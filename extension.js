const vscode = require('vscode');
const path = require('path');
const { pickDirty } = require('./src/dirtysave');
const { newProblems, formatNewProblems } = require('./src/newproblems');
const { toMarkdown, parseImported, forImport } = require('./src/exportchat');
const { plan, places, safeName } = require('./src/scaffold');
const { describeUsage } = require('./src/usage');

const os = require('os');
const fs = require('fs');
const { openBridge } = require('./src/bridge');

const { projectInstructions } = require('./src/projectrules');
const { runAgent, toolStateOf } = require('./src/agent');
const checkpoint = require('./src/checkpoint');
const mcp = require('./src/mcp');
const protocol = require('./src/protocol');
const compact = require('./src/compact');
const history = require('./src/history');
const {
  isGitRepo,
  DEFAULT_ALLOWLIST,
  mergeDenylist,
  GIT_IO,
  makeTools,
  whyBlocked,
  resolveInside,
  SEARCH_SKIP,
} = require('./src/tools');
const { diffLines, acceptBlock, rejectBlock } = require('./src/linediff');
const { parseMentions, rankCandidates, rankSkills, buildAttachment, splitRange } = require('./src/mention');
const { needsApproval, inProject } = require('./src/conversation');
const { splitBang, bangBlock, attachBangs } = require('./src/bang');
const { collectUrls } = require('./src/webfetch');
const { planMentions, mimeOf } = require('./src/attachplan');
const { runBang } = require('./src/bangrun');
const globalrules = require('./src/globalrules');
const sessions = require('./src/sessions');
const { makeT } = require('./src/i18n');
const { makeQueue } = require('./src/queue');
const { makePool } = require('./src/pool');
const { makeSubagents, formatSubagentResults } = require('./src/subagents');
const { buildGoalCheck, buildGoalContinue } = require('./src/protocol');
const { runAgent: runSubAgent } = require('./src/agent');
const { execFileSync } = require('child_process');

let translator = null;

function localeNow() {
  const pick = vscode.workspace.getConfiguration('chatgptBridge').get('language', 'auto');
  if (pick && pick !== 'auto') return pick;
  return (vscode.env && vscode.env.language) || 'en';
}

function t(key, vars) {
  if (!translator) translator = makeT(localeNow());
  return translator(key, vars);
}

const SECONDARY_SINCE = { major: 1, minor: 106 };

const BEFORE_SCHEME = 'chatgpt-bridge-before';
const beforeStore = new Map();

const beforeProvider = {
  provideTextDocumentContent(uri) {
    return beforeStore.get(uri.path) ?? t('before.missing');
  },
};

const VIEW_ID_PRIMARY = 'chatgptBridge.chat';
const VIEW_ID_SECONDARY = 'chatgptBridge.chatSecondary';
const NO_SECONDARY_KEY = 'chatgptBridge.noSecondarySidebar';

function supportsSecondarySidebar(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== SECONDARY_SINCE.major) return major > SECONDARY_SINCE.major;
  return minor >= SECONDARY_SINCE.minor;
}

let channel = null;
let view = null;
let session = null;
let store = null;

let globalStore = null;
let storeRoot = null;
let current = null;

let editorPanel = null;

let inSecondaryBar = false;

let pendingStartMode = '';

const queue = makeQueue();

const { makeSchedule } = require('./src/schedule');
const schedule = makeSchedule();
const SCHEDULE_KEY = 'chatgptBridge.scheduled';

const PROJECTS_KEY = 'chatgptBridge.knownProjects';

let scheduleTimer = null;

let pendingBangs = [];

let bangStop = false;
let bangRunning = false;

function notifyIdle(text, { needsYou = false } = {}) {
  const how = vscode.workspace.getConfiguration().get('chatgptBridge.notify', 'needsYou');
  if (how === 'off') return;
  if (how === 'needsYou' && !needsYou) return;

  if (view && view.visible) return;
  vscode.window.showInformationMessage(text);
}

function fireDue() {
  const ready = schedule.due();
  for (const item of ready) {

    handleRun(item.text).catch(() => {});
  }
  if (ready.length && store) store.update(SCHEDULE_KEY, schedule.dump());
  if (schedule.isEmpty()) stopScheduleWatch();
}

const SCHEDULE_STEP_MS = 1000;
function startScheduleWatch() {
  if (scheduleTimer) return;
  scheduleTimer = setInterval(fireDue, SCHEDULE_STEP_MS);
}
function stopScheduleWatch() {
  if (!scheduleTimer) return;
  clearInterval(scheduleTimer);
  scheduleTimer = null;
}

async function handleSchedule() {
  const mins = await vscode.window.showInputBox({
    title: t('sched.title'),
    prompt: t('sched.mins'),
    value: '30',
    validateInput: (v) => (/^\d{1,4}$/.test(String(v || '').trim()) ? null : t('sched.minsBad')),
  });
  if (mins === undefined) return;
  const text = await vscode.window.showInputBox({
    title: t('sched.title'),
    prompt: t('sched.what'),
  });
  if (!text) return;
  const at = Date.now() + Number(mins) * 60000;
  const r = schedule.add(text, at);
  if (!r.ok) {
    vscode.window.showWarningMessage(t('sched.no.' + r.why));
    return;
  }
  if (store) store.update(SCHEDULE_KEY, schedule.dump());
  startScheduleWatch();
  vscode.window.showInformationMessage(t('sched.ok', { mins: String(Number(mins)) }));
}

function showQueue() {
  send('queue', { items: queue.list() });
}

const CURRENT_KEY = 'chatgptBridge.currentSessionId';

function remember(msg) {
  if (!current) return;

  if (msg.type === 'delta' || msg.type === 'turn' || msg.type === 'where') return;
  sessions.append(current, msg, Date.now());
  try {
    sessions.save(storeRoot, current);
  } catch (e) {
    log(`[セッション] 残せませんでした: ${e.message}`);
  }
}

function startSession(workspace) {
  current = sessions.create(storeRoot, { workspace, nowMs: Date.now() });
  sessions.save(storeRoot, current);
  if (store) store.update(CURRENT_KEY, current.id);
  return current;
}

function resumeLastSession(workspace) {
  const id = store ? store.get(CURRENT_KEY, '') : '';
  if (!id) return null;
  try {
    const s = sessions.load(storeRoot, id);
    if (workspace && s.workspace !== workspace) return null;
    current = s;
    return s;
  } catch {
    return null;
  }
}

function log(s) {
  if (channel) channel.appendLine(s);
}

function send(type, data, id) {
  if (view) view.webview.postMessage({ type, data: data || {}, id: id || null });
}

function post(msg) {
  remember(msg);
  const { type, ...data } = msg;
  send(type, data);
}

// 「略過」と「略過（加強版）」は聞かない。加強版は更に触らせない場所の門も開く。
function skipsAsking() {
  const m = settings().mode;
  return m === 'never' || m === 'neverPlus';
}

function unrestricted() {
  return settings().mode === 'neverPlus';
}

function neverModeStop(reason) {
  if (!skipsAsking()) return null;
  post({ type: 'note', text: t('never.autostop', { why: t(reason) }) });
  return '';
}

function replay(msg) {
  const { type, ...data } = msg;
  send(type, data);
}

function pickWorkspace() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const active = vscode.window.activeTextEditor;
  if (active && folders.length > 1) {
    const f = vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (f) return f.uri.fsPath;
  }
  return folders[0].uri.fsPath;
}

function settings() {
  const c = vscode.workspace.getConfiguration('chatgptBridge');
  return {
    port: c.get('port', 8765),
    allowlist: c.get('allowlist', DEFAULT_ALLOWLIST),

    denylist: mergeDenylist(c.get('denylist', [])),

    timeoutAllowlist: c.get('commandTimeoutAllowlist', []),
    maxTurns: c.get('maxTurns', 0),
    requireRestorePoint: c.get('requireRestorePoint', false),
    protectSecrets: c.get('protectSecrets', true),
    loadGlobalRules: c.get('loadGlobalRules', true),
    subAgents: c.get('subAgents', 2),

    restartGapSeconds: c.get('restartGapSeconds', 20),

    subPortBase: c.get('subPortBase', 8810),

    browserPath: c.get('browserPath', ''),
    browserProfile: c.get('browserProfile', ''),

    disabledTools: c.get('disabledTools', []),
    respectGitIgnore: c.get('respectGitIgnore', true),

    projectUrl: c.get('projectUrl', ''),
    preventDoneWithOpenTodos: c.get('preventDoneWithOpenTodos', true),

    modes: c.get('modes', []),
    mcp: c.get('mcp', false),

    mode: c.get('mode', 'ask'),

    thinking: c.get('thinking', false),

    outputStyle: c.get('outputStyle', ''),
    requireModifierToSend: c.get('requireModifierToSend', true),
  };
}

function runInTerminal(root, command) {
  const term = vscode.window.createTerminal({ cwd: root, name: t('app.title') });
  term.show();
  term.sendText(command);
}

function ensureSession() {
  if (session) return session;
  const root = pickWorkspace();
  if (!root) {
    post({ type: 'error', text: t('note.needFolder') });
    return null;
  }
  session = { bridge: null, root, started: false, cancel: false, busy: false, warnedNoGit: false };
  if (!current) startSession(root);
  post({ type: 'where', text: root });
  return session;
}

const WARNED_NO_GIT_KEY = 'chatgptBridge.warnedNoGit';

function warnNoRestorePoint(s) {

  const seen = store ? store.get(WARNED_NO_GIT_KEY, []) : [];
  if (seen.includes(s.root)) return;
  if (store) store.update(WARNED_NO_GIT_KEY, seen.concat([s.root]));
  post({
    type: 'ask',
    text: t('ask.noRestorePoint', { why: s.noRestoreWhy || '' }),
    actions: [{ label: t('action.gitinit'), action: 'gitinit' }],
  });
}

function minutesUntil(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((at - Date.now()) / 60000));
}

async function handleGitInit() {
  if (!session) return;
  const root = session.root;
  try {
    if (isGitRepo(root)) {
      post({ type: 'note', text: t('note.gitAlready') });
      session.warnedNoGit = true;
      return;
    }
    execFileSync('git', ['-C', root, 'init'], GIT_IO);
    execFileSync('git', ['-C', root, 'add', '-A'], GIT_IO);
    const staged = execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only'], GIT_IO)
      .trim()
      .split('\n')
      .filter(Boolean).length;
    if (staged > 0) {
      execFileSync('git', ['-C', root, 'commit', '-m', t('git.commitMessage')], GIT_IO);
    }
    session.warnedNoGit = true;
    post({
      type: 'note',
      text:
        t('note.gitStarted', { n: staged }),
    });
  } catch (e) {
    post({ type: 'error', text: t('note.gitFailed', { why: e.message }) });
  }
}

function projectHomeOf(url) {
  const m = /^(https:\/\/chatgpt\.com\/g\/g-p-[A-Za-z0-9-]+)\//.exec(String(url || ''));
  return m ? `${m[1]}/project` : '';
}

async function ensureBridge(s, port) {
  if (s.bridge) return true;
  post({ type: 'note', text: t('note.waitingTab') });
  try {
    s.bridge = await openBridge({
      port,
      onLog: log,

      workspace: pickWorkspace() || '',

      t: (k, v) => t(k, v),

      onConversationChange: (id, url, title, fromId) =>
        handleConversationChange(s, id, url, fromId),

      onThinkingState: (st) => {
        post({
          type: 'thinking',
          on: st && st.present && st.usable ? !!st.on : null,
        });
      },
    });

    await s.bridge.waitForTab();

    const home =
      s.projectUrl || settings().projectUrl || projectHomeOf((current && current.conversationUrl) || '');
    if (home && s.bridge.setProjectUrl) {
      s.bridge.setProjectUrl(home);

      if (s.bridge.requireProject) s.bridge.requireProject(true);
      log(`[bridge] 引き直しの行き先を戻しました: ${home}`);
    }

    const id = s.bridge.conversationId();
    const known = current ? current.conversationId : '';

    const rulesNow = instructionFingerprint(s);
    const sameRules = current && current.rulesFingerprint === rulesNow;

    if (id && known && id === known && current && current.instructionSent && sameRules) {
      s.started = true;

      log(`[bridge] 続きとみなしました（決まりの指紋 ${rulesNow}）`);
      post({ type: 'note', text: t('note.tabResumed') });
    } else {

      s.started = false;

      dropCarriedTabs(s);
      post({ type: 'note', text: t('note.tabConnected') });
    }
    return true;
  } catch (e) {
    log(`[失敗] ${e.message}`);
    try {
      if (s.bridge) s.bridge.close();
    } catch {}
    s.bridge = null;
    post({ type: 'error', text: e.message });
    return false;
  }
}

async function confirmConversation(s, task) {

  const projectUrl =
    s.projectUrl || settings().projectUrl || projectHomeOf((current && current.conversationUrl) || '');

  let tabUrl = s.bridge.tabUrl();
  if (projectUrl && !inProject(tabUrl, projectUrl) && /\/c\/[^/]+$/.test(String(tabUrl || ''))) {
    const settleDeadline = Date.now() + 8000;
    while (Date.now() < settleDeadline && !inProject(s.bridge.tabUrl(), projectUrl)) {
      await new Promise((r) => setTimeout(r, 300));
    }
    tabUrl = s.bridge.tabUrl();
  }
  const tabId = s.bridge.conversationId();
  const ask = needsApproval({
    tabUrl,
    tabConversationId: tabId,
    sessionConversationId: current ? current.conversationId : '',
    approved: !!s.conversationOk,
    projectUrl,
  });
  if (!ask) return true;

  const outsideProject = !!projectUrl && !inProject(tabUrl, projectUrl) && !!tabId;

  s.pendingTask = task;
  const title = s.bridge.currentTitle() || t('conv.noTitle');
  post({
    type: 'ask',
    text: outsideProject
      ? t('ask.outsideProject', { title, url: tabUrl })
      : tabUrl
        ? t('ask.otherConversation', { title, url: tabUrl })
        : t('ask.unknownConversation'),
    actions: [
      { label: t('action.newconv'), action: 'newconv' },
      { label: t('action.usethis'), action: 'usethis' },
    ],
  });

  post({ type: 'idle' });
  return false;
}

function loadGlobal(root) {
  if (!settings().loadGlobalRules) return null;
  const rules = globalrules.loadRules();
  const projectRules = globalrules.loadProjectRules(root);

  const skills = globalrules.skillNames().map((n) => `  - ${n}`).join('\n');
  if (!rules && !skills && !projectRules) return null;
  return { rules, projectRules, skills, ruleNames: globalrules.listRules() };
}

