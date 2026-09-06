import type { Rig } from '../lib/rigs';
import { rigColor } from '../lib/rigs';
import { ms } from '../lib/format';
import { Icon } from './Icon';

export interface RigScore {
  /** Median TTFA of the last run of this rig, in this browser session. */
  ttfaMedianMs?: number;
  turns: number;
}

/**
 * The rig switcher.
 *
 * Each tab carries the rig's own median TTFA, so the comparison the bench
 * exists for is on screen before you click anything — and switching rig is one
 * click rather than rebuilding eight dropdowns from memory.
 *
 * A rig cannot be changed while its session is live, so the tabs lock during a
 * run: swapping the config under a connected socket would leave the numbers
 * attributed to a combination that never produced them.
 */
export function RigTabs({
  rigs,
  activeId,
  scores,
  locked,
  onSelect,
  onAdd,
  onCompare,
}: {
  rigs: Rig[];
  activeId: string;
  scores: Record<string, RigScore>;
  locked: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onCompare: () => void;
}) {
  return (
    <div className="rig-strip">
      {rigs.map((rig) => {
        const score = scores[rig.id];
        const active = rig.id === activeId;
        return (
          <button
            key={rig.id}
            type="button"
            className={`rig-tab ${active ? 'on' : ''}`}
            // The active rig stays clickable while locked — clicking it is a no-op,
            // and disabling it would grey out the label you are reading.
            disabled={locked && !active}
            title={locked && !active ? 'End the conversation to switch rig' : rig.name}
            onClick={() => onSelect(rig.id)}
          >
            <span className="dot" style={{ background: rigColor(rig) }} />
            {rig.name}
            <span className="rig-ttfa">
              {score?.ttfaMedianMs !== undefined ? `${ms(score.ttfaMedianMs)} ms` : '—'}
            </span>
          </button>
        );
      })}

      <button type="button" className="rig-add" onClick={onAdd} disabled={locked} title="Add a rig">
        <Icon name="plus" size={11} />
        rig
      </button>

      <span className="spacer" />
      <button type="button" className="ghost inline" onClick={onCompare}>
        <Icon name="snitch" size={11} />
        Compare runs
      </button>
    </div>
  );
}
