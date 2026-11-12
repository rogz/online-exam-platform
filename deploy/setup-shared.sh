#!/usr/bin/env bash
# One-time set-up on a server that already runs nginx for other websites (no Docker).
#   - Exam Wizard runs as a background service (systemd) on a free local port, with its own Node.js copy.
#   - The database stays on Neon (nothing to copy, no extra memory on this server).
#   - nginx gets one new file that forwards your web address to Exam Wizard; other sites are not touched.
#   - HTTPS from Let's Encrypt (certbot), once your web address points to this server.
# Run it ON THE SERVER after the first GitHub deploy copied the files:
#     bash ~/exam-wizard/app/deploy/setup-shared.sh
# Safe to run again (e.g. after changing DNS, to turn on HTTPS): finished steps are skipped.
set -euo pipefail
BASE="$HOME/exam-wizard"
APP="$BASE/app"
NODE_DIR="$BASE/node"
NODE_VERSION="22.23.4"
ME="$(id -un)"
SERVICE=/etc/systemd/system/exam-wizard.service
SITE=/etc/nginx/sites-available/exam-wizard
say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ask_yes() { local a; read -rp "$1 (y/n) " a </dev/tty; [ "$a" = "y" ] || [ "$a" = "Y" ]; }

[ -f "$APP/server.js" ] || { echo "The site files are not here yet. Run the GitHub deploy first (Actions → Test and deploy → Run workflow)."; exit 1; }
command -v nginx >/dev/null 2>&1 || { echo "nginx is not installed. Use deploy/setup.sh (Docker) instead."; exit 1; }

# 1. Swap: this server has little memory; swap helps every site on it during busy moments
mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
if [ "$mem_mb" -lt 1900 ] && [ -z "$(swapon --noheadings 2>/dev/null)" ]; then
  say "This server has ${mem_mb} MB of memory and no swap space"
  if ask_yes "Add 2 GB of swap space (recommended; helps all the websites on this server)?"; then
    sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    echo "Swap added."
  fi
fi

# 2. Node.js for Exam Wizard only (inside ~/exam-wizard/node; the server's own Node.js is not changed)
if [ ! -x "$NODE_DIR/bin/node" ]; then
  say "Downloading Node.js $NODE_VERSION for Exam Wizard"
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "Unsupported processor: $(uname -m)"; exit 1 ;; esac
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.xz" | tar xJ -C "$tmp"
  rm -rf "$NODE_DIR" && mv "$tmp/node-v$NODE_VERSION-linux-$arch" "$NODE_DIR" && rm -rf "$tmp"
fi
export PATH="$NODE_DIR/bin:$PATH"

# 3. Settings (.env), kept outside the code folder so deploys don't touch it
if [ ! -f "$BASE/.env" ]; then
  say "Site settings"
  port=3100
  while ss -ltn 2>/dev/null | grep -q ":$port "; do port=$((port + 1)); done
  read -rp "Web address for the site (e.g. quiz.karmsys.com): " DOMAIN </dev/tty
  read -rp "Your admin email (the site owner, same as on Render): " ADMIN_EMAIL </dev/tty
  echo "Paste your Neon connection string (Neon → Connect; starts with postgresql://). It is not shown on screen."
  read -rs DATABASE_URL </dev/tty; echo
  case "$DATABASE_URL" in postgres://*|postgresql://*) ;; *) echo "That doesn't look like a connection string. Run this again."; exit 1 ;; esac
  ( umask 077; cat > "$BASE/.env" <<EOF
DOMAIN=$DOMAIN
PORT=$port
HOST=127.0.0.1
DATABASE_URL=$DATABASE_URL
ADMIN_EMAIL=$ADMIN_EMAIL
SITE_NAME=Exam Wizard
TIME_ZONE=Asia/Manila
NODE_ENV=production
EOF
  )
  unset DATABASE_URL
  echo "Saved to $BASE/.env (only you can read it). Exam Wizard will use local port $port."
fi
envget() { grep "^$1=" "$BASE/.env" | head -1 | cut -d= -f2-; }
DOMAIN=$(envget DOMAIN); PORT=$(envget PORT); ADMIN_EMAIL=$(envget ADMIN_EMAIL)

# 4. Libraries
say "Installing Exam Wizard's libraries"
cd "$APP"
npm ci --omit=dev --omit=optional --no-audit --no-fund

# 5. Background service: starts on boot, restarts if it stops, limited memory so other sites are safe
if [ ! -f "$SERVICE" ]; then
  say "Creating the exam-wizard service"
  sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=Exam Wizard
After=network-online.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$APP
EnvironmentFile=$BASE/.env
ExecStart=$NODE_DIR/bin/node --max-old-space-size=256 server.js
Restart=always
RestartSec=3
MemoryHigh=350M
MemoryMax=450M

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable exam-wizard >/dev/null 2>&1
fi
sudo systemctl restart exam-wizard
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && ok=1 && break; sleep 2; done
[ "${ok:-0}" = 1 ] || { echo "Exam Wizard did not start. Last log lines:"; sudo journalctl -u exam-wizard -n 40 --no-pager; exit 1; }
echo "Exam Wizard is running on local port $PORT."

# 6. nginx: one new file for your web address (other sites untouched)
if [ ! -f "$SITE" ]; then
  say "Adding $DOMAIN to nginx"
  sudo tee "$SITE" >/dev/null <<EOF
# Exam Wizard ($DOMAIN) → local port $PORT. Added by deploy/setup-shared.sh
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
  sudo ln -sf "$SITE" /etc/nginx/sites-enabled/exam-wizard
  if ! sudo nginx -t 2>/tmp/nginx-test.txt; then
    sudo rm -f /etc/nginx/sites-enabled/exam-wizard "$SITE"
    echo "nginx did not accept the new file, so it was removed again (other sites are unchanged):"; cat /tmp/nginx-test.txt; exit 1
  fi
  sudo systemctl reload nginx
  echo "nginx now forwards $DOMAIN to Exam Wizard."
fi

# 7. HTTPS, once the web address points to this server
IP=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null || true)
DNS_IP=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)
if sudo grep -q "listen 443" "$SITE" 2>/dev/null; then
  echo "HTTPS is already on."
elif [ -n "$IP" ] && [ "$DNS_IP" = "$IP" ]; then
  say "Turning on HTTPS for $DOMAIN"
  if ! command -v certbot >/dev/null 2>&1 || ! sudo certbot plugins 2>/dev/null | grep -q nginx; then
    echo "certbot's nginx helper is needed (a small package)."
    if ask_yes "Install it now (sudo apt-get install certbot python3-certbot-nginx)?"; then
      sudo apt-get update -qq && sudo apt-get install -y -qq certbot python3-certbot-nginx
    else
      echo "Skipped. Run this script again when you're ready."; exit 0
    fi
  fi
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" --redirect
else
  say "Almost done"
  SHOW_IP="${IP:-the public IP of this server}"
  echo "Point $DOMAIN to this server with a DNS \"A\" record → $SHOW_IP"
  echo "(right now it points to: ${DNS_IP:-nothing})."
  echo "When it does, run this script again to turn on HTTPS:  bash ~/exam-wizard/app/deploy/setup-shared.sh"
  exit 0
fi

say "Done. Open https://$DOMAIN"
