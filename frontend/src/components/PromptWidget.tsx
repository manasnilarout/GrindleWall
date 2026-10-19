import { Icon, PanelIcon } from './Icon';

interface Props {
  systemPrompt: string;
  onSystemPromptChange: (v: string) => void;
  locked: boolean;
}

const PRESETS = [
  {
    name: 'Terse assistant',
    text: 'You are a voice assistant. Answer in one or two short sentences. Never use lists or markdown.',
  },
  {
    name: 'Latency probe',
    text: 'Reply with exactly one short sentence, immediately, with no preamble.',
  },
  {
    name: 'Naturalness probe',
    text: 'You are a warm, chatty human on a phone call. Use contractions, filler words, and natural hesitation.',
  },
];

/**
 * The system prompt. It is part of what produced the numbers — the session
 * record keeps it and the CLI command carries it — so it pins with the rig
 * while a conversation is live.
 */
export function PromptWidget({ systemPrompt, onSystemPromptChange, locked }: Props) {
  // A hand-edited prompt matches no preset; the select says so rather than
  // claiming the last preset picked.
  const preset = PRESETS.find((p) => p.text === systemPrompt)?.name ?? '';

  return (
    <section className="panel">
      <h2>
        <PanelIcon name="scroll" />
        System prompt
        {locked && (
          <span className="right prompt-lock">
            <Icon name="lock" size={14} />
            Locked while live
          </span>
        )}
      </h2>

      <label className="field">
        <span className="field-label">Preset</span>
        <select
          value={preset}
          disabled={locked}
          onChange={(e) => {
            const picked = PRESETS.find((p) => p.name === e.target.value);
            if (picked) onSystemPromptChange(picked.text);
          }}
        >
          {!preset && <option value="">Custom</option>}
          {PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field prompt-text">
        <span className="sr-only">System prompt text</span>
        <textarea
          rows={4}
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          disabled={locked}
          placeholder="You are a voice assistant…"
        />
      </label>
    </section>
  );
}