function makeSpawner(s, opts) {
  const { maxTurns, protectSecrets } = opts;
  const pool = makePool({
    base: settings().subPortBase,
    max: settings().subAgents,

    openTab: async (port) => {
      if (!s.bridge) throw new Error(t('sub.noBridge'));
      await s.bridge.openTabFor(port);
    },
    openBridge: async (port) => {
      const b = await openBridge({ port, onLog: log, t: (k, v) => t(k, v) });
      await b.waitForTab();

      const projectUrl =
        s.projectUrl || settings().projectUrl || projectHomeOf((current && current.conversationUrl) || '');
      if (projectUrl) {
        if (b.setProjectUrl) b.setProjectUrl(projectUrl);
        try {
          const r = await b.newConversation(projectUrl);
          if (r && r.fresh === false) log(`[sub:${port}] 既存の対話の続きに成りました（${r.url || '?'}）`);
        } catch (e) {
          log(`[sub:${port}] 専案へ入れませんでした（${e && e.message}）`);
        }
      }
      return b;
    },

    closeTab: async (port, held) => {
      if (held && held.bridge && held.bridge.retireTab) await held.bridge.retireTab();
    },
  });

  const subs = makeSubagents({
    pool,
    limit: settings().subAgents,

    onProgress: ({ name, at, stateKey, state, text, turn, of }) => {
      post({
        type: 'sub',

        key: at ? String(at) : String(name),
        at: at || null,
        name: at ? t('sub.name', { n: at }) : name,
        stateKey: stateKey || null,
        state: stateKey ? t(`sub.${stateKey}`) : state,

        chars: text ? String(text).length : null,

        turn: turn || null,
        of: of || null,
      });
    },
    runOne: async ({ bridge, task, name, at }) => {

      const r = await runSubAgent({
        bridge,
        root: s.root,
        task,
        allowlist: [],

        allowedOutside: vscode.workspace.getConfiguration().get('chatgptBridge.allowedOutside', []),

        isRevoked: isRevokedAllow,

        readOnly: true,

        global: loadGlobal(s.root),

        maxTurns: maxTurns > 0 ? Math.min(maxTurns, 6) : 6,
        workspaceName: `${path.basename(s.root)}（${name}）`,
        protectSecrets,
        locale: localeNow(),
        onLog: (line) => {
          log(`[${name}] ${line}`);
        },

        onTurn: ({ turn, limit }) => subs.tick(name, turn, limit),

        onTool: (r) => {
          post({
            type: 'tool',
            ok: !!r.ok,
            state: toolStateOf(r),

            name: `${t('sub.name', { n: at })} · ${r.tool}`,

            sub: at || 1,
            target: r.target || '',
            why: r.ok ? '' : String(r.output || '').slice(0, 200),
            output: r.ok ? String(r.output || '').slice(0, 400) : '',
          });
        },
      });

      const all = String(r.allAnswers || '').trim();
      if (all) return all;
      const body = String(r.lastAnswer || '').trim();
      if (body) return body;
      return String(r.summary || '').trim();
    },
  });

  return async (tasks) => {
    const r = await subs.run(tasks);
    if (r.why) return { why: r.why };
    return { results: r.results, text: formatSubagentResults(r) };
  };
}

async function handleRun(task) {

  const startMode = pendingStartMode;
  const s = ensureSession();
  if (!s) return;

  const routed = queue.route(s.busy, task);
  if (routed.as === 'full') {
    post({ type: 'note', text: t('queue.full', { n: queue.max }) });
    return;
  }
  if (routed.as === 'empty') {
    post({ type: 'note', text: t('queue.empty') });
    return;
  }
  if (routed.as === 'queued') {
    showQueue();
    return;
  }

  revokedAllows.clear();
  const { port, allowlist, denylist, maxTurns, requireRestorePoint, protectSecrets } = settings();

  let mcpGot = null;
  if (settings().mcp) {
    try {
      mcpGot = await mcp.connectAll(mcp.loadServers(), { log });
      if (mcpGot.failed.length) {
        for (const f2 of mcpGot.failed) {
          post({ type: 'note', text: t('mcp.failed', { name: f2.name, why: f2.why }) });
        }
      }
      if (mcpGot.tools.length) {
        post({ type: 'note', text: t('mcp.ready', { n: mcpGot.tools.length, servers: mcpGot.clients.size }) });
      }
    } catch (e) {
      log(`[mcp] 立ち上げに失敗: ${e.message}`);
      mcpGot = null;
    }
  }

  s.busy = true;

  s.startedAt = Date.now();
  s.toolCount = 0;
  s.gotChars = 0;
  s.gotTurns = 0;
  s.wroteFiles = new Set();

  let stallTimer = null;
  let waitingOn = '';
  try {
    if (!(await ensureBridge(s, port))) return;

    stallTimer = setInterval(() => {
      if (!waitingOn) return;
      post({
        type: 'note',
        text: t('note.stillWorking', {
          n: String(STALL_NOTE_SEC),

          where: waitingOnGlobal || waitingOn,
        }),
      });
    }, STALL_NOTE_SEC * 1000);
    const waitNoting = async (where, f) => {
      waitingOn = where;
      try {
        return await f();
      } finally {
        waitingOn = '';
      }
    };

    const inConversation =
      s.bridge.conversationId() || (s.bridge.tabTurns && s.bridge.tabTurns() > 0);
    if (!inConversation) {
      const proj = await waitNoting(t('wait.project'), () => ensureBridgeProject(s));
      if (!proj.ok) {
        post({ type: 'error', text: t('bp.failed', { why: proj.why || '?' }) });
        return;
      }
      s.projectUrl = proj.url || '';
      if (s.bridge.setProjectUrl) s.bridge.setProjectUrl(proj.url || '');

      if (s.bridge.requireProject) s.bridge.requireProject(!!(proj && proj.url));

      await waitNoting(t('wait.newConv'), () => s.bridge.newConversation(proj.url || ''));
      s.started = false;
      if (current) current.instructionSent = false;
    }

    if (!(await confirmConversation(s, task))) return;

    s.cancel = false;
    let label = '';
    let shown = 0;

    let touched = false;

    let taskText = attachBangs(task, pendingBangs);
    pendingBangs = [];
    let mentioned = parseMentions(task);

    const uploadFiles = [];

    if (mentioned.length > 0) {
      const plan = planMentions(mentioned, (p) => {
        try {
          const full = resolveInside(s.root, p);
          const st = fs.statSync(full);
          if (!st.isFile()) return null;

          const fd = fs.openSync(full, 'r');
          const head = Buffer.alloc(Math.min(512, st.size));
          try {
            if (head.length) fs.readSync(fd, head, 0, head.length, 0);
          } finally {
            fs.closeSync(fd);
          }
          return { size: st.size, head };
        } catch {
          return null;
        }
      });
      if (plan.upload.length) {
        post({ type: 'note', text: t('up.sending', { list: plan.upload.join(' / ') }) });
        for (const p of plan.upload) {
          try {
            uploadFiles.push({
              name: path.basename(p),
              mime: mimeOf(p),
              b64: fs.readFileSync(resolveInside(s.root, p)).toString('base64'),
            });
          } catch (e) {
            plan.skipped.push({ path: p, why: e.message });
          }
        }
      }
      for (const sk of plan.skipped) {
        post({ type: 'note', text: t('note.notAttached', { path: sk.path, why: sk.why }) });
      }

      mentioned = plan.text;
    }

    if (mentioned.length > 0) {
      const tools = makeTools({
        root: s.root,
        allowlist,
        denylist,
        protectSecrets,
        disabled: settings().disabledTools,

        browserProfile: settings().browserProfile || '',
        browserPath: settings().browserPath || '',
        isRevoked: isRevokedAllow,
      });

      const readOrProblems = async (call) => {
        if (String(call && call.path) !== PROBLEMS_MARK) return tools.read_file(call);
        return { ok: true, output: collectProblems(s.root) };
      };
      const att = await buildAttachment(readOrProblems, mentioned, {

        exists: (p) => {

          if (p === PROBLEMS_MARK) return true;
          try {
            return fs.existsSync(resolveInside(s.root, p));
          } catch {

            return false;
          }
        },
      });

      taskText = taskText + att.text;
      const parts = [];
      if (att.attached.length) parts.push(t('note.attached', { list: att.attached.join(' / ') }));
      for (const sk of att.skipped) parts.push(t('note.notAttached', { path: sk.path, why: sk.why }));
      post({ type: 'note', text: parts.join('\n') });
    }

    const sendingInstruction = !s.started;

    const result = await runAgent({

      mcp: mcpGot,

      mode: settings().mode,

      thinking: settings().thinking,

      restartGapMs: Math.max(0, Number(settings().restartGapSeconds) || 0) * 1000,

      tr: (k, v) => t(k, v),

      outputStyle: globalrules.loadOutputStyle(settings().outputStyle),

      readOnly: settings().mode === 'plan',

      planMode: settings().mode === 'plan',

      readSetting: (k) => vscode.workspace.getConfiguration().get(`chatgptBridge.${k}`),
      writeSetting: async (k, v) =>
        vscode.workspace
          .getConfiguration()
          .update(`chatgptBridge.${k}`, v, vscode.ConfigurationTarget.Workspace),

      onExitPlan: async () => {
        await vscode.workspace
          .getConfiguration()
          .update('chatgptBridge.mode', 'edit', vscode.ConfigurationTarget.Workspace);
        post({ type: 'note', text: t('note.planAccepted') });
      },

      disabledTools: settings().disabledTools,
      modes: settings().modes,

      startMode,

      beforeTouch: (abs) => saveIfDirty(abs),
      afterTouch: (abs) => problemsAfterTouch(abs),

      respectGitIgnore: settings().respectGitIgnore,
      preventDoneWithOpenTodos: settings().preventDoneWithOpenTodos,

      onTurnsExhausted: ({ turns }) => askMoreTurns(s, turns),

      onFailingStreak: ({ times, why }) => askFailingStreak(times, why),
      onSilentStreak: ({ times, why, calledEver }) => askSilentStreak(times, why, calledEver),

      onDowngrade: (info) => askDowngrade(info),
      onTodosOpen: ({ left }) => askTodosOpen(left),

      hasProjectRules: () => hasProjectRules(),
      isInProject: () => {
        try {
          const url = s.bridge ? s.bridge.tabUrl() : '';
          const home =
            s.projectUrl ||
            settings().projectUrl ||
            projectHomeOf((current && current.conversationUrl) || '');
          return !!url && !!home && inProject(url, home);
        } catch {
          return false;
        }
      },

      onGoalCheck: ({ summary, wrote }) => checkGoal(summary, wrote),

      files: uploadFiles,
      onUpload: (up) => {
        if (up.uploaded && up.uploaded.length) {
          post({ type: 'note', text: t('up.done', { list: up.uploaded.join(' / ') }) });
        }

        for (const nm of up.failed || []) {
          post({ type: 'note', text: t('up.failed', { name: nm, why: '' }) });
        }
      },

      onLimits: (list) => {

        try {
          if (Array.isArray(list) && list.length) remember({ type: 'limits', text: JSON.stringify(list) });
        } catch {

        }
        const f = (list || []).find((x) => x && x.feature_name === 'file_upload');
        if (!f || Number(f.remaining) > 0) return;
        const min = minutesUntil(f.reset_after);
        const when =
          min == null
            ? ''
            : min < 60
              ? t('up.backMin', { n: min })
              : t('up.backHour', { h: Math.floor(min / 60), m: min % 60 });
        post({ type: 'note', text: t('up.noQuota', { when }) });
      },

      hookConfig: (() => {
        try {
          const p = path.join(s.root, '.chatgpt-bridge', 'hooks.json');
          if (!fs.existsSync(p)) return null;
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          const n = Object.keys(j || {}).length;
          if (n) log(`[hook] ${p} を読みました（${n} 種）`);
          return j;
        } catch (e) {

          post({ type: 'note', text: t('hook.badConfig', { why: e.message }) });
          return null;
        }
      })(),

      seenUrls: (() => {
        const set = s.seenUrls || (s.seenUrls = new Set());
        for (const u of collectUrls(task)) set.add(u);
        return set;
      })(),

      readSkills: (() => {
        const conv = s.bridge ? s.bridge.conversationId() : '';
        if (s.readSkillsConv !== conv) {
          s.readSkillsConv = conv;
          s.readSkills = new Set();
        }
        return s.readSkills;
      })(),

      onTurn: ({ turn, limit }) => {

        s.gotTurns = s.gotChars || 0;
        post({
          type: 'turn',

          label: limit ? t('state.turn', { n: turn, of: limit }) : t('state.turnOnly', { n: turn }),

          startedAt: s.startedAt || null,

          tools: s.toolCount || 0,
          wrote: s.wroteFiles ? s.wroteFiles.size : 0,

          got: s.gotChars || 0,

          usage: (() => {
            try {
              const u = s.bridge && s.bridge.conversationUsage ? s.bridge.conversationUsage() : null;
              if (!u) return null;
              return describeUsage(
                u,
                vscode.workspace.getConfiguration().get('chatgptBridge.contextWindow', 0)
              );
            } catch {

              return null;
            }
          })(),

          turn,
        });
      },

      onTodos: (todos) => {
        post({ type: 'todos', todos });
        remember({ type: 'todos', todos });
      },
      onCommandOutput: ({ id, command, chunk, started }) => {
        post({
          type: 'cmdout',
          id: String(id || ''),
          command: String(command || ''),
          chunk: String(chunk || ''),

          started: !!started,
        });
      },
      bridge: s.bridge,
      root: s.root,
      task: taskText,
      allowlist,
      denylist,
      maxTurns,
      workspaceName: path.basename(s.root),
      requireRestorePoint,
      protectSecrets,

      includeInstruction: sendingInstruction,
      askPermission: askPermissionFromPanel,

      allowedOutside: vscode.workspace.getConfiguration().get('chatgptBridge.allowedOutside', []),
      allowedOutsideWrite: vscode.workspace.getConfiguration().get('chatgptBridge.allowedOutsideWrite', []),

      allowedMcpServers: vscode.workspace.getConfiguration().get('chatgptBridge.allowedMcpServers', []),

      allowedSites: vscode.workspace.getConfiguration().get('chatgptBridge.allowedSites', []),

      openTabs: s.openTabs || null,
      onOpenTabs: (list) => {
        s.openTabs = list && list.length ? list : null;
      },
      onAllowAlways: allowAlways,

      isRevoked: isRevokedAllow,

      spawnAgents: makeSpawner(s, { maxTurns, protectSecrets }),

      locale: localeNow(),

      global: loadGlobal(s.root),
      shouldStop: () => s.cancel,
      onLog: (line) => {
        log(line);

        const rp = /^\[agent\] checkpoint: (.+)$/.exec(line);
        if (rp) {
          const sha = /^[0-9a-f]{7,40}$/.test(rp[1]) ? rp[1] : null;
          post({
            type: 'note',
            text: sha ? t('note.restorePoint', { sha }) : t('note.restorePointNone'),
          });
        }
      },

      onNotice: (n) => {
        const make = {
          tooLong: () => t('note.sentAsFile', { chars: String(n.chars || '') }),
          sameCall: () => t('note.sameCall', { n: String(n.n || '?') }),
          delivered: () => t('note.notResending'),
          resend: () => t('note.resendingOnce'),

          policy: () => t('note.policy', { why: String(n.why || '') }),
          restart: () => {

            s.modelSlug = null;

            if (!n.why) return t('note.restarted');
            return t('note.restartedWhy', {
              n: String(n.n || '?'),
              max: String(n.max || '?'),
              why: t('restartWhy.' + n.why),
            });
          },

          doneWithoutFile: () => t('note.doneWithoutFile'),

          pace: () => t('note.pacing', { sec: String(Math.ceil(Number(n.ms || 0) / 1000)) }),

          waiting: () =>
            t('note.waitingStrong', {
              model: String(n.model || '?'),
              when: n.hhmm ? t('downgrade.until', { hhmm: String(n.hhmm) }) : t('downgrade.unknownUntil'),
              n: String(n.n || '?'),
              max: String(n.max || '?'),
            }),
          resumed: () => t('note.resumedStrong'),
          downgraded: () => t('note.downgradedStop', { model: String(n.model || '?') }),
        }[n && n.kind];
        if (!make) return;
        const msg = { type: 'note', text: make() };
        post(msg);

        if (n.kind === 'doneWithoutFile') remember(msg);
      },

      onAnswer: (text, turn, info) => post({ type: 'answer', text, ms: (info && info.ms) || null }),
      onNoRestorePoint: (why) => {
        s.noRestoreWhy = why;
        warnNoRestorePoint(s);
      },
      onTool: (r) => {

        let diffKey = null;

        if (r.ok && (r.changed || r.tool === 'run_command')) touched = true;
        if (r.ok && r.changed) {
          diffKey = `/${Date.now()}-${diffSeq++}/${r.changed.path}`;
          beforeStore.set(diffKey, r.changed.before);

          const abs = path.join(s.root, r.changed.path);
          if (!originStore.has(abs)) originStore.set(abs, r.changed.before);
          refreshOverlay(abs);
        }
        s.toolCount = (s.toolCount || 0) + 1;
        if (r.ok && (r.tool === 'write_file' || r.tool === 'edit_file') && r.target) {
          s.wroteFiles = s.wroteFiles || new Set();
          s.wroteFiles.add(String(r.target));
        }

        if (r.full && r.id) {
          fullOutputs.set(String(r.id), String(r.full));

          while (fullOutputs.size > FULL_KEEP) fullOutputs.delete(fullOutputs.keys().next().value);
        }
        post({
          type: 'tool',

          ok: r.ok,

          state: toolStateOf(r),
          name: r.tool,
          target: r.target || '',
          why: r.ok ? '' : String(r.output || '').split('\n')[0],

          output: clipForScreen(r.output),

          fullLength: String(r.output || '').length,

          fullChars: r.full ? String(r.full).length : null,
          fullLines: r.full ? String(r.full).split('\n').length : null,

          ms: r.ms || null,
          diffKey,
          newFile: r.changed ? !r.changed.existed : false,
        });
      },

      onDelta: (text) => {

        s.gotChars = (s.gotTurns || 0) + text.length;
        if (text.length - shown < 400) return;
        shown = text.length;
        post({ type: 'delta', label, text });
      },

      onBusy: () => {
        send('busy', { label });
      },

      onImage: (img) => {
        post({ type: 'image', ...img });
      },

      onModel: (slug) => {
        if (!slug || s.modelSlug === slug) return;
        s.modelSlug = slug;
        post({ type: 'model', text: slug });
      },

      onAutoSwitch: (m) => {
        const seen = JSON.stringify(m);
        if (s.lastAutoSwitch === seen) return;
        s.lastAutoSwitch = seen;

        remember({ type: 'autoswitch', ...m });
      },
    });

    s.started = true;

    if (current && sendingInstruction) {
      current.instructionSent = true;

      current.rulesFingerprint = instructionFingerprint(s);
    }

    const convUrl = s.bridge.conversationUrl();
    const convId = s.bridge.conversationId();
    if (current && convId) {
      current.conversationUrl = convUrl;
      current.conversationId = convId;
      sessions.save(storeRoot, current);
    }
    log(`\nstate: ${result.status} / ターン数: ${result.turns}`);

    if (result.status === 'asked' && result.options) {
      post({
        type: 'ask',
        text: result.question,
        kind: 'choice',
        actions: result.options.map((o) => ({
          label: o.label,
          action: 'choice',
          answer: o.label,

          note: o.description,
        })),
      });
    }

    notifyIdle(
      result.status === 'asked'
        ? t('notify.asked', { name: path.basename(s.root) })
        : t('notify.done', { name: path.basename(s.root) }),

      { needsYou: result.status === 'asked' }
    );
    post({
      type: 'result',
      status: result.status,
      turns: result.turns,

      tools: s.toolCount || 0,
      wrote: s.wroteFiles ? s.wroteFiles.size : 0,
      ms: s.startedAt ? Date.now() - s.startedAt : 0,
      detail: resultDetail(result),

      sha:
        result.startSha && checkpoint.changedSince(s.root, result.startSha)
          ? result.startSha.slice(0, 8)
          : null,
    });
  } catch (e) {
    log(`[失敗] ${e.message}`);
    post({ type: 'error', text: e.message });

    if (s.bridge && typeof s.bridge.connected === 'function' && s.bridge.connected()) {
      log('[bridge] 線は生きているので、橋は畳みません（失敗は線と関係が無い）');
    } else {
      try {
        if (s.bridge) s.bridge.close();
      } catch {}
      s.bridge = null;
    }
  } finally {
    s.busy = false;

    try {
      clearInterval(stallTimer);
    } catch {

    }

    if (mcpGot) {
      for (const c2 of mcpGot.clients.values()) {
        try {
          await c2.close();
        } catch {

        }
      }
    }
  }

  const nextOne = queue.next();
  if (nextOne) {
    showQueue();
    post({ type: 'you', text: nextOne.text });
    setTimeout(() => {
      handleRun(nextOne.text);
    }, 0);
  }
}

