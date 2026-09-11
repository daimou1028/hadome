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
