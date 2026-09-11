const URL_RE = /https?:\/\/[^\s<>"'`）)\]｝}、。，]+/g;

function collectUrls(text) {
  const out = new Set();
  for (const m of String(text || '').match(URL_RE) || []) {

    out.add(m.replace(/[.,;:!?）)\]｝}」』"']+$/, ''));
  }
  return out;
}

function normalizeUrl(u) {
  try {
    const url = new URL(String(u));
    url.hash = '';
    let s = url.toString();
    if (s.endsWith('/') && !url.search) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return String(u || '').trim().toLowerCase();
  }
}

function hasProvenance(url, seen) {
  const want = normalizeUrl(url);
  for (const s of seen) {
    if (normalizeUrl(s) === want) return true;
  }
  return false;
}

const DROP = /<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi;

const BLOCK = /<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi;

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(DROP, ' ');

  s = s.replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n\n' + '#'.repeat(Number(n)) + ' ');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(BLOCK, '\n');
  s = s.replace(/<[^>]+>/g, '');

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  s = s.replace(/&(#?\w+);/g, (m, k) => (k in ENT ? ENT[k] : m));

  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? htmlToText(m[1]).slice(0, 120) : '';
}

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';

function searchUrl(query) {
  return SEARCH_ENDPOINT + '?q=' + encodeURIComponent(String(query || '').trim());
}

function searchResults(html, limit = 10) {
  const out = [];
  const text = String(html || '');
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  const snips = [];
  const sre = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let sm;
  while ((sm = sre.exec(text))) snips.push(裸(sm[1]));
  let m;
  let i = 0;
  while ((m = re.exec(text)) && out.length < limit) {
    const url = 本当の場所(m[1]);
    if (!url) {
      i += 1;
      continue;
    }
    out.push({ title: 裸(m[2]), url, snippet: snips[i] || '' });
    i += 1;
  }
  return out;
}

function 裸(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function 本当の場所(href) {
  const raw = String(href || '');
  const m = /[?&]uddg=([^&]+)/.exec(raw);
  const s = m ? decodeURIComponent(m[1]) : raw.startsWith('//') ? 'https:' + raw : raw;
  return /^https?:\/\//i.test(s) ? s : '';
}

module.exports = {
  collectUrls,
  normalizeUrl,
  hasProvenance,
  htmlToText,
  titleOf,
  URL_RE,
  searchUrl,
  searchResults,
  SEARCH_ENDPOINT,
};
