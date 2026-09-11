const TAIL_FENCE = /```([A-Za-z0-9_-]*(?:\s+[A-Za-z0-9_-]+="[^"]*")*)\s*$/;

function isToolBody(body) {
  return body.includes('tool_use') || body.includes('bridge_tool');
}

function isBareCall(line) {
  const t = line.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return false;
  return t.includes('tool_use') || t.includes('bridge_tool');
}

function isBareJson(line) {
  const t = line.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return false;
  try {
    const o = JSON.parse(t);
    return o !== null && typeof o === 'object';
  } catch {
    return false;
  }
}

function startsBareCall(line) {
  const t = line.trim();
  if (!t.startsWith('{')) return false;
  return t.includes('tool_use') || t.includes('bridge_tool');
}

function balance(text, start) {
  let depth = start;
  let inStr = false;
  let esc = false;
  for (const c of String(text)) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
  }
  return depth;
}

function proseOf(text, streaming) {
  const out = [];
  let open = null;
  let body = null;

  let bare = 0;
  for (const raw of String(text == null ? '' : text).split('\n')) {

    let line = raw;
    let closesHere = false;
    let opensHere = null;

    const tail = TAIL_FENCE.exec(line);
    if (tail && !line.trimStart().startsWith('```')) {
      const after = tail[1].trim();

      if (body !== null) {
        line = line.slice(0, tail.index);
        closesHere = true;
      } else {
        opensHere = '```' + after;
        line = line.slice(0, tail.index);
      }
    }
    if (opensHere !== null) {

      if (line.trim() && !isBareJson(line)) out.push(line);
      open = opensHere;
      body = [];
      continue;
    }
    if (closesHere) {
      body.push(line);
      const joined = body.join('\n');
      if (!isToolBody(joined)) {
        const lang = (/^```(\w*)/.exec(open) || [, ''])[1];
        out.push('```' + lang, ...body, '```');
      }
      open = null;
      body = null;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      if (body === null) {
        open = line.trimStart();
        body = [];
        continue;
      }
      const joined = body.join('\n');
      if (!isToolBody(joined)) {

        const lang = (/^```(\w*)/.exec(open) || [, ''])[1];
        out.push('```' + lang, ...body, '```');
      }
      open = null;
      body = null;
      continue;
    }
    if (body !== null) {
      body.push(line);
      continue;
    }

    if (bare > 0) {
      bare = balance(line, bare);
      continue;
    }
    if (isBareCall(line) || isBareJson(line)) continue;

    if (startsBareCall(line)) {
      const d = balance(line, 0);
      if (d > 0) {
        bare = d;
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

module.exports = { proseOf };
