'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const 台帳の道 = process.env.CHATGPT_BRIDGE_RUN_LEDGER
  || path.join(os.homedir(), '.chatgpt-bridge', 'run-ledger.ndjson');

function run_id() {
  return (
    process.env.CHATGPT_BRIDGE_RUN_ID
    || process.env.CLAUDE_JOB_ID
    || `pid-${process.pid}`
  );
}

function 起こした(何を, pid, 命令, 足す) {
  const 行 = {
    何を,
    pid,
    run_id: run_id(),
    起こした刻: new Date().toISOString(),
    起こした者: process.env.CHATGPT_BRIDGE_STARTED_BY || 'chatgpt-web',
    走らせた所: process.cwd(),
    命令: String(命令 || '').slice(0, 400),
    ...(足す || {}),
  };
  try {
    fs.mkdirSync(path.dirname(台帳の道), { recursive: true });
    fs.appendFileSync(台帳の道, JSON.stringify(行) + '\n');
    return { 書けた: true, 行 };
  } catch (e) {
    return { 書けた: false, なぜ: String((e && e.message) || e).slice(0, 120), 行 };
  }
}

function 読む() {
  if (!fs.existsSync(台帳の道)) return { 状態: 'absent', なぜ: `台帳がまだ無い（${台帳の道}）` };
  let 生;
  try {
    生 = fs.readFileSync(台帳の道, 'utf8');
  } catch (e) {
    return { 状態: 'unknown', なぜ: `台帳が読めない: ${String((e && e.message) || e).slice(0, 90)}` };
  }
  const 値 = [];
  const 壊れた = [];
  for (const l of 生.split('\n')) {
    const s = l.trim();
    if (!s) continue;
    try {
      値.push(JSON.parse(s));
    } catch {
      壊れた.push(s.slice(0, 60));
    }
  }
  return { 状態: 'ok', 値, 壊れた };
}

function 誰の(pid, 台帳) {
  const t = 台帳 || 読む();
  if (t.状態 === 'unknown') return { 状態: 'unknown', なぜ: t.なぜ };
  const 当たり = (t.値 || []).filter((x) => x.pid === pid);
  if (!当たり.length) {
    return {
      状態: 'absent',
      なぜ: t.状態 === 'absent' ? t.なぜ : '台帳に起動の記録が無い（所有者不明）',
    };
  }
  return { 状態: 'ok', 値: 当たり[当たり.length - 1] };
}

function 掃く() {
  const t = 読む();
  if (t.状態 !== 'ok') return t;
  const 生きている = t.値.filter((x) => {
    try {
      process.kill(x.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  try {
    fs.writeFileSync(
      台帳の道,
      生きている.map((x) => JSON.stringify(x)).join('\n') + (生きている.length ? '\n' : '')
    );
  } catch (e) {
    return { 状態: 'unknown', なぜ: `台帳を書き直せない: ${String((e && e.message) || e).slice(0, 90)}` };
  }
  return { 状態: 'ok', 値: 生きている, 落とした: t.値.length - 生きている.length };
}

module.exports = { 台帳の道, run_id, 起こした, 読む, 誰の, 掃く };
