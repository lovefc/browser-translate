'use strict';

/**
 * 封尘翻译 - 后台 Service Worker
 * 所有网络请求都集中在这里，content script 只通过消息通信。
 */

const TRANSLATE_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext';
const MENU_ID = 'fanyi-translate-selection';

const MAX_CONCURRENCY = 2;          // 同时最多 2 个 HTTP 请求
const MAX_RETRIES = 2;              // 首次失败后再重试 2 次
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_LIMIT = 1000;           // 内存 LRU 上限，Service Worker 休眠后清空

const MAX_TEXTS_PER_REQUEST = 40;
const MAX_CHARS_PER_TEXT = 5000;
const MAX_CHARS_PER_REQUEST = 8000;

const DEFAULT_SETTINGS = Object.freeze({
  targetLang: 'zh-Hans',
  selectionBubble: true,
  autoTranslatePage: true,
  autoTranslateDynamic: false
});

const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/;

/* ------------------------------------------------------------------ */
/* 错误类型                                                           */
/* ------------------------------------------------------------------ */

class TranslateError extends Error {
  constructor(code, message, options) {
    super(message);
    this.name = 'TranslateError';
    this.code = code;
    this.retryable = Boolean(options && options.retryable);
    this.retryAfterMs = (options && options.retryAfterMs) || 0;
    this.detail = (options && options.detail) || '';
  }
}

function normalizeError(error) {
  if (error instanceof TranslateError) return error;
  return new TranslateError(
    'UNKNOWN',
    (error && error.message) || '翻译失败，请稍后重试',
    { retryable: true }
  );
}

function userFacingError(error) {
  const normalized = normalizeError(error);
  const messages = {
    INVALID_INPUT: '翻译参数无效',
    INVALID_LANG: '目标语言代码无效',
    TOO_MANY_TEXTS: '一次翻译的文本条数过多，请分批翻译',
    TOO_LONG: '单次翻译的文本过长，请缩短后重试',
    TIMEOUT: '翻译请求超时，请检查网络后重试',
    NETWORK: '网络错误，无法连接翻译服务',
    HTTP_429: '翻译接口请求过于频繁（HTTP 429），请稍后再试',
    HTTP_5XX: '翻译服务暂时不可用，请稍后再试',
    HTTP_ERROR: '翻译请求失败，请稍后重试',
    EMPTY_RESPONSE: '翻译接口返回了空响应',
    PARSE_ERROR: '翻译结果解析失败，接口返回结构可能已变化',
    EMPTY_TRANSLATION: '翻译接口返回了空译文',
    INTERNAL: '翻译服务内部错误，请重试'
  };
  return messages[normalized.code] || normalized.message || '翻译失败，请稍后重试';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* 并发队列                                                           */
/* ------------------------------------------------------------------ */

class RequestQueue {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  add(task) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.limit && this.waiting.length > 0) {
      const job = this.waiting.shift();
      this.active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

const requestQueue = new RequestQueue(MAX_CONCURRENCY);

/* ------------------------------------------------------------------ */
/* 内存 LRU 缓存                                                       */
/* ------------------------------------------------------------------ */

const translationCache = new Map();

function cacheKey(from, to, text) {
  return `${from}|${to}|${text}`;
}

function cacheGet(key) {
  if (!translationCache.has(key)) return undefined;
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (typeof value !== 'string' || !value) return;
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > CACHE_LIMIT) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
}

/* ------------------------------------------------------------------ */
/* 响应解析                                                           */
/* ------------------------------------------------------------------ */

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

/**
 * 兼容三种常见返回：
 * 1. [{ translations: [{ text: '你好', to: 'zh-Hans' }] }, ...]
 * 2. { translations: [{ text: '你好' }] }
 * 3. ['你好', ...]
 * 另外兼容数组内直接出现 { text }、{ translation }、[['你好']] 等变体。
 */
function parseTranslateResponse(data, expectedCount) {
  function fail(reason) {
    console.error('[封尘翻译] 无法解析翻译响应，原始数据：', data);
    throw new TranslateError(
      'PARSE_ERROR',
      `翻译结果解析失败：${reason}`,
      { retryable: true, detail: safeStringify(data).slice(0, 500) }
    );
  }

  function extractItem(item) {
    if (typeof item === 'string') return item;
    if (Array.isArray(item)) {
      return typeof item[0] === 'string' ? item[0] : null;
    }
    if (!item || typeof item !== 'object') return null;
    if (Array.isArray(item.translations)) {
      const first = item.translations[0];
      if (typeof first === 'string') return first;
      if (first && typeof first.text === 'string') return first.text;
    }
    if (item.translations && typeof item.translations === 'object') {
      if (typeof item.translations.text === 'string') return item.translations.text;
    }
    if (typeof item.text === 'string') return item.text;
    if (typeof item.translation === 'string') return item.translation;
    if (Array.isArray(item.result) && typeof item.result[0] === 'string') return item.result[0];
    return null;
  }

  if (data === null || data === undefined) fail('响应为空');

  let list = null;

  if (Array.isArray(data)) {
    if (data.length === 0) fail('响应数组为空');
    list = data.map(extractItem);
  } else if (typeof data === 'object') {
    if (Array.isArray(data.translations)) {
      list = data.translations.map(extractItem);
    } else if (data.translations && typeof data.translations === 'object' && typeof data.translations.text === 'string') {
      list = [data.translations.text];
    } else if (Array.isArray(data.result)) {
      list = data.result.map(extractItem);
    } else if (data.result && Array.isArray(data.result.translations)) {
      list = data.result.translations.map(extractItem);
    } else if (typeof data.translation === 'string') {
      list = [data.translation];
    } else if (typeof data.text === 'string') {
      list = [data.text];
    }
  }

  if (!Array.isArray(list)) fail('未找到译文数组');
  if (list.some((item) => typeof item !== 'string')) fail('译文数组中存在无法识别的内容');

  // 对象形态只返回一条时，允许用于单项请求；其余情况必须严格对齐数量。
  if (expectedCount === 1 && list.length >= 1 && !Array.isArray(data)) {
    list = [list[0]];
  }
  if (list.length !== expectedCount) {
    fail(`译文数量不匹配（期望 ${expectedCount} 条，实际 ${list.length} 条）`);
  }

  const cleaned = list.map((item) => item.trim());
  if (cleaned.some((item) => !item)) fail('接口返回了空译文');
  return cleaned;
}

/* ------------------------------------------------------------------ */
/* HTTP 请求                                                          */
/* ------------------------------------------------------------------ */

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 5000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.min(Math.max(timestamp - Date.now(), 0), 5000);
  }
  return 0;
}

