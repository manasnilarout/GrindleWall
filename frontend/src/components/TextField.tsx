interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** A fact about the field, set after the label: "cloned and library voices". */
  note?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  /** Set the value in mono: for ids, which are read character by character. */
  mono?: boolean;
  /** `email` lets the browser check an address; text otherwise. */
  type?: 'text' | 'email';
}

/** Single-line text input in the same shape as <Select>, for ids no dropdown can enumerate. */
export function TextField({ label, value, onChange, note, placeholder, hint, disabled, mono, type = 'text' }: Props) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {note && <span className="field-note"> · {note}</span>}
      </span>
      <input
        type={type}
        className={mono ? 'mono' : undefined}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
