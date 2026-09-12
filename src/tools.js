const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const globalrules = require('./globalrules');
const { normalizeTodos, todoCount } = require('./todo');
const webfetch = require('./webfetch');
const browser = require('./browser');

const DEFAULT_ALLOWLIST = [
  'git status',
  'git diff',

  'git log',
  'git show',
  'npm test',
  'npm run lint',
  'composer install',
  'php -l',

  'node --check',
];

const DEFAULT_DENYLIST = [
  {
    re: /(^|\s)--output(=|\s|$)/,
    why: '--output は作業場の外へ書けます',
    key: 'tool.deny.output',

    一度だけ許せる: true,
  },
  {
    re: /^git\b[\s\S]*\bbranch\b[\s\S]*\s(-d|-D|-m|-M|--delete|--force|--move)(=|\s|$)/,
    why: 'git branch のこの引数は枝を消したり付け替えたりします',
    key: 'tool.deny.gitBranch',

    一度だけ許せる: true,
  },
  {

    re: /^node(?=\s|$)[\s\S]*(^|\s)(-r|--require|--import|--loader|--experimental-loader|-e|--eval|-p|--print)(=|\s|$)/,
    why: 'node のこの引数は、構文を見る前に別のものを走らせます',
    key: 'tool.deny.nodePreload',

    一度だけ許せる: true,
  },

  {
    re: /--remote-debugging-(port|pipe)(=|\s|$)/,
    why:
      '遠隔デバッグの口を開く browser は、命令からは起こせません。' +
      '隔離した browser は browser_open が自分で起こすので、そちらを使ってください',
    key: 'tool.deny.remoteDebugging',

  },
  {
    re: /(^|[\s"'/])(Google Chrome|Google Chrome Canary|Chromium|Microsoft Edge|Brave Browser)([\s"']|$)[\s\S]*--user-data-dir(=|\s)/,
    why:
      'browser を別の設定ファイルで起こす事は、命令からはできません。' +
      '隔離した browser は browser_open が自分で起こすので、そちらを使ってください',
    key: 'tool.deny.browserProfile',

  },
];

function mergeDenylist(extra, onDropped = (x) => {
  console.warn(`chatgptBridge.denylist: 字の並びでないので捨てました: ${JSON.stringify(x)}`);
}) {
  const more = [];
  for (const src of extra || []) {
    if (typeof src !== 'string') {
      onDropped(src);
      continue;
    }
    try {
      more.push({ re: new RegExp(String(src)), key: 'tool.deny.other', why: `否決の規則に当たりました: ${src}` });
    } catch (e) {

    }
  }
  return DEFAULT_DENYLIST.concat(more);
}

function denyReason(command, denylist = DEFAULT_DENYLIST) {
  const c = String(command || '').trim().replace(/\s+/g, ' ');

  const 当たり = [];
  for (const rule of denylist) {
    const re = rule.re instanceof RegExp ? rule.re : new RegExp(rule.re);
    if (re.test(c)) 当たり.push(rule);
  }
  if (!当たり.length) return null;

  const 硬い = 当たり.find((r) => r.一度だけ許せる !== true) || 当たり[0];

  return {

    why: 当たり.map((r) => r.why || '否決の表に当たりました').join('\n'),
    key: 硬い.key || 'tool.deny.other',

    一度だけ許せる: 当たり.every((r) => r.一度だけ許せる === true),
  };
}

class ToolError extends Error {
  constructor(message, key, vars) {
    super(message);
    this.name = 'ToolError';
    this.i18n = key ? { key, vars: vars || {} } : null;
  }
}

const READ_LIMIT_BYTES = 60000;

const OUTPUT_LIMIT_CHARS = 8000;

const CONFIG_OPEN = [
  'notify',
  'outputStyle',
  'autosave',
  'respectGitIgnore',
  'preventDoneWithOpenTodos',
  'requireModifierToSend',
  'revealOnStart',
  'maxTurns',
  'subAgents',
];

const GLOB_MAX = 100;

const MAX_STAGES = 4;

const COMMAND_TIMEOUT_MS = 120000;

const COMMAND_TIMEOUT_MAX_MS = 600000;

const COMMAND_KEEP = 200000;

const COMMAND_KILL_GRACE_MS = 2000;

const SEARCH_MAX_HITS = 200;
const SEARCH_MAX_FILE_BYTES = 1000000;
const SEARCH_SKIP = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next']);

const DANGEROUS_DIRS = ['.git', '.vscode', '.idea', '.claude', '.agents'];
const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
];

function bareName(seg) {
  return String(seg).replace(/[. ]+$/, '').toLowerCase();
}

const DOORS = [
  {
    re: /(^|\/)\.agents\/rules\/([^/]+)\.md$/i,
    say: (m) => `read_rule で読めます: {"name":"read_rule","input":{"name":"${m[2]}"}}`,
  },
  {
    re: /(^|\/)\.agents\/rules\/?$/i,
    say: () => 'read_rule を name なしで呼ぶと一覧が出ます',
  },
  {
    re: /(^|\/)\.(?:agents|claude)\/skills\/([^/]+)(?:\/|$)/i,
    say: (m) => `read_skill で読めます: {"name":"read_skill","input":{"name":"${m[2]}"}}`,
  },
];

function doorFor(rel) {
  const p = String(rel).replace(/\\/g, '/');
  for (const d of DOORS) {
    const m = d.re.exec(p);
    if (m) return d.say(m);
  }
  return null;
}

function isDangerousPath(rel) {
  const segs = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i += 1) {
    const n = bareName(segs[i]);
    if (DANGEROUS_DIRS.includes(n)) return true;

    if (i === segs.length - 1 && DANGEROUS_FILES.includes(n)) return true;
  }
  return false;
}

