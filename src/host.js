import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AppError, isWithinRoots, shellQuote } from "./util.js";

const execFileAsync = promisify(execFile);

function envFor(extra = {}) {
  return { ...process.env, ...extra };
}

function envPrefix(env) {
  const entries = Object.entries(env ?? {}).filter(([, value]) => value !== undefined && value !== "");
  if (entries.length === 0) return "";
  return `env ${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} `;
}

async function run(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout ?? 30_000,
      env: options.env ?? process.env,
      cwd: options.cwd,
      windowsHide: true,
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: typeof err.code === "number" ? err.code : null,
      error: err,
    };
  }
}

function parseTmuxSessions(stdout, prefix) {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, created, panePid, attached, cwd] = line.split("\t");
    if (!name || !name.startsWith(prefix)) continue;
    rows.push({
      name,
      createdAt: Number(created) > 0 ? Number(created) * 1000 : null,
      panePid: Number(panePid) || null,
      attached: attached === "1",
      cwd: cwd || "",
    });
  }
  return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

class BaseAdapter {
  constructor(config) {
    this.config = config;
    this.name = "base";
    this.pathModule = path;
  }

  validateCwd(cwd) {
    const resolved = this.pathModule.resolve(String(cwd ?? ""));
    if (!isWithinRoots(resolved, this.config.roots, this.pathModule)) {
      throw new AppError(
        `working directory is outside allowed roots: ${this.config.roots.join(", ")}`,
        403,
        "cwd_forbidden",
      );
    }
    return resolved;
  }

  async toRuntimePath(hostPath) {
    return hostPath;
  }

  async check() {
    return { ok: true };
  }

  async listSessions() {
    throw new Error("not implemented");
  }
}

class LinuxAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.name = "linux";
    this.pathModule = path;
  }

  async validateCwd(cwd) {
    const resolved = super.validateCwd(cwd);
    let stat;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      throw new AppError(`working directory does not exist: ${resolved}`, 400, "cwd_missing");
    }
    if (!stat.isDirectory()) {
      throw new AppError(`working directory is not a directory: ${resolved}`, 400, "cwd_not_dir");
    }
    return resolved;
  }

  async check() {
    const [tmux, omp] = await Promise.all([
      run(this.config.tmuxBin, ["-V"], { timeout: 5_000 }),
      run(this.config.ompBin, ["--version"], {
        timeout: 15_000,
        env: envFor(this.config.sessionEnv),
      }),
    ]);
    return {
      ok: tmux.code === 0 && omp.code === 0,
      tmux: tmux.code === 0 ? tmux.stdout.trim() : `unavailable: ${tmux.stderr.trim() || tmux.code}`,
      omp: omp.code === 0 ? omp.stdout.trim().split("\n")[0] : `unavailable: ${omp.stderr.trim() || omp.code}`,
    };
  }

  async runOmp(args, options = {}) {
    return run(this.config.ompBin, args, {
      timeout: options.timeout ?? this.config.linkTimeoutMs,
      env: envFor(this.config.sessionEnv),
    });
  }

  async listSessions() {
    const result = await run(
      this.config.tmuxBin,
      [
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_created}\t#{pane_pid}\t#{session_attached}\t#{pane_current_path}",
      ],
      { timeout: 10_000 },
    );
    if (result.code !== 0) {
      const text = `${result.stderr}${result.stdout}`;
      if (/no server running|error connecting to/i.test(text)) return [];
      throw new AppError(`tmux list-sessions failed: ${text.trim() || result.code}`, 500, "tmux_failed");
    }
    return parseTmuxSessions(result.stdout, this.config.sessionPrefix);
  }

  async hasSession(name) {
    const result = await run(this.config.tmuxBin, ["has-session", "-t", name], { timeout: 5_000 });
    return result.code === 0;
  }

  async startSession({ name, cwd, overlayPath }) {
    const command = `exec ${envPrefix(this.config.sessionEnv)}${shellQuote(this.config.ompBin)} --config ${shellQuote(overlayPath)} --cwd ${shellQuote(cwd)}`;
    const result = await run(
      this.config.tmuxBin,
      ["new-session", "-d", "-s", name, "-c", cwd, "bash", "-lc", command],
      { timeout: 10_000 },
    );
    if (result.code !== 0) {
      throw new AppError(
        `could not start tmux session: ${(result.stderr || result.stdout).trim() || result.code}`,
        500,
        "tmux_start_failed",
      );
    }
  }

  async killSession(name) {
    const result = await run(this.config.tmuxBin, ["kill-session", "-t", name], { timeout: 10_000 });
    if (result.code !== 0 && !/can't find session|no server running/i.test(result.stderr)) {
      throw new AppError(`could not stop session: ${result.stderr.trim() || result.code}`, 500, "tmux_kill_failed");
    }
  }

  async capture(name, lines = 80) {
    const count = Math.min(Math.max(Number(lines) || 80, 1), 1000);
    const result = await run(
      this.config.tmuxBin,
      ["capture-pane", "-p", "-t", name, "-S", `-${count}`],
      { timeout: 10_000 },
    );
    if (result.code !== 0) {
      throw new AppError(`could not read tmux output: ${result.stderr.trim() || result.code}`, 404, "tmux_capture_failed");
    }
    return result.stdout;
  }

  spawnTerminal({ session, cwd, cols, rows }) {
    const pty = this.pty;
    const options = {
      name: "xterm-256color",
      cols: Math.max(2, Number(cols) || 80),
      rows: Math.max(2, Number(rows) || 24),
      cwd: cwd || this.config.roots[0] || process.cwd(),
      env: envFor({ ...this.config.sessionEnv, TERM: "xterm-256color" }),
    };
    if (session) {
      return pty.spawn(this.config.tmuxBin, ["attach-session", "-t", session], options);
    }
    const shell = process.env.SHELL || "/bin/bash";
    return pty.spawn(shell, ["-l"], options);
  }
}

class WslAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.name = "wsl";
    this.pathModule = path.posix;
  }

  wslArgs(args) {
    const base = this.config.wslDistro ? ["-d", this.config.wslDistro] : [];
    return [...base, "--", ...args];
  }

  async runWsl(args, options = {}) {
    return run(this.config.wslBin, this.wslArgs(args), {
      timeout: options.timeout ?? 30_000,
      env: envFor(this.config.sessionEnv),
    });
  }

  async validateCwd(cwd) {
    const resolved = super.validateCwd(cwd);
    const result = await this.runWsl(["test", "-d", resolved], { timeout: 10_000 });
    if (result.code !== 0) {
      throw new AppError(`working directory does not exist in WSL: ${resolved}`, 400, "cwd_missing");
    }
    return resolved;
  }

  async toRuntimePath(hostPath) {
    const result = await this.runWsl(["wslpath", "-a", hostPath], { timeout: 10_000 });
    if (result.code !== 0) return hostPath;
    const converted = result.stdout.trim().split(/\r?\n/).pop();
    return converted || hostPath;
  }

  async check() {
    const [tmux, omp, distro] = await Promise.all([
      this.runWsl(["tmux", "-V"], { timeout: 10_000 }),
      this.runWsl([this.config.ompBin, "--version"], { timeout: 20_000 }),
      this.runWsl(["uname", "-a"], { timeout: 10_000 }),
    ]);
    return {
      ok: tmux.code === 0 && omp.code === 0,
      tmux: tmux.code === 0 ? tmux.stdout.trim() : `unavailable: ${tmux.stderr.trim() || tmux.code}`,
      omp: omp.code === 0 ? omp.stdout.trim().split("\n")[0] : `unavailable: ${omp.stderr.trim() || omp.code}`,
      wsl: distro.code === 0 ? "reachable" : `unavailable: ${distro.stderr.trim() || distro.code}`,
    };
  }

  async runOmp(args, options = {}) {
    const env = [];
    for (const [key, value] of Object.entries(this.config.sessionEnv)) {
      env.push(`${key}=${value}`);
    }
    const command = env.length > 0 ? ["env", ...env, this.config.ompBin, ...args] : [this.config.ompBin, ...args];
    return this.runWsl(command, { timeout: options.timeout ?? this.config.linkTimeoutMs });
  }

  async listSessions() {
    const result = await this.runWsl(
      [
        this.config.tmuxBin,
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_created}\t#{pane_pid}\t#{session_attached}\t#{pane_current_path}",
      ],
      { timeout: 15_000 },
    );
    if (result.code !== 0) {
      const text = `${result.stderr}${result.stdout}`;
      if (/no server running|error connecting to/i.test(text)) return [];
      throw new AppError(`tmux list-sessions failed in WSL: ${text.trim() || result.code}`, 500, "tmux_failed");
    }
    return parseTmuxSessions(result.stdout, this.config.sessionPrefix);
  }

  async startSession({ name, cwd, overlayPath }) {
    const runtimeOverlay = await this.toRuntimePath(overlayPath);
    const command = `exec ${envPrefix(this.config.sessionEnv)}${shellQuote(this.config.ompBin)} --config ${shellQuote(runtimeOverlay)} --cwd ${shellQuote(cwd)}`;
    const result = await this.runWsl(
      [this.config.tmuxBin, "new-session", "-d", "-s", name, "-c", cwd, "bash", "-lc", command],
      { timeout: 15_000 },
    );
    if (result.code !== 0) {
      throw new AppError(
        `could not start tmux in WSL: ${(result.stderr || result.stdout).trim() || result.code}`,
        500,
        "tmux_start_failed",
      );
    }
  }

  async killSession(name) {
    const result = await this.runWsl(
      [this.config.tmuxBin, "kill-session", "-t", name],
      { timeout: 15_000 },
    );
    if (result.code !== 0 && !/can't find session|no server running/i.test(result.stderr)) {
      throw new AppError(`could not stop WSL session: ${result.stderr.trim() || result.code}`, 500, "tmux_kill_failed");
    }
  }

  async capture(name, lines = 80) {
    const count = Math.min(Math.max(Number(lines) || 80, 1), 1000);
    const result = await this.runWsl(
      [this.config.tmuxBin, "capture-pane", "-p", "-t", name, "-S", `-${count}`],
      { timeout: 15_000 },
    );
    if (result.code !== 0) {
      throw new AppError(`could not read WSL tmux output: ${result.stderr.trim() || result.code}`, 404, "tmux_capture_failed");
    }
    return result.stdout;
  }

  spawnTerminal({ session, cwd, cols, rows }) {
    const pty = this.pty;
    const options = {
      name: "xterm-256color",
      cols: Math.max(2, Number(cols) || 80),
      rows: Math.max(2, Number(rows) || 24),
      env: envFor({ ...this.config.sessionEnv, TERM: "xterm-256color" }),
    };
    if (session) {
      return pty.spawn(
        this.config.wslBin,
        this.wslArgs([this.config.tmuxBin, "attach-session", "-t", session]),
        options,
      );
    }
    const args = this.config.wslDistro ? ["-d", this.config.wslDistro] : [];
    if (cwd) args.push("--cd", cwd);
    args.push("--", "bash", "-l");
    return pty.spawn(this.config.wslBin, args, options);
  }
}

export async function createAdapter(config) {
  const adapter = config.adapterKind === "wsl" ? new WslAdapter(config) : new LinuxAdapter(config);
  // node-pty is loaded lazily so the bridge can still serve the control panel
  // when the native terminal module is unavailable.
  if (config.terminalEnabled) {
    try {
      const mod = await import("node-pty");
      adapter.pty = mod.spawn ? mod : mod.default;
    } catch {
      adapter.terminalUnavailable = "node-pty is not available";
    }
  }
  return adapter;
}

export { LinuxAdapter, WslAdapter, parseTmuxSessions, run };
