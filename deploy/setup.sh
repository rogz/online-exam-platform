#!/usr/bin/env bash
# One-time set-up of Exam Wizard on your own server (Ubuntu, Debian or Amazon Linux).
# Run it ON THE SERVER after the first GitHub deploy copied the files:
#     bash ~/exam-wizard/app/deploy/setup.sh
# Safe to run again: steps already done are skipped.
set -euo pipefail
BASE="$HOME/exam-wizard"
APP="$BASE/app"
say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

[ -f "$APP/docker-compose.yml" ] || { echo "The site files are not here yet. Run the GitHub deploy first (Actions → Test and deploy → Run workflow)."; exit 1; }
. /etc/os-release

# 1. Swap space, so small servers (1 GB) don't run out of memory while building
mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
if [ "$mem_mb" -lt 1900 ] && ! swapon --show 2>/dev/null | grep -q /swapfile; then
  say "Adding 2 GB of swap space (this server has ${mem_mb} MB of memory)"
  sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 2. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (a few minutes)"
  case "$ID" in
    ubuntu|debian)
      curl -fsSL https://get.docker.com | sudo sh ;;
    amzn)
      sudo dnf install -y docker cronie
      arch=$(uname -m); bx=$([ "$arch" = x86_64 ] && echo amd64 || echo arm64)
      sudo mkdir -p /usr/local/lib/docker/cli-plugins
      sudo curl -fsSL "https://github.com/docker/compose/releases/download/v2.39.2/docker-compose-linux-$arch" -o /usr/local/lib/docker/cli-plugins/docker-compose
      sudo curl -fsSL "https://github.com/docker/buildx/releases/download/v0.26.1/buildx-v0.26.1.linux-$bx" -o /usr/local/lib/docker/cli-plugins/docker-buildx
      sudo chmod +x /usr/local/lib/docker/cli-plugins/*
      sudo systemctl enable --now docker crond ;;
    *)
      echo "This script supports Ubuntu, Debian and Amazon Linux. This server is: $PRETTY_NAME"; exit 1 ;;
  esac
fi
sudo systemctl enable --now docker >/dev/null 2>&1 || true
sudo usermod -aG docker "${USER:-$(id -un)}"
D="docker"; docker info >/dev/null 2>&1 || D="sudo docker"

# 3. Settings (.env), kept outside the code folder so deploys don't touch it
if [ ! -f "$BASE/.env" ]; then
  say "Site settings"
  read -rp "Web address for the site (e.g. quiz.karmsys.com): " DOMAIN
  read -rp "Your admin email (the site owner): " ADMIN_EMAIL
  echo "First admin password. It is only used if this admin account doesn't exist yet"
  read -rsp "(when you copy your data from Neon, your current password stays): " ADMIN_PASSWORD; echo
  PGPW=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  ( umask 077; cat > "$BASE/.env" <<EOF
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$PGPW
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD='$ADMIN_PASSWORD'
SITE_NAME="Exam Wizard"
TIME_ZONE=Asia/Manila
EOF
  )
  echo "Saved to $BASE/.env (only you can read it)."
fi
ln -sf ../.env "$APP/.env"

# 4. Database, and your data from Neon (first time only)
cd "$APP"
say "Starting the database"
$D compose up -d db
until $D compose exec -T db pg_isready -h 127.0.0.1 -U exam -d exam </dev/null >/dev/null 2>&1; do sleep 2; done
has_users=$($D compose exec -T db psql -U exam -d exam -tAc "SELECT to_regclass('public.users') IS NOT NULL" </dev/null)
if [ "$has_users" != "t" ]; then
  read -rp "Copy your current data (accounts, questions, results) from Neon now? (y/n) " yn
  if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then bash "$APP/deploy/import-from-neon.sh"; fi
fi

# 5. Start the site
say "Building and starting the site (first time takes a few minutes)"
$D compose up -d --build --remove-orphans
for i in $(seq 1 40); do
  if $D compose exec -T app wget -qO- http://localhost:3000/healthz </dev/null >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[ "${ok:-0}" = 1 ] || { echo "The site did not start. Last log lines:"; $D compose logs --tail 60 app; exit 1; }

# 6. Daily backup at 3:30 AM (server time), kept for 14 days in ~/exam-wizard/backups
if command -v crontab >/dev/null 2>&1; then
  ( crontab -l 2>/dev/null | grep -v 'exam-wizard-backup' || true
    echo "30 3 * * * bash $APP/deploy/backup.sh >> $BASE/backup.log 2>&1 # exam-wizard-backup" ) | crontab -
  echo "Daily backups are on."
else
  echo "Note: cron is not installed, so daily backups are off. Install cron and run this script again."
fi

DOMAIN=$(grep '^DOMAIN=' "$BASE/.env" | cut -d= -f2)
IP=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null || hostname -I | awk '{print $1}')
say "Done. The site is running."
echo "Next: point $DOMAIN to this server with a DNS \"A\" record → $IP"
echo "When the DNS change has spread (minutes to an hour), open https://$DOMAIN"
echo "(HTTPS is set up automatically the first time someone opens it.)"
