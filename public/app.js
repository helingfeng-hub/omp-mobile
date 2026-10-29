const TOKEN_KEY = "omp-mobile.token";
const META_KEY = "omp-mobile.session-meta";
const APP_VERSION = new URLSearchParams(location.search).get("app") || "";
const BOOT_MIN_MS = 1400;
const bootShownAt = Date.now();
const $ = (selector) => document.querySelector(selector);

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  data: null,
  loading: false,
  poll: null,
  chatSession: null,
  chatUrl: null,
  chatReconnectTimer: null,
  chatStatus: null,
  chatStatusLoaded: false,
  chatStatusTimer: null,
  autoStarting: false,
  autoStartAttempted: false,
  autoStartError: "",
  creatingSession: false,
  resumingSession: null,
  activeSession: null,
  chatGeneration: null,
  chatLinkRefreshing: false,
  collabOpen: false,
  sendingPrompt: false,
  live: null,
  liveVersion: "",
  liveIdleTicks: 0,
  livePinned: true,
  liveTimer: null,
};

class AuthError extends Error {}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = String(message);
  element.classList.toggle("error", isError);
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 4500);
}

function setOnline(value) {
  const dot = $("#connection-dot");
  dot.classList.toggle("online", value === true);
  dot.classList.toggle("offline", value === false);
}

function setHostStatus(text) {
  $("#host-sub").textContent = text;
}

function setAuthVisible(visible) {
  $("#auth-view").classList.toggle("hidden", !visible);
  $("#main-view").classList.toggle("hidden", visible);
  if (visible) {
    setOnline(false);
    $("#host-name").textContent = "未连接";
    setHostStatus("输入访问令牌");
  }
}

async function api(path, options = {}) {
  const { timeout: timeoutMs = 12_000, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (fetchOptions.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, {
      ...fetchOptions,
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    throw new Error("连接超时，请重试");
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    state.token = "";
    state.data = null;
    setAuthVisible(true);
    const authError = $("#auth-error");
    authError.textContent = "访问令牌无效或已过期";
    authError.classList.remove("hidden");
    throw new AuthError("访问令牌无效或已过期");
  }
  if (!response.ok) {
    const error = new Error(body?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  return body;
}

function showConnecting() {
  $("#host-name").textContent = "连接中…";
  setHostStatus("正在连接");
  setOnline(null);
  $("#sessions").innerHTML = "";
  const empty = $("#empty-state");
  empty.classList.remove("hidden");
  empty.querySelector(".spinner").classList.remove("hidden");
  $("#empty-message").textContent = "正在连接…";
  $("#empty-detail").classList.add("hidden");
  $("#retry-button").classList.add("hidden");
}

function showConnectionError() {
  setOnline(false);
  $("#host-name").textContent = "未连接";
  setHostStatus("连接失败");
  const empty = $("#empty-state");
  empty.classList.remove("hidden");
  empty.querySelector(".spinner").classList.add("hidden");
  $("#empty-message").textContent = "无法连接电脑";
  $("#empty-detail").textContent = "请检查 Tailscale 和电脑端服务。";
  $("#empty-detail").classList.remove("hidden");
  $("#retry-button").classList.remove("hidden");
}

async function loadState({ quiet = false, force = false } = {}) {
  if (!state.token) {
    setAuthVisible(true);
    return;
  }
  if (state.loading) return;
  state.loading = true;
  try {
    const data = await api(`/api/state${force ? "?refresh=1" : ""}`);
    state.data = data;
    state.activeSession = data.activeSession || null;
    setAuthVisible(false);
    setOnline(true);
    render();
    refreshChatLinkIfStale();
  } catch (error) {
    if (error instanceof AuthError) return;
    if (state.data) {
      setOnline(false);
      setHostStatus("连接中断");
    } else {
      showConnectionError();
    }
    if (!quiet) toast(error.message, true);
  } finally {
    state.loading = false;
  }
}

function updateNewSessionButton() {
  const button = $("#new-session-button");
  if (!button) return;
  button.disabled = state.creatingSession || state.autoStarting || Boolean(state.resumingSession);
  button.textContent = state.creatingSession ? "新建中…" : "＋ 新会话";
}

async function resumeWorkstationSession(session, { quietInUse = false } = {}) {
  if (state.resumingSession || state.creatingSession) return "busy";
  state.resumingSession = session.id;
  render();
  toast("正在电脑上继续这个会话…");
  try {
    const body = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ resume: session.id }),
      timeout: 45_000,
    });
    await loadState({ quiet: true, force: true });
    if (body?.session?.name) {
      closeChat();
      await openChat(body.session.name);
    } else {
      toast("会话已启动");
    }
    return "ok";
  } catch (error) {
    if (error.code === "session_in_use" || error.code === "session_already_running") {
      if (!quietInUse) toast("电脑上的会话还在运行，已先打开只读视图");
      return "in_use";
    }
    if (!(error instanceof AuthError)) toast(error.message, true);
    return "error";
  } finally {
    state.resumingSession = null;
    render();
  }
}

