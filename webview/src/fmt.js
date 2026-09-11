function secLabel(sec, t) {
  return sec < 60
    ? t('state.sec', { n: sec })
    : t('state.min', { m: Math.floor(sec / 60), s: String(sec % 60).padStart(2, '0') });
}

function tookLabel(ms, t) {
  if (!ms || ms < 1000) return '';
  return secLabel(Math.round(ms / 1000), t);
}

function elapsedLabel(since, now, t) {
  if (!since) return '';
  return secLabel(Math.max(0, Math.round((now - since) / 1000)), t);
}

function shortNum(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1000000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

module.exports = { secLabel, tookLabel, elapsedLabel, shortNum };
