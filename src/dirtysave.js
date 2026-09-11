function pickDirty(docs, abs) {
  if (!Array.isArray(docs) || !abs) return null;
  for (const doc of docs) {
    if (!doc || !doc.isDirty) continue;

    const uri = doc.uri || {};
    if (uri.scheme !== 'file') continue;
    if (uri.fsPath !== abs) continue;
    return doc;
  }
  return null;
}

module.exports = { pickDirty };
