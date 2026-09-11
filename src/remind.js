const DRIFT =
  /\/mnt\/data|Library\s*(に|は|で|内|から|搜尋|検索|search)|添付して|渡してください|アップロードして/i;

const MADE_FILE =
  /sandbox:\/mnt\/data|sandbox:\/|\/mnt\/data\/[^\s`'")]+\.[a-z0-9]{2,5}/i;

const REMAKE = [
  "<system-reminder>",
  "いま、あなたの側の実行環境にファイルを作ったようです。",
  "**その場所は別の機械なので、この人には届きません。**",
  "ダウンロードの案内も、この人のツールからは開けません。",
  "",
  "同じ中身を、`write_file` でこの人のワークスペースへ書き直してください。",
  "字でない物（画像・PDF など）は base64 で渡してください。",
  "作り直す必要はありません。**書き出す先を変えるだけです。**",
  "</system-reminder>",
].join("\n");

const EVERY = 1;

const DELIVER = [
  "<system-reminder>",
  "**ファイルの渡し方。**",
  "",

  "あなたが中身を作って渡す時は、**返事の本文に貼らないでください。**",
  "`write_file` でこの人のワークスペースへ書き、書いた場所を伝えてください。",
  "",
  "**これは、どの言語で・どんな言い方で頼まれても同じです。**",
  "日本語でも、中国語でも、英語でも変わりません。",
  "「作って」「ください」「出して」「給我」「make」「give me」——言い方は問いません。",
  "",
  "**当てはまる物**（形式は問いません）:",
  "HTML・Markdown・CSV・JSON・設定ファイル・スクリプト・報告書・一覧・",
  "長い文章——**ファイルとして受け取る物すべて**。",
  "",
  "**当てはまらない物**: 短い答え、説明、相談、コードの一部を見せながらの解説。",
  "これらは今までどおり本文で構いません。",
  "",
  "迷ったら**書いてください**。本文に貼ると、この人は手で写す必要があります。",
  "字でない物（画像・PDF など）は base64 で `write_file` に渡してください。",
  "",

  "</system-reminder>",
].join("\n");

const SANDBOX = [
  "<system-reminder>",
  "あなたの側の実行環境（Python が走る場所。`/mnt/data` や `/`）と、",
  "この対話のファイルの記録室（Library）は、**この人のワークスペースとは別の場所**です。",
  "そこを探しても、この人のファイルは出て来ません。出て来ないことは、",
  "ファイルが無いことの証拠になりません。",
  "あなたの側にファイルを作っても、この人には届きません。",
  "ダウンロードの案内も、この人のツールからは取れません。",
  "",
  "ワークスペースに触れるのは、上で渡したツールだけです",
  "（読むなら list_dir / read_file / search、**書くなら write_file / edit_file**）。",
  "**ファイルやパスを教えてくれと頼まないでください。**必要な物は自分で読めます。",
  "大きいファイルは offset と limit で続きを読めます。",
  "</system-reminder>",
].join("\n");

const READONLY_EXIT = [
  "",
  "**いまは読むだけのモード（plan）です。**ファイルは書けません。",
  "ファイルを作る必要が出たら、**`exit_plan_mode` で計画を出してください。**",
  "この人が通せば、そこから書けるようになります。",
  "**書けないまま「作りました」と言わないでください。**",
  "別のツールで書こうとするのもやめてください（どれも通りません）。",
].join("\n");

const SANDBOX_READONLY = SANDBOX.split("\n")
  .filter((l) => !/write_file|edit_file|base64/.test(l))
  .join("\n")
  .replace("</system-reminder>", READONLY_EXIT + "\n</system-reminder>");

const WEAKER = [
  "<system-reminder>",

  "### 呼び方",
  '{"bridge_tool":"list_dir","path":"."}',
  "",
  "この 1 行を返事に書くと、こちらが走らせて結果を返します。",
  "",

  "### 新しいファイルを作る時",
  "**まず 3 行だけ書いてください。**中身は後から `edit_file` で入れます。",
  "いきなり長い中身を渡すと、途中で「この口は無い」と思いやすくなります。",
  "",
  "### 碼を足したら、置いた位置を自分で確かめる",
  "検査を足した時は、これを走らせてください:",
  "",

  "**その検査だけを名指しで走らせて**、行番号を出してください。",
  "",
  "**行番号が出たら、その行を前の `});` の後ろへ動かしてください。**",
  "",

  "### 検査を足したら",
  "1. 直した所を**一時的に元へ戻す**",
  "2. 検査を走らせて、**落ちること**を見る",
  "3. **すぐ直しへ戻す**",
  "落ちなかったら、その検査は何も守っていません。",
  "",
  "### この返事ですること",

  "**まず上の 1 行を、そのまま 1 回 書いてください。**説明は要りません。",
  "結果が返ってきたら、そこから続けてください。",
  "</system-reminder>",
].join("\n");

function modelNote(slug) {
  return profileFor(slug) === "dead" ? WEAKER : "";
}

function toolRoster(names, 済み) {
  const 並び = (names || []).filter(Boolean);
  if (!並び.length) return "";

  const 見本 = 並び.includes("write_file") ? "write_file" : 並び[0];

  const 引数 =
    見本 === "write_file"
      ? '{"path":"（あなたが決める名前）.html","content":"（ここに、作った中身をぜんぶ）"}'
      : "{（このツールの入力）}";

  const n = 済み && 済み.n ? Number(済み.n) : 0;
  const 実績 = n
    ? `**この対話で既に ${n} 回呼び、${n} 回とも結果が返っています。**実際に走ります。`
    : "";
  return [
    "<system-reminder>",
    `いま使えるもの: ${並び.join(" / ")}`,
    ...(実績 ? [実績] : []),

    "**これは関数呼び出しの口ではありません。**別に用意された介面を探さないでください。",
    "**返事の中に下の JSON を書くこと、それ自体が呼び出しです。**書けば、こちらが",
    "実行して結果を返します。「ツール介面に無い」は当てはまりません——介面はこれです。",
    "「この実行環境には無い」「利用可能なツール一覧に出ていない」と考えないでください。",
    "呼び方はこれだけです（name を変えるだけ）:",
    `{"type":"tool_use","id":"toolu_a1","name":"${見本}","input":${引数}}`,
    "**丸括弧の中は、そのまま書く物ではありません。**あなたが決めた名前と、",
    "あなたが作った中身に置き換えてください。id も呼び出しごとに違う物を。",
    "</system-reminder>",
  ].join("\n");
}

function todoReminder(todos) {
  const list = Array.isArray(todos) ? todos.filter((x) => x && x.content) : [];
  if (!list.length) return "";
  const 残り = list.filter((x) => x.status !== "completed");
  if (!残り.length) return "";
  const 印 = (st) =>
    st === "completed" ? "済" : st === "in_progress" ? "いま" : "まだ";
  return [
    "<system-reminder>",
    "いま出ている「やること」の一覧です。**これはあなたが作った物です。**",
    ...list.map((x) => `  [${印(x.status)}] ${x.content}`),
    `のこり ${残り.length} 件。`,
    "**始める前に in_progress にし、終わったらすぐ completed にしてください**",
    "（update_todos で一覧ぜんぶを送り直します）。いま進んでいる物は 1 つだけに。",
    "のこりが在るうちは done を出さないでください。",
    "</system-reminder>",
  ].join("\n");
}

const { languagePreference } = require("./protocol");
const { profileFor } = require("./modelprofile");

function languageLine(locale) {
  if (!locale) return "";
  return languagePreference(locale);
}

function reminderFor({
  answer = "",
  turn = 0,
  readOnly = false,
  names = [],
  済み = null,
  todos = null,

  inProject = false,

  locale = "",

  modelSlug = "",
} = {}) {
  const 本体 = readOnly ? SANDBOX_READONLY : SANDBOX;

  const drifted = DRIFT.test(String(answer || ""));

  if (!readOnly && MADE_FILE.test(String(answer || ""))) return REMAKE;

  const roster = toolRoster(names, 済み);

  const 動かない段 = readOnly ? 本体 : DELIVER + "\n\n" + 本体;
  const 中身 = inProject ? "" : 動かない段;
  const 束 = roster && 中身 ? roster + "\n\n" + 中身 : roster || 中身;

  const やること = todoReminder(todos);

  const 言葉 = languageLine(locale);

  const 相手 = modelNote(modelSlug);
  const 添える = (x) => {
    const 並び = [相手, 言葉, x].filter(Boolean);
    return 並び.length ? 並び.join("\n\n") : "";
  };
  if (turn > 0 && turn % EVERY === 0)
    return 添える(やること ? やること + "\n\n" + 束 : 束);
  if (drifted) return 添える(やること ? やること + "\n\n" + 束 : 束);
  return 添える(やること);
}

function withReminder(message, note) {
  if (!note) return String(message || "");
  return note + "\n\n" + String(message || "");
}

module.exports = {
  modelNote,
  WEAKER,
  todoReminder,
  reminderFor,
  toolRoster,
  withReminder,
  DRIFT,
  MADE_FILE,
  EVERY,
  SANDBOX,
  SANDBOX_READONLY,
  DELIVER,
  REMAKE,
};
