const TOKEN_KEY = "omp-mobile.token";
const META_KEY = "omp-mobile.session-meta";
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
  renamingSession: null,
  creatingSession: false,
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
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let response;
  try {
    response = await fetch(path, {
      ...options,
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
    throw new Error(body?.error || `请求失败（${response.status}）`);
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
    setAuthVisible(false);
    setOnline(true);
    render();
    const sessions = data.sessions || [];
    if (sessions.length > 0) {
      state.autoStartAttempted = true;
    } else if (!state.autoStartAttempted) {
      state.autoStartAttempted = true;
      void ensureSession();
    }
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
  button.disabled = state.creatingSession || state.autoStarting;
  button.textContent = state.creatingSession ? "新建中…" : "＋ 新会话";
}

async function createSession() {
  if (state.creatingSession || state.autoStarting) return;
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

function updateChatTitle() {
  const label = $("#chat-current-title");
  if (!label) return;
  const session = state.chatSession ? findSession(state.chatSession) : null;
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

function updateChatMeta() {
  const label = $("#chat-current-meta");
  if (!label) return;
  const session = state.chatSession ? findSession(state.chatSession) : null;
  if (!session) {
    label.textContent = "";
    label.title = "";
    return;
  }
  const model = state.chatStatus?.model || modelLabel(session.host?.model);
  const text = [model, contextLabel()].filter(Boolean).join(" · ");
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

function displayTitle(session) {
  if (!session) return "omp 会话";
  const custom = sessionMeta(session.name).title;
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  const hostTitle = String(session.host?.sessionName || "").trim();
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

function renderSession(session) {
  const active = state.chatSession === session.name ? " active" : "";
  const { label, tone, ready } = statusFor(session);
  return `
    <div class="session-card${active}${ready ? "" : " disabled"}">
      <button type="button" class="session-open" data-open="${escapeHtml(session.name)}"${ready ? "" : " disabled"}>
        <span class="session-main">
          <span class="session-title">${escapeHtml(displayTitle(session))}</span>
          <span class="session-cwd">${escapeHtml(session.cwd)}</span>
          <span class="session-last">${escapeHtml(lastOpenedText(session.name))}</span>
        </span>
        <span class="session-state ${tone}">
          <span class="dot ${tone}"></span>${label}
        </span>
        <span class="session-chevron" aria-hidden="true">›</span>
      </button>
      <button type="button" class="session-rename" data-rename="${escapeHtml(session.name)}" title="重命名">✎</button>
    </div>`;
}

function renderDrawer() {
  const list = $("#drawer-sessions");
  const sessions = state.data?.sessions || [];
  if (!sessions.length) {
    list.innerHTML = `<p class="drawer-empty">暂无会话</p>`;
    return;
  }
  list.innerHTML = sessions.map((session) => {
    const active = state.chatSession === session.name ? " active" : "";
    const { label, tone, ready } = statusFor(session);
    return `
      <div class="drawer-session${active}">
        <button type="button" class="drawer-open" data-switch="${escapeHtml(session.name)}"${ready ? "" : " disabled"}>
          <span class="drawer-title">${escapeHtml(displayTitle(session))}</span>
          <span class="drawer-cwd">${escapeHtml(session.cwd)}</span>
          <span class="drawer-meta"><span class="${tone}">${label}</span> · ${escapeHtml(lastOpenedText(session.name))}</span>
        </button>
        <button type="button" class="drawer-rename" data-rename="${escapeHtml(session.name)}" title="重命名">✎</button>
      </div>`;
  }).join("");
}

function render() {
  const data = state.data;
  if (!data) return;
  $("#host-name").textContent = data.name || "电脑";
  setHostStatus("已连接");

  const sessions = data.sessions || [];
  $("#session-count").textContent = sessions.length ? `${sessions.length} 个` : "";
  $("#sessions").innerHTML = sessions.map(renderSession).join("");

  const empty = $("#empty-state");
  const showEmpty = sessions.length === 0;
  empty.classList.toggle("hidden", !showEmpty);
  if (showEmpty) {
    const spinner = empty.querySelector(".spinner");
    const message = $("#empty-message");
    const detail = $("#empty-detail");
    const retry = $("#retry-button");
    detail.classList.add("hidden");
    retry.classList.add("hidden");
    if (state.autoStarting) {
      spinner.classList.remove("hidden");
      message.textContent = "正在启动 omp…";
    } else if (state.autoStartError) {
      spinner.classList.add("hidden");
      message.textContent = "omp 启动失败";
      detail.textContent = "请检查电脑端的 tmux 和 omp。";
      detail.classList.remove("hidden");
      retry.classList.remove("hidden");
    } else {
      spinner.classList.add("hidden");
      message.textContent = "暂无会话";
      retry.classList.remove("hidden");
    }
  }

  if ($("#chat-drawer").classList.contains("open")) renderDrawer();
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
  const frame = $("#chat-frame");
  const loading = $("#chat-loading");
  stopChatStatus();
  closeDrawer();
  clearTimeout(state.chatReconnectTimer);
  state.chatReconnectTimer = null;
  touchSession(name);
  const session = findSession(name);
  $("#chat-current-title").textContent = session ? displayTitle(session) : "";
  $("#chat-current-title").title = session ? displayTitle(session) : "";
  loading.classList.remove("hidden");
  overlay.classList.remove("hidden");
  try {
    const link = await api(`/api/sessions/${encodeURIComponent(name)}/link`);
    const url = validChatUrl(link.url);
    if (!url) throw new Error("无效的会话链接");
    state.chatSession = name;
    state.chatUrl = url;
    startChatStatus(name);
    frame.src = url;
    frame.onload = () => {
      loading.classList.add("hidden");
    };
    setTimeout(() => loading.classList.add("hidden"), 8000);
    requestAnimationFrame(syncChatViewport);
    render();
  } catch (error) {
    overlay.classList.add("hidden");
    closeDrawer();
    stopChatStatus();
    state.chatSession = null;
    render();
    if (!(error instanceof AuthError)) toast(error.message, true);
  }
}

function syncChatViewport() {
  const overlay = $("#chat-overlay");
  if (!overlay || overlay.classList.contains("hidden")) return;
  const viewport = window.visualViewport;
  if (!viewport) return;
  const covered = window.innerHeight - viewport.height - viewport.offsetTop;
  if (covered > 48) {
    overlay.style.top = `${viewport.offsetTop}px`;
    overlay.style.height = `${viewport.height}px`;
    overlay.style.bottom = "auto";
  } else {
    overlay.style.top = "";
    overlay.style.height = "";
    overlay.style.bottom = "";
  }
}

function closeChat() {
  closeDrawer();
  stopChatStatus();
  clearTimeout(state.chatReconnectTimer);
  state.chatReconnectTimer = null;
  $("#chat-frame").src = "about:blank";
  $("#chat-loading").classList.add("hidden");
  $("#chat-overlay").classList.add("hidden");
  $("#chat-overlay").style.top = "";
  $("#chat-overlay").style.height = "";
  $("#chat-overlay").style.bottom = "";
  state.chatSession = null;
  state.chatUrl = null;
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

let chatHiddenAt = 0;

function reloadChatFrame() {
  if (!state.chatSession || !state.chatUrl) return;
  const frame = $("#chat-frame");
  const target = new URL(state.chatUrl);
  target.searchParams.set("_reconnect", String(Date.now()));
  $("#chat-loading").classList.remove("hidden");
  frame.src = target.toString();
  setTimeout(() => $("#chat-loading").classList.add("hidden"), 8000);
}

function scheduleChatReconnect() {
  if (!state.chatSession || !state.chatUrl) return;
  clearTimeout(state.chatReconnectTimer);
  state.chatReconnectTimer = setTimeout(reloadChatFrame, 250);
}

window.ompMobileOnResume = (elapsed) => {
  if (!state.chatSession) return;
  if (Number.isFinite(elapsed) && elapsed >= 1500) {
    scheduleChatReconnect();
  } else if (chatHiddenAt > 0 && Date.now() - chatHiddenAt >= 1500) {
    scheduleChatReconnect();
  }
};

function openRename(name) {
  const session = findSession(name);
  if (!session) return;
  state.renamingSession = name;
  $("#rename-input").value = displayTitle(session);
  $("#rename-overlay").classList.remove("hidden");
  requestAnimationFrame(() => {
    const input = $("#rename-input");
    input.focus();
    input.select();
  });
}

function closeRename() {
  state.renamingSession = null;
  $("#rename-overlay").classList.add("hidden");
}

function saveRename(event) {
  event.preventDefault();
  const name = state.renamingSession;
  if (!name) return;
  const value = $("#rename-input").value.trim().slice(0, 40);
  const meta = readMeta();
  const entry = meta[name] && typeof meta[name] === "object" ? { ...meta[name] } : {};
  if (value) entry.title = value;
  else delete entry.title;
  meta[name] = entry;
  writeMeta(meta);
  closeRename();
  render();
  if ($("#chat-drawer").classList.contains("open")) renderDrawer();
}

function openSettings() {
  $("#settings-token").value = state.token;
  $("#settings-overlay").classList.remove("hidden");
}

function closeSettings() {
  $("#settings-overlay").classList.add("hidden");
}

function closeTopOverlay() {
  if (!$("#rename-overlay").classList.contains("hidden")) {
    closeRename();
    return true;
  }
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
  closeRename();
  setAuthVisible(false);
  showConnecting();
  void loadState({ force: true });
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
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
  closeRename();
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

  $("#settings-button").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveToken($("#settings-token").value);
    closeSettings();
  });
  $("#logout-button").addEventListener("click", logout);

  $("#sessions").addEventListener("click", (event) => {
    const rename = event.target.closest("button[data-rename]");
    if (rename) {
      openRename(rename.dataset.rename);
      return;
    }
    const open = event.target.closest("button[data-open]");
    if (open && !open.disabled) void openChat(open.dataset.open);
  });

  $("#chat-drawer").addEventListener("click", (event) => {
    const rename = event.target.closest("button[data-rename]");
    if (rename) {
      openRename(rename.dataset.rename);
      return;
    }
    const open = event.target.closest("button[data-switch]");
    if (open && !open.disabled) switchSession(open.dataset.switch);
  });

  $("#chat-back").addEventListener("click", closeChat);
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", () => {
    // The click that follows the opening pointerup lands on the fresh backdrop.
    if (Date.now() - drawerOpenedAt < 800) return;
    closeDrawer();
  });

  $("#rename-form").addEventListener("submit", saveRename);
  $("#rename-cancel").addEventListener("click", closeRename);
  $("#rename-overlay").addEventListener("click", (event) => {
    if (event.target === $("#rename-overlay")) closeRename();
  });

  wireDrawerGesture();

  window.addEventListener("resize", syncChatViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncChatViewport);
    window.visualViewport.addEventListener("scroll", syncChatViewport);
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

async function init() {
  wireEvents();
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
  $("#boot-view").classList.add("hidden");
  startPolling();
}

void init();
