import { randomUUID } from 'node:crypto';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type InvokeModelWithBidirectionalStreamInput,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import WebSocket from 'ws';
import type { RealtimeProvider, SessionContext, VoiceSession } from '../types.js';
import { CANONICAL_SAMPLE_RATE, type LegUsage, type SessionMode } from '../../shared/protocol.js';
import { TurnMetrics } from '../../metrics/TurnMetrics.js';
import { pcm16DurationMs, resamplePcm16 } from '../../audio/pcm.js';
import { SpeechEndDetector } from '../../audio/vad.js';

/**
 * Amazon Nova Sonic — native speech-to-speech on Bedrock.
 *
 *   InvokeModelWithBidirectionalStream, HTTP/2, SigV4
 *   https://bedrock-runtime.{region}.amazonaws.com
 *
 * ---------------------------------------------------------------------------
 * NOT VERIFIED LIVE. Every wire shape below is DOC-DERIVED, read off the Nova 2
 * user guide and the aws-samples client on 2026-09-17. No request in this file
 * has ever been accepted by AWS, because this repo has no AWS credentials to
 * run one with.
 *
 * `npm run nova:selftest` exercises this module against a local fake that
 * agrees with it by construction, so a green suite says nothing at all about
 * what Bedrock accepts. `npm run nova:probe` is the check that would: it needs
 * a real key and it asserts the things most likely to be wrong (see that
 * script's header for the list). Until it has been run, treat this provider as
 * the same "doc-derived" state the five late providers were in before
 * 2026-09-05 — see README, "The five late providers".
 * ---------------------------------------------------------------------------
 *
 * Four things about this vendor that differ from every other provider here:
 *
 * 1. IT IS NOT A WEBSOCKET. The request body is an `AsyncIterable` the SDK
 *    pulls from for the life of the conversation. If that iterator ever returns
 *    `done`, the request half closes and the session dies — so `EventQueue`
 *    below parks on a promise when it runs dry instead of returning. This is
 *    the single biggest structural constraint and it is why there is a queue
 *    here at all rather than a `ws.send()`.
 *
 * 2. ERRORS ARRIVE TWO DIFFERENT WAYS, so both paths are handled.
 *
 *    AUTH AND TRANSPORT FAILURES THROW from `client.send()`, synchronously,
 *    before any stream exists — MEASURED 2026-09-17, three runs, by sending
 *    deliberately invalid credentials to `bedrock-runtime.us-east-1`:
 *
 *        send() THREW: UnrecognizedClientException
 *        message: The security token included in the request is invalid.
 *        http status: 403
 *
 *    so `start()` rejects on a bad key, exactly as the OpenAI leg does. An
 *    earlier version of this comment claimed the opposite; that was written
 *    from the SDK's general "send resolves early" behaviour and the probe
 *    contradicted it. Reproduce with the command in README's Nova section.
 *
 *    MODEL-LEVEL FAILURES are documented to arrive instead as A MEMBER OF THE
 *    OUTPUT UNION (`validationException`, `throttlingException`, …) rather
 *    than as a thrown error, so a `for await` loop that only looks at
 *    `chunk.bytes` would swallow them silently. `readResponses()` checks every
 *    member first for that reason. That half is still DOC-DERIVED: the probe
 *    above never got past authentication, so it never saw a validation error.
 *
 * 3. NOVA PUBLISHES NO SPEECH-END EVENT, so t0 comes from the local detector.
 *    See `beginTurn` / `pushAudio` — this is the decision most likely to
 *    corrupt the comparison if it is ever "simplified" back to a server event.
 *
 * 4. THE STREAM IS CAPPED AT 8 MINUTES. The API reference says verbatim: "The
 *    response is returned in a stream that remains open for 8 minutes." A
 *    longer conversation needs a reconnect that replays history, which this
 *    module does NOT implement — it warns as the cap approaches and reports
 *    the close honestly rather than pretending the session is still live.
 *
 * Nova also takes NO language parameter. There is no field for one anywhere in
 * `sessionStart` or `promptStart`; the spoken language follows the voice id and
 * the user's own audio. `config.language` is therefore deliberately unused, and
 * the catalog's language list is a navigation aid for picking a voice, not
 * something that travels on the wire.
 */

const PROVIDER_ID = 'aws-nova-sonic';
const DEFAULT_MODEL = 'amazon.nova-2-sonic-v1:0';
const DEFAULT_VOICE = 'tiffany';
const DEFAULT_REGION = 'us-east-1';

/**
 * Input rate. The `audioInputConfiguration.sampleRateHertz` enum is documented
 * as 8000 | 16000 | 24000, and every AWS sample uses 16000 — so 16k is the only
 * one with a working reference implementation behind it. Declaring 24000 here
 * would remove a resample and is listed as accepted, but "listed in an enum" is
 * not "measured", and a wrong guess costs a `ValidationException` that kills the
 * session rather than degrading it. `nova:probe` tests 24k explicitly; if it
 * passes, this becomes the boundary rate and `pushAudio` stops converting.
 */
const NOVA_INPUT_RATE = 16000;

/**
 * Output rate, which is `CANONICAL_SAMPLE_RATE` exactly — the same lucky
 * alignment OpenAI Realtime has. `resamplePcm16` is still called against the
 * session's rate rather than skipped, so a moved boundary converts instead of
 * shipping 24k audio as if it were right.
 */
const NOVA_OUTPUT_RATE = 24000;

/** The documented pause before Nova decides the user has finished. */
const ENDPOINTING = new Set(['HIGH', 'MEDIUM', 'LOW']);
const DEFAULT_ENDPOINTING = 'MEDIUM';

/** "The response is returned in a stream that remains open for 8 minutes." */
const MAX_STREAM_MS = 8 * 60_000;
const STREAM_WARN_MS = 7 * 60_000;

const HANDSHAKE_TIMEOUT_MS = 20_000;
/** How long `close()` waits for the teardown events to be pulled. */
const TEARDOWN_DRAIN_MS = 500;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * The barge-in marker AWS's own Python handler greps for, verbatim:
 *
 *     if '{ "interrupted" : true }' in text_content:
 *
 * Matched as a pattern rather than a substring because the spacing in that
 * literal is a formatting accident of whoever wrote the sample, not something
 * the docs promise, and a compact `{"interrupted":true}` would otherwise be
 * read out loud to the user as if it were part of the answer.
 */
