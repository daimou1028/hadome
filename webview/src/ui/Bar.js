const { Mode } = require('./Mode');
const { Gear } = require('./Gear');
const { Queue } = require('./Queue');
const { Picks } = require('./Picks');
const { Chips } = require('./Chips');
const { Usage } = require('./Usage');

function Bar({

  queue,

  picks,

  chips,

  input,

  buttons,

  usage,

  historyAt,
}) {
  return (
    <>
      <div id="queue" hidden={!queue.items.length}>
        <Queue {...queue} />
      </div>
      {}
      <div id="state" />

      {usage ? <Usage {...usage} /> : null}

      {historyAt ? (
        <div id="histat" role="status">
          {historyAt}
        </div>
      ) : null}

      <div
        id="inwrap"
        onDragOver={input.onDragOver}
        onDragLeave={input.onDragLeave}
        onDrop={input.onDrop}
      >
        <div id="picks" hidden={picks.hidden}>
          <Picks {...picks} />
        </div>
        {}

        <button
          id="addctx"
          className="iconbtn"
          title={buttons.addContext.hint}
          aria-label={buttons.addContext.hint}
          onClick={buttons.addContext.onAdd}
        >
          <span className="codicon codicon-add" aria-hidden="true" />
        </button>
        <textarea
          id="input"
          rows={3}
          ref={input.ref}
          placeholder={input.placeholder}
          onInput={input.onInput}
          onKeyDown={input.onKeyDown}
          onBlur={input.onBlur}

          onCompositionStart={input.onCompositionStart}
          onCompositionEnd={input.onCompositionEnd}
        />
        <div id="chips" hidden={!chips.names.length}>
          <Chips {...chips} />
        </div>
        {}
        <div id="tools">

        <Mode {...buttons.mode} />

        <span id="gap" />

        <Gear {...buttons.enter} />

        <button
          id="stop"
          className="iconbtn"
          disabled={!buttons.canStop}
          title={buttons.stopLabel}
          aria-label={buttons.stopLabel}
          onClick={buttons.onStop}
        >
          <span className="codicon codicon-stop-circle" aria-hidden="true" />
        </button>
        {}
        <button
          id="send"
          className="iconbtn"
          title={buttons.sendHint}
          aria-label={buttons.sendLabel}
          onClick={buttons.onSend}
        >
          <span className="codicon codicon-arrow-up" aria-hidden="true" />
        </button>
        </div>
      </div>
    </>
  );
}

module.exports = { Bar };
