import fs from "node:fs";
import path from "node:path";
import { AppError, randomId } from "./util.js";
import { linkForHost, listHosts, pickHost, waitForHost } from "./collab.js";

function publicHost(host) {
  if (!host) return null;
  return {
    instanceId: host.instanceId,
    generation: host.generation,
    sessionId: host.sessionId,
    sessionName: host.sessionName,
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

export class SessionManager {
  constructor(config, adapter) {
    this.config = config;
    this.adapter = adapter;
    this.overlayDir = path.join(config.stateDir, "overlays");
    fs.mkdirSync(this.overlayDir, { recursive: true, mode: 0o700 });
    this.sessions = new Map();
    this.hosts = [];
    this.hostsAt = 0;
    this.refreshing = null;
  }

  async getHosts({ force = false } = {}) {
    const ttl = force ? 0 : 1_000;
    if (!force && Date.now() - this.hostsAt < ttl) return this.hosts;
    this.hosts = await listHosts(this.adapter);
    this.hostsAt = Date.now();
    return this.hosts;
  }

  snapshot() {
    return [...this.sessions.values()]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map((entry) => ({
        name: entry.name,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        host: publicHost(entry.host),
      }));
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
      this.sessions.set(row.name, entry);

      let host = null;
      if (entry.host) {
        host =
          hosts.find(
            (candidate) =>
              candidate.instanceId === entry.host.instanceId &&
              candidate.generation === entry.host.generation,
          ) ?? null;
      }
      if (!host) {
        host = pickHost(hosts, {
          cwd: entry.cwd,
          since: entry.createdAt,
          exclude: used,
        });
      }
      if (host) {
        entry.host = host;
        used.add(host.instanceId);
      } else {
        entry.host = null;
      }
    }
    return this.snapshot();
  }

  async start({ cwd } = {}) {
    const target = await this.adapter.validateCwd(cwd || this.config.roots[0]);
    let name = `${this.config.sessionPrefix}${randomId(4)}`;
    for (let i = 0; i < 5 && (await this.adapter.hasSession(name)); i++) {
      name = `${this.config.sessionPrefix}${randomId(4)}`;
    }

    const overlayPath = path.join(this.overlayDir, `${name}.yml`);
    fs.writeFileSync(overlayPath, buildOverlay(this.config), { mode: 0o600 });
    const createdAt = Date.now();
    let started = false;
    try {
      await this.adapter.startSession({ name, cwd: target, overlayPath });
      started = true;
      const exclude = new Set(
        [...this.sessions.values()].map((entry) => entry.host?.instanceId).filter(Boolean),
      );
      const host = await waitForHost(this.adapter, {
        cwd: target,
        since: createdAt,
        exclude,
        timeoutMs: this.config.startTimeoutMs,
      });
      const entry = { name, cwd: target, createdAt, host };
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
    this.#assertName(name);
    const entry = this.sessions.get(name);
    if (!entry) throw new AppError(`unknown session: ${name}`, 404, "session_not_found");

    const resolveHost = async (force) => {
      const hosts = await this.getHosts({ force });
      if (entry.host) {
        const exact = hosts.find(
          (candidate) =>
            candidate.instanceId === entry.host.instanceId &&
            candidate.generation === entry.host.generation,
        );
        if (exact) return exact;
      }
      const used = new Set(
        [...this.sessions.values()]
          .filter((other) => other.name !== name)
          .map((other) => other.host?.instanceId)
          .filter(Boolean),
      );
      const host = pickHost(hosts, { cwd: entry.cwd, since: entry.createdAt, exclude: used });
      if (host) entry.host = host;
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

  async output(name, lines) {
    this.#assertName(name);
    return this.adapter.capture(name, lines);
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
