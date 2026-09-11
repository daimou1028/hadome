const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const IO = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

const GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_TEMPLATE_DIR',
];

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (GIT_VARS.includes(k)) continue;
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function dirFor(root) {
  const abs = path.resolve(root);

  const key = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.chatgpt-bridge', 'checkpoints', `${path.basename(abs)}-${key}`);
}

function git(root, args) {
  const dir = dirFor(root);
  return execFileSync(
    'git',
    ['--git-dir', path.join(dir, '.git'), '--work-tree', path.resolve(root), ...args],
    { ...IO, env: cleanEnv() }
  );
}

const EXCLUDE = [
  '.git/',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'dist/',
  'build/',
  '.next/',
  'target/',
  '.DS_Store',
];

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureRepo(root) {
  const dir = dirFor(root);
  const dotGit = path.join(dir, '.git');
  const abs = path.resolve(root);

  if (exists(dotGit)) {

    const worktree = git(root, ['config', 'core.worktree']).trim();
    if (path.resolve(worktree) !== abs) {
      throw new Error(`控えの行き先が違います（${worktree} ≠ ${abs}）`);
    }
    return dir;
  }

  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--template=', dir], { ...IO, env: cleanEnv() });

  git(root, ['config', 'core.worktree', abs]);

  git(root, ['config', 'commit.gpgSign', 'false']);
  git(root, ['config', 'user.name', 'chatgpt-bridge']);
  git(root, ['config', 'user.email', 'bridge@localhost']);
  fs.mkdirSync(path.join(dotGit, 'info'), { recursive: true });
  fs.writeFileSync(path.join(dotGit, 'info', 'exclude'), EXCLUDE.join('\n') + '\n');

  git(root, ['add', '-A', '--ignore-errors']);
  git(root, ['commit', '--allow-empty', '-m', 'はじめの状態']);
  return dir;
}

function save(root, label) {
  ensureRepo(root);
  git(root, ['add', '-A', '--ignore-errors']);

  const staged = git(root, ['status', '--porcelain']).trim();
  if (staged) git(root, ['commit', '-m', `[bridge] ${label}`]);
  return head(root);
}

function head(root) {
  try {
    return git(root, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

function restore(root, sha) {
  ensureRepo(root);

  git(root, ['clean', '-f', '-d']);
  git(root, ['reset', '--hard', sha]);
}

function changedSince(root, sha) {
  if (!sha) return false;
  try {
    ensureRepo(root);
    git(root, ['add', '-A', '--ignore-errors']);

    return git(root, ['diff', '--stat', sha]).trim().length > 0;
  } catch {

    return true;
  }
}

function has(root, sha) {
  try {
    const t = git(root, ['cat-file', '-t', sha]).trim();
    return t === 'commit';
  } catch {
    return false;
  }
}

module.exports = { dirFor, ensureRepo, save, head, restore, has, changedSince, EXCLUDE };