function handleConversationChange(s, id, url, fromId) {
  if (!id) return;
  if (current && current.conversationId === id) return;

  if (s && s.busy) {
    if (current) {
      current.conversationId = id;
      current.conversationUrl = url;
      sessions.save(storeRoot, current);
    }
    log(`[bridge] 送って始まった対話です: ${id}`);
    return;
  }

  if (current && !current.conversationId) {
    current.conversationId = id;
    current.conversationUrl = url;
    sessions.save(storeRoot, current);
    log(`[bridge] この対話に名前が付きました: ${id}`);
    return;
  }

  const found = sessions.findByConversationId(storeRoot, id);
  if (found) {
    try {
      current = sessions.load(storeRoot, found.id);
      if (store) store.update(CURRENT_KEY, current.id);
      s.started = !!current.instructionSent;
      replay({ type: 'clear' });
      replay({ type: 'where', text: s.root });
      for (const e of current.entries) replay(e);
      replay({ type: 'restored' });
      post({ type: 'note', text: t('note.tabMovedBack') });
      return;
    } catch (e) {
      log(`[セッション] 読めませんでした: ${e.message}`);
    }
  }

  startSession(s.root);
  current.conversationId = id;
  current.conversationUrl = url;
  current.instructionSent = false;
  sessions.save(storeRoot, current);
  s.started = false;
  replay({ type: 'clear' });
  replay({ type: 'where', text: s.root });
  post({
    type: 'note',
    text: t('note.movedConversation'),
  });
}

async function handleFresh() {
  const s = ensureSession();
  if (!s) return;
  if (s.busy) {
    post({ type: 'note', text: t('note.busySwitch') });
    return;
  }
  const { port } = settings();
  if (!(await ensureBridge(s, port))) return;

  post({ type: 'note', text: t('note.switching') });

  clearOverlays();
  try {

    let r = null;
    let proj = null;
    for (let round = 0; round < 2; round += 1) {
      proj = await ensureBridgeProject(s);
      if (!proj.ok) {
        post({ type: 'error', text: t('bp.failed', { why: proj.why || '?' }) });
        return;
      }

      s.projectUrl = proj.url || '';
      if (s.bridge.setProjectUrl) s.bridge.setProjectUrl(proj.url || '');

      if (s.bridge.requireProject) s.bridge.requireProject(!!(proj && proj.url));
      r = await s.bridge.newConversation(proj.url || '');
      const wanted = (/\/g\/(g-p-[A-Za-z0-9-]+)/.exec(proj.url || '') || [])[1] || '';
      const landed = String((r && r.url) || '');
      if (!wanted || landed.includes(wanted)) break;

      if (!proj.mine) {
        post({ type: 'error', text: t('bp.pinnedGone', { url: proj.url || '' }) });
        return;
      }

      if (globalStore) await globalStore.update(BRIDGE_PROJECT_KEY, null);
      if (round === 0) post({ type: 'note', text: t('bp.remaking') });
      else {
        post({ type: 'error', text: t('bp.notThere', { url: proj.url || '' }) });
        return;
      }
    }
    s.started = false;

    startSession(s.root);
    current.instructionSent = false;

    sessions.save(storeRoot, current);
    log(`[bridge] 新しい対話: ${r && r.url}`);

    post({
      type: 'fresh',
      text: t(
        r && r.fresh === false ? 'hist.freshFellBack' : 'hist.freshStarted',
        { where: (r && r.url) || t('hist.whereUnknown') }
      ),
    });
  } catch (e) {
    post({ type: 'error', text: t('note.switchFailed', { why: e.message }) });
  }
}

