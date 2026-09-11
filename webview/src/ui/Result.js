const { useState } = require('react');

function ActionButton({ label, onRun }) {
  const [text, setText] = useState(label);
  const [off, setOff] = useState(false);

  const [why, setWhy] = useState('');
  return (
    <button
      className="ghost"
      disabled={off}
      title={why || undefined}
      onClick={async () => {
        const next = await onRun();
        setText(next.text);
        setWhy(next.why || '');

        setOff(!!next.keepOff);
      }}
    >
      {text}
    </button>
  );
}

function Result({ okish, cap, detailHtml, actions }) {

  return (
    <>
      <div className="cap">{cap}</div>
      {detailHtml ? <div dangerouslySetInnerHTML={{ __html: detailHtml }} /> : null}
      {actions && actions.length ? (
        <div className="actions">
          {actions.map((a) => (
            <ActionButton key={a.key} label={a.label} onRun={a.run} />
          ))}
        </div>
      ) : null}
    </>
  );
}

module.exports = { Result };
