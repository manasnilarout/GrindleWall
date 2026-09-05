interface Option {
  id: string;
  name: string;
  disabled?: boolean;
  hint?: string;
}

interface Props {
  label: string;
  value: string;
  options: Option[];
  onChange: (id: string) => void;
  hint?: string;
  disabled?: boolean;
}

export function Select({ label, value, options, onChange, hint, disabled }: Props) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={o.disabled}>
            {o.name}
            {o.hint ? ` — ${o.hint}` : ''}
          </option>
        ))}
      </select>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
