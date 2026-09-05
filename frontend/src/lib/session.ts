import type { LegUsage, SessionSummary, TurnUsage } from './protocol';

/**
 * Session records are read back from files on disk that may predate the current
 * shape, or have been truncated by a crash mid-write, or hand-edited. Rendering
 * one directly means a single missing array takes down the whole page, so every
 * field the UI dereferences is filled in here first.
 *
 * Missing numbers become 0 rather than being invented, and `usdPerInr` keeps a
 * sane divisor so the FX footnote cannot render "₹NaN per $1".
 */
export function normalizeSummary(raw: unknown): SessionSummary {
  const s = (raw ?? {}) as Partial<SessionSummary>;
  const usdPerInr = Number.isFinite(s.usdPerInr) && (s.usdPerInr as number) > 0 ? (s.usdPerInr as number) : 0.0113;

  return {
    recordId: s.recordId ?? 'unknown',
    sessionId: s.sessionId ?? 'unknown',
    mode: s.mode ?? 'pipeline',
    label: s.label ?? '(no pipeline recorded)',
    config: s.config ?? ({ mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad' } as SessionSummary['config']),
    startedAt: num(s.startedAt),
    endedAt: num(s.endedAt),
    durationMs: num(s.durationMs),
    turnCount: num(s.turnCount),
    totals: arr(s.totals).map(normalizeLeg),
    costUsd: num(s.costUsd),
    costInr: num(s.costInr),
    unpriced: arr(s.unpriced).filter((u): u is string => typeof u === 'string'),
    turns: arr(s.turns).map(normalizeTurn),
    latency: s.latency ?? {},
    usdPerInr,
  };
}

function normalizeTurn(raw: unknown): TurnUsage {
  const t = (raw ?? {}) as Partial<TurnUsage>;
  return {
    turnId: num(t.turnId),
    at: num(t.at),
    legs: arr(t.legs).map(normalizeLeg),
    costUsd: num(t.costUsd),
    costInr: num(t.costInr),
    unpriced: arr(t.unpriced).filter((u): u is string => typeof u === 'string'),
  };
}

function normalizeLeg(raw: unknown): LegUsage {
  const l = (raw ?? {}) as Partial<LegUsage>;
  return {
    ...l,
    leg: l.leg ?? 'llm',
    providerId: l.providerId ?? 'unknown',
    modelId: l.modelId ?? 'unknown',
    unit: l.unit ?? 'tokens',
    inputUnits: num(l.inputUnits),
    outputUnits: num(l.outputUnits),
    source: l.source === 'vendor' ? 'vendor' : 'local',
    cost: l.cost
      ? {
          ...l.cost,
          amount: num(l.cost.amount),
          amountUsd: num(l.cost.amountUsd),
          amountInr: num(l.cost.amountInr),
          currency: l.cost.currency ?? 'USD',
          rate: l.cost.rate ?? 'unknown rate',
          confidence: l.cost.confidence === 'ambiguous' ? 'ambiguous' : 'verified',
        }
      : undefined,
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
