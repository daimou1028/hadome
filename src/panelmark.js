const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const PARTS = [
  path.join(ROOT, 'webview', 'panel.html'),
  path.join(ROOT, 'webview', 'dist', 'panel.js'),
];

function panelMark() {
  const joined = PARTS.map((p) => fs.readFileSync(p, 'utf8')).join('');
  return crypto.createHash('sha1').update(joined).digest('hex').slice(0, 12);
}

module.exports = { panelMark, PARTS };
