import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { LinuxAdapter } from "../src/host.js";
import { createServer } from "../src/server.js";
import { SessionManager } from "../src/sessions.js";

function setup({ exit = true } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-resume-state-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-resume-root-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-resume-sessions-"));
  const sessionId = randomUUID();
  const projectDir = path.join(sessionDir, "project");
  const file = path.join(projectDir, `2026-10-29T00-00-00-000Z_${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "可恢复会话" }),
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-10-29T00:00:00.000Z",
      cwd: root,
    }),
  ];
  if (exit) {
    lines.push(JSON.stringify({
      type: "custom",
      customType: "session_exit",
      data: { reason: "test" },
      timestamp: "2026-10-29T00:00:01.000Z",
    }));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const config = loadConfig({
    OMP_REMOTE_STATE_DIR: stateDir,
    OMP_REMOTE_TOKEN: "test-token",
    OMP_REMOTE_ROOTS: root,
    OMP_REMOTE_SESSION_DIR: sessionDir,
    OMP_REMOTE_PORT: "0",
    OMP_REMOTE_TERMINAL: "0",
    OMP_REMOTE_START_TIMEOUT_MS: "3000",
  });
  return { config, stateDir, root, sessionDir, sessionId, file };
}

function host(sessionId, cwd, startedAt) {
  return {
    instanceId: `instance-${sessionId}`,
    generation: 1,
    sessionId,
    sessionName: "omp-test",
    title: "可恢复会话",
    cwd,
    model: null,
    startedAt,
    participants: 1,
    relayConnected: true,
    inputRequired: false,
    busy: false,
    access: "control",
    pid: 12345,
  };
}

function fakeAdapter(config, { inUse = false } = {}) {
  const calls = [];
  const resumeCwds = [];
  let started = false;
  let hosts = [];
  return {
    name: "fake",
    config,
    pty: null,
    calls,
    resumeCwds,
    setHosts(value) {
      hosts = value;
    },
    setStarted(value) {
      started = Boolean(value);
    },
    async check() {
      return { ok: true, omp: "fake-omp", tmux: "fake-tmux" };
    },
    async listSessions() {
      return [];
    },
    async runOmp() {
      return {
        stdout: JSON.stringify({ version: 1, hosts: started ? hosts : [] }),
        stderr: "",
        code: 0,
      };
    },
    async validateCwd(cwd) {
      return String(cwd);
    },
    async validateResumeCwd(cwd) {
      resumeCwds.push(String(cwd));
      return String(cwd);
    },
    async hasSession() {
      return false;
    },
    async startSession(args) {
      calls.push(args);
      started = true;
    },
    async killSession() {},
    async capture() {
      return "";
    },
    async sendPrompt() {
      throw new Error("prompt should not be sent");
    },
    async sessionInUse() {
      return inUse;
    },
  };
}

function cleanup({ stateDir, root, sessionDir }) {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });
}

test("resume starts tmux with --resume and waits for that session's host", async () => {
  const env = setup();
  const adapter = fakeAdapter(env.config);
  const now = Date.now();
  adapter.setHosts([
    host("other-session", env.root, now + 2000),
    host(env.sessionId, env.root, now + 1000),
  ]);
  const manager = new SessionManager(env.config, adapter);
  try {
    const session = await manager.resumeWorkstation(env.sessionId);
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].resume, env.sessionId);
    assert.equal(adapter.calls[0].cwd, env.root);
    assert.equal(adapter.resumeCwds[0], env.root);
    assert.match(session.name, /^omp-/);
    assert.equal(session.host.sessionId, env.sessionId);
  } finally {
    cleanup(env);
  }
});

test("resume refuses a session that another omp still has open", async () => {
  const env = setup();
  const manager = new SessionManager(env.config, fakeAdapter(env.config, { inUse: true }));
  try {
    await assert.rejects(
      () => manager.resumeWorkstation(env.sessionId),
      (error) => error.status === 409 && error.code === "session_in_use",
    );
  } finally {
    cleanup(env);
  }
});

test("resume rejects an unknown workstation session", async () => {
  const env = setup();
  const manager = new SessionManager(env.config, fakeAdapter(env.config));
  try {
    await assert.rejects(
      () => manager.resumeWorkstation("missing-session"),
      (error) => error.status === 404 && error.code === "workstation_session_not_found",
    );
  } finally {
    cleanup(env);
  }
});

test("resume accepts a recorded cwd outside roots while new sessions stay confined", async () => {
  const env = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-resume-outside-"));
  const adapter = new LinuxAdapter(env.config);
  try {
    assert.equal(await adapter.validateResumeCwd(outside), outside);
    await assert.rejects(
      () => adapter.validateCwd(outside),
      (error) => error.status === 403 && error.code === "cwd_forbidden",
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    cleanup(env);
  }
});

test("workstation sessions stay read-only while a host is running", async () => {
  const env = setup();
  const adapter = fakeAdapter(env.config);
  adapter.setStarted(true);
  adapter.setHosts([host(env.sessionId, env.root, Date.now())]);
  const manager = new SessionManager(env.config, adapter);
  try {
    const entry = (await manager.workstationSessions()).find((item) => item.id === env.sessionId);
    assert.equal(entry.running, true);
    assert.equal(entry.readOnly, true);
    assert.equal(entry.canPrompt, false);
  } finally {
    cleanup(env);
  }
});

test("workstation live exposes whether the session file is still open", async () => {
  const env = setup();
  const manager = new SessionManager(env.config, fakeAdapter(env.config, { inUse: true }));
  try {
    const live = await manager.workstationLive(env.sessionId);
    assert.equal(live.readOnly, true);
    assert.equal(live.inUse, true);
    assert.equal(live.ended, true);
  } finally {
    cleanup(env);
  }
});

test("unfinished sessions stay read-only and cannot be resumed", async () => {
  const env = setup({ exit: false });
  const manager = new SessionManager(env.config, fakeAdapter(env.config));
  try {
    const entry = (await manager.workstationSessions()).find((item) => item.id === env.sessionId);
    assert.equal(entry.running, true);
    assert.equal(entry.readOnly, true);
    await assert.rejects(
      () => manager.resumeWorkstation(env.sessionId),
      (error) => error.status === 409 && error.code === "session_in_use",
    );
  } finally {
    cleanup(env);
  }
});

test("unfinished sessions older than a week can be resumed", async () => {
  const env = setup({ exit: false });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(env.file, old, old);
  const adapter = fakeAdapter(env.config);
  adapter.setHosts([host(env.sessionId, env.root, Date.now())]);
  const manager = new SessionManager(env.config, adapter);
  try {
    const entry = (await manager.workstationSessions()).find((item) => item.id === env.sessionId);
    assert.equal(entry.running, false);
    const session = await manager.resumeWorkstation(env.sessionId);
    assert.equal(session.host.sessionId, env.sessionId);
  } finally {
    cleanup(env);
  }
});

test("live follows the newest fork of a tmux session", async () => {
  const env = setup();
  const childId = randomUUID();
  const childFile = path.join(
    path.dirname(env.file),
    `2026-10-29T04-13-19-972Z_${childId}.jsonl`,
  );
  fs.writeFileSync(childFile, [
    JSON.stringify({ type: "title", v: 1, title: "子会话" }),
    JSON.stringify({
      type: "session",
      version: 3,
      id: childId,
      parentSession: env.sessionId,
      timestamp: "2026-10-29T04:13:19.972Z",
      cwd: env.root,
    }),
    JSON.stringify({
      type: "message",
      id: "child-message",
      message: { role: "user", content: [{ type: "text", text: "子会话的新消息" }] },
      timestamp: "2026-10-29T04:14:00.000Z",
    }),
  ].join("\n") + "\n");
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(childFile, future, future);
  const adapter = fakeAdapter(env.config);
  adapter.setStarted(true);
  adapter.setHosts([host(env.sessionId, env.root, Date.now())]);
  adapter.listSessions = async () => [{
    name: "omp-test",
    cwd: env.root,
    createdAt: Date.now(),
    panePid: 12345,
  }];
  const manager = new SessionManager(env.config, adapter);
  try {
    await manager.refresh({ force: true });
    const live = await manager.live("omp-test");
    assert.equal(live.items.at(-1)?.text, "子会话的新消息");
    const snapshot = manager.snapshot().find((item) => item.name === "omp-test");
    assert.equal(snapshot.readOnly, true);
    await assert.rejects(
      () => manager.prompt("omp-test", "不要发送"),
      (error) => error.status === 409 && error.code === "session_read_only",
    );
    adapter.setHosts([]);
    await assert.rejects(
      () => manager.resumeWorkstation(env.sessionId),
      (error) => error.status === 409 && error.code === "session_in_use",
    );
  } finally {
    cleanup(env);
  }
});

test("POST /api/sessions with resume delegates to the manager", async () => {
  const env = setup();
  let resumed = null;
  const manager = {
    async refresh() {
      return [];
    },
    async resumeWorkstation(sessionId) {
      resumed = sessionId;
      return { name: "omp-test", host: null };
    },
  };
  const app = await createServer(env.config, {
    adapter: fakeAdapter(env.config),
    manager,
  });
  const addr = await app.start();
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/api/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ resume: env.sessionId }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.resumed, true);
    assert.equal(body.session.name, "omp-test");
    assert.equal(resumed, env.sessionId);
  } finally {
    await app.stop();
    cleanup(env);
  }
});
