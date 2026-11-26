import { useEffect, useState, type FormEvent } from 'react';
import {
  addAllowEntry,
  fetchAllowlist,
  removeAllowEntry,
  type AllowEntry,
  type AllowlistState,
  type AllowTarget,
} from '../lib/auth';
import { when } from '../lib/format';
import { PageHeader } from './PageHeader';
import { Icon } from './Icon';
import { Select } from './Select';
import { TextField } from './TextField';

type Api = {
  fetch: () => Promise<AllowlistState>;
  add: (t: AllowTarget) => Promise<AllowlistState>;
  remove: (t: AllowTarget) => Promise<AllowlistState>;
};

const KINDS = [
  { id: 'domain', name: 'Whole domain' },
  { id: 'email', name: 'Single address' },
];

const defaultApi: Api = { fetch: fetchAllowlist, add: addAllowEntry, remove: removeAllowEntry };

/**
 * Who may sign in with Google — admins only.
 *
 * Pinned domains come from AUTH_ALLOWED_DOMAINS on the server and are shown
 * but not removable here, so a slip cannot lock everyone out. Everything an
 * admin adds is a whole domain or one address. Removing one signs its people
 * out at once (the server revokes their sessions), which the confirmation says.
 */
export function AccessPage({ api = defaultApi, initial }: { api?: Api; initial?: AllowlistState }) {
  const [state, setState] = useState<AllowlistState | null>(initial ?? null);
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<AllowEntry['kind']>('domain');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initial) return;
    api
      .fetch()
      .then((s) => {
        setState(s);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, [api, initial]);

  const run = async (fn: () => Promise<AllowlistState>) => {
    setBusy(true);
    setError(undefined);
    try {
      setState(await fn());
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    if (await run(() => api.add({ kind, value: v }))) setValue('');
  };

  const onRemove = (entry: AllowEntry) => {
    const who = entry.kind === 'domain' ? `everyone at @${entry.value}` : entry.value;
    if (!window.confirm(`Remove ${entry.value}? ${who} will be signed out now.`)) return;
    void run(() => api.remove({ kind: entry.kind, value: entry.value }));
  };

  const entries = state?.entries ?? [];

  return (
    <div className="access">
      <PageHeader
        title="Access"
        sub="Google accounts on these domains, or these exact addresses, can sign in and use every rig. Only admins see this page."
      />

      {error && (
        <div className="banner error page-banner" role="alert">
          {error}
        </div>
      )}

      <section className="panel">
        <h2>
          <Icon name="shield" size={18} className="panel-icon" />
          Allowed to sign in
          {state && <span className="right">{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>}
        </h2>

        {!state && !error && <p className="access-empty">Loading…</p>}

        {state && (
          <div className="table-scroll">
            <table className="access-table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Kind</th>
                  <th>Added</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={`${e.kind}:${e.value}`}>
                    <td className="strong mono">{e.kind === 'domain' ? `@${e.value}` : e.value}</td>
                    <td>{e.kind === 'domain' ? 'Domain' : 'Address'}</td>
                    <td className="access-added">
                      {e.source === 'env'
                        ? 'Pinned (AUTH_ALLOWED_DOMAINS)'
                        : [e.addedBy, e.addedAt ? when(e.addedAt) : undefined]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                    </td>
                    <td>
                      {e.source === 'admin' ? (
                        <button
                          type="button"
                          className="ghost inline danger"
                          disabled={busy}
                          onClick={() => onRemove(e)}
                          aria-label={`Remove ${e.value}`}
                        >
                          Remove
                        </button>
                      ) : (
                        <span className="access-pinned" title="Change AUTH_ALLOWED_DOMAINS on the server to remove">
                          <Icon name="lock" size={13} /> Pinned
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={4} className="access-empty">
                      Nobody can sign in with Google yet. Add a domain below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <form className="access-add" onSubmit={(e) => void onAdd(e)}>
          <Select
            label="Kind"
            value={kind}
            options={KINDS}
            onChange={(id) => setKind(id as AllowEntry['kind'])}
            disabled={busy}
          />
          <div className="access-value">
            <TextField
              label={kind === 'domain' ? 'Domain' : 'Email address'}
              type={kind === 'domain' ? 'text' : 'email'}
              mono
              value={value}
              placeholder={kind === 'domain' ? 'partner.com' : 'someone@gmail.com'}
              onChange={setValue}
              disabled={busy}
            />
          </div>
          <button type="submit" className="btn primary" disabled={busy || !value.trim()}>
            <Icon name="plus" size={16} />
            Add
          </button>
        </form>

        {state && state.adminEmails.length > 0 && (
          <p className="access-note">
            Admins by AUTH_ADMIN_EMAILS (may edit this list): <span className="mono">{state.adminEmails.join(', ')}</span>
          </p>
        )}
      </section>
    </div>
  );
}
