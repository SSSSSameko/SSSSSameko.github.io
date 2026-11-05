const steps = ['载入名单', '确认奖项', '开始抽奖'];

export default function WorkspaceHeading({ loaded, confirmed, completed, running }) {
  const activeStep = loaded ? (confirmed ? 2 : 1) : 0;

  return (
    <header className="workspace-heading">
      <div className="workspace-heading-copy">
        <h1>抽奖工作台</h1>
        <p>先载入名单，再设置奖项。</p>
      </div>
      <ol className="workspace-steps" aria-label="本轮抽奖流程">
        {steps.map((label, index) => {
          const done = completed || index < activeStep;
          const current = !completed && index === activeStep;
          return (
            <li
              key={label}
              className={`${done ? 'is-complete' : ''} ${current ? 'is-current' : ''} ${current && running ? 'is-running' : ''}`}
              aria-current={current ? 'step' : undefined}
            >
              <span aria-hidden="true">{done ? '✓' : String(index + 1).padStart(2, '0')}</span>
              <strong>{label}</strong>
            </li>
          );
        })}
      </ol>
    </header>
  );
}
