'use strict';

function createLiveness(now = Date.now()) {
  const at = Number(now) || 0;
  return {
    startedAt: at,
    lastProgressAt: at,
    lastAliveAt: at,
    repeatCount: 0,
    stream: { events: 0, bytes: 0, chars: 0 },
    lastKind: 'start',
  };
}

function noteLiveness(state, event = {}) {
  const next = { ...(state || createLiveness(0)), stream: { ...((state && state.stream) || {}) } };
  const kind = String(event.kind || '');
  const at = Number(event.at);
  const when = Number.isFinite(at) ? at : Date.now();
  let progressed = false;
  if (kind === 'stream_beat') {
    for (const key of ['events', 'bytes', 'chars']) {
      const value = Number(event[key]) || 0;
      if (value > (Number(next.stream[key]) || 0)) progressed = true;
      next.stream[key] = Math.max(Number(next.stream[key]) || 0, value);
    }
  } else if (['busy', 'tool', 'start', 'end', 'text'].includes(kind)) {
    progressed = true;
  }
  if (progressed) next.lastProgressAt = when;
  if (kind === 'tabAlive') next.lastAliveAt = when;
  next.lastKind = kind || next.lastKind;
  return next;
}

function shouldStall(state, now = Date.now(), thresholdMs = 150000) {
  const last = Number(state && state.lastProgressAt) || 0;
  return Number(now) - last >= Number(thresholdMs);
}

function resetLiveness(state, now = Date.now()) {

  return createLiveness(now);
}

module.exports = { createLiveness, noteLiveness, shouldStall, resetLiveness };
