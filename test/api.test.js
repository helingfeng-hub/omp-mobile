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
    assert.equal(state.activeSession, null);
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

test("monitor endpoint returns the last item for notifications", async () => {
  const { config, stateDir, root } = temporaryConfig();
  const adapter = fakeAdapter(config);
  const manager = {
    async refresh() {
      return [];
    },
    async monitor(name) {
      return {
        name,
        title: "自动标题",
        sessionId: "session-id",
        busy: false,
        inputRequired: false,
        relayConnected: true,
        updatedAt: 1793235000000,
        version: "1:2:item",
        last: { kind: "assistant", text: "输出完成", ts: "2026-10-29T08:50:00.000Z", id: "item", name: "" },
      };
    },
  };
  const app = await createServer(config, { adapter, manager });
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { authorization: "Bearer test-token" };
  try {
    const unauthorized = await fetch(`${base}/api/monitor?session=omp-test`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${base}/api/monitor?session=omp-test`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.title, "自动标题");
    assert.equal(body.last.kind, "assistant");
    assert.equal(body.last.text, "输出完成");
  } finally {
    await app.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("delete session route stops the selected session", async () => {
  const { config, stateDir, root } = temporaryConfig();
  const adapter = fakeAdapter(config);
  let stopped = null;
  const manager = {
    async refresh() {
      return [];
    },
    async stop(name) {
      stopped = name;
      return { stopped: true, name };
    },
  };
  const app = await createServer(config, { adapter, manager });
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { authorization: "Bearer test-token" };
  try {
    const unauthorized = await fetch(`${base}/api/sessions/omp-test`, { method: "DELETE" });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${base}/api/sessions/omp-test`, {
      method: "DELETE",
      headers,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).stopped, true);
    assert.equal(stopped, "omp-test");
  } finally {
    await app.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state and live expose read-only workstation sessions", async () => {
  const { config, stateDir, root } = temporaryConfig();
  const adapter = fakeAdapter(config);
  const manager = {
    async refresh() {
      return [];
    },
    workstationSessions() {
      return [{
        name: "ws:session-id",
        id: "session-id",
        kind: "workstation",
        title: "工作站标题",
        cwd: "/tmp/project",
        parent: null,
        fork: false,
        updatedAt: 1793242000000,
        readOnly: true,
      }];
    },
    async live(name) {
      return {
        name,
        sessionId: "session-id",
        readOnly: true,
        title: "工作站标题",
        items: [{ kind: "assistant", text: "只读输出", ts: "2026-10-29T02:00:00.000Z" }],
        updatedAt: 1793242000000,
        version: "1:1:a",
      };
    },
  };
  const app = await createServer(config, { adapter, manager });
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { authorization: "Bearer test-token" };
  try {
    const stateResponse = await fetch(`${base}/api/state`, { headers });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.workstationSessions.length, 1);
    assert.equal(state.workstationSessions[0].name, "ws:session-id");
    assert.equal(state.workstationSessions[0].readOnly, true);

    const liveResponse = await fetch(`${base}/api/live?session=ws:session-id`, { headers });
    assert.equal(liveResponse.status, 200);
    const live = await liveResponse.json();
    assert.equal(live.readOnly, true);
    assert.equal(live.title, "工作站标题");
    assert.equal(live.items[0].text, "只读输出");
  } finally {
    await app.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
