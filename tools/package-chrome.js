const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'chrome-extension');

const FILES = ['manifest.json', 'background.js', 'content.js', 'injected.js'];

function tabProtocol() {
  const m = /const TAB_PROTOCOL = (\d+);/.exec(fs.readFileSync(path.join(SRC, 'content.js'), 'utf8'));
  if (!m) {
    console.error('手順の合図を読めませんでした（TAB_PROTOCOL）');
    process.exit(1);
  }
  return m[1];
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

const wantMinor = Number(tabProtocol());
const nowMinor = Number(String(manifest.version).split('.')[1] || 0);
if (nowMinor !== wantMinor) {
  console.error(
    `包む前に版を直してください。\n` +
      `  手順の合図: ${wantMinor}\n` +
      `  manifest  : ${manifest.version}（真ん中が ${nowMinor}）\n` +
      `  直す先    : 0.${wantMinor}.0`
  );
  process.exit(1);
}

const 名 = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).name;
const out = path.join(REPO, `${名}-chrome-${manifest.version}.zip`);

const 在る = fs
  .readdirSync(SRC)
  .filter((n) => !n.startsWith('.'))
  .sort();
const 入れる = [...FILES].sort();
if (JSON.stringify(在る) !== JSON.stringify(入れる)) {
  console.error(
    '相方の所の中身と、包む一覧が食い違っています。\n' +
      `  相方の所: ${在る.join(' / ')}\n` +
      `  一覧  : ${入れる.join(' / ')}\n` +
      'tools/package-chrome.js の FILES を直してください。'
  );
  process.exit(1);
}

const tab = /const TAB_PROTOCOL = (\d+);/.exec(fs.readFileSync(path.join(SRC, 'content.js'), 'utf8'));
const here = /const EXPECTED_TAB_PROTOCOL = (\d+);/.exec(
  fs.readFileSync(path.join(REPO, 'src', 'bridge.js'), 'utf8')
);
if (!tab || !here) {
  console.error('手順の合図を読めませんでした（TAB_PROTOCOL / EXPECTED_TAB_PROTOCOL）');
  process.exit(1);
}
if (tab[1] !== here[1]) {
  console.error(`手順の合図が揃っていません（タブ側 ${tab[1]} / こちら ${here[1]}）。包みません。`);
  process.exit(1);
}

try {
  fs.unlinkSync(out);
} catch {

}
execFileSync('zip', ['-q', '-j', out, ...FILES.map((n) => path.join(SRC, n))]);

const size = fs.statSync(out).size;
console.log(`包みました: ${path.basename(out)}（${FILES.length} 件 / ${(size / 1024).toFixed(1)} KB）`);
console.log(`  手順の合図: ${tab[1]}（両側で揃っている）`);
