const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function dirPath() {
  return process.env.CHATGPT_BRIDGE_LAST_MODEL_DIR || path.join(os.homedir(), '.chatgpt-bridge', 'last-model');
}

function filePath(id) {
  const name = /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : 'h-' + crypto.createHash('sha1').update(id).digest('hex');
  return path.join(dirPath(), name + '.json');
}

function read(pluginId) {
  const id = String(pluginId || '').trim();
  if (!id) return '';
  try {
    const entry = JSON.parse(fs.readFileSync(filePath(id), 'utf8'));
    return entry && typeof entry.modelSlug === 'string' ? entry.modelSlug : '';
  } catch {
    return '';
  }
}

function write(pluginId, modelSlug) {
  const id = String(pluginId || '').trim();
  const slug = String(modelSlug || '').trim();
  if (!id || !slug) return;
  try {
    const file = filePath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ modelSlug: slug, timestamp: Date.now() }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch {

  }
}

module.exports = { read, write, filePath };
