const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const pw = require('./pwpage');

const PORT = Number(process.env.BRIDGE_BROWSER_PORT || 9444);

const OWN = new Set(['https://chatgpt.com', 'https://chat.openai.com']);

function originOf(u) {
  try {
    return new URL(String(u)).origin;
  } catch {
    return '';
  }
}

function isOwnSite(u) {
  const o = originOf(u);
  if (!o) return true;
  return OWN.has(o);
}

function 隔離した設定ファイルの道() {
  return (
    process.env.BRIDGE_BROWSER_PROFILE ||
    path.join(process.env.HOME || '', 'Library/Application Support/chatgpt-bridge-canary')
  );
}

const 確かめた口 = new Map();

const 空 = '空';
const 読めない = '読めない';

function 口を握っている命令列(port) {

  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p'], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch (e) {

    return e && e.status === 1 ? 空 : 読めない;
  }
  const pid = (/^p(\d+)/m.exec(out) || [])[1];
  if (!pid) return 空;
  try {
    return execFileSync('ps', ['-p', pid, '-o', 'command='], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    return 読めない;
  }
}

function 引数として合うか(命令列, 道) {
  for (const 印 of [`--user-data-dir=${道}`, `--user-data-dir="${道}"`, `--user-data-dir='${道}'`]) {
    let i = 命令列.indexOf(印);
    while (i >= 0) {
      const 次 = 命令列.slice(i + 印.length, i + 印.length + 1);

      if (次 === '' || 次 === ' ' || 次 === '"' || 次 === "'") return true;
      i = 命令列.indexOf(印, i + 1);
    }
  }
  return false;
}

function 隔離した口か(port = PORT) {
  if (確かめた口.has(port)) return 確かめた口.get(port);
  const 命令列 = 口を握っている命令列(port);

  let 良い = false;
  let なぜ =
    命令列 === 空
      ? '隔離したブラウザーを起こせませんでした。\n' +
        '命令選択区の「隔離したブラウザーを起こす」で起こしてから、もう一度 頼んでください。'
      : `口 ${port} を誰が握っているか読めませんでした（lsof が使えない機械かもしれません）。\n` +
        '読めない口には触りません。';
  if (命令列 !== 空 && 命令列 !== 読めない) {

    const 道 = 隔離した設定ファイルの道();
    if (引数として合うか(命令列, 道)) {
      良い = true;
      なぜ = '';
    } else if (!/--user-data-dir/.test(命令列)) {
      なぜ =
        `口 ${port} の browser は、設定ファイルを指さずに動いています。\n` +
        '**利用者のふだんの browser かもしれないので触りません。**\n' +
        '隔離した browser は「隔離したブラウザーを起こす」で起こしてください。';
    } else {

      const m = /--user-data-dir=(.*?)(?: --|$)/.exec(命令列);
      const いまの道 = (m && m[1].trim()) || '（読めません）';
      なぜ =
        `口 ${port} の browser は、隔離した設定ファイルの物ではありません。\n` +
        `  いま握っている設定ファイル: ${いまの道}\n` +
        `  こちらが触れるのは        : ${隔離した設定ファイルの道()}\n` +
        '**利用者のふだんの browser かもしれないので触りません。**\n' +
        'その browser を閉じてから、「隔離したブラウザーを起こす」で起こしてください。';
    }
  }
  確かめた口.set(port, { 良い, なぜ, 様子: 命令列 });
  return { 良い, なぜ, 様子: 命令列 };
}

async function 窓を出させる(port = PORT) {
  let 実行檔 = '';
  try {
    実行檔 = (require('../tools/lib/find-browser').探す() || {}).実行檔 || '';
  } catch {
    return;
  }
  if (!実行檔) return;
  try {
    require('child_process')
      .spawn(実行檔, [`--user-data-dir=${隔離した設定ファイルの道()}`, 'about:blank'], {
        detached: true,
        stdio: 'ignore',
      })
      .unref();
  } catch {
    return;
  }

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const l = await getJSON('/json/list', port);
      if (l.some((x) => x.type === 'page')) return;
    } catch {

    }
  }
}

async function 起こす(port = PORT) {
  let 実行檔 = '';
  try {
    実行檔 = (require('../tools/lib/find-browser').探す() || {}).実行檔 || '';
  } catch {
    実行檔 = '';
  }
  if (!実行檔) {
    throw new Error(
      '相方の入っている browser が見つかりませんでした。\n' +
        '設定 `chatgptBridge.browserPath` に実行檔の道を入れてください。'
    );
  }
  try {
    const 子 = require('child_process')
      .spawn(
        実行檔,
        [
          `--user-data-dir=${隔離した設定ファイルの道()}`,
          `--remote-debugging-port=${port}`,

          '--disable-features=LocalNetworkAccessChecks',
          '--no-first-run',
          '--no-default-browser-check',
          'about:blank',
        ],
        { detached: true, stdio: 'ignore' }
      );

    try {
      const 台帳 = require('../tools/lib/run-ledger');
      const 呼び手 = String(new Error().stack || '')
        .split('\n')
        .slice(2, 6)
        .map((x) => x.trim())
        .join(' ← ')
        .slice(0, 300);
      const r = 台帳.起こした('browser', 子.pid, `${実行檔} --remote-debugging-port=${port}`, {
        設定ファイル: 隔離した設定ファイルの道(),
        枠: port,
        起こした所: 'src/browser.js',
        呼び手,
      });
      if (!r.書けた) console.error(`[bridge] 台帳へ書けませんでした（${r.なぜ}）。この browser は所有者不明に成ります`);
    } catch (e) {
      console.error(`[bridge] 台帳を開けませんでした（${e.message}）。この browser は所有者不明に成ります`);
    }

    子.unref();
  } catch (e) {
    throw new Error(`隔離したブラウザーを起こせませんでした: ${e.message}`);
  }

  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));

    if (await 口が返るか(port)) return;
  }
  throw new Error(
    `隔離したブラウザーを起こしましたが、口 ${port} が 20 秒 経っても返りません。\n` +
      '命令選択区の「隔離したブラウザーを起こす」で起こし直してください。'
  );
}

