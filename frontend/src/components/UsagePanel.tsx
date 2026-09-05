import type { LegUsage, TurnUsage } from '../lib/protocol';
import { UNIT_LABEL, inr, isPipeline, legOf, num, usd } from '../lib/format';

/**
 * Live token/character/audio consumption, one row per completed turn.
 *
 * Only the LLM leg is denominated in tokens. STT bills per second of audio and
 * TTS per character, so those columns carry their own units rather than being
 * flattened into a single fictional "token" count.
 */
export function UsagePanel({ usage, compact }: { usage: TurnUsage[]; compact?: boolean }) {
  if (usage.length === 0) {
    return (
      <section className="panel">
        {!compact && <h2>Tokens &amp; cost</h2>}
        <p className="muted">No turn completed, so nothing was consumed.</p>
      </section>
    );
  }

  const pipeline = usage.some(isPipeline);
  const total = usage.reduce((sum, t) => sum + t.costUsd, 0);
  const totalInr = usage.reduce((sum, t) => sum + t.costInr, 0);
  const unpriced = [...new Set(usage.flatMap((t) => t.unpriced))];
  const tokens = usage.reduce((sum, t) => {
    const llm = legOf(t, 'llm');
    return sum + (llm ? llm.inputUnits + llm.outputUnits : 0);
  }, 0);
  const estimated = usage.some((t) => t.legs.some((l) => l.leg === 'llm' && l.source === 'local'));

  return (
    <section className="panel">
      {/* Inside the end-of-session report the heading and headline stats are
          already above this table, so only the per-turn rows are wanted. */}
      {!compact && <h2>Tokens &amp; cost</h2>}

      {!compact && (
      <div className="summary">
        <Stat label="Estimated cost so far" value={usd(total)} sub={inr(totalInr)} big />
        {pipeline && <Stat label={`LLM tokens${estimated ? ' (some estimated)' : ''}`} value={num(tokens)} />}
        <Stat label="Turns" value={String(usage.length)} />
        <Stat label="Per turn (avg)" value={usd(total / usage.length)} sub={inr(totalInr / usage.length)} />
      </div>
      )}

      {unpriced.length > 0 && (
        <p className="muted small">
          No rate on file for {unpriced.join(', ')} — the total above is a floor, not a bill.
        </p>
      )}

      <div className="table-scroll">
        {pipeline ? <PipelineTable usage={usage} /> : <RealtimeTable usage={usage} />}
      </div>
    </section>
  );
}

function PipelineTable({ usage }: { usage: TurnUsage[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>STT audio</th>
          <th>LLM in</th>
          <th>LLM out</th>
          <th>thinking</th>
          <th>TTS chars</th>
          <th>Audio out</th>
          <th>USD</th>
          <th>INR</th>
        </tr>
      </thead>
      <tbody>
        {usage.map((t) => {
          const stt = legOf(t, 'stt');
          const llm = legOf(t, 'llm');
          const tts = legOf(t, 'tts');
          return (
            <tr key={t.turnId}>
              <td>{t.turnId}</td>
              <td>
                {stt ? `${num(stt.inputUnits, 1)}s` : '—'}
                {stt?.source === 'local' && <span className="est" title={LOCAL_HINT}>~</span>}
              </td>
              <td title={llm && (llm.source === 'local' ? ESTIMATE_HINT : 'Vendor-reported')}>
                {llm ? num(llm.inputUnits) : '—'}
                {llm?.source === 'local' && <span className="est">~</span>}
              </td>
              <td title={llm && (llm.source === 'local' ? ESTIMATE_HINT : 'Vendor-reported')}>
                {llm ? num(llm.outputUnits) : '—'}
                {llm?.source === 'local' && <span className="est">~</span>}
              </td>
              <td className="muted">{llm?.thinkingTokens ? num(llm.thinkingTokens) : '—'}</td>
              <td>
                {tts ? num(tts.outputUnits) : '—'}
                {tts?.source === 'local' && <span className="est" title={LOCAL_HINT}>~</span>}
              </td>
              <td className="muted">{tts?.audioSeconds === undefined ? '—' : `${num(tts.audioSeconds, 1)}s`}</td>
              <td className="strong">{usd(t.costUsd)}</td>
              <td className="strong">{inr(t.costInr)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RealtimeTable({ usage }: { usage: TurnUsage[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Model</th>
          <th>Audio in</th>
          <th>Audio out</th>
          <th>USD</th>
          <th>INR</th>
        </tr>
      </thead>
      <tbody>
        {usage.map((t) => {
          const rt = legOf(t, 'realtime');
          return (
            <tr key={t.turnId}>
              <td>{t.turnId}</td>
              <td>{rt?.modelId ?? '—'}</td>
              <td>{num(rt?.inputUnits, 1)}s</td>
              <td>{num(rt?.outputUnits, 1)}s</td>
              <td className="strong">{usd(t.costUsd)}</td>
              <td className="strong">{inr(t.costInr)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Per-leg totals, with the rate each cost was derived from. */
export function LegTotals({ legs }: { legs: LegUsage[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Leg</th>
            <th>Provider / model</th>
            <th>Input</th>
            <th>Output</th>
            <th>Rate</th>
            <th>USD</th>
            <th>INR</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={`${l.leg}-${l.providerId}-${l.modelId}`}>
              <td className="upper">{l.leg}</td>
              <td>
                {l.providerId}
                <span className="muted"> · {l.modelId}</span>
                {l.source === 'local' && <span className="est" title={LOCAL_HINT}> ~</span>}
              </td>
              <td>
                {l.inputUnits ? `${num(l.inputUnits, 1)} ${UNIT_LABEL[l.unit]}` : '—'}
                {l.cachedInputTokens ? <span className="muted"> ({num(l.cachedInputTokens)} cached)</span> : null}
              </td>
              <td>
                {l.outputUnits ? `${num(l.outputUnits, 1)} ${UNIT_LABEL[l.unit]}` : '—'}
                {l.thinkingTokens ? <span className="muted"> ({num(l.thinkingTokens)} thinking)</span> : null}
              </td>
              <td className="muted rate" title={l.cost?.note ?? l.unpricedReason}>
                {l.cost?.rate ?? 'no rate on file'}
                {l.cost?.confidence === 'ambiguous' && <span className="warn-flag" title={l.cost.note}> ?</span>}
              </td>
              {/* The vendor's own currency is exact; the other went through the
                  assumed FX rate, so it is dimmed rather than shown as a quote. */}
              <td className={l.cost?.currency === 'USD' ? 'strong' : 'muted'} title={converted(l.cost?.currency, 'USD')}>
                {l.cost ? usd(l.cost.amountUsd) : '—'}
              </td>
              <td className={l.cost?.currency === 'INR' ? 'strong' : 'muted'} title={converted(l.cost?.currency, 'INR')}>
                {l.cost ? inr(l.cost.amountInr) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LOCAL_HINT = 'Counted here, not reported by the vendor';
const ESTIMATE_HINT = 'Estimated from character count — the vendor reported no token counts';

const converted = (vendorCurrency: string | undefined, column: string): string | undefined =>
  vendorCurrency === undefined
    ? undefined
    : vendorCurrency === column
      ? `Billed in ${column} — this is the vendor's own figure`
      : `Converted from ${vendorCurrency} at the assumed FX rate`;

function Stat({ label, value, sub, big }: { label: string; value: string; sub?: string; big?: boolean }) {
  return (
    <div className={`stat ${big ? 'big' : ''}`}>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
      <span className="stat-label">{label}</span>
    </div>
  );
}
