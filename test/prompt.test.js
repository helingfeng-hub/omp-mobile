import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { LinuxAdapter } from "../src/host.js";
import { createServer } from "../src/server.js";
import { SessionManager } from "../src/sessions.js";

function setup({ rows = [] } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-prompt-state-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-prompt-root-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-prompt-sessions-"));
  const config = loadConfig({
    OMP_REMOTE_STATE_DIR: stateDir,
    OMP_REMOTE_TOKEN: "test-token",
    OMP_REMOTE_ROOTS: root,
    OMP_REMOTE_SESSION_DIR: sessionDir,
    OMP_REMOTE_PORT: "0",
    OMP_REMOTE_TERMINAL: "0",
    OMP_REMOTE_START_TIMEOUT_MS: "3000",
  });
  return {
    config,
    stateDir,
    root,
    sessionDir,
    rows: rows.map((row) => ({ cwd: root, createdAt: Date.now(), panePid: 123, ...row })),
  };
}

function fakeAdapter(config, rows) {
  const prompts = [];
  return {
    name: "fake",
    config,
    pty: null,
    prompts,
    async check() {
      return { ok: true, omp: "fake-omp", tmux: "fake-tmux" };
    },
    async listSessions() {
      return rows;
    },
    async runOmp() {
      return { stdout: '{"version":1,"hosts":[]}', stderr: "", code: 0 };
    },
    async sessionInUse() {
      return false;
    },
    async sendPrompt(name, text) {
      prompts.push({ name, text });
    },
  };
}

function cleanup({ stateDir, root, sessionDir }) {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });
}

test("prompt sends text to the selected tmux session", async () => {
  const env = setup({ rows: [{ name: "omp-test" }] });
  const adapter = fakeAdapter(env.config, env.rows);
  const manager = new SessionManager(env.config, adapter);
  try {
    const result = await manager.prompt("omp-test", "第一行\n第二行");
    assert.deepEqual(adapter.prompts, [{ name: "omp-test", text: "第一行\n第二行" }]);
    assert.equal(result.sent, true);
  } finally {
    cleanup(env);
  }
});

test("prompt rejects empty text", async () => {
  const env = setup({ rows: [{ name: "omp-test" }] });
  const manager = new SessionManager(env.config, fakeAdapter(env.config, env.rows));
  try {
    await assert.rejects(
      () => manager.prompt("omp-test", "   "),
      (error) => error.status === 400 && error.code === "prompt_empty",
    );
  } finally {
    cleanup(env);
  }
});

test("prompt rejects an unknown session", async () => {
  const env = setup();
  const manager = new SessionManager(env.config, fakeAdapter(env.config, env.rows));
  try {
    await assert.rejects(
      () => manager.prompt("omp-missing", "hello"),
      (error) => error.status === 404 && error.code === "session_not_found",
    );
  } finally {
    cleanup(env);
  }
});

test("Linux prompt uses bracketed paste before Enter", async () => {
  const env = setup();
  const log = path.join(env.stateDir, "tmux.log");
  const tmuxBin = path.join(env.stateDir, "tmux");
  fs.writeFileSync(
    tmuxBin,
    `#!/bin/bash\nprintf '%q ' "$@" >> ${JSON.stringify(log)}\nprintf '\\n' >> ${JSON.stringify(log)}\n`,
    { mode: 0o755 },
  );
  const config = { ...env.config, tmuxBin };
  const adapter = new LinuxAdapter(config);
  try {
    await adapter.sendPrompt("omp-test", "第一行\n第二行");
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    const setIndex = calls.findIndex((line) => /set-buffer/.test(line));
    const pasteIndex = calls.findIndex((line) => /paste-buffer/.test(line));
    const enterIndex = calls.findIndex((line) => /send-keys/.test(line));
    assert.ok(setIndex >= 0, "set-buffer is called");
    assert.ok(pasteIndex > setIndex, "paste follows set");
    assert.ok(enterIndex > pasteIndex, "Enter follows paste");
    assert.match(calls[setIndex], /--/);
    assert.match(calls[setIndex], /第一行/);
    assert.match(calls[pasteIndex], /-p/);
    assert.match(calls[enterIndex], /Enter/);
    assert.ok(calls.some((line) => /delete-buffer/.test(line)), "buffer is cleaned up");
  } finally {
    cleanup(env);
  }
});

test("POST prompt route delegates to the manager", async () => {
  const env = setup();
  let received = null;
  const manager = {
    async refresh() {
      return [];
    },
    async prompt(name, text) {
      received = { name, text };
      return { sent: true };
    },
  };
  const app = await createServer(env.config, { adapter: fakeAdapter(env.config, []), manager });
  const addr = await app.start();
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/api/sessions/omp-test/prompt`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hello\nworld" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, { name: "omp-test", text: "hello\nworld" });
    assert.equal((await response.json()).sent, true);
  } finally {
    await app.stop();
    cleanup(env);
  }
});
