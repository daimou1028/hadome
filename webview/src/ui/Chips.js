function Chips({ names, removeTitle, onRemove, missing, missingTitle }) {
  const known = missing || {};
  return (
    <>
      {names.map((name) => {
        const gone = Object.prototype.hasOwnProperty.call(known, name) && known[name] === false;
        return (
        <span className={'chip' + (gone ? ' gone' : '')} key={name}>
          <span className="nm" title={gone ? missingTitle || name : name}>
            {name}
          </span>
          <span className="x" title={removeTitle} onClick={() => onRemove(name)}>
            ✕
          </span>
        </span>
        );
      })}
    </>
  );
}

module.exports = { Chips };