async function requestOnce(texts, from, to) {
  const url = new URL(TRANSLATE_ENDPOINT);
  url.searchParams.set('from', from || '');
  url.searchParams.set('to', to);
  url.searchParams.set('isEnterpriseClient', 'false');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(texts),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new TranslateError('TIMEOUT', '翻译请求超时', { retryable: true });
      }
      console.warn('[封尘翻译] 网络请求失败：', error);
      throw new TranslateError('NETWORK', '网络错误，无法连接翻译服务', { retryable: true });
    }

    let rawText = '';
    try {
      rawText = await response.text();
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new TranslateError('TIMEOUT', '读取翻译响应超时', { retryable: true });
      }
      throw new TranslateError('NETWORK', '读取翻译响应失败', { retryable: true });
    }

    if (!response.ok) {
      console.error(
        `[封尘翻译] 翻译接口返回 HTTP ${response.status}`,
        rawText.slice(0, 1000)
      );
      if (response.status === 429) {
        throw new TranslateError('HTTP_429', '翻译接口请求过于频繁', {
          retryable: true,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after'))
        });
      }
      if (response.status >= 500) {
        throw new TranslateError('HTTP_5XX', `翻译服务暂时不可用（HTTP ${response.status}）`, {
          retryable: true
        });
      }
      throw new TranslateError('HTTP_ERROR', `翻译请求失败（HTTP ${response.status}）`, {
        retryable: false,
        detail: rawText.slice(0, 500)
      });
    }

    if (!rawText.trim()) {
      console.error('[封尘翻译] 翻译接口返回空响应体');
      throw new TranslateError('EMPTY_RESPONSE', '翻译接口返回空响应', { retryable: true });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      console.error('[封尘翻译] 翻译接口返回的不是合法 JSON：', rawText.slice(0, 2000));
      throw new TranslateError('PARSE_ERROR', '翻译结果解析失败：返回的不是 JSON', {
        retryable: true,
        detail: rawText.slice(0, 300)
      });
    }

    return parseTranslateResponse(data, texts.length);
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithRetry(texts, from, to) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await requestQueue.add(() => requestOnce(texts, from, to));
    } catch (error) {
      lastError = normalizeError(error);
      if (!lastError.retryable || attempt >= MAX_RETRIES) break;

      const backoff = Math.min(500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250), 4000);
      const waitMs = Math.max(backoff, lastError.retryAfterMs || 0);
      console.warn(
        `[封尘翻译] 第 ${attempt + 1} 次请求失败（${lastError.code}），${waitMs}ms 后重试`
      );
      await delay(waitMs);
    }
  }

  throw lastError;
}

