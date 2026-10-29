import fs from "node:fs";
import path from "node:path";
import { AppError, randomId } from "./util.js";
import { findHostForSession, linkForHost, listHosts, waitForHost } from "./collab.js";
import { parseSessionStatus } from "./status.js";
import { createSessionTitleReader } from "./session-title.js";
import { createSessionLog } from "./session-log.js";

const ABANDONED_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function publicHost(host) {
  if (!host) return null;
  return {
    instanceId: host.instanceId,
    generation: host.generation,
    sessionId: host.sessionId,
    sessionName: host.sessionName,
    title: host.title ?? null,
    cwd: host.cwd,
    model: host.model ?? null,
    startedAt: host.startedAt,
    participants: host.participants,
    relayConnected: host.relayConnected,
    inputRequired: host.inputRequired,
    busy: host.busy,
    access: host.access,
  };
}

function buildOverlay(config) {
  const lines = [
    "collab:",
    "  autoStart: control",
    `  relayUrl: ${JSON.stringify(config.relayUrl)}`,
    `  displayName: ${JSON.stringify(config.displayName)}`,
  ];
  if (config.collabWebUrl) lines.push(`  webUrl: ${JSON.stringify(config.collabWebUrl)}`);
  return `${lines.join("\n")}\n`;
}

function activeScore(host) {
  return (host.inputRequired ? 4 : 0)
    + (host.busy ? 2 : 0)
    + (Number(host.participants) > 1 ? 1 : 0);
}

function sessionEnded(entry) {
  if (!entry) return true;
  if (entry.ended) return true;
  return Boolean(entry.updatedAt) && Date.now() - entry.updatedAt > ABANDONED_SESSION_MS;
}

export function pickActiveSession(sessions) {
  const ranked = [...sessions].filter(
    (entry) => entry?.host && entry.host.relayConnected !== false,
  );
  ranked.sort((a, b) => {
    const score = activeScore(b.host) - activeScore(a.host);
    if (score !== 0) return score;
    return (Number(b.host.startedAt) || 0) - (Number(a.host.startedAt) || 0);
  });
  return ranked[0]?.name ?? null;
}

export class SessionManager {
  constructor(config, adapter) {
    this.config = config;
    this.adapter = adapter;
    this.overlayDir = path.join(config.stateDir, "overlays");
    fs.mkdirSync(this.overlayDir, { recursive: true, mode: 0o700 });
    this.sessionTitle = createSessionTitleReader(config.sessionDir);
    this.sessionLog = createSessionLog(config.sessionDir);
    this.sessions = new Map();
    this.hosts = [];
    this.hostsAt = 0;
    this.refreshing = null;
    this.resumeRequests = new Map();
  }

  async getHosts({ force = false } = {}) {
    const ttl = force ? 0 : 1_000;
    if (!force && Date.now() - this.hostsAt < ttl) return this.hosts;
    this.hosts = await listHosts(this.adapter);
    this.hostsAt = Date.now();
    return this.hosts;
  }

