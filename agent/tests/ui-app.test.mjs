import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const staticRoot = new URL("../src/room_agent/static/", import.meta.url);

async function createAppDom() {
  const html = readFileSync(new URL("../src/room_agent/static/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://test/",
    pretendToBeVisual: true,
  });
  dom.window.setInterval = () => 0;
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(callback, 0);
  dom.window.fetch = async (url) => {
    if (String(url).includes("/health")) {
      return {
        ok: true,
        async json() {
          return { ok: true, settings: { deepseek_model: "deepseek-v4-flash" } };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          light: true,
          fan: false,
          connected: true,
          ac: { power: true, temperature: 24, fan_level: 3 },
        };
      },
    };
  };
  [
    "vendor/lucide.min.js",
    "vendor/marked.umd.js",
    "vendor/purify.min.js",
    "vendor/highlight.min.js",
    "markdown.js",
    "tool-progress.js",
    "voice-mode.js",
    "app.js",
  ].forEach((path) => dom.window.eval(readFileSync(new URL(path, staticRoot), "utf8")));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  return dom;
}

test("formats trace duration as whole seconds", async () => {
  const dom = await createAppDom();
  assert.equal(dom.window.RoomApp.formatTraceDuration(0), "0 seconds");
  assert.equal(dom.window.RoomApp.formatTraceDuration(1000), "1 second");
  assert.equal(dom.window.RoomApp.formatTraceDuration(1450), "1 second");
  assert.equal(dom.window.RoomApp.formatTraceDuration(1500), "2 seconds");
  dom.window.close();
});

test("formats clock time in 24-hour hh:mm:ss format", async () => {
  const dom = await createAppDom();
  const value = dom.window.RoomApp.formatClockTime(new Date(2026, 0, 1, 13, 4, 5));
  assert.match(value, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(value, "13:04:05");
  dom.window.close();
});

test("sums grand usage across sessions", async () => {
  const dom = await createAppDom();
  const totals = dom.window.RoomApp.sumUsageTotals([
    { usageTotals: { totalTokens: 10, costUsd: 0.1, modelCalls: 1 } },
    { usageTotals: { totalTokens: 25, costUsd: 0.2, modelCalls: 2 } },
  ]);
  assert.equal(totals.totalTokens, 35);
  assert.equal(totals.modelCalls, 3);
  assert.equal(totals.costUsd, 0.30000000000000004);
  dom.window.close();
});

test("pending model tokens stay hidden until classified", async () => {
  const dom = await createAppDom();
  dom.window.RoomApp.resetStreamingAssistant();
  dom.window.RoomApp.beginRunTrace("user-1");
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "model", response_target: "pending" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "Hello",
    color: "#fff",
    payload: { node: "model", response_target: "pending" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: " world",
    color: "#fff",
    payload: { node: "model", response_target: "pending" },
  });

  assert.equal(dom.window.document.querySelector(".trace-step.model"), null);
  assert.equal(dom.window.document.querySelectorAll(".message-row.assistant").length, 0);

  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_intermediate",
    heading: "Model response",
    message: "Hello world",
    color: "#fff",
    payload: { node: "model", call_index: 1, tool_call_count: 0, response_target: "working" },
  });
  assert.equal(dom.window.document.querySelector(".trace-step.model"), null);

  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Final Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "final_model", response_target: "final" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "final",
    heading: "Final Output",
    message: "Hello world",
    color: "#fff",
    payload: { content: "Hello world" },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 160));

  const assistantMessages = [...dom.window.document.querySelectorAll(".message-row.assistant .message-body")];
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].textContent.trim(), "Hello world");
  assert.equal(dom.window.document.querySelector(".trace-step.model"), null);
  dom.window.close();
});

test("classified tool-call model response is committed before tools", async () => {
  const dom = await createAppDom();
  dom.window.RoomApp.resetStreamingAssistant();
  dom.window.RoomApp.beginRunTrace("user-2");
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "model", response_target: "pending" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "I will ",
    color: "#fff",
    payload: { node: "model", response_target: "pending" },
  });
  assert.equal(dom.window.document.querySelector(".trace-step.model"), null);
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_intermediate",
    heading: "Model response",
    message: "I will turn on the fan.",
    color: "#fff",
    payload: { node: "model", call_index: 1, tool_call_count: 1, response_target: "working" },
  });

  assert.equal(dom.window.document.querySelector(".trace-step.model strong").textContent, "Model response");
  const modelStep = dom.window.document.querySelector(".trace-step.model .trace-step-body");
  assert.equal(modelStep.textContent.trim(), "I will turn on the fan.");
  assert.equal(dom.window.document.querySelector(".trace-step.model.streaming"), null);
  assert.equal(dom.window.document.querySelectorAll(".message-row.assistant").length, 0);
  dom.window.close();
});

