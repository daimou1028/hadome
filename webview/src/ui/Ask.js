const { useState } = require('react');

function Ask({ text, detail, kind, actions, onRun, cantStart, answered }) {

  const acts = Array.isArray(actions) ? actions : [];

  const [busy, setBusy] = useState(false);

  const [why, setWhy] = useState({});

  const labelOf = (v) => {
    const hit = acts.find((a) => String(a.answer) === String(v));
    return hit ? hit.label : String(v);
  };
  const already =
    answered === undefined || answered === null || answered === '' ? null : labelOf(answered);
  const [chosen, setChosen] = useState(already);

  return (
    <>
      <div>{text}</div>
      {}
      {detail ? <div className={'what ' + (kind || '')}>{detail}</div> : null}
      {chosen ? (
        <div className="chosen">{chosen}</div>
      ) : (
      <div className="actions">
        {acts.map((a, i) => (
          <button
            key={i}
            disabled={busy}
            title={why[i] || undefined}
            onClick={async () => {
              setBusy(true);
              const r = await onRun(a);

              if (r && r.started) {
                setChosen(a.label);
                return;
              }
              setBusy(false);
              setWhy((prev) => ({ ...prev, [i]: (r && r.why) || cantStart }));
            }}
          >

            {a.note ? (
              <span className="col">
                <span className="nm">{a.label}</span>
                <span className="note">{a.note}</span>
              </span>
            ) : (
              a.label
            )}
          </button>
        ))}
      </div>
      )}
    </>
  );
}

module.exports = { Ask };
