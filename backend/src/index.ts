import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { config, FIREBASE_DEFAULT_JWKS_URL, redactSecrets } from './config.js';
import {
  AUTH_USERNAME,
  authEnabled,
  googleAuthEnabled,
  passwordAuthEnabled,
  SessionBook,
  tokenFromRequest,
  verifyLogin,
  type AuthSession,
} from './auth.js';
import { verifyFirebaseIdToken } from './auth-google.js';
import { Allowlist, isAllowed, type AllowEntry } from './auth-allowlist.js';
import { HttpError } from './http-error.js';
import { catalogWithReadiness } from './providers/catalog.js';
import { registeredIds } from './providers/factory.js';
import { drainLiveSockets, handleSocket } from './server/session-socket.js';
import { CANONICAL_SAMPLE_RATE } from './shared/protocol.js';
import { sessionStore } from './store/SessionStore.js';
import { FX_CHECKED_ON, inrPerUsd, rateTable, usdPerInr } from './pricing/rates.js';

const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json());

/**
 * Express 4 does not catch rejections from async handlers — an unguarded one
 * leaves the request hanging with no response and no status. Every async route
 * goes through this.
 */
const route =
  (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response): void => {
    fn(req, res).catch((err: Error) => {
      // An expected refusal that already knows its answer (bad allowlist entry,
      // rejected sign-in token, ...). `message` may carry detail for the log only.
      if (err instanceof HttpError) {
        console.warn(`[api] ${req.method} ${req.path} ${err.status}:`, err.message);
        if (!res.headersSent) res.status(err.status).json({ error: redactSecrets(err.publicMessage) });
        return;
      }
      console.error(`[api] ${req.method} ${req.path} failed:`, err.message);
      // Scrubbed like every other message that leaves this process: the
      // invariant is stated as absolute, and an fs error already carries
      // SESSION_DIR.
      if (!res.headersSent) res.status(500).json({ error: redactSecrets(err.message) });
    });
  };

/**
 * FIREBASE_JWKS_URL decides who can mint a valid identity. The test suite
 * points it at a key it holds on 127.0.0.1; anything else is refused at boot
 * rather than warned about, since a warning in a container log is not read.
 */
if (config.firebase.jwksUrl !== FIREBASE_DEFAULT_JWKS_URL) {
  const u = URL.canParse(config.firebase.jwksUrl) ? new URL(config.firebase.jwksUrl) : undefined;
  if (!u || u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error(
      `FIREBASE_JWKS_URL=${config.firebase.jwksUrl} is not allowed: it exists only to point tests at a local key ` +
        `(http://127.0.0.1:<port>/...). Unset it to use Google's keys.`,
    );
  }
}

const sessions = new SessionBook(config.authSessionTtlMs);
const allowlist = new Allowlist(config.authAllowlistFile, config.authAllowedDomains);

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

/**
 * Admin-only routes. With the gate off there is no one to be admin, and the
 * allowlist only matters to a gate that is on — so these are closed (403)
 * rather than open, unlike every other route.
 */
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!authEnabled()) {
    res.status(403).json({ error: 'Sign-in is not configured' });
    return;
  }
  const session = sessions.get(tokenFromRequest(req));
  if (!session) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (session.role !== 'admin') {
    res.status(403).json({ error: 'Admins only' });
    return;
  }
  res.locals.session = session;
  next();
}

const isAdminEmail = (email: string): boolean => config.authAdminEmails.includes(email.toLowerCase());

/**
 * Who may hold a Google session: an AUTH_ADMIN_EMAILS account, or anyone the
 * allowlist covers. The one rule, for sign-in and for revoking on removal alike.
 */
const admits = (entries: AllowEntry[], email: string): boolean => isAdminEmail(email) || isAllowed(entries, email);

const allowlistBody = (entries: AllowEntry[]) => ({ entries, adminEmails: config.authAdminEmails });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, sampleRate: CANONICAL_SAMPLE_RATE, registered: registeredIds() });
});

