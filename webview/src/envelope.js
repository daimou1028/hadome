function makeBridge(postMessage) {
  let seq = 0;
  const waiting = new Map();

  function tell(type, data) {
    postMessage({ type, data: data || {}, id: null });
  }

  function ask(type, data) {
    const id = 'w' + (seq += 1);
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, type });
      postMessage({ type, data: data || {}, id });
    });
  }

  function settleReply(env) {
    if (!env || !env.id || !waiting.has(env.id)) return false;
    const w = waiting.get(env.id);

    if (env.type && env.type !== w.type) return false;

    waiting.delete(env.id);
    const d = env.data || {};
    if (d.ok) w.resolve(d.value);
    else w.reject(new Error(d.error || '理由の分からない失敗'));
    return true;
  }

  function unwrap(env) {
    return Object.assign({ type: env.type }, env.data || {});
  }

  return { tell, ask, settleReply, unwrap, waiting };
}

module.exports = { makeBridge };
