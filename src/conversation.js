function needsApproval({ tabUrl, tabConversationId, sessionConversationId, approved, projectUrl } = {}) {

  if (!tabUrl) return true;

  if (approved) return false;

  if (!tabConversationId) return false;

  if (projectUrl && !inProject(tabUrl, projectUrl)) return true;

  return tabConversationId !== sessionConversationId;
}

function inProject(url, projectUrl) {
  const want = projectIdOf(projectUrl);
  if (!want) return true;
  return projectIdOf(url) === want;
}

function projectIdOf(u) {
  let p = String(u || '');
  try {
    p = new URL(p).pathname;
  } catch {
    p = p.split(/[?#]/)[0];
  }
  const m = /^\/g\/(g-p-[A-Za-z0-9]+)/.exec(p);
  return m ? m[1] : '';
}

module.exports = { needsApproval, inProject, projectIdOf };
