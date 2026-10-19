import { useEffect, useMemo, useRef, useState } from 'react';
import { authFetch } from '../lib/auth';
import { resolveVoice, voicesFor, type ProviderEntry } from '../lib/catalog';
import type { SessionIndexEntry, StartConfig } from '../lib/protocol';
import { typedVoiceIdOf, type Rig } from '../lib/rigs';
import {
  buildVoiceStackSpec,
  checkExportable,
  citeSessions,
  initialRows,
  mapLeg,
  pickedVoiceFor,
  provenanceFrom,
  rowFor,
  sharedLanguages,
  type ExportCheck,
  type ExportContext,
  type ExportLanguage,
} from '../lib/voice-stack/export';
import { decodeVoiceStack, encodeVoiceStack, type VoiceStackSpec } from '../lib/voice-stack/spec';
import { Select } from './Select';
import { TextField } from './TextField';
import { Icon } from './Icon';

/** A row as edited here: the picked voice, plus a typed id that wins over it. */
type Row = ExportLanguage & { custom: string };

type Output =
  | { kind: 'pending' }
  | { kind: 'blocked' }
  | { kind: 'error'; message: string }
  | { kind: 'code'; code: string; spec: VoiceStackSpec; checksum: string };

/**
 * Exports the active rig as a MagickVoice voice-stack code (`mvs1.…`).
 *
 * The code is core's own format, produced by core's own spec module (synced
 * into `lib/voice-stack/`), and it is decoded again before it is shown: a code
 * this dialog displays is one core's decoder has already read back. What the
 * bench cannot promise is that core can RUN it — core checks that against its
 * own providers on import — so the checklist here is about consistency with
 * what was measured, and says so.
 */