async function handleHistory() {
  const s = ensureSession();
  if (!s) return;
  if (s.busy) {
    vscode.window.showWarningMessage(t('hist.busySwitch'));
    return;
  }

  const all = sessions.list(storeRoot, { workspace: s.root });
  if (all.length === 0) {
    vscode.window.showInformationMessage(t('hist.none'));
    return;
  }

  const items = all.map((x) => ({
    label: x.title,
    description: t('hist.count', { n: x.count, when: new Date(x.updatedAt).toLocaleString() }),
    detail:

      x.conversationUrl || t('hist.noUrl'),
    id: x.id,
    url: x.conversationUrl,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    title: t('hist.pickTitle'),
    placeHolder: t('hist.pickHint'),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;

  let loaded;
  try {
    loaded = sessions.load(storeRoot, pick.id);
  } catch (e) {
    vscode.window.showErrorMessage(t('hist.loadFailed', { why: e.message }));
    return;
  }

  current = loaded;
  if (store) store.update(CURRENT_KEY, loaded.id);

  replay({ type: 'clear' });
  replay({ type: 'where', text: s.root });
  for (const e of loaded.entries) replay(e);
  replay({ type: 'restored' });

  if (loaded.conversationId && loaded.conversationUrl) {
    const { port } = settings();
    if (!(await ensureBridge(s, port))) return;
    post({ type: 'note', text: t('note.movingTab') });
    try {
      await s.bridge.openConversation(loaded.conversationUrl);

      s.started = !!loaded.instructionSent;
      post({
        type: 'note',
        text: s.started
          ? t('hist.resumed')
          : t('hist.movedNoRules'),
      });
    } catch (e) {
      post({
        type: 'error',
        text: t('hist.moveFailed', { why: e.message }),
      });
      s.started = false;
    }
  } else {
    post({
      type: 'note',
      text: t('hist.localOnly'),
    });
    s.started = false;
  }
}

let diffSeq = 0;

const SCREEN_LINES = 40;
const SCREEN_CHARS = 4000;

function clipForScreen(text) {
  let s = String(text == null ? '' : text);
  if (!s) return '';
  const lines = s.split('\n');
  let cut = '';
  if (lines.length > SCREEN_LINES) {
    cut = t('screen.moreLines', { n: lines.length - SCREEN_LINES });
    s = lines.slice(0, SCREEN_LINES).join('\n');
  }
  if (s.length > SCREEN_CHARS) {
    const rest = s.length - SCREEN_CHARS;
    s = s.slice(0, SCREEN_CHARS);
    cut = t('screen.moreChars', { n: rest });
  }
  return s + cut;
}

async function showDiff(diffKey, target, newFile) {
  if (!session || !diffKey) return false;

  if (!newFile && !beforeStore.has(diffKey)) return false;
  const filePath = path.join(session.root, target);
  const fileUri = vscode.Uri.file(filePath);
  if (newFile) {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc, { preview: true });
    return true;
  }
  const beforeUri = vscode.Uri.parse(`${BEFORE_SCHEME}:${diffKey}`);
  await vscode.commands.executeCommand(
    'vscode.diff',
    beforeUri,
    fileUri,
    t('diff.title', { target })
  );
  return true;
}

const MENTION_EXCLUDE = `{${[...SEARCH_SKIP].map((d) => `**/${d}/**`).join(',')}}`;

let fileListCache = null;

const PROBLEMS_MARK = 'problems';

const PROBLEMS_MAX = 60;
const SEVERITY = ['Error', 'Warning', 'Information', 'Hint'];

function collectProblems(root) {
  let all = [];
  try {
    all = vscode.languages.getDiagnostics ? vscode.languages.getDiagnostics() : [];
  } catch {
    return t('prob.unreadable');
  }
  const lines = [];
  let n = 0;
  for (const [uri, list] of all) {
    for (const d of list || []) {
      if (n >= PROBLEMS_MAX) break;
      n += 1;
      const rel = uri && uri.fsPath ? path.relative(root, uri.fsPath).split(path.sep).join('/') : '';
      const at = d.range && d.range.start ? `:${d.range.start.line + 1}` : '';
      lines.push(`${SEVERITY[d.severity] || 'Error'}  ${rel}${at}  ${d.message || ''}`);
    }
  }
  if (!lines.length) return t('prob.none');
  let total = 0;
  for (const [, list] of all) total += (list || []).length;
  if (total > lines.length) {
    lines.push(t('prob.trimmed', { total: String(total), shown: String(lines.length) }));
  }
  return lines.join('\n');
}
const originStore = new Map();
const blockStore = new Map();

let addedDeco = null;
let removedMarkDeco = null;
const codeLensChanged = new vscode.EventEmitter();

function makeDecorations() {
  addedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  });

  removedMarkDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
  });
}

function clearOverlays() {
  originStore.clear();
  blockStore.clear();
  for (const editor of vscode.window.visibleTextEditors) paintOverlay(editor);
  codeLensChanged.fire();
}

function removedHover(block) {
  const head = block.removed.slice(0, 20);
  const more = block.removed.length - head.length;
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${t('diff.removed', { n: String(block.removed.length) })}**\n\n`);
  md.appendCodeblock(head.join('\n') + (more > 0 ? `\n${t('diff.more', { n: String(more) })}` : ''), '');
  return md;
}

function paintOverlay(editor) {
  if (!editor || !addedDeco) return;
  if (editor.document.uri.scheme !== 'file') return;
  const blocks = blockStore.get(editor.document.uri.fsPath);
  if (!blocks || blocks.length === 0) {
    editor.setDecorations(addedDeco, []);
    editor.setDecorations(removedMarkDeco, []);
    return;
  }
  const last = Math.max(editor.document.lineCount - 1, 0);
  const added = [];
  const removedMarks = [];
  for (const block of blocks) {
    if (block.added.length > 0) {
      const from = Math.min(block.afterLine, last);
      const to = Math.min(block.afterLine + block.added.length - 1, last);
      added.push({
        range: new vscode.Range(from, 0, to, 0),
        hoverMessage: block.removed.length > 0 ? removedHover(block) : undefined,
      });
      continue;
    }

    const at = Math.min(block.afterLine, last);
    removedMarks.push({
      range: new vscode.Range(at, 0, at, 0),
      hoverMessage: removedHover(block),
    });
  }
  editor.setDecorations(addedDeco, added);
  editor.setDecorations(removedMarkDeco, removedMarks);
}

function refreshOverlay(absPath) {
  const before = originStore.get(absPath);
  if (before === undefined) return;
  let after;
  try {
    after = fs.readFileSync(absPath, 'utf8');
  } catch {

    blockStore.delete(absPath);
    originStore.delete(absPath);
    after = null;
  }
  if (after !== null) {
    const blocks = diffLines(before, after);
    if (blocks.length === 0) blockStore.delete(absPath);
    else blockStore.set(absPath, blocks);
  }
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.fsPath === absPath) paintOverlay(editor);
  }
  codeLensChanged.fire();
}

const blockLensProvider = {
  onDidChangeCodeLenses: codeLensChanged.event,
  provideCodeLenses(document) {
    const blocks = blockStore.get(document.uri.fsPath);
    if (!blocks || blocks.length === 0) return [];
    const last = Math.max(document.lineCount - 1, 0);
    const lenses = [];
    blocks.forEach((block, index) => {
      const at = Math.min(block.afterLine, last);
      const range = new vscode.Range(at, 0, at, 0);
      const sign =
        (block.added.length ? `+${block.added.length}` : '') +
        (block.added.length && block.removed.length ? ' ' : '') +
        (block.removed.length ? `-${block.removed.length}` : '');
      lenses.push(
        new vscode.CodeLens(range, {
          title: t('diff.accept', { sign }),
          command: 'chatgptBridge.acceptBlock',
          arguments: [document.uri.fsPath, index],
        }),
        new vscode.CodeLens(range, {
          title: t('diff.reject'),
          command: 'chatgptBridge.rejectBlock',
          arguments: [document.uri.fsPath, index],
        })
      );
    });
    return lenses;
  },
};

function acceptOverlayBlock(absPath, index) {
  const blocks = blockStore.get(absPath);
  const before = originStore.get(absPath);
  if (!blocks || !blocks[index] || before === undefined) return;
  originStore.set(absPath, acceptBlock(before, blocks[index]));
  refreshOverlay(absPath);
}

async function rejectOverlayBlock(absPath, index) {
  const blocks = blockStore.get(absPath);
  if (!blocks || !blocks[index]) return;
  const uri = vscode.Uri.file(absPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const next = rejectBlock(doc.getText(), blocks[index]);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), next);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showWarningMessage(t('diff.undoFailed'));
    return;
  }
  await doc.save();
  refreshOverlay(absPath);
}

const fullOutputs = new Map();

const FULL_KEEP = 60;

function instructionFingerprint(s2) {
  try {
    const root = (s2 && s2.root) || pickWorkspace() || '';

    const readOnly = settings().mode === 'plan';
    const text = protocol.buildInstruction({
      workspaceName: path.basename(root),
      allowlist: settings().allowlist,
      proof: '',
      root,
      readOnly,
      global: loadGlobal(root),
      locale: localeNow(),
      task: '',
    });

    return require('crypto')
      .createHash('sha1')
      .update(String(settings().mode || '') + '\n' + String(text))
      .digest('hex')
      .slice(0, 16);
  } catch {

    return '';
  }
}

function showSkills() {
  const names = globalrules.skillNames(null, { forHuman: true });
  post({ type: 'note', text: t('cmd.skills', { n: names.length, list: names.join(', ') }) });
}

function showContext() {
  const s2 = session;
  const root = (s2 && s2.root) || pickWorkspace() || '';
  const g = loadGlobal(root);
  const first = protocol.buildInstruction({
    workspaceName: path.basename(root),
    allowlist: settings().allowlist,
    proof: '',
    root,
    global: g,
    locale: localeNow(),
    task: '',
  });
  const entries = (current && current.entries) || [];
  const kept = entries.reduce((n, e) => n + String(e.text || '').length, 0);
  post({
    type: 'note',
    text: t('cmd.context', {
      first: first.length.toLocaleString(),
      turns: entries.length,
      kept: kept.toLocaleString(),
    }),
  });
}

function showCost() {
  const s2 = session;
  if (!s2 || !s2.startedAt) {
    post({ type: 'note', text: t('cmd.costNone') });
    return;
  }
  const sec = Math.round((Date.now() - s2.startedAt) / 1000);
  post({
    type: 'note',
    text: t('cmd.cost', {
      sec,
      tools: s2.toolCount || 0,
      wrote: s2.wroteFiles ? s2.wroteFiles.size : 0,
      model: s2.modelSlug || '—',
    }),
  });
}

let pendingTurns = null;

function resultDetail(result) {
  if (result.status === 'asked') return result.question;
  if (result.status === 'done') {
    const summary = String(result.summary || '');
    const prose = String(result.lastAnswer || '');

    const flat = (x) => x.replace(/\s+/g, ' ').trim();
    if (summary && prose && flat(summary) === flat(prose)) return '';
    return result.summary;
  }

  if (result.status === 'answered') return '';
  return result.reason;
}

function markAnswered(answer, kind) {
  if (!current) return;
  const hit = sessions.answerLastAsk(current, answer, { kind: kind || null });
  if (!hit) return;
  try {
    sessions.save(storeRoot, current);
  } catch (e) {
    log(`[セッション] 答えを残せませんでした: ${e.message}`);
  }

}

function selectionMention() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return null;
  const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
  const sel = ed.selection;
  if (sel.isEmpty) return '@' + rel;

  const from = sel.start.line + 1;
  const to = sel.end.line + 1;
  return from === to ? `@${rel}#L${from}` : `@${rel}#L${from}-${to}`;
}

function askMoreTurns(s, turns) {
  const stopped = neverModeStop('never.why.turns');
  if (stopped !== null) return Promise.resolve(stopped);
  return new Promise((resolve) => {
    if (pendingTurns) pendingTurns.resolve(0);
    pendingTurns = { resolve };
    post({
      type: 'ask',
      text: t('turns.reached', { n: turns }),
      actions: [
        { label: t('turns.more', { n: turns }), action: 'moreturns', answer: String(turns) },
        { label: t('turns.stop'), action: 'moreturns', answer: '0' },
      ],
    });
  });
}

let pendingFailing = null;
function askFailingStreak(times, why) {
  const stopped = neverModeStop('never.why.failing');
  if (stopped !== null) return Promise.resolve(stopped);
  return new Promise((resolve) => {
    if (pendingFailing) pendingFailing.resolve('');
    pendingFailing = { resolve };
    post({
      type: 'ask',
      text: t('failing.reached', { n: times }),
      detail: why,
      kind: 'failing',
      actions: [
        { label: t('failing.go'), action: 'failing', answer: 'go' },
        { label: t('failing.stop'), action: 'failing', answer: '' },
      ],
    });
  });
}

let pendingSilent = null;

let pendingTodosOpen = null;

function askTodosOpen(left) {
  const stopped = neverModeStop('never.why.todos');
  if (stopped !== null) return Promise.resolve(stopped);
  return new Promise((resolve) => {
    if (pendingTodosOpen) pendingTodosOpen.resolve('');
    pendingTodosOpen = { resolve };
    post({
      type: 'ask',
      text: t('todosopen.reached', { n: left.length }),
      detail: left.map((x) => '  - ' + x).join('\n'),
      kind: 'todosopen',
      actions: [
        { label: t('todosopen.go'), action: 'todosopen', answer: 'go' },
        { label: t('todosopen.stop'), action: 'todosopen', answer: '' },
      ],
    });
  });
}

function askSilentStreak(times, why, calledEver) {
  const stopped = neverModeStop('never.why.silent');
  if (stopped !== null) return Promise.resolve(stopped);
  const neverCalled = !calledEver;
  return new Promise((resolve) => {
    if (pendingSilent) pendingSilent.resolve('');
    pendingSilent = { resolve };
    post({
      type: 'ask',
      text: neverCalled
        ? t('silent.never', { model: (session && session.modelSlug) || '?' })
        : t('silent.reached', { n: times }),
      detail: why,
      kind: 'silent',
      actions: [
        { label: t('silent.go'), action: 'silent', answer: 'go' },
        { label: t('silent.stop'), action: 'silent', answer: '' },
      ],
    });
  });
}

let pendingDowngrade = null;
function askDowngrade(info) {
  const when = info.hhmm ? t('downgrade.until', { hhmm: info.hhmm }) : t('downgrade.unknownUntil');
  if (skipsAsking()) {
    const policy = info.until ? 'wait' : 'continue';
    post({ type: 'note', text: t('downgrade.auto.' + policy, { model: info.to || '?', when }) });
    return Promise.resolve(policy);
  }
  return new Promise((resolve) => {
    if (pendingDowngrade) pendingDowngrade.resolve('');
    pendingDowngrade = { resolve };
    post({
      type: 'ask',
      text: t('downgrade.ask', { from: info.from || '?', model: info.to || '?', when }),
      detail: info.notice || '',
      kind: 'downgrade',
      actions: [
        { label: t('downgrade.wait'), action: 'downgrade', answer: 'wait' },
        { label: t('downgrade.go'), action: 'downgrade', answer: 'continue' },
        { label: t('downgrade.stop'), action: 'downgrade', answer: 'stop' },
      ],
    });
  });
}

async function handleCompact() {
  const s2 = ensureSession();
  if (!s2) return;
  if (s2.busy) {
    post({ type: 'note', text: t('note.busySwitch') });
    return;
  }
  const { port } = settings();
  if (!(await ensureBridge(s2, port))) return;

  s2.busy = true;
  post({ type: 'note', text: t('compact.asking') });
  let summary = '';
  try {
    summary = await s2.bridge.ask(compact.COMPACT_PROMPT, {});
  } catch (e) {
    post({ type: 'error', text: t('compact.failed', { why: e.message }) });
    s2.busy = false;
    return;
  }
  s2.busy = false;

  const text = String(summary || '').trim();
  if (!text) {

    post({ type: 'error', text: t('compact.empty') });
    return;
  }

  post({ type: 'note', text: t('compact.summary', { n: text.length }) });
  post({ type: 'answer', text });

  await handleFresh();
  post({ type: 'note', text: t('compact.carried') });
  await handleRun(compact.handoffMessage(text));
}

async function releaseBridge() {
  const s2 = session;
  if (!s2 || !s2.bridge) return { ok: false, port: 0, closedTab: false };
  const port = s2.bridge.port;
  let closedTab = false;

  if (s2.tabOpenedByUs && s2.bridge.retireTab) {
    try {
      closedTab = await s2.bridge.retireTab();
    } catch {

    }
  }
  try {
    await s2.bridge.close();
  } catch {

  }
  session = null;
  return { ok: true, port, closedTab };
}

async function handleExit() {
  const r = await releaseBridge();
  post({
    type: 'note',
    text: r.ok
      ? t(r.closedTab ? 'cmd.releasedWithTab' : 'cmd.released', { port: r.port })
      : t('cmd.releaseNone'),
  });
  if (editorPanel) {
    try {
      editorPanel.dispose();
    } catch {

    }
  }

  try {
    await vscode.commands.executeCommand(
      inSecondaryBar ? 'workbench.action.closeAuxiliaryBar' : 'workbench.action.closeSidebar'
    );
  } catch {

  }
}

const BUILTIN_COMMANDS = [
  { name: 'new', run: () => handleFresh() },
  { name: 'clear', run: () => post({ type: 'clear' }) },
  { name: 'compact', run: () => handleCompact() },

  { name: 'goal', run: () => setGoal() },
  { name: 'resume', run: () => handleHistory() },
  { name: 'skills', run: () => showSkills() },
  { name: 'context', run: () => showContext() },
  { name: 'cost', run: () => showCost() },

  { name: 'exit', run: () => handleExit() },
];

const BRIDGE_PROJECT_NAME = 'ChatGPT Bridge';

const STALL_NOTE_SEC = 30;

let waitingOnGlobal = '';
function setWaitingOn(where) {
  waitingOnGlobal = String(where || '');
}

const BRIDGE_PROJECT_KEY = 'chatgptBridge.dedicatedProject';

const GOAL_KEY = 'chatgptBridge.goal';

async function ensureBridgeProject(s) {

  const pinned = settings().projectUrl || '';
  if (pinned) return { ok: true, url: pinned, mine: false };
  if (!globalStore) return { ok: false, why: 'noStore' };

  const memo = globalStore.get(BRIDGE_PROJECT_KEY, null);
  if (memo && memo.id) {
    setWaitingOn(t('wait.readRules'));

    const state = await projectRuleState(memo.name || BRIDGE_PROJECT_NAME);

    projectRulesLive = !!(state.ok && state.kind === 'same');
    projectRulesLang = projectRulesLive ? rulesLocale() : '';

    if (state.ok && state.kind === 'truncated') {
      post({
        type: 'note',
        text: t('proj.ruleTruncated', {
          name: String(memo.name || BRIDGE_PROJECT_NAME),
          have: String(state.have),
          want: String(state.want),
        }),
      });
      return { ok: true, url: `https://chatgpt.com/g/${memo.id}/project`, mine: true };
    }
    if (state.ok && state.kind !== 'same') {
      setWaitingOn(t('wait.writeRules'));
      const w = await s.bridge.writeInstructions(
        memo.name || BRIDGE_PROJECT_NAME,
        projectInstructions(rulesLocale()),

        { memory: 'project' }
      );
      post({
        type: 'note',
        text: w.ok
          ? t('proj.ruleWritten', { name: String(memo.name || BRIDGE_PROJECT_NAME), n: String(w.len) })
          : t('proj.ruleFailed', { name: String(memo.name || BRIDGE_PROJECT_NAME), why: w.why || '?' }),
      });

      if (w.ok) {
        const again = await projectRuleState(memo.name || BRIDGE_PROJECT_NAME);
        projectRulesLive = !!(again.ok && again.kind === 'same');
        projectRulesLang = projectRulesLive ? rulesLocale() : '';
      }
    } else if (!state.ok) {
      post({ type: 'note', text: t('proj.ruleUnknown', { why: state.why || '?' }) });
    }
    return { ok: true, url: `https://chatgpt.com/g/${memo.id}/project`, mine: true };
  }

  setWaitingOn(t('wait.listProjects'));
  const listed = await s.bridge.listProjects();
  const clash = (listed.projects || []).some(
    (p) => String(p.name || '').trim() === BRIDGE_PROJECT_NAME
  );
  let projName = BRIDGE_PROJECT_NAME;
  if (clash) {

    const alreadyOurs = await projectRuleState(BRIDGE_PROJECT_NAME);
    if (alreadyOurs.ok && alreadyOurs.kind === 'same') {
      projectRulesLive = true;
      projectRulesLang = rulesLocale();
    } else {
    const useIt = t('bp.useExisting');
    const another = t('bp.makeAnother');

    setWaitingOn(t('wait.askingUser'));
    post({ type: 'note', text: t('note.askingModal') });
    const answer = await vscode.window.showWarningMessage(
      t('bp.clash', { name: BRIDGE_PROJECT_NAME }),
      { modal: true },
      useIt,
      another
    );
    if (!answer) return { ok: false, why: t('bp.cancelled') };

    if (answer === another) projName = `${BRIDGE_PROJECT_NAME} (${(storeRoot || 'ws').split('/').pop()})`;
    }
  }

  const made = clash && projName === BRIDGE_PROJECT_NAME
    ? { ok: true, project: '' }
    : await s.bridge.createProject(projName);
  if (!made.ok) return { ok: false, why: t('mk.failed', { why: made.why || '?' }) };
  let id = made.project || '';
  if (!id) {
    setWaitingOn(t('wait.projectId'));
    const r = await s.bridge.projectId(projName);
    if (!r.ok) return { ok: false, why: t('proj.noId', { name: projName }) };
    id = r.project;
  }
  setWaitingOn(t('wait.writeRules'));
  const w = await s.bridge.writeInstructions(projName, projectInstructions(rulesLocale()), {
    memory: 'project',
  });
  post({
    type: 'note',
    text: w.ok
      ? t('mk.done', { name: projName, n: String(w.len) })
      : t('mk.madeOnly', { name: projName, why: w.why || '?' }),
  });
  setWaitingOn('');
  await globalStore.update(BRIDGE_PROJECT_KEY, { id, name: projName });

  if (w.ok) {
    const again = await projectRuleState(projName);
    projectRulesLive = !!(again.ok && again.kind === 'same');
    projectRulesLang = projectRulesLive ? rulesLocale() : '';
  } else {
    projectRulesLive = false;
    projectRulesLang = '';
  }
  return { ok: true, url: `https://chatgpt.com/g/${id}/project`, mine: true };
}

async function setGoal() {
  if (!store) return;
  const now = String(store.get(GOAL_KEY, '') || '');
  const v = await vscode.window.showInputBox({
    title: t('goal.ask'),
    value: now,
    ignoreFocusOut: true,
  });
  if (v === undefined) return;
  const goal = String(v).trim();
  await store.update(GOAL_KEY, goal);
  post({ type: 'note', text: goal ? t('goal.set', { goal }) : t('goal.cleared') });
}

async function checkGoal(summary, wrote) {
  const goal = store ? String(store.get(GOAL_KEY, '') || '') : '';
  if (!goal) return '';
  const s = ensureSession();
  if (!s || !s.bridge) return '';

  const question = buildGoalCheck({ goal, summary, wrote });

  try {

    const spawner = makeSpawner(s, { maxTurns: 6, protectSecrets: settings().protectSecrets });
    const r0 = await spawner([question]);
    const r = (r0 && r0.results && r0.results[0]) || null;
    const said = String((r && r.text) || '').trim();
    if (!said) return '';
    if (/^\s*MET\b/i.test(said)) return '';
    const left = said.replace(/^\s*NOT_MET\b[:：]?\s*/i, '').trim();
    if (!left) return '';
    post({ type: 'note', text: t('goal.notYet') });
    return buildGoalContinue({ goal, left });
  } catch (e) {

    log(`[goal] 審判に聞けませんでした（${e.message}）。そのまま終わります`);
    return '';
  }
}

