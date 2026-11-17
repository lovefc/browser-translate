'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  targetLang: 'zh-Hans',
  selectionBubble: true,
  autoTranslatePage: true,
  autoTranslateDynamic: false
});

const els = {
  targetLang: document.getElementById('targetLang'),
  selectionBubble: document.getElementById('selectionBubble'),
  autoTranslatePage: document.getElementById('autoTranslatePage'),
  autoTranslateDynamic: document.getElementById('autoTranslateDynamic'),
  save: document.getElementById('save'),
  reset: document.getElementById('reset'),
  clearCache: document.getElementById('clearCache'),
  status: document.getElementById('status')
};

let settings = { ...DEFAULT_SETTINGS };

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

function setStatus(message, tone) {
  if (!message) {
    els.status.textContent = '';
    els.status.className = 'status';
    return;
  }
  els.status.textContent = message;
  els.status.className = `status visible ${tone || ''}`.trim();
}

function languageLabel(code) {
  if (typeof window.fanyiLanguageLabel === 'function') {
    return window.fanyiLanguageLabel(code);
  }
  return code || '目标语言';
}

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

function applySettings(next) {
  settings = normalizeSettings(next);
  els.targetLang.value = settings.targetLang;
  if (!els.targetLang.value) els.targetLang.value = DEFAULT_SETTINGS.targetLang;
  els.selectionBubble.checked = settings.selectionBubble;
  els.autoTranslatePage.checked = settings.autoTranslatePage;
  els.autoTranslateDynamic.checked = settings.autoTranslateDynamic;
}

async function loadSettings() {
  let loaded = null;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response && response.ok) loaded = response.settings;
  } catch (_) {
    // 回退到 storage 直读。
  }

  if (!loaded) {
    try {
      loaded = await chrome.storage.local.get(DEFAULT_SETTINGS);
    } catch (_) {
      loaded = null;
    }
  }

  applySettings(loaded);
}

async function saveSettings(next) {
  const response = await chrome.runtime.sendMessage({
    type: 'SET_SETTINGS',
    settings: next
  });

  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : '设置保存失败');
  }

  applySettings(response.settings);
  return response.settings;
}

// 单项即时保存：只更新设置镜像，不整体重绘控件，避免覆盖用户正在编辑的其他项。
async function persistPatch(patch) {
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

const TOGGLE_MESSAGES = {
  autoTranslatePage: ['已开启自动翻译网页', '已关闭自动翻译网页'],
  selectionBubble: ['已开启选中后显示翻译按钮', '已关闭选中后显示翻译按钮'],
  autoTranslateDynamic: ['已开启自动翻译动态内容', '已关闭自动翻译动态内容']
};

async function handleToggleChange(key, input) {
  const value = input.checked;
  input.disabled = true;

  try {
    await persistPatch({ [key]: value });
    const messages = TOGGLE_MESSAGES[key];
    setStatus(messages ? messages[value ? 0 : 1] : '设置已保存', 'success');
  } catch (error) {
    input.checked = Boolean(settings[key]);
    setStatus(`保存失败：${(error && error.message) || error}`, 'error');
  } finally {
    input.disabled = false;
  }
}

async function handleLanguageChange() {
  const previous = settings.targetLang;
  const next = els.targetLang.value;
  els.targetLang.disabled = true;

  try {
    await persistPatch({ targetLang: next });
    setStatus(`目标语言已保存：${languageLabel(next)}`, 'success');
  } catch (error) {
    els.targetLang.value = previous;
    setStatus(`保存失败：${(error && error.message) || error}`, 'error');
  } finally {
    els.targetLang.disabled = false;
  }
}

async function handleSave() {
  els.save.disabled = true;
  setStatus('正在保存…', 'info');

  try {
    await saveSettings({
      targetLang: els.targetLang.value,
      selectionBubble: els.selectionBubble.checked,
      autoTranslatePage: els.autoTranslatePage.checked,
      autoTranslateDynamic: els.autoTranslateDynamic.checked
    });
    setStatus('设置已保存', 'success');
  } catch (error) {
    setStatus(`保存失败：${(error && error.message) || error}`, 'error');
  } finally {
    els.save.disabled = false;
  }
}

async function handleReset() {
  els.save.disabled = true;
  els.reset.disabled = true;
  setStatus('正在恢复默认设置…', 'info');

  try {
    await saveSettings({ ...DEFAULT_SETTINGS });
    setStatus('已恢复默认设置', 'success');
  } catch (error) {
    setStatus(`恢复默认失败：${(error && error.message) || error}`, 'error');
  } finally {
    els.save.disabled = false;
    els.reset.disabled = false;
  }
}

async function handleClearCache() {
  els.clearCache.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    if (!response || !response.ok) throw new Error('后台未响应');

    if (Number(response.cleared) > 0) {
      setStatus(`已清除 ${response.cleared} 条内存缓存`, 'success');
    } else {
      setStatus('缓存已经是空的', 'info');
    }
  } catch (error) {
    setStatus(`清除缓存失败：${(error && error.message) || error}`, 'error');
  } finally {
    els.clearCache.disabled = false;
  }
}

function bindEvents() {
  // 所有选项修改后立即保存生效，与弹窗行为一致；「保存设置」仍可整体确认一次。
  els.targetLang.addEventListener('change', handleLanguageChange);
  els.selectionBubble.addEventListener('change', () => {
    handleToggleChange('selectionBubble', els.selectionBubble);
  });
  els.autoTranslatePage.addEventListener('change', () => {
    handleToggleChange('autoTranslatePage', els.autoTranslatePage);
  });
  els.autoTranslateDynamic.addEventListener('change', () => {
    handleToggleChange('autoTranslateDynamic', els.autoTranslateDynamic);
  });
  els.save.addEventListener('click', handleSave);
  els.reset.addEventListener('click', handleReset);
  els.clearCache.addEventListener('click', handleClearCache);
}

async function init() {
  populateLanguages();
  bindEvents();
  try {
    await loadSettings();
  } catch (error) {
    setStatus(`读取设置失败：${(error && error.message) || error}`, 'error');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
