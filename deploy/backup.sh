#!/usr/bin/env bash
# Saves a copy of the database to ~/exam-wizard/backups (keeps 14 days). setup.sh runs it every night.
# Run it by hand any time:  bash ~/exam-wizard/app/deploy/backup.sh
# To restore one into an EMPTY database:  gunzip -c FILE | docker compose exec -T db psql -U exam -d exam
set -euo pipefail
BASE="$HOME/exam-wizard"
DIR="$BASE/backups"
mkdir -p "$DIR"
cd "$BASE/app"
D="docker"; docker info >/dev/null 2>&1 || D="sudo docker"
f="$DIR/exam-$(date +%F-%H%M).sql.gz"
$D compose exec -T db pg_dump -U exam -d exam --no-owner | gzip > "$f"
find "$DIR" -name 'exam-*.sql.gz' -mtime +14 -delete
echo "$(date '+%F %T') backup saved: $f ($(du -h "$f" | cut -f1))"
