'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function openRunLog({ root: workspace = '' } = {}) {
  const root = process.env.CHATGPT_BRIDGE_RUNS_DIR || path.join(os.homedir(), '.chatgpt-bridge', 'runs');
  const now = new Date();
  const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('') + '-' + [String(now.getHours()).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0'), String(now.getSeconds()).padStart(2, '0')].join('');
  const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const runId = `${stamp}-${suffix}`;
  const file = path.join(root, `${runId}.jsonl`);
  let writable = true;
  let warned = false;

  function record(value) {
    if (!writable) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ run_id: runId, ...value }) + '\n', 'utf8');
    } catch (error) {
      writable = false;
      if (!warned) {
        warned = true;
        try {
          console.error(`[runlog] 記録を書けません: ${error.message}`);
        } catch {

        }
      }
    }
  }

  try {
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(file, '', 'utf8');
  } catch (error) {
    writable = false;
    if (!warned) {
      warned = true;
      try {
        console.error(`[runlog] 記録を開けません: ${error.message}`);
      } catch {

      }
    }
  }

  if (workspace) record({ t: 'start', at: Date.now(), root: String(workspace) });

  return {
    path: file,
    runId,
    tool(rec) {
      record({ t: 'tool', at: Date.now(), ...rec });
    },
    send(rec) {
      record({ t: 'send', at: Date.now(), ...rec });
    },
    result(rec = {}) {
      record({ t: 'result', at: Date.now(), ...rec });
    },
    error(rec = {}) {
      record({ t: 'error', at: Date.now(), ...rec });
    },
    close() {
      writable = false;
    },
  };
}

module.exports = { openRunLog };
