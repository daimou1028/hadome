const { makeBridge } = require('./envelope');
const { proseOf } = require('../../src/prose');
const { decideKey, moveIndex, shouldShowDetail } = require('./keys');
const { Boundary } = require('./ui/Boundary');
const { makeT } = require('../../src/i18n');

const { parseMentions } = require('../../src/mention');

const { verbFor } = require('./verbs');

const { render, esc } = require('./md');

const { secLabel, tookLabel, elapsedLabel, shortNum } = require('./fmt');

const { mentionAt } = require('./atcaret');

const { isAtBottom, AT_BOTTOM_SLACK } = require('./scroll');

const { createElement } = require('react');
const { createRoot } = require('react-dom/client');
const { flushSync } = require('react-dom');
const { Note } = require('./ui/Note');
const { Msg } = require('./ui/Msg');
const { Result } = require('./ui/Result');
const { Tool } = require('./ui/Tool');
const { Mode } = require('./ui/Mode');
const { nextMode } = require('./ui/modeCycle');
const { Ask } = require('./ui/Ask');
const { Shot } = require('./ui/Shot');
const { Chips } = require('./ui/Chips');
const { Queue } = require('./ui/Queue');
const { Picks } = require('./ui/Picks');
const { Usage } = require('./ui/Usage');
const { State } = require('./ui/State');
const { Empty } = require('./ui/Empty');
const { Bar } = require('./ui/Bar');
const { Gear } = require('./ui/Gear');
const { Todos } = require('./ui/Todos');

const { Changes } = require('./ui/Changes');
const { changedPaths } = require('./changes');
const { Sub } = require('./ui/Sub');

const { Cmd } = require('./ui/Cmd');

let failedLabel = 'この行は出せませんでした';
function setFailedLabel(s) {
  if (s) failedLabel = s;
}
function wrap(el) {
  return createElement(Boundary, { label: failedLabel }, el);
}

function node(Component, props) {
  return createElement(Component, props);
}

function renderNode(el, cls, withSetter) {

  const host = document.createElement('div');

  if (cls) host.className = cls;

  const setHostClass = (extra) => {
    host.className = [cls, extra].filter(Boolean).join(' ');
  };
  const root = createRoot(host);

  roots.set(host, root);

  flushSync(() =>
    root.render(wrap(withSetter ? withSetter(setHostClass) : el))
  );
  return host;
}

const roots = new WeakMap();
function renderInto(container, el) {
  let root = roots.get(container);
  if (!root) {

    container.innerHTML = '';
    root = createRoot(container);
    roots.set(container, root);
  }

  flushSync(() => root.render(wrap(el)));
}

function makeTranslator(locale) {
  return makeT(locale);
}

window.Bridge = {
  makeBridge,
  proseOf,
  decideKey,
  moveIndex,
  shouldShowDetail,
  makeTranslator,
  parseMentions,
  verbFor,
  render,
  esc,
  secLabel,
  tookLabel,
  elapsedLabel,
  shortNum,
  mentionAt,
  isAtBottom,
  AT_BOTTOM_SLACK,
  renderNode,
  renderInto,
  node,

  setFailedLabel,
  nextMode,

  dropToMentions: require('../../src/mention').dropToMentions,

  splitBang: require('../../src/bang').splitBang,

  modeOrder: require('./ui/modeCycle').ORDER,
  ui: { Note, Msg, Result, Tool, Mode, Gear, Todos, Changes, Ask, Shot, Chips, Queue, Picks, State, Empty, Bar, Sub, Cmd, Usage },
  changedPaths,

  highlight: require('./highlight').highlight,
};