const INTERRUPT_MARKER = /\{\s*"interrupted"\s*:\s*true\s*\}/;

/**
 * Per-model wire differences, in one table rather than scattered through the
 * event builders — the same reason `MurfModelProfile` exists.
 *
 * Only Nova 2 is in the catalog, so this has one row today. It is a table
 * anyway because the one difference that exists is a session-killer: v1 has no
 * `turnDetectionConfiguration`, so sending Nova 2's shape to a v1 id is a
 * `ValidationException` on the very first event.
 */
interface NovaModelProfile {
  /** `sessionStart.turnDetectionConfiguration` — Nova 2 only. */
  turnDetection: boolean;
}

const PROFILES: Record<string, NovaModelProfile> = {
  'amazon.nova-2-sonic-v1:0': { turnDetection: true },
  // Legacy. Its model card gives an EOL of 2026-09-14, so it is not in the
  // catalog; the row is here so that re-adding it cannot forget the difference.
  'amazon.nova-sonic-v1:0': { turnDetection: false },
};

const DEFAULT_PROFILE: NovaModelProfile = { turnDetection: false };

/* ------------------------------ transport ------------------------------ */

/**
 * The seam between this module's event handling and the HTTP/2 stream.
 *
 * It exists for the self-test. Every other provider here is a WebSocket, so its
 * fake is a `WebSocketServer` on port 0 and the provider is pointed at it with
 * a `*_WS_BASE` credential. A Bedrock bidirectional stream cannot be faked that
 * way — it is SigV4-signed HTTP/2 event framing through the vendor SDK — so the
 * seam moves up one level: the events are the same JSON either way, and only
 * what carries them differs.
 *
 * Be clear about what that costs. The WebSocket transport proves the event
 * SEQUENCE, the audio adaptation, turn attribution, barge-in and billing. It
 * proves NOTHING about SigV4, HTTP/2 framing, or whether Bedrock accepts a
 * single field in these events.
 */
interface NovaTransport {
  /** Queue one input event. Never blocks; ordering is preserved. */
  send(event: unknown): void;
  /**
   * Close the input half and WAIT for what is queued to reach the wire.
   * Awaited by `close()`, because the teardown events are queued immediately
   * before the transport is destroyed and would otherwise never be pulled.
   */
  endInput(): Promise<void>;
  /** Drop everything now. */
  destroy(): void;
}

interface TransportEvents {
  /** The parsed body of the top-level `event` key. */
  onEvent(event: Record<string, any>): void;
  onError(err: Error): void;
  onClose(reason?: string): void;
}

/**
 * The async iterable the SDK pulls the request body from.
 *
 * The one rule: `stream()` must not return while the conversation is live. A
 * generator that drained its buffer and exited would close the request half and
 * end the session mid-turn, which is the failure mode every AWS sample works
 * around (theirs with an RxJS Subject; this with a bare promise, to avoid
 * taking a dependency for one await).
 */
export class EventQueue {
  private readonly items: unknown[] = [];
  private wake?: () => void;
  private closed = false;

  /**
   * Resolves when `stream()` has yielded everything and reached its exit.
   *
   * `close()` used to be fire-and-forget: it queued contentEnd/promptEnd/
   * sessionEnd and then called `client.destroy()` in the same synchronous run.
   * The SDK's pull is parked on a promise, and its continuation is a microtask
   * that cannot run until the caller yields — so the HTTP/2 session was already
   * destroyed by the time those three events were pulled, and none of them ever
   * went out. AWS's error guide is explicit that completing the sequence "frees
   * GPU resources and memory", so skipping it leaks capacity on the vendor side
   * of a session we were done with.
   */
  private drained?: () => void;
  readonly whenDrained: Promise<void>;

  constructor() {
    this.whenDrained = new Promise<void>((resolve) => {
      this.drained = resolve;
    });
  }

