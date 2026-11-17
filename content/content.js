(function () {
  'use strict';

  // 防止 popup / 右键菜单的兜底注入重复注册监听器。
  if (window.__FANYI_CONTENT_LOADED__) return;
  window.__FANYI_CONTENT_LOADED__ = true;

  const DEFAULT_SETTINGS = Object.freeze({
    targetLang: 'zh-Hans',
    selectionBubble: true,
    autoTranslatePage: true,
    autoTranslateDynamic: false
  });

  const MAX_SELECTION_CHARS = 5000;
  const MAX_PAGE_TEXT_CHARS = 5000;
  const PAGE_BATCH_SIZE = 30;
  const PAGE_BATCH_CHARS = 3500;
  const UI_ATTR = 'data-fanyi-ui';

  const EXCLUDED_SELECTOR = [
    'script',
    'style',
    'noscript',
    'code',
    'pre',
    'textarea',
    'input',
    'select',
    'option',
    'svg',
    'canvas',
    'iframe',
    '[contenteditable]:not([contenteditable="false"])',
    '[translate="no"]',
    '.notranslate',
    '[data-fanyi-ui]'
  ].join(',');

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    translating: false,
    jobId: 0,
    records: [],
    translatedNodes: new WeakSet(),
    lastSelection: null,
    observer: null,
    observerTimer: 0,
    autoTranslating: false,
    autoCanceled: false,
    deferredDynamic: false
  };

  const selectionSession = {
    requestId: 0
  };

  let bubbleUI = null;
  let bubbleData = null;
  let progressUI = null;
  let progressHideTimer = 0;
  let panelUI = null;
  let panelOpen = false;
  let panelOriginal = '';
  let panelAnchor = null;
  let panelTranslation = '';
  let panelCanRetry = true;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                           */
  /* ------------------------------------------------------------------ */

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function normalizeRect(rect) {
    if (!rect) return null;
    const left = Number(rect.left);
    const top = Number(rect.top);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![left, top, width, height].every((value) => Number.isFinite(value))) return null;
    return {
      left,
      top,
      width,
      height,
      right: Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + width,
      bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height
    };
  }

  function rectToPlain(rect) {
    return normalizeRect(rect);
  }

  function usableRect(rect) {
    return Boolean(rect && (rect.width > 0 || rect.height > 0));
  }

  function languageLabel(code) {
    if (typeof window.fanyiLanguageLabel === 'function') {
      return window.fanyiLanguageLabel(code);
    }
    return code || '目标语言';
  }

  function sendRuntimeMessage(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      // 扩展被重新加载后，旧 content script 的上下文会失效，忽略即可。
    }
  }

  function emitPageEvent(phase, payload) {
    sendRuntimeMessage({ type: 'FC_PAGE_EVENT', phase, ...(payload || {}) });
  }

  /* ------------------------------------------------------------------ */
  /* 设置                                                               */
  /* ------------------------------------------------------------------ */

  function normalizeSettings(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    let targetLang = DEFAULT_SETTINGS.targetLang;
    if (typeof value.targetLang === 'string') {
      const supported = Array.isArray(window.FANYI_LANGUAGES)
        ? window.FANYI_LANGUAGES.some((item) => item.code === value.targetLang)
        : /^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(value.targetLang);
      if (supported) targetLang = value.targetLang;
    }
    return {
      targetLang,
      selectionBubble: value.selectionBubble !== false,
      autoTranslatePage: value.autoTranslatePage !== false,
      autoTranslateDynamic: value.autoTranslateDynamic === true
    };
  }

  async function loadSettings() {
    let loaded = null;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response && response.ok) loaded = response.settings;
    } catch (_) {
      // 后台未就绪时回退到 storage 直读。
    }

    if (!loaded) {
      try {
        loaded = await chrome.storage.local.get(DEFAULT_SETTINGS);
      } catch (_) {
        loaded = null;
      }
    }

    state.settings = normalizeSettings(loaded);
    applySettings();
  }

  function applySettings() {
    if (!state.settings.selectionBubble) hideBubble();
    syncObserver();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const previous = state.settings.autoTranslatePage;
    const next = { ...state.settings };
    let changed = false;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key]) {
        next[key] = changes[key].newValue;
        changed = true;
      }
    }
    if (!changed) return;
    state.settings = normalizeSettings(next);
    applySettings();
    // 弹窗/设置页刚开启自动翻译时，立即尝试翻译当前页面。
    if (!previous && state.settings.autoTranslatePage) maybeAutoTranslateNow();
  });

  /* ------------------------------------------------------------------ */
  /* Shadow DOM 样式                                                    */
  /* ------------------------------------------------------------------ */

  const SHADOW_STYLES = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .ui {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.55;
      color: #1f2328;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      pointer-events: auto;
    }

    .translate-trigger {
      position: fixed;
      min-width: 34px;
      height: 30px;
      padding: 0 10px;
      border: 1px solid rgba(255, 255, 255, 0.28);
      border-radius: 8px;
      background: #1f6feb;
      color: #ffffff;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Microsoft YaHei", sans-serif;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.3);
      user-select: none;
      pointer-events: auto;
    }
    .translate-trigger:hover { background: #195fc9; }
    .translate-trigger:active { background: #164faa; }

    .panel {
      position: fixed;
      display: flex;
      flex-direction: column;
      width: min(360px, calc(100vw - 24px));
      max-height: min(62vh, 540px);
      overflow: hidden;
      background: #ffffff;
      color: #1f2328;
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 14px;
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.22), 0 2px 8px rgba(15, 23, 42, 0.08);
      color-scheme: light dark;
      pointer-events: auto;
    }

    .panel-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: none;
      padding: 10px 10px 9px 14px;
      border-bottom: 1px solid #eef0f3;
    }
    .panel-title {
      flex: none;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .lang-badge {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      color: #6b7280;
      font-size: 11px;
      text-align: right;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .icon-btn {
      flex: none;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: #8a94a6;
      font: 20px/1 "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .icon-btn:hover { background: #eef1f5; color: #1f2328; }

    .panel-scroll {
      flex: 1 1 auto;
      min-height: 0;
      padding: 12px 14px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }

    .section + .section { margin-top: 12px; }
    .section-label {
      margin-bottom: 4px;
      color: #8a94a6;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .original {
      max-height: 108px;
      overflow-y: auto;
      color: #57606a;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .result {
      color: #111827;
      font-size: 14px;
      line-height: 1.65;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .loading {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 0 1px;
      color: #57606a;
    }

    .spinner {
      flex: none;
      width: 13px;
      height: 13px;
      border: 2px solid rgba(31, 111, 235, 0.24);
      border-top-color: #1f6feb;
      border-radius: 50%;
      animation: fanyi-spin 0.72s linear infinite;
    }
    @keyframes fanyi-spin { to { transform: rotate(360deg); } }

    .error {
      margin-top: 10px;
      padding: 8px 10px;
      border: 1px solid #fecdca;
      border-radius: 8px;
      background: #fef3f2;
      color: #b42318;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .panel-foot {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex: none;
      padding: 10px 12px;
      border-top: 1px solid #eef0f3;
      background: #fbfcfd;
    }

    .button {
      height: 30px;
      padding: 0 12px;
      border: 1px solid transparent;
      border-radius: 8px;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Microsoft YaHei", sans-serif;
      cursor: pointer;
    }
    .button:disabled { opacity: 0.5; cursor: default; }
    .button.primary { background: #1f6feb; color: #ffffff; }
    .button.primary:not(:disabled):hover { background: #195fc9; }
    .button.ghost {
      background: transparent;
      color: #344054;
      border-color: #d0d5dd;
    }
    .button.ghost:hover { background: #eef1f5; }

    .progress {
      position: fixed;
      right: 16px;
      bottom: 16px;
      display: flex;
      align-items: center;
      gap: 9px;
      max-width: min(430px, calc(100vw - 32px));
      padding: 9px 10px 9px 12px;
      border-radius: 10px;
      background: #1f2328;
      color: #ffffff;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
      font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Microsoft YaHei", sans-serif;
      color-scheme: light dark;
      pointer-events: auto;
    }
    .progress[data-tone="warn"] { background: #7c4a03; }
    .progress[data-tone="success"] { background: #14532d; }
    .progress[data-tone="error"] { background: #7f1d1d; }
    .progress-text {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .progress .spinner {
      border-color: rgba(255, 255, 255, 0.32);
      border-top-color: #ffffff;
    }
    .progress-action {
      flex: none;
      padding: 3px 8px;
      border: 1px solid rgba(255, 255, 255, 0.26);
      border-radius: 6px;
      background: transparent;
      color: #e5e7eb;
      font: 11.5px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Microsoft YaHei", sans-serif;
      cursor: pointer;
    }
    .progress-action:hover { background: rgba(255, 255, 255, 0.12); }

    @media (prefers-color-scheme: dark) {
      .panel {
        background: #1c2128;
        color: #e6edf3;
        border-color: rgba(240, 246, 252, 0.13);
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
      }
      .panel-head, .panel-foot { border-color: #30363d; }
      .panel-foot { background: #22272e; }
      .panel-title { color: #f0f6fc; }
      .lang-badge, .loading, .original { color: #8b949e; }
      .result { color: #e6edf3; }
      .icon-btn { color: #8b949e; }
      .icon-btn:hover { background: #30363d; color: #f0f6fc; }
      .section-label { color: #768390; }
      .error { color: #ffb4ab; background: #3d1d1d; border-color: #5c2b29; }
      .button.ghost { color: #c9d1d9; border-color: #444c56; }
      .button.ghost:hover { background: #30363d; }
    }
  `;

  function createUiHost(id) {
    const host = document.createElement('div');
    host.id = id;
    host.setAttribute(UI_ATTR, '');
    host.style.cssText = [
      'all: initial !important',
      'position: fixed !important',
      'top: 0 !important',
      'left: 0 !important',
      'width: 0 !important',
      'height: 0 !important',
      'display: block !important',
      'overflow: visible !important',
      'pointer-events: none !important',
      'z-index: 2147483647 !important'
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_STYLES;
    shadow.appendChild(style);

    (document.documentElement || document.body).appendChild(host);
    return { host, shadow };
  }

  function isEventFromUi(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.some((node) => node instanceof Element && node.hasAttribute(UI_ATTR));
  }

  /* ------------------------------------------------------------------ */
  /* 页面级进度提示                                                     */
  /* ------------------------------------------------------------------ */

  function ensureProgressUI() {
    if (progressUI && progressUI.host.isConnected) return progressUI;

    const { host, shadow } = createUiHost('fc-fanyi-progress-host');
    const card = document.createElement('div');
    card.className = 'ui progress';
    card.hidden = true;

    const spinner = document.createElement('span');
    spinner.className = 'spinner';

    const text = document.createElement('span');
    text.className = 'progress-text';

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'progress-action';
    action.textContent = '关闭';

    card.append(spinner, text, action);
    shadow.appendChild(card);

    progressUI = { host, shadow, card, spinner, text, action };

    action.addEventListener('click', () => {
      if (action.dataset.mode === 'cancel') {
        cancelPageTranslation();
      } else {
        hideProgress();
      }
    });

    return progressUI;
  }

  function showProgress(options) {
    const ui = ensureProgressUI();
    if (progressHideTimer) {
      clearTimeout(progressHideTimer);
      progressHideTimer = 0;
    }
    ui.card.hidden = false;
    ui.card.dataset.tone = options.tone || 'info';
    ui.text.textContent = options.text || '';
    ui.spinner.hidden = options.spinner === false;
    ui.action.dataset.mode = options.cancelable ? 'cancel' : 'close';
    ui.action.textContent = options.cancelable ? '取消' : '关闭';
  }

  function hideProgress() {
    if (progressHideTimer) {
      clearTimeout(progressHideTimer);
      progressHideTimer = 0;
    }
    if (progressUI) progressUI.card.hidden = true;
  }

  function scheduleProgressHide(ms) {
    if (progressHideTimer) clearTimeout(progressHideTimer);
    progressHideTimer = window.setTimeout(() => {
      progressHideTimer = 0;
      if (progressUI) progressUI.card.hidden = true;
    }, ms);
  }

  function showToast(message, tone, duration) {
    showProgress({ text: message, spinner: false, tone: tone || 'info', cancelable: false });
    if (duration) scheduleProgressHide(duration);
  }

  /* ------------------------------------------------------------------ */
  /* 选区翻译按钮                                                       */
  /* ------------------------------------------------------------------ */

  function ensureBubbleUI() {
    if (bubbleUI && bubbleUI.host.isConnected) return bubbleUI;

    const { host, shadow } = createUiHost('fc-fanyi-bubble-host');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui translate-trigger';
    button.textContent = '译';
    button.title = '翻译选中文本';
    button.setAttribute('aria-label', '翻译选中文本');
    button.style.display = 'none';
    shadow.appendChild(button);
    bubbleUI = { host, shadow, button };

    button.addEventListener('pointerdown', (event) => {
      // 防止按下按钮时浏览器清空选区。
      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const data = bubbleData;
      hideBubble();
      if (data && data.text) translateSelection(data.text, data.rect);
    });

    return bubbleUI;
  }

  function showBubble(data) {
    if (!state.settings.selectionBubble || !data || !data.text) return;

    const ui = ensureBubbleUI();
    bubbleData = data;
    const button = ui.button;

    button.style.display = 'block';
    button.style.visibility = 'hidden';

    const width = button.offsetWidth || 34;
    const height = button.offsetHeight || 30;
    const rect = usableRect(data.rect) ? data.rect : null;

    let left;
    let top;
    if (rect) {
      left = rect.left + rect.width / 2 - width / 2;
      top = rect.top - height - 8;
      if (top < 6) top = Math.min(rect.bottom + 8, window.innerHeight - height - 6);
    } else {
      left = (window.innerWidth - width) / 2;
      top = 80;
    }

    left = clamp(left, 6, Math.max(6, window.innerWidth - width - 6));
    top = clamp(top, 6, Math.max(6, window.innerHeight - height - 6));

    button.style.left = `${Math.round(left)}px`;
    button.style.top = `${Math.round(top)}px`;
    button.style.visibility = 'visible';
  }

  function hideBubble() {
    bubbleData = null;
    if (bubbleUI) bubbleUI.button.style.display = 'none';
  }

  function getCurrentSelectionData(options) {
    const allowExcluded = Boolean(options && options.allowExcluded);
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const text = selection.toString().trim();
    if (!text) return null;

    const anchorNode = selection.anchorNode;
    const container = anchorNode && anchorNode.nodeType === Node.ELEMENT_NODE
      ? anchorNode
      : anchorNode && anchorNode.parentElement;

    if (!container) return null;
    if (!allowExcluded) {
      if (container.getRootNode() !== document) return null;
      if (container.closest(EXCLUDED_SELECTOR)) return null;
    }

    let rect = null;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch (_) {
      rect = null;
    }

    return { text, rect: rect ? rectToPlain(rect) : null };
  }

  function handleMouseUp(event) {
    if (event.button !== 0 || isEventFromUi(event)) return;
    window.setTimeout(() => {
      const data = getCurrentSelectionData();
      if (!data) {
        hideBubble();
        return;
      }
      state.lastSelection = { text: data.text, rect: data.rect };
      if (state.settings.selectionBubble) showBubble(state.lastSelection);
    }, 0);
  }

  /* ------------------------------------------------------------------ */
  /* 选区翻译浮层                                                       */
  /* ------------------------------------------------------------------ */

  function ensurePanelUI() {
    if (panelUI && panelUI.host.isConnected) return panelUI;

    const { host, shadow } = createUiHost('fc-fanyi-panel-host');
    const panel = document.createElement('div');
    panel.className = 'ui panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="panel-head">
        <span class="panel-title">翻译</span>
        <span class="lang-badge"></span>
        <button type="button" class="icon-btn close" title="关闭" aria-label="关闭">×</button>
      </div>
      <div class="panel-scroll">
        <div class="section">
          <div class="section-label">原文</div>
          <div class="original"></div>
        </div>
        <div class="section result-section" hidden>
          <div class="section-label">译文</div>
          <div class="result"></div>
        </div>
        <div class="loading">
          <span class="spinner"></span>
          <span>正在翻译…</span>
        </div>
        <div class="error" hidden></div>
      </div>
      <div class="panel-foot">
        <button type="button" class="button ghost retry" hidden>重试</button>
        <button type="button" class="button primary copy" disabled>复制译文</button>
      </div>
    `;

    shadow.appendChild(panel);

    const parts = {
      lang: panel.querySelector('.lang-badge'),
      original: panel.querySelector('.original'),
      resultSection: panel.querySelector('.result-section'),
      result: panel.querySelector('.result'),
      loading: panel.querySelector('.loading'),
      error: panel.querySelector('.error'),
      retry: panel.querySelector('.retry'),
      copy: panel.querySelector('.copy'),
      close: panel.querySelector('.close')
    };

    panelUI = { host, shadow, panel, parts };

    parts.close.addEventListener('click', () => closePanel());
    parts.copy.addEventListener('click', () => {
      copyPanelTranslation();
    });
    parts.retry.addEventListener('click', () => {
      if (!panelCanRetry || !panelOriginal) return;
      translateSelection(panelOriginal, panelAnchor);
    });

    return panelUI;
  }

  function refreshPanelPosition() {
    if (!panelOpen) return;
    window.requestAnimationFrame(() => {
      if (!panelOpen) return;
      positionPanel();
    });
  }

  function positionPanel() {
    if (!panelUI || !panelOpen || panelUI.panel.hidden) return;

    const margin = 12;
    const rect = panelUI.panel.getBoundingClientRect();
    const width = rect.width || 360;
    const height = rect.height || 200;

    let left;
    let top;
    if (usableRect(panelAnchor)) {
      left = panelAnchor.left;
      top = panelAnchor.bottom + 10;
      if (top + height > window.innerHeight - margin) {
        top = panelAnchor.top - height - 10;
      }
    } else {
      left = (window.innerWidth - width) / 2;
      top = (window.innerHeight - height) / 2;
    }

    left = clamp(left, margin, Math.max(margin, window.innerWidth - width - margin));
    top = clamp(top, margin, Math.max(margin, window.innerHeight - height - margin));

    panelUI.panel.style.left = `${Math.round(left)}px`;
    panelUI.panel.style.top = `${Math.round(top)}px`;
  }

  function openSelectionPanel(original, anchor, options) {
    const ui = ensurePanelUI();
    const config = options || {};

    panelOpen = true;
    panelOriginal = original;
    panelAnchor = normalizeRect(anchor);
    panelTranslation = '';
    panelCanRetry = config.canRetry !== false;

    hideBubble();

    ui.parts.lang.textContent = `自动检测 → ${languageLabel(state.settings.targetLang)}`;
    ui.parts.original.textContent = original.length > 4000
      ? `${original.slice(0, 4000)}…`
      : original;
    ui.parts.copy.textContent = '复制译文';
    ui.parts.copy.disabled = true;
    ui.parts.retry.hidden = true;

    ui.panel.hidden = false;
    ui.panel.style.visibility = 'hidden';
    ui.panel.style.left = '-10000px';
    ui.panel.style.top = '0px';

    if (config.error) {
      setPanelError(config.error, panelCanRetry);
    } else if (config.translation) {
      setPanelResult(config.translation);
    } else {
      setPanelLoading();
    }

    window.requestAnimationFrame(() => {
      if (!panelOpen) return;
      positionPanel();
      ui.panel.style.visibility = 'visible';
    });
  }

  function setPanelLoading() {
    if (!panelUI) return;
    const parts = panelUI.parts;
    parts.loading.hidden = false;
    parts.resultSection.hidden = true;
    parts.error.hidden = true;
    parts.retry.hidden = true;
    parts.copy.disabled = true;
    refreshPanelPosition();
  }

  function setPanelResult(translation) {
    if (!panelUI) return;
    panelTranslation = translation;
    const parts = panelUI.parts;
    parts.loading.hidden = true;
    parts.result.hidden = false;
    parts.resultSection.hidden = false;
    parts.result.textContent = translation;
    parts.error.hidden = true;
    parts.retry.hidden = true;
    parts.copy.disabled = false;
    parts.copy.textContent = '复制译文';
    refreshPanelPosition();
  }

  function setPanelError(message, canRetry) {
    if (!panelUI) return;
    panelTranslation = '';
    const parts = panelUI.parts;
    parts.loading.hidden = true;
    parts.resultSection.hidden = true;
    parts.error.hidden = false;
    parts.error.textContent = message;
    parts.retry.hidden = !canRetry;
    parts.copy.disabled = true;
    refreshPanelPosition();
  }

  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    selectionSession.requestId += 1;
    panelOriginal = '';
    panelAnchor = null;
    panelTranslation = '';
    if (panelUI) {
      panelUI.panel.hidden = true;
      panelUI.panel.style.visibility = 'hidden';
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // 某些页面不是安全上下文，回退到 execCommand。
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    textarea.remove();
    return ok;
  }

  async function copyPanelTranslation() {
    if (!panelUI || !panelTranslation) return;
    const button = panelUI.parts.copy;
    const ok = await copyText(panelTranslation);
    button.textContent = ok ? '已复制' : '复制失败';
    window.setTimeout(() => {
      if (!panelUI) return;
      button.textContent = '复制译文';
      button.disabled = !panelTranslation;
    }, 1500);
  }

  function translateSelection(rawText, anchorRect) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';

    if (!text) {
      showToast('请先选中要翻译的文本', 'info', 2400);
      return;
    }

    if (text.length > MAX_SELECTION_CHARS) {
      selectionSession.requestId += 1;
      hideBubble();
      openSelectionPanel(
        `${text.slice(0, 1200)}…`,
        anchorRect,
        {
          error: `选中文本过长（${text.length} 字），最多支持 ${MAX_SELECTION_CHARS} 字，请分段翻译。`,
          canRetry: false
        }
      );
      return;
    }

    hideBubble();
    const requestId = ++selectionSession.requestId;

    openSelectionPanel(text, anchorRect, { loading: true, canRetry: true });

    (async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'TRANSLATE_TEXTS',
          texts: [text],
          from: '',
          to: state.settings.targetLang
        });

        if (requestId !== selectionSession.requestId) return;
        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : '翻译失败，请稍后重试');
        }

        const translated = response.translations && response.translations[0];
        if (typeof translated !== 'string' || !translated.trim()) {
          throw new Error('翻译接口返回了空译文');
        }

        setPanelResult(translated);
      } catch (error) {
        if (requestId !== selectionSession.requestId) return;
        setPanelError(
          (error && error.message) || '翻译失败，请稍后重试',
          panelCanRetry
        );
      }
    })();
  }

  function handleContextMenuSelection(message) {
    const provided = typeof message.text === 'string' ? message.text.trim() : '';
    const current = getCurrentSelectionData({ allowExcluded: true });
    const text = provided || (current && current.text) || '';

    if (!text) {
      showToast('未选中可翻译的文本', 'info', 2400);
      return;
    }

    let anchor = null;
    if (current && (!provided || current.text === provided)) {
      anchor = current.rect;
    } else if (state.lastSelection && (!provided || state.lastSelection.text === provided)) {
      anchor = state.lastSelection.rect;
    }

    translateSelection(text, anchor);
  }

  /* ------------------------------------------------------------------ */
  /* 整页翻译                                                           */
  /* ------------------------------------------------------------------ */

  function isVisibleElement(element, cache) {
    if (cache.has(element)) return cache.get(element);
    let visible = true;
    try {
      const style = window.getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      ) {
        visible = false;
      } else {
        visible = element.getClientRects().length > 0;
      }
    } catch (_) {
      visible = true;
    }
    cache.set(element, visible);
    return visible;
  }

  function shouldTranslateText(raw) {
    const text = raw.trim();
    if (!text || text.length > MAX_PAGE_TEXT_CHARS) return false;
    // 至少包含一个 Unicode 字母（含中日韩文字），排除纯数字/纯符号。
    if (!/\p{L}/u.test(text)) return false;
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(text)) return false;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text)) return false;
    return true;
  }

  function collectTextNodes(root) {
    if (!root) return [];
    const visibilityCache = new Map();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !shouldTranslateText(node.nodeValue)) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(EXCLUDED_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (state.translatedNodes.has(node)) return NodeFilter.FILTER_REJECT;
        if (!isVisibleElement(parent, visibilityCache)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let current;
    while ((current = walker.nextNode())) nodes.push(current);
    return nodes;
  }

  function groupTextNodes(nodes) {
    const groups = new Map();
    for (const node of nodes) {
      const text = node.nodeValue.trim();
      const existing = groups.get(text);
      if (existing) existing.push(node);
      else groups.set(text, [node]);
    }
    return groups;
  }

  function buildBatches(groups) {
    const batches = [];
    let batch = [];
    let chars = 0;

    for (const entry of groups) {
      const length = entry[0].length;
      if (
        batch.length > 0 &&
        (batch.length >= PAGE_BATCH_SIZE || chars + length > PAGE_BATCH_CHARS)
      ) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(entry);
      chars += length;
    }

    if (batch.length > 0) batches.push(batch);
    return batches;
  }

  function applyTranslation(nodes, sourceText, translation) {
    const translated = typeof translation === 'string' ? translation.trim() : '';
    if (!translated) return;

    for (const node of nodes) {
      if (!node.isConnected || state.translatedNodes.has(node)) continue;
      if (!node.nodeValue || node.nodeValue.trim() !== sourceText) continue;

      const original = node.nodeValue;
      const leading = original.match(/^\s*/)[0];
      const trailing = original.match(/\s*$/)[0];

      node.nodeValue = leading + translated + trailing;
      state.translatedNodes.add(node);
      state.records.push({ node, original });
    }
  }

  async function translateGroups(groups, options) {
    const optionsValue = options || {};
    const jobId = optionsValue.jobId;
    const onProgress = optionsValue.onProgress;
    const targetLang = optionsValue.to || state.settings.targetLang;
    const batches = buildBatches(groups);
    const total = groups.size;

    let done = 0;
    let failed = 0;
    let lastError = '';

    for (const batch of batches) {
      if (jobId !== undefined && jobId !== state.jobId) {
        return { canceled: true, done, failed, lastError, total };
      }

      const texts = batch.map((entry) => entry[0]);

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'TRANSLATE_TEXTS',
          texts,
          from: '',
          to: targetLang
        });

        if (jobId !== undefined && jobId !== state.jobId) {
          return { canceled: true, done, failed, lastError, total };
        }
        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : '翻译请求失败');
        }

        const translations = response.translations;
        if (!Array.isArray(translations) || translations.length !== texts.length) {
          throw new Error('译文数量与原文数量不一致');
        }

        for (let i = 0; i < batch.length; i += 1) {
          applyTranslation(batch[i][1], batch[i][0], translations[i]);
          done += 1;
        }
      } catch (error) {
        failed += batch.length;
        lastError = (error && error.message) || '翻译失败';
        console.warn('[封尘翻译] 批次翻译失败：', error);
      }

      if (typeof onProgress === 'function') {
        try {
          onProgress({ done, failed, total, lastError });
        } catch (_) {
          // 进度回调异常不应中断翻译。
        }
      }
    }

    return { canceled: false, done, failed, lastError, total };
  }

  async function translatePage(isAuto) {
    // 自动翻译被取消或恢复过原文后，本次浏览不再自动开始；手动翻译不受影响。
    if (isAuto && state.autoCanceled) {
      return { ok: false, error: '自动翻译已取消' };
    }

    if (state.translating) {
      if (!isAuto) {
        showProgress({
          text: '正在翻译中，请稍候…',
          spinner: true,
          tone: 'info',
          cancelable: true
        });
      }
      return { ok: false, error: '翻译正在进行中' };
    }

    if (state.records.length > 0) {
      if (!isAuto) showToast('当前页面已翻译；更换语言前请先恢复原文', 'info', 3200);
      emitPageEvent('noop', { message: '页面已翻译，请先恢复原文' });
      return { ok: false, error: '页面已翻译' };
    }

    const nodes = collectTextNodes(document.body);
    if (nodes.length === 0) {
      if (!isAuto) showToast('未找到可翻译的文本', 'info', 2600);
      emitPageEvent('noop', { message: '未找到可翻译的文本' });
      return { ok: false, error: '未找到可翻译的文本' };
    }

    const groups = groupTextNodes(nodes);
    const total = groups.size;
    const targetLang = state.settings.targetLang;
    hideBubble();

    const jobId = ++state.jobId;
    state.translating = true;
    emitPageEvent('started', { total });
    showProgress({
      text: `正在翻译 0%（0/${total} 段）`,
      spinner: true,
      tone: 'info',
      cancelable: true
    });

    try {
      const result = await translateGroups(groups, {
        jobId,
        to: targetLang,
        onProgress: ({ done, failed, total: groupTotal }) => {
          const processed = done + failed;
          const percent = Math.min(100, Math.max(1, Math.round((processed / groupTotal) * 100)));
          const failedSuffix = failed > 0 ? `，${failed} 段失败` : '';
          showProgress({
            text: `正在翻译 ${percent}%（${processed}/${groupTotal} 段）${failedSuffix}`,
            spinner: true,
            tone: 'info',
            cancelable: true
          });
          emitPageEvent('progress', {
            percent,
            processed,
            total: groupTotal,
            failed
          });
        }
      });

      if (result.canceled || jobId !== state.jobId) {
        return { ok: false, canceled: true };
      }

      if (state.records.length === 0) {
        const message = result.lastError
          ? `翻译失败：${result.lastError}`
          : '翻译失败，未获得任何译文';
        showProgress({
          text: message,
          spinner: false,
          tone: 'error',
          cancelable: false
        });
        emitPageEvent('error', { error: message });
        return { ok: false, error: message };
      }

      if (result.failed > 0) {
        const message = `完成 ${result.done}/${result.total} 段，${result.failed} 段失败${
          result.lastError ? `：${result.lastError}` : ''
        }`;
        showProgress({
          text: message,
          spinner: false,
          tone: 'warn',
          cancelable: false
        });
        emitPageEvent('done', {
          translated: result.done,
          failed: result.failed,
          error: result.lastError
        });
        scheduleProgressHide(8000);
      } else {
        const message = `翻译完成，共 ${result.done} 段 → ${languageLabel(targetLang)}`;
        showProgress({
          text: message,
          spinner: false,
          tone: 'success',
          cancelable: false
        });
        emitPageEvent('done', {
          translated: result.done,
          failed: 0,
          error: ''
        });
        scheduleProgressHide(3500);
      }

      return { ok: true, translated: result.done, failed: result.failed };
    } catch (error) {
      const message = `翻译失败：${(error && error.message) || '未知错误'}`;
      showProgress({
        text: message,
        spinner: false,
        tone: 'error',
        cancelable: false
      });
      emitPageEvent('error', { error: message });
      return { ok: false, error: message };
    } finally {
      if (jobId === state.jobId) {
        state.translating = false;
        scheduleDeferredDynamic();
      }
    }
  }

  function cancelPageTranslation() {
    if (!state.translating) return;
    state.jobId += 1;
    state.translating = false;
    state.autoCanceled = true;

    showProgress({
      text: `已停止翻译，已完成的 ${state.records.length} 处内容可恢复原文`,
      spinner: false,
      tone: 'warn',
      cancelable: false
    });
    scheduleProgressHide(4500);
    emitPageEvent('canceled', { translated: state.records.length });
  }

  function restorePage() {
    if (state.translating) {
      // 静默取消，由 restorePage 统一提示。
      state.jobId += 1;
      state.translating = false;
    }
    // 恢复原文代表用户想看原文，本次浏览不再自动翻译。
    state.autoCanceled = true;

    const recordCount = state.records.length;
    let restored = 0;

    for (let i = recordCount - 1; i >= 0; i -= 1) {
      const record = state.records[i];
      try {
        if (record.node && record.node.isConnected) {
          record.node.nodeValue = record.original;
          restored += 1;
        }
      } catch (_) {
        // 节点可能已被页面卸载。
      }
    }

    state.records = [];
    state.translatedNodes = new WeakSet();
    hideBubble();

    if (recordCount === 0) {
      showToast('当前页面没有已翻译的内容', 'info', 2400);
    } else if (restored > 0) {
      showProgress({
        text: `已恢复原文（${restored} 处）`,
        spinner: false,
        tone: 'success',
        cancelable: false
      });
      scheduleProgressHide(2500);
    } else {
      showProgress({
        text: '原文节点已被页面替换，无法恢复',
        spinner: false,
        tone: 'warn',
        cancelable: false
      });
      scheduleProgressHide(4000);
    }

    emitPageEvent('restored', { restored });
    return { ok: true, restored, hadRecords: recordCount };
  }

  function getPageState() {
    return {
      ok: true,
      translating: state.translating,
      translatedNodes: state.records.length,
      hasTranslations: state.records.length > 0
    };
  }

  /* ------------------------------------------------------------------ */
  /* 自动翻译（页面加载后）                                             */
  /* ------------------------------------------------------------------ */

  const AUTO_TRANSLATE_DELAY_MS = 600;        // load 之后的缓冲，等页面渲染
  const AUTO_TRANSLATE_EXTRA_DELAY_MS = 3200; // 首扫之后补扫一次新增文本
  const AUTO_TRANSLATE_SAMPLE_CHARS = 900;

  // 常用简繁对照字（只收录简繁写法不同的常用字），用于区分 zh-Hans / zh-Hant。
  const SIMP_ONLY_CHARS = '简体译网页语这们时车东对发经线点里开关门问间队长机电书学后钱办边还进远动场医历压厂广应态风飞龙马鸟齿岁记让谈论识别测试设备银难显贝质观传达产亚环';
  const TRAD_ONLY_CHARS = '簡體譯網頁語這們時車東對發經線點裡開關門問間隊長機電書學後錢辦邊還進遠動場醫歷壓廠廣應態風飛龍馬鳥齒歲記讓談論識別測試設備銀難顯貝質觀傳達產亞環';
  const SIMP_SET = new Set(SIMP_ONLY_CHARS);
  const TRAD_SET = new Set(TRAD_ONLY_CHARS);

  function countFromSet(text, set) {
    let count = 0;
    for (const ch of text) {
      if (set.has(ch)) count += 1;
    }
    return count;
  }

  function countScripts(text) {
    const counts = {
      latin: 0, han: 0, kana: 0, hangul: 0, cyrillic: 0,
      greek: 0, arabic: 0, hebrew: 0, thai: 0, devanagari: 0
    };
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff)) {
        counts.kana += 1;
      } else if (
        (cp >= 0x1100 && cp <= 0x11ff) ||
        (cp >= 0x3130 && cp <= 0x318f) ||
        (cp >= 0xac00 && cp <= 0xd7af)
      ) {
        counts.hangul += 1;
      } else if (
        (cp >= 0x2e80 && cp <= 0x2eff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xf900 && cp <= 0xfaff)
      ) {
        counts.han += 1;
      } else if (cp >= 0x0400 && cp <= 0x04ff) {
        counts.cyrillic += 1;
      } else if ((cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff)) {
        counts.greek += 1;
      } else if (cp >= 0x0600 && cp <= 0x06ff) {
        counts.arabic += 1;
      } else if (cp >= 0x0590 && cp <= 0x05ff) {
        counts.hebrew += 1;
      } else if (cp >= 0x0e00 && cp <= 0x0e7f) {
        counts.thai += 1;
      } else if (cp >= 0x0900 && cp <= 0x097f) {
        counts.devanagari += 1;
      } else if (
        (cp >= 0x0041 && cp <= 0x005a) ||
        (cp >= 0x0061 && cp <= 0x007a) ||
        (cp >= 0x00c0 && cp <= 0x024f)
      ) {
        counts.latin += 1;
      }
    }
    return counts;
  }

  function pickScriptBase(counts) {
    const total =
      counts.latin + counts.han + counts.kana + counts.hangul + counts.cyrillic +
      counts.greek + counts.arabic + counts.hebrew + counts.thai + counts.devanagari;
    if (total <= 0) return '';

    // 至少占样本字母数的 20% 且不少于 6 个，避免个别外来词导致误判。
    const threshold = Math.max(6, Math.floor(total * 0.2));
    if (counts.kana >= threshold) return 'ja';
    if (counts.hangul >= threshold && counts.hangul > counts.han) return 'ko';
    if (counts.han >= threshold) return 'zh';
    if (counts.cyrillic >= threshold) return 'ru';
    if (counts.arabic >= threshold) return 'ar';
    if (counts.thai >= threshold) return 'th';
    if (counts.greek >= threshold) return 'el';
    if (counts.hebrew >= threshold) return 'he';
    if (counts.devanagari >= threshold) return 'hi';
    return '';
  }

  function hanVariantOf(sample) {
    const simp = countFromSet(sample, SIMP_SET);
    const trad = countFromSet(sample, TRAD_SET);
    if (simp >= 2 && simp > trad * 2) return 'zh-Hans';
    if (trad >= 2 && trad > simp * 2) return 'zh-Hant';
    return '';
  }

  function getDocumentLangAttribute() {
    const root = document.documentElement;
    const body = document.body;
    const attr = (root && root.getAttribute('lang')) || (body && body.getAttribute('lang')) || '';
    return String(attr).trim().toLowerCase();
  }

  function collectPageSample(maxChars) {
    if (!document.body) return '';
    const visibilityCache = new Map();

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest(EXCLUDED_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (!isVisibleElement(parent, visibilityCache)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let sample = '';
    let current;
    while ((current = walker.nextNode())) {
      const value = current.nodeValue.trim();
      sample = sample ? `${sample} ${value}` : value;
      if (sample.length >= maxChars) break;
    }
    return sample.slice(0, maxChars);
  }

  function detectLanguageCode(text) {
    return new Promise((resolve) => {
      try {
        if (!chrome.i18n || typeof chrome.i18n.detectLanguage !== 'function') {
          resolve('');
          return;
        }
        chrome.i18n.detectLanguage(text, (result) => {
          void chrome.runtime.lastError;
          const top = result && Array.isArray(result.languages) && result.languages[0];
          resolve(top && typeof top.language === 'string' ? top.language : '');
        });
      } catch (_) {
        resolve('');
      }
    });
  }

  /**
   * 判断页面语言是否与目标语言一致，一致则跳过自动翻译。
   * 依次参考 html lang 属性、样本文字的主要书写系统、chrome.i18n 检测结果。
   */
  async function pageLanguageMatchesTarget(targetLang) {
    const target = String(targetLang || '');
    const base = target.split('-')[0].toLowerCase();
    if (!base) return false;

    const attr = getDocumentLangAttribute();
    if (attr) {
      const attrBase = attr.split('-')[0];
      if (attrBase && attrBase !== base) return false;
    }

    const sample = collectPageSample(AUTO_TRANSLATE_SAMPLE_CHARS);
    if (!sample) return false;

    const scriptBase = pickScriptBase(countScripts(sample));
    if (scriptBase) {
      if (scriptBase !== base) return false;
      if (base === 'zh') {
        const variant = hanVariantOf(sample);
        if (variant) return variant === target;
      }
      return true;
    }

    const detected = await detectLanguageCode(sample);
    if (detected) return detected.split('-')[0].toLowerCase() === base;
    return false;
  }

  function shouldAutoTranslateNewNodes() {
    if (state.settings.autoTranslateDynamic) return true;
    return state.settings.autoTranslatePage && !state.autoCanceled;
  }

  function scheduleAutoTranslate() {
    if (document.readyState === 'complete') {
      startAutoTranslate();
      return;
    }
    window.addEventListener('load', () => startAutoTranslate(), { once: true });
  }

  function startAutoTranslate() {
    window.setTimeout(() => {
      if (!state.settings.autoTranslatePage) return;
      if (state.translating || state.autoTranslating) return;
      if (state.records.length > 0 || state.autoCanceled) return;

      (async () => {
        try {
          if (await pageLanguageMatchesTarget(state.settings.targetLang)) return;
          await translatePage(true);
        } catch (error) {
          console.warn('[封尘翻译] 自动翻译失败：', error);
          return;
        }
        // 部分页面正文加载较慢，首扫可能没有内容，稍后补扫一次新增文本。
        window.setTimeout(() => {
          if (!state.settings.autoTranslatePage || state.autoCanceled) return;
          translateDynamicContent(true).catch(() => {});
        }, AUTO_TRANSLATE_EXTRA_DELAY_MS);
      })();
    }, AUTO_TRANSLATE_DELAY_MS);
  }

  // 弹窗/设置页刚开启自动翻译时对当前页面立即生效。
  function maybeAutoTranslateNow() {
    if (document.readyState === 'loading') return;
    if (state.translating || state.autoTranslating) return;
    if (state.records.length > 0 || state.autoCanceled) return;

    (async () => {
      try {
        if (await pageLanguageMatchesTarget(state.settings.targetLang)) return;
        await translatePage(true);
      } catch (_) {
        // 自动翻译失败不影响页面使用。
      }
    })();
  }

  /* ------------------------------------------------------------------ */
  /* 动态内容观察器                                                     */
  /* ------------------------------------------------------------------ */

  function startObserver() {
    if (state.observer || !document.body) return;

    state.observer = new MutationObserver((mutations) => {
      if (!shouldAutoTranslateNewNodes()) return;

      let hasAdded = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          hasAdded = true;
          break;
        }
      }
      if (!hasAdded) return;

      // 翻译进行中先记下来，等本轮结束后补扫，避免漏翻这段时间新增的内容。
      if (state.translating || state.autoTranslating) {
        state.deferredDynamic = true;
        return;
      }

      if (state.observerTimer) clearTimeout(state.observerTimer);
      state.observerTimer = window.setTimeout(() => {
        state.observerTimer = 0;
        translateDynamicContent();
      }, 900);
    });

    // 只观察新增节点，不观察 characterData，避免自身替换文本触发循环。
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.observerTimer) {
      clearTimeout(state.observerTimer);
      state.observerTimer = 0;
    }
  }

  function syncObserver() {
    if (shouldAutoTranslateNewNodes()) startObserver();
    else stopObserver();
  }

  // 翻译进行中错过的新增节点，在本轮翻译结束后补扫一次。
  function scheduleDeferredDynamic() {
    if (!state.deferredDynamic) return;
    state.deferredDynamic = false;
    if (!shouldAutoTranslateNewNodes()) return;
    window.setTimeout(() => {
      translateDynamicContent().catch(() => {});
    }, 1000);
  }

  async function translateDynamicContent(force) {
    if (state.autoTranslating || state.translating || !document.body) return;
    if (!force && !shouldAutoTranslateNewNodes()) return;

    const nodes = collectTextNodes(document.body);
    if (nodes.length === 0) return;
    const groups = groupTextNodes(nodes);

    state.autoTranslating = true;
    try {
      const result = await translateGroups(groups, {
        jobId: state.jobId,
        to: state.settings.targetLang
      });
      if (!result.canceled && result.failed > 0) {
        console.warn('[封尘翻译] 动态内容部分翻译失败：', result.lastError);
      }
    } catch (error) {
      console.warn('[封尘翻译] 动态内容翻译失败：', error);
    } finally {
      state.autoTranslating = false;
      scheduleDeferredDynamic();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定与消息接收                                                 */
  /* ------------------------------------------------------------------ */

  document.addEventListener('mousedown', (event) => {
    if (!isEventFromUi(event)) hideBubble();
  }, true);

  document.addEventListener('mouseup', handleMouseUp, true);

  document.addEventListener('contextmenu', () => {
    const data = getCurrentSelectionData({ allowExcluded: true });
    if (data) {
      state.lastSelection = { text: data.text, rect: data.rect };
    }
    hideBubble();
  }, true);

  document.addEventListener('selectionchange', () => {
    if (!getCurrentSelectionData()) hideBubble();
  });

  document.addEventListener('keyup', (event) => {
    const keys = ['Shift', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) return;

    const data = getCurrentSelectionData();
    if (!data) return;
    state.lastSelection = { text: data.text, rect: data.rect };
    if (state.settings.selectionBubble) showBubble(state.lastSelection);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    hideBubble();
    if (panelOpen) closePanel();
  }, true);

  window.addEventListener('scroll', hideBubble, true);
  window.addEventListener('resize', () => {
    hideBubble();
    refreshPanelPosition();
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;

    switch (message.type) {
      case 'FC_PING':
        sendResponse({ ok: true, loaded: true });
        return false;

      case 'FC_TRANSLATE_PAGE':
        translatePage().catch((error) => {
          console.warn('[封尘翻译] 整页翻译异常：', error);
        });
        sendResponse({ ok: true });
        return false;

      case 'FC_RESTORE_PAGE':
        sendResponse(restorePage());
        return false;

      case 'FC_GET_PAGE_STATE':
        sendResponse(getPageState());
        return false;

      case 'TRANSLATE_SELECTION':
        handleContextMenuSelection(message);
        sendResponse({ ok: true });
        return false;

      default:
        return undefined;
    }
  });

  loadSettings()
    .then(() => {
      scheduleAutoTranslate();
    })
    .catch((error) => {
      console.warn('[封尘翻译] 读取设置失败，使用默认设置：', error);
      scheduleAutoTranslate();
    });
})();
