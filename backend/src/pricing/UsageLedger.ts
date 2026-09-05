import { randomUUID } from 'node:crypto';
import type {
  DerivedMetrics,
  LegUsage,
  SessionSummary,
  SessionMode,
  StartConfig,
  TurnUsage,
} from '../shared/protocol.js';
import { priceLeg, usdPerInr } from './rates.js';

/**
 * One per conversation. Prices each turn as it completes and keeps the running
 * totals, so the summary at the end is the same arithmetic the UI already saw
 * turn by turn rather than a second, independent calculation.
 */
export class UsageLedger {
  readonly recordId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  readonly startedAt = Date.now();

  private readonly turns: TurnUsage[] = [];
  private readonly ttfas: number[] = [];
  private readonly sttLatencies: number[] = [];
  private readonly llmTtfts: number[] = [];
  private readonly ttsTtfbs: number[] = [];
  private readonly totalTurns: number[] = [];
  private readonly audioDurations: number[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly mode: SessionMode,
    private readonly label: string,
    private readonly config: StartConfig,
  ) {}

  get turnCount(): number {
    return this.turns.length;
  }

  /** Prices a completed turn and files it. Returns what the client should be told. */
  record(turnId: number, legs: LegUsage[]): TurnUsage {
    const priced = legs.map((leg) => priceLeg(leg));
    const turn: TurnUsage = {
      turnId,
      at: Date.now(),
      legs: priced,
      costUsd: round(priced.reduce((sum, l) => sum + (l.cost?.amountUsd ?? 0), 0)),
      costInr: round(priced.reduce((sum, l) => sum + (l.cost?.amountInr ?? 0), 0), 6),
      unpriced: priced.filter((l) => l.unpricedReason).map((l) => `${l.providerId}:${l.modelId}`),
    };
    this.turns.push(turn);
    return turn;
  }

  /**
   * Banks a completed turn's whole latency breakdown.
   *
   * Server-side time-to-first-audio is one of the figures here. The browser
   * measures its own, actually-audible number, but that never reaches this
   * process — so the record carries the server figure and the UI shows both.
   *
   * This deliberately replaced a narrower `noteTtfa`. Two public methods writing
   * the same array is a trap: calling both banks every TTFA twice and skews the
   * median and p95 with nothing to show for it.
   *
   * The per-leg numbers were already computed and already on the wire; they
   * were simply never kept, so a record on disk could report a slow
   * conversation without saying which leg was slow. Comparing two past runs is
   * the point of this bench, and that comparison is arithmetic on medians —
   * medians that only ever existed in the browser tab that ran the session.
   *
   * Every leg is banked separately rather than as whole turns: a realtime
   * session has no STT or LLM mark at all, and a pipeline turn can miss one
   * when a provider reports nothing, so a shared array would silently pair the
   * n-th STT figure with an unrelated turn's TTS figure.
   */
  noteLatency(derived: DerivedMetrics): void {
    this.note(this.ttfas, derived.timeToFirstAudioMs);
    this.note(this.sttLatencies, derived.sttLatencyMs);
    this.note(this.llmTtfts, derived.llmTtftMs);
    this.note(this.ttsTtfbs, derived.ttsTtfbMs);
    this.note(this.totalTurns, derived.totalTurnMs);
    this.note(this.audioDurations, derived.audioDurationMs);
  }

  private note(into: number[], ms: number | undefined): void {
    if (ms !== undefined && Number.isFinite(ms) && ms >= 0) into.push(ms);
  }

  summary(): SessionSummary {
    const endedAt = Date.now();
    return {
      recordId: this.recordId,
      sessionId: this.sessionId,
      mode: this.mode,
      label: this.label,
      config: this.config,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt - this.startedAt,
      turnCount: this.turns.length,
      totals: totalsByLeg(this.turns),
      costUsd: round(this.turns.reduce((sum, t) => sum + t.costUsd, 0)),
      costInr: round(this.turns.reduce((sum, t) => sum + t.costInr, 0), 6),
      unpriced: [...new Set(this.turns.flatMap((t) => t.unpriced))],
      turns: this.turns,
      latency: {
        ...latencyOf(this.ttfas),
        sttMedianMs: medianOf(this.sttLatencies),
        llmTtftMedianMs: medianOf(this.llmTtfts),
        ttsTtfbMedianMs: medianOf(this.ttsTtfbs),
        totalTurnMedianMs: medianOf(this.totalTurns),
        audioMedianMs: medianOf(this.audioDurations),
      },
      usdPerInr,
    };
  }
}

