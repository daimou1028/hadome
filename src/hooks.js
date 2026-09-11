const { spawn } = require('child_process');

const EVENTS = ['PreToolUse', 'PostToolUse'];

const DEFAULT_TIMEOUT_MS = 60000;

function pickHooks(config, event, toolName) {
  const groups = (config && config[event]) || [];
  const out = [];
  for (const g of groups) {
    const m = g && g.matcher;
    if (m) {
      let re;
      try {
        re = new RegExp('^(?:' + m + ')$');
      } catch {

        continue;
      }
      if (!re.test(String(toolName || ''))) continue;
    }
    for (const h of (g && g.hooks) || []) {
      if (h && h.type === 'command' && h.command) out.push(h);
    }
  }
  return out;
}

function readDecision(code, stdout, stderr) {
  if (code === 2) {
    return { decision: 'deny', why: String(stderr || stdout || '').trim() || '検査が止めました' };
  }
  const text = String(stdout || '').trim();
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const p = (j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision) || j.decision;
      if (p === 'deny' || p === 'block') {
        return { decision: 'deny', why: j.stopReason || j.reason || '検査が止めました' };
      }
      if (p === 'allow') return { decision: 'allow', why: '' };
      if (p === 'ask') return { decision: 'ask', why: j.reason || '' };
    } catch {

    }
  }
  return { decision: 'pass', why: text };
}

function runHook(hook, payload, { cwd }) {
  return new Promise((res) => {
    let child;
    try {
      child = spawn(process.env.SHELL || '/bin/sh', ['-c', String(hook.command)], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (e) {
      res({ decision: 'pass', why: `検査を走らせられませんでした: ${e.message}` });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err += b.toString()));

    const ms = Number(hook.timeout) > 0 ? Number(hook.timeout) * 1000 : DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {

      }
    }, ms);
    child.on('error', (e) => {
      clearTimeout(timer);
      res({ decision: 'pass', why: `検査を走らせられませんでした: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {

        res({
          decision: 'pass',
          why: `検査が ${Math.round(ms / 1000)} 秒で終わらなかったので、止めて先へ進みました: ${String(hook.command).slice(0, 60)}`,
        });
        return;
      }
      res(readDecision(code, out, err));
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {

    }
  });
}

async function runHooks(config, event, { toolName, toolInput, cwd, sessionId }) {
  const list = pickHooks(config, event, toolName);
  if (!list.length) return { decision: 'pass', why: '', ran: 0 };
  const payload = {
    hook_event_name: event,
    tool_name: toolName,
    tool_input: toolInput,
    session_id: sessionId || '',
    cwd: cwd || '',
  };
  const notes = [];
  for (const h of list) {
    const r = await runHook(h, payload, { cwd });
    if (r.why) notes.push(r.why);
    if (r.decision === 'deny' || r.decision === 'ask') {
      return { decision: r.decision, why: notes.join('\n'), ran: list.length };
    }
  }
  return { decision: 'pass', why: notes.join('\n'), ran: list.length };
}

module.exports = { EVENTS, pickHooks, readDecision, runHooks, DEFAULT_TIMEOUT_MS };
