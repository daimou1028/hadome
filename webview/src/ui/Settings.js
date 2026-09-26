const { modelOptions, effortOptions } = require('../settingsOptions');
const { ModelChoice } = require('./ModelChoice');
const { EffortChoice } = require('./EffortChoice');

function Settings({ values, models, loading, cached, t, onChange, onBack, onOpenAll }) {
  const effortLabel = (value) => {
    const key = `settingsPage.effort.${value}`;
    const label = t(key);
    return label === key ? value : label;
  };

  const listNote = loading
    ? t('agentSettings.loadingList')
    : (models === null ? t('agentSettings.noList') : (cached ? t('settingsPage.cachedList') : ''));
  const subModels = modelOptions(models, values.subAgentModel, t);
  const subEfforts = effortOptions(models, values.subAgentModel, values.subAgentThinkingEffort)
    .filter((option) => option && option.value);
  const model = {
    value: values.subAgentModel,
    options: subModels,
    label: t('settingsPage.modelLabel'),
    loading,
    loadingLabel: t('agentSettings.loadingList'),
    legacyLabel: t('settingsPage.legacy'),
    asTabLabel: t('agentSettings.asTab'),
    onPick: (value) => {
      const levels = effortOptions(models, value, '')
        .filter((option) => option && option.value);
      const currentEffort = values.subAgentThinkingEffort;
      Promise.resolve(onChange('subAgentModel', value))
        .then((result) => {
          if (result && currentEffort && !levels.some((option) => option.value === currentEffort)) {
            return onChange('subAgentThinkingEffort', '');
          }
          return null;
        })
        .catch(() => {});
    },
  };
  const effort = subEfforts.length ? {
    value: values.subAgentThinkingEffort,
    levels: subEfforts,
    label: t('settingsPage.effortLabel'),
    labelFor: effortLabel,
    asTabInlineLabel: t('settingsPage.effort.asTab'),
    onPick: (value) => onChange('subAgentThinkingEffort', value),
  } : null;

  return (
    <div className="settingspage">
      <div className="settingshead">
        <button className="iconbtn" aria-label={t('settingsPage.back')} title={t('settingsPage.back')} onClick={onBack}>
          <span className="codicon codicon-arrow-left" aria-hidden="true" />
        </button>
        <h2>{t('settingsPage.subTitle')}</h2>
      </div>

      <p className="settingsnote settingsmainhint">{t('settingsPage.mainHint')}</p>

      <section>
        <div className="settingsrow">
          <span className="settingslabel">{t('settingsPage.countLabel')}</span>
          <div className="settingscount" role="group" aria-label={t('settingsPage.countLabel')}>
            {[0, 1, 2, 3, 4].map((count) => (
              <button
                key={count}
                type="button"
                className={values.subAgents === count ? 'now' : ''}
                aria-pressed={values.subAgents === count ? 'true' : 'false'}
                onClick={() => onChange('subAgents', count)}
              >
                {count}
              </button>
            ))}
          </div>
        </div>

        <ModelChoice model={model} />
        {listNote ? <div className="settingsnote settingsmodelnote">{listNote}</div> : null}
        {effort ? <EffortChoice effort={effort} asTabLabel={t('agentSettings.asTab')} /> : null}
      </section>

      <section>
        <h3>{t('agentSettings.subAgentCleanup')}</h3>
        <div className="settingscleanup">
          {['archive-success', 'archive-all', 'none'].map((value) => (
            <button
              key={value}
              type="button"
              className={'modeitem' + (values.subAgentCleanup === value ? ' now' : '')}
              onClick={() => onChange('subAgentCleanup', value)}
            >
              <span
                className={'mark codicon codicon-' + (values.subAgentCleanup === value ? 'check' : 'blank')}
                aria-hidden="true"
              />
              <span className="col">
                <span className="nm">{t(`agentSettings.cleanup.${value}`)}</span>
                <span className="note">{t(`agentSettings.cleanup.${value}.d`)}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <button type="button" className="settingsall" onClick={onOpenAll}>
        {t('agentSettings.all')}
      </button>
    </div>
  );
}

module.exports = { Settings };
