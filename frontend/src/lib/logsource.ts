import type { MetricName, StartConfig } from './protocol';

/**
 * Which part of the session a console line came from.
 *
 * **This is a guess, and the UI says so.** The wire protocol's `log` frame
 * carries a level and a free-text message and nothing else — there is no
 * structured source on it, and adding one would mean touching every provider
 * module. So a line is attributed by looking for the vendor's name in the text,
 * and failing that by keyword. It is good enough to filter by and to colour
 * with; nothing depends on it being right.
 *
 * Metric marks are the exception: those arrive structured, and `sourceOfMark`
 * reads the leg straight off the mark name.
 */
export type LogSource = 'session' | 'stt' | 'llm' | 'tts' | 'realtime' | 'mic' | 'client';

export const SOURCE_COLOR: Record<LogSource, string> = {
  session: '#5c4632',
  stt: '#3987e5',
  llm: '#d95926',
  tts: '#199e70',
  realtime: '#199e70',
  mic: '#9085e9',
  client: '#9085e9',
};

/**
 * The vendor half of a provider id — `sarvam-stt` → `sarvam`, `google-llm` →
 * `google`. That is the token a provider's own log messages tend to use.
 */
const vendorOf = (providerId: string | undefined): string =>
  (providerId ?? '').replace(/-(realtime|stt|llm|tts|agents)$/, '').toLowerCase();

export function sourceOfMessage(message: string, config?: StartConfig): LogSource {
  // The frame is server-controlled but not necessarily well-formed; a non-string
  // message here would throw inside the socket's onmessage and drop the session.
  if (typeof message !== 'string') return 'session';
  const m = message.toLowerCase();

  /*
   * Vendor first, browser heuristics second.
   *
   * The other order looked natural and was wrong: a vendor adapter logging
   * `websocket closed 1008` — which is exactly how Murf's gen2 host announces a
   * rejection — matched the browser rule and was filed under `client`, hiding a
   * vendor error behind the colour used for local noise.
   */
  if (config) {
    /*
     * Only the slots this session actually uses are candidates. `StartConfig`
     * carries every id regardless of mode, so a pipeline session still names a
     * realtime provider it never opened; matching against it meant an all-mock
     * pipeline (where every vendor token is the same string, `mock`) coloured
     * every line `realtime`.
     */
    const candidates: Array<[LogSource, string]> =
      config.mode === 'realtime'
        ? [['realtime', vendorOf(config.realtimeProviderId)]]
        : [
            ['stt', vendorOf(config.sttProviderId)],
            ['llm', vendorOf(config.llmProviderId)],
            ['tts', vendorOf(config.ttsProviderId)],
          ];

    /*
     * Ambiguity is reported as ambiguity. When two slots share a vendor token —
     * an all-mock rig, or OpenAI in two legs at once — there is genuinely no way
     * to tell which leg spoke, so the line stays `session` rather than being
     * assigned to whichever happened to sort first.
     */
    const hits = candidates.filter(([, vendor]) => vendor.length >= 3 && m.includes(vendor));
    const distinct = new Set(hits.map(([, vendor]) => vendor));
    if (hits.length === 1) return hits[0][0];
    if (hits.length > 1 && distinct.size > 1) {
      // Different vendors matched; the longest token is the more specific one.
      return [...hits].sort((a, b) => b[1].length - a[1].length)[0][0];
    }
    if (hits.length > 1) return 'session';
  }

  // Browser-local lines. Word-boundary anchored: `m.includes('mic ')` also
  // matched "dynamic ", "atomic " and "seismic " — verified, not theoretical.
  if (/\bmic\b|microphone/.test(m)) return 'mic';
  if (/\bwebsocket\b|audio output/.test(m)) return 'client';

  // Last resort, and the reason this whole function is documented as a guess.
  if (/\bstt\b|transcript|speech_end/.test(m)) return 'stt';
  if (/\bllm\b|\btoken\b/.test(m)) return 'llm';
  if (/\btts\b|synthes|\bvoice\b/.test(m)) return 'tts';
  return 'session';
}

/** Marks carry their leg in the name, so this one is a lookup, not a guess. */
export function sourceOfMark(name: MetricName): LogSource {
  if (name.startsWith('stt_')) return 'stt';
  if (name.startsWith('llm_')) return 'llm';
  if (name.startsWith('tts_')) return 'tts';
  return 'session';
}

/**
 * What each mark actually means, shown beside it in the console. Written out
 * because the names are terse and the distinctions are the ones that matter:
 * `tts_request_sent` is marked *before* the socket opens, and `first_audio_out`
 * is the server's number rather than the one a person hears.
 */
export const MARK_NOTE: Record<MetricName, string> = {
  user_speech_end: 't0 — every number in this turn is relative to this',
  stt_first_partial: 'first partial transcript',
  stt_final: 'transcript settled',
  llm_request_sent: 'prompt handed to the model',
  llm_first_token: 'first token back',
  llm_last_token: 'generation finished',
  tts_request_sent: 'marked before open() — the handshake is inside the window',
  tts_first_audio: 'first frame from the vendor',
  first_audio_out: 'server-side TTFA',
  last_audio_out: 'reply finished streaming',
};
