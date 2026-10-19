import type { SessionSummary } from '../lib/protocol';
import type { ProviderEntry } from '../lib/catalog';
import { duration, when } from '../lib/format';
import { downloadJson } from '../lib/download';
import { SessionReport } from './SessionReport';
import { ErrorBoundary } from './ErrorBoundary';
import { PageHeader } from './PageHeader';
import { Icon } from './Icon';

/**
 * One filed conversation, as a page of its own: the report you land on when a
 * conversation ends, and the page a run in the Runs list opens.
 */
export function RunDetailView({
  summary,
  justEnded,
  providers = [],
  onBackToRuns,
  onBackToBench,
}: {
  summary: SessionSummary;
  /** True when this is the conversation that just ended on the bench. */
  justEnded: boolean;
  /** For readable provider names; ids are shown until the catalog arrives. */
  providers?: ProviderEntry[];
  onBackToRuns: () => void;
  onBackToBench: () => void;
}) {
  const { config } = summary;
  const language =
    config.language ??
    (config.sttLanguage || config.ttsLanguage
      ? `${config.sttLanguage ?? 'auto'} in, ${config.ttsLanguage ?? 'auto'} out`
      : undefined);
  const voice = config.voice;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Runs', onSelect: onBackToRuns }, { label: when(summary.startedAt) }]}
        // The backend files nothing for a conversation with no turns, so only a
        // conversation that ran one may say it was filed.
        eyebrow={
          justEnded
            ? summary.turnCount > 0
              ? 'Mischief managed · filed to disk'
              : 'No turns ran · nothing was filed'
            : undefined
        }
        title={runChainName(summary, providers)}
        sub={
          <>
            <span className="run-label">{summary.label}</span>
            <span className="run-meta">
              {`${duration(summary.durationMs)} · ${summary.turnCount} ${summary.turnCount === 1 ? 'turn' : 'turns'}`}
              {language && ` · language ${language}`}
              {voice && (
                <>
                  {' · '}
                  <span title={voice}>{`voice ${voice.length > 16 ? `${voice.slice(0, 8)}…` : voice}`}</span>
                </>
              )}
            </span>
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="ghost"
              title={`The whole record, as ${summary.recordId}.json`}
              onClick={() => downloadJson(summary, `session-${summary.recordId}.json`)}
            >
              <Icon name="download" size={14} />
              Export JSON
            </button>
            <button type="button" className="btn primary" onClick={onBackToBench}>
              Back to bench
            </button>
          </>
        }
      />
      <ErrorBoundary panel="Conversation report">
        <SessionReport
          summary={summary}
          providers={providers}
          title={justEnded ? 'Conversation report' : 'Past conversation'}
        />
      </ErrorBoundary>
    </>
  );
}

/**
 * The rig as a readable chain of provider names. Taken from the config's ids;
 * a record whose config predates those fields still has its label, which is
 * the same chain as `provider:model → …`.
 */
function runChainName(summary: SessionSummary, providers: ProviderEntry[]): string {
  const c = summary.config;
  const fromConfig =
    summary.mode === 'realtime'
      ? [c.realtimeProviderId]
      : [c.sttProviderId, c.llmProviderId, c.ttsProviderId];
  const ids = fromConfig.every(Boolean)
    ? (fromConfig as string[])
    : summary.label
        .split('→')
        .map((part) => part.trim().split(':')[0])
        .filter(Boolean);
  if (ids.length === 0) return 'Conversation';
  return ids.map((id) => providers.find((p) => p.id === id)?.name ?? id).join(' → ');
}
