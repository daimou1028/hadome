const { WebSocketServer } = require('ws');

const creategate = require('./creategate');

const DEFAULT_PORT = 8765;

const CONNECT_TIMEOUT_MS = 30000;

const TAB_FROZEN_MS = 20000;

const SILENCE_STEP_MS = 5000;

const ABORT_STEP_MS = 200;
const SILENCE_BEFORE_TEXT_MS = 150000;
const SILENCE_AFTER_TEXT_MS = 60000;

const SILENCE_AFTER_CUT_MS = 30000;
const RECONNECT_WAIT_MS = 30000;

const ENTRY_RENDER_WAIT_MS = 15000;

const RELOAD_WAIT_MS = 15000;

const EXPECTED_TAB_PROTOCOL = 62;

const WANT_TAB_REPEAT_MS = 30000;

const portlock = require('./portlock');

const { noteStreamCut, fileOf: streamCutsFileOf } = require('./streamcuts');
const { pathHits } = require('./tabpick');
const { projectIdOf } = require('./conversation');
const { createLiveness, noteLiveness, shouldStall } = require('./liveness');

const PROJECT_SETTLE_MS = 2500;
const PROJECT_PROBE_MS = 3000;

const CLAIM_POLL_MS = 1000;

const CLAIM_AFTER_MS = 5000;

function isConversationUrl(url) {
  return conversationIdOf(url) !== '';
}

function conversationIdOf(url) {

  const m = /^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\/((?:WEB:)?[0-9a-fA-F-]{8,})/.exec(
    String(url || '')
  );
  return m ? m[1] : '';
}

const UI_MARK = /\uE200[\s\S]*?\uE201/g;

function stripUiMarks(text) {
  return String(text == null ? '' : text).replace(UI_MARK, '');
}

const JA_FALLBACK = {
  'br.portBusy': ({ port }) => `${port} は既に誰かが使っています。\nもう一方の VSCodium の窓で /exit を打つと放されます（**画面の X では放されません**）。`,
  'br.portOpen': ({ port, why }) => `${port} を開けません: ${why}`,
  'br.serverError': ({ why }) => `ブリッジのサーバのエラー: ${why}`,
  'br.noTab': () => '対象タブがつながりません。ブラウザで chatgpt.com を開いているか確認してください。',
  'br.tabElsewhere': ({ port }) =>
    `ChatGPT のタブは、別の窓の枠 ${port} につながっています。`,
  'br.tabElsewhereHow': () =>
    'その窓へ譲るよう頼みましたが、返事がありませんでした。その窓で /exit するか、窓を閉じてください。',

  'br.nobodyHolds': ({ port }) =>
    'どの窓もこのタブを握っていません（前の走りが指した枠を覚えたままです）。\n' +
    `chatgpt.com を新しいタブで開くか、https://chatgpt.com/?bridge_port=${port} を開いてください（読み込み直しでは直りません）。`,
  'br.oldTab': ({ tab, here }) =>
    `ブラウザの拡張機能が古いままです（タブ側 ${tab} / こちら ${here}）。\nブラウザを閉じて開き直してください。`,
  'br.oldTabHow': () =>
    '1) chrome://extensions でこの拡張機能を読み込み直す\n2) chatgpt.com のタブも読み込み直す\nこの 2 つを両方やってください。片方だけでは古いものが動き続けます。',
  'br.tabCutMid': () => "返答の途中で対象タブが切れました",
  'br.closed': () => "ブリッジを閉じています",
  'br.busy': () => "前の返答がまだ終わっていません",
  'br.cut': ({ n }) =>
    `[bridge] 流れが途中で切れました（ここまで ${n} 文字）。画面が繋ぎ直すのを待ちます`,
  'br.streamCut': ({ why, status, ms, events, chars, file }) =>
    `[bridge] 流れが最後まで来ないまま閉じました（${why}／番号 ${status}／${ms}ms／` +
    `出来事 ${events} 件／本文 ${chars} 文字）。証拠を ${file} に残しました`,
  'br.timeoutNoStream': ({ sec }) =>
    `送ってから ${sec} 秒 待ちましたが、相手からの流れが 1 度も開きませんでした。` +
    '**相手が受け取っていないか、受け取ったまま何も始めていません。**\n' +
    '同じ依頼をもう一度 送ってみてください。',
  'br.timeoutNoText': ({ sec, events }) =>
    `相手は動いていますが、本文を 1 文字も出していません（${sec} 秒／出来事 ${events} 件）。` +
    '**ただ遅いのとは別です。**相手の側の処理が動いたまま止まっている時に出ます。\n' +
    '画面の停止ボタンを押してから、依頼を小さく分けて送り直してください。',

  'br.tabFrozen': ({ sec, late }) =>
    `対象タブが応答しなくなりました（心拍が ${sec} 秒 途切れ／いちばん遅れた心拍は ${late} 秒）。` +
    '相手の生成が重すぎて画面が固まっている時に出ます。**時間切れとは別です。**\n' +
    'タブを読み込み直すか、依頼を小さく分けてください。',
  'br.projectEntryBroken': ({ where }) =>
    `専案の入口が描けませんでした（${where}）。ChatGPT 側の画面の不具合で、` +
    'こちらでは直せません（相手の側は健全で、拡張を外しても同じでした）。\n' +
    '走れなくなるのは代償が大き過ぎるので、同じ専案の既存の対話へ落として続けます。',
  'br.projectEntryHopped': ({ where }) =>
    `専案の入口は硬く読めないので、専案の中の対話から画面の連結を押して入りました（${where}）。` +
    '新しい対話として始めます。',
  'br.projectEntryFallback': ({ where }) =>
    `既存の対話の続きとして走ります（${where}）。**新しい対話ではありません。**` +
    '専案の入口が直ったら、次からは新しい対話で始まります。',
  'br.projectEntryDead': ({ where }) =>
    `専案の入口が描けず（${where}）、落とせる既存の対話も見つかりませんでした。` +
    'ChatGPT を開いて専案の画面が出るかを見てください。出ないなら相手の側の不具合です。',
  'br.projectGone': ({ where }) =>
    `専案へ入れませんでした（着いた所: ${where}）。専案が消された見込みです。専案の外では送りません。`,
  'br.stopped': () => "利用者が中断しました",
  'br.noSock': () => "対象タブが繋がっていません",
  'br.openNoReply': () => "タブを開けたかどうかの返事がありません",
  'br.openFailed': () => "タブを開けませんでした",
  'br.noReload': () => "タブが読み込み直されませんでした。ブラウザの chrome://extensions で拡張機能を読み込み直し、chatgpt.com のタブも読み込み直してください。",
  'br.noMove': () => "タブが移りませんでした。ブラウザの拡張機能とタブを読み込み直してください。",
  'br.cantEnter': ({ where }) => `その対話へ入れませんでした（着いた先: ${where}）。ChatGPT 側で消されているか、別の場所へ移された可能性があります。`,
  'br.badLifecycle': ({ reason, actor }) =>
    `新しい対話を作る理由が不正です（reason=${reason}, actor=${actor}）。`,
  'br.unknownWhere': () => "不明",
  'br.noProjectHome': () =>
    '専案の道がまだ分かっていません。専案の外で始めると、その決まりが 1 つも効きません。少し待つか、対話の画面を開き直してください。',
  'br.silent': ({ sec }) => `相手が ${sec} 秒だまったままです（生成が止まっている見込み）`,

  'br.noFreePort': ({ from, to }) => `${from}〜${to} に空きがありません。`,
  'br.heldBy': ({ name, pid }) => `握っているのは ${name}（PID ${pid}）です。`,
  'br.heldWhere': ({ where }) => `その窓が開いている場所: ${where}`,
  'br.howToFind': ({ port }) => `調べる時: lsof -ti:${port} -sTCP:LISTEN`,
  'br.pickedTabLate': () => '選んだタブがまだ繋がっていません。タブを前面に出してから、もう 1 度 送ってください',
};

