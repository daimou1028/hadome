const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCK_DIR = process.env.CHATGPT_BRIDGE_PORTS_DIR
  ? path.resolve(process.env.CHATGPT_BRIDGE_PORTS_DIR)
  : path.join(os.homedir(), '.chatgpt-bridge', 'ports');

const PORT_FROM = 8765;
const PORT_TO = PORT_FROM;

const RESERVED = new Set([8767, 8768, 8769]);

function lockPath(port) {
  return path.join(LOCK_DIR, `${port}.json`);
}

function holderOf(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pcn'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = /^p(\d+)$/m.exec(out);
    const name = /^c(.+)$/m.exec(out);
    if (!pid) return null;
    return { pid: Number(pid[1]), name: name ? name[1] : '' };
  } catch {

    return null;
  }
}

function readLock(port) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(lockPath(port), 'utf8'));
  } catch {
    return null;
  }

  try {
    process.kill(info.pid, 0);
  } catch {
    try {
      fs.unlinkSync(lockPath(port));
    } catch {

    }
    return null;
  }
  return info;
}

function writeLock(port, workspace, hasTab = false) {
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(
      lockPath(port),
      JSON.stringify({
        port,
        pid: process.pid,
        workspace: String(workspace || ''),
        hasTab: !!hasTab,
        at: Date.now(),
      })
    );
    return true;
  } catch {

    return false;
  }
}

function markTab(port, hasTab) {
  const info = readLock(port);
  if (!info || info.pid !== process.pid) return false;
  try {
    fs.writeFileSync(lockPath(port), JSON.stringify({ ...info, hasTab: !!hasTab, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

function clearLock(port) {
  const info = readLock(port);
  if (info && info.pid !== process.pid) return false;
  try {
    fs.unlinkSync(lockPath(port));
    return true;
  } catch {
    return false;
  }
}

function listLocks() {
  let names;
  try {
    names = fs.readdirSync(LOCK_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (!m) continue;
    const info = readLock(Number(m[1]));
    if (info) out.push(info);
  }
  return out.sort((a, b) => a.port - b.port);
}

const CLAIM_FILE = 'claim.json';

const CLAIM_TTL_MS = 45000;

function claimPath() {
  return path.join(LOCK_DIR, CLAIM_FILE);
}

function writeClaim(port, workspace) {
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(
      claimPath(),
      JSON.stringify({ port, pid: process.pid, workspace: String(workspace || ''), at: Date.now() })
    );
    return true;
  } catch {

    return false;
  }
}

function readClaim() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(claimPath(), 'utf8'));
  } catch {
    return null;
  }
  const stale = !info || !info.at || Date.now() - info.at > CLAIM_TTL_MS;
  let dead = false;
  try {
    process.kill(info.pid, 0);
  } catch {
    dead = true;
  }
  if (stale || dead) {

    try {
      fs.unlinkSync(claimPath());
    } catch {

    }
    return null;
  }
  return info;
}

function clearClaim(which = {}) {
  const info = readClaim();
  if (!info) return false;
  const mine = which.pid !== undefined && info.pid === which.pid;
  const thatPort = which.port !== undefined && info.port === which.port;
  if (!mine && !thatPort) return false;
  try {
    fs.unlinkSync(claimPath());
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  markTab,
  LOCK_DIR,
  PORT_FROM,
  PORT_TO,
  RESERVED,
  lockPath,
  holderOf,
  readLock,
  writeLock,
  clearLock,
  listLocks,
  CLAIM_TTL_MS,
  claimPath,
  writeClaim,
  readClaim,
  clearClaim,
};
