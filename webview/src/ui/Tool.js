const { useState } = require('react');

const { lookOf } = require('./toolLook');

function Tool({
  state,
  ok,
  name,
  target,
  why,
  output,
  clipped,

  took,

  more,
  diff,
  onOpenDiff,
}) {
  const look = lookOf(state, ok);

  const hasBody = !!output;

  const [open, setOpenState] = useState(hasBody && !ok);

  const setOpen = (next) => {
    setOpenState((prev) => (typeof next === 'function' ? next(prev) : next));
  };

  const [full, setFull] = useState('');
  const [moreWhy, setMoreWhy] = useState('');
  const [diffText, setDiffText] = useState(diff ? diff.label : '');
  const [diffWhy, setDiffWhy] = useState('');

  return (
    <div className={'toolbox' + (open ? ' open' : '')}>
      <div
        className={'tool' + (hasBody ? ' head' : '') + look.cls}
        style={hasBody ? undefined : { cursor: 'default' }}
        onClick={hasBody ? () => setOpen((v) => !v) : undefined}
      >

        <div className="toolhead">
          <span className="caret">{hasBody ? (open ? '▾' : '▸') : ''}</span>
          <span className="mark">{look.mark}</span>
          <span className="name">{name}</span>
          {}
          <span className="tgt">{target == null ? '' : String(target)}</span>
        </div>
        {clipped || took || (!ok && why) ? (
          <div className="toolmeta">

            {clipped ? <span className="why">{clipped}</span> : null}
            {}
            {took ? <span className="took">{took}</span> : null}
            {!ok && why ? <span className="why">{'— ' + why}</span> : null}
          </div>
        ) : null}
        {diff ? (
          <a
            className="difflink"
            title={diffWhy || undefined}

            onClick={async (ev) => {
              ev.stopPropagation();
              const r = await onOpenDiff();
              setDiffText(r.text);
              setDiffWhy(r.why || '');
            }}
          >
            {diffText}
          </a>
        ) : null}
      </div>
      {hasBody ? (
        <div className="bodywrap">
          <pre>{full || output}</pre>
          {}
          {more && !full ? (
            <div
              className="more"
              onClick={async (ev) => {
                ev.stopPropagation();
                const r = await more.onOpen();
                if (r && r.text) setFull(r.text);
                else setMoreWhy((r && r.why) || '');
              }}
              title={moreWhy || undefined}
            >
              {moreWhy || more.label}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

module.exports = { Tool };
