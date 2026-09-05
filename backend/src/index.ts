import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { catalogWithReadiness } from './providers/catalog.js';
import { registeredIds } from './providers/factory.js';
import { handleSocket } from './server/session-socket.js';
import { CANONICAL_SAMPLE_RATE } from './shared/protocol.js';
import { sessionStore } from './store/SessionStore.js';
import { FX_CHECKED_ON, inrPerUsd, rateTable, usdPerInr } from './pricing/rates.js';

const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, sampleRate: CANONICAL_SAMPLE_RATE, registered: registeredIds() });
});

/** Everything the frontend needs to render its provider/model toggles. */
app.get('/api/catalog', (_req, res) => {
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
app.get('/api/pricing', (_req, res) => {
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
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  };

/** Completed conversations, newest first. */
app.get(
  '/api/sessions',
  route(async (_req, res) => {
    res.json({ sessions: await sessionStore.list() });
  }),
);

app.get(
  '/api/sessions/:id',
  route(async (req, res) => {
    const summary = await sessionStore.get(req.params.id);
    if (!summary) {
      res.status(404).json({ error: 'No such session' });
      return;
    }
    res.json(summary);
  }),
);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/session' });
wss.on('connection', handleSocket);

server.listen(config.port, () => {
  console.log(`backend listening on http://localhost:${config.port}`);
  console.log(`  ws  ws://localhost:${config.port}/ws/session`);
  console.log(`  registered:`, registeredIds());
});
