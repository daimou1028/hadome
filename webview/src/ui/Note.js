const { toText } = require('./toText');

function Note({ text }) {

  return <>{toText(text)}</>;
}

module.exports = { Note };
