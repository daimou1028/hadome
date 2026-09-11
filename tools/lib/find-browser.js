const fs = require('fs');
const os = require('os');
const path = require('path');

const 候補 = [
  {
    名: 'Google Chrome',
    実行檔: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    設定: 'Library/Application Support/Google/Chrome',
  },
  {
    名: 'Google Chrome Dev',
    実行檔: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    設定: 'Library/Application Support/Google/Chrome Dev',
  },
  {
    名: 'Google Chrome Beta',
    実行檔: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    設定: 'Library/Application Support/Google/Chrome Beta',
  },
  {
    名: 'Google Chrome Canary',
    実行檔: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    設定: 'Library/Application Support/Google/Chrome Canary',
  },
  {
    名: 'Chromium',
    実行檔: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    設定: 'Library/Application Support/Chromium',
  },
  {
    名: 'Microsoft Edge',
    実行檔: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    設定: 'Library/Application Support/Microsoft Edge',
  },
  {
    名: 'Brave Browser',
    実行檔: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    設定: 'Library/Application Support/BraveSoftware/Brave-Browser',
  },
];

function 相方の名前() {
  try {
    const p = path.join(__dirname, '..', '..', 'chrome-extension', 'manifest.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).name || '';
  } catch {
    return '';
  }
}

function 相方が入っているか(設定の道, 名前) {
  if (!名前 || !fs.existsSync(設定の道)) return null;
  let 帳 = [];
  try {
    帳 = fs.readdirSync(設定の道);
  } catch {
    return null;
  }
  for (const 帳名 of 帳) {
    const p = path.join(設定の道, 帳名, 'Secure Preferences');
    if (!fs.existsSync(p)) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    const 表 = (j.extensions && j.extensions.settings) || {};
    for (const [id, v] of Object.entries(表)) {
      if (v.location !== 4) continue;

      const 名 = (v.manifest && v.manifest.name) || '';
      if (名 === 名前) return { 帳: 帳名, id };

      const 置いた = v.path;
      if (!置いた) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(置いた, 'manifest.json'), 'utf8'));
        if (m.name === 名前) return { 帳: 帳名, id, 道: 置いた };
      } catch {

      }
    }
  }
  return null;
}

function 探す({ 明示 = process.env.BRIDGE_BROWSER_PATH || '' } = {}) {
  if (明示) {
    if (!fs.existsSync(明示)) {
      return { 実行檔: 明示, 名: path.basename(明示), なぜ: '明示（ただし在りません）', 在る: false };
    }
    return { 実行檔: 明示, 名: path.basename(明示), なぜ: '明示', 在る: true };
  }
  const 名前 = 相方の名前();
  const 家 = os.homedir();
  const 入っている = 候補.filter((c) => fs.existsSync(c.実行檔));
  for (const c of 入っている) {
    const 当たり = 相方が入っているか(path.join(家, c.設定), 名前);
    if (当たり) {
      return {
        実行檔: c.実行檔,
        名: c.名,
        なぜ: `相方が入っています（${当たり.帳}）`,
        在る: true,
        相方: 当たり,
      };
    }
  }
  if (入っている.length) {
    return {
      実行檔: 入っている[0].実行檔,
      名: 入っている[0].名,
      なぜ: '相方の入っている browser が見つからないので、入っている物の先頭',
      在る: true,
    };
  }
  return null;
}

module.exports = { 探す, 候補, 相方の名前, 相方が入っているか };
