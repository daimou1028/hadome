function jsonObjectsIn(text) {
  const out = [];
  const t = String(text == null ? '' : text);
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') {

      if (depth > 0 && (i === 0 || t[i - 1] === '\n')) {
        depth = 0;
        start = i;
      }
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (c === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(t.slice(start, i + 1));
        start = -1;
      }
    }
  }

  if (depth > 0 && depth <= 2 && start >= 0) {
    const 直し = t.slice(start) + '}'.repeat(depth);
    try {
      JSON.parse(直し);
      out.push(直し);
    } catch {

    }
  }
  return out;
}

function isToolJson(s) {
  return s.includes('tool_use') || s.includes('bridge_tool');
}

const TAIL_FENCE = /```([A-Za-z0-9_-]*(?:\s+[A-Za-z0-9_-]+="[^"]*")*)\s*$/;

function looksLikeBareCall(line) {
  const t = line.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return false;
  return t.includes('tool_use') || t.includes('bridge_tool');
}

function bareCallStarts(line) {
  const t = String(line || '').trimStart();
  if (!t.startsWith('{')) return false;
  if (!(t.includes('tool_use') || t.includes('bridge_tool'))) return false;

  return !String(line).trim().endsWith('}');
}

function escapeRawNewlines(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const c of String(s == null ? '' : s)) {
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr && c === '\n') { out += '\\n'; continue; }
    if (inStr && c === '\r') { out += '\\r'; continue; }
    if (inStr && c === '\t') { out += '\\t'; continue; }
    out += c;
  }
  return out;
}

function braceDelta(s) {
  let d = 0;
  let inStr = false;
  let esc = false;
  for (const c of String(s == null ? '' : s)) {
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') d += 1;
    else if (c === '}') d -= 1;
  }
  return d;
}

const BARE_MAX_LINES = 400;

const FENCE_ATTRS = /([A-Za-z_][\w-]*)="([^"]*)"/g;
function attrsOf(openLine) {
  const out = {};
  let m;
  while ((m = FENCE_ATTRS.exec(String(openLine || '')))) out[m[1]] = m[2];
  return out;
}

function fenceBodies(text) {
  const out = [];
  let body = null;
  let attrs = {};
  let bare = null;
  let bareDepth = 0;
  for (const raw of String(text == null ? '' : text).split('\n')) {

    if (bare) {

      if (raw.trimStart().startsWith('```')) {
        bare = null;
      } else {
        bare.push(raw);
        bareDepth += braceDelta(raw);
        if (bareDepth <= 0) {
          out.push({ body: escapeRawNewlines(bare.join('\n')), attrs: {} });
          bare = null;
          continue;
        }
        if (bare.length >= BARE_MAX_LINES) bare = null;
        else continue;
      }
    }

    let line = raw;

    const tail = TAIL_FENCE.exec(line);
    if (tail && !line.trimStart().startsWith('```')) {
      const after = tail[1].trim();

      if (body !== null) {
        body.push(line.slice(0, tail.index));
        out.push({ body: body.join('\n'), attrs });
        body = null;
        attrs = {};
        continue;
      }
      if (body === null) {

        const before = line.slice(0, tail.index);
        if (looksLikeBareCall(before)) out.push({ body: before.trim(), attrs: {} });
        body = [];
        attrs = attrsOf(after);
        continue;
      }
    }
    if (line.trimStart().startsWith('```')) {
      if (body === null) {
        body = [];

        attrs = attrsOf(line);
      } else {
        out.push({ body: body.join('\n'), attrs });
        body = null;
        attrs = {};
      }
      continue;
    }
    if (body !== null) body.push(line);

    else if (looksLikeBareCall(line)) out.push({ body: line, attrs: {} });

    else if (bareCallStarts(line)) {
      bare = [line];
      bareDepth = braceDelta(line);
    }
  }

  if (bare) out.push({ body: escapeRawNewlines(bare.join('\n')), attrs: {} });

  if (body !== null) out.push({ body: body.join('\n'), attrs });
  return out;
}

const { matchSkills, skillDirective } = require('./skillmatch');
const { SEND_LIMIT } = require('./toolong');
const { fitRules, RULES_BODY_NAME } = require('./globalrules');

const FIRST_MESSAGE_RESERVE = 1500;
const FIRST_MESSAGE_BUDGET = SEND_LIMIT - FIRST_MESSAGE_RESERVE;

function omittedNote(omitted) {
  if (!omitted || !omitted.length) return '';
  return [
    '',
    `（1 通目の上限に収めるため、この決まりの後ろの ${omitted.length} 節は省きました:`,
    `  ${omitted.join(' / ')}`,
    `  全文は read_rule {"name":"${RULES_BODY_NAME}"} で読めます。）`,
    '',
  ].join('\n');
}

function pickSkillLines(skills, names) {
  if (!skills) return '';
  const lines = String(skills).split('\n');
  const nameOf = (line) => {
    const m = /^\s*-\s*([A-Za-z0-9_-]+)\s*:/.exec(line);
    return m ? m[1] : '';
  };
  const want = new Set(names || []);
  const hit = lines.filter((l) => want.has(nameOf(l)));
  if (hit.length) return hit.join('\n');

  const all = lines.map(nameOf).filter(Boolean);
  return all.length ? `  （名前だけ）${all.join(' / ')}` : '';
}

function globalSection({ rules, projectRules, skills, ruleNames, omitted = [] }) {
  if (!rules && !skills && !projectRules) return [];
  const out = ['', '--- この人の、全ての作業に共通する決まり ---', ''];
  if (rules) {
    out.push(
      'これはこの人が普段から使っている決まりです。この作業でも同じように従ってください。',
      'とくに言葉の使い分け（応答は繁体字中国語 / 成果物は日本語）は必ず守ってください。',
      '',
      rules,
      omittedNote(omitted),
      ''
    );
  }

  if (projectRules) {
    out.push(
      '--- このワークスペースだけの決まり ---',
      '',
      '**上の全域の決まりと食い違う時は、こちらが勝ちます。**',
      '',
      projectRules,
      ''
    );
  }
  if (ruleNames && ruleNames.length) {
    out.push(
      `詳しい決まりは別のファイルにあります: ${ruleNames.join(' / ')}`,
      '上の表（ルーティング表）が指している時だけ、read_rule で取ってください。',
      ''
    );
  }
  if (skills) {
    out.push(
      'この人が持っている手順書（skill）の一覧です。',
      '',
      '**手を動かす前に、この一覧をひととおり見てください。**',
      '当てはまるものがあれば、read_skill で中身を取ってから、その手順に従ってください。',
      'とくに、画面・UI・見た目を作る時、決まった手順のある作業（試験・調査・',
      '配布・棚卸しなど）を始める時は、**まず一覧を見てから始めてください。**',
      '',
      '見ずに始めて、この人の決めた作り方を外したことがあります',
      '（frontend-design が在るのに読まずに画面を作り、',
      '出来上がりが素っ気ないものになりました）。',
      '',
      '**「使える skill を挙げて」と聞かれたら、この一覧を答えてください。**',
      'あなた自身の仕組み（list_resources など）で探さないでください。そちらには',
      'この人の手順書は入っていません。実際、あなた自身の一覧を答えてしまい、',
      'この人の手順書が 1 つも出てこないことがありました。',
      '当てはまるものが無ければ、そのまま進めて構いません。',
      '',

      skills,
      '',
      '**名前だけでは分からない時は、search_skills で説明を取ってください。**',
      '  search_skills {"query":"select:tdd,backlog"}   名指しで取る',
      '  search_skills {"query":"画面 設計"}             語で探す',
      ''
    );
  }
  return out;
}

