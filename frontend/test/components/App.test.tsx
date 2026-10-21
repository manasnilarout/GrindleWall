// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App, { Bench } from '../../src/App';
import { AUTH_STORAGE_KEY } from '../../src/lib/auth';
import { normalizeSummary } from '../../src/lib/session';
import { startConfigOf, withDefaults, blankRig, type Rig } from '../../src/lib/rigs';
import type { SessionSummary } from '../../src/lib/protocol';
import { FakeWebSocket, lastSocket, resetFakes } from './fakes';
import { SYNTHETIC, pickerProviders, pipelineTurn, routedFetch, runRows, type FakeResponseInit, type Route } from './fixtures';

vi.mock('../../src/audio/player', async () => ({ AudioSink: (await import('./fakes')).FakeAudioSink }));
vi.mock('../../src/audio/recorder', async () => ({ MicRecorder: (await import('./fakes')).FakeMicRecorder }));

const DEFAULT_PROMPT = 'You are a voice assistant. Answer in one or two short sentences. Never use lists or markdown.';
const RIGS_KEY = 'bench.rigs.v1';
const SECRET = 's3cret';

const gated = { required: true, username: 'admin@magickvoice.com', sessionTtlMs: 3_600_000, hmacSecret: SECRET };
const open = { required: false, username: 'admin@magickvoice.com', sessionTtlMs: 3_600_000 };

const records: Record<string, SessionSummary> = Object.fromEntries(
  runRows.map((r) => [r.recordId, normalizeSummary({ ...SYNTHETIC, recordId: r.recordId, label: r.label, mode: r.mode })]),
);

