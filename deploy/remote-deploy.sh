#!/usr/bin/env bash
# Runs ON THE SERVER for each deploy (sent by .github/workflows/deploy.yml).
# Puts the new files in ~/exam-wizard/app and restarts the site. Settings (.env) and data stay.
# Works with both set-ups: setup-shared.sh (service behind nginx) and setup.sh (Docker).
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

# ── Service behind nginx (setup-shared.sh) ──
if [ -f /etc/systemd/system/exam-wizard.service ]; then
  export PATH="$BASE/node/bin:$PATH"
  PORT=$(grep '^PORT=' .env | cut -d= -f2)
  cd app
  # Same libraries as before? Reuse them instead of downloading again.
  if [ -d ../app.old/node_modules ] && cmp -s package-lock.json ../app.old/package-lock.json; then
    mv ../app.old/node_modules node_modules
  else
    npm ci --omit=dev --omit=optional --no-audit --no-fund
  fi
  sudo systemctl restart exam-wizard
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then echo "Site is up."; exit 0; fi
    sleep 2
  done
  echo "The new version did not start. Last log lines:"
  sudo journalctl -u exam-wizard -n 40 --no-pager || true
  if [ -d "$BASE/app.old" ]; then
    echo "Going back to the previous version…"
    cd "$BASE" && rm -rf app.failed && mv app app.failed && mv app.old app
    [ -d app/node_modules ] || (cd app && npm ci --omit=dev --omit=optional --no-audit --no-fund)
    sudo systemctl restart exam-wizard
    echo "Previous version restored. The failed one is in ~/exam-wizard/app.failed"
  fi
  exit 1
fi

# ── Not set up yet ──
if ! command -v docker >/dev/null 2>&1 || [ ! -f .env ]; then
  echo "Files copied to $BASE/app. First time on this server, log in and run ONE of these:"
  echo "  bash ~/exam-wizard/app/deploy/setup-shared.sh   (server shared with other websites, uses nginx)"
  echo "  bash ~/exam-wizard/app/deploy/setup.sh          (server only for Exam Wizard, uses Docker)"
  exit 0
fi

# ── Docker (setup.sh) ──
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
