import { useEffect, useRef } from 'react';
import type { Utterance } from '../hooks/useVoiceSession';

export function Transcript({ utterances, speaking }: { utterances: Utterance[]; speaking: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  // Block body on purpose: a concise arrow would return scrollIntoView's result,
  // which React then treats as a cleanup function and tries to call.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [utterances]);

  return (
    <section className="panel grow">
      <h2>
        Conversation
        {speaking && <span className="speaking-dot" aria-label="assistant speaking" />}
      </h2>
      <div className="transcript">
        {utterances.length === 0 && <p className="muted">Nothing yet. Hold the mic or type a turn.</p>}
        {utterances.map((u, i) => (
          <div key={i} className={`bubble ${u.role} ${u.final ? '' : 'partial'}`}>
            <span className="who">{u.role === 'user' ? 'You' : 'Assistant'}</span>
            <span>{u.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  );
}