  #familyRunning(entry) {
    const all = this.sessionLog.catalog();
    const byId = new Map(all.map((item) => [item.id, item]));
    let root = entry;
    const seen = new Set();
    while (root?.parent && byId.has(root.parent) && !seen.has(root.id)) {
      seen.add(root.id);
      root = byId.get(root.parent);
    }
    if (!root) return false;
    const family = new Set();
    const stack = [root.id];
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id || family.has(id)) continue;
      family.add(id);
      for (const item of all) {
        if (item.parent === id) stack.push(item.id);
      }
    }
    return all.some((item) => family.has(item.id) && !sessionEnded(item));
  }

  #readOnly(entry) {
    if (!entry?.host) return false;
    const hostFile = this.sessionLog.fileFor(entry.host.sessionId);
    const liveFile = this.sessionLog.newestFor(entry.host.sessionId);
    if (!hostFile || !liveFile || hostFile === liveFile) return false;
    const live = this.sessionLog.catalog().find(
      (item) => this.sessionLog.fileFor(item.id) === liveFile,
    );
    return Boolean(live && !sessionEnded(live));
  }

  snapshot() {
    return [...this.sessions.values()]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map((entry) => ({
        name: entry.name,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        host: publicHost(entry.host),
        readOnly: this.#readOnly(entry),
      }));
  }

  async workstationSessions() {
    const hosts = await this.getHosts().catch(() => []);
    const bySession = new Map();
    for (const host of hosts) {
      if (host?.sessionId) bySession.set(host.sessionId, host);
    }
    return this.sessionLog.catalog().map((entry) => {
      const host = bySession.get(entry.id);
      const activeHost = host && host.relayConnected !== false ? host : null;
      const ended = sessionEnded(entry);
      return {
        name: `ws:${entry.id}`,
        id: entry.id,
        kind: "workstation",
        title: entry.title || "",
        cwd: entry.cwd || "",
        parent: entry.parent || null,
        fork: Boolean(entry.fork),
        updatedAt: entry.updatedAt,
        host: activeHost
          ? publicHost({ ...activeHost, title: entry.title || activeHost.title })
          : null,
        running: Boolean(activeHost) || !ended,
        ended,
        canPrompt: false,
        readOnly: true,
      };
    });
  }

  get(name) {
    const entry = this.sessions.get(name);
    if (!entry) throw new AppError(`unknown session: ${name}`, 404, "session_not_found");
    return {
      name: entry.name,
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      host: publicHost(entry.host),
    };
  }

  async refresh({ force = false } = {}) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.#refresh(force).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async #refresh(force) {
    const rows = await this.adapter.listSessions();
    const live = new Set(rows.map((row) => row.name));
    for (const name of this.sessions.keys()) {
      if (!live.has(name)) {
        this.sessions.delete(name);
        this.#removeOverlay(name);
      }
    }

    const hosts = await this.getHosts({ force }).catch(() => []);
    const used = new Set();
    for (const row of rows) {
      const entry = this.sessions.get(row.name) ?? {
        name: row.name,
        cwd: row.cwd,
        createdAt: row.createdAt,
        host: null,
      };
      entry.cwd = row.cwd || entry.cwd;
      entry.createdAt = row.createdAt ?? entry.createdAt;
      entry.panePid = Number(row.panePid) || null;
      this.sessions.set(row.name, entry);

      const host = findHostForSession(hosts, {
        pid: entry.panePid,
        instanceId: entry.host?.instanceId,
        generation: entry.host?.generation,
        cwd: entry.cwd,
        since: entry.createdAt,
        exclude: used,
      });
      if (host) {
        host.title = this.sessionTitle(host.sessionId);
        entry.host = host;
        used.add(host.instanceId);
      } else {
        entry.host = null;
      }
    }
    return this.snapshot();
  }

  async resumeWorkstation(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) {
      throw new AppError("invalid workstation session", 400, "invalid_workstation_session");
    }
    const entry = this.sessionLog.catalog().find((item) => item.id === id);
    if (!entry) {
      throw new AppError("workstation session not found", 404, "workstation_session_not_found");
    }

    const hosts = await this.getHosts({ force: true });
    const activeHost = hosts.find(
      (host) => host.sessionId === id && host.relayConnected !== false,
    );
    if (activeHost) {
      await this.refresh({ force: true });
      const linked = [...this.sessions.values()].find(
        (session) => session.host?.instanceId === activeHost.instanceId,
      );
      if (linked) return this.get(linked.name);
      throw new AppError(
        "这个会话正在电脑上的另一个 omp 中托管，请直接使用电脑上的会话",
        409,
        "session_already_running",
      );
    }

    if (!sessionEnded(entry) || this.#familyRunning(entry)) {
      throw new AppError(
        "这个会话或它的分支正在电脑上运行，手机只能查看，不能 resume",
        409,
        "session_in_use",
      );
    }

    const file = this.sessionLog.fileFor(id);
    if (file && await this.adapter.sessionInUse(file)) {
      throw new AppError(
        "这个会话正在电脑上的 omp 中运行，不能同时接管。请先在电脑上结束该会话再试",
        409,
        "session_in_use",
      );
    }

    const pending = this.resumeRequests.get(id);
    if (pending) return pending;
    const task = this.start({
      cwd: entry.cwd || this.config.roots[0],
      resume: id,
    }).finally(() => {
      if (this.resumeRequests.get(id) === task) this.resumeRequests.delete(id);
    });
    this.resumeRequests.set(id, task);
    return task;
  }

  async start({ cwd, resume } = {}) {
    const resumeId = resume ? String(resume).trim() : null;
    const target = resumeId
      ? await this.adapter.validateResumeCwd(cwd || this.config.roots[0])
      : await this.adapter.validateCwd(cwd || this.config.roots[0]);
    let name = `${this.config.sessionPrefix}${randomId(4)}`;
    for (let i = 0; i < 5 && (await this.adapter.hasSession(name)); i++) {
      name = `${this.config.sessionPrefix}${randomId(4)}`;
    }

    const overlayPath = path.join(this.overlayDir, `${name}.yml`);
    fs.writeFileSync(overlayPath, buildOverlay(this.config), { mode: 0o600 });
    const createdAt = Date.now();
    let started = false;
    try {
      await this.adapter.startSession({ name, cwd: target, overlayPath, resume: resumeId });
      started = true;
      const exclude = new Set(
        [...this.sessions.values()].map((entry) => entry.host?.instanceId).filter(Boolean),
      );
      const host = await waitForHost(this.adapter, {
        cwd: target,
        sessionId: resumeId,
        since: createdAt,
        exclude,
        timeoutMs: this.config.startTimeoutMs,
      });
      host.title = this.sessionTitle(host.sessionId);
      const entry = { name, cwd: target, createdAt, panePid: Number(host.pid) || null, host };
      this.sessions.set(name, entry);
      this.hostsAt = 0;
      return this.get(name);
    } catch (err) {
      let output = "";
      if (started) {
        try {
          output = await this.adapter.capture(name, 60);
        } catch {
          // The session may already be gone.
        }
        await this.adapter.killSession(name).catch(() => {});
      }
      this.#removeOverlay(name);
      if (err instanceof AppError && output.trim()) {
        err.message = `${err.message}\n--- tmux output ---\n${output.trim().slice(-4000)}`;
      }
      throw err;
    }
  }

  async stop(name) {
    this.#assertName(name);
    const entry = this.sessions.get(name);
    if (!entry && !(await this.adapter.hasSession(name))) {
      throw new AppError(`unknown session: ${name}`, 404, "session_not_found");
    }
    await this.adapter.killSession(name);
    this.sessions.delete(name);
    this.#removeOverlay(name);
    this.hostsAt = 0;
    return { stopped: true, name };
  }

  async link(name, access = "control") {
    const raw = String(name || "");
    if (raw.startsWith("ws:")) return this.workstationLink(raw.slice(3), access);
    this.#assertName(name);
    const entry = this.sessions.get(name);
    if (!entry) throw new AppError(`unknown session: ${name}`, 404, "session_not_found");

    const resolveHost = async (force) => {
      const hosts = await this.getHosts({ force });
      const used = new Set(
        [...this.sessions.values()]
          .filter((other) => other.name !== name)
          .map((other) => other.host?.instanceId)
          .filter(Boolean),
      );
      const host = findHostForSession(hosts, {
        pid: entry.panePid,
        instanceId: entry.host?.instanceId,
        generation: entry.host?.generation,
        cwd: entry.cwd,
        since: entry.createdAt,
        exclude: used,
      });
      if (host) {
        host.title = this.sessionTitle(host.sessionId);
        entry.host = host;
      }
      return host;
    };

    let host = await resolveHost(false);
    if (!host) host = await resolveHost(true);
    if (!host) {
      throw new AppError("this session is not hosting a collab room yet", 409, "collab_not_ready");
    }

    try {
      const result = await linkForHost(this.adapter, host.instanceId, access);
      entry.host = host;
      return result;
    } catch (err) {
      if (err.code !== "stale_generation") throw err;
      const refreshed = await resolveHost(true);
      if (!refreshed) throw err;
      return linkForHost(this.adapter, refreshed.instanceId, access);
    }
  }

  async workstationLink(sessionId, access = "control") {
    const id = String(sessionId || "").trim();
    if (!id) {
      throw new AppError("invalid workstation session", 400, "invalid_workstation_session");
    }
    const hosts = await this.getHosts({ force: true });
    const host = hosts.find(
      (item) => item.sessionId === id && item.relayConnected !== false,
    );
    if (!host) {
      throw new AppError(
        "this workstation session is not hosting a collab room",
        409,
        "collab_not_ready",
      );
    }
    return linkForHost(this.adapter, host.instanceId, access);
  }

  async output(name, lines) {
    this.#assertName(name);
    return this.adapter.capture(name, lines);
  }

  async prompt(name, text) {
    this.#assertName(name);
    const value = typeof text === "string" ? text : String(text ?? "");
    if (!value.trim()) {
      throw new AppError("prompt is empty", 400, "prompt_empty");
    }
    if (value.length > 32 * 1024) {
      throw new AppError("prompt is too large", 413, "prompt_too_large");
    }
    let entry = this.sessions.get(name);
    if (!entry) {
      await this.refresh({ force: true });
      entry = this.sessions.get(name);
    }
    if (!entry) {
      throw new AppError(`unknown session: ${name}`, 404, "session_not_found");
    }
    if (this.#readOnly(entry)) {
      throw new AppError(
        "这个会话正在电脑上运行，手机只能查看，不能输入",
        409,
        "session_read_only",
      );
    }
    await this.adapter.sendPrompt(name, value);
    return { sent: true };
  }

  async live(name) {
    const raw = String(name || "");
    if (raw.startsWith("ws:")) return this.workstationLive(raw.slice(3));
    this.#assertName(name);
    let entry = this.sessions.get(name);
    if (!entry) {
      await this.refresh({ force: true });
      entry = this.sessions.get(name);
    }
    if (!entry) throw new AppError(`unknown session: ${name}`, 404, "session_not_found");
    let host = entry.host;
    if (!host) {
      const hosts = await this.getHosts({ force: true });
      const used = new Set(
        [...this.sessions.values()]
          .filter((other) => other.name !== name)
          .map((other) => other.host?.instanceId)
          .filter(Boolean),
      );
      host = findHostForSession(hosts, {
        pid: entry.panePid,
        cwd: entry.cwd,
        since: entry.createdAt,
        exclude: used,
      });
      if (host) {
        host.title = this.sessionTitle(host.sessionId);
        entry.host = host;
      }
    }
    if (!host) {
      throw new AppError("this session is not hosting a collab room yet", 409, "collab_not_ready");
    }
    const file = this.sessionLog.newestFor(host.sessionId)
      || this.sessionLog.fileFor(host.sessionId);
    if (!file) {
      throw new AppError("session log not found", 404, "session_log_missing");
    }
    const log = this.sessionLog.read(file);
    if (log.missing) {
      throw new AppError("session log is not readable", 404, "session_log_missing");
    }
    return { name, sessionId: host.sessionId, ...log };
  }

  async workstationLive(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) {
      throw new AppError("invalid workstation session", 400, "invalid_workstation_session");
    }
    const file = this.sessionLog.fileFor(id);
    if (!file) {
      throw new AppError("workstation session not found", 404, "workstation_session_not_found");
    }
    const log = this.sessionLog.read(file);
    if (log.missing) {
      throw new AppError("session log is not readable", 404, "session_log_missing");
    }
    const entry = this.sessionLog.catalog().find((item) => item.id === id);
    const title = entry?.title || log.title || "";
    let inUse = false;
    try {
      inUse = await this.adapter.sessionInUse(file);
    } catch {
      // A missing `fuser` or a transient stat failure must not break the view.
    }
    return {
      name: `ws:${id}`,
      sessionId: id,
      readOnly: true,
      inUse,
      ended: sessionEnded(entry),
      ...log,
      title,
    };
  }

  async monitor(name) {
    const live = await this.live(name);
    const entry = this.get(name);
    const items = Array.isArray(live.items) ? live.items : [];
    const last = items.length > 0 ? items[items.length - 1] : null;
    return {
      name,
      title: live.title || entry.host?.title || "",
      sessionId: live.sessionId,
      busy: Boolean(entry.host?.busy),
      inputRequired: Boolean(entry.host?.inputRequired),
      relayConnected: entry.host?.relayConnected !== false,
      updatedAt: live.updatedAt,
      version: live.version,
      last: last
        ? {
            kind: last.kind,
            text: typeof last.text === "string" ? last.text : "",
            ts: last.ts || null,
            id: last.id || null,
            name: last.name || "",
          }
        : null,
    };
  }

  async status(name) {
    this.#assertName(name);
    const entry = this.sessions.get(name);
    if (!entry && !(await this.adapter.hasSession(name))) {
      throw new AppError(`unknown session: ${name}`, 404, "session_not_found");
    }
    const output = await this.adapter.capture(name, 80);
    const parsed = parseSessionStatus(output);
    const model = entry?.host?.model;
    return {
      name,
      model: parsed.model
        || (model
          ? [model.provider, model.id].filter(Boolean).join("/")
          : null),
      context: parsed.context,
    };
  }

  #assertName(name) {
    if (!new RegExp(`^${this.config.sessionPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9]+$`).test(name)) {
      throw new AppError("invalid session name", 400, "invalid_session_name");
    }
  }

  #removeOverlay(name) {
    try {
      fs.rmSync(path.join(this.overlayDir, `${name}.yml`), { force: true });
    } catch {
      // Best effort.
    }
  }
}
