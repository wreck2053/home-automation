const messagesEl = document.getElementById("messages");
const logsEl = document.getElementById("logs");
const composer = document.getElementById("composer");
const promptInput = document.getElementById("prompt");
const promptPreviewEl = document.getElementById("promptPreview");
const writeTabEl = document.getElementById("writeTab");
const previewTabEl = document.getElementById("previewTab");
const composerExpandEl = document.getElementById("composerExpand");
const sendButton = document.getElementById("send");
const sendTextEl = document.getElementById("sendText");
const sendIconEl = document.getElementById("sendIcon");
const healthEl = document.getElementById("health");
const railEl = document.getElementById("workflowRail");
const modelNameEl = document.getElementById("modelName");
const sessionTokensEl = document.getElementById("sessionTokens");
const sessionCostEl = document.getElementById("sessionCost");
const headerMessageCountEl = document.getElementById("headerMessageCount");
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
const pricingLabelEl = document.getElementById("pricingLabel");
const workflowDetailKickerEl = document.getElementById("workflowDetailKicker");
const workflowDetailTitleEl = document.getElementById("workflowDetailTitle");
const workflowDetailMessageEl = document.getElementById("workflowDetailMessage");
const workflowDetailActualEl = document.getElementById("workflowDetailActual");
const usagePanel = document.getElementById("usagePanel");
const workflowPanel = document.getElementById("workflowPanel");
const usageTab = document.getElementById("usageTab");
const workflowTab = document.getElementById("workflowTab");
const { setMarkdown } = window.RoomMarkdown;
const { resolveToolResult, failPendingToolCalls } = window.RoomToolProgress;

const MAX_MESSAGES_PER_SESSION = 20;

const STORAGE_KEYS = {
  sessions: "roomAssistant.sessions.v1",
  activeSessionId: "roomAssistant.activeSessionId.v1",
  legacyHistory: "roomAssistant.chatHistory.v2",
  legacyUsageTotals: "roomAssistant.usageTotals.v1",
  legacyUsageCalls: "roomAssistant.usageCalls.v1",
};

const WORKFLOW_ORDER = ["load_state", "model", "tools", "load_state_after_tools", "final"];

const WORKFLOW_DETAILS = {
  load_state: {
    title: "Load state",
    message: "This reads the live ESP32 state before Deepsy decides what to do.",
  },
  model: {
    title: "Model",
    message: "This is the model decision point: reply normally or request a room-control tool.",
  },
  tools: {
    title: "Tools",
    message: "This runs only when the model requested a known room-control tool.",
  },
  load_state_after_tools: {
    title: "Refresh state",
    message: "After an action, this verifies the device state before the final answer is written.",
  },
  final: {
    title: "Final reply",
    message: "This is the answer returned to chat after the graph has finished.",
  },
};

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
let sessions = loadSessions();
let activeSessionId = loadActiveSessionId();
let selectedWorkflowStep = "load_state";
let workflowEvents = {};
let composerExpanded = false;

