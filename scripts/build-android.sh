#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)}"
PLATFORM="${ANDROID_PLATFORM:-$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -1 || true)}"
VERSION="${VERSION:-0.1.0}"
OUT="$ROOT/dist/omp-mobile-$VERSION.apk"
KEYSTORE="${OMP_ANDROID_KEYSTORE:-$HOME/.config/omp-mobile/android.keystore}"
STOREPASS="${OMP_ANDROID_KEYSTORE_PASS:-omp-mobile-pass}"
ALIAS="${OMP_ANDROID_KEY_ALIAS:-omp}"
JAVAC="${JAVAC:-javac}"
KEYTOOL="${KEYTOOL:-keytool}"

for file in "$BUILD_TOOLS/aapt2" "$BUILD_TOOLS/d8" "$BUILD_TOOLS/zipalign" "$BUILD_TOOLS/apksigner"; do
  [ -x "$file" ] || { echo "missing Android build tool: $file" >&2; exit 1; }
done
[ -f "$PLATFORM/android.jar" ] || { echo "missing platform android.jar: $PLATFORM" >&2; exit 1; }

rm -rf "$ROOT/android/build"
mkdir -p "$ROOT/android/build/classes" "$ROOT/android/build/dex" "$ROOT/android/build/gen" "$ROOT/android/build/res/mipmap-xxxhdpi" "$ROOT/dist"
cp "$ROOT/public/icons/icon-512.png" "$ROOT/android/build/res/mipmap-xxxhdpi/ic_launcher.png"

"$BUILD_TOOLS/aapt2" compile --dir "$ROOT/android/build/res" -o "$ROOT/android/build/res.zip"
"$BUILD_TOOLS/aapt2" link \
  -o "$ROOT/android/build/base.apk" \
  -I "$PLATFORM/android.jar" \
  --manifest "$ROOT/android/AndroidManifest.xml" \
  --java "$ROOT/android/build/gen" \
  --min-sdk-version 23 \
  --target-sdk-version 35 \
  --version-code 1 \
  --version-name "$VERSION" \
  "$ROOT/android/build/res.zip"

"$JAVAC" -source 8 -target 8 -Xlint:-options \
  -classpath "$PLATFORM/android.jar" \
  -d "$ROOT/android/build/classes" \
  "$ROOT/android/src/dev/omp/mobile/MainActivity.java"

"$BUILD_TOOLS/d8" --lib "$PLATFORM/android.jar" --min-api 23 \
  --output "$ROOT/android/build/dex" \
  "$ROOT"/android/build/classes/dev/omp/mobile/*.class

if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  "$KEYTOOL" -genkeypair \
    -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$STOREPASS" -keypass "$STOREPASS" \
    -dname "CN=omp mobile, OU=Personal, O=omp, C=CN"
  echo "created signing key: $KEYSTORE"
fi

(
  cd "$ROOT/android/build"
  cp base.apk unsigned.apk
  zip -j unsigned.apk dex/classes.dex >/dev/null
  "$BUILD_TOOLS/zipalign" -f 4 unsigned.apk aligned.apk
)
rm -f "$OUT"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$STOREPASS" --key-pass "pass:$STOREPASS" \
  --out "$OUT" "$ROOT/android/build/aligned.apk"
"$BUILD_TOOLS/apksigner" verify --print-certs "$OUT" | head -6
echo "built $OUT"
