const STOP_CHARS = '\\s、。，．,;:！？!?"\'`（）()［］\\[\\]｛｝{}<>「」『』';

const OPEN_BEFORE = '\\s、。，．,;:！？!?（(「『［\\[｛\\{<"\'';

const MENTION = new RegExp(
  `(?<=^|[${OPEN_BEFORE}])@(?:"([^"\\n]+)"|'([^'\\n]+)'|([^${STOP_CHARS}]+))`,
  'g'
);

const FENCE_BLOCK = /```[\s\S]*?```/g;

function normalizePath(p) {
  let out = String(p).replace(/\\/g, '/');
  out = out.replace(/\/{2,}/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

function splitRange(p) {
  const m = /^(.*?)#L(\d+)(?:-(\d+))?$/.exec(String(p || ''));
  if (!m) return { path: String(p || ''), from: null, to: null };
  const from = Number(m[2]);
  const to = m[3] === undefined ? from : Number(m[3]);

  return { path: m[1], from: Math.min(from, to), to: Math.max(from, to) };
}

function dropToMentions(raw, root) {
  const out = [];
  const seen = new Set();
  for (const line of String(raw || '').split(/\r?\n/)) {
    let p = line.trim();
    if (!p) continue;
    if (p.startsWith('file://')) p = p.slice(7);
    else if (p.startsWith('vscode-remote://')) {
      const rest = p.slice('vscode-remote://'.length);
      const slash = rest.indexOf('/');
      p = slash < 0 ? '' : rest.slice(slash);
    }
    if (!p) continue;
    try {
      p = decodeURIComponent(p);
    } catch {

    }

    if (root && p.startsWith(root + '/')) p = p.slice(root.length + 1);
    p = p.replace(/\\/g, '/');
    if (seen.has(p)) continue;
    seen.add(p);
    out.push('@' + p);
  }
  return out;
}

function parseMentions(text) {
  const out = [];
  const seen = new Set();
  if (typeof text !== 'string') return out;
  const body = text.replace(FENCE_BLOCK, '');
  MENTION.lastIndex = 0;
  let m;
  while ((m = MENTION.exec(body)) !== null) {
    const quoted = m[1] !== undefined || m[2] !== undefined;
    let p = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];

    if (!quoted) p = p.replace(/[.、。,;:!?)\]}>」』"'`]+$/, '');
    if (!p) continue;

    const r = splitRange(p);
    const norm = normalizePath(r.path);
    if (!norm) continue;

    const key = r.from === null ? norm : norm + '#L' + r.from + '-' + r.to;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function rankCandidates(files, query, limit = 12) {
  const q = String(query || '').toLowerCase();
  const scored = [];
  for (const file of files) {
    const p = String(file);
    const lower = p.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let rank;
    if (q === '') rank = 3;
    else if (base.startsWith(q)) rank = 0;
    else if (base.includes(q)) rank = 1;
    else if (lower.includes(q)) rank = 2;
    else continue;
    scored.push({ path: p, rank });
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return scored.slice(0, limit).map((s) => s.path);
}

function rankSkills(names, query) {
  const q = String(query || '').toLowerCase();
  const scored = [];
  for (const name of names) {
    const lower = String(name).toLowerCase();
    let rank;
    if (q === '') rank = 0;
    else if (lower.startsWith(q)) rank = 0;
    else if (lower.includes(q)) rank = 1;
    else continue;
    scored.push({ name: String(name), rank });
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;

    return a.name.localeCompare(b.name);
  });
  return scored.map((s) => s.name);
}

const ATTACH_LIMIT_CHARS = 24000;

async function buildAttachment(
  readFile,
  paths,
  { maxChars = ATTACH_LIMIT_CHARS, exists = null } = {}
) {
  const attached = [];
  const skipped = [];
  const blocks = [];
  let used = 0;

  for (const p of paths) {

    const range = splitRange(p);
    if (exists && !exists(range.path)) continue;
    if (used >= maxChars) {
      skipped.push({ path: p, why: '1 通に付けられる量を超えたので付けていません' });
      continue;
    }
    let body;
    try {
      const r = await readFile({ path: range.path });
      if (!r || !r.ok) throw new Error((r && r.output) || '読めませんでした');
      body = String(r.output);
      if (range.from !== null) {

        const lines = body.split('\n');
        if (range.from > lines.length) {
          throw new Error(`${lines.length} 行しかありません（${range.from} 行目を求められました）`);
        }
        body = lines.slice(range.from - 1, range.to).join('\n');
      }
    } catch (e) {
      skipped.push({ path: p, why: e.message });
      continue;
    }
    const room = maxChars - used;
    if (body.length > room) {
      body = body.slice(0, room) + `\n…（ここで切りました。全体は ${body.length} 文字）`;
    }
    used += body.length;
    attached.push(p);

    blocks.push(`### ${p}\n\`\`\`\`\n${body}\n\`\`\`\``);
  }

  if (attached.length === 0 && skipped.length === 0) {
    return { text: '', attached, skipped };
  }

  const lines = [
    '',
    '--- 名指しされたファイルの中身（この人が付けました）---',
    'すでに読んであります。**同じファイルに read_file を出さないでください。**',
    'そのぶんのターンと待ち時間が丸ごと無駄になります。',
    '',
  ];
  for (const b of blocks) {
    lines.push(b, '');
  }
  if (skipped.length > 0) {
    lines.push('付けられなかったもの:');
    for (const s of skipped) lines.push(`  - ${s.path}: ${s.why}`);
    lines.push('');
    lines.push('これらが要るなら read_file で取ってください。');
  }
  return { text: lines.join('\n'), attached, skipped };
}

module.exports = { dropToMentions, splitRange, parseMentions, rankCandidates, rankSkills, buildAttachment, ATTACH_LIMIT_CHARS };
