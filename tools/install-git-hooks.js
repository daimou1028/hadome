#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'tools', 'git-hooks');
const dst = path.join(root, '.git', 'hooks');

if (!fs.existsSync(dst) || !fs.statSync(dst).isDirectory()) {
  process.exit(0);
}
let n = 0;
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name);
  const to = path.join(dst, name);
  const body = fs.readFileSync(from);
  if (fs.existsSync(to) && fs.readFileSync(to).equals(body)) continue;
  fs.writeFileSync(to, body);
  fs.chmodSync(to, 0o755);
  n += 1;
}
console.log(`git hook を ${n} 件 写しました（${path.relative(root, dst)}）`);
