const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(REPO, 'package.json');
const PACKAGE_LOCK = path.join(REPO, 'package-lock.json');
const FORMAL_VERSION = '0.1.10.2';
const VSIX_VERSION = '0.1.10-2';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function findVsix() {
  return fs
    .readdirSync(REPO)
    .filter((name) => name.endsWith('.vsix'))
    .map((name) => path.join(REPO, name));
}

const originalPackage = readJson(PACKAGE_JSON);
const originalLock = fs.existsSync(PACKAGE_LOCK) ? readJson(PACKAGE_LOCK) : null;
const originalVsix = findVsix();

if (originalPackage.version !== FORMAL_VERSION) {
  console.error(`正式版本不符：預期 ${FORMAL_VERSION}，實際 ${originalPackage.version}`);
  process.exit(1);
}

let producedVsix;
try {
  const buildPackage = { ...originalPackage, version: VSIX_VERSION };
  writeJson(PACKAGE_JSON, buildPackage);

  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: REPO,
    stdio: 'inherit',
  });

  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
    'vsce',
    'package',
    '--allow-missing-repository',
    '--skip-license',
    '--no-rewrite-relative-links',
  ], {
    cwd: REPO,
    stdio: 'inherit',
  });

  const afterVsix = findVsix();
  producedVsix = afterVsix.find((file) => !originalVsix.includes(file));
  if (!producedVsix) {
    throw new Error('找不到新產生的 VSIX 檔案。');
  }

  const formalName = `${originalPackage.name}-${FORMAL_VERSION}.vsix`;
  const formalPath = path.join(REPO, formalName);
  if (formalPath !== producedVsix) {
    try {
      fs.unlinkSync(formalPath);
    } catch {
      // 目標檔案不存在時不需處理。
    }
    fs.renameSync(producedVsix, formalPath);
    producedVsix = formalPath;
  }

  console.log(`VSIX 已建立：${path.basename(producedVsix)}`);
  console.log(`VSIX 內部版本：${VSIX_VERSION}`);
  console.log(`正式專案版本：${FORMAL_VERSION}`);
} finally {
  writeJson(PACKAGE_JSON, originalPackage);
  if (originalLock) {
    writeJson(PACKAGE_LOCK, originalLock);
  }
}
