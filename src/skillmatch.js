const HINTS = [
  {

    skill: 'frontend-design',

    when: /(?<!\.)html|画面[^。\n]{0,10}(?:作|つく|直|整|デザイン|見た目|設計|レイアウト)|(?:作|つく|直|整|デザイン|見た目|設計)[^。\n]{0,10}画面|(?<![A-Za-z])ui(?![A-Za-z])|見た目|デザイン|design|介面|網頁|網站|頁面|レイアウト|排版|美觀|好看/i,
    why: '人が見る画面を作るため',
  },
  {

    skill: 'research',

    when: /調查|調査|しらべ|調べ|research|出典|來源|来源|source|論文|学術|學術|benchmark|事例/i,
    why: '出典を押さえて調べるため',
  },
  {
    skill: 'webapp-testing',
    when: /画面.*試|e2e|playwright|browser.*test|瀏覽器.*測/i,
    why: '画面を実際に動かして確かめるため',
  },
  {
    skill: 'document-coauthoring',
    when: /仕様書|提案書|決定.*文書|(?<![A-Za-z])specs?(?![A-Za-z])|proposal/i,
    why: '文書を組み立てるため',
  },
];

function isNegatedHintMatch(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const all = [...text.matchAll(new RegExp(pattern.source, flags))];
  if (!all.length) return false;
  return all.every((m) => /^(?:ずに|ないで|なくて|ません)/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 8)));
}

