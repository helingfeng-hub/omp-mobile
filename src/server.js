import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createAuth } from "./auth.js";
import { createAdapter } from "./host.js";
import { SessionManager, pickActiveSession } from "./sessions.js";
import { attachTerminal, TerminalTickets } from "./terminal.js";
import { AppError, mimeType, readJsonBody } from "./util.js";

function securityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "frame-src https: http://localhost:* http://127.0.0.1:*",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

function sendJson(res, status, value) {
  securityHeaders(res);
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  securityHeaders(res);
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function serveStatic(res, publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, "bad path");
  }
  if (decoded.includes("\0")) return sendText(res, 400, "bad path");
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relative === "update.json" || relative.endsWith(".apk")) {
    console.log(
      `STATIC ${res.req?.method || "GET"} /${relative} ua=${res.req?.headers["user-agent"] || "-"}`,
    );
  }
  const file = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    return sendText(res, 403, "forbidden");
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendText(res, 404, "not found");
  }
  if (!stat.isFile()) return sendText(res, 404, "not found");
  const body = fs.readFileSync(file);
  const noStore = relative === "update.json" || relative.endsWith(".apk");
  securityHeaders(res);
  res.writeHead(200, {
    "content-type": mimeType(file),
    "content-length": body.length,
    "cache-control": noStore ? "no-store, no-cache, must-revalidate, max-age=0" : "no-cache",
    ...(noStore ? { pragma: "no-cache", expires: "0" } : {}),
  });
  res.end(res.req?.method === "HEAD" ? undefined : body);
}

