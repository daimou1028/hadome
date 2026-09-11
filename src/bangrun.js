const KILL_GRACE_MS = 2000;

const MAX_KEEP = 200000;

function runBang({ command, root, onChunk, shouldStop }) {
  const { spawn } = require('child_process');
  return new Promise((res) => {
    const sh = process.env.SHELL || '/bin/sh';
    let child;
    try {
      child = spawn(sh, ['-c', String(command || '')], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],

        detached: true,

        env: { ...process.env, PYTHONUNBUFFERED: '1', NODE_DISABLE_COLORS: '1' },
      });
    } catch (e) {
      res({ stdout: '', stderr: `走らせられませんでした: ${e.message}`, code: 127 });
      return;
    }
    let out = '';
    let err = '';
    let dropped = 0;
    const take = (which) => (buf) => {
      const piece = buf.toString();

      if (out.length + err.length >= MAX_KEEP) {
        dropped += piece.length;
        return;
      }
      if (which === 'o') out += piece;
      else err += piece;
      if (onChunk) onChunk(piece);
    };
    child.stdout.on('data', take('o'));
    child.stderr.on('data', take('e'));

    let settled = false;
    let killTimer = null;

    let timer = null;

    const signal = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {

        }
      }
    };
    const done = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (killTimer) clearTimeout(killTimer);
      const tail = dropped ? `\n…（ここから先 ${dropped} 文字は溜めるのをやめました）` : '';
      res({ stdout: out + tail, stderr: err, code: Number(code === null ? 130 : code) });
    };
    if (shouldStop) {
      timer = setInterval(() => {
        if (!shouldStop()) return;
        clearInterval(timer);
        timer = null;
        signal('SIGTERM');

        killTimer = setTimeout(() => {
          signal('SIGKILL');

          setTimeout(() => done(130), 300);
        }, KILL_GRACE_MS);
      }, 200);
    }
    child.on('error', (e) => {
      err += `\n${e.message}`;
      done(127);
    });
    child.on('close', done);
  });
}

module.exports = { runBang, MAX_KEEP, KILL_GRACE_MS };