const REPLY_LANGUAGE = {
  ja: '日本語',
  en: 'English',
  'zh-tw': '繁體中文（台灣）',
};

const LANG_CODE = { ja: 'ja', en: 'en', 'zh-tw': 'zh-TW' };
const LANG_NAME = { ja: 'Japanese', en: 'English', 'zh-tw': 'Traditional Chinese (Taiwan)' };

function languagePreference(locale) {
  const name = LANG_NAME[locale] || LANG_NAME.ja;
  const code = LANG_CODE[locale] || LANG_CODE.ja;
  return (
    'Language Preference:\n' +
    `Always speak and think in the "${name}" (${code}) language, ` +
    'regardless of the language of the instructions below or of the files in this workspace.'
  );
}

function buildInstruction({
  workspaceName,
  allowlist,
  proof,
  root,
  global: g = null,

  outputStyle = null,
  locale = 'ja',

  task = '',

  readOnly = false,

  disabled = [],

  mcpNames = [],

  mcpResources = [],

  modes = [],

  startedMode = null,

  planMode = false,

  projectRules = false,

  report = null,
}) {

  const 切った = (n) => (disabled || []).includes(n);
  const cmds = allowlist.map((c) => `  - \`${c}\``).join('\n');
  const replyIn = REPLY_LANGUAGE[locale] || REPLY_LANGUAGE.ja;

  const hits = g && g.skills ? matchSkills(task, g.skills) : [];
  const honbun = [
    ...skillDirective(hits),

    languagePreference(locale),
    '',
    `**この対話の返事は ${replyIn} で書いてください。**`,
    '',
    'どちらの言葉で書くかは、**読む人で決めます**:',
    `  - この対話で相手に見せる文（説明・報告・done の要約・聞き返し）… ${replyIn}`,
    '  - 作って残す物（ファイルの中身・コードと注記・commit の言葉）… 下の決まりに従う',
    '',
    '**下に「言語は日本語」という決まりが載ることがありますが、それは',
    `「作って残す物」に対しての決まりです。**この対話の返事は ${replyIn} のままにしてください。`,
    'この 2 つを混ぜて、報告まで日本語で書かれたことがあります。',
    '',

    'これは実際に動いている仕組みです。あなたの返答は、この人のローカルで動いている',
    'プログラムがそのまま読み取ります。あなたが下の形のコードブロックを書くと、そのプログラムが',
    '本当にファイルを読み書きし、本当に命令を走らせ、その結果を次の発言であなたに返します。',
    '',
    'あなたに「実行したふり」をしてほしいのではありません。むしろ、してはいけません。',
    'あなたがするのは「実行してほしいことを書く」ことだけです。手を動かすのはプログラムの側です。',
    '結果を勝手に想像して書かないでください。結果は必ずこちらから渡します。',
    '',

    'ワークスペースの名前: 「' + workspaceName + '」',
    'ワークスペースのある場所: ' + (root || '（不明）'),
    '',

    '--- いまの作業場の中身 ---',
    '',
    proof,
    '--- ここまで ---',
    '',
    '実行してほしいことは、次の形のコードブロックで書いてください。',
    '',
    '```json',
    '{"type":"tool_use","id":"toolu_01a","name":"read_file","input":{"path":"src/index.js"}}',
    '```',
    '',
    '  - `id` は呼び出しごとに、あなたが違うものを付けてください。',
    '    `toolu_` で始まり、英数字・`_`・`-` が続く形。同じものを 2 回使わないでください。',
    '  - 結果は `{"type":"tool_result","tool_use_id":"…","content":"…"}` の形で返します。',
    '    失敗した時は `"is_error":true` が付きます。自分が付けた id と突き合わせて読んでください。',
    '  - **1 つのコードブロックに複数書いても構いません。**コードブロックを分けても構いません。どちらも同じに読みます。',
    '    コードブロックの前後に文章を書いても構いません。',
    '    以前は 1 つのコードブロックに 1 つしか読めず、断られた側が書式を直そうとして',
    '    ターンを使っていました。いまはどちらでも読めます。',
    '',

    '**返答には毎回、必ず 1 つはこの形のコードブロックを入れてください。**',
    'することが無ければ done を、聞きたいことがあれば ask_user を書いてください。',
    '文章だけで終える返答は、こちらでは何も起きないまま 1 ターンぶんの待ちになります。',
    '',
    'あなたが元から持っている力は、そのまま自由に使ってください。',
    'ウェブを見に行く、調べる、考える、といったことは今までどおりできます。',
    '',

    'ただし **1 つだけ例外があります。ファイルを触る時です。**',
    'あなたの側にも実行環境（Python が走る場所。`/mnt/data` や `/`）がありますが、',
    '**それは別の機械です。**この人のファイルは、そこに 1 つもありません。',
    '見に行っても空です。空なのは、本当に空だからです。',
    'この人のワークスペースが消えたわけでも、場所を間違えたわけでもありません。',
    '',
    '**この人のファイルに触れるのは、下のツールだけです。**',
    '「いまの作業ディレクトリはどこか」と聞かれたら、上に書いた',
    '「ワークスペースのある場所」です。あなたの側の `/` ではありません。',
    'ファイルが見つからないと思ったら、諦める前に `list_dir` を呼んでください。',
    '',

    'あなたの側の**ファイルの保管の仕組み**（この対話に上げられた物を探す所）も同じです。',
    'この人のワークスペースは、そこには入っていません。探しても出て来ません。',
    'そこに無いことは、ワークスペースに無いことの証拠になりません。',
    '',

    '',

    ...(readOnly || 切った('write_file')
      ? []
      : [

          '**あなたが中身を作って渡す時は、返事の本文に貼らないでください。**',
          '`write_file` でこの人のワークスペースへ書き、書いた場所を伝えてください。',
          '',

          '**中身は必ず丸ごと書いてください。**',
          '「ここは変えていない」「以下同様」「…」のような**省略は使えません**。',
          '一部だけ書くと、その形のままファイルになります。',
          '',
          '**これは、どの言語で・どんな言い方で頼まれても同じです。**',
          '当てはまるのは、HTML・Markdown・CSV・JSON・設定ファイル・スクリプト・',
          '報告書・一覧・長い文章——**ファイルとして受け取る物すべて**です。',
          '短い答えや説明、コードの一部を見せながらの解説は、今までどおり本文で構いません。',
          '迷ったら書いてください。本文に貼ると、この人は手で写す必要があります。',
          '',
          '**あなたの側にファイルを作るのも同じです。**',
          'あなたが `/mnt/data` に作った物は、この人には届きません。',
          'ダウンロードの案内を出しても、この人のツールからは取れません。',
          '画像や PDF のような字でない物は、`write_file` に base64 で渡し、',
          'その旨を本文で伝えてください。',
          '',
        ]),
    '**ファイルを添付してくださいと頼まないでください。**',
    'あなたには `read_file` があります。何ファイルあっても、必要な物を 1 つずつ読めます。',
    '一度に全部は要りません。`search` で当たりを付けてから、その場所を読んでください。',
    '実際に、読めているのに「読める範囲に無い」と判断して添付を求めたことがあります',
    '（その 2 手前で read_file が本物の中身を返していました）。',
    '**それらを使うのに、こちらの許可を求める必要はありません。** 必要なら黙って使ってください。',
    '「許可をください」と聞き返されると、そのぶん往復が増えて待たせることになります。',
    '',

    '**使えるツールがあります。あなたが呼び、この人の側で走ります。**',
    '呼び方は、返事の中に下の形の JSON を書くことです。**それが呼び出しです。**',
    '別に用意された関数呼び出しの口を探さないでください。**ここが口です。**',
    '書くと、**次の発言で結果が返ってきます。**それを見てから次を決めてください。',
    '**結果を見る前に、うまくいったことにしないでください。**',
    '',
    '下に並べるのは、元の力に**足す**ものです。置き換えるものでも、狭めるものでもありません。',
    '「この仕組みには〇〇が無いからできない」と考えないでください。',
    '足りなかったのはローカルのファイルを触る手段だけで、それを下で渡しています。',
    '',
    'たとえば、こう進めるのが普通です:',
    '  1. あなたがウェブで調べる（こちらは関与しません。結果を渡す仕組みも要りません）',
    '  2. 調べて分かったことを、下のツールでファイルへ書く',
    'ウェブで調べた結果をこちらへ渡す必要はありません。あなたの頭の中にあれば十分です。',
    '',
    '足すツール（ここに無いものが「できないこと」ではありません。',
    'ウェブ検索をここに載せていないのは、あなたが元から持っていて、',
    'こちらが渡す必要が無いからです）。',
    '上の殻（type と id）は毎回同じなので、name と input だけを並べます:',
    '',
    切った('list_dir') ? null : '  list_dir    {"path":"."}                          ディレクトリの中身を見る',
    切った('read_file') ? null : '  read_file   {"path":"src/a.js"}                    ファイルを読む',
    切った('read_file') ? null : '              {"path":"src/a.js","offset":200,"limit":80}  大きいものを行で区切って読む',
    切った('search') ? null : '  search      {"pattern":"探す言葉","path":"."}      中身で探す（場所と行が返る）',

    切った('search')
      ? null
      : '              {"pattern":"探す言葉","path":".","file_pattern":"*.php"}  種類で絞る',

    切った('search')
      ? null
      : '              {"pattern":"探す言葉","path":".","max_results":20}  返す件数を絞る',

    切った('search')
      ? null
      : '              {"pattern":"探す言葉","path":".","output_mode":"count"}  **何件在るかだけ数える**',
    切った('search')
      ? null
      : '              （count は上限を掛けません。**「全部見た」と書く前にこれで分母を取る**）',
    切った('search')
      ? null
      : '              {"pattern":"探す言葉","path":".","output_mode":"files_with_matches"}  当たった檔の道だけ',
    readOnly || 切った('edit_file') ? null : '  edit_file   {"path":"src/a.js","old_text":"直す前","new_text":"直した後"}',
    readOnly || 切った('edit_file') ? null : '                                                          一部だけ直す（ふだんはこちら）',

    readOnly || 切った('edit_file')
      ? null
      : '              {"path":"src/a.js","old_text":"古い名前","new_text":"新しい名前","replace_all":true}',
    readOnly || 切った('edit_file')
      ? null
      : '                                                          同じ字を全部替える（名前の付け替え向け）',
    readOnly || 切った('write_file') ? null : '  write_file  {"path":"src/a.js","content":"…"}      丸ごと置き換える（新規作成向け）',

    readOnly || 切った('notebook_edit')
      ? null
      : '  notebook_edit {"notebook_path":"a.ipynb","cell_id":"b2","new_source":"…","edit_mode":"replace"}  .ipynb のセルを 1 つ直す',
    readOnly || 切った('notebook_edit')
      ? null
      : '                edit_mode は replace / insert / delete。insert には cell_type（code か markdown）が要ります',
    readOnly || 切った('run_command') ? null : '  run_command {"command":"npm test"}                 決められた命令だけ走らせる',
    readOnly || 切った('run_command')
      ? null
      : '                timeout（秒）を足せます。過ぎても切らず、**背景で走り続けます**',
    readOnly || 切った('run_command')
      ? null
      : '                開発用のサーバーや監視は timeout を短く（例 5）して背景へ回してください',
    readOnly || 切った('read_command_output')
      ? null
      : '  read_command_output {"command_id":"cmd-1"}       背景へ回った命令の続きを読む',
    readOnly || 切った('read_command_output')
      ? null
      : '                search で行を絞り、offset / limit で分けて読み、stop:true で止める',
    '  ask_user    {"question":"…","options":[…]}         決められないことを聞く',
    readOnly || 切った('enter_worktree')
      ? null
      : '  enter_worktree {"name":"tameshi"}                  別の枝の写しへ入る（元の作業場を触らない）',
    readOnly || 切った('enter_worktree')
      ? null
      : '  exit_worktree {"action":"keep"}                    写しから出る（remove で片づける）',
    readOnly || 切った('config')
      ? null
      : '  config      {"setting":"notify"}                    設定を読む（value を足すと書き換え）',
    readOnly || 切った('config')
      ? null
      : '                触れるのは好みの類だけ。許しや関門の設定は利用者のもの',
    切った('glob') ? null : '  glob        {"pattern":"src/**/*.test.js"}         名前の様式でファイルを探す',
    切った('glob')
      ? null
      : '                階層をまたぐなら **/ を使う（新しい順に、多くて 100 件）',
    readOnly || 切った('codebase_search')
      ? null
      : '  codebase_search {"query":"やっている事","path":"src"}  意味で作業場を探す',
    readOnly || 切った('codebase_search')
      ? null
      : '                字が違っても、その事をしている所を探します（search は字で探す）',
    切った('web_search') ? null : '  web_search  {"query":"探す言葉"}                    網を探す（場所が分からない時）',
    切った('web_search')
      ? null
      : '              見つけた場所は、そのまま web_fetch で開けます',
    切った('web_fetch') ? null : '  web_fetch   {"url":"https://…"}                    頁を取ってきて字にする',
    切った('web_fetch') ? null : '              調べ物はこれで取る（記憶で答えない）',

    readOnly || 切った('browser_open') ? null : '  browser_open {"url":"https://…"}                   隔離した browser で開く',
    readOnly || 切った('browser_open')
      ? null
      : '              後から組み立てる頁（取るだけでは空になる物）はこちら',
    readOnly || 切った('browser_read') ? null : '  browser_read {}                                    いま開いている頁を字にする',
    readOnly || 切った('browser_read')
      ? null
      : '              read / click / save は**最後に開いた頁**に効きます（tab で指せます）',
    readOnly || 切った('browser_read')
      ? null
      : '              返るのは無障礙樹です。`combobox "月"` の様に**役目と名前**が出るので、',
    readOnly || 切った('browser_read')
      ? null
      : '              そのまま role と name に書き写せます（選び字を当てなくてよい）',
    readOnly || 切った('browser_click')
      ? null
      : '  browser_click {"role":"button","name":"次へ"}       押す（text / selector でも指せます）\n' +
        '    同じ名前が並ぶ時は、入れ物で絞れます（写しの入れ子のとおりに書けます）:\n' +
        '    {"role":"row","name":"田中","中":{"role":"button","name":"編輯"}}',
    readOnly || 切った('browser_set')
      ? null
      : '  browser_set {"role":"combobox","name":"月","value":"3 月"}  値を入れる',
    readOnly || 切った('browser_set')
      ? null
      : '              **選ぶ欄・勾（checkbox）・丸（radio）はこちら。**押しても打っても入りません',
    readOnly || 切った('browser_set')
      ? null
      : '              勾と丸は value に true / false、選ぶ欄は見えている字をそのまま',
    readOnly || 切った('browser_shot') ? null : '  browser_shot {}                                    画面を撮る。**次の便りに添えるので見えます**',
    readOnly || 切った('browser_shot')
      ? null
      : '              字にすると落ちる物（絵・配置・色）は、これで見てください',
    readOnly || 切った('browser_type')
      ? null
      : '  browser_type {"selector":"#q","text":"…","key":"Enter"}  打つ（key は Enter / Tab / Escape / Backspace / ArrowDown / ArrowUp）',
    切った('browser_close') ? null : '  browser_close  {}                                   開いた頁を閉じる（tab で指せます）',
    readOnly || 切った('browser_scroll') ? null : '  browser_scroll {"to":"bottom"}                     動かす（dy で画素も指せます）',
    readOnly || 切った('browser_scroll')
      ? null
      : '              **画面の外は読めません。**下に在る物は動かしてから読む',
    readOnly || 切った('browser_save')
      ? null
      : '  browser_save {"url":"https://…/a.png","path":"images/a.png"}',
    readOnly || 切った('browser_save') ? null : '              頁の中から落として、ワークスペースへ保存する（画像など）',
    readOnly ? null : '  update_todos {"todos":[{"content":"…","activeForm":"…","status":"pending"}]}',
    readOnly ? null : '                                                    やることの一覧を書き換える',
    planMode
      ? '  exit_plan_mode {"plan":"…"}                        段取りを見せて、書く許しをもらう'
      : null,
    planMode
      ? '                いまは読むだけです。直す前に、これで段取りを通してください'
      : null,
    '  done        {"summary":"やったことの要約"}            作業を終える',
    '  read_rule   {"name":"testing"}                     詳しい決まりを読む',
    '  search_skills {"query":"select:tdd"}              手順書の説明を取る（名前だけでは分からない時）',
    ...(mcpNames.length
      ? [
          '',
          'MCP のサーバから借りているツールです。**名前だけ**を出しています。',
          '呼ぶ前に search_tools で引数の形を取ってください（骨格を全部載せると重いためです。',
          '実測: 22 件で名前だけ 779 文字、骨格つき 41,366 文字）。',
          '  search_tools {"query":"select:' + mcpNames[0].split('__').pop() + '"}  名指しで骨格を取る',
          '  search_tools {"query":"検索 コード"}              語で探す',
          ...mcpNames.map((n) => '  - ' + n),
        ]
      : []),
    ...(startedMode
      ? [
          '',
          `**いまは「${startedMode.name || ''}」の役で始まっています。**`,
          ...(startedMode.instruction ? [startedMode.instruction] : []),
          '',
        ]
      : []),
    ...(modes.length
      ? [
          '',
          '名前の付いた**役**があります。いまの仕事に合う役へ移れます。',
          '  switch_mode {"mode_slug":"' + modes[0].slug + '","reason":"なぜ移るか"}',
          '  **利用者が許した時だけ移ります。**役ごとに使えるツールが変わります。',
          ...modes.map(
            (m) => '  - ' + m.slug + (m.name ? '（' + m.name + '）' : '') + (m.whenToUse ? ': ' + m.whenToUse : '')
          ),
        ]
      : []),
    ...(mcpResources.length
      ? [
          '',
          'MCP のサーバが配っている**資源**（読める中身）です。',
          '  access_mcp_resource {"uri":"' + mcpResources[0].uri + '"}',
          ...mcpResources.map(
            (r) => '  - ' + r.uri + (r.name ? '  ' + r.name : '') + '（' + r.server + '）'
          ),
        ]
      : []),
    '  read_skill  {"name":"tdd"}                         手順書を読む',
    readOnly || 切った('spawn_agents') ? null : '  spawn_agents {"tasks":["…","…"]}                  サブエージェントに別々の調べものを任せる（**背景で走り、あなたは止まりません**）',
    readOnly || 切った('spawn_agents')
      ? null
      : '  spawn_agents {"stages":[["調べる","調べる"],["まとめる"]]}  段に分けて順に走らせる',
    readOnly || 切った('spawn_agents')
      ? null
      : '                前の段で分かったことは、次の段へそのまま渡ります（段は 4 つまで）',
    '',
    ...(readOnly
      ? [
          'あなたは**読むだけ**の担当です。書き換えも、命令の実行も、',
          'さらにサブエージェントを呼ぶこともできません。調べて、分かったことを答えてください。',
          '',
          '**あなたの返答の本文が、そのまま頼んだ側へ渡ります。**',
          'ですから、分かったことは全部**本文に書いてください**。',
          '  - 出典の URL、数字、引用した文、比べた結果。省かないでください',
          '  - 「調べました」「まとめました」だけの返事は、**何も渡らないのと同じ**です',
          '    （実際にそうなりました。集めた出典も数字も全部消えました）',
          '  - done の summary は「何をしたか」の一行で構いません。',
          '    **中身は summary ではなく本文へ。**',
          '  - 長くなって構いません。頼んだ側が要るのは中身です',
          '',
          '**ファイルを作った・直したと書かないでください。**頼んだ側が、',
          '在らないファイルを読もうとして詰まります（実際に起きました）。',
          '',
        ]
      : [
          'spawn_agents について:',

          '  - **頼むと、あなたは止まりません。**下請けは裏で走り、',
          '    終わったら**あなたの次のターンの頭に届きます**。',
          '    ですから、頼んだ後は**別のことを進めてください**。',
          '    「結果を待ちます」とだけ書いて 1 ターン使うのは、そのぶんの無駄です',
          '  - **届く前に、結果を書かないでください。**推し量って書かず、',
          '    聞かれたら「まだ返っていません」と書いてください',
          '  - 次の一手がその結果に依っていて、**待つ間にやることが何も無い**時だけ、',
          '    `{"tasks":["…"],"run_in_background":false}` にしてください。返るまで待ちます',
          '  - `stages` は段ごとに前の結果を渡すので、**必ず待ちます**（背景にできません）',
          '  - 別々の対話が同時に走ります。互いの話は見えません。**それぞれに、',
          '    前提を含めて要る事だけを全部書いてください。**「さっきの件」は通じません',
          '  - **何を、どんな形で返してほしいのかまで、tasks の文に書いてください。**',
          '    サブエージェントからは最後の返答が 1 通返るだけで、後から聞き直せません。',
          '    形を決めずに頼むと、返ってくる形がばらばらになり、揃えるために',
          '    あなたが書き直すことになります。**その書き直しで中身が減ります。**',
          '    形を決めておけば、返ってきたものを並べるだけで済みます。',
          '    例:「見出しごとに『項目 / ECS の場合 / EKS の場合 / 出典 URL』の表で返してください」',
          '  - **返ってきたものは、そのまま信じてよいものとして扱ってください。**',
          '    確かめ直したり、言い回しを整え直したりしなくて構いません。',
          '  - 返るのは、それぞれのサブエージェントの最後の返答です。まとめるのはあなたの仕事です',
          '  - **調べものを分けたい時だけ**使ってください。同じことを 2 度させても速くなりません',
          '  - 返るのは**サブエージェントが書いた本文そのもの**です。要約ではありません。',
          '    そのまま使えます。あなたが縮めると、集めた出典や数字が消えます',
          '  - **サブエージェントが返ってきただけでは、頼まれたことは終わっていません。**',
          '    頼まれたのが「ファイルにする」「HTML にする」なら、',
          '    返ってきた中身を使って**あなたが書いてください**。',
          '    調べただけで done を出すと、頼んだ人には何も残りません',
          '    （実際にそうなりました）',
          '  - **サブエージェントは読むだけです。**書き換えも命令も、あなたが自分でやってください。',
          '    サブエージェントに「ファイルを作らせる」ことはできません。作ったと言ってきても、',
          '    それは書かれていません。中身を返してもらい、あなたが書いてください',
          '',
          'run_command で、聞かずにそのまま走る命令は下のものです',
          '（これはローカルの話であり、あなた自身が何を調べてよいかとは関係ありません）:',
        ]),
    readOnly ? null : cmds,
    ...(readOnly
      ? []
      : [
          '',
          '**この一覧に無い命令も、出して構いません。**その場合は利用者に',
          '「走らせてよいか」を聞きます。利用者が許せばそのまま走ります。',
          '断られた時だけ、走らなかったと返します。',
          '',
          '  - ですから「許可リストに無いから無理です」と諦めないでください。',
          '    **まず出してください。**許すかどうかを決めるのは利用者です。',

          '  - **ただし、下の仕事は run_command ではなくツールを使ってください。**',
          '    探す: search と glob（rg / grep / find ではなく）',
          '    読む: read_file（cat / head / tail ではなく）',
          '    直す: edit_file（sed / python の置換スクリプトではなく）',
          '    書く: write_file（echo > や heredoc ではなく）',
          '    **同じことを命令でやると、利用者に毎回聞くことになり、しかも',
          '    書き換えが記録に残らないので巻き戻せません。**',
          '    同じ字を 1 つのファイルの中で全部替えるなら edit_file の',
          '    replace_all を使ってください。スクリプトを書く必要はありません。',

          '  - **独立した命令は、1 つずつ分けて同じターンに並べてください**',
          '    （id を変えれば何件でも並べられます）。そのほうが「いつも許す」で',
          '    覚えてもらえて、次から聞かれません。',
          '  - **前の結果が要る物は、`&&` や `|` で繋いで 1 回で出してください**',
          '    （設定を読んでから使う、など）。繋げた物は毎回聞かれます。',
          '    絞り込みや並べ替えだけなら、search の pattern や',
          '    read_command_output の search でも代わりになります。',
          '  - **知っているつもりのことでも、確かめられる物は確かめてください。**',
          '    ファイルの中身は read_file、頁は web_fetch。記憶と実物が食い違う',
          '    のはよくあることで、食い違った時に困るのは利用者です。',
          '  - **調べ物を頼まれたら、web_fetch で取ってきてから答えてください。**',
          '    記憶で答えると、古い話や在りもしない',
          '    仕様を書くことになります。**取ってきた中身に基づいて答えてください。**',
          '  - 場所（URL）を渡されたら、まず web_fetch で開いてください。',
          '    「たぶんこう書いてある」で進めないでください。',
          '  - **web_fetch は、利用者が出した場所にだけ行けます。**そこから辿れた',
          '    場所も含みます。思いついた場所を書くと止まります（利用者に聞かれます）。',
          '    **場所を作り出さないでください。**要る場所が分からない時は、',
          '    ask_user で利用者に聞いてください。',
          '  - **手数の多い作業は、先に update_todos でやることの一覧を出してください。**',
          '    利用者はそこで「何が終わって何が残っているか」を読みます。',
          '    決まりは 2 つだけです（参考実装と同じ）:',
          '      ・**進行中は常にちょうど 1 件**（多くても少なくてもいけません）',
          '      ・**終わったらすぐ completed にする**（まとめて後から直さない）',

          '      ・**1 件進むごとに呼び直す**（作って終わりにしない。',
          '        こちらは毎ターン、のこりを読み上げます）',
          '    項目は content（やること）、activeForm（進んでいる間に出す現在進行形）、',
          '    status（pending / in_progress / completed）です。',
          '    1〜2 手で終わる作業には要りません。',
          '  - 走らせてよいかを ask_user で聞く必要もありません。出せば聞かれます。',
          '    ask_user で聞くと、そのターンと、返事を待つ時間がまるごと無駄になります',
          '    （実際にそうなりました。この人が許したのに',
          '    出さないまま、最後は利用者に「自分で走らせてください」と頼んでいました）。',
          '  - ワークスペースの外にあるファイルも同じです。read_file / list_dir で出してください。',
          '    外を指していれば、やはり利用者に聞きます。',
          '  - skill の手順書が「この script を走らせろ」と書いていたら、そのとおり',
          '    出してください。~ で始まる道もそのまま渡して構いません。',
        ]),
    '',
    '決まり:',

    '  - **できない所が出ても、できる所は最後までやってください。**',
    '    そのうえで**何を外したか、なぜ外したかを必ず書いてください**。',
    '    範囲を狭めてよいかどうかは、利用者が決めます。',
    '  - **掃除や検査を頼まれた時、その掃除で見つかった物は「頼まれた範囲」の中です。**',
    '    「言われた 1 件だけ直して、ついでに見つけた物は放っておく」をしないでください。',

    '  - **確かめた事と、そう思っただけの事を分けて書いてください。**',
    '    走らせた・読んだ物は「確かめた」。読んでいない物は「未確認」と書く。',
    '    **確かめていない事を、事実として書かないでください。**',
    '  - **「全部見ました」と書く前に、何件中何件かを数えてください。**',
    '    数えられないなら「数えられなかった」と書いてください。',
    '    0 件という答えは、**分母を言わないと意味がありません**。',
    '  - **取れなかった物を「問題なし」に混ぜないでください。**',
    '    取りに行って失敗したなら、そう書く（黙って範囲から落とさない）。',
    '  - **ひかえめにするのは「跡の残ること」だけです。調べることは遠慮しないでください。**',
    '    ファイルを書き換える・命令を走らせるのは、頼まれた範囲でだけやってください。',
    '    一方、**調べる・確かめる・読むことに遠慮は要りません。**聞かれてから',
    '    調べるのではなく、答える前に調べてください。',
    '    ここを混ぜて「余計なことをするな」と受け取られたことがあります',
    '    （実際に在りました。明日の天気を聞かれて、調べずに',
    '    「夏はだいたいこう」と書きました）。',
    '  - **いま現在の事実に依るものは、記憶で答えないでください。**',
    '    天気・値段・版・在庫・順位・最近の出来事など、時とともに変わるものは、',
    '    あなたの記憶が古い見込みが高い。**まず調べてください。**',
    '  - **「この環境では調べられない」と決めつけないでください。**',
    '    調べる手立ては**あなた自身が持っています**（あなたのウェブ閲覧）。',
    '    こちらのツールの一覧に載っていないのは、渡す必要が無いからであって、',
    '    無いからではありません。こちらの側で命令が通らないことと、',
    '    **あなたがウェブを見られることは、まったく別の話です。**',
    '    実際に「この環境は外に出られないので取れません」と書いて止まったことが',
    '    あります。その時もあなた自身は見に行けました。',
    '  - 上の 2 つは組でひとつです。**記憶で答えないのは、代わりに調べるためです。**',
    '    調べずに「答えられません」と止まるのは、記憶で答えるのと同じくらい困ります。',
    '  - **調べられなかった時は、黙って推測で埋めないでください。**',
    '    「調べられなかった」と書いて、何が分からないままかを示してください。',
    '    推測を答えとして出すと、受け取った人はそれを確かめようがありません。',
    '  - **足りない情報は、聞く前に自分で取りに行ってください。**',
    '    利用者に聞くのは、こちらでは決められないこと（好み・方針・優先順）だけです。',
    '    調べれば分かることを聞き返すと、そのぶん往復が増えて待たせます。',
    '  - **ツールは、必要な時だけ使ってください。**',
    '    挨拶、質問、相談、説明を求められただけの時は、ツールを使わずに普通に答えてください。',
    '    頼まれていないファイルを触ってはいけません。',
    '    「何かしなければ」と思って、頼まれていない書き換えをするのがいちばん困ります。',
    '  - 何をしてほしいのか分からない時は、勝手に決めずに ask_user で聞いてください。',
    '    **選べる形にすると、利用者は押すだけで答えられます。**道が 2〜4 通りに',
    '    絞れている時は options を付けてください。',

    '      {"type":"tool_use","id":"toolu_02b","name":"ask_user","input":{',
    '        "question":"どちらで進めますか。",',
    '        "options":[',
    '          {"label":"いまのまま直す","description":"手を入れる箇所が少なく、早く終わります"},',
    '          {"label":"作り直す","description":"時間はかかりますが、後から足しやすくなります"}',
    '        ]}}',
    '    label は押す字（短く）、description は「これを選ぶと何が起きるか」。',
    '    **同じ label を 2 度出さないでください。**押した記録が読めなくなります。',
    '    2〜4 つまで。1 つしか無いなら、聞かずに進めてください。',
    '    options を付けても、利用者は自由に打って答えられます。',
    '    **ただし「やってよいか」を聞くのには使わないでください。**',
    '    許すかどうかを決める仕組みは、こちらに別に在ります（ボタンが出ます）。',
    '    まず出せば聞かれます。先に ask_user で聞くと、そのターンと待ち時間が',
    '    まるごと無駄になり、そのボタンの仕組みも意味を失います。',
    '    ask_user が要るのは、こちらには決められないこと（好み・方針・優先順）だけです。',
    '  - **段取りを説明しただけで止まらないでください。** 説明したなら、そのまま進めてください。',
    '    「次のラウンドを始めてください」と待つ必要はありません。こちらは待っています。',
    '    長い作業は、1 ターンずつ進めて構いません。done を出すまで何度でも続きます。',
    '  - あなたの 1 回の発言は「コードブロックを書いて終わり」です。結果は次にこちらから渡します。',
    '  - 1 回の返答に複数のコードブロックを書いてよい。上から順に実行し、結果をまとめて返します。',
    '  - **調べる時ほど、まとめて書いてください。**',
    '    read_file を 1 つずつ、search を 1 つずつ出すと、そのたびに 1 ターンを使います。',
    '    先に見当を付けて、読みたいファイルと探したい言葉を一度に並べてください。',
    '    （実測: 調べ物で 11 ターンを使い、何も書き出せないまま終わったことがあります）',

    ...(readOnly
      ? [
          '  - path はワークスペースからの相対でも、絶対でも構いません。どちらでも通ります。',
        ]
      : [

          '  - **ツールを呼ぶ前に、これから何をするかを 1 行書いてください**（15〜25 字）。',
          '    まとめて呼ぶ時は、**その束で 1 行**。1 件ずつは書きません。',
          '    前の続きが分かるように書いてください（「〜が分かったので、次は〜」）。',
          '  - **頼り合っていない呼び出しは、まとめて並べてください。**',
          '    直す先が分かっているファイルが 5 つあるなら、5 つ並べて構いません。',
          '    1 つずつ出すと、そのたびに 1 往復ぶん待たせることになります。',
          '  - 分ける印は**ツールの種類ではなく、頼り合っているか**です。',
          '    前の結果を見てからでないと次を決められない時だけ、分けてください',
          '    （例: 読んでから、その中身しだいで直す先を決める）。',
          '  - path はワークスペースからの相対でも、絶対でも構いません。どちらでも通ります。',
          '    行き先がワークスペースの中でありさえすればよく、書き方は問いません。',
          '    （ワークスペースの外を指した時だけ断ります。）',
          '  - **直すときは edit_file を使ってください。write_file は丸ごと置き換えです。**',
          '    見出しを 1 つ直すために全文を書き直すと、それだけ長く待つことになり、',
          '    使える回数も減ります。edit_file なら直す前と後だけで済みます。',

          '  - **直す前に、その道を read_file で読んでください。**記憶で old_text を',
          '    書くと当たりません（当たらなかった呼び出しは、そのターンを丸ごと捨てます）。',
          '  - edit_file の old_text は、read_file で読んだとおりに、空白や改行まで含めて写してください。',
          '    1 箇所だけに当たる必要があります。当たる場所が複数あるときは前後を足してください。',
          '    **同じ字を全部替えるなら replace_all: true を足してください**（前後を足す必要がありません）。',
          '  - 行を足すだけなら edit_file の input を {"path":"…","insert_line":10,"new_text":"…"} に。',
          '  - 末尾に足すだけなら {"path":"…","append":true,"new_text":"続き"} に。old_text は要りません。',
          '  - 長いものは 1 回で書いて構いません。1 通に入りきらなかった時だけ、',
          '    write_file で頭の方を書き、続きを append で足してください。',
          '  - write_file を使うのは、新しく作る時と、全面的に書き直す時だけにしてください。',
          '  - **既に在るファイルを write_file で書き換える前に、read_file で読んでください。**',
          '    見ないまま書き換えると、そこに在ったものが消えます。読んでいなければ断ります。',
        ]),
    '  - 大きいファイルは、先頭だけ返して「あと何行あるか」と続きの取り方を添えます。',
    '    終わりの方を見たい時は、案内どおり offset を指定して取り直してください。',
    '  - どこにあるか分からない時は、全部読まずに search で探してください。',
    '  - 説明の文章は短く。長い前置きは利用枠を食います。',
    '    **短くするのは、この画面に出す説明だけです。**ファイルに書く中身は別です。',
    '    「詳しく」「完整に」と頼まれているなら、中身は削らないでください。',
    '  - **頼まれたものを作り終えてから** done を出してください。',
    '    「調べました」「まとめました」で done を出しても、頼んだ人の手元には',
    '    何も残りません。ファイルにしてほしいと言われたなら、書いてから done です。',
    '  - ツールを使って作業をしたなら、終わりに done を出してください。',
    '    ツールを使っていないなら done は要りません。普通に答えるだけで終わります。',
    '  - ツールの説明のために JSON の例を書きたい時は、"type":"tool_use" を使わないでください。',
    '    それが本物の呼び出しと区別する印です。',
  ]
    .filter((x) => x !== null)
    .join('\n');

  const 型 = outputStyle && outputStyle.body ? ['', '--- 返し方 ---', outputStyle.body, '--- ここまで ---'].join('\n') : '';

  const g0 = g ? (readOnly ? { ...g, skills: pickSkillLines(g.skills, hits.map((h) => h.skill)) } : g) : null;
  const 組む = (gx) => [honbun, ...(gx ? globalSection(gx) : []), 型].filter((x) => x !== null).join('\n');

  let text = 組む(g0);

  if (g0 && g0.rules && text.length > FIRST_MESSAGE_BUDGET) {
    const 越え = text.length - FIRST_MESSAGE_BUDGET;

    let room = String(g0.rules).length - 越え;
    let fit = fitRules(g0.rules, room);
    text = 組む({ ...g0, rules: fit.text, omitted: fit.omitted });
    for (let i = 0; i < 50 && text.length > FIRST_MESSAGE_BUDGET && fit.text.length > 0; i += 1) {
      room = Math.min(room - (text.length - FIRST_MESSAGE_BUDGET), fit.text.length - 1);
      fit = fitRules(g0.rules, room);
      text = 組む({ ...g0, rules: fit.text, omitted: fit.omitted });
    }
    if (typeof report === 'function') {
      report({ omitted: fit.omitted, kept: fit.text.length, total: String(g0.rules).length, length: text.length });
    }
  }
  return projectRules ? dropCoveredRules(text) : text;
}

