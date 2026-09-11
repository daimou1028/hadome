function Empty({ lines, after }) {
  return (
    <>
      {lines.map((text, i) => (
        <div key={i} className={i === 0 ? 'lead' : undefined}>
          {text}
        </div>
      ))}
      {after || null}
    </>
  );
}

module.exports = { Empty };
