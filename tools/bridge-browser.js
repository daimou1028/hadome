#!/usr/bin/env node

const http = require('http');
const { placeByUserDataDir, frontApp, restoreFront } = require('./lib/place-window');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const CDP_PORT = Number(process.env.BRIDGE_BROWSER_PORT || 9444);

const PROFILE =
  process.env.BRIDGE_BROWSER_PROFILE ||
  path.join(process.env.HOME || '', 'Library/Application Support/chatgpt-bridge-canary');

const 見つけた = require('./lib/find-browser').探す();
const CANARY = (見つけた && 見つけた.実行檔) || '';
const EXT = path.join(__dirname, '..', 'chrome-extension');

function extensionInstalled() {
  const f = path.join(PROFILE, 'Default', 'Secure Preferences');
  try {
    const p = JSON.parse(require('fs').readFileSync(f, 'utf8'));
    const s = (p.extensions && p.extensions.settings) || {};
    return Object.values(s).some((v) => String(v.path || '').includes('chrome-extension'));
  } catch {
    return false;
  }
}

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8799);
const ENTRY = `https://chatgpt.com/?bridge_port=${BRIDGE_PORT}`;

const 起こす時の行き先 = () => (extensionInstalled() ? ENTRY : 'about:blank');

function getJSON(p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: p, timeout: 3000 }, (r) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => {
        try {
          res(JSON.parse(s));
        } catch (e) {
          rej(new Error(`JSON として読めない: ${s.slice(0, 120)}`));
        }
      });
    });
    req.on('error', rej);
    req.on('timeout', () => req.destroy(new Error('時間切れ')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    await getJSON('/json/version');
    return true;
  } catch {
    return false;
  }
}

async function stopBrowser() {
  const { execFileSync } = require('child_process');
  const pid = execFileSync('bash', [
    '-c',
    `pgrep -f "user-data-dir=${PROFILE}" | while read p; do ppid=$(ps -o ppid= -p $p | tr -d ' '); ` +
      `[ "$(ps -o command= -p $ppid 2>/dev/null | grep -c chatgpt-bridge-canary)" = "0" ] && echo $p; done | head -1`,
  ])
    .toString()
    .trim();
  if (!pid) return false;
  process.kill(Number(pid), 'SIGTERM');
  for (let i = 0; i < 20 && (await alive()); i += 1) await sleep(1000);
  return !(await alive());
}

