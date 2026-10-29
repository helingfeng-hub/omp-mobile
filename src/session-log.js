import fs from "node:fs";
import path from "node:path";

const HEAD_BYTES = 8 * 1024;
const MAX_ITEMS = 240;
const THINKING_LIMIT = 2000;
const TOOL_LIMIT = 600;
const TEXT_LIMIT = 8000;

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

function readEnded(file, stat) {
  if (!stat.size) return false;
  const length = Math.min(stat.size, 16 * 1024);
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = fs.openSync(file, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(descriptor);
  }
  const lines = buffer.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    return event.type === "custom" && event.customType === "session_exit";
  }
  return false;
}

function cleanTitle(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 40);
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
  let id = "";
  let parent = null;
  let title = "";
  let cwd = "";
  let fallback = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type === "title" && typeof value.title === "string") title = value.title.trim();
    if (value.type === "session" && typeof value.id === "string") {
      id = value.id;
      parent = typeof value.parentSession === "string" ? value.parentSession : null;
      cwd = typeof value.cwd === "string" ? value.cwd : "";
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
    if (fallback && id) break;
  }
  return { id, parent, title, cwd, fallback: cleanTitle(fallback) };
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

function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function toolArgs(value) {
  if (value === undefined || value === null) return "";
  try {
    return truncate(JSON.stringify(value), TOOL_LIMIT);
  } catch {
    return truncate(String(value), TOOL_LIMIT);
  }
}

function pushItem(state, item) {
  state.items.push(item);
  if (state.items.length > MAX_ITEMS) {
    state.items.splice(0, state.items.length - MAX_ITEMS);
  }
}

function ingestMessage(state, event) {
  const message = event?.message;
  if (!message || typeof message !== "object") return;
  const content = Array.isArray(message.content) ? message.content : [];
  if (message.role === "user") {
    const texts = content
      .filter((block) => block?.type === "text" && block.text)
      .map((block) => String(block.text));
    const images = content.some((block) => block?.type === "image");
    if (texts.length > 0 || images) {
      pushItem(state, {
        kind: "user",
        text: truncate(texts.join("\n\n") || "[图片]", TEXT_LIMIT),
        ts: event.timestamp,
        id: event.id,
      });
    }
    return;
  }
  if (message.role !== "assistant") return;

  const texts = [];
  const thinking = [];
  for (const block of content) {
    if (block?.type === "text" && block.text) texts.push(String(block.text));
    if (block?.type === "thinking" && block.thinking) thinking.push(String(block.thinking));
  }
  if (texts.length > 0 || thinking.length > 0) {
    pushItem(state, {
      kind: "assistant",
      text: truncate(texts.join("\n\n"), TEXT_LIMIT),
      thinking: truncate(thinking.join("\n\n"), THINKING_LIMIT),
      tools: [],
      model: message.model || null,
      ts: event.timestamp,
      id: event.id,
    });
  }
  if (message.model) state.model = message.model;
  if (message.contextSnapshot) {
    state.context = {
      promptTokens: Number(message.contextSnapshot.promptTokens) || 0,
      nonMessageTokens: Number(message.contextSnapshot.nonMessageTokens) || 0,
      toolSchemaTokens: Number(message.contextSnapshot.toolSchemaTokens) || 0,
      compactionEpoch: Number(message.contextSnapshot.compactionEpoch) || 0,
    };
  }
  if (message.usage) {
    state.usage = {
      input: Number(message.usage.input) || 0,
      output: Number(message.usage.output) || 0,
      cacheRead: Number(message.usage.cacheRead) || 0,
      totalTokens: Number(message.usage.totalTokens) || 0,
    };
  }
}