const TOOL_ALIASES = {

  Bash: 'run_command',
  Grep: 'search',
  Glob: 'glob',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  TodoWrite: 'update_todos',
  AskUserQuestion: 'ask_user',
  Task: 'spawn_agents',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',

  execute_command: 'run_command',
  executeCommand: 'run_command',
  write_to_file: 'write_file',
  apply_diff: 'edit_file',
  search_files: 'search',
  searchFiles: 'search',
  list_files: 'list_dir',
  update_todo_list: 'update_todos',
  ask_followup_question: 'ask_user',
  new_task: 'spawn_agents',
  attempt_completion: 'done',

  exec_command: 'run_command',
  unified_exec: 'run_command',
  shell: 'run_command',
  apply_patch: 'edit_file',
  update_plan: 'update_todos',
  request_user_input: 'ask_user',
};

function toolAlias(name) {
  const n = String(name || '');
  return Object.prototype.hasOwnProperty.call(TOOL_ALIASES, n) ? TOOL_ALIASES[n] : n;
}

const TOOL_USE_ID = /^toolu_[A-Za-z0-9_-]{1,64}$/;

function normalizeCall(obj) {

  if (obj && obj.type === 'tool_use') {
    if (typeof obj.name !== 'string' || !obj.name) {

      const 名前かも =
        typeof obj.id === 'string' && obj.id && !TOOL_USE_ID.test(obj.id) ? obj.id : '';
      if (名前かも) {
        return {
          bad:
            `tool_use に name がありません（\`id\` の枠に "${名前かも}" が入っています）。` +
            'ツールの名前は `name` へ、`id` には toolu_ で始まる一意な印を書いてください。',
        };
      }
      return { bad: 'tool_use に name がありません' };
    }
    if (typeof obj.id !== 'string' || !TOOL_USE_ID.test(obj.id)) {

      if (typeof obj.id === 'string' && /[…]|\.\.\./.test(obj.id)) {
        return {
          bad:
            `id が穴埋めのままです（来たもの: ${obj.id}）。` +
            '`…` は「ここに何か書く」という印で、そのまま書く物ではありません。' +
            '`toolu_a1` のように、呼び出しごとに違う印を**あなたが決めて**書いてください。',
        };
      }
      return { bad: `id の形が違います（toolu_ で始まる英数字。来たもの: ${obj.id}）` };
    }
    const input = obj.input && typeof obj.input === 'object' ? obj.input : {};
    return { call: { id: obj.id, bridge_tool: toolAlias(obj.name), ...input } };
  }

  if (obj && typeof obj.bridge_tool === 'string') {
    return { call: { id: null, ...obj } };
  }
  return { bad: 'type が tool_use でも、bridge_tool でもありません' };
}

