import { useEffect, useRef, useState } from 'react';
import type { Utterance } from '../hooks/useVoiceSession';
import { Icon, PanelIcon } from './Icon';

export function Transcript({
  utterances,
  speaking,
  turnCount,
  micOn = false,
  onSend,
  canSend = false,
}: {
  utterances: Utterance[];
  speaking: boolean;
  turnCount?: number;
  micOn?: boolean;
  /** Renders the composer under the conversation. Without it, the transcript is read-only. */
  onSend?: (text: string) => void;
  canSend?: boolean;
}) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scrolls the list, not the page: scrollIntoView would drag the whole bench
  // down to the transcript on every partial.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [utterances]);

  const last = utterances[utterances.length - 1];
  const listening = micOn && !(last && !last.final);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !canSend || !onSend) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <section className="panel convo">
      <h2>
        <PanelIcon name="quill" />
        Conversation
        {turnCount !== undefined && (
          <span className="muted convo-count">{`${turnCount} ${turnCount === 1 ? 'turn' : 'turns'}`}</span>
        )}
        {speaking && (
          <span className="right convo-speaking" role="status">
            <span className="speaking-dot" aria-hidden="true" />
            Assistant speaking
          </span>
        )}
      </h2>
      <div className="transcript" ref={scrollRef}>
        {utterances.length === 0 && !listening && (
          <p className="muted transcript-empty">The parchment is blank. Start the mic and speak, or type a turn below.</p>
        )}
        {utterances.map((u, i) => (
          <div key={i} className={`bubble ${u.role} ${u.final ? '' : 'partial'}`}>
            <span className="sr-only">{u.role === 'user' ? 'You: ' : 'Assistant: '}</span>
            {u.text}
          </div>
        ))}
        {listening && (
          <span className="listening">
            <i aria-hidden="true" />
            Listening…
          </span>
        )}
      </div>

      {onSend && (
        <form className="composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="turn-input">
            Type a turn
          </label>
          <input
            id="turn-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={canSend ? 'Type a turn instead of speaking' : 'Connect a session first'}
            disabled={!canSend}
          />
          <button type="submit" className="btn" disabled={!canSend || !text.trim()}>
            <Icon name="send" size={16} />
            Send
          </button>
        </form>
      )}
    </section>
  );
}
