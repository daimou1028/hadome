(() => {

  try {
    if (new URLSearchParams(location.search).get('bridge_sub') === '1') {
      sessionStorage.setItem('chatgpt-bridge-sub', '1');
    }
    if (sessionStorage.getItem('chatgpt-bridge-sub') === '1') {
      Object.defineProperty(Document.prototype, 'visibilityState', {
        configurable: true,
        get() { return 'visible'; },
      });
      Object.defineProperty(Document.prototype, 'hidden', {
        configurable: true,
        get() { return false; },
      });
      document.addEventListener('visibilitychange', (event) => {
        event.stopImmediatePropagation();
      }, true);
    }
  } catch {

  }

  const ORIGIN_MARK = 'chatgpt-bridge';
  const TARGET_PATH = /\/backend-api\/(f\/)?conversation(\?|$)/;

  const RAW_SAMPLE_LIMIT = 40;

  const CUT_SAMPLE_EACH = 6;
  const CUT_SAMPLE_CHARS = 300;

  const CUT_SECRET = /eyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+){0,2}/g;

  const origFetch = window.fetch;
  let modelCatalogPromise = null;
  let pendingModelOverrideTask = null;

  function post(kind, payload) {
    window.postMessage({ __from: ORIGIN_MARK, kind, payload }, window.location.origin);
  }

  function modelEntry(models, slug) {
    return models.find((entry) => entry && entry.slug === slug) || null;
  }

  function thinkingEfforts(entry) {
    if (!entry || !Array.isArray(entry.thinking_efforts)) return [];
    return entry.thinking_efforts
      .map((item) => item && item.thinking_effort)
      .filter((value) => typeof value === 'string');
  }

  function refusalReason(status, body) {
    const s = Number(status) || 0;
    const t = String(body || '');
    if (/unusual activity/i.test(t)) return 'unusualActivity';
    if (s === 429 && /limit of messages|reached our limit|usage[_ ]limit/i.test(t)) return 'usageLimit';
    if (s === 429) return 'rateLimit';
    if (s >= 500) return 'unavailable';
    return '';
  }

  function modelNote(reason) {
    post('note', { text: '[model] 替えません: ' + reason });
  }

  async function loadAccessToken() {
    const sessionRes = await origFetch.call(window, '/api/auth/session', { credentials: 'include' });
    if (!sessionRes.ok) throw new Error('session を読めません（' + sessionRes.status + '）');
    const session = await sessionRes.json();
    const accessToken = session && session.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('accessToken が在りません');
    return accessToken;
  }

  async function loadModelCatalog() {
    if (!modelCatalogPromise) {
      modelCatalogPromise = (async () => {
        const accessToken = await loadAccessToken();
        const modelsRes = await origFetch.call(window, '/backend-api/models', {
          credentials: 'include',
          headers: { Authorization: 'Bearer ' + accessToken },
        });
        if (!modelsRes.ok) throw new Error('models を読めません（' + modelsRes.status + '）');
        const data = await modelsRes.json();
        if (!data || !Array.isArray(data.models)) throw new Error('models[] が在りません');
        return data;
      })();
    }
    return modelCatalogPromise;
  }

  async function listModels(data) {
    const id = data && data.id;
    try {
      const catalog = await loadModelCatalog();
      const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
      const categoryByModel = new Map(categories
        .filter((item) => item && typeof item.default_model === 'string')
        .map((item) => [item.default_model, item]));
      const models = catalog.models
        .filter((entry) => entry && typeof entry.slug === 'string')
        .map((entry) => {
          const category = categoryByModel.get(entry.slug);
          return {
            slug: entry.slug,
            title: typeof entry.title === 'string' ? entry.title : entry.slug,
            efforts: thinkingEfforts(entry),
            category: category ? {
              name: category.human_category_name,
              short: category.human_category_short_name,
              lane: category.model_lane,
              legacy: !!category.is_soft_deprecated || !!category.subcategory,
            } : null,
          };
        });
      post('modelsListed', { id, ok: true, models });
    } catch (err) {
      post('modelsListed', { id, ok: false, models: [], why: String((err && err.message) || err) });
    }
  }

  async function cleanupConversation(data) {
    const id = data && data.id;
    const action = data && data.action;
    const conversationId = data && data.conversationId;
    const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(conversationId || ''));
    const body = action === 'archive' ? { is_archived: true } : null;
    if (!validId || !body) {
      post('cleaned', { id, ok: false, status: 0, why: !validId ? 'invalid conversationId' : 'unknown action' });
      return;
    }
    try {
      const accessToken = await loadAccessToken();
      const res = await origFetch.call(window, '/backend-api/conversation/' + conversationId, {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + accessToken,
        },
        body: JSON.stringify(body),
      });
      post('cleaned', {
        id,
        ok: !!res.ok,
        status: Number(res.status || 0),
        why: res.ok ? '' : 'PATCH に失敗しました（' + res.status + '）',
      });
    } catch (err) {
      post('cleaned', { id, ok: false, status: 0, why: String((err && err.message) || err) });
    }
  }

  async function prepareModelOverride(data) {
    try {
      const model = typeof data.model === 'string' ? data.model : '';
      const thinkingEffort = typeof data.thinkingEffort === 'string' ? data.thinkingEffort : '';
      const catalog = await loadModelCatalog();
      const models = catalog && Array.isArray(catalog.models) ? catalog.models : null;
      if (!models) {
        modelNote('models[] が在りません');
        return null;
      }
      if (model) {
        const entry = modelEntry(models, model);
        if (!entry) {
          modelNote('モデル ' + model + ' は選べません');
          return null;
        }
        if (thinkingEffort && !thinkingEfforts(entry).includes(thinkingEffort)) {
          modelNote('思考の量 ' + thinkingEffort + ' はモデル ' + model + ' では選べません');
          return null;
        }
      }
      return { model, thinkingEffort, models };
    } catch (err) {
      modelNote(String((err && err.message) || err));
      return null;
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.__to !== 'chatgpt-bridge-page') return;
    if (data.kind === 'modelOverride') {
      pendingModelOverrideTask = prepareModelOverride(data);
      return;
    }
    if (data.kind === 'cleanupConversation') cleanupConversation(data);
    if (data.kind === 'listModels') listModels(data);
  });

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function makeAssembler() {
    const PART_PATH = /^\/message\/content\/parts\/\d+$/;

    const out_status = [];

    const out_images = [];

    const out_limits = [];
    let role = null;
    let contentType = null;
    let recipient = null;
    let currentPath = null;

    let streamComplete = false;

    function usable() {
      return role === 'assistant' && contentType === 'text';
    }

    function toolRunning() {
      return role === 'assistant' && contentType === 'code' && recipient && recipient !== 'all';
    }

    function noteMessage(msg) {
      if (!msg || !msg.author) return null;
      role = msg.author.role || null;
      contentType = (msg.content && msg.content.content_type) || null;
      recipient = msg.recipient || null;
      currentPath = null;
      const parts = msg.content && msg.content.parts;

      if (toolRunning()) {
        out_status.push(String(recipient));
        return null;
      }

      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (!p || p.content_type !== 'image_asset_pointer') continue;
          const id = String(p.asset_pointer || '').replace(/^\w+:\/\//, '');
          if (!id) continue;
          out_images.push({
            id,
            mime: p.mime_type || 'image/png',
            width: p.width || 0,
            height: p.height || 0,
            bytes: p.size_bytes || 0,
          });
        }
      }
      if (!usable()) return null;
      if (!Array.isArray(parts)) return null;
      const t = parts.filter((p) => typeof p === 'string').join('');
      return t || null;
    }

    function applyOp(op, out) {
      if (!op || typeof op.p !== 'string') return;
      if (!PART_PATH.test(op.p)) return;
      currentPath = op.p;
      if (typeof op.v !== 'string') return;

      if (toolRunning()) return;
      if (!usable()) return;
      out.push({ op: op.o === 'replace' ? 'set' : 'append', text: op.v });
    }

    function feed(obj) {
      const out = [];
      if (obj == null) return out;
      if (typeof obj === 'string') return out;
      if (typeof obj.type === 'string') {

        if (obj.type === 'message_stream_complete') streamComplete = true;

        if (Array.isArray(obj.limits_progress) && obj.limits_progress.length) {
          out_limits.push(JSON.stringify(obj.limits_progress));
        }

        const slug = obj.metadata && obj.metadata.model_slug;
        if (slug) out.push({ op: 'model', text: String(slug) });

        const md = obj.metadata;
        if (md) {
          const sw = {};
          if (md.is_autoswitcher_enabled !== undefined) sw.enabled = !!md.is_autoswitcher_enabled;
          if (md.auto_switcher_race_winner != null) sw.winner = String(md.auto_switcher_race_winner);
          if (md.did_auto_switch_to_reasoning !== undefined) sw.toReasoning = !!md.did_auto_switch_to_reasoning;
          if (Object.keys(sw).length) out.push({ op: 'autoswitch', ...sw });
        }
        if (obj.default_model_slug) out.push({ op: 'defaultModel', text: String(obj.default_model_slug) });
        return out;
      }

      const msg = obj.message || (obj.v && obj.v.message);
      if (msg) {
        const full = noteMessage(msg);
        if (full) out.push({ op: 'set', text: full });
        return out;
      }

      if (Array.isArray(obj.v)) {
        for (const op of obj.v) applyOp(op, out);
        return out;
      }

      if (typeof obj.p === 'string') {
        applyOp(obj, out);
        return out;
      }

      if (typeof obj.v === 'string') {
        if (currentPath && PART_PATH.test(currentPath) && usable()) {
          out.push({ op: 'append', text: obj.v });
        }
      }
      return out;
    }

    return {
      feed,
      takeStatus: () => out_status.splice(0, out_status.length),
      takeImages: () => out_images.splice(0, out_images.length),
      takeLimits: () => out_limits.splice(0, out_limits.length),
      isComplete: () => streamComplete,
    };
  }

  const IMAGE_WAIT_MS = 20000;
  const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

  async function grabImage(info) {
    const deadline = Date.now() + IMAGE_WAIT_MS;
    for (;;) {
      const img = Array.from(document.images).find((i) =>
        String(i.currentSrc || i.src || '').includes(info.id)
      );
      if (img && (img.currentSrc || img.src)) {
        const url = img.currentSrc || img.src;
        try {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) return { ...info, error: 'とれません: ' + res.status };
          const blob = await res.blob();
          if (blob.size > IMAGE_MAX_BYTES) {
            return { ...info, error: '大きすぎます（' + blob.size + ' バイト）' };
          }
          const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = () => reject(new Error('読めません'));
            fr.readAsDataURL(blob);
          });
          return { ...info, dataUrl, bytes: blob.size };
        } catch (e) {
          return { ...info, error: String((e && e.message) || e) };
        }
      }
      if (Date.now() > deadline) return { ...info, error: '頁に出てきませんでした' };
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const handoffs = new Map();
  const pendingTopicMessages = [];
  const MAX_PENDING_TOPIC_MESSAGES = 500;

  function handleEvent(ctx, parsed) {
    const { requestId, asm } = ctx;
    const { feed, takeStatus, takeImages, takeLimits } = asm;

    for (const t of takeStatus()) post('busy', { requestId, tool: t });

    for (const l of takeLimits()) post('limits', { requestId, text: l });

    for (const info of takeImages()) {
      grabImage(info).then((r) => post('image', { requestId, ...r }));
    }

    for (const op of feed(parsed)) {
      if (op.op === 'set') {
        ctx.assembled = op.text;
        ctx.lastTextAt = Date.now();
        post('replace', { requestId, text: op.text });
      } else if (op.op === 'model') {

        post('model', { requestId, text: op.text });
      } else if (op.op === 'autoswitch') {

        post('autoswitch', { requestId, ...op });
      } else if (op.op === 'defaultModel') {
        post('defaultModel', { requestId, ...op });
      } else {
        ctx.assembled += op.text;
        ctx.lastTextAt = Date.now();
        post('delta', { requestId, text: op.text });
      }
    }
  }

  function parseEncodedItem(encoded) {
    if (typeof encoded !== 'string') return null;
    const dataLines = encoded.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    const bodies = dataLines.length > 0 ? dataLines.map((line) => line.slice(5).trim()) : [encoded.trim()];
    for (const body of bodies) {
      if (!body || body === '[DONE]') continue;
      try {
        return JSON.parse(body);
      } catch {

      }
    }
    return null;
  }

  function finishTopic(topicId, ctx) {
    if (ctx.wsDone) return;
    ctx.wsDone = true;
    post('done', { requestId: ctx.requestId, text: ctx.assembled, complete: true });
    handoffs.delete(topicId);
    for (let i = pendingTopicMessages.length - 1; i >= 0; i -= 1) {
      if (pendingTopicMessages[i].topicId === topicId) pendingTopicMessages.splice(i, 1);
    }
  }

  function consumeTopicMessage(m, ctx) {
    if (!m || typeof m !== 'object') return;
    const outer = m.payload;
    if (!outer || outer.type !== 'conversation-turn-stream') return;
    const payload = outer.payload;
    if (!payload || typeof payload !== 'object') return;

    if (payload.type === 'stream-item') {
      const id = payload.stream_item_id;
      if (typeof id === 'string') {
        if (ctx.seenStreamItems.has(id)) return;
        ctx.seenStreamItems.add(id);
      }
      const parsed = parseEncodedItem(payload.encoded_item);
      if (parsed) handleEvent(ctx, parsed);
      return;
    }

    if (payload.type === 'done') finishTopic(m.topic_id, ctx);
  }

  function onTopicMessage(m) {
    try {
      if (!m || typeof m.topic_id !== 'string' || !m.topic_id.startsWith('conversation-turn-')) return;
      const ctx = handoffs.get(m.topic_id);
      if (ctx) {
        consumeTopicMessage(m, ctx);
        return;
      }
      pendingTopicMessages.push({ topicId: m.topic_id, message: m });
      if (pendingTopicMessages.length > MAX_PENDING_TOPIC_MESSAGES) pendingTopicMessages.shift();
    } catch {

    }
  }

  function registerHandoff(topicId, ctx) {
    ctx.handoffTopic = topicId;
    handoffs.set(topicId, ctx);
    const queued = [];
    for (let i = pendingTopicMessages.length - 1; i >= 0; i -= 1) {
      if (pendingTopicMessages[i].topicId !== topicId) continue;
      queued.unshift(pendingTopicMessages[i].message);
      pendingTopicMessages.splice(i, 1);
    }
    for (const m of queued) consumeTopicMessage(m, ctx);
  }

  function onWsFrame(ev) {
    try {
      if (!ev || typeof ev.data !== 'string') return;
      const frame = JSON.parse(ev.data);
      if (!Array.isArray(frame)) return;
      for (const item of frame) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message') {
          onTopicMessage(item);
        } else if (item.type === 'reply' && item.reply && Array.isArray(item.reply.catchups)) {
          for (const m of item.reply.catchups) onTopicMessage(m);
        }
      }
    } catch {

    }
  }

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        try {
          const url = String(args[0] || '');
          if (url.startsWith('wss://ws.chatgpt.com/')) ws.addEventListener('message', onWsFrame);
        } catch {

        }
        return ws;
      },
    });
  }

  async function drain(stream, requestId, url, status) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const asm = makeAssembler();
    const { isComplete } = asm;
    let buffer = '';
    let assembled = '';
    let rawSent = 0;

    const openedAt = Date.now();
    let events = 0;
    let bytes = 0;
    const head = [];
    const tail = [];

    let 流れの断り = null;

    const BEAT_MS = 5000;
    let lastTextAt = openedAt;
    const ctx = {
      requestId,
      asm,
      get assembled() {
        return assembled;
      },
      set assembled(value) {
        assembled = value;
      },
      get lastTextAt() {
        return lastTextAt;
      },
      set lastTextAt(value) {
        lastTextAt = value;
      },
      handoffTopic: null,
      seenStreamItems: new Set(),
      wsDone: false,
    };
    const beat = setInterval(() => {
      post('stream_beat', {
        requestId,
        ms: Date.now() - openedAt,
        events,
        bytes,
        chars: assembled.length,
        sinceText: Date.now() - lastTextAt,
      });
    }, BEAT_MS);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        bytes += chunk.length;
        buffer += chunk;

        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);

          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const body = line.slice(5).trim();
            if (!body || body === '[DONE]') continue;

            if (rawSent < RAW_SAMPLE_LIMIT) {
              rawSent += 1;
              post('raw', { requestId, index: rawSent, body: body.slice(0, 2000) });
            }

            events += 1;
            const sample = body.replace(CUT_SECRET, '（合言葉は伏せた）').slice(0, CUT_SAMPLE_CHARS);
            if (head.length < CUT_SAMPLE_EACH) head.push(sample);
            else {
              tail.push(sample);
              if (tail.length > CUT_SAMPLE_EACH) tail.shift();
            }

            let parsed;
            try {
              parsed = JSON.parse(body);
            } catch {
              continue;
            }

            if (!流れの断り && parsed && typeof parsed.error === 'string' && parsed.error && !parsed.message) {
              流れの断り = { message: parsed.error, code: typeof parsed.error_code === 'string' ? parsed.error_code : '' };
            }

            if (parsed.type === 'stream_handoff' && Array.isArray(parsed.options)) {
              const ws = parsed.options.find((option) => option && option.type === 'subscribe_ws_topic');
              if (ws && typeof ws.topic_id === 'string') registerHandoff(ws.topic_id, ctx);
            }

            handleEvent(ctx, parsed);
          }
        }
      }

      const complete = isComplete();
      if (ctx.handoffTopic) {
        post('busy', { requestId, tool: 'stream_handoff' });
      } else if (流れの断り && assembled.length === 0) {

        const 字 = 流れの断り.message + (流れの断り.code ? ` [${流れの断り.code}]` : '');
        const 種類 = /usage[_ ]limit/i.test(字) ? refusalReason(429, 字) : refusalReason(status, 字);
        post('error', {
          requestId,
          status: 種類 === 'usageLimit' ? 429 : status,
          reason: 種類,
          message: `相手が断りました（流れの中。${status}）: ${字.slice(0, 1000)}`,
        });
        post('stream_cut', {
          requestId,
          url,
          status,
          why: 'refused-in-stream',
          ms: Date.now() - openedAt,
          events,
          bytes,
          chars: 0,
          complete,
          head,
          tail,
        });
      } else {
        post('done', { requestId, text: assembled, complete });

        if (!complete || assembled.length === 0) {
          post('stream_cut', {
            requestId,
            url,
            status,
            why: !complete && assembled.length === 0 ? 'nothing' : !complete ? 'no-end-mark' : 'no-text',
            ms: Date.now() - openedAt,
            events,
            bytes,
            chars: assembled.length,
            complete,
            head,
            tail,
          });
        }
      }
    } catch (err) {
      post('error', { requestId, message: String((err && err.message) || err) });

      post('stream_cut', {
        requestId,
        url,
        status,
        why: 'threw',
        ms: Date.now() - openedAt,
        events,
        bytes,
        chars: assembled.length,
        complete: false,
        message: String((err && err.message) || err),
        head,
        tail,
      });
    } finally {

      clearInterval(beat);
    }
  }

  window.fetch = async function (...args) {
    let fetchArgs = args;
    const url = urlOf(args[0]);
    const init = args[1];
    if (
      TARGET_PATH.test(url) &&
      init &&
      String(init.method || 'GET').toUpperCase() === 'POST' &&
      typeof init.body === 'string' &&
      pendingModelOverrideTask
    ) {
      const task = pendingModelOverrideTask;
      pendingModelOverrideTask = null;
      try {
        const override = await task;
        if (override) {
          const body = JSON.parse(init.body);
          const oldModel = typeof body.model === 'string' ? body.model : '';
          const oldEffort = typeof body.thinking_effort === 'string' ? body.thinking_effort : '';
          const nextModel = override.model || oldModel;
          const entry = modelEntry(override.models, nextModel);
          if (!entry) {
            modelNote('モデル ' + nextModel + ' は選べません');
          } else if (override.thinkingEffort && !thinkingEfforts(entry).includes(override.thinkingEffort)) {
            modelNote('思考の量 ' + override.thinkingEffort + ' はモデル ' + nextModel + ' では選べません');
          } else {
            if (override.model) body.model = override.model;
            const efforts = thinkingEfforts(entry);
            if (efforts.length === 0) delete body.thinking_effort;
            else if (override.thinkingEffort) body.thinking_effort = override.thinkingEffort;
            const newEffort = typeof body.thinking_effort === 'string' ? body.thinking_effort : 'なし';
            fetchArgs = [args[0], { ...init, body: JSON.stringify(body) }, ...args.slice(2)];

            const 替わった = body.model !== oldModel || newEffort !== (oldEffort || 'なし');
            post('note', {
              text: 替わった
                ? '[model] 送る本文のモデルを ' + oldModel + ' → ' + body.model +
                  '、思考の量を ' + (oldEffort || 'なし') + ' → ' + newEffort + ' に替えました（画面の札は触っていません）'
                : '[model] 送る本文のモデルは ' + body.model + '、思考の量は ' + newEffort + ' のままです（替える所が無い）',
            });
          }
        }
      } catch (err) {
        modelNote(String((err && err.message) || err));
      }
    }

    const res = await origFetch.apply(this, fetchArgs);
    try {

      if (!TARGET_PATH.test(urlOf(fetchArgs[0]))) return res;
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (!res.ok) {
        post('start', { requestId, url: urlOf(args[0]) });

        const 見出し = (name) => {
          try {
            const v = res.headers && res.headers.get ? res.headers.get(name) : null;
            return v ? `${name}=${v}` : '';
          } catch (e) {
            return '';
          }
        };
        const retryAfter = 見出し('retry-after').replace(/^retry-after=/, '');
        const rateLimitReset = 見出し('x-ratelimit-reset').replace(/^x-ratelimit-reset=/, '');
        const rateLimitRemaining = 見出し('x-ratelimit-remaining').replace(/^x-ratelimit-remaining=/, '');
        const 添え = [
          見出し('retry-after'),
          見出し('x-ratelimit-reset'),
          見出し('x-ratelimit-remaining'),
          見出し('cf-ray'),
        ]
          .filter(Boolean)
          .join(' / ');
        const 尾 = 添え ? `［${添え}］` : '';

        const 読む = res.body ? res.clone().text() : Promise.resolve('');
        読む
          .then((body) => {
            const 中身 = String(body || '');
            post('error', {
              requestId,
              status: res.status,
              reason: refusalReason(res.status, 中身),
              retryAfter,
              rateLimitReset,
              rateLimitRemaining,

              message:
                `相手が断りました（${res.status}）${尾}: ` +
                (中身 ? 中身.slice(0, 1000) : '（中身は空でした）'),
            });
          })
          .catch((e) => {
            post('error', {
              requestId,
              status: res.status,
              reason: refusalReason(res.status, ''),
              retryAfter,
              rateLimitReset,
              rateLimitRemaining,
              message:
                `相手が断りました（${res.status}）${尾}: ` +
                `（中身を読めませんでした: ${(e && e.message) || e}）`,
            });
          });
        return res;
      }
      if (!res.body) return res;

      post('start', { requestId, url: urlOf(args[0]), status: res.status });
      const [forPage, forUs] = res.body.tee();
      drain(forUs, requestId, urlOf(args[0]), res.status);

      return new Response(forPage, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch {
      return res;
    }
  };

  post('ready', { at: window.location.href });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { makeAssembler };
  }
})();
