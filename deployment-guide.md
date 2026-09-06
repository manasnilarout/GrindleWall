# Deploy Grindelwald with Docker

Grindelwald is two npm projects — a Vite UI and a Node server that owns
`/api/*` plus one WebSocket per voice session at `/ws/session`. The browser
already talks **same-origin** (`fetch('/api/…')`, `ws(s)://<host>/ws/session`),
so production is a reverse proxy (or the server itself) on one public port.

This guide covers the files under `deploy/`. You do not need vendor API keys
to bring the stack up: mock providers stay registered, and the bench runs
end-to-end with synthetic audio.

## What you are deploying

```
browser ──HTTP/WS──► :8080
                       │
          ┌────────────┴────────────┐
          │  UI  (Vite build)       │
          │  /api  → backend        │
          │  /ws/session → backend  │
          └────────────┬────────────┘
                       │
                 Express + `ws`
                 PCM16 LE mono @ 24 kHz
                 records → /data/sessions
```

Two shapes, same app:

| Shape | Files | Use when |
|---|---|---|
| **Two services** | `deploy/docker-compose.yml`, `Dockerfile.backend`, `Dockerfile.frontend`, `nginx.conf` | A VM or Docker host. nginx serves the UI and proxies `/api` + `/ws`. |
| **One container** | `deploy/Dockerfile`, `docker-compose.single.yml` | Cloud platforms that give you one process and one `PORT` (Cloud Run, Render, Railway, Fly, a single ECS task). Express serves the Vite build from `STATIC_DIR`. |

Both persist conversations on a volume at `/data/sessions` (JSON + stereo WAV).

## Prerequisites

- Docker Engine 24+ and Compose v2 (`docker compose version`).
- For a cloud registry: permission to push an image (GHCR, Docker Hub, ECR, Artifact Registry, …).
- Vendor keys only for the providers you want live. Names match `backend/.env.example`.
- `deploy/.env` must exist for Compose (`cp .env.example .env`). Empty values are fine.

**Microphone access needs a secure context.** Browsers allow `getUserMedia` on
`http://localhost` and on **HTTPS**. A public HTTP URL will load the UI and
accept typed turns, but **Start mic** will fail. Put TLS in front of any
non-localhost host (load balancer, Caddy, Traefik, or your cloud ingress).

The client picks `ws:` vs `wss:` from `location.protocol`, so HTTPS automatically
upgrades the session socket. Terminate TLS at the edge and forward HTTP + the
WebSocket upgrade to the container.

## Quick start (local or a VM)

From the repository root:

```bash
cd deploy
cp .env.example .env          # required; empty keys use mocks
# edit .env and paste only the keys you need

docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080). Click **Connect**, then
**Start mic**, or type a turn. You should hear the mock tone and see a latency
waterfall.

Useful commands:

```bash
docker compose ps
docker compose logs -f backend
curl -sS http://localhost:8080/api/health
curl -sS http://localhost:8080/api/catalog | head
docker compose down              # keep the volume
docker compose down -v           # also drop saved sessions
```

Single-container variant (same port, one process). That file uses the Compose
project name `grindelwald-single` so it does not collide with the two-service
project; they still both default to host port 8080 — set `HTTP_PORT` on one
of them if you run both.

```bash
cd deploy
docker compose -f docker-compose.single.yml up --build
```

Change the published port with `HTTP_PORT=80 docker compose up --build`, or set
`HTTP_PORT` in `.env`. If the URL is no longer `http://localhost:8080`, update
`CORS_ORIGINS` to that origin (only required if something calls the API
cross-origin; same-origin through the proxy does not depend on CORS).

## Environment

Compose reads `deploy/.env` via `env_file` (the file must exist). **Do not
bake keys into an image.** Pass them at run time:

- `env_file: .env` on a VM
- the platform’s secret store / service environment on a cloud host

