#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const 根 = path.join(__dirname, '..');
const 出し先 = process.argv[2];
if (!出し先) {
  console.error('使い方: node tools/make-notice.js <出し先>');
  process.exit(1);
}

function 束ねた物() {
  const esbuild = require(path.join(根, 'node_modules', 'esbuild'));
  const opts = require(path.join(__dirname, 'build-webview.js')).opts;
  const r = esbuild.buildSync({
    ...opts,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const 名 = new Set();
  for (const 道 of Object.keys(r.metafile.inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(道);
    if (m) 名.add(m[1]);
  }
  return 名;
}

function 配る依存() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
    cwd: 根,
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');
  const j = JSON.parse(out);
  const 名 = new Set();
  const 歩く = (d) => {
    for (const [n, v] of Object.entries(d || {})) {
      名.add(n);
      歩く(v.dependencies);
    }
  };
  歩く(j.dependencies);
  return 名;
}

const 手で持ってきた = [
  {
    檔: 'docs/mermaid.min.js',
    pkg: 'mermaid',
    なぜ: '`docs/` の HTML が、網に繋がらなくても図を描ける様にする為',

    中に在る: ['dompurify'],
  },
];

function 授権(名) {
  const d = path.join(根, 'node_modules', 名);
  if (!fs.existsSync(d)) return null;
  const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
  const 檔 = fs.readdirSync(d).filter((f) => /^licen[sc]e/i.test(f));
  const 全文 = 檔.map((f) => ({
    名: f,
    中身: fs.readFileSync(path.join(d, f), 'utf8'),
  }));
  return {
    名,
    版: pkg.version,
    授権: typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license),
    家: (pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '').replace(/^git\+|\.git$/g, ''),
    全文,
  };
}

function 走る() {
  const 全部 = new Set([...束ねた物(), ...配る依存()]);

  const 実際に在る = 手で持ってきた.filter((h) => fs.existsSync(path.join(出し先, h.檔)));
  for (const h of 実際に在る) {
    全部.add(h.pkg);
    for (const n of h.中に在る) 全部.add(n);
  }
  if (実際に在る.length !== 手で持ってきた.length) {
    const 外した = 手で持ってきた.filter((h) => !実際に在る.includes(h)).map((h) => h.檔);
    console.log(`手で持ってきた物のうち、出し先に無いので載せなかった: ${外した.join(' / ')}`);
  }
  const 並び = [...全部].sort();
  const 拾った = [];
  const 授権の檔なし = [];
  const 入っていない = [];
  for (const n of 並び) {
    const a = 授権(n);

    if (!a) { 入っていない.push(n); continue; }
    if (!a.全文.length) 授権の檔なし.push(`${n}（授権の檔が同梱されていない）`);
    拾った.push(a);
  }
  if (入っていない.length) {
    console.log(`入れていないので載せなかった: ${入っていない.join(' / ')}`);
  }

  const 授権先 = path.join(出し先, 'licenses');
  fs.rmSync(授権先, { recursive: true, force: true });
  fs.mkdirSync(授権先, { recursive: true });
  for (const a of 拾った) {
    if (!a.全文.length) continue;
    const 名 = a.名.replace('/', '__');
    const 本文 = a.全文
      .map((f) => (a.全文.length > 1 ? `===== ${f.名} =====\n${f.中身}` : f.中身))
      .join('\n');
    fs.writeFileSync(path.join(授権先, `${名}.txt`), 本文);
  }

  const 行 = 拾った.map((a) => {
    const 道 = a.全文.length ? `[\`licenses/${a.名.replace('/', '__')}.txt\`](licenses/${a.名.replace('/', '__')}.txt)` : '—';
    return `| \`${a.名}\` | ${a.版} | ${a.授権} | ${道} |`;
  });

  const 文 = `# Third-party notices

This file is generated — do not edit it by hand. It is rebuilt from what is
actually shipped, not from what \`package.json\` declares:

- what \`webview/dist/panel.js\` bundles (esbuild metafile)
- what the packaged extension carries in \`node_modules\` (\`npm ls --omit=dev --all\`)
- files vendored directly into the tree (listed below)

Everything else in this repository is part of the project itself and is covered
by [\`LICENSE\`](LICENSE) (AGPL-3.0-or-later).

${実際に在る.length ? `## Vendored files

| File | Package | Why it is vendored |
|---|---|---|
${実際に在る.map((h) => `| \`${h.檔}\` | \`${h.pkg}\` | ${h.なぜ.replace(/\*\*/g, '')} |`).join('\n')}

` : ''}## Packages

| Package | Version | License | Full text |
|---|---|---|---|
${行.join('\n')}
${授権の檔なし.length ? `\n## Needs attention\n\n${授権の檔なし.map((s) => `- ${s}`).join('\n')}\n` : ''}`;

  fs.writeFileSync(path.join(出し先, 'NOTICE.md'), 文);
  console.log(`NOTICE.md: ${拾った.length} 件（授権の全文 ${fs.readdirSync(授権先).length} 枚）`);
  if (授権の檔なし.length) {
    console.error(`★ 授権の全文を取れなかった物が ${授権の檔なし.length} 件 在ります:`);
    for (const s of 授権の檔なし) console.error('  ' + s);
    process.exit(1);
  }
}

走る();
