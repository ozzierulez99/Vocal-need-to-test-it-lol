import React from 'react';

export function Section({ title, children, right, className }: { title: string; children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <section className={`section ${className ?? ''}`}>
      <header className="section-head">
        <h3>{title}</h3>
        {right}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Slider({ label, value, onChange, min = 0, max = 1, step = 0.01, format, hint, testid }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; format?: (v: number) => string; hint?: string; testid?: string }) {
  return (
    <label className="slider" title={hint}>
      <span className="slider-label">
        {label}
        <em>{format ? format(value) : value.toFixed(2)}</em>
      </span>
      <input data-testid={testid} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function Select<T extends string | number>({ label, value, options, onChange, testid, title }: { label?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; testid?: string; title?: string }) {
  return (
    <label className="field" title={title}>
      {label && <span>{label}</span>}
      <select data-testid={testid} value={String(value)} onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}>
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NumberField({ label, value, onChange, min, max, step = 1, testid, width, suffix }: { label?: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; testid?: string; width?: number; suffix?: string }) {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    let v = Number(draft);
    if (!Number.isFinite(v)) return setDraft(String(value));
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (v !== value) onChange(v);
    else setDraft(String(value));
  };
  return (
    <label className="field number">
      {label && <span>{label}</span>}
      <div className={`num-wrap ${suffix ? 'has-suffix' : ''}`}>
        <input
          data-testid={testid}
          style={width ? { width: width + (suffix ? 30 : 0) } : undefined}
          type="number"
          value={draft}
          step={step}
          min={min}
          max={max}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
          }}
        />
        {suffix && <i className="suffix">{suffix}</i>}
      </div>
    </label>
  );
}

export function TextField({ label, value, onChange, testid, placeholder }: { label?: string; value: string; onChange: (v: string) => void; testid?: string; placeholder?: string }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return (
    <label className="field text">
      {label && <span>{label}</span>}
      <input
        data-testid={testid}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onChange(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
        }}
      />
    </label>
  );
}

export function Toggle({ label, value, onChange, testid, title }: { label: string; value: boolean; onChange: (v: boolean) => void; testid?: string; title?: string }) {
  return (
    <label className="toggle" title={title}>
      <input data-testid={testid} type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Btn({ children, onClick, kind, disabled, title, testid, small, active }: { children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; title?: string; testid?: string; small?: boolean; active?: boolean }) {
  return (
    <button data-testid={testid} className={`btn ${kind ?? ''} ${small ? 'small' : ''} ${active ? 'active' : ''}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Meter({ value, label }: { value: number; label: string }) {
  return (
    <div className="meter" title={`${label}: ${Math.round(value * 100)}%`}>
      <span>{label}</span>
      <div className="meter-bar">
        <div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
      </div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