/**
 * Collapses every turn into one row per (leg, provider, model). Costs are summed
 * from the per-turn numbers rather than re-derived, so a rate that changed
 * mid-conversation cannot make the total disagree with the rows above it.
 */
function totalsByLeg(turns: TurnUsage[]): LegUsage[] {
  const byKey = new Map<string, LegUsage>();

  for (const turn of turns) {
    for (const leg of turn.legs) {
      // Unit is part of the key: summing seconds into characters would be silent nonsense.
      const key = `${leg.leg}|${leg.providerId}|${leg.modelId}|${leg.unit}`;
      const acc = byKey.get(key);
      if (!acc) {
        byKey.set(key, { ...leg, cost: leg.cost ? { ...leg.cost } : undefined });
        continue;
      }
      acc.inputUnits = round(acc.inputUnits + leg.inputUnits, 4);
      acc.outputUnits = round(acc.outputUnits + leg.outputUnits, 4);
      if (leg.thinkingTokens !== undefined) acc.thinkingTokens = (acc.thinkingTokens ?? 0) + leg.thinkingTokens;
      if (leg.cachedInputTokens !== undefined) {
        acc.cachedInputTokens = (acc.cachedInputTokens ?? 0) + leg.cachedInputTokens;
      }
      if (leg.audioSeconds !== undefined) acc.audioSeconds = round((acc.audioSeconds ?? 0) + leg.audioSeconds, 3);
      // The audio/text token split, kept summed alongside the totals it sits
      // inside. Dropping these would leave a realtime total that no longer
      // reproduces its own cost.
      if (leg.audioInputTokens !== undefined) acc.audioInputTokens = (acc.audioInputTokens ?? 0) + leg.audioInputTokens;
      if (leg.audioOutputTokens !== undefined) {
        acc.audioOutputTokens = (acc.audioOutputTokens ?? 0) + leg.audioOutputTokens;
      }
      if (leg.cachedAudioInputTokens !== undefined) {
        acc.cachedAudioInputTokens = (acc.cachedAudioInputTokens ?? 0) + leg.cachedAudioInputTokens;
      }
      // A single 'local' turn makes the total an estimate, so it wins.
      if (leg.source === 'local') acc.source = 'local';
      if (leg.unpricedReason && !acc.unpricedReason) acc.unpricedReason = leg.unpricedReason;
      if (acc.cost && leg.cost) {
        acc.cost.amount = round(acc.cost.amount + leg.cost.amount, 8);
        acc.cost.amountUsd = round(acc.cost.amountUsd + leg.cost.amountUsd, 8);
        acc.cost.amountInr = round(acc.cost.amountInr + leg.cost.amountInr, 6);
      }
    }
  }

  return [...byKey.values()];
}

function latencyOf(values: number[]): SessionSummary['latency'] {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  return {
    ttfaMedianMs: median(sorted),
    ttfaP95Ms: percentile(sorted, 0.95),
    ttfaMinMs: sorted[0],
    ttfaMaxMs: sorted[sorted.length - 1],
  };
}

/**
 * Median of an unsorted sample, or undefined when there is nothing to take one
 * of. Undefined rather than 0: a realtime session genuinely has no STT leg, and
 * a zero there would render as a measurement of instant transcription.
 */
function medianOf(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return median([...values].sort((a, b) => a - b));
}

/** True median: the midpoint of the middle pair on an even count, not the upper one. */
function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2, 1);
}

/** Nearest-rank: the smallest observation at or above the given fraction. */
function percentile(sorted: number[], q: number): number {
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (n: number, dp = 8) => Number(n.toFixed(dp));
