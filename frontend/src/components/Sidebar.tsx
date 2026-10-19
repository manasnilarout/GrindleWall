import type { ProviderEntry } from '../lib/catalog';
import { chainOf, rigColor, rigLetter, type Rig } from '../lib/rigs';
import { ms } from '../lib/format';
import { Icon } from './Icon';

/** The two places you navigate to. A run's detail page is reached from Runs, not from here. */
export type NavView = 'bench' | 'runs';

/** What the sidebar can honestly say about the backend: whether the catalog came back. */
export type BackendStatus = 'loading' | 'ready' | 'unreachable';

export interface RigScore {
  /** Median TTFA of the last run of this rig, in this browser session. */
  ttfaMedianMs?: number;
  turns: number;
}

/**
 * Navigation and the rig switcher, in one rail.
 *
 * Rigs used to be a strip of tabs under a top bar that also held the view
 * switch, the chain, the session id, the state badge and sign-out. Here the
 * rail answers "where am I" and "which rig" and nothing else; everything about
 * the current page lives in that page's header.
 *
 * Each rig carries its own median TTFA, so the A/B is visible before you click
 * anything. The rigs lock during a live session: swapping the config under a
 * connected socket would attribute the numbers to a combination that never
 * produced them.
 */
export function Sidebar({
  view,
  onNavigate,
  rigs,
  activeRigId,
  providers,
  scores,
  locked,
  onSelectRig,
  onAddRig,
  backend,
  username,
  onLogout,
}: {
  /** Which nav entry is current. The run detail page counts as Runs. */
  view: NavView;
  onNavigate: (view: NavView) => void;
  rigs: Rig[];
  activeRigId: string;
  providers: ProviderEntry[];
  scores: Record<string, RigScore>;
  locked: boolean;
  onSelectRig: (id: string) => void;
  onAddRig: () => void;
  /** From the catalog fetch at load. Not a heartbeat — hence "catalog loaded", not "online". */
  backend: BackendStatus;
  username?: string;
  onLogout?: () => void;
}) {
  const activeName = rigs.find((r) => r.id === activeRigId)?.name;

  return (
    <nav className="sidebar" aria-label="Main">
      <span className="brand">
        <img className="brand-logo" src="/magickvoice-logo.png" alt="MagickVoice" />
        <span className="brand-copy">
          <span className="brand-name">Grindelwald</span>
          <span className="brand-byline">powered by MagickVoice</span>
        </span>
      </span>

      <div className="side-nav">
        <button
          type="button"
          className="side-link"
          aria-current={view === 'bench' ? 'page' : undefined}
          onClick={() => onNavigate('bench')}
        >
          <Icon name="wand" size={18} />
          Bench
        </button>
        <button
          type="button"
          className="side-link"
          aria-current={view === 'runs' ? 'page' : undefined}
          onClick={() => onNavigate('runs')}
        >
          <Icon name="scroll" size={18} />
          Runs
        </button>
      </div>

      <div className="side-section">
        <div className="side-section-head">
          <span className="side-section-title" id="rigs-title">
            Rigs
          </span>
          <button
            type="button"
            className="side-icon-btn"
            onClick={onAddRig}
            disabled={locked || providers.length === 0}
            aria-label="Add a rig"
            title="Add a rig"
          >
            <Icon name="plus" size={16} />
          </button>
        </div>

        <div role="list" aria-labelledby="rigs-title" className="side-section">
          {rigs.map((rig) => {
            const active = rig.id === activeRigId;
            const score = scores[rig.id];
            const chain = providers.length ? chainOf(rig, providers).join(' · ') : '';
            return (
              <div role="listitem" key={rig.id}>
                <button
                  type="button"
                  className={`rig-item ${active ? 'on' : ''}`}
                  aria-current={active ? 'true' : undefined}
                  // The active rig stays clickable while locked — clicking it is a
                  // no-op, and disabling it would grey out the label you are reading.
                  disabled={locked && !active}
                  title={locked && !active ? 'End the conversation to switch rig' : chain || rig.name}
                  onClick={() => onSelectRig(rig.id)}
                >
                  <span className="rig-badge" style={{ background: rigColor(rig) }} aria-hidden="true">
                    {rigLetter(rig)}
                  </span>
                  <span className="rig-item-body">
                    <span className="rig-item-name">{rig.name}</span>
                    {chain && <span className="rig-item-chain">{chain}</span>}
                  </span>
                  {/* Nothing until it has run here: a lone dash at the row's end read as a remove control. */}
                  {score?.ttfaMedianMs !== undefined && (
                    <span className="rig-item-ms" title="Median time to first audio in this tab">
                      {`${ms(score.ttfaMedianMs)} ms`}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {locked && (
          <p className="side-note">
            <Icon name="lock" size={13} />
            {activeName ? `Locked while ${activeName} is live` : 'Locked while live'}
          </p>
        )}
      </div>

      <div className="side-sky" aria-hidden="true">
        <svg width="180" height="96" viewBox="0 0 180 96" fill="var(--gold)">
          <path d="M126 14a24 24 0 1 0 26 32a19 19 0 1 1 -26 -32z" opacity="0.9" />
          <path d="M44 40l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" opacity="0.85" />
          <path d="M92 70l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" opacity="0.7" />
          <circle cx="18" cy="18" r="1.4" opacity="0.7" />
          <circle cx="70" cy="14" r="1.1" opacity="0.6" />
          <circle cx="96" cy="34" r="1.6" opacity="0.8" />
          <circle cx="160" cy="76" r="1.2" opacity="0.6" />
          <circle cx="24" cy="78" r="1.6" opacity="0.5" />
          <circle cx="140" cy="88" r="1" opacity="0.6" />
        </svg>
        <span className="side-motto">I solemnly swear I am up to no good</span>
      </div>

      <div className="side-foot">
        <div className="side-status" title="Checked once, when the page loaded">
          <span className={`dot ${backend === 'ready' ? '' : backend === 'loading' ? 'wait' : 'off'}`} />
          <span>
            {backend === 'ready' ? 'Catalog loaded' : backend === 'loading' ? 'Reaching backend…' : 'Backend unreachable'}
          </span>
          <span className="fmt">24 kHz PCM16</span>
        </div>
        {(username || onLogout) && (
          <div className="side-user">
            {username && (
              <>
                <span className="side-avatar" aria-hidden="true">
                  {username.slice(0, 1).toUpperCase()}
                </span>
                <span className="side-username" title={username}>
                  {username}
                </span>
              </>
            )}
            {onLogout && (
              <button type="button" className="side-signout" onClick={onLogout}>
                <Icon name="logout" size={15} />
                Sign out
              </button>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