  push(event: unknown): void {
    if (this.closed) return;
    this.items.push(event);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  close(): void {
    this.closed = true;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async *stream(): AsyncIterable<InvokeModelWithBidirectionalStreamInput> {
    const encoder = new TextEncoder();
    for (;;) {
      if (this.items.length === 0) {
        if (this.closed) {
          this.drained?.();
          return; // the ONLY exit
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        continue;
      }
      const next = this.items.shift();
      yield { chunk: { bytes: encoder.encode(JSON.stringify(next)) } };
    }
  }
}

/** The real one: Bedrock over HTTP/2. */
class BedrockTransport implements NovaTransport {
  private readonly queue = new EventQueue();
  private client?: BedrockRuntimeClient;

  constructor(
    private readonly opts: {
      modelId: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      endpoint?: string;
    },
    private readonly events: TransportEvents,
  ) {}

  /**
   * Resolves once the SDK has accepted the command and handed back a response
   * stream.
   *
   * A credentials or transport failure rejects here — measured, see note 2 in
   * the file header — so `start()` fails loudly on a bad key. What this does
   * NOT acknowledge is that Bedrock liked the CONTENT of the request: a
   * `ValidationException` for a bad model id or a malformed `sessionStart` is
   * documented to arrive afterwards as an output-union member, and is surfaced
   * from `readResponses()` instead.
   */
  async open(): Promise<void> {
    const client = new BedrockRuntimeClient({
      region: this.opts.region,
      // Passed explicitly, never left to the SDK's own credential chain: the
      // chain reads process.env, and this repo's invariant is that a provider
      // reads keys from ctx.credentials so sessions stay swappable and scripts
      // can inject. An SDK default would silently violate that and still work,
      // which is the worst kind of violation.
      credentials: {
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
        ...(this.opts.sessionToken ? { sessionToken: this.opts.sessionToken } : {}),
      },
      ...(this.opts.endpoint ? { endpoint: this.opts.endpoint } : {}),
      // The client already defaults to NodeHttp2Handler; it is constructed
      // explicitly only to raise the timeouts. A conversation is idle between
      // turns by definition, and the default request timeout would abort one
      // mid-thought.
      requestHandler: new NodeHttp2Handler({
        requestTimeout: 300_000,
        sessionTimeout: 300_000,
        disableConcurrentStreams: false,
        maxConcurrentStreams: 20,
      }),
    });
    this.client = client;

    const response = await client.send(
      new InvokeModelWithBidirectionalStreamCommand({
        modelId: this.opts.modelId,
        body: this.queue.stream(),
      }),
    );
    void this.readResponses(response.body);
  }

  private async readResponses(body: AsyncIterable<any> | undefined): Promise<void> {
    if (!body) {
      this.events.onError(new Error('Bedrock returned no response stream'));
      return;
    }
    const decoder = new TextDecoder();
    try {
      for await (const out of body) {
        // Deferred errors first. Each is a distinct member of the output union
        // and none of them throws, so a loop that went straight to `chunk`
        // would report a throttled or rejected session as a silent hang.
        const failure =
          out.validationException ??
          out.throttlingException ??
          out.modelTimeoutException ??
          out.modelStreamErrorException ??
          out.serviceUnavailableException ??
          out.internalServerException;
        if (failure) {
          const kind = Object.keys(out).find((k) => k !== 'chunk') ?? 'error';
          this.events.onError(new Error(`Nova Sonic ${kind}: ${failure.message ?? 'no message'}`));
          continue;
        }
        if (!out.chunk?.bytes) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(decoder.decode(out.chunk.bytes));
        } catch {
          continue; // a frame we cannot read must not take the conversation down
        }
        if (parsed?.event) this.events.onEvent(parsed.event);
      }
      this.events.onClose();
    } catch (err) {
      this.events.onError(err instanceof Error ? err : new Error(String(err)));
      this.events.onClose('stream error');
    } finally {
      // Nothing will ever pull from the queue again. Without this, mic frames
      // kept accumulating in it for as long as the browser held the microphone
      // open — ~43 KB/s of retained base64 into a queue with no consumer.
      this.queue.close();
    }
  }

  send(event: unknown): void {
    this.queue.push(event);
  }

  async endInput(): Promise<void> {
    this.queue.close();
    // Bounded: if the stream is already dead nothing will ever drain it, and a
    // hung teardown would block the socket layer's close on a dead connection.
    await Promise.race([this.queue.whenDrained, delay(TEARDOWN_DRAIN_MS)]);
  }

  destroy(): void {
    this.queue.close();
    this.client?.destroy();
    this.client = undefined;
  }
}

/**
 * The fake one: the same events over a WebSocket, one JSON frame each.
 *
 * Only reachable when `NOVA_SONIC_WS_BASE` is set, which nothing but
 * `nova-sonic-selftest.ts` does. It is deliberately not a general escape hatch:
 * there is no WebSocket endpoint for Nova Sonic to point it at.
 */
class FakeWsTransport implements NovaTransport {
  private ws?: WebSocket;
  private readonly pending: unknown[] = [];

  constructor(
    private readonly url: string,
    private readonly events: TransportEvents,
  ) {}

  async open(): Promise<void> {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('message', (raw) => {
      let parsed: any;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (parsed?.event) this.events.onEvent(parsed.event);
    });
    ws.on('error', (err) => this.events.onError(new Error(`Nova Sonic fake transport: ${err.message}`)));
    ws.on('close', () => this.events.onClose());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        for (const queued of this.pending.splice(0)) ws.send(JSON.stringify(queued));
        resolve();
      });
      ws.once('error', (err) => reject(err));
    });
  }

  send(event: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.pending.push(event);
      return;
    }
    ws.send(JSON.stringify(event));
  }

  async endInput(): Promise<void> {
    /* nothing to half-close on a socket; frames are already on the wire */
  }

  destroy(): void {
    const ws = this.ws;
    this.ws = undefined;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
  }
}

/* -------------------------------- session -------------------------------- */

/** A content block the model opened, keyed by the `contentId` its events carry. */
interface Block {
  role: string;
  type: string;
  /** `additionalModelFields.generationStage` — FINAL or SPECULATIVE. */
  speculative: boolean;
}

/**
 * One conversational turn. Outlives `onTurnEnd` for the same reason OpenAI's
 * does: a turn cut short by barge-in still has usage arriving behind it, and
 * dropping it at end-of-turn would throw that bill away.
 */
interface Turn {
  turnId: number;
  /**
   * Replaced, not mutated, when a pending turn's t0 is restamped — see
   * `beginTurn`. `TurnMetrics` fixes its own t0 at construction.
   */
  metrics: TurnMetrics;
  /** Bound at `completionStart`, so late events find their own turn. */
  completionId?: string;
  audioBytes: number;
  ended: boolean;
  billed: boolean;
  /** Any usage event landed for this turn — the difference between free and unreported. */
  sawUsage: boolean;
  speechIn: number;
  textIn: number;
  speechOut: number;
  textOut: number;
  /**
   * Nova streams transcripts as whole blocks rather than fragments, but the
   * ASSISTANT side arrives as one SPECULATIVE preview and then one FINAL, and
   * a turn can carry more than one of each. `SessionEvents` is a cumulative
   * channel — the browser replaces the current utterance on every non-final —
   * so these accumulate rather than overwrite.
   */
  assistantText: string;
  userText: string;
}

class NovaSonicSession implements VoiceSession {
  readonly mode: SessionMode = 'realtime';
  readonly label: string;

  private readonly modelId: string;
  private readonly profile: NovaModelProfile;

  /**
   * Realtime providers get no per-session sample rate the way `TtsOptions`
   * does, so the boundary constant is read once here rather than assumed at
   * each call site. Everything that resamples goes through it.
   */
  private sessionRate = CANONICAL_SAMPLE_RATE;

  /** Ids the vendor requires us to invent and then repeat on every event. */
  private readonly promptName = randomUUID();
  private readonly systemContentName = randomUUID();
  private readonly audioContentName = randomUUID();

  private transport?: NovaTransport;
  private readonly blocks = new Map<string, Block>();
  /** The last block opened, for events that arrive without a `contentId`. */
  private lastBlock?: Block;

