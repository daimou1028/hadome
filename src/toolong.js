const MEASURED_JA_MAX = 35000;

const SEND_LIMIT = Math.floor(MEASURED_JA_MAX * 0.8);

function notice(cut, lang) {
  if (lang === 'en') return `\n\n…（${cut} characters were left out here because the message was too long）\n\n`;
  return `\n\n…（長すぎるので、ここで ${cut} 文字を省きました。必要なら道具をもう一度呼んでください）\n\n`;
}

function trimForSend(text, limit = SEND_LIMIT) {
  const s = String(text == null ? '' : text);
  if (s.length <= limit) return { text: s, trimmed: false, cut: 0 };
  const note = notice(0);
  const room = Math.max(0, limit - note.length - 16);

  const headLen = Math.floor(room * 0.6);
  const tailLen = room - headLen;
  const cut = s.length - headLen - tailLen;
  return {
    text: s.slice(0, headLen) + notice(cut) + s.slice(s.length - tailLen),
    trimmed: true,
    cut,
  };
}

module.exports = { trimForSend, SEND_LIMIT, MEASURED_JA_MAX };
