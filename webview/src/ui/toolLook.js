const LOOK = {
  done: { cls: '', mark: '✓' },
  failed: { cls: ' bad', mark: '✕' },

  askedAgain: { cls: ' again', mark: '↺' },
};

function lookOf(state, ok) {
  return LOOK[state || (ok ? 'done' : 'failed')] || LOOK.failed;
}

module.exports = { LOOK, lookOf };
