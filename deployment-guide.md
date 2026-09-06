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
| **Two services** | `deploy/docker-compose.yml`, `Dockerfile.backend`, `Dockerfile.frontend`, `nginx.conf`; plus `docker-compose.https.yml` + `nginx.https.conf` for TLS | A VM or Docker host. nginx serves the UI and proxies `/api` + `/ws`, and can terminate TLS for a public domain. |
| **One container** | `deploy/Dockerfile`, `docker-compose.single.yml` | Cloud platforms that give you one process and one `PORT` (Cloud Run, Render, Railway, Fly, a single ECS task). Express serves the Vite build from `STATIC_DIR`. |

Both persist conversations on a volume at `/data/sessions` (JSON + stereo WAV).

## Prerequisites

- Docker Engine 24+ and Compose v2 (`docker compose version`).
- For a cloud registry: permission to push an image (GHCR, Docker Hub, ECR, Artifact Registry, …).
- Vendor keys only for the providers you want live. Names match `backend/.env.example`.
- `deploy/.env` must exist for Compose (`cp .env.example .env`). Empty values are fine.
- For a public HTTPS host: a domain you can add a DNS record to, a static
  public IP, and ports 80 and 443 free on the machine and open inbound.

**Microphone access needs a secure context.** Browsers allow `getUserMedia` on
`http://localhost` and on **HTTPS**. A public HTTP URL will load the UI and
accept typed turns, but **Start mic** will fail. Any non-localhost host needs
TLS — [HTTPS on a VM](#https-on-a-vm-grindelwaldmagickvoicecom) does it in
nginx with a Let's Encrypt certificate; a load balancer or Caddy in front
works just as well.

The client picks `ws:` vs `wss:` from `location.protocol`, so HTTPS automatically
upgrades the session socket. Nothing in the app changes.

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
docker compose down              # keep the volumes
docker compose down -v           # also drop saved sessions (and, with the
                                 # TLS overlay, the certificate)
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
`HTTP_PORT` in `.env`. If the URL is no longer `http://localhost:8080`,
uncomment `CORS_ORIGINS` in `.env` and set it to that origin (only required if
something calls the API cross-origin; same-origin through the proxy does not
depend on CORS).

## Environment

Compose reads `deploy/.env` via `env_file` (the file must exist). **Do not
bake keys into an image.** Pass them at run time:

- `env_file: .env` on a VM
- the platform’s secret store / service environment on a cloud host

| Variable | Default in containers | Meaning |
|---|---|---|
| `PORT` | `8787` (backend image) / `8080` (all-in-one) | Listen port inside the container. Cloud hosts often inject this — keep it. Compose pins it; a raw `docker run --env-file` does not, so do not set `PORT=8787` in `.env` for the all-in-one image. |
| `HOST` | `0.0.0.0` in the images | Bind address. Unset locally so Node keeps its dual-stack default. |
| `AUTH_PASSWORD` / `AUTH_HMAC_SECRET` | unset (gate off) | Both required to turn the login gate on. Username is always `admin@magickvoice.com`. Sessions live in the process — a restart or a second replica signs people out. Run one instance (or rely on session affinity) if the gate is on. |
| `AUTH_SESSION_HOURS` | `3` (capped at 24) | How long a UI session lasts after login. |
| `STATIC_DIR` | unset / `/app/ui` in the all-in-one image | Directory of the Vite build. When set, Express serves the UI. |
| `SESSION_DIR` | `/data/sessions` | JSON records + stereo WAVs. Mount a volume here. |
| `CORS_ORIGINS` | `http://localhost:8080` under Compose, `https://grindelwald.magickvoice.com` under the TLS overlay, `http://localhost:5173` in the process itself | Comma-separated allowed origins. Both container defaults come from Compose pinning them, not from the backend — a raw `docker run --env-file` gets the process default. Same-origin through the proxy does not use CORS at all; a value left in `.env` wins over every default. |
| `HTTP_PORT` | `8080` | Host port Compose publishes. Compose-only. Set it to `80` on a public host: the first certificate is issued while only the base stack is running, and that is what publishes port 80 for ACME. The TLS overlay then publishes 80 and 443 itself. |
| `SESSION_AUDIO` | on (`0` disables) | Record each conversation to a stereo WAV. |
| `SESSION_AUDIO_MAX_MINUTES` | `60` | Cap on one recording. Stereo PCM16 @ 24 kHz is ~5.8 MB per recorded minute. |
| `SESSION_MAX_RECORDS` | unset (keep all) | Prune oldest conversations when set to a positive integer. |
| `CARTESIA_USD_PER_CREDIT` | `0.00005` | Cartesia credit → USD. |
| `USD_PER_INR` | `1/94.43` (~0.01059) | Assumed FX, not a feed. Travels in every session summary. Unset uses that default. |

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

Every Compose file here mounts the named volume `session-data` →
`/data/sessions`.

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

The TLS overlay adds two more volumes: `letsencrypt` (the certificate and its
private key, `/etc/letsencrypt`) and `certbot-webroot` (the ACME challenge
directory, disposable). Backing up `letsencrypt` is optional — certbot can
always issue again — but restoring it is faster than an issuance, and it
sidesteps the weekly duplicate-certificate limit.

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

## HTTPS on a VM (grindelwald.magickvoice.com)

The containers speak HTTP by default. `deploy/docker-compose.https.yml` is an
overlay that puts TLS on nginx itself, with a Let's Encrypt certificate
renewed by a certbot container beside it. Two new files; the plain-HTTP stack
gains only an ACME challenge location and the volume it is served from, and
keeps working exactly as before:

| File | Role |
|---|---|
| `deploy/nginx.https.conf` | Port 443 serves the app; port 80 answers the ACME challenge and redirects everything else to HTTPS. Mounted over `/etc/nginx/conf.d/default.conf`. |
| `deploy/docker-compose.https.yml` | Publishes 80 and 443, mounts the certificate volume, adds the `certbot` service, points `CORS_ORIGINS` at the HTTPS URL. |

The hostname is written into `nginx.https.conf` — `server_name` and the two
certificate paths — and as the `CORS_ORIGINS` default in the overlay. To
serve a different name, change it in both and issue the certificate for that
name.

### 1. Point the domain at the VM

Create **one `A` record** pointing at the VM's public IPv4 address. In a DNS
panel (Route 53, Cloudflare, your registrar) that is:

```
Type: A     Name: grindelwald     Value: 203.0.113.42     TTL: 300
```

Most panels append the zone, so the Name field is the label `grindelwald`,
not the full `grindelwald.magickvoice.com`. If the provider proxies traffic
(Cloudflare's orange cloud), turn that **off** — a proxy terminates TLS
itself, which makes this whole section moot.

Do **not** add an `AAAA` record unless you have configured Docker to publish
on IPv6. Docker's default `ports:` publishing is IPv4-only, and Let's Encrypt
prefers AAAA when it finds one — an AAAA nothing listens on breaks
validation rather than adding redundancy.

Wait for it to resolve before going further; a stale record fails the order.
From your laptop, not the VM:

```bash
host grindelwald.magickvoice.com     # or: dig +short …  (needs bind9-dnsutils)
```

Open **80 and 443** inbound in the VM's firewall / security group. 80 is not
optional: it is where ACME HTTP-01 validates and where visitors get redirected
from. Leave 8787 closed; the backend is never published.

### 2. Bring the plain-HTTP stack up on port 80

nginx cannot start on the TLS config before a certificate exists, so the
first one is issued through the plain-HTTP stack.

```bash
cd deploy
cp -n .env.example .env
```

Now edit `deploy/.env`: paste the vendor keys you want live, and set

```
HTTP_PORT=80
```

`HTTP_PORT=80` matters right now because the certificate is issued while only
this stack is running, and ACME reaches it on port 80. (Once you switch to the
overlay in step 4, that file publishes 80 and 443 on its own, so renewals no
longer depend on this setting.) `cp -n` will not overwrite an existing `.env`,
so if you are upgrading a deployment, open it and check `HTTP_PORT` yourself —
and `CORS_ORIGINS`, which the TLS overlay only points at the HTTPS URL when
`.env` leaves it unset.

```bash
docker compose up -d --build
```

Then, **from your laptop rather than the VM** — many clouds do not route a
VM's own public IP back to itself, so an on-VM curl can fail on a perfectly
good setup:

```bash
curl -fsS http://grindelwald.magickvoice.com/api/health
```

That is the exact path ACME is about to take. If it fails, fix it now:
Let's Encrypt allows 5 failed validations per hostname per hour, and burning
them makes the next hour a waiting game.

### 3. Issue the certificate

`certbot` writes the challenge into the `certbot-webroot` volume, which the
running nginx already serves at `/.well-known/acme-challenge/`:

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml \
  run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
  -d grindelwald.magickvoice.com \
  --email ops@magickvoice.com --agree-tos --no-eff-email
```

Use an address you actually read — it is where expiry warnings go — and one
on a real domain; reserved example domains are not always accepted as ACME
contacts.

Rehearse it first by adding `--dry-run` (anywhere after `certonly`): that
runs the whole path against the staging CA and issues nothing, so a mistake
costs no rate limit. Then drop the flag and run it again for the real
certificate. If it fails, the error is in the command's own output and in
`/var/log/letsencrypt/letsencrypt.log` inside that throwaway container — add
`-v` to the command to see it on stdout instead.

The result lands in the `grindelwald_letsencrypt` volume as
`/etc/letsencrypt/live/grindelwald.magickvoice.com/{fullchain,privkey}.pem` —
the paths `nginx.https.conf` names. That directory is named after the **first**
`-d`, so if you ever issue for several names, keep this one first (or pass
`--cert-name grindelwald.magickvoice.com`) or nginx will be pointing at a
path that no longer exists.

### 4. Switch nginx to TLS

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
```

nginx now serves 443 and redirects 80. The `certbot` service wakes every 12
hours; `certbot renew` is a no-op until the certificate is within 30 days of
expiry, which is the cadence Let's Encrypt asks for.

Verify — again from your laptop:

```bash
curl -fsS  https://grindelwald.magickvoice.com/api/health
curl -sSI  http://grindelwald.magickvoice.com/ | head -1   # 301

# what is actually being served, and until when
openssl s_client -connect grindelwald.magickvoice.com:443 \
  -servername grindelwald.magickvoice.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

Then rehearse the renewal, on the VM. This is the one part of the setup that
fails silently and late — a broken renewal looks exactly like a working one
until the certificate expires:

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml \
  run --rm --entrypoint certbot certbot renew --dry-run
```

Then open <https://grindelwald.magickvoice.com> and click **Start mic** — the
whole point of the certificate is that `getUserMedia` is now allowed. The
client picks `wss:` from `location.protocol`, so the session socket upgrades
with no config change.

Note what serving this page commits you to: `nginx.https.conf` sends
`Strict-Transport-Security: max-age=31536000`, so for a year after their last
visit, browsers will refuse plain HTTP on this hostname with no way to click
through. That is the point of HSTS, and it is also why going back to the HTTP
stack is an outage rather than a downgrade — see [Updating](#updating).

Use this compose invocation from now on. Both `-f` flags, every time —
`docker compose up -d` alone would drop back to plain HTTP:

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.https.yml logs -f backend
```

### 5. Reload nginx after a renewal

nginx reads the certificate at startup and at reload. certbot renews in its
own container and cannot signal this one, so add one cron entry on the VM —
a renewal is worthless if nginx keeps serving the expired copy:

Run `crontab -e` as a user in the `docker` group, and use **your** clone path
in place of `/opt/grindelwald` — a `cd` that fails takes the whole line with
it, silently, and you would not find out until the certificate expired:

```cron
# reload nginx weekly so a renewed certificate is actually served
0 4 * * 1 cd /opt/grindelwald/deploy && docker compose -f docker-compose.yml -f docker-compose.https.yml exec -T frontend nginx -s reload 2>&1 | logger -t grindelwald-reload
```

`logger` puts the outcome in the system journal (`journalctl -t
grindelwald-reload`) instead of mailing you a success notice every week.
Weekly is comfortably fast enough: certbot renews at 30 days remaining on a
90-day certificate, so the reload lands with about three weeks to spare.

`nginx -s reload` is graceful: in-flight requests and open WebSockets stay
with the old worker until they close, so a live conversation is not cut.

### Alternatives

If you would rather not terminate TLS in the container, the plain-HTTP stack
is unchanged and anything in front works. **Caddy** on the same VM, with
automatic Let's Encrypt and WebSocket forwarding by default:

```caddyfile
grindelwald.magickvoice.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then set `CORS_ORIGINS=https://grindelwald.magickvoice.com` in `deploy/.env`.

A host nginx should mirror the `/ws/` block in `deploy/nginx.conf`: `Upgrade`
/ `Connection` headers, `proxy_buffering off`, and a long
`proxy_read_timeout`. Buffering the WebSocket or the TTS stream will destroy
time-to-first-audio — that number is the point of the bench.

**Cloud load balancers** (Cloud Run, Cloud Load Balancing, ALB, Azure
Container Apps) terminate TLS for you: enable HTTP/1.1 WebSocket upgrade, an
idle timeout of at least the longest conversation you expect, and HTTPS on
the public hostname. The single-container image has no nginx in it, so that
is the shape to use there.

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

Install Docker, clone the repo, and follow
[HTTPS on a VM](#https-on-a-vm-grindelwaldmagickvoicecom) — that section is
written for exactly this case and ends with nginx terminating TLS itself.
Open 80 and 443 only; do not publish port 8787 to the internet.

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
curl -fsS https://grindelwald.magickvoice.com/api/health

# UI is the Vite build, not a 404
curl -fsS -o /dev/null -w '%{http_code}\n' https://grindelwald.magickvoice.com/

# catalog is JSON and lists mock providers as ready
curl -fsS https://grindelwald.magickvoice.com/api/catalog | grep -E '"id": ?"mock-'

# WebSocket upgrade (should be 101; needs wscat or similar)
# npx wscat -c wss://grindelwald.magickvoice.com/ws/session
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

**On a TLS deployment, use both `-f` flags instead** — every time, including
here:

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
```

The bare command recreates nginx from the base file alone: `nginx.https.conf`
is unmounted and port 443 stops being published. Because the site has already
sent `Strict-Transport-Security: max-age=31536000`, every browser that has
visited it will refuse to fall back to `http://` — so this does not degrade
the deployment to HTTP, it takes it **down**, with no click-through, until you
re-run the command with both flags.

Images do not include `deploy/.env` or `backend/.env`. Keys survive a rebuild.
The `session-data` volume survives `up --build`; only `down -v` deletes it —
and under the TLS overlay `down -v` also destroys `letsencrypt`, taking the
certificate with it. Re-issuing counts against Let's Encrypt's limit of 5
identical certificates per week, so reach for `down` without `-v` unless you
mean it. (`down -v` with only the base file leaves the certificate alone: the
volume is declared in the overlay, so the blast radius follows the flags.)

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| UI loads, **Connect** fails / console says backend :8787 | `/ws/session` is not reaching the backend. Check the proxy upgrade headers and that nothing strips `/ws`. |
| **Start mic** denied or `getUserMedia` throws | The page is HTTP on a non-localhost host. Serve HTTPS. |
| frontend container restarts, logs `cannot load certificate … no such file` | You started the TLS overlay before the certificate existed. Bring up the plain stack, issue it (step 3), then switch. |
| ACME order fails on `Invalid response … 404` | Port 80 is not published (`HTTP_PORT=80` in `.env`) or not open in the firewall, or DNS still points elsewhere. `curl http://grindelwald.magickvoice.com/api/health` from off the VM. |
| Browser warns the certificate expired | Renewal happened but nginx was never reloaded. Run the reload from step 5 by hand, then check `docker compose -f docker-compose.yml -f docker-compose.https.yml logs certbot`. |
| Renewal never runs (`certbot` log shows failures, or the cert nears expiry) | Port 80 is not reachable — HTTP-01 renewal needs it just as issuance did. Rehearse with `run --rm --entrypoint certbot certbot renew --dry-run`. |
| Site unreachable after a deploy, browser will not fall back to HTTP | `docker compose up -d` without both `-f` flags dropped nginx back to `nginx.conf`, and HSTS forbids the HTTP fallback. Re-run with both `-f` flags. See [Updating](#updating). |
| Catalog shows a provider not ready | Its `envKeys` are empty in the container environment. `docker compose exec backend env \| grep KEY` (values will print — do this on a private shell). |
| 502 from nginx | Backend not healthy yet, or the hostname is not `backend`. `docker compose logs backend`. nginx re-resolves `backend` via Docker DNS every 10s. |
| First audio is seconds late vs local | An intermediate proxy is buffering. Disable `proxy_buffering` / equivalent. |
| Recordings 404 | `SESSION_AUDIO=0`, or the conversation was typed-only, or `/data/sessions` is not the mounted volume. |
| Disk fills | WAVs are ~5.8 MB/minute. Lower `SESSION_AUDIO_MAX_MINUTES` or set `SESSION_MAX_RECORDS`. |
| CORS errors in the browser | You are calling the API from a different origin than `CORS_ORIGINS`. Same-origin through the proxy (:8080, or :443 under TLS) should not hit this. |
| Container exits on boot: `STATIC_DIR … does not contain index.html` | You ran the backend image with `STATIC_DIR` set. That variable belongs on the all-in-one image only. |
| Login page after a restart / second replica | Sessions are in-process. A replace invalidates tokens; two instances do not share the book. Set both `AUTH_PASSWORD` and `AUTH_HMAC_SECRET`, keep one replica, or leave them unset to keep the bench open. |

## Files in `deploy/`

| File | Role |
|---|---|
| `Dockerfile` | All-in-one image (Node + Vite build, `STATIC_DIR=/app/ui`). |
| `Dockerfile.backend` | API + WebSocket only. |
| `Dockerfile.frontend` | nginx + Vite build, proxies to `backend:8787`. |
| `nginx.conf` | Plain HTTP: SPA, `/api/`, `/ws/` (no buffering, long WS timeout), ACME challenge. |
| `nginx.https.conf` | TLS on 443 for `grindelwald.magickvoice.com`, 80 → 443. The overlay mounts it over the image's `/etc/nginx/conf.d/default.conf`, replacing `nginx.conf`. |
| `docker-compose.yml` | Two-service stack, UI on `${HTTP_PORT:-8080}`. |
| `docker-compose.https.yml` | TLS overlay: 443, the certificate volume, the certbot renewer. Layers on `docker-compose.yml`. |
| `docker-compose.single.yml` | One-service stack (Compose project `grindelwald-single`). |
| `cloudbuild.yaml` | Cloud Build for the all-in-one image (`gcloud builds submit --config …`). |
| `.env.example` | Keys and deploy knobs. Copy to `.env`. |

The Docker **context** is the repository root. `.dockerignore` lives there so
`node_modules`, `.env`, and `data/` never enter a build.
