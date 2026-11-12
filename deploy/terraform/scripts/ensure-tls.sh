#!/usr/bin/env bash
# Installed as /usr/local/sbin/grindelwald-tls. Run by grindelwald-tls.timer
# every 5 minutes, and once at the end of every deploy.
#
# Certificate present and served: no-op.
# Certificate present, not served: switch nginx to the TLS overlay.
# No certificate: once the domain resolves to THIS VM's IP, issue one over
# HTTP-01 and switch. Until then, wait, which is what makes the AWS -> OCI
# cutover a single DNS edit.
set -euo pipefail

# shellcheck source=/dev/null
. /etc/grindelwald/deploy.conf
cd /opt/grindelwald/deploy

exec 9>/run/grindelwald.lock
flock -n 9 || { echo "deploy in progress; next tick"; exit 0; }

https=(-f docker-compose.yml -f docker-compose.https.yml)
# Let's Encrypt allows 5 failed validations per hostname per hour. After a
# failure, stand down for an hour instead of burning them every 5 minutes.
FAILED=/var/lib/grindelwald/acme-failed

serve_https() {
  echo "switching nginx to TLS"
  docker compose "${https[@]}" up -d --remove-orphans --wait --wait-timeout 300
}

cert_volume="$(docker volume inspect -f '{{.Mountpoint}}' grindelwald_letsencrypt 2>/dev/null || true)"
if [ -n "$cert_volume" ] && [ -f "$cert_volume/live/$DOMAIN/fullchain.pem" ]; then
  if [ -z "$(docker compose "${https[@]}" port frontend 443 2>/dev/null)" ]; then
    serve_https
  fi
  exit 0
fi

if [ -f "$FAILED" ] && [ -n "$(find "$FAILED" -mmin -60)" ]; then
  echo "last issuance failed under an hour ago; waiting (rm $FAILED to retry now)"
  exit 0
fi

resolved="$(dig +short A "$DOMAIN" @1.1.1.1 | grep -E '^[0-9.]+$' | tail -n1 || true)"
if [ "$resolved" != "$PUBLIC_IP" ]; then
  echo "$DOMAIN resolves to ${resolved:-nothing}, not $PUBLIC_IP; waiting for the DNS change"
  exit 0
fi

echo "$DOMAIN resolves here; issuing a certificate"
if docker compose "${https[@]}" run --rm --entrypoint certbot certbot \
     certonly --webroot -w /var/www/certbot -d "$DOMAIN" \
     --email "$ACME_EMAIL" --agree-tos --no-eff-email --non-interactive; then
  rm -f "$FAILED"
  serve_https
else
  touch "$FAILED"
  echo "issuance failed; retrying in an hour" >&2
  exit 1
fi
