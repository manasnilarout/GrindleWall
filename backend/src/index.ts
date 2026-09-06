import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { config, redactSecrets } from './config.js';
import {
  AUTH_USERNAME,
  authEnabled,
  SessionBook,
  tokenFromRequest,
  verifyLogin,
} from './auth.js';
import { catalogWithReadiness } from './providers/catalog.js';
import { registeredIds } from './providers/factory.js';
import { handleSocket } from './server/session-socket.js';
import { CANONICAL_SAMPLE_RATE } from './shared/protocol.js';
import { sessionStore } from './store/SessionStore.js';
import { FX_CHECKED_ON, inrPerUsd, rateTable, usdPerInr } from './pricing/rates.js';

const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json());

const sessions = new SessionBook(config.authSessionTtlMs);

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!authEnabled()) {
    next();
    return;
  }
  if (sessions.get(tokenFromRequest(req))) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, sampleRate: CANONICAL_SAMPLE_RATE, registered: registeredIds() });
});

/**
 * HMAC secret the login page HMACs the password with. Public on purpose —
 * the password itself is what is secret; this key just keeps it off the wire.
 */
app.get('/api/auth/config', (_req, res) => {
  const required = authEnabled();
  res.json({
    required,
    username: AUTH_USERNAME,
    sessionTtlMs: config.authSessionTtlMs,
    ...(required ? { hmacSecret: config.authHmacSecret } : {}),
  });
});

app.post('/api/auth/login', (req, res) => {
  if (!authEnabled()) {
    res.status(503).json({ error: 'Login is not configured (set AUTH_PASSWORD and AUTH_HMAC_SECRET)' });
    return;
  }
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const hmac = typeof req.body?.hmac === 'string' ? req.body.hmac : '';
  const ok = verifyLogin(
    { username, hmac },
    { username: AUTH_USERNAME, password: config.authPassword, hmacSecret: config.authHmacSecret },
  );
  if (!ok) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  res.json(sessions.create(username));
});

app.post('/api/auth/logout', (req, res) => {
  const token = tokenFromRequest(req);
  if (token) sessions.revoke(token);
  res.json({ ok: true });
});

app.get('/api/auth/session', (req, res) => {
  if (!authEnabled()) {
    res.json({ required: false, session: null });
    return;
  }
  const session = sessions.get(tokenFromRequest(req));
  if (!session) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ required: true, session });
});

/** Everything the frontend needs to render its provider/model toggles. */
app.get('/api/catalog', requireAuth, (_req, res) => {
  const registered = registeredIds();
  const all = new Set([...registered.realtime, ...registered.stt, ...registered.llm, ...registered.tts]);
  res.json({
    sampleRate: CANONICAL_SAMPLE_RATE,
    providers: catalogWithReadiness().map((p) => ({ ...p, registered: all.has(p.id) })),
  });
});

/**
 * The rates every cost estimate is derived from, with the source URL and the
 * date each was read. Surfaced so a number in the UI can always be traced back
 * to a vendor page rather than taken on faith.
 */
app.get('/api/pricing', requireAuth, (_req, res) => {
  res.json({ usdPerInr, inrPerUsd, fxCheckedOn: FX_CHECKED_ON, rates: rateTable() });
});

/**
 * Express 4 does not catch rejections from async handlers — an unguarded one
 * leaves the request hanging with no response and no status. Every async route
 * goes through this.
 */
const route =
  (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response): void => {
    fn(req, res).catch((err: Error) => {
      console.error(`[api] ${req.method} ${req.path} failed:`, err.message);
      // Scrubbed like every other message that leaves this process: the
      // invariant is stated as absolute, and an fs error already carries
      // SESSION_DIR.
      if (!res.headersSent) res.status(500).json({ error: redactSecrets(err.message) });
    });
  };

/** Completed conversations, newest first. */
app.get(
  '/api/sessions',
  requireAuth,
  route(async (_req, res) => {
    res.json({ sessions: await sessionStore.list() });
  }),
);

