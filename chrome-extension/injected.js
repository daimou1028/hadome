(() => {
  const ORIGIN_MARK = 'chatgpt-bridge';
  const TARGET_PATH = /\/backend-api\/(f\/)?conversation(\?|$)/;

  const RAW_SAMPLE_LIMIT = 40;

  const CUT_SAMPLE_EACH = 6;
  const CUT_SAMPLE_CHARS = 300;

  const CUT_SECRET = /eyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+){0,2}/g;

  const origFetch = window.fetch;

  function post(kind, payload) {
    window.postMessage({ __from: ORIGIN_MARK, kind, payload }, window.location.origin);
  }

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

  async function drain(stream, requestId, url, status) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const { feed, takeStatus, takeImages, takeLimits, isComplete } = makeAssembler();
    let buffer = '';
    let assembled = '';
    let rawSent = 0;

    const openedAt = Date.now();
    let events = 0;
    let bytes = 0;
    const head = [];
    const tail = [];

    const BEAT_MS = 5000;
    let lastTextAt = openedAt;
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

            for (const t of takeStatus()) post('busy', { requestId, tool: t });

            for (const l of takeLimits()) post('limits', { requestId, text: l });

            for (const info of takeImages()) {
              grabImage(info).then((r) => post('image', { requestId, ...r }));
            }

            for (const op of feed(parsed)) {
              if (op.op === 'set') {
                assembled = op.text;
                lastTextAt = Date.now();
                post('replace', { requestId, text: op.text });
              } else if (op.op === 'model') {

                post('model', { requestId, text: op.text });
              } else if (op.op === 'autoswitch') {

                post('autoswitch', { requestId, ...op });
              } else if (op.op === 'defaultModel') {
                post('defaultModel', { requestId, ...op });
              } else {
                assembled += op.text;
                lastTextAt = Date.now();
                post('delta', { requestId, text: op.text });
              }
            }
          }
        }
      }

      const complete = isComplete();
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
    const res = await origFetch.apply(this, args);
    try {
      if (!TARGET_PATH.test(urlOf(args[0])) || !res.body) return res;
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
        const 添え = [見出し('retry-after'), 見出し('x-ratelimit-reset'), 見出し('cf-ray')]
          .filter(Boolean)
          .join(' / ');
        const 尾 = 添え ? `［${添え}］` : '';
        res
          .clone()
          .text()
          .then((body) => {
            const 中身 = String(body || '');
            post('error', {
              requestId,
              status: res.status,
              message:
                `相手が断りました（${res.status}）${尾}: ` +
                (中身 ? 中身.slice(0, 300) : '（中身は空でした）'),
            });
          })
          .catch((e) => {
            post('error', {
              requestId,
              status: res.status,
              message:
                `相手が断りました（${res.status}）${尾}: ` +
                `（中身を読めませんでした: ${(e && e.message) || e}）`,
            });
          });
        return res;
      }

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
