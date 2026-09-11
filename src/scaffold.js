const path = require('path');

function safeName(name) {
  const n = String(name || '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(n) ? n : '';
}

function plan(kind, ctx = {}) {
  const root = String(ctx.root || '');
  const home = String(ctx.home || '');
  if (kind === 'skill') {
    const n = safeName(ctx.name);
    if (!n) return { error: 'name' };
    return {

      file: path.join(home, '.agents', 'skills', n, 'SKILL.md'),
      body:
        `---\nname: ${n}\ndescription: いつ使うかを 1 行で書く（これで選ばれる）\n---\n\n` +
        `# ${n}\n\n` +
        `## いつ使うか\n\n（どんな頼みの時にこれを読むのか）\n\n` +
        `## 手順\n\n1. \n2. \n\n` +
        `## 確かめ方\n\n（やり終えたことを、どう確かめるか）\n`,
    };
  }
  if (kind === 'rules') {
    if (!root) return { error: 'root' };
    return {
      file: path.join(root, 'AGENTS.md'),
      body:
        `# この作業場の決まり\n\n` +
        `（相手が毎回読みます。**短く、確かめられる形**で書いてください）\n\n` +
        `## やること\n\n- \n\n## やらないこと\n\n- \n`,
    };
  }
  if (kind === 'globalRules') {
    return {
      file: path.join(home, '.agents', 'AGENTS.md'),
      body: `# 全域の決まり\n\n（どの作業場でも読みます）\n\n- \n`,
    };
  }
  if (kind === 'hooks') {
    if (!root) return { error: 'root' };
    return {

      file: path.join(root, '.chatgpt-bridge', 'hooks.json'),
      body:
        JSON.stringify(
          {
            PreToolUse: [
              {
                matcher: 'run_command',
                hooks: [{ type: 'command', command: 'echo 走る前に見る', timeout: 5 }],
              },
            ],
          },
          null,
          2
        ) + '\n',
    };
  }
  return { error: 'kind' };
}

function places(ctx = {}) {
  const root = String(ctx.root || '');
  const home = String(ctx.home || '');
  return [
    { kind: 'rules', file: path.join(root, 'AGENTS.md') },
    { kind: 'globalRules', file: path.join(home, '.agents', 'AGENTS.md') },
    { kind: 'hooks', file: path.join(root, '.chatgpt-bridge', 'hooks.json') },
  ];
}

module.exports = { plan, places, safeName };
