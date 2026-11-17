'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  targetLang: 'zh-Hans',
  selectionBubble: true,
  autoTranslatePage: true,
  autoTranslateDynamic: false
});

const MAX_MANUAL_CHARS = 5000;

const RESTRICTED_PROTOCOLS = new Set([
  'chrome:',
  'edge:',
  'about:',
  'devtools:',
  'chrome-extension:',
  'moz-extension:',
  'view-source:'
]);

const els = {
  targetLang: document.getElementById('targetLang'),
  selectionBubble: document.getElementById('selectionBubble'),
  autoTranslatePage: document.getElementById('autoTranslatePage'),
  translatePage: document.getElementById('translatePage'),
  restorePage: document.getElementById('restorePage'),
  status: document.getElementById('status'),
  pageState: document.getElementById('pageState'),
  openOptions: document.getElementById('openOptions'),
  manualInput: document.getElementById('manualInput'),
  manualCount: document.getElementById('manualCount'),
  manualTranslate: document.getElementById('manualTranslate'),
  manualCopy: document.getElementById('manualCopy'),
  manualResultWrap: document.getElementById('manualResultWrap'),
  manualResult: document.getElementById('manualResult'),
  manualResultLabel: document.getElementById('manualResultLabel')
};

let activeTab = null;
let settings = { ...DEFAULT_SETTINGS };
let pageState = { translating: false, hasTranslations: false, translatedNodes: 0 };
let busy = false;
let refreshTimer = 0;
let manualBusy = false;
let manualResult = '';

/* ------------------------------------------------------------------ */
/* 基础工具                                                           */
/* ------------------------------------------------------------------ */

function languageLabel(code) {
  if (typeof window.fanyiLanguageLabel === 'function') {
    return window.fanyiLanguageLabel(code);
  }
  return code || '目标语言';
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const supported = Array.isArray(window.FANYI_LANGUAGES)
    ? window.FANYI_LANGUAGES.map((item) => item.code)
    : null;

  let targetLang = DEFAULT_SETTINGS.targetLang;
  if (
    typeof value.targetLang === 'string' &&
    (!supported || supported.includes(value.targetLang))
  ) {
    targetLang = value.targetLang;
  }

  return {
    targetLang,
    selectionBubble: value.selectionBubble !== false,
    autoTranslatePage: value.autoTranslatePage !== false,
    autoTranslateDynamic: value.autoTranslateDynamic === true
  };
}

function isRestrictedTab(tab) {
  if (!tab) return true;
  const rawUrl = typeof tab.url === 'string' ? tab.url : '';
  if (!rawUrl) return false;

  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return true;
  }

  if (RESTRICTED_PROTOCOLS.has(url.protocol)) return true;
  if (url.hostname === 'chromewebstore.google.com') return true;
  if (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')) return true;
  return false;
}

function explainTabError(error) {
  const message = error && error.message ? error.message : '';
  if (/cannot access|extensions gallery|chrome:\/\/|The page is a chrome/i.test(message)) {
    return '当前页面不允许扩展注入脚本，请换一个普通网页重试';
  }
  if (/No tab with id|No active tab/i.test(message)) {
    return '页面已关闭或已切换，请重新打开弹窗';
  }
  if (/Cannot access contents of url|Missing host permission/i.test(message)) {
    return '没有当前页面的访问权限，请刷新网页后重试';
  }
  return message || '无法在当前页面执行翻译';
}

function setStatus(message, tone) {
  if (!message) {
    els.status.textContent = '';
    els.status.className = 'status';
    return;
  }
  els.status.textContent = message;
  els.status.className = `status visible ${tone || ''}`.trim();
}

function renderButtons() {
  const restricted = !activeTab || isRestrictedTab(activeTab);
  const translating = pageState.translating;
  const translated = pageState.hasTranslations;

  els.translatePage.disabled = busy || restricted || translating || translated;
  els.restorePage.disabled = busy || restricted || (!translating && !translated);
  els.targetLang.disabled = busy || translating;

  els.translatePage.title = translated ? '请先恢复原文，再翻译其他语言' : '翻译当前页面';
  els.restorePage.title = translating
    ? '停止当前翻译并恢复已翻译内容'
    : '恢复页面原文';
}

