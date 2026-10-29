import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionTitleReader } from "../src/session-title.js";
import { createSessionLog } from "../src/session-log.js";
import { pickActiveSession } from "../src/sessions.js";

function writeSession(dir, name, lines) {
  fs.writeFileSync(
    path.join(dir, name),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

test("session title reader uses the newest titled child session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-title-"));
  try {
    writeSession(dir, "parent.jsonl", [
      { type: "title", title: "" },
      { type: "session", id: "parent" },
    ]);
    writeSession(dir, "child.jsonl", [
      { type: "title", title: "Sync workstation conversation" },
      { type: "session", id: "child", parentSession: "parent" },
    ]);
    const titleFor = createSessionTitleReader(dir);
    assert.equal(titleFor("parent"), "Sync workstation conversation");
    assert.equal(titleFor("child"), "Sync workstation conversation");
    assert.equal(titleFor("missing"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pickActiveSession prefers waiting, busy, shared, then newest", () => {
  const host = (overrides = {}) => ({
    relayConnected: true,
    inputRequired: false,
    busy: false,
    participants: 1,
    startedAt: 1,
    ...overrides,
  });
  const sessions = [
    { name: "idle", host: host({ startedAt: 10 }) },
    { name: "shared", host: host({ participants: 2, startedAt: 5 }) },
    { name: "busy", host: host({ busy: true, startedAt: 1 }) },
    { name: "waiting", host: host({ inputRequired: true, startedAt: 0 }) },
    { name: "offline", host: host({ relayConnected: false, inputRequired: true }) },
  ];
  assert.equal(pickActiveSession(sessions), "waiting");
  assert.equal(
    pickActiveSession([
      { name: "older", host: host({ startedAt: 1 }) },
      { name: "newer", host: host({ startedAt: 2 }) },
    ]),
    "newer",
  );
  assert.equal(pickActiveSession([]), null);
});

test("session log reader follows the newest child and parses messages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-log-"));
  try {
    const parent = path.join(dir, "parent.jsonl");
    const child = path.join(dir, "child.jsonl");
    writeSession(dir, "parent.jsonl", [
      { type: "title", title: "" },
      { type: "session", id: "parent" },
    ]);
    writeSession(dir, "child.jsonl", [
      { type: "title", title: "Live title" },
      { type: "session", id: "child", parentSession: "parent" },
      { type: "model_change", model: "deepseek/deepseek-flash" },
      {
        type: "custom_message",
        customType: "collab-prompt",
        content: "同步这条对话",
        display: true,
        id: "prompt-1",
        timestamp: "2026-10-29T08:00:00.000Z",
      },
      {
        type: "custom",
        customType: "tool_execution_start",
        id: "tool-1",
        timestamp: "2026-10-29T08:00:00.500Z",
        data: { toolName: "bash", intent: "跑测试", args: { command: "npm test" } },
      },
      {
        type: "message",
        id: "assistant-1",
        timestamp: "2026-10-29T08:00:01.000Z",
        message: {
          role: "assistant",
          model: "deepseek-flash",
          content: [
            { type: "text", text: "正在处理" },
            { type: "toolCall", name: "bash", intent: "跑测试", arguments: { command: "npm test" } },
          ],
          contextSnapshot: { promptTokens: 1234, nonMessageTokens: 10 },
          usage: { input: 1, output: 2, cacheRead: 3, totalTokens: 1234 },
        },
      },
      {
        type: "message",
        id: "user-1",
        timestamp: "2026-10-29T08:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: "工作站消息" }] },
      },
    ]);
    const log = createSessionLog(dir);
    assert.equal(path.basename(log.newestFor("parent")), "child.jsonl");
    const data = log.read(child);
    assert.equal(data.title, "Live title");
    assert.equal(data.model, "deepseek-flash");
    assert.equal(data.context.promptTokens, 1234);
    assert.deepEqual(
      data.items.map((item) => item.kind),
      ["user", "tool", "assistant", "user"],
    );
    assert.equal(data.items[1].name, "bash");
    assert.equal(data.items[1].intent, "跑测试");
    assert.equal(data.items[1].args, '{"command":"npm test"}');
    assert.equal(data.items[2].text, "正在处理");
    assert.equal(data.version.startsWith(`${fs.statSync(child).size}:4:`), true);
    assert.equal(fs.existsSync(parent), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