let projectRulesLive = false;

let projectRulesLang = '';

function hasProjectRules() {
  return projectRulesLive && projectRulesLang === rulesLocale();
}

function rulesLocale() {
  const pick = vscode.workspace.getConfiguration('chatgptBridge').get('projectRulesLanguage', 'auto');
  if (pick && pick !== 'auto') return pick;
  return localeNow();
}

async function projectRuleState(name) {
  const s = ensureSession();
  if (!s) return { ok: false, why: t('why.noWorkspace') };
  const { port } = settings();
  if (!(await ensureBridge(s, port))) return { ok: false, why: t('proj.noBridge', { port: String(port) }) };
  const r = await s.bridge.readInstructions(String(name || ''));
  if (!r.ok) return { ok: false, why: r.why || '?' };
  const have = String(r.text || '');
  const want = projectInstructions(rulesLocale());
  const mark = '"name":"write_file"';
  if (have.trim() === want.trim()) return { ok: true, kind: 'same' };

  const wasTruncated =
    have.length > 0 && have.length < want.length && want.startsWith(have.slice(0, have.length));
  if (wasTruncated) return { ok: true, kind: 'truncated', have: have.length, want: want.length };
  if (have.includes(mark)) return { ok: true, kind: 'stale' };
  if (!have.trim()) return { ok: true, kind: 'empty' };
  return { ok: true, kind: 'other' };
}

