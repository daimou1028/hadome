const { WebSocketServer } = require('ws');

const DEFAULT_PORT = 8765;

const CONNECT_TIMEOUT_MS = 30000;
const ANSWER_TIMEOUT_MS = 300000;

const TAB_FROZEN_MS = 20000;

const SILENCE_STEP_MS = 5000;

const ABORT_STEP_MS = 200;
const SILENCE_BEFORE_TEXT_MS = 150000;
const SILENCE_AFTER_TEXT_MS = 60000;

const SILENCE_AFTER_CUT_MS = 30000;
const RECONNECT_WAIT_MS = 30000;

const RELOAD_WAIT_MS = 15000;

const EXPECTED_TAB_PROTOCOL = 60;

const portlock = require('./portlock');

const { noteStreamCut, fileOf: streamCutsFileOf } = require('./streamcuts');

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
  'br.timeout': () => "返答が時間切れになりました",
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
  'br.stopped': () => "利用者が中断しました",
  'br.noSock': () => "対象タブが繋がっていません",
  'br.openNoReply': () => "タブを開けたかどうかの返事がありません",
  'br.openFailed': () => "タブを開けませんでした",
  'br.noReload': () => "タブが読み込み直されませんでした。ブラウザの chrome://extensions で拡張機能を読み込み直し、chatgpt.com のタブも読み込み直してください。",
  'br.noMove': () => "タブが移りませんでした。ブラウザの拡張機能とタブを読み込み直してください。",
  'br.cantEnter': ({ where }) => `その対話へ入れませんでした（着いた先: ${where}）。ChatGPT 側で消されているか、別の場所へ移された可能性があります。`,
  'br.unknownWhere': () => "不明",
  'br.noProjectHome': () =>
    '専案の道がまだ分かっていません。専案の外で始めると、その決まりが 1 つも効きません。少し待つか、対話の画面を開き直してください。',
  'br.silent': ({ sec }) => `相手が ${sec} 秒だまったままです（生成が止まっている見込み）`,

  'br.noFreePort': ({ from, to }) => `${from}〜${to} に空きがありません。`,
  'br.heldBy': ({ name, pid }) => `握っているのは ${name}（PID ${pid}）です。`,
  'br.heldWhere': ({ where }) => `その窓が開いている場所: ${where}`,
  'br.howToFind': ({ port }) => `調べる時: lsof -ti:${port} -sTCP:LISTEN`,
};

function openBridge({
  port = DEFAULT_PORT,
  onLog = () => {},
  onConversationChange = () => {},

  onThinkingState = () => {},

  t: tIn = null,

  workspace = '',
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

    let lastTurns = -1;
    let lastTitle = '';
    let tabProtocol = 0;

    let lastBrands = null;
    let lastUa = '';
    const tabWaiters = [];
    const tabOpeners = new Map();
    const projectWaiters = new Map();
    const idWaiters = new Map();
    const writeWaiters = new Map();
    const readWaiters = new Map();
    const noticeWaiters = new Map();
    const makeWaiters = new Map();
    const probeWaiters = new Map();
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

            const free = sock === null || sock.readyState !== 1;
            if (targetId === null || free || targetId === who) {
              if (targetId !== who) onLog(`[bridge:${port}] 送り先のタブ: ${who}`);
              targetId = who;
              sock = ws;

              try {

                portlock.markTab(openedPort, true);
              } catch {

              }

              generation += 1;
              tabProtocol = m.protocol || 0;

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
                ws.send(JSON.stringify({ type: 'welcome', protocol: EXPECTED_TAB_PROTOCOL }));
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

              const late = Number(m.late) || 0;
              if (late > (waiting.worstLate || 0)) waiting.worstLate = late;
            }
            return;
          }

          if (m.type === 'start') {
            waiting.streamOpened = true;
            waiting.beat = null;
            return;
          }

          if (m.type === 'stream_beat') {
            waiting.beat = m;
            return;
          }
          if (m.type === 'busy') {

            waiting.quiet = 0;
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
            waiting.onDelta(waiting.text);
          } else if (m.type === 'replace') {
            waiting.text = stripUiMarks(m.text);
            waiting.onDelta(waiting.text);
          } else if (m.type === 'done') {
            if (m.text) waiting.text = stripUiMarks(m.text);

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

            e.stuckUi = /STUCK_UI/.test(String(m.message || ''));
            w.reject(e);
          }
        });

        ws.on('close', () => {

          if (sock !== ws) return;
          sock = null;
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

        body = '',
      } = {}
    ) {
      if (closed) throw new Error(t('br.closed'));
      if (waiting) throw new Error(t('br.busy'));
      if (!sock || !tabProtocol) await waitForTab(CONNECT_TIMEOUT_MS);

      if (tabProtocol !== EXPECTED_TAB_PROTOCOL) {
        throw new Error(
          t('br.oldTab', { tab: tabProtocol, here: EXPECTED_TAB_PROTOCOL }) + '\n' + t('br.oldTabHow')
        );
      }
      seq += 1;
      return await new Promise((res, rej) => {

        const timer = setTimeout(() => {
          const w = waiting;
          waiting = null;
          if (w) {
            clearInterval(w.watch);
            if (w.abortWatch) clearInterval(w.abortWatch);

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
                sec: String(Math.round(ANSWER_TIMEOUT_MS / 1000)),
              });
            } else if (beat && Number(beat.chars) === 0) {
              why = t('br.timeoutNoText', {
                sec: String(Math.round(Number(beat.ms || 0) / 1000)),
                events: String(Number(beat.events) || 0),
              });
            } else {
              why = t('br.timeout');
            }
            w.reject(new Error(why));
          }
        }, ANSWER_TIMEOUT_MS);

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
          if (w.quiet < limit) return;
          waiting = null;
          clearTimeout(w.timer);
          clearInterval(w.watch);
          if (w.abortWatch) clearInterval(w.abortWatch);
          onLog(
            `[bridge:${port}] 相手が ${Math.round(w.quiet / 1000)} 秒だまりました（${w.text.length} 文字で止まっています）`
          );
          if (w.text) {

            w.resolve(w.text);
          } else {
            const e = new Error(
              t('br.silent', { sec: Math.round(w.quiet / 1000) })
            );

            e.delivered = !!w.submitted;
            e.transient = !w.submitted;
            w.reject(e);
          }
        }, SILENCE_STEP_MS);

        waiting = {
          text: '',
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

        const url = 'https://chatgpt.com/?bridge_port=' + subPort;
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

    async function newConversation(url) {

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
      const seen = atEntry ? await probe() : { ok: false, composer: false, conversations: [] };
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
      ask,
      conversationUsage,
      waitForTab,
      newConversation,
      setProjectUrl,
      requireProject,
      listProjects,
      projectId,
      writeInstructions,
      readInstructions,
      readNotice,
      probe,
      projectHop,
      createProject,
      openTabFor,
      retireTab,

      reloadTab,
      limits: () => lastLimits,

      currentUrl: () => lastUrl,

      conversationUrl: () => (isConversationUrl(lastUrl) ? lastUrl : ''),
      conversationId: () => conversationIdOf(lastUrl),

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
  isConversationUrl,
  conversationIdOf,
};
