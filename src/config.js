import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRoots, randomToken } from "./util.js";

export const VERSION = "0.1.7";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(HERE, "..", "public");

function readJsonConfig(stateDir) {
  const file = path.join(stateDir, "config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Missing or malformed config is not fatal; env is authoritative.
  }
  return {};
}

function readOrCreateToken(stateDir, explicit) {
  if (explicit && String(explicit).trim()) {
    return { token: String(explicit).trim(), created: false };
  }
  const file = path.join(stateDir, "token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 24) return { token: existing, created: false };
  } catch {
    // Create one below.
  }
  const token = randomToken(32);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file stays under the user's profile.
  }
  return { token, created: true };
}

function splitRoots(value) {
  if (!value) return [];
  // Accept the platform delimiter and commas, so a Windows env can list WSL paths.
  return String(value)
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

export function loadConfig(env = process.env, overrides = {}) {
  const home = os.homedir();
  const stateDir = path.resolve(
    env.OMP_REMOTE_STATE_DIR || overrides.stateDir || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "omp-remote"),
  );
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const fileConfig = readJsonConfig(stateDir);
  const merged = { ...fileConfig, ...overrides };

  const explicitToken = env.OMP_REMOTE_TOKEN || merged.token;
  const { token, created } = readOrCreateToken(stateDir, explicitToken);

  const platform = process.platform;
  const adapterKind =
    env.OMP_REMOTE_ADAPTER || merged.adapter || (platform === "win32" ? "wsl" : "linux");
  const rootValues = splitRoots(env.OMP_REMOTE_ROOTS || merged.roots);
  const fallbackRoot =
    adapterKind === "wsl" ? path.posix.join("/home", os.userInfo().username) : home;
  const roots = normalizeRoots(
    rootValues.length > 0 ? rootValues : [fallbackRoot],
    adapterKind === "wsl" ? path.posix : path,
  );

  const sessionEnv = {};
  for (const key of ["OMP_PROFILE", "PI_CODING_AGENT_DIR"]) {
    if (env[key]) sessionEnv[key] = env[key];
  }

  return {
    version: VERSION,
    publicDir: PUBLIC_DIR,
    stateDir,
    token,
    tokenCreated: created,
    host: env.OMP_REMOTE_HOST || merged.host || "127.0.0.1",
    port: Number(env.OMP_REMOTE_PORT || merged.port || 8787),
    platform,
    adapterKind,
    roots,
    ompBin: env.OMP_REMOTE_OMP || merged.ompBin || "omp",
    tmuxBin: env.OMP_REMOTE_TMUX || merged.tmuxBin || "tmux",
    wslBin: env.OMP_REMOTE_WSL || merged.wslBin || "wsl.exe",
    wslDistro: env.OMP_REMOTE_WSL_DISTRO || merged.wslDistro || "",
    relayUrl: env.OMP_REMOTE_RELAY || merged.relayUrl || "wss://my.omp.sh",
    collabWebUrl: env.OMP_REMOTE_WEB || merged.collabWebUrl || "",
    displayName: env.OMP_REMOTE_NAME || merged.displayName || os.hostname(),
    terminalEnabled: boolValue(env.OMP_REMOTE_TERMINAL ?? merged.terminal, true),
    startTimeoutMs: Number(env.OMP_REMOTE_START_TIMEOUT_MS || merged.startTimeoutMs || 30_000),
    linkTimeoutMs: Number(env.OMP_REMOTE_LINK_TIMEOUT_MS || merged.linkTimeoutMs || 20_000),
    maxBodyBytes: Number(env.OMP_REMOTE_MAX_BODY || merged.maxBodyBytes || 64 * 1024),
    sessionEnv,
    sessionPrefix: "omp-",
  };
}