app.get(
  '/api/sessions/:id',
  requireAuth,
  route(async (req, res) => {
    const summary = await sessionStore.get(req.params.id);
    if (!summary) {
      res.status(404).json({ error: 'No such session' });
      return;
    }
    res.json(summary);
  }),
);

/**
 * Pipes a file to the response and cleans up after itself.
 *
 * `pipe()` alone does neither half of this. A client that walks away mid-body —
 * which is precisely what an `<audio>` element does every time the listener
 * seeks, since it aborts the request and opens a new Range — leaves the read
 * stream open, and a descriptor is not reclaimed by GC. Measured at one leaked
 * fd per aborted download; a few hundred and the process cannot accept a
 * WebSocket upgrade any more. A read error after the headers are out cannot be
 * turned into a status code either, so the response is destroyed rather than
 * left hanging forever.
 */
function sendFile(res: express.Response, stream: ReturnType<typeof createReadStream>): void {
  res.on('close', () => stream.destroy());
  stream.on('error', (err) => {
    console.error('[api] recording read failed:', err);
    // Headers are set but not flushed until the first write, so an open()
    // failure can still be reported properly. Once bytes are out the only
    // honest signal left is a broken connection.
    if (!res.headersSent) {
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Range');
      res.status(500).json({ error: 'Recording could not be read' });
      return;
    }
    res.destroy();
  });
  stream.pipe(res);
}

/**
 * The conversation's stereo recording: left channel the microphone, right the
 * assistant. Streamed rather than buffered — a long call is tens of megabytes,
 * and `Range` support is what lets a browser <audio> element seek in it.
 */
app.get(
  '/api/sessions/:id/audio',
  requireAuth,
  route(async (req, res) => {
    let path: string;
    try {
      path = sessionStore.audioPath(req.params.id);
    } catch {
      res.status(400).json({ error: 'Bad record id' });
      return;
    }
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) {
      res.status(404).json({ error: 'No recording for this session' });
      return;
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      let start: number;
      let end: number;
      if (range[1] === '') {
        /*
         * A SUFFIX range: `bytes=-500` is the LAST 500 bytes (RFC 9110 §14.1.2),
         * not the first 500. Treating an absent start as 0 answered 206 with the
         * head of the file under a Content-Range claiming it was the tail — a
         * media element probing the end of a container got silent garbage rather
         * than an error.
         */
        const suffix = Number(range[2]);
        if (!range[2] || !Number.isFinite(suffix) || suffix <= 0) {
          res.setHeader('Content-Range', `bytes */${info.size}`);
          res.status(416).end();
          return;
        }
        start = Math.max(0, info.size - suffix);
        end = info.size - 1;
      } else {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      }
      if (!(start >= 0 && start <= end && end < info.size)) {
        res.setHeader('Content-Range', `bytes */${info.size}`);
        res.status(416).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      sendFile(res, createReadStream(path, { start, end }));
      return;
    }
    res.setHeader('Content-Length', String(info.size));
    sendFile(res, createReadStream(path));
  }),
);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/session' });
wss.on('connection', (ws, req) => {
  if (authEnabled() && !sessions.get(tokenFromRequest(req))) {
    ws.close(4401, 'unauthorized');
    return;
  }
  handleSocket(ws);
});

server.listen(config.port, () => {
  console.log(`backend listening on http://localhost:${config.port}`);
  console.log(`  ws  ws://localhost:${config.port}/ws/session`);
  console.log(`  registered:`, registeredIds());
  if (config.authPassword && !config.authHmacSecret) {
    console.warn('  auth: AUTH_PASSWORD is set but AUTH_HMAC_SECRET is not — login gate is off');
  } else if (config.authHmacSecret && !config.authPassword) {
    console.warn('  auth: AUTH_HMAC_SECRET is set but AUTH_PASSWORD is not — login gate is off');
  } else if (authEnabled()) {
    console.log(`  auth: required (session ${Math.round(config.authSessionTtlMs / 3_600_000)}h)`);
  }
});
