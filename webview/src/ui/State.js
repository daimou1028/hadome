function State({ text, verb, elapsed, counts }) {
  if (!text) return null;

  const meta = [elapsed, counts].filter(Boolean).join(' · ');
  return (
    <>

      <span className="dot" />

      {verb ? <span className="verb">{verb}…</span> : null}
      <span className="what">{text}</span>
      {meta ? <span className="meta">({meta})</span> : null}
    </>
  );
}

module.exports = { State };
