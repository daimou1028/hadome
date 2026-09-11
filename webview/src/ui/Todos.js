const MARK = {

  completed: 'check',

  in_progress: 'circle-filled',

  pending: 'circle-outline',
};

const { toText } = require('./toText');

function Todos({ todos, title }) {
  const list = Array.isArray(todos) ? todos : [];
  if (!list.length) return null;
  const done = list.filter((t) => t.status === 'completed').length;
  return (
    <div className="todos">
      <div className="todohead">
        <span className="nm">{toText(title)}</span>
        <span className="cnt">
          {done}/{list.length}
        </span>
      </div>
      {list.map((t, i) => (
        <div key={t.content + i} className={'todo ' + t.status}>
          <span className={'mark codicon codicon-' + (MARK[t.status] || MARK.pending)} aria-hidden="true" />

          <span className="txt">{t.status === 'in_progress' ? t.activeForm || t.content : t.content}</span>
        </div>
      ))}
    </div>
  );
}

module.exports = { Todos, MARK };
