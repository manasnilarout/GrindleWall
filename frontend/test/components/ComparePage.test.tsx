// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  ComparePage, CompareCard, Matrix, RunsTable, Verdicts, chainName, filterRuns, isMockRun, type RunsMemory, type Series,
} from '../../src/components/ComparePage';
import { normalizeSummary } from '../../src/lib/session';
import { RIG_COLORS } from '../../src/lib/rigs';
import type { SessionIndexEntry, SessionSummary } from '../../src/lib/protocol';
import { SYNTHETIC, namedProviders, routedFetch, runRows, type FakeResponseInit } from './fixtures';

vi.mock('../../src/lib/download', () => ({ downloadJson: vi.fn() }));
const { downloadJson } = await import('../../src/lib/download');

/** Full records behind each index row. */
const records: Record<string, SessionSummary> = {
  'real-a': normalizeSummary({ ...SYNTHETIC, recordId: 'real-a' }),
  'rt-b': normalizeSummary({
    ...SYNTHETIC, recordId: 'rt-b', mode: 'realtime', label: 'openai-realtime:gpt-realtime-2.1-mini', turnCount: 1,
    costUsd: 0.0015, unpriced: [], latency: { ttfaMedianMs: 1070, ttfaP95Ms: 1070, totalTurnMedianMs: 2900, audioMedianMs: 2400 },
  }),
  'mock-c': normalizeSummary({ ...SYNTHETIC, recordId: 'mock-c', label: runRows[2].label }),
  'old-d': normalizeSummary({ ...SYNTHETIC, recordId: 'old-d', latency: {}, turnCount: 0, costUsd: 0 }),
};

