const MIN_TO_SHOW = 3;

const { toText } = require('./toText');

function Changes({ items, title, open, onToggle, onOpen }) {
  const list = Array.isArray(items) ? items : [];
  if (list.length < MIN_TO_SHOW) return null;
  return (
    <div className={'changes' + (open ? ' open' : '')}>
      <button type="button" className="chghead" onClick={onToggle} aria-expanded={!!open}>
        <span className={'chev codicon codicon-' + (open ? 'chevron-down' : 'chevron-right')} aria-hidden="true" />
        <span className="nm">{toText(title)}</span>
        <span className="cnt">{list.length}</span>
      </button>
      {open ? (
        <div className="chglist">
          {list.map((x) => (
            <button
              type="button"
              key={x.path}
              className="chgitem"
              onClick={() => onOpen && onOpen(x.path)}
              title={x.path}
            >
              <span className="p">{x.path}</span>
              {}
              {x.times > 1 ? <span className="n">{'×' + x.times}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

module.exports = { Changes, MIN_TO_SHOW };
