import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, "update.json"), "utf8"));
const apkName = String(manifest.apk || "");
const expectedName = `omp-mobile-${manifest.versionName}.apk`;
assert.equal(apkName, expectedName, "update manifest must point at a versioned APK");
const apkPath = path.join(publicDir, apkName);
const apk = fs.readFileSync(apkPath);
assert.equal(apk.length, manifest.size, "APK size does not match update.json");
assert.equal(
  crypto.createHash("sha256").update(apk).digest("hex"),
  manifest.sha256,
  "APK sha256 does not match update.json",
);

function findTool(name) {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (home) {
    const dir = path.join(home, "build-tools");
    if (fs.existsSync(dir)) {
      const versions = fs
        .readdirSync(dir)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .reverse();
      for (const version of versions) {
        const candidate = path.join(dir, version, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return name;
}

const badging = execFileSync(findTool("aapt2"), ["dump", "badging", apkPath], {
  encoding: "utf8",
});
const version = /versionCode='(\d+)' versionName='([^']+)'/.exec(badging);
assert.ok(version, "cannot read APK version");
assert.equal(Number(version[1]), manifest.versionCode, "APK versionCode does not match update.json");
assert.equal(version[2], manifest.versionName, "APK versionName does not match update.json");

const certs = execFileSync(findTool("apksigner"), ["verify", "--print-certs", apkPath], {
  encoding: "utf8",
});
assert.match(certs, /Signer #1/);
const expectedSigner = process.env.OMP_EXPECTED_SIGNER || "";
if (expectedSigner) {
  assert.ok(certs.includes(expectedSigner), "APK signer does not match OMP_EXPECTED_SIGNER");
}

const base = process.env.OMP_UPDATE_BASE || "http://127.0.0.1:8787/";
const manifestResponse = await fetch(new URL("update.json", base), { cache: "no-store" });
assert.equal(manifestResponse.status, 200, "update.json is not reachable");
assert.match(
  manifestResponse.headers.get("cache-control") || "",
  /no-store/,
  "update.json must be served with no-store",
);
assert.deepEqual(await manifestResponse.json(), manifest, "served update.json differs from disk");

const apkResponse = await fetch(new URL(apkName, base), { cache: "no-store" });
assert.equal(apkResponse.status, 200, "versioned APK is not reachable");
assert.match(
  apkResponse.headers.get("cache-control") || "",
  /no-store/,
  "APK must be served with no-store",
);
const servedApk = Buffer.from(await apkResponse.arrayBuffer());
assert.equal(servedApk.length, manifest.size, "served APK size mismatch");
assert.equal(
  crypto.createHash("sha256").update(servedApk).digest("hex"),
  manifest.sha256,
  "served APK sha256 mismatch",
);

console.log(
  `update ok: ${manifest.versionName} (code ${manifest.versionCode}), ${apkName}, ${manifest.size} bytes`,
);
console.log(`install: ${new URL(apkName, base)}`);
