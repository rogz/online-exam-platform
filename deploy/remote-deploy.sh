#!/usr/bin/env bash
# Runs ON THE SERVER for each deploy (sent by .github/workflows/deploy.yml).
# Puts the new files in ~/exam-wizard/app and restarts the site. Settings (.env) and data stay.
set -euo pipefail
BASE="$HOME/exam-wizard"
mkdir -p "$BASE"
cd "$BASE"
rm -rf app.new && mkdir app.new
tar xzf /tmp/exam-wizard-app.tgz -C app.new && rm -f /tmp/exam-wizard-app.tgz
rm -rf app.old
if [ -d app ]; then mv app app.old; fi
mv app.new app
if [ -f .env ]; then ln -sf ../.env app/.env; fi

if ! command -v docker >/dev/null 2>&1 || [ ! -f .env ]; then
  echo "Files copied to $BASE/app."
  echo "First time on this server: log in and run   bash ~/exam-wizard/app/deploy/setup.sh"
  exit 0
fi

cd app
D="docker"; docker info >/dev/null 2>&1 || D="sudo docker"
$D compose up -d --build --remove-orphans
for i in $(seq 1 40); do
  if $D compose exec -T app wget -qO- http://localhost:3000/healthz </dev/null >/dev/null 2>&1; then
    echo "Site is up."
    $D image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 3
done
echo "The site did not start. Last log lines:"
$D compose logs --tail 60 app
exit 1