const fromWebview = {

  output({ id }) {
    if (!id || !fullOutputs.has(String(id))) return { text: null, why: t('why.noFullOutput') };
    return { text: fullOutputs.get(String(id)) };
  },

  ready() {
    const root = pickWorkspace();
    if (root) replay({ type: 'where', text: root });
    const restored = resumeLastSession(root);
    const past = restored ? restored.entries : [];
    if (past.length) {

      const dropped = Number(restored.dropped || 0);
      replay({
        type: 'note',
        text: dropped
          ? t('note.replayHead.dropped', { n: past.length, d: dropped })
          : t('note.replayHead', { n: past.length }),
      });
      for (const old of past) replay(old);
      replay({ type: 'restored' });
    } else {
      post({ type: 'note', text: t('note.allowlist', { list: settings().allowlist.join(' / ') }) });
    }
  },

  async fork({ at, upto }) {
    const asked = Array.isArray(upto) ? upto.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!asked.length) {
      post({ type: 'note', text: t('fork.nothing') });
      return { ok: false };
    }

    const go = await vscode.window.showInformationMessage(
      t('fork.confirm', { n: String(asked.length) }),
      { modal: true },
      t('fork.go')
    );
    if (go !== t('fork.go')) return { ok: false };

    await handleFresh();

    const body = [
      t('fork.head'),
      '',
      ...asked.map((x, i) => `${i + 1}. ${x}`),
      '',
      t('fork.tail'),
    ].join('\n');
    post({ type: 'prefill', text: body });
    post({ type: 'note', text: t('fork.done', { n: String(asked.length) }) });
    return { ok: true };
  },

  async codeblock({ action, text }) {
    const code = String(text || '');
    if (!code.trim()) return { ok: false };
    if (action === 'copy') {
      await vscode.env.clipboard.writeText(code);
      post({ type: 'note', text: t('note.codeCopied') });
      return { ok: true };
    }
    if (action === 'newfile') {

      const doc = await vscode.workspace.openTextDocument({ content: code });
      await vscode.window.showTextDocument(doc, { preview: false });
      return { ok: true };
    }
    if (action === 'terminal') {

      const term = vscode.window.activeTerminal || vscode.window.createTerminal('ChatGPT Bridge');
      term.show(true);
      term.sendText(code, false);
      post({ type: 'note', text: t('note.codeTerminal') });
      return { ok: true };
    }

    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      vscode.window.showInformationMessage(t('cb.noEditor'));
      return { ok: false };
    }
    await ed.edit((b) => b.insert(ed.selection.active, code));
    post({ type: 'note', text: t('note.codeInserted') });
    return { ok: true };
  },

  async run({ task }) {

    remember({ type: 'you', text: task });

    const hRoot = (session && session.root) || pickWorkspace() || '';
    if (storeRoot) history.add(storeRoot, { text: task, workspace: hRoot });
    await handleRun(task);
  },

  async bang({ command }) {
    const cmd = String(command || '').trim();
    if (!cmd) return;

    const giveUp = (why) => {
      post({ type: 'note', text: why });
      post({ type: 'bangDone', command: cmd, code: -1, pending: pendingBangs.length });
    };
    if (bangRunning) {
      giveUp(t('bang.busy'));
      return;
    }
    const root = (session && session.root) || pickWorkspace();
    if (!root) {
      giveUp(t('bang.noWorkspace'));
      return;
    }

    remember({ type: 'you', text: '!' + cmd });
    if (storeRoot) history.add(storeRoot, { text: '!' + cmd, workspace: root });
    bangRunning = true;
    bangStop = false;

    post({ type: 'cmdout', id: 'bang', command: cmd, chunk: '', started: true });
    let r;
    try {
      r = await runBang({
        command: cmd,
        root,
        onChunk: (piece) => post({ type: 'cmdout', id: 'bang', command: cmd, chunk: piece }),
        shouldStop: () => bangStop,
      });
    } finally {
      bangRunning = false;
    }
    const block = bangBlock({ command: cmd, ...r });
    pendingBangs.push(block);

    post({ type: 'bangDone', command: cmd, code: r.code, pending: pendingBangs.length });
    remember({ type: 'bang', command: cmd, code: r.code });
  },

  cancel() {

    if (bangRunning) bangStop = true;
    if (session) session.cancel = true;

  },

  queueUpdate({ id, text }) {
    const ok = queue.update(String(id || ''), text);
    showQueue();
    return { ok };
  },

  queueRemove({ id }) {
    const ok = queue.remove(String(id || ''));
    showQueue();
    return { ok };
  },

  queueClear() {
    const n = queue.clear();
    showQueue();
    return { removed: n };
  },

  runCommand({ name }) {
    const c2 = BUILTIN_COMMANDS.find((x) => x.name === String(name || ''));
    if (!c2) return { ok: false, why: t('cmd.unknown', { name }) };
    try {
      c2.run();
      return { ok: true };
    } catch (e) {
      return { ok: false, why: e.message };
    }
  },

  async keys({ enterSends } = {}) {

    if (typeof enterSends === 'boolean') {
      await vscode.workspace
        .getConfiguration('chatgptBridge')
        .update('requireModifierToSend', !enterSends, vscode.ConfigurationTarget.Global);
    }
    return { enterSends: !settings().requireModifierToSend };
  },

  history() {
    const root = (session && session.root) || pickWorkspace() || '';
    if (!storeRoot) return { items: [] };
    return { items: history.recent(storeRoot, { workspace: root, limit: 100 }) };
  },

  skills({ query }) {

    const names = globalrules.skillNames(null, { forHuman: true });

    const built = BUILTIN_COMMANDS.map((c2) => c2.name);

    const root = (session && session.root) || pickWorkspace() || '';
    const usedRecently = storeRoot ? history.recentSkills(storeRoot, { workspace: root }) : [];
    const all = rankSkills(built, query).concat(rankSkills(names, query));
    const recentFirst = usedRecently.filter((x) => all.includes(x));
    return {
      items: recentFirst.concat(all.filter((x) => !recentFirst.includes(x))),
      builtin: built,

      recent: recentFirst.length,
    };
  },

  async files({ query }) {
    const root = (session && session.root) || pickWorkspace();
    if (!root) return { items: [] };
    const now = Date.now();
    if (!fileListCache || fileListCache.root !== root || now - fileListCache.at > 5000) {
      const found = await vscode.workspace.findFiles('**/*', MENTION_EXCLUDE, 4000);
      const { protectSecrets } = settings();
      const items = [];

      const dirs = new Set();
      for (const uri of found) {
        const rel = path.relative(root, uri.fsPath).split(path.sep).join('/');
        if (!rel || rel.startsWith('..')) continue;
        if (whyBlocked(root, rel, { protectSecrets, unrestricted: unrestricted() })) continue;
        items.push(rel);

        for (let cut = rel.lastIndexOf('/'); cut > 0; ) {
          const dir = rel.slice(0, cut);
          if (dirs.has(dir)) break;
          dirs.add(dir);
          cut = dir.lastIndexOf('/');
        }
      }

      fileListCache = { root, at: now, items, dirs: [...dirs].map((x) => x + '/') };
    }

    const opened = [];

    const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
    for (const g of groups) {
      for (const t of g.tabs || []) {
        const u = t.input && t.input.uri;
        if (!u || u.scheme !== 'file') continue;
        const rel = path.relative(root, u.fsPath).split(path.sep).join('/');
        if (!rel || rel.startsWith('..')) continue;
        if (!opened.includes(rel)) opened.push(rel);
      }
    }

    const marks = [];
    try {
      const diags = vscode.languages.getDiagnostics ? vscode.languages.getDiagnostics() : [];
      let n = 0;
      for (const [, list] of diags) n += (list || []).length;
      if (n > 0) marks.push(PROBLEMS_MARK);
    } catch {

    }
    const all = marks.concat(fileListCache.items, fileListCache.dirs || []);
    const ranked = rankCandidates(all, query, 12);

    const openedHit = rankCandidates(opened, query, 4);
    return {
      items: openedHit.concat(ranked.filter((x) => !openedHit.includes(x))).slice(0, 14),
      opened: openedHit.length,
    };
  },

  async runFresh({ task }) {
    const text = String(task || '');
    if (!text.trim()) return;
    remember({ type: 'you', text });
    const hRoot = (session && session.root) || pickWorkspace() || '';
    if (storeRoot) history.add(storeRoot, { text, workspace: hRoot });

    await handleFresh();
    post({ type: 'you', text });
    await handleRun(text);
  },

  async openPath({ path: rel, line }) {
    const s2 = ensureSession();
    if (!s2 || !s2.root) return { ok: false };
    const nm = String(rel || '').trim();
    if (!nm) return { ok: false };

    if (
      whyBlocked(s2.root, nm, {
        protectSecrets: settings().protectSecrets,
        unrestricted: unrestricted(),
      })
    )
      return { ok: false };
    const full = path.join(s2.root, nm);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
      const n = Number(line);
      const ed = await vscode.window.showTextDocument(doc, { preview: true });
      if (Number.isInteger(n) && n > 0) {
        const at = new vscode.Position(Math.min(n - 1, doc.lineCount - 1), 0);
        ed.selection = new vscode.Selection(at, at);
        ed.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
      }
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },

  mentionsExist({ names }) {
    const s = ensureSession();
    const found = {};
    const list = Array.isArray(names) ? names : [];
    for (const raw of list) {
      const nm = String(raw || '');
      if (!nm) continue;
      if (nm === PROBLEMS_MARK) {
        found[nm] = true;
        continue;
      }
      if (!s || !s.root) {
        found[nm] = true;
        continue;
      }

      const p = splitRange(nm).path;
      try {
        found[nm] = fs.existsSync(resolveInside(s.root, p));
      } catch {
        found[nm] = false;
      }
    }
    return { ok: true, exists: found };
  },

  async newconv() {
    const s = session;
    if (!s || !s.pendingTask) return { started: false, why: t('why.noPendingTask') };
    const task = s.pendingTask;
    s.pendingTask = null;
    s.conversationOk = false;
    await handleFresh();

    post({ type: 'you', text: task });
    await handleRun(task);
    return { started: true };
  },

  async usethis() {
    const s = session;
    if (!s || !s.pendingTask) return { started: false, why: t('why.noPendingTask') };
    const task = s.pendingTask;
    s.pendingTask = null;
    s.conversationOk = true;
    if (current && s.bridge) {
      current.conversationId = s.bridge.conversationId();
      current.conversationUrl = s.bridge.conversationUrl();
      sessions.save(storeRoot, current);
    }
    await handleRun(task);
    return { started: true };
  },

  async mode({ mode }) {
    const { ORDER } = require('./webview/src/ui/modeCycle');
    const want = String(mode || '');
    if (!ORDER.includes(want)) return { mode: settings().mode };
    await vscode.workspace
      .getConfiguration('chatgptBridge')
      .update('mode', want, vscode.ConfigurationTarget.Global);
    return { mode: want };
  },

  async thinking({ on } = {}) {
    if (typeof on !== 'boolean') return { on: settings().thinking };
    await vscode.workspace
      .getConfiguration('chatgptBridge')
      .update('thinking', on, vscode.ConfigurationTarget.Global);
    return { on };
  },

  async choice({ answer }) {
    const text = String(answer || '').trim();
    if (!text) return { started: false, why: t('ask.cantStart') };
    markAnswered(text, 'choice');
    await handleRun(text);
    return { started: true };
  },

  todosopen({ answer }) {
    const w = pendingTodosOpen;
    if (!w) return { started: false, why: t('ask.cantStart') };
    pendingTodosOpen = null;
    markAnswered(String(answer || ''), 'todosopen');

    w.resolve(String(answer || ''));
    return { started: true };
  },

  silent({ answer }) {
    const w = pendingSilent;
    if (!w) return { started: false, why: t('ask.cantStart') };
    pendingSilent = null;
    markAnswered(String(answer || ''), 'silent');

    w.resolve(String(answer || ''));
    return { started: true };
  },

  downgrade({ answer }) {
    const w = pendingDowngrade;
    if (!w) return { started: false, why: t('ask.cantStart') };
    pendingDowngrade = null;
    markAnswered(String(answer || ''), 'downgrade');

    w.resolve(String(answer || ''));
    return { started: true };
  },

  failing({ answer }) {
    const w = pendingFailing;
    if (!w) return { started: false, why: t('ask.cantStart') };
    pendingFailing = null;
    markAnswered(String(answer || ''), 'failing');

    w.resolve(String(answer || ''));
    return { started: true };
  },

  moreturns({ answer }) {
    const w = pendingTurns;
    if (!w) return { started: false, why: t('ask.cantStart') };
    pendingTurns = null;
    markAnswered(String(Number(answer) || 0));
    w.resolve(Number(answer) || 0);
    return { started: true };
  },

  async askrun({ answer }) {
    const w = pendingCommand;
    if (!w) return { started: false, why: t('ask.cantStart') };
    pendingCommand = null;
    const chosen = answer === 'always' ? 'always' : answer === 'once' ? 'once' : 'no';
    markAnswered(chosen, 'command');
    w.resolve(chosen);
    return { started: true };
  },

  async gitinit() {
    if (!session) return { started: false, why: t('why.noWorkspace') };
    await handleGitInit();
    return { started: true };
  },

  async showdiff({ diffKey, target, newFile }) {
    return { opened: await showDiff(diffKey, target, newFile) };
  },

  diff({ sha }) {
    if (!session) return { opened: false };

    const dir = checkpoint.dirFor(session.root);
    const gitDir = path.join(dir, '.git');
    if (!fs.existsSync(gitDir)) return { opened: false, why: t('why.noCheckpoint') };
    runInTerminal(
      session.root,
      `git --git-dir=${JSON.stringify(gitDir)} --work-tree=${JSON.stringify(session.root)} diff ${sha}..HEAD`
    );
    return { opened: true };
  },

  async revert({ sha }) {
    if (!session) return { reverted: false, why: t('why.noWorkspace') };

    if (session.busy) {
      return { reverted: false, why: t('why.busyRevert') };
    }
    if (!sha || !/^[0-9a-f]{4,40}$/i.test(String(sha))) {
      return { reverted: false, why: t('why.badSha') };
    }
    const sure = await vscode.window.showWarningMessage(
      t('revert.confirm', { sha }),
      { modal: true },
      t('revert.yes')
    );
    if (sure !== t('revert.yes')) return { reverted: false, why: t('why.cancelled') };

    const root = session && session.root;
    if (!root) return { reverted: false, why: t('why.noWorkspace') };
    try {

      if (!checkpoint.has(root, String(sha))) {
        return { reverted: false, why: t('why.badSha') };
      }
      checkpoint.restore(root, String(sha));
    } catch (e) {
      const why = String((e && e.stderr) || (e && e.message) || e).trim().split('\n')[0];
      log(`[戻す] 失敗: ${why}`);
      return { reverted: false, why };
    }

    clearOverlays();
    return { reverted: true };
  },
};

function paintPanel(webviewView) {

    const panelSrc = fs.readFileSync(path.join(__dirname, 'webview', 'panel.html'), 'utf8');
    const bundle = path.join(__dirname, 'webview', 'dist', 'panel.js');

    if (!fs.existsSync(bundle)) {
      webviewView.webview.html =
        '<body style="font-family:sans-serif;padding:16px">' +
        `<h3>${t('build.missing.title')}</h3><p>${t('build.missing.body')}</p>` +
        `<p style="opacity:.7">${t('build.missing.where', { path: bundle })}</p></body>`;
      log(`[画面] 束が無い: ${bundle}`);
      return;
    }

    const mark = require('./src/panelmark').panelMark();

    const codeMark = require('crypto')
      .createHash('sha1')
      .update(
        [
          'extension.js',
          'src/agent.js',
          'src/protocol.js',
          'src/tools.js',
          'src/skillmatch.js',

          'src/bridge.js',
          'src/pool.js',
          'src/subagents.js',
          'src/queue.js',
        ]
          .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8'))
          .join('')
      )
      .digest('hex')
      .slice(0, 12);
    const bundleUri = webviewView.webview.asWebviewUri(vscode.Uri.file(bundle));

    const locale = localeNow();
    webviewView.webview.html = panelSrc

      .replace(/__CSP_SOURCE__/g, webviewView.webview.cspSource)
      .replace('__BUNDLE__', String(bundleUri))
      .replace(
        '__CODICON__',
        String(
          webviewView.webview.asWebviewUri(
            vscode.Uri.file(
              path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
            )
          )
        )
      )

      .replace(/__LOCALE__/g, String(locale).replace(/[^A-Za-z0-9_-]/g, ''))
      .replace(
        '<head>',
        `<head>\n    <meta name="panel-mark" content="${mark}" />\n    <meta name="code-mark" content="${codeMark}" />`
      );
}

function wirePanel(webviewView) {
    view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(__dirname, 'webview', 'dist')),

        vscode.Uri.file(path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist')),
      ],
    };
    paintPanel(webviewView);

    if (vscode.workspace.getConfiguration().get('chatgptBridge.focusView', false)) {
      post({ type: 'focusview', on: true });
    }

    webviewView.webview.onDidReceiveMessage(async (m) => {

      let replied = false;
      const reply = (data) => {
        if (replied || !m || !m.id) return;
        replied = true;
        send(m.type, data, m.id);
      };

      const type = m && m.type;
      if (typeof type !== 'string' || !Object.hasOwn(fromWebview, type)) {
        log(`[画面] 知らない合図: ${type}`);
        reply({ ok: false, error: t('why.unknownSignal', { type }) });
        return;
      }

      try {
        reply({ ok: true, value: await fromWebview[type](m.data || {}) });
      } catch (e) {
        log(`[画面] ${type} で失敗: ${e.message}`);
        reply({ ok: false, error: e.message });
      }
    });

    webviewView.onDidDispose(() => {

      if (view !== webviewView) return;
      if (session && session.bridge) {
        try {
          session.bridge.close();
        } catch {}
      }
      session = null;
      view = null;
    });
}

function openInEditor() {
  if (editorPanel) {
    editorPanel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'chatgptBridgePanel',
    t('extension.displayName') || 'ChatGPT Bridge',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,

      retainContextWhenHidden: true,
    }
  );
  editorPanel = panel;
  const before = view;
  wirePanel(panel);
  panel.onDidDispose(() => {
    editorPanel = null;

    if (before && before !== panel) {
      view = before;
      paintPanel(before);
      return;
    }

    if (session && session.bridge) {
      try {
        session.bridge.close();
      } catch {

      }
      session = null;
    }
    view = null;
  });
}

const provider = {

  resolveWebviewView(webviewView) {
    wirePanel(webviewView);
  },
};

