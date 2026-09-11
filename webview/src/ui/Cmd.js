const { createElement: h, Fragment, useRef, useLayoutEffect } = require('react');

function Cmd({ command, output, elapsed, done }) {
  const preRef = useRef(null);

  useLayoutEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  return h(
    Fragment,
    null,
    h(
      'div',
      { className: 'cmdhead' },

      h('span', { className: done ? `dot ${done.ok ? 'ok' : 'ng'}` : 'dot' }),
      h('span', { className: 'nm' }, command || ''),
      h('span', { className: 'sec' }, done ? done.label : elapsed || '')
    ),

    h('pre', { ref: preRef, hidden: !output }, output || '')
  );
}

module.exports = { Cmd };
