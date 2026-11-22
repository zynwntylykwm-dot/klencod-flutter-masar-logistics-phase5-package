#!/usr/bin/env bash
# فحص صحة الخادم — يُستخدم في المراقبة (UptimeRobot وغيرها) أو cron
set -euo pipefail
URL="${1:-http://127.0.0.1:8080/api/health}"
out=$(curl -fsS --max-time 8 "$URL") || { echo "❌ لا استجابة من $URL"; exit 1; }
echo "$out" | grep -q '"ok":true' && echo "✅ الخادم سليم: $out" || { echo "❌ رد غير سليم: $out"; exit 1; }