/* ------------------------------------------------------------------ */
/* 设置                                                               */
/* ------------------------------------------------------------------ */

function isValidLanguage(code) {
  return typeof code === 'string' && code.length <= 16 && LANG_RE.test(code);
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    targetLang: isValidLanguage(value.targetLang) ? value.targetLang : DEFAULT_SETTINGS.targetLang,
    selectionBubble: value.selectionBubble !== false,
    autoTranslatePage: value.autoTranslatePage !== false,
    autoTranslateDynamic: value.autoTranslateDynamic === true
  };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...stored });
}

async function setSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TranslateError('INVALID_INPUT', '无效的设置数据');
  }

  if ('targetLang' in patch && !isValidLanguage(patch.targetLang)) {
    throw new TranslateError('INVALID_LANG', '目标语言代码无效');
  }

  const next = normalizeSettings({
    ...(await getSettings()),
    ...('targetLang' in patch ? { targetLang: patch.targetLang } : {}),
    ...('selectionBubble' in patch ? { selectionBubble: Boolean(patch.selectionBubble) } : {}),
    ...('autoTranslatePage' in patch ? { autoTranslatePage: Boolean(patch.autoTranslatePage) } : {}),
    ...('autoTranslateDynamic' in patch
      ? { autoTranslateDynamic: Boolean(patch.autoTranslateDynamic) }
      : {})
  });

  await chrome.storage.local.set(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* 翻译入口                                                           */
/* ------------------------------------------------------------------ */

function validateTranslateRequest(message) {
  if (!message || !Array.isArray(message.texts)) {
    throw new TranslateError('INVALID_INPUT', 'texts 必须是字符串数组');
  }
  if (message.texts.length === 0) {
    throw new TranslateError('INVALID_INPUT', '没有需要翻译的文本');
  }
  if (message.texts.length > MAX_TEXTS_PER_REQUEST) {
    throw new TranslateError(
      'TOO_MANY_TEXTS',
      `一次最多翻译 ${MAX_TEXTS_PER_REQUEST} 条文本，请分批发送`
    );
  }

  const from = typeof message.from === 'string' ? message.from.trim() : '';
  const to = typeof message.to === 'string' ? message.to.trim() : '';
  if (!to || !isValidLanguage(to)) {
    throw new TranslateError('INVALID_LANG', '目标语言代码无效');
  }
  if (from && !isValidLanguage(from)) {
    throw new TranslateError('INVALID_LANG', '源语言代码无效');
  }

  let totalChars = 0;
  const texts = message.texts.map((item) => {
    if (typeof item !== 'string') {
      throw new TranslateError('INVALID_INPUT', 'texts 中必须全部是字符串');
    }
    const text = item.trim();
    if (!text) {
      throw new TranslateError('INVALID_INPUT', '待翻译文本不能为空');
    }
    if (text.length > MAX_CHARS_PER_TEXT) {
      throw new TranslateError(
        'TOO_LONG',
        `单条文本最长 ${MAX_CHARS_PER_TEXT} 字符，请缩短后重试`
      );
    }
    totalChars += text.length;
    return text;
  });

  if (totalChars > MAX_CHARS_PER_REQUEST) {
    throw new TranslateError(
      'TOO_LONG',
      `单次请求总长度不能超过 ${MAX_CHARS_PER_REQUEST} 字符，请分批翻译`
    );
  }

  return { texts, from, to };
}

async function handleTranslateTexts(message) {
  const { texts, from, to } = validateTranslateRequest(message);

  const resolved = new Map();
  const missing = [];
  const missingSet = new Set();

  for (const text of texts) {
    const key = cacheKey(from, to, text);
    if (translationCache.has(key)) {
      resolved.set(text, cacheGet(key));
    } else if (!missingSet.has(text)) {
      missingSet.add(text);
      missing.push(text);
    }
  }

  if (missing.length > 0) {
    const translations = await requestWithRetry(missing, from, to);
    if (!Array.isArray(translations) || translations.length !== missing.length) {
      throw new TranslateError('PARSE_ERROR', '译文数量与请求数量不一致', { retryable: false });
    }

    for (let i = 0; i < missing.length; i += 1) {
      const translated = translations[i];
      if (typeof translated !== 'string' || !translated.trim()) {
        throw new TranslateError('EMPTY_TRANSLATION', '翻译接口返回了空译文', {
          retryable: true
        });
      }
      const text = missing[i];
      cacheSet(cacheKey(from, to, text), translated);
      resolved.set(text, translated);
    }
  }

  const output = texts.map((text) => resolved.get(text));
  if (output.some((item) => typeof item !== 'string')) {
    throw new TranslateError('INTERNAL', '译文映射失败，请重试', { retryable: false });
  }
  return output;
}

/* ------------------------------------------------------------------ */
/* 右键菜单与脚本注入                                                 */
/* ------------------------------------------------------------------ */

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: '翻译选中文本',
        contexts: ['selection']
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  });
}

