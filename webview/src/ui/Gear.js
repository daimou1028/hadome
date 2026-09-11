const { useState, useEffect, useRef } = require('react');

function Gear({ enterSends, labels, hint, onToggle }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false);
    };
    const esc = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div id="gearwrap" ref={box}>
      {open ? (
        <div className="gearpick">
          <button
            className={'gearitem' + (enterSends ? ' now' : '')}
            onClick={() => {
              setOpen(false);
              if (!enterSends) onToggle();
            }}
          >
            <span className="mark codicon codicon-check" aria-hidden="true" />
            <span className="nm">{labels.send}</span>
          </button>
          <button
            className={'gearitem' + (!enterSends ? ' now' : '')}
            onClick={() => {
              setOpen(false);
              if (enterSends) onToggle();
            }}
          >
            <span className="mark codicon codicon-check" aria-hidden="true" />
            <span className="nm">{labels.newline}</span>
          </button>
        </div>
      ) : null}
      <button
        id="gear"
        className="iconbtn"
        title={hint}
        aria-label={hint}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="codicon codicon-settings-gear" aria-hidden="true" />
      </button>
    </div>
  );
}

module.exports = { Gear };
