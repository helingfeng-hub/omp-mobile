import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

function temporaryConfig() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mobile-test-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mobile-root-"));
  const config = loadConfig(
    {
      OMP_REMOTE_STATE_DIR: stateDir,
      OMP_REMOTE_TOKEN: "test-token",
      OMP_REMOTE_ROOTS: root,
      OMP_REMOTE_PORT: "0",
      OMP_REMOTE_TERMINAL: "0",
      OMP_REMOTE_START_TIMEOUT_MS: "50",
    },
    {},
  );
  return { config, stateDir, root };
}

function fakeAdapter(config) {
  return {
    name: "fake",
    config,
    pty: null,
    terminalUnavailable: "disabled in test",
    async check() {
      return { ok: true, omp: "fake-omp", tmux: "fake-tmux" };
    },
    async listSessions() {
      return [];
    },
    async runOmp() {
      return { stdout: '{"version":1,"hosts":[]}', stderr: "", code: 0 };
    },
    async validateCwd(cwd) {
      return String(cwd);
    },
    async hasSession() {
      return false;
    },
    async startSession() {},
    async killSession() {},
    async capture() {
      return "fake pane";
    },
  };
}

test("API requires a token and serves the PWA shell", async () => {
  const { config, stateDir, root } = temporaryConfig();
  const adapter = fakeAdapter(config);
  const app = await createServer(config, { adapter });
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { authorization: "Bearer test-token" };
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(`${base}/api/state`);
    assert.equal(unauthorized.status, 401);

    const stateResponse = await fetch(`${base}/api/state`, { headers });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.adapter, "fake");
    assert.deepEqual(state.sessions, []);
    assert.equal(state.terminal, false);

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<title>omp 会话<\/title>/);
    assert.match(index.headers.get("content-security-policy"), /default-src 'self'/);

    const traversal = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(traversal.status, 403);

    const ticket = await fetch(`${base}/api/terminal/ticket`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cwd: root }),
    });
    assert.equal(ticket.status, 403);

    const start = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cwd: root }),
    });
    assert.equal(start.status, 504);
    const startBody = await start.json();
    assert.equal(startBody.code, "collab_timeout");
  } finally {
    await app.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