async function createSession() {
  if (state.creatingSession || state.autoStarting || state.resumingSession) return;
  const cwd = (state.data?.sessions || [])[0]?.cwd || state.data?.roots?.[0];
  if (!cwd) {
    toast("没有可用的工作目录", true);
    return;
  }
  state.creatingSession = true;
  updateNewSessionButton();
  try {
    const body = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd }),
      timeout: 45_000,
    });
    await loadState({ quiet: true, force: true });
    if (body?.session?.name) {
      await openChat(body.session.name);
    } else {
      toast("已新建会话");
    }
  } catch (error) {
    if (!(error instanceof AuthError)) toast(error.message, true);
  } finally {
    state.creatingSession = false;
    updateNewSessionButton();
  }
}

async function deleteSession(name) {
  const session = findSession(name);
  if (!session) return;
  const label = displayTitle(session);
  if (!window.confirm(`删除会话“${label}”？\n\n这会停止电脑上的 tmux 会话，正在进行的输出会中断。`)) {
    return;
  }
  try {
    await api(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (state.chatSession === name) closeChat();
    toast("已删除会话");
    await loadState({ quiet: true, force: true });
    if ($("#chat-drawer").classList.contains("open")) renderDrawer();
  } catch (error) {
    if (!(error instanceof AuthError)) toast(error.message, true);
  }
}

async function ensureSession() {
  if (state.autoStarting || !state.token) return;
  const cwd = state.data?.roots?.[0];
  state.autoStarting = true;
  state.autoStartError = "";
  render();
  if (!cwd) {
    state.autoStarting = false;
    state.autoStartError = "没有可用的工作目录";
    render();
    return;
  }
  try {
    await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
    await loadState({ quiet: true, force: true });
    if (!(state.data?.sessions || []).length) {
      state.autoStartError = "启动后没有发现会话";
    }
  } catch (error) {
    if (!(error instanceof AuthError)) {
      state.autoStartError = error.message || "启动失败";
    }
  } finally {
    state.autoStarting = false;
    render();
  }
}

function readMeta() {
  try {
    const raw = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeMeta(meta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    // Private mode or storage pressure: titles still work for this page load.
  }
}

function sessionMeta(name) {
  const entry = readMeta()[name];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
}

function setSessionMeta(name, patch) {
  const meta = readMeta();
  const current = meta[name] && typeof meta[name] === "object" ? meta[name] : {};
  meta[name] = { ...current, ...patch };
  writeMeta(meta);
}

function formatRelative(timestamp) {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function lastOpenedText(name) {
  const timestamp = Number(sessionMeta(name).lastOpenedAt) || 0;
  return timestamp ? `最近打开：${formatRelative(timestamp)}` : "尚未打开";
}

function touchSession(name) {
  setSessionMeta(name, { lastOpenedAt: Date.now() });
}

function setNativeSession(name) {
  try {
    if (window.OmpNative && typeof window.OmpNative.setSession === "function") {
      window.OmpNative.setSession(name || "");
    }
  } catch {
    // Browser/PWA: no native bridge.
  }
}

function updateChatTitle() {
  const label = $("#chat-current-title");
  if (!label) return;
  const session = state.chatSession ? findAnySession(state.chatSession) : null;
  const title = session ? displayTitle(session) : "";
  label.textContent = title;
  label.title = title;
}

function modelLabel(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.id || model.provider || "";
}

function contextLabel() {
  const context = state.chatStatus?.context;
  if (context) {
    const percent = context.percentText ?? context.percent;
    return `上下文 ${percent}%${context.window ? ` / ${context.window}` : ""}`;
  }
  return state.chatStatusLoaded ? "上下文 —" : "上下文读取中…";
}

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (number >= 1_000) return `${Math.round(number / 1_000)}k`;
  return String(number);
}

function parseWindow(value) {
  const match = String(value || "").match(/^([\d.]+)\s*([KMG])?$/i);
  if (!match) return 0;
  const number = Number(match[1]) || 0;
  const unit = (match[2] || "").toUpperCase();
  return number * (unit === "G" ? 1e9 : unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1);
}

function liveContextLabel(context) {
  const tokens = Number(context.promptTokens) || 0;
  if (!tokens) return "";
  const windowText = state.chatStatus?.context?.window || "";
  const windowTokens = parseWindow(windowText);
  const percent = windowTokens ? Math.round((tokens / windowTokens) * 100) : null;
  const head = windowText ? `${formatTokens(tokens)} / ${windowText}` : formatTokens(tokens);
  return percent === null ? `上下文 ${head}` : `上下文 ${head} · ${percent}%`;
}

function updateChatMeta() {
  const label = $("#chat-current-meta");
  if (!label) return;
  const session = state.chatSession ? findAnySession(state.chatSession) : null;
  if (!session) {
    label.textContent = "";
    label.title = "";
    return;
  }
  const model = state.chatStatus?.model
    || modelLabel(session.host?.model)
    || state.live?.model
    || "";
  let context = "";
  if (state.live?.context?.promptTokens) {
    context = liveContextLabel(state.live.context);
  } else if (!session.readOnly) {
    context = contextLabel();
  }
  const text = [session.readOnly ? "只读" : "", model, context].filter(Boolean).join(" · ");
  label.textContent = text;
  label.title = text;
}

function stopChatStatus() {
  if (state.chatStatusTimer) clearInterval(state.chatStatusTimer);
  state.chatStatusTimer = null;
  state.chatStatus = null;
  state.chatStatusLoaded = false;
  updateChatMeta();
}

function startChatStatus(name) {
  stopChatStatus();
  updateChatMeta();
  if (String(name || "").startsWith("ws:")) return;
  let busy = false;
  const poll = async () => {
    if (busy || state.chatSession !== name) return;
    busy = true;
    try {
      const status = await api(`/api/sessions/${encodeURIComponent(name)}/status`);
      if (state.chatSession !== name) return;
      state.chatStatus = status;
      state.chatStatusLoaded = true;
      updateChatMeta();
    } catch {
      if (state.chatSession !== name) return;
      state.chatStatusLoaded = true;
      updateChatMeta();
    } finally {
      busy = false;
    }
  };
  void poll();
  state.chatStatusTimer = setInterval(poll, 3000);
}

function startLivePoll(name) {
  stopLivePoll();
  let busy = false;
  const poll = async () => {
    if (busy || state.chatSession !== name) return;
    busy = true;
    try {
      const data = await api(`/api/live?session=${encodeURIComponent(name)}`);
      if (state.chatSession !== name) return;
      state.live = data;
      if (data.version !== state.liveVersion) {
        state.liveVersion = data.version;
        renderLive(data);
      }
      updateChatMeta();
      const ws = String(name).startsWith("ws:") ? findWorkstation(name) : null;
      if (ws && !ws.running && data.inUse === false && data.ended === true && !state.resumingSession) {
        state.liveIdleTicks += 1;
        if (state.liveIdleTicks >= 2) {
          state.liveIdleTicks = 0;
          void resumeWorkstationSession(ws, { quietInUse: true });
        }
      } else {
        state.liveIdleTicks = 0;
      }
    } catch {
      // Keep the last rendered view; auth failures are handled by api().
    } finally {
      busy = false;
    }
  };
  void poll();
  state.liveTimer = setInterval(poll, 1000);
}

function stopLivePoll() {
  clearInterval(state.liveTimer);
  state.liveTimer = null;
}

function liveTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function renderLive(data) {
  const view = $("#chat-live");
  const list = $("#chat-live-list");
  if (!view || !list) return;
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) {
    list.innerHTML = '<div class="live-empty">等待会话输出…</div>';
  } else {
    list.innerHTML = items
      .map((item) => {
        if (item.kind === "tool") {
          const time = item.ts ? ` · ${liveTime(item.ts)}` : "";
          const label = [item.name, item.intent].filter(Boolean).join(" · ");
          const args = item.args ? `\n${item.args}` : "";
          return `<div class="live-msg assistant"><div class="live-role">tool${time}</div><div class="live-tool">${escapeHtml(label + args)}</div></div>`;
        }
        if (item.kind === "user") {
          const time = item.ts ? ` · ${liveTime(item.ts)}` : "";
          return `<div class="live-msg user"><div class="live-role">你${time}</div><div class="live-text">${escapeHtml(item.text)}</div></div>`;
        }
        const time = item.ts ? ` · ${liveTime(item.ts)}` : "";
        const thinking = item.thinking
          ? `<details class="live-thinking"><summary>thinking</summary><pre>${escapeHtml(item.thinking)}</pre></details>`
          : "";
        const text = item.text ? `<div class="live-text">${escapeHtml(item.text)}</div>` : "";
        const tools = (item.tools || [])
          .map((tool) => {
            const label = [tool.name, tool.intent].filter(Boolean).join(" · ");
            const args = tool.args ? `\n${tool.args}` : "";
            return `<div class="live-tool">${escapeHtml(label + args)}</div>`;
          })
          .join("");
        return `<div class="live-msg assistant"><div class="live-role">agent${time}</div>${thinking}${text}${tools}</div>`;
      })
      .join("");
  }
  if (state.livePinned) view.scrollTop = view.scrollHeight;
}

function displayTitle(session) {
  if (!session) return "omp 会话";
  if (session.readOnly) {
    const own = String(session.title || "").trim();
    if (own) return own;
  }
  const hostTitle = String(session.host?.title || session.host?.sessionName || "").trim();
  if (hostTitle && !/^omp-[A-Za-z0-9]+$/.test(hostTitle)) return hostTitle;
  const parts = String(session.cwd || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? `${parts[parts.length - 1]} 会话` : "omp 会话";
}

function statusFor(session) {
  const host = session.host;
  if (!host) return { label: "未就绪", tone: "muted", ready: false };
  if (host.relayConnected === false) return { label: "未连接", tone: "bad", ready: false };
  if (host.inputRequired) return { label: "等待输入", tone: "warn", ready: true };
  if (host.busy) return { label: "运行中", tone: "ok", ready: true };
  return { label: "空闲", tone: "ok", ready: true };
}

function findSession(name) {
  return (state.data?.sessions || []).find((session) => session.name === name) || null;
}

function findWorkstation(name) {
  return (state.data?.workstationSessions || []).find((session) => session.name === name) || null;
}

function findAnySession(name) {
  if (!name) return null;
  return findSession(name) || findWorkstation(name);
}

function renderSession(session) {
  const active = state.chatSession === session.name ? " active" : "";
  const { label, tone, ready } = statusFor(session);
  const readOnly = Boolean(session.readOnly);
  const stateLabel = readOnly ? "查看" : label;
  const stateTone = readOnly ? "muted" : tone;
  const canOpen = ready || readOnly;
  return `
    <div class="session-card${active}${canOpen ? "" : " disabled"}">
      <button type="button" class="session-open" data-open="${escapeHtml(session.name)}"${canOpen ? "" : " disabled"}>
        <span class="session-main">
          <span class="session-title">${escapeHtml(displayTitle(session))}</span>
          <span class="session-cwd">${escapeHtml(session.cwd)}</span>
          <span class="session-last">${escapeHtml(lastOpenedText(session.name))}</span>
        </span>
        <span class="session-state ${stateTone}">
          <span class="dot ${stateTone}"></span>${stateLabel}
        </span>
        <span class="session-chevron" aria-hidden="true">›</span>
      </button>
      <button type="button" class="session-delete" data-delete="${escapeHtml(session.name)}" title="删除会话" aria-label="删除会话">✕</button>
    </div>`;
}

function renderWorkstationSession(session) {
  const active = state.chatSession === session.name ? " active" : "";
  const updated = session.updatedAt ? formatRelative(session.updatedAt) : "";
  const fork = session.fork ? '<span class="session-fork">fork</span>' : "";
  const resuming = state.resumingSession === session.id;
  const running = Boolean(session.running);
  const tone = resuming ? "warn" : running ? "muted" : "ok";
  const hint = resuming
    ? "正在电脑上启动…"
    : `${updated ? `更新：${escapeHtml(updated)} · ` : ""}${running ? "电脑上运行中 · 点击查看" : "点击打开"}`;
  const stateLabel = resuming ? "启动中" : running ? "查看" : "打开";
  return `
    <div class="session-card workstation${active}${resuming ? " disabled" : ""}">
      <button type="button" class="session-open" data-open="${escapeHtml(session.name)}"${resuming ? " disabled" : ""}>
        <span class="session-main">
          <span class="session-title">${escapeHtml(displayTitle(session))}${fork}</span>
          <span class="session-cwd">${escapeHtml(session.cwd)}</span>
          <span class="session-last">${hint}</span>
        </span>
        <span class="session-state ${tone}">
          <span class="dot ${tone}"></span>${stateLabel}
        </span>
        <span class="session-chevron" aria-hidden="true">›</span>
      </button>
    </div>`;
}

function visibleWorkstationSessions(data) {
  const sessions = data?.sessions || [];
  const managed = new Set(
    sessions.map((session) => session.host?.sessionId).filter(Boolean),
  );
  const all = data?.workstationSessions || [];
  const byId = new Map(all.map((session) => [session.id, session]));
  const rootOf = (session) => {
    let current = session;
    const seen = new Set();
    while (current?.parent && byId.has(current.parent) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parent);
    }
    return current?.id || session.id;
  };
  const groups = new Map();
  for (const session of all) {
    const root = rootOf(session);
    const list = groups.get(root) ?? [];
    list.push(session);
    groups.set(root, list);
  }
  const chosen = new Set();
  for (const list of groups.values()) {
    const running = list.filter((session) => session.running && !session.ended);
    const pick = (running.length ? running : list)
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (pick) chosen.add(pick.id);
  }
  return all.filter(
    (session) => chosen.has(session.id)
      && !managed.has(session.id)
      && !managed.has(session.parent),
  );
}

function renderDrawer() {
  const list = $("#drawer-sessions");
  const sessions = state.data?.sessions || [];
  const workstation = visibleWorkstationSessions(state.data);
  const all = [...sessions, ...workstation];
  if (!all.length) {
    list.innerHTML = `<p class="drawer-empty">暂无会话</p>`;
    return;
  }
  list.innerHTML = all.map((session) => {
    const active = state.chatSession === session.name ? " active" : "";
    if (session.readOnly && session.kind === "workstation") {
      const fork = session.fork ? '<span class="session-fork">fork</span>' : "";
      const updated = session.updatedAt ? formatRelative(session.updatedAt) : "";
      const resuming = state.resumingSession === session.id;
      const running = Boolean(session.running);
      const meta = resuming ? "启动中…" : running ? "电脑上运行 · 查看" : "点击打开";
      return `
        <div class="drawer-session${active}">
          <button type="button" class="drawer-open" data-switch="${escapeHtml(session.name)}"${resuming ? " disabled" : ""}>
            <span class="drawer-title">${escapeHtml(displayTitle(session))}${fork}</span>
            <span class="drawer-cwd">${escapeHtml(session.cwd)}</span>
            <span class="drawer-meta"><span class="${resuming ? "warn" : running ? "muted" : "ok"}">${meta}</span>${updated ? ` · ${escapeHtml(updated)}` : ""}</span>
          </button>
        </div>`;
    }
    const { label, tone, ready } = statusFor(session);
    const readOnly = Boolean(session.readOnly);
    const stateLabel = readOnly ? "查看" : label;
    const stateTone = readOnly ? "muted" : tone;
    const canOpen = ready || readOnly;
    return `
      <div class="drawer-session${active}">
        <button type="button" class="drawer-open" data-switch="${escapeHtml(session.name)}"${canOpen ? "" : " disabled"}>
          <span class="drawer-title">${escapeHtml(displayTitle(session))}</span>
          <span class="drawer-cwd">${escapeHtml(session.cwd)}</span>
          <span class="drawer-meta"><span class="${stateTone}">${stateLabel}</span> · ${escapeHtml(lastOpenedText(session.name))}</span>
        </button>
        <button type="button" class="drawer-delete" data-delete="${escapeHtml(session.name)}" title="删除会话" aria-label="删除会话">✕</button>
      </div>`;
  }).join("");
}

function render() {
  const data = state.data;
  if (!data) return;
  $("#host-name").textContent = data.name || "电脑";
  setHostStatus("已连接");

  const sessions = data.sessions || [];
  const workstation = visibleWorkstationSessions(data);
  const total = sessions.length + workstation.length;
  $("#session-count").textContent = total ? `${total} 个` : "";
  $("#sessions").innerHTML = sessions.map(renderSession).join("")
    + workstation.map(renderWorkstationSession).join("");

  const empty = $("#empty-state");
  const showEmpty = total === 0;
  empty.classList.toggle("hidden", !showEmpty);
  if (showEmpty) {
    const spinner = empty.querySelector(".spinner");
    const message = $("#empty-message");
    const detail = $("#empty-detail");
    const retry = $("#retry-button");
    spinner.classList.add("hidden");
    detail.classList.add("hidden");
    retry.classList.remove("hidden");
    message.textContent = "暂无会话";
  }

  if ($("#chat-drawer").classList.contains("open")) renderDrawer();
  updateComposerState();
  updateNewSessionButton();
  updateChatTitle();
  updateChatMeta();
}

function validChatUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return url.toString();
    }
  } catch {
    // Fall through.
  }
  return null;
}

