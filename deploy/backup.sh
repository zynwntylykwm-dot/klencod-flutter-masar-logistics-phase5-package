#!/usr/bin/env bash
# نسخة احتياطية يومية لمجلد البيانات + الاحتفاظ 14 يومًا (للاستخدام مع cron)
#   crontab: 15 3 * * * /opt/masar/deploy/backup.sh >> /var/log/masar-backup.log 2>&1
set -euo pipefail
DATA_DIR="${DATA_DIR:-/var/lib/masar}"
DEST="${DEST:-/var/backups/masar}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$DEST"
ts=$(date +%Y%m%d-%H%M)
tar -czf "$DEST/masar-$ts.tar.gz" -C "$DATA_DIR" .
find "$DEST" -name 'masar-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "[backup] $DEST/masar-$ts.tar.gz ($(du -h "$DEST/masar-$ts.tar.gz" | cut -f1))"
