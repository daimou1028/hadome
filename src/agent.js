const {
  buildInstruction,
  parseToolCalls,
  formatResults,
  formatBrokenNotice,
  writeFileRecall,
} = require('./protocol');
const { trimForSend, SEND_LIMIT } = require('./toolong');
const { reminderFor, withReminder } = require('./remind');
const { profileFor, evidenceFor, shouldRestart } = require('./modelprofile');
const { parseLimitNotice } = require('./limitnotice');
const { noteUnknown } = require('./unknowntools');

const { noteStreamCut } = require('./streamcuts');

const 命令の頭 = /^(git|npm|node|npx|ls|cat|grep|find|sed|awk|rm|mv|cp|mkdir|python3?|uv|php|composer|curl|make|bash|sh)(\s|_|$)/i;
function 命令に見える(名) {
  const s2 = String(名 || '').trim();
  if (!s2) return false;
  return 命令の頭.test(s2) || /\s/.test(s2);
}
const { collectUrls } = require('./webfetch');
const { makeTools, ensureRestorePoint, DEFAULT_ALLOWLIST, normalizeCall } = require('./tools');
const hooks = require('./hooks');

const { proseOf } = require('./prose');
const {
  matchSkills,
  needsSkillFirst,
  needsFileFirst,
  needsDetailKept,
  needsRealContent,
} = require('./skillmatch');

const SHORT_TURN_CHARS = 200;

function allProse(history) {
  const parts = [];
  for (const h of history || []) {
    const t = proseOf(h.answer, false).trim();
    if (!t) continue;
    parts.push(t);
  }
  if (parts.length <= 1) return parts.join('\n\n');

  const meaty = parts.filter((p) => p.length >= SHORT_TURN_CHARS);
  return (meaty.length ? meaty : parts).join('\n\n');
}

function targetOf(call) {
  return call.path || call.command || call.name || '';
}

const DEFAULT_MAX_TURNS = 0;
const DEFAULT_MAX_SILENT = 2;

const MAX_THIN_REFUSALS = 5;

const MAX_TODO_REFUSALS = 3;

const MAX_BG_REFUSALS = 3;

const MAX_GOAL_CHECKS = 8;