function withFenceAttrs(body, attrs) {
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return body;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return body;
  return JSON.stringify({
    type: 'tool_use',
    id: attrs.id || obj.id || '',
    name: attrs.name,

    input: obj.input && typeof obj.input === 'object' ? obj.input : obj,
  });
}

function parseToolCalls(text) {
  const calls = [];
  const broken = [];
  const seenIds = new Set();

  const bodies = [];
  for (const { body: raw, attrs } of fenceBodies(text)) {

    const 名札 = attrs && attrs.name ? String(attrs.name) : '';
    for (const obj of jsonObjectsIn(raw)) {

      if (isToolJson(obj)) {

        if (attrs && attrs.id) {
          let o = null;
          try { o = JSON.parse(obj); } catch { o = null; }
          if (o && typeof o === 'object' && typeof o.id !== 'string') {
            bodies.push(JSON.stringify({ ...o, id: String(attrs.id) }));
            continue;
          }
        }
        bodies.push(obj);
        continue;
      }

      if (名札) bodies.push(withFenceAttrs(obj, attrs));
    }
  }
  for (const body of bodies) {
    let obj;
    try {
      obj = JSON.parse(body);
    } catch (e) {
      broken.push({ body: body.slice(0, 400), reason: `JSON として読めない: ${e.message}` });
      continue;
    }
    const r = normalizeCall(obj);
    if (r.bad) {
      broken.push({ body: body.slice(0, 400), reason: r.bad });
      continue;
    }

    if (r.call.id) {
      if (seenIds.has(r.call.id)) {
        broken.push({
          body: body.slice(0, 400),
          reason: `同じ id を 2 回使っています: ${r.call.id}`,
        });
        continue;
      }
      seenIds.add(r.call.id);
    }
    calls.push(r.call);
  }

  if (calls.length === 0 && broken.length === 0) {
    for (const needle of ['tool_use', 'bridge_tool']) {
      if (!text.includes(needle)) continue;
      broken.push({

        kind: 'mentioned',
        body: extractAround(text, needle),
        reason: `本文に ${needle} があるのに、コードブロックとして取り出せなかった`,
      });
      break;
    }
  }

  return { calls, broken };
}

