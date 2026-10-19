import type { LegUsage, TurnUsage } from '../lib/protocol';
import { LEG_BANDS } from '../lib/legs';
import { UNIT_LABEL, inr, isPipeline, legOf, num, usd } from '../lib/format';
import { PanelIcon } from './Icon';

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
      <section className="panel usage">
        {!compact && (
          <h2>
            <PanelIcon name="potion" />
            Tokens &amp; cost
          </h2>
        )}
        <p className="muted usage-note">No turn completed, so nothing was consumed.</p>
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
    <section className="panel usage">
      {/* Inside the end-of-session report the heading and headline stats are
          already above this table, so only the per-turn rows are wanted. */}
      {!compact && (
        <h2>
          <PanelIcon name="potion" />
          Tokens &amp; cost
        </h2>
      )}

      {!compact && (
      <div className="summary">
        <Stat label="Estimated cost so far" value={usd(total)} sub={inr(totalInr)} big />
        {pipeline && <Stat label={`LLM tokens${estimated ? ' (some estimated)' : ''}`} value={num(tokens)} />}
        <Stat label="Turns" value={String(usage.length)} />
        <Stat label="Per turn (avg)" value={usd(total / usage.length)} sub={inr(totalInr / usage.length)} />
      </div>
      )}

      {unpriced.length > 0 && (
        <p className="foot usage-note">
          No rate on file for {unpriced.join(', ')} — the total above is a floor, not a bill.
        </p>
      )}

      <div className="table-scroll">
        {pipeline ? <PipelineTable usage={usage} /> : <RealtimeTable usage={usage} />}
      </div>
    </section>
  );
}

/**
 * Audio streamed after the last turn is still metered, and the backend reports
 * it as a record carrying only an STT leg — that shape is what marks it as a
 * tail rather than a turn (`flushTail` in PipelineSession).
 */
const isTail = (t: TurnUsage) => t.legs.length > 0 && t.legs.every((l) => l.leg === 'stt');

