import { randomToken } from "./util.js";

const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 200;

export class TerminalTickets {
  constructor() {
    this.tickets = new Map();
  }

  issue({ session = null, cwd = null, cols = 80, rows = 24 }) {
    const ticket = randomToken(24);
    this.tickets.set(ticket, {
      session,
      cwd,
      cols: Math.max(2, Number(cols) || 80),
      rows: Math.max(2, Number(rows) || 24),
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    if (this.tickets.size > MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value;
      if (oldest) this.tickets.delete(oldest);
    }
    return ticket;
  }

  redeem(ticket) {
    const entry = this.tickets.get(String(ticket ?? ""));
    if (!entry) return null;
    this.tickets.delete(String(ticket));
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }
}

export function attachTerminal({ ws, ticket, adapter, config }) {
  if (!config.terminalEnabled || !adapter.pty) {
    ws.send(JSON.stringify({ type: "error", message: adapter.terminalUnavailable || "terminal is disabled" }));
    ws.close(1011, "terminal unavailable");
    return;
  }

  let pty;
  try {
    pty = adapter.spawnTerminal({
      session: ticket.session,
      cwd: ticket.cwd,
      cols: ticket.cols,
      rows: ticket.rows,
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: `could not start terminal: ${String(err?.message ?? err)}` }));
    ws.close(1011, "pty failed");
    return;
  }

  let closed = false;
  let heartbeat;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      pty.kill();
    } catch {
      // Already exited.
    }
  };

  const send = (value) => {
    if (ws.readyState === 1) ws.send(value);
  };
  const sendOutput = (data) => {
    if (ws.readyState === 1) ws.send(Buffer.from(data, "utf8"), { binary: true });
  };

  pty.onData(sendOutput);
  pty.onExit(({ exitCode, signal }) => {
    send(JSON.stringify({ type: "exit", exitCode, signal }));
    cleanup();
    try {
      ws.close(1000, "terminal exited");
    } catch {
      // Already closed.
    }
  });

  ws.send(JSON.stringify({ type: "ready", pid: pty.pid }));
  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "input" && typeof message.data === "string") {
      pty.write(message.data);
    } else if (message.type === "resize") {
      const cols = Math.max(2, Math.min(1000, Number(message.cols) || 80));
      const rows = Math.max(2, Math.min(1000, Number(message.rows) || 24));
      try {
        pty.resize(cols, rows);
      } catch {
        // The pty may have exited between the message and resize.
      }
    } else if (message.type === "ping") {
      send(JSON.stringify({ type: "pong" }));
    }
  });
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  heartbeat = setInterval(() => {
    if (ws.readyState !== 1) {
      cleanup();
      return;
    }
    try {
      ws.ping();
    } catch {
      cleanup();
    }
  }, 30_000);
  heartbeat.unref?.();
}
