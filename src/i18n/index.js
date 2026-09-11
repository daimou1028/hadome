const ja = require('./ja');
const en = require('./en');
const zhTw = require('./zh-tw');

const BOOKS = { ja, en, 'zh-tw': zhTw };

const FALLBACK = 'en';

function bookNameFor(locale) {
  const raw = String(locale || '').toLowerCase();
  if (BOOKS[raw]) return raw;

  if (/^zh\b/.test(raw) && /(tw|hant|hk|mo)/.test(raw)) return 'zh-tw';
  const head = raw.split(/[-_]/)[0];
  if (BOOKS[head]) return head;
  return FALLBACK;
}

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : whole
  );
}

function makeT(locale) {
  const name = bookNameFor(locale);
  const book = BOOKS[name];
  return function t(key, vars) {

    if (vars && Number(vars.n) === 1 && book[key + '_one']) {
      return fill(book[key + '_one'], vars);
    }
    const text = book[key] != null ? book[key] : ja[key];
    return text != null ? fill(text, vars) : key;
  };
}

module.exports = { makeT, bookNameFor, BOOKS, FALLBACK, fill };
