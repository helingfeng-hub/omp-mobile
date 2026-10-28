import { AppError, parseJson } from "./util.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isLocalUrl(url) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
}

export function validateCollabUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new AppError("collab returned an invalid link", 502, "invalid_collab_link");
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLocalUrl(url)) return url.toString();
  throw new AppError("collab returned a non-HTTPS link", 502, "insecure_collab_link");
}

export function parseHosts(stdout) {
  const data = parseJson(String(stdout).trim());
  if (!data || data.version !== 1 || !Array.isArray(data.hosts)) {
    throw new AppError("omp collab list returned an unexpected payload", 502, "collab_bad_payload");
  }
  return data.hosts.filter((host) => host && typeof host.instanceId === "string" && typeof host.cwd === "string");
}

export function pickHost(hosts, { cwd, since = 0, exclude = new Set() } = {}) {
  const candidates = hosts
    .filter((host) => !exclude.has(host.instanceId))
    .filter((host) => {
      if (cwd === undefined || cwd === null) return true;
      return host.cwd === cwd;
    })
    .filter((host) => {
      if (!since) return true;
      const started = Number(host.startedAt) || 0;
      // The overlay starts hosting during omp startup; allow a small clock skew
      // between the bridge's Date.now() and the host's startedAt.
      return started >= since - 5_000;
    })
    .sort((a, b) => {
      const started = (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0);
      if (started !== 0) return started;
      return (Number(b.generation) || 0) - (Number(a.generation) || 0);
    });
  return candidates[0] ?? null;
}

export async function listHosts(adapter) {
  const result = await adapter.runOmp(["collab", "list", "--json"], { timeout: adapter.config.linkTimeoutMs });
  if (result.code !== 0) {
    throw new AppError(
      `omp collab list failed: ${(result.stderr || result.stdout).trim() || result.code}`,
      502,
      "collab_list_failed",
    );
  }
  return parseHosts(result.stdout);
}

export async function linkForHost(adapter, instanceId, access = "control") {
  const args = ["collab", "link", instanceId, "--json"];
  if (access === "view") args.splice(3, 0, "--view");
  const result = await adapter.runOmp(args, { timeout: adapter.config.linkTimeoutMs });
  if (result.code !== 0) {
    const text = `${result.stderr}${result.stdout}`;
    const code = /stale_generation/.test(text)
      ? "stale_generation"
      : /access_unavailable/.test(text)
        ? "access_unavailable"
        : "collab_link_failed";
    throw new AppError(`omp collab link failed: ${text.trim() || result.code}`, code === "stale_generation" ? 409 : 502, code);
  }
  const data = parseJson(result.stdout.trim());
  if (!data || typeof data.url !== "string" || data.instanceId !== instanceId) {
    throw new AppError("omp collab link returned an unexpected payload", 502, "collab_bad_payload");
  }
  return {
    url: validateCollabUrl(data.url),
    access: data.access === "view" ? "view" : "control",
    instanceId: data.instanceId,
    generation: Number(data.generation) || 0,
  };
}

export async function waitForHost(adapter, { cwd, since, exclude, timeoutMs } = {}) {
  const deadline = Date.now() + (timeoutMs ?? adapter.config.startTimeoutMs);
  let lastHosts = [];
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastHosts = await listHosts(adapter);
      const host = pickHost(lastHosts, { cwd, since, exclude });
      if (host) return host;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  const available = lastHosts.map((host) => `${host.cwd} (${host.instanceId}, ${host.access})`).slice(0, 8);
  throw new AppError(
    lastError
      ? `omp did not publish a collab host: ${lastError.message}`
      : `omp started but no collab host appeared within ${Math.round((timeoutMs ?? adapter.config.startTimeoutMs) / 1000)}s${available.length ? `; visible hosts: ${available.join("; ")}` : ""}`,
    504,
    "collab_timeout",
  );
}
