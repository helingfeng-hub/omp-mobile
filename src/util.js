import crypto from "node:crypto";
import path from "node:path";

export class AppError extends Error {
  constructor(message, status = 400, code = "bad_request") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function randomId(bytes = 4) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function normalizeRoots(roots, pathModule = path) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!root) continue;
    const resolved = pathModule.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function isWithinRoots(target, roots, pathModule = path) {
  const resolved = pathModule.resolve(target);
  for (const root of roots) {
    const rel = pathModule.relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !pathModule.isAbsolute(rel))) return true;
  }
  return false;
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(new AppError("request body too large", 413, "body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      if (chunks.length === 0) return resolve("");
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });
}

export async function readJsonBody(req, limit) {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  const value = parseJson(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("request body must be a JSON object", 400, "invalid_json");
  }
  return value;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function mimeType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function sanitizeName(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "");
}

export function formatDuration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}