function 名指しを確かめる(root, summary, seam = {}) {
  const exists = seam.exists || ((p) => fs.existsSync(p));
  const list = seam.list || (() => fs.readdirSync(root));

  const 名 = String(summary || '').match(/[^\s"'`<>|:*?、。「」（）,]+\.(html?|md|json|csv|txt|pdf|png|jpe?g|svg)\b/gi) || [];
  if (!名.length) return '';
  const 無い = [];
  for (const n of [...new Set(名)].slice(0, 5)) {
    const 素 = n.replace(/^.*[/\\]/, '');
    try {
      if (!exists(path.join(root, 素)) && !exists(path.join(root, n))) 無い.push(n);
    } catch {
      無い.push(n);
    }
  }
  if (!無い.length) return '';
  let 中身 = [];
  try {
    中身 = list().slice(0, 40);
  } catch {
    中身 = [];
  }
  return (
    `\n**いまワークスペースを見ました。${無い.map((x) => `\`${x}\``).join(' / ')} は在りません。**` +
    `（見たのは ${root}。${中身.length} 個のファイルを数えました）\n` +
    'あなたの側の保存先や、別の保存の道に置いた物は、この人の手元には届きません。' +
    '**この対話の `write_file` で書いた物だけが届きます。**'
  );
}

const WRITE_TOOL_NAMES = [
  'write_file',
  'edit_file',
  'notebook_edit',
  'run_command',
  'spawn_agents',
  'config',
  'enter_worktree',
  'exit_worktree',
  'codebase_search',
  'read_command_output',
  'switch_mode',
];

const MAX_BROKEN_ROW = 4;

const MAX_SAME_CALL = 3;

function callFingerprint(call) {
  const o = {};
  for (const k of Object.keys(call).sort()) {
    if (k === 'id') continue;
    o[k] = call[k];
  }
  return JSON.stringify(o);
}

const TOOL_STATE = {
  done: 'done',
  failed: 'failed',
  askedAgain: 'askedAgain',
};

function toolStateOf(r) {
  if (r.askedAgain) return TOOL_STATE.askedAgain;
  return r.ok ? TOOL_STATE.done : TOOL_STATE.failed;
}

const MAX_OPTIONS = 4;
function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const o of raw) {
    if (out.length >= MAX_OPTIONS) break;

    const label = String((o && o.label) || o || '').trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, description: String((o && o.description) || '').trim() });
  }

  return out.length >= 2 ? out : null;
}

const TOUCHING_WORDS =
  /直す|直し|修正|変更|変える|置き換|書き換|足す|追加|作る|作成|削除|消す|反映|適用|修改|變更|新增|加入|建立|刪除|fix|change|update|add|create|remove|apply|write/i;

const READ_ONLY_TAIL =
  /(確認|検査|調査|調べ|取得|読み?取|読む|見る|洗い出|数え|確定|把握|一覧|列挙|確認する|檢查|確認|取得|閱讀)(する|します|して|し)?[。．.]?\s*$/;

function todoTouches(content) {
  const t = String(content || '').trim();
  if (!t) return false;

  if (READ_ONLY_TAIL.test(t)) return false;
  return TOUCHING_WORDS.test(t);
}

const LISTS_CHOICES = (() => {

  const 印 = [
    /[①-⑳].*?[①-⑳]/s,
    /[⑴-⒇].*?[⑴-⒇]/s,
    /(^|\s)1[.)、].*?(^|\s)2[.)、]/s,
    /(^|\s)[AaＡ][.)、].*?(^|\s)[BbＢ][.)、]/s,
  ];
  return { test: (q) => 印.some((r) => r.test(String(q || ''))) };
})();

const WANTS_PERMISSION = (() => {

  const plain =
    /許可|許し|よいですか|いいですか|実行して(も)?よ|走らせて(も)?よ|授權|授权|允許|允许|可以(执行|執行|運行|运行)|permission|may I run|can I run|allow me to run/i;

  const confirm = /確認|確定|よろしいですか|進めて(も)?よ|proceed|shall I|go ahead/i;
  const action = /実行|執行|执行|走らせ|更新|変更|變更|变更|run|update|change|delete|削除/i;
  return {
    test: (q) => {
      const t = String(q || '');
      return plain.test(t) || (confirm.test(t) && action.test(t));
    },
  };
})();

const FIRST_MESSAGE_WARN_CHARS = 18000;

const DEFAULT_MAX_FAILING = 3;

async function runAgent(options) {
  let ツール = null;
  let 結果 = null;
  try {
    結果 = await runAgentBody(options, (t) => {
      ツール = t;
    });
    return 結果;
  } finally {
    if (ツール && typeof ツール.stopBackground === 'function') {
      try {

        ツール.stopBackground({ closeTabs: false });
      } catch {

      }
    }
  }
}

async function runAgentBody({
  bridge,
  root,
  task,
  allowlist = DEFAULT_ALLOWLIST,
  denylist = undefined,
  maxTurns = DEFAULT_MAX_TURNS,
  maxSilent = DEFAULT_MAX_SILENT,
  maxFailing = DEFAULT_MAX_FAILING,
  workspaceName = root,

  locale = 'ja',

  outputStyle = null,

  tr = null,
  onLog = () => {},

  onNotice = null,
  onDelta = null,

  onBusy = null,

  onImage = null,

  onModel = null,
  onAutoSwitch = null,

  restartGapMs = undefined,

  mcp = null,

  mode = 'edit',

  onCommandOutput = null,
  onTodos = null,

  onTurn = () => {},

  seenUrls = null,

  readSkills: readSkillsIn = null,

  hookConfig = null,

  files = null,
  onUpload = () => {},

  onTurnsExhausted = null,

  onFailingStreak = null,

  onSilentStreak = null,

  onDowngrade = null,

  sleepMs = (ms) => new Promise((r) => setTimeout(r, ms)),

  waitCapMs = 6 * 60 * 60 * 1000,

  now: nowFn = () => Date.now(),

  onTodosOpen = null,

  isInProject = null,

  perTurnLanguage = true,

  hasProjectRules = null,

  onGoalCheck = null,

  spawnAgents = null,

  readOnly = false,

  disabledTools = [],

  modes = [],

  startMode = '',

  beforeTouch = null,

  planMode = false,

  onExitPlan = null,

  readSetting = null,
  writeSetting = null,

  respectGitIgnore = true,

  preventDoneWithOpenTodos = true,

  onAnswer = () => {},

  onTool = () => {},

  onNoRestorePoint = () => {},

  includeInstruction = true,

  shouldStop = () => false,

  requireRestorePoint = false,

  protectSecrets = true,

  global: globalRules = null,

  askPermission = null,

  allowedOutside = [],
  allowedOutsideWrite = [],
  allowedMcpServers = [],
  allowedSites = [],

  openTabs = null,

  onOpenTabs = null,

  onAllowAlways = null,

  isRevoked = null,

  thinking = undefined,
}, onTools) {

  const 背景の走り = [];
  let 背景の連番 = 0;
  const spawnInBackground = spawnAgents
    ? async (tasks, opts = {}) => {

        if (opts.wait) return spawnAgents(tasks);
        背景の連番 += 1;
        const rec = {
          id: `agent${背景の連番}`,
          tasks: tasks.map((x) => String(x)),
          done: false,
          taken: false,
          r: null,
        };

        (async () => {
          try {
            rec.r = await spawnAgents(tasks);
          } catch (e) {
            rec.r = { why: String((e && e.message) || e) };
          }
          rec.done = true;
        })();
        背景の走り.push(rec);
        return { started: rec.id, n: rec.tasks.length };
      }
    : null;

  const 背景の実り = () => {
    const 出来た = 背景の走り.filter((x) => x.done && !x.taken);
    出来た.forEach((x) => {
      x.taken = true;
    });
    return 出来た;
  };
  const 背景ののこり = () => 背景の走り.filter((x) => !x.done).length;

  const 添える物 = [];

  const tools = makeTools({
    root,
    onAttach: (f) => {
      if (f && f.b64) 添える物.push(f);
    },
    allowlist,
    denylist,
    protectSecrets,
    spawnAgents: spawnInBackground || spawnAgents,
    readOnly,
    askPermission,
    onAllowAlways,
    isRevoked,
    allowedOutside,
    allowedOutsideWrite,
    allowedMcpServers,
    allowedSites,
    openTabs,
    onOpenTabs,
    mcp,
    mode,

    modes,
    startMode,
    beforeTouch,
    planMode,
    onExitPlan,
    readSetting,
    writeSetting,
    respectGitIgnore,
    onCommandOutput,
    onTodos: (todos) => {
      lastTodos = Array.isArray(todos) ? todos : [];
      if (onTodos) onTodos(todos);
    },

    seenUrls: (() => {
      const set = seenUrls instanceof Set ? seenUrls : new Set();
      for (const u of collectUrls(String(task || ''))) set.add(u);
      return set;
    })(),
  });
  if (onTools) onTools(tools);
  const history = [];
  let silent = 0;

  let remindedDeadModel = false;

  let 送った字 = 0;

  let goalChecks = 0;

  let calledEver = 0;

  let modelSlug = '';

  try {
    if (process.env.BRIDGE_NO_LAST_MODEL === '1') throw new Error('検査では読まない');
    const 印 = require('path').join(require('os').tmpdir(), 'panel-run-last-model.txt');
    const 前 = require('fs').readFileSync(印, 'utf8').trim();
    if (前) {
      modelSlug = 前;
      onLog(`[agent] 1 通目は前の走りの相手（${前}）で当てます`);
    }
  } catch {

  }
  let downgraded = false;

  let downgradeDecided = false;
  let waitsForStrong = 0;
  const MAX_WAITS = 2;

  let lastStrongSlug = '';

  const readSkills = readSkillsIn || new Set();
  const namedSkills =
    globalRules && globalRules.skills ? matchSkills(task, globalRules.skills).map((h) => h.skill) : [];
  const refusedFor = new Set();

  let wroteAny = false;

  let touched = 0;

  let claimedWithoutTouching = false;

  let lastTodos = [];

  let doneRefusals = 0;

  let todoRefusals = 0;

  let emptyDones = 0;
  let movedSinceDone = false;

  let bgRefusals = 0;

  const wrotePaths = [];

  let gathered = 0;

  let thinRefusals = 0;

  let brokenRow = 0;

  let askedWithoutOptions = false;

  let askedForPermission = false;

  let skillRefused = false;

  let lastCall = null;
  let sameCallRow = 0;

  let taughtSplit = false;

  let firstSilentAnswer = '';
  let failing = 0;

  let startSha = null;

  const REFUSAL =
    /接続されてい|存在(せず|しなかった|しません|していません)|(使える|利用可能な)ツール[^。]{0,20}(あり|ませ|無い|ない|接続)|(ツール|呼び出し口)[^。]{0,20}公開されて(おらず|いない|いません)|利用可能な(状態になってい|ファイル領域)|ツールが(無|な)い|読めるファイルがない|mnt\/data|Library\s*(搜尋|検索|search)/i;

  const POLICY = /コンテンツポリシー|content\s*polic(y|ies)|usage\s*polic(y|ies)に違反/i;

  function firstLineOf(text, re) {
    for (const line of String(text || '').split(/\r?\n/)) {
      if (re.test(line)) return line.trim().slice(0, 200);
    }
    return String(text || '').trim().slice(0, 200);
  }

  function silentNudge() {
    return [
      '前の返答にツールのコードブロックがありませんでした。次のどれかで答えてください。',
      '',
      '  1. 用が済んでいるなら {"type":"tool_use","id":"toolu_…","name":"done","input":{"summary":"…"}}',
      '  2. こちらに聞かないと決められないことがあるなら',
      '     {"type":"tool_use","id":"toolu_…","name":"ask_user","input":{"question":"…"}}',
      '  3. まだ済んでおらず、聞くことも無いなら、**そのまま次の一手を進めてください。**',
      '     段取りを説明しただけで止まらないでください。こちらが促すのを待つ必要はありません。',
      '  4. 雑談や質問への返事で、そもそもすることが無いなら、1. の done で終わってください。',
      '     summary には、いま答えたことの要点を短く書いてください。',
      '     **「ありません」のような一言を、コードブロックの外に書かないでください。**',
      '     コードブロックの外に書いた文はそのまま画面に出るので、中身の無い一言が残ります。',
      '',
      '**することが無いのに、頼まれていない書き換えをしてはいけません。**',
    ].join('\n');
  }

const TURN_PACE_MIN_MS = Number(process.env.BRIDGE_TURN_PACE_MIN ?? 2000);
const TURN_PACE_MAX_MS = Number(process.env.BRIDGE_TURN_PACE_MAX ?? 11000);

  const RESTART_GAP_MS = Number.isFinite(Number(restartGapMs)) ? Math.max(0, Number(restartGapMs)) : 20000;
  let lastRestartAt = 0;

  async function remakeConversation() {
    const since = lastRestartAt ? Date.now() - lastRestartAt : Infinity;

    const 揺れ = Math.floor(Math.random() * Math.max(1, Math.round(RESTART_GAP_MS * 0.4)));
    const 目安 = RESTART_GAP_MS + 揺れ;
    if (since < 目安) {
      const wait = 目安 - since;
      onLog(`[agent] 対話を続けて作らないよう ${Math.round(wait / 1000)} 秒あけます`);
      if (onNotice) onNotice({ kind: 'pace', ms: wait });
      await new Promise((r) => setTimeout(r, wait));
    }
    lastRestartAt = Date.now();

    remindedDeadModel = false;
    return bridge.newConversation();
  }

  async function readLimitNotice() {
    if (!bridge.readNotice) return null;
    try {
      const r = await bridge.readNotice();
      if (!r || !r.ok) return null;
      return parseLimitNotice(r.texts || [], nowFn());
    } catch {
      return null;
    }
  }

  async function waitForStrong(until) {
    const start = nowFn();
    const 揺れ = 30 * 1000 + Math.floor(Math.random() * 60 * 1000);
    let target = until ? until + 揺れ : start + 10 * 60 * 1000;
    for (;;) {
      while (nowFn() < target) {
        if (shouldStop()) return false;
        await sleepMs(Math.min(15 * 1000, Math.max(0, target - nowFn())));
      }
      if (shouldStop()) return false;

      const 帯 = await readLimitNotice();
      if (!帯 || !帯.until || 帯.until <= nowFn()) return true;
      if (nowFn() - start > waitCapMs) {
        onLog(`[agent] ${Math.round(waitCapMs / 60000)} 分 待っても解けないので、待つのをやめます`);
        return true;
      }
      onLog(`[agent] まだ制限中です（${帯.hhmm} まで）。待ち直します`);
      target = 帯.until + 揺れ;
    }
  }

  const MAX_RESTARTS = 2;
  let restarts = 0;
  const canRestart = () => restarts < MAX_RESTARTS;
  const restartLabel = () => `${restarts}/${MAX_RESTARTS} 回目`;
  let firstMessage = '';

  let handedOver = 0;
  const HAND_OVER_MAX = 3;

  async function handOverIfAsked(said) {
    if (handedOver >= HAND_OVER_MAX) return null;
    const text = String(said || '');

    const paths = (text.match(/[A-Za-z0-9_][\w./-]{1,60}/g) || [])
      .map((x) => x.replace(/^[./]+/, '').replace(/[.,、。]+$/, ''))
      .filter((x) => x && !x.startsWith('http') && !/^\d+$/.test(x))
      .slice(0, 10);

    const range = /(\d{1,6})\s*[〜~\-–]\s*(\d{1,6})\s*行/.exec(text);
    for (const p of paths) {

      let out = null;
      let how = '';
      try {
        const input = { path: p };
        if (range) {
          input.offset = Number(range[1]);
          input.limit = Math.max(1, Number(range[2]) - Number(range[1]) + 1);
        }
        const r = await tools.read_file(input);
        if (r && r.output) {
          out = r.output;
          how = 'read_file';
        }
      } catch {

      }
      if (!out) {
        try {
          const r = await tools.list_dir({ path: p });
          if (r && r.output) {
            out = r.output;
            how = 'list_dir';
          }
        } catch {

        }
      }
      if (!out) continue;
      handedOver += 1;
      onLog(
        `[agent] 相手が求めた ${p}${range ? ` の ${range[1]}〜${range[2]} 行` : ''} を ${how} で渡します` +
          `（${handedOver}/${HAND_OVER_MAX}）`
      );
      return formatResults([{ id: null, ok: true, output: out, tool: how, target: p }], SEND_LIMIT);
    }
    return null;
  }

  async function restartIfRefused(said) {
    if (!canRestart() || !firstMessage || !bridge.newConversation) return '';
    if (!REFUSAL.test(String(said || ''))) return '';
    restarts += 1;
    onLog(`[agent] 相手が「その道具は無い」と言って終わろうとしました。対話を引き直します（${restartLabel()}）`);
    if (onNotice)
      onNotice({ kind: 'restart', why: 'noTool', n: restarts, max: MAX_RESTARTS });
    try {
      await remakeConversation();

      return firstMessage;
    } catch (e) {
      onLog(`[agent] 引き直せませんでした（${e.message}）。そのまま返します`);
      return '';
    }
  }
  let message;
  if (includeInstruction) {

    let proof;
    const proofCalls = [];
    try {
      const ls = await tools.list_dir({ path: '.' });
      proofCalls.push({
        call: '{"type":"tool_use","id":"toolu_proof1","name":"list_dir","input":{"path":"."}}',
        output: ls.output,
      });

      const names = String(ls.output || '')
        .split('\n')
        .map((x) => x.trim())
        .filter((x) => x && !x.endsWith('/'));
      const pick = names.find((x) => /\.(js|ts|php|py|rb|go|java|md|json)$/i.test(x));
      if (pick) {
        const rd = await tools.read_file({ path: pick });
        const head = String(rd.output || '').split('\n').slice(0, 12).join('\n');
        proofCalls.push({
          call: `{"type":"tool_use","id":"toolu_proof2","name":"read_file","input":{"path":"${pick}"}}`,
          output: head + '\n…（ここから先は、あなたが同じように呼べば読めます）',
        });
      }

      proof = proofCalls
        .map((p) => p.output)
        .join('\n\n')
        .trim();
    } catch (e) {
      proof = `（ワークスペースを読めませんでした: ${e.message}）`;
    }
    message =
      buildInstruction({
        workspaceName,
        allowlist,
        proof,
        root,
        global: globalRules,

        report: (r) =>
          onLog(
            `[agent] 1 通目の上限に収めるため、全域の決まりの後ろ ${r.omitted.length} 節を省きました` +
              `（${r.kept} / ${r.total} 字を載せた。1 通目 ${r.length} 字）: ${r.omitted.join(' / ')}`
          ),
        outputStyle,
        locale,
        readOnly,
        disabled: disabledTools,
        modes: modes.map((m) => ({ slug: m.slug, name: m.name, whenToUse: m.whenToUse })),
        startedMode: startMode
          ? (() => {
              const m = modes.find((x) => x.slug === startMode);
              return m ? { name: m.name || m.slug, instruction: m.instruction || '' } : null;
            })()
          : null,
        task,

        mcpNames: mcp && mcp.tools ? mcp.tools.map((x) => x.name) : [],
        mcpResources: mcp && mcp.resources ? mcp.resources : [],

        projectRules: typeof hasProjectRules === 'function' ? !!hasProjectRules() : false,
      }) +
      TASK_MARK +
      task;

    firstMessage = message;
    if (message.length > FIRST_MESSAGE_WARN_CHARS) {
      onLog(
        `[agent] **1 通目が ${message.length} 文字あります**（目安 ${FIRST_MESSAGE_WARN_CHARS}）。` +
          '相手に断られる（413 input_too_large）かもしれません。'
      );
    }
  } else {

    message = '--- 次の作業 ---\n' + task;
  }

  let turnLimit = maxTurns > 0 ? maxTurns : Infinity;

  const 済み = { n: 0,名: {} };

  let refusedEmpty = false;

  for (let turn = 1; ; turn += 1) {
    if (turn > turnLimit) {
      if (!onTurnsExhausted) break;
      const more = await onTurnsExhausted({ turns: turnLimit });
      if (!(more > 0)) break;
      turnLimit += more;
      onLog(`[agent] ターンの上限を ${turnLimit} へ伸ばしました`);
    }
    if (shouldStop()) {
      return { status: 'stopped', reason: '利用者が中断した', startSha, turns: turn - 1, history };
    }

    const prev = history.length ? history[history.length - 1].answer : '';

    const note = reminderFor({
      answer: prev,
      turn,
      readOnly,
      names: [...Object.keys(tools), 'ask_user', 'done'],
      済み,

      inProject: typeof isInProject === 'function' ? !!isInProject() : false,

      todos: lastTodos,

      locale: perTurnLanguage ? locale : '',

      modelSlug,
    });

    if (note) onLog('[agent] 決まりを言い直しました（毎ターン。src/remind.js に理由）');
    message = withReminder(message, note);

    {
      const 実り = 背景の実り();
      if (実り.length) {
        const 束 = 実り
          .map((x) => {
            if (x.r && x.r.why) return `【${x.id}】失敗: ${x.r.why}`;
            const 中身 = (x.r && x.r.text) || '（何も返りませんでした）';
            return `【${x.id}】終わりました（${x.tasks.length} 本）\n${中身}`;
          })
          .join('\n\n');
        const のこり = 背景ののこり();
        message = withReminder(
          message,
          '--- 背景で頼んでいた下請けの実り ---\n' +
            束 +
            (のこり ? `\n\n（まだ ${のこり} 件 走っています）` : '') +
            '\n--- ここまで ---'
        );
        onLog(`[agent] 背景の下請け ${実り.length} 件の実りを差し込みました`);
      }
    }

    let asFile = false;

    let sendText = message;
    const fit = trimForSend(message);
    if (fit.trimmed) {
      asFile = true;
      onLog(`[agent] 送る文が長い（${message.length} 文字）ので、貼り付けてファイルにして送ります`);
      if (onNotice) onNotice({ kind: 'tooLong', chars: message.length, limit: SEND_LIMIT });
    }

    const of = turnLimit === Infinity ? '' : `/${turnLimit}`;
    onLog(`\n=== ターン ${turn}${of} ===（送る文字数 ${message.length}）`);

    onTurn({ turn, limit: turnLimit === Infinity ? null : turnLimit, sent: message.length });

    const t0 = Date.now();

    const askOpts = {};

    if (typeof thinking === 'boolean') askOpts.thinking = thinking;
    if (onDelta) askOpts.onDelta = onDelta;
    if (onBusy) askOpts.onBusy = onBusy;
    if (onImage) askOpts.onImage = onImage;

    askOpts.onModel = (slug) => {
      const name = String(slug || '');
      if (name) {
        if (modelSlug && modelSlug !== name) {

          if (shouldRestart(modelSlug, name)) {
            downgraded = true;
            if (profileFor(modelSlug) !== 'dead') lastStrongSlug = modelSlug;
            const 実 = evidenceFor(name);
            onLog(
              `[agent] 答える相手が ${modelSlug} から ${name} に変わりました` +
                (実 ? `（実測: ${実.answers} 返答で呼び出し ${実.calls} 件）` : '')
            );
          } else {
            onLog(`[agent] 答える相手が ${modelSlug} から ${name} に変わりました（${profileFor(name)}）`);
          }
        }
        modelSlug = name;
      }
      if (onModel) onModel(slug);
    };

    if (onAutoSwitch) askOpts.onAutoSwitch = onAutoSwitch;

    askOpts.shouldStop = shouldStop;
    if (asFile) {
      askOpts.asFile = true;

      const 分け = splitForFile(message);
      if (分け.body) {
        sendText = 分け.file;
        askOpts.body = 分け.body;
        onLog(`[agent] 依頼（${分け.body.length} 文字）は入力欄に残し、決まり（${分け.file.length} 文字）だけファイルにします`);
      }
    }

    if (turn === 1 && files && files.length) {
      askOpts.files = files;
      askOpts.onUpload = onUpload;
    }

    if (添える物.length) {
      askOpts.files = (askOpts.files || []).concat(添える物.splice(0));
      askOpts.onUpload = onUpload;
      onLog(`[agent] 撮った画面を ${askOpts.files.length} 枚 添えます`);
    }

    if (turn > 1 && TURN_PACE_MAX_MS > 0) {
      const 幅 = Math.max(0, TURN_PACE_MAX_MS - TURN_PACE_MIN_MS);
      const 間 = TURN_PACE_MIN_MS + Math.floor(Math.random() * (幅 + 1));
      onLog(`[agent] 次を送る前に ${(間 / 1000).toFixed(1)} 秒あけます`);
      await new Promise((r) => setTimeout(r, 間));
    }

    if (!remindedDeadModel && 送った字 > 60000 && firstMessage && turn > 1) {
      remindedDeadModel = true;
      onLog('[agent] 押し出されたので、頼まれている事を 1 度だけ添えます');
      sendText =
        [
          '<system-reminder>',
          '**これは新しい依頼ではありません。**いま進めている事の思い出しです。',
          '**やり直さないでください。**済んだ所の続きから進めてください。',
          '',
          '頼まれている事（1 通目の頭だけ。全文はこの対話の最初に在ります）:',
          '',
          firstMessage.slice(0, 600) +
            (firstMessage.length > 600 ? '\n…（ここまで。続きは 1 通目を見てください）' : ''),
          '</system-reminder>',
        ].join('\n') +
        '\n\n' +
        sendText;
    }
    送った字 += sendText.length;
    let answer;
    try {
      answer = await bridge.ask(sendText, askOpts);
    } catch (e) {

      if (e && e.stopped) {
        return { status: 'stopped', reason: '利用者が中断した', startSha, turns: turn - 1, history };
      }

      if (e && e.tooLong) {
        const half = trimForSend(message, Math.floor(message.length / 2));
        onLog(`[agent] 長すぎると断られました。${half.cut} 文字を省いて 1 度だけ送り直します`);
        message = half.text;

        sendText = message;
        delete askOpts.body;
        askOpts.asFile = false;
        answer = await bridge.ask(sendText, askOpts);
      } else {
        if (!e || !e.transient) {

          if (e && e.delivered) {
            onLog(
              `[agent] 依頼は相手の対話に入っています（${e.message}）。` +
                '**送り直しません**（同じ字が 2 度並ぶため）'
            );
            if (onNotice) onNotice({ kind: 'delivered', why: String(e.message || '') });
          }
          throw e;
        }
        onLog(`[agent] 送れませんでした（${e.message}）。1 度だけ送り直します`);
        if (onNotice) onNotice({ kind: 'resend', why: String(e.message || '') });
        answer = await bridge.ask(sendText, askOpts);
      }
    }
    const waited = Date.now() - t0;
    onLog(`[agent] 返答 ${answer.length} 文字 / ${Math.round(waited / 1000)} 秒`);

    if (POLICY.test(answer)) {
      onLog('[agent] 相手の側の審査に当たりました。**依頼の言い方を変える必要が在ります**');
      if (onNotice) onNotice({ kind: 'policy', why: firstLineOf(answer, POLICY) });

      try {
        noteStreamCut({
          why: 'policy',
          chars: answer.length,
          ms: waited,
          url: 'agent',
          message: firstLineOf(answer, POLICY),
        });
      } catch {

      }
    }

    onAnswer(answer, turn, { ms: waited });
    history.push({ turn, answer });

    const { calls, broken } = parseToolCalls(answer);
    if (broken.length === 0) brokenRow = 0;
    calledEver += calls.length;

    if (profileFor(modelSlug) === 'dead' && !downgradeDecided) {
      downgradeDecided = true;
      const 帯 = await readLimitNotice();
      const info = {
        from: lastStrongSlug,
        to: modelSlug,
        until: 帯 && 帯.until ? 帯.until : null,
        hhmm: 帯 ? 帯.hhmm : '',
        notice: 帯 ? 帯.text : '',
        evidence: evidenceFor(modelSlug),
        waits: waitsForStrong,
        max: MAX_WAITS,
      };
      let policy = '';
      if (waitsForStrong < MAX_WAITS) {
        if (onDowngrade) {
          try {
            policy = String((await onDowngrade(info)) || '');
          } catch (e) {
            onLog(`[agent] 落とされた時の判断を聞けませんでした（${e.message}）。今までどおり続けます`);
            policy = '';
          }
        } else {
          policy = info.until ? 'wait' : 'continue';
        }
      } else {
        onLog(`[agent] 強い相手を ${MAX_WAITS} 回 待ちました。これ以上は待たず、今までどおり続けます`);
      }
      if (policy === 'stop') {
        onLog(`[agent] 弱い相手（${modelSlug}）に落とされたので、ここで止めます`);
        if (onNotice) onNotice({ kind: 'downgraded', model: modelSlug, hhmm: info.hhmm });
        return {
          status: 'downgraded',
          reason: `弱い相手（${modelSlug}）に落とされた${info.hhmm ? `（${info.hhmm} まで制限）` : ''}`,
          startSha,
          turns: turn,
          history,
          model: modelSlug,
          until: info.until,
        };
      }
      if (policy === 'wait') {
        waitsForStrong += 1;
        onLog(
          `[agent] 弱い相手（${modelSlug}）に落とされました。` +
            (info.until ? `${info.hhmm} まで待って、` : '解ける時刻が読めないので 10 分 ずつ見ながら待って、') +
            `強い相手で続けます（${waitsForStrong}/${MAX_WAITS} 回目）`
        );
        if (onNotice) onNotice({ kind: 'waiting', until: info.until, hhmm: info.hhmm, n: waitsForStrong, max: MAX_WAITS, model: modelSlug });
        const 待てた = await waitForStrong(info.until);
        if (!待てた) {
          return { status: 'stopped', reason: '強い相手を待っている間に、利用者が中断した', startSha, turns: turn, history };
        }
        if (firstMessage && bridge.newConversation) {
          try {
            await remakeConversation();
            downgraded = false;
            modelSlug = '';
            silent = 0;
            firstSilentAnswer = '';
            downgradeDecided = false;
            message = firstMessage;
            onLog('[agent] 待ち終えたので、新しい対話で 1 通目から続けます');
            if (onNotice) onNotice({ kind: 'resumed', n: waitsForStrong, max: MAX_WAITS });
            continue;
          } catch (e) {
            onLog(`[agent] 待った後に引き直せませんでした（${e.message}）。そのまま続けます`);
          }
        }
      }

    }

    if (downgraded && calledEver === 0 && canRestart() && firstMessage && bridge.newConversation) {
      restarts += 1;
      onLog(`[agent] 相手が入れ替わったので、対話を引き直します（${restartLabel()}）`);
      if (onNotice)
        onNotice({ kind: 'restart', why: 'downgraded', n: restarts, max: MAX_RESTARTS });
      try {
        await remakeConversation();
        downgraded = false;
        modelSlug = '';

        silent = 0;

        firstSilentAnswer = '';
        message = firstMessage;
        continue;
      } catch (e) {
        onLog(`[agent] 引き直せませんでした（${e.message}）。そのまま続けます`);
      }
    }

    if (calls.length === 0) {

      const 断りに見える =
        broken.length > 0 &&
        broken.every((b) => b.kind === 'mentioned') &&
        REFUSAL.test(proseOf(answer, false));
      if (broken.length > 0 && !断りに見える) {

        brokenRow += 1;
        if (brokenRow > MAX_BROKEN_ROW) {

          if (canRestart() && firstMessage && bridge.newConversation) {
            restarts += 1;
            onLog(`[agent] 読めない形が続いたので、対話を引き直します（${restartLabel()}）`);
            if (onNotice)
              onNotice({ kind: 'restart', why: 'badFormat', n: restarts, max: MAX_RESTARTS });
            try {
              await remakeConversation();
              brokenRow = 0;
              message = firstMessage;
              continue;
            } catch (e) {
              onLog(`[agent] 引き直せませんでした（${e.message}）。そのまま止めます`);
            }
          }
          onLog(`[agent] コードブロックが読めないターンが ${brokenRow} 回続きました。止めます`);
          return {
            status: 'stopped',
            reason: `道具の書き方が ${brokenRow} 回続けて読めませんでした`,
            answer: allProse(history),
            startSha,
            turns: turn,
            history,
          };
        }

        const なぜ = broken
          .map((b) => {
            const r = String(b.reason || '').slice(0, 60);
            const body = String(b.body || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            return body ? `${r} ← ${body}` : r;
          })
          .filter(Boolean)
          .join(' / ');
        onLog(
          `[agent] コードブロックが読めない ${broken.length} 件（${brokenRow}/${MAX_BROKEN_ROW} 回目）` +
            `${なぜ ? `: ${なぜ}` : ''}。書式を伝えて出し直させます`
        );
        message = formatBrokenNotice(broken);
        continue;
      }

      if (
        canRestart() &&
        silent === 0 &&
        bridge.newConversation &&
        includeInstruction &&
        REFUSAL.test(proseOf(answer, false))
      ) {
        restarts += 1;
        onLog(`[agent] 相手が「その道具は無い」と言って止まりました。対話を引き直します（${restartLabel()}）`);
        if (onNotice)
          onNotice({ kind: 'restart', why: 'noTool', n: restarts, max: MAX_RESTARTS });
        try {
          await remakeConversation();

          message = firstMessage;
          continue;
        } catch (e) {
          onLog(`[agent] 引き直せませんでした（${e.message}）。そのまま続けます`);
        }
      }

      if (downgraded && canRestart() && firstMessage && bridge.newConversation) {
        restarts += 1;
        onLog(`[agent] 弱い相手に変わってから呼ばなくなったので、対話を引き直します（${restartLabel()}）`);
        if (onNotice)
          onNotice({ kind: 'restart', why: 'downgraded', n: restarts, max: MAX_RESTARTS });
        try {
          await remakeConversation();

          downgraded = false;
          modelSlug = '';
          silent = 0;
          firstSilentAnswer = '';
          message = firstMessage;
          continue;
        } catch (e) {
          onLog(`[agent] 引き直せませんでした（${e.message}）。そのまま続けます`);
        }
      }
      silent += 1;

      if (silent === 1) firstSilentAnswer = answer;
      onLog(`[agent] 道具呼び出しなし（${silent}/${maxSilent}）`);
      onLog(`--- 相手の返答 ---\n${answer.slice(0, 1200)}`);
      if (silent >= maxSilent) {

        const gaveHere = await handOverIfAsked(proseOf(answer, false));
        if (gaveHere) {
          silent = 0;
          firstSilentAnswer = '';
          message = gaveHere;
          continue;
        }

        const worked = history.some((h) => /```json/.test(String(h.answer || '')));
        const refused = REFUSAL.test(proseOf(answer, false));

        const 押し出された = 送った字 > 60000;
        if (
          !remindedDeadModel &&
          (profileFor(modelSlug) === 'dead' || 押し出された) &&
          firstMessage
        ) {
          remindedDeadModel = true;

          const reminder = [
            '<system-reminder>',
            '**これは新しい依頼ではありません。**いま進めている事の思い出しです。',
            '**やり直さないでください。**済んだ所の続きから進めてください。',
            '',
            '頼まれている事（1 通目の頭だけ。全文はこの対話の最初に在ります）:',
            '',
            firstMessage.slice(0, 600) +
              (firstMessage.length > 600 ? '\n…（ここまで。続きは 1 通目を見てください）' : ''),
            '</system-reminder>',
          ].join('\n');
          onLog('[agent] 弱い相手が黙ったため、頼まれている事を 1 度だけ貼り直します');
          silent = 0;
          firstSilentAnswer = '';
          message = reminder;
          continue;
        }
        if (canRestart() && firstMessage && bridge.newConversation && (worked || refused)) {
          restarts += 1;
          onLog(`[agent] 道具を呼ばないまま終わりかけたので、対話を引き直します（${restartLabel()}）`);
          if (onNotice)
            onNotice({ kind: 'restart', why: 'noCall', n: restarts, max: MAX_RESTARTS });
          try {
            await remakeConversation();
            silent = 0;
            firstSilentAnswer = '';
            message = firstMessage;
            continue;
          } catch (e) {
            onLog(`[agent] 引き直せませんでした（${e.message}）。そのまま返します`);
          }
        }

        if (onSilentStreak) {
          const why =
            `ツールを呼ばないターンが ${silent} 回続きました。\n` +
            `最後の返答: ${String(firstSilentAnswer || answer).split('\n')[0].slice(0, 200)}`;
          const hint = await onSilentStreak({ times: silent, why, answer, calledEver });
          if (hint) {
            silent = 0;
            firstSilentAnswer = '';
            onLog('[agent] 無言の数を戻して続けます');

            message =
              silentNudge() +
              (typeof hint === 'string' && hint.trim()
                ? '\n\n利用者からの指点:\n' + hint.trim()
                : '');
            continue;
          }
        }
        return {
          status: 'answered',

          summary: firstSilentAnswer || answer,
          allAnswers: allProse(history),
          startSha,
          turns: turn,
          history,
          lastAnswer: proseOf(answer, false),
        };
      }
      message = silentNudge();
      continue;
    }

    silent = 0;

    const doneCall = calls.find((c) => c.bridge_tool === 'done');

    const todoCall = calls.find((c) => c.bridge_tool === 'update_todos');
    if (todoCall && !claimedWithoutTouching && touched === 0) {
      const 空約束 = (Array.isArray(todoCall.todos) ? todoCall.todos : []).filter(
        (x) => x && x.status === 'completed' && todoTouches(x.content)
      );
      if (空約束.length) {
        claimedWithoutTouching = true;
        const back = {
          id: todoCall.id,
          tool: 'update_todos',
          ok: false,
          target: '',
          askedAgain: true,
          output:
            `次の項目を「終わった」にしていますが、**この走りではまだ何も直していません**:\n` +
            空約束.map((x) => `  - ${x.content}`).join('\n') +
            '\n\n' +
            '直した記録が 1 つも在りません（`edit_file` / `write_file` / `run_command` が 0 回）。\n' +
            '**前に在った記録や、他の誰かがやった事を、自分がやった事にしないでください。**\n' +
            'まだ直していないなら `in_progress` へ戻して、実際に直してください。\n' +
            '**直せない事情が在るなら、`completed` にせずそう書いてください**' +
            '（できない所が出ても、できる所は最後までやる）。',
        };
        onLog('[agent] update_todos → 直した記録が無いのに「終わった」にしているので差し戻します');
        onTool(back);
        message = formatResults([back], SEND_LIMIT);
        continue;
      }
    }

    const askCall = calls.find((c) => c.bridge_tool === 'ask_user');

    if (askCall && !doneCall && !askedForPermission && WANTS_PERMISSION.test(String(askCall.question || ''))) {
      askedForPermission = true;

      const 聞いた字 = String(askCall.question || '').replace(/\s+/g, ' ').trim();

      const 命令 =
        (/`([^`\n]{3,200})`/.exec(聞いた字) || [])[1] ||
        (/\b((?:curl|git|npm|node|python3?|sh|bash|source|export)\s[^。．\n？?]{2,180})/.exec(聞いた字) || [])[1] ||
        '';
      const back = {
        id: askCall.id,
        tool: 'ask_user',
        ok: false,
        target: '',
        askedAgain: true,
        output:
          '走らせてよいかを、ここで聞く必要はありません。許可リストに無い命令や、' +
          'ワークスペースの外のファイルは、出した時にこちらが利用者へ聞きます。' +
          '許されればそのまま走ります。\n\n' +
          '**次の返事で `run_command` を出してください。**聞き直さないでください。' +
          (命令 ? `\n出すのはこれです:\n\`\`\`\n${命令}\n\`\`\`` : '') +
          '\n\n**別のことへ移らないでください。**報告書を書いたり、' +
          '取れなかった物を「調べた範囲では」と書いて済ませたりせず、' +
          '**まずこの命令を出して、結果を見てから**続けてください。',
      };
      onLog('[agent] ask_user → 許しを求めているので、そのまま出させます');
      onTool(back);

      message = formatResults([back], SEND_LIMIT);
      continue;
    }

    if (
      askCall &&
      !doneCall &&
      !askedWithoutOptions &&
      !normalizeOptions(askCall.options) &&
      LISTS_CHOICES.test(String(askCall.question || ''))
    ) {
      askedWithoutOptions = true;
      const back = {
        id: askCall.id,
        tool: 'ask_user',
        ok: false,
        target: '',
        askedAgain: true,
        output:
          '問いの中に選べる道を並べていますが、**`options` が付いていません。**\n' +
          'そのままだと利用者は打って答えることになり、**押した記録も残りません**。\n' +
          '同じ問いを、`options` を付けて出し直してください:\n' +
          '  {"type":"tool_use","id":"toolu_…","name":"ask_user","input":{\n' +
          '    "question":"（問いの本文。①② は書かなくてよい）",\n' +
          '    "options":[\n' +
          '      {"label":"（押す字。短く）","description":"（選ぶと何が起きるか）"},\n' +
          '      {"label":"…","description":"…"}\n' +
          '    ]}}\n' +
          '2〜4 つまで。**同じ label を 2 度出さないでください。**',
      };
      onLog('[agent] ask_user → 選択肢を文で並べているので、options を付けて出し直させます');
      onTool(back);
      message = formatResults([back], SEND_LIMIT);
      continue;
    }

    if (askCall && !doneCall) {

      const gave = await handOverIfAsked(askCall.question || '');
      if (gave) {
        message = gave;
        continue;
      }
      const r = await restartIfRefused(askCall.question || '');
      if (r) {
        message = r;
        continue;
      }
      return {
        status: 'asked',

        allAnswers: allProse(history),
        question: askCall.question || '（聞きたいことが書かれていません）',

        options: normalizeOptions(askCall.options),
        summary: askCall.question || '',
        startSha,
        turns: turn,
        history,
        lastAnswer: proseOf(answer, false),
      };
    }
    const actionable = calls.filter(
      (c) => c.bridge_tool !== 'done' && c.bridge_tool !== 'ask_user'
    );

    const mutating = actionable.some((c) =>
      ['write_file', 'edit_file', 'run_command'].includes(c.bridge_tool)
    );

    let restoreFailed = null;
    if (mutating) {
      try {
        const sha = ensureRestorePoint(root, `ターン ${turn}`);

        if (!startSha) startSha = sha;
        onLog(`[agent] checkpoint: ${sha ? sha.slice(0, 8) : '（コミットなし）'}`);
      } catch (e) {
        restoreFailed = e.message;

        onLog(
          `[agent] チェックポイントなしで進みます（戻せません）: ${e.message}` +
            (requireRestorePoint ? ' — 設定により書き換えを断ります' : '')
        );
        onNoRestorePoint(e.message);
      }
    }

    const results = [];
    for (const call of actionable) {

      if (shouldStop()) {
        return { status: 'stopped', reason: '利用者が中断した', startSha, turns: turn, history };
      }

      if (
        requireRestorePoint &&
        restoreFailed &&
        ['write_file', 'edit_file', 'run_command'].includes(call.bridge_tool)
      ) {
        const refused = {
          id: call.id,
          tool: call.bridge_tool,
          ok: false,
          target: targetOf(call),
          output: `${restoreFailed}\n読むだけの道具は使えます。`,
        };
        onTool(refused);
        results.push(refused);
        continue;
      }

      if (call.bridge_tool !== 'done' && call.bridge_tool !== 'update_todos') movedSinceDone = true;
      if (call.bridge_tool === 'read_skill' && call.name) readSkills.add(String(call.name));

      if (
        !skillRefused &&
        namedSkills.length &&
        call.bridge_tool !== 'read_skill' &&
        call.bridge_tool !== 'done' &&
        call.bridge_tool !== 'update_todos'
      ) {
        const unreadFirst = namedSkills.filter((n) => !readSkills.has(n));
        if (unreadFirst.length) {
          skillRefused = true;
          const backFirst = {
            id: call.id,
            tool: call.bridge_tool,
            ok: false,
            target: targetOf(call),
            askedAgain: true,
            output:
              `この依頼には手順書があります。まだ読んでいません: ${unreadFirst.join(' / ')}\n` +
              `read_skill {"name":"${unreadFirst[0]}"} を先に出してください。` +
              'この人の決めた手順（使う script や API の呼び方）が書いてあります。' +
              '読んでから、**この手をもう一度 出してください**。\n' +

              'まったく当てはまらない時（この依頼が画面や調べものの話ではない等）は、' +
              '**その旨を 1 行 書いて、この手をもう一度 出してください**。' +
              'それで通ります。橋は繋がっています——この打ち返しは、' +
              'あなたの呼び方が悪いのでも、ツールが無いのでもありません。',
          };
          onLog(`[agent] 最初の手 → 手順書 ${unreadFirst.join(' / ')} を先に読ませます`);
          onTool(backFirst);
          results.push(backFirst);
          continue;
        }
      }
      const needs =
        call.bridge_tool === 'write_file' || call.bridge_tool === 'edit_file'
          ? needsSkillFirst(call.path, namedSkills, readSkills)
          : null;

      if (call.bridge_tool === 'write_file' && !refusedEmpty && !needs) {
        const 空 = needsRealContent(task, targetOf(call), call.content);
        if (空) {
          refusedEmpty = true;
          const back = {
            id: call.id,
            tool: call.bridge_tool,
            ok: false,
            target: targetOf(call),
            askedAgain: true,
            output: 空,
          };
          onLog('[agent] write_file → 殻だけなので 1 度だけ断りました');
          onTool(back);
          results.push(back);
          continue;
        }
      }

      let splitHint = '';
      if (call.bridge_tool === 'write_file' && !taughtSplit && !needs) {
        const thin = needsDetailKept(task, gathered, call.content);
        if (thin) {
          taughtSplit = true;
          splitHint = `\n\n--- 書けました。ただし ${thin}`;
          onLog('[agent] write_file → 通したうえで、分けて書く手順を渡しました');
        }
      }
      if (needs && !refusedFor.has(needs.skill)) {
        refusedFor.add(needs.skill);
        const first = {
          id: call.id,
          tool: call.bridge_tool,
          ok: false,
          target: targetOf(call),
          askedAgain: true,
          output:
            `${needs.why}。read_skill {"name":"${needs.skill}"} を先に出してください。` +
            'そのあと、同じ書き込みをもう一度出せば通ります。',
        };
        onLog(`[agent] ${call.bridge_tool} → 先に ${needs.skill} を読ませます`);
        onTool(first);
        results.push(first);
        continue;
      }

      const print = callFingerprint(call);
      if (print === lastCall) {
        sameCallRow += 1;
        if (sameCallRow >= MAX_SAME_CALL) {
          onLog(`[agent] 同じ呼び出しが ${sameCallRow + 1} 回続きました。止めます`);
          if (onNotice) {
            onNotice({
              kind: 'sameCall',
              tool: call.bridge_tool,
              n: sameCallRow + 1,
            });
          }
          return {
            status: 'stopped',
            reason:
              `同じ道具を同じ引数で ${sameCallRow + 1} 回続けて呼びました（${call.bridge_tool}）。` +
              '進んでいないので止めます。',
            answer: allProse(history),
            startSha,
            turns: turn,
            history,
          };
        }
      } else {
        lastCall = print;
        sameCallRow = 0;
      }

      const 寄せ = normalizeCall(call.bridge_tool, call);
      let 名前の知らせ = '';
      if (寄せ.notes.length) {

        for (const k of Object.keys(call)) {
          if (k === 'bridge_tool' || k === 'tool' || k === 'id') continue;
          if (!(k in 寄せ.call)) delete call[k];
        }
        Object.assign(call, 寄せ.call);
        名前の知らせ = '\n\n（' + 寄せ.notes.join('。') + '）';
      }
      const fn = tools[call.bridge_tool];
      if (!fn) {

        const 引数 = {};
        for (const k of Object.keys(call)) {
          if (k === 'bridge_tool' || k === 'tool' || k === 'id' || k === 'input') continue;
          引数[k] = 1;
        }
        if (call.input && typeof call.input === 'object')
          for (const k of Object.keys(call.input)) 引数[k] = 1;
        const 未知名 = call.tool || call.bridge_tool;
        const 帳簿名 = 命令に見える(未知名)
          ? String(未知名).trim().split(/\s+/).slice(0, 2).join(' ')
          : 未知名;
        const 通算 = noteUnknown(帳簿名, 引数);
        if (通算)
          onLog(
            `[agent] 知らない名前で呼ばれました: ${call.tool || call.bridge_tool}（通算 ${通算} 回。` +
              `${require('./unknowntools').fileOf()}）`
          );
        const unknown = {
          id: call.id,
          tool: call.bridge_tool,
          ok: false,

          output:
            (readOnly && WRITE_TOOL_NAMES.includes(call.tool)
              ? '**いまは読むだけのモード（plan）なので、書くツールは渡していません。**\n' +
                'ファイルを作る必要が在るなら、`exit_plan_mode` で計画を出してください。' +
                'この人が通せば、そこから書けるようになります。\n' +
                '別のツールで書こうとしても通りません。\n\n'
              : '') +
            `そんな道具はありません。使えるのは ${[...Object.keys(tools), 'ask_user', 'done'].join(' / ')} です。` +

              (命令に見える(call.tool || call.bridge_tool)
                ? '\n命令を走らせたいなら、口は別に在ります。' +
                  '`run_command` を `command` の鍵で呼んでください。'
                : ''),
        };
        onTool(unknown);
        results.push(unknown);
        continue;
      }
      try {

        if (hookConfig) {
          const pre = await hooks.runHooks(hookConfig, 'PreToolUse', {
            toolName: call.bridge_tool,
            toolInput: call,
            cwd: root,
          });
          if (pre.decision === 'deny') {

            const e = new Error(pre.why || '利用者の検査が止めました');
            if (!pre.why) e.i18n = { key: 'tool.hookDeny', vars: {} };
            throw e;
          }
          if (pre.decision === 'ask' && askPermission) {
            const answer = await askPermission({ kind: 'hook', detail: pre.why || call.bridge_tool });
            if (answer !== 'once' && answer !== 'always') {
              const e = new Error(pre.why || '利用者が許しませんでした');
              if (!pre.why) e.i18n = { key: 'tool.hookNo', vars: {} };
              throw e;
            }
          }
        }
        const toolAt = Date.now();
        const r = await fn(call);

        if (hookConfig) {
          const post = await hooks.runHooks(hookConfig, 'PostToolUse', {
            toolName: call.bridge_tool,
            toolInput: call,
            cwd: root,
          });
          if (post.why) onLog(`[hook] ${post.why.slice(0, 200)}`);
        }
        const tookMs = Date.now() - toolAt;
        onLog(`[agent] ${call.bridge_tool} ${r.target || ''} → ${r.ok ? 'ok' : '失敗'}`);
        if (r.ok && (call.bridge_tool === 'write_file' || call.bridge_tool === 'edit_file')) {
          wroteAny = true;
          const p = String(call.path || '');
          if (p && !wrotePaths.includes(p)) wrotePaths.push(p);
        }

        if (
          r.ok &&
          (call.bridge_tool === 'write_file' ||
            call.bridge_tool === 'edit_file' ||
            call.bridge_tool === 'run_command')
        ) {
          touched += 1;
        }
        if (r.ok && call.bridge_tool === 'spawn_agents') {
          gathered += String(r.output || '').length;
        }

        const 寄せ後 = 名前の知らせ ? { ...r, output: String(r.output || '') + 名前の知らせ } : r;
        const withHint =
          splitHint && 寄せ後.ok ? { ...寄せ後, output: String(寄せ後.output || '') + splitHint } : 寄せ後;

        if (r.ok) {
          済み.n += 1;
          済み.名[call.bridge_tool] = (済み.名[call.bridge_tool] || 0) + 1;
        }
        onTool({ id: call.id, tool: call.bridge_tool, ms: tookMs, ...withHint });
        results.push({ id: call.id, tool: call.bridge_tool, ...withHint });
      } catch (e) {
        onLog(`[agent] ${call.bridge_tool} → 失敗: ${e.message}`);
        const failed = {
          id: call.id,
          tool: call.bridge_tool,
          ok: false,
          target: targetOf(call),
          output: e.message,
        };

        onTool(
          e.i18n && tr ? { ...failed, output: tr(e.i18n.key, e.i18n.vars) } : failed
        );
        results.push(failed);
      }
    }

    if (doneCall && !skillRefused && namedSkills.length) {
      const unread = namedSkills.filter((n) => !readSkills.has(n));
      if (unread.length) {
        skillRefused = true;
        const back = {
          id: doneCall.id,
          tool: 'done',
          ok: false,
          target: '',
          askedAgain: true,
          output:
            `この依頼には手順書があります。まだ読んでいません: ${unread.join(' / ')}\n` +
            `read_skill {"name":"${unread[0]}"} を先に出してください。` +
            'この人の決めた手順（使う script や API の呼び方）が書いてあります。' +
            '読んでから、そのとおりに進めてください。',
        };
        onLog(`[agent] done → 手順書 ${unread.join(' / ')} を読ませます`);
        onTool(back);
        results.push(back);
        message = formatResults(results, SEND_LIMIT);
        continue;
      }
    }

    if (doneCall && onGoalCheck && goalChecks < MAX_GOAL_CHECKS) {
      const more = await onGoalCheck({
        summary: String((doneCall.input && doneCall.input.summary) || doneCall.summary || ''),
        turn,
        wrote: [...wrotePaths],
      });
      if (more && String(more).trim()) {
        goalChecks += 1;
        onLog(`[agent] 目当てがまだ満たされていません（${goalChecks}/${MAX_GOAL_CHECKS}）。続けます`);
        const back = {
          id: doneCall.id,
          tool: 'done',
          ok: false,
          target: '',
          askedAgain: true,
          output: String(more).trim(),
        };
        onTool(back);
        results.push(back);
        message = formatResults(results, SEND_LIMIT);
        continue;
      }
    }

    if (doneCall && !readOnly && preventDoneWithOpenTodos) {
      const 残り = lastTodos.filter((x) => x && x.status !== 'completed');
      if (残り.length) {
        const 断る = (指点) => {

          if (movedSinceDone) emptyDones = 0;
          else emptyDones += 1;
          movedSinceDone = false;
          const refused = {
            id: doneCall.id,
            tool: 'done',
            ok: false,
            target: '',
            askedAgain: true,
            output:
              `やることが ${残り.length} 件のこっています:\n` +
              残り.map((x) => `  - ${x.content}`).join('\n') +
              '\n終わっているなら update_todos で completed にしてください。' +
              '終わっていないなら、**のこりの 1 件目から続けてください**。' +

              (emptyDones >= 2
                ? `\n\n**前の done から、ツールを 1 つも呼んでいません（${emptyDones} 回目）。**\n` +
                  '次に出すのは done ではありません。ツールを 1 つ 呼んでください。'
                : '') +
              (指点 ? '\n\n利用者からの指点:\n' + 指点 : ''),
          };
          onTool(refused);
          results.push(refused);
          message = formatResults(results, SEND_LIMIT);
        };
        if (todoRefusals < MAX_TODO_REFUSALS) {
          todoRefusals += 1;
          onLog(`[agent] done → やることが ${残り.length} 件のこっている（${todoRefusals}/${MAX_TODO_REFUSALS} 回目）`);
          断る('');
          continue;
        }
        if (onTodosOpen) {
          const hint = await onTodosOpen({ left: 残り.map((x) => x.content), times: todoRefusals });
          if (hint) {
            todoRefusals = 0;
            onLog('[agent] やり残しの数を戻して続けます');
            断る(typeof hint === 'string' && hint.trim() ? hint.trim() : '');
            continue;
          }
          onLog(`[agent] 利用者が「やり残し ${残り.length} 件のままで終えてよい」と答えました`);
        } else {
          onLog(`[agent] やり残し ${残り.length} 件のまま通します（聞く相手が居ません）`);
        }
      }
    }

    if (doneCall && 背景ののこり() > 0 && bgRefusals < MAX_BG_REFUSALS) {
      bgRefusals += 1;
      const n = 背景ののこり();
      onLog(`[agent] done → 背景の下請けが ${n} 件 走っている（${bgRefusals}/${MAX_BG_REFUSALS} 回目）`);
      const refused = {
        id: doneCall.id,
        tool: 'done',
        ok: false,
        target: '',
        askedAgain: true,
        output:
          `背景で頼んだ下請けが、まだ ${n} 件 走っています。\n` +
          '**結果はあなたの次のターンの頭に届きます。**届く前に終わらせると、' +
          'その調べは丸ごと捨てることになります。\n' +
          '**結果を推し量って書かないでください。**別に進められることが在れば' +
          'それを進め、無ければそう書いて、もう一度 done を出してください。',
      };
      onTool(refused);
      results.push(refused);
      message = formatResults(results, SEND_LIMIT);
      continue;
    }

    if (doneCall && !readOnly && doneRefusals < MAX_THIN_REFUSALS) {
      const why = needsFileFirst(task, wroteAny);
      if (why) {
        doneRefusals += 1;

        if (doneRefusals >= 2 && canRestart() && firstMessage && bridge.newConversation) {
          restarts += 1;
          onLog(`[agent] 断っても作らないので、対話を引き直します（${restartLabel()}）`);
          if (onNotice)
            onNotice({ kind: 'restart', why: 'refusedTwice', n: restarts, max: MAX_RESTARTS });
          try {
            await remakeConversation();
            message = firstMessage;
            continue;
          } catch (e) {
            onLog(`[agent] 引き直せませんでした（${e.message}）。そのまま断ります`);
          }
        }
        const refused = {
          id: doneCall.id,
          tool: 'done',
          ok: false,
          target: '',
          askedAgain: true,
          output:
            why +
            (doneRefusals < MAX_THIN_REFUSALS
              ? `（この後 ${MAX_THIN_REFUSALS - doneRefusals} 回まで見ます）`
              : '（次はそのまま通します）') +

            名指しを確かめる(root, doneCall.summary) +

            writeFileRecall(済み),
        };
        onLog(`[agent] done → まだ作っていない（${doneRefusals}/${MAX_THIN_REFUSALS} 回目）`);
        onTool(refused);
        results.push(refused);
        message = formatResults(results, SEND_LIMIT);
        continue;
      }
    }

    if (doneCall && !readOnly && wrotePaths.length && thinRefusals < MAX_THIN_REFUSALS) {
      const target = wrotePaths[wrotePaths.length - 1];
      let made = '';
      try {
        made = String((await tools.read_file({ path: target })).output || '');
      } catch (e) {
        made = '';
      }
      const thin = made ? needsDetailKept(task, gathered, made) : null;
      if (thin) {
        thinRefusals += 1;
        const back = {
          id: doneCall.id,
          tool: 'done',
          ok: false,
          target,
          askedAgain: true,
          output:
            `${target} は出来ていますが、まだ薄いです。\n${thin}\n` +
            `**すでにある分は消さないでください。** edit_file の append で続きを足してください。` +
            (thinRefusals < MAX_THIN_REFUSALS
              ? `（この後 ${MAX_THIN_REFUSALS - thinRefusals} 回まで見ます）`
              : '（次はそのまま通します）'),
        };
        onLog(`[agent] done → ${target} が薄い（${thinRefusals}/${MAX_THIN_REFUSALS} 回目）`);
        onTool(back);
        results.push(back);
        message = formatResults(results, SEND_LIMIT);
        continue;
      }
    }

    if (doneCall) {

      const r = await restartIfRefused(doneCall.summary || '');
      if (r) {
        message = r;
        continue;
      }

      if (!readOnly && !wroteAny && needsFileFirst(task, false)) {
        onLog('[agent] 頼まれた物が作られないまま終わりました');
        if (onNotice) onNotice({ kind: 'doneWithoutFile' });
      }
      return {
        status: 'done',
        summary: doneCall.summary || '（要約なし）',

        lastAnswer: proseOf(answer, false),

        allAnswers: allProse(history),
        startSha,
        turns: turn,
        history,
        lastResults: results,
      };
    }

    const real = results.filter((r) => !r.askedAgain && !r.ran);
    const failed = real.filter((r) => !r.ok).length;
    const succeeded = real.length - failed;
    if (succeeded > 0) {
      failing = 0;
    } else if (failed > 0) {
      failing += 1;
      onLog(`[agent] 道具が全部失敗したターン（${failing}/${maxFailing}）`);
      if (failing >= maxFailing) {

        const why =
          `道具が全部失敗するターンが ${failing} 回続きました。\n` +
          `最後の失敗: ${results.map((r) => `${r.tool} ${r.target || ''} → ${String(r.output || '').split('\n')[0]}`).join(' / ')}`;
        if (onFailingStreak) {
          const hint = await onFailingStreak({ times: failing, why, results });
          if (hint) {

            failing = 0;
            onLog('[agent] 失敗続きの数を戻して続けます');
            message =
              formatResults(results, SEND_LIMIT) +
              (typeof hint === 'string' && hint.trim()
                ? '\n\n利用者からの指点:\n' + hint.trim()
                : '');
            continue;
          }
        }
        return {
          status: 'stopped',

          allAnswers: allProse(history),
          reason: why,
          startSha,
          turns: turn,
          history,
          lastResults: results,
        };
      }
    }

    message = formatResults(results, SEND_LIMIT);
  }

  return {
    status: 'stopped',

    allAnswers: allProse(history),
    reason: `ターンの上限 ${turnLimit} に達した`,
    startSha,
    turns: turnLimit,
    history,
  };
}

const TASK_MARK = '\n\n--- 今回の作業 ---\n';

const BODY_MAX = 4000;

function splitForFile(msg) {
  const at = msg.indexOf(TASK_MARK);
  if (at < 0) return { file: msg, body: '' };
  const body = msg.slice(at + 2);
  if (!body.trim() || body.length > BODY_MAX) return { file: msg, body: '' };
  return { file: msg.slice(0, at), body };
}

module.exports = {
  runAgent,

  命令に見える,

  splitForFile,
  TASK_MARK,
  BODY_MAX,

  名指しを確かめる,
  TOOL_STATE,
  toolStateOf,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_SILENT,
  DEFAULT_MAX_FAILING,
};