// Persist normalized sessions so saved Flash calls are repriced with Flash rates on reload.
saveSessions();

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
    model: "",
    usageTotals: emptyUsageTotals(),
    usageCalls: [],
  };
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
  return {
    id: String(source.id || newId()),
    type: allowedTypes.has(source.type) ? source.type : "model",
    title: String(source.title || "Agent step"),
    content: String(source.content || ""),
    toolCallId: String(source.toolCallId || ""),
    args: source.args && typeof source.args === "object" ? sanitizeTraceValue(source.args) : null,
    success: typeof source.success === "boolean" ? source.success : null,
    elapsedMs: Math.max(0, Number(source.elapsedMs) || 0),
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
  return {
    id: String(raw.id || newId()),
    status,
    startedAt,
    lastUpdatedAt,
    durationMs,
    steps: Array.isArray(raw.steps) ? raw.steps.map(normalizeTraceStep) : [],
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
    ? session.history
        .filter((item) => item && (item.role === "user" || item.role === "assistant"))
        .map((item) => ({
          id: String(item.id || newId()),
          role: item.role,
          content: String(item.content || ""),
          time: item.time || "",
          trace: item.role === "user" ? normalizeRunTrace(item.trace) : null,
        }))
        .filter((item) => item.content)
        .slice(-MAX_MESSAGES_PER_SESSION)
    : [];
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
  session.history = Array.isArray(history) ? history.slice(-MAX_MESSAGES_PER_SESSION) : [];
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

function addMessage(role, text, timestamp = formatTime()) {
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
  label.textContent = role === "user" ? "You" : role === "error" ? "Error" : "Deepsy";
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
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { row, avatar, bubble, label, body };
}

function formatTraceDuration(durationMs) {
  return `${(Math.max(0, durationMs) / 1000).toFixed(1)} seconds`;
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

function renderTraceStep(step) {
  const item = document.createElement("article");
  const stateClass = step.success === true ? "succeeded" : step.success === false ? "failed" : "pending";
  item.className = `trace-step ${step.type} ${stateClass}`.trim();
  const marker = document.createElement("span");
  marker.className = "trace-marker";
  marker.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  content.className = "trace-step-content";
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = step.title;
  const elapsed = document.createElement("span");
  elapsed.textContent = `+${formatTraceDuration(step.elapsedMs)}`;
  header.append(title, elapsed);
  const body = document.createElement("div");
  body.className = "trace-step-body";
  if (step.type === "model") {
    body.classList.add("markdown");
    setMarkdown(body, step.content);
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
  details.open = active;
  const summary = document.createElement("summary");
  const chevron = document.createElement("span");
  chevron.className = "trace-chevron";
  chevron.textContent = ">";
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
  trace.steps.forEach((step) => timeline.appendChild(renderTraceStep(step)));
  const activity = document.createElement("div");
  activity.className = "trace-activity";
  activity.hidden = !active;
  body.append(timeline, activity);
  details.append(summary, body);
  row.appendChild(details);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { row, details, summaryLabel, stepCount, timeline, activity };
}

function refreshActiveTraceView() {
  if (!activeTrace || !activeTraceView) return;
  activeTraceView.summaryLabel.textContent = traceSummary(activeTrace, true);
  activeTraceView.stepCount.textContent = `${activeTrace.steps.length} step${activeTrace.steps.length === 1 ? "" : "s"}`;
  activeTraceView.timeline.replaceChildren(...activeTrace.steps.map(renderTraceStep));
  activeTraceView.activity.hidden = false;
  activeTraceView.activity.replaceChildren();
  const indicator = document.createElement("span");
  indicator.className = "pending-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = activeTraceActivity || "Working";
  activeTraceView.activity.append(indicator, text);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  failPendingToolCalls(activeTrace.steps, status);
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
    activeTraceView.details.open = false;
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
    setTraceActivity(runHasToolCall || event.heading === "Model Response" ? "Preparing the final response" : "Deepsy is reasoning");
  } else if (event.phase === "model_intermediate") {
    setTraceActivity("Preparing a tool call");
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
  messagesEl.replaceChildren();
  session.history.forEach((item) => {
    addMessage(item.role, item.content, item.time || "");
    if (item.role === "user" && item.trace) renderRunTrace(item.trace, false);
  });
}

function resetWorkflow() {
  workflowEvents = {};
  railEl.querySelectorAll("[data-step]").forEach((item) => {
    item.classList.remove("active", "completed");
  });
  renderWorkflowDetail();
}

function setActiveStep(step) {
  const activeIndex = WORKFLOW_ORDER.indexOf(step);
  railEl.querySelectorAll("[data-step]").forEach((item) => {
    const itemIndex = WORKFLOW_ORDER.indexOf(item.dataset.step);
    item.classList.toggle("active", item.dataset.step === step);
    item.classList.toggle("completed", activeIndex > itemIndex && itemIndex >= 0);
  });
}

function renderWorkflowDetail(step = selectedWorkflowStep) {
  const detail = WORKFLOW_DETAILS[step] || WORKFLOW_DETAILS.load_state;
  const events = workflowEvents[step] || [];
  workflowDetailKickerEl.textContent = events.length ? `${events.length} event${events.length === 1 ? "" : "s"} in this run` : "Awaiting a run";
  workflowDetailTitleEl.textContent = detail.title;
  workflowDetailMessageEl.textContent = detail.message;
  renderWorkflowActual(step, events);

  railEl.querySelectorAll("[data-step]").forEach((item) => {
    const isSelected = item.dataset.step === step;
    item.classList.toggle("selected", isSelected);
    item.setAttribute("aria-pressed", String(isSelected));
  });
}

function recordWorkflowEvent(event, step) {
  workflowEvents[step] = workflowEvents[step] || [];
  workflowEvents[step].push(event);
  if (selectedWorkflowStep === step) renderWorkflowDetail(step);
}

function addWorkflowActual(label, value, tone = "") {
  const row = document.createElement("div");
  row.className = `workflow-actual-row ${tone}`.trim();
  const key = document.createElement("span");
  key.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value;
  row.append(key, content);
  workflowDetailActualEl.appendChild(row);
}

function describeRoomState(state) {
  if (!state || typeof state !== "object") return "State was unavailable.";
  const ac = state.ac || {};
  const acText = ac.power ? `on, ${ac.temperature || "?"} C, fan level ${ac.fan_level || ac.fanLevel || "?"}` : "off";
  return `Light ${state.light ? "on" : "off"}; fan ${state.fan ? "on" : "off"}; AC ${acText}.`;
}

function toolCallDescription(event) {
  const toolCall = event.payload && event.payload.tool_call;
  if (!toolCall) return event.message || "Tool request recorded.";
  const args = toolCall.args && Object.keys(toolCall.args).length ? ` with ${JSON.stringify(toolCall.args)}` : "";
  return `${toolCall.name || "tool"}${args}`;
}

function renderWorkflowActual(step, events) {
  workflowDetailActualEl.replaceChildren();
  if (!events.length) {
    addWorkflowActual("What happened", "No event for this step in the current run yet.");
    return;
  }

  const latest = events[events.length - 1];
  if (step === "load_state" || step === "load_state_after_tools") {
    const snapshot = [...events].reverse().find((event) => event.phase === "state_snapshot");
    addWorkflowActual("Result", snapshot ? describeRoomState(snapshot.payload && snapshot.payload.state) : latest.message);
    addWorkflowActual("Learning", step === "load_state" ? "This snapshot becomes context for the first model decision." : "This verifies the action before Deepsy writes the final response.");
    return;
  }

  if (step === "model") {
    const start = [...events].reverse().find((event) => event.phase === "model_start" && event.payload && event.payload.message_count);
    const calls = events.filter((event) => event.phase === "tool_call");
    const answer = [...events].reverse().find((event) => event.heading === "Model Response");
    const usage = [...events].reverse().find((event) => event.phase === "token_usage");
    if (start) addWorkflowActual("Context", `${start.payload.message_count} message(s) plus system instructions, room state, and tool schemas.`);
    if (calls.length) addWorkflowActual("Decision", calls.map(toolCallDescription).join("; "), "action");
    else if (answer) addWorkflowActual("Decision", "Answered directly; no device tool was requested.", "success");
    if (answer) addWorkflowActual("Model output", answer.message);
    if (usage && usage.payload) addWorkflowActual("Tokens", `Call #${usage.payload.call_index}: ${usage.payload.cache_hit_input_tokens || 0} cached, ${usage.payload.cache_miss_input_tokens || 0} new input, ${usage.payload.output_tokens || 0} output.`);
    return;
  }

  if (step === "tools") {
    const calls = events.filter((event) => event.phase === "tool_call");
    const results = events.filter((event) => event.phase === "tool_result");
    calls.forEach((event) => addWorkflowActual("Requested", toolCallDescription(event), "action"));
    results.forEach((event) => addWorkflowActual("Result", event.message, event.message.startsWith("OK:") ? "success" : "error"));
    if (!calls.length && !results.length) addWorkflowActual("What happened", latest.message);
    return;
  }

  if (step === "final") {
    addWorkflowActual("Sent to chat", latest.message || "Final response completed.", "success");
    addWorkflowActual("Learning", "This is the completed graph output, not an additional device action.");
    return;
  }

  addWorkflowActual("Latest event", latest.message || latest.phase);
}

function eventStep(event) {
  if (event.phase === "tool_call" || event.phase === "tool_result") return "tools";
  if (event.phase === "final") return "final";
  const node = event.payload && event.payload.node;
  if (node) return node;
  if (event.phase === "token_usage" || event.phase.startsWith("model")) return "model";
  return null;
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

function setChip(id, label, value, active) {
  const chip = document.getElementById(id);
  chip.classList.toggle("on", Boolean(active));
  chip.replaceChildren();
  const small = document.createElement("small");
  small.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  chip.append(small, strong);
}

function setDeviceState(state) {
  if (!state) return;
  setChip("lightChip", "Light", state.light ? "On" : "Off", state.light);
  setChip("fanChip", "Fan", state.fan ? "On" : "Off", state.fan);
  setChip("acChip", "AC", state.ac && state.ac.power ? "On" : "Off", state.ac && state.ac.power);
  const temp = state.ac ? `${state.ac.temperature} C / L${state.ac.fan_level || state.ac.fanLevel || "--"}` : "--";
  setChip("tempChip", "Climate", temp, Boolean(state.ac && state.ac.power));
}

function canSendInSession(session) {
  return session.history.length <= MAX_MESSAGES_PER_SESSION - 2;
}

function updateComposerState() {
  const session = getSession();
  const blockedByLimit = !canSendInSession(session);
  const canStop = isSending && !runReachedTerminal;
  promptInput.disabled = blockedByLimit;
  sendButton.disabled = blockedByLimit || (isSending && runReachedTerminal);
  sendButton.classList.toggle("stop-mode", canStop);
  sendButton.setAttribute("aria-label", canStop ? "Stop response" : "Send message");
  sendTextEl.textContent = canStop ? "Stop" : "Send";
  sendIconEl.textContent = canStop ? "\u25a0" : "\u25b6";
  limitNoticeEl.hidden = !blockedByLimit;
  headerMessageCountEl.textContent = `${session.history.length}/${MAX_MESSAGES_PER_SESSION}`;
  messageCountEl.textContent = `${session.history.length} of ${MAX_MESSAGES_PER_SESSION} messages used`;
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
    count.textContent = `${session.history.length}/${MAX_MESSAGES_PER_SESSION}`;
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
    menuTrigger.textContent = "\u22ee";
    menuTrigger.setAttribute("aria-label", `Options for ${session.title || "New chat"}`);
    menuTrigger.disabled = isSending;

    const menu = document.createElement("div");
    menu.className = "session-menu";
    menu.hidden = true;
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "Rename";
    rename.addEventListener("click", () => renameSession(session));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
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

function deleteSession(session) {
  if (isSending) return;
  if (!window.confirm(`Delete "${session.title || "New chat"}"?`)) return;
  sessions = sessions.filter((item) => item.id !== session.id);
  if (!sessions.length) sessions.push(createSession());
  if (activeSessionId === session.id) activeSessionId = sessions[0].id;
  saveSessions();
  logsEl.replaceChildren();
  resetWorkflow();
  renderActiveSession();
}

function renderUsage() {
  const session = getSession();
  const totals = session.usageTotals;
  const activeModel = session.model || modelNameEl.textContent;
  const pricing = modelPricing(activeModel);
  pricingLabelEl.textContent = pricing ? `${pricing.label} estimate` : "Model cost estimate unavailable";
  sessionTokensEl.textContent = formatNumber(totals.totalTokens);
  sessionCostEl.textContent = formatCost(totals.costUsd);
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

function renderActiveSession() {
  const session = getSession();
  activeSessionTitleEl.textContent = session.title || "New chat";
  renderPersistedChat();
  renderUsage();
  renderSessionList();
  updateComposerState();
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
  const step = eventStep(event);
  if (step) {
    setActiveStep(step);
    if (event.phase !== "model_token") recordWorkflowEvent(event, step);
  }

  updateTraceFromLifecycle(event);

  if (event.phase === "token_usage") {
    handleTokenUsage(event);
    return;
  }

  if (event.phase === "model_token") return;

  addLog(event);

  if (event.phase === "state_snapshot" && event.payload && event.payload.state) {
    setDeviceState(event.payload.state);
  }

  if (event.phase === "final") {
    finishRunTrace("completed");
    addMessage("assistant", event.message);
    runReachedTerminal = true;
    const session = getSession(pendingSessionId || activeSessionId);
    session.history.push({ id: newId(), role: "assistant", content: event.message, time: formatTime(), trace: null });
    session.history = session.history.slice(-MAX_MESSAGES_PER_SESSION);
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
  resetWorkflow();
  isSending = true;
  currentAbortController = new AbortController();
  beginRunTrace(userMessageId);
  updateComposerState();
  renderSessionList();
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, history: historyForRequest }),
      signal: currentAbortController.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Chat request failed with ${response.status}`);
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
  } catch (error) {
    if (error.name === "AbortError") {
      finishRunTrace("stopped");
      runReachedTerminal = true;
      addLog({ phase: "stopped", heading: "Response Stopped", message: "Streaming was stopped by you.", color: "#f6c96a" });
      refreshDeviceState();
    } else {
      appendTraceStep({ type: "error", title: "Connection error", content: error.message, success: false });
      finishRunTrace("error");
      addMessage("error", error.message);
      runReachedTerminal = true;
    }
    pendingSessionId = null;
  } finally {
    if (!runReachedTerminal && activeTrace) {
      appendTraceStep({ type: "error", title: "Incomplete response", content: "Deepsy did not produce a final answer.", success: false });
      finishRunTrace("error");
      addMessage("error", "The response ended before Deepsy produced a final answer.");
    }
    isSending = false;
    currentAbortController = null;
    updateComposerState();
    renderSessionList();
    if (!promptInput.disabled) promptInput.focus();
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
    healthEl.textContent = health.ok ? "Ready" : "Check setup";
    healthEl.className = `status-pill ${health.ok ? "ok" : "warn"}`;
    if (health.settings) {
      modelNameEl.textContent = health.settings.deepseek_model || "--";
      renderUsage();
    }
  } catch (_) {
    healthEl.textContent = "Offline";
    healthEl.className = "status-pill warn";
  }
}

function autoSizePrompt() {
  applyComposerHeight();
}

function expandedComposerHeight() {
  const chatPanel = composer.closest(".chat-panel");
  const panelHeight = chatPanel ? chatPanel.clientHeight : Math.floor(window.innerHeight * 0.75);
  return Math.max(180, Math.min(360, Math.floor(panelHeight * 0.48)));
}

function applyComposerHeight() {
  const pixels = `${composerExpanded ? expandedComposerHeight() : 112}px`;
  promptInput.style.height = pixels;
  promptPreviewEl.style.height = pixels;
}

function toggleComposerHeight() {
  composerExpanded = !composerExpanded;
  composerExpandEl.setAttribute("aria-pressed", String(composerExpanded));
  composerExpandEl.setAttribute("aria-label", composerExpanded ? "Collapse message editor" : "Expand message editor");
  composerExpandEl.title = composerExpanded ? "Collapse message editor" : "Expand message editor";
  composerExpandEl.querySelector("span").textContent = composerExpanded ? "⤡" : "⤢";
  applyComposerHeight();
}

function setComposerMode(mode) {
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
  } else if (!promptInput.disabled) {
    promptInput.focus();
  }
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

  const historyForRequest = session.history
    .slice(-MAX_MESSAGES_PER_SESSION)
    .map((item) => ({ role: item.role, content: item.content }));
  if (session.history.length === 0 || session.title === "New chat") {
    session.title = deriveTitle(prompt);
  }

  addMessage("user", prompt);
  const userMessage = { id: newId(), role: "user", content: prompt, time: formatTime(), trace: null };
  session.history.push(userMessage);
  touchSession(session);
  saveSessions();
  renderSessionList();
  updateComposerState();

  promptInput.value = "";
  setComposerMode("write");
  autoSizePrompt();
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
  if (!promptPreviewEl.hidden) setMarkdown(promptPreviewEl, promptInput.value.trim() || "*Nothing to preview yet.*");
});

writeTabEl.addEventListener("click", () => setComposerMode("write"));
previewTabEl.addEventListener("click", () => setComposerMode("preview"));
composerExpandEl.addEventListener("click", toggleComposerHeight);
window.addEventListener("resize", applyComposerHeight);

document.getElementById("newChat").addEventListener("click", () => {
  if (isSending) return;
  const session = createSession();
  sessions.unshift(session);
  activeSessionId = session.id;
  saveSessions();
  logsEl.replaceChildren();
  resetWorkflow();
  renderActiveSession();
  promptInput.focus();
});

document.getElementById("clearSession").addEventListener("click", () => {
  if (isSending) return;
  const session = getSession();
  const hasContent = session.history.length || session.usageCalls.length;
  if (hasContent && !window.confirm("Clear messages and token usage for this chat?")) return;
  session.history = [];
  session.usageTotals = emptyUsageTotals();
  session.usageCalls = [];
  session.title = "New chat";
  touchSession(session);
  saveSessions();
  renderActiveSession();
  promptInput.focus();
});

document.getElementById("resetUsage").addEventListener("click", () => {
  if (isSending) return;
  const session = getSession();
  session.usageTotals = emptyUsageTotals();
  session.usageCalls = [];
  touchSession(session);
  saveSessions();
  renderUsage();
  renderSessionList();
});

sendButton.addEventListener("click", (event) => {
  if (!isSending || runReachedTerminal) return;
  event.preventDefault();
  if (currentAbortController) currentAbortController.abort();
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

railEl.querySelectorAll("[data-step]").forEach((item) => {
  item.addEventListener("click", () => {
    selectedWorkflowStep = item.dataset.step;
    renderWorkflowDetail();
  });
});

autoSizePrompt();
renderActiveSession();
renderWorkflowDetail();
refreshHealth();
refreshDeviceState();
setInterval(refreshDeviceState, 5000);