let drawerOpenedAt = 0;

function openDrawer() {
  if (!state.chatSession) return;
  renderDrawer();
  drawerOpenedAt = Date.now();
  $("#drawer-backdrop").classList.remove("hidden");
  $("#chat-drawer").classList.add("open");
}

function closeDrawer() {
  $("#chat-drawer").classList.remove("open");
  $("#drawer-backdrop").classList.add("hidden");
}

async function openChat(name) {
  const overlay = $("#chat-overlay");
  stopChatStatus();
  stopLivePoll();
  closeDrawer();
  clearTimeout(state.chatReconnectTimer);
  state.chatReconnectTimer = null;
  touchSession(name);
  const session = findAnySession(name);
  if (session?.kind === "workstation" && session.readOnly && !session.running) {
    const outcome = await resumeWorkstationSession(session);
    if (outcome !== "in_use") return;
  }
  const readOnly = Boolean(session?.readOnly);
  state.collabOpen = false;
  state.sendingPrompt = false;
  overlay.classList.remove("collab");
  overlay.classList.toggle("readonly", readOnly);
  $("#chat-back").title = "返回主页";
  $("#chat-current-title").textContent = session ? displayTitle(session) : "";
  $("#chat-current-title").title = session ? displayTitle(session) : "";
  state.chatSession = name;
  state.chatUrl = null;
  state.chatGeneration = null;
  state.chatLinkRefreshing = false;
  state.live = null;
  state.liveVersion = "";
  state.liveIdleTicks = 0;
  state.livePinned = true;
  $("#chat-frame").src = "about:blank";
  setNativeSession(readOnly ? "" : name);
  hideChatConnecting();
  $("#chat-live").classList.remove("hidden");
  overlay.classList.remove("hidden");
  setComposerVisible(!readOnly);
  const input = $("#chat-input");
  input.value = "";
  input.style.height = "40px";
  startLivePoll(name);
  if (readOnly) updateChatMeta();
  else startChatStatus(name);
  autoGrowComposer();
  updateComposerState();
  updateComposerHeight();
  scheduleChatViewportSync();
  render();
}