const uriHandler = {
  async handleUri(uri) {

    const params = new URLSearchParams(uri.query || '');
    const route = (uri.path || '').replace(/^\//, '');

    const want = params.get('root');
    if (want) {
      const here = pickWorkspace();
      if (here !== want) {
        vscode.window.showWarningMessage(
          t('error.otherWorkspace', { want, here: here || t('error.noFolderOpen') })
        );
        return;
      }
    }

    if (route === 'run') {
      const task = params.get('task');
      if (!task) {
        vscode.window.showErrorMessage(t('error.noTask'));
        return;
      }
      await vscode.commands.executeCommand('chatgptBridge.focus');

      post({ type: 'you', text: task });
      await handleRun(task);
      return;
    }
    if (route === 'new') {
      await handleFresh();
      return;
    }
    if (route === 'focus') {
      await vscode.commands.executeCommand('chatgptBridge.focus');
      return;
    }
    vscode.window.showWarningMessage(t('error.unknownRoute', { route }));
  },
};

let pendingCommand = null;

function askPermissionFromPanel({ kind, detail, always }) {
  return new Promise((resolve) => {

    if (pendingCommand) pendingCommand.resolve('no');
    pendingCommand = { resolve };
    const isPath = kind === 'path' || kind === 'pathWrite';

    const isMode = kind === 'mode';

    const isWorktree = kind === 'worktree';

    const isPlan = kind === 'plan';

    const isSetting = kind === 'setting';

    const isMcp = kind === 'mcp';

    const isBrowser = kind === 'browser';

    const isWrite = kind === 'pathWrite';

    const isWriteInside = kind === 'pathWriteInside';
    post({
      type: 'ask',
      text: t(
        isSetting
          ? 'ask.changeSetting'
          : isMcp
          ? 'ask.useMcp'
          : isBrowser
          ? 'ask.useBrowser'
          : isPlan
          ? 'ask.exitPlan'
          : isWorktree
          ? 'ask.makeWorktree'
          : isMode
          ? 'ask.switchMode'
          : isWriteInside
            ? 'ask.usePathWriteInside'
            : isWrite
            ? 'ask.usePathWrite'
            : isPath
              ? 'ask.usePath'
              : 'ask.runCommand'
      ),

      kind,
      detail,
      actions: [
        { label: t('action.runOnce'), action: 'askrun', answer: 'once' },

        ...(isPath || always
          ? [
              {
                label: isWrite
                  ? t('action.allowFolderWrite', { dir: dirLabel(detail) })
                  : isPath
                    ? t('action.allowFolder', { dir: dirLabel(detail) })
                    : isMcp
                      ? t('action.allowServer', { server: always })
                      : isBrowser
                        ? t('action.allowSite', { site: always })
                        : t('action.allowProgram', { prog: always }),
                action: 'askrun',
                answer: 'always',
              },
            ]
          : []),
        { label: t('action.runNo'), action: 'askrun', answer: 'no' },
      ],
    });
  });
}

const revokedAllows = new Set();
const revokeKey = (kind, detail) => `${kind}\n${String(detail)}`;
function isRevokedAllow({ kind, detail }) {
  return revokedAllows.has(revokeKey(kind, detail));
}

function dirLabel(abs) {
  try {
    return require('fs').statSync(abs).isDirectory() ? abs : path.dirname(abs);
  } catch {
    return path.dirname(abs);
  }
}

const PROBLEM_WAITS_VISIBLE = [750, 750];
const PROBLEM_WAITS_HIDDEN = [1000];

const problemsBefore = new Map();

const linesBefore = new Map();

function snapProblems(abs) {
  try {
    problemsBefore.set(abs, vscode.languages.getDiagnostics ? vscode.languages.getDiagnostics() : []);
  } catch {
    problemsBefore.delete(abs);
  }
  try {
    const doc = vscode.workspace.textDocuments.find((d) => d && d.uri && d.uri.fsPath === abs);
    linesBefore.set(abs, doc ? doc.lineCount : 0);
  } catch {
    linesBefore.set(abs, 0);
  }
}

function isVisible(abs) {
  try {
    return (vscode.window.visibleTextEditors || []).some(
      (e) => e && e.document && e.document.uri && e.document.uri.fsPath === abs
    );
  } catch {
    return false;
  }
}

async function problemsAfterTouch(abs) {
  if (!vscode.workspace.getConfiguration().get('chatgptBridge.diagnosticsAfterEdit', true)) return '';
  const before = problemsBefore.get(abs);
  const linesWas = linesBefore.get(abs) || 0;
  problemsBefore.delete(abs);
  linesBefore.delete(abs);
  if (!before) return '';
  const root = pickWorkspace() || '';
  const waits = isVisible(abs) ? PROBLEM_WAITS_VISIBLE : PROBLEM_WAITS_HIDDEN;
  for (const ms of waits) {
    await new Promise((r) => setTimeout(r, ms));
    let after = [];
    try {
      after = vscode.languages.getDiagnostics ? vscode.languages.getDiagnostics() : [];
    } catch {
      return '';
    }
    let haba = 0;
    try {
      const doc = vscode.workspace.textDocuments.find((d) => d && d.uri && d.uri.fsPath === abs);
      haba = doc ? Math.abs(doc.lineCount - linesWas) : 0;
    } catch {
      haba = 0;
    }
    const text = formatNewProblems(newProblems(before, after, haba), root, path.relative, PROBLEMS_MAX);

    if (text) return text;
  }
  return '';
}

async function saveIfDirty(abs) {
  if (!vscode.workspace.getConfiguration().get('chatgptBridge.autosave', true)) return;

  snapProblems(abs);
  const doc = pickDirty(vscode.workspace.textDocuments, abs);
  if (!doc) return;
  try {
    await doc.save();
    post({ type: 'note', text: t('note.savedBeforeTouch', { file: path.basename(abs) }) });
  } catch {

  }
}

const CODE_ASKS = [
  { id: 'explainCode', key: 'ask.explain' },
  { id: 'fixCode', key: 'ask.fix' },
  { id: 'improveCode', key: 'ask.improve' },
];

async function askAboutSelection(key) {
  const at = selectionMention();
  if (!at) {
    vscode.window.showInformationMessage(t('sel.noEditor'));
    return;
  }
  await vscode.commands.executeCommand('chatgptBridge.focus');

  send('insert', { text: `${t(key)} ${at}\n` });
}

const codeAskProvider = {
  provideCodeActions(document, range) {
    if (range.isEmpty) return [];
    return CODE_ASKS.map((a) => {
      const act = new vscode.CodeAction(t(a.key), vscode.CodeActionKind.QuickFix);
      act.command = { command: `chatgptBridge.${a.id}`, title: t(a.key) };
      return act;
    });
  },
};

const TERM_ASKS = [
  { id: 'terminalAddToContext', key: 'term.add', cmd: 'copyLastCommandAndLastCommandOutput' },
  { id: 'terminalFixCommand', key: 'term.fix', cmd: 'copyLastCommandAndLastCommandOutput' },
  { id: 'terminalExplainCommand', key: 'term.explain', cmd: 'copyLastCommand' },
];

async function askAboutTerminal(key, which) {

  const before = await vscode.env.clipboard.readText();
  let text = '';
  try {
    await vscode.commands.executeCommand(`workbench.action.terminal.${which}`);
    text = await vscode.env.clipboard.readText();
  } catch {
    text = '';
  } finally {
    await vscode.env.clipboard.writeText(before);
  }
  const got = String(text || '').trim();
  if (!got || got === String(before || '').trim()) {

    vscode.window.showInformationMessage(t('term.nothing'));
    return;
  }
  await vscode.commands.executeCommand('chatgptBridge.focus');

  send('insert', { text: `${t(key)}\n\n\`\`\`\n${got.slice(0, 4000)}\n\`\`\`\n` });
}

async function newCustomization() {
  const s = ensureSession();
  const kinds = [
    { label: t('scaffold.skill'), kind: 'skill' },
    { label: t('scaffold.rules'), kind: 'rules' },
    { label: t('scaffold.globalRules'), kind: 'globalRules' },
    { label: t('scaffold.hooks'), kind: 'hooks' },
    { label: t('scaffold.mode'), kind: 'mode' },
  ];
  const pick = await vscode.window.showQuickPick(kinds, { title: t('scaffold.title') });
  if (!pick) return;
  if (pick.kind === 'mode') {

    await vscode.commands.executeCommand('workbench.action.openSettings', 'chatgptBridge.modes');
    return;
  }
  let name = '';
  if (pick.kind === 'skill') {
    name = await vscode.window.showInputBox({
      title: t('scaffold.skillName'),
      validateInput: (v) => (safeName(v) ? null : t('scaffold.badName')),
    });
    if (!name) return;
  }
  const p = plan(pick.kind, { root: s ? s.root : '', home: os.homedir(), name });
  if (p.error) {
    vscode.window.showErrorMessage(t('scaffold.cannot'));
    return;
  }
  const uri = vscode.Uri.file(p.file);
  let existed = false;
  try {
    await vscode.workspace.fs.stat(uri);
    existed = true;
  } catch {

  }
  if (!existed) {

    await vscode.workspace.fs.writeFile(uri, Buffer.from(p.body, 'utf8'));
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  post({ type: 'note', text: t(existed ? 'note.scaffoldOpened' : 'note.scaffoldMade', { path: p.file }) });
}

async function writeProjectInstructions() {
  const s = ensureSession();
  if (!s) return;
  const { port } = settings();
  if (!(await ensureBridge(s, port))) {
    vscode.window.showWarningMessage(t('proj.noBridge', { port: String(port) }));
    return;
  }
  const r = await s.bridge.listProjects();
  if (!r.ok || !(r.projects || []).length) {
    vscode.window.showWarningMessage(t('proj.none', { where: r.where || '?', n: String(r.links || 0) }));
    return;
  }
  const picked = await vscode.window.showQuickPick(
    r.projects.map((p) => ({ label: p.name })),
    { placeHolder: t('rules.pick') }
  );
  if (!picked) return;
  const body = projectInstructions(rulesLocale());

  const go = await vscode.window.showWarningMessage(
    t('rules.confirm', { name: picked.label, n: String(body.length) }),
    { modal: true },
    t('rules.go')
  );
  if (go !== t('rules.go')) return;
  const w = await s.bridge.writeInstructions(picked.label, body);
  if (w.ok) vscode.window.showInformationMessage(t('rules.done', { name: picked.label, n: String(w.len) }));
  else vscode.window.showWarningMessage(t('rules.failed', { why: w.why || '?' }));
}

async function newConversationAs() {
  const modes = settings().modes || [];
  if (!modes.length) {

    const answer = await vscode.window.showInformationMessage(
      t('role.none'),
      t('role.make')
    );
    if (answer === t('role.make')) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'chatgptBridge.modes');
    }
    return;
  }
  const pick = await vscode.window.showQuickPick(
    modes.map((m) => ({
      label: m.name || m.slug,
      description: m.whenToUse || '',
      detail: (m.disabledTools || []).length ? t('role.without', { list: (m.disabledTools || []).join(' / ') }) : '',
      slug: m.slug,
    })),
    { title: t('role.pick') }
  );
  if (!pick) return;
  pendingStartMode = pick.slug;
  await handleFresh();
  post({ type: 'note', text: t('note.startedAs', { name: pick.label }) });
}

function dropCarriedTabs(s) {
  const list = s && s.openTabs;
  if (!list || !list.length) return;
  s.openTabs = null;
  let browser;
  try {
    browser = require('./src/browser');
  } catch {
    return;
  }
  for (const [id] of list) browser.close(id).catch(() => {});
}

function openWalkthrough() {

  const pkg = require('./package.json');
  const id = `${pkg.publisher}.${pkg.name}`;
  return vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    `${id}#${pkg.contributes.walkthroughs[0].id}`,
    false
  );
}

async function openCustomizations() {
  const s = ensureSession();
  const list = [];
  for (const x of places({ root: s ? s.root : '', home: os.homedir() })) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(x.file));
      list.push({ label: t(`scaffold.${x.kind}`), description: x.file, file: x.file });
    } catch {

    }
  }
  if (!list.length) {

    vscode.window.showInformationMessage(t('scaffold.none'));
    return;
  }
  const pick = await vscode.window.showQuickPick(list, { title: t('scaffold.openTitle') });
  if (!pick) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pick.file));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function exportChat() {
  if (!current || !Array.isArray(current.entries) || !current.entries.length) {
    vscode.window.showInformationMessage(t('export.empty'));
    return;
  }
  const md = toMarkdown(current, {
    at: new Date().toISOString(),
    workspace: current.workspace || '',
  });
  const uri = await vscode.window.showSaveDialog({

    filters: { Markdown: ['md'], JSON: ['json'] },
    saveLabel: t('export.save'),
  });
  if (!uri) return;
  const json = /\.json$/i.test(uri.fsPath);
  const body = json ? JSON.stringify(current, null, 1) : md;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(body, 'utf8'));
  post({ type: 'note', text: t('note.exported', { path: uri.fsPath }) });
}

async function importChat() {
  const picked = await vscode.window.showOpenDialog({
    filters: { JSON: ['json'] },
    canSelectMany: false,
    openLabel: t('import.open'),
  });
  if (!picked || !picked.length) return;
  let text;
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
  } catch (e) {
    vscode.window.showErrorMessage(t('import.unreadable', { why: String((e && e.message) || e) }));
    return;
  }
  const r = parseImported(text);
  if (!r.ok) {

    vscode.window.showErrorMessage(t('import.bad', { why: t(r.why) }));
    return;
  }

  const ready = forImport(r.session, {
    id: sessions.newId(Date.now()),
    nowMs: Date.now(),
    label: t('import.label'),
  });
  sessions.save(storeRoot, ready);
  post({
    type: 'note',
    text: t('import.done', { n: String(ready.entries.length), title: ready.title }),
  });
}

function openSettings() {
  return vscode.commands.executeCommand('workbench.action.openSettings', 'chatgptBridge');
}

function clearInputHistory() {
  post({ type: 'clearhistory' });
  post({ type: 'note', text: t('note.historyCleared') });
}

function gotoCodeBlock(dir) {
  post({ type: 'codeblocknav', dir });
}

async function deleteAllSessions() {
  const root = pickWorkspace() || '';
  const all = sessions.list(storeRoot, {});
  const here = root ? sessions.list(storeRoot, { workspace: root }) : [];
  if (!all.length) {
    post({ type: 'note', text: t('wipe.none') });
    return;
  }

  const picks = [];
  if (root && here.length) {
    picks.push({
      label: t('wipe.here'),
      description: t('wipe.count', { n: String(here.length) }),
      detail: root,
      scope: 'here',
    });
  }
  picks.push({
    label: t('wipe.all'),
    description: t('wipe.count', { n: String(all.length) }),
    detail: sessions.dirOf(storeRoot),
    scope: 'all',
  });
  const chosen = await vscode.window.showQuickPick(picks, { title: t('wipe.pick') });
  if (!chosen) return;

  const n = chosen.scope === 'here' ? here.length : all.length;

  const answer = await vscode.window.showWarningMessage(
    t('wipe.confirm', { n: String(n) }),
    { modal: true, detail: t('wipe.detail', { where: sessions.dirOf(storeRoot) }) },
    t('wipe.go')
  );
  if (answer !== t('wipe.go')) return;

  const r = sessions.removeAll(storeRoot, chosen.scope === 'here' ? { workspace: root } : {});

  post({
    type: 'note',
    text: r.left
      ? t('wipe.partial', { n: String(r.removed), left: String(r.left) })
      : t('wipe.done', { n: String(r.removed) }),
  });
}

async function disconnectTab() {
  if (!session || !session.bridge) {
    post({ type: 'note', text: t('conn.none') });
    return;
  }

  if (session.busy) {
    post({ type: 'note', text: t('conn.busy') });
    return;
  }
  const ok = await session.bridge.retireTab();
  post({ type: 'note', text: ok ? t('conn.cut') : t('conn.cutFailed') });
}

async function reconnectTab() {
  if (!session || !session.bridge) {
    post({ type: 'note', text: t('conn.none') });
    return;
  }
  if (session.busy) {
    post({ type: 'note', text: t('conn.busy') });
    return;
  }
  post({ type: 'note', text: t('conn.again') });
  try {

    await session.bridge.reloadTab();
    post({ type: 'note', text: t('conn.back', { where: session.bridge.currentUrl() || '' }) });
  } catch (e) {

    post({ type: 'note', text: t('conn.backFailed', { why: String((e && e.message) || e) }) });
  }
}

function acceptInput() {
  post({ type: 'submit' });
}

function blurPanel() {
  post({ type: 'blur' });
}

async function openInNewWindow() {
  openInEditor();

  await new Promise((r) => setTimeout(r, 400));
  try {
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  } catch (e) {
    vscode.window.showWarningMessage(t('note.newWindowFailed', { why: String(e.message || e) }));
  }
}

async function createWorktree() {
  const s = ensureSession();
  if (!s) return;
  const name = await vscode.window.showInputBox({
    title: t('worktree.title'),
    prompt: t('worktree.prompt'),
    validateInput: (v) =>
      /^[A-Za-z0-9._\-/]{1,64}$/.test(String(v || '').trim()) ? null : t('worktree.badName'),
  });
  if (!name) return;
  const dest = path.join(path.dirname(s.root), '.bridge-worktrees', `${path.basename(s.root)}--${name}`);
  try {
    require('child_process').execFileSync(
      'git',
      ['-C', s.root, 'worktree', 'add', '-b', name.trim(), dest],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    vscode.window.showErrorMessage(t('worktree.failed', { why: String(e.message || e).slice(0, 200) }));
    return;
  }
  post({ type: 'note', text: t('note.worktreeMade', { path: dest }) });
  const answer = await vscode.window.showInformationMessage(
    t('worktree.made', { path: dest }),
    t('worktree.open'),
    t('worktree.stay')
  );
  if (answer === t('worktree.open')) {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), {
      forceNewWindow: true,
    });
  }
}

