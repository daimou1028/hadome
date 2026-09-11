const { spawnSync, execFileSync } = require('child_process');

const 既定の画面 = process.env.VSCB_SCREEN || '';

function screens() {
  const r = spawnSync(
    'osascript',
    ['-l', 'JavaScript', '-e',
      'ObjC.import("AppKit"); var out=[], ss=$.NSScreen.screens;' +
      'for (var i=0;i<ss.count;i++){var f=ss.objectAtIndex(i).frame;' +
      'out.push({i:i,x:f.origin.x,y:f.origin.y,w:f.size.width,h:f.size.height,' +
      'name:ObjC.unwrap(ss.objectAtIndex(i).localizedName)});} JSON.stringify(out);'],
    { encoding: 'utf8' }
  );
  try {
    return JSON.parse(r.stdout || '[]');
  } catch {
    return [];
  }
}

function pickScreen() {
  const all = screens();
  if (all.length <= 1) return null;
  const v = 既定の画面;
  const byIndex = v && /^\d+$/.test(v) ? all[Number(v)] : null;
  const byName = v
    ? all.find((x) => String(x.name || '').toLowerCase().includes(v.toLowerCase()))
    : null;
  const hit = byIndex || byName;
  if (hit) return hit;

  const 主 = all.find((x) => x.x === 0 && x.y === 0);
  const 外 = all.filter((x) => x !== 主);
  return (外.length ? 外 : all).slice().sort((a, b) => b.w * b.h - a.w * a.h)[0] || null;
}

function mainPidFor(userDir) {
  const r = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, cmd] = m;
    if (!cmd.includes(`--user-data-dir=${userDir}`)) continue;
    if (cmd.includes('Helper')) continue;
    return Number(pid);
  }
  return null;
}

function placePid(pid) {
  const s = pickScreen();
  if (!s || !pid) return '';
  const all = screens();
  const 主 = all.find((x) => x.x === 0 && x.y === 0) || all[0];
  if (!主) return '';
  const w = Math.min(1440, Math.round(s.w * 0.9));
  const h = Math.min(900, Math.round(s.h * 0.9));
  const 上端 = 主.h - (s.y + s.h);
  const x = Math.round(s.x + (s.w - w) / 2);
  const y = Math.round(上端 + (s.h - h) / 2);
  const ax = (body) =>
    spawnSync('osascript', ['-e',
      `tell application "System Events" to tell (first application process whose unix id is ${pid}) to ${body}`],
      { encoding: 'utf8' });
  ax(`set position of window 1 to {${x}, ${y}}`);
  ax(`set size of window 1 to {${w}, ${h}}`);

  const 実 = String((ax('get {position, size} of window 1').stdout || '')).trim();
  const [rx, ry] = 実.split(',').map((n) => Number(String(n).trim()));
  const 中 = rx >= s.x && rx < s.x + s.w && ry >= 上端 && ry < 上端 + s.h;
  return 中
    ? `窓を出す画面: ${s.name}（${実}）`
    : `**窓を動かせませんでした**（いま ${実}。輔助使用の許可を確かめること）`;
}

async function placeByUserDataDir(userDir, { 待つ = 20000 } = {}) {
  const 締め = Date.now() + 待つ;

  while (Date.now() < 締め) {
    const pid = mainPidFor(userDir);
    if (pid) {
      const r = placePid(pid);
      if (r) return r;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return '';
}

function frontApp() {
  try {
    return execFileSync('osascript', ['-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function restoreFront(name) {
  if (!name) return;
  try {
    execFileSync('osascript', ['-e', `tell application "${name}" to activate`]);
  } catch {

  }
}

module.exports = { screens, pickScreen, mainPidFor, placePid, placeByUserDataDir, frontApp, restoreFront };
