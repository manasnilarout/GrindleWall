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
  /** A fact about the options, set after the label: "44 on this model". */
  note?: string;
  hint?: string;
  disabled?: boolean;
  /** Set the value in mono: for model ids, which are read as ids. */
  mono?: boolean;
}

export function Select({ label, value, options, onChange, note, hint, disabled, mono }: Props) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {note && <span className="field-note"> · {note}</span>}
      </span>
      <select className={mono ? 'mono' : undefined} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
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
