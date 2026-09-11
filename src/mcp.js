const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'mcp__';
function fullName(server, tool) {
  return `${PREFIX}${server}__${tool}`;
}
function isMcpName(name) {
  return String(name || '').startsWith(PREFIX);
}

function addTool(tools, server, t) {
  const 名 = fullName(server, t.name);
  if (tools.some((x) => x.name === 名)) return false;
  tools.push({
    server,
    name: 名,
    bare: t.name,
    description: String(t.description || ''),
    inputSchema: t.inputSchema || null,
  });
  return true;
}

function loadServers(explicit) {
  if (explicit && typeof explicit === 'object' && Object.keys(explicit).length) return explicit;
  const f = path.join(os.homedir(), '.claude.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (j && j.mcpServers) || {};
  } catch {
    return {};
  }
}

function kindOf(s) {
  if (s && typeof s.command === 'string' && s.command) return 'stdio';
  if (s && typeof s.url === 'string' && s.url) return s.type === 'sse' ? 'sse' : 'http';
  return null;
}

async function connectAll(servers, { log = () => {}, timeoutMs = 15000 } = {}) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const clients = new Map();
  const tools = [];
  const resources = [];
  const failed = [];

  const skipped = [];

  const collided = [];

  for (const [name, conf] of Object.entries(servers || {})) {
    if (conf && conf.disabled === true) {
      skipped.push(name);
      log(`[mcp] ${name}: 設定で切ってあります（disabled: true）。起こしません`);
      continue;
    }
    const kind = kindOf(conf);
    if (!kind) {
      failed.push({ name, why: 'command も url も無い設定です' });
      continue;
    }

    let transport = null;
    let client = null;
    try {
      if (kind === 'stdio') {
        const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
        transport = new StdioClientTransport({
          command: conf.command,
          args: conf.args || [],
          env: { ...process.env, ...(conf.env || {}) },
        });
      } else if (kind === 'sse') {
        const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
        transport = new SSEClientTransport(new URL(conf.url));
      } else {
        const {
          StreamableHTTPClientTransport,
        } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        transport = new StreamableHTTPClientTransport(new URL(conf.url));
      }
      client = new Client({ name: 'chatgpt-bridge', version: '0.1.0' }, { capabilities: {} });

      await withTimeout(client.connect(transport), timeoutMs, `${name} へつなげません`);
      const list = await withTimeout(client.listTools(), timeoutMs, `${name} の道具を取れません`);
      clients.set(name, client);
      for (const t of list.tools || []) {

        const 載った = addTool(tools, name, t);
        if (!載った) {
          collided.push(fullName(name, t.name));
          log(`[mcp] ${name}: ${t.name} は名前が衝突するので載せません（${fullName(name, t.name)}）`);
        }
      }

      let 資源 = [];
      try {
        const rl = await withTimeout(client.listResources(), timeoutMs, `${name} の資源を取れません`);
        資源 = rl.resources || [];
      } catch {

      }
      for (const r of 資源) {
        resources.push({
          server: name,
          uri: String(r.uri || ''),
          name: String(r.name || ''),
          description: String(r.description || ''),
          mimeType: String(r.mimeType || ''),
        });
      }
      log(`[mcp] ${name}: 道具 ${(list.tools || []).length} 件` + (資源.length ? ` / 資源 ${資源.length} 件` : ''));
    } catch (e) {
      const why = String((e && e.message) || e);
      failed.push({ name, why });
      log(`[mcp] ${name}: つながりません（${why}）`);

      for (const shut of [client, transport]) {
        try {
          if (shut && typeof shut.close === 'function') await shut.close();
        } catch {

        }
      }
    }
  }
  return { clients, tools, resources, failed, skipped, collided };
}

function withTimeout(p, ms, why) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${why}（${ms}ms 待ちました）`)), ms)),
  ]);
}

function searchTools(tools, query, { limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (q.toLowerCase().startsWith('select:')) {
    const want = q
      .slice(7)
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);

    return tools
      .filter((t) => want.includes(t.name.toLowerCase()) || want.includes(t.bare.toLowerCase()))
      .slice(0, limit);
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return tools
    .map((t) => {
      const hay = (t.name + ' ' + t.description).toLowerCase();
      return { t, n: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((x) => x.t);
}

async function callTool(clients, tools, which, args, { timeoutMs = 120000 } = {}) {
  let t = which && typeof which === 'object' ? which : null;
  const name = t ? t.name : which;
  if (!t) {
    const 当たり = tools.filter((x) => x.name === name);
    if (当たり.length > 1) {
      throw new Error(`同じ名前のツールが ${当たり.length} 件 あります: ${name}`);
    }
    t = 当たり[0];
  }
  if (!t) throw new Error(`そんなツールはありません: ${name}`);
  const client = clients.get(t.server);
  if (!client) throw new Error(`${t.server} につながっていません`);
  const r = await withTimeout(
    client.callTool({ name: t.bare, arguments: args || {} }),
    timeoutMs,
    `${name} が返ってきません`
  );

  const parts = [];
  for (const c of r.content || []) {
    if (c.type === 'text') parts.push(String(c.text || ''));
    else parts.push(`（${c.type} は文字にできません）`);
  }
  return { text: parts.join('\n'), isError: !!r.isError };
}

async function readResource(clients, server, uri, { timeoutMs = 120000 } = {}) {
  const client = clients.get(server);
  if (!client) throw new Error(`そのサーバはつながっていません: ${server}`);
  const r = await withTimeout(
    client.readResource({ uri }),
    timeoutMs,
    `${server} の ${uri} を読めません`
  );
  const 中身 = (r && r.contents) || [];
  const 字 = 中身
    .map((c) => (typeof c.text === 'string' ? c.text : c.blob ? `（中身は文字ではありません: ${c.mimeType || '種類不明'}）` : ''))
    .filter(Boolean)
    .join('\n');
  return 字 || '（中身がありません）';
}

module.exports = {
  PREFIX,
  fullName,
  isMcpName,
  addTool,
  loadServers,
  kindOf,
  connectAll,
  searchTools,
  callTool,
  readResource,
};
