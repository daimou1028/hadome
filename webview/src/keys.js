function isComposingEvent(ev, st) {
  const e = ev || {};
  const s = st || {};

  if (e.isComposing === false && e.keyCode !== 229) return false;
  return !!(e.isComposing || e.keyCode === 229 || s.composing);
}

function decideKey(ev, st) {
  const e = ev || {};
  const s = st || {};

  if (isComposingEvent(e, s)) return 'pass';

  const newlineCombo = e.shiftKey || e.altKey || e.metaKey;

  const enterSends = s.enterSends !== false;
  const enter = e.key === 'Enter' && (enterSends ? !newlineCombo : newlineCombo);

  if (e.key === 'Enter' && e.shiftKey && e.metaKey) return 'send-fresh';

  if (e.key === 'Tab' && e.shiftKey) return 'cycle-mode';

  if (s.picksOpen) {
    if (e.key === 'ArrowDown') return 'move-down';
    if (e.key === 'ArrowUp') return 'move-up';
    if (e.key === 'Escape') return 'close';

    const chooseKey = (e.key === 'Enter' && !newlineCombo) || e.key === 'Tab';
    if (chooseKey && s.pickAt >= 0 && s.pickCount > 0) return 'choose';
    if (enter || e.key === 'Tab') {

      return enter ? 'send' : 'close';
    }
  }

  if (enter) return 'send';

  if (s.hasSelection) return 'pass';
  if (e.key === 'ArrowUp' && s.atStart) return 'history-prev';
  if (e.key === 'ArrowDown' && s.inHistory && (s.atStart || s.atEnd)) return 'history-next';

  return 'pass';
}

function moveIndex(at, count, dir) {
  if (!count) return -1;
  const base = at < 0 ? (dir > 0 ? -1 : 0) : at;
  return (base + (dir > 0 ? 1 : count - 1) + count) % count;
}

function shouldShowDetail(detail, lastProse, tools) {
  const d = String(detail == null ? '' : detail).trim();
  if (!d) return false;
  const p = String(lastProse == null ? '' : lastProse).trim();
  if (d === p) return false;

  if (tools === 0 && p) return false;

  return true;
}

module.exports = { decideKey, moveIndex, shouldShowDetail, isComposingEvent };
