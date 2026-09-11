function Picks({ items, at, noneLabel, onChoose }) {
  if (!items.length) return <div className="none">{noneLabel}</div>;
  return (
    <>
      {items.map((p, i) => {

        const isDir = p.endsWith('/');
        const body = isDir ? p.slice(0, -1) : p;
        const cut = body.lastIndexOf('/');
        return (
          <div
            key={p}
            className={'pick' + (i === at ? ' on' : '')}
            onMouseDown={(ev) => {
              ev.preventDefault();
              onChoose(i);
            }}
          >

            {isDir ? <span className="mark codicon codicon-folder" aria-hidden="true" /> : null}
            <span className="base">{cut < 0 ? body : body.slice(cut + 1)}</span>
            <span className="dir">{cut < 0 ? '' : body.slice(0, cut)}</span>
          </div>
        );
      })}
    </>
  );
}

module.exports = { Picks };