test("final-target model tokens stream in the assistant bubble and final reuses it", async () => {
  const dom = await createAppDom();
  dom.window.RoomApp.resetStreamingAssistant();
  dom.window.RoomApp.beginRunTrace("user-final");
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "model", response_target: "final" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "Final",
    color: "#fff",
    payload: { node: "model" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: " answer",
    color: "#fff",
    payload: { node: "model" },
  });

  const assistantBubble = dom.window.document.querySelector(".message-row.assistant .message");
  assert.equal(assistantBubble.classList.contains("streaming"), true);
  assert.equal(assistantBubble.querySelector(".message-body").textContent.trim(), "Final answer");
  assert.equal(dom.window.document.querySelector(".trace-step.model"), null);

  dom.window.RoomApp.handleLifecycleEvent({
    phase: "final",
    heading: "Final Output",
    message: "Final answer",
    color: "#fff",
    payload: { content: "Final answer" },
  });

  const assistantMessages = [...dom.window.document.querySelectorAll(".message-row.assistant .message-body")];
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].textContent.trim(), "Final answer");
  assert.equal(assistantBubble.classList.contains("streaming"), false);
  dom.window.close();
});

test("pending post-tool model tokens wait and final-model tokens stream in chat", async () => {
  const dom = await createAppDom();
  dom.window.RoomApp.resetStreamingAssistant();
  dom.window.RoomApp.beginRunTrace("user-pending");
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "model", response_target: "pending" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "Final",
    color: "#fff",
    payload: { node: "model", response_target: "pending" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: " answer",
    color: "#fff",
    payload: { node: "model", response_target: "pending" },
  });

  assert.equal(dom.window.document.querySelector(".message-row.assistant"), null);
  assert.equal(dom.window.document.querySelector(".trace-step.model"), null);

  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_intermediate",
    heading: "Model response",
    message: "Ready for the final reply.",
    color: "#fff",
    payload: { node: "model", call_index: 2, tool_call_count: 0, response_target: "working" },
  });
  assert.equal(dom.window.document.querySelector(".trace-step.model"), null);

  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Final Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "final_model", response_target: "final" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "Final",
    color: "#fff",
    payload: { node: "final_model", response_target: "final" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: " answer",
    color: "#fff",
    payload: { node: "final_model", response_target: "final" },
  });

  const assistantBubble = dom.window.document.querySelector(".message-row.assistant .message");
  assert.equal(assistantBubble.classList.contains("streaming"), true);
  assert.equal(assistantBubble.querySelector(".message-body").textContent.trim(), "Final answer");

  dom.window.RoomApp.handleLifecycleEvent({
    phase: "final",
    heading: "Final Output",
    message: "Final answer",
    color: "#fff",
    payload: { content: "Final answer" },
  });

  const assistantMessages = [...dom.window.document.querySelectorAll(".message-row.assistant .message-body")];
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].textContent.trim(), "Final answer");
  assert.equal(dom.window.document.querySelector(".trace-step.model"), null);
  dom.window.close();
});

test("composer action controls live inside the editor and send disables when empty", async () => {
  const dom = await createAppDom();
  const composerMain = dom.window.document.querySelector(".composer-main");
  const send = dom.window.document.getElementById("send");
  const stop = dom.window.document.getElementById("stopResponse");
  const sendIcon = dom.window.document.getElementById("sendIcon");
  assert.equal(composerMain.contains(send), true);
  assert.equal(composerMain.contains(stop), true);
  assert.equal(send.getAttribute("aria-label"), "Send message");
  assert.equal(dom.window.document.getElementById("sendText").textContent, "Send");
  assert.equal(sendIcon.dataset.icon, "SendHorizontal");
  assert.ok(sendIcon.querySelector("svg"));
  assert.equal(send.disabled, true);
  assert.equal(stop.hidden, true);
  assert.equal(stop.textContent.trim(), "");
  dom.window.close();
});

test("logs inspector has no workflow cards or tooltip", async () => {
  const dom = await createAppDom();
  assert.equal(dom.window.document.getElementById("workflowTab").textContent, "Logs");
  assert.equal(dom.window.document.querySelector(".workflow-step"), null);
  assert.equal(dom.window.document.getElementById("workflowTooltip"), null);
  assert.ok(dom.window.document.getElementById("logs"));
  dom.window.close();
});