  /**
   * t0's detector.
   *
   * Nova publishes no speech-end event of its own — nothing in its output event
   * list corresponds to Sarvam's `vad.speech_end`. The earliest server-side
   * marker of "the user stopped talking" is `completionStart`, which only fires
   * AFTER Nova's own endpointing pause (a documented 1.5-2.0s depending on
   * `endpointingSensitivity`).
   *
   * Taking t0 from there would fold that pause into every latency number this
   * bench prints, making Nova look ~2s slower than every pipeline rig for a
   * reason that is policy rather than model speed — and worse, moving
   * `endpointingSensitivity` would then MOVE t0, so the two settings would not
   * be comparable with each other either.
   *
   * So Nova sits in the same bucket as Cartesia: same definition of t0, local
   * detector. The invariant in CLAUDE.md is explicit that this is the intended
   * shape, not a workaround.
   */
  private readonly speechEnd = new SpeechEndDetector();

  private turnCounter = 0;
  private active?: Turn;
  /**
   * Every completion id ever bound to a turn. `turnFor` uses it to tell "an id
   * belonging to a turn already retired" (drop it) from "an id not seen yet"
   * (the open turn may claim it). Bounded by the 8-minute stream cap: one entry
   * per completion, so a few hundred short strings at the very most.
   */
  private readonly seenCompletions = new Set<string>();
  /** Ended-but-unbilled turns, oldest first. */
  private readonly awaitingUsage: Turn[] = [];
  private closed = false;
  private audioBlockOpen = false;
  private streamWarnTimer?: NodeJS.Timeout;
  private streamCapTimer?: NodeJS.Timeout;
  /**
   * Set once the vendor's documented 8-minute limit has passed, so the close
   * that follows is reported as the expected one rather than as a fault. The
   * README promises this stream is "reported honestly"; calling the one close
   * we predicted "unexpected" is the opposite of that.
   */
  private reachedStreamCap = false;

  constructor(
    readonly id: string,
    private readonly ctx: SessionContext,
  ) {
    this.modelId = ctx.config.realtimeModelId || DEFAULT_MODEL;
    this.profile = PROFILES[this.modelId] ?? DEFAULT_PROFILE;
    this.label = `${PROVIDER_ID}:${this.modelId}`;
  }

  /**
   * Opens the stream and queues the whole preamble.
   *
   * Every event up to and including the audio `contentStart` is queued BEFORE
   * the command is sent, so the first thing the SDK pulls is a complete,
   * correctly ordered session. Nova rejects out-of-order events outright, and
   * queueing first removes any chance of a race between `open()` resolving and
   * a microphone frame arriving.
   */
  async start(): Promise<void> {
    const creds = this.ctx.credentials;
    const fakeBase = creds.NOVA_SONIC_WS_BASE;

    const events: TransportEvents = {
      onEvent: (event) => this.onEvent(event),
      onError: (err) => {
        if (this.closed) return;
        this.ctx.events.onError(err);
      },
      onClose: (reason) => this.onStreamClosed(reason),
    };

    let transport: NovaTransport & { open(): Promise<void> };
    if (fakeBase) {
      transport = new FakeWsTransport(fakeBase, events);
    } else {
      const accessKeyId = creds.AWS_ACCESS_KEY_ID;
      const secretAccessKey = creds.AWS_SECRET_ACCESS_KEY;
      if (!accessKeyId || !secretAccessKey) {
        throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set');
      }
      transport = new BedrockTransport(
        {
          modelId: this.modelId,
          region: creds.AWS_REGION || creds.AWS_DEFAULT_REGION || DEFAULT_REGION,
          accessKeyId,
          secretAccessKey,
          sessionToken: creds.AWS_SESSION_TOKEN,
          endpoint: creds.BEDROCK_ENDPOINT,
        },
        events,
      );
    }
    this.transport = transport;

    this.queuePreamble();

    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Nova Sonic stream did not open within 20s')),
        HANDSHAKE_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([transport.open(), timeout]);
    } catch (err) {
      this.closed = true;
      transport.destroy();
      throw err instanceof Error ? err : new Error(String(err));
    }

