const { useEffect, useRef } = require('react');
const { isComposingEvent } = require('../keys');

function Row({ item, editing, onEdit, onSave, onCancel, onRemove, hint, removeTitle }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!editing || !ref.current) return;
    const ta = ref.current;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  if (editing) {
    return (
      <div className="qrow">
        <textarea
          ref={ref}
          className="qedit"
          defaultValue={item.text}
          rows={Math.min(item.text.split('\n').length, 8)}
          onBlur={() => onSave(ref.current.value)}
          onKeyDown={(e) => {

            const ne = e.nativeEvent || {};

            if (isComposingEvent(ne)) return;
            if (ne.key === 'Enter' && !ne.shiftKey) {
              e.preventDefault();
              onSave(ref.current.value);
            } else if (ne.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="qrow">
      <div className="qtext" title={hint} onClick={onEdit}>
        {item.text}
      </div>
      <span
        className="qx"
        title={removeTitle}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ✕
      </span>
    </div>
  );
}

function Queue({ items, editingId, title, clearLabel, hint, removeTitle, onClear, onEdit, onSave, onCancel, onRemove }) {
  if (!items.length) return null;
  return (
    <>
      <div className="qhead">
        <span>{title}</span>
        <span className="qclear" onClick={onClear}>
          {clearLabel}
        </span>
      </div>
      {items.map((item) => (
        <Row
          key={item.id}
          item={item}
          editing={editingId === item.id}
          hint={hint}
          removeTitle={removeTitle}
          onEdit={() => onEdit(item.id)}
          onSave={(text) => onSave(item.id, text)}
          onCancel={onCancel}
          onRemove={() => onRemove(item.id)}
        />
      ))}
    </>
  );
}

module.exports = { Queue };