function 口が返るか(port) {
  return new Promise((res) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: 2000 },
      (r) => {
        r.resume();
        res(r.statusCode === 200);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => res(false));
  });
}

async function 用意する(port = PORT) {
  const r = 隔離した口か(port);
  if (r.良い) return;
  if (r.様子 !== 空) throw new Error(r.なぜ);
  await 起こす(port);
  確かめた口.delete(port);
  const r2 = 隔離した口か(port);
  if (!r2.良い) throw new Error(r2.なぜ);
}

function 隔離を確かめる(port = PORT) {
  const r = 隔離した口か(port);
  if (!r.良い) throw new Error(r.なぜ);
}

function getJSON(path, port = PORT) {

  隔離を確かめる(port);
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 5000 }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        try {
          res(JSON.parse(b));
        } catch (e) {
          rej(new Error(`browser の返事が読めません: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('browser が返事をしません')));
    req.on('error', rej);
  });
}

async function connect(wsUrl, { timeoutMs = 30000 } = {}) {
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  let id = 0;
  const waiting = new Map();
  ws.on('message', (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!m.id || !waiting.has(m.id)) return;
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error) w.rej(new Error(`${w.method}: ${m.error.message}`));
    else w.res(m.result);
  });

  ws.on('close', () => {
    for (const [, w] of waiting) w.rej(new Error(`${w.method}: browser との口が閉じました`));
    waiting.clear();
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      waiting.set(mid, { res, rej, method });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => {
        if (!waiting.has(mid)) return;
        waiting.delete(mid);
        rej(new Error(`${method} が ${timeoutMs}ms 返ってきません`));
      }, timeoutMs);
    });
  return { send, close: () => ws.close() };
}

async function targetOf(targetId, port = PORT) {
  const list = await getJSON('/json/list', port);
  return list.find((x) => x.id === targetId) || null;
}

async function 確かなタブ(targetId, port = PORT, { tries = 6, waitMs = 300 } = {}) {
  let t = null;
  for (let i = 0; i < tries; i += 1) {
    t = await targetOf(targetId, port);
    if (t && t.url) return t;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return t;
}

async function open(url, { port = PORT, waitMs = 15000 } = {}) {
  if (isOwnSite(url)) throw new Error(`この站は開けません: ${originOf(url) || url}`);

  await 用意する(port);
  let list = await getJSON('/json/list', port);
  let any = list.find((x) => x.type === 'page');

  if (!any) {
    await 窓を出させる(port);
    list = await getJSON('/json/list', port);
    any = list.find((x) => x.type === 'page');
  }
  if (!any) {
    throw new Error(
      'browser に頁が 1 つ も在りません。\n' +
        '窓を出させようとしましたが、出ませんでした。\n' +
        '命令選択区の「隔離したブラウザーを起こす」で起こし直してください。'
    );
  }

  const 空の頁 = list.find((x) => x.type === 'page' && (!x.url || x.url === 'about:blank'));
  if (空の頁) {
    const page = await 確かな頁(空の頁.id, port);
    try {

      await page.goto(url, { waitUntil: 'commit', timeout: waitMs });
    } catch (e) {
      throw new Error(`頁を開けませんでした: ${String((e && e.message) || e).split('\n')[0]}`);
    }
    return 開くのを待つ(空の頁.id, url, port, waitMs);
  }
  const c = await connect(any.webSocketDebuggerUrl);
  let targetId = null;
  try {
    const r = await c.send('Target.createTarget', {
      url,

      newWindow: false,
      background: true,
    });
    targetId = r && r.targetId;
  } finally {
    c.close();
  }
  if (!targetId) throw new Error('タブを開けませんでした');
  return 開くのを待つ(targetId, url, port, waitMs);
}

async function 開くのを待つ(targetId, url, port, waitMs) {

  const 期限 = Date.now() + waitMs;
  let 最後 = null;
  while (Date.now() < 期限) {
    const t = await targetOf(targetId, port);
    if (t) {
      最後 = t;

      if (t.url && t.url !== 'about:blank') break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  while (Date.now() < 期限) {
    let 中の場所 = '';
    try {

      中の場所 = await evaluate(targetId, 'location.href', { port });
    } catch {
      break;
    }
    if (中の場所 && 中の場所 !== 'about:blank') break;

    await new Promise((r) => setTimeout(r, 250));
  }
  return { targetId, url: (最後 && 最後.url) || url, title: (最後 && 最後.title) || '' };
}

async function evaluate(targetId, expression, { port = PORT, timeoutMs = 30000 } = {}) {
  const t = await 確かなタブ(targetId, port);
  if (!t) throw new Error(`そのタブはもう在りません: ${targetId}`);
  if (isOwnSite(t.url)) throw new Error(`この站には触れません: ${originOf(t.url) || t.url}`);
  const c = await connect(t.webSocketDebuggerUrl, { timeoutMs });
  try {
    const r = await c.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r && r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error((e.exception && e.exception.description) || e.text || '頁の中で失敗しました');
    }
    return r && r.result ? r.result.value : null;
  } finally {
    c.close();
  }
}

const 画像の上限 = 30;

async function 確かな頁(targetId, port = PORT) {

  if (!pw.繋がっているか(port)) 確かめた口.delete(port);
  await 用意する(port);
  await pw.繋ぐ(port, 窓を出させる);
  const page = await pw.頁(targetId, port);
  if (!page) throw new Error(`そのタブはもう在りません: ${targetId}`);
  const u = page.url();
  if (isOwnSite(u)) throw new Error(`この站には触れません: ${originOf(u) || u}`);
  return page;
}

async function read(targetId, opts = {}) {
  const page = await 確かな頁(targetId, opts.port || PORT);
  return pw.読む(page, { 画像の上限 });
}

async function click(targetId, 目印 = {}, opts = {}) {
  const page = await 確かな頁(targetId, opts.port || PORT);
  return pw.押す(page, 目印);
}

async function set(targetId, 目印 = {}, 値, opts = {}) {
  const page = await 確かな頁(targetId, opts.port || PORT);
  return pw.値を入れる(page, 目印, 値);
}

async function fetchBytes(targetId, url, opts = {}) {
  if (isOwnSite(url)) throw new Error(`この站からは取れません: ${originOf(url) || url}`);
  const EXPR = `(async () => {
    const r = await fetch(${JSON.stringify(String(url))});
    if (!r.ok) return { ok: false, why: String(r.status) };
    const b = await r.blob();
    const base64 = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.readAsDataURL(b);
    });
    return { ok: true, type: b.type || '', size: b.size, base64 };
  })()`;
  return evaluate(targetId, EXPR, opts);
}

async function shot(targetId, { port = PORT, full = false, timeoutMs = 30000 } = {}) {
  const t = await 確かなタブ(targetId, port);
  if (!t) throw new Error(`そのタブはもう在りません: ${targetId}`);
  if (isOwnSite(t.url)) throw new Error(`この站には触れません: ${originOf(t.url) || t.url}`);
  const c = await connect(t.webSocketDebuggerUrl, { timeoutMs });
  try {

    const 撮る = () =>
      c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full });
    let r;
    try {
      r = await 撮る();
    } catch (e) {
      if (!/not attached|not available|target closed/i.test(String(e.message))) throw e;
      await new Promise((x) => setTimeout(x, 1200));
      r = await 撮る();
    }
    return { base64: (r && r.data) || '', url: t.url, title: t.title || '' };
  } finally {
    c.close();
  }
}

async function type(targetId, 目印 = {}, opts = {}) {
  const page = await 確かな頁(targetId, opts.port || PORT);
  const 鍵 = String(目印.key || '');
  if (鍵 && !KEYS[鍵]) {
    throw new Error(`知らない鍵です: ${鍵}（使えるのは ${Object.keys(KEYS).join(' / ')}）`);
  }
  return pw.打つ(page, 目印, 目印.text, 鍵);
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
};

async function scroll(targetId, { dy = 0, to = '' } = {}, opts = {}) {
  const page = await 確かな頁(targetId, opts.port || PORT);
  return page.evaluate(
    ({ dy: d, to: t }) => {
      const 前 = window.scrollY;
      if (t === 'top') window.scrollTo(0, 0);
      else if (t === 'bottom') window.scrollTo(0, document.body.scrollHeight);
      else window.scrollBy(0, Number(d) || 0);
      const 後 = window.scrollY;
      return { from: 前, to: 後, moved: 後 - 前, height: document.body.scrollHeight, view: window.innerHeight };
    },
    { dy, to }
  );
}

async function close(targetId, { port = PORT } = {}) {
  const list = await getJSON('/json/list', port);
  const any = list.find((x) => x.type === 'page');
  if (!any) return false;
  const c = await connect(any.webSocketDebuggerUrl);
  try {
    await c.send('Target.closeTarget', { targetId });
    return true;
  } catch {
    return false;
  } finally {
    c.close();
  }
}

const 手を離す = () => require('./pwpage').手を離す();

module.exports = { PORT, originOf, isOwnSite, open, read, click, set, shot, type, scroll, fetchBytes, close, evaluate, targetOf, KEYS, 窓を出させる, 用意する, 手を離す };