function matchSkills(task, index, limit = 3) {
  const t = String(task == null ? '' : task);
  const idx = String(index == null ? '' : index);
  if (!t.trim() || !idx.trim()) return [];
  const out = [];

  const inIndex = (name) => new RegExp('^\\s*-\\s*' + name + '\\s*(?::|$)', 'm').test(idx);

  for (const line of idx.split('\n')) {
    if (out.length >= limit) break;

    const m = /^\s*-\s*([A-Za-z0-9_-]+)\s*(?::|$)/.exec(line);
    if (!m) continue;
    const name = m[1];

    if (name.length < 3) continue;
    const at = new RegExp('(^|[^A-Za-z0-9_-])' + name.replace(/[-]/g, '\\-') + '($|[^A-Za-z0-9_-])', 'i');
    if (!at.test(t)) continue;

    if (/^[a-z]+$/.test(name) && !pointsToSkill(t, name)) continue;
    if (out.some((x) => x.skill === name)) continue;
    out.push({ skill: name, why: '依頼にこの名前が出てくるため' });
  }

  const prose = t.replace(/`[^`\n]*`/g, ' ');
  for (const h of HINTS) {
    if (out.length >= limit) break;
    if (!h.when.test(prose)) continue;
    if (isNegatedHintMatch(prose, h.when)) continue;

    if (!inIndex(h.skill)) continue;
    if (out.some((x) => x.skill === h.skill)) continue;
    out.push({ skill: h.skill, why: h.why });
  }
  return out;
}

const PROPER_NAMES = new Set([

  'backlog',
]);
function pointsToSkill(task, name) {
  const esc = name.replace(/[-]/g, '\\-');
  if (new RegExp('[./]' + esc + '\\.[a-z]{2,}', 'i').test(task)) return true;
  const proper = name.charAt(0).toUpperCase() + name.slice(1);
  if (PROPER_NAMES.has(name) && new RegExp('(^|[^A-Za-z0-9_-])' + proper + '($|[^A-Za-z0-9_-])').test(task)) return true;
  const marker = new RegExp('(?:^|[^A-Za-z])skills?(?:$|[^A-Za-z])|手順書|read_skill|/' + esc + '(?:$|[^A-Za-z0-9_-])|`' + esc + '`', 'i');
  return task
    .split(/[。\n]|\.\s/)
    .some((s) => new RegExp('(^|[^A-Za-z0-9_-])' + esc + '($|[^A-Za-z0-9_-])', 'i').test(s) && marker.test(s));
}

function skillDirective(hits) {
  if (!hits || hits.length === 0) return [];
  return [
    '--- この依頼に当てはまる手順書 ---',
    '',
    '**始める前に、次を read_skill で読んでください。**',
    ...hits.map((h) => `  - ${h.skill}（${h.why}）`),
    '',
    'この人が決めた作り方が書いてあります。読まずに始めると外します。',
    '読んでから、その手順に従ってください。',
    '',
  ];
}

const NEEDS_SKILL = [
  {
    skill: 'frontend-design',

    path: /\.(html?|css|scss|jsx|tsx|vue|svelte)$/i,
    why: '人が見る画面を作る前に、この人の決めた作り方を読んでください',
  },
];

function needsSkillFirst(rel, named, read) {
  const p = String(rel || '');
  for (const n of NEEDS_SKILL) {
    if (!n.path.test(p)) continue;
    if (!named || !named.includes(n.skill)) continue;
    if (read && read.has(n.skill)) continue;
    return { skill: n.skill, why: n.why };
  }
  return null;
}

const WANTS_FILE =
  /(?<![.A-Za-z0-9])html|ファイルに|ファイルへ|書き出|出力し|作成し|作って|做成|寫成|存成|輸出成|建立.*(檔|網頁)|寫(入|到).*檔|產出|生成.*(檔|檔案|報告|網頁)|保存/i;

const READ_ONLY_TASK =
  /書き換え(は)?しないで|変更しないで|編集しないで|読むだけ|不要修改|不要改|別修改|只(讀|看)|唯讀|do not (modify|change|edit)|read[- ]only/i;

const SKIP_IF_EXISTS =
  /既に(在|あ)れば|既に(在|あ)る|何も(足さ|作ら)ないで|不要な?ら|要らなければ|なければ.*だけ/i;

function needsFileFirst(task, wroteAny) {
  if (wroteAny) return null;
  const text = String(task || '');

  if (SKIP_IF_EXISTS.test(text)) return null;
  const wantsFile = WANTS_FILE.test(text);

  if (READ_ONLY_TASK.test(text) && !wantsFile) return null;
  if (!wantsFile) return null;
  return (
    '頼まれたものを、まだ作っていません。調べただけでは、頼んだ人の手元に何も残りません。' +

    '**新しいファイルを作ってください。**さっき読んだファイルを書き換えないでください。' +
    'write_file で作ってから done を出してください。' +

    '**頼まれた形（HTML なら .html）で作ってください。**' +
    '（サブエージェントが返した中身は、そのまま使えます。あなたが縮めると出典や数字が消えます）'
  );
}

const WANTS_DETAIL =
  /詳細|詳しく|詳盡|詳尽|完整|網羅|くわしく|できるだけ|なるべく|盡可能|as detailed|comprehensive|in depth/i;

const KEEP_RATIO = 0.5;

function readableLength(content) {
  return String(content || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

function needsDetailKept(task, gathered, content) {
  if (!gathered || gathered < 1000) return null;
  if (!WANTS_DETAIL.test(String(task || ''))) return null;
  const kept = readableLength(content);
  if (kept >= gathered * KEEP_RATIO) return null;
  const want = Math.ceil(gathered * KEEP_RATIO);
  return (
    `サブエージェントが集めたのは ${gathered} 文字ですが、いま書こうとしているのは ` +
    `本文 ${kept} 文字です（${Math.round((kept / gathered) * 100)}%）。` +
    '「できるだけ詳しく」と頼まれています。**要約せずに、集めたものを載せてください。**' +
    '出典の URL、引用した文、数字、表は落とさないでください。\n' +
    `目安は本文 ${want} 文字です。長くなって構いません。\n` +
    '1 通に入りきらなかった時は、分けて足せます:\n' +
    '  write_file で頭の方を書き、続きは edit_file の input を\n' +
    '  {"path":"同じ path","append":true,"new_text":"次の節"} にして足してください。\n' +
    'append は末尾に足すだけなので、old_text も insert_line も要りません。'
  );
}

const 穴埋めだけ = /^[\s…。.（）()「」]*$/;

const 括弧だけ = /^\s*[（(][^）)]*[）)]\s*$/;

function needsRealContent(task, target, content) {
  if (!WANTS_FILE.test(String(task || ''))) return null;
  const c = String(content || '');
  if (!穴埋めだけ.test(c) && !括弧だけ.test(c)) return null;
  return (
    `\`${target}\` の中身が「${c.slice(0, 20)}」だけです。**これは穴埋めの印であって、中身ではありません。**\n` +
    '見本に出てくる「…」や丸括弧は、そのまま書く物ではありません。' +
    'あなたが作った中身に置き換えて、もう一度書いてください。'
  );
}

module.exports = {
  matchSkills,
  skillDirective,
  needsSkillFirst,
  needsFileFirst,
  needsDetailKept,
  needsRealContent,
  readableLength,
  HINTS,
  NEEDS_SKILL,
  WANTS_FILE,
  READ_ONLY_TASK,
  WANTS_DETAIL,
  KEEP_RATIO,
};
