import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadJson } from '../../src/lib/download';

interface FakeAnchor {
  href: string;
  download: string;
  click: ReturnType<typeof vi.fn>;
}

describe('downloadJson', () => {
  let anchor: FakeAnchor;
  let blobs: Blob[];
  let create: { mock: { calls: unknown[][] } };
  let revoke: { mock: { calls: unknown[][] } };
  const events: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    events.length = 0;
    blobs = [];
    anchor = { href: '', download: '', click: vi.fn(() => events.push('click')) };
    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        expect(tag).toBe('a');
        return anchor;
      }),
    });
    create = vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      events.push('create');
      return 'blob:fake/1';
    });
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      events.push('revoke');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serialises the data as pretty-printed JSON', async () => {
    const data = { a: 1, nested: { b: ['x', null] }, s: 'ü' };
    downloadJson(data, 'report.json');
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('application/json');
    expect(await blobs[0].text()).toBe(JSON.stringify(data, null, 2));
  });

  it('clicks an anchor pointing at the object URL with the given filename', () => {
    downloadJson([1, 2], 'session rec-1.json');
    expect(anchor.href).toBe('blob:fake/1');
    expect(anchor.download).toBe('session rec-1.json');
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it('defers the revoke well past the click', () => {
    downloadJson({}, 'x.json');
    expect(events).toEqual(['create', 'click']);
    vi.advanceTimersByTime(9_999);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith('blob:fake/1');
    expect(events).toEqual(['create', 'click', 'revoke']);
  });

  it('handles values JSON renders as primitives', async () => {
    downloadJson('just a string', 's.json');
    downloadJson(null, 'n.json');
    expect(await blobs[0].text()).toBe('"just a string"');
    expect(await blobs[1].text()).toBe('null');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('propagates a serialisation failure before touching the DOM', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => downloadJson(cyclic, 'c.json')).toThrow(TypeError);
    expect(anchor.click).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