test("turbo interrupt renders inline approval and checkpoint log", async () => {
  const dom = await createAppDom();
  dom.window.RoomApp.beginRunTrace("turbo-user");
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "approval_required",
    heading: "Turbo Approval Required",
    message: "Graph paused before activating AC turbo mode.",
    color: "#ffd166",
    payload: {
      thread_id: "thread-1",
      checkpoint_id: "checkpoint-1",
      next_nodes: ["tools"],
      request: { feature: "turbo", enabled: true },
    },
  });

  const card = dom.window.document.querySelector(".approval-card.pending");
  assert.ok(card);
  assert.equal(card.querySelector(".approve-button").textContent, "Approve turbo");
  assert.equal(card.querySelector(".deny-button").textContent, "Deny");
  assert.equal(dom.window.document.querySelector(".log-phase").textContent, "approval_required");
  assert.equal(dom.window.document.getElementById("prompt").disabled, true);
  dom.window.close();
});

test("room state strip renders lucide icons for each chip", async () => {
  const dom = await createAppDom();
  const stateStrip = dom.window.document.querySelector(".state-strip");
  const icons = [...dom.window.document.querySelectorAll(".state-strip .chip-icon")];
  assert.equal(dom.window.document.querySelector(".topbar").contains(stateStrip), true);
  assert.deepEqual(icons.map((icon) => icon.dataset.icon), ["Lightbulb", "Fan", "Snowflake", "Thermometer"]);
  assert.equal(icons.filter((icon) => icon.querySelector("svg")).length, 4);
  assert.equal(dom.window.document.querySelector("#acChip small").textContent, "AC");
  assert.equal(dom.window.document.querySelector("#tempChip small").textContent, "");
  assert.equal(dom.window.document.querySelector("#tempChip").getAttribute("aria-label"), "AC settings");
  assert.match(dom.window.document.querySelector("#tempChip strong").textContent, /^24 C \/ L3 \/ auto$/);
  dom.window.close();
});

test("user message limit ignores assistant messages and trims to ten user turns", async () => {
  const dom = await createAppDom();
  const history = [];
  for (let index = 1; index <= 12; index += 1) {
    history.push({ role: "user", content: `user ${index}` });
    history.push({ role: "assistant", content: `assistant ${index}` });
  }
  const trimmed = dom.window.RoomApp.trimHistoryToUserLimit(history);
  assert.equal(dom.window.RoomApp.userMessageCount(trimmed), 10);
  assert.equal(trimmed[0].content, "user 3");
  assert.equal(dom.window.RoomApp.requestHistory(history).filter((item) => item.role === "user").length, 10);
  dom.window.close();
});

test("streaming does not force scroll when user is away from bottom", async () => {
  const dom = await createAppDom();
  const messages = dom.window.document.getElementById("messages");
  Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 1200 });
  Object.defineProperty(messages, "clientHeight", { configurable: true, value: 400 });
  messages.scrollTop = 120;
  messages.dispatchEvent(new dom.window.Event("scroll"));

  dom.window.RoomApp.resetStreamingAssistant();
  dom.window.RoomApp.beginRunTrace("scroll-user-1");
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "model", response_target: "final" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "hello",
    color: "#fff",
    payload: { node: "model" },
  });

  assert.equal(messages.scrollTop, 120);
  assert.equal(dom.window.document.getElementById("scrollLatest").hidden, false);
  dom.window.close();
});

test("streaming follows when scroll latest button is hidden", async () => {
  const dom = await createAppDom();
  const messages = dom.window.document.getElementById("messages");
  let scrollHeight = 1200;
  Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(messages, "clientHeight", { configurable: true, value: 400 });
  messages.scrollTop = 800;
  messages.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(dom.window.document.getElementById("scrollLatest").hidden, true);

  dom.window.RoomApp.beginRunTrace("scroll-user-2");
  scrollHeight = 1400;
  dom.window.RoomApp.resetStreamingAssistant();
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "model", response_target: "final" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "hello",
    color: "#fff",
    payload: { node: "model" },
  });

  assert.equal(messages.scrollTop, 1400);
  assert.equal(dom.window.document.getElementById("scrollLatest").hidden, true);
  dom.window.close();
});

