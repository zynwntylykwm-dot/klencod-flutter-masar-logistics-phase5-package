#!/usr/bin/env bash
# ============================================================================
# build-apk.sh — إعادة بناء ملف APK لتطبيق «المسار اللوجستي» من المصدر
# ----------------------------------------------------------------------------
# يحتاج: JDK 11+ (javac) + إنترنت لتنزيل أدوات أندرويد (مرة واحدة ~123MB + ~؟)
# لا يحتاج Gradle ولا Android Studio: البناء يدوي عبر aapt2 + d8 + apksigner.
#
# الاستخدام:  bash android/build-apk.sh
# الناتج:     masar-logistics-v1.0.0-phase5.apk  في جذر المشروع
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AND="$ROOT/android"
SDK_DIR="${SDK_DIR:-/tmp/sdk}"
BT="$SDK_DIR/android-14"          # build-tools (aapt2, d8, zipalign, apksigner)
AJAR="$SDK_DIR/android-13/android.jar"   # platform API 33
KEYTOOL="${KEYTOOL:-$(command -v keytool || echo /usr/lib/jvm/jdk-11/bin/keytool)}"

# 1) أدوات أندرويد (تُنزَّل مرة واحدة فقط)
if [ ! -x "$BT/aapt2" ] || [ ! -f "$AJAR" ]; then
  echo "▶ تنزيل أدوات أندرويد…"
  mkdir -p "$SDK_DIR" && cd "$SDK_DIR"
  [ -f bt.zip ] || curl -sL -o bt.zip https://dl.google.com/android/repository/build-tools_r34-linux.zip
  [ -f pf.zip ] || curl -sL -o pf.zip https://dl.google.com/android/repository/platform-33_r02.zip
  unzip -q -o bt.zip && unzip -q -o pf.zip
fi

# 2) نسخ الواجهة الكاملة داخل أصول التطبيق
echo "▶ نسخ الواجهة إلى assets/www…"
rm -rf "$AND/app/assets/www"
cp -r "$ROOT/app" "$AND/app/assets/www"

cd "$AND"
rm -rf build && mkdir -p build

# 3) الموارد + البيان → APK أساسي
echo "▶ ترجمة الموارد…"
"$BT/aapt2" compile --dir app/res -o build/res.zip
"$BT/aapt2" link -o build/base.apk -I "$AJAR" \
  --manifest app/AndroidManifest.xml -R build/res.zip -A app/assets \
  --java build/gen --min-sdk-version 21 --target-sdk-version 33 \
  --version-code 7 --version-name 1.0.0-phase5 --auto-add-overlay

# 4) جافا → dex
echo "▶ ترجمة جافا وتوليد classes.dex…"
mkdir -p build/classes
javac -encoding UTF-8 -source 8 -target 8 -nowarn \
  -bootclasspath "$AJAR" -classpath "$AJAR" -d build/classes \
  $(find app/src -name '*.java') build/gen/com/almasar/logistics/R.java
mkdir -p build/dex
"$BT/d8" --lib "$AJAR" --min-api 21 --release --output build/dex $(find build/classes -name '*.class')

# 5) تجميع + محاذاة + توقيع
echo "▶ تجميع وتوقيع…"
cd build
cp base.apk unsigned.apk
zip -q -j unsigned.apk dex/classes.dex
"$BT/zipalign" -f -p 4 unsigned.apk aligned.apk
KS="$AND/masar-release.keystore"
if [ ! -f "$KS" ]; then
  "$KEYTOOL" -genkeypair -keystore "$KS" -storepass masar2026 -keypass masar2026 \
    -alias masar -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=Almasar Global Logistics, OU=Mobile, O=Almasar, L=Ibb, C=YE"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:masar2026 --key-pass pass:masar2026 \
  --ks-key-alias masar --out "$ROOT/masar-logistics-v1.0.0-phase5.apk" aligned.apk
"$BT/apksigner" verify --print-certs "$ROOT/masar-logistics-v1.0.0-phase5.apk" | head -3

echo "✅ تم: $ROOT/masar-logistics-v1.0.0-phase5.apk"
