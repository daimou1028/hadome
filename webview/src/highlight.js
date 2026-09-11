const { createHighlighterCore } = require('shiki/core');
const { createJavaScriptRegexEngine } = require('shiki/engine/javascript');

const LANGS = {
  json: require('@shikijs/langs/json'),
  php: require('@shikijs/langs/php'),
  html: require('@shikijs/langs/html'),
  javascript: require('@shikijs/langs/javascript'),
  css: require('@shikijs/langs/css'),
  ini: require('@shikijs/langs/ini'),
};

const ALIAS = {
  js: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  ts: 'javascript',
  htm: 'html',
  jsonc: 'json',
  toml: 'ini',
  conf: 'ini',
  bash: null,
  sh: null,
  shell: null,
  text: null,
  plaintext: null,
  txt: null,
};

const DARK = require('@shikijs/themes/dark-plus');
const LIGHT = require('@shikijs/themes/light-plus');

let ready = null;

function normalizeLang(lang) {
  const k = String(lang || '').toLowerCase();
  if (!k) return null;
  if (Object.prototype.hasOwnProperty.call(ALIAS, k)) return ALIAS[k];
  return LANGS[k] ? k : null;
}

function themeFor(kind) {
  const k = String(kind || '');
  if (k === 'vscode-light' || k === 'vscode-high-contrast-light') return 'light-plus';
  return 'dark-plus';
}

function getHighlighter() {
  if (!ready) {
    ready = createHighlighterCore({
      themes: [DARK, LIGHT],
      langs: Object.values(LANGS),

      engine: createJavaScriptRegexEngine(),
    });
  }
  return ready;
}

async function highlight(code, lang, kind) {
  const l = normalizeLang(lang);
  if (!l) return null;
  try {
    const h = await getHighlighter();
    return h.codeToHtml(String(code), { lang: l, theme: themeFor(kind) });
  } catch {

    return null;
  }
}

module.exports = { highlight, normalizeLang, themeFor, LANGS, ALIAS };
