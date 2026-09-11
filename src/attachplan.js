const UPLOAD_EXT = new Set([

  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'rtf',

  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tiff',
]);

const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

function extOf(p) {
  const s = String(p || '');
  const at = s.lastIndexOf('.');
  const slash = s.lastIndexOf('/');

  if (at < 0 || at < slash) return '';
  return s.slice(at + 1).toLowerCase();
}

function looksBinary(head) {
  if (!head || !head.length) return false;
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0) return true;
  }
  return false;
}

function planMentions(paths, look) {
  const text = [];
  const upload = [];
  const skipped = [];
  for (const p of paths || []) {

    if (/#L\d/.test(String(p))) {
      text.push(p);
      continue;
    }
    let info = null;
    try {
      info = look(p);
    } catch {
      info = null;
    }
    if (!info) {

      text.push(p);
      continue;
    }
    const ext = extOf(p);
    const wantUpload = UPLOAD_EXT.has(ext) || looksBinary(info.head);
    if (!wantUpload) {
      text.push(p);
      continue;
    }
    if (info.size > UPLOAD_MAX_BYTES) {
      skipped.push({
        path: p,
        why: `${Math.round(info.size / 1024 / 1024)}MB あります（上げられるのは ${UPLOAD_MAX_BYTES / 1024 / 1024}MB まで）`,
      });
      continue;
    }
    if (info.size === 0) {

      skipped.push({ path: p, why: '中身が空です' });
      continue;
    }
    upload.push(p);
  }
  return { text, upload, skipped };
}

const MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  tiff: 'image/tiff',
};

function mimeOf(p) {
  return MIME[extOf(p)] || 'application/octet-stream';
}

module.exports = { planMentions, mimeOf, extOf, looksBinary, UPLOAD_EXT, UPLOAD_MAX_BYTES };