/**
 * HMAC secret the login page HMACs the password with. Public on purpose —
 * the password itself is what is secret; this key just keeps it off the wire.
 */
app.get('/api/auth/config', (_req, res) => {
  const required = authEnabled();
  const password = passwordAuthEnabled();
  const google = googleAuthEnabled();
  res.json({
    required,
    username: AUTH_USERNAME,
    sessionTtlMs: config.authSessionTtlMs,
    password,
    ...(password ? { hmacSecret: config.authHmacSecret } : {}),
    ...(google
      ? {
          google: {
            apiKey: config.firebase.apiKey,
            authDomain: config.firebase.authDomain,
            projectId: config.firebase.projectId,
            ...(config.firebase.appId ? { appId: config.firebase.appId } : {}),
          },
        }
      : {}),
  });
});

app.post('/api/auth/login', (req, res) => {
  if (!passwordAuthEnabled()) {
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
  res.json(sessions.create(username, { role: 'admin', method: 'password' }));
});

/**
 * Google sign-in. The browser ran Firebase's Google popup and posts the ID
 * token it got; we verify it, check the allowlist, and hand back one of our own
 * session tokens — so the WebSocket, the <audio> URLs and every route keep
 * working exactly as they do for the password login.
 */
app.post(
  '/api/auth/google',
  route(async (req, res) => {
    if (!googleAuthEnabled()) {
      res.status(503).json({ error: 'Google sign-in is not configured (set FIREBASE_PROJECT_ID and FIREBASE_API_KEY)' });
      return;
    }
    // A bad token (401) or unreachable Google keys (503) throw an HttpError that `route` answers.
    const { email } = await verifyFirebaseIdToken(typeof req.body?.idToken === 'string' ? req.body.idToken : '', {
      projectId: config.firebase.projectId,
      jwksUrl: config.firebase.jwksUrl,
    });
    if (!admits(await allowlist.list(), email)) {
      console.warn(`[auth] google sign-in refused, not on the allowlist: ${email}`);
      res.status(403).json({ error: `${email} is not allowed to sign in. Ask an admin to add it or its domain.` });
      return;
    }
    const admin = isAdminEmail(email);
    console.log(`[auth] google sign-in: ${email}${admin ? ' (admin)' : ''}`);
    res.json(sessions.create(email, { role: admin ? 'admin' : 'member', method: 'google' }));
  }),
);

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

/** Who may sign in with Google. Admins only — it lists colleagues' addresses. */
app.get(
  '/api/auth/allowlist',
  requireAdmin,
  route(async (_req, res) => {
    res.json(allowlistBody(await allowlist.list()));
  }),
);

app.post(
  '/api/auth/allowlist',
  requireAdmin,
  route(async (req, res) => {
    // A junk value (400) or an unreadable file (503) throw an HttpError that `route` answers.
    const by = (res.locals.session as AuthSession).username;
    const entries = await allowlist.add(req.body?.kind, req.body?.value, by);
    console.log(`[auth] allowlist + ${req.body?.kind} ${String(req.body?.value)} by ${by}`);
    res.json(allowlistBody(entries));
  }),
);

app.delete(
  '/api/auth/allowlist',
  requireAdmin,
  route(async (req, res) => {
    const by = (res.locals.session as AuthSession).username;
    const entries = await allowlist.remove(req.body?.kind, req.body?.value);
    // Out now, not at token expiry: end every Google session the list no longer covers.
    const revoked = sessions.revokeWhere((s) => s.method === 'google' && !admits(entries, s.username));
    console.log(`[auth] allowlist - ${req.body?.kind} ${String(req.body?.value)} by ${by} (${revoked} signed out)`);
    res.json({ ...allowlistBody(entries), revoked });
  }),
);

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

if (config.staticDir) serveUi(app, config.staticDir);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/session' });
/**
 * Open sockets per session token. The token is checked once, on upgrade — so
 * without this a signed-out, expired or de-listed user's open tab could keep
 * starting vendor sessions (each billed) until they closed it. Every way a
 * token ends goes through `SessionBook.onRevoke`, which closes its sockets with
 * 4401: the browser treats that as "sign in again", the socket handler as the
 * end of the conversation.
 */
const socketsByToken = new Map<string, Set<WebSocket>>();
sessions.onRevoke = (token) => {
  const open = socketsByToken.get(token);
  if (!open) return;
  socketsByToken.delete(token);
  for (const ws of open) ws.close(4401, 'signed out');
};

wss.on('connection', (ws, req) => {
  if (!authEnabled()) {
    handleSocket(ws);
    return;
  }
  const token = tokenFromRequest(req);
  if (!token || !sessions.get(token)) {
    ws.close(4401, 'unauthorized');
    return;
  }
  let open = socketsByToken.get(token);
  if (!open) socketsByToken.set(token, (open = new Set()));
  open.add(ws);
  ws.once('close', () => {
    const set = socketsByToken.get(token);
    set?.delete(ws);
    if (set?.size === 0) socketsByToken.delete(token);
  });
  handleSocket(ws);
});

const onListen = (): void => {
  const where = `${config.host ?? 'localhost'}:${config.port}`;
  console.log(`backend listening on http://${where}`);
  console.log(`  ws  ws://${where}/ws/session`);
  if (config.staticDir) console.log(`  ui  ${config.staticDir}`);
  console.log(`  registered:`, registeredIds());
  if (googleAuthEnabled()) {
    const domains = allowlist.pinned.join(', ') || '(none pinned)';
    console.log(`  auth: google sign-in on (firebase ${config.firebase.projectId}; domains ${domains})`);
    if (config.firebase.jwksUrl !== FIREBASE_DEFAULT_JWKS_URL) {
      console.warn(`  auth: FIREBASE_JWKS_URL is overridden (${config.firebase.jwksUrl}) — test use only`);
    }
    if (!passwordAuthEnabled() && config.authAdminEmails.length === 0) {
      console.warn('  auth: no admin — set AUTH_ADMIN_EMAILS (or the password login), or nobody can edit the allowlist');
    }
  } else if (config.firebase.projectId || config.firebase.apiKey) {
    console.warn('  auth: only one of FIREBASE_PROJECT_ID / FIREBASE_API_KEY is set — google sign-in is off');
  }
  if (config.authPassword && !config.authHmacSecret) {
    console.warn('  auth: AUTH_PASSWORD is set but AUTH_HMAC_SECRET is not — password login is off');
  } else if (config.authHmacSecret && !config.authPassword) {
    console.warn('  auth: AUTH_HMAC_SECRET is set but AUTH_PASSWORD is not — password login is off');
  } else if (authEnabled()) {
    console.log(`  auth: required (session ${Math.round(config.authSessionTtlMs / 3_600_000)}h)`);
  }
};
if (config.host) server.listen(config.port, config.host, onListen);
else server.listen(config.port, onListen);

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, draining sessions`);
  server.close();
  void drainLiveSockets(8_000)
    .catch((err) => console.error('drain failed:', err))
    .finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Production UI: hashed Vite assets under /assets, everything else from the
 * build directory, SPA fallback to index.html. API and WebSocket paths stay
 * 404 JSON rather than the parchment shell.
 */
function serveUi(app: express.Express, dir: string): void {
  const root = resolve(dir);
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    throw new Error(`STATIC_DIR ${root} does not contain index.html`);
  }
  app.use(
    '/assets',
    express.static(join(root, 'assets'), { maxAge: '365d', immutable: true, fallthrough: false }),
  );
  app.use(
    express.static(root, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get('*', (req, res) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path === '/ws' || req.path.startsWith('/ws/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}
