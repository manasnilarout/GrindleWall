import type { ReactNode } from 'react';

export interface Crumb {
  label: string;
  /** Omitted for the current page, which is text rather than a link. */
  onSelect?: () => void;
}

/**
 * The top of every view: optional breadcrumbs and eyebrow, the title in
 * Cinzel, a line of context, and the view's own actions on the right, closed
 * off by the double gold rule.
 *
 * One component so the three views cannot drift into three different headers,
 * which is how the old top bar ended up holding twelve unrelated things.
 */
export function PageHeader({
  title,
  eyebrow,
  crumbs,
  sub,
  badges,
  actions,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  crumbs?: Crumb[];
  sub?: ReactNode;
  /** Small pills beside the title (mode, state). */
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-heading">
        {crumbs && crumbs.length > 0 && (
          <nav className="page-crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="page-crumbs">
                {i > 0 && <span aria-hidden="true">›</span>}
                {c.onSelect ? (
                  <button type="button" onClick={c.onSelect}>
                    {c.label}
                  </button>
                ) : (
                  <span aria-current="page">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <div className="page-title-row">
          <h1 className="page-title">{title}</h1>
          {badges}
        </div>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
