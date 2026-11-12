#!/usr/bin/env bash
# Runs as root on the VM on every `terraform apply` that changes the commit,
# the .env, these scripts, or the instance. Idempotent: safe to re-run.
#
# Terraform has staged deploy.conf, app.env and both scripts in STAGE.
set -euo pipefail

STAGE=/home/ubuntu/.grindelwald
APP_DIR=/opt/grindelwald
CONF=/etc/grindelwald/deploy.conf
LOCK=/run/grindelwald.lock

log() { echo "[grindelwald] $*"; }

install -d -m 755 /etc/grindelwald /var/lib/grindelwald
install -m 644 "$STAGE/deploy.conf" "$CONF"
install -m 755 "$STAGE/ensure-tls.sh" /usr/local/sbin/grindelwald-tls
# shellcheck source=/dev/null
. "$CONF"

# SSH access for every machine listed in deploy/terraform/authorized_keys.
# Replaces the file: a key removed from the list loses access here.
if [ -s "$STAGE/authorized_keys" ]; then
  install -m 600 -o ubuntu -g ubuntu "$STAGE/authorized_keys" /home/ubuntu/.ssh/authorized_keys
  log "authorized_keys: $(grep -c . /home/ubuntu/.ssh/authorized_keys) key(s)"
fi

# The TLS timer must not run compose while this does.
exec 9>"$LOCK"
flock 9

log "waiting for cloud-init to finish first boot"
cloud-init status --wait >/dev/null || true

# ---- 1. Docker ----------------------------------------------------------------
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1 || ! command -v dig >/dev/null; then
  log "installing docker, compose, git"
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=600 update -q
  apt-get -o DPkg::Lock::Timeout=600 install -y -q \
    docker.io docker-compose-v2 docker-buildx git dnsutils
fi
systemctl enable --now docker >/dev/null
usermod -aG docker ubuntu

# ---- 2. Host firewall ---------------------------------------------------------
# OCI's Ubuntu images ship iptables rules that REJECT everything but 22. Open
# 80/443 live, and in rules.v4 so it survives a reboot. rules.v4 is edited as
# text, never saved from live state: that would capture Docker's own chains.
for port in 80 443; do
  iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
  rule="-A INPUT -p tcp -m state --state NEW -m tcp --dport $port -j ACCEPT"
  if [ -f /etc/iptables/rules.v4 ] && ! grep -qxF -- "$rule" /etc/iptables/rules.v4; then
    sed -i "0,/^-A INPUT -j REJECT/s//$rule\n&/" /etc/iptables/rules.v4
  fi
done

# ---- 3. Code ------------------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  log "cloning $REPO_URL"
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi
git -C "$APP_DIR" fetch --quiet origin "$GIT_SHA"
git -C "$APP_DIR" checkout --quiet --force --detach "$GIT_SHA"
log "checked out $(git -C "$APP_DIR" log -1 --format='%h %s')"

# ---- 4. .env ------------------------------------------------------------------
install -m 600 -o root -g root "$STAGE/app.env" "$APP_DIR/deploy/.env"
rm -f "$STAGE/app.env"

# ---- 5. Stack -----------------------------------------------------------------
cd "$APP_DIR/deploy"
cert_volume="$(docker volume inspect -f '{{.Mountpoint}}' grindelwald_letsencrypt 2>/dev/null || true)"
if [ -n "$cert_volume" ] && [ -f "$cert_volume/live/$DOMAIN/fullchain.pem" ]; then
  log "certificate present: starting the HTTPS stack"
  files=(-f docker-compose.yml -f docker-compose.https.yml)
else
  log "no certificate yet: starting the plain-HTTP stack on :80"
  files=(-f docker-compose.yml)
fi
docker compose "${files[@]}" up -d --build --remove-orphans --wait --wait-timeout 300
docker image prune -f >/dev/null

# ---- 6. TLS automation --------------------------------------------------------
# A timer issues the first certificate as soon as DNS points here, then
# switches nginx to TLS. Renewal itself is the certbot container's loop.
cat >/etc/systemd/system/grindelwald-tls.service <<'UNIT'
[Unit]
Description=Grindelwald: issue the first TLS certificate once DNS points here
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/grindelwald-tls
UNIT

cat >/etc/systemd/system/grindelwald-tls.timer <<'UNIT'
[Unit]
Description=Grindelwald: retry TLS issuance every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT

# nginx only re-reads the certificate on reload; certbot renews in its own
# container and cannot signal this one. Weekly is ~3 weeks ahead of expiry.
cat >/etc/cron.d/grindelwald <<'CRON'
0 4 * * 1 root cd /opt/grindelwald/deploy && docker compose -f docker-compose.yml -f docker-compose.https.yml exec -T frontend nginx -s reload 2>&1 | logger -t grindelwald-reload
CRON

systemctl daemon-reload
systemctl enable --now grindelwald-tls.timer >/dev/null

flock -u 9
/usr/local/sbin/grindelwald-tls || log "TLS step failed; the timer retries (journalctl -u grindelwald-tls)"

log "deployed $GIT_SHA"
