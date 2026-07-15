const messagesEl = document.getElementById("messages");
const logsEl = document.getElementById("logs");
const composer = document.getElementById("composer");
const promptInput = document.getElementById("prompt");
const promptPreviewEl = document.getElementById("promptPreview");
const writeTabEl = document.getElementById("writeTab");
const previewTabEl = document.getElementById("previewTab");
const composerExpandEl = document.getElementById("composerExpand");
const voiceLauncherEl = document.getElementById("voiceLauncher");
const voiceModalEl = document.getElementById("voiceModal");
const voiceCloseEl = document.getElementById("voiceClose");
const voiceStripEl = document.getElementById("voiceStrip");
const voiceToggleEl = document.getElementById("voiceToggle");
const voiceToggleTextEl = document.getElementById("voiceToggleText");
const voiceClearEl = document.getElementById("voiceClear");
const voiceStatusEl = document.getElementById("voiceStatus");
const voiceStatusDetailEl = document.getElementById("voiceStatusDetail");
const voiceHeardEl = document.getElementById("voiceHeard");
const voiceAlternativesEl = document.getElementById("voiceAlternatives");
const voiceTranscriptEl = document.getElementById("voiceTranscript");
const voiceEngineStatusEl = document.getElementById("voiceEngineStatus");
const voiceRestartCountEl = document.getElementById("voiceRestartCount");
const voiceLatencyEl = document.getElementById("voiceLatency");
const voiceActivityEl = document.getElementById("voiceActivity");
const sendButton = document.getElementById("send");
const sendTextEl = document.getElementById("sendText");
const sendIconEl = document.getElementById("sendIcon");
const stopButton = document.getElementById("stopResponse");
const scrollLatestButton = document.getElementById("scrollLatest");
const healthEl = document.getElementById("health");
const modelNameEl = document.getElementById("modelName");
const sessionTokensEl = document.getElementById("sessionTokens");
const sessionCostEl = document.getElementById("sessionCost");
const grandTokensEl = document.getElementById("grandTokens");
const grandCostEl = document.getElementById("grandCost");
const activeSessionTitleEl = document.getElementById("activeSessionTitle");
const messageCountEl = document.getElementById("messageCount");
const sessionListEl = document.getElementById("sessionList");
const limitNoticeEl = document.getElementById("limitNotice");
const inputTokensEl = document.getElementById("inputTokens");
const cacheHitTokensEl = document.getElementById("cacheHitTokens");
const cacheMissTokensEl = document.getElementById("cacheMissTokens");
const outputTokensEl = document.getElementById("outputTokens");
const usageTotalTokensEl = document.getElementById("usageTotalTokens");
const usageTotalCostEl = document.getElementById("usageTotalCost");
const modelCallsEl = document.getElementById("modelCalls");
const tokenCallsEl = document.getElementById("tokenCalls");
const usagePanel = document.getElementById("usagePanel");
const workflowPanel = document.getElementById("workflowPanel");
const usageTab = document.getElementById("usageTab");
const workflowTab = document.getElementById("workflowTab");
const { setMarkdown } = window.RoomMarkdown;
const { resolveToolResult, failPendingToolCalls } = window.RoomToolProgress;

const MAX_USER_MESSAGES_PER_SESSION = 10;
const MAX_REQUEST_MESSAGES = 20;

const STORAGE_KEYS = {
  sessions: "roomAssistant.sessions.v1",
  activeSessionId: "roomAssistant.activeSessionId.v1",
  legacyHistory: "roomAssistant.chatHistory.v2",
  legacyUsageTotals: "roomAssistant.usageTotals.v1",
  legacyUsageCalls: "roomAssistant.usageCalls.v1",
};

const MAX_MODEL_DRAFT_CHARS = 220;