function updatePageStateLabel() {
  if (!activeTab) {
    els.pageState.textContent = '没有可操作的活动标签页';
    return;
  }
  if (isRestrictedTab(activeTab)) {
    els.pageState.textContent = '当前页面不支持翻译';
    return;
  }
  if (pageState.translating) {
    els.pageState.textContent = '正在翻译…';
  } else if (pageState.hasTranslations) {
    els.pageState.textContent = `已翻译 ${pageState.translatedNodes} 处`;
  } else {
    els.pageState.textContent = '页面原文';
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    refreshPageState();
  }, 120);
}

/* ------------------------------------------------------------------ */
/* 数据加载与保存                                                     */
/* ------------------------------------------------------------------ */

function populateLanguages() {
  const languages = Array.isArray(window.FANYI_LANGUAGES) && window.FANYI_LANGUAGES.length > 0
    ? window.FANYI_LANGUAGES
    : [{ code: 'zh-Hans', label: '简体中文' }];

  els.targetLang.textContent = '';
  for (const item of languages) {
    const option = document.createElement('option');
    option.value = item.code;
    option.textContent = item.label;
    els.targetLang.appendChild(option);
  }
}

async function loadSettings() {
  let loaded = null;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response && response.ok) loaded = response.settings;
  } catch (_) {
    // 后台暂时不可用时回退到 storage 直读。
  }

  if (!loaded) {
    try {
      loaded = await chrome.storage.local.get(DEFAULT_SETTINGS);
    } catch (_) {
      loaded = null;
    }
  }

  settings = normalizeSettings(loaded);

  els.targetLang.value = settings.targetLang;
  if (!els.targetLang.value) els.targetLang.value = DEFAULT_SETTINGS.targetLang;
  els.selectionBubble.checked = settings.selectionBubble;
  els.autoTranslatePage.checked = settings.autoTranslatePage;
}

async function persistSettings(patch) {
  const response = await chrome.runtime.sendMessage({
    type: 'SET_SETTINGS',
    settings: patch
  });

  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : '设置保存失败');
  }

  settings = normalizeSettings(response.settings);
  return settings;
}

async function detectActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
  } catch (_) {
    activeTab = null;
  }

  if (!activeTab) {
    els.pageState.textContent = '没有可操作的活动标签页';
    renderButtons();
    return;
  }

  updatePageStateLabel();
  renderButtons();
}

async function refreshPageState() {
  if (!activeTab) {
    pageState = { translating: false, hasTranslations: false, translatedNodes: 0 };
    updatePageStateLabel();
    renderButtons();
    return;
  }

  if (isRestrictedTab(activeTab)) {
    pageState = { translating: false, hasTranslations: false, translatedNodes: 0 };
    updatePageStateLabel();
    renderButtons();
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: 'FC_GET_PAGE_STATE'
    });
    if (!response || !response.ok) throw new Error('页面未响应');

    pageState = {
      translating: Boolean(response.translating),
      hasTranslations: Boolean(response.hasTranslations),
      translatedNodes: Number(response.translatedNodes) || 0
    };
    updatePageStateLabel();
  } catch (_) {
    pageState = { translating: false, hasTranslations: false, translatedNodes: 0 };
    els.pageState.textContent = '页面脚本尚未启用';
  }

  renderButtons();
}

/* ------------------------------------------------------------------ */
/* 页面操作                                                           */
/* ------------------------------------------------------------------ */

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    // 安装扩展前已经打开的标签页没有 content script，按需注入后再发一次。
    await chrome.scripting
      .insertCSS({ target: { tabId }, files: ['content/content.css'] })
      .catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/languages.js', 'content/content.js']
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function handleTranslateClick() {
  if (!activeTab || isRestrictedTab(activeTab) || busy) {
    if (activeTab && isRestrictedTab(activeTab)) {
      setStatus('当前页面不允许扩展注入脚本，请换一个普通网页重试', 'error');
    }
    return;
  }

  busy = true;
  renderButtons();
  setStatus('正在启动整页翻译…', 'info');

  try {
    await persistSettings({
      targetLang: els.targetLang.value,
      selectionBubble: els.selectionBubble.checked,
      autoTranslatePage: els.autoTranslatePage.checked
    });

    const response = await sendToTab(activeTab.id, { type: 'FC_TRANSLATE_PAGE' });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : '页面没有响应翻译指令');
    }
    els.pageState.textContent = '正在翻译…';
  } catch (error) {
    setStatus(`启动失败：${explainTabError(error)}`, 'error');
    els.pageState.textContent = '翻译未能启动';
  } finally {
    busy = false;
    renderButtons();
    refreshPageState();
  }
}