function extractAround(text, needle) {
  const i = text.indexOf(needle);
  return text.slice(Math.max(0, i - 200), i + 400);
}

function formatResults(results, budget = 0) {
  const head = ['ツールの結果です。続けてください。', ''];
  const wrap = (r, content) => {
    const block = { type: 'tool_result' };
    if (r.id) block.tool_use_id = r.id;
    block.content = content;
    if (!r.ok) block.is_error = true;
    return ['```json', JSON.stringify(block), '```', ''];
  };
  const bodies = results.map((r) => String(r.output == null ? '' : r.output));
  const full = head.concat(...results.map((r, i) => wrap(r, bodies[i]))).join('\n');
  if (!budget || full.length <= budget) return full;

  const overhead = 120;
  const share = Math.max(
    200,
    Math.floor((budget - head.join('\n').length) / Math.max(1, results.length)) - overhead
  );
  const cut = (t, 取り分) => {
    if (t.length <= 取り分) return t;
    const keep = Math.max(100, 取り分 - 60);
    const h = Math.floor(keep * 0.7);
    return (
      t.slice(0, h) +
      `\n…（この結果はここで ${t.length - keep} 文字を省きました。要るなら範囲を指定して読み直してください）\n` +
      t.slice(t.length - (keep - h))
    );
  };
  const 組む = (取り分) =>
    head.concat(...results.map((r, i) => wrap(r, cut(bodies[i], 取り分)))).join('\n');

  let 取り分 = share;
  let out = 組む(取り分);
  for (let i = 0; i < 6 && out.length > budget && 取り分 > 200; i += 1) {

    取り分 = Math.max(200, Math.floor(取り分 * (budget / out.length) * 0.95));
    out = 組む(取り分);
  }
  return out;
}

