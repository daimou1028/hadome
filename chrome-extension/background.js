const openedByPort = new Map();

function note(line) {
  const at = new Date().toISOString().slice(11, 19);
  chrome.storage.local.get({ bridgeLog: [] }, (o) => {
    const l = (o.bridgeLog || []).slice(-40);
    l.push(at + ' ' + line);
    chrome.storage.local.set({ bridgeLog: l });
  });
}

function findTabFor(port, done) {
  const kept = openedByPort.get(String(port));
  if (kept !== undefined) return done(kept);
  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    const hit = (tabs || []).find((t) => new RegExp('[?&]bridge_port=' + port + '\\b').test(t.url || ''));
    done(hit ? hit.id : undefined);
  });
}

const 窓の幅 = 500;
const 窓の高さ = 288;
const 横のずれ = 120;
const 縦のずれ = 48;

function 窓の場所(port) {
  const n = Number(port) % 10;
  if (!Number.isFinite(n)) return {};
  return { left: 40 + n * 横のずれ, top: 40 + n * 縦のずれ, width: 窓の幅, height: 窓の高さ };
}

function 同じ港の古いタブを閉じる(port, done) {
  if (!port) return done();
  chrome.tabs.query({}, (tabs) => {
    const queryErr = chrome.runtime.lastError;
    if (queryErr) {
      note('港 ' + port + ' の古いタブを探せません: ' + queryErr.message);
      return done();
    }
    const re = new RegExp('[?&]bridge_port=' + port + '\\b');
    const ids = (tabs || []).filter((t) => re.test(t.url || '')).map((t) => t.id).filter((id) => id !== undefined);
    if (ids.length === 0) return done();
    openedByPort.delete(String(port));
    chrome.tabs.remove(ids, () => {
      const removeErr = chrome.runtime.lastError;
      note('港 ' + port + (removeErr ? ' の古いタブを閉じられません: ' + removeErr.message : ' の古いタブを閉じました: ' + ids.length + ' 件'));
      done();
    });
  });
}

function 別の窓で開く(url, port, done) {
  chrome.windows.create({ url, focused: false, type: 'normal', ...窓の場所(port) }, (win) => {
    const err = chrome.runtime.lastError;
    if (err || !win || !win.tabs || !win.tabs[0]) {
      note('別の窓を作れません: ' + String((err && err.message) || '窓が返らない'));
      return done(null);
    }
    const tab = win.tabs[0];
    if (port) openedByPort.set(String(port), tab.id);
    note('下請けを別の窓で開きました（焦点は渡していません）');
    done(tab);
  });
}

function 港のタブを探す(tabs, 港, done) {
  const 当たり = [];

  const 様子 = { asked: tabs.length, ports: {}, silent: tabs.length };
  let 残り = tabs.length;
  if (!残り) return void done(当たり, 様子);
  let 済んだ = false;
  const 締める = () => {
    if (済んだ) return;
    済んだ = true;
    done(当たり, 様子);
  };
  const 時計 = setTimeout(締める, 1500);
  for (const t of tabs) {
    const 一つ済み = () => {
      残り -= 1;
      if (残り <= 0) {
        clearTimeout(時計);
        締める();
      }
    };
    try {
      chrome.tabs.sendMessage(t.id, { kind: 'which_port' }, (r) => {
        void chrome.runtime.lastError;
        if (!済んだ && r && Number.isFinite(Number(r.port))) {
          const 答え = String(Number(r.port));
          様子.ports[答え] = (様子.ports[答え] || 0) + 1;
          様子.silent -= 1;
          if (Number(r.port) === 港) 当たり.push(t.id);
        }
        一つ済み();
      });
    } catch {
      一つ済み();
    }
  }
}

function 消して返す(ids, 返す) {
  chrome.tabs.remove(ids, () => {
    const err = chrome.runtime.lastError;
    if (!err) {
      note(`橋に頼まれて、名指しの港の ChatGPT のタブを ${ids.length} 枚 閉じた`);
      return void 返す(ids.length);
    }
    chrome.tabs.query({ url: 'https://chatgpt.com/*' }, (残り) => {
      const 数え損ね = chrome.runtime.lastError;
      const まだ在る = 数え損ね ? ids.length : (残り || []).filter((x) => ids.includes(x.id)).length;
      返す(ids.length - まだ在る, String(err.message || 'remove に失敗') + (数え損ね ? `（数え直しも失敗: ${数え損ね.message}）` : ''));
    });
  });
}

