const fs = require('fs');
const path = require('path');
const os = require('os');

const DESC_LIMIT = 110;

function homeOf(home) {
  return home || os.homedir();
}

function agentsDir(home) {
  return path.join(homeOf(home), '.agents');
}

function safeName(name) {
  const s = String(name || '');
  if (!s) throw new Error('名前が空です');

  if (/[/\\\u0000-\u001f]/.test(s)) throw new Error(`名前の形が違います: ${name}`);

  if (s.startsWith('.')) throw new Error(`名前の形が違います: ${name}`);
  return s;
}

function loadRules(home) {
  try {
    return fs.readFileSync(path.join(agentsDir(home), 'AGENTS.md'), 'utf8');
  } catch {
    return '';
  }
}

function loadProjectRules(root) {
  if (!root) return '';
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const t = fs.readFileSync(path.join(root, name), 'utf8');
      if (t.trim()) return t;
    } catch {

    }
  }
  return '';
}

function readRule(home, name) {

  if (String(name) === RULES_BODY_NAME) return loadRules(home);
  const f = path.join(agentsDir(home), 'rules', `${safeName(name)}.md`);
  return fs.readFileSync(f, 'utf8');
}

const RULES_BODY_NAME = 'AGENTS';

function fitRules(rules, room) {
  const s = String(rules || '');
  const limit = Math.max(0, Math.floor(Number(room) || 0));
  if (s.length <= limit) return { text: s, omitted: [] };

  const heads = [];
  const re = /^## .*$/gm;
  let m;
  while ((m = re.exec(s))) heads.push({ at: m.index, title: m[0].replace(/^## /, '').trim() });
  if (!heads.length) {

    return { text: '', omitted: ['（全文）'] };
  }

  let cut = 0;
  let firstOmitted = 0;
  for (let i = 0; i < heads.length; i += 1) {
    if (heads[i].at <= limit) {
      cut = heads[i].at;
      firstOmitted = i;
    } else break;
  }

  if (heads[0].at > limit) {
    cut = Math.min(heads[0].at, limit);
    firstOmitted = 0;
  }
  return {
    text: s.slice(0, cut).replace(/\s+$/, '') + '\n',
    omitted: heads.slice(firstOmitted).map((h) => h.title),
  };
}

function listRules(home) {
  try {
    return fs
      .readdirSync(path.join(agentsDir(home), 'rules'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => n.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return m ? m[1] : '';
}

function unquote(v) {
  const s = String(v == null ? '' : v).trim();
  const q = s[0];
  if ((q === '"' || q === "'") && s.length > 1 && s[s.length - 1] === q) {
    const inner = s.slice(1, -1);
    return q === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
  }
  return s;
}

function listSkills(home, { forHuman = false } = {}) {
  const dir = path.join(agentsDir(home), 'skills');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    if (!fm) continue;

    const dv = /^disable-model-invocation:[ \t]*(.*)$/m.exec(fm);
    if (!forHuman && dv && /^true$/i.test(unquote(dv[1]))) continue;
    const dm = /^description:\s*([\s\S]*?)(?=\n[A-Za-z][\w-]*:|$)/m.exec(fm);
    out.push({ name: n, description: unquote((dm ? dm[1] : '').replace(/\s+/g, ' ')) });
  }
  return out;
}

function skillIndex(home, { maxDesc = DESC_LIMIT } = {}) {
  return listSkills(home)
    .map((s) => {
      const d = s.description.length > maxDesc ? s.description.slice(0, maxDesc) + '…' : s.description;
      return `  - ${s.name}: ${d}`;
    })
    .join('\n');
}

function skillNames(home, opts) {
  return listSkills(home, opts).map((s) => s.name);
}

function searchSkills(home, query, { limit = 12, maxDesc = DESC_LIMIT } = {}) {
  const all = listSkills(home);
  const q = String(query || '').trim();
  let hit;
  if (q.toLowerCase().startsWith('select:')) {
    const want = q
      .slice(7)
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    hit = all.filter((s) => want.includes(s.name.toLowerCase()));
  } else {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    hit = all
      .map((s) => {
        const hay = (s.name + ' ' + s.description).toLowerCase();
        return { s, n: words.filter((w) => hay.includes(w)).length };
      })
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .map((x) => x.s);
  }
  return hit.slice(0, limit).map((s) => ({
    name: s.name,
    description: s.description.length > maxDesc ? s.description.slice(0, maxDesc) + '…' : s.description,
  }));
}

function expandHomeIn(text, home) {
  const h = String(home || '').replace(/\/+$/, '');
  if (!h) return text;

  return String(text).replace(/(^|[\s"'`(\[])~\//g, (_, pre) => `${pre}${h}/`);
}

function readSkill(home, name) {
  const n = safeName(name);
  const f = path.join(agentsDir(home), 'skills', n, 'SKILL.md');
  const text = fs.readFileSync(f, 'utf8');
  if (/^disable-model-invocation:\s*true\s*$/m.test(frontmatter(text))) {
    throw new Error(`この skill は模型からは使えません（人が /${n} で呼ぶもの）`);
  }

  return expandHomeIn(text, homeOf(home));
}

function outputStyleDir(home) {
  return path.join(home || os.homedir(), '.claude', 'output-styles');
}

function listOutputStyles(home) {
  let names = [];
  try {
    names = fs.readdirSync(outputStyleDir(home)).filter((n) => /\.md$/.test(n));
  } catch {
    return [];
  }
  return names.map((file) => {
    const body = fs.readFileSync(path.join(outputStyleDir(home), file), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
    const head = fm ? fm[1] : '';
    const pick = (k) => {
      const m = new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(head);
      return m ? m[1].trim().replace(/^["\']|["\']$/g, '') : '';
    };
    return {
      file,
      name: pick('name') || file.replace(/\.md$/, ''),
      description: pick('description'),
      body: (fm ? body.slice(fm[0].length) : body).trim(),
    };
  });
}

function loadOutputStyle(name, home) {
  if (!name) return null;
  return listOutputStyles(home).find((x) => x.name === name || x.file === name) || null;
}

module.exports = {
  fitRules,
  RULES_BODY_NAME,
  listOutputStyles,
  loadOutputStyle,
  skillNames,
  searchSkills,
  loadRules,
  loadProjectRules,
  readRule,
  listRules,
  listSkills,
  skillIndex,
  readSkill,
  expandHomeIn,
  DESC_LIMIT,
};