function buildGoalCheck({ goal, summary, wrote }) {
  const shown = (Array.isArray(wrote) ? wrote : []).slice(0, 40);
  return [
    'あなたは審判です。作業はしません。**満たされたかどうかだけ**を答えてください。',
    '',
    '【目当て】',
    String(goal || ''),
    '',
    '【相手が「終わった」と言った時の要約】',
    String(summary || '（要約なし）'),
    '',
    '【この作業で書き換えたファイル】',
    shown.length ? shown.join('\n') : '（無し）',
    '',
    '満たされているなら、1 行目に **MET** とだけ書いてください。',
    '満たされていないなら、1 行目に **NOT_MET** と書き、2 行目以降に',
    '**何が残っているか**を、そのまま作業の指示として読める形で書いてください。',
    '（あなたはワークスペースを読めます。要約を鵜呑みにせず、実際に確かめてください。）',
  ].join('\n');
}

function buildGoalContinue({ goal, left }) {
  return [
    '利用者が決めた目当てが、まだ満たされていません。',
    '',
    '【目当て】',
    String(goal || ''),
    '',
    '【審判が見たところ、残っていること】',
    String(left || ''),
    '',
    '続けてください。満たせたら done を出してください。',
  ].join('\n');
}

function formatBrokenNotice(broken) {
  const lines = [
    'ツールのコードブロックが読めませんでした。書式を直して出し直してください。',
    '',
    '（コードブロックを分けること、1 つのコードブロックに複数書くこと、コードブロックの前後に文章を書くことは、',
    'どれも問題ありません。読めなかったのは下の理由だけです。）',
    '',
  ];
  for (const b of broken) {
    lines.push(`理由: ${b.reason}`);
    lines.push(b.body);
    lines.push('');
  }
  return lines.join('\n');
}