const GUARDED_IN_CMD = /(^|[\s'"`=(&|;/])(\.git|\.vscode|\.idea|\.claude|\.agents)\//;
const SKILLS_IN_CMD = /\/skills\//;

function guardedPathInCommand(cmd) {
  const c = String(cmd || '');
  const m = GUARDED_IN_CMD.exec(c);
  if (!m) return null;

  const parts = c.split(/[\s'"`;|&]+/).filter((x) => GUARDED_IN_CMD.test(' ' + x));
  if (parts.length && parts.every((x) => SKILLS_IN_CMD.test(x))) return null;
  return (parts.find((x) => !SKILLS_IN_CMD.test(x)) || m[0]).trim();
}

const SECRET_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)service-account.*\.json$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  /(^|\/)secrets?\.(json|ya?ml|toml|ini)$/i,
];

function pathGlobToRegExp(pattern) {
  const p = String(pattern || '').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {

        if (p[i + 2] === '/') {
          out += '(?:[^/]*/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    if (c === '{') {
      const end = p.indexOf('}', i);
      if (end > i) {
        const 中 = p.slice(i + 1, end).split(',');
        out += '(?:' + 中.map((x) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
        continue;
      }
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

function globToRegExp(line) {
  const anchored = line.startsWith('/');

  const body = (anchored ? line.slice(1) : line).replace(/\/+$/, '');
  const esc = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(anchored ? `^${esc}(/|$)` : `(^|/)${esc}(/|$)`);
}

function readIgnoreRules(root) {
  const file = path.join(root, '.bridgeignore');
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(globToRegExp);
}

function whyBlocked(root, rel, { protectSecrets = true } = {}) {
  const p = String(rel).replace(/\\/g, '/');

  if (isDangerousPath(p)) {
    const door = doorFor(p);
    return (
      '触らせない場所です（git やエディターの設定は、書ければ次の命令実行になります）' +
      (door ? `。中身が要るなら ${door}` : '')
    );
  }
  if (protectSecrets && SECRET_PATTERNS.some((re) => re.test(p))) {
    return '秘密が入っていそうなファイルなので中身を渡しません（設定 chatgptBridge.protectSecrets）';
  }
  for (const re of readIgnoreRules(root)) {
    if (re.test(p)) return '.bridgeignore で除いてあるので中身を渡しません';
  }
  return null;
}

const TAIL_CLOSE = /\s*<\/body>\s*<\/html>\s*$|\s*<\/html>\s*$/i;

function notebookAsText(raw) {
  let nb;
  try {
    nb = JSON.parse(raw);
  } catch {
    return raw;
  }
  const cells = Array.isArray(nb && nb.cells) ? nb.cells : null;
  if (!cells) return raw;
  const join = (x) => (Array.isArray(x) ? x.join('') : String(x == null ? '' : x));
  const out = [];
  cells.forEach((c, i) => {

    const id = c && c.id ? String(c.id) : `#${i}`;
    out.push(`--- cell ${id} (${(c && c.cell_type) || 'code'}) ---`);
    out.push(join(c && c.source));
    for (const o of (c && c.outputs) || []) {
      const t = join(o.text) || join((o.data || {})['text/plain']);
      if (t) out.push(`--- output ---\n${t}`);
      else if (o.data) out.push(`--- output --- （${Object.keys(o.data).join(' / ')}。字ではないので出しません）`);
    }
  });
  return out.join('\n');
}

function clip(s, n = OUTPUT_LIMIT_CHARS) {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…（ここで切りました。全体は ${s.length} 文字）`;
}

const HOW_NARROW = '落とした分はもう出せません。全部が要るなら、条件の側で絞って呼び直してください';
const HOW_NARROW_CMD =
  '落とした分はもう出せません。全部が要るなら、命令の側で絞ってください' +
  '（grep で行を選ぶ / head・tail で範囲を切る / jq で要る鍵だけ出す / API なら件数の引数を付ける）';

function clipMiddle(s, n = OUTPUT_LIMIT_CHARS, how = HOW_NARROW) {
  if (s.length <= n) return s;
  const half = Math.floor(n / 2);
  const dropped = s.slice(half, -half).split('\n').length;
  return `${s.slice(0, half)}\n\n…（真ん中の ${dropped} 行を落としました。全体は ${s.length} 文字。${how}）\n\n${s.slice(-half)}`;
}

function withFull(full, clipped) {
  return clipped === full ? { output: clipped } : { output: clipped, full: full };
}

function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new ToolError('path が空です', 'tool.pathEmpty');
  }

  const target = path.resolve(root, expandHome(rel));

  let probe = target;
  for (;;) {
    if (fs.existsSync(probe)) break;
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const realRoot = fs.realpathSync(root);
  const realProbe = fs.existsSync(probe) ? fs.realpathSync(probe) : probe;
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
    throw new ToolError(`ワークスペースの外です: ${rel}`, 'tool.outside', { rel });
  }
  return target;
}

function wantName(v, 何の) {
  if (typeof v !== 'string') {
    throw new ToolError(
      `${何の}の名前は文字で渡してください（${Array.isArray(v) ? '配列' : typeof v} が来ました）`,
      'tool.nameType',
      { what: 何の, got: Array.isArray(v) ? 'array' : typeof v }
    );
  }
  if (!v.trim()) {

    throw new ToolError(`${何の}の名前が空です`, 'tool.nameEmpty', { what: 何の });
  }
  return v.trim();
}

const ALWAYS_ON = [

  'switch_mode',
  'ask_user',
  'done',
  'update_todos',
  'read_rule',
  'read_skill',
  'search_skills',
  'search_tools',
];

function isAllowed(command, allowlist) {
  const c = command.trim().replace(/\s+/g, ' ');
  return allowlist.some((a) => c === a || c.startsWith(a + ' '));
}

const SHELL_META = /[;&|`$<>\n\r]/;

const EXPANDS_IN_DQUOTE = /[`$]/;

function leadingAssignment(cmd) {
  return /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(String(cmd || ''));
}

function shellMetaOutsideQuotes(cmd) {
  let quote = null;
  const s2 = String(cmd || '');
  for (let i = 0; i < s2.length; i += 1) {
    const c = s2[i];
    if (quote) {
      if (c === quote) quote = null;

      else if (quote === '"' && EXPANDS_IN_DQUOTE.test(c)) return c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (SHELL_META.test(c)) return c;
  }
  return null;
}

function nearbyFiles(e, target) {
  if (!e || e.code !== 'ENOENT' || typeof target !== 'string') return '';
  const dir = path.dirname(target);
  let items = [];
  try {
    items = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return `\n（${dir} が開けません）`;
  }
  if (!items.length) return `\n（${dir} は空です）`;
  const shown = items.slice(0, 40);
  return (
    `\n\n${dir} に在るのは:\n` +
    shown.map((n) => `  - ${n}`).join('\n') +
    (items.length > shown.length ? `\n  …ほか ${items.length - shown.length} 件` : '')
  );
}

const RUNS_ANYTHING = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'node', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'php', 'osascript',
  'env', 'nohup', 'xargs', 'nice', 'time', 'sudo', 'doas', 'ssh', 'eval',
]);

function canRememberAlways(prog) {
  const base = String(prog || '').split('/').pop();
  return !RUNS_ANYTHING.has(base);
}

function expandHome(arg) {
  const home = process.env.HOME || '';
  if (!home) return arg;
  if (arg === '~') return home;
  if (arg.startsWith('~/')) return path.join(home, arg.slice(2));
  return arg;
}

function splitArgs(command) {
  const argv = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || has) argv.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (quote) throw new ToolError(`引用符が閉じていません: ${command}`, 'tool.quote', { command });
  if (cur || has) argv.push(cur);
  return argv;
}

const checkpoint = require('./checkpoint');
const mcpMod = require('./mcp');

function isGitRepo(root) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const GIT_IO = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

function notIgnored(root) {
  try {
    const out = execFileSync(
      'git',

      ['-c', 'core.quotePath=false', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { ...GIT_IO, maxBuffer: 64 * 1024 * 1024 }
    );
    const set = new Set();
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (t) set.add(t);
    }

    return set;
  } catch {

    return null;
  }
}

function isDirty(root) {
  const out = execFileSync('git', ['-C', root, 'status', '--porcelain'], GIT_IO);
  return out.trim().length > 0;
}

function headSha(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], GIT_IO).trim();
  } catch {
    return null;
  }
}

function ensureRestorePoint(root, label) {
  return checkpoint.save(root, label);
}

const NEAR_LINES = 12;

function softenForMatch(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n');
}

function nearbyOf(before, oldText) {
  const lines = before.split('\n');
  const want = String(oldText).split('\n')[0].trim();
  if (!want) return '';
  let at = -1;
  let best = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i].trim();
    if (!l) continue;
    let n = 0;
    while (n < l.length && n < want.length && l[n] === want[n]) n += 1;
    if (n > best) {
      best = n;
      at = i;
    }
  }

  if (best < 8) {

    const 手 = want.length > 24 ? want.slice(0, 24) : want;
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i];
      if (!l.trim()) continue;

      for (let len = 手.length; len >= 6; len -= 2) {
        if (l.includes(手.slice(0, len)) && len > best) {
          best = len;
          at = i;
          break;
        }
      }
    }
  }
  if (at < 0 || best < 3) return '';
  const from = Math.max(0, at - 2);
  const to = Math.min(lines.length, at + NEAR_LINES);
  return lines
    .slice(from, to)
    .map((l, i) => `${from + i + 1}: ${l}`)
    .join('\n');
}

function nearbyPaths(root, rel) {
  const base = path.basename(String(rel || ''));
  if (!base || base.includes('*')) return '';
  const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', 'prior-art']);
  const MAX_DEPTH = 5;
  const MAX_HITS = 3;
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || hits.length >= MAX_HITS) return;
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (hits.length >= MAX_HITS) return;
      if (d.name.startsWith('.') && d.name !== '.github') continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (SKIP.has(d.name)) continue;
        walk(full, depth + 1);
      } else if (d.name === base) {
        hits.push(path.relative(root, full));
      }
    }
  };
  try {
    walk(root, 0);
  } catch {
    return '';
  }
  if (hits.length) {
    return `同じ名前なら、ここに在ります: ${hits.join(' / ')}`;
  }

  return `\`${base}\` という名前のファイルは、このワークスペースのどこにもありません。` +
    'list_dir か search で、実際に在る名前を確かめてください。';
}

function routeFor(p) {
  const s = String(p || '');
  const skill = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/.exec(s);
  if (skill) return `skill は read_skill で読みます: {"name":"${skill[1]}"}`;
  if (/SKILL\.md$/.test(s)) return 'skill は read_skill で読みます（名前だけを渡してください）。';
  const rule = /(?:^|\/)rules\/([^/]+)\.md$/.exec(s);
  if (rule) return `決まりは read_rule で読みます: {"name":"${rule[1]}"}`;
  return '';
}

const READS = [

    'list_dir',
    'glob',
    'read_file',
    'search',

    'read_rule',
    'search_skills',
    'read_skill',

    'web_search',
    'web_fetch',

    'update_todos',
  ];
function makeTools({

  root: rootIn,

  allowlist: allowlistIn = DEFAULT_ALLOWLIST,
  denylist = DEFAULT_DENYLIST,

  timeoutAllowlist = [],

  defaultTimeoutMs = COMMAND_TIMEOUT_MS,
  protectSecrets = true,

  spawnAgents = null,

  readOnly = false,

  disabled = [],

  modes = [],

  onModeSwitch = null,

  startMode = '',

  beforeTouch = null,

  afterTouch = null,

  respectGitIgnore = true,

  onWorktree = null,

  planMode = false,

  onExitPlan = null,

  readSetting = null,
  writeSetting = null,

  askPermission = null,

  allowedOutside: allowedOutsideIn = [],
  allowedOutsideWrite: allowedOutsideWriteIn = [],

  onAllowAlways = null,

  isRevoked = null,

  mcp = null,

  allowedMcpServers: allowedMcpServersIn = [],

  allowedSites: allowedSitesIn = [],

  browserProfile = '',

  browserPath = '',
  openTabs: openTabsIn = null,

  onOpenTabs = null,

  onCommandOutput = null,

  onAttach = null,
  onTodos = null,

  seenUrls = null,

  mode = 'edit',
} = {}) {
  let root = rootIn;

  const 元の作業場 = rootIn;
  let 写し = null;

  let allowlist = allowlistIn;

  const background = new Map();
  let 番 = 0;

  const 止める = (rec, sig) => {
    if (!rec.child || rec.ended) return;
    try {
      process.kill(-rec.child.pid, sig);
    } catch {

      try {
        rec.child.kill(sig);
      } catch {

      }
    }
  };

  const allowedRead = new Set(allowedOutsideIn);
  const allowedWrite = new Set(allowedOutsideWriteIn);

  const allowedMcp = new Set(allowedMcpServersIn.map((x) => String(x)));

  const allowedSite = new Set(allowedSitesIn.map((x) => String(x)));

  if (browserProfile) process.env.BRIDGE_BROWSER_PROFILE = browserProfile;

  if (browserPath) process.env.BRIDGE_BROWSER_PATH = browserPath;

  const 目印を読む = (call, 深さ = 0) => {
    const 目印 = {
      role: String(call.role || '').trim(),
      name: String(call.name || '').trim(),
      selector: String(call.selector || '').trim(),
      text: String(call.text || '').trim(),
      key: String(call.key || '').trim(),
    };

    if (call.中 && typeof call.中 === 'object' && !Array.isArray(call.中)) {
      if (深さ >= 5) {
        throw new ToolError(
          '入れ子が深すぎます（5 段 まで）。browser_read の写しを見て、近い入れ物から書いてください。',
          'tool.browserNestTooDeep'
        );
      }
      目印.中 = 目印を読む(call.中, 深さ + 1);
    }
    if (!目印.role && !目印.selector && !目印.text && !目印.key) {
      throw new ToolError(
        'role（と name）か、selector か、text を渡してください。\n' +
          'browser_read の写しに出ている通りに書けます（例: role="combobox", name="月"）。',
        'tool.browserNoTarget'
      );
    }
    return 目印;
  };
  const 目印の字 = (目印) => {
    const 頭 = 目印.role
      ? `${目印.role}${目印.name ? ` "${目印.name}"` : ''}`
      : 目印.selector || 目印.text || 目印.key || '(焦点)';

    return 目印.中 ? `${頭} > ${目印の字(目印.中)}` : 頭;
  };

  const 開いたタブ = new Map(openTabsIn || []);

  let いま見ているタブ = null;

  const 取り消された = (kind, detail) => {
    if (!isRevoked) return false;
    try {
      return !!isRevoked({ kind, detail: String(detail) });
    } catch {

      return true;
    }
  };

  const under = (set, abs, kind) =>
    [...set].some(
      (d2) => (abs === d2 || abs.startsWith(d2 + path.sep)) && !取り消された(kind, d2)
    );

  const 生きている許可 = () =>
    isRevoked ? allowlist.filter((a) => !取り消された('command', a)) : allowlist;

  const askOrPass = async (q) => {
    if (mode === 'never') return 'once';
    return askPermission ? askPermission(q) : 'no';
  };

  async function pathFor(rel, { write = false } = {}) {
    try {
      const inside = resolveInside(root, rel);

      if (write && mode === 'ask') {

        const answer = await askOrPass({ kind: 'pathWriteInside', detail: inside });
        if (answer !== 'once' && answer !== 'always') {
          throw new ToolError(`書き換えを許しませんでした: ${rel}`, 'tool.noWrite', { rel });
        }

      }
      if (beforeTouch) await beforeTouch(inside, { write });
      return inside;
    } catch (e) {
      if (!/ワークスペースの外です/.test(String(e.message))) throw e;
      const abs = path.resolve(root, expandHome(String(rel)));

      if (under(allowedWrite, abs, 'pathWrite')) return abs;
      if (!write && under(allowedRead, abs, 'path')) return abs;
      const answer = await askOrPass({ kind: write ? 'pathWrite' : 'path', detail: abs });
      if (answer === 'always') {

        let dir = abs;
        try {
          if (!fs.statSync(abs).isDirectory()) dir = path.dirname(abs);
        } catch {
          dir = path.dirname(abs);
        }

        (write ? allowedWrite : allowedRead).add(dir);

        if (onAllowAlways) {
          try {
            await onAllowAlways({ kind: write ? 'pathWrite' : 'path', detail: dir });
          } catch {

          }
        }
      } else if (answer !== 'once') {

        throw new ToolError(
          `ワークスペースの外です: ${rel}` + (askPermission ? '（利用者が許しませんでした）' : ''),
          askPermission ? 'tool.outsideNo' : 'tool.outside',
          { rel }
        );
      }
      if (beforeTouch) await beforeTouch(abs, { write });
      return abs;
    }
  }

  const guard = (rel) => {
    const why = whyBlocked(root, rel, { protectSecrets });
    if (why) throw new ToolError(`${why}: ${rel}`, 'tool.blocked', { why, rel });
  };

  const readAt = new Map();

  const failedWrite = new Map();

  const guardOverwrite = (rel, file) => {
    if (!fs.existsSync(file)) return;
    const seen = readAt.get(file);
    if (seen == null) {
      throw new ToolError(
        `${rel} はもう在ります。中身を見ないまま書き換えると、` +
          'そこに在ったものが消えます。read_file で読んでから書いてください',
        'tool.exists',
        { rel }
      );
    }
    const now = fs.statSync(file).mtimeMs;
    if (now > seen) {
      throw new ToolError(
        `${rel} は、あなたが読んだ後に変わっています（利用者か整形器が触りました）。` +
          'read_file で読み直してから書いてください',
        'tool.changed',
        { rel }
      );
    }
  };
  const all = {
    async list_dir(call) {
      const dir = await pathFor(call.path || '.');
      const items = fs.readdirSync(dir, { withFileTypes: true });
      const lines = items
        .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
      const listing = lines.join('\n') || '（空）';
      return { ok: true, target: call.path || '.', ...withFull(listing, clip(listing)) };
    },

    async browser_open(call) {
      const url = String(call.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new ToolError('http か https の場所を渡してください', 'tool.httpOnly');
      }

      if (browser.isOwnSite(url)) {
        throw new ToolError(
          `この站は開けません: ${browser.originOf(url) || url}\n` +
            '相手（ChatGPT）が居る站なので、こちらからは触りません。',
          'tool.browserOwnSite',
          { url }
        );
      }
      await 站の関門(url);
      let r;
      try {
        r = await browser.open(url);
      } catch (e) {
        throw new ToolError(
          `頁を開けませんでした: ${e.message}\n` +
            '隔離した browser が起きていないかもしれません（npm run browser）。',
          'tool.browserOpenFail',
          { why: e.message }
        );
      }
      開いたタブ.set(r.targetId, r.url);
      いま見ているタブ = r.targetId;

      if (seenUrls) seenUrls.add(r.url);
      return {
        ok: true,
        target: r.url,
        output: `開きました（tab=${r.targetId}）\n${r.title || '(題なし)'}\n${r.url}`,
      };
    },

    async browser_read(call) {
      const id = await タブを決める(call.tab);
      const r = await browser.read(id);

      if (seenUrls) {
        if (r && r.url) seenUrls.add(r.url);
        for (const im of (r && r.images) || []) if (im && im.src) seenUrls.add(im.src);
      }

      const 絵 = (r && r.images) || [];
      const 絵の行 = 絵.length
        ? '\n\n画像（そのまま browser_save の url へ渡せます）:\n' +
          絵.map((im) => `  ${im.src}${im.alt ? `  ${im.alt}` : ''}${im.w ? `  ${im.w}x${im.h}` : ''}`).join('\n') +
          (r.imagesTotal > 絵.length ? `\n  （ほかに ${r.imagesTotal - 絵.length} 枚 あります）` : '')
        : '';

      const 写しの行 = r.写しが読めない
        ? `\n\n作り（役目と名前）: 読めませんでした（${r.写しが読めない}）`
        : r.写し
          ? '\n\n作り（browser_set / browser_click の role と name は ここから写せます）:\n' +
            r.写し +
            (r.写しを切った ? `\n  （長いので ${r.写しを切った} 字 切りました）` : '')
          : '';
      const 本文の行 = r.本文が読めない
        ? `読めませんでした（${r.本文が読めない}）`
        : `${r.text || ''}${r.本文を切った ? `\n  （長いので ${r.本文を切った} 字 切りました）` : ''}`;
      const body =
        `題名: ${r.title || '(題なし)'}\n場所: ${r.url}${写しの行}\n\n本文:\n${本文の行}${絵の行}`;
      return { ok: true, target: r.url || id, ...withFull(body, clipMiddle(body)) };
    },

    async browser_click(call) {

      const 目印 = 目印を読む(call);
      const id = await タブを決める(call.tab);

      const いま = await browser.targetOf(id);
      await 站の関門((いま && いま.url) || '', `browser_click ${目印の字(目印)}`);
      const r = await browser.click(id, 目印);
      if (!r || !r.ok) {

        throw new ToolError(
          `押せませんでした: ${(r && r.why) || '理由が返りません'}（当たり ${(r && r.n) || 0} 件）\n` +
            'browser_read で頁を読んでから、絞ってください。\n' +
            '同じ名前が並ぶ時は、入れ物で絞れます（写しの入れ子のとおりに書けます）:\n' +
            '  {"role":"row","name":"田中","中":{"role":"button","name":"編輯"}}',
          'tool.browserClickFail',
          { why: (r && r.why) || '', n: String((r && r.n) || 0) }
        );
      }
      return {
        ok: true,
        target: r.label || 目印の字(目印),
        output: `押しました: ${r.label || 目印の字(目印)}`,
      };
    },

    async browser_set(call) {
      const 目印 = 目印を読む(call);
      if (call.value === undefined || call.value === null) {
        throw new ToolError('value を渡してください（勾は真偽、選ぶ欄は見えている字）', 'tool.browserNoValue');
      }
      const id = await タブを決める(call.tab);

      const いま = await browser.targetOf(id);
      await 站の関門((いま && いま.url) || '', `browser_set ${目印の字(目印)}`);
      const r = await browser.set(id, 目印, call.value);
      if (!r || !r.ok) {
        throw new ToolError(
          `値を入れられませんでした: ${(r && r.why) || '理由が返りません'}（当たり ${(r && r.n) || 0} 件）\n` +
            'browser_read で頁を読んで、写しに出ている役目（role）と名前（name）をそのまま渡してください。',
          'tool.browserSetFail',
          { why: (r && r.why) || '', n: String((r && r.n) || 0) }
        );
      }
      return {
        ok: true,
        target: 目印の字(目印),
        output: `入れました。いま入っているのは: ${JSON.stringify(r.value || '')}`,
      };
    },

    async browser_shot(call) {
      const id = await タブを決める(call.tab);
      const いま = await browser.targetOf(id);
      await 站の関門((いま && いま.url) || '', 'browser_shot');
      const r = await browser.shot(id, { full: !!call.full });
      const buf = Buffer.from(String(r.base64 || ''), 'base64');
      if (!buf.length) throw new ToolError('画面を撮れませんでした', 'tool.browserShotEmpty');

      let 保存 = '';
      const rel = String(call.path || '').trim();
      if (rel) {
        const abs = await pathFor(rel, { write: true });
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        保存 = `\n${rel} にも保存しました`;
      }

      if (!onAttach) {
        return {
          ok: true,
          target: r.url || id,
          output:
            `撮りました（${buf.length} バイト）。**ただし、この走りでは相手へ渡せません**` +
            `（添える手立てが渡されていません）。${保存}`,
        };
      }
      const 名 = `screen-${Date.now()}.png`;
      onAttach({ name: 名, mime: 'image/png', b64: buf.toString('base64') });
      return {
        ok: true,
        target: r.url || id,
        output: `撮りました（${名} / ${buf.length} バイト）。**次の便りに添えます。**${保存}`,
      };
    },

    async browser_type(call) {

      const text = String(call.text || '');
      const key = String(call.key || '').trim();
      if (!text && !key) {
        throw new ToolError('text か key のどちらかを渡してください', 'tool.browserNoText');
      }

      const 目印 = {
        role: String(call.role || '').trim(),
        name: String(call.name || '').trim(),
        selector: String(call.selector || '').trim(),
        text,
        key,
      };
      const 指す = 目印.role || 目印.selector ? 目印の字(目印) : '(いま焦点が在る所)';
      const id = await タブを決める(call.tab);

      const いま = await browser.targetOf(id);
      await 站の関門((いま && いま.url) || '', `browser_type ${指す}`);
      let r;
      try {
        r = await browser.type(id, 目印);
      } catch (e) {
        throw new ToolError(e.message, 'tool.browserTypeFail', { why: e.message });
      }
      if (!r || !r.ok) {
        throw new ToolError(
          `打てませんでした: ${(r && r.why) || '理由が返りません'}（当たり ${(r && r.n) || 0} 件）\n` +
            'browser_read で頁を読んでから、selector を絞ってください。',
          'tool.browserTypeFail',
          { why: (r && r.why) || '', n: String((r && r.n) || 0) }
        );
      }

      return {
        ok: true,
        target: 指す,
        output:
          `打ちました${key ? `（鍵: ${key}）` : ''}。` +
          `いまその欄に入っているのは: ${JSON.stringify(r.value || '')}`,
      };
    },

    async browser_close(call) {
      const id = await タブを決める(call.tab);
      const url = 開いたタブ.get(id) || '';
      await browser.close(id);
      開いたタブ.delete(id);
      if (いま見ているタブ === id) いま見ているタブ = null;
      return {
        ok: true,
        target: url || id,
        output:
          `閉じました。${開いたタブ.size ? `まだ ${開いたタブ.size} 枚 開いています` : 'ほかに開いている頁はありません'}`,
      };
    },

    async browser_scroll(call) {

      const to = String(call.to || '').trim();
      const dy = Number(call.dy || 0);
      if (!to && !dy) {
        throw new ToolError('dy（画素。＋が下）か to（top / bottom）を渡してください', 'tool.browserNoScroll');
      }
      if (to && to !== 'top' && to !== 'bottom') {
        throw new ToolError(`to は top か bottom です: ${to}`, 'tool.browserBadScroll', { to });
      }
      const id = await タブを決める(call.tab);
      const r = await browser.scroll(id, { dy, to });

      return {
        ok: true,
        target: to || `${dy}px`,
        output:
          `${r.from} から ${r.to} へ（${r.moved} 画素 動きました）。` +
          `頁の高さ ${r.height} / 見えている高さ ${r.view}` +
          (r.moved === 0 ? '\n**動いていません。**もう端に着いています。' : ''),
      };
    },

    async browser_save(call) {

      const url = String(call.url || '').trim();
      const rel = String(call.path || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new ToolError('http か https の場所を渡してください', 'tool.httpOnly');
      }
      if (!rel) throw new ToolError('path（保存先）を渡してください', 'tool.noPath');
      const id = await タブを決める(call.tab);
      await 站の関門(url, `browser_save ${url}`);

      const abs = await pathFor(rel, { write: true });
      const r = await browser.fetchBytes(id, url);
      if (!r || !r.ok) {
        throw new ToolError(
          `取れませんでした: ${(r && r.why) || '理由が返りません'}`,
          'tool.browserSaveFail',
          { why: (r && r.why) || '' }
        );
      }
      const buf = Buffer.from(String(r.base64 || ''), 'base64');
      if (!buf.length) throw new ToolError('中身が空でした', 'tool.browserSaveEmpty');

      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      if (seenUrls) seenUrls.add(url);
      return {
        ok: true,
        target: rel,
        output: `落としました: ${rel}（${buf.length} バイト${r.type ? ` / ${r.type}` : ''}）`,
      };
    },

    async spawn_agents(call) {
      if (!spawnAgents) {
        throw new ToolError('サブエージェントはこの入口では使えません（対話の画面から使ってください）', 'tool.subNoCli');
      }

      const stages = Array.isArray(call.stages) ? call.stages : null;
      if (stages) {
        if (!stages.length) throw new ToolError('stages が空です', 'tool.tasksNeeded');
        if (stages.length > MAX_STAGES) {
          throw new ToolError(
            `段は ${MAX_STAGES} つまでです（${stages.length} つ来ました）`,
            'tool.tooManyStages',
            { got: stages.length }
          );
        }
        const 全 = [];
        const 文 = [];
        let 前の結果 = '';
        for (let i = 0; i < stages.length; i += 1) {
          const 段 = Array.isArray(stages[i]) ? stages[i] : [stages[i]];
          if (!段.length) throw new ToolError(`${i + 1} 段目が空です`, 'tool.tasksNeeded');

          const 頼み = 段.map((t) =>
            前の結果
              ? `${String(t)}\n\n--- 前の段で分かったこと ---\n${前の結果}`
              : String(t)
          );

          const r = await spawnAgents(頼み, { wait: true });
          if (r.why) throw new ToolError(r.why, 'tool.subFail', { why: r.why });
          全.push(...r.results);
          前の結果 = r.text;
          文.push(`=== ${i + 1} 段目（${段.length} 本） ===\n${r.text}`);
        }
        const body = 文.join('\n\n');
        return {
          ok: true,
          target: `${stages.length} 段 / ${全.length} 本`,
          ...withFull(body, clipMiddle(body)),
        };
      }

      const tasks = Array.isArray(call.tasks) ? call.tasks : [];
      if (tasks.length === 0) {
        throw new ToolError('tasks か stages が要ります（配列で 1 件以上）', 'tool.tasksNeeded');
      }

      const 待つ = call.run_in_background === false;
      const r = await spawnAgents(tasks, { wait: 待つ });
      if (r.why) throw new ToolError(r.why, 'tool.subFail', { why: r.why });

      if (r.started) {
        return {
          ok: true,
          target: `${r.n} 本を背景で始めた（${r.started}）`,
          output:
            `${r.n} 本を背景で始めました。**結果はまだ出ていません。**\n` +
            '終わったら、次のあなたのターンの頭に届きます。\n' +
            '**届く前に、結果を書かないでください。**' +
            '（分からないことは「まだ返っていません」と書く）\n' +
            'それまでの間、**別のことを進めてください。**待つだけの返事は要りません。',
        };
      }
      const ok = r.results.filter((x) => x.ok).length;
      return {
        ok: true,
        target: `${ok}/${r.results.length} 件`,
        output: r.text,
      };
    },

    async config(call) {
      const setting = String(call.setting || '').trim();
      if (!setting) {
        throw new ToolError(
          `どの設定かを渡してください。読み書きできるのは: ${CONFIG_OPEN.join(' / ')}`,
          'tool.noSetting'
        );
      }
      if (!CONFIG_OPEN.includes(setting)) {

        throw new ToolError(
          `その設定は相手からは触れません: ${setting}\n` +
            `触れるのは: ${CONFIG_OPEN.join(' / ')}\n` +
            '許しや関門にかかわる設定は、利用者が画面から変えるものです。',
          'tool.settingClosed',
          { setting }
        );
      }
      if (!readSetting) {
        throw new ToolError('この入口では設定を読めません（対話の画面から使ってください）', 'tool.subNoCli');
      }
      if (call.value === undefined) {
        return {
          ok: true,
          target: setting,
          output: `${setting} = ${JSON.stringify(readSetting(setting))}`,
        };
      }
      if (!writeSetting) {
        throw new ToolError('この入口では設定を書けません（対話の画面から使ってください）', 'tool.subNoCli');
      }
      const 前 = readSetting(setting);

      const 答え = await askOrPass({
        kind: 'setting',
        detail: `${setting}\n  いま: ${JSON.stringify(前)}\n  あとで: ${JSON.stringify(call.value)}`,
      });
      if (答え !== 'once' && 答え !== 'always') {
        throw new ToolError(`設定の書き換えは断られました: ${setting}`, 'tool.settingRefused', { setting });
      }
      await writeSetting(setting, call.value);
      return {
        ok: true,
        target: setting,
        output: `${setting} を ${JSON.stringify(前)} から ${JSON.stringify(call.value)} へ変えました。`,
      };
    },

    async enter_worktree(call) {
      if (写し) {
        throw new ToolError(
          `もう写しの中に居ます: ${写し.path}\n先に exit_worktree で出てください。`,
          'tool.inWorktree',
          { path: 写し.path }
        );
      }
      if (!isGitRepo(元の作業場)) {
        throw new ToolError('git の作業場ではないので、写しは作れません', 'tool.notGit');
      }
      const 名 = String(call.name || '').trim() || `bridge-${Date.now().toString(36)}`;

      if (!/^[A-Za-z0-9._\-/]{1,64}$/.test(名)) {
        throw new ToolError(
          `名前に使えない字があります: ${名}（英数字と . _ - / だけ、64 字まで）`,
          'tool.badWorktreeName',
          { name: 名 }
        );
      }

      const 先 = path.join(
        path.dirname(元の作業場),
        '.bridge-worktrees',
        `${path.basename(元の作業場)}--${名}`
      );
      if (fs.existsSync(先)) {
        throw new ToolError(
          `その名前の写しはもう在ります: ${先}\n別の名前にするか、先に片づけてください。`,
          'tool.worktreeExists',
          { path: 先 }
        );
      }
      const 答え = await askOrPass({ kind: 'worktree', detail: `${名}\n${先}` });
      if (答え !== 'once' && 答え !== 'always') {
        throw new ToolError('写しを作るのは断られました', 'tool.worktreeRefused', {});
      }
      try {
        execFileSync('git', ['-C', 元の作業場, 'worktree', 'add', '-b', 名, 先], GIT_IO);
      } catch (e) {
        throw new ToolError(`写しを作れませんでした: ${String(e.message).slice(0, 200)}`, 'tool.worktreeFail', {});
      }
      写し = { path: 先, branch: 名 };
      root = 先;
      if (onWorktree) onWorktree({ entered: true, path: 先, branch: 名 });
      return {
        ok: true,
        target: 名,
        output:
          `写しへ入りました。ここから先の読み書きは、この中だけに効きます。\n` +
          `  場所: ${先}\n  枝: ${名}\n` +
          `元へ戻るときは exit_worktree {"action":"keep"} か {"action":"remove"}。`,
      };
    },

    async exit_worktree(call) {
      if (!写し) throw new ToolError('写しの中に居ません', 'tool.notInWorktree');
      const action = String(call.action || '').trim();
      if (action !== 'keep' && action !== 'remove') {
        throw new ToolError('action は keep か remove です', 'tool.badWorktreeAction', { action });
      }
      const 出す = { path: 写し.path, branch: 写し.branch };
      if (action === 'remove') {
        let 残り = '';
        try {
          残り = execFileSync('git', ['-C', 出す.path, 'status', '--porcelain'], GIT_IO).trim();
        } catch {

          残り = '（確かめられませんでした）';
        }
        if (残り && !call.discard_changes) {
          throw new ToolError(
            `写しに残っている物があります。捨ててよいなら discard_changes: true を付けてください。\n${残り.slice(0, 800)}`,
            'tool.worktreeDirty',
            {}
          );
        }
        try {
          execFileSync('git', ['-C', 元の作業場, 'worktree', 'remove', '--force', 出す.path], GIT_IO);
          execFileSync('git', ['-C', 元の作業場, 'branch', '-D', 出す.branch], GIT_IO);
        } catch (e) {
          throw new ToolError(`写しを片づけられませんでした: ${String(e.message).slice(0, 200)}`, 'tool.worktreeFail', {});
        }
      }
      写し = null;
      root = 元の作業場;
      if (onWorktree) onWorktree({ entered: false, path: 出す.path, branch: 出す.branch, action });
      return {
        ok: true,
        target: action,
        output:
          action === 'keep'
            ? `写しを残したまま出ました。\n  場所: ${出す.path}\n  枝: ${出す.branch}\nこの後の読み書きは、元の作業場に効きます。`
            : `写しを片づけて出ました（枝 ${出す.branch} も消しました）。`,
      };
    },

    async glob(call) {
      const pattern = String(call.pattern || '').trim();
      if (!pattern) {
        throw new ToolError(
          '探す様式を渡してください（例: src/**/*.js、*.{ts,tsx}）',
          'tool.noGlob'
        );
      }
      const 起点 = await pathFor(call.path || '.');
      const re = pathGlobToRegExp(pattern);
      const 探してよい = respectGitIgnore ? notIgnored(root) : null;
      const 当たり = [];
      let 打ち切った = false;
      const walk = (dir) => {
        if (打ち切った) return;
        let items;
        try {
          items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const it of items) {
          if (打ち切った) return;
          if (SEARCH_SKIP.has(it.name)) continue;
          const full = path.join(dir, it.name);
          if (it.isDirectory()) {
            walk(full);
            continue;
          }
          if (!it.isFile()) continue;

          const rel = path.relative(起点, full);
          if (!re.test(rel)) continue;

          const fromRoot = path.relative(root, full);
          if (探してよい && !探してよい.has(fromRoot)) continue;
          if (whyBlocked(root, fromRoot, { protectSecrets })) continue;
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {

          }
          当たり.push({ rel, mtime });
          if (当たり.length >= GLOB_MAX + 1) 打ち切った = true;
        }
      };
      walk(起点);

      当たり.sort((a, b) => b.mtime - a.mtime);
      const 出す = 当たり.slice(0, GLOB_MAX);
      if (!出す.length) {

        return {
          ok: true,
          target: pattern,
          output:
            `当たりませんでした: ${pattern}\n` +
            '様式は道の全体に当てます。階層をまたぐなら `**/` を使ってください' +
            '（例: `**/*.test.js`。`*.test.js` は起点の直下だけ）。',
        };
      }
      const body =
        出す.map((x) => x.rel).join('\n') +
        (打ち切った ? `\n…（${GLOB_MAX} 件で切りました。様式を細くしてください）` : '');
      return { ok: true, target: `${出す.length} 件`, ...withFull(body, clipMiddle(body)) };
    },

    async codebase_search(call) {
      const query = String(call.query || '').trim();
      if (!query) throw new ToolError('探したい事を query に書いてください', 'tool.noQuery');
      if (!spawnAgents) {
        throw new ToolError(
          'この入口では意味で探せません（対話の画面から使ってください）。字で探すなら search が使えます',
          'tool.subNoCli'
        );
      }
      const 場所 = String(call.path || '').trim();
      const 頼み =
        `この作業場から「${query}」に関わる所を探してください。` +
        (場所 ? `探す先は ${場所} の下だけです。` : '') +
        '\n\n**字が一致する所だけを見ないでください。**言い方が違っても、' +
        'その事をやっている所を探します（名前・註釈・呼び出し先から辿る）。' +
        '\n\n返す形:' +
        '\n  1. <道>:<行> — なぜ関わるか（1 行）' +
        '\n  2. …' +
        '\n\n近い順に、多くて 10 件。**1 件も無ければ「無い」と書いてください**' +
        '（当てはまらない物で埋めない）。';
      const r = await spawnAgents([頼み]);
      if (r.why) throw new ToolError(r.why, 'tool.subFail', { why: r.why });
      const body = r.text || '';
      return { ok: true, target: query, ...withFull(body, clipMiddle(body)) };
    },

    async web_search(call) {
      const query = String(call.query || '').trim();
      if (!query) throw new ToolError('探す言葉を渡してください', 'tool.noQuery');
      let res;
      let html;
      try {
        res = await fetch(webfetch.searchUrl(query), {
          redirect: 'follow',
          headers: { 'user-agent': 'chatgpt-bridge', accept: 'text/html' },
          signal: AbortSignal.timeout(30000),
        });
        html = await res.text();
      } catch (e) {
        throw new ToolError(`探せませんでした: ${e.message}`, 'tool.searchFail', { why: e.message });
      }
      if (!res.ok) {
        throw new ToolError(`探せませんでした（${res.status}）`, 'tool.searchStatus', { status: res.status });
      }
      const hits = webfetch.searchResults(html);
      if (!hits.length) {

        return {
          ok: true,
          target: query,
          output:
            html.length > 2000
              ? `結果を取り出せませんでした（${html.length} 字は返って来ています）。` +
                '探す先の作りが変わった見込みです。**「見つからなかった」ではありません。**'
              : `当たりませんでした: ${query}`,
        };
      }

      if (seenUrls) for (const h of hits) seenUrls.add(h.url);
      const body = hits
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
        .join('\n');
      return {
        ok: true,
        target: query,
        ...withFull(body, clipMiddle(body)),
      };
    },

    async web_fetch(call) {
      const url = String(call.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new ToolError('http か https の場所を渡してください', 'tool.httpOnly');
      }
      const seen = seenUrls || new Set();
      if (!webfetch.hasProvenance(url, seen)) {

        const answer = await askOrPass({ kind: 'url', detail: url });
        if (answer !== 'once' && answer !== 'always') {
          throw new ToolError(
            `この場所は、この対話にまだ出てきていません: ${url}\n` +
              '利用者が出した場所と、そこから辿れた場所だけを取りに行けます。\n' +
              '要るなら、利用者に場所を書いてもらってください。',
            'tool.urlUnseen',
            { url }
          );
        }
      }
      let res;
      try {
        res = await fetch(url, {
          redirect: 'follow',
          headers: { 'user-agent': 'chatgpt-bridge', accept: 'text/html,text/plain,*/*' },
          signal: AbortSignal.timeout(30000),
        });
      } catch (e) {
        throw new ToolError(`取れませんでした: ${e.message}`, 'tool.fetchFail', { why: e.message });
      }
      if (!res.ok) throw new ToolError(`取れませんでした（${res.status}）: ${url}`, 'tool.fetchStatus', { status: res.status, url });
      const kind = String(res.headers.get('content-type') || '');
      const raw = await res.text();

      if (seenUrls) {
        for (const u of webfetch.collectUrls(raw)) seenUrls.add(u);
        seenUrls.add(String(res.url || url));
      }
      const isHtml = /html/i.test(kind) || /^\s*<(!doctype|html)/i.test(raw);
      const body = isHtml ? webfetch.htmlToText(raw) : raw;
      const title = isHtml ? webfetch.titleOf(raw) : '';

      const hostOf = (u) => {
        try {
          return new URL(u).host;
        } catch {
          return '';
        }
      };
      const 移った = res.url && webfetch.normalizeUrl(res.url) !== webfetch.normalizeUrl(url);
      const 別のサーバ = 移った && hostOf(res.url) && hostOf(res.url) !== hostOf(url);
      const moved = !移った
        ? ''
        : 別のサーバ
          ? `**別の場所へ飛ばされました。**頼まれたのは ${hostOf(url)} ですが、` +
            `着いたのは ${hostOf(res.url)} です:\n  ${res.url}\n` +
            '**下の中身は、頼まれた場所の物ではありません**（ログインの画面などです）。' +
            'これを答えの材料にしないでください。要るなら、上の場所を web_fetch で取り直すか、' +
            '取れないことを利用者に伝えてください。\n\n'
          : `（${res.url} へ移りました）\n`;
      return {
        ok: true,
        target: title || url,
        output: clip(moved + body),
      };
    },

    update_todos(call) {
      const r = normalizeTodos(call.todos);
      if (!r.ok) return { ok: false, output: r.why };
      if (onTodos) onTodos(r.todos);
      const n = todoCount(r.todos);
      return {
        ok: true,
        target: `${n.done}/${n.all}`,

        output: r.fixed
          ? `${n.all} 件を控えました（進行中が 2 件以上あったので、最初の 1 件だけ残しました）`
          : `${n.all} 件を控えました（終わり ${n.done}）`,
      };
    },

    read_rule(call) {
      const name = wantName(call.name, '決まり');

      if (name !== globalrules.RULES_BODY_NAME && !globalrules.listRules(null).includes(name)) {
        throw new ToolError(
          `そんな決まりはありません: ${name}（読める名前は最初の指示の §13 の表に出ています）`,
          'tool.noRule',
          { name }
        );
      }
      return {
        ok: true,
        target: name,
        output: clip(globalrules.readRule(null, name)),
      };
    },

    search_skills(call) {
      const hit = globalrules.searchSkills(null, call.query);
      if (!hit.length) {

        return {
          ok: true,
          target: String(call.query || ''),
          output: '当てはまるものがありませんでした。名前だけの一覧は最初の指示に出ています。',
        };
      }
      return {
        ok: true,
        target: String(call.query || ''),
        output: hit.map((x) => `- ${x.name}: ${x.description}`).join('\n'),
      };
    },

    read_skill(call) {
      const name = wantName(call.name, '手順書');

      if (!globalrules.skillNames(null, { forHuman: true }).includes(name)) {
        throw new ToolError(
          `そんな手順書はありません: ${name}（読める名前は最初の指示に出ています）`,
          'tool.noSkill',
          { name }
        );
      }
      return {
        ok: true,
        target: name,
        output: clip(globalrules.readSkill(null, name), 20000),
      };
    },

    async read_file(call) {
      guard(call.path);
      const file = await pathFor(call.path);
      let st;
      try {
        st = fs.statSync(file);
      } catch (e) {

        const route = routeFor(call.path);

        const near = nearbyPaths(root, call.path);

        throw new ToolError(
          [String(e.message), route || '', near].filter(Boolean).join('\n'),
          'tool.readMissing',
          { path: String(call.path || '') }
        );
      }
      if (st.isDirectory()) throw new ToolError('ディレクトリです。list_dir を使ってください', 'tool.isDir');

      const raw = fs.readFileSync(file, 'utf8');

      const text = /\.ipynb$/i.test(file) ? notebookAsText(raw) : raw;
      const lines = text.split('\n');

      for (const k of ['offset', 'limit']) {
        const v = call[k];
        if (v == null) continue;
        if (typeof v !== 'number' && !(typeof v === 'string' && /^\d+$/.test(v))) {
          throw new ToolError(
            `${k} は数で渡してください（${typeof v} が来ました）`,
            'tool.numType',
            { name: k, got: typeof v }
          );
        }
      }
      const from = Math.max(0, Number(call.offset) > 0 ? Number(call.offset) - 1 : 0);
      const asked = Number(call.limit) > 0 ? Number(call.limit) : null;
      const wantsPart = from > 0 || asked !== null;

      readAt.set(file, st.mtimeMs);

      if (!wantsPart && st.size <= READ_LIMIT_BYTES) {
        return { ok: true, target: call.path, output: text };
      }

      const out = [];
      let bytes = 0;
      let n = from;
      for (; n < lines.length; n += 1) {
        if (asked !== null && out.length >= asked) break;
        const size = Buffer.byteLength(lines[n]) + 1;
        if (out.length > 0 && bytes + size > READ_LIMIT_BYTES) break;
        out.push(lines[n]);
        bytes += size;
      }

      const rest = lines.length - n;
      const note =
        rest > 0
          ? `\n…（${from + 1}〜${n} 行目。あと ${rest} 行あります。` +
            `続きは {"path":"${call.path}","offset":${n + 1}} で取れます）`
          : from > 0
            ? `\n…（${from + 1}〜${n} 行目。ここが終わりです）`
            : '';

      const 頭 =
        rest > 0
          ? `（このファイルは ${lines.length} 行 在ります。ここは ${from + 1}〜${n} 行目だけです。` +
            `続きは {"path":"${call.path}","offset":${n + 1}} で取れます）\n\n`
          : '';
      return { ok: true, target: call.path, output: 頭 + out.join('\n') + note };
    },

    async notebook_edit(call) {
      const p = call.notebook_path || call.path;
      guard(p);
      const file = await pathFor(p);
      if (!/\.ipynb$/i.test(file)) throw new ToolError('.ipynb ではありません', 'tool.notIpynb');
      const mode = String(call.edit_mode || 'replace');
      if (!['replace', 'insert', 'delete'].includes(mode)) {
        throw new ToolError('edit_mode は replace / insert / delete のどれかです', 'tool.badEditMode');
      }
      let nb;
      try {
        nb = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        throw new ToolError(`ノートブックとして読めません: ${e.message}`, 'tool.badNotebook', { why: e.message });
      }
      if (!Array.isArray(nb.cells)) throw new ToolError('cells がありません', 'tool.noCells');

      const wanted = String(call.cell_id == null ? '' : call.cell_id);
      const byIndex = /^#(\d+)$/.exec(wanted);
      const at = byIndex
        ? Number(byIndex[1])
        : nb.cells.findIndex((c) => c && String(c.id || '') === wanted);

      if (mode === 'insert') {
        if (!call.cell_type) throw new ToolError('insert には cell_type が要ります（code か markdown）', 'tool.needCellType');
        const cell = {
          id: wanted && !byIndex ? wanted : `c${Date.now().toString(36)}`,
          cell_type: String(call.cell_type),
          metadata: {},
          source: String(call.new_source == null ? '' : call.new_source).split(/(?<=\n)/),
        };
        if (cell.cell_type === 'code') {
          cell.outputs = [];
          cell.execution_count = null;
        }

        const where = at >= 0 ? at + 1 : nb.cells.length;
        nb.cells.splice(where, 0, cell);
        fs.writeFileSync(file, JSON.stringify(nb, null, 1));
        return { output: `セルを入れました（${where + 1} 番目 / id ${cell.id}）` };
      }

      if (at < 0 || at >= nb.cells.length) {
        const ids = nb.cells.map((c, i) => (c && c.id ? c.id : `#${i}`)).join(' / ');
        throw new ToolError(`そのセルがありません: ${wanted}\n在るのは: ${ids}`, 'tool.noCell', { wanted, ids });
      }

      if (mode === 'delete') {
        const gone = nb.cells.splice(at, 1)[0];
        fs.writeFileSync(file, JSON.stringify(nb, null, 1));
        return { output: `セルを消しました（${(gone && gone.id) || at}）` };
      }

      const cell = nb.cells[at];
      cell.source = String(call.new_source == null ? '' : call.new_source).split(/(?<=\n)/);
      if (call.cell_type) cell.cell_type = String(call.cell_type);
      if (cell.cell_type === 'code') {
        cell.outputs = [];
        cell.execution_count = null;
      } else {
        delete cell.outputs;
        delete cell.execution_count;
      }
      fs.writeFileSync(file, JSON.stringify(nb, null, 1));
      return { output: `セルを書き換えました（${(cell && cell.id) || at}）` };
    },

    async write_file(call) {
      guard(call.path);
      if (typeof call.content !== 'string') {

        try {
          const f2 = await pathFor(call.path, { write: true });
          failedWrite.set(f2, fs.existsSync(f2) ? fs.readFileSync(f2, 'utf8').length : 0);
        } catch {

        }
        throw new ToolError('content が文字列ではありません', 'tool.contentNotString');
      }
      const file = await pathFor(call.path, { write: true });
      guardOverwrite(call.path, file);

      const 入れ物 = path.dirname(file);
      let 新しい入れ物 = '';
      if (!fs.existsSync(入れ物)) {
        try {
          const 根 = fs.realpathSync(root);
          const 相対 = path.relative(根, 入れ物);

          if (相対 && !相対.startsWith('..') && !path.isAbsolute(相対)) {
            const 頭 = 相対.split(path.sep)[0];
            if (!fs.existsSync(path.join(根, 頭))) 新しい入れ物 = 頭;
          }
        } catch {

        }
      }

      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existed = fs.existsSync(file);

      const 前に失敗 = failedWrite.get(file);
      if (前に失敗 !== undefined && call.content.length < 前に失敗) {
        failedWrite.delete(file);
        throw new ToolError(
          `前は ${前に失敗} 字、今は ${call.content.length} 字です。` +
            '書き損じた後は、**全部を書き直してください**（続きだけ書かないでください）。',
          'tool.shorterAfterFail',
          {}
        );
      }
      failedWrite.delete(file);

      const beforeText = existed ? fs.readFileSync(file, 'utf8') : '';
      const beforeSize = existed ? Buffer.byteLength(beforeText) : null;
      try {
        fs.writeFileSync(file, call.content, 'utf8');
      } catch (e) {

        failedWrite.set(file, beforeText.length);
        throw e;
      }
      const st2 = fs.statSync(file);
      const after = st2.size;
      readAt.set(file, st2.mtimeMs);
      return {
        ok: true,
        target: call.path,
        changed: { path: call.path, before: beforeText, existed },
        output:
          (beforeSize === null
            ? `新しく作りました（${after} バイト）`
            : `書き換えました（${beforeSize} → ${after} バイト）`) +
          (新しい入れ物
            ? `\n**開いているフォルダの直下に \`${新しい入れ物}/\` を新しく作りました**（${file}）。` +
              '\n道が思っていた所と違うなら、絶対の道で言い直してください。'
            : ''),
      };
    },

    async edit_file(call) {
      guard(call.path);
      if (typeof call.new_text !== 'string') throw new ToolError('new_text が文字列ではありません', 'tool.newTextNotString');
      const file = await pathFor(call.path, { write: true });
      const exists = fs.existsSync(file);

      guardOverwrite(call.path, file);

      if (!exists) {
        if (call.old_text) {
          throw new ToolError('ファイルがありません。作る場合は old_text を付けないでください', 'tool.noFileForEdit');
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, call.new_text, 'utf8');
        readAt.set(file, fs.statSync(file).mtimeMs);
        return {
          ok: true,
          target: call.path,
          changed: { path: call.path, before: '', existed: false },
          output: `新しく作りました（${call.new_text.length} 文字）`,
        };
      }

      let before = fs.readFileSync(file, 'utf8');

      if (call.append === true || call.append === 'true') {
        if (call.old_text || call.insert_line != null) {
          throw new ToolError('append の時は old_text も insert_line も要りません', 'tool.appendExtra');
        }

        const stripped = TAIL_CLOSE.test(before) ? before.replace(TAIL_CLOSE, '') : before;
        const joined = stripped + call.new_text;
        fs.writeFileSync(file, joined, 'utf8');
        readAt.set(file, fs.statSync(file).mtimeMs);
        return {
          ok: true,
          target: call.path,
          changed: { path: call.path, before, existed: true },
          output: `末尾に足しました（${call.new_text.length} 文字 → 全体 ${joined.length} 文字）`,
        };
      }

      if (call.insert_line != null) {
        const n = Number(call.insert_line);
        const lines = before.split('\n');
        if (!Number.isInteger(n) || n < 0 || n > lines.length) {
          throw new ToolError(`insert_line が範囲の外です（1〜${lines.length} で指定）`, 'tool.lineRange', { max: lines.length });
        }
        lines.splice(n, 0, call.new_text);
        fs.writeFileSync(file, lines.join('\n'), 'utf8');
        readAt.set(file, fs.statSync(file).mtimeMs);
        return {
          ok: true,
          target: call.path,
          changed: { path: call.path, before, existed: true },
          output: `${n} 行目に挿しました`,
        };
      }

      if (typeof call.old_text !== 'string' || call.old_text === '') {
        throw new ToolError('old_text が要ります（挿す場合は insert_line を指定）', 'tool.needOldText');
      }

      let count = 0;
      const 当たり = [];
      let idx = before.indexOf(call.old_text);
      while (idx !== -1) {
        count += 1;
        当たり.push(idx);
        idx = before.indexOf(call.old_text, idx + call.old_text.length);
      }
      let oldText = call.old_text;
      if (count === 0) {

        const soft = softenForMatch(before);
        const softWant = softenForMatch(call.old_text);
        let softCount = 0;
        let j = soft.indexOf(softWant);
        while (j !== -1) {
          softCount += 1;
          j = soft.indexOf(softWant, j + softWant.length);
        }
        if (softCount === 1 && softWant) {

          before = soft;
          oldText = softWant;
          count = 1;
        } else {
          const near = nearbyOf(before, call.old_text);
          throw new ToolError(
            'old_text が見つかりません。空白や改行まで含めて、read_file で読んだとおりに書いてください。' +
              (near ? `\nいま、その辺りはこうなっています:\n${near}` : ''),
            'tool.oldTextMissing',
            {}
          );
        }
      }

      const all = call.replace_all === true;
      if (count > 1 && !all) {

        const どこ = 当たり
          .map((at) => `${before.slice(0, at).split('\n').length} 行目`)
          .join('・');
        throw new ToolError(
          `old_text が ${count} 箇所に当たります（${どこ}）。` +
            `前後を足して 1 箇所だけに当たるようにするか、` +
            `全部を替えてよいなら replace_all: true を足してください`,
          'tool.oldTextMany',
          { count, where: どこ }
        );
      }

      const after = all ? before.split(oldText).join(call.new_text) : (() => {
        const at = before.indexOf(oldText);
        return before.slice(0, at) + call.new_text + before.slice(at + oldText.length);
      })();

      if (after === before) {
        throw new ToolError(
          '何も変わりません。old_text と new_text が同じ字です。' +
            '直したい形を new_text に書いてください。',
          'tool.editNoop',
          {}
        );
      }
      fs.writeFileSync(file, after, 'utf8');
      readAt.set(file, fs.statSync(file).mtimeMs);
      const lineNo = before.slice(0, before.indexOf(oldText)).split('\n').length;
      return {
        ok: true,
        target: call.path,
        changed: { path: call.path, before, existed: true },
        output: all
          ? `${count} 箇所を置き換えました（${before.length} → ${after.length} 文字）`
          : `${lineNo} 行目あたりを置き換えました（${before.length} → ${after.length} 文字）`,
      };
    },

    async search(call) {

      if (call.pattern != null && typeof call.pattern !== 'string') {
        throw new ToolError(
          `pattern は文字列で渡してください（${typeof call.pattern} が来ました）`,
          'tool.patternType',
          { got: typeof call.pattern }
        );
      }
      const pattern = String(call.pattern || '');

      if (!pattern) {
        throw new ToolError(
          'pattern が空です。探す言葉を入れてください。\n' +
            '例: {"name":"search","input":{"pattern":"register_post_type","path":"."}}\n' +
            'もう探す物が無いなら、done を呼んで終えてください。' +
            '空のまま呼び直しても、同じ失敗が返るだけです。',
          'tool.emptyPattern',
          {}
        );
      }

      let re;
      let literalNote = '';
      try {
        re = new RegExp(pattern, 'g');
      } catch (e) {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        literalNote =
          `\n\n（\`${pattern}\` は正規表現として編めなかったので` +
          `（${e.message.replace(/^Invalid regular expression: [^:]*: /, '')}）、` +
          '**そのままの字**として探しました。' +
          '正規表現で探したい時は、丸括弧などを `\\(` のように逃がしてください）';
      }

      const cap = Math.max(1, Math.min(SEARCH_MAX_HITS, Number(call.max_results) || SEARCH_MAX_HITS));

      const 返し方 = ['content', 'files_with_matches', 'count'].includes(String(call.output_mode || ''))
        ? String(call.output_mode)
        : 'content';

      const 数えるだけ = 返し方 === 'count';
      const 全部歩く = 返し方 !== 'content';

      let 全件 = 0;
      const 当たった檔 = new Set();
      const start = await pathFor(call.path || '.');

      const filePat = typeof call.file_pattern === 'string' ? call.file_pattern.trim() : '';
      const fileRe = filePat ? globToRegExp(filePat) : null;
      const hits = [];
      let scanned = 0;

      const 探してよい = respectGitIgnore ? notIgnored(root) : null;
      const walk = (dir) => {
        if (hits.length >= cap) return;
        let items;
        try {
          items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const it of items) {
          if (hits.length >= cap) return;
          if (SEARCH_SKIP.has(it.name)) continue;
          const full = path.join(dir, it.name);
          if (it.isDirectory()) {
            walk(full);
            continue;
          }
          if (!it.isFile()) continue;
          let st;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.size > SEARCH_MAX_FILE_BYTES) continue;

          if (fileRe) {
            const relForPat = path.relative(root, full).split(path.sep).join('/');

            if (!fileRe.test(it.name) && !fileRe.test(relForPat)) continue;
          }
          scanned += 1;
          let body;
          try {
            body = fs.readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          const rel = path.relative(root, full);

          if (探してよい && !探してよい.has(rel)) continue;
          if (whyBlocked(root, rel, { protectSecrets })) continue;
          body.split('\n').forEach((line, i) => {
            if (!全部歩く && hits.length >= cap) return;
            re.lastIndex = 0;
            if (!re.test(line)) return;
            全件 += 1;
            当たった檔.add(rel);
            if (全部歩く) return;
            if (hits.length < cap) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
      };

      const st = fs.statSync(start);
      if (st.isDirectory()) walk(start);
      else walk(path.dirname(start));

      if (数えるだけ) {
        return {
          ok: true,
          target: `${全件} 件`,
          output:
            `${全件} 件（${当たった檔.size} ファイル / ${scanned} ファイルを見ました）\n` +
            '**上限は掛けていません。これが全部です。**' +
            literalNote,
        };
      }
      if (返し方 === 'files_with_matches') {
        const 並び = [...当たった檔].slice(0, cap);
        return {
          ok: true,
          target: `${当たった檔.size} ファイル`,
          output:
            `${当たった檔.size} ファイル（${scanned} ファイルを見ました）\n` +
            並び.join('\n') +
            (当たった檔.size > 並び.length ? `\n…（${cap} 件で切りました）` : '') +
            literalNote,
        };
      }
      const 切った = hits.length >= cap;
      const head =
        `${hits.length} 件${切った ? '以上' : ''}（${scanned} ファイルを見ました` +
        (切った ? '。**上限で打ち切ったので、これが全部ではありません**' : '') +
        '）';
      return {
        ok: true,
        target: pattern,
        output:
          (hits.length ? `${head}\n${hits.join('\n')}` : `${head}\n（見つかりません）`) + literalNote,
      };
    },

    async run_command(call) {
      const cmd = String(call.command || '');

      const meta = shellMetaOutsideQuotes(cmd) || leadingAssignment(cmd);

      const denied = denyReason(cmd, denylist);

      const guardedPath = guardedPathInCommand(cmd);

      const 許可 = 生きている許可();

      if (denied || meta || guardedPath || !isAllowed(cmd, 許可)) {

        const prog = expandHome(splitArgs(cmd)[0] || cmd);

        const rememberable = !denied && !meta && !guardedPath && canRememberAlways(prog);
        const answer = await askOrPass({
          kind: 'command',
          detail: denied
            ? `${cmd}\n（${denied.why}）`
            : guardedPath
              ? `${cmd}\n（触らせない場所を名指ししています: ${guardedPath}）`
              : cmd,
          always: rememberable ? prog : null,
        });
        if (answer === 'always' && rememberable) {
          allowlist = allowlist.concat([prog]);

          if (onAllowAlways) {
            try {
              await onAllowAlways({ kind: 'command', detail: prog });
            } catch {

            }
          }

        } else if (denied && !(denied.一度だけ許せる && answer === 'once' && !guardedPath && !meta)) {

          const 断りの理由 = !askPermission
            ? ''
            : answer === 'no'
              ? '利用者が許しませんでした。\n'
              : '利用者は許しましたが、この引数は否決の表に在るので走らせません。\n';
          throw new ToolError(
            `この引数は自動では通しません: ${cmd}\n` +
              `${denied.why}\n` +
              断りの理由 +
              '引数を外して書き直してください。',
            denied.key,
            { cmd }
          );
        } else if (answer !== 'once' && guardedPath) {
          throw new ToolError(
            `触らせない場所を名指ししています: ${guardedPath}\n` +
              (askPermission ? '利用者が許しませんでした。\n' : '') +
              'その下は hook と設定なので、書ければ次の命令実行になります。\n' +
              '中身を読みたいだけなら read_rule / read_skill が使えます。',
            'tool.guardedPathCmd',
            { cmd, guardedPath }
          );
        } else if (answer !== 'once') {
          throw new ToolError(
            `許可リストにありません: ${cmd}\n` +
              (askPermission ? '利用者が許しませんでした。\n' : '') +
              '走らせてよいのは次だけです:\n' +
              許可.map((a) => `  - ${a}`).join('\n'),
            askPermission ? 'tool.notAllowedNo' : 'tool.notAllowed',
            { cmd, list: 許可.map((a) => `  - ${a}`).join('\n') }
          );
        }
      }

      const loginShell = process.env.SHELL || '/bin/zsh';
      const argv = meta ? [loginShell, '-lc', cmd] : splitArgs(cmd).map(expandHome);
      if (argv.length === 0) throw new ToolError('命令が空です', 'tool.emptyCommand');

      if (onCommandOutput) onCommandOutput({ id: call.id || '', command: cmd, chunk: '', started: true });

      const 秒 = Number(call.timeout);

      const 掛けない =
        !Number.isFinite(秒) &&
        (timeoutAllowlist || []).some((p) => {
          const 頭 = String(p || '').trim();
          return 頭 !== '' && String(call.command || '').startsWith(頭);
        });
      const 待つ = 掛けない
        ? Infinity
        : Number.isFinite(秒) && 秒 > 0
          ? Math.min(秒 * 1000, COMMAND_TIMEOUT_MAX_MS)
          : defaultTimeoutMs;
      const cmdId = 'cmd-' + ++番;

      const r = await new Promise((res) => {
        const { spawn } = require('child_process');
        const child = spawn(argv[0], argv.slice(1), {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],

          detached: true,

          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            NODE_DISABLE_COLORS: process.env.NODE_DISABLE_COLORS || '',
            RUBYOPT: [process.env.RUBYOPT, '-W0'].filter(Boolean).join(' '),
            STDBUF: '0',
          },
        });

        const rec = { id: cmdId, command: cmd, child, out: '', ended: false, status: null, 満杯: false };
        background.set(cmdId, rec);

        let done = false;

        const timer = Number.isFinite(待つ)
          ? setTimeout(() => {
              if (done) return;
              done = true;

              rec.背景 = true;
              res({ status: null, out: rec.out, 背景: true, id: cmdId, 待った: 待つ });
            }, 待つ)
          : null;
        const take = (buf) => {
          const piece = buf.toString();

          if (rec.out.length < COMMAND_KEEP) {
            rec.out += piece;
            if (rec.out.length >= COMMAND_KEEP && !rec.満杯) {
              rec.満杯 = true;
              rec.out += `\n…（ここから先は溜めるのをやめました。${COMMAND_KEEP} 字で満杯）`;
            }
          }

          if (onCommandOutput) onCommandOutput({ id: call.id || '', command: cmd, chunk: piece });
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        child.on('error', (e) => {
          rec.ended = true;
          rec.why = e.message;
          if (done) return;
          done = true;
          clearTimeout(timer);
          res({ status: null, out: rec.out, why: e.message, err: e });
        });
        child.on('close', (code) => {
          rec.ended = true;
          rec.status = code;
          if (done) return;
          done = true;
          clearTimeout(timer);

          background.delete(cmdId);
          res({ status: code, out: rec.out });
        });
      });

      if (r.背景) {
        const body =
          (r.out || '（まだ出力はありません）') +
          `\n\n---\n${Math.round(r.待った / 1000)} 秒を過ぎたので、この命令は**背景で走り続けています**。` +
          `\n続きは read_command_output {"command_id":"${r.id}"} で読めます。` +
          `\n止めるなら read_command_output {"command_id":"${r.id}","stop":true}。`;
        return { ok: true, target: cmd, ...withFull(body, clipMiddle(body, OUTPUT_LIMIT_CHARS, HOW_NARROW_CMD)) };
      }

      if (r.status === 0) {
        const body = r.out || '（出力なし）';
        return { ok: true, target: cmd, ...withFull(body, clipMiddle(body, OUTPUT_LIMIT_CHARS, HOW_NARROW_CMD)) };
      }

      let body = r.out || r.why || '';

      const 段 = String(cmd).split('|');
      const 最後の段 = 段[段.length - 1].trim();
      if (r.status === 1 && 段.length > 1 && /^grep(\s|$)/.test(最後の段)) {
        body +=
          '\ngrep は中らなくても 1 を返します。**手前の命令は通っているかもしれません。**' +
          '確かめるには `|` から後ろを外して、そのまま走らせてください。';
      }
      const full =
        `終了コード ${r.status === null ? '（なし）' : r.status}\n${body}` +
        nearbyFiles(r.err || { code: r.err && r.err.code }, argv[0]);

      return { ok: false, ran: true, target: cmd, ...withFull(full, clipMiddle(full, OUTPUT_LIMIT_CHARS, HOW_NARROW_CMD)) };
    },

    read_command_output(call) {
      const id = String(call.command_id || '').trim();
      if (!id) throw new ToolError('command_id を渡してください', 'tool.noCommandId');
      const rec = background.get(id);
      if (!rec) {

        const 居る = [...background.keys()];
        throw new ToolError(
          `そんな命令はありません: ${id}\n` +
            (居る.length ? `いま残って在るのは: ${居る.join(' / ')}` : '背景に回った命令は 1 本もありません。'),
          'tool.noSuchCommand',
          { id }
        );
      }

      if (call.stop) {
        if (rec.ended) return { ok: true, target: id, output: 'その命令はもう終わっています。' };
        止める(rec, 'SIGTERM');

        setTimeout(() => 止める(rec, 'SIGKILL'), COMMAND_KILL_GRACE_MS).unref?.();
        rec.ended = true;
        return { ok: true, target: id, output: `止めました（${rec.command}）。` };
      }

      let text = rec.out || '';
      if (call.search) {
        let re;
        try {
          re = new RegExp(String(call.search), 'i');
        } catch {
          re = null;
        }
        const 行 = text.split('\n').filter((l) => (re ? re.test(l) : l.includes(String(call.search))));
        text = 行.length ? 行.join('\n') : `（${call.search} に当たる行はありません）`;
      }
      const from = Math.max(0, Number(call.offset) || 0);
      const 幅 = Math.max(1, Number(call.limit) || 40000);
      const 切れる = text.length > from + 幅;
      const body =
        (from >= text.length && text.length ? '（そこから先はありません）' : text.slice(from, from + 幅)) +
        (切れる ? `\n…（続きは offset ${from + 幅} から）` : '') +
        `\n\n---\n${rec.ended ? `終わっています（終了コード ${rec.status === null ? '（なし）' : rec.status}）` : '**まだ走っています**'}`;
      return { ok: true, target: id, ...withFull(body, clipMiddle(body)) };
    },
  };

  const 站の関門 = async (url, 何を) => {
    const 站 = browser.originOf(url);
    if (!站) throw new ToolError(`場所が読めません: ${url}`, 'tool.badUrl', { url });

    const seen = seenUrls || new Set();
    if (!webfetch.hasProvenance(url, seen)) {
      const 答え = await askOrPass({ kind: 'url', detail: url });
      if (答え !== 'once' && 答え !== 'always') {
        throw new ToolError(
          `この場所は、この対話にまだ出てきていません: ${url}\n` +
            '利用者が出した場所と、そこから辿れた場所だけを開けます。\n' +
            '探すなら web_search が使えます。',
          'tool.urlUnseen',
          { url }
        );
      }
      if (seenUrls) seenUrls.add(url);
    }

    if (allowedSite.has(站) && !取り消された('browser', 站)) return;
    const answer = await askOrPass({
      kind: 'browser',
      detail: 何を ? `${何を}\n${url}` : url,
      always: 站,
    });
    if (answer === 'always') {
      allowedSite.add(站);
      if (onAllowAlways) {
        try {
          await onAllowAlways({ kind: 'browser', detail: 站 });
        } catch {

        }
      }
      return;
    }
    if (answer !== 'once') {
      throw new ToolError(
        `browser は自動では通しません: ${何を || url}\n` +
          (askPermission ? '利用者が許しませんでした。\n' : '') +
          `站 ${站} を「いつも許す」にするか、別の道でやってください。`,
        askPermission ? 'tool.browserNo' : 'tool.browserNotAllowed',
        { url, site: 站 }
      );
    }
  };

  const タブを決める = async (指定) => {
    const id = String(指定 || '').trim();
    if (id) {
      if (!開いたタブ.has(id)) {
        throw new ToolError(
          `こちらが開いたタブではありません: ${id}\n` +
            '触れるのは browser_open で開いた物だけです。\n' +
            'いま開いているのは:\n' +
            [...開いたタブ.keys()].map((x) => `  ${x}  ${開いたタブ.get(x)}`).join('\n'),
          'tool.browserNotOurs',
          { tab: id }
        );
      }
      いま見ているタブ = id;
      return id;
    }
    if (!開いたタブ.size) {
      throw new ToolError('まだ頁を開いていません（browser_open）', 'tool.browserNoTab');
    }

    if (!いま見ているタブ || !開いたタブ.has(いま見ているタブ)) {
      いま見ているタブ = [...開いたタブ.keys()].pop();
    }
    return いま見ているタブ;
  };

  const mcpGate = async (server, 何を, 中身) => {
    if (allowedMcp.has(server) && !取り消された('mcp', server)) return;
    const answer = await askOrPass({
      kind: 'mcp',

      detail: 中身 ? `${何を}\n${中身}` : String(何を),
      always: server,
    });
    if (answer === 'always') {
      allowedMcp.add(server);

      if (onAllowAlways) {
        try {
          await onAllowAlways({ kind: 'mcp', detail: server });
        } catch {

        }
      }
      return;
    }
    if (answer !== 'once') {
      throw new ToolError(
        `MCP は自動では通しません: ${何を}\n` +
          (askPermission ? '利用者が許しませんでした。\n' : '') +
          `サーバ ${server} を「いつも許す」にするか、別の道でやってください。`,
        askPermission ? 'tool.mcpNo' : 'tool.mcpNotAllowed',
        { name: String(何を), server }
      );
    }
  };

  if (mcp && mcp.resources && mcp.resources.length) {
    all.access_mcp_resource = async (call) => {
      const uri = String(call.uri || '').trim();
      if (!uri) throw new ToolError('uri を渡してください', 'tool.noResourceUri');

      const 当たり = mcp.resources.filter(
        (r) => r.uri === uri && (!call.server_name || r.server === call.server_name)
      );
      if (!当たり.length) {

        throw new ToolError(
          `そんな資源はありません: ${uri}\n` +
            '読めるのは:\n' +
            mcp.resources.map((r) => `  ${r.server}  ${r.uri}${r.name ? `  ${r.name}` : ''}`).join('\n'),
          'tool.noSuchResource',
          { uri }
        );
      }

      if (当たり.length > 1) {
        throw new ToolError(
          `同じ場所を ${当たり.length} 台 が配っています: ${uri}\n` +
            'server_name でどれかを指してください:\n' +
            当たり.map((x) => `  ${x.server}`).join('\n'),
          'tool.ambiguousResource',
          { uri, n: String(当たり.length) }
        );
      }
      const r = 当たり[0];

      await mcpGate(r.server, `access_mcp_resource ${r.server}`, r.uri);
      const body = await mcpMod.readResource(mcp.clients, r.server, r.uri);
      return { ok: true, target: `${r.server} ${r.uri}`, ...withFull(body, clipMiddle(body)) };
    };
  }

  if (mcp && mcp.tools && mcp.tools.length) {
    all.search_tools = (call) => {
      const hit = mcpMod.searchTools(mcp.tools, call.query);
      if (!hit.length) {

        return {
          ok: true,
          target: String(call.query || ''),
          output: '当てはまるものがありませんでした。名前だけの一覧は最初の指示に出ています。',
        };
      }
      return {
        ok: true,
        target: String(call.query || ''),
        output: hit
          .map((t) => `${t.name}: ${t.description}\n  引数: ${JSON.stringify(t.inputSchema || {})}`)
          .join('\n\n'),
      };
    };
    for (const t of mcp.tools) {

      if (!mcpMod.isMcpName(t.name)) continue;
      all[t.name] = async (call) => {

        const { bridge_tool: _b, id: _i, ...args } = call;

        await mcpGate(t.server, t.name, clipMiddle(JSON.stringify(args || {}), 400));

        const r = await mcpMod.callTool(mcp.clients, mcp.tools, t, args);
        return { ok: !r.isError, target: t.name, output: r.text };
      };
    }
  }

  if (modes && modes.length) {

    let いまの役 = String(startMode || '');
    all.switch_mode = async (call) => {
      const slug = String(call.mode_slug || '').trim();
      const m = modes.find((x) => x.slug === slug);
      if (!m) {

        throw new ToolError(
          `そんな役はありません: ${slug || '（空）'}\n` +
            '選べるのは:\n' +
            modes.map((x) => `  ${x.slug}  ${x.name || ''}`).join('\n'),
          'tool.noSuchMode',
          { slug }
        );
      }

      if (いまの役 && いまの役 === slug) {
        return {
          ok: true,
          target: slug,
          output: `すでに ${m.name || slug} の役です（替えていません）`,
        };
      }
      const 答え = await askOrPass({
        kind: 'mode',
        detail: `${m.name || m.slug}${call.reason ? `\n（${call.reason}）` : ''}`,
      });
      if (答え !== 'once' && 答え !== 'always') {
        throw new ToolError(`役を替えるのは断られました: ${m.name || slug}`, 'tool.modeRefused', { slug });
      }
      掛ける(m.disabledTools);
      いまの役 = slug;
      if (onModeSwitch) onModeSwitch(m);
      const 使える = Object.keys(all).sort().join(' / ');
      return {
        ok: true,
        target: m.name || slug,
        output:
          `${m.name || slug} へ移りました。ここから先は、この役で進めてください。\n\n` +
          (m.instruction ? `${m.instruction}\n\n` : '') +
          `いま使えるツール: ${使える}`,
      };
    };
  }

  const 元 = { ...all };
  const 掛ける = (list) => {
    for (const k of Object.keys(all)) delete all[k];
    for (const [k, v] of Object.entries(元)) all[k] = v;
    for (const name of list || []) {
      if (ALWAYS_ON.includes(name)) continue;
      delete all[name];
    }
  };

  const 始めの役 = startMode ? (modes || []).find((m) => m.slug === startMode) : null;
  掛ける(始めの役 ? 始めの役.disabledTools : disabled);

  Object.defineProperty(all, 'stopBackground', {
    enumerable: false,
    value: ({ closeTabs = true } = {}) => {
      let n = 0;
      for (const rec of background.values()) {
        if (rec.ended) continue;
        止める(rec, 'SIGTERM');
        setTimeout(() => 止める(rec, 'SIGKILL'), COMMAND_KILL_GRACE_MS).unref?.();
        rec.ended = true;
        n += 1;
      }
      background.clear();

      if (closeTabs) {
        for (const id of 開いたタブ.keys()) {
          browser.close(id).catch(() => {});
        }
        開いたタブ.clear();
      }
      if (typeof onOpenTabs === 'function') onOpenTabs([...開いたタブ.entries()]);
      return n;
    },
  });

  const 誤りを添える = (組) => {
    if (!afterTouch) return 組;
    for (const name of ['write_file', 'edit_file', 'notebook_edit']) {
      const 元 = 組[name];
      if (typeof 元 !== 'function') continue;
      組[name] = async (call) => {
        const r = await 元(call);
        if (!r || !r.ok) return r;
        let 増えた = '';
        try {
          増えた = await afterTouch(String((call && call.path) || ''));
        } catch {

        }
        if (増えた) r.output = String(r.output || '') + '\n\n' + 増えた;
        return r;
      };
    }
    return 組;
  };

  if (!readOnly) return 誤りを添える(all);

  const kept = {};
  for (const [name, fn] of Object.entries(all)) {
    if (READS.includes(name)) kept[name] = fn;
  }

  if (planMode) {
    kept.exit_plan_mode = async (call) => {
      const plan = String(call.plan || '').trim();
      if (!plan) {
        throw new ToolError(
          '何をするつもりかを plan に書いてください（利用者はこれを読んで決めます）',
          'tool.noPlan'
        );
      }
      const 答え = await askOrPass({ kind: 'plan', detail: plan });
      if (答え !== 'once' && 答え !== 'always') {
        throw new ToolError(
          '段取りは通りませんでした。読むだけのまま、直しを続けてください。',
          'tool.planRefused'
        );
      }

      for (const [name, fn] of Object.entries(all)) {
        if (!READS.includes(name)) kept[name] = fn;
      }
      delete kept.exit_plan_mode;
      if (onExitPlan) onExitPlan({ plan });

      return {
        ok: true,
        target: '段取りが通りました',
        output:
          '段取りが通りました。ここから先は書けます。\n' +
          '**まず update_todos で、やることの一覧を出してください**（1〜2 手で終わる時は要りません）。\n' +
          `いま使えるツール: ${Object.keys(kept).sort().join(' / ')}`,
      };
    };
  }

  return 誤りを添える(kept);
}

module.exports = {
  ALWAYS_ON,
  CONFIG_OPEN,
  routeFor,
  denyReason,
  mergeDenylist,
  DEFAULT_DENYLIST,
  GIT_IO,
  clipMiddle,
  withFull,
  whyBlocked,
  doorFor,
  guardedPathInCommand,
  clipMiddle,
  shellMetaOutsideQuotes,
  isDangerousPath,
  DANGEROUS_DIRS,
  DANGEROUS_FILES,
  SECRET_PATTERNS,
  SEARCH_SKIP,
  makeTools,
  ensureRestorePoint,
  resolveInside,
  isAllowed,
  splitArgs,
  expandHome,
  canRememberAlways,
  SHELL_META,
  EXPANDS_IN_DQUOTE,
  isGitRepo,
  headSha,
  DEFAULT_ALLOWLIST,
};

const ALIASES = {
  search: {
    query: 'pattern',
    regex: 'pattern',
    include: 'file_pattern',
    glob: 'file_pattern',

    head_limit: 'max_results',
  },
  edit_file: { old_string: 'old_text', new_string: 'new_text' },
  write_file: { contents: 'content', text: 'content' },
  read_file: { file_path: 'path', filename: 'path' },

  update_todos: { plan: 'todos', steps: 'todos' },
  run_command: { cmd: 'command' },
};

const TODO_ITEM_ALIASES = { step: 'content', task: 'content', text: 'content' };

const KNOWN = {
  search: ['pattern', 'path', 'file_pattern', 'max_results'],
  edit_file: ['path', 'old_text', 'new_text', 'append', 'insert_line'],
  write_file: ['path', 'content'],
  read_file: ['path', 'offset', 'limit'],
};

function normalizeCall(name, call) {
  const alias = ALIASES[name];
  const known = KNOWN[name];
  if (!alias && !known) return { call, notes: [] };
  const out = { ...call };
  const notes = [];
  for (const [from, to] of Object.entries(alias || {})) {
    if (out[from] === undefined) continue;

    if (out[to] === undefined) out[to] = out[from];
    delete out[from];
    notes.push(`\`${from}\` は \`${to}\` として読みました（この道具の名前は \`${to}\` です）`);
  }

  const ENVELOPE = ['id', 'name', 'tool', 'bridge_tool', 'type', 'input'];
  for (const k of Object.keys(out)) {
    if (ENVELOPE.includes(k)) continue;
    if (!known || known.includes(k)) continue;
    notes.push(`\`${k}\` は、この道具にはありません。読み飛ばしました（使えるのは ${known.join(' / ')}）`);
  }
  return { call: out, notes };
}

module.exports.normalizeCall = normalizeCall;
module.exports.ALIASES = ALIASES;
module.exports.READS = READS;