async function toggleFocusView() {
  const c = vscode.workspace.getConfiguration();
  const now = !c.get('chatgptBridge.focusView', false);
  await c.update('chatgptBridge.focusView', now, vscode.ConfigurationTarget.Workspace);
  post({ type: 'focusview', on: now });
  post({ type: 'note', text: t(now ? 'note.focusOn' : 'note.focusOff') });
}

async function forgetAllowed() {
  const c = vscode.workspace.getConfiguration();

  const groups = [
    { key: 'chatgptBridge.allowlist', kind: 'command', kindLabel: t('forget.kindCommand') },
    { key: 'chatgptBridge.allowedOutside', kind: 'path', kindLabel: t('forget.kindRead') },
    { key: 'chatgptBridge.allowedOutsideWrite', kind: 'pathWrite', kindLabel: t('forget.kindWrite') },
    { key: 'chatgptBridge.allowedMcpServers', kind: 'mcp', kindLabel: t('forget.kindMcp') },
    { key: 'chatgptBridge.allowedSites', kind: 'browser', kindLabel: t('forget.kindSite') },
  ];
  const items = [];
  for (const b of groups) {
    for (const v of c.get(b.key, [])) items.push({ label: String(v), description: b.kindLabel, key: b.key });
  }
  if (!items.length) {

    vscode.window.showInformationMessage(t('forget.none'));
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: t('forget.title'),
    placeHolder: t('forget.placeholder'),
  });
  if (!picked || !picked.length) return;
  for (const b of groups) {
    const drop = picked.filter((x) => x.key === b.key).map((x) => x.label);
    if (!drop.length) continue;
    const rest = c.get(b.key, []).filter((v) => !drop.includes(String(v)));

    await c.update(b.key, rest, vscode.ConfigurationTarget.Workspace);

    for (const v of drop) revokedAllows.add(revokeKey(b.kind, v));
  }
  post({ type: 'note', text: t('note.forgotAllowed', { n: String(picked.length) }) });
}

async function allowAlways({ kind, detail }) {

  revokedAllows.delete(revokeKey(kind, detail));
  if (kind === 'path' || kind === 'pathWrite') {
    revokedAllows.delete(revokeKey(kind, dirLabel(detail)));
  }
  if (kind === 'path' || kind === 'pathWrite') {
    const c = vscode.workspace.getConfiguration();

    const key =
      kind === 'pathWrite' ? 'chatgptBridge.allowedOutsideWrite' : 'chatgptBridge.allowedOutside';
    const dir = dirLabel(detail);
    const now = c.get(key, []);
    if (now.includes(dir)) return;
    await c.update(key, now.concat([dir]), vscode.ConfigurationTarget.Workspace);
    post({ type: 'note', text: t('note.allowedAlways', { cmd: dir }) });
    return;
  }
  if (kind === 'browser') {

    const c = vscode.workspace.getConfiguration();
    const key = 'chatgptBridge.allowedSites';
    const now = c.get(key, []);
    if (now.includes(detail)) return;
    await c.update(key, now.concat([detail]), vscode.ConfigurationTarget.Workspace);
    post({ type: 'note', text: t('note.allowedAlways', { cmd: detail }) });
    return;
  }
  if (kind === 'mcp') {

    const c = vscode.workspace.getConfiguration();
    const key = 'chatgptBridge.allowedMcpServers';
    const now = c.get(key, []);
    if (now.includes(detail)) return;
    await c.update(key, now.concat([detail]), vscode.ConfigurationTarget.Workspace);
    post({ type: 'note', text: t('note.allowedAlways', { cmd: detail }) });
    return;
  }
  return allowAlwaysCommand(detail);
}

async function allowAlwaysCommand(cmd) {
  const c = vscode.workspace.getConfiguration();
  const now = c.get('chatgptBridge.allowlist', []);
  if (now.includes(cmd)) return;
  await c.update('chatgptBridge.allowlist', now.concat([cmd]), vscode.ConfigurationTarget.Workspace);
  post({ type: 'note', text: t('note.allowedAlways', { cmd }) });
}

function activate(context) {

  if (vscode.workspace.getConfiguration().get('chatgptBridge.revealOnStart', false)) {
    setTimeout(() => {
      vscode.commands.executeCommand('chatgptBridge.focus').then(
        () => {},
        () => {}
      );
    }, 1200);
  }

  store = context.workspaceState;
  globalStore = context.globalState;

  schedule.restore(store.get(SCHEDULE_KEY, []));
  if (!schedule.isEmpty()) startScheduleWatch();

  storeRoot = context.globalStorageUri.fsPath;

  history.trim(storeRoot);

  sessions.useTranslator((k, v) => t(k, v));
  channel = vscode.window.createOutputChannel(t('app.title'));
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('chatgptBridge.language')) return;
      translator = null;
      if (view) paintPanel(view);
    })
  );

  const secondary = supportsSecondarySidebar(vscode.version);
  inSecondaryBar = secondary;

  vscode.commands.executeCommand('setContext', NO_SECONDARY_KEY, !secondary);
  log(`[起動] ${vscode.version} / 眺めの置き場 = ${secondary ? '副側面（右）' : '活動列（左）'}`);

  makeDecorations();
  context.subscriptions.push(addedDeco, removedMarkDeco, codeLensChanged);

  const opts = {

    webviewOptions: { retainContextWhenHidden: true },
  };
  const activeViewId = secondary ? VIEW_ID_SECONDARY : VIEW_ID_PRIMARY;

  context.subscriptions.push(

    vscode.window.registerUriHandler(uriHandler),
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, beforeProvider),
    vscode.window.registerWebviewViewProvider(VIEW_ID_PRIMARY, provider, opts),
    vscode.window.registerWebviewViewProvider(VIEW_ID_SECONDARY, provider, opts),
    vscode.commands.registerCommand('chatgptBridge.focus', () =>
      vscode.commands.executeCommand(`${activeViewId}.focus`)
    ),

    vscode.commands.registerCommand('chatgptBridge.release', async () => {
      const r = await releaseBridge();
      vscode.window.showInformationMessage(
        r.ok
          ? t(r.closedTab ? 'cmd.releasedWithTab' : 'cmd.released', { port: r.port })
          : t('cmd.releaseNone')
      );
    }),
    vscode.commands.registerCommand('chatgptBridge.newConversation', () => {

      pendingStartMode = '';
      return handleFresh();
    }),
    vscode.commands.registerCommand('chatgptBridge.newConversationAs', newConversationAs),
    vscode.commands.registerCommand('chatgptBridge.writeProjectInstructions', writeProjectInstructions),
    vscode.commands.registerCommand('chatgptBridge.history', handleHistory),
    vscode.commands.registerCommand('chatgptBridge.schedule', handleSchedule),

    vscode.commands.registerCommand('chatgptBridge.insertSelection', async () => {
      const at = selectionMention();
      if (!at) {
        vscode.window.showInformationMessage(t('sel.noEditor'));
        return;
      }

      await vscode.commands.executeCommand('chatgptBridge.focus');
      send('insert', { text: at + ' ' });
    }),

    vscode.commands.registerCommand('chatgptBridge.probeApis', async () => {
      const out = [];
      const say = (k, v) => out.push(`  ${k} = ${v}`);
      out.push('[probe] real vscode shapes');
      say('version', vscode.version);

      say(
        'ConfigurationTarget',
        JSON.stringify({
          Global: vscode.ConfigurationTarget.Global,
          Workspace: vscode.ConfigurationTarget.Workspace,
          WorkspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
        })
      );

      const folders = vscode.workspace.workspaceFolders || [];
      say('workspaceFolders', folders.length);
      if (folders.length) {
        const base = folders[0].uri;
        const inside = vscode.Uri.joinPath(base, 'src', 'a.js');
        say('asRelativePath(inside, true)', vscode.workspace.asRelativePath(inside, true));
        say('asRelativePath(inside, false)', vscode.workspace.asRelativePath(inside, false));
        const outside = vscode.Uri.file('/tmp/outside/b.js');
        say('asRelativePath(outside, false)', vscode.workspace.asRelativePath(outside, false));
      }

      const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
      say('tabGroups.all.length', groups.length);
      say(
        'tabGroups[0].tabs.length',
        groups.length ? groups[0].tabs.length : '(no tabs)'
      );
      say(
        'tab.input ctor',
        groups.length && groups[0].tabs.length
          ? (groups[0].tabs[0].input && groups[0].tabs[0].input.constructor.name) || 'none'
          : '(no tabs)'
      );

      for (const [k, v] of [
        ['showQuickPick', vscode.window.showQuickPick],
        ['showTextDocument', vscode.window.showTextDocument],
        ['applyEdit', vscode.workspace.applyEdit],
        ['findFiles', vscode.workspace.findFiles],
      ]) {
        say(k, typeof v);
      }

      try {
        const withNull = await vscode.workspace.findFiles('**/*', null, 5);
        const withDefault = await vscode.workspace.findFiles('**/*', undefined, 5);
        say('findFiles(exclude=null) count', withNull.length);
        say('findFiles(exclude=undefined) count', withDefault.length);
        say(
          'same?',
          withNull.length === withDefault.length ? 'yes' : 'NO (default excludes apply)'
        );
      } catch (e) {
        say('findFiles', `failed: ${e.message}`);
      }
      const text = out.join('\n');
      post({ type: 'note', text });
      console.log(text);
    }),
    vscode.commands.registerCommand('chatgptBridge.openStorage', () =>
      vscode.env.openExternal(vscode.Uri.file(sessions.dirOf(storeRoot)))
    ),
    vscode.commands.registerCommand('chatgptBridge.deleteAllSessions', deleteAllSessions),
    vscode.commands.registerCommand('chatgptBridge.importChat', importChat),
    vscode.commands.registerCommand('chatgptBridge.disconnectTab', disconnectTab),
    vscode.commands.registerCommand('chatgptBridge.reconnectTab', reconnectTab),

    vscode.commands.registerCommand('chatgptBridge.openChromeExtension', () =>
      vscode.env.openExternal(vscode.Uri.file(path.join(__dirname, 'chrome-extension')))
    ),

    vscode.commands.registerCommand('chatgptBridge.startBrowser', () => {
      const launcher = path.join(__dirname, 'tools', 'bridge-browser.js');
      if (!require('fs').existsSync(launcher)) {
        vscode.window.showErrorMessage(t('browser.launcherMissing'));
        return;
      }
      channel.show(true);
      channel.appendLine(t('browser.starting'));
      const child = require('child_process').spawn(process.execPath, [launcher], {
        cwd: __dirname,
        env: {
          ...process.env,

          BRIDGE_PORT: String(vscode.workspace.getConfiguration('chatgptBridge').get('port', 8765)),

          ...(vscode.workspace.getConfiguration('chatgptBridge').get('browserPath', '')
            ? { BRIDGE_BROWSER_PATH: vscode.workspace.getConfiguration('chatgptBridge').get('browserPath', '') }
            : {}),
          ...(vscode.workspace.getConfiguration('chatgptBridge').get('browserProfile', '')
            ? { BRIDGE_BROWSER_PROFILE: vscode.workspace.getConfiguration('chatgptBridge').get('browserProfile', '') }
            : {}),
        },
      });
      const emit = (b) => String(b).split('\n').forEach((l) => l && channel.appendLine(l));
      child.stdout.on('data', emit);
      child.stderr.on('data', emit);
      child.on('close', (code) => {
        channel.appendLine(t('browser.exited', { code: String(code) }));
        if (code !== 0) vscode.window.showWarningMessage(t('browser.failed'));
      });
    }),
    vscode.commands.registerCommand('chatgptBridge.showLog', () => channel.show(true)),
    vscode.commands.registerCommand('chatgptBridge.forgetAllowed', forgetAllowed),
    vscode.commands.registerCommand('chatgptBridge.openInEditor', openInEditor),
    vscode.commands.registerCommand('chatgptBridge.toggleFocusView', toggleFocusView),
    vscode.commands.registerCommand('chatgptBridge.blur', blurPanel),
    vscode.commands.registerCommand('chatgptBridge.exportChat', exportChat),
    vscode.commands.registerCommand('chatgptBridge.openWalkthrough', openWalkthrough),
    vscode.commands.registerCommand('chatgptBridge.newCustomization', newCustomization),
    vscode.commands.registerCommand('chatgptBridge.openCustomizations', openCustomizations),
    vscode.commands.registerCommand('chatgptBridge.openSettings', openSettings),
    vscode.commands.registerCommand('chatgptBridge.clearInputHistory', clearInputHistory),
    vscode.commands.registerCommand('chatgptBridge.acceptInput', acceptInput),
    vscode.commands.registerCommand('chatgptBridge.nextCodeBlock', () => gotoCodeBlock('next')),
    vscode.commands.registerCommand('chatgptBridge.previousCodeBlock', () => gotoCodeBlock('prev')),
    ...TERM_ASKS.map((a) =>
      vscode.commands.registerCommand(`chatgptBridge.${a.id}`, () => askAboutTerminal(a.key, a.cmd))
    ),
    ...CODE_ASKS.map((a) =>
      vscode.commands.registerCommand(`chatgptBridge.${a.id}`, () => askAboutSelection(a.key))
    ),

    ...(vscode.workspace.getConfiguration().get('chatgptBridge.codeActions', true)
      ? [vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, codeAskProvider)]
      : []),
    vscode.commands.registerCommand('chatgptBridge.openInNewWindow', openInNewWindow),
    vscode.commands.registerCommand('chatgptBridge.createWorktree', createWorktree),

    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, blockLensProvider),
    vscode.commands.registerCommand('chatgptBridge.acceptBlock', acceptOverlayBlock),
    vscode.commands.registerCommand('chatgptBridge.rejectBlock', rejectOverlayBlock),

    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) paintOverlay(editor);
    })
  );
}

function deactivate() {

  dropCarriedTabs(session);
  if (session && session.bridge) {
    try {
      session.bridge.close();
    } catch {

    }
    session = null;
  }
}

module.exports = { activate, deactivate, supportsSecondarySidebar, resultDetail, neverModeStop };