const HEALTH_INTERVAL_MS = 30000;

const HEALTH_TIMEOUT_MS = 15000;

const HEAP_WARN_MB = 1500;

function openBridge({
  port = DEFAULT_PORT,

  onRoster = () => {},

  editorId = '',
  onLog = () => {},
  onConversationChange = () => {},
  onTabHealth = () => {},

  onThinkingState = () => {},

  t: tIn = null,

  workspace = '',

  createGapMs = 0,
} = {}) {
  const t = (k, v) => (tIn ? tIn(k, v) : JA_FALLBACK[k](v || {}));
  return new Promise((resolve, reject) => {
    let server;

    let openedPort = port;
    const roam = port === portlock.PORT_FROM;
    try {
      server = new WebSocketServer({ host: '127.0.0.1', port });
    } catch (e) {
      reject(new Error(t('br.portOpen', { port, why: e.message })));
      return;
    }

    let sock = null;
    let targetId = null;
    const seenTabs = new Set();
    let waiting = null;
    let closed = false;
    let seq = 0;
    let generation = 0;
    let lastUrl = '';
    const createdConversationIds = new Set();
    let awaitingCreatedConversationId = false;

    let lastTurns = -1;
    let lastTitle = '';
    let tabProtocol = 0;

    let lastPluginId = '';
    let lastChromeTabId = null;

    const rosters = new Map();

    const claimWaiters = new Map();

    let wanted = null;

    let lastWantTab = { key: '', at: 0 };
    let switchArmed = false;
    let switchWaitLogged = false;
    let switchCandidate = null;

    function matchesWanted(tab) {
      if (!wanted || !tab) return false;
      if (wanted.pluginId && String(tab.pluginId || '') !== wanted.pluginId) return false;
      const href = String(tab.url || '');
      if (Number.isInteger(wanted.chromeTabId) && Number.isInteger(tab.chromeTabId)) {

        if (!wanted.pluginId && (!wanted.url || wanted.url === '/')) return false;
        return wanted.chromeTabId === tab.chromeTabId && (!wanted.url || wanted.url === '/' || pathHits(href, wanted.url));
      }
      return !!wanted.url && pathHits(href, wanted.url);
    }

    function armTabSwitch(v) {
      wanted =
        v && v.url
          ? { pluginId: String(v.pluginId || ''), url: String(v.url), chromeTabId: Number.isInteger(v.chromeTabId) ? v.chromeTabId : null }
          : null;
      if (!wanted) {
        switchCandidate = null;
        switchArmed = false;
        switchWaitLogged = false;
        return;
      }
      if (matchesWanted({ pluginId: lastPluginId, chromeTabId: lastChromeTabId, url: lastUrl })) {
        switchCandidate = null;
        switchArmed = false;
        switchWaitLogged = false;
        return;
      }
      switchCandidate = null;
      switchArmed = true;
      switchWaitLogged = false;
    }

    let closeWanted = null;
    const seenRosters = new Set();

    let lastBrands = null;
    let lastUa = '';
    let healthTimer = null;
    let healthTimeoutTimer = null;
    let healthWaitingId = null;
    let healthSeq = 0;
    let healthEverHealthy = false;
    let healthOldPeerReported = false;
    let healthUnresponsiveReported = false;

    function reportTabHealth(st) {
      try {
        onTabHealth(st);
      } catch {

      }
    }

    function clearHealthWait() {
      if (healthTimeoutTimer) {
        clearTimeout(healthTimeoutTimer);
        healthTimeoutTimer = null;
      }
      healthWaitingId = null;
    }

    function sendHealth() {
      if (closed || !sock || sock.readyState !== 1 || healthWaitingId) return;
      const id = `health-${++healthSeq}`;
      healthWaitingId = id;
      try {
        sock.send(JSON.stringify({ type: 'health', id }));
      } catch {
        clearHealthWait();
        return;
      }
      healthTimeoutTimer = setTimeout(() => {
        if (healthWaitingId !== id) return;
        healthTimeoutTimer = null;
        healthWaitingId = null;
        if (!healthEverHealthy) {
          if (!healthOldPeerReported) {
            healthOldPeerReported = true;
            onLog(`[bridge:${openedPort}] タブが health に答えません（古い相方の見込み）`);
          }
          return;
        }
        if (!healthUnresponsiveReported) {
          healthUnresponsiveReported = true;
          reportTabHealth({ ok: false, why: 'unresponsive' });
        }
      }, HEALTH_TIMEOUT_MS);
    }

    healthTimer = setInterval(sendHealth, HEALTH_INTERVAL_MS);

    const tabWaiters = [];
    const switchWaiters = [];
    const tabOpeners = new Map();
    const projectWaiters = new Map();
    const idWaiters = new Map();
    const writeWaiters = new Map();
    const readWaiters = new Map();
    const noticeWaiters = new Map();
    const makeWaiters = new Map();
    const probeWaiters = new Map();
    const cleanupWaiters = new Map();
    const modelsWaiters = new Map();
    const hopWaiters = new Map();

    function wireServer() {

      if (server.address()) ready();
      else server.once('listening', ready);
    server.on('error', (e) => {
        if (closed) return;

        if (e && e.code === 'EADDRINUSE') {

          if (roam && openedPort < portlock.PORT_TO) {

            const before = openedPort;
            do {
              openedPort += 1;
            } while (portlock.RESERVED.has(openedPort) && openedPort < portlock.PORT_TO);
            if (portlock.RESERVED.has(openedPort)) {
              reject(
                new Error(t('br.noFreePort', { from: portlock.PORT_FROM, to: portlock.PORT_TO }))
              );
              return;
            }
            onLog(`[bridge] ${before} は塞がっています。${openedPort} で開き直します`);
            try {
              server.close();
            } catch {

            }
            server = new WebSocketServer({ host: '127.0.0.1', port: openedPort });
            wireServer();
            return;
          }

          const who = portlock.holderOf(openedPort);
          const pub = portlock.readLock(openedPort);
          const detail =
            (who ? '\n' + t('br.heldBy', { name: who.name || '?', pid: who.pid }) : '') +
            (pub && pub.workspace ? '\n' + t('br.heldWhere', { where: pub.workspace }) : '') +
            '\n' + t('br.howToFind', { port: openedPort }) +
            (roam ? '\n' + t('br.noFreePort', { from: portlock.PORT_FROM, to: portlock.PORT_TO }) : '');
          reject(new Error(t('br.portBusy', { port: openedPort }) + detail));
          return;
        }
        reject(new Error(t('br.serverError', { why: e.message })));
      });
    server.on('connection', (ws) => {

        ws.on('message', (buf) => {
          let m;
          try {
            m = JSON.parse(buf.toString());
          } catch {
            return;
          }

          if (m.type === 'closedTabs') {
            if (closeWanted) {
              closeWanted.results.push({
                pluginId: String(m.pluginId || ''),
                closed: Number(m.closed) || 0,

                ...(m.error ? { error: String(m.error) } : {}),

                ...(m.seen && typeof m.seen === 'object' ? { seen: m.seen } : {}),
              });
              onLog(
                `[bridge:${port}] 相方 ${m.pluginId || '(名札なし)'} が ChatGPT のタブを ${Number(m.closed) || 0} 枚 閉じました` +
                  (m.error ? `（閉じきれなかった: ${m.error}）` : '')
              );
              if (closeWanted.port && (Number(m.closed) || 0) > 0 && !m.error && closeWanted.early) closeWanted.early();
            }
            return;
          }
          if (m.type === 'claimResult') {
            const claimId = String(m.id || '');
            const waiter = claimWaiters.get(claimId);
            if (waiter && waiter.socket === ws) {
              claimWaiters.delete(claimId);
              waiter.resolve(m);
            }
            return;
          }
          if (m.type === 'roster') {
            const id = typeof m.pluginId === 'string' ? m.pluginId : '';
            const windows = Array.isArray(m.windows) ? m.windows : [];
            const count = windows.reduce((n, w) => n + ((w && w.tabs && w.tabs.length) || 0), 0);

            const sends1h = Number.isFinite(Number(m.sends1h)) ? Math.max(0, Number(m.sends1h)) : 0;
            const sendsOldestAt = Number.isFinite(Number(m.sendsOldestAt)) ? Math.max(0, Number(m.sendsOldestAt)) : 0;

            const version = typeof m.version === 'string' ? m.version.slice(0, 20) : '';

            const browser = m.browser && typeof m.browser.ua === 'string' ? { ua: m.browser.ua.slice(0, 400) } : null;
            rosters.set(id || 'unnamed', { pluginId: id, windows, at: Date.now(), sends1h, sendsOldestAt, version, browser });
            if (!seenRosters.has(id)) {
              seenRosters.add(id);
              onLog(`[bridge:${port}] 相方が名乗りました: ${id || '(名札なし)'}（窓 ${windows.length} / タブ ${count}${version ? ` / 版 ${version}` : ' / 版を名乗らない古い相方'}）`);
            }
            try {
              onRoster({ pluginId: id, windows, at: Date.now() });
            } catch {

            }

            if (wanted && wanted.url && (!wanted.pluginId || wanted.pluginId === id)) {
              const tabs = windows.flatMap((w) => (w && Array.isArray(w.tabs) ? w.tabs : []));

              const urlHits = (href) => pathHits(href, wanted.url);
              const byUrl = (x) => !!x && urlHits(x.url);
              const byId = wanted.chromeTabId !== null ? tabs.find((x) => byUrl(x) && x.chromeTabId === wanted.chromeTabId) : null;
              const pathHitTabs = tabs.filter(byUrl);

              const hit = byId || (pathHitTabs.length === 1 ? pathHitTabs[0] : null);
              const targetAlive = !!sock && sock.readyState === 1;

              const alreadyThere = targetAlive && matchesWanted({ pluginId: lastPluginId, chromeTabId: lastChromeTabId, url: lastUrl });
              const wantKey = hit ? `${id}|${Number.isInteger(hit.chromeTabId) ? hit.chromeTabId : String(hit.url || '')}` : '';
              const askedJustNow = !!wantKey && lastWantTab.key === wantKey && Date.now() - lastWantTab.at < WANT_TAB_REPEAT_MS;
              if (hit && !waiting && !alreadyThere && !askedJustNow) {
                try {
                  const want = { type: 'wantTab', url: wanted.url };
                  if (Number.isInteger(hit.chromeTabId)) want.chromeTabId = hit.chromeTabId;
                  ws.send(JSON.stringify(want));
                  lastWantTab = { key: wantKey, at: Date.now() };
                  onLog(`[bridge:${port}] 覚えている対話が在ったので、繋ぎ直しを頼みました`);
                } catch {

                }
              }
            }

            if (closeWanted && !closeWanted.done.has(id)) {
              closeWanted.done.add(id);
              if (closeWanted.askedAt) closeWanted.askedAt.set(id, Date.now());
              try {

                ws.send(JSON.stringify(closeWanted.port ? { type: 'closeTabsOnPort', port: closeWanted.port } : { type: 'closeTabs' }));
                onLog(`[bridge:${port}] 相方 ${id || '(名札なし)'} へ ChatGPT のタブを閉じるよう頼みました`);
              } catch {
                closeWanted.done.delete(id);
              }
            }
            return;
          }

          if (m.type === 'tabinfo') {
            if (ws === sock && Number.isInteger(m.chromeTabId)) {
              lastChromeTabId = m.chromeTabId;
              onLog(`[bridge:${port}] タブの番号: ${lastChromeTabId}（後から届いた）`);
            }
            return;
          }
          if (m.type === 'hello') {

            if (m.thinking && typeof m.thinking === 'object') {
              try {
                onThinkingState({
                  present: !!m.thinking.present,
                  usable: !!m.thinking.usable,
                  on: !!m.thinking.on,
                });
              } catch {

              }
            }
            const id = typeof m.tabId === 'string' && m.tabId ? m.tabId : null;

            const who = id || '(名札なし)';

            const helloTab = {
              pluginId: typeof m.pluginId === 'string' ? m.pluginId : '',
              chromeTabId: Number.isInteger(m.chromeTabId) ? m.chromeTabId : null,
              url: m.url || '',
            };
            const switchHit = switchArmed && !waiting && !switchCandidate && matchesWanted(helloTab) && !matchesWanted({ pluginId: lastPluginId, chromeTabId: lastChromeTabId, url: lastUrl });
            if (switchHit) {
              const candidate = {
                socket: ws,
                targetId: who,
                pluginId: helloTab.pluginId,
                chromeTabId: helloTab.chromeTabId,
                url: helloTab.url,
                title: m.title || '',
                turns: typeof m.turns === 'number' ? m.turns : -1,
                protocol: m.protocol || 0,
                brands: Array.isArray(m.brands) ? m.brands : null,
                ua: typeof m.ua === 'string' ? m.ua : '',
              };
              switchCandidate = candidate;
              void claimTab('claim', 5000, ws).then((claim) => {
                if (switchCandidate !== candidate) return;
                switchCandidate = null;
                if (!claim.ok || claim.why === 'timeout-old-companion' || ws.readyState !== 1) {
                  try {
                    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'not_target' }));
                  } catch {

                  }
                  return;
                }

                const oldSock = sock;
                const oldTitle = lastTitle;
                targetId = candidate.targetId;
                sock = candidate.socket;
                healthEverHealthy = false;
                healthOldPeerReported = false;
                try {
                  portlock.markTab(openedPort, true);
                } catch {

                }
                generation += 1;
                tabProtocol = candidate.protocol;
                lastPluginId = candidate.pluginId;
                lastChromeTabId = candidate.chromeTabId;
                lastBrands = candidate.brands;
                lastUa = candidate.ua;
                lastUrl = candidate.url;
                if (candidate.turns >= 0) lastTurns = candidate.turns;
                lastTitle = candidate.title;
                onLog(`[bridge:${openedPort}] 送り先のタブを替えました: ${oldTitle || '?'} → ${candidate.title || '?'}`);
                onLog(`[bridge:${port}] hello: ${candidate.title} / ${candidate.url}`);
                if (tabProtocol !== EXPECTED_TAB_PROTOCOL) {
                  onLog(`[bridge] タブ側が古いままです（タブ ${tabProtocol} / こちら ${EXPECTED_TAB_PROTOCOL}）`);
                }
                try {
                  ws.send(JSON.stringify({ type: 'welcome', protocol: EXPECTED_TAB_PROTOCOL, editorId }));
                } catch {

                }
                if (oldSock && oldSock !== ws && oldSock.readyState === 1) {
                  try {
                    oldSock.send(JSON.stringify({ type: 'release', editorId }));
                    oldSock.send(JSON.stringify({ type: 'not_target' }));
                  } catch {

                  }
                }
                switchArmed = false;
                switchWaitLogged = false;
                while (switchWaiters.length) switchWaiters.shift()();
              }).catch(() => {
                if (switchCandidate !== candidate) return;
                switchCandidate = null;
                try {
                  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'not_target' }));
                } catch {

                }
              });
              return;
            }
            if (switchCandidate && switchCandidate.socket === ws) return;

            const free = sock === null || sock.readyState !== 1;
            if (targetId === null || free || targetId === who) {
              if (targetId !== who) onLog(`[bridge:${port}] 送り先のタブ: ${who}`);
              targetId = who;
              sock = ws;
              healthEverHealthy = false;
              healthOldPeerReported = false;

              try {

                portlock.markTab(openedPort, true);
              } catch {

              }

              generation += 1;
              tabProtocol = m.protocol || 0;

              const pluginId = typeof m.pluginId === 'string' ? m.pluginId : '';
              if (pluginId && pluginId !== lastPluginId) {
                lastPluginId = pluginId;
                onLog(`[bridge:${port}] 相方: ${pluginId}`);
              }

              lastChromeTabId = Number.isInteger(m.chromeTabId) ? m.chromeTabId : null;
              if (lastChromeTabId !== null) onLog(`[bridge:${port}] タブの番号: ${lastChromeTabId}`);
              lastBrands = Array.isArray(m.brands) ? m.brands : null;
              lastUa = typeof m.ua === 'string' ? m.ua : '';
              lastUrl = m.url || '';
              if (typeof m.turns === 'number') lastTurns = m.turns;
              lastTitle = m.title || '';
              onLog(`[bridge:${port}] hello: ${m.title} / ${lastUrl}`);
              if (tabProtocol !== EXPECTED_TAB_PROTOCOL) {
                onLog(
                  `[bridge] タブ側が古いままです（タブ ${tabProtocol} / こちら ${EXPECTED_TAB_PROTOCOL}）`
                );
              }

              try {

                ws.send(
                  JSON.stringify({ type: 'welcome', protocol: EXPECTED_TAB_PROTOCOL, editorId })
                );
              } catch {

              }

              while (tabWaiters.length) tabWaiters.shift()();
              return;
            }

            if (!seenTabs.has(who)) {
              seenTabs.add(who);
              onLog(
                `[bridge] 別のタブもつながっています（${m.title} / ${m.url}）。` +
                  'こちらへは送りません。切り替えたい時は、いま使っているタブを閉じてください。'
              );
            }

            try {
              ws.send(JSON.stringify({ type: 'not_target' }));
            } catch {

            }
            return;
          }

          if (ws !== sock) return;
          if (m.type === 'healthy') {
            if (m.id === healthWaitingId) clearHealthWait();
            healthEverHealthy = true;
            healthUnresponsiveReported = false;
            reportTabHealth({
              ok: true,
              heapMB: typeof m.heapMB === 'number' ? m.heapMB : null,
            });
            return;
          }

          if (m.type === 'projectCreated') {
            const fn = makeWaiters.get(m.id);
            if (fn) {
              makeWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'instructionsRead') {
            const fn = readWaiters.get(m.id);
            if (fn) {
              readWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'hopped') {
            const fn = hopWaiters.get(m.id);
            if (fn) {
              hopWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'probed') {
            const fn = probeWaiters.get(m.id);
            if (fn) {
              probeWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'cleaned') {
            const fn = cleanupWaiters.get(m.id);
            if (fn) {
              cleanupWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'modelsListed') {
            const fn = modelsWaiters.get(m.id);
            if (fn) {
              modelsWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'noticeRead') {
            const fn = noticeWaiters.get(m.id);
            if (fn) {
              noticeWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'instructionsWritten') {
            const fn = writeWaiters.get(m.id);
            if (fn) {
              writeWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'projectId') {
            const fn = idWaiters.get(m.id);
            if (fn) {
              idWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'projects') {
            const fn = projectWaiters.get(m.id);
            if (fn) {
              projectWaiters.delete(m.id);
              fn(m);
            }
            return;
          }
          if (m.type === 'tab_opened') {
            const fn = tabOpeners.get(m.id);
            if (fn) fn(m);
            return;
          }
          if (m.type === 'url') {
            const beforeId = conversationIdOf(lastUrl);
            lastUrl = m.url || lastUrl;
            lastTitle = m.title || lastTitle;
            if (typeof m.turns === 'number') lastTurns = m.turns;
            const afterId = conversationIdOf(lastUrl);
            if (awaitingCreatedConversationId && afterId && afterId !== beforeId) {
              createdConversationIds.add(afterId);
              awaitingCreatedConversationId = false;
              onLog(`[bridge:${port}] この橋が作った対話を記録しました: ${afterId}`);
            }

            onLog(`[bridge:${port}] 場所が変わりました: ${lastUrl}（吹き出し ${lastTurns}）`);

            if (afterId !== beforeId) onConversationChange(afterId, lastUrl, lastTitle, beforeId);

            if (m.thinking && typeof m.thinking === 'object') {
              try {
                onThinkingState({
                  present: !!m.thinking.present,
                  usable: !!m.thinking.usable,
                  on: !!m.thinking.on,
                });
              } catch {

              }
            }
            return;
          }

          if (m.type === 'stream_cut') {
            noteStreamCut(m);
            onLog(
              t('br.streamCut', {
                why: String(m.why || ''),
                status: Number(m.status) || 0,
                ms: Number(m.ms) || 0,
                events: Number(m.events) || 0,
                chars: Number(m.chars) || 0,
                file: streamCutsFileOf(),
              })
            );
            return;
          }
          if (!waiting) return;

          if (m.type === 'submitted') {

            if (waiting) waiting.submitted = true;
            if (waiting && m.upload && waiting.onUpload) {
              try {
                waiting.onUpload(m.upload);
              } catch {

              }
            }
            return;
          }

          if (m.type === 'note') {
            onLog(String(m.text || ''));
            return;
          }

          if (m.type === 'tabAlive') {
            if (waiting) {
              waiting.lastAlive = Date.now();
              waiting.liveness = noteLiveness(waiting.liveness, {
                kind: m.busy ? 'busy' : 'tabAlive',
                at: waiting.lastAlive,
              });

              const late = Number(m.late) || 0;
              if (late > (waiting.worstLate || 0)) waiting.worstLate = late;
            }
            return;
          }

          if (m.type === 'start') {
            waiting.streamOpened = true;
            waiting.beat = null;
            waiting.liveness = noteLiveness(waiting.liveness, { kind: 'start', at: Date.now() });
            return;
          }

          if (m.type === 'stream_beat') {

            const prev = waiting.beat;
            waiting.beat = m;
            const beforeProgress = Number(waiting.liveness && waiting.liveness.lastProgressAt) || 0;
            waiting.liveness = noteLiveness(waiting.liveness, {
              kind: 'stream_beat',
              at: Date.now(),
              events: Number(m.events) || 0,
              bytes: Number(m.bytes) || 0,
              chars: Number(m.chars) || 0,
            });
            if ((Number(waiting.liveness.lastProgressAt) || 0) > beforeProgress || !prev) waiting.quiet = 0;
            return;
          }
          if (m.type === 'busy') {

            waiting.quiet = 0;
            waiting.liveness = noteLiveness(waiting.liveness, { kind: m.tool ? 'tool' : 'busy', at: Date.now() });
            waiting.onBusy(String(m.tool || ''));
            return;
          }

          if (m.type === 'image') {
            waiting.onImage({
              id: String(m.id || ''),
              mime: String(m.mime || 'image/png'),
              width: Number(m.width || 0),
              height: Number(m.height || 0),
              bytes: Number(m.bytes || 0),
              dataUrl: typeof m.dataUrl === 'string' ? m.dataUrl : '',
              error: m.error ? String(m.error) : '',
            });
            return;
          }

          if (m.type === 'limits') {
            let list = null;
            try {
              list = JSON.parse(String(m.text || ''));
            } catch {
              list = null;
            }
            if (Array.isArray(list)) {
              lastLimits = list;
              if (waiting && waiting.onLimits) {
                try {
                  waiting.onLimits(list);
                } catch {

                }
              }
            }
            return;
          }
          if (m.type === 'model') {
            waiting.onModel(String(m.text || ''));
            return;
          }

          if (m.type === 'autoswitch' || m.type === 'defaultModel') {
            if (waiting.onAutoSwitch) waiting.onAutoSwitch(m);
            return;
          }
          if (m.type === 'delta') {
            waiting.text = stripUiMarks(waiting.text + m.text);
            waiting.liveness = noteLiveness(waiting.liveness, { kind: 'text', at: Date.now() });
            waiting.onDelta(waiting.text);
          } else if (m.type === 'replace') {
            waiting.text = stripUiMarks(m.text);
            waiting.liveness = noteLiveness(waiting.liveness, { kind: 'text', at: Date.now() });
            waiting.onDelta(waiting.text);
          } else if (m.type === 'done') {
            if (m.text) waiting.text = stripUiMarks(m.text);
            waiting.liveness = noteLiveness(waiting.liveness, { kind: m.complete === true ? 'end' : 'stream_beat', at: Date.now() });

            if (m.complete !== true) {
              waiting.cut = true;
              waiting.quiet = 0;
              onLog(t('br.cut', { n: waiting.text.length }));
              return;
            }

            waiting.cut = false;
            const w = waiting;
            waiting = null;
            clearTimeout(w.timer);
            clearInterval(w.watch);
            if (w.abortWatch) clearInterval(w.abortWatch);
            w.resolve(w.text);
          } else if (m.type === 'error') {
            waiting.liveness = noteLiveness(waiting.liveness, { kind: 'end', at: Date.now() });
            const w = waiting;
            waiting = null;
            clearTimeout(w.timer);
            clearInterval(w.watch);
            if (w.abortWatch) clearInterval(w.abortWatch);

            if (w.text) {
              onLog(`[bridge] 途中で切れました（${m.message}）。ここまでの ${w.text.length} 文字で続けます`);
              w.resolve(w.text);
              return;
            }

            const e = new Error(m.message);

            const refused = Number(m.status) > 0;

            e.delivered = !!w.submitted;

            const sendButtonMissing = !w.submitted && String(m.code || '') === 'waitTimeout';
            e.transient = (!refused && !w.submitted) || sendButtonMissing;
            e.refused = refused;
            e.status = Number(m.status) || 0;

            e.tooLong = /input_too_large|message_length_exceeds_limit/.test(String(m.message || ''));
            e.usageLimit = Number(m.status) === 429 && /limit of messages|reached our limit|usage[_ ]limit/i.test(String(m.message || ''));

            e.retryAfter = m.retryAfter == null ? null : String(m.retryAfter);
            e.rateLimitReset = m.rateLimitReset == null ? null : String(m.rateLimitReset);
            e.rateLimitRemaining = m.rateLimitRemaining == null ? null : String(m.rateLimitRemaining);

            e.reason = String(m.reason || '');

            e.stuckUi = /STUCK_UI/.test(String(m.message || ''));
            w.reject(e);
          }
        });

        ws.on('close', () => {
          if (switchCandidate && switchCandidate.socket === ws) switchCandidate = null;

          if (sock !== ws) return;
          sock = null;
          clearHealthWait();
          try {
            portlock.markTab(openedPort, false);
          } catch {

          }
          if (waiting) {
            const w = waiting;
            waiting = null;
            clearTimeout(w.timer);
            clearInterval(w.watch);
            if (w.abortWatch) clearInterval(w.abortWatch);
            if (w.text) {
              onLog(`[bridge] タブが切れました。ここまでの ${w.text.length} 文字で続けます`);
              w.resolve(w.text);
            } else {
              const e = new Error(t('br.tabCutMid'));
              e.delivered = !!w.submitted;
              e.transient = !w.submitted;
              w.reject(e);
            }
          }
          if (!closed) onLog('[bridge] 対象タブが切れました');
        });
      });
    }
    wireServer();

    let claimTimer = null;
    function pollClaim() {
      if (closed) return;
      let c = null;
      try {
        c = portlock.readClaim();
      } catch {

      }

      if (!c || c.port === openedPort) return;

      if (!sock || sock.readyState !== 1) return;
      if (waiting) {

        onLog(`[bridge:${openedPort}] ${c.port} から譲れと頼まれましたが、返答の途中なので断ります`);
        return;
      }

      if (tabProtocol !== EXPECTED_TAB_PROTOCOL) {
        onLog(`[bridge:${openedPort}] 譲れと頼まれましたが、タブ側が古い（${tabProtocol}）ので譲れません`);
        return;
      }
      onLog(`[bridge:${openedPort}] タブを ${c.port} へ譲ります（${c.workspace || '場所は不明'}）`);
      try {
        sock.send(JSON.stringify({ type: 'handover', port: c.port }));
      } catch {

      }

      try {
        portlock.clearClaim({ port: c.port });
      } catch {

      }

      const going = sock;
      sock = null;
      targetId = null;
      tabProtocol = 0;
      try {
        portlock.markTab(openedPort, false);
      } catch {

      }
      try {
        going.close();
      } catch {

      }
    }
    claimTimer = setInterval(pollClaim, CLAIM_POLL_MS);
    if (claimTimer.unref) claimTimer.unref();

    function liveOthers() {
      try {
        return portlock.listLocks().filter((l) => l.port !== openedPort);
      } catch {
        return [];
      }
    }

    function dropClaim() {
      try {
        portlock.clearClaim({ pid: process.pid });
      } catch {

      }
    }

    function noTabWhy() {
      const others = liveOthers();
      if (!others.length) return t('br.noTab');

      const holder = others.find((o) => o.hasTab);
      if (!holder) return t('br.noTab') + '\n' + t('br.nobodyHolds', { port: openedPort });
      return (
        t('br.tabElsewhere', { port: holder.port }) +
        (holder.workspace ? '\n' + t('br.heldWhere', { where: holder.workspace }) : '') +
        '\n' +
        t('br.tabElsewhereHow')
      );
    }

    function waitForTabSwitch(ms = 80000) {
      if (!switchArmed) return Promise.resolve();
      if (!switchWaitLogged) {
        switchWaitLogged = true;
        onLog(`[bridge:${openedPort}] 選んだタブが繋がるのを待っています`);
      }
      return new Promise((res, rej) => {
        let done = false;
        const fn = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const i = switchWaiters.indexOf(fn);
          if (i >= 0) switchWaiters.splice(i, 1);
          res();
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          const i = switchWaiters.indexOf(fn);
          if (i >= 0) switchWaiters.splice(i, 1);
          const e = new Error(t('br.pickedTabLate'));
          e.transient = true;
          e.delivered = false;
          rej(e);
        }, ms);
        switchWaiters.push(fn);
      });
    }

    function waitForTab(ms = RECONNECT_WAIT_MS) {

      if (sock && tabProtocol) return Promise.resolve();
      return new Promise((res, rej) => {

        const timer = setTimeout(() => {
          const i = tabWaiters.indexOf(fn);
          if (i >= 0) tabWaiters.splice(i, 1);
          clearTimeout(askTimer);
          dropClaim();
          rej(new Error(noTabWhy()));
        }, ms);

        const askTimer = setTimeout(() => {
          if (sock && tabProtocol) return;
          const others = liveOthers();
          if (!others.length) return;
          onLog(
            `[bridge:${openedPort}] タブが来ないので、譲ってくれと頼みます` +
              `（いま握っている見込み: ${others.map((o) => o.port).join(' / ')}）`
          );
          try {
            portlock.writeClaim(openedPort, workspace);
          } catch {

          }
        }, Math.min(CLAIM_AFTER_MS, ms));
        const fn = () => {
          clearTimeout(timer);
          clearTimeout(askTimer);
          dropClaim();
          res();
        };
        tabWaiters.push(fn);
      });
    }

    let tally = { id: null, sent: 0, got: 0, turns: 0 };
    function addTally(outLen, inLen) {
      const id = conversationIdOf(lastUrl);
      if (id !== tally.id) tally = { id, sent: 0, got: 0, turns: 0 };
      tally.sent += outLen;
      tally.got += inLen;
      tally.turns += 1;
    }

    function conversationUsage() {
      const id = conversationIdOf(lastUrl);

      if (id !== tally.id) return { chars: 0, turns: 0, sent: 0, got: 0, id };
      return {
        chars: tally.sent + tally.got,
        turns: tally.turns,
        sent: tally.sent,
        got: tally.got,
        id,
      };
    }

    async function ask(text, opts = {}) {
      const outLen = String(text || '').length;
      try {
        const answer = await askOnce(text, opts);
        addTally(outLen, String(answer || '').length);
        return answer;
      } catch (e) {
        if (!e || !e.stuckUi) throw e;
        onLog('[bridge] 画面が固まっています。読み込み直して 1 度だけ送り直します');
        await reloadTab();
        const answer = await askOnce(text, opts);
        addTally(outLen, String(answer || '').length);
        return answer;
      }
    }

    async function askOnce(
      text,
      {
        onDelta = () => {},
        onBusy = () => {},
        onImage = () => {},
        onModel = () => {},
        onAutoSwitch = () => {},
        shouldStop = null,

        files = null,
        onUpload = () => {},
        onLimits = () => {},

        asFile = false,

        thinking = undefined,
        model = '',
        thinkingEffort = '',

        body = '',
      } = {}
    ) {
      if (closed) throw new Error(t('br.closed'));
      if (switchArmed) await waitForTabSwitch(80000);
      if (waiting) throw new Error(t('br.busy'));
      if (!sock || !tabProtocol) await waitForTab(CONNECT_TIMEOUT_MS);

      if (tabProtocol !== EXPECTED_TAB_PROTOCOL) {
        throw new Error(
          t('br.oldTab', { tab: tabProtocol, here: EXPECTED_TAB_PROTOCOL }) + '\n' + t('br.oldTabHow')
        );
      }

      if (mustStayInProject && homeUrl) {
        const want = projectIdOf(homeUrl);
        if (want) {
          const now = await probe(PROJECT_PROBE_MS).catch(() => ({ ok: false }));
          const here = now.ok && now.url ? now.url : String(lastUrl || '');
          if (projectIdOf(here) !== want) {
            onLog(`[bridge:${openedPort}] ${t('br.projectGone', { where: here })}`);
            const e = new Error(t('br.projectGone', { where: here }));
            e.projectGone = true;
            e.url = here;
            e.delivered = false;
            throw e;
          }
        }
      }
      seq += 1;
      return await new Promise((res, rej) => {

        const timer = null;

        const abortWatch = shouldStop
          ? setInterval(() => {
              if (!shouldStop()) return;
              const w = waiting;
              waiting = null;
              if (!w) return;
              clearInterval(w.watch);
              clearInterval(abortWatch);
              clearTimeout(timer);
              const e = new Error(t('br.stopped'));
              e.stopped = true;
              w.reject(e);
            }, ABORT_STEP_MS)
          : null;

        const watch = setInterval(() => {
          const w = waiting;
          if (!w) return;
          if (w.text.length !== w.seenLen) {
            w.seenLen = w.text.length;
            w.quiet = 0;
            return;
          }

          w.quiet += SILENCE_STEP_MS;

          const limit = w.cut
            ? SILENCE_AFTER_CUT_MS
            : w.text
              ? SILENCE_AFTER_TEXT_MS
              : SILENCE_BEFORE_TEXT_MS;
          if (!shouldStall(w.liveness, Date.now(), limit)) return;
          waiting = null;
          clearTimeout(w.timer);
          clearInterval(w.watch);
          if (w.abortWatch) clearInterval(w.abortWatch);

          const progressSilentSec = Math.round(
            (Date.now() - ((w.liveness && w.liveness.lastProgressAt) || 0)) / 1000
          );
          onLog(
            `[bridge:${port}] 相手の進展が ${progressSilentSec} 秒止まりました（${w.text.length} 文字、last=${String((w.liveness && w.liveness.lastKind) || '?')}）`
          );

          const silentMs = Date.now() - (w.lastAlive || 0);
          const worstLate = w.worstLate || 0;
          const wedged = silentMs > TAB_FROZEN_MS || worstLate >= TAB_FROZEN_MS;
          const beat = w.beat;
          let why;
          if (wedged) {
            why = t('br.tabFrozen', {
              sec: String(Math.round(silentMs / 1000)),
              late: String(Math.round(worstLate / 1000)),
            });
          } else if (!w.streamOpened) {
            why = t('br.timeoutNoStream', {
              sec: String(Math.round(limit / 1000)),
            });
          } else if (beat && Number(beat.chars) === 0) {
            why = t('br.timeoutNoText', {
              sec: String(Math.round(Number(beat.ms || limit) / 1000)),
              events: String(Number(beat.events) || 0),
            });
          } else {
            why = t('br.silent', { sec: Math.round(limit / 1000) });
          }
          const e = new Error(why);
          e.stalled = true;
          e.partialText = w.text;

          e.delivered = !!w.submitted;
          e.transient = !w.submitted;
          w.reject(e);
        }, SILENCE_STEP_MS);

        waiting = {
          text: '',
          liveness: createLiveness(Date.now()),
          resolve: res,
          reject: rej,
          timer,
          watch,

          abortWatch,
          seenLen: 0,
          quiet: 0,

          lastAlive: Date.now(),

          cut: false,
          onDelta,
          onBusy,
          onImage,
          onModel,
          onAutoSwitch,
          onUpload,
          onLimits,
        };

        sock.send(
          JSON.stringify({
            type: 'send',
            id: seq,
            text,
            files: files || [],
            asFile: !!asFile,

            ...(asFile && body ? { body: String(body) } : {}),

            ...(typeof thinking === 'boolean' ? { thinking } : {}),
            ...(model ? { model: String(model) } : {}),
            ...(thinkingEffort ? { thinkingEffort: String(thinkingEffort) } : {}),
          })
        );
      });
    }

    let homeUrl = '';

    let mustStayInProject = false;
    function setProjectUrl(u) {
      homeUrl = String(u || '');
    }

    function requireProject(on) {
      mustStayInProject = !!on;
    }

    function ensureProjectHome() {
      if (mustStayInProject && !homeUrl) throw new Error(t('br.noProjectHome'));
    }

    function openTabFor(subPort) {
      if (!sock) throw new Error(t('br.noSock'));
      const id = 'tab' + (seq += 1);
      return new Promise((res, rej) => {

        const askCleanup = () => {
          try {
            if (sock) sock.send(JSON.stringify({ type: 'close_tab', port: subPort }));
          } catch {

          }
        };
        const timer = setTimeout(() => {
          tabOpeners.delete(id);
          askCleanup();
          rej(new Error(t('br.openNoReply')));
        }, 15000);
        tabOpeners.set(id, (m) => {
          clearTimeout(timer);
          tabOpeners.delete(id);
          if (m.ok) res(true);
          else {
            askCleanup();
            rej(new Error(m.why || t('br.openFailed')));
          }
        });

        try {
          ensureProjectHome();
        } catch (e) {
          clearTimeout(timer);
          tabOpeners.delete(id);
          rej(e);
          return;
        }

        const url = 'https://chatgpt.com/?bridge_port=' + subPort + '&bridge_sub=1';
        sock.send(JSON.stringify({ type: 'open_tab', id, url }));
      });
    }

    function retireTab() {
      if (!sock) return Promise.resolve(false);
      const target = sock;
      try {

        target.send(JSON.stringify({ type: 'close_tab', port }));
      } catch {
        return Promise.resolve(false);
      }
      return new Promise((res) => {

        const timer = setTimeout(() => res(false), 8000);
        target.once('close', () => {
          clearTimeout(timer);
          res(true);
        });
      });
    }

    async function reloadTab() {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const before = generation;
      sock.send(JSON.stringify({ type: 'reload_tab' }));
      const deadline = Date.now() + RELOAD_WAIT_MS;
      while (generation === before) {
        if (Date.now() > deadline) throw new Error(t('br.noReload'));
        await new Promise((r) => setTimeout(r, 150));
      }

      await new Promise((r) => setTimeout(r, 2500));
    }

    async function listProjects(timeoutMs = 8000) {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const id = `p${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          projectWaiters.delete(id);
          resolve({ ok: false, why: 'timeout', projects: [] });
        }, timeoutMs);
        projectWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({
            ok: true,
            projects: m.projects || [],
            where: m.where || '',
            links: m.links || 0,

            current: m.current || '',
            currentName: m.currentName || '',
            heads: m.heads || [],
          });
        });
        sock.send(JSON.stringify({ type: 'list_projects', id }));
      });
    }

    async function createProject(name, timeoutMs = 90000) {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const id = `n${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          makeWaiters.delete(id);
          resolve({ ok: false, why: 'timeout' });
        }, timeoutMs);
        makeWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({ ok: !!m.ok, why: m.why || '', project: m.project || '' });
        });
        sock.send(JSON.stringify({ type: 'create_project', id, name: String(name || '') }));
      });
    }

    async function writeInstructions(name, text, opts = {}, timeoutMs = 90000) {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const id = `w${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          writeWaiters.delete(id);
          resolve({ ok: false, why: 'timeout' });
        }, timeoutMs);
        writeWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({ ok: !!m.ok, why: m.why || '', len: m.len || 0 });
        });
        sock.send(JSON.stringify({
          type: 'write_instructions',
          id,
          name: String(name || ''),
          text: String(text || ''),

          memory: opts && opts.memory === 'project' ? 'project' : undefined,
        }));
      });
    }

    async function readInstructions(name, timeoutMs = 90000) {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const id = `r${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          readWaiters.delete(id);
          resolve({ ok: false, why: 'timeout', text: '' });
        }, timeoutMs);
        readWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({ ok: !!m.ok, why: m.why || '', text: String(m.text || '') });
        });
        sock.send(JSON.stringify({ type: 'read_instructions', id, name: String(name || '') }));
      });
    }

    async function readNotice(timeoutMs = 8000) {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const id = `z${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          noticeWaiters.delete(id);
          resolve({ ok: false, why: 'timeout', texts: [] });
        }, timeoutMs);
        noticeWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({ ok: !!m.ok, why: m.why || '', texts: Array.isArray(m.texts) ? m.texts.map(String) : [], url: String(m.url || '') });
        });
        sock.send(JSON.stringify({ type: 'read_notice', id }));
      });
    }

    async function probe(timeoutMs = 8000) {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const id = `p${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          probeWaiters.delete(id);
          resolve({ ok: false, composer: false, conversations: [], url: '' });
        }, timeoutMs);
        probeWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({
            ok: true,
            composer: !!m.composer,
            conversations: Array.isArray(m.conversations) ? m.conversations.map(String) : [],
            url: String(m.url || ''),
          });
        });
        sock.send(JSON.stringify({ type: 'probe', id }));
      });
    }

    async function claimTab(kind, timeoutMs = 5000, claimSock = sock) {
      if (!claimSock) return { ok: false, why: 'no-tab' };
      const id = `c${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          claimWaiters.delete(id);

          resolve({ ok: true, why: 'timeout-old-companion' });
        }, timeoutMs);
        claimWaiters.set(id, {
          socket: claimSock,
          resolve: (m) => {
            clearTimeout(timer);
            resolve({
              ok: !!m.ok,
              heldBy: String(m.heldBy || ''),
              why: String(m.why || ''),
            });
          },
        });
        try {
          claimSock.send(JSON.stringify({ type: kind, id, editorId }));
        } catch (e) {
          clearTimeout(timer);
          claimWaiters.delete(id);
          resolve({ ok: false, why: String((e && e.message) || e) });
        }
      });
    }

    async function listModels(timeoutMs = 10000) {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const id = `m${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          modelsWaiters.delete(id);
          resolve({ ok: false, models: [], why: 'timeout' });
        }, timeoutMs);
        modelsWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({
            ok: !!m.ok,
            models: Array.isArray(m.models) ? m.models : [],
            why: String(m.why || ''),
          });
        });
        sock.send(JSON.stringify({ type: 'list_models', id }));
      });
    }

    async function cleanupConversation(action, conversationId = '', timeoutMs = 10000) {
      if (String(action || '') !== 'archive') {
        return { ok: false, status: 0, why: 'cleanup-action-disabled' };
      }
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const explicitId = String(conversationId || '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(explicitId)) {
        return { ok: false, why: 'invalid-conversation-id', conversationId: '' };
      }
      conversationId = explicitId;
      const id = `k${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          cleanupWaiters.delete(id);
          resolve({ ok: false, status: 0, why: 'timeout', conversationId });
        }, timeoutMs);
        cleanupWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({
            ok: !!m.ok,
            status: Number(m.status || 0),
            why: String(m.why || ''),
            conversationId,
          });
        });
        sock.send(JSON.stringify({ type: 'cleanup_conversation', id, action: String(action || ''), conversationId }));
      });
    }

    async function projectHop(timeoutMs = 30000) {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const id = `h${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          hopWaiters.delete(id);
          resolve({ ok: false, why: 'timeout', url: '' });
        }, timeoutMs);
        hopWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({ ok: !!m.ok, why: String(m.why || ''), url: String(m.url || '') });
        });
        sock.send(JSON.stringify({ type: 'project_hop', id }));
      });
    }

    async function projectId(name, timeoutMs = 25000) {
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const id = `i${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          idWaiters.delete(id);
          resolve({ ok: false, why: 'timeout' });
        }, timeoutMs);
        idWaiters.set(id, (m) => {
          clearTimeout(timer);
          resolve({ ok: !!m.ok, project: m.project || '', why: m.why || '' });
        });
        sock.send(JSON.stringify({ type: 'project_id', id, name: String(name || '') }));
      });
    }

    async function openConversation(url) {
        if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
        const before = generation;
        sock.send(JSON.stringify({ type: 'navigate', url }));
        const deadline = Date.now() + RELOAD_WAIT_MS;
        while (generation === before) {
          if (Date.now() > deadline) {
            throw new Error(
              t('br.noMove')
            );
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        await new Promise((r) => setTimeout(r, 1500));

        const want = conversationIdOf(url);
        const got = conversationIdOf(lastUrl);
        if (want && got !== want) {
          throw new Error(t('br.cantEnter', { where: lastUrl || t('br.unknownWhere') }));
        }
        return { url: lastUrl, id: got };
    }

    async function newConversation(url, lifecycle = {}) {
      const lifecycleReason = String(lifecycle && lifecycle.reason || '');
      const lifecycleActor = String(lifecycle && lifecycle.actor || '');

      const lifecycleActors = {
        'entry-send': 'user',
        'user-new': 'user',
        'subagent-start': 'subagent',
        'recovery-no-tool': 'agent-recovery',
        'recovery-no-call': 'agent-recovery',
        'recovery-bad-format': 'agent-recovery',
        'recovery-downgraded': 'agent-recovery',
      };
      const expectedActor = lifecycleActors[lifecycleReason];
      if (!expectedActor || lifecycleActor !== expectedActor) {
        throw new Error(t('br.badLifecycle', { reason: lifecycleReason || 'none', actor: lifecycleActor || 'none' }));
      }

      const gapMs = Number.isFinite(Number(lifecycle.gapMs)) ? Math.max(0, Number(lifecycle.gapMs)) : createGapMs;
      const waitedMs = await creategate.waitGap({ key: lastPluginId || 'unknown', gapMs });
      if (waitedMs >= 1000) onLog(`[bridge:${openedPort}] 対話を続けて作らないよう ${Math.round(waitedMs / 1000)} 秒待ちました`);
      const want = projectIdOf(url || homeUrl || '');
      const beforeId = conversationIdOf(lastUrl);
      awaitingCreatedConversationId = true;
      let r;
      try {
        r = await landConversation(url);
      } catch (e) {
        awaitingCreatedConversationId = false;
        throw e;
      }

      if (want && projectIdOf(r && r.url) === want) {
        await new Promise((res) => setTimeout(res, PROJECT_SETTLE_MS));

        const now = await probe(PROJECT_PROBE_MS).catch(() => ({ ok: false }));
        const seen = now.ok && now.url ? now.url : String(lastUrl || '');
        if (projectIdOf(seen) !== want) r.url = seen;
      }
      if (want && projectIdOf(r && r.url) !== want) {
        awaitingCreatedConversationId = false;
        const where = String((r && r.url) || lastUrl || '');
        onLog(`[bridge:${openedPort}] ${t('br.projectGone', { where })}`);
        const e = new Error(t('br.projectGone', { where }));
        e.projectGone = true;
        e.url = where;
        throw e;
      }
      if (r && r.fresh === false) awaitingCreatedConversationId = false;
      const afterId = conversationIdOf((r && r.url) || lastUrl);
      if (r && r.fresh === true && afterId && afterId !== beforeId) {
        createdConversationIds.add(afterId);
        awaitingCreatedConversationId = false;
      }
      if (r && r.fresh === true && (lifecycleReason || lifecycleActor)) {
        onLog(`[bridge:${openedPort}] 新しい対話を作成: ${lifecycleReason || 'unknown'}${lifecycleActor ? ` (${lifecycleActor})` : ''}`);
      }
      return r;
    }

    async function landConversation(url) {

      if (!url) ensureProjectHome();
      if (!sock) await waitForTab(CONNECT_TIMEOUT_MS);
      const before = generation;
      sock.send(JSON.stringify({ type: 'new_conversation', url: url || homeUrl || '' }));

      const deadline = Date.now() + RELOAD_WAIT_MS;
      while (generation === before) {
        if (Date.now() > deadline) {
          throw new Error(
            t('br.noReload')
          );
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      await new Promise((r) => setTimeout(r, 1500));

      const atEntry = /\/g\/g-p-[^/]+\/project/.test(String(lastUrl || ''));
      let seen = atEntry ? await probe() : { ok: false, composer: false, conversations: [] };

      const renderUntil = Date.now() + ENTRY_RENDER_WAIT_MS;
      while (atEntry && seen.ok && !seen.composer && Date.now() < renderUntil) {
        await new Promise((r) => setTimeout(r, 500));
        seen = await probe();
      }
      if (atEntry && seen.ok && !seen.composer) {
        const want = (/\/g\/(g-p-[A-Za-z0-9-]+)/.exec(String(lastUrl || '')) || [])[1] || '';
        onLog(t('br.projectEntryBroken', { where: String(lastUrl || '') }));

        let list = seen.conversations;
        if (!list.length) {
          try {
            await openConversation('https://chatgpt.com/');
            list = (await probe()).conversations;
          } catch (e) {

            onLog(`[bridge] 落とし先の一覧を読めませんでした: ${e && e.message}`);
            list = [];
          }
        }

        for (const href of list.slice(0, 3)) {
          try {
            await openConversation('https://chatgpt.com' + href);
          } catch (e) {
            onLog(`[bridge] ${href} を開けませんでした: ${e && e.message}`);
            continue;
          }

          let after = await probe();
          const settleDeadline = Date.now() + 12000;
          while (
            Date.now() < settleDeadline &&
            !(after.composer && want && String(after.url || '').includes(want))
          ) {
            await new Promise((r) => setTimeout(r, 500));
            after = await probe();
          }
          if (!(after.composer && want && String(after.url || '').includes(want))) continue;

          const hop = await projectHop();
          if (hop.ok) {
            onLog(t('br.projectEntryHopped', { where: String(hop.url || lastUrl || '') }));
            return { url: hop.url || lastUrl, fresh: true };
          }
          onLog(`[bridge] 入口へ押し進めませんでした（${hop.why || '?'}）。既存の対話の続きにします`);
          onLog(t('br.projectEntryFallback', { where: String(lastUrl || '') }));
          return { url: lastUrl, fresh: false };
        }
        throw new Error(t('br.projectEntryDead', { where: String(lastUrl || '') }));
      }
      return { url: lastUrl, fresh: true };
    }

    const api = {

      roster: () => [...rosters.values()],

      useTab: (v) => {
        armTabSwitch(v);
        if (!switchArmed) void claimTab('claim').catch(() => {});
      },

      wantTab: (v) => {
        wanted =
          v && v.url
            ? { pluginId: String(v.pluginId || ''), url: String(v.url), chromeTabId: Number.isInteger(v.chromeTabId) ? v.chromeTabId : null }
            : null;
      },

      chromeTabId: () => lastChromeTabId,

      pluginId: () => lastPluginId,

      pluginSends: () => {
        const r = lastPluginId ? rosters.get(lastPluginId) : null;
        return r ? { pluginId: r.pluginId, sends1h: r.sends1h || 0, oldestAt: r.sendsOldestAt || 0, at: r.at } : null;
      },

      closeTabs: (waitMs = 70000, { port: onlyPort = 0 } = {}) =>
        new Promise((resolve) => {
          closeWanted = { done: new Set(), results: [], port: Number.isInteger(onlyPort) && onlyPort > 0 ? onlyPort : 0 };
          const mine = closeWanted;
          mine.askedAt = new Map();
          const finish = () => {
            if (closeWanted !== mine) return;
            clearTimeout(timer);
            const r = { asked: [...mine.done], results: mine.results };
            closeWanted = null;
            resolve(r);
          };

          const settle = () => {
            const replied = new Set(mine.results.map((x) => x.pluginId));
            const late = [...mine.askedAt.entries()].filter(([id, at]) => !replied.has(id) && Date.now() - at < 6000);
            if (!late.length) return void finish();
            timer = setTimeout(settle, 500);
          };
          let timer = setTimeout(settle, waitMs);

          mine.early = finish;
        }),
      claim: (timeoutMs) => claimTab('claim', timeoutMs),
      release: (timeoutMs) => claimTab('release', timeoutMs),
      ask,
      conversationUsage,
      waitForTab,
      newConversation,
      setProjectUrl,
      projectUrl: () => homeUrl,
      requireProject,
      listProjects,
      projectId,
      writeInstructions,
      readInstructions,
      readNotice,
      probe,
      listModels,
      cleanupConversation,
      projectHop,
      createProject,
      openTabFor,
      retireTab,

      reloadTab,
      limits: () => lastLimits,

      currentUrl: () => lastUrl,

      conversationUrl: () => (isConversationUrl(lastUrl) ? lastUrl : ''),
      conversationId: () => conversationIdOf(lastUrl),
      createdConversationIds: () => [...createdConversationIds],

      tabUrl: () => lastUrl,

      tabTurns: () => lastTurns,
      currentTitle: () => lastTitle,
      tabProtocol: () => tabProtocol,

      connected: () => !!sock && sock.readyState === 1,

      tabBrands: () => ({ brands: lastBrands, ua: lastUa }),
      expectedProtocol: () => EXPECTED_TAB_PROTOCOL,
      openConversation,

      close() {
        closed = true;
        if (healthTimer) {
          clearInterval(healthTimer);
          healthTimer = null;
        }
        clearHealthWait();

        try {
          if (sock) sock.close();
        } catch {

        }
        try {
          server.close();
        } catch {

        }

        try {
          portlock.clearLock(openedPort);
        } catch {

        }

        dropClaim();
        if (claimTimer) {
          clearInterval(claimTimer);
          claimTimer = null;
        }
      },
    };

    let resolved = false;
    function ready() {
      if (resolved) return;
      resolved = true;

    const listened = server.address();
    if (listened && typeof listened.port === 'number' && listened.port > 0) {
      openedPort = listened.port;
    }
      portlock.writeLock(openedPort, workspace);
      if (openedPort !== port) {
        onLog(`[bridge] ${port} が塞がっていたので ${openedPort} で開きました`);
      }
      resolve({ port: openedPort, ...api });
    }
  });
}

module.exports = {
  openBridge,
  stripUiMarks,
  DEFAULT_PORT,
  EXPECTED_TAB_PROTOCOL,
  HEALTH_INTERVAL_MS,
  HEALTH_TIMEOUT_MS,
  HEAP_WARN_MB,
  isConversationUrl,
  conversationIdOf,
};
