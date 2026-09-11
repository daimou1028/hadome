const DEAD = new Map([['gpt-5-5-mini', { answers: 71, calls: 0 }]]);

const WEAK = /(^|[-_])(mini|nano)([-_]|$)/i;

const CHATGPT = /^(gpt|chatgpt|o[0-9])/i;

function profileFor(slug) {
  const name = String(slug || '').trim().toLowerCase();
  if (!name) return 'chatgpt';
  if (DEAD.has(name)) return 'dead';
  if (WEAK.test(name)) return 'weak';
  if (CHATGPT.test(name)) return 'chatgpt';
  return 'base';
}

function evidenceFor(slug) {
  return DEAD.get(String(slug || '').trim().toLowerCase()) || null;
}

function shouldRestart(fromSlug, toSlug) {
  if (!fromSlug || !toSlug || fromSlug === toSlug) return false;
  const 前 = profileFor(fromSlug);
  const 後 = profileFor(toSlug);

  return (後 === 'dead') !== (前 === 'dead');
}

module.exports = { profileFor, evidenceFor, shouldRestart, DEAD, WEAK };