const MODEL_PRICING = {
  "deepseek-v4-flash": { label: "DeepSeek V4 Flash", cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
  "deepseek-v4-pro": { label: "DeepSeek V4 Pro", cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
  "deepseek-chat": { label: "DeepSeek V4 Flash", cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
  "deepseek-reasoner": { label: "DeepSeek V4 Flash", cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
};

let pendingSessionId = null;
let isSending = false;
let currentAbortController = null;
let runHasToolCall = false;
let runReachedTerminal = false;
let activeTrace = null;
let activeTraceView = null;
let activeTraceUserMessageId = null;
let activeTraceActivity = "";
let traceTimer = null;
let streamAssistantView = null;
let streamAssistantText = "";
let streamWorkingStepId = null;
let streamAnimationTimer = null;
let streamReplayTimer = null;
let pendingModelChunks = [];
let pendingModelText = "";
let currentModelStreamTarget = "pending";
let autoFollowLatest = true;
let userScrollAwayIntentTimer = null;
let userScrollAwayIntent = false;
let lastTouchY = null;
let sessions = loadSessions();
let activeSessionId = loadActiveSessionId();
let composerExpanded = false;
const TRACE_TOGGLE_ANIMATION_MS = 240;
const runTraceAnimationTimers = new WeakMap();

// Persist normalized sessions so saved Flash calls are repriced with Flash rates on reload.
saveSessions();

function setIcon(target, iconName) {
  if (!target) return;
  target.dataset.icon = iconName;
  target.replaceChildren();
  const iconNode = window.lucide && window.lucide.icons && window.lucide.icons[iconName];
  if (!iconNode || typeof window.lucide.createElement !== "function") {
    target.textContent = "";
    return;
  }
  const svg = window.lucide.createElement(iconNode, {
    "aria-hidden": "true",
    focusable: "false",
    class: "lucide-icon",
  });
  target.appendChild(svg);
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function refreshIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((target) => {
    setIcon(target, target.dataset.icon);
  });
}

function iconSpan(iconName) {
  const span = document.createElement("span");
  span.className = "button-icon";
  span.dataset.icon = iconName;
  span.setAttribute("aria-hidden", "true");
  return span;
}

function emptyUsageTotals() {
  return {
    inputTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    costUsd: 0,
    cacheHitInputCostUsd: 0,
    cacheMissInputCostUsd: 0,
    outputCostUsd: 0,
  };
}

function loadJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function createSession(title = "New chat") {
  const now = nowIso();
  return {
    id: newId(),
    title,
    createdAt: now,
    updatedAt: now,
    history: [],
    pendingApproval: null,
    model: "",
    usageTotals: emptyUsageTotals(),
    usageCalls: [],
  };
}

function userMessageCount(historyOrSession) {
  const history = Array.isArray(historyOrSession)
    ? historyOrSession
    : Array.isArray(historyOrSession && historyOrSession.history)
      ? historyOrSession.history
      : [];
  return history.filter((item) => item && item.role === "user").length;
}

function trimHistoryToUserLimit(history, maxUsers = MAX_USER_MESSAGES_PER_SESSION) {
  if (!Array.isArray(history)) return [];
  const kept = [];
  let users = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!item || (item.role !== "user" && item.role !== "assistant")) continue;
    if (item.role === "user") {
      if (users >= maxUsers) break;
      users += 1;
    }
    kept.push(item);
  }
  const ordered = kept.reverse();
  while (ordered.length && ordered[0].role !== "user") ordered.shift();
  return ordered;
}

function requestHistory(history) {
  return trimHistoryToUserLimit(history)
    .slice(-MAX_REQUEST_MESSAGES)
    .map((item) => ({ role: item.role, content: item.content }));
}

function modelPricing(model) {
  return MODEL_PRICING[String(model || "").trim().toLowerCase()] || null;
}

function estimateCallCosts(model, cacheHitInputTokens, cacheMissInputTokens, outputTokens) {
  const pricing = modelPricing(model);
  if (!pricing) {
    return {
      pricing_model: model || "Unknown model",
      pricing_available: false,
      estimated_cache_hit_input_cost_usd: 0,
      estimated_cache_miss_input_cost_usd: 0,
      estimated_output_cost_usd: 0,
      estimated_total_cost_usd: 0,
    };
  }
  const hitCost = (cacheHitInputTokens * pricing.cacheHit) / 1_000_000;
  const missCost = (cacheMissInputTokens * pricing.cacheMiss) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  return {
    pricing_model: pricing.label,
    pricing_available: true,
    estimated_cache_hit_input_cost_usd: hitCost,
    estimated_cache_miss_input_cost_usd: missCost,
    estimated_output_cost_usd: outputCost,
    estimated_total_cost_usd: hitCost + missCost + outputCost,
  };
}

function normalizeUsageTotals(value) {
  const source = value && typeof value === "object" ? value : {};
  const totals = emptyUsageTotals();
  totals.inputTokens = Number(source.inputTokens) || 0;
  totals.cacheHitInputTokens = Number(source.cacheHitInputTokens) || 0;
  totals.cacheMissInputTokens = Number(source.cacheMissInputTokens) || totals.inputTokens;
  totals.outputTokens = Number(source.outputTokens) || 0;
  totals.totalTokens = Number(source.totalTokens) || totals.inputTokens + totals.outputTokens;
  totals.modelCalls = Number(source.modelCalls) || 0;
  totals.costUsd = Number(source.costUsd) || 0;
  totals.cacheHitInputCostUsd = Number(source.cacheHitInputCostUsd) || 0;
  totals.cacheMissInputCostUsd = Number(source.cacheMissInputCostUsd) || totals.costUsd;
  totals.outputCostUsd = Number(source.outputCostUsd) || 0;
  return totals;
}

function normalizeCall(call) {
  const source = call && typeof call === "object" ? call : {};
  const inputTokens = Number(source.input_tokens ?? source.inputTokens) || 0;
  const outputTokens = Number(source.output_tokens ?? source.outputTokens) || 0;
  const cacheHit = Number(source.cache_hit_input_tokens ?? source.cacheHitInputTokens) || 0;
  const cacheMiss =
    Number(source.cache_miss_input_tokens ?? source.cacheMissInputTokens) ||
    Math.max(inputTokens - cacheHit, 0);
  const model = source.model || "";
  const costs = estimateCallCosts(model, cacheHit, cacheMiss, outputTokens);
  return {
    call_index: source.call_index ?? source.callIndex,
    model,
    has_usage: source.has_usage !== false,
    input_tokens: inputTokens,
    cache_hit_input_tokens: cacheHit,
    cache_miss_input_tokens: cacheMiss,
    output_tokens: outputTokens,
    total_tokens: Number(source.total_tokens ?? source.totalTokens) || inputTokens + outputTokens,
    ...costs,
    created_at: source.created_at || source.createdAt || nowIso(),
  };
}

function normalizeTraceStep(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const allowedTypes = new Set(["model", "tool_call", "tool_result", "direct", "error"]);
  const createdAt = source.createdAt || source.created_at || "";
  return {
    id: String(source.id || newId()),
    type: allowedTypes.has(source.type) ? source.type : "model",
    title: String(source.title || "Agent step"),
    content: String(source.content || ""),
    toolCallId: String(source.toolCallId || ""),
    args: source.args && typeof source.args === "object" ? sanitizeTraceValue(source.args) : null,
    success: typeof source.success === "boolean" ? source.success : null,
    streaming: source.streaming === true,
    elapsedMs: Math.max(0, Number(source.elapsedMs) || 0),
    createdAt: createdAt ? String(createdAt) : "",
  };
}

function normalizeRunTrace(raw) {
  if (!raw || typeof raw !== "object") return null;
  const validStatuses = new Set(["running", "completed", "stopped", "error", "interrupted"]);
  let status = validStatuses.has(raw.status) ? raw.status : "completed";
  const startedAt = Number(raw.startedAt) || Date.now();
  const lastUpdatedAt = Math.max(startedAt, Number(raw.lastUpdatedAt) || startedAt);
  let durationMs = Math.max(0, Number(raw.durationMs) || 0);
  if (status === "running") {
    status = "interrupted";
    durationMs = Math.max(durationMs, lastUpdatedAt - startedAt);
  }
  const steps = Array.isArray(raw.steps) ? raw.steps.map(normalizeTraceStep) : [];
  if (status !== "running") {
    steps.forEach((step) => {
      step.streaming = false;
    });
  }
  return {
    id: String(raw.id || newId()),
    status,
    startedAt,
    lastUpdatedAt,
    durationMs,
    steps,
  };
}

function totalsFromCalls(calls) {
  const totals = emptyUsageTotals();
  calls.forEach((call) => {
    totals.inputTokens += call.input_tokens;
    totals.cacheHitInputTokens += call.cache_hit_input_tokens;
    totals.cacheMissInputTokens += call.cache_miss_input_tokens;
    totals.outputTokens += call.output_tokens;
    totals.totalTokens += call.total_tokens;
    totals.modelCalls += 1;
    totals.cacheHitInputCostUsd += call.estimated_cache_hit_input_cost_usd;
    totals.cacheMissInputCostUsd += call.estimated_cache_miss_input_cost_usd;
    totals.outputCostUsd += call.estimated_output_cost_usd;
    totals.costUsd += call.estimated_total_cost_usd;
  });
  return totals;
}

function normalizeSession(raw) {
  const session = raw && typeof raw === "object" ? raw : createSession();
  const normalized = createSession(session.title || "New chat");
  normalized.id = session.id || newId();
  normalized.createdAt = session.createdAt || nowIso();
  normalized.updatedAt = session.updatedAt || normalized.createdAt;
  normalized.model = String(session.model || "");
  normalized.history = Array.isArray(session.history)
    ? trimHistoryToUserLimit(
        session.history
          .filter((item) => item && (item.role === "user" || item.role === "assistant"))
          .map((item) => ({
            id: String(item.id || newId()),
            role: item.role,
            content: String(item.content || ""),
            time: item.time || "",
            trace: item.role === "user" ? normalizeRunTrace(item.trace) : null,
          }))
          .filter((item) => item.content)
      )
    : [];
  if (session.pendingApproval && typeof session.pendingApproval === "object") {
    const status = ["pending", "resuming", "approved", "denied"].includes(session.pendingApproval.status)
      ? session.pendingApproval.status
      : "pending";
    normalized.pendingApproval = {
      status,
      userMessageId: String(session.pendingApproval.userMessageId || ""),
      payload: session.pendingApproval.payload && typeof session.pendingApproval.payload === "object"
        ? sanitizeTraceValue(session.pendingApproval.payload)
        : {},
    };
  }
  normalized.usageCalls = Array.isArray(session.usageCalls)
    ? session.usageCalls.map(normalizeCall).slice(0, 80)
    : [];
  normalized.usageTotals = normalized.usageCalls.length
    ? totalsFromCalls(normalized.usageCalls)
    : normalizeUsageTotals(session.usageTotals);
  if (!normalized.model && normalized.usageCalls.length) {
    normalized.model = normalized.usageCalls[0].model;
  }
  return normalized;
}

function migrateLegacySessions() {
  const history = loadJson(STORAGE_KEYS.legacyHistory, []);
  const usageTotals = loadJson(STORAGE_KEYS.legacyUsageTotals, emptyUsageTotals());
  const usageCalls = loadJson(STORAGE_KEYS.legacyUsageCalls, []);
  const session = createSession(Array.isArray(history) && history.length ? "Imported chat" : "New chat");
  session.history = Array.isArray(history) ? trimHistoryToUserLimit(history) : [];
  session.usageTotals = normalizeUsageTotals(usageTotals);
  session.usageCalls = Array.isArray(usageCalls) ? usageCalls.map(normalizeCall).slice(0, 80) : [];
  return [normalizeSession(session)];
}

function loadSessions() {
  const stored = loadJson(STORAGE_KEYS.sessions, null);
  if (Array.isArray(stored) && stored.length) {
    return stored.map(normalizeSession);
  }
  const migrated = migrateLegacySessions();
  saveJson(STORAGE_KEYS.sessions, migrated);
  return migrated;
}

function loadActiveSessionId() {
  const stored = localStorage.getItem(STORAGE_KEYS.activeSessionId);
  if (stored && sessions.some((session) => session.id === stored)) return stored;
  return sessions[0].id;
}

function saveSessions() {
  saveJson(STORAGE_KEYS.sessions, sessions);
  localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
}

function getSession(id = activeSessionId) {
  let session = sessions.find((item) => item.id === id);
  if (!session) {
    session = createSession();
    sessions.unshift(session);
    activeSessionId = session.id;
    saveSessions();
  }
  return session;
}

function touchSession(session) {
  session.updatedAt = nowIso();
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(Number(value) || 0));
}

function formatCost(value) {
  return `$${(Number(value) || 0).toFixed(6)}`;
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatClockTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatSessionTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function deriveTitle(text) {
  const cleaned = String(text || "")
    .replace(/[`*_#[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "New chat";
  return cleaned.length > 44 ? `${cleaned.slice(0, 41)}...` : cleaned;
}

function shouldAutoFollow(threshold = 72) {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= threshold;
}

function isFollowingLatest() {
  return autoFollowLatest && !userScrollAwayIntent;
}

function updateScrollLatestButton({ syncFollow = false } = {}) {
  if (!scrollLatestButton) return;
  const atLatest = shouldAutoFollow();
  if (syncFollow) {
    autoFollowLatest = atLatest;
  } else if (atLatest && !userScrollAwayIntent) {
    autoFollowLatest = true;
  }
  const composerOffset = composer ? composer.offsetHeight || 150 : 150;
  const noticeOffset = limitNoticeEl && !limitNoticeEl.hidden ? limitNoticeEl.offsetHeight + 10 : 0;
  scrollLatestButton.style.bottom = `${composerOffset + noticeOffset + 14}px`;
  scrollLatestButton.hidden = isFollowingLatest() || atLatest;
}

function scrollToLatest({ force = false, smooth = false } = {}) {
  if (force || isFollowingLatest() || (!userScrollAwayIntent && shouldAutoFollow())) {
    if (smooth && typeof messagesEl.scrollTo === "function") {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
    } else {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    autoFollowLatest = true;
    userScrollAwayIntent = false;
    if (userScrollAwayIntentTimer) window.clearTimeout(userScrollAwayIntentTimer);
    userScrollAwayIntentTimer = null;
  }
  updateScrollLatestButton();
}

function pauseAutoFollowForUserScroll() {
  if (!autoFollowLatest) return;
  autoFollowLatest = false;
  userScrollAwayIntent = true;
  if (userScrollAwayIntentTimer) window.clearTimeout(userScrollAwayIntentTimer);
  userScrollAwayIntentTimer = window.setTimeout(() => {
    userScrollAwayIntent = false;
    if (shouldAutoFollow()) autoFollowLatest = true;
    updateScrollLatestButton();
  }, 350);
}

function handleMessagesScroll() {
  userScrollAwayIntent = false;
  if (userScrollAwayIntentTimer) window.clearTimeout(userScrollAwayIntentTimer);
  userScrollAwayIntentTimer = null;
  updateScrollLatestButton({ syncFollow: true });
}

function addMessage(role, text, timestamp = formatTime(), options = {}) {
  const shouldFollow = Boolean(options.forceScroll) || isFollowingLatest() || (!userScrollAwayIntent && shouldAutoFollow());
  const row = document.createElement("div");
  row.className = `message-row ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "YOU" : role === "error" ? "ERR" : "AI";

  const bubble = document.createElement("article");
  bubble.className = `message ${role}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const label = document.createElement("span");
  label.textContent = role === "user" ? "You" : role === "error" ? "Error" : "Deepy";
  const time = document.createElement("time");
  time.textContent = timestamp;
  meta.append(label, time);

  const body = document.createElement("div");
  body.className = "message-body markdown";
  setMarkdown(body, text);

  bubble.append(meta, body);
  if (role === "user") {
    row.append(bubble, avatar);
  } else {
    row.append(avatar, bubble);
  }
  messagesEl.appendChild(row);
  scrollToLatest({ force: shouldFollow, smooth: Boolean(options.smoothScroll) });
  return { row, avatar, bubble, label, body };
}

function resetStreamingAssistant() {
  if (streamAnimationTimer) window.clearTimeout(streamAnimationTimer);
  if (streamReplayTimer) window.clearTimeout(streamReplayTimer);
  streamAnimationTimer = null;
  streamReplayTimer = null;
  if (streamAssistantView) {
    streamAssistantView.bubble.classList.remove("streaming", "streaming-tick");
  }
  streamAssistantView = null;
  streamAssistantText = "";
  streamWorkingStepId = null;
  pendingModelChunks = [];
  pendingModelText = "";
  currentModelStreamTarget = "pending";
}

function pulseStreamingTarget(target) {
  const bubble = target === "working" && streamWorkingStepId
    ? document.querySelector(`[data-trace-step-id="${cssEscape(streamWorkingStepId)}"] .trace-step-body`)
    : streamAssistantView && streamAssistantView.bubble;
  if (!bubble) return;
  bubble.classList.add("streaming");
  bubble.classList.remove("streaming-tick");
  bubble.getBoundingClientRect();
  bubble.classList.add("streaming-tick");
  if (streamAnimationTimer) window.clearTimeout(streamAnimationTimer);
  streamAnimationTimer = window.setTimeout(() => {
    bubble.classList.remove("streaming-tick");
    streamAnimationTimer = null;
  }, 180);
}

function workingModelStep() {
  if (!activeTrace || !streamWorkingStepId) return null;
  return activeTrace.steps.find((step) => step.id === streamWorkingStepId) || null;
}

function modelDraftDisplayText(content) {
  const text = String(content || "");
  if (text.length <= MAX_MODEL_DRAFT_CHARS) return text;
  return `${text.slice(0, MAX_MODEL_DRAFT_CHARS).trimEnd()}...`;
}

function ensureWorkingModelStep() {
  if (!activeTrace) return null;
  const current = workingModelStep();
  if (current) return current;
  const step = normalizeTraceStep({
    id: newId(),
    type: "model",
    title: "Model response",
    content: "",
    success: null,
    streaming: true,
    elapsedMs: Date.now() - activeTrace.startedAt,
    createdAt: nowIso(),
  });
  activeTrace.steps.push(step);
  streamWorkingStepId = step.id;
  persistActiveTrace();
  refreshActiveTraceView();
  return step;
}

function updateWorkingModelStepView(step) {
  if (!activeTraceView || !step) return false;
  const item = activeTraceView.timeline.querySelector(`[data-trace-step-id="${cssEscape(step.id)}"]`);
  if (!item) return false;
  const stateClass = step.success === true ? "succeeded" : step.success === false ? "failed" : "pending";
  item.className = `trace-step ${step.type} ${stateClass} ${step.streaming ? "streaming" : ""}`.trim();
  const status = item.querySelector(".trace-step-status");
  if (status) status.textContent = step.streaming ? "Streaming" : `+${formatTraceDuration(step.elapsedMs)}`;
  const body = item.querySelector(".trace-step-body");
  if (body) {
    body.classList.add("markdown");
    setMarkdown(body, modelDraftDisplayText(step.content));
  }
  return true;
}

function appendWorkingModelToken(token) {
  const text = String(token || "");
  if (!text) return;
  const step = ensureWorkingModelStep();
  if (!step || !activeTrace) return;
  step.content += text;
  step.streaming = true;
  step.elapsedMs = Date.now() - activeTrace.startedAt;
  persistActiveTrace();
  if (!updateWorkingModelStepView(step)) refreshActiveTraceView();
  pulseStreamingTarget("working");
  scrollToLatest();
}

function ensureAssistantStreamView() {
  if (streamAssistantView) return streamAssistantView;
  streamAssistantView = addMessage("assistant", "");
  streamAssistantView.bubble.classList.add("streaming");
  return streamAssistantView;
}

function appendStreamingAssistantToken(token) {
  const text = String(token || "");
  if (!text) return;
  if (streamReplayTimer) {
    window.clearTimeout(streamReplayTimer);
    streamReplayTimer = null;
  }
  const view = ensureAssistantStreamView();
  streamAssistantText += text;
  setMarkdown(view.body, streamAssistantText);
  pulseStreamingTarget("assistant");
  scrollToLatest();
}

function appendPendingModelToken(token) {
  const text = String(token || "");
  if (!text) return;
  pendingModelChunks.push(text);
  pendingModelText += text;
}

function clearPendingModelText() {
  pendingModelChunks = [];
  pendingModelText = "";
}

function clearWorkingModelDraft({ removeStep = false } = {}) {
  if (activeTrace && streamWorkingStepId) {
    const step = workingModelStep();
    if (step) {
      step.streaming = false;
      if (removeStep || !String(step.content || "").trim()) {
        activeTrace.steps = activeTrace.steps.filter((item) => item.id !== streamWorkingStepId);
      }
      persistActiveTrace();
      refreshActiveTraceView();
    }
  }
  streamWorkingStepId = null;
}

function commitWorkingModelDraft(content = "") {
  const step = workingModelStep();
  const draft = modelDraftDisplayText(content || pendingModelText || (step && step.content) || "").trim();
  clearPendingModelText();
  if (!draft) return;
  if (step) {
    step.content = draft;
    step.streaming = false;
    step.success = true;
    if (activeTrace) step.elapsedMs = Date.now() - activeTrace.startedAt;
    persistActiveTrace();
    refreshActiveTraceView();
    streamWorkingStepId = null;
    return;
  }
  appendTraceStep({ type: "model", title: "Model response", content: draft, success: true });
}

function finalizeAssistantMessage(content) {
  const finalText = String(content || "");
  if (!finalText.trim()) return;
  if (streamAssistantView) {
    if (streamReplayTimer) window.clearTimeout(streamReplayTimer);
    streamReplayTimer = null;
    setMarkdown(streamAssistantView.body, finalText);
    streamAssistantView.bubble.classList.remove("streaming", "streaming-tick");
  } else {
    replayAssistantMessage(finalText);
    return;
  }
  if (streamAnimationTimer) window.clearTimeout(streamAnimationTimer);
  streamAnimationTimer = null;
  streamAssistantText = finalText;
}

function replayAssistantMessage(content) {
  const finalText = String(content || "");
  if (!finalText.trim()) return;
  if (streamReplayTimer) window.clearTimeout(streamReplayTimer);
  const view = ensureAssistantStreamView();
  const chars = Array.from(finalText);
  const chunkSize = Math.max(2, Math.ceil(chars.length / 48));
  let index = 0;
  streamAssistantText = "";
  setMarkdown(view.body, "");
  const tick = () => {
    index = Math.min(chars.length, index + chunkSize);
    streamAssistantText = chars.slice(0, index).join("");
    setMarkdown(view.body, streamAssistantText);
    pulseStreamingTarget("assistant");
    if (index < chars.length) {
      streamReplayTimer = window.setTimeout(tick, 16);
      return;
    }
    view.bubble.classList.remove("streaming", "streaming-tick");
    streamReplayTimer = null;
  };
  tick();
}

function formatTraceDuration(durationMs) {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function traceSummary(trace, live = false) {
  const actions = trace.steps.filter((step) => step.type === "tool_call");
  if (actions.length) {
    const completed = actions.filter((step) => step.success === true).length;
    const failed = actions.filter((step) => step.success === false).length;
    return `Room actions · ${completed}/${actions.length} complete${failed ? ` · ${failed} failed` : ""}`;
  }
  const duration = live ? Date.now() - trace.startedAt : trace.durationMs;
  const prefix = {
    running: "Working for",
    completed: "Worked for",
    stopped: "Stopped after",
    error: "Failed after",
    interrupted: "Interrupted after",
  }[trace.status] || "Worked for";
  return `${prefix} ${formatTraceDuration(duration)}`;
}

function sanitizeTraceValue(value, key = "") {
  const lowerKey = String(key).toLowerCase();
  if (["api_key", "authorization", "secret", "password", "token"].some((part) => lowerKey.includes(part))) {
    return "***";
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, sanitizeTraceValue(item, childKey)]));
  }
  if (["string", "number", "boolean"].includes(typeof value) || value === null) return value;
  return String(value ?? "");
}

function createRunTrace() {
  const now = Date.now();
  return {
    id: newId(),
    status: "running",
    startedAt: now,
    lastUpdatedAt: now,
    durationMs: 0,
    steps: [],
  };
}

function traceStepTimestamp(step, trace) {
  if (step.createdAt) {
    const createdAt = new Date(step.createdAt);
    if (!Number.isNaN(createdAt.getTime())) return createdAt;
  }
  const startedAt = Number(trace && trace.startedAt);
  if (step.type === "tool_call" && Number.isFinite(startedAt)) {
    return new Date(startedAt + (Number(step.elapsedMs) || 0));
  }
  return null;
}

function renderTraceStep(step, trace = null) {
  const item = document.createElement("article");
  const stateClass = step.success === true ? "succeeded" : step.success === false ? "failed" : "pending";
  item.className = `trace-step ${step.type} ${stateClass} ${step.streaming ? "streaming" : ""}`.trim();
  item.dataset.traceStepId = step.id;
  const marker = document.createElement("span");
  marker.className = "trace-marker";
  marker.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  content.className = "trace-step-content";
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = step.title;
  const elapsed = document.createElement("span");
  elapsed.className = "trace-step-status";
  const createdAt = traceStepTimestamp(step, trace);
  if (step.streaming) {
    elapsed.textContent = "Streaming";
  } else {
    elapsed.textContent =
      step.type === "tool_call" && createdAt && !Number.isNaN(createdAt.getTime())
        ? formatClockTime(createdAt)
        : `+${formatTraceDuration(step.elapsedMs)}`;
  }
  header.append(title, elapsed);
  const body = document.createElement("div");
  body.className = "trace-step-body";
  if (step.type === "model") {
    body.classList.add("markdown");
    setMarkdown(body, modelDraftDisplayText(step.content));
  } else {
    const message = document.createElement("p");
    message.textContent = step.content;
    body.appendChild(message);
    if (step.args) {
      const args = document.createElement("code");
      args.textContent = JSON.stringify(step.args);
      body.appendChild(args);
    }
  }
  content.append(header, body);
  item.append(marker, content);
  return item;
}

function renderRunTrace(trace, active = false) {
  const row = document.createElement("div");
  row.className = "run-trace-row";
  const details = document.createElement("details");
  details.className = `run-trace ${trace.status}`;
  details.open = true;
  details.dataset.expanded = String(active);
  details.classList.toggle("collapsed", !active);
  const summary = document.createElement("summary");
  summary.setAttribute("aria-expanded", String(active));
  summary.addEventListener("click", (event) => {
    event.preventDefault();
    toggleRunTrace(details);
  });
  const chevron = document.createElement("span");
  chevron.className = "trace-chevron";
  chevron.dataset.icon = "ChevronRight";
  chevron.setAttribute("aria-hidden", "true");
  const summaryLabel = document.createElement("strong");
  summaryLabel.textContent = traceSummary(trace, active);
  const stepCount = document.createElement("span");
  stepCount.className = "trace-count";
  stepCount.textContent = `${trace.steps.length} step${trace.steps.length === 1 ? "" : "s"}`;
  summary.append(chevron, summaryLabel, stepCount);
  const body = document.createElement("div");
  body.className = "run-trace-body";
  const timeline = document.createElement("div");
  timeline.className = "trace-timeline";
  trace.steps.forEach((step) => timeline.appendChild(renderTraceStep(step, trace)));
  const activity = document.createElement("div");
  activity.className = "trace-activity";
  activity.hidden = !active;
  body.append(timeline, activity);
  details.append(summary, body);
  row.appendChild(details);
  messagesEl.appendChild(row);
  refreshIcons(row);
  scrollToLatest();
  return { row, details, summaryLabel, stepCount, timeline, activity };
}

function refreshActiveTraceView() {
  if (!activeTrace || !activeTraceView) return;
  activeTraceView.summaryLabel.textContent = traceSummary(activeTrace, true);
  activeTraceView.stepCount.textContent = `${activeTrace.steps.length} step${activeTrace.steps.length === 1 ? "" : "s"}`;
  activeTraceView.timeline.replaceChildren(...activeTrace.steps.map((step) => renderTraceStep(step, activeTrace)));
  activeTraceView.activity.hidden = false;
  activeTraceView.activity.replaceChildren();
  const indicator = document.createElement("span");
  indicator.className = "pending-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = activeTraceActivity || "Working";
  activeTraceView.activity.append(indicator, text);
  scrollToLatest();
}

function clearRunTraceAnimation(details) {
  const timer = runTraceAnimationTimers.get(details);
  if (timer) window.clearTimeout(timer);
  runTraceAnimationTimers.delete(details);
}

function runTraceBody(details) {
  return details ? details.querySelector(".run-trace-body") : null;
}

function finishRunTraceAnimation(details, body) {
  details.classList.remove("opening", "closing");
  if (body) body.style.maxHeight = "";
  runTraceAnimationTimers.delete(details);
}

function setRunTraceExpanded(details, expanded) {
  details.open = true;
  details.dataset.expanded = String(expanded);
  const summary = details.querySelector("summary");
  if (summary) summary.setAttribute("aria-expanded", String(expanded));
}

function expandRunTrace(details) {
  if (!details || (details.dataset.expanded === "true" && !details.classList.contains("closing"))) return;
  const body = details.querySelector(".run-trace-body");
  if (!body) {
    setRunTraceExpanded(details, true);
    return;
  }
  clearRunTraceAnimation(details);
  body.style.maxHeight = "0px";
  setRunTraceExpanded(details, true);
  details.classList.remove("closing", "collapsed");
  details.classList.add("opening");
  body.getBoundingClientRect();
  requestAnimationFrame(() => {
    body.style.maxHeight = `${body.scrollHeight}px`;
  });
  const timer = window.setTimeout(() => finishRunTraceAnimation(details, body), TRACE_TOGGLE_ANIMATION_MS);
  runTraceAnimationTimers.set(details, timer);
}

function collapseRunTrace(details) {
  if (!details || (details.dataset.expanded === "false" && !details.classList.contains("opening"))) return;
  const body = runTraceBody(details);
  if (!body) {
    setRunTraceExpanded(details, false);
    details.classList.add("collapsed");
    return;
  }
  clearRunTraceAnimation(details);
  details.classList.remove("opening");
  body.style.maxHeight = `${body.scrollHeight}px`;
  body.getBoundingClientRect();
  details.classList.add("closing");
  setRunTraceExpanded(details, false);
  requestAnimationFrame(() => {
    body.style.maxHeight = "0px";
  });
  const timer = window.setTimeout(() => {
    details.classList.add("collapsed");
    finishRunTraceAnimation(details, body);
  }, TRACE_TOGGLE_ANIMATION_MS);
  runTraceAnimationTimers.set(details, timer);
}

function toggleRunTrace(details) {
  if (!details) return;
  if (details.classList.contains("closing")) expandRunTrace(details);
  else if (details.dataset.expanded === "true") collapseRunTrace(details);
  else expandRunTrace(details);
}

function persistActiveTrace() {
  if (!activeTrace || !activeTraceUserMessageId) return;
  activeTrace.lastUpdatedAt = Date.now();
  const session = getSession(pendingSessionId || activeSessionId);
  const userMessage = session.history.find((item) => item.id === activeTraceUserMessageId);
  if (userMessage) userMessage.trace = activeTrace;
  touchSession(session);
  saveSessions();
}

function beginRunTrace(userMessageId) {
  activeTrace = createRunTrace();
  activeTraceUserMessageId = userMessageId;
  activeTraceActivity = "Reading current room state";
  persistActiveTrace();
  activeTraceView = renderRunTrace(activeTrace, true);
  refreshActiveTraceView();
  traceTimer = window.setInterval(() => {
    if (!activeTraceView || !activeTrace) return;
    const liveDuration = Date.now() - activeTrace.startedAt;
    activeTraceView.summaryLabel.textContent = traceSummary(activeTrace, true);
    if (Math.floor(liveDuration / 1000) > Math.floor(activeTrace.durationMs / 1000)) {
      activeTrace.durationMs = liveDuration;
      persistActiveTrace();
    }
  }, 250);
}

function setTraceActivity(activity) {
  activeTraceActivity = activity;
  refreshActiveTraceView();
}

function appendTraceStep(step) {
  if (!activeTrace) return;
  activeTrace.steps.push(
    normalizeTraceStep({
      id: newId(),
      elapsedMs: Date.now() - activeTrace.startedAt,
      createdAt: nowIso(),
      ...step,
    })
  );
  persistActiveTrace();
  refreshActiveTraceView();
}

function finishRunTrace(status) {
  if (!activeTrace) return;
  if (status === "completed" && activeTrace.steps.length === 0) {
    appendTraceStep({ type: "direct", title: "Direct response", content: "Answered without calling room tools." });
  }
  if (status !== "interrupted") failPendingToolCalls(activeTrace.steps, status);
  activeTrace.status = status;
  activeTrace.durationMs = Date.now() - activeTrace.startedAt;
  activeTrace.lastUpdatedAt = Date.now();
  if (traceTimer) window.clearInterval(traceTimer);
  traceTimer = null;
  persistActiveTrace();
  if (activeTraceView) {
    activeTraceView.details.className = `run-trace ${status}`;
    activeTraceView.summaryLabel.textContent = traceSummary(activeTrace);
    activeTraceView.stepCount.textContent = `${activeTrace.steps.length} step${activeTrace.steps.length === 1 ? "" : "s"}`;
    activeTraceView.activity.hidden = true;
    collapseRunTrace(activeTraceView.details);
  }
  activeTrace = null;
  activeTraceView = null;
  activeTraceUserMessageId = null;
  activeTraceActivity = "";
}

function friendlyToolStatus(event) {
  const toolCall = event.payload && event.payload.tool_call;
  const name = toolCall && toolCall.name;
  const args = (toolCall && toolCall.args) || {};
  const statuses = {
    get_room_state: "Checking current room state",
    get_diagnostics: "Checking device diagnostics",
    set_light: `Turning the light ${args.power ? "on" : "off"}`,
    set_fan: `Turning the fan ${args.power ? "on" : "off"}`,
    set_ac_power: `Turning the AC ${args.power ? "on" : "off"}`,
    set_ac_temperature: `Setting AC temperature to ${args.celsius} C`,
    set_ac_mode: `Setting AC mode to ${String(args.mode || "").toLowerCase()}`,
    set_ac_fan_level: `Setting AC fan level to ${args.level}`,
    set_ac_feature: `${args.enabled ? "Enabling" : "Disabling"} AC ${String(args.feature || "feature").toLowerCase()}`,
    advance_light_color: "Changing the light color",
  };
  if (statuses[name]) return `Running: ${statuses[name]}`;
  const fallback = String(name || "room action").replace(/_/g, " ");
  return `Running: ${fallback}`;
}

function updateTraceFromLifecycle(event) {
  const node = event.payload && event.payload.node;
  if (event.phase === "phase_start" && node === "load_state") {
    setTraceActivity("Reading current room state");
  } else if (event.phase === "state_snapshot" && node === "load_state") {
    setTraceActivity("Room state loaded; choosing the next step");
  } else if (event.phase === "model_start") {
    const target = event.payload && event.payload.response_target;
    currentModelStreamTarget = target === "final" ? "final" : target === "pending" ? "pending" : "working";
    if (currentModelStreamTarget === "final") {
      clearPendingModelText();
      clearWorkingModelDraft({ removeStep: true });
      setTraceActivity("Preparing the final response");
    } else {
      setTraceActivity("Deepy is reasoning");
    }
  } else if (event.phase === "model_intermediate") {
    const toolCallCount = Number(event.payload && event.payload.tool_call_count) || 0;
    if (toolCallCount > 0) {
      commitWorkingModelDraft(event.message);
      setTraceActivity("Preparing a tool call");
    } else {
      clearPendingModelText();
      clearWorkingModelDraft({ removeStep: true });
      setTraceActivity("Preparing the final response");
    }
  } else if (event.phase === "tool_call") {
    runHasToolCall = true;
    const toolCall = event.payload && event.payload.tool_call;
    const actionNumber = activeTrace ? activeTrace.steps.filter((step) => step.type === "tool_call").length + 1 : 1;
    appendTraceStep({
      type: "tool_call",
      title: `${actionNumber}. ${friendlyToolStatus(event).replace(/^Running:\s*/, "")}`,
      content: "Waiting for the room controller",
      toolCallId: (toolCall && toolCall.id) || "",
      args: sanitizeTraceValue((toolCall && toolCall.args) || {}),
    });
    setTraceActivity(friendlyToolStatus(event));
  } else if (event.phase === "tool_result") {
    const result = event.payload && event.payload.result;
    const toolCallId = (event.payload && event.payload.tool_call_id) || "";
    const matched = activeTrace && resolveToolResult(activeTrace.steps, {
      toolCallId,
      success: !(result && result.success === false),
      content: event.message,
      elapsedMs: Date.now() - activeTrace.startedAt,
    });
    if (matched) {
      persistActiveTrace();
      refreshActiveTraceView();
    } else {
      appendTraceStep({
        type: "tool_result",
        title: result && result.success === false ? "Unmatched tool failure" : "Unmatched tool result",
        content: event.message,
        toolCallId,
        success: !(result && result.success === false),
      });
    }
    setTraceActivity(result && result.success === false ? "Action failed; preparing a safe response" : "Action completed; verifying room state");
  } else if (event.phase === "phase_start" && node === "load_state_after_tools") {
    setTraceActivity("Verifying the updated room state");
  } else if (event.phase === "state_snapshot" && node === "load_state_after_tools") {
    setTraceActivity("Updated room state verified; preparing the final response");
  }
}

function renderPersistedChat() {
  const session = getSession();
  let approvalRendered = false;
  messagesEl.replaceChildren();
  session.history.forEach((item) => {
    addMessage(item.role, item.content, item.time || "");
    if (item.role === "user" && item.trace) {
      const view = renderRunTrace(item.trace, Boolean(activeTrace && activeTrace.id === item.trace.id));
      if (activeTrace && activeTrace.id === item.trace.id) activeTraceView = view;
    }
    if (
      item.role === "user" &&
      session.pendingApproval &&
      session.pendingApproval.userMessageId === item.id
    ) {
      renderApprovalCard(session);
      approvalRendered = true;
    }
  });
  if (!approvalRendered) renderApprovalCard(session);
  scrollToLatest({ force: true });
}

function renderApprovalCard(session) {
  const approval = session && session.pendingApproval;
  if (!approval) return;
  const card = document.createElement("article");
  card.className = `approval-card ${approval.status}`;
  card.dataset.approval = "turbo";
  const title = document.createElement("strong");
  title.textContent = "AC turbo approval";
  const message = document.createElement("p");
  message.textContent = approval.status === "pending"
    ? "The graph is checkpointed and paused before activating turbo mode."
    : approval.status === "resuming"
      ? "Resuming the saved graph checkpoint…"
      : `Turbo activation ${approval.status}.`;
  card.append(title, message);
  if (approval.status === "pending") {
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "approve-button";
    approve.textContent = "Approve turbo";
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "deny-button";
    deny.textContent = "Deny";
    approve.addEventListener("click", () => resumeApproval(session, true));
    deny.addEventListener("click", () => resumeApproval(session, false));
    actions.append(approve, deny);
    card.appendChild(actions);
  }
  messagesEl.appendChild(card);
}

function addLog(event) {
  const entry = document.createElement("article");
  entry.className = "log-entry";
  entry.style.setProperty("--entry-color", event.color || "#60d6ff");

  const header = document.createElement("header");
  const title = document.createElement("span");
  title.className = "log-title";
  title.textContent = event.heading;
  const phase = document.createElement("span");
  phase.className = "log-phase";
  phase.textContent = event.phase;
  header.append(title, phase);

  const message = document.createElement("p");
  message.className = "log-message";
  message.textContent = event.message;

  entry.append(header, message);
  if (event.payload) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "payload";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(event.payload, null, 2);
    details.append(summary, pre);
    entry.appendChild(details);
  }
  logsEl.appendChild(entry);
  logsEl.scrollTop = logsEl.scrollHeight;
}

function setChip(id, label, value, active, iconName) {
  const chip = document.getElementById(id);
  chip.classList.toggle("on", Boolean(active));
  chip.replaceChildren();
  const icon = document.createElement("span");
  icon.className = "chip-icon";
  icon.dataset.icon = iconName;
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "chip-copy";
  const small = document.createElement("small");
  small.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  copy.append(small, strong);
  chip.append(icon, copy);
  refreshIcons(chip);
}

function setDeviceState(state) {
  if (!state) return;
  setChip("lightChip", "Light", state.light ? "On" : "Off", state.light, "Lightbulb");
  setChip("fanChip", "Fan", state.fan ? "On" : "Off", state.fan, "Fan");
  const ac = state.ac || {};
  const acPower = Boolean(ac.power);
  setChip("acChip", "AC", acPower ? "On" : "Off", acPower, "Snowflake");
  const temperature = ac.temperature ? `${ac.temperature} C` : "-- C";
  const fanLevel = ac.fan_level || ac.fanLevel || "--";
  const mode = ac.mode ? String(ac.mode).toLowerCase() : "auto";
  const acSettings = state.ac ? `${temperature} / L${fanLevel} / ${mode}` : "--";
  setChip("tempChip", "", acSettings, acPower, "Thermometer");
}

function canSendInSession(session) {
  return userMessageCount(session) < MAX_USER_MESSAGES_PER_SESSION;
}

function updateComposerState() {
  const session = getSession();
  const blockedByLimit = !canSendInSession(session);
  const blockedByApproval = Boolean(
    session.pendingApproval && ["pending", "resuming"].includes(session.pendingApproval.status)
  );
  const canStop = isSending && !runReachedTerminal;
  const hasPrompt = Boolean(promptInput.value.trim());
  promptInput.disabled = blockedByLimit || blockedByApproval;
  sendButton.disabled = blockedByLimit || blockedByApproval || isSending || !hasPrompt;
  sendButton.setAttribute("aria-label", "Send message");
  sendTextEl.textContent = "Send";
  setIcon(sendIconEl, "SendHorizontal");
  stopButton.hidden = !canStop;
  limitNoticeEl.hidden = !blockedByLimit;
  messageCountEl.textContent = blockedByApproval
    ? "Waiting for turbo approval"
    : `${userMessageCount(session)} of ${MAX_USER_MESSAGES_PER_SESSION} user messages used`;
}

function renderSessionList() {
  const sortedSessions = [...sessions].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  sessionListEl.replaceChildren();
  sortedSessions.forEach((session) => {
    const row = document.createElement("article");
    row.className = `session-row ${session.id === activeSessionId ? "active" : ""}`.trim();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-item";
    button.disabled = isSending;

    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title || "New chat";

    const meta = document.createElement("span");
    meta.className = "session-meta";
    const count = document.createElement("span");
    count.textContent = `${userMessageCount(session)}/${MAX_USER_MESSAGES_PER_SESSION}`;
    const cost = document.createElement("span");
    cost.textContent = formatCost(session.usageTotals.costUsd);
    const date = document.createElement("span");
    date.textContent = formatSessionTime(session.updatedAt);
    meta.append(count, cost, date);

    button.append(title, meta);
    button.addEventListener("click", () => {
      if (isSending) return;
      activeSessionId = session.id;
      saveSessions();
      renderActiveSession();
    });
    const menuTrigger = document.createElement("button");
    menuTrigger.type = "button";
    menuTrigger.className = "session-menu-trigger";
    menuTrigger.setAttribute("aria-label", `Options for ${session.title || "New chat"}`);
    menuTrigger.disabled = isSending;
    const menuIcon = document.createElement("span");
    menuIcon.className = "button-icon";
    menuIcon.dataset.icon = "MoreVertical";
    menuIcon.setAttribute("aria-hidden", "true");
    menuTrigger.appendChild(menuIcon);

    const menu = document.createElement("div");
    menu.className = "session-menu";
    menu.hidden = true;
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "button-with-icon";
    rename.append(iconSpan("Pencil"), document.createTextNode("Rename"));
    rename.addEventListener("click", () => renameSession(session));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger button-with-icon";
    remove.append(iconSpan("Trash2"), document.createTextNode("Delete"));
    remove.addEventListener("click", () => deleteSession(session));
    menu.append(rename, remove);

    const showMenu = () => {
      if (isSending) return;
      document.querySelectorAll(".session-menu").forEach((item) => {
        if (item !== menu) item.hidden = true;
      });
      menu.hidden = !menu.hidden;
    };
    menuTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      showMenu();
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showMenu();
    });
    row.append(button, menuTrigger, menu);
    sessionListEl.appendChild(row);
    refreshIcons(row);
  });
}

function renameSession(session) {
  if (isSending) return;
  const nextTitle = window.prompt("Rename chat", session.title || "New chat");
  if (!nextTitle) return;
  session.title = nextTitle.trim().slice(0, 60) || "New chat";
  touchSession(session);
  saveSessions();
  renderActiveSession();
}

async function deleteSession(session) {
  if (isSending) return;
  if (!window.confirm(`Delete "${session.title || "New chat"}"?`)) return;
  try {
    const response = await fetch(`/api/threads/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Checkpoint deletion failed with ${response.status}`);
  } catch (error) {
    window.alert(error.message);
    return;
  }
  sessions = sessions.filter((item) => item.id !== session.id);
  if (!sessions.length) sessions.push(createSession());
  if (activeSessionId === session.id) activeSessionId = sessions[0].id;
  saveSessions();
  logsEl.replaceChildren();
  renderActiveSession();
}

function sumUsageTotals(sessionItems) {
  return sessionItems.reduce((totals, session) => {
    const usage = normalizeUsageTotals(session.usageTotals);
    totals.inputTokens += usage.inputTokens;
    totals.cacheHitInputTokens += usage.cacheHitInputTokens;
    totals.cacheMissInputTokens += usage.cacheMissInputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.totalTokens += usage.totalTokens;
    totals.modelCalls += usage.modelCalls;
    totals.costUsd += usage.costUsd;
    totals.cacheHitInputCostUsd += usage.cacheHitInputCostUsd;
    totals.cacheMissInputCostUsd += usage.cacheMissInputCostUsd;
    totals.outputCostUsd += usage.outputCostUsd;
    return totals;
  }, emptyUsageTotals());
}

function grandUsageTotals() {
  return sumUsageTotals(sessions);
}

function renderGrandUsage() {
  const totals = grandUsageTotals();
  grandTokensEl.textContent = formatNumber(totals.totalTokens);
  grandCostEl.textContent = formatCost(totals.costUsd);
}

function renderActiveChatUsage() {
  const session = getSession();
  const totals = session.usageTotals;
  sessionTokensEl.textContent = formatNumber(totals.totalTokens);
  sessionCostEl.textContent = formatCost(totals.costUsd);
}

function renderUsagePanel() {
  const session = getSession();
  const totals = session.usageTotals;
  inputTokensEl.textContent = formatNumber(totals.inputTokens);
  cacheHitTokensEl.textContent = formatNumber(totals.cacheHitInputTokens);
  cacheMissTokensEl.textContent = formatNumber(totals.cacheMissInputTokens);
  outputTokensEl.textContent = formatNumber(totals.outputTokens);
  usageTotalTokensEl.textContent = formatNumber(totals.totalTokens);
  usageTotalCostEl.textContent = formatCost(totals.costUsd);
  modelCallsEl.textContent = formatNumber(totals.modelCalls);

  tokenCallsEl.replaceChildren();
  if (!session.usageCalls.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Token usage will appear after the next model call.";
    tokenCallsEl.appendChild(empty);
    return;
  }

  session.usageCalls.slice(0, 40).forEach((call, index) => {
    const row = document.createElement("article");
    const level = call.total_tokens >= 20000 ? "danger" : call.total_tokens >= 5000 ? "warn" : "";
    row.className = `token-call ${level}`.trim();

    const header = document.createElement("header");
    const title = document.createElement("span");
    title.textContent = `Call #${call.call_index || session.usageCalls.length - index}`;
    const cost = document.createElement("span");
    cost.textContent = formatCost(call.estimated_total_cost_usd);
    header.append(title, cost);

    const grid = document.createElement("div");
    grid.className = "token-grid";
    [
      `hit ${formatNumber(call.cache_hit_input_tokens)}`,
      `miss ${formatNumber(call.cache_miss_input_tokens)}`,
      `out ${formatNumber(call.output_tokens)}`,
      `total ${formatNumber(call.total_tokens)}`,
    ].forEach((text) => {
      const cell = document.createElement("span");
      cell.textContent = text;
      grid.appendChild(cell);
    });

    const costs = document.createElement("div");
    costs.className = "token-costs";
    const model = document.createElement("span");
    model.textContent = call.has_usage === false ? "usage unavailable" : call.model || "model";
    const split = document.createElement("span");
    split.textContent =
      `hit ${formatCost(call.estimated_cache_hit_input_cost_usd)} / ` +
      `miss ${formatCost(call.estimated_cache_miss_input_cost_usd)} / ` +
      `out ${formatCost(call.estimated_output_cost_usd)}`;
    costs.append(model, split);

    row.append(header, grid, costs);
    tokenCallsEl.appendChild(row);
  });
}

function renderUsage() {
  renderGrandUsage();
  renderActiveChatUsage();
  renderUsagePanel();
}

function renderStatusIndicator(status, text) {
  healthEl.className = `status-indicator ${status}`;
  healthEl.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = text;
  healthEl.append(dot, label);
}

function renderActiveSession() {
  const session = getSession();
  activeSessionTitleEl.textContent = session.title || "New chat";
  renderPersistedChat();
  renderUsage();
  renderSessionList();
  updateComposerState();
  refreshThreadStatus(session);
}

async function refreshThreadStatus(session) {
  try {
    const response = await fetch(`/api/threads/${encodeURIComponent(session.id)}`, { cache: "no-store" });
    if (!response.ok) return;
    const status = await response.json();
    if (status.status === "interrupted") {
      const request = Array.isArray(status.interrupts) ? status.interrupts[0] : null;
      session.pendingApproval = {
        status: "pending",
        userMessageId: session.pendingApproval?.userMessageId || session.history.filter((item) => item.role === "user").at(-1)?.id || "",
        payload: { ...status, request },
      };
      saveSessions();
      if (session.id === activeSessionId) {
        renderPersistedChat();
        updateComposerState();
        addLog({
          phase: "checkpoint",
          heading: "Pending Checkpoint Restored",
          message: `Thread ${session.id} is paused for turbo approval.`,
          color: "#59a7ff",
          payload: status,
        });
      }
    } else if (session.pendingApproval && ["pending", "resuming"].includes(session.pendingApproval.status)) {
      session.pendingApproval = null;
      saveSessions();
      if (session.id === activeSessionId) {
        renderPersistedChat();
        updateComposerState();
      }
    }
  } catch (_) {
  }
}

function handleTokenUsage(event) {
  const payload = event.payload || {};
  const call = normalizeCall({
    call_index: payload.call_index,
    model: payload.model,
    has_usage: payload.has_usage,
    input_tokens: payload.input_tokens,
    cache_hit_input_tokens: payload.cache_hit_input_tokens,
    cache_miss_input_tokens: payload.cache_miss_input_tokens,
    output_tokens: payload.output_tokens,
    total_tokens: payload.total_tokens,
    estimated_cache_hit_input_cost_usd: payload.estimated_cache_hit_input_cost_usd,
    estimated_cache_miss_input_cost_usd: payload.estimated_cache_miss_input_cost_usd,
    estimated_output_cost_usd: payload.estimated_output_cost_usd,
    estimated_total_cost_usd: payload.estimated_total_cost_usd,
    created_at: nowIso(),
  });
  const session = getSession(pendingSessionId || activeSessionId);
  if (call.model) session.model = call.model;

  session.usageTotals.inputTokens += call.input_tokens;
  session.usageTotals.cacheHitInputTokens += call.cache_hit_input_tokens;
  session.usageTotals.cacheMissInputTokens += call.cache_miss_input_tokens;
  session.usageTotals.outputTokens += call.output_tokens;
  session.usageTotals.totalTokens += call.total_tokens;
  session.usageTotals.modelCalls += 1;
  session.usageTotals.cacheHitInputCostUsd += call.estimated_cache_hit_input_cost_usd;
  session.usageTotals.cacheMissInputCostUsd += call.estimated_cache_miss_input_cost_usd;
  session.usageTotals.outputCostUsd += call.estimated_output_cost_usd;
  session.usageTotals.costUsd += call.estimated_total_cost_usd;
  session.usageCalls.unshift(call);
  session.usageCalls = session.usageCalls.slice(0, 80);
  touchSession(session);
  saveSessions();
  if (session.id === activeSessionId) {
    renderUsage();
    renderSessionList();
  }
}

function handleLifecycleEvent(event) {
  updateTraceFromLifecycle(event);

  if (event.phase === "token_usage") {
    handleTokenUsage(event);
    return;
  }

  if (event.phase === "model_token") {
    const payloadTarget = event.payload && event.payload.response_target;
    const target =
      payloadTarget === "final" || payloadTarget === "working" || payloadTarget === "pending"
        ? payloadTarget
        : currentModelStreamTarget;
    if (target === "final") {
      appendStreamingAssistantToken(event.message);
    } else if (target === "pending") {
      appendPendingModelToken(event.message);
    } else {
      appendWorkingModelToken(event.message);
    }
    return;
  }

  addLog(event);

  if (event.phase === "approval_required") {
    const approvalUserMessageId = activeTraceUserMessageId;
    clearPendingModelText();
    clearWorkingModelDraft({ removeStep: true });
    finishRunTrace("interrupted");
    runReachedTerminal = true;
    const session = getSession(pendingSessionId || activeSessionId);
    session.pendingApproval = {
      status: "pending",
      userMessageId: approvalUserMessageId || session.history.filter((item) => item.role === "user").at(-1)?.id || "",
      payload: event.payload || {},
    };
    touchSession(session);
    pendingSessionId = null;
    saveSessions();
    if (session.id === activeSessionId) renderPersistedChat();
    renderSessionList();
    updateComposerState();
    return;
  }

  if (event.phase === "approval_decision") {
    const session = getSession(pendingSessionId || activeSessionId);
    if (session.pendingApproval) {
      session.pendingApproval.status = event.payload && event.payload.approved ? "approved" : "denied";
      touchSession(session);
      saveSessions();
    }
  }

  if (event.phase === "state_snapshot" && event.payload && event.payload.state) {
    setDeviceState(event.payload.state);
  }

  if (event.phase === "final") {
    const finalText = String(event.message || "");
    clearPendingModelText();
    clearWorkingModelDraft({ removeStep: true });
    finishRunTrace("completed");
    finalizeAssistantMessage(finalText);
    runReachedTerminal = true;
    const session = getSession(pendingSessionId || activeSessionId);
    if (session.pendingApproval && session.pendingApproval.status === "resuming") {
      session.pendingApproval.status = "approved";
    }
    session.history.push({ id: newId(), role: "assistant", content: finalText, time: formatTime(), trace: null });
    session.history = trimHistoryToUserLimit(session.history);
    touchSession(session);
    pendingSessionId = null;
    saveSessions();
    renderSessionList();
    updateComposerState();
    refreshDeviceState();
  }

  if (event.phase === "error") {
    if (event.heading === "State Load Failed") {
      setTraceActivity("Room state unavailable; preparing a safe response");
    } else {
      clearPendingModelText();
      clearWorkingModelDraft({ removeStep: true });
      appendTraceStep({ type: "error", title: "Run error", content: event.message, success: false });
      finishRunTrace("error");
      addMessage("error", event.message);
      runReachedTerminal = true;
      pendingSessionId = null;
      updateComposerState();
    }
  }
}

function parseSseBlock(block) {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (!dataLines.length) return null;
  return JSON.parse(dataLines.join("\n"));
}

async function sendPrompt(prompt, sessionId, userMessageId, historyForRequest) {
  pendingSessionId = sessionId;
  runHasToolCall = false;
  runReachedTerminal = false;
  currentModelStreamTarget = "pending";
  resetStreamingAssistant();
  logsEl.replaceChildren();
  isSending = true;
  currentAbortController = new AbortController();
  beginRunTrace(userMessageId);
  updateComposerState();
  renderSessionList();
  try {
    await consumeLifecycleStream("/api/chat", {
      thread_id: sessionId,
      prompt,
      history: historyForRequest,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      clearPendingModelText();
      clearWorkingModelDraft({ removeStep: true });
      finishRunTrace("stopped");
      runReachedTerminal = true;
      addLog({ phase: "stopped", heading: "Response Stopped", message: "Streaming was stopped by you.", color: "#f6c96a" });
      refreshDeviceState();
    } else {
      clearPendingModelText();
      clearWorkingModelDraft({ removeStep: true });
      appendTraceStep({ type: "error", title: "Connection error", content: error.message, success: false });
      finishRunTrace("error");
      addMessage("error", error.message);
      runReachedTerminal = true;
    }
    pendingSessionId = null;
  } finally {
    if (!runReachedTerminal && activeTrace) {
      clearPendingModelText();
      clearWorkingModelDraft({ removeStep: true });
      appendTraceStep({ type: "error", title: "Incomplete response", content: "Deepy did not produce a final answer.", success: false });
      finishRunTrace("error");
      addMessage("error", "The response ended before Deepy produced a final answer.");
    }
    isSending = false;
    currentAbortController = null;
    updateComposerState();
    renderSessionList();
    if (!promptInput.disabled) promptInput.focus();
  }
}

async function consumeLifecycleStream(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: currentAbortController.signal,
  });
  if (!response.ok || !response.body) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload.detail ? `: ${payload.detail}` : "";
    } catch (_) {
    }
    throw new Error(`Chat request failed with ${response.status}${detail}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseBlock(block);
      if (event) handleLifecycleEvent(event);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function resumeRunTrace(session, userMessageId) {
  const userMessage = session.history.find((item) => item.id === userMessageId && item.role === "user");
  if (!userMessage || !userMessage.trace) return;
  userMessage.trace = normalizeRunTrace(userMessage.trace);
  userMessage.trace.status = "running";
  userMessage.trace.lastUpdatedAt = Date.now();
  activeTrace = userMessage.trace;
  activeTraceUserMessageId = userMessageId;
  activeTraceActivity = "Resuming saved LangGraph checkpoint";
  renderPersistedChat();
}

async function resumeApproval(session, approved) {
  if (isSending || !session.pendingApproval || session.pendingApproval.status !== "pending") return;
  const previousStatus = session.pendingApproval.status;
  session.pendingApproval.status = "resuming";
  touchSession(session);
  saveSessions();
  pendingSessionId = session.id;
  runReachedTerminal = false;
  currentModelStreamTarget = "pending";
  resetStreamingAssistant();
  isSending = true;
  currentAbortController = new AbortController();
  resumeRunTrace(session, session.pendingApproval.userMessageId);
  updateComposerState();
  renderSessionList();
  try {
    await consumeLifecycleStream("/api/chat/resume", {
      thread_id: session.id,
      approved,
    });
  } catch (error) {
    session.pendingApproval.status = previousStatus;
    saveSessions();
    clearPendingModelText();
    clearWorkingModelDraft({ removeStep: true });
    if (activeTrace) finishRunTrace("interrupted");
    addMessage("error", error.message);
    runReachedTerminal = true;
    pendingSessionId = null;
  } finally {
    if (!runReachedTerminal && activeTrace) {
      finishRunTrace("interrupted");
      session.pendingApproval.status = "pending";
      saveSessions();
    }
    isSending = false;
    currentAbortController = null;
    renderPersistedChat();
    updateComposerState();
    renderSessionList();
  }
}

async function refreshDeviceState() {
  try {
    const response = await fetch("/api/device-state", { cache: "no-store" });
    if (response.ok) setDeviceState(await response.json());
  } catch (_) {
  }
}

async function refreshHealth() {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    const health = await response.json();
    renderStatusIndicator(health.ok ? "ok" : "warn", health.ok ? "Ready" : "Setup");
    if (health.settings) {
      modelNameEl.textContent = health.settings.deepseek_model || "--";
      renderUsage();
    }
  } catch (_) {
    renderStatusIndicator("warn", "Offline");
  }
}

function autoSizePrompt() {
  if (promptInput.style.height) return;
  const height = `${Math.min(Math.max(promptInput.scrollHeight, 52), 132)}px`;
  promptInput.style.height = height;
  promptPreviewEl.style.height = height;
}

function expandedComposerHeight() {
  const chatPanel = composer.closest(".chat-panel");
  const panelHeight = chatPanel ? chatPanel.clientHeight : Math.floor(window.innerHeight * 0.75);
  return Math.max(180, Math.min(360, Math.floor(panelHeight * 0.48)));
}

function applyComposerHeight() {
  const height = composerExpanded ? expandedComposerHeight() : 112;
  promptInput.style.height = `${height}px`;
  promptPreviewEl.style.height = `${height}px`;
  updateScrollLatestButton();
}

function updateComposerExpandButton() {
  if (!composerExpandEl) return;
  composerExpandEl.setAttribute("aria-pressed", String(composerExpanded));
  composerExpandEl.setAttribute("aria-label", composerExpanded ? "Collapse message editor" : "Expand message editor");
  composerExpandEl.title = composerExpanded ? "Collapse message editor" : "Expand message editor";
  setIcon(composerExpandEl.querySelector("[data-icon]"), composerExpanded ? "Minimize2" : "Maximize2");
}

function toggleComposerHeight() {
  composerExpanded = !composerExpanded;
  applyComposerHeight();
  updateComposerExpandButton();
}

function collapseComposer() {
  composerExpanded = false;
  applyComposerHeight();
  updateComposerExpandButton();
}

function setComposerMode(mode, { focus = true } = {}) {
  const previewing = mode === "preview";
  writeTabEl.classList.toggle("active", !previewing);
  previewTabEl.classList.toggle("active", previewing);
  writeTabEl.setAttribute("aria-selected", String(!previewing));
  previewTabEl.setAttribute("aria-selected", String(previewing));
  promptInput.hidden = previewing;
  promptInput.required = !previewing;
  promptPreviewEl.hidden = !previewing;
  if (previewing) {
    const markdown = promptInput.value.trim();
    setMarkdown(promptPreviewEl, markdown || "*Nothing to preview yet.*");
  } else if (focus && !promptInput.disabled) {
    promptInput.focus();
  }
}

function insertVoiceTranscript(transcript) {
  const spokenText = String(transcript || "").trim();
  if (!spokenText || promptInput.disabled) return false;
  const currentDraft = promptInput.value.trim();
  promptInput.value = currentDraft ? `${currentDraft}\n${spokenText}` : spokenText;
  setComposerMode("write", { focus: false });
  promptInput.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (isSending) return;
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  const session = getSession();
  if (!canSendInSession(session)) {
    updateComposerState();
    return;
  }

  const historyForRequest = requestHistory(session.history);
  if (userMessageCount(session) === 0 || session.title === "New chat") {
    session.title = deriveTitle(prompt);
  }

  addMessage("user", prompt, formatTime(), { forceScroll: true, smoothScroll: true });
  const userMessage = { id: newId(), role: "user", content: prompt, time: formatTime(), trace: null };
  session.history.push(userMessage);
  session.history = trimHistoryToUserLimit(session.history);
  touchSession(session);
  saveSessions();
  renderSessionList();
  updateComposerState();

  promptInput.value = "";
  setComposerMode("write");
  collapseComposer();
  updateComposerState();
  sendPrompt(prompt, session.id, userMessage.id, historyForRequest);
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

promptInput.addEventListener("input", () => {
  autoSizePrompt();
  updateComposerState();
  if (!promptPreviewEl.hidden) setMarkdown(promptPreviewEl, promptInput.value.trim() || "*Nothing to preview yet.*");
});

writeTabEl.addEventListener("click", () => setComposerMode("write"));
previewTabEl.addEventListener("click", () => setComposerMode("preview"));
composerExpandEl.addEventListener("click", toggleComposerHeight);
window.addEventListener("resize", () => {
  if (composerExpanded) applyComposerHeight();
});

document.getElementById("newChat").addEventListener("click", () => {
  if (isSending) return;
  const session = createSession();
  sessions.unshift(session);
  activeSessionId = session.id;
  saveSessions();
  logsEl.replaceChildren();
  renderActiveSession();
  promptInput.focus();
});

stopButton.addEventListener("click", (event) => {
  event.preventDefault();
  if (!isSending || runReachedTerminal) return;
  if (currentAbortController) currentAbortController.abort();
});

messagesEl.addEventListener("wheel", (event) => {
  if (event.deltaY < 0) pauseAutoFollowForUserScroll();
}, { passive: true });
messagesEl.addEventListener("touchstart", (event) => {
  lastTouchY = event.touches && event.touches.length ? event.touches[0].clientY : null;
}, { passive: true });
messagesEl.addEventListener("touchmove", (event) => {
  const touch = event.touches && event.touches.length ? event.touches[0] : null;
  if (touch && lastTouchY !== null && touch.clientY > lastTouchY) pauseAutoFollowForUserScroll();
  if (touch) lastTouchY = touch.clientY;
}, { passive: true });
messagesEl.addEventListener("scroll", handleMessagesScroll);

scrollLatestButton.addEventListener("click", () => {
  scrollToLatest({ force: true });
});

function selectInspectorTab(name) {
  const usageActive = name === "usage";
  usagePanel.hidden = !usageActive;
  workflowPanel.hidden = usageActive;
  usageTab.classList.toggle("active", usageActive);
  workflowTab.classList.toggle("active", !usageActive);
  usageTab.setAttribute("aria-selected", String(usageActive));
  workflowTab.setAttribute("aria-selected", String(!usageActive));
}

usageTab.addEventListener("click", () => selectInspectorTab("usage"));
workflowTab.addEventListener("click", () => selectInspectorTab("workflow"));

document.addEventListener("click", (event) => {
  if (!event.target.closest(".session-row")) {
    document.querySelectorAll(".session-menu").forEach((menu) => {
      menu.hidden = true;
    });
  }
});

function openVoiceModal() {
  if (!voiceModalEl) return;
  voiceModalEl.hidden = false;
  document.body.classList.add("modal-open");
  voiceLauncherEl.setAttribute("aria-expanded", "true");
  window.requestAnimationFrame(() => voiceCloseEl.focus());
}

function closeVoiceModal() {
  if (!voiceModalEl || voiceModalEl.hidden) return;
  voiceModalEl.hidden = true;
  document.body.classList.remove("modal-open");
  voiceLauncherEl.setAttribute("aria-expanded", "false");
  voiceLauncherEl.focus();
}

if (voiceLauncherEl && voiceModalEl) {
  voiceLauncherEl.addEventListener("click", openVoiceModal);
  voiceCloseEl.addEventListener("click", closeVoiceModal);
  voiceModalEl.addEventListener("click", (event) => {
    if (event.target === voiceModalEl) closeVoiceModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !voiceModalEl.hidden) closeVoiceModal();
  });
}

let voiceModeController = null;
if (window.RoomVoiceMode && voiceToggleEl) {
  voiceModeController = window.RoomVoiceMode.createVoiceModeController({
    windowRef: window,
    documentRef: document,
    button: voiceToggleEl,
    buttonText: voiceToggleTextEl,
    clearButton: voiceClearEl,
    launcher: voiceLauncherEl,
    strip: voiceStripEl,
    status: voiceStatusEl,
    statusDetail: voiceStatusDetailEl,
    heard: voiceHeardEl,
    alternatives: voiceAlternativesEl,
    transcript: voiceTranscriptEl,
    engineStatus: voiceEngineStatusEl,
    restartCount: voiceRestartCountEl,
    latency: voiceLatencyEl,
    activity: voiceActivityEl,
  });
  voiceModeController.init();
}

collapseComposer();
renderActiveSession();
refreshIcons();
refreshHealth();
refreshDeviceState();
setInterval(refreshDeviceState, 5000);

window.RoomApp = {
  formatTraceDuration,
  grandUsageTotals,
  sumUsageTotals,
  normalizeUsageTotals,
  handleLifecycleEvent,
  resetStreamingAssistant,
  collapseComposer,
  userMessageCount,
  trimHistoryToUserLimit,
  requestHistory,
  shouldAutoFollow,
  scrollToLatest,
  updateScrollLatestButton,
  formatClockTime,
  beginRunTrace,
  collapseRunTrace,
  expandRunTrace,
  toggleRunTrace,
  renderRunTrace,
  insertVoiceTranscript,
  openVoiceModal,
  closeVoiceModal,
  voiceModeController,
};
