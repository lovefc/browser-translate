/* 语言表由 popup、options 和 content script 共用（普通脚本，无构建步骤） */
(function (root) {
  'use strict';

  var languages = [
    { code: 'zh-Hans', label: '简体中文' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
    { code: 'ru', label: 'Русский' },
    { code: 'pt', label: 'Português' },
    { code: 'it', label: 'Italiano' },
    { code: 'ar', label: 'العربية' },
    { code: 'th', label: 'ไทย' },
    { code: 'vi', label: 'Tiếng Việt' },
    { code: 'id', label: 'Bahasa Indonesia' },
    { code: 'tr', label: 'Türkçe' },
    { code: 'nl', label: 'Nederlands' },
    { code: 'pl', label: 'Polski' }
  ];

  root.FANYI_LANGUAGES = languages;
  root.fanyiLanguageLabel = function (code) {
    for (var i = 0; i < languages.length; i += 1) {
      if (languages[i].code === code) return languages[i].label;
    }
    return code || '目标语言';
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