test("upward user scroll intent pauses streaming autoscroll before scroll event", async () => {
  const dom = await createAppDom();
  const messages = dom.window.document.getElementById("messages");
  const button = dom.window.document.getElementById("scrollLatest");
  let scrollHeight = 1200;
  Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(messages, "clientHeight", { configurable: true, value: 400 });
  messages.scrollTop = 800;
  messages.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(button.hidden, true);

  messages.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -120 }));
  dom.window.RoomApp.beginRunTrace("scroll-user-3");
  scrollHeight = 1400;
  dom.window.RoomApp.resetStreamingAssistant();
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "model", response_target: "final" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "hello",
    color: "#fff",
    payload: { node: "model" },
  });

  assert.equal(messages.scrollTop, 800);
  assert.equal(button.hidden, false);
  dom.window.close();
});

test("streaming resumes autoscroll after user returns to bottom", async () => {
  const dom = await createAppDom();
  const messages = dom.window.document.getElementById("messages");
  const button = dom.window.document.getElementById("scrollLatest");
  let scrollHeight = 1200;
  Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(messages, "clientHeight", { configurable: true, value: 400 });
  messages.scrollTop = 120;
  messages.dispatchEvent(new dom.window.Event("scroll"));

  dom.window.RoomApp.resetStreamingAssistant();
  dom.window.RoomApp.beginRunTrace("scroll-user-4");
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_start",
    heading: "Model Call",
    message: "calling",
    color: "#fff",
    payload: { node: "model", response_target: "final" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "hello",
    color: "#fff",
    payload: { node: "model" },
  });
  assert.equal(messages.scrollTop, 120);
  assert.equal(button.hidden, false);

  messages.scrollTop = 800;
  messages.dispatchEvent(new dom.window.Event("scroll"));
  assert.equal(button.hidden, true);

  scrollHeight = 1400;
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: " world",
    color: "#fff",
    payload: { node: "model" },
  });

  assert.equal(messages.scrollTop, 1400);
  assert.equal(button.hidden, true);
  dom.window.close();
});

test("submitting a new message scrolls to bottom smoothly", async () => {
  const dom = await createAppDom();
  const messages = dom.window.document.getElementById("messages");
  const composer = dom.window.document.getElementById("composer");
  const prompt = dom.window.document.getElementById("prompt");
  const scrollCalls = [];
  dom.window.fetch = () => new Promise(() => {});
  Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 1200 });
  Object.defineProperty(messages, "clientHeight", { configurable: true, value: 400 });
  messages.scrollTop = 120;
  messages.scrollTo = (options) => scrollCalls.push(options);
  messages.dispatchEvent(new dom.window.Event("scroll"));

  prompt.value = "smooth scroll please";
  composer.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  assert.equal(scrollCalls.length, 1);
  assert.equal(scrollCalls[0].top, 1200);
  assert.equal(scrollCalls[0].behavior, "smooth");
  dom.window.close();
});

test("scroll latest button jumps to the bottom", async () => {
  const dom = await createAppDom();
  const messages = dom.window.document.getElementById("messages");
  const button = dom.window.document.getElementById("scrollLatest");
  Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 1200 });
  Object.defineProperty(messages, "clientHeight", { configurable: true, value: 400 });
  messages.scrollTop = 120;
  messages.dispatchEvent(new dom.window.Event("scroll"));

  assert.equal(button.hidden, false);
  button.click();
  assert.equal(messages.scrollTop, 1200);
  dom.window.close();
});

test("collapse run trace uses animated closing class before closing details", async () => {
  const dom = await createAppDom();
  const details = dom.window.document.createElement("details");
  details.className = "run-trace completed";
  details.open = true;
  const body = dom.window.document.createElement("div");
  body.className = "run-trace-body";
  Object.defineProperty(body, "scrollHeight", { configurable: true, value: 140 });
  details.appendChild(body);
  dom.window.document.body.appendChild(details);

  dom.window.RoomApp.collapseRunTrace(details);
  assert.equal(details.classList.contains("closing"), true);
  assert.equal(details.dataset.expanded, "false");
  await new Promise((resolve) => dom.window.setTimeout(resolve, 270));
  assert.equal(details.open, true);
  assert.equal(details.classList.contains("collapsed"), true);
  assert.equal(details.classList.contains("closing"), false);
  dom.window.close();
});

test("expand run trace animates open before clearing inline height", async () => {
  const dom = await createAppDom();
  const details = dom.window.document.createElement("details");
  details.className = "run-trace completed";
  const body = dom.window.document.createElement("div");
  body.className = "run-trace-body";
  Object.defineProperty(body, "scrollHeight", { configurable: true, value: 160 });
  details.appendChild(body);
  dom.window.document.body.appendChild(details);

  dom.window.RoomApp.expandRunTrace(details);
  assert.equal(details.open, true);
  assert.equal(details.dataset.expanded, "true");
  assert.equal(details.classList.contains("opening"), true);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 270));
  assert.equal(details.open, true);
  assert.equal(details.classList.contains("opening"), false);
  assert.equal(body.style.maxHeight, "");
  dom.window.close();
});