async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
  } catch (_) {
    // CSS 注入失败通常意味着页面不允许注入，下面 executeScript 会给出最终结果。
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['shared/languages.js', 'content/content.js']
  });
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    await injectContentScripts(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function flashBadge(tabId, text) {
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#b42318' }, () => {
      void chrome.runtime.lastError;
    });
    chrome.action.setBadgeText({ tabId, text: String(text).slice(0, 4) }, () => {
      void chrome.runtime.lastError;
    });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }, () => {
        void chrome.runtime.lastError;
      });
    }, 3000);
  } catch (_) {
    // 标签页可能已经关闭。
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
  chrome.storage.local
    .get(DEFAULT_SETTINGS)
    .then((settings) => chrome.storage.local.set(normalizeSettings(settings)))
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(setupContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || typeof tab.id !== 'number') return;

  const text = typeof info.selectionText === 'string' ? info.selectionText : '';
  sendToTab(tab.id, { type: 'TRANSLATE_SELECTION', text }).catch((error) => {
    console.warn('[封尘翻译] 无法在当前页面打开翻译浮层：', error);
    flashBadge(tab.id, '!');
  });
});

/* ------------------------------------------------------------------ */
/* 消息路由                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  if (message.type === 'TRANSLATE_TEXTS') {
    (async () => {
      try {
        const translations = await handleTranslateTexts(message);
        sendResponse({ ok: true, translations });
      } catch (error) {
        const normalized = normalizeError(error);
        console.error(`[封尘翻译] 翻译失败（${normalized.code}）：`, normalized, normalized.detail || '');
        sendResponse({
          ok: false,
          error: userFacingError(normalized),
          code: normalized.code
        });
      }
    })();
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    (async () => {
      try {
        const settings = await getSettings();
        sendResponse({ ok: true, settings });
      } catch (error) {
        sendResponse({ ok: false, error: userFacingError(error), code: 'SETTINGS' });
      }
    })();
    return true;
  }

  if (message.type === 'SET_SETTINGS') {
    (async () => {
      try {
        const settings = await setSettings(message.settings);
        sendResponse({ ok: true, settings });
      } catch (error) {
        sendResponse({
          ok: false,
          error: userFacingError(error),
          code: normalizeError(error).code
        });
      }
    })();
    return true;
  }

  if (message.type === 'CLEAR_CACHE') {
    const size = translationCache.size;
    translationCache.clear();
    sendResponse({ ok: true, cleared: size });
    return false;
  }

  // FC_PAGE_EVENT 等广播消息无需后台处理。
  return undefined;
});