export function CreateCodeDialog({
  rig,
  providers,
  systemPrompt,
  turnDetection,
  onClose,
  sessions: injectedSessions,
  languages,
}: {
  rig: Rig;
  providers: ProviderEntry[];
  /**
   * The bench's current prompt and turn detection — what every session it runs
   * is started with. Required: the prompt picks which recorded sessions are
   * cited, and a push-to-talk bench must not get a server-VAD code.
   */
  systemPrompt: string;
  turnDetection: StartConfig['turnDetection'];
  onClose: () => void;
  /** Supplied by render-check, which cannot run the fetch effect. */
  sessions?: SessionIndexEntry[];
  /** Starting rows; by default the one language the rig itself speaks. */
  languages?: ExportLanguage[];
}) {
  const [name, setName] = useState(rig.name);
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Row[]>(() =>
    (languages ?? initialRows(rig, providers)).map((row) => editable(rig, providers, row)),
  );
  const [sessions, setSessions] = useState<SessionIndexEntry[] | undefined>(injectedSessions);
  const [sessionsError, setSessionsError] = useState<string>();
  const [adding, setAdding] = useState('');

  useEffect(() => {
    if (injectedSessions) return;
    let live = true;
    authFetch('/api/sessions')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { sessions?: SessionIndexEntry[] }) => live && setSessions(Array.isArray(d.sessions) ? d.sessions : []))
      // Provenance is a courtesy: losing it must not cost the user their code.
      .catch((err: Error) => live && setSessionsError(err.message));
    return () => {
      live = false;
    };
  }, [injectedSessions]);

  const ttsEntry = providers.find((p) => p.id === rig.ttsProviderId);
  const shared = useMemo(() => sharedLanguages(rig, providers), [rig, providers]);
  const addable = shared.filter((o) => !rows.some((r) => r.code === o.code));
  const settled = sessions !== undefined || sessionsError !== undefined;

  // Fixed when the dialog opens, so `exportedAt` — and with it the code — does
  // not change under the user between two copies. The citation itself does
  // follow the rows: which sessions count depends on each row's voice.
  const [openedAt] = useState(() => new Date());
  const exportRows = rows.map(({ custom, ...row }) => ({ ...row, voice: custom.trim() || row.voice }));
  const rowsKey = JSON.stringify(exportRows);
  const citation = useMemo(
    () => (sessions ? citeSessions(rig, sessions, exportRows, systemPrompt) : undefined),
    // `exportRows` is a fresh array each render; its content is `rowsKey`.
    [rig, sessions, rowsKey, systemPrompt],
  );
  const provenance = useMemo(() => provenanceFrom(citation, openedAt), [citation, openedAt]);

  const selection = { languages: exportRows, name, description, provenance };
  const context: ExportContext = { turnDetection, citation };
  const checks = checkExportable(rig, providers, selection, context);
  const blocked = checks.some((c) => c.level === 'block');
  const output = produce(blocked, settled, () => buildVoiceStackSpec(rig, providers, selection, context));

  const update = (i: number, patch: Partial<Row>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows((prev) => prev.filter((_, j) => j !== i));
  const makeDefault = (i: number) => setRows((prev) => [prev[i], ...prev.filter((_, j) => j !== i)]);
  const add = () => {
    const option = shared.find((o) => o.code === (adding || addable[0]?.code));
    if (!option) return;
    setRows((prev) => [...prev, editable(rig, providers, rowFor(rig, providers, option))]);
    setAdding('');
  };

  const panelRef = useRef<HTMLDivElement>(null);
  /** Same rule as the rig editor: a dismissal has to start AND end on the scrim. */
  const downOnScrim = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const legs = (
    [
      ['STT', 'stt', rig.sttProviderId, rig.sttModelId],
      ['LLM', 'llm', rig.llmProviderId, rig.llmModelId],
      ['TTS', 'tts', rig.ttsProviderId, rig.ttsModelId],
    ] as const
  ).map(([label, leg, providerId, modelId]) => ({ label, mapped: mapLeg(leg, providerId, modelId), providerId, modelId }));

  return (
    <div
      className="drawer-scrim"
      onMouseDown={(e) => {
        downOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnScrim.current) onClose();
      }}
    >
      <div className="drawer" role="dialog" aria-modal="true" aria-label={`Create code for ${rig.name}`} tabIndex={-1} ref={panelRef}>
        <div className="drawer-head">
          <h1>
            <Icon name="scroll" size={16} />
            Create code
          </h1>
          <span className="muted small">export {rig.name} as a MagickVoice voice stack</span>
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={onClose}>
            <Icon name="close" size={13} />
            Close
          </button>
        </div>

        <div className="drawer-body">
          <section className="slot">
            <h3>
              <Icon name="quill" size={13} />
              Stack
            </h3>
            <div className="grid">
              <TextField label="Name" value={name} onChange={setName} hint="Shown to whoever imports it. Up to 80 characters." />
              <TextField label="Description (optional)" value={description} onChange={setDescription} />
            </div>
            {rig.mode === 'pipeline' && (
              <div className="cc-legs">
                {legs.map(({ label, mapped, providerId, modelId }) => (
                  <span key={label} className="cc-leg">
                    <span className="field-label">{label}</span>
                    {mapped.ok ? (
                      <code className="mono">
                        {mapped.value.provider} · {mapped.value.model}
                        {Object.entries(mapped.value.options).map(([k, v]) => ` · ${k}=${String(v)}`).join('')}
                      </code>
                    ) : (
                      <code className="mono muted">
                        {providerId}:{modelId}
                      </code>
                    )}
                  </span>
                ))}
              </div>
            )}
          </section>

          {rig.mode === 'pipeline' && (
            <section className="slot">
              <h3>
                <Icon name="owl" size={13} />
                Languages
              </h3>
              <div className="cc-rows">
                {rows.map((row, i) => {
                  const option = shared.find((o) => o.code === row.code);
                  const voices = voicesFor(providers, rig.ttsProviderId, rig.ttsModelId, row.ttsLang);
                  const codes = (list: string[] | undefined, current: string) =>
                    [...new Set([current, ...(list ?? [])])].filter(Boolean).map((id) => ({ id, name: id }));
                  return (
                    <div key={row.code} className="cc-row">
                      <span className="cc-lang">
                        <b>{option?.name ?? row.code}</b>
                        <code className="mono">{row.code}</code>
                        {i === 0 ? (
                          <span className="pill vendor">default</span>
                        ) : (
                          <button type="button" className="ghost inline" onClick={() => makeDefault(i)}>
                            make default
                          </button>
                        )}
                      </span>
                      <Select
                        label="STT code"
                        value={row.sttLang}
                        options={codes(option?.stt, row.sttLang)}
                        onChange={(id) => update(i, { sttLang: id })}
                      />
                      <Select
                        label="TTS code"
                        value={row.ttsLang}
                        options={codes(option?.tts, row.ttsLang)}
                        // A language can narrow the voice list (Cartesia), so the voice is re-resolved with it.
                        onChange={(id) =>
                          update(i, { ttsLang: id, voice: resolveVoice(providers, rig.ttsProviderId, rig.ttsModelId, id, row.voice) })
                        }
                      />
                      {voices.length > 0 ? (
                        <Select
                          label={row.custom.trim() ? 'Voice — overridden' : 'Voice'}
                          value={row.voice}
                          options={(voices.some((v) => v.id === row.voice) || !row.voice ? voices : [{ id: row.voice, name: row.voice }, ...voices]).map((v) => ({ id: v.id, name: v.name }))}
                          onChange={(id) => update(i, { voice: id })}
                          disabled={Boolean(row.custom.trim())}
                        />
                      ) : (
                        <span className="field">
                          <span className="field-label">Voice</span>
                          <span className="muted small">{ttsEntry?.acceptsVoiceId ? 'type an id →' : 'none listed'}</span>
                        </span>
                      )}
                      {ttsEntry?.acceptsVoiceId ? (
                        <TextField label="Custom voice id" value={row.custom} placeholder="optional" onChange={(v) => update(i, { custom: v })} />
                      ) : (
                        <span />
                      )}
                      <button type="button" className="ghost inline danger cc-remove" aria-label={`Remove ${row.code}`} onClick={() => remove(i)}>
                        <Icon name="close" size={11} />
                      </button>
                    </div>
                  );
                })}
                {rows.length === 0 && <p className="muted small">No language yet — add one both legs support.</p>}
              </div>
              <div className="cc-add">
                <Select
                  label={`Add a language both legs list (${addable.length} more)`}
                  value={adding || addable[0]?.code || ''}
                  options={addable.map((o) => ({ id: o.code, name: `${o.name} — STT ${o.stt.join('/')} · TTS ${o.tts.join('/')}` }))}
                  onChange={setAdding}
                  disabled={addable.length === 0}
                />
                <button type="button" className="btn" disabled={addable.length === 0} onClick={add}>
                  <Icon name="plus" size={12} />
                  Add
                </button>
              </div>
              <p className="muted small foot">
                The first row is the default. STT and TTS spell some languages differently, so each leg keeps its own code; a
                stack row is keyed by the base code both normalise to.
              </p>
            </section>
          )}

          {rig.mode === 'pipeline' && (
            <section className="slot">
              <h3>
                <Icon name="snitch" size={13} />
                Measured on this bench
              </h3>
              <ProvenanceSummary provenance={provenance} sessionsError={sessionsError} loading={!settled} />
            </section>
          )}

          <section className="slot">
            <h3>
              <Icon name="shield" size={13} />
              Checklist
            </h3>
            <Checklist checks={checks} />
            <p className="muted small foot">
              Checked against this bench&apos;s catalog only. MagickVoice validates the code again on import and reports anything
              it cannot run.
            </p>
          </section>

          <section className="slot">
            <h3>
              <Icon name="key" size={13} />
              Code
            </h3>
            <CodeOutput output={output} />
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * A row as the editor holds it. `rowFor` folds the rig's typed voice id into
 * `voice` (that is what a session sends); split it back out so the picker shows
 * it as the override it is, over the voice the dropdown would offer for that
 * language. Every row — the rig's own, an injected one, an added one — comes
 * through here, so none can lose the override the others keep.
 */
function editable(rig: Rig, providers: ProviderEntry[], row: ExportLanguage): Row {
  const typed = typedVoiceIdOf(rig, providers);
  if (!typed || row.voice !== typed) return { ...row, custom: '' };
  return { ...row, voice: pickedVoiceFor(rig, providers, row.ttsLang), custom: typed };
}

/** Encode, then decode with core's own decoder before anything is shown. */
function produce(blocked: boolean, settled: boolean, build: () => Parameters<typeof encodeVoiceStack>[0]): Output {
  if (blocked) return { kind: 'blocked' };
  if (!settled) return { kind: 'pending' };
  try {
    const code = encodeVoiceStack(build());
    const decoded = decodeVoiceStack(code);
    if (!decoded.ok) return { kind: 'error', message: `The code did not decode: ${decoded.error.message}` };
    return { kind: 'code', code, spec: decoded.spec, checksum: decoded.checksum };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

function Checklist({ checks }: { checks: ExportCheck[] }) {
  const order = { block: 0, warn: 1, ok: 2 } as const;
  return (
    <ul className="checklist">
      {[...checks]
        .sort((a, b) => order[a.level] - order[b.level])
        .map((c, i) => (
          <li key={`${c.level}-${i}`} className={`check ${c.level}`}>
            <span className="check-mark">{c.level === 'block' ? '✕' : c.level === 'warn' ? '!' : '✓'}</span>
            {c.message}
          </li>
        ))}
    </ul>
  );
}

function ProvenanceSummary({
  provenance,
  sessionsError,
  loading,
}: {
  provenance: ReturnType<typeof provenanceFrom>;
  sessionsError?: string;
  loading: boolean;
}) {
  if (loading) return <p className="muted small">Reading recorded sessions…</p>;
  if (sessionsError) {
    return <p className="banner warn inline-banner">Could not read recorded sessions ({sessionsError}). The code is exported without measurements.</p>;
  }
  if (!provenance.sessions?.length) {
    return (
      <p className="muted small">
        No recorded session matches this stack yet — same three legs, server VAD, this system prompt, and a row&apos;s language in
        its voice. Run one and end the conversation to file it.
      </p>
    );
  }
  const latency = provenance.latency as { ttfaMedianMs?: number; ttfaSessionP95MedianMs?: number; basis?: string } | undefined;
  const cost = provenance.costPerMinute as { usd?: number; inr?: number; floor?: boolean; basis?: string } | undefined;
  return (
    <>
      <div className="stat-row cc-stats">
        <span className="stat">
          <span className="stat-value">{provenance.sessionCount ?? provenance.sessions.length}</span>
          <span className="stat-label">sessions</span>
        </span>
        {latency?.ttfaMedianMs !== undefined && (
          <span className="stat">
            <span className="stat-value">{latency.ttfaMedianMs} ms</span>
            <span className="stat-label">
              TTFA median
              {latency.ttfaSessionP95MedianMs !== undefined ? ` · median session p95 ${latency.ttfaSessionP95MedianMs} ms` : ''}
            </span>
          </span>
        )}
        {cost?.usd !== undefined && (
          <span className="stat">
            <span className="stat-value">
              ${cost.usd} · ₹{cost.inr}
            </span>
            <span className="stat-label">per minute of assistant speech{cost.floor ? ' (floor — a leg was unpriced)' : ''}</span>
          </span>
        )}
        <span className="stat">
          <span className="stat-value mono">{provenance.measuredLanguages?.join(', ') || '—'}</span>
          <span className="stat-label">languages spoken</span>
        </span>
      </div>
      {(latency?.basis || cost?.basis) && (
        <p className="muted small foot">
          {latency?.basis && <>Latency is the {latency.basis}. </>}
          {cost?.basis && <>Cost is the {cost.basis}. </>}
          Travels in the code as provenance; core never reads it.
        </p>
      )}
    </>
  );
}

function CodeOutput({ output }: { output: Output }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const resetTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  if (output.kind === 'blocked') return <p className="muted small">Clear the blockers above to produce a code.</p>;
  if (output.kind === 'pending') return <p className="muted small">Waiting for recorded sessions before producing the code…</p>;
  if (output.kind === 'error') return <p className="banner error inline-banner">{output.message}</p>;

  const settle = (state: 'copied' | 'selected') => {
    setCopyState(state);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState('idle'), 2400);
  };
  // `navigator.clipboard` is missing on a non-secure origin and can refuse
  // without a user gesture it trusts. Either way the text is selected instead,
  // and the button says so rather than claiming a copy that did not happen.
  const fallback = () => {
    const box = boxRef.current;
    if (!box) return;
    box.focus();
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    settle(ok ? 'copied' : 'selected');
  };
  const copy = () => {
    const written = navigator.clipboard?.writeText(output.code);
    if (!written) return fallback();
    void written.then(() => settle('copied'), fallback);
  };

  return (
    <>
      <textarea
        ref={boxRef}
        className="cc-code mono"
        readOnly
        rows={4}
        value={output.code}
        aria-label="Voice stack code"
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="report-foot">
        <button type="button" className="btn primary" onClick={copy}>
          <Icon name="copy" size={12} />
          {copyState === 'copied' ? 'Copied' : copyState === 'selected' ? 'Selected — press Ctrl/⌘+C' : 'Copy code'}
        </button>
        <span className="muted small">
          {output.code.length.toLocaleString()} characters · checksum <code className="mono">{output.checksum}</code> · decodes
          cleanly
        </span>
      </div>
      <h3 className="cc-sub">Decoded</h3>
      <pre className="jsonbox">{JSON.stringify(output.spec, null, 2)}</pre>
    </>
  );
}