function writeFileRecall(済み) {

  const n = 済み && 済み.n ? Number(済み.n) : 0;
  const 内訳 = 済み && 済み.名 ? 済み.名 : {};
  const 多い = Object.entries(内訳).sort((a, b) => b[1] - a[1])[0];
  const 実績 = n
    ? [
        '',
        `**この対話で、あなたは既に ${n} 回ツールを呼び、${n} 回とも結果が返っています**` +
          (多い ? `（いちばん多いのは ${多い[0]} の ${多い[1]} 回）。` : '。'),
        'その結果は、この人のディスクから実際に読み出した中身です。捏造ではありません。',
        '`write_file` も**まったく同じ道**を通ります。呼べば、実際に書かれます。',
      ]
    : [];
  return [
    ...実績,
    '',
    '**呼び方をここに置き直します。**対話が長くなると、頭で渡した決まりが',
    '流れて行くことがあります。**これは在ります。いま使えます:**',
    '',

    '**これは関数呼び出しの口ではありません。**別に用意された介面を探さないでください。',
    '**返事の中に下の JSON を書くこと、それ自体が呼び出しです。**',
    '',
    '{"type":"tool_use","id":"toolu_01a","name":"write_file",' +
      '"input":{"path":"（あなたが決める名前）.html","content":"（ここに、作った中身をぜんぶ）"}}',
    '',

    '**上の丸括弧は、そのまま書く物ではありません。**名前はあなたが決め、',
    'content には作った中身を**ぜんぶ**入れてください（「…」や空のままは駄目です）。',
    'path はワークスペースからの相対です。あなたの側の保存先（/mnt/data など）',
    'ではありません。あちらに置いた物は、頼んだ人の手元には届きません。',
  ].join('\n');
}