function dropServiceWorkerCache() {
  const dir = path.join(PROFILE, 'Default', 'Service Worker');
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function launch() {

  if (!CANARY || !fs.existsSync(CANARY)) {
    console.error(
      'browser が見つかりません。\n' +
        '  探した所: ' +
        require('./lib/find-browser').候補.map((c) => c.名).join(' / ') +
        '\n  名指しするなら BRIDGE_BROWSER_PATH に実行檔の道を入れてください。'
    );
    process.exit(1);
  }
  const child = spawn(
    CANARY,
    [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${CDP_PORT}`,

      '--disable-features=LocalNetworkAccessChecks',
      '--no-first-run',
      '--no-default-browser-check',

      起こす時の行き先(),
    ],
    { detached: true, stdio: 'ignore' }
  );

  {
    const 台帳 = require('./lib/run-ledger');
    const r = 台帳.起こした('browser', child.pid, `${CANARY} --user-data-dir=${PROFILE} --remote-debugging-port=${CDP_PORT}`, {
      設定ファイル: PROFILE,
      枠: CDP_PORT,
    });
    if (!r.書けた) console.error(`  ★ 台帳へ書けませんでした（${r.なぜ}）。この browser は所有者不明に成ります`);
  }
  child.unref();
}

const { conversationIdOf } = require(path.join(__dirname, '..', 'src', 'bridge'));

function browserCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    getJSON('/json/version')
      .then((v) => {
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        const t = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          reject(new Error(`${method}: 返事が来ない`));
        }, 8000);
        ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
        ws.on('message', (b) => {
          clearTimeout(t);
          const m = JSON.parse(b.toString());
          ws.close();
          if (m.error) reject(new Error(`${method}: ${m.error.message}`));
          else resolve(m.result);
        });
        ws.on('error', (e) => {
          clearTimeout(t);
          reject(e);
        });
      })
      .catch(reject);
  });
}

async function chatTab() {
  const list = await getJSON('/json/list');
  return list.find((t) => t.type === 'page' && String(t.url || '').includes('chatgpt.com')) || null;
}

async function ensureChatTab() {
  const found = await chatTab();
  if (found) return found;

  if (!extensionInstalled()) {
    const e = new Error('この設定ファイルに相方が入っていないので、ここでは ChatGPT を開きません');
    e.相方が別の所 = true;
    throw e;
  }
  await browserCall('Target.createTarget', { url: ENTRY });
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const t = await chatTab();
    if (t) return t;
  }
  throw new Error('chatgpt.com のタブを開けませんでした');
}

async function status() {
  let tab;
  try {
    tab = await ensureChatTab();
  } catch (e) {
    if (e && e.相方が別の所) return { ok: true, 相方が別の所: true };
    throw e;
  }
  const id = conversationIdOf(tab.url);
  return {
    ok: true,
    url: tab.url,
    title: tab.title,
    where: id ? `対話の中（${id}）` : '入口（次に送ると新しい対話になる）',
  };
}

function 既定の待ち秒() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const p = pkg.contributes.configuration.properties['chatgptBridge.restartGapSeconds'];
  const n = Number(p && p.default);
  if (!Number.isFinite(n) || n < 0) throw new Error('restartGapSeconds の既定が読めません');
  return n;
}

async function toEntry() {
  const tab = await ensureChatTab();

  if (!conversationIdOf(tab.url) && String(tab.url).includes('bridge_port=')) return;
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: ENTRY } }));
  await new Promise((r) => ws.once('message', r));
  ws.close();
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const t = await chatTab();
    if (t && !conversationIdOf(t.url)) return;
  }
  throw new Error('入口へ戻せませんでした');
}

(async () => {
  const args = process.argv.slice(2);
  const wantStatus = args.includes('--status');
  const wantNew = args.includes('--new');

  const wantReload = args.includes('--reload-extension');

  if (wantReload && (await alive())) {
    console.log('裏方のセッションを消すため、いったん閉じます。');
    await stopBrowser();
  }
  if (wantReload) {
    console.log(dropServiceWorkerCache() ? '裏方のセッションを消しました。' : '裏方のセッションはありませんでした。');
  }

  if (!(await alive())) {
    if (wantStatus) {
      console.log('起きていません。引数なしで走らせると起こします。');
      process.exit(1);
    }
    console.log(`起こします（設定ファイル: ${PROFILE} / 遠隔口: ${CDP_PORT}）`);

    const 前に居た = frontApp();
    launch();
    {
      const r = await placeByUserDataDir(PROFILE);
      if (r) console.log(r);
    }
    restoreFront(前に居た);
    let up = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      if (await alive()) {
        up = true;
        break;
      }
    }
    if (!up) {
      console.error('遠隔口が開きませんでした。');
      process.exit(1);
    }
    await sleep(2000);
  }

  if (wantNew) {

    const 入口へ戻す下限MS = 300000;
    const 印 = path.join(os.tmpdir(), 'bridge-new-times.txt');

    const 揺れ = Math.floor(Math.random() * 入口へ戻す下限MS * 0.4);
    const 待ち = Math.max(既定の待ち秒() * 1000, 入口へ戻す下限MS) + 揺れ;

    let 記録 = [];
    try {
      記録 = JSON.parse(fs.readFileSync(印, 'utf8')).filter((t) => Number.isFinite(t));
    } catch {
      記録 = [];
    }
    const 窓 = 3600000;
    記録 = 記録.filter((t) => Date.now() - t < 窓);
    const 前 = 記録.length ? Math.max(...記録) : 0;
    const 経過 = Date.now() - 前;
    if (前 && 経過 < 待ち) {
      const 残り = 待ち - 経過;
      console.log(`前に入口へ戻してから ${Math.round(経過 / 1000)} 秒しか経っていません。${Math.round(残り / 1000)} 秒 待ちます。`);
      await new Promise((r) => setTimeout(r, 残り));
    }

    if (記録.length >= 5) {
      const 次 = Math.min(...記録) + 窓;
      const 残り = 次 - Date.now();
      if (残り > 0) {
        console.log(
          `この 1 時間で ${記録.length} 回 入口へ戻しています。` +
            `${Math.round(残り / 1000)} 秒 待ちます（1 時間に 5 回まで）。`
        );
        await new Promise((r) => setTimeout(r, 残り));
        記録 = 記録.filter((t) => Date.now() - t < 窓);
      }
    }
    await toEntry();
    try {
      記録.push(Date.now());
      fs.writeFileSync(印, JSON.stringify(記録));
    } catch {

    }
  }

  const s = await status();
  if (!s.ok) {
    console.error(s.why);
    process.exit(1);
  }
  if (s.相方が別の所) {

    const 居る = require('./lib/find-browser').探す();
    console.log('場所  : （この browser には ChatGPT のタブを置きません）');
    console.log(`いま  : ${居る && 居る.相方 ? `相方は ${居る.名} に入っています` : '相方が見つかりません'}`);
    console.log(`開く先: ${居る && 居る.相方 ? `${居る.名} で ` : ''}https://chatgpt.com/?bridge_port=${BRIDGE_PORT}`);
    console.log(`繋ぎ先: ws://127.0.0.1:${BRIDGE_PORT}（VSCodium の chatgptBridge.port も同じ値に）`);
  } else {
    console.log(`場所  : ${s.url}`);
    console.log(`題名  : ${s.title || '（まだ読み込み中）'}`);
    console.log(`いま  : ${s.where}`);
    console.log(`繋ぎ先: ws://127.0.0.1:${BRIDGE_PORT}（VSCodium の chatgptBridge.port も同じ値に）`);
  }

  const 相方が居る場所 = require('./lib/find-browser').探す();
  const 別の所に在る = !!(相方が居る場所 && 相方が居る場所.相方 && !extensionInstalled());
  console.log(
    `拡張  : ${
      extensionInstalled()
        ? '入っています'
        : 別の所に在る
          ? `この設定ファイルには入っていません（${相方が居る場所.名} に入っています）\n` +
            '        ChatGPT をそちらで開いているなら、この browser は browser_* の相手を\n' +
            '        するだけなので**入れる必要はありません**。'
          : '**入っていません**'
    }`
  );

  try {
    const 碼 = fs.statSync(path.join(__dirname, '..', 'chrome-extension', 'content.js')).mtimeMs;
    const 出 = execFileSync('lsof', ['-ti:' + CDP_PORT, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (出) {
      const 起 = execFileSync('ps', ['-o', 'lstart=', '-p', 出], { encoding: 'utf8' }).trim();
      const 起ms = Date.parse(起);
      const 古い = Number.isFinite(起ms) && 起ms < 碼;
      console.log(`      起きた: ${起}${古い ? '' : '（碼より新しい）'}`);
      if (古い) {
        console.log('  ★★ **直した碼より前に起きています。載っているのは古い版です。**');
        console.log('  ★★ `npm run browser -- --stop` してから起こし直してください。');
      }
    }
  } catch {

  }

  const どこにも居ない = !(require('./lib/find-browser').探す() || {}).相方;
  if (!extensionInstalled() && どこにも居ない) {
    console.log('');
    console.log('出ている窓で、次を 1 度だけやってください（設定ファイルは残ります）:');
    console.log('  1. chrome://extensions を開く');
    console.log('  2. 右上の「デベロッパーモード」を入れる');
    console.log('  3. 「パッケージ化されていない拡張機能を読み込む」で次を選ぶ');
    console.log(`     ${EXT}`);
    console.log('');
    console.log('命令列から入れる道は塞がれています（--load-extension は効きません）。');
  }
  if (extensionInstalled() || どこにも居ない) {
    console.log('');
    console.log('※ ログインもまだなら、出ている窓で済ませてください（これも 1 度だけ）。');
  }
  process.exit(0);
})().catch((e) => {
  console.error('失敗:', e.message);
  process.exit(1);
});
