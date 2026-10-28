#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)}"
PLATFORM="${ANDROID_PLATFORM:-$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -1 || true)}"
VERSION="${VERSION:-0.1.1-personal}"
VERSION_NAME="${VERSION_NAME:-${VERSION%-personal}}"
VERSION_CODE="${VERSION_CODE:-2}"
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
mkdir -p "$ROOT/android/build/classes" "$ROOT/android/build/dex" "$ROOT/android/build/gen" \
  "$ROOT/android/build/genlocal/dev/omp/mobile" "$ROOT/android/build/res/mipmap-xxxhdpi" "$ROOT/dist"
cp "$ROOT/public/icons/icon-512.png" "$ROOT/android/build/res/mipmap-xxxhdpi/ic_launcher.png"

python3 - "$ROOT/android/AndroidManifest.xml" "$ROOT/android/build/AndroidManifest.xml" "$VERSION_CODE" "$VERSION_NAME" <<'PY'
import re
import sys
from pathlib import Path

source, target, code, name = sys.argv[1:5]
text = Path(source).read_text(encoding="utf-8")
text = re.sub(r'android:versionCode="[^"]*"', 'android:versionCode="%s"' % code, text)
text = re.sub(r'android:versionName="[^"]*"', 'android:versionName="%s"' % name, text)
Path(target).write_text(text, encoding="utf-8")
PY

# Optional build-time personalization. Never commit the generated file.
OMP_MOBILE_URL="${OMP_MOBILE_URL:-}" OMP_MOBILE_TOKEN="${OMP_MOBILE_TOKEN:-}" \
python3 - "$ROOT/android/build/genlocal/dev/omp/mobile/LocalConfig.java" <<'PY'
import json
import os
import sys

path = sys.argv[1]
url = os.environ.get("OMP_MOBILE_URL", "")
token = os.environ.get("OMP_MOBILE_TOKEN", "")
with open(path, "w", encoding="utf-8") as handle:
    handle.write("package dev.omp.mobile;\n\n")
    handle.write("final class LocalConfig {\n")
    handle.write("    static final String DEFAULT_URL = %s;\n" % json.dumps(url))
    handle.write("    static final String DEFAULT_TOKEN = %s;\n" % json.dumps(token))
    handle.write("    private LocalConfig() {}\n")
    handle.write("}\n")
PY

"$BUILD_TOOLS/aapt2" compile --dir "$ROOT/android/build/res" -o "$ROOT/android/build/res.zip"
"$BUILD_TOOLS/aapt2" link \
  -o "$ROOT/android/build/base.apk" \
  -I "$PLATFORM/android.jar" \
  --manifest "$ROOT/android/build/AndroidManifest.xml" \
  --java "$ROOT/android/build/gen" \
  --min-sdk-version 23 \
  --target-sdk-version 35 \
  "$ROOT/android/build/res.zip"

"$JAVAC" -source 8 -target 8 -g:none -Xlint:-options \
  -classpath "$PLATFORM/android.jar" \
  -d "$ROOT/android/build/classes" \
  "$ROOT/android/src/dev/omp/mobile/MainActivity.java" \
  "$ROOT/android/src/dev/omp/mobile/UpdateChecker.java" \
  "$ROOT/android/src/dev/omp/mobile/ApkProvider.java" \
  "$ROOT/android/build/genlocal/dev/omp/mobile/LocalConfig.java"

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

if [ -n "${OMP_MOBILE_URL:-}" ]; then
  SHA256="$(sha256sum "$OUT" | awk '{print $1}')"
  SIZE="$(stat -c%s "$OUT")"
  cp "$OUT" "$ROOT/public/omp-mobile-latest.apk"
  cp "$OUT" "$ROOT/public/omp-mobile-personal.apk"
  OMP_MOBILE_UPDATE_NOTES="${OMP_MOBILE_UPDATE_NOTES:-应用内更新已启用。}" \
  python3 - "$ROOT/public/update.json" "$VERSION_CODE" "$VERSION_NAME" "$SHA256" "$SIZE" <<'PY'
import json
import os
import sys

path, code, name, sha, size = sys.argv[1:6]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "versionCode": int(code),
            "versionName": name,
            "apk": "omp-mobile-latest.apk",
            "sha256": sha,
            "size": int(size),
            "notes": os.environ.get("OMP_MOBILE_UPDATE_NOTES", "应用内更新已启用。"),
        },
        handle,
        ensure_ascii=False,
        indent=2,
    )
    handle.write("\n")
PY
  echo "published update manifest: $ROOT/public/update.json"
fi