const SENDS_KEY = 'sends';
const SENDS_WINDOW_MS = 60 * 60 * 1000;
let 送りの列 = Promise.resolve();
function 直近の送り(列, 今) {
  return (Array.isArray(列) ? 列 : []).map(Number).filter((x) => Number.isFinite(x) && 今 - x < SENDS_WINDOW_MS && x <= 今 + 60000);
}
function 送りを覚える(at) {
  送りの列 = 送りの列.then(
    () =>
      new Promise((resolve) => {
        chrome.storage.session.get(SENDS_KEY, (v) => {
          void chrome.runtime.lastError;
          const 列 = 直近の送り(v && v[SENDS_KEY], Date.now());
          列.push(at);
          列.sort((a, b) => a - b);
          chrome.storage.session.set({ [SENDS_KEY]: 列 }, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        });
      })
  );
  return 送りの列;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {

  if (msg && (msg.kind === 'claim' || msg.kind === 'release')) {
    const chromeTabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    専有を裁く(msg, reply, chromeTabId);
    return true;
  }

  if (msg && msg.kind === 'whoami') {
    reply({ chromeTabId: sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null });
    return false;
  }

  if (msg && msg.kind === 'sent') {
    送りを覚える(Number(msg.at) || Date.now());
    return false;
  }
  if (msg && msg.kind === 'close_tab') {
    note('close_tab を受け取りました: 港 ' + String(msg.port || ''));

    const port = String(msg.port || '');

    const own = sender && sender.tab && sender.tab.id;
    if (own !== undefined && own !== null) {
      openedByPort.delete(port);
      chrome.tabs.remove(own, () => {
        const err = chrome.runtime.lastError;
        note('港 ' + port + (err ? ' 閉じられません: ' + err.message : ' 閉じました（頼んできたタブ）'));
      });
      return false;
    }

    findTabFor(port, (id) => {
      openedByPort.delete(port);
      if (id === undefined) {
        note('港 ' + port + ' のタブが見つかりません');
        return;
      }
      chrome.tabs.remove(id, () => {
        const err = chrome.runtime.lastError;
        note('港 ' + port + (err ? ' 閉じられません: ' + err.message : ' 閉じました'));
      });
    });
    return false;
  }
  if (!msg || msg.kind !== 'open_tab') return false;
  const url = String(msg.url || '');

  if (!/^https:\/\/chatgpt\.com\//.test(url)) {
    reply({ ok: false, why: '開けるのは chatgpt.com だけです' });
    return true;
  }
  note('open_tab を受け取りました');
  const 港 = (/[?&]bridge_port=(\d+)/.exec(url) || [])[1] || '';

  if (/\/g\/g-p-/.test(url) || /[?&]bridge_sub=1(?:&|$)/.test(url)) {
    同じ港の古いタブを閉じる(港, () => {
      別の窓で開く(url, 港, (tab) => {
        if (!tab) return reply({ ok: false, why: '別の窓を作れませんでした' });
        reply({ ok: true, tabId: tab.id });
      });
    });
    return true;
  }
  chrome.tabs.create({ url, active: false }, (tab) => {
    const err = chrome.runtime.lastError;
    if (err) return reply({ ok: false, why: String(err.message || err) });
    if (港 && tab) openedByPort.set(港, tab.id);

    reply({ ok: true, tabId: tab && tab.id });
  });
  return true;
});

const CLAIM_TTL_MS = 10 * 60 * 1000;

function 専有を裁く(msg, reply, chromeTabId) {
  const 主 = String(msg.editorId || '');

  const 道の鍵 = 'claim:' + String(msg.path || '');
  const 鍵 = Number.isInteger(chromeTabId) ? 'claim:tab:' + String(chromeTabId) : 道の鍵;
  chrome.storage.session.get([鍵, 道の鍵], (v) => {
    void chrome.runtime.lastError;

    const 今 = (v && (v[鍵] || v[道の鍵])) || null;
    if (msg.kind === 'release') {

      if (!今 || 今.editorId === 主) chrome.storage.session.remove([鍵, 道の鍵]);
      reply({ ok: true, released: true });
      return;
    }

    const 古い = 今 && Date.now() - Number(今.at || 0) > CLAIM_TTL_MS;
    if (今 && !古い && 今.editorId && 今.editorId !== 主) {
      reply({ ok: false, heldBy: 今.editorId, why: 'already-claimed' });
      return;
    }
    chrome.storage.session.set({ [鍵]: { editorId: 主, at: Date.now() } }, () => {
      void chrome.runtime.lastError;
      reply({ ok: true, heldBy: 主 });
    });
  });
}

const ROSTER_FROM = 8765;
const ROSTER_TO = 8779;
const ROSTER_SKIP = [8767, 8768, 8769];

const ROSTER_EXTRA = [8799];
const ROSTER_MS = 30000;

function rosterPayload(done) {
  chrome.storage.local.get('pluginId', (v) => {
    const pluginId = (v && v.pluginId) || '';

    chrome.storage.session.get(null, (all) => {
      void chrome.runtime.lastError;
      const 専有 = all || {};
      chrome.tabs.query({ url: 'https://chatgpt.com/*' }, (tabs) => {
      void chrome.runtime.lastError;
      const 窓 = new Map();
      for (const t of tabs || []) {
        const w = String(t.windowId);
        if (!窓.has(w)) 窓.set(w, []);
        窓.get(w).push({

          chromeTabId: t.id,
          ...(Number.isInteger(t.index) ? { index: t.index } : {}),
          url: t.url || '',
          title: t.title || '',

          visible: !!t.active,

          kind: [...openedByPort.values()].includes(t.id) ? 'subagent' : 'main',

          claimedBy: (() => {
            try {

              const tabKey = 'claim:tab:' + String(t.id);
              const pathKey = 'claim:' + new URL(t.url || '').pathname;
              const 今 = 専有[tabKey] || 専有[pathKey];
              if (!今 || !今.editorId) return null;

              if (Date.now() - Number(今.at || 0) > 10 * 60 * 1000) return null;
              return 今.editorId;
            } catch {
              return null;
            }
          })(),
        });
      }
      const 送り = 直近の送り(専有[SENDS_KEY], Date.now());
      done({
        type: 'roster',
        protocol: 61,
        pluginId,

        version: (() => {
          try {
            return String(chrome.runtime.getManifest().version || '');
          } catch {
            return '';
          }
        })(),

        sends1h: 送り.length,
        sendsOldestAt: 送り.length ? 送り[0] : 0,
        browser: { ua: (navigator && navigator.userAgent) || '' },
        windows: [...窓.entries()].map(([windowId, tabs2]) => ({ windowId, tabs: tabs2 })),
      });
      });
    });
  });
}

let 前の指紋 = '';

function 名乗る(定時 = false) {
  rosterPayload((payload) => {
    if (!payload.windows.length) return;

    const 指紋 = JSON.stringify(payload.windows);
    if (!定時 && 指紋 === 前の指紋) return;
    前の指紋 = 指紋;
    const 回る枠 = [];
    for (let p = ROSTER_FROM; p <= ROSTER_TO; p += 1) if (!ROSTER_SKIP.includes(p)) 回る枠.push(p);
    for (const p of ROSTER_EXTRA) if (!回る枠.includes(p)) 回る枠.push(p);
    for (const p of 回る枠) {
      let ws = null;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${p}`);
      } catch {
        continue;
      }

      let 閉じる時計 = 0;
      const 閉じる = () => {
        try {
          ws.close();
        } catch {

        }
      };
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(payload));
        } catch {

        }

        閉じる時計 = setTimeout(閉じる, 1500);
      };

      ws.onmessage = (ev) => {
        let m = null;
        try {
          m = JSON.parse(String(ev.data || '{}'));
        } catch {
          return;
        }

        if (m.type === 'closeTabsOnPort') {
          const 狙う港 = Number.isInteger(m.port) && m.port > 0 ? m.port : 0;
          if (!狙う港) return;
          clearTimeout(閉じる時計);
          閉じる時計 = setTimeout(閉じる, 10000);
          let 訊いた様子 = null;
          const 返す2 = (n, 失敗) => {
            try {
              ws.send(JSON.stringify({ type: 'closedTabs', closed: n, port: 狙う港, pluginId: payload.pluginId, ...(訊いた様子 ? { seen: 訊いた様子 } : {}), ...(失敗 ? { error: 失敗 } : {}) }));
            } catch {

            }
            clearTimeout(閉じる時計);
            閉じる時計 = setTimeout(閉じる, 300);
          };
          chrome.tabs.query({ url: 'https://chatgpt.com/*' }, (tabs) => {
            const 探し損ね = chrome.runtime.lastError;
            if (探し損ね) return void 返す2(0, `タブを探せなかった: ${探し損ね.message || '不明'}`);
            港のタブを探す(tabs || [], 狙う港, (当たり, 様子) => {
              訊いた様子 = 様子 || null;
              if (!当たり.length) return void 返す2(0);
              消して返す(当たり, 返す2);
            });
          });
          return;
        }
        if (m.type === 'closeTabs') {

          clearTimeout(閉じる時計);
          閉じる時計 = setTimeout(閉じる, 10000);
          chrome.tabs.query({ url: 'https://chatgpt.com/*' }, (tabs) => {
            const 探し損ね = chrome.runtime.lastError;
            const 返す = (n, 失敗) => {
              try {

                ws.send(
                  JSON.stringify({
                    type: 'closedTabs',
                    closed: n,
                    pluginId: payload.pluginId,
                    ...(失敗 ? { error: 失敗 } : {}),
                  })
                );
              } catch {

              }
              clearTimeout(閉じる時計);
              閉じる時計 = setTimeout(閉じる, 300);
            };

            if (探し損ね) return void 返す(0, `タブを探せなかった: ${探し損ね.message || '不明'}`);
            const 消す = (tabs || []).map((t) => t.id);
            if (!消す.length) return void 返す(0);
            chrome.tabs.remove(消す, () => {
              const err = chrome.runtime.lastError;
              if (!err) {
                note(`橋に頼まれて ChatGPT のタブを ${消す.length} 枚 閉じた`);
                return void 返す(消す.length);
              }

              chrome.tabs.query({ url: 'https://chatgpt.com/*' }, (残り) => {

                const 数え損ね = chrome.runtime.lastError;
                const 閉じた = 数え損ね ? 0 : Math.max(0, 消す.length - (残り || []).length);
                note(`ChatGPT のタブを閉じきれなかった（${閉じた}/${消す.length}）: ${err.message}`);
                返す(閉じた, String(err.message || 'remove に失敗') + (数え損ね ? `（数え直しも失敗: ${数え損ね.message}）` : ''));
              });
            });
          });
          return;
        }
        if (m.type !== 'wantTab') return;
        const 道 = String(m.url || '');
        if (!道) return;
        chrome.tabs.query({ url: 'https://chatgpt.com/*' }, (tabs) => {
          void chrome.runtime.lastError;

          const 番号 = Number.isInteger(m.chromeTabId) ? m.chromeTabId : null;
          const 当たり =
            (番号 !== null && (tabs || []).find((x) => x.id === 番号 && String(x.url || '').includes(道))) ||
            (tabs || []).find((x) => String(x.url || '').includes(道));
          if (!当たり) return;
          try {
            chrome.tabs.sendMessage(当たり.id, { kind: 'dial', port: p });
            note(`繋ぎ直しを頼まれた: 枠 ${p} / ${道.slice(0, 40)}`);
          } catch {

          }
        });
      };
      ws.onerror = () => {

      };
    }
  });
}

let 名乗りの待ち = 0;
function 名乗りを頼む() {
  if (名乗りの待ち) clearTimeout(名乗りの待ち);
  名乗りの待ち = setTimeout(() => {
    名乗りの待ち = 0;
    名乗る();
  }, 1500);
}

setInterval(名乗る, ROSTER_MS);
try {

  chrome.alarms.get('roster', (a) => {
    void chrome.runtime.lastError;
    if (!a) chrome.alarms.create('roster', { periodInMinutes: 1 });
  });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a && a.name === 'roster') 名乗る(true);
  });
} catch {

}
chrome.tabs.onCreated.addListener(() => 名乗りを頼む());
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('claim:tab:' + String(tabId), () => { void chrome.runtime.lastError; });
  名乗りを頼む();
});
chrome.tabs.onUpdated.addListener((_id, info) => {

  if (info.url) 名乗りを頼む();
});
chrome.tabs.onActivated.addListener(() => 名乗りを頼む());
