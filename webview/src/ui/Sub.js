const MARK = {
  waiting: '·',
  started: '▶',
  running: '▶',
  done: '✓',
  failed: '✕',
};

const { toText } = require('./toText');

function Sub({ at, name, state, stateKey, turn, of, chars, turnLabel, charsLabel }) {

  const tone = 'sub-' + (((Number(at) || 1) - 1) % 4 + 1);
  return (
    <>
      <span className={'dot ' + tone} />
      <span className="nm">{toText(name)}</span>
      <span className="st">{MARK[stateKey] || ''} {toText(state)}</span>
      {}
      {turn ? <span className="meta">{turnLabel}</span> : null}
      {}
      {chars ? <span className="meta">{charsLabel}</span> : null}
    </>
  );
}

module.exports = { Sub, MARK };
