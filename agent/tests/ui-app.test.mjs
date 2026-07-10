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

test("streams model tokens into one assistant bubble and final does not duplicate it", async () => {
  const dom = await createAppDom();
  dom.window.RoomApp.resetStreamingAssistant();
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: "Hello",
    color: "#fff",
    payload: { node: "model" },
  });
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "model_token",
    heading: "Model Token",
    message: " world",
    color: "#fff",
    payload: { node: "model" },
  });
  const streamingBubble = dom.window.document.querySelector(".message-row.assistant .message");
  assert.equal(streamingBubble.classList.contains("streaming"), true);
  assert.equal(streamingBubble.classList.contains("streaming-tick"), true);
  dom.window.RoomApp.handleLifecycleEvent({
    phase: "final",
    heading: "Final Output",
    message: "Hello world",
    color: "#fff",
    payload: { content: "Hello world" },
  });

  const assistantMessages = [...dom.window.document.querySelectorAll(".message-row.assistant .message-body")];
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].textContent.trim(), "Hello world");
  assert.equal(streamingBubble.classList.contains("streaming"), false);
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

test("workflow rail renders lucide icons for each step", async () => {
  const dom = await createAppDom();
  const icons = [...dom.window.document.querySelectorAll(".workflow-step .workflow-icon")];
  assert.deepEqual(icons.map((icon) => icon.dataset.icon), [
    "DatabaseZap",
    "BrainCircuit",
    "Wrench",
    "RefreshCw",
    "MessageSquareText",
  ]);
  assert.equal(icons.filter((icon) => icon.querySelector("svg")).length, 5);
  dom.window.close();
});

test("workflow details appear in hover tooltip without dot markers", async () => {
  const dom = await createAppDom();
  const loadStep = dom.window.document.querySelector('.workflow-step[data-step="load_state"]');
  const tooltip = dom.window.document.getElementById("workflowTooltip");

  assert.equal(dom.window.document.querySelectorAll(".workflow-step i").length, 0);
  assert.equal(dom.window.document.querySelector(".workflow-detail"), null);
  assert.equal(tooltip.hidden, true);

  loadStep.dispatchEvent(new dom.window.Event("mouseenter", { bubbles: true }));
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.parentElement, dom.window.document.body);
  assert.equal(dom.window.document.getElementById("workflowDetailTitle").textContent, "Load state");

  loadStep.dispatchEvent(new dom.window.Event("mouseleave", { bubbles: true }));
  assert.equal(tooltip.hidden, false);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 160));
  assert.equal(tooltip.hidden, true);
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

  scrollHeight = 1400;
  dom.window.RoomApp.resetStreamingAssistant();
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
  scrollHeight = 1400;
  dom.window.RoomApp.resetStreamingAssistant();
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