function serve({
  rows = runRows,
  list,
  record,
}: { rows?: SessionIndexEntry[]; list?: () => FakeResponseInit | Promise<FakeResponseInit>; record?: (id: string) => FakeResponseInit | undefined | Promise<FakeResponseInit | undefined> } = {}) {
  const fetch = routedFetch(async (url) => {
    if (url === '/api/sessions') return list ? list() : { body: { sessions: rows } };
    const m = /^\/api\/sessions\/([^/]+)$/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const custom = await record?.(id);
      if (custom) return custom;
      return records[id] ? { body: records[id] } : { status: 404 };
    }
    return undefined;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const calls = (fetch: ReturnType<typeof serve>, url: string) => fetch.mock.calls.filter((c) => c[0] === url).length;
const runOpen = (name: RegExp | string) => within(screen.getByRole('region', { name: 'All runs' })).getByRole('button', { name });
const tableRows = () => [...screen.getByRole('region', { name: 'All runs' }).querySelectorAll('tbody tr')] as HTMLTableRowElement[];

describe('ComparePage', () => {
  it('says it is loading before the listing lands, never that the disk is empty', () => {
    serve({ list: () => new Promise(() => {}) });
    render(<ComparePage onOpenReport={() => {}} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeTruthy();
    expect(screen.getByText('Loading runs…')).toBeTruthy();
    expect(screen.queryByText(/Nothing recorded yet/)).toBeNull();
    expect(screen.getByText('Tick a run or two to compare them.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Recordings/ })).toBeNull();
  });

  it('says nothing is recorded once an empty listing lands', async () => {
    serve({ rows: [] });
    render(<ComparePage onOpenReport={() => {}} />);
    await screen.findByText('Nothing recorded yet. Run a conversation first.');
    expect(screen.getByText(/^0 conversations on disk\./)).toBeTruthy();
  });

  it('a failed listing is an alert, and the loading note goes away', async () => {
    serve({ list: () => ({ status: 500 }) });
    render(<ComparePage onOpenReport={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot list sessions: HTTP 500');
    expect(screen.queryByText('Loading runs…')).toBeNull();
  });

  it('lists runs, hides mocks by default, preselects the newest real ones and fetches each once', async () => {
    const fetch = serve();
    render(<ComparePage onOpenReport={() => {}} providers={namedProviders} />);
    await screen.findByText(/^4 conversations on disk/);
    expect(tableRows()).toHaveLength(3);
    expect(screen.queryByText(runRows[2].label)).toBeNull();
    await screen.findByText('Comparing 3 runs');
    await waitFor(() => expect(screen.getByRole('heading', { name: /All numbers/ })).toBeTruthy());
    for (const id of ['real-a', 'rt-b', 'old-d']) expect(calls(fetch, `/api/sessions/${id}`)).toBe(1);
    expect(calls(fetch, '/api/sessions/mock-c')).toBe(0);
    // Badges in series order on the selected rows.
    const badges = tableRows().map((r) => r.querySelector('.series-badge')?.textContent);
    expect(badges).toEqual(['1', '2', '3']);
    expect(
      screen.getByLabelText('Compare Sarvam Saaras → Google Gemini → Murf Falcon (series 1)'),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: /What the crystal ball says/ })).toBeTruthy();
    expect(screen.getAllByLabelText(/^Recording of /)).toHaveLength(3);
  });

  it('deselecting keeps the others\' numbers, and reselecting takes the lowest free slot', async () => {
    serve();
    render(<ComparePage onOpenReport={() => {}} providers={namedProviders} />);
    await screen.findByText('Comparing 3 runs');
    const second = tableRows()[1].querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(second.checked).toBe(true);
    fireEvent.click(second);
    expect(screen.getByText('Comparing 2 runs')).toBeTruthy();
    expect(tableRows().map((r) => r.querySelector('.series-badge')?.textContent ?? null)).toEqual(['1', null, '3']);
    fireEvent.click(second);
    expect(tableRows().map((r) => r.querySelector('.series-badge')?.textContent ?? null)).toEqual(['1', '2', '3']);
  });

  it('Clear empties the comparison', async () => {
    serve();
    render(<ComparePage onOpenReport={() => {}} />);
    await screen.findByText('Comparing 3 runs');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Tick a run or two to compare them.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /All numbers/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Export \d+ as JSON/ })).toBeNull();
  });

  it('switches metric tabs as pressed toggles', async () => {
    serve();
    const { container } = render(<ComparePage onOpenReport={() => {}} providers={namedProviders} />);
    await screen.findByText('Comparing 3 runs');
    await waitFor(() => expect(container.querySelectorAll('.cmp-row').length).toBe(3));
    const metric = screen.getByRole('group', { name: 'Metric' });
    const tab = (n: string) => within(metric).getByRole('button', { name: n });
    expect(tab('First audio').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Bar is the median, tick is p95.')).toBeTruthy();
    fireEvent.click(tab('Per leg'));
    expect(tab('Per leg').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Legs overlap, so they do not add up to TTFA. Each is its own median.')).toBeTruthy();
    expect(screen.getByText('One model — no legs to split.')).toBeTruthy();
    expect(screen.getByText(/No per-leg medians on this record/)).toBeTruthy();
    fireEvent.click(tab('Cost'));
    expect(screen.getByText(/A run with an unpriced leg is a floor, not a bill/)).toBeTruthy();
    fireEvent.click(tab('Whole turn'));
    expect(screen.getByText('Whole turn · t0 to the last audio byte')).toBeTruthy();
    fireEvent.click(tab('Reply length'));
    expect(screen.getByText('Rendered audio per turn')).toBeTruthy();
  });

  it('filters by query, architecture and mocks, and Clear filters shows everything', async () => {
    serve();
    render(<ComparePage onOpenReport={() => {}} providers={namedProviders} />);
    await screen.findByText(/^4 conversations on disk/);
    const search = screen.getByPlaceholderText('Filter by provider, model or language');
    fireEvent.change(search, { target: { value: 'openai realtime' } });
    expect(tableRows()).toHaveLength(1);
    expect(await screen.findByText(/2 selected runs are hidden by the filters/)).toBeTruthy();
    fireEvent.change(search, { target: { value: '' } });

    const arch = screen.getByRole('group', { name: 'Architecture' });
    fireEvent.click(within(arch).getByRole('button', { name: 'Realtime' }));
    expect(within(arch).getByRole('button', { name: 'Realtime' }).getAttribute('aria-pressed')).toBe('true');
    expect(tableRows()).toHaveLength(1);
    fireEvent.click(within(arch).getByRole('button', { name: 'Pipeline' }));
    expect(tableRows()).toHaveLength(2);
    fireEvent.click(within(arch).getByRole('button', { name: 'All' }));

    const hideMock = screen.getByLabelText('Hide mock runs') as HTMLInputElement;
    expect(hideMock.checked).toBe(true);
    fireEvent.click(hideMock);
    expect(tableRows()).toHaveLength(4);

    fireEvent.change(search, { target: { value: 'no such vendor' } });
    expect(screen.getByText(/No run matches these filters — 4 are on disk\./)).toBeTruthy();
    fireEvent.click(hideMock);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(tableRows()).toHaveLength(4);
    expect((screen.getByLabelText('Hide mock runs') as HTMLInputElement).checked).toBe(false);
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('opens a loaded run straight away, without a second fetch', async () => {
    const fetch = serve();
    const onOpen = vi.fn();
    render(<ComparePage onOpenReport={onOpen} providers={namedProviders} />);
    await screen.findByText('Comparing 3 runs');
    await waitFor(() => expect(screen.getByRole('heading', { name: /All numbers/ })).toBeTruthy());
    fireEvent.click(runOpen('OpenAI Realtime'));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(records['rt-b']);
    expect(calls(fetch, '/api/sessions/rt-b')).toBe(1);
  });

  it('opens an unselected run by fetching its record, busy until it lands', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = serve({ record: async (id) => (id === 'mock-c' ? (await gate, { body: records['mock-c'] }) : undefined) });
    const onOpen = vi.fn();
    render(<ComparePage onOpenReport={onOpen} memory={{ filter: { query: '', mode: 'all', hideMock: false } }} />);
    await screen.findByText(/^4 conversations on disk/);
    const btn = runOpen('mock-stt → mock-llm → mock-tts') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await act(async () => release());
    await waitFor(() => expect(onOpen).toHaveBeenCalledExactlyOnceWith(records['mock-c']));
    expect(btn.disabled).toBe(false);
    expect(calls(fetch, '/api/sessions/mock-c')).toBe(1);
  });

  it('a record that will not open says so on its own line, apart from the listing', async () => {
    serve({ record: (id) => (id === 'mock-c' ? { status: 500 } : undefined) });
    const onOpen = vi.fn();
    render(<ComparePage onOpenReport={onOpen} memory={{ slots: { 'real-a': 0 }, filter: { query: '', mode: 'all', hideMock: false } }} />);
    await screen.findByText(/^4 conversations on disk/);
    fireEvent.click(runOpen('mock-stt → mock-llm → mock-tts'));
    expect(await screen.findByText('Could not open mock-c: HTTP 500')).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a selected record that will not load is counted, flagged, and not drawn', async () => {
    serve({ record: (id) => (id === 'old-d' ? { status: 404 } : undefined) });
    render(<ComparePage onOpenReport={() => {}} />);
    expect(await screen.findByText('Could not load old-d: HTTP 404')).toBeTruthy();
    expect(screen.getByText('Comparing 3 runs')).toBeTruthy();
    await screen.findByText('Loading 1 more…');
  });

  it('a run that resolves after the page is left does not navigate', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    serve({ record: async (id) => (id === 'mock-c' ? (await gate, { body: records['mock-c'] }) : undefined) });
    const onOpen = vi.fn();
    const { unmount } = render(<ComparePage onOpenReport={onOpen} memory={{ slots: { x: 0 }, filter: { query: '', mode: 'all', hideMock: false } }} />);
    await screen.findByText(/^4 conversations on disk/);
    fireEvent.click(runOpen('mock-stt → mock-llm → mock-tts'));
    unmount();
    await act(async () => release());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Refresh refetches the listing and the selected records, since records are rewritten', async () => {
    const fetch = serve();
    render(<ComparePage onOpenReport={() => {}} />);
    await screen.findByText('Comparing 3 runs');
    await waitFor(() => expect(calls(fetch, '/api/sessions/old-d')).toBe(1));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    });
    await waitFor(() => expect(calls(fetch, '/api/sessions')).toBe(2));
    await waitFor(() => expect(calls(fetch, '/api/sessions/real-a')).toBe(2));
    expect(calls(fetch, '/api/sessions/rt-b')).toBe(2);
  });

  it('only the newest of two overlapping listings may write', async () => {
    let first = true;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    serve({
      list: async () => {
        if (first) {
          first = false;
          await gate;
          return { body: { sessions: runRows.slice(0, 1) } };
        }
        return { body: { sessions: runRows } };
      },
    });
    render(<ComparePage onOpenReport={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await screen.findByText(/^4 conversations on disk/);
    await act(async () => releaseFirst());
    expect(screen.getByText(/^4 conversations on disk/)).toBeTruthy();
  });

  it('exports the compared records as JSON', async () => {
    serve();
    render(<ComparePage onOpenReport={() => {}} />);
    const btn = await screen.findByRole('button', { name: 'Export 3 as JSON' });
    fireEvent.click(btn);
    expect(downloadJson).toHaveBeenCalledWith(
      [records['real-a'], records['rt-b'], records['old-d']],
      expect.stringMatching(/^compare-3-runs-\d+\.json$/),
    );
  });

  it('remembers selection, metric and filter across a remount through the parent', async () => {
    serve();
    const memory: RunsMemory = {};
    const { unmount } = render(<ComparePage onOpenReport={() => {}} memory={memory} />);
    await screen.findByText('Comparing 3 runs');
    fireEvent.click(within(screen.getByRole('group', { name: 'Metric' })).getByRole('button', { name: 'Cost' }));
    fireEvent.change(screen.getByPlaceholderText('Filter by provider, model or language'), { target: { value: 'murf' } });
    fireEvent.click(tableRows()[0].querySelector('input[type="checkbox"]')!);
    unmount();
    expect(memory).toEqual({
      slots: { 'rt-b': 1, 'old-d': 2 },
      metricKey: 'cost',
      filter: { query: 'murf', mode: 'all', hideMock: true },
    });
    render(<ComparePage onOpenReport={() => {}} memory={memory} />);
    await screen.findByText('Comparing 2 runs');
    expect(within(screen.getByRole('group', { name: 'Metric' })).getByRole('button', { name: 'Cost' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByPlaceholderText('Filter by provider, model or language') as HTMLInputElement).value).toBe('murf');
  });

  it('the matrix opens a run with its full record', async () => {
    serve();
    const onOpen = vi.fn();
    render(<ComparePage onOpenReport={onOpen} providers={namedProviders} />);
    const matrix = await screen.findByRole('region', { name: /All numbers/ });
    fireEvent.click(within(matrix).getByRole('button', { name: 'OpenAI Realtime' }));
    expect(onOpen).toHaveBeenCalledWith(records['rt-b']);
  });
});

/* --------------------------- the parts, directly --------------------------- */

const pipe = records['real-a'];
const rt = records['rt-b'];
const series: Series[] = [
  { run: pipe, tag: { n: 1, color: RIG_COLORS[0], name: 'Sarvam Saaras → Google Gemini → Murf Falcon' } },
  { run: rt, tag: { n: 2, color: RIG_COLORS[1], name: 'OpenAI Realtime' } },
];

describe('RunsTable', () => {
  it('has one open button and one checkbox per row, and toggles/open by record id', () => {
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(
      <RunsTable rows={runRows} slots={{ 'real-a': 0 }} providers={namedProviders} onToggle={onToggle} onOpen={onOpen} opening="rt-b" />,
    );
    expect(container.querySelectorAll('.run-open')).toHaveLength(4);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
    fireEvent.click(screen.getByLabelText('Compare OpenAI Realtime'));
    expect(onToggle).toHaveBeenCalledWith('rt-b');
    // real-a and old-d share a label, so they share a name: the row decides which opens.
    fireEvent.click(screen.getAllByRole('button', { name: 'Sarvam Saaras → Google Gemini → Murf Falcon' })[1]);
    expect(onOpen).toHaveBeenCalledWith('old-d');
    expect((screen.getByRole('button', { name: 'OpenAI Realtime' }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).not.toContain('NaN');
    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0].className).toBe('on');
    expect(rows[0].querySelector('.pill.floor')?.getAttribute('title')).toBe('A floor, not a total: no rate on file for elevenlabs-tts:v3');
    expect(rows[1].querySelector('.tag')?.textContent).toBe('Realtime');
    // A record older than the latency field reads as dashes, and $ / turn with no turns as a dash.
    expect([...rows[3].querySelectorAll('td')].slice(4).map((td) => td.textContent)).toEqual(['—', '—', '—']);
  });
});

describe('CompareCard', () => {
  it('draws the median bar and p95 tick per run in its series colour, warning on a one-turn run', () => {
    const { container } = render(<CompareCard series={series} selectedCount={2} metricKey="ttfa" onMetric={() => {}} onClear={() => {}} />);
    expect(screen.getByText('Comparing 2 runs')).toBeTruthy();
    const fills = [...container.querySelectorAll('.cmp-fill')] as HTMLElement[];
    expect(fills.map((f) => f.style.background)).toEqual(['rgb(142, 31, 47)', 'rgb(42, 63, 122)']);
    expect(container.querySelector('.cmp-tick')?.getAttribute('title')).toBe('p95 1,403 ms');
    expect(screen.getByText('Based on 1 turn — read it as a rough figure.')).toBeTruthy();
    expect(container.textContent).not.toContain('NaN');
  });

  it('an unknown metric key falls back to first audio, and a run without the figure says so', () => {
    const noTtfa: Series[] = [{ ...series[0], run: { ...pipe, latency: {} } }];
    render(<CompareCard series={noTtfa} selectedCount={1} metricKey="bogus" onMetric={() => {}} onClear={() => {}} />);
    expect(screen.getByText(/Not measured: this run has no completed turn with a first audio figure\./)).toBeTruthy();
    expect(screen.getByText('Comparing 1 run')).toBeTruthy();
  });

  it('reports metric changes and Clear', () => {
    const onMetric = vi.fn();
    const onClear = vi.fn();
    render(<CompareCard series={series} selectedCount={2} metricKey="ttfa" onMetric={onMetric} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Per leg' }));
    expect(onMetric).toHaveBeenCalledWith('legs');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('the cost tab flags the unpriced run and states the per-1,000 figure', () => {
    const { container } = render(<CompareCard series={series} selectedCount={2} metricKey="cost" onMetric={() => {}} onClear={() => {}} />);
    expect(container.querySelectorAll('.cmp-row')[0].querySelector('.pill.floor')).toBeTruthy();
    expect(container.querySelectorAll('.cmp-row')[1].querySelector('.pill.floor')).toBeNull();
    expect(screen.getByText('$2.05 per 1,000 turns')).toBeTruthy();
  });
});

describe('Matrix', () => {
  it('renders nothing for one run', () => {
    const { container } = render(<Matrix series={series.slice(0, 1)} onOpen={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('marks the best of each column by more than colour, and never ranks a realtime transcript', () => {
    const withStt: Series[] = [series[0], { ...series[1], run: { ...rt, latency: { ...rt.latency, sttMedianMs: 90 } } }];
    const { container } = render(<Matrix series={withStt} onOpen={() => {}} />);
    const [pipeRow, rtRow] = [...container.querySelectorAll('tbody tr')];
    expect(pipeRow.querySelectorAll('td.win')).toHaveLength(4);
    expect(rtRow.querySelectorAll('td.win')).toHaveLength(2);
    expect(container.querySelectorAll('.sr-only')).toHaveLength(6);
    const rtCells = rtRow.querySelectorAll('td');
    expect(rtCells[4].textContent).toBe('90');
    expect(rtCells[4].className).toBe('muted');
    expect(pipeRow.querySelector('.pill.floor')).toBeTruthy();
    expect(rtRow.querySelector('.pill.floor')).toBeNull();
  });
});

describe('Verdicts', () => {
  it('asks for two runs before it has them', () => {
    render(<Verdicts series={series.slice(0, 1)} />);
    expect(screen.getByText('Select at least two runs to compare them.')).toBeTruthy();
  });

  it('names fastest, cheapest and what is not measured, with the floor caveat', () => {
    const { container } = render(<Verdicts series={series} />);
    const text = container.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('Sarvam Saaras → Google Gemini → Murf Falcon at 812 ms median, 258 ms ahead of the slowest selected.');
    expect(text).toContain('OpenAI Realtime at $0.0015 a turn.');
    expect(text).toContain('their totals are floors');
    expect(text).toContain('How it sounds.');
  });

  it('says there is no trade-off when one run is both fastest and cheapest', () => {
    const cheapFast: Series[] = [
      { ...series[0], run: { ...pipe, costUsd: 0.0001, unpriced: [] } },
      { ...series[1], run: { ...rt, costUsd: 0.01 } },
    ];
    const { container } = render(<Verdicts series={cheapFast} />);
    expect(container.textContent).toContain('It is also the fastest, so there is no trade-off here.');
    expect(container.textContent).toContain('cheaper than the dearest selected');
    expect(container.textContent).not.toContain('floors');
  });
});

describe('label helpers', () => {
  it('chainName uses names where known and splits on the first colon only', () => {
    expect(chainName(SYNTHETIC.label, namedProviders)).toBe('Sarvam Saaras → Google Gemini → Murf Falcon');
    expect(chainName(SYNTHETIC.label, [])).toBe('sarvam-stt → google-llm → murf-tts');
    expect(chainName('', [])).toBe('');
  });

  it('isMockRun is true only when every leg is a mock', () => {
    expect(isMockRun(runRows[2].label)).toBe(true);
    expect(isMockRun('mock-stt:a → google-llm:b')).toBe(false);
    expect(isMockRun('')).toBe(false);
  });

  it('filterRuns matches every term against ids, names and languages', () => {
    const ids = (q: string) => filterRuns(runRows, { query: q, mode: 'all', hideMock: false }, namedProviders).map((r) => r.recordId);
    expect(ids('murf-tts')).toEqual(['real-a', 'old-d']);
    expect(ids('openai realtime')).toEqual(['rt-b']);
    expect(ids('hi')).toContain('real-a');
    expect(ids('MURF falcon')).toEqual(['real-a', 'old-d']);
  });
});
