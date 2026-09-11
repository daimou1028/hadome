const LCS_LIMIT = 1000000;

function alignLines(a, b) {
  const n = a.length;
  const m = b.length;

  if (n * m > LCS_LIMIT) {
    return [
      ...a.map((line) => ({ type: 'old', line })),
      ...b.map((line) => ({ type: 'new', line })),
    ];
  }

  const dp = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {

      ops.push({ type: 'old', line: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'new', line: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'old', line: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'new', line: b[j] });
    j += 1;
  }
  return ops;
}

function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 && midB.length === 0) return [];

  const ops = alignLines(midA, midB);

  const blocks = [];
  let ia = head;
  let ib = head;
  let cur = null;
  for (const op of ops) {
    if (op.type === 'same') {
      if (cur) {
        blocks.push(cur);
        cur = null;
      }
      ia += 1;
      ib += 1;
      continue;
    }
    if (!cur) cur = { originLine: ia, removed: [], afterLine: ib, added: [] };
    if (op.type === 'old') {
      cur.removed.push(op.line);
      ia += 1;
    } else {
      cur.added.push(op.line);
      ib += 1;
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function acceptBlock(beforeText, block) {
  const lines = beforeText.split('\n');
  lines.splice(block.originLine, block.removed.length, ...block.added);
  return lines.join('\n');
}

function rejectBlock(afterText, block) {
  const lines = afterText.split('\n');
  lines.splice(block.afterLine, block.added.length, ...block.removed);
  return lines.join('\n');
}

module.exports = { diffLines, acceptBlock, rejectBlock, LCS_LIMIT };