| Variable | Default in containers | Meaning |
|---|---|---|
| `PORT` | `8787` (backend image) / `8080` (all-in-one) | Listen port inside the container. Cloud hosts often inject this — keep it. Compose pins it; a raw `docker run --env-file` does not, so do not set `PORT=8787` in `.env` for the all-in-one image. |
| `HOST` | `0.0.0.0` in the images | Bind address. Unset locally so Node keeps its dual-stack default. |
| `STATIC_DIR` | unset / `/app/ui` in the all-in-one image | Directory of the Vite build. When set, Express serves the UI. |
| `SESSION_DIR` | `/data/sessions` | JSON records + stereo WAVs. Mount a volume here. |
| `CORS_ORIGINS` | `http://localhost:8080` | Comma-separated allowed origins. |
| `HTTP_PORT` | `8080` | Host port Compose publishes. Compose-only. |
| `SESSION_AUDIO` | on (`0` disables) | Record each conversation to a stereo WAV. |
| `SESSION_AUDIO_MAX_MINUTES` | `60` | Cap on one recording. Stereo PCM16 @ 24 kHz is ~5.8 MB per recorded minute. |
| `SESSION_MAX_RECORDS` | unset (keep all) | Prune oldest conversations when set to a positive integer. |
| `CARTESIA_USD_PER_CREDIT` | `0.00005` | Cartesia credit → USD. |
| `USD_PER_INR` | `0.0113` | Assumed FX, not a feed. Travels in every session summary. |

Vendor keys — set only those you use. A missing key leaves that provider
**not ready** in `/api/catalog`; it does not fail the process.

```
OPENAI_API_KEY
GOOGLE_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_AGENT_ID
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
SARVAM_API_KEY
DEEPGRAM_API_KEY
ASSEMBLYAI_API_KEY
ANTHROPIC_API_KEY
GROQ_API_KEY
MURF_API_KEY
CARTESIA_API_KEY
```

Session files hold the start config (including the system prompt) and usage —
**not** credentials. Treat the volume as conversation content anyway.

Errors that reach the browser are scrubbed (`redactSecrets`). Do not interpolate
raw environment values into logs you ship off-box.

## Persistence

Both Compose files mount a named volume `session-data` → `/data/sessions`.

- One JSON file per conversation, rewritten after every turn.
- Optional stereo WAV beside it (`<recordId>.wav`), left mic / right assistant.
- The UI lists them at `/api/sessions` and plays audio from
  `/api/sessions/:id/audio` (HTTP `Range`).

On a VM, a bind mount works if the process user can write it. The images run
as `node` (uid 1000):

```bash
mkdir -p /var/lib/grindelwald/sessions
sudo chown 1000:1000 /var/lib/grindelwald/sessions
```

```yaml
# in compose, replace the named volume with:
volumes:
  - /var/lib/grindelwald/sessions:/data/sessions
```

Back the directory up if the numbers matter; there is no database to dump.

## Build and run without Compose

From the repository root (the Docker context is always the repo, not `deploy/`):

```bash
# all-in-one
cp -n deploy/.env.example deploy/.env
docker build -f deploy/Dockerfile -t grindelwald:local .
docker run --rm -p 8080:8080 --env-file deploy/.env \
  -v grindelwald-sessions:/data/sessions grindelwald:local

# split images
docker build -f deploy/Dockerfile.backend -t grindelwald-backend:local .
docker build -f deploy/Dockerfile.frontend -t grindelwald-frontend:local .
```

The frontend image proxies to the hostname `backend` on port 8787. That is the
Compose service name. On a custom network, either keep that name or change the
`upstream` in `deploy/nginx.conf` and rebuild.

## HTTPS in front

The containers speak HTTP. Put TLS on the host or at the cloud edge.

**Caddy** on the same VM (automatic Let’s Encrypt):

