const { toText } = require('./toText');

function Msg({ cls, who, content, asText, took, onFork }) {

  return (
    <>
      <div className="who">
        {toText(who)}

        {took ? <span className="took">{took}</span> : null}
        {}
        {onFork ? (
          <button type="button" className="forkbtn" onClick={onFork} title={onFork.title}>
            {onFork.label}
          </button>
        ) : null}
      </div>
      {asText ? (

        <div className="body">{toText(content)}</div>
      ) : (

        <div className="body" dangerouslySetInnerHTML={{ __html: toText(content) }} />
      )}
    </>
  );
}

module.exports = { Msg };
