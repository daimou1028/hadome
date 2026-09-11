function needsApproval({ tabUrl, tabConversationId, sessionConversationId, approved, projectUrl } = {}) {

  if (!tabUrl) return true;

  if (approved) return false;

  if (!tabConversationId) return false;

  if (projectUrl && !inProject(tabUrl, projectUrl)) return true;

  return tabConversationId !== sessionConversationId;
}

function inProject(url, projectUrl) {
  const id = (u) => {
    const m = /\/g\/(g-p-[A-Za-z0-9]+)/.exec(String(u || ''));
    return m ? m[1] : '';
  };
  const want = id(projectUrl);
  if (!want) return true;
  return id(url) === want;
}

module.exports = { needsApproval, inProject };
