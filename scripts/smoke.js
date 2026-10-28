import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { startLocalRelay } from "./local-relay.js";

const runId = `${process.pid}-${Date.now()}`;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mobile-smoke-state-"));
const profile = `omp-mobile-smoke-${runId}`;
const profileDir = path.join(os.homedir(), ".omp", "profiles", profile);
const token = "smoke-token";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  console.log(...args);
}

async function main() {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });

  const relay = await startLocalRelay(0);
  log("relay", relay.url);

  process.env.OMP_REMOTE_STATE_DIR = stateDir;
  process.env.OMP_REMOTE_TOKEN = token;
  process.env.OMP_REMOTE_ROOTS = "/tmp";
  process.env.OMP_REMOTE_PORT = "0";
  process.env.OMP_REMOTE_RELAY = relay.url;
  process.env.OMP_REMOTE_WEB = "http://localhost:3000";
  process.env.OMP_REMOTE_START_TIMEOUT_MS = "30000";
  process.env.OMP_PROFILE = profile;

  const { loadConfig } = await import("../src/config.js");
  const { createServer } = await import("../src/server.js");
  const config = loadConfig();
  const app = await createServer(config);
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  log("bridge", base);

  let session = null;
  try {
    const state = await (await fetch(`${base}/api/state`, { headers })).json();
    log("initial sessions", state.sessions.length, "health", state.health);

    const started = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: "/tmp" }),
    });
    const startBody = await started.json();
    log("start", started.status, JSON.stringify(startBody).slice(0, 500));
    if (started.status !== 201) throw new Error(`start failed: ${JSON.stringify(startBody)}`);
    session = startBody.session.name;

    const state2 = await (await fetch(`${base}/api/state`, { headers })).json();
    const found = state2.sessions.find((item) => item.name === session);
    log("state session", JSON.stringify(found, null, 2));
    if (!found?.host?.instanceId) throw new Error("no collab host on session");

    const linkRes = await fetch(`${base}/api/sessions/${encodeURIComponent(session)}/link`, { headers });
    const link = await linkRes.json();
    log("link", linkRes.status, JSON.stringify(link).slice(0, 300));
    if (linkRes.status !== 200 || !link.url?.startsWith("http://localhost:3000/#")) {
      throw new Error(`bad link: ${JSON.stringify(link)}`);
    }

    const viewRes = await fetch(
      `${base}/api/sessions/${encodeURIComponent(session)}/link?access=view`,
      { headers },
    );
    const view = await viewRes.json();
    log("view link", viewRes.status, view.access, view.url?.slice(0, 60));
    if (viewRes.status !== 200 || view.access !== "view") throw new Error("bad view link");

    const ticketRes = await fetch(`${base}/api/terminal/ticket`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: "/tmp", cols: 80, rows: 24 }),
    });
    const ticketBody = await ticketRes.json();
    log("ticket", ticketRes.status, Boolean(ticketBody.ticket));
    if (ticketRes.status !== 201) throw new Error("ticket failed");

    const wsUrl = `ws://127.0.0.1:${addr.port}/ws/terminal?ticket=${encodeURIComponent(ticketBody.ticket)}`;
    const ptyOutput = await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let output = "";
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`pty timeout; output=${output.slice(-500)}`));
      }, 10_000);
      ws.on("message", (data) => {
        const text = String(data);
        output += text;
        if (text.includes("PTY_OK")) {
          clearTimeout(timer);
          ws.close();
          resolve(output);
        }
      });
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "input", data: "printf 'PTY_OK\\n'; exit\n" }));
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    log("pty output contains PTY_OK:", ptyOutput.includes("PTY_OK"));

    const stopped = await fetch(`${base}/api/sessions/${encodeURIComponent(session)}`, {
      method: "DELETE",
      headers,
    });
    log("stop", stopped.status, await stopped.text());
    session = null;
  } finally {
    if (session) {
      await fetch(`${base}/api/sessions/${encodeURIComponent(session)}`, {
        method: "DELETE",
        headers,
      }).catch(() => {});
    }
    await app.stop();
    await relay.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(profileDir, { recursive: true, force: true });
    log("cleaned");
  }
}

main().catch((err) => {
  console.error("SMOKE FAILED", err);
  process.exitCode = 1;
});
