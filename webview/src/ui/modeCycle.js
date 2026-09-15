const ORDER = ['ask', 'edit', 'plan', 'never', 'neverPlus'];

function nextMode(now) {
  const at = ORDER.indexOf(now);

  return ORDER[at < 0 ? 0 : (at + 1) % ORDER.length];
}

const MARK = {

  ask: 'debug-pause',

  plan: 'book',

  edit: 'code',

  never: 'zap',

  neverPlus: 'flame',
};

module.exports = { ORDER, nextMode, MARK };