test("rendered run trace summary toggles through animation helpers", async () => {
  const dom = await createAppDom();
  const view = dom.window.RoomApp.renderRunTrace({
    id: "trace-1",
    status: "completed",
    startedAt: Date.now(),
    durationMs: 1000,
    steps: [{ type: "direct", title: "Direct response", content: "Done", elapsedMs: 0 }],
  }, false);
  const summary = view.details.querySelector("summary");
  const body = view.details.querySelector(".run-trace-body");
  Object.defineProperty(body, "scrollHeight", { configurable: true, value: 140 });

  summary.click();
  assert.equal(view.details.open, true);
  assert.equal(view.details.dataset.expanded, "true");
  assert.equal(view.details.classList.contains("opening"), true);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 270));

  summary.click();
  assert.equal(view.details.open, true);
  assert.equal(view.details.dataset.expanded, "false");
  assert.equal(view.details.classList.contains("closing"), true);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 270));
  assert.equal(view.details.open, true);
  assert.equal(view.details.classList.contains("collapsed"), true);
  dom.window.close();
});

test("tool trace steps fall back to hh:mm:ss from trace start time", async () => {
  const dom = await createAppDom();
  const startedAt = new Date(2026, 0, 1, 13, 4, 5).getTime();
  const view = dom.window.RoomApp.renderRunTrace({
    id: "trace-2",
    status: "completed",
    startedAt,
    durationMs: 3000,
    steps: [{ type: "tool_call", title: "1. Turning the fan on", content: "OK", elapsedMs: 3000 }],
  }, true);
  const stamp = view.timeline.querySelector(".trace-step-content header span").textContent;
  assert.equal(stamp, "13:04:08");
  dom.window.close();
});

test("composer expand button toggles icons and submit collapses to compact height", async () => {
  const dom = await createAppDom();
  const textarea = dom.window.document.getElementById("prompt");
  const preview = dom.window.document.getElementById("promptPreview");
  const expand = dom.window.document.getElementById("composerExpand");
  const icon = expand.querySelector("[data-icon]");

  assert.equal(textarea.style.height, "112px");
  assert.equal(expand.getAttribute("aria-pressed"), "false");
  assert.equal(icon.dataset.icon, "Maximize2");

  expand.click();
  assert.equal(expand.getAttribute("aria-pressed"), "true");
  assert.equal(icon.dataset.icon, "Minimize2");
  assert.notEqual(textarea.style.height, "112px");

  dom.window.RoomApp.collapseComposer();

  assert.equal(textarea.style.height, "112px");
  assert.equal(preview.style.height, "112px");
  assert.equal(expand.getAttribute("aria-pressed"), "false");
  assert.equal(icon.dataset.icon, "Maximize2");
  dom.window.close();
});

test("voice transcript appends to the composer without submitting", async () => {
  const dom = await createAppDom();
  const composer = dom.window.document.getElementById("composer");
  const prompt = dom.window.document.getElementById("prompt");
  let submitCount = 0;
  composer.addEventListener("submit", () => { submitCount += 1; });
  prompt.value = "existing draft";

  const inserted = dom.window.RoomApp.insertVoiceTranscript("விளக்கை ஆன் பண்ணு");

  assert.equal(inserted, true);
  assert.equal(prompt.value, "existing draft\nவிளக்கை ஆன் பண்ணு");
  assert.equal(submitCount, 0);
  assert.equal(dom.window.document.getElementById("send").disabled, false);
  dom.window.close();
});

test("header voice button opens and closes the diagnostic dialog", async () => {
  const dom = await createAppDom();
  const launcher = dom.window.document.getElementById("voiceLauncher");
  const modal = dom.window.document.getElementById("voiceModal");
  const close = dom.window.document.getElementById("voiceClose");

  assert.equal(dom.window.document.querySelector("#composer #voiceStrip"), null);
  assert.equal(modal.hidden, true);
  launcher.click();
  assert.equal(modal.hidden, false);
  assert.equal(launcher.getAttribute("aria-expanded"), "true");
  close.click();
  assert.equal(modal.hidden, true);
  assert.equal(launcher.getAttribute("aria-expanded"), "false");
  dom.window.close();
});
