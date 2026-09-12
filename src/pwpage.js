const { chromium } = require('playwright-core');
const http = require('http');

function 頁の数を数える(port) {
  return new Promise((res) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/list', timeout: 4000 },
      (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => {
          try {
            res(JSON.parse(b).filter((x) => x.type === 'page').length);
          } catch {
            res(0);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => res(0));
  });
}

let 繋ぎ = null;

let 対応 = new Map();

async function 繋ぐ(port, 窓を出させる = null) {

  if (窓を出させる) {
    const 頁の数 = await 頁の数を数える(port);
    if (頁の数 === 0) await 窓を出させる(port);
  }
  if (繋ぎ && 繋ぎ.port === port && 繋ぎ.browser.isConnected()) return 繋ぎ.browser;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  繋ぎ = { port, browser };
  対応 = new Map();
  return browser;
}

function 繋がっているか(port) {
  return !!(繋ぎ && 繋ぎ.port === port && 繋ぎ.browser.isConnected());
}

function 手を離す() {
  try {
    if (繋ぎ && 繋ぎ.browser.isConnected()) 繋ぎ.browser.close();
  } catch {

  }
  繋ぎ = null;
  対応 = new Map();
}

async function 対応を作り直す(port) {
  const b = await 繋ぐ(port);
  const 新しい = new Map();
  for (const ctx of b.contexts()) {
    for (const page of ctx.pages()) {
      try {

        const s = await ctx.newCDPSession(page);

        const info = await s.send('Target.getTargetInfo');
        await s.detach().catch(() => {});
        const id = info && info.targetInfo && info.targetInfo.targetId;
        if (id) 新しい.set(id, page);
      } catch {

      }
    }
  }
  対応 = 新しい;
  return 対応;
}

async function 頁(targetId, port) {

  if (!繋がっているか(port)) await 繋ぐ(port);
  const 在る = 対応.get(targetId);
  if (在る && !在る.isClosed()) return 在る;
  const m = await 対応を作り直す(port);
  const p = m.get(targetId);
  return p && !p.isClosed() ? p : null;
}

function 掴む(page, 目印 = {}) {
  const { role = '', name = '', selector = '', text = '', ぼかす = false, 中 = null } = 目印;

  if (中 && typeof 中 === 'object') {
    const 外 = 掴む(page, { role, name, selector, text, ぼかす });
    if (!外) return null;
    return 掴む(外, 中);
  }
  if (role) {

    if (!name) return page.getByRole(String(role));
    return page.getByRole(String(role), { name: String(name), exact: !ぼかす });
  }
  if (selector) return page.locator(String(selector));
  if (text) return page.getByText(String(text), { exact: !ぼかす });
  return null;
}

async function ひとつに絞る(l, page = null, 目印 = null) {
  const n = await l.count();
  if (n === 0) {

    if (page && 目印 && 目印.role && 目印.name) {
      const 頭で = page.getByRole(String(目印.role), {
        name: new RegExp(`^${String(目印.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`),
      });
      const m = await 頭で.count().catch(() => 0);
      if (m === 1) return { ok: true, n: 1, l: 頭で, 名が伸びていた: true };
    }

    let 候補 = [];
    if (page && 目印 && 目印.role) {
      try {
        候補 = (await page.getByRole(String(目印.role)).allInnerTexts())
          .map((x) => x.trim().replace(/\s+/g, ' '))
          .filter(Boolean)
          .slice(0, 20);
      } catch {
        候補 = [];
      }
    }
    return {
      ok: false,
      why: 候補.length
        ? `みつかりません（同じ役目で在るのは: ${候補.join(' / ')}）`
        : 'みつかりません',
      n: 0,
    };
  }
  if (n > 1) return { ok: false, why: `いくつも当たります（${n} 件）`, n };
  return { ok: true, n: 1, l };
}

async function 読む(page, { 画像の上限 = 20, 字数の上限 = 40000, 中 = '' } = {}) {

  const 枠 = 中 ? page.locator(String(中)) : page.locator('body');
  const 採る = async (f) => {
    try {
      return { ok: true, v: await f() };
    } catch (e) {
      return { ok: false, why: String((e && e.message) || e).split('\n')[0] };
    }
  };
  const [写し, 本文, 絵] = await Promise.all([
    採る(() => 枠.ariaSnapshot()),
    採る(() => 枠.innerText()),
    採る(() =>
      page.evaluate(() =>
        [...document.images]
          .map((im) => ({
            src: im.currentSrc || im.src || '',
            alt: (im.alt || '').slice(0, 60),
            w: im.naturalWidth,
            h: im.naturalHeight,
          }))
          .filter((x) => /^https?:/i.test(x.src))
      )
    ),
  ]);
  const 全部の絵 = 絵.ok ? 絵.v : [];

  const 切る = (x) => {
    const t = String(x || '');
    if (t.length <= 字数の上限) return { t, 切った: 0 };
    return { t: t.slice(0, 字数の上限), 切った: t.length - 字数の上限 };
  };
  const 写 = 切る(写し.ok ? 写し.v : '');
  const 本 = 切る(本文.ok ? 本文.v : '');
  return {
    url: page.url(),
    title: (await 採る(() => page.title())).v || '',
    写し: 写.t,
    写しを切った: 写.切った,
    写しが読めない: 写し.ok ? '' : 写し.why,
    text: 本.t,
    本文を切った: 本.切った,
    本文が読めない: 本文.ok ? '' : 本文.why,
    images: 全部の絵.slice(0, 画像の上限),

    imagesTotal: 全部の絵.length,
  };
}

async function 値を入れる(page, 目印, 値) {
  const l = 掴む(page, 目印);
  if (!l) return { ok: false, why: '何を指すのか渡されていません', n: 0 };
  const r = await ひとつに絞る(l, page, 目印);
  if (!r.ok) return r;
  const el = r.l;
  const 駄目 = await 動かせるか(el);
  if (駄目) return { ok: false, why: `値を入れられません: ${駄目}`, n: 1 };
  const 種 = await el.evaluate((e) => ({
    tag: e.tagName,
    type: (e.getAttribute('type') || '').toLowerCase(),
    role: (e.getAttribute('role') || '').toLowerCase(),
  }));
  if (種.tag === 'SELECT') {

    const 並び = await el.evaluate((e) =>
      [...e.options].map((o) => ({ text: (o.text || '').trim(), value: String(o.value) }))
    );
    const 欲しい = String(値).trim();
    const 字で = 並び.filter((o) => o.text === 欲しい);
    const 値で = 並び.filter((o) => o.value === 欲しい);
    const 当 = 字で.length === 1 ? 字で[0] : 値で.length === 1 ? 値で[0] : null;
    if (!当) {
      const なぜ =
        字で.length > 1 || 値で.length > 1
          ? 'その字の選び方が 2 つ 以上 在ります'
          : 'その選び方は在りません';
      return {
        ok: false,
        why: `${なぜ}（選べるのは: ${並び.map((o) => o.text).join(' / ')}）`,
        n: 1,
      };
    }
    await el.selectOption({ value: 当.value }, { timeout: 待ちの上限 });
    const いま = await el.evaluate((e) =>
      e.selectedIndex >= 0 ? (e.options[e.selectedIndex].text || '').trim() : ''
    );
    return { ok: いま === 当.text, value: いま, tag: 'SELECT' };
  }

  if (種.role === 'combobox' || 種.role === 'listbox') {

    const 手形 = await el.elementHandle();
    const 前の字 = String((await el.innerText().catch(() => '')) || '').trim();
    await el.click({ timeout: 待ちの上限 });
    const 欲しい = String(値).trim();
    const 選び = page.getByRole('option', { name: 欲しい, exact: true });
    try {
      await 選び.waitFor({ state: 'visible', timeout: 5000 });
    } catch {

      const 並び = await page
        .getByRole('option')
        .allInnerTexts()
        .catch(() => []);
      return {
        ok: false,
        why: `その選び方は在りません（開いた先に在るのは: ${並び.map((x) => x.trim()).slice(0, 40).join(' / ') || '(何も出ません)'}）`,
        n: 1,
      };
    }
    await 選び.first().click({ timeout: 待ちの上限 });

    let いま = '';
    for (let i = 0; i < 12; i += 1) {

      いま = String(
        (手形 && (await 手形.innerText().catch(() => ''))) ||
          (手形 && (await 手形.getAttribute('aria-label').catch(() => ''))) ||
          ''
      ).trim();
      if (いま && いま !== 前の字) break;

      await new Promise((r) => setTimeout(r, 100));
    }
    if (手形) await 手形.dispose().catch(() => {});
    return { ok: true, value: いま.slice(0, 80), tag: 'COMBOBOX' };
  }
  if (種.type === 'checkbox' || 種.type === 'radio') {

    const 真 = [true, 'true', 1, '1', 'on', 'yes'].includes(値);
    const 偽 = [false, 'false', 0, '0', 'off', 'no'].includes(値);
    if (!真 && !偽) {
      return { ok: false, why: `真偽で渡してください（受け取ったのは ${JSON.stringify(値)}）`, n: 1 };
    }
    if (種.type === 'radio') {
      if (偽) {
        return {
          ok: false,
          why: '丸（radio）は外せません。同じ組の別の物を true にしてください',
          n: 1,
        };
      }
      await el.check({ timeout: 待ちの上限 });
    } else if (真) {
      await el.check({ timeout: 待ちの上限 });
    } else {
      await el.uncheck({ timeout: 待ちの上限 });
    }
    const いま = await el.isChecked();
    return { ok: いま === 真, value: String(いま), tag: 種.type === 'radio' ? 'RADIO' : 'CHECKBOX' };
  }
  await el.fill(String(値), { timeout: 待ちの上限 });
  return { ok: true, value: await el.inputValue().catch(() => String(値)), tag: 種.tag };
}

const 待ちの上限 = 8000;

async function 動かせるか(l) {
  try {
    if (!(await l.isEnabled({ timeout: 2000 }))) return '止まっています（disabled）';
    if (!(await l.isVisible({ timeout: 2000 }))) return '見えていません（hidden）';
  } catch (e) {
    return String((e && e.message) || e).split('\n')[0];
  }
  return '';
}

async function 押す(page, 目印) {
  const l = 掴む(page, 目印);
  if (!l) return { ok: false, why: '何を指すのか渡されていません', n: 0 };
  const r = await ひとつに絞る(l, page, 目印);
  if (!r.ok) return r;
  const tag = await r.l.evaluate((e) => e.tagName);
  if (tag === 'SELECT') {
    return {
      ok: false,
      why: 'これは選ぶ欄です。押しても選ばれません。browser_set で値を入れてください',
      n: 1,
    };
  }
  const 駄目 = await 動かせるか(r.l);
  if (駄目) return { ok: false, why: `押せません: ${駄目}`, n: 1 };
  try {
    await r.l.click({ timeout: 待ちの上限 });
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e).split('\n')[0], n: 1 };
  }
  const 名 = await r.l.innerText().catch(() => '');
  return { ok: true, n: 1, label: String(名).trim().slice(0, 80) };
}

async function 打つ(page, 目印, 字, 鍵) {
  if (目印 && (目印.role ||目印.selector || 目印.text)) {
    const l = 掴む(page, 目印);
    const r = await ひとつに絞る(l, page, 目印);
    if (!r.ok) return r;
    if (字 !== '' && 字 != null) await r.l.fill(String(字));
    if (鍵) await r.l.press(String(鍵));
    const いま = await r.l.inputValue().catch(() => r.l.innerText().catch(() => ''));
    return { ok: true, value: String(いま).slice(0, 200), tag: await r.l.evaluate((e) => e.tagName) };
  }

  if (字 !== '' && 字 != null) await page.keyboard.type(String(字));
  if (鍵) await page.keyboard.press(String(鍵));
  const v = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { value: '', tag: '' };
    return { value: String(el.value != null ? el.value : el.innerText || '').slice(0, 200), tag: el.tagName };
  });
  return { ok: true, value: v.value || '', tag: v.tag || '' };
}

module.exports = { 繋ぐ, 頁, 掴む, ひとつに絞る, 手を離す, 対応を作り直す, 読む, 値を入れる, 押す, 打つ, 繋がっているか };
