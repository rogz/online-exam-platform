#!/usr/bin/env bash
# Copies everything from your Neon database into this server's database (run ON THE SERVER).
# Only for a new, empty server database. Usage:  bash ~/exam-wizard/app/deploy/import-from-neon.sh
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP"
D="docker"; docker info >/dev/null 2>&1 || D="sudo docker"

$D compose up -d db
until $D compose exec -T db pg_isready -h 127.0.0.1 -U exam -d exam </dev/null >/dev/null 2>&1; do sleep 2; done
rows=0
if [ "$($D compose exec -T db psql -U exam -d exam -tAc "SELECT to_regclass('public.users') IS NOT NULL" </dev/null)" = "t" ]; then
  rows=$($D compose exec -T db psql -U exam -d exam -tAc "SELECT count(*) FROM users" </dev/null)
fi
if [ "$rows" != "0" ]; then
  echo "This server's database already has $rows accounts. Stopping, so nothing is overwritten."
  exit 1
fi

echo "Paste your Neon connection string (from Neon → Connect; it starts with postgresql://)."
echo "It is not shown on screen and not saved."
read -rs NEON; echo
case "$NEON" in postgres://*|postgresql://*) ;; *) echo "That doesn't look like a connection string."; exit 1 ;; esac

$D compose stop app >/dev/null 2>&1 || true
DUMP=$(mktemp)
echo "Downloading your data from Neon…"
$D run --rm -e NEON_URL="$NEON" postgres:17-alpine sh -c 'pg_dump "$NEON_URL" --schema=public --no-owner --no-acl' > "$DUMP"
unset NEON
echo "Downloaded $(du -h "$DUMP" | cut -f1). Loading it into the server database…"
$D compose exec -T db psql -q -U exam -d exam < "$DUMP" 2>&1 | grep -v 'already exists' || true
rm -f "$DUMP"
echo "Copied:"
$D compose exec -T db psql -U exam -d exam -tAc \
  "SELECT '  accounts: ' || (SELECT count(*) FROM users) || ', questions: ' || (SELECT count(*) FROM questions) || ', exams: ' || (SELECT count(*) FROM exams) || ', attempts: ' || (SELECT count(*) FROM attempts)" </dev/null
