'use strict';

const { projectIdOf } = require('./conversation');

const landed = (r) => String((r && r.url) || '');

async function openProjectConversation({ bridge, ensureProject, forget, remember = () => {}, tell, step: stepIn, allowRecreate = false, lifecycle }) {

  const step = typeof stepIn === 'function' ? stepIn : (_label, fn) => fn();
  for (let round = 0; round < 2; round += 1) {
    const proj = await step('project', () => ensureProject());
    if (!proj || !proj.ok) {
      tell('failed', { why: (proj && proj.why) || '?' });
      return { ok: false };
    }

    const wanted = projectIdOf(proj.url);
    if (!wanted) {
      if (proj.mine) tell('failed', { why: proj.url || '?' });
      else tell('pinnedGone', { url: proj.url || '' });
      return { ok: false };
    }
    remember(proj);

    if (bridge.requireProject) bridge.requireProject(!!proj.url);

    let r;
    try {
      r = await step('newConv', () => bridge.newConversation(proj.url || '', lifecycle));
    } catch (e) {
      if (!e || !e.projectGone) throw e;
      r = { url: e.url || '' };
    }

    if (projectIdOf(landed(r)) === wanted) return { ok: true, r, proj };

    if (!proj.mine) {
      tell('pinnedGone', { url: proj.url || '' });
      return { ok: false };
    }

    if (!allowRecreate) {
      tell('notThere', { url: proj.url || '' });
      return { ok: false, reason: 'project-gone' };
    }
    await forget();
    if (round === 0) tell('remaking');
    else {
      tell('notThere', { url: proj.url || '' });
      return { ok: false };
    }
  }
  return { ok: false };
}

module.exports = { openProjectConversation };
