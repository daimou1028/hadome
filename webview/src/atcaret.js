function mentionAt(value, caret) {
  const text = String(value == null ? '' : value);
  const at = Math.max(0, Math.min(Number(caret) || 0, text.length));
  const head = text.slice(0, at);

  const trimmed = text.replace(/^\s+/, '');
  const slashAt = text.length - trimmed.length;
  if (trimmed.startsWith('/') && at > slashAt) {
    const word = head.slice(slashAt + 1);
    if (!/\s/.test(word)) return { kind: 'skill', from: slashAt, query: word };
  }

  const i = head.lastIndexOf('@');
  if (i < 0) return null;
  const before = i === 0 ? '' : head[i - 1];

  if (before !== '' && !/\s/.test(before)) return null;
  const word = head.slice(i + 1);

  if (/\s/.test(word)) return null;
  return { kind: 'file', from: i, query: word };
}

module.exports = { mentionAt };