async function handleRestoreClick() {
  if (!activeTab || isRestrictedTab(activeTab) || busy) return;

  busy = true;
  renderButtons();
  setStatus('正在恢复原文…', 'info');

  try {
    const response = await sendToTab(activeTab.id, { type: 'FC_RESTORE_PAGE' });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : '页面没有响应恢复指令');
    }

    if (response.restored > 0) {
      setStatus(`已恢复原文（${response.restored} 处）`, 'success');
    } else if (response.hadRecords > 0) {
      setStatus('原文节点已被页面替换，无法恢复', 'error');
    } else {
      setStatus('当前页面没有已翻译的内容', 'info');
    }
  } catch (error) {
    setStatus(`恢复失败：${explainTabError(error)}`, 'error');
  } finally {
    busy = false;
    renderButtons();
    refreshPageState();
  }
}

async function handleLanguageChange() {
  const previous = settings.targetLang;
  const next = els.targetLang.value;
  els.targetLang.disabled = true;

  try {
    await persistSettings({ targetLang: next });
    if (pageState.hasTranslations) {
      setStatus('目标语言已保存；当前页面请先恢复原文，再按新语言翻译', 'info');
    } else {
      setStatus(`目标语言已保存：${languageLabel(next)}`, 'success');
    }
  } catch (error) {
    els.targetLang.value = previous;
    setStatus(`设置保存失败：${error.message || error}`, 'error');
  } finally {
    renderButtons();
  }
}

async function handleBubbleChange() {
  const next = els.selectionBubble.checked;
  els.selectionBubble.disabled = true;

  try {
    await persistSettings({ selectionBubble: next });
    setStatus(
      next ? '已开启选中翻译按钮' : '已关闭选中翻译按钮，右键菜单仍可使用',
      'success'
    );
  } catch (error) {
    els.selectionBubble.checked = settings.selectionBubble;
    setStatus(`设置保存失败：${error.message || error}`, 'error');
  } finally {
    els.selectionBubble.disabled = false;
  }
}

async function handleAutoTranslateChange() {
  const next = els.autoTranslatePage.checked;
  els.autoTranslatePage.disabled = true;

  try {
    await persistSettings({ autoTranslatePage: next });
    setStatus(
      next ? '已开启自动翻译：打开网页后自动翻译整页' : '已关闭自动翻译',
      'success'
    );
  } catch (error) {
    els.autoTranslatePage.checked = settings.autoTranslatePage;
    setStatus(`设置保存失败：${error.message || error}`, 'error');
  } finally {
    els.autoTranslatePage.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 手动输入翻译                                                       */
/* ------------------------------------------------------------------ */

function updateManualCount() {
  els.manualCount.textContent = `${els.manualInput.value.length} / ${MAX_MANUAL_CHARS}`;
}

async function handleManualTranslate() {
  if (manualBusy) return;
  const text = els.manualInput.value.trim();

  if (!text) {
    setStatus('请先输入要翻译的文本', 'info');
    els.manualInput.focus();
    return;
  }
  if (text.length > MAX_MANUAL_CHARS) {
    setStatus(`文本过长（${text.length} 字），最多支持 ${MAX_MANUAL_CHARS} 字`, 'error');
    return;
  }

  manualBusy = true;
  els.manualTranslate.disabled = true;
  els.manualTranslate.textContent = '翻译中…';
  els.manualResultLabel.textContent = `译文 → ${languageLabel(els.targetLang.value)}`;
  manualResult = '';
  els.manualResult.textContent = '正在翻译…';
  els.manualResultWrap.hidden = false;
  els.manualCopy.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_TEXTS',
      texts: [text],
      from: '',
      to: els.targetLang.value
    });

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : '翻译失败，请稍后重试');
    }
    const translated = response.translations && response.translations[0];
    if (typeof translated !== 'string' || !translated.trim()) {
      throw new Error('翻译接口返回了空译文');
    }

    manualResult = translated;
    els.manualResult.textContent = translated;
    els.manualCopy.disabled = false;
  } catch (error) {
    manualResult = '';
    els.manualResultWrap.hidden = true;
    setStatus(`翻译失败：${(error && error.message) || error}`, 'error');
  } finally {
    manualBusy = false;
    els.manualTranslate.disabled = false;
    els.manualTranslate.textContent = '翻译';
  }
}