```caddyfile
bench.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy forwards WebSocket upgrades by default. Then set:

```
CORS_ORIGINS=https://bench.example.com
```

**nginx** on the host should mirror the `/ws/` block in `deploy/nginx.conf`:
`Upgrade` / `Connection` headers, `proxy_buffering off`, and a long
`proxy_read_timeout`. Buffering the WebSocket or the TTS stream will destroy
time-to-first-audio — that number is the point of the bench.

**Cloud load balancers** (Cloud Run, Cloud Load Balancing, ALB, Azure Container
Apps): enable HTTP/1.1 WebSocket upgrade, idle timeout of at least the longest
conversation you expect, and HTTPS on the public hostname.

## Cloud platforms

Build from the repo root, push, then point the service at the **all-in-one**
image (`deploy/Dockerfile`) unless you are running a two-task mesh yourself.

Set `PORT` to whatever the platform injects (Cloud Run uses `8080`; the
Dockerfile already does). Set `SESSION_DIR=/data/sessions` and attach a
writable volume if you want recordings to survive a replace. Without a volume,
records live on the container filesystem and vanish when the instance is
replaced.

### Google Cloud Run

Create an Artifact Registry Docker repo, then:

```bash
gcloud builds submit --config deploy/cloudbuild.yaml \
  --substitutions=_REGION=us-central1,_REPO=grindelwald

gcloud run deploy grindelwald \
  --image us-central1-docker.pkg.dev/PROJECT/grindelwald/grindelwald \
  --port 8080 \
  --cpu 1 --memory 1Gi \
  --timeout 3600 \
  --session-affinity \
  --set-env-vars CORS_ORIGINS=https://YOUR_SERVICE.run.app
```

`--set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest` only works after that
secret exists in Secret Manager — create it first, then add the flag. Do not
pass `--tag` together with `--config`; `deploy/cloudbuild.yaml` already tags
the image.

Cloud Run request timeout caps a single WebSocket (max 60 minutes). Session
affinity is cheap insurance if more than one instance is running.

If `/data/sessions` must outlive the instance, mount a volume that can do a
same-directory `rename()` — the store writes a sibling `.tmp` and renames it
into place. NFS / Cloud Filestore (or EFS on AWS) is the right shape. Cloud
Storage FUSE is a weak POSIX: that rename is often a copy, and the uid is
often not `node` (1000). Without a volume, records die when the instance is
replaced.

### AWS ECS / Fargate

Push `deploy/Dockerfile` to ECR. One task definition, container port 8080,
awsvpc. Put an ALB in front with an HTTPS listener and a target group that
forwards WebSockets (HTTP/1.1, idle timeout ≥ conversation length). Mount an
EFS volume on `/data/sessions` if more than one task can run. Inject secrets
from SSM or Secrets Manager — do not put keys in the task JSON.

### Azure Container Apps

One container, ingress on 8080, HTTPS external. Enable WebSocket on the
ingress (default). Attach an Azure Files volume at `/data/sessions` for
durable records. Map secrets into the same env var names as `.env.example`.

### Fly.io

```toml
# fly.toml (sketch)
[build]
  dockerfile = "deploy/Dockerfile"

[env]
  PORT = "8080"
  SESSION_DIR = "/data/sessions"

[http_service]
  internal_port = 8080
  force_https = true

[[mounts]]
  source = "grindelwald_data"
  destination = "/data/sessions"
```

`fly secrets set OPENAI_API_KEY=…` (and the rest you use).

### Render / Railway

Set the Dockerfile path to `deploy/Dockerfile` and the context to the repo
root. Map the platform `PORT`. Attach a persistent disk at `/data/sessions`.
Paste keys into the service environment UI.

### A generic Linux VM

Install Docker, clone the repo, `cd deploy && docker compose up -d --build`.
Point Caddy or nginx at `127.0.0.1:8080`. Open 443 (and 80 for the ACME
challenge) only. Do not publish port 8787 to the internet.

## Health, readiness, resources

- Liveness/readiness URL: `GET /api/health` →
  `{ ok: true, sampleRate: 24000, registered: { … } }`.
- `GET /api/catalog` is the heavier check: it is what the UI loads, and
  `ready` / `missingEnv` on each provider tells you which keys the process
  actually has.
- One vCPU and 512 MB–1 GB is enough for mock traffic and a handful of live
  turns. Live vendor sockets and session WAVs are the memory/disk cost, not
  the Node process.
- Do not put a buffering proxy, a 30s idle timeout, or HTTP/2-only (no
  WebSocket) in front of `/ws/session`.

## Verify a deployment

```bash
# process is up
curl -fsS https://bench.example.com/api/health

