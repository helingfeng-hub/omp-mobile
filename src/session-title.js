import fs from "node:fs";
import path from "node:path";

const HEAD_BYTES = 8 * 1024;
const CACHE_MS = 5_000;

function readHead(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(descriptor, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function cleanFallback(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 32);
}

function messageText(value) {
  const message = value?.message && typeof value.message === "object" ? value.message : value;
  const role = message?.role ?? value?.role;
  if (role !== "user") return "";
  const content = message?.content ?? value?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function parseMeta(text) {
  let title = "";
  let id = "";
  let parent = null;
  let fallback = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type === "title" && typeof value.title === "string") {
      title = value.title.trim();
    }
    if (value.type === "session" && typeof value.id === "string") {
      id = value.id;
      parent = typeof value.parentSession === "string" ? value.parentSession : null;
    }
    if (!fallback) {
      if (
        value.type === "custom_message" &&
        value.display !== false &&
        typeof value.content === "string"
      ) {
        fallback = value.content;
      } else if (value.type === "message") {
        fallback = messageText(value);
      }
    }
    if (title && id) break;
  }
  return { title, id, parent, fallback: cleanFallback(fallback) };
}

function listSessionFiles(dir, depth = 0) {
  if (depth > 2) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSessionFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

export function createSessionTitleReader(dir) {
  let cache = { at: 0, byId: new Map(), children: new Map() };

  function load() {
    const now = Date.now();
    if (now - cache.at < CACHE_MS) return cache;
    const byId = new Map();
    const children = new Map();
    for (const file of listSessionFiles(dir)) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const meta = parseMeta(readHead(file));
      if (!meta.id) continue;
      const entry = { ...meta, mtime: stat.mtimeMs };
      byId.set(meta.id, entry);
      if (meta.parent) {
        const list = children.get(meta.parent) ?? [];
        list.push(entry);
        children.set(meta.parent, list);
      }
    }
    cache = { at: now, byId, children };
    return cache;
  }

  function titleFor(sessionId, seen = new Set()) {
    const id = String(sessionId || "").trim();
    if (!id || !dir || seen.has(id)) return null;
    seen.add(id);
    const { byId, children } = load();
    const own = byId.get(id);
    if (own?.title) return own.title;
    const descendants = [...(children.get(id) ?? [])].sort((a, b) => b.mtime - a.mtime);
    for (const child of descendants) {
      if (child.title) return child.title;
      const nested = titleFor(child.id, seen);
      if (nested) return nested;
    }
    return own?.fallback || null;
  }

  return titleFor;
}
