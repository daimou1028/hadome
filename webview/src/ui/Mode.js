const { useState, useEffect, useRef } = require('react');

const { ORDER, nextMode, MARK } = require('./modeCycle');

function Mode({ mode, label, labels, notes, hint, onPick, thinking, thinkingLabel, thinkingNote, onThinking }) {
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
    <div id="modewrap" ref={box}>
      {open ? (
        <div className="modepick">
          {ORDER.map((m) => (
            <button
              key={m}
              className={'modeitem mode-' + m + (m === mode ? ' now' : '')}
              onClick={() => {
                setOpen(false);
                if (m !== mode) onPick(m);
              }}
            >
              <span className={'mark codicon codicon-' + MARK[m]} aria-hidden="true" />
              <span className="col">
                <span className="nm">{(labels && labels[m]) || m}</span>
                {}
                {notes && notes[m] ? <span className="note">{notes[m]}</span> : null}
              </span>
            </button>
          ))}
          {typeof thinking === 'boolean' ? (
            <button
              className={'modeitem thinkitem' + (thinking ? ' now' : '')}

              aria-pressed={thinking}
              onClick={() => onThinking(!thinking)}
            >
              <span
                className={'mark codicon codicon-' + (thinking ? 'check' : 'blank')}
                aria-hidden="true"
              />
              <span className="col">
                <span className="nm">{thinkingLabel}</span>
                {thinkingNote ? <span className="note">{thinkingNote}</span> : null}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      <button
        id="mode"
        className={'iconbtn mode mode-' + mode}
        title={hint + '（' + label + '）'}
        aria-label={hint + '（' + label + '）'}
        onClick={() => setOpen((v) => !v)}

        tabIndex={-1}
      >
        <span className={'mark codicon codicon-' + MARK[mode]} aria-hidden="true" />

        <span className="nm">{label}</span>
      </button>
    </div>
  );
}

module.exports = { Mode, ORDER, nextMode, MARK };
