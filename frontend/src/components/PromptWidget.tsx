import { useState } from 'react';
import { Icon, PanelIcon } from './Icon';

interface Props {
  systemPrompt: string;
  onSystemPromptChange: (v: string) => void;
  turnDetection: 'server_vad' | 'manual';
  onTurnDetectionChange: (v: 'server_vad' | 'manual') => void;
  onSend: (text: string) => void;
  canSend: boolean;
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

export function PromptWidget({
  systemPrompt,
  onSystemPromptChange,
  turnDetection,
  onTurnDetectionChange,
  onSend,
  canSend,
  locked,
}: Props) {
  const [text, setText] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !canSend) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <section className="panel">
      <h2>
        <PanelIcon name="book" />
        Prompt
      </h2>

      <label className="field">
        <span className="field-label">System prompt</span>
        <textarea
          rows={4}
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          disabled={locked}
          placeholder="You are a voice assistant…"
        />
      </label>

      <div className="preset-row">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" disabled={locked} onClick={() => onSystemPromptChange(p.text)}>
            <Icon name={p.name === 'Naturalness probe' ? 'owl' : p.name === 'Latency probe' ? 'lightning' : 'hat'} size={12} />
            {p.name}
          </button>
        ))}
      </div>

      <label className="field">
        <span className="field-label">Turn detection</span>
        <select
          value={turnDetection}
          onChange={(e) => onTurnDetectionChange(e.target.value as 'server_vad' | 'manual')}
          disabled={locked}
        >
          <option value="server_vad">Server VAD (provider decides when you stopped)</option>
          <option value="manual">Manual (push to talk)</option>
        </select>
      </label>

      <form className="composer" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={canSend ? 'Type a turn instead of speaking…' : 'Connect a session first'}
          disabled={!canSend}
        />
        <button type="submit" disabled={!canSend || !text.trim()}>
          <Icon name="quill" size={13} />
          Send
        </button>
      </form>
    </section>
  );
}
