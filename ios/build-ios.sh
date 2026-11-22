#!/usr/bin/env bash
# ============================================================================
# بناء تطبيق آيفون — يتطلب macOS + Xcode (لا يمكن بناؤه على لينكس/ويندوز)
# ----------------------------------------------------------------------------
#   1) brew install xcodegen
#   2) bash ios/build-ios.sh          ← ينسخ الواجهة ويولّد المشروع
#   3) open ios/MasarApp.xcodeproj    ← اختر فريق التوقيع وابنِ على جهازك
#   4) للمتجر: Product ▸ Archive ▸ Distribute App (حساب مطوّر مدفوع)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

command -v xcodebuild >/dev/null 2>&1 || { echo "❌ Xcode غير مثبّت — هذا السكربت يعمل على macOS فقط."; exit 1; }
command -v xcodegen >/dev/null 2>&1 || { echo "▶ ثبّت XcodeGen أولًا: brew install xcodegen"; exit 1; }

echo "▶ نسخ الواجهة إلى موارد التطبيق…"
rm -rf MasarApp/Resources/www
mkdir -p MasarApp/Resources
cp -r "$ROOT/app" MasarApp/Resources/www

echo "▶ توليد مشروع Xcode…"
xcodegen generate

echo "✅ جاهز:  open MasarApp.xcodeproj"