interface Backend {
  auth?: typeof gated | typeof open;
  catalog?: () => FakeResponseInit;
  extra?: Route;
}
function backend({ auth = open, catalog, extra }: Backend = {}) {
  const fetch = routedFetch(async (url, init) => {
    const custom = await extra?.(url, init);
    if (custom) return custom;
    if (url === '/api/auth/config') return { body: auth };
    if (url === '/api/auth/session') return { body: {} };
    if (url === '/api/auth/login') {
      return { body: { token: 'tok', username: 'admin@magickvoice.com', expiresAt: Date.now() + 3_600_000 } };
    }
    if (url === '/api/auth/logout') return { body: {} };
    if (url === '/api/catalog') return catalog ? catalog() : { body: { sampleRate: 24000, providers: pickerProviders } };
    if (url === '/api/sessions') return { body: { sessions: runRows } };
    const m = /^\/api\/sessions\/([^/?]+)$/.exec(url);
    if (m && records[decodeURIComponent(m[1])]) return { body: records[decodeURIComponent(m[1])] };
    return undefined;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const calls = (fetch: ReturnType<typeof backend>, url: string) => fetch.mock.calls.filter((c) => c[0] === url);

const nav = () => screen.getByRole('navigation', { name: 'Main' });
const navButton = (name: RegExp) => within(nav()).getByRole('button', { name });
const rigItem = (name: string) => within(screen.getByRole('list', { name: 'Rigs' })).getByText(name).closest('button') as HTMLButtonElement;
const title = () => screen.getByRole('heading', { level: 1 }).textContent;
const savedRigs = () => JSON.parse(localStorage.getItem(RIGS_KEY) ?? 'null') as { rigs: Rig[]; activeId: string } | null;

async function onBench() {
  render(<App />);
  await screen.findByRole('navigation', { name: 'Main' });
  await waitFor(() => expect(title()).toBe('Rig A'));
}

describe('App', () => {
  beforeEach(() => {
    resetFakes();
    localStorage.clear();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
    localStorage.clear();
  });

  describe('auth gate', () => {
    it('shows the splash while the auth config is in flight', () => {
      backend({ extra: (url) => (url === '/api/auth/config' ? new Promise(() => {}) : undefined) });
      const { container } = render(<App />);
      expect(container.querySelector('.splash')).toBeTruthy();
      expect(screen.getByText('Grindelwald')).toBeTruthy();
      expect(screen.queryByRole('navigation')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
    });

    it('a gated backend shows the login page; signing in opens the bench with the user and Sign out', async () => {
      const fetch = backend({ auth: gated });
      render(<App />);
      await screen.findByRole('heading', { name: 'Sign in' });
      expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('admin@magickvoice.com');
      expect(screen.getByText(/the session lasts 1 hour\./)).toBeTruthy();
      // Nothing behind the gate is fetched yet.
      expect(calls(fetch, '/api/catalog')).toHaveLength(0);

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      await screen.findByRole('navigation', { name: 'Main' });
      expect(within(nav()).getByText('admin@magickvoice.com')).toBeTruthy();
      expect(calls(fetch, '/api/auth/login')).toHaveLength(1);
      // The catalog is fetched with the new token.
      await waitFor(() => expect(calls(fetch, '/api/catalog')).toHaveLength(1));
      expect((calls(fetch, '/api/catalog')[0][1]?.headers as Headers).get('Authorization')).toBe('Bearer tok');

      fireEvent.click(within(nav()).getByRole('button', { name: /Sign out/ }));
      await screen.findByRole('heading', { name: 'Sign in' });
      expect(calls(fetch, '/api/auth/logout')).toHaveLength(1);
      expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    });

    it('a refused sign-in stays on the login page with an alert', async () => {
      backend({ auth: gated, extra: (url) => (url === '/api/auth/login' ? { status: 401, body: { error: 'Wrong password.' } } : undefined) });
      render(<App />);
      await screen.findByRole('heading', { name: 'Sign in' });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      expect((await screen.findByRole('alert')).textContent).toBe('Wrong password.');
      expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    });

    it('a 401 from the catalog kicks a signed-in user back to the login page', async () => {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'old', username: 'admin@magickvoice.com', expiresAt: Date.now() + 600_000 }));
      backend({ auth: gated, catalog: () => ({ status: 401 }) });
      render(<App />);
      await screen.findByRole('heading', { name: 'Sign in' });
      expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    });

    it('an ungated backend opens the bench directly with no Sign out', async () => {
      backend();
      await onBench();
      expect(within(nav()).queryByRole('button', { name: /Sign out/ })).toBeNull();
    });
  });

  describe('bench shell', () => {
    it('seeds three rigs from the catalog, saves them, and says the catalog loaded', async () => {
      backend();
      await onBench();
      expect(within(screen.getByRole('list', { name: 'Rigs' })).getAllByRole('listitem')).toHaveLength(3);
      expect(rigItem('Rig A').getAttribute('aria-current')).toBe('true');
      expect(within(nav()).getByText('Catalog loaded')).toBeTruthy();
      expect(navButton(/Bench/).getAttribute('aria-current')).toBe('page');
      const saved = savedRigs()!;
      expect(saved.rigs.map((r) => r.name)).toEqual(['Rig A', 'Rig B', 'Rig C']);
      expect(saved.activeId).toBe(saved.rigs[0].id);
      expect(saved.rigs[0]).toMatchObject({ sttProviderId: 'mock-stt', llmProviderId: 'mock-llm', ttsProviderId: 'sarvam-tts', voice: 'priya' });
    });

    it('restores saved rigs and the active one, healing them against the catalog', async () => {
      const a = { ...blankRig('Kept A', 0), id: 'keep-a' };
      const b = { ...blankRig('Kept B', 4), id: 'keep-b', ttsProviderId: 'murf-tts', ttsModelId: 'falcon-2' };
      localStorage.setItem(RIGS_KEY, JSON.stringify({ rigs: [a, b], activeId: 'keep-b' }));
      backend();
      render(<App />);
      await waitFor(() => expect(title()).toBe('Kept B'));
      expect(rigItem('Kept B').querySelector('.rig-badge')?.textContent).toBe('E');
      expect(savedRigs()!.rigs[1]).toEqual(withDefaults(b, pickerProviders));
    });

    it('a saved active id that no longer exists falls back to the first rig', async () => {
      localStorage.setItem(RIGS_KEY, JSON.stringify({ rigs: [{ ...blankRig('Only', 0), id: 'only' }], activeId: 'gone' }));
      backend();
      render(<App />);
      await waitFor(() => expect(title()).toBe('Only'));
    });

    it('a backend it cannot reach is an alert, and no rig is shown', async () => {
      backend({ catalog: () => ({ status: 500 }) });
      render(<App />);
      expect((await screen.findByRole('alert')).textContent).toBe('Cannot reach the backend: Catalog request failed: 500');
      expect(within(nav()).getByText('Backend unreachable')).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Session controls' })).toBeNull();
      expect((within(nav()).getByRole('button', { name: 'Add a rig' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('the console is at the shell, docked, and expands the layout when opened', async () => {
      backend();
      const { container } = render(<App />);
      await waitFor(() => expect(title()).toBe('Rig A'));
      const shell = container.querySelector('.shell')!;
      expect(shell.className).toBe('shell ');
      fireEvent.click(within(screen.getByRole('region', { name: 'Console' })).getByRole('button', { name: /Open/ }));
      expect(shell.className).toBe('shell console-open');
      expect(screen.getByLabelText('Filter console lines')).toBeTruthy();
      fireEvent.click(within(screen.getByRole('region', { name: 'Console' })).getByRole('button', { name: /Close/ }));
      expect(shell.className).toBe('shell ');
    });
  });

  describe('rigs', () => {
    it('switches rig from the sidebar', async () => {
      backend();
      await onBench();
      fireEvent.click(rigItem('Rig B'));
      expect(title()).toBe('Rig B');
      expect(savedRigs()!.activeId).toBe(savedRigs()!.rigs[1].id);
    });

    it('adds a rig with the next letter and colour, opens it on the bench, and deletes it again', async () => {
      backend();
      await onBench();
      fireEvent.click(navButton(/Runs/));
      fireEvent.click(within(nav()).getByRole('button', { name: 'Add a rig' }));
      expect(title()).toBe('Rig D');
      expect(rigItem('Rig D').querySelector('.rig-badge')?.textContent).toBe('D');
      expect(savedRigs()!.rigs).toHaveLength(4);
      fireEvent.click(screen.getByRole('button', { name: /Delete rig/ }));
      expect(savedRigs()!.rigs.map((r) => r.name)).toEqual(['Rig A', 'Rig B', 'Rig C']);
      expect(title()).toBe('Rig A');
    });

    /*
     * `addRig` takes the session's high-water mark, deleted rigs included, so
     * deleting the most recently added rig does not hand its colour index —
     * and letter — to the next one (`Rig.colorIndex`: "never reused within a
     * session").
     */
    it('a colour is never reused after a delete', async () => {
      backend();
      await onBench();
      fireEvent.click(rigItem('Rig C'));
      fireEvent.click(screen.getByRole('button', { name: /Delete rig/ }));
      fireEvent.click(within(nav()).getByRole('button', { name: 'Add a rig' }));
      // The high-water mark was C (2), so the new one is D, not a second C.
      expect(title()).toBe('Rig D');
    });

    it('deleting a rig that is not active keeps the active one', async () => {
      backend();
      await onBench();
      fireEvent.click(rigItem('Rig B'));
      fireEvent.click(screen.getByRole('button', { name: /Delete rig/ }));
      expect(title()).toBe('Rig A');
    });

    it('the last rig cannot be deleted', async () => {
      localStorage.setItem(RIGS_KEY, JSON.stringify({ rigs: [{ ...blankRig('Solo', 0), id: 'solo' }], activeId: 'solo' }));
      backend();
      render(<App />);
      await waitFor(() => expect(title()).toBe('Solo'));
      expect(screen.queryByRole('button', { name: /Delete rig/ })).toBeNull();
    });

    it('renames the active rig in the sidebar and in storage', async () => {
      backend();
      await onBench();
      fireEvent.click(screen.getByRole('button', { name: 'Rename rig' }));
      const input = screen.getByLabelText('Rig name');
      fireEvent.change(input, { target: { value: 'Murf probe' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(title()).toBe('Murf probe');
      expect(rigItem('Murf probe')).toBeTruthy();
      expect(savedRigs()!.rigs[0].name).toBe('Murf probe');
    });

    it('edits the rig in the drawer and the rail follows', async () => {
      backend();
      const { container } = render(<App />);
      await waitFor(() => expect(title()).toBe('Rig A'));
      fireEvent.click(screen.getByRole('button', { name: /Edit rig/ }));
      const dialog = screen.getByRole('dialog', { name: 'Edit Rig A' });
      // The drawer's command carries the bench prompt.
      expect(dialog.querySelector('pre.codeblock')?.textContent).toContain(`SYSTEM='${DEFAULT_PROMPT}'`);
      fireEvent.click(within(dialog).getByRole('radio', { name: /Murf Falcon/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      const tts = [...container.querySelectorAll('.chain-card')][2];
      expect(tts.querySelector('.chain-provider')?.textContent).toBe('Murf Falcon');
      expect(savedRigs()!.rigs[0]).toMatchObject({ ttsProviderId: 'murf-tts', ttsModelId: 'falcon-2', voice: 'en-US-natalie' });
    });

    it('opens the voice-stack export with the bench\'s own prompt and turn detection, and closes it', async () => {
      const fetch = backend();
      await onBench();
      fireEvent.click(within(screen.getByRole('group', { name: 'Turn detection' })).getByRole('button', { name: 'Push to talk' }));
      fireEvent.click(screen.getByRole('button', { name: /Export voice stack/ }));
      const dialog = screen.getByRole('dialog', { name: 'Create code for Rig A' });
      await waitFor(() => expect(calls(fetch, '/api/sessions').length).toBeGreaterThan(0));
      // Push-to-talk on the bench is what the dialog refuses.
      expect(within(dialog).getByText(/Push-to-talk \(manual turn detection\) cannot be exported/)).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('views', () => {
    it('navigates to Runs and back from the sidebar', async () => {
      const fetch = backend();
      await onBench();
      fireEvent.click(navButton(/Runs/));
      expect(title()).toBe('Runs');
      expect(navButton(/Runs/).getAttribute('aria-current')).toBe('page');
      await screen.findByText(/^4 conversations on disk/);
      expect(calls(fetch, '/api/sessions')).toHaveLength(1);
      fireEvent.click(navButton(/Bench/));
      expect(title()).toBe('Rig A');
    });

    it('opens a run from Runs, and the crumb returns to Runs with the selection kept', async () => {
      backend();
      await onBench();
      fireEvent.click(navButton(/Runs/));
      await screen.findByText('Comparing 3 runs');
      const list = screen.getByRole('region', { name: 'All runs' });
      fireEvent.click(within(list).getByRole('button', { name: 'openai-realtime' }));
      await screen.findByRole('region', { name: 'Past conversation' });
      expect(title()).toBe('openai-realtime');
      // The run page counts as Runs in the sidebar.
      expect(navButton(/Runs/).getAttribute('aria-current')).toBe('page');
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', { name: 'Runs' }));
      expect(title()).toBe('Runs');
      await screen.findByText('Comparing 3 runs');
    });

    it('Back to bench from a run page', async () => {
      backend();
      await onBench();
      fireEvent.click(navButton(/Runs/));
      await screen.findByText('Comparing 3 runs');
      fireEvent.click(within(screen.getByRole('region', { name: 'All runs' })).getByRole('button', { name: 'openai-realtime' }));
      await screen.findByRole('region', { name: 'Past conversation' });
      fireEvent.click(screen.getByRole('button', { name: 'Back to bench' }));
      expect(title()).toBe('Rig A');
    });
  });

  describe('a live session', () => {
    async function connect() {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
      });
      const ws = lastSocket();
      act(() => ws.serverOpen());
      act(() => ws.serverSend({ type: 'session_started', sessionId: 's-1', mode: 'pipeline', sampleRate: 24000, label: 'mock chain' }));
      return ws;
    }

    it('starts the active rig with the bench prompt and turn detection', async () => {
      backend();
      await onBench();
      fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'Latency probe' } });
      fireEvent.click(within(screen.getByRole('group', { name: 'Turn detection' })).getByRole('button', { name: 'Push to talk' }));
      const ws = await connect();
      const rig = savedRigs()!.rigs[0];
      expect(ws.json[0]).toEqual({
        type: 'start',
        config: startConfigOf(rig, pickerProviders, 'Reply with exactly one short sentence, immediately, with no preamble.', 'manual'),
      });
    });

    it('locks the rig while live, scores it as turns land, and opens the report when the bill arrives', async () => {
      backend();
      await onBench();
      const ws = await connect();
      expect(screen.getByText('Live')).toBeTruthy();
      expect((screen.getByRole('button', { name: /Edit rig/ }) as HTMLButtonElement).disabled).toBe(true);
      expect(rigItem('Rig B').disabled).toBe(true);
      expect((within(nav()).getByRole('button', { name: 'Add a rig' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByLabelText('Preset') as HTMLSelectElement).disabled).toBe(true);

      act(() => ws.serverSend({ type: 'metrics', turnId: 1, marks: pipelineTurn.marks, derived: pipelineTurn.derived }));
      expect(within(rigItem('Rig A')).getByText('548 ms')).toBeTruthy();
      expect(screen.getByText(/1 turns run in this tab/)).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: /End and file report/ }));
      await waitFor(() => expect(ws.json.at(-1)).toEqual({ type: 'end_conversation' }));
      act(() => ws.serverSend({ type: 'session_summary', summary: SYNTHETIC }));
      act(() => ws.serverSend({ type: 'session_closed', reason: 'ended' }));

      await screen.findByText('Mischief managed · filed to disk');
      expect(screen.getByRole('region', { name: 'Conversation report' })).toBeTruthy();
      // Unlocked once it has ended.
      expect(rigItem('Rig B').disabled).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Back to bench' }));
      expect(title()).toBe('Rig A');
      expect(screen.getByText('Ended')).toBeTruthy();
    });

    it('a bill that lands while the user reads Runs does not yank them out', async () => {
      backend();
      await onBench();
      const ws = await connect();
      fireEvent.click(navButton(/Runs/));
      act(() => ws.serverSend({ type: 'session_summary', summary: SYNTHETIC }));
      expect(title()).toBe('Runs');
      // …and it is not held for later either.
      fireEvent.click(navButton(/Bench/));
      expect(title()).toBe('Rig A');
    });

    it('signing out mid-session drops the socket', async () => {
      backend({ auth: gated });
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'tok', username: 'admin@magickvoice.com', expiresAt: Date.now() + 600_000 }));
      render(<App />);
      await waitFor(() => expect(title()).toBe('Rig A'));
      const ws = await connect();
      await act(async () => {
        fireEvent.click(within(nav()).getByRole('button', { name: /Sign out/ }));
      });
      expect(ws.json.some((m) => m.type === 'stop')).toBe(true);
      expect(ws.closed).toBe(true);
      await screen.findByRole('heading', { name: 'Sign in' });
    });

    it('the connection error is logged to the console', async () => {
      backend();
      await onBench();
      const ws = await connect();
      await act(async () => ws.serverError());
      expect(screen.getByText('Error')).toBeTruthy();
      const latest = screen.getByRole('region', { name: 'Console' }).querySelector('.console-latest')!;
      expect(latest.textContent).toContain('WebSocket error — is the backend running on :8787?');
    });
  });

  describe('Bench without auth', () => {
    it('renders with a username and a logout handler', async () => {
      backend();
      const onLogout = vi.fn();
      render(<Bench username="ops@example.com" onLogout={onLogout} />);
      await waitFor(() => expect(title()).toBe('Rig A'));
      fireEvent.click(within(nav()).getByRole('button', { name: /Sign out/ }));
      expect(onLogout).toHaveBeenCalledTimes(1);
    });
  });
});