function ingest(state, event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "title" && typeof event.title === "string") {
    state.title = event.title.trim();
    return;
  }
  if (event.type === "session") {
    state.id = event.id || state.id;
    state.parent = event.parentSession || state.parent;
    return;
  }
  if (event.type === "model_change" && typeof event.model === "string") {
    state.model = event.model;
    return;
  }
  if (event.type === "custom_message") {
    if (
      event.customType === "collab-prompt" &&
      event.display !== false &&
      typeof event.content === "string"
    ) {
      pushItem(state, {
        kind: "user",
        text: truncate(event.content, TEXT_LIMIT),
        ts: event.timestamp,
        id: event.id,
      });
    }
    return;
  }
  if (event.type === "custom" && event.customType === "tool_execution_start") {
    const data = event.data && typeof event.data === "object" ? event.data : {};
    pushItem(state, {
      kind: "tool",
      name: String(data.toolName || "tool"),
      intent: truncate(data.intent || "", 200),
      args: toolArgs(data.args),
      ts: event.timestamp,
      id: event.id,
    });
    return;
  }
  if (event.type === "message") ingestMessage(state, event);
}

export function createSessionLog(dir) {
  const fileCache = { at: 0, files: [] };
  const states = new Map();
  const tails = new Map();

  function files() {
    const now = Date.now();
    if (now - fileCache.at < 1_000) return fileCache.files;
    const list = [];
    for (const file of listSessionFiles(dir)) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const meta = parseMeta(readHead(file));
      if (!meta.id) continue;
      let tail = tails.get(file);
      if (!tail || tail.size !== stat.size || tail.mtime !== stat.mtimeMs) {
        let ended = false;
        try {
          ended = readEnded(file, stat);
        } catch {
          // Keep the previous value if the file disappears mid-read.
          ended = tail?.ended ?? false;
        }
        tail = { size: stat.size, mtime: stat.mtimeMs, ended };
        tails.set(file, tail);
      }
      list.push({
        file,
        id: meta.id,
        parent: meta.parent,
        title: meta.title,
        cwd: meta.cwd,
        fallback: meta.fallback,
        mtime: stat.mtimeMs,
        ended: tail.ended,
      });
    }
    fileCache.files = list;
    fileCache.at = now;
    return list;
  }

  function fileFor(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id || !dir) return null;
    return files().find((entry) => entry.id === id)?.file ?? null;
  }

  function catalog() {
    return files()
      .map((entry) => ({
        id: entry.id,
        title: entry.title || entry.fallback || "",
        cwd: entry.cwd || "",
        parent: entry.parent || null,
        fork: Boolean(entry.parent),
        updatedAt: entry.mtime,
        ended: Boolean(entry.ended),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function newestFor(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id || !dir) return null;
    const all = files();
    const seen = new Set();
    const stack = [id];
    let best = null;
    while (stack.length > 0) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const entry of all) {
        if (entry.id !== current && entry.parent !== current) continue;
        if (!best || entry.mtime > best.mtime) best = entry;
        if (entry.parent === current && entry.id !== current) stack.push(entry.id);
      }
    }
    return best?.file ?? null;
  }

  function read(file) {
    let state = states.get(file);
    if (!state) {
      state = {
        offset: 0,
        remainder: "",
        items: [],
        title: "",
        model: null,
        context: null,
        usage: null,
        id: null,
        parent: null,
        version: "",
      };
      states.set(file, state);
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return { ...state, missing: true, file: path.basename(file) };
    }
    if (stat.size < state.offset) {
      state.offset = 0;
      state.remainder = "";
      state.items = [];
      state.title = "";
      state.model = null;
      state.context = null;
      state.usage = null;
      state.id = null;
      state.parent = null;
    }
    if (stat.size > state.offset) {
      const length = stat.size - state.offset;
      const buffer = Buffer.allocUnsafe(length);
      const descriptor = fs.openSync(file, "r");
      try {
        fs.readSync(descriptor, buffer, 0, length, state.offset);
      } finally {
        fs.closeSync(descriptor);
      }
      state.offset = stat.size;
      const text = state.remainder + buffer.toString("utf8");
      const lines = text.split("\n");
      state.remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        ingest(state, event);
      }
    }
    state.version = `${state.offset}:${state.items.length}:${state.items.at(-1)?.id ?? ""}`;
    return {
      file: path.basename(file),
      title: state.title,
      model: state.model,
      context: state.context,
      usage: state.usage,
      items: state.items,
      updatedAt: stat.mtimeMs,
      version: state.version,
    };
  }

  return { catalog, fileFor, newestFor, read };
}
