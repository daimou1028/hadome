(() => {
  const ORIGIN_MARK = 'chatgpt-bridge';

  const DEFAULT_PORT = 8765;

  const PORT_KEY = 'chatgpt-bridge-port';

  const PIN_KEY = 'chatgpt-bridge-pin';
  function pinnedPort() {
    let fromUrl = '';
    try {
      fromUrl = new URLSearchParams(location.search).get('bridge_port') || '';
    } catch {}
    if (/^\d{2,5}$/.test(fromUrl)) {
      try {

        sessionStorage.setItem(PIN_KEY, fromUrl);
      } catch {}
      return Number(fromUrl);
    }
    try {
      const pin = sessionStorage.getItem(PIN_KEY);
      if (/^\d{2,5}$/.test(pin || '')) return Number(pin);
    } catch {}
    return 0;
  }

  const PORT_FROM = 8765;

  const PORT_TO = 8765;

  const SKIP = [8767, 8768, 8769];
  let pinned = pinnedPort();

  let pinnedFallback = 0;
  let scanningAfterPinnedFailure = false;
  function clearPinnedPort() {
    pinned = 0;
    pinnedFallback = 0;
    scanningAfterPinnedFailure = false;
    try {
      sessionStorage.removeItem(PIN_KEY);
    } catch {

    }
  }

  let pinnedFailures = 0;
  const PINNED_FAILURE_LIMIT = 3;

  let kept = 0;
  try {
    const v = sessionStorage.getItem(PORT_KEY);
    if (/^\d{2,5}$/.test(v || '')) kept = Number(v);
  } catch {

  }
  let tryPort = pinned || kept || PORT_FROM;

  function nextPort() {

    if (pinned) {
      tryPort = pinned;
      return pinned;
    }
    do {
      tryPort = tryPort >= PORT_TO ? PORT_FROM : tryPort + 1;
    } while (SKIP.includes(tryPort));
    return tryPort;
  }

  const TAB_PROTOCOL = 60;

  const STILL_WRITING_WAIT_MS = 300000;

  let lastDeltaAt = 0;

  let lastDoneAt = 0;

  let lastStreamEndAt = 0;

  let stopSeenAt = 0;

  let turnSentAt = 0;

  let sawDeltaThisTurn = false;

  let lastStuckSaid = 0;

  const STUCK_AFTER_DONE_MS = 3000;

  const STUCK_AFTER_CUT_MS = 30000;

  const STUCK_NO_DELTA_MS = 45000;

  const TAB_KEY = 'chatgpt-bridge-tab-id';
  function tabId() {
    try {
      const kept = sessionStorage.getItem(TAB_KEY);
      if (kept) return kept;
      const made = 't' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem(TAB_KEY, made);
      return made;
    } catch {

      return 't' + Math.random().toString(36).slice(2, 10);
    }
  }
  const TAB_ID = tabId();
  const RECONNECT_MS = 3000;

  const STEP_MS = 150;

  const WELCOME_WAIT_MS = 1200;
  let welcomeTimer = 0;

  const PORT_COUNT = (() => {
    let n = 0;
    for (let p = PORT_FROM; p <= PORT_TO; p += 1) if (!SKIP.includes(p)) n += 1;
    return n;
  })();
  let searched = 0;

  const REST_MAX_MS = 30000;
  let rest = RECONNECT_MS;
  function restMs() {
    const now = rest;
    rest = Math.min(rest * 2, REST_MAX_MS);

    return Math.round(now * (1 - Math.random() * 0.25));
  }

  function restReset() {
    rest = RECONNECT_MS;
  }

  let sock = null;
  let alive = false;

  let everHello = false;

  let jumping = false;

  let stayed = 0;

  const STAY_TRIES = 5;

  const pending = [];
  const PENDING_MAX = 200;

  function connect() {
    const port = tryPort;
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      nextPort();
      setTimeout(connect, RECONNECT_MS);
      return;
    }

    sock.onopen = () => {
      alive = true;

      try {
        sessionStorage.setItem(PORT_KEY, String(port));
      } catch {

      }
      send({
        type: 'hello',
        url: location.href,
        title: document.title,
        protocol: TAB_PROTOCOL,
        tabId: TAB_ID,

        turns: (() => { try { return document.querySelectorAll('[data-message-author-role]').length; } catch { return -1; } })(),

        thinking: thinkingState(),

        brands: (() => {
          try {
            const b = navigator.userAgentData && navigator.userAgentData.brands;
            return Array.isArray(b) ? b.map((x) => `${x.brand} ${x.version}`) : null;
          } catch {
            return null;
          }
        })(),
        ua: (() => {
          try {
            return String(navigator.userAgent || '').slice(0, 300);
          } catch {
            return '';
          }
        })(),
      });

      const queued = pending.splice(0, pending.length);
      for (const item of queued) send(item);

      console.log(`[bridge] つないだ（枠 ${port}）。返事を待つ`);
      clearTimeout(welcomeTimer);
      welcomeTimer = setTimeout(() => {
        if (everHello) return;
        console.log(`[bridge] 枠 ${port} は返事をしません。次を当たる`);
        try {
          sock.close();
        } catch {

        }
      }, WELCOME_WAIT_MS);
    };

    sock.onclose = () => {
      alive = false;

      if (jumping) {
        jumping = false;
        searched = 0;
        setTimeout(connect, STEP_MS);
        return;
      }

      if (!everHello) {

        if (pinned) {
          pinnedFailures += 1;
          if (pinnedFailures >= PINNED_FAILURE_LIMIT) {

            pinnedFallback = pinned;
            pinned = 0;
            scanningAfterPinnedFailure = true;
            pinnedFailures = 0;
          }
        } else if (scanningAfterPinnedFailure && pinnedFallback) {

          pinned = pinnedFallback;
          pinnedFallback = 0;
          scanningAfterPinnedFailure = false;
        }
        nextPort();

        searched += 1;
        const 一巡した = searched >= PORT_COUNT;
        if (一巡した) searched = 0;

        setTimeout(connect, 一巡した ? restMs() : STEP_MS);
        return;
      }

      stayed += 1;
      if (stayed >= STAY_TRIES) {
        stayed = 0;
        everHello = false;
        if (pinned) {

          pinnedFallback = pinned;
          pinned = 0;
          scanningAfterPinnedFailure = true;
          pinnedFailures = 0;
        }
        nextPort();
      }
      setTimeout(connect, RECONNECT_MS);
    };

    sock.onerror = () => {

    };

    sock.onmessage = async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg && msg.type === 'welcome') {
        clearTimeout(welcomeTimer);
        everHello = true;
        stayed = 0;
        pinnedFailures = 0;
        searched = 0;

        restReset();
        console.log(`[bridge] 送り先になった（枠 ${tryPort}）`);

        try {
          chrome.storage.local.set({ bridgePort: tryPort });
        } catch {

        }
        return;
      }

      if (msg && msg.type === 'handover') {

        if (pinned) {
          console.log('[bridge] 移れと言われましたが、枠が指されているので動きません');
          return;
        }
        const 先 = Number(msg.port || 0);
        if (!(先 >= PORT_FROM && 先 <= PORT_TO) || SKIP.includes(先)) return;
        console.log(`[bridge] 枠 ${tryPort} から ${先} へ移ります（橋に言われた）`);
        tryPort = 先;
        jumping = true;
        everHello = false;
        stayed = 0;
        searched = 0;
        clearTimeout(welcomeTimer);

        try {
          sessionStorage.setItem(PORT_KEY, String(先));
        } catch {

        }
        try {
          chrome.storage.local.set({ bridgePort: 先 });
        } catch {

        }
        try {
          sock.close();
        } catch {

        }
        return;
      }

      if (msg && msg.type === 'not_target') {
        everHello = false;
        clearTimeout(welcomeTimer);
        try {
          sock.close();
        } catch {

        }
        return;
      }
      if (!msg) {
        return;
      }
      if (msg.type === 'close_tab') {

        try {
          chrome.runtime.sendMessage({ kind: 'close_tab', port: msg.port });
        } catch {

        }

        setTimeout(() => {
          try {
            location.replace('about:blank');
          } catch {

          }
        }, 2500);
        return;
      }
      if (msg.type === 'open_tab') {

        chrome.runtime.sendMessage({ kind: 'open_tab', url: msg.url }, (r) => {
          send({ type: 'tab_opened', id: msg.id, ok: !!(r && r.ok), why: (r && r.why) || '' });
        });
        return;
      }
      if (msg.type === 'navigate') {

        if (msg.url === 'about:blank') {
          location.href = 'about:blank';
          return;
        }
        if (typeof msg.url === 'string' && msg.url.startsWith('https://chatgpt.com/')) {
          location.href = msg.url;
        }
        return;
      }

      const 一覧の入口 = () => document.querySelector('[data-testid="sidebar-item-projects"]');
      const 一覧の根 = () => document.querySelector('[data-testid="project-directory-scroll-root"]');

      const 一覧の行 = () =>
        [...document.querySelectorAll('[data-testid="project-folder-icon"]')]
          .map((ic) => {
            let p2 = ic;
            for (let k = 0; k < 6 && p2; k += 1) {
              const t = (p2.textContent || '').replace(/\s+/g, ' ').trim();
              if (t.length > 1 && t.length < 90) break;
              p2 = p2.parentElement;
            }
            return p2;
          })
          .filter(Boolean);
      const 一覧の名 = (行) => {
        const d = 行.querySelector('.truncate');
        const 名 = ((d ? d.textContent : 行.textContent) || '').replace(/\s+/g, ' ').trim();
        return 名 && 名.length <= 60 ? 名 : '';
      };

      if (msg.type === 'list_projects') {
        const 列の印 = '[class*="project-unfurl-row"]';

        const 名前にする = (列) => {
          const 名 = (列.textContent || '').replace(/\s+/g, ' ').trim();
          return 名 && 名.length <= 60 ? 名 : '';
        };

        const 拾う = () => {
          const 出た = [];
          for (const 列 of document.querySelectorAll(列の印)) {
            const 名 = 名前にする(列);
            if (名 && !出た.some((x) => x.name === 名)) 出た.push({ id: '', name: 名 });
          }
          if (出た.length) return 出た;

          if (一覧の根()) {
            for (const 行 of 一覧の行()) {
              const 名 = 一覧の名(行);
              if (名 && !出た.some((x) => x.name === 名)) 出た.push({ id: '', name: 名 });
            }
            if (出た.length) return 出た;
          }

          return 出た;
        };

        const 返す = (出た) => {
          send({
            type: 'projects',
            id: msg.id || null,
            projects: 出た,
            where: location.href,
            links: document.querySelectorAll('a[href]').length,
            current: (/\/g\/(g-p-[A-Za-z0-9-]+)/.exec(location.href) || [])[1] || '',
            currentName: document.title || '',

            heads: [...document.querySelectorAll('[aria-label]')]
              .map((e) => (e.getAttribute('aria-label') || '').trim())
              .filter((x) => /專案|项目|project|プロジェクト/i.test(x))
              .slice(0, 8),
          });
        };

        let 移った = false;
        let 残り = 60;
        const 試す = () => {
          const 出た = 拾う();
          if (出た.length) {
            返す(出た);
            return;
          }

          if (!移った && !一覧の根() && 一覧の入口()) {
            移った = true;
            const a = 一覧の入口();
            for (const ty of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              a.dispatchEvent(new MouseEvent(ty, { bubbles: true, cancelable: true, view: window, button: 0 }));
            }
            setTimeout(試す, 600);
            return;
          }
          if (--残り <= 0) {
            返す([]);
            return;
          }
          setTimeout(試す, 500);
        };
        試す();
        return;
      }

      if (msg.type === 'project_id') {
        const 名 = String(msg.name || '');
        const 拾う = () =>
          [...document.querySelectorAll('a[href]')]
            .map((a) => a.getAttribute('href') || '')
            .map((h) => (/\/g\/(g-p-[A-Za-z0-9-]+)/.exec(h) || [])[1])
            .filter(Boolean);

        const 前 = new Set(拾う());
        let 押した = false;
        for (const li of document.querySelectorAll('li')) {
          if ((li.textContent || '').replace(/\s+/g, ' ').trim() !== 名) continue;
          const b = li.querySelector('[role=button], a, button') || li;
          try {
            b.scrollIntoView({ block: 'center' });
          } catch {}

          for (const 型 of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            b.dispatchEvent(new MouseEvent(型, { bubbles: true, cancelable: true, view: window, button: 0 }));
          }
          押した = true;
          break;
        }
        if (!押した) {

          const 行 = 一覧の根() ? 一覧の行().find((x) => 一覧の名(x) === 名) : null;
          if (行) {
            for (const 型 of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              行.dispatchEvent(new MouseEvent(型, { bubbles: true, cancelable: true, view: window, button: 0 }));
            }
            let のこり = 40;
            const 道を見る = () => {
              const id2 = (/\/g\/(g-p-[A-Za-z0-9-]+)/.exec(location.href) || [])[1] || '';
              if (id2) {
                send({ type: 'projectId', id: msg.id || null, ok: true, project: id2, name: 名 });
                return;
              }
              if (--のこり <= 0) {
                send({ type: 'projectId', id: msg.id || null, ok: false, why: 'noId', name: 名 });
                return;
              }
              setTimeout(道を見る, 250);
            };
            setTimeout(道を見る, 300);
            return;
          }
          send({ type: 'projectId', id: msg.id || null, ok: false, why: 'notfound' });
          return;
        }

        let 残り = 60;
        const 見る = () => {

          const 新しい = 拾う().filter((x) => !前.has(x));
          if (新しい.length) {
            send({ type: 'projectId', id: msg.id || null, ok: true, project: 新しい[0], name: 名 });
            return;
          }
          if (--残り <= 0) {
            send({ type: 'projectId', id: msg.id || null, ok: false, why: 'noId', name: 名 });
            return;
          }
          setTimeout(見る, 250);
        };
        setTimeout(見る, 400);
        return;
      }

      if (msg.type === 'create_project') {
        const 名 = String(msg.name || '');
        const 押す = (e) => {
          for (const t2 of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            e.dispatchEvent(new MouseEvent(t2, { bubbles: true, cancelable: true, view: window, button: 0 }));
          }
        };
        const 待つ = (見る, 残り, 次) => {
          if (見る()) return 次(true);
          if (--残り <= 0) return 次(false);
          setTimeout(() => 待つ(見る, 残り, 次), 400);
        };
        const 終わり = (ok, why, project) =>
          send({ type: 'projectCreated', id: msg.id || null, ok, why: why || '', project: project || '' });

        const 探す = () => {

          const 入口 = document.querySelector('[data-testid="sidebar-item-projects"]');
          const 直 = 入口 && 入口.querySelector('button[data-trailing-button]');
          if (直) return 直;
          for (const 節 of document.querySelectorAll('[class*="sidebar-expando-section"]')) {
            if (!節.querySelector('[class*="project-unfurl-row"]')) continue;
            const b = [...節.querySelectorAll('button')].find(
              (x) =>
                !x.closest('[class*="project-unfurl-row"]') &&
                x.hasAttribute('data-trailing-button') &&
                x.getAttribute('aria-expanded') === null
            );
            if (b) return b;
          }
          return null;
        };

        if (!document.querySelector('[class*="sidebar-expando-section"]')) {
          const 開く = document.querySelector('[data-testid="open-sidebar-button"]');
          if (開く) 押す(開く);
        }
        待つ(() => !!探す(), 60, (在った) => {
        if (!在った) return void 終わり(false, 'sidebarClosed');
        押す(探す());

        待つ(
          () => [...document.querySelectorAll('[role="dialog"] input, dialog input')].length,
          30,
          (出た) => {
            if (!出た) return void 終わり(false, 'noDialog');
            const 欄 = [...document.querySelectorAll('[role="dialog"] input, dialog input')][0];
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            欄.focus();
            setter.call(欄, 名);
            欄.dispatchEvent(new Event('input', { bubbles: true }));
            欄.dispatchEvent(new Event('change', { bubbles: true }));

            setTimeout(() => {
              const 箱 = 欄.closest('[role="dialog"], dialog');
              const ボタン = [...(箱 ? 箱.querySelectorAll('button') : [])];

              const 作る =
                ボタン.find((b) => /建立|创建|Create|作成/i.test((b.textContent || '').trim())) ||
                ボタン[ボタン.length - 1];
              if (!作る) return void 終わり(false, 'noCreate');
              押す(作る);

              待つ(
                () => /\/g\/g-p-[A-Za-z0-9-]+/.test(location.href),
                40,
                (移った) => {
                  const m2 = /\/g\/(g-p-[A-Za-z0-9-]+)/.exec(location.href);
                  終わり(!!(移った && m2), 移った ? '' : 'noMove', m2 ? m2[1] : '');
                }
              );
            }, 600);
          }
        );
        });
        return;
      }

      const 専案限定か = (字) =>
        /僅限專案|仅限项目|プロジェクト限定|Project[- ]only/i.test(String(字 || ''));

      const 指令欄を開く = (名, 終わり, 次) => {
        const 待つ = (見る, 残り, 続き) => {
          if (見る()) return 続き(true);
          if (--残り <= 0) return 続き(false);
          setTimeout(() => 待つ(見る, 残り, 続き), 400);
        };
        const 押す = (e) => {
          for (const t2 of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            e.dispatchEvent(new MouseEvent(t2, { bubbles: true, cancelable: true, view: window, button: 0 }));
          }
        };

        const 旧い列 = () =>
          [...document.querySelectorAll('[class*="project-unfurl-row"]')].find(
            (r) => (r.textContent || '').replace(/\s+/g, ' ').trim() === 名
          );
        const 新しい列 = () => {
          const 根 = 一覧の根();
          if (!根) return null;
          return (
            [...根.querySelectorAll('[role="row"]')].find((r) => {
              const t = r.querySelector('.truncate');
              return t && (t.textContent || '').replace(/\s+/g, ' ').trim() === 名;
            }) || null
          );
        };
        const 列を探す = () => 旧い列() || 新しい列();

        const 選び所 = (列) => {
          const t = [...列.querySelectorAll('button[data-trailing-button]')];
          if (t.length) return t[t.length - 1];
          const b = [...列.querySelectorAll('button')];
          return b.length ? b[b.length - 1] : null;
        };

        let 移った = false;
        const 探し当てる = (残り, 続き2) => {
          if (列を探す()) return 続き2(true);
          if (!移った && !一覧の根() && 一覧の入口()) {
            移った = true;
            押す(一覧の入口());
            return void setTimeout(() => 探し当てる(残り, 続き2), 600);
          }
          if (--残り <= 0) return 続き2(false);
          setTimeout(() => 探し当てる(残り, 続き2), 400);
        };
        探し当てる(20, (出た) => {
          if (!出た) {

            const 数 = document.querySelectorAll('a[href*="/g/g-p-"]').length;
            const 題 = String(document.title || '');
            return void 終わり(false, `noRow:links=${数}:title=${題.slice(0, 40)}`);
          }
          const 列 = 列を探す();
          const b = 選び所(列);
          if (!b) return void 終わり(false, 'noMenuButton');
          押す(b);
          続き(列);
        });
        return;
        function 続き(列) {

        待つ(
          () => document.querySelector('[role="menuitem"], [role="menu"] button'),
          25,
          (開いた) => {
            if (!開いた) return void 終わり(false, 'noMenu');

            const 項目 = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button')];
            const 設定 =
              項目.find((e) =>
                /設定|设置|setting/i.test((e.textContent || '').replace(/\s+/g, ' ').trim())
              ) || (項目.length === 4 ? 項目[2] : null);
            if (!設定) return void 終わり(false, 'noSettingsItem');
            押す(設定);

            待つ(
              () => [...document.querySelectorAll('[role="dialog"] textarea, dialog textarea')].length,
              30,
              (出た) => {
                if (!出た) return void 終わり(false, 'noDialog');

                const 欄 =
                  document.querySelector('[role="dialog"] textarea#instructions, dialog textarea#instructions') ||
                  [...document.querySelectorAll('[role="dialog"] textarea, dialog textarea')].pop();
                if (!欄) return void 終わり(false, 'noField');
                次(欄, 押す);
              }
            );
          }
        );
        }
      };

      if (msg.type === 'read_instructions') {
        const 名 = String(msg.name || '');
        const 終わり = (ok, why, 字) =>
          send({ type: 'instructionsRead', id: msg.id || null, ok, why: why || '', text: 字 || '' });
        指令欄を開く(名, 終わり, (欄, 押す) => {
          const 字 = String(欄.value || '');
          const 箱 = 欄.closest('[role="dialog"], dialog');

          const 閉じる =
            (箱 && 箱.querySelector('button[data-testid="close-button"]')) ||
            [...(箱 ? 箱.querySelectorAll('button') : [])].find((b) =>
              /取消|取り消|キャンセル|Cancel|閉じる|Close/i.test((b.textContent || '').trim())
            );
          if (閉じる) 押す(閉じる);
          else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          setTimeout(() => 終わり(true, '', 字), 600);
        });
        return;
      }

      if (msg.type === 'write_instructions') {
        const 名 = String(msg.name || '');
        const 字 = String(msg.text || '');
        const 終わり = (ok, why, 中身) =>
          send({ type: 'instructionsWritten', id: msg.id || null, ok, why: why || '', len: 中身 || 0 });
        指令欄を開く(名, 終わり, (欄, 押す) => {

          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value'
          ).set;
          欄.focus();
          setter.call(欄, 字);
          欄.dispatchEvent(new Event('input', { bubbles: true }));
          欄.dispatchEvent(new Event('change', { bubbles: true }));

          const メモリを直す = (次へ) => {
            if (msg.memory !== 'project') return void 次へ();
            const 箱 = 欄.closest('[role="dialog"], dialog');

            const ボタン =
              (箱 && 箱.querySelector('button[data-testid="project-memory-scope-trigger"]')) ||
              [...(箱 ? 箱.querySelectorAll('button') : [])].find((b) =>
                /記憶|メモリ|memory/i.test(
                  (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')
                )
              );

            if (!ボタン || 専案限定か(ボタン.textContent || '')) {
              return void 次へ();
            }
            押す(ボタン);
            setTimeout(() => {

              const 選び所 = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
              const 項 = 選び所.find((e) => 専案限定か(e.textContent || '')) ||
                (選び所.length === 2 ? 選び所[1] : null);

              if (項 && 項.getAttribute('aria-checked') === 'true') {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              } else if (項) 押す(項);
              setTimeout(次へ, 700);
            }, 700);
          };

          setTimeout(() => メモリを直す(() => {

            const 箱 = 欄.closest('[role="dialog"], dialog');
            const ボタン = [...(箱 ? 箱.querySelectorAll('button') : [])];

            const 保存 =
              ボタン.find((b) =>
                /儲存|保存|Save|更新|Update|完了/i.test((b.textContent || '').trim())
              ) || ボタン[ボタン.length - 1];
            if (!保存) return void 終わり(false, 'noSave');

            const 名前欄 = 箱
              ? 箱.querySelector('input[name="name"], input#name, input[type="text"]')
              : null;
            const いまの名 = 名前欄 ? String(名前欄.value || '').trim() : '';
            const 待ちの字 = /^(Loading|読み込み|\u8f09\u5165|\u52a0\u8f7d)/i;
            if (待ちの字.test(いまの名) || (名前欄 && !いまの名)) {
              return void 終わり(false, 'nameNotReady:' + (いまの名 || '(空)'));
            }
            押す(保存);
            setTimeout(() => 終わり(true, '', 欄.value.length), 1500);
          }), 500);
        });
        return;
      }

      if (msg.type === 'new_conversation') {

        const 入口 = typeof msg.url === 'string' && /^https:\/\/chatgpt\.com\//.test(msg.url)
          ? msg.url
          : 'https://chatgpt.com/';

        if (location.href.split('?')[0].replace(/\/$/, '') === 入口.split('?')[0].replace(/\/$/, '')) {
          location.reload();
        } else {
          location.href = 入口;
        }
        return;
      }

      if (msg.type === 'reload_tab') {
        location.reload();
        return;
      }

      if (msg.type === 'project_hop') {
        const projectLink = document.querySelector('a[href*="g-p-"][href$="/project"]');
        if (!projectLink) {
          send({ type: 'hopped', id: msg.id || null, ok: false, why: '画面に専案への連結が無い', url: location.href });
          return;
        }
        projectLink.click();

        const hopDeadline = Date.now() + 20000;
        (async () => {
          for (;;) {
            if (findComposer() && /\/project$/.test(location.pathname)) {
              send({ type: 'hopped', id: msg.id || null, ok: true, url: location.href });
              return;
            }
            if (Date.now() > hopDeadline) {
              send({
                type: 'hopped',
                id: msg.id || null,
                ok: false,
                why: '押しても入口が描けない（20 秒）',
                url: location.href,
              });
              return;
            }
            await sleep(200);
          }
        })();
        return;
      }
      if (msg.type === 'probe') {
        send({
          type: 'probed',
          id: msg.id || null,
          url: location.href,
          composer: !!findComposer(),

          conversations: Array.from(document.querySelectorAll('a[href^="/c/"]'))
            .map((a) => a.getAttribute('href'))
            .filter(Boolean)
            .slice(0, 20),
        });
        return;
      }
      if (msg.type === 'read_notice') {
        send({ type: 'noticeRead', id: msg.id || null, ok: true, texts: noticeTexts(), url: location.href });
        return;
      }
      if (msg.type !== 'send') return;
      try {
        const up = await submitPrompt(msg.text, msg.files || [], {
          asFile: !!msg.asFile,
          body: typeof msg.body === 'string' ? msg.body : '',

          thinking: typeof msg.thinking === 'boolean' ? msg.thinking : undefined,
        });
        send({ type: 'submitted', id: msg.id, upload: up });

        aliveBeat(msg.id);
      } catch (err) {

        send({
          type: 'error',
          id: msg.id,
          message: String((err && err.message) || err),
          ...(err && err.code ? { code: String(err.code) } : {}),
        });
      }
    };
  }

  const BEAT_MS = 5000;
  const BEAT_MAX = 120;
  let beatTimer = null;

  let turnBeatTimer = null;

  function startTurnBeat() {
    if (turnBeatTimer) clearInterval(turnBeatTimer);
    let n = 0;
    let prev = Date.now();
    turnBeatTimer = setInterval(() => {
      n += 1;
      const now = Date.now();

      const late = Math.max(0, now - prev - BEAT_MS);
      prev = now;

      if (!turnSentAt || n > BEAT_MAX) {
        clearInterval(turnBeatTimer);
        turnBeatTimer = null;
        return;
      }
      send({ type: 'tabAlive', n, late });
    }, BEAT_MS);
  }

  function aliveBeat(id) {
    if (beatTimer) clearInterval(beatTimer);
    let n = 0;
    beatTimer = setInterval(() => {
      n += 1;
      if (n > BEAT_MAX || !findStopButton()) {
        clearInterval(beatTimer);
        beatTimer = null;
        return;
      }
      send({ type: 'busy', id, tool: 'writing' });
    }, BEAT_MS);
  }

  function send(obj) {
    if (alive && sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(obj));
      return;
    }

    pending.push(obj);
    while (pending.length > PENDING_MAX) pending.shift();
  }

  function isStuck() {
    const now = Date.now();

    if (turnSentAt > 0 && !sawDeltaThisTurn) return false;
    const noDelta = lastDeltaAt > 0 && now - lastDeltaAt > STUCK_NO_DELTA_MS;
    const doneAndQuiet =
      (lastDoneAt > 0 && lastDoneAt >= lastDeltaAt && now - lastDoneAt > STUCK_AFTER_DONE_MS) ||
      (lastStreamEndAt > 0 &&
        lastStreamEndAt >= lastDeltaAt &&
        now - lastStreamEndAt > STUCK_AFTER_CUT_MS);

    const neverSaw = lastDeltaAt === 0 && lastDoneAt === 0 && lastStreamEndAt === 0;
    const stale = neverSaw && stopSeenAt > 0 && now - stopSeenAt > STUCK_NO_DELTA_MS;
    return noDelta || doneAndQuiet || stale;
  }

  const STUCK_UI_MARK = 'STUCK_UI';

  function escapeStuck() {
    const b = findStopButton();

    if (!b) {
      stopSeenAt = 0;
      return false;
    }
    const now = Date.now();
    if (!stopSeenAt) stopSeenAt = now;

    if (isStuck() && b.disabled) {
      throw new Error(
        `${STUCK_UI_MARK}: 画面が固まっています（停止ボタンが押せない状態で残っています）`
      );
    }
    if (!isStuck()) {

      if (now - lastStuckSaid > 10000) {
        lastStuckSaid = now;
        send({
          type: 'note',
          text:
            '[tab] 停止ボタンが残っていますが、まだ固まりとは見なしていません' +
            `（字が来なくなって ${lastDeltaAt ? Math.round((now - lastDeltaAt) / 1000) : '—'} 秒 / ` +
            `流れの終わりから ${lastStreamEndAt ? Math.round((now - lastStreamEndAt) / 1000) : '—'} 秒）`,
        });
      }
      return false;
    }
    send({ type: 'note', text: '[tab] 返答は終わっているのに停止ボタンが残っています。押して進めます' });
    b.click();
    return true;
  }

  function findComposer() {

    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector('textarea')
    );
  }

  function noticeTexts() {
    try {
      const box = findComposer();
      if (!box) return [];
      let area = box;
      for (let i = 0; i < 6 && area.parentElement; i += 1) area = area.parentElement;
      const seen = [];
      for (const e of area.querySelectorAll('*')) {
        if (e.children.length) continue;
        const t = (e.textContent || '').trim();
        if (t.length < 20 || t.length > 200) continue;
        if (box.contains(e)) continue;
        if (!seen.includes(t)) seen.push(t);
        if (seen.length >= 2) break;
      }
      return seen;
    } catch {
      return [];
    }
  }

  function findSendButton() {
    return (
      document.querySelector('[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('button[aria-label*="送信"]')
    );
  }

  function sendable(b) {
    return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  }

  function findStopButton() {
    return (
      document.querySelector('[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label*="Stop"]') ||
      document.querySelector('button[aria-label*="停止"]')
    );
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitFor(name, getter, timeoutMs = 15000, whyIfLate = null, look = null) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = getter();
      if (v) return v;
      if (Date.now() > deadline) {
        let seen = '';
        try {
          seen = look ? `\n${look()}` : '';
        } catch {
          seen = '';
        }

        const why = typeof whyIfLate === 'function' ? whyIfLate() : whyIfLate;

        const err = new Error(
          (why
            ? `${why}（${Math.round(timeoutMs / 1000)} 秒待ちました。いる場所: ${location.pathname}）`
            : `${name}が見つからないまま ${Math.round(timeoutMs / 1000)} 秒たちました` +
              `（いる場所: ${location.pathname}）。` +
              '画面がまだ出来上がっていないか、chatgpt.com の作りが変わった可能性があります。') + seen
        );
        err.code = 'waitTimeout';
        throw err;
      }
      await sleep(150);
    }
  }

  function findFileInput() {
    const all = [...document.querySelectorAll('input[type=file]')];

    return all.find((i) => !i.accept) || all[0] || null;
  }

  function chipLabels() {

    const out = [];
    const 入れ物 = [...document.querySelectorAll('[role="group"][class*="file-tile"]')];
    for (const t of 入れ物) {
      const words = [t.getAttribute('aria-label') || ''];
      for (const n of t.querySelectorAll('[aria-label]')) words.push(n.getAttribute('aria-label') || '');
      words.push((t.textContent || '').trim());
      out.push(words.filter(Boolean));
    }
    if (out.length) return out;

    const dels = [...document.querySelectorAll('button[aria-label]')].filter((b) =>
      /削除|remove|Remove|移除/.test(b.getAttribute('aria-label') || '')
    );
    for (const b of dels) {
      const words = [b.getAttribute('aria-label') || ''];
      let e = b;
      for (let i = 0; i < 7 && e.parentElement; i += 1) e = e.parentElement;
      for (const n of e.querySelectorAll('[aria-label]')) words.push(n.getAttribute('aria-label') || '');
      words.push((e.textContent || '').trim());
      out.push(words.filter(Boolean));
    }
    return out;
  }

  function chipHasName(labels, name) {
    const s = String(name || '');
    const dot = s.lastIndexOf('.');
    const stem = dot > 0 ? s.slice(0, dot) : s;
    const ext = dot > 0 ? s.slice(dot) : '';

    const re = new RegExp(
      esc(stem) + '(?:\\s*\\(\\d+\\))?' + esc(ext).replace(/\\\./g, '\\.')
    );
    return labels.some((words) => words.some((w) => re.test(w)));
  }

  function esc(x) {
    return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  const UPLOAD_WAIT_MS = 120000;

  const START_WAIT_MS = 8000;

  async function attachFiles(files) {
    const list = (files || []).filter((f) => f && f.name);
    if (!list.length) return { uploaded: [], failed: [] };
    const inp = await waitFor('上げ口', findFileInput, 20000);

    const dt = new DataTransfer();
    for (const f of list) {
      dt.items.add(
        new File([b64ToBytes(f.b64)], String(f.name), { type: String(f.mime || 'application/octet-stream') })
      );
    }
    const before = chipLabels().length;
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));

    const t0 = Date.now();
    const phase = {};
    while (Date.now() - t0 < START_WAIT_MS) {
      const b = findSendButton();
      if (b && b.disabled) break;
      await sleep(100);
    }
    phase.始まるまで = Date.now() - t0;

    await waitFor(
      '上げ終わるの',
      () => {
        const b = findSendButton();
        if (!b) return null;
        return b.disabled ? null : true;
      },
      UPLOAD_WAIT_MS,
      'ファイルが上がり終わりませんでした'
    );
    phase.終わるまで = Date.now() - t0;

    await sleep(800);

    const labels = chipLabels();
    const uploaded = [];
    const failed = [];

    const seen = labels.map((w) => w.join(' | ').slice(0, 80)).slice(0, 6);
    for (const f of list) {
      if (chipHasName(labels, f.name)) uploaded.push(f.name);
      else failed.push(f.name);
    }
    return { uploaded, failed, seen, phase };
  }

  function pasteAsFile(box, text) {
    box.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });

    return box.dispatchEvent(ev) === false;
  }

  const SENT_CONFIRM_MS = 6000;
  const SEND_TRIES = 6;

  function composerLen() {
    const c = findComposer();
    if (!c) return 0;
    return (c.tagName === 'TEXTAREA' ? c.value : c.textContent || '').length;
  }

  let replyWatchTimer = 0;
  function watchReplyMissing(missing) {
    if (replyWatchTimer) clearInterval(replyWatchTimer);
    const 始め = Date.now();
    let 続いた = 0;
    let 言った = false;
    replyWatchTimer = setInterval(() => {

      if (sawDeltaThisTurn || findStopButton() || !turnSentAt) {
        clearInterval(replyWatchTimer);
        replyWatchTimer = 0;
        return;
      }
      if (!missing()) {
        続いた = 0;
        return;
      }
      if (!続いた) 続いた = Date.now();
      if (!言った && Date.now() - 続いた >= STUCK_NO_DELTA_MS) {
        言った = true;
        send({
          type: 'note',
          text:
            '[tab] 送れていますが、相手が 1 字も返していません' +
            `（${Math.round((Date.now() - 始め) / 1000)} 秒。停止ボタン無し・入力欄は空・` +
            '送った字が最後の投稿のまま）',
        });
      }
    }, 3000);
  }

  async function pressSend(name, timeoutMs, whyIfLate, look, sentText) {
    for (let n = 1; n <= SEND_TRIES; n += 1) {
      const b = await waitFor(
        name,
        () => {
          const x = findSendButton();
          if (sendable(x)) return x;

          escapeStuck();
          return null;
        },
        timeoutMs,
        whyIfLate,
        look
      );
      const had = composerLen();

      const userMessages = () =>
        Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      const lastUserMessage = () => {
        const messages = userMessages();
        return messages.length ? messages[messages.length - 1] : null;
      };

      const beforeUserMessages = new Set(userMessages());
      b.click();
      const addedUserMessage = () =>
        userMessages().find((node) => !beforeUserMessages.has(node)) || null;

      const composerCleared = () =>
        composerLen() < Math.max(1, Math.floor(had / 2)) || !!findStopButton();
      const gone = () => !!addedUserMessage();

      const 様子 = () =>
        `送ろうとした字=${String(sentText || '').length} 文字` +
        ` / 入力欄=${composerLen()} 文字（空になった=${composerCleared() ? 'はい' : 'いいえ'}）` +
        ` / 停止ボタン=${findStopButton() ? '在り' : '無し'}`;
      const till = Date.now() + SENT_CONFIRM_MS;
      for (;;) {
        const sentNode = addedUserMessage();
        if (sentNode) {

          turnSentAt = Date.now();
          sawDeltaThisTurn = false;

          startTurnBeat();

          watchReplyMissing(
            () =>
              lastUserMessage() === sentNode &&
              !findStopButton() &&
              composerLen() === 0
          );
          return b;
        }
        if (Date.now() > till) break;
        await sleep(200);
      }
      send({
        type: 'note',
        text: `[tab] 送信ボタンを押しましたが、投稿が増えません（${n}/${SEND_TRIES} 回目。${様子()}）。押し直します`,
      });
    }
    throw new Error(
      `送信ボタンを ${SEND_TRIES} 回押しましたが、投稿が増えませんでした` +
        `（いる場所: ${location.pathname} / ${様子()}）`
    );
  }

  function thinkingPill() {
    try {
      const all = [...document.querySelectorAll('button.__composer-pill[aria-pressed]')];
      return all.length === 1 ? all[0] : null;
    } catch {
      return null;
    }
  }

  let thinkingInertNoted = false;

  function thinkingState() {
    const b = thinkingPill();
    if (!b) return { present: false, usable: false, on: false };
    const usable =
      b.getAttribute('aria-pressed') !== null && !b.disabled && !thinkingInertNoted;
    return { present: true, usable, on: b.getAttribute('aria-pressed') === 'true' };
  }

  async function setThinking(want) {
    const b = thinkingPill();
    if (!b) return null;
    const read = () => b.getAttribute('aria-pressed') === 'true';
    if (read() === want) return want;
    b.click();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (read() === want) return want;
    }

    thinkingInertNoted = true;
    return read();
  }

  let thinkingButtonMissingNoted = false;

  async function submitPrompt(text, files, opts) {

    const box = await waitFor('入力欄', findComposer, 20000);
    box.focus();

    if (opts && typeof opts.thinking === 'boolean') {
      const got = await setThinking(opts.thinking);
      if (got === null) {
        if (!thinkingButtonMissingNoted) {
          thinkingButtonMissingNoted = true;
          send({ type: 'note', text: '「思考」の札が見つからないので、そのまま送ります' });
        }
      } else if (got !== opts.thinking) {
        send({ type: 'note', text: `「思考」を ${opts.thinking ? '入' : '切'} にできませんでした` });
      }
    }

    if (opts && opts.asFile) {
      const before = chipLabels().length;
      const took = pasteAsFile(box, text);
      send({
        type: 'note',
        text: `[tab] 長いので貼り付けてファイルにします（${text.length} 文字 / 受け取り=${took ? 'はい' : 'いいえ'}）`,
      });

      await waitFor(
        'ファイルになるの',
        () => (chipLabels().length > before ? true : null),
        60000,
        '長い文がファイルになりませんでした'
      );

      const cover = opts.body
        ? `${opts.body}\n\n（この作業の決まりは、付けたファイルに入っています。先に読んでから、上の依頼をやってください。**前の作業の続きではありません。**）`
        : '付けたファイルに続きが入っています。読んで、そのまま作業を続けてください。';
      document.execCommand('insertText', false, cover);
      await sleep(300);

      await pressSend('送信ボタン（ファイルの上げ終わり）', 180000, undefined, undefined, cover);
      return { uploaded: [], failed: [], asFile: true, chars: text.length };
    }

    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {

      const range = document.createRange();
      range.selectNodeContents(box);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
    }

    const grace = Math.max(
      STUCK_NO_DELTA_MS + 5000,
      20000 + Math.floor(text.length / 10000) * 20000
    );
    await waitFor(
      '入力欄への取り込み',
      () => {
        const got = box.tagName === 'TEXTAREA' ? box.value : box.textContent || '';

        const need = text.length ? Math.max(1, Math.floor(text.length * 0.9)) : 0;
        return got.length >= need ? true : null;
      },
      grace
    );

    if (findStopButton()) {
      await waitFor(
        '相手が書き終わるの',
        () => {
          if (!findStopButton()) return true;
          if (escapeStuck()) return true;
          return null;
        },
        STILL_WRITING_WAIT_MS,
        '相手がまだ書き終えていません。書き終わってから、もう一度送ってください'
      );
    }

    let upload = null;
    if (files && files.length) {
      upload = await attachFiles(files);
    }

    await sleep(120);

    const noticeNear = () => {
      const seen = noticeTexts();
      return seen.length ? `\n画面に出ている知らせ: ${seen.join(' / ')}` : '';
    };
    const look = () => {
      const b = findSendButton();
      const box = findComposer();
      const got = box ? (box.tagName === 'TEXTAREA' ? box.value : box.textContent || '') : '';
      return (
        `画面の様子: 送信=${b ? (sendable(b) ? '押せる' : '不可') : '無し'} / ` +
        `停止=${findStopButton() ? '在り' : '無し'} / 入力欄=${got.length} 文字 / ` +
        `札=${chipLabels().length} 枚` +
        noticeNear()
      );
    };
    await pressSend(
      '送信ボタン',
      grace,

      () => {

        if (isStuck() && findStopButton()) {
          throw new Error(
            `${STUCK_UI_MARK}: 画面が固まっています（送りを諦める所で気づきました）`
          );
        }
        const b = findSendButton();
        if (!b || sendable(b)) return null;

        const 読み込み中 = document.body?.innerText.includes('Loading');
        return 読み込み中
          ? '画面がまだ読み込み中です（Loading の字が出ています）。**利用枠の話ではありません。**少し待つか、タブを開き直してください'
          : '送信ボタンは在りますが、押せないままです（利用枠や、相手の側の制限のことがあります）';
      },
      look,
      text
    );
    return upload;
  }

  let lastSeenUrl = location.href;

  let lastSeenTurns = -1;
  let lastSeenThinking = '';
  const 吹き出しの数 = () => {
    try {
      return document.querySelectorAll('[data-message-author-role]').length;
    } catch {
      return -1;
    }
  };
  setInterval(() => {
    const turns = 吹き出しの数();
    const 動いた = location.href !== lastSeenUrl;
    const 増えた = turns >= 0 && turns !== lastSeenTurns;

    const thinking = thinkingState();
    const 思考の印 = `${thinking.present}/${thinking.usable}/${thinking.on}`;
    const 思考が動いた = 思考の印 !== lastSeenThinking;
    if (!動いた && !増えた && !思考が動いた) return;
    if (動いた) {

      thinkingButtonMissingNoted = false;
      thinkingInertNoted = false;
    }
    lastSeenUrl = location.href;
    lastSeenTurns = turns;
    lastSeenThinking = 思考の印;
    send({ type: 'url', url: lastSeenUrl, title: document.title, turns, thinking });
  }, 800);

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__from !== ORIGIN_MARK) return;

    if (d.kind === 'delta' || d.kind === 'replace') {
      lastDeltaAt = Date.now();

      sawDeltaThisTurn = true;
    }

    if (d.kind === 'done') {

      lastStreamEndAt = Date.now();

      turnSentAt = 0;
      sawDeltaThisTurn = false;
      if (d.payload && d.payload.complete) lastDoneAt = Date.now();
    }
    send({ type: d.kind, ...d.payload });
  });

  if (pinned || kept) {
    connect();
  } else {
    let 始めた = false;
    const 始める = (p) => {
      if (始めた) return;
      始めた = true;
      if (p >= PORT_FROM && p <= PORT_TO && !SKIP.includes(p)) tryPort = p;
      connect();
    };

    setTimeout(() => 始める(0), 400);
    try {
      chrome.storage.local.get('bridgePort', (v) => 始める(Number((v && v.bridgePort) || 0)));
    } catch {
      始める(0);
    }
  }
})();
