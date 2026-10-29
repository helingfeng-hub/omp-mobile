import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionTitleReader } from "../src/session-title.js";
import { createSessionLog } from "../src/session-log.js";

function temporaryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omp-mobile-title-"));
}

function writeSession(dir, name, { title = "", id, parent = null, firstUser = "" }) {
  const lines = [
    JSON.stringify({ type: "title", v: 1, title, updatedAt: "2026-10-29T00:00:00.000Z" }),
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-10-29T00:00:00.000Z",
      cwd: "/home/helingfeng",
      ...(parent ? { parentSession: parent } : {}),
    }),
  ];
  if (firstUser) {
    lines.push(JSON.stringify({
      type: "custom_message",
      customType: "collab-prompt",
      content: firstUser,
      display: true,
      timestamp: "2026-10-29T00:00:01.000Z",
    }));
  }
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), `${lines.join("\n")}\n`);
}

test("prefers a forked child's auto title", () => {
  const dir = temporaryDir();
  try {
    writeSession(dir, "parent", { id: "parent-id" });
    writeSession(dir, "child", { title: "自动标题", id: "child-id", parent: "parent-id" });
    const titleFor = createSessionTitleReader(dir);
    assert.equal(titleFor("parent-id"), "自动标题");
    assert.equal(titleFor("child-id"), "自动标题");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to the first user message when the title line is empty", () => {
  const dir = temporaryDir();
  try {
    writeSession(dir, "session", {
      id: "session-id",
      firstUser: "  修复输入框遮挡\n第二行  ",
    });
    const titleFor = createSessionTitleReader(dir);
    assert.equal(titleFor("session-id"), "修复输入框遮挡 第二行");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to a normal user message", () => {
  const dir = temporaryDir();
  try {
    const id = "session-id";
    const lines = [
      JSON.stringify({ type: "title", v: 1, title: "" }),
      JSON.stringify({ type: "session", version: 3, id }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "同步电脑会话到手机" }] },
      }),
    ];
    fs.writeFileSync(path.join(dir, "session.jsonl"), `${lines.join("\n")}\n`);
    const titleFor = createSessionTitleReader(dir);
    assert.equal(titleFor(id), "同步电脑会话到手机");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fileFor keeps the host file while newestFor follows a fork", () => {
  const dir = temporaryDir();
  try {
    writeSession(dir, "parent", { id: "parent-id" });
    writeSession(dir, "child", { title: "fork title", id: "child-id", parent: "parent-id" });
    const parentPath = path.join(dir, "parent.jsonl");
    const childPath = path.join(dir, "child.jsonl");
    const now = Date.now();
    fs.utimesSync(parentPath, new Date(now - 5000), new Date(now - 5000));
    fs.utimesSync(childPath, new Date(now), new Date(now));
    const log = createSessionLog(dir);
    assert.equal(log.fileFor("parent-id"), parentPath);
    assert.equal(log.newestFor("parent-id"), childPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workstation catalog exposes title, cwd and first-user fallback", () => {
  const dir = temporaryDir();
  try {
    writeSession(dir, "fallback", {
      id: "fallback-id",
      firstUser: "  修复输入框\n第二行  ",
    });
    writeSession(dir, "titled", { id: "titled-id", title: "自动标题" });
    const log = createSessionLog(dir);
    const catalog = log.catalog();
    const fallback = catalog.find((entry) => entry.id === "fallback-id");
    const titled = catalog.find((entry) => entry.id === "titled-id");
    assert.equal(fallback.title, "修复输入框 第二行");
    assert.equal(fallback.cwd, "/home/helingfeng");
    assert.equal(fallback.fork, false);
    assert.equal(titled.title, "自动标题");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