# UI is the Vite build, not a 404
curl -fsS -o /dev/null -w '%{http_code}\n' https://bench.example.com/

# catalog is JSON and lists mock providers as ready
curl -fsS https://bench.example.com/api/catalog | grep -E '"id": "mock-'

# WebSocket upgrade (should be 101; needs wscat or similar)
# npx wscat -c wss://bench.example.com/ws/session
```

In the browser, on HTTPS (or localhost):

1. The parchment UI loads; the catalog populates.
2. **Connect** → status becomes connected (socket open).
3. Type a turn with mocks → assistant transcript + audio + a metrics row.
4. **Start mic** is allowed by the browser (secure context).
5. After **End conversation**, the run appears in history and the recording
   (if `SESSION_AUDIO` is on and you used the mic) is playable.

Typed-only conversations have no WAV; that is expected.

## Updating

```bash
git pull
cd deploy
docker compose up -d --build
```

Images do not include `deploy/.env` or `backend/.env`. Keys survive a rebuild.
The `session-data` volume survives `up --build`; only `down -v` deletes it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| UI loads, **Connect** fails / console says backend :8787 | `/ws/session` is not reaching the backend. Check the proxy upgrade headers and that nothing strips `/ws`. |
| **Start mic** denied or `getUserMedia` throws | The page is HTTP on a non-localhost host. Serve HTTPS. |
| Catalog shows a provider not ready | Its `envKeys` are empty in the container environment. `docker compose exec backend env \| grep KEY` (values will print — do this on a private shell). |
| 502 from nginx | Backend not healthy yet, or the hostname is not `backend`. `docker compose logs backend`. nginx re-resolves `backend` via Docker DNS every 10s. |
| First audio is seconds late vs local | An intermediate proxy is buffering. Disable `proxy_buffering` / equivalent. |
| Recordings 404 | `SESSION_AUDIO=0`, or the conversation was typed-only, or `/data/sessions` is not the mounted volume. |
| Disk fills | WAVs are ~5.8 MB/minute. Lower `SESSION_AUDIO_MAX_MINUTES` or set `SESSION_MAX_RECORDS`. |
| CORS errors in the browser | You are calling the API from a different origin than `CORS_ORIGINS`. Same-origin through :8080 should not hit this. |
| Container exits on boot: `STATIC_DIR … does not contain index.html` | You ran the backend image with `STATIC_DIR` set. That variable belongs on the all-in-one image only. |

## Files in `deploy/`

| File | Role |
|---|---|
| `Dockerfile` | All-in-one image (Node + Vite build, `STATIC_DIR=/app/ui`). |
| `Dockerfile.backend` | API + WebSocket only. |
| `Dockerfile.frontend` | nginx + Vite build, proxies to `backend:8787`. |
| `nginx.conf` | SPA, `/api/`, `/ws/` (no buffering, long WS timeout). |
| `docker-compose.yml` | Two-service stack, UI on `${HTTP_PORT:-8080}`. |
| `docker-compose.single.yml` | One-service stack (Compose project `grindelwald-single`). |
| `cloudbuild.yaml` | Cloud Build for the all-in-one image (`gcloud builds submit --config …`). |
| `.env.example` | Keys and deploy knobs. Copy to `.env`. |

The Docker **context** is the repository root. `.dockerignore` lives there so
`node_modules`, `.env`, and `data/` never enter a build.