function PipelineTable({ usage }: { usage: TurnUsage[] }) {
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th scope="col">Turn</th>
          <th scope="col">STT audio</th>
          <th scope="col">LLM in</th>
          <th scope="col">LLM out</th>
          <th scope="col">TTS chars</th>
          <th scope="col">USD</th>
          <th scope="col">INR</th>
        </tr>
      </thead>
      <tbody>
        {usage.map((t) => {
          const stt = legOf(t, 'stt');
          const llm = legOf(t, 'llm');
          const tts = legOf(t, 'tts');
          const tail = isTail(t);
          // A turn that ran and was billed, but spoke nothing back: an empty
          // completion, a TTS failure, an interrupt before the first character.
          const silent = !tail && t.legs.length > 0 && (tts?.outputUnits ?? 0) === 0;
          const money = moneyClasses(t.legs);
          return (
            <tr key={t.turnId} className={tail ? 'row-tail' : silent ? 'row-silent' : undefined}>
              <td>
                {tail ? (
                  <span title="Audio that reached the STT vendor after the last turn — still metered, so billed here">
                    Tail <span className="cell-aside">· after last turn</span>
                  </span>
                ) : (
                  <>
                    {t.turnId}
                    {silent && (
                      <span className="no-reply" title="This turn was billed but nothing was spoken back">
                        no reply
                      </span>
                    )}
                  </>
                )}
              </td>
              <td>
                {stt?.source === 'local' && <Est />}
                {stt ? `${num(stt.inputUnits, 1)} s` : '—'}
              </td>
              <td title={llm && (llm.source === 'local' ? ESTIMATE_HINT : 'Vendor-reported')}>
                {llm?.source === 'local' && <span className="est">~</span>}
                {llm ? num(llm.inputUnits) : '—'}
              </td>
              <td title={llm && (llm.source === 'local' ? ESTIMATE_HINT : 'Vendor-reported')}>
                {llm?.source === 'local' && <span className="est">~</span>}
                {llm ? num(llm.outputUnits) : '—'}
                {llm?.thinkingTokens ? <span className="cell-sub">{`${num(llm.thinkingTokens)} thinking`}</span> : null}
              </td>
              <td>
                {tts?.source === 'local' && <Est />}
                {tts ? num(tts.outputUnits) : '—'}
                {tts?.audioSeconds !== undefined && (
                  <span className="cell-sub" title="Audio produced — not what is billed">
                    {`${num(tts.audioSeconds, 1)} s audio`}
                  </span>
                )}
              </td>
              <td className={money.usd}>{usd(t.costUsd)}</td>
              <td className={money.inr}>{inr(t.costInr)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One side of a realtime leg, rendered in the unit the vendor actually bills —
 * `132 tokens` or `4.3 s audio`, never a bare number wearing the wrong suffix.
 * Seconds get a decimal place; token and character counts are integers.
 */
function unitCell(leg: LegUsage | undefined, side: 'in' | 'out' = 'in'): string {
  if (!leg) return '—';
  const value = side === 'in' ? leg.inputUnits : leg.outputUnits;
  const dp = leg.unit === 'audio_seconds' ? 1 : 0;
  return `${num(value, dp)} ${UNIT_LABEL[leg.unit] ?? leg.unit}`;
}

function RealtimeTable({ usage }: { usage: TurnUsage[] }) {
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th scope="col">Turn</th>
          <th scope="col" className="left">Model</th>
          <th scope="col">In</th>
          <th scope="col">Out</th>
          <th scope="col">Audio</th>
          <th scope="col">USD</th>
          <th scope="col">INR</th>
        </tr>
      </thead>
      <tbody>
        {usage.map((t) => {
          const rt = legOf(t, 'realtime');
          const silent = rt !== undefined && rt.outputUnits === 0;
          const money = moneyClasses(t.legs);
          return (
            <tr key={t.turnId} className={silent ? 'row-silent' : undefined}>
              <td>
                {t.turnId}
                {silent && (
                  <span className="no-reply" title="This turn was billed but nothing was spoken back">
                    no reply
                  </span>
                )}
              </td>
              <td className="left mono small">{rt?.modelId ?? '—'}</td>
              {/* Realtime vendors do not agree on a unit: the mock meters
                  seconds of audio, OpenAI meters tokens and charges audio ones
                  at several times the text rate. Hardcoding "s" here rendered
                  132 tokens as "132.0s" — a number that looks like a
                  measurement and is off by whatever the token/second ratio
                  happens to be. The unit travels with the leg; use it. */}
              <td>
                {rt?.source === 'local' && <Est />}
                {unitCell(rt)}
                {rt?.audioInputTokens !== undefined && (
                  <span className="cell-sub">
                    {`${num(rt.audioInputTokens)} audio${rt.cachedInputTokens ? ` · ${num(rt.cachedInputTokens)} cached` : ''}`}
                  </span>
                )}
              </td>
              <td>
                {rt?.source === 'local' && <Est />}
                {unitCell(rt, 'out')}
                {rt?.audioOutputTokens !== undefined && (
                  <span className="cell-sub">{`${num(rt.audioOutputTokens)} audio`}</span>
                )}
              </td>
              {/* Seconds of audio are still worth showing where the provider
                  reports them, since they are the latency/quality denominator
                  even when they are not what is billed. */}
              <td className="muted">{rt?.audioSeconds === undefined ? '—' : `${num(rt.audioSeconds, 1)}s`}</td>
              <td className={money.usd}>{usd(t.costUsd)}</td>
              <td className={money.inr}>{inr(t.costInr)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Per-leg totals, with the rate each cost was derived from. `total` adds the
 * session's own figure as a closing row — the ledger's sum, never re-added here.
 */
export function LegTotals({
  legs,
  nameOf,
  total,
}: {
  legs: LegUsage[];
  /** Display name for a provider id; the id itself is shown when it has none. */
  nameOf?: (providerId: string) => string | undefined;
  total?: { usd: number; inr: number; floor: boolean };
}) {
  const totalMoney = moneyClasses(legs);
  return (
    <div className="table-scroll">
      <table className="usage-table legs-table">
        <thead>
          <tr>
            <th scope="col">Leg</th>
            <th scope="col" className="left">Provider / model</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col" className="left">Rate</th>
            <th scope="col">USD</th>
            <th scope="col">INR</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => {
            const band = LEG_BANDS.find((b) => b.key === l.leg);
            return (
              <tr key={`${l.leg}-${l.providerId}-${l.modelId}`}>
                <td>
                  <span className="leg-key">
                    {/* Realtime is one opaque leg with no band of its own. */}
                    <span className="leg-swatch" style={band ? { background: band.color } : undefined} aria-hidden="true" />
                    {l.leg === 'realtime' ? 'Realtime' : l.leg.toUpperCase()}
                  </span>
                </td>
                <td className="left leg-who" title={`${l.providerId}:${l.modelId}`}>
                  {nameOf?.(l.providerId) ?? l.providerId}
                  <span className="cell-sub mono">{l.modelId}</span>
                </td>
                <td>
                  {l.inputUnits ? (
                    <>
                      {l.source === 'local' && <Est />}
                      {`${num(l.inputUnits, 1)} ${UNIT_LABEL[l.unit]}`}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  {l.cachedInputTokens ? <span className="cell-sub">{`${num(l.cachedInputTokens)} cached`}</span> : null}
                  {l.audioInputTokens ? <span className="cell-sub">{`${num(l.audioInputTokens)} audio`}</span> : null}
                </td>
                <td>
                  {l.outputUnits ? (
                    <>
                      {l.source === 'local' && <Est />}
                      {`${num(l.outputUnits, 1)} ${UNIT_LABEL[l.unit]}`}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  {l.thinkingTokens ? <span className="cell-sub">{`${num(l.thinkingTokens)} thinking`}</span> : null}
                  {l.audioOutputTokens ? <span className="cell-sub">{`${num(l.audioOutputTokens)} audio`}</span> : null}
                  {l.audioSeconds !== undefined && (
                    <span className="cell-sub" title="Audio produced — not what is billed">
                      {`${num(l.audioSeconds, 1)} s audio`}
                    </span>
                  )}
                </td>
                <td className={`left rate${l.cost ? '' : ' unrated'}`} title={l.cost?.note ?? l.unpricedReason}>
                  {l.cost?.rate ?? 'no rate on file'}
                  {l.cost?.confidence === 'ambiguous' && (
                    <span className="rate-flag" title={l.cost.note ?? 'Sources disagree on this rate'}>
                      ?
                    </span>
                  )}
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
            );
          })}
          {total && (
            <tr className="row-total">
              <td colSpan={5}>
                Total
                {total.floor && (
                  <span className="pill floor" title="At least one leg has no rate on file">
                    floor
                  </span>
                )}
              </td>
              <td className={totalMoney.usd}>{usd(total.usd)}</td>
              <td className={totalMoney.inr}>{inr(total.inr)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The one currency every priced leg here bills in, or undefined when they
 * disagree (or none is priced). Only then is one column exact and the other
 * purely converted; a mixed total is part of each, and dims neither.
 */
export function billedCurrency(legs: LegUsage[]): 'USD' | 'INR' | undefined {
  const currencies = new Set(legs.flatMap((l) => (l.cost ? [l.cost.currency] : [])));
  if (currencies.size !== 1) return undefined;
  const [only] = currencies;
  return only === 'USD' || only === 'INR' ? only : undefined;
}

function moneyClasses(legs: LegUsage[]): { usd: string; inr: string } {
  const billed = billedCurrency(legs);
  return {
    usd: billed === 'INR' ? 'muted' : 'strong',
    inr: billed === 'USD' ? 'muted' : 'strong',
  };
}

const Est = () => (
  <span className="est" title={LOCAL_HINT}>
    ~
  </span>
);

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