let chatViewportFrame = 0;

function syncChatViewport() {
  chatViewportFrame = 0;
  const overlay = $("#chat-overlay");
  if (!overlay || overlay.classList.contains("hidden")) return;
  const viewport = window.visualViewport;
  const covered = viewport
    ? window.innerHeight - viewport.height - viewport.offsetTop
    : 0;
  if (viewport && covered > 48) {
    overlay.style.top = `${viewport.offsetTop}px`;
    overlay.style.height = `${viewport.height}px`;
    overlay.style.bottom = "auto";
  } else {
    overlay.style.top = "";
    overlay.style.height = "";
    overlay.style.bottom = "";
  }
}

function scheduleChatViewportSync() {
  if (chatViewportFrame) return;
  chatViewportFrame = requestAnimationFrame(syncChatViewport);
}

function setComposerVisible(visible) {
  const form = $("#chat-composer");
  const input = $("#chat-input");
  if (!form) return;
  form.classList.toggle("hidden", !visible);
  if (input) input.disabled = !visible;
  if (!visible) {
    const overlay = $("#chat-overlay");
    if (overlay) overlay.style.removeProperty("--composer-height");
  }
}

function updateComposerHeight() {
  const form = $("#chat-composer");
  const overlay = $("#chat-overlay");
  if (!form || !overlay) return;
  if (
    form.classList.contains("hidden")
    || overlay.classList.contains("readonly")
    || overlay.classList.contains("collab")
  ) {
    overlay.style.removeProperty("--composer-height");
    return;
  }
  const height = Math.ceil(form.getBoundingClientRect().height);
  if (height > 0) overlay.style.setProperty("--composer-height", `${height}px`);
}

