function Usage({ usage, t, short }) {
  if (!usage || !usage.turns) return null;

  const 概算 = short(usage.tokens);

  const 札 = t('usage.approx', { n: 概算 });

  if (!usage.window) {

    return (
      <div id="usage" className="unknown" title={t('usage.noWindow')}>
        <span className="num">{札}</span>
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, Math.round(usage.ratio * 100)));
  const 内訳 = t('usage.detail', {
    n: 概算,
    of: short(usage.window),
    pct: String(pct),
    turns: String(usage.turns),
  });
  return (
    <div id="usage" className={usage.level} title={内訳}>
      <span className="num">{札}</span>
      <span className="track" aria-hidden="true">
        <span className="used" style={{ width: `${pct}%` }} />
      </span>
      <span className="pct">{pct}%</span>
    </div>
  );
}

module.exports = { Usage };