export async function createServer(config, deps = {}) {
  const auth = createAuth(config.token);
  const adapter = deps.adapter ?? (await createAdapter(config));
  const manager = deps.manager ?? new SessionManager(config, adapter);
  const tickets = new TerminalTickets();
  const seenClients = new Set();
  let healthCache = { at: 0, value: null };

  async function getHealth(force = false) {
    if (!force && healthCache.value && Date.now() - healthCache.at < 30_000) return healthCache.value;
    try {
      const value = await adapter.check();
      healthCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      const value = { ok: false, error: String(err?.message ?? err) };
      healthCache = { at: Date.now(), value };
      return value;
    }
  }

  function requireAuth(req, res) {
    if (auth.authorize(req)) return true;
    res.setHeader("www-authenticate", 'Bearer realm="omp-remote"');
    sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
    return false;
  }

  function routeError(res, err) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // Ignore.
      }
      return;
    }
    if (err instanceof AppError) {
      sendJson(res, err.status, { error: err.message, code: err.code });
      return;
    }
    console.error(err);
    sendJson(res, 500, { error: "internal error", code: "internal_error" });
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      const userAgent = req.headers["user-agent"] || "";
      if (pathname === "/api/state" && userAgent.includes("omp-mobile/")
          && !seenClients.has(userAgent)) {
        seenClients.add(userAgent);
        console.log(`CLIENT ${userAgent}`);
      }
      if (req.method === "GET" && pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }
      if (pathname.startsWith("/api/")) {
        if (!requireAuth(req, res)) return;
      }

      if (req.method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          version: config.version,
          platform: config.platform,
          adapter: adapter.name,
          check: await getHealth(),
        });
      }

      if (req.method === "GET" && pathname === "/api/state") {
        const force = url.searchParams.get("refresh") === "1";
        const sessions = await manager.refresh({ force });
        return sendJson(res, 200, {
          ok: true,
          version: config.version,
          platform: config.platform,
          adapter: adapter.name,
          name: config.displayName,
          host: config.host,
          roots: config.roots,
          terminal: config.terminalEnabled && Boolean(adapter.pty),
          terminalUnavailable: adapter.terminalUnavailable ?? null,
          sessions,
          workstationSessions: manager.workstationSessions
            ? await manager.workstationSessions()
            : [],
          activeSession: pickActiveSession(sessions),
          health: await getHealth(),
        });
      }

      if (req.method === "GET" && pathname === "/api/live") {
        let name = url.searchParams.get("session");
        if (!name) {
          const sessions = await manager.refresh({ force: false });
          name = pickActiveSession(sessions);
        }
        if (!name) throw new AppError("no active session", 404, "no_active_session");
        return sendJson(res, 200, { ok: true, ...(await manager.live(name)) });
      }

      if (req.method === "GET" && pathname === "/api/monitor") {
        let name = url.searchParams.get("session");
        if (!name) {
          const sessions = await manager.refresh({ force: false });
          name = pickActiveSession(sessions);
        }
        if (!name) throw new AppError("no active session", 404, "no_active_session");
        return sendJson(res, 200, { ok: true, ...(await manager.monitor(name)) });
      }

      if (req.method === "POST" && pathname === "/api/sessions") {
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body.resume) {
          const session = await manager.resumeWorkstation(String(body.resume));
          return sendJson(res, 201, { ok: true, resumed: true, session });
        }
        const session = await manager.start({ cwd: body.cwd });
        return sendJson(res, 201, { ok: true, session });
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(link|output|stop|status|prompt))?$/.exec(pathname);
      if (sessionMatch) {
        const name = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2] ?? null;

        if (req.method === "DELETE" && !action) {
          return sendJson(res, 200, await manager.stop(name));
        }
        if (req.method === "POST" && action === "stop") {
          return sendJson(res, 200, await manager.stop(name));
        }
        if (req.method === "POST" && action === "prompt") {
          const body = await readJsonBody(req, config.maxBodyBytes);
          return sendJson(res, 200, { ok: true, ...(await manager.prompt(name, body.text)) });
        }
        if (req.method === "GET" && action === "link") {
          const access = url.searchParams.get("access") === "view" ? "view" : "control";
          return sendJson(res, 200, { ok: true, ...(await manager.link(name, access)) });
        }
        if (req.method === "GET" && action === "output") {
          const lines = Number(url.searchParams.get("lines") || 80);
          return sendJson(res, 200, { ok: true, output: await manager.output(name, lines) });
        }
        if (req.method === "GET" && action === "status") {
          return sendJson(res, 200, { ok: true, ...(await manager.status(name)) });
        }
      }

      if (req.method === "POST" && pathname === "/api/terminal/ticket") {
        if (!config.terminalEnabled || !adapter.pty) {
          throw new AppError(
            adapter.terminalUnavailable || "terminal is disabled",
            403,
            "terminal_disabled",
          );
        }
        const body = await readJsonBody(req, config.maxBodyBytes);
        let session = null;
        let cwd = null;
        if (body.session) {
          manager.get(String(body.session));
          session = String(body.session);
        } else {
          cwd = await adapter.validateCwd(body.cwd || config.roots[0]);
        }
        const ticket = tickets.issue({
          session,
          cwd,
          cols: body.cols,
          rows: body.rows,
        });
        return sendJson(res, 201, { ok: true, ticket, expiresInMs: 30_000 });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(res, config.publicDir, pathname);
      }
      return sendJson(res, 404, { error: "not found", code: "not_found" });
    } catch (err) {
      routeError(res, err);
    } finally {
      if (pathnameForLog(req.url)?.startsWith("/api/")) {
        console.log(`${req.method} ${pathnameForLog(req.url)} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws, _req, ticket) => {
    attachTerminal({ ws, ticket, adapter, config });
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws/terminal") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      const ticket = tickets.redeem(url.searchParams.get("ticket"));
      if (!ticket) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, ticket);
      });
    } catch {
      socket.destroy();
    }
  });

  async function start() {
    await manager.refresh().catch((err) => {
      console.error(`initial session refresh failed: ${err.message}`);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return server.address();
  }

  async function stop() {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // Ignore.
      }
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    server,
    adapter,
    manager,
    start,
    stop,
    getHealth,
    address: () => server.address(),
  };
}

function pathnameForLog(rawUrl) {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}
