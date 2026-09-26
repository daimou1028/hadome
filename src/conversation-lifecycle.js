'use strict';

const EXPLICIT_REASONS = new Set(['plus', 'slash-new', 'send-fresh-key', 'conversation-guard', 'uri-new']);
const RECOVERY_REASONS = new Set([
  'recovery-no-tool',
  'recovery-bad-format',
  'recovery-downgraded',
  'recovery-no-call',
]);
const REASONS = new Set([...EXPLICIT_REASONS, ...RECOVERY_REASONS, 'project-gone']);

function decideConversationChange({ reason, explicit = false, mode = 'edit', choice = '' } = {}) {
  const why = String(reason || '');
  if (!REASONS.has(why)) return { action: 'stop', reason: why || 'unknown' };
  if (why === 'project-gone') return { action: 'stop', reason: why };
  if (EXPLICIT_REASONS.has(why)) {
    return explicit ? { action: 'create', reason: why } : { action: 'stop', reason: why };
  }
  if (String(mode) === 'never') return { action: 'stop', reason: why };
  if (choice === 'restart') return { action: 'create', reason: why };
  if (choice === 'keep') return { action: 'keep', reason: why };
  if (choice === 'stop') return { action: 'stop', reason: why };
  return { action: 'ask', reason: why };
}

module.exports = { decideConversationChange, EXPLICIT_REASONS, RECOVERY_REASONS, REASONS };