function autoGrowComposer() {
  const input = $("#chat-input");
  const form = $("#chat-composer");
  if (!input || !form || form.classList.contains("hidden")) return;
  input.style.height = "auto";
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const max = Math.max(40, Math.floor(viewportHeight * 0.34));
  const height = Math.min(Math.max(40, input.scrollHeight), max);
  input.style.height = `${height}px`;
  updateComposerHeight();
}

function updateComposerState() {
  const input = $("#chat-input");
  const send = $("#chat-send");
  if (!input || !send) return;
  const session = state.chatSession ? findSession(state.chatSession) : null;
  const waiting = Boolean(session?.host?.inputRequired);
  const visible = Boolean(session) && !session.readOnly && !state.collabOpen;
  input.placeholder = waiting ? "会话等待确认，请打开 Collab" : "输入提示词…";
  input.disabled = !visible || waiting;
  send.disabled = !visible || waiting || state.sendingPrompt || !input.value.trim();
  send.textContent = state.sendingPrompt ? "…" : "发送";
}

async function sendChatPrompt() {
  if (!state.chatSession || state.collabOpen || state.sendingPrompt) return;
  const name = state.chatSession;
  const input = $("#chat-input");
  const text = input.value;
  if (!text.trim()) return;
  const session = findSession(name);
  if (!session || session.host?.inputRequired) return;
  state.sendingPrompt = true;
  updateComposerState();
  try {
    await api(`/api/sessions/${encodeURIComponent(name)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
      timeout: 20_000,
    });
    if (state.chatSession !== name) return;
    input.value = "";
    autoGrowComposer();
    state.livePinned = true;
    void loadState({ quiet: true });
  } catch (error) {
    if (!(error instanceof AuthError) && state.chatSession === name) toast(error.message, true);
  } finally {
    if (state.chatSession === name) {
      state.sendingPrompt = false;
      updateComposerState();
      input.focus();
    }
  }
}

async function openCollabView() {
  const name = state.chatSession;
  const session = name ? findAnySession(name) : null;
  if (!name || !session) return;
  if (state.collabOpen) {
    closeCollabView();
    return;
  }
  state.collabOpen = true;
  state.chatUrl = null;
  state.chatGeneration = null;
  const overlay = $("#chat-overlay");
  overlay.classList.add("collab");
  $("#chat-collab").textContent = "实时";
  $("#chat-collab").title = "回到实时消息";
  $("#chat-back").title = "返回实时消息";
  $("#chat-collab").classList.add("active");
  $("#chat-frame").src = "about:blank";
  showChatConnecting(false);
  updateComposerState();
  updateComposerHeight();
  try {
    const access = session.readOnly ? "view" : "control";
    const link = await api(`/api/sessions/${encodeURIComponent(name)}/link?access=${access}`);
    if (!state.collabOpen || state.chatSession !== name) return;
    const url = validChatUrl(link.url);
    if (!url) throw new Error("无效的会话链接");
    state.chatUrl = url;
    state.chatGeneration = Number(link.generation) || null;
    loadChatFrame();
  } catch (error) {
    if (state.collabOpen && state.chatSession === name) closeCollabView();
    if (!(error instanceof AuthError)) toast(error.message, true);
  }
}

function closeCollabView() {
  if (!state.collabOpen) return;
  state.collabOpen = false;
  state.chatUrl = null;
  state.chatGeneration = null;
  clearTimeout(state.chatReconnectTimer);
  state.chatReconnectTimer = null;
  $("#chat-frame").src = "about:blank";
  hideChatConnecting();
  $("#chat-overlay").classList.remove("collab");
  $("#chat-collab").textContent = "Collab";
  $("#chat-collab").title = "打开 Collab 房间";
  $("#chat-back").title = "返回主页";
  $("#chat-collab").classList.remove("active");
  const session = state.chatSession ? findAnySession(state.chatSession) : null;
  setComposerVisible(Boolean(session) && !session.readOnly);
  if (session && !session.readOnly) autoGrowComposer();
  updateComposerState();
  updateComposerHeight();
  const live = $("#chat-live");
  if (live && state.livePinned) live.scrollTop = live.scrollHeight;
}

function handleChatResize() {
  scheduleChatViewportSync();
  autoGrowComposer();
  updateComposerHeight();
}

function closeChat() {
  closeDrawer();
  stopChatStatus();
  stopLivePoll();
  clearTimeout(state.chatReconnectTimer);
  state.chatReconnectTimer = null;
  state.collabOpen = false;
  state.sendingPrompt = false;
  $("#chat-frame").src = "about:blank";
  hideChatConnecting();
  const overlay = $("#chat-overlay");
  overlay.classList.add("hidden");
  overlay.classList.remove("readonly", "collab");
  overlay.style.top = "";
  overlay.style.height = "";
  overlay.style.bottom = "";
  overlay.style.removeProperty("--composer-height");
  $("#chat-back").title = "返回主页";
  $("#chat-input").value = "";
  $("#chat-input").style.height = "";
  setComposerVisible(false);
  $("#chat-live").classList.add("hidden");
  state.chatSession = null;
  state.chatUrl = null;
  state.chatGeneration = null;
  state.chatLinkRefreshing = false;
  setNativeSession("");
  state.live = null;
  state.liveVersion = "";
  state.liveIdleTicks = 0;
  state.livePinned = true;
  updateChatTitle();
  updateChatMeta();
  render();
}

function switchSession(name) {
  if (!name) return;
  closeDrawer();
  if (name === state.chatSession) return;
  void openChat(name);
}

function refreshChatLinkIfStale() {
  if (!state.collabOpen || !state.chatSession || state.chatLinkRefreshing) return;
  const session = findAnySession(state.chatSession);
  const generation = Number(session?.host?.generation) || 0;
  if (!generation || !state.chatGeneration) return;
  if (generation > state.chatGeneration) void refreshChatLink(false);
}

async function refreshChatLink(force) {
  if (!state.collabOpen || !state.chatSession || state.chatLinkRefreshing) return;
  const name = state.chatSession;
  const access = findAnySession(name)?.readOnly ? "view" : "control";
  state.chatLinkRefreshing = true;
  try {
    const link = await api(`/api/sessions/${encodeURIComponent(name)}/link?access=${access}`);
    if (state.chatSession !== name || !state.collabOpen) return;
    const url = validChatUrl(link.url);
    if (!url) return;
    const changed = url !== state.chatUrl;
    state.chatUrl = url;
    state.chatGeneration = Number(link.generation) || state.chatGeneration;
    if (changed || force) reloadChatFrame();
  } catch {
    if (state.chatSession === name && state.collabOpen) reloadChatFrame();
  } finally {
    state.chatLinkRefreshing = false;
  }
}

let chatHiddenAt = 0;

let chatConnectTimer = null;

function showChatConnecting(retry = false) {
  const loading = $("#chat-loading");
  if (!loading) return;
  const text = $("#chat-loading-text");
  if (text) text.textContent = "正在连接…";
  $("#chat-retry")?.classList.toggle("hidden", !retry);
  loading.classList.remove("hidden");
}

function hideChatConnecting() {
  clearTimeout(chatConnectTimer);
  chatConnectTimer = null;
  $("#chat-loading")?.classList.add("hidden");
  $("#chat-retry")?.classList.add("hidden");
}

function startChatConnectWatch() {
  clearTimeout(chatConnectTimer);
  showChatConnecting(false);
  const name = state.chatSession;
  const startedAt = Date.now();
  setTimeout(() => {
    if (state.chatSession === name) hideChatConnecting();
  }, 750);
  const tick = async () => {
    if (!name || state.chatSession !== name) return;
    try {
      const data = await api("/api/state");
      if (state.chatSession !== name) return;
      const session = (data.sessions || []).find((entry) => entry.name === name)
        || (data.workstationSessions || []).find((entry) => entry.name === name);
      const participants = Number(session?.host?.participants) || 0;
      const relayConnected = session?.host?.relayConnected !== false;
      if (relayConnected && participants >= 2) {
        hideChatConnecting();
        return;
      }
    } catch {
      // Keep the connecting hint and try again.
    }
    if (Date.now() - startedAt >= 12_000) {
      showChatConnecting(true);
      return;
    }
    chatConnectTimer = setTimeout(tick, 1500);
  };
  chatConnectTimer = setTimeout(tick, 1500);
}

function loadChatFrame() {
  if (!state.chatSession || !state.chatUrl) return;
  const frame = $("#chat-frame");
  const target = new URL(state.chatUrl);
  target.searchParams.set("_open", String(Date.now()));
  showChatConnecting(false);
  startChatConnectWatch();
  frame.src = target.toString();
}

function reloadChatFrame() {
  loadChatFrame();
}

function scheduleChatReconnect() {
  if (!state.collabOpen || !state.chatSession) return;
  clearTimeout(state.chatReconnectTimer);
  state.chatReconnectTimer = setTimeout(() => {
    if (state.collabOpen && state.chatSession) void refreshChatLink(true);
  }, 250);
}

window.ompMobileOnResume = (elapsed) => {
  if (!state.collabOpen || !state.chatSession) return;
  if (Number.isFinite(elapsed) && elapsed >= 1500) {
    scheduleChatReconnect();
  } else if (chatHiddenAt > 0 && Date.now() - chatHiddenAt >= 1500) {
    scheduleChatReconnect();
  }
};

function openSettings() {
  $("#settings-token").value = state.token;
  $("#settings-overlay").classList.remove("hidden");
}

function closeSettings() {
  $("#settings-overlay").classList.add("hidden");
}

function closeTopOverlay() {
  if ($("#chat-drawer").classList.contains("open")) {
    closeDrawer();
    return true;
  }
  if (!$("#settings-overlay").classList.contains("hidden")) {
    closeSettings();
    return true;
  }
  if (!$("#chat-overlay").classList.contains("hidden")) {
    closeChat();
    return true;
  }
  return false;
}

function saveToken(token) {
  const value = String(token || "").trim();
  if (!value) {
    toast("访问令牌不能为空", true);
    return;
  }
  localStorage.setItem(TOKEN_KEY, value);
  try {
    if (window.OmpNative && typeof window.OmpNative.setToken === "function") {
      window.OmpNative.setToken(value);
    }
  } catch {
    // Browser/PWA: no native bridge.
  }
  const authError = $("#auth-error");
  authError.textContent = "";
  authError.classList.add("hidden");
  state.token = value;
  state.data = null;
  state.autoStarting = false;
  state.autoStartAttempted = false;
  state.autoStartError = "";
  state.creatingSession = false;
  closeChat();
  setAuthVisible(false);
  showConnecting();
  void loadState({ force: true });
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  try {
    if (window.OmpNative && typeof window.OmpNative.setToken === "function") {
      window.OmpNative.setToken("");
    }
  } catch {
    // Browser/PWA: no native bridge.
  }
  const authError = $("#auth-error");
  authError.textContent = "";
  authError.classList.add("hidden");
  state.token = "";
  state.data = null;
  state.autoStarting = false;
  state.autoStartAttempted = false;
  state.autoStartError = "";
  state.creatingSession = false;
  closeChat();
  closeSettings();
  setAuthVisible(true);
}

function refresh() {
  if (!state.autoStarting) {
    state.autoStartAttempted = false;
    state.autoStartError = "";
  }
  void loadState({ force: true });
}

function wireDrawerGesture() {
  const edge = $("#drawer-edge");
  let gesture = null;
  edge.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    gesture = { x: event.clientX, y: event.clientY, moved: false };
    try {
      edge.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a convenience; swipes still work without it.
    }
  });
  edge.addEventListener("pointermove", (event) => {
    if (!gesture) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) gesture.moved = true;
    if (dx > 44 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      gesture = null;
      openDrawer();
    }
  });
  edge.addEventListener("pointerup", () => {
    const current = gesture;
    gesture = null;
    if (current && !current.moved) openDrawer();
  });
  edge.addEventListener("pointercancel", () => {
    gesture = null;
  });
  edge.addEventListener("click", () => {
    if (!gesture && state.chatSession) openDrawer();
  });
}

function wireEvents() {
  $("#auth-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveToken($("#token-input").value);
  });

  $("#refresh-button").addEventListener("click", refresh);
  $("#new-session-button").addEventListener("click", createSession);

  $("#settings-button").addEventListener("click", () => {
    if (window.OmpNative && typeof window.OmpNative.openSetup === "function") {
      window.OmpNative.openSetup();
      return;
    }
    openSettings();
  });
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveToken($("#settings-token").value);
    closeSettings();
  });
  $("#logout-button").addEventListener("click", logout);

  $("#sessions").addEventListener("click", (event) => {
    const remove = event.target.closest("button[data-delete]");
    if (remove) {
      void deleteSession(remove.dataset.delete);
      return;
    }
    const open = event.target.closest("button[data-open]");
    if (open && !open.disabled) void openChat(open.dataset.open);
  });

  $("#chat-drawer").addEventListener("click", (event) => {
    const remove = event.target.closest("button[data-delete]");
    if (remove) {
      void deleteSession(remove.dataset.delete);
      return;
    }
    const open = event.target.closest("button[data-switch]");
    if (open && !open.disabled) switchSession(open.dataset.switch);
  });

  $("#chat-back").addEventListener("click", () => {
    if (state.collabOpen) {
      closeCollabView();
      return;
    }
    closeChat();
  });
  $("#chat-composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendChatPrompt();
  });
  $("#chat-input").addEventListener("input", () => {
    autoGrowComposer();
    updateComposerState();
  });
  $("#chat-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const touch = (navigator.maxTouchPoints || 0) > 0
      || window.matchMedia?.("(pointer: coarse)")?.matches;
    if (touch) return;
    event.preventDefault();
    void sendChatPrompt();
  });
  $("#chat-retry").addEventListener("click", () => {
    if (!state.chatSession) return;
    showChatConnecting(false);
    void refreshChatLink(true);
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== "https://my.omp.sh") return;
    if (event.data?.type === "omp-collab-ready") hideChatConnecting();
  });
  $("#chat-live").addEventListener("scroll", () => {
    const live = $("#chat-live");
    if (!live) return;
    state.livePinned = live.scrollHeight - live.scrollTop - live.clientHeight < 80;
  });
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", () => {
    // The click that follows the opening pointerup lands on the fresh backdrop.
    if (Date.now() - drawerOpenedAt < 800) return;
    closeDrawer();
  });

  wireDrawerGesture();

  window.addEventListener("resize", handleChatResize);
  window.addEventListener("orientationchange", () => {
    setTimeout(handleChatResize, 150);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleChatResize);
    window.visualViewport.addEventListener("scroll", handleChatResize);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      chatHiddenAt = Date.now();
      return;
    }
    if (state.chatSession && chatHiddenAt > 0 && Date.now() - chatHiddenAt >= 1500) {
      scheduleChatReconnect();
    }
    void loadState({ quiet: true });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && closeTopOverlay()) event.preventDefault();
  });
}

function startPolling() {
  clearInterval(state.poll);
  state.poll = setInterval(() => {
    if (!document.hidden) void loadState({ quiet: true });
  }, 3000);
}

function showClientVersion() {
  if (!APP_VERSION) return;
  const badge = $("#client-version-badge");
  if (badge) {
    badge.textContent = `v${APP_VERSION}`;
    badge.classList.remove("hidden");
  }
  const line = $("#client-version");
  if (line) {
    line.textContent = `客户端版本 ${APP_VERSION}`;
    line.classList.remove("hidden");
  }
}

async function init() {
  wireEvents();
  showClientVersion();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  if (state.token) {
    setAuthVisible(false);
    showConnecting();
    await loadState({ quiet: true });
  } else {
    setAuthVisible(true);
  }
  const bootRemaining = BOOT_MIN_MS - (Date.now() - bootShownAt);
  if (bootRemaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, bootRemaining));
  }
  $("#boot-view").classList.add("hidden");
  startPolling();
}

void init();
