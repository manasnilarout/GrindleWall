interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
}

/** Single-line text input in the same shape as <Select>, for ids no dropdown can enumerate. */
export function TextField({ label, value, onChange, placeholder, hint, disabled }: Props) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
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