    // The vendor's own cap, not ours. Warned about rather than worked around:
    // resuming past it means reconnecting and replaying the conversation as
    // text, which this module does not implement.
    this.streamWarnTimer = setTimeout(() => {
      this.ctx.events.onLog(
        'warn',
        'Nova Sonic streams are capped at 8 minutes; this conversation is about to reach it and will be closed by AWS',
      );
    }, STREAM_WARN_MS);
    this.streamWarnTimer.unref?.();
    this.streamCapTimer = setTimeout(() => {
      this.reachedStreamCap = true;
      this.ctx.events.onLog('warn', 'Nova Sonic has reached its 8-minute stream limit');
    }, MAX_STREAM_MS);
    this.streamCapTimer.unref?.();
  }

  /**
   * Mic audio in, and — in server-VAD mode — the only source of t0.
   *
   * The frame is fed to the detector BEFORE it is forwarded, so a speech-end
   * mark is stamped at the moment the silence completes rather than one frame
   * later. Nova's audio content block stays open across the whole conversation;
   * turns are delimited by the vendor's endpointing, never by closing it.
   */
  pushAudio(chunk: Buffer): void {
    if (this.closed || chunk.length === 0 || !this.audioBlockOpen) return;

    if (this.ctx.config.turnDetection === 'server_vad') {
      if (this.speechEnd.push(chunk, this.sessionRate) === 'end') this.beginTurn();
    }

    const pcm = resamplePcm16(chunk, this.sessionRate, NOVA_INPUT_RATE);
    if (pcm.length === 0) return;

    // Forwarded frame for frame with no aggregation, for the same reason the
    // OpenAI leg does it: Nova's endpointing is what decides when the turn ends,
    // and batching would blunt it for nothing.
    this.send({
      event: {
        audioInput: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          content: pcm.toString('base64'),
        },
      },
    });
  }

  /**
   * Manual turn detection: the user released the mic.
   *
   * Nova has no commit event and no way to disable its own endpointing — the
   * audio block stays open and the vendor decides when the turn ended either
   * way. So this cannot make Nova answer sooner; what it does is supply t0 from
   * the mic release instead of from the local detector, which is the same
   * instant by a different route and keeps the bench's definition intact.
   */
  commitAudio(): void {
    if (this.closed) return;
    if (this.ctx.config.turnDetection === 'server_vad') return; // the detector owns t0
    this.beginTurn();
  }

  /**
   * Typed input, mid-conversation.
   *
   * A TEXT block with `interactive: true` is the documented cross-modal path —
   * a typed message inside a voice session. Unlike the system prompt it is a
   * USER turn, so it opens one here: the moment the text is handed over is the
   * honest t0, the same event the user would otherwise have produced by falling
   * silent.
   */
  sendText(text: string): void {
    if (this.closed || !text.trim()) return;
    const turn = this.beginTurn();
    this.ctx.events.onUserTranscript(text, true, turn.turnId);

    const contentName = randomUUID();
    this.send({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName,
          type: 'TEXT',
          interactive: true,
          role: 'USER',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });
    this.send({ event: { textInput: { promptName: this.promptName, contentName, content: text } } });
    this.send({ event: { contentEnd: { promptName: this.promptName, contentName } } });
  }

  /**
   * Barge-in.
   *
   * NOTHING IS SENT UPSTREAM, and that is deliberate rather than an omission.
   * Nova publishes no cancel event — the documented client behaviour on an
   * interruption is to flush the playback queue and keep streaming mic audio,
   * because the model stops generating on its own the moment it hears speech.
   * The audio content block stays open; closing it would end the conversation,
   * not the utterance.
   *
   * So all that happens here is local: stop attributing audio to this turn, and
   * tell the recorder that what it already wrote was never heard.
   */
  interrupt(): void {
    const turn = this.active;
    if (!turn || turn.ended) return;
    this.endTurn(turn, true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.streamWarnTimer);
    clearTimeout(this.streamCapTimer);

    if (this.active && !this.active.ended) this.endTurn(this.active);

    // Teardown is order-critical: contentEnd before promptEnd before sessionEnd.
    // AWS's error guide is explicit that completing these "frees GPU resources
    // and memory" — a stream abandoned without them holds capacity server-side.
    if (this.audioBlockOpen) {
      this.send({ event: { contentEnd: { promptName: this.promptName, contentName: this.audioContentName } } });
      this.audioBlockOpen = false;
    }
    this.send({ event: { promptEnd: { promptName: this.promptName } } });
    this.send({ event: { sessionEnd: {} } });

    const transport = this.transport;
    // AWAITED. The teardown events above are only queued; the SDK pulls them on
    // a microtask that cannot run until this function yields, so destroying the
    // transport in the same synchronous run meant none of the three ever
    // reached AWS. Bounded by TEARDOWN_DRAIN_MS so a dead stream cannot hang
    // the socket layer's close.
    await transport?.endInput();
    // Anything still waiting on a usage event will never get one.
    this.flushBilling('session closed before the vendor reported usage');
    transport?.destroy();
    this.transport = undefined;
  }

  /* ------------------------------- wire ------------------------------- */

  private send(payload: unknown): void {
    this.transport?.send(payload);
  }

  /** Everything up to the open audio block, in the one order Nova accepts. */
  private queuePreamble(): void {
    const { config } = this.ctx;
    const voice = config.voice?.trim() || DEFAULT_VOICE;
    const raw = (this.ctx.credentials.NOVA_SONIC_ENDPOINTING ?? '').toUpperCase();
    const sensitivity = ENDPOINTING.has(raw) ? raw : DEFAULT_ENDPOINTING;

    this.send({
      event: {
        sessionStart: {
          inferenceConfiguration: {
            maxTokens: 1024,
            topP: 0.9,
            // The bench's own temperature wins where the UI set one; Nova's
            // documented sample value is the fallback.
            temperature: config.temperature ?? 0.7,
          },
          // v1 has no such field and rejects the whole event if it is present.
          ...(this.profile.turnDetection
            ? { turnDetectionConfiguration: { endpointingSensitivity: sensitivity } }
            : {}),
        },
      },
    });

    this.send({
      event: {
        promptStart: {
          promptName: this.promptName,
          textOutputConfiguration: { mediaType: 'text/plain' },
          audioOutputConfiguration: {
            mediaType: 'audio/lpcm',
            sampleRateHertz: NOVA_OUTPUT_RATE,
            sampleSizeBits: 16,
            channelCount: 1,
            // Passed through exactly as the catalog stored it. NOT lowercased:
            // the ids the docs enumerate are already lowercase, and silently
            // rewriting a value the user chose would hide a rejection rather
            // than report it. Whether Nova is case-sensitive here is one of the
            // things `nova:probe` asks.
            voiceId: voice,
            encoding: 'base64',
            audioType: 'SPEECH',
          },
          toolUseOutputConfiguration: { mediaType: 'application/json' },
        },
      },
    });

    // System prompt. `interactive: false` — the input-events reference and the
    // aws-samples Node client both use it here; only the getting-started page
    // shows `true`, and it is the odd one out.
    this.send({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: this.systemContentName,
          type: 'TEXT',
          interactive: false,
          role: 'SYSTEM',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });
    this.send({
      event: {
        textInput: {
          promptName: this.promptName,
          contentName: this.systemContentName,
          content: config.systemPrompt,
        },
      },
    });
    this.send({ event: { contentEnd: { promptName: this.promptName, contentName: this.systemContentName } } });

    // ONE audio block for the entire conversation. Opening one per turn is the
    // obvious-looking mistake: turn boundaries come from Nova's endpointing,
    // and closing this block ends the conversation rather than the utterance.
    this.send({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          type: 'AUDIO',
          interactive: true,
          role: 'USER',
          audioInputConfiguration: {
            mediaType: 'audio/lpcm',
            sampleRateHertz: NOVA_INPUT_RATE,
            sampleSizeBits: 16,
            channelCount: 1,
            audioType: 'SPEECH',
            encoding: 'base64',
          },
        },
      },
    });
    this.audioBlockOpen = true;
  }

  private onEvent(event: Record<string, any>): void {
    if (this.closed) return;

    if (event.completionStart) {
      this.bindCompletion(event.completionStart.completionId);
      return;
    }
    if (event.contentStart) {
      this.onContentStart(event.contentStart);
      return;
    }
    if (event.textOutput) {
      this.onTextOutput(event.textOutput);
      return;
    }
    if (event.audioOutput) {
      this.onAudioOutput(event.audioOutput);
      return;
    }
    if (event.toolUse) {
      // No tools are configured, so this should never arrive. Logged rather
      // than ignored: silently dropping it would leave the model waiting on a
      // toolResult that is never coming, and the turn would simply stall.
      this.ctx.events.onLog('warn', `Nova Sonic asked for tool "${event.toolUse.toolName}", which this bench does not serve`);
      return;
    }
    if (event.contentEnd) {
      this.onContentEnd(event.contentEnd);
      return;
    }
    if (event.usageEvent) {
      this.onUsageEvent(event.usageEvent);
      return;
    }
    if (event.completionEnd) {
      const turn = this.turnFor(event.completionEnd.completionId);
      if (turn && !turn.ended) this.endTurn(turn);
      if (turn) this.bill(turn);
      return;
    }
  }

  private onContentStart(msg: Record<string, any>): void {
    let speculative = false;
    // A JSON-encoded STRING, not an object. Parsed defensively: a stage we
    // cannot read means "treat it as final", which shows the text rather than
    // hiding it.
    if (typeof msg.additionalModelFields === 'string') {
      try {
        speculative = JSON.parse(msg.additionalModelFields)?.generationStage === 'SPECULATIVE';
      } catch {
        /* unreadable stage; fall through as final */
      }
    }
    const block: Block = { role: msg.role ?? 'ASSISTANT', type: msg.type ?? 'TEXT', speculative };
    // Output events key on `contentId`; input events use `contentName`. Both
    // are read because they are one character apart and easy to mis-wire.
    const key = msg.contentId ?? msg.contentName;
    if (key) this.blocks.set(key, block);
    this.lastBlock = block;
  }

  private onTextOutput(msg: Record<string, any>): void {
    const text: string = msg.content ?? '';
    const block = this.blockOf(msg);

    // The barge-in marker AWS's own sample greps for. Checked before anything
    // else: it arrives AS the text content, so a handler that routed first
    // would read "{ "interrupted" : true }" out as part of the conversation.
    if (INTERRUPT_MARKER.test(text)) {
      this.onInterrupted(msg.completionId);
      return;
    }
    if (!text) return;

    const turn = this.turnFor(msg.completionId);
    if (block?.role === 'USER') {
      // An already-snapshotted turn must not have marks added or its transcript
      // rewritten — its metrics have been emitted and cannot be emitted again.
      if (turn?.ended) return;
      // Nova's ASR of the user's own words. This is the only user transcript a
      // speech-to-speech model produces, so without it the bench shows one side
      // of the conversation.
      if (turn) {
        turn.metrics.mark('stt_first_partial');
        if (!block.speculative) turn.metrics.mark('stt_final');
        turn.userText = turn.userText ? `${turn.userText} ${text}` : text;
      }
      this.ctx.events.onUserTranscript(turn?.userText ?? text, !block?.speculative, turn?.turnId ?? 0);
      return;
    }

    if (!turn || turn.ended) return; // a block from a turn the user talked past
    turn.assistantText = turn.assistantText ? `${turn.assistantText} ${text}` : text;
    this.ctx.events.onAssistantTranscript(turn.assistantText, !block?.speculative, turn.turnId);
  }

  private onAudioOutput(msg: Record<string, any>): void {
    const turn = this.turnFor(msg.completionId);
    // Audio for a turn the user already talked over is discarded, not played.
    if (!turn || turn.ended || !msg.content) return;

    const pcm = resamplePcm16(Buffer.from(msg.content, 'base64'), NOVA_OUTPUT_RATE, this.sessionRate);
    if (pcm.length === 0) return;

    turn.metrics.mark('first_audio_out');
    turn.metrics.countAudio(pcm.length);
    turn.audioBytes += pcm.length;
    this.ctx.events.onAudio(pcm);
  }

  private onContentEnd(msg: Record<string, any>): void {
    const key = msg.contentId ?? msg.contentName;
    if (key) {
      // Cleared with the block, not just removed from the map. A stale
      // `lastBlock` is how an ASSISTANT answer got published to the browser as
      // the USER's own words: the fallback below is only reached when an event
      // carries no contentId, and it must not then name a block that has ended.
      if (this.lastBlock === this.blocks.get(key)) this.lastBlock = undefined;
      this.blocks.delete(key);
    }

    // The AUDIO block's documented stopReason enum is PARTIAL_TURN | END_TURN
    // and only the TEXT block's carries INTERRUPTED — but it is checked on
    // every type here rather than on text alone, because which block carries it
    // is a doc detail and being wrong about it means missing a barge-in.
    if (String(msg.stopReason ?? '').toUpperCase() === 'INTERRUPTED') {
      this.onInterrupted(msg.completionId);
      return;
    }
    if (msg.stopReason === 'END_TURN') {
      const turn = this.turnFor(msg.completionId);
      if (turn && !turn.ended) turn.metrics.mark('last_audio_out');
    }
  }

  /**
   * Nova reported that it stopped speaking because the user spoke over it.
   *
   * Reached from two different signals — `contentEnd.stopReason` and the text
   * marker — and both can fire for one interruption, so it is idempotent: the
   * `ended` check inside `endTurn` makes the second one a no-op rather than a
   * second `onInterrupt` that would truncate the recording twice.
   *
   * It takes the COMPLETION ID rather than assuming `this.active`. The turn
   * being interrupted is usually the open one, but not always: typing a message
   * mid-answer opens the next turn first, and the interruption that the typing
   * caused then arrives labelled with the PREVIOUS completion. Ending
   * `this.active` there killed the turn the user had just started — it emitted
   * an empty turn_start/turn_end pair, stranded the user's own text on it, and
   * pushed the real answer onto a third turn whose t0 was the completion start
   * rather than the moment the text was sent. That is the ~2s of Nova's own
   * endpointing that t0 is defined to exclude.
   */
  private onInterrupted(completionId?: string): void {
    const turn = this.turnFor(completionId) ?? this.active;
    if (!turn || turn.ended) return;
    this.endTurn(turn, true);
  }

  /**
   * Usage arrives repeatedly during a completion, carrying BOTH an incremental
   * `delta` and a cumulative `total`.
   *
   * The deltas are what is accumulated. `totalInputTokens` and friends are
   * session-cumulative across every completion, so summing those across events
   * would multiply the bill several times over — and taking the last one would
   * bill every turn for the whole conversation so far.
   */
  private onUsageEvent(msg: Record<string, any>): void {
    const turn = this.turnFor(msg.completionId);
    if (!turn) return;
    const delta = msg.details?.delta;
    if (!delta) return;

    turn.sawUsage = true;
    turn.speechIn += num(delta.input?.speechTokens);
    turn.textIn += num(delta.input?.textTokens);
    turn.speechOut += num(delta.output?.speechTokens);
    turn.textOut += num(delta.output?.textTokens);
  }

  /**
   * The stream died under us.
   *
   * The session is marked closed here, which is what stops `pushAudio` feeding
   * a queue nothing will ever drain again: the transport layer above does not
   * tear a session down on `onError`, it only forwards the message to the
   * browser, so an unclosed session went on accepting microphone frames for as
   * long as the tab held the mic.
   */
  private onStreamClosed(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.streamWarnTimer);
    clearTimeout(this.streamCapTimer);
    if (this.reachedStreamCap) {
      // Predicted, documented, and not a bug: AWS caps the stream at 8 minutes.
      // Surfaced as an error anyway because the conversation really has ended
      // and the caller must know, but named for what it is.
      this.ctx.events.onError(
        new Error(
          'Nova Sonic closed the stream at its documented 8-minute limit; ' +
            'continuing would need a reconnect that replays the conversation, which this provider does not implement',
        ),
      );
    } else {
      this.ctx.events.onError(new Error(`Nova Sonic stream closed unexpectedly${reason ? ` (${reason})` : ''}`));
    }
    if (this.active && !this.active.ended) this.endTurn(this.active);
    // No usage event is coming for anything still in flight. Bill it from what
    // we have rather than losing the turn.
    this.flushBilling('stream closed before the vendor reported usage');
    this.transport?.destroy();
    this.transport = undefined;
  }

  /* ------------------------------ turns ------------------------------ */

  /**
   * Opens a turn and stamps t0.
   *
   * A turn that is still PENDING — nothing bound to it, no audio emitted — is
   * restamped rather than replaced. The local detector ends an utterance after
   * 600ms of silence while Nova waits 1.5-2.0s, so a user who pauses mid-
   * sentence produces a speech-end that Nova does not act on, and then another
   * when they really finish. Opening a second turn there would emit a
   * turn_start/turn_end pair for a turn that never ran; keeping the first and
   * moving its t0 forward is both tidier and more correct, because the later
   * silence IS the real end of the user's speech.
   */
  private beginTurn(): Turn {
    const pending = this.active;
    if (pending && !pending.ended && pending.completionId === undefined && pending.audioBytes === 0) {
      pending.metrics = new TurnMetrics(pending.turnId);
      pending.metrics.mark('user_speech_end');
      return pending;
    }
    // A turn already open and RUNNING means the user started talking while the
    // assistant still was. That is a barge-in by any other name — the audio
    // already handed to the sink will not be heard — so it is flagged as one
    // rather than ended quietly. Under server VAD this is the ORDINARY voice
    // barge-in path: the local detector reaches here well before Nova's own
    // INTERRUPTED marker arrives, and if only the marker raised onInterrupt the
    // recorder would never be told.
    if (pending && !pending.ended) this.endTurn(pending, true);

    this.turnCounter += 1;
    const metrics = new TurnMetrics(this.turnCounter);
    metrics.mark('user_speech_end');
    const turn: Turn = {
      turnId: this.turnCounter,
      metrics,
      audioBytes: 0,
      ended: false,
      billed: false,
      sawUsage: false,
      speechIn: 0,
      textIn: 0,
      speechOut: 0,
      textOut: 0,
      assistantText: '',
      userText: '',
    };
    this.active = turn;
    this.ctx.events.onTurnStart(turn.turnId);
    return turn;
  }

  /**
   * `completionStart` is the first sight of the completion id, which is how
   * every later event — including a usage event arriving after barge-in —
   * finds the turn it belongs to.
   *
   * With no turn open, Nova started speaking on its own. Opening one keeps the
   * audio and the bill attached to something, but t0 is then the completion
   * start rather than a speech end, so the log says so instead of quietly
   * publishing a latency number measured from the wrong instant.
   */
  private bindCompletion(completionId?: string): void {
    /*
     * A SECOND completion opening while one is still live used to overwrite the
     * id in place, which quietly threw the first one's bill away: its own
     * `usageEvent` and `completionEnd` then matched no turn at all and were
     * dropped, so tokens the vendor had already charged for never reached the
     * invoice. Retiring the first turn instead keeps it in `awaitingUsage`
     * under its own id, where those late events still find it.
     */
    const active = this.active;
    if (active && !active.ended && active.completionId !== undefined && completionId &&
        active.completionId !== completionId) {
      this.ctx.events.onLog(
        'warn',
        `Nova Sonic opened completion ${completionId} while ${active.completionId} was still live; ` +
          'closing the earlier turn so its usage is still attributed',
      );
      this.endTurn(active);
    }

    if (!this.active || this.active.ended) {
      this.ctx.events.onLog(
        'warn',
        'Nova Sonic started a completion with no turn open; t0 is the completion start, not a speech end',
      );
      this.beginTurn();
    }
    if (this.active && completionId) this.bindTo(this.active, completionId);
  }

  /**
   * Emits the turn's metrics exactly once. Billing is separate and may lag.
   *
   * `interrupted` means audio ALREADY EMITTED will never be heard, which is a
   * different thing from a turn simply finishing. It is raised here rather than
   * at each call site so it cannot fire twice for one interruption — the
   * `ended` guard above covers both signals Nova sends, and the local barge-in
   * path that reaches this through `beginTurn()`. Missing that third path left
   * seconds of never-heard speech in the stereo recording and displaced every
   * later assistant turn in the file by that much, which is exactly what
   * `SessionEvents.onInterrupt` exists to prevent.
   */
  private endTurn(turn: Turn, interrupted = false): void {
    if (turn.ended) return;
    turn.ended = true;
    if (interrupted && turn.audioBytes > 0) this.ctx.events.onInterrupt?.();
    if (turn.audioBytes > 0) turn.metrics.mark('last_audio_out');
    const snap = turn.metrics.snapshot();
    if (this.active === turn) this.active = undefined;
    if (!turn.billed) this.awaitingUsage.push(turn);
    this.ctx.events.onTurnEnd(turn.turnId);
    this.ctx.events.onMetrics(turn.turnId, snap.marks, snap.derived);
  }

  /**
   * Emits the turn's usage exactly once, however the turn ended.
   *
   * One row, because a realtime session has one leg; `unit: 'tokens'` because
   * that is what AWS bills it in, with the speech portion carried separately
   * since speech tokens cost several times text tokens in the same request.
   */
  private bill(turn: Turn, missingReason?: string): void {
    if (turn.billed) return;
    turn.billed = true;
    const idx = this.awaitingUsage.indexOf(turn);
    if (idx >= 0) this.awaitingUsage.splice(idx, 1);

    /*
     * The totals are SUMMED HERE rather than read from `totalInputTokens`.
     *
     * This repo's containment rule is that a total always includes its
     * breakdown — `audioInputTokens` lives inside `inputUnits` — and `priceLeg`
     * subtracts on that basis. AWS documents `usageEvent` as carrying both
     * `details.*.input.speechTokens`/`textTokens` and a flat `totalInputTokens`,
     * but says NOWHERE whether the flat number is their sum. Trusting it and
     * being wrong either double-bills the speech half or drops it.
     *
     * Adding the two halves ourselves makes the invariant true by construction
     * instead of by assumption, and it is the one reading that cannot be
     * inconsistent with the breakdown it contains. `nova:probe` prints the
     * vendor's flat totals next to these so the assumption is checkable.
     */
    const leg: LegUsage = {
      leg: 'realtime',
      providerId: PROVIDER_ID,
      modelId: this.modelId,
      unit: 'tokens',
      inputUnits: turn.speechIn + turn.textIn,
      outputUnits: turn.speechOut + turn.textOut,
      audioInputTokens: turn.speechIn,
      audioOutputTokens: turn.speechOut,
      audioSeconds: round(pcm16DurationMs(turn.audioBytes, this.sessionRate) / 1000, 3),
      source: turn.sawUsage ? 'vendor' : 'local',
    };

    /*
     * A turn that never ran is abandoned, not billed — the same distinction
     * `PipelineSession` makes with its `pending` phase. The live case here is
     * the local detector firing on a cough: `beginTurn()` stamps t0, Nova's own
     * endpointing never agrees that a turn happened, and no completion is ever
     * created. Emitting a row would put a turn on the invoice that consumed
     * nothing.
     */
    if (!turn.sawUsage && turn.completionId === undefined && turn.audioBytes === 0) {
      this.ctx.events.onLog('info', `turn ${turn.turnId} produced no completion and was not billed`);
      return;
    }

    if (!turn.sawUsage) {
      // Ran, but the vendor never said what it cost. Nothing was counted, so
      // nothing is claimed — a zero row here would price the turn at exactly
      // zero and let the session total pass itself off as complete.
      leg.unpricedReason = missingReason ?? 'Nova Sonic reported no usage for this turn';
    }

    this.ctx.events.onUsage(turn.turnId, [leg]);
  }

  private flushBilling(reason: string): void {
    for (const turn of [...this.awaitingUsage]) this.bill(turn, reason);
  }

  /**
   * The turn a labelled event belongs to.
   *
   * The subtlety here cost three separate bugs, all with the same root. The
   * obvious rule — "a completion we no longer hold may still be claimed by a
   * turn that has not bound one yet" — is what the OpenAI leg does, and it is
   * safe THERE because `speech_stopped` and `response.created` are milliseconds
   * apart. On Nova the same window is the endpointing pause: a turn opened by
   * the local detector does not bind a `completionId` until `completionStart`,
   * which is a documented 1.5-2.0s later. For those two seconds every straggler
   * from the PREVIOUS completion matched the new turn, and:
   *
   *   · a late `audioOutput` was played to the user and marked
   *     `first_audio_out` on the new turn, so the bench's headline
   *     time-to-first-audio read ~40ms for a turn whose real audio arrived half
   *     a second later — measured against the previous turn's speech;
   *   · a late `usageEvent` billed the previous completion's tokens a SECOND
   *     time, onto the new turn;
   *   · and that in turn set `sawUsage` on a turn Nova never answered, which
   *     defeated the "a turn that never ran is not billed" guard and invoiced a
   *     phantom turn as `source: 'vendor'`.
   *
   * So a completion id is remembered once it has ever been bound, and an event
   * carrying a remembered id that no turn still holds is DROPPED. An id never
   * seen before is different: `audioOutput` may legitimately precede
   * `completionStart`, and an unbound active turn is the only honest owner for
   * it, so it claims it and binds.
   */
  private turnFor(completionId?: string): Turn | undefined {
    if (completionId) {
      if (this.active?.completionId === completionId) return this.active;
      const match = this.awaitingUsage.find((t) => t.completionId === completionId);
      if (match) return match;
      // Seen before, held by nobody: it belongs to a turn already retired.
      if (this.seenCompletions.has(completionId)) return undefined;
      // Never seen, and the active turn has nothing bound — it can claim it.
      if (this.active && !this.active.ended && this.active.completionId === undefined) {
        this.bindTo(this.active, completionId);
        return this.active;
      }
      return undefined;
    }
    // Unlabelled. The active turn if there is one, else the oldest unbilled.
    return this.active ?? this.awaitingUsage[0];
  }

  /** Binds a completion id to a turn and remembers it for `turnFor`. */
  private bindTo(turn: Turn, completionId: string): void {
    turn.completionId = completionId;
    this.seenCompletions.add(completionId);
  }

  private blockOf(msg: Record<string, any>): Block | undefined {
    const key = msg.contentId ?? msg.contentName;
    return (key ? this.blocks.get(key) : undefined) ?? this.lastBlock;
  }
}

export class NovaSonicProvider implements RealtimeProvider {
  readonly id = PROVIDER_ID;
  readonly name = 'AWS Nova Sonic';

  createSession(ctx: SessionContext): VoiceSession {
    return new NovaSonicSession(ctx.sessionId, ctx);
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (n: number, dp: number) => Number(n.toFixed(dp));
