const ASCII_PER_TOKEN = 4;

function estimateTokens(text) {
  const s = String(text || '');
  let ascii = 0;
  let wide = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / ASCII_PER_TOKEN) + wide;
}

function estimateTokensFromChars(chars, { wideRatio = 0.5 } = {}) {
  const n = Math.max(0, Number(chars) || 0);
  const wide = n * wideRatio;
  const ascii = n - wide;
  return Math.ceil(ascii / ASCII_PER_TOKEN + wide);
}

const WARN_AT = 0.75;
const DANGER_AT = 0.9;

function describeUsage(usage, window) {
  const chars = Math.max(0, Number((usage && usage.chars) || 0));
  const turns = Math.max(0, Number((usage && usage.turns) || 0));
  const tokens = estimateTokensFromChars(chars);
  const win = Math.max(0, Number(window) || 0);

  if (!win) {
    return { chars, turns, tokens, window: 0, ratio: null, level: 'unknown' };
  }
  const ratio = tokens / win;
  const level = ratio >= DANGER_AT ? 'danger' : ratio >= WARN_AT ? 'warn' : 'ok';
  return { chars, turns, tokens, window: win, ratio, level };
}

function short(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(v);
  if (v < 1000000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
  return `${(v / 1000000).toFixed(1)}M`;
}

module.exports = {
  estimateTokens,
  estimateTokensFromChars,
  describeUsage,
  short,
  WARN_AT,
  DANGER_AT,
};
