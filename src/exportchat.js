function blockOf(e) {
  if (!e || typeof e !== 'object') return '> （読めない行）';
  const t = e.type;
  if (t === 'you') return `## 依頼\n\n${String(e.text || '')}`;
  if (t === 'answer') return `## 返答\n\n${String(e.text || '')}`;
  if (t === 'note') return `> ${String(e.text || '')}`;
  if (t === 'bang') return `### \`!${String(e.command || '')}\`\n\n\`\`\`\n${String(e.output || '')}\n\`\`\``;
  if (t === 'tool') {
    const 印 = e.ok ? 'ok' : 'NG';
    const 中 = String(e.output || e.why || '');
    return (
      `### ツール: ${String(e.name || '')} ${印}` +
      (e.target ? `（${e.target}）` : '') +
      (中 ? `\n\n\`\`\`\n${中}\n\`\`\`` : '')
    );
  }
  if (t === 'todos') {
    const list = Array.isArray(e.todos) ? e.todos : [];
    if (!list.length) return '### やること\n\n（無し）';
    return (
      '### やること\n\n' +
      list.map((x) => `- [${x && x.status === 'completed' ? 'x' : ' '}] ${(x && x.content) || ''}`).join('\n')
    );
  }

  return `> （出せない種類: ${String(t || '不明')}）`;
}

function toMarkdown(session, meta = {}) {
  const entries = (session && Array.isArray(session.entries) && session.entries) || [];
  const head = [
    '# ChatGPT Bridge の対話',
    '',
    ...(meta.workspace ? [`- ワークスペース: ${meta.workspace}`] : []),
    ...(meta.at ? [`- 書き出した時: ${meta.at}`] : []),
    `- 行数: ${entries.length}`,

    ...(session && session.dropped ? [`- **頭から ${session.dropped} 行は残っていません**`] : []),
    '',
    '---',
    '',
  ];
  return head.join('\n') + entries.map(blockOf).join('\n\n') + '\n';
}

module.exports = { toMarkdown, blockOf };

function parseImported(text) {
  let o;
  try {
    o = JSON.parse(String(text || ''));
  } catch (e) {
    return { ok: false, why: 'ex.notJson' };
  }

  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, why: 'ex.notSession' };
  if (!Array.isArray(o.entries)) return { ok: false, why: 'ex.noEntries' };

  if (!o.entries.length) return { ok: false, why: 'ex.emptyEntries' };

  const readable = o.entries.some((e) => e && typeof e === 'object' && typeof e.type === 'string');
  if (!readable) return { ok: false, why: 'ex.badEntries' };
  return { ok: true, session: o };
}

function forImport(session, { id, nowMs, label }) {
  return {
    ...session,
    id,
    createdAt: nowMs,
    updatedAt: nowMs,

    title: `${label} ${String(session.title || '')}`.trim(),
    conversationUrl: '',
    conversationId: '',
    instructionSent: false,
    rulesFingerprint: '',
    imported: true,
  };
}

module.exports.parseImported = parseImported;
module.exports.forImport = forImport;