const COVERED = [
  ['できない所が出ても、できる所は最後までやってください', '報せ方'],
  ['掃除や検査を頼まれた時', '報せ方'],
  ['確かめた事と、そう思っただけの事を分けて書いてください', '報せ方'],
  ['「全部見ました」と書く前に', '報せ方'],
  ['取れなかった物を「問題なし」に混ぜないでください', '報せ方'],

  ['いま現在の事実に依るものは、記憶で答えないでください', '取ってきてから答える'],
  ['「この環境では調べられない」と決めつけないでください', '「この環境では調べられない」と決めつけないでください'],
  ['上の 2 つは組でひとつです', '上の 2 つは組でひとつです'],
  ['調べられなかった時は、黙って推測で埋めないでください', '終わり方'],
  ['足りない情報は、聞く前に自分で取りに行ってください', '聞く前に、自分でやる'],
  ['段取りを説明しただけで止まらないでください', '終わり方'],
  ['ツールを呼ぶ前に、これから何をするかを 1 行書いてください', '動く前に、一言'],
  ['調べる時ほど、まとめて書いてください', 'まとめて呼ぶ'],
  ['頼り合っていない呼び出しは、まとめて並べてください', 'まとめて呼ぶ'],
  ['分ける印は**ツールの種類ではなく、頼り合っているか**です', 'まとめて呼ぶ'],
  ['直すときは edit_file を使ってください', '直し方'],
  ['直す前に、その道を read_file で読んでください', '直す前に読む'],
  ['既に在るファイルを write_file で書き換える前に', '直す前に読む'],
  ['頼まれたものを作り終えてから', '終わり方'],

  ['ただし、下の仕事は run_command ではなくツールを使ってください', '直し方'],
  ['独立した命令は、1 つずつ分けて同じターンに並べてください', '直し方'],
  ['前の結果が要る物は、`&&` や `|` で繋いで 1 回で出してください', '直し方'],
  ['知っているつもりのことでも、確かめられる物は確かめてください', 'ウェブ'],
  ['調べ物を頼まれたら、web_fetch で取ってきてから答えてください', 'ウェブ'],
  ['場所（URL）を渡されたら、まず web_fetch で開いてください', 'ウェブ'],
  ['web_fetch は、利用者が出した場所にだけ行けます', 'ウェブ'],
  ['ひかえめにするのは「跡の残ること」だけです', '聞く前に、自分でやる'],
  ['ツールは、必要な時だけ使ってください', '聞く前に、自分でやる'],
  ['何をしてほしいのか分からない時は、勝手に決めずに ask_user で聞いてください', '聞く前に、自分でやる'],
];

function dropCoveredRules(text) {
  const lines = String(text).split('\n');
  const out = [];
  let dropping = false;
  for (const line of lines) {
    const 条項 = /^ {2}- /.test(line);
    if (条項) dropping = COVERED.some(([mark]) => line.includes(mark));
    else if (dropping && !/^ {4,}\S/.test(line)) dropping = false;
    if (!dropping) out.push(line);
  }
  return out.join('\n');
}

module.exports = {
  FIRST_MESSAGE_RESERVE,
  FIRST_MESSAGE_BUDGET, buildGoalCheck, buildGoalContinue, COVERED, languagePreference,
  looksLikeBareCall,
  jsonObjectsIn, buildInstruction, writeFileRecall, parseToolCalls, formatResults, formatBrokenNotice, toolAlias, TOOL_ALIASES };
