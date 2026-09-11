const HEAD = /^[!！]/;

function splitBang(text) {
  const s = String(text || '');
  if (!HEAD.test(s)) return { bang: false, command: '' };
  const command = s.slice(1).trim();

  if (!command) return { bang: false, command: '' };
  return { bang: true, command };
}

const MAX_OUT = 20000;

function clip(s, max = MAX_OUT) {
  const t = String(s == null ? '' : s);
  if (t.length <= max) return t;
  return t.slice(0, max) + `\n…（ここから先 ${t.length - max} 文字は省きました）`;
}

function bangBlock({ command, stdout, stderr, code }) {
  const out = [];
  out.push(`<bash-input>${String(command || '')}</bash-input>`);
  const o = clip(stdout);
  const e = clip(stderr);

  out.push(`<bash-stdout>${o}</bash-stdout>`);
  if (e) out.push(`<bash-stderr>${e}</bash-stderr>`);

  if (code !== 0) out.push(`<bash-code>${code}</bash-code>`);
  return out.join('\n');
}

function attachBangs(task, blocks) {
  const list = (blocks || []).filter(Boolean);
  if (!list.length) return String(task || '');
  return list.join('\n\n') + '\n\n' + String(task || '');
}

module.exports = { splitBang, bangBlock, attachBangs, MAX_OUT };