async function handleManualCopy() {
  if (!manualResult) return;

  let ok = true;
  try {
    await navigator.clipboard.writeText(manualResult);
  } catch (_) {
    // 弹窗页面通常支持 clipboard API，这里兜底 execCommand。
    const textarea = document.createElement('textarea');
    textarea.value = manualResult;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    textarea.remove();
  }

  els.manualCopy.textContent = ok ? '已复制' : '复制失败';
  window.setTimeout(() => {
    els.manualCopy.textContent = '复制';
  }, 1200);
}

/* ------------------------------------------------------------------ */
/* 页面事件广播                                                       */
/* ------------------------------------------------------------------ */

function handlePageEvent(event) {
  const phase = event.phase;

  if (phase === 'started') {
    pageState.translating = true;
    updatePageStateLabel();
    renderButtons();
    setStatus('正在翻译当前页面…', 'info');
    return;
  }

  if (phase === 'progress') {
    pageState.translating = true;
    const processed = Number(event.processed) || 0;
    const total = Number(event.total) || 0;
    const failed = Number(event.failed) || 0;
    const percent = Number(event.percent) || 0;
    updatePageStateLabel();
    renderButtons();
    setStatus(
      `正在翻译 ${percent}%（${processed}/${total} 段）${
        failed > 0 ? `，${failed} 段失败` : ''
      }`,
      'info'
    );
    return;
  }

  if (phase === 'done') {
    pageState.translating = false;
    pageState.hasTranslations = Number(event.translated) > 0 || pageState.hasTranslations;
    els.pageState.textContent = '翻译完成';
    renderButtons();
    if (Number(event.failed) > 0) {
      setStatus(
        `部分完成：${event.failed} 段失败${event.error ? `（${event.error}）` : ''}`,
        'warn'
      );
    } else {
      setStatus(`翻译完成：${Number(event.translated) || 0} 段`, 'success');
    }
    scheduleRefresh();
    return;
  }

  if (phase === 'error') {
    pageState.translating = false;
    renderButtons();
    els.pageState.textContent = '翻译失败';
    setStatus(event.error || '翻译失败，请稍后重试', 'error');
    scheduleRefresh();
    return;
  }

  if (phase === 'canceled') {
    pageState.translating = false;
    pageState.hasTranslations = Number(event.translated) > 0;
    updatePageStateLabel();
    renderButtons();
    setStatus('已停止翻译，已翻译内容可用“恢复原文”还原', 'warn');
    scheduleRefresh();
    return;
  }

  if (phase === 'noop') {
    pageState.translating = false;
    renderButtons();
    setStatus(event.message || '没有可翻译的内容', 'info');
    scheduleRefresh();
    return;
  }

  if (phase === 'restored') {
    pageState.translating = false;
    pageState.hasTranslations = false;
    updatePageStateLabel();
    renderButtons();
    if (Number(event.restored) > 0) {
      setStatus(`已恢复原文（${event.restored} 处）`, 'success');
    }
    scheduleRefresh();
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                             */
/* ------------------------------------------------------------------ */

function bindEvents() {
  els.translatePage.addEventListener('click', handleTranslateClick);
  els.restorePage.addEventListener('click', handleRestoreClick);
  els.targetLang.addEventListener('change', handleLanguageChange);
  els.selectionBubble.addEventListener('change', handleBubbleChange);
  els.autoTranslatePage.addEventListener('change', handleAutoTranslateChange);
  els.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage().catch((error) => {
      setStatus(`无法打开设置页：${error.message || error}`, 'error');
    });
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== 'FC_PAGE_EVENT') return undefined;
    if (!activeTab || !sender || !sender.tab || sender.tab.id !== activeTab.id) {
      return undefined;
    }
    handlePageEvent(message);
    return undefined;
  });

  els.manualTranslate.addEventListener('click', handleManualTranslate);
  els.manualCopy.addEventListener('click', handleManualCopy);
  els.manualInput.addEventListener('input', updateManualCount);
  els.manualInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleManualTranslate();
    }
  });
}

async function init() {
  populateLanguages();
  updateManualCount();
  bindEvents();

  try {
    await loadSettings();
    await detectActiveTab();
    await refreshPageState();
  } catch (error) {
    setStatus(`初始化失败：${(error && error.message) || error}`, 'error');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
