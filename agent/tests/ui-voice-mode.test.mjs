import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const script = readFileSync(
  new URL("../src/room_agent/static/voice-mode.js", import.meta.url),
  "utf8",
);

function createScheduler() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      nextId += 1;
      pending.set(nextId, { callback, delay });
      return nextId;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runDelay(delay) {
      const matches = [...pending.entries()].filter(([, timer]) => timer.delay === delay);
      matches.forEach(([id, timer]) => {
        pending.delete(id);
        timer.callback();
      });
    },
    size() {
      return pending.size;
    },
  };
}

class FakeRecognition {
  static instances = [];

  constructor() {
    this.startCalls = 0;
    this.abortCalls = 0;
    FakeRecognition.instances.push(this);
  }

  start() {
    this.startCalls += 1;
    if (this.onstart) this.onstart();
  }

  abort() {
    this.abortCalls += 1;
    if (this.onend) this.onend();
  }
}

function speechResult(alternatives, isFinal = false) {
  const result = alternatives.map((transcript) => ({ transcript }));
  result.isFinal = isFinal;
  return result;
}

function emit(recognition, alternatives, isFinal = false) {
  recognition.onresult({
    resultIndex: 0,
    results: [speechResult(alternatives, isFinal)],
  });
}

function emitResults(recognition, results, resultIndex = 0) {
  recognition.onresult({
    resultIndex,
    results: results.map(({ alternatives, isFinal }) => speechResult(alternatives, isFinal)),
  });
}

function createHarness({ permissionError = null, Recognition = FakeRecognition } = {}) {
  FakeRecognition.instances = [];
  const dom = new JSDOM(`
    <button id="launcher"></button>
    <button id="toggle"><span id="toggleText"></span></button>
    <button id="clear"></button>
    <section id="strip"><strong id="status"></strong><span id="detail"></span></section>
    <span id="heard"></span><span id="alternatives"></span><span id="transcript"></span>
    <span id="engine"></span><span id="restarts"></span><ol id="activity"></ol>
  `, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
  dom.window.eval(script);
  const scheduler = createScheduler();
  const stopCalls = [];
  const permissionCalls = [];
  const mediaDevices = {
    async getUserMedia(constraints) {
      permissionCalls.push(constraints);
      if (permissionError) throw permissionError;
      return { getTracks: () => [{ stop: () => stopCalls.push(true) }] };
    },
  };
  const transcripts = [];
  const controller = dom.window.RoomVoiceMode.createVoiceModeController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    Recognition,
    mediaDevices,
    button: dom.window.document.getElementById("toggle"),
    buttonText: dom.window.document.getElementById("toggleText"),
    clearButton: dom.window.document.getElementById("clear"),
    launcher: dom.window.document.getElementById("launcher"),
    strip: dom.window.document.getElementById("strip"),
    status: dom.window.document.getElementById("status"),
    statusDetail: dom.window.document.getElementById("detail"),
    heard: dom.window.document.getElementById("heard"),
    alternatives: dom.window.document.getElementById("alternatives"),
    transcript: dom.window.document.getElementById("transcript"),
    engineStatus: dom.window.document.getElementById("engine"),
    restartCount: dom.window.document.getElementById("restarts"),
    activity: dom.window.document.getElementById("activity"),
    onTranscript: (value) => transcripts.push(value),
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    silenceMs: 1200,
    hardTimeoutMs: 10000,
    restartMs: 250,
  });
  controller.init();
  return { dom, controller, scheduler, permissionCalls, stopCalls, transcripts };
}

test("recognizes every configured Deepy alias and preserves command text", () => {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  dom.window.eval(script);
  const aliases = [
    "Deepy",
    "deep e",
    "deepie",
    "deep ee",
    "DP",
    "டீபி",
    "டிபி",
    "டீப்பி",
    "டிப்பி",
    "தீபி",
    "திபி",
    "தீப்பி",
    "திப்பி",
    "டி பி",
    "டீ பி",
    "தீ பி",
  ];
  aliases.forEach((alias) => {
    const match = dom.window.RoomVoiceMode.findWakeWord(`${alias}, விளக்கை ஆன் பண்ணு`);
    assert.ok(match, `expected wake match for ${alias}`);
    assert.equal(match.command, "விளக்கை ஆன் பண்ணு");
  });
  assert.equal(dom.window.RoomVoiceMode.findWakeWord("deep system"), null);
  dom.window.close();
});

test("merges overlapping Chrome speech segments without repeating their tail", () => {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  dom.window.eval(script);
  const merge = dom.window.RoomVoiceMode.mergeSpeechSegments;
  assert.equal(merge(["லைட் ஆஃப் பண்ணு", "ஆஃப் பண்ணு"]), "லைட் ஆஃப் பண்ணு");
  assert.equal(merge(["ஃபேன் ஆன் பண்றியா", "பண்றியா"]), "ஃபேன் ஆன் பண்றியா");
  assert.equal(merge(["லைட் ஆஃப்", "ஆஃப் பண்ணு"]), "லைட் ஆஃப் பண்ணு");
  dom.window.close();
});

test("marks unsupported browsers without requesting permission", () => {
  const { dom, controller, permissionCalls } = createHarness({ Recognition: null });
  assert.equal(dom.window.document.getElementById("strip").dataset.state, "unsupported");
  assert.equal(dom.window.document.getElementById("toggle").disabled, true);
  assert.equal(permissionCalls.length, 0);
  controller.destroy();
  dom.window.close();
});

test("requests permission only when enabled and configures Tamil recognition", async () => {
  const harness = createHarness();
  assert.equal(harness.permissionCalls.length, 0);

  await harness.controller.enable();

  assert.equal(harness.permissionCalls.length, 1);
  assert.equal(harness.permissionCalls[0].audio, true);
  assert.equal(harness.stopCalls.length, 1);
  const recognition = harness.controller.recognition();
  assert.equal(recognition.lang, "ta-IN");
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.maxAlternatives, 3);
  assert.equal(recognition.startCalls, 1);
  assert.equal(harness.dom.window.document.getElementById("strip").dataset.state, "armed");
  harness.controller.destroy();
  harness.dom.window.close();
});

test("shows a clear state when microphone permission is denied", async () => {
  const harness = createHarness({ permissionError: new Error("denied") });
  await harness.controller.enable();
  assert.equal(harness.controller.isEnabled(), false);
  assert.equal(harness.dom.window.document.getElementById("strip").dataset.state, "denied");
  assert.match(harness.dom.window.document.getElementById("status").textContent, /denied/i);
  harness.dom.window.close();
});

test("captures a same-result Tamil command and finalizes after silence", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  const recognition = harness.controller.recognition();

  emit(recognition, ["Deepy, விளக்கை ஆன் பண்ணு"], true);

  assert.equal(harness.controller.state(), "listening");
  assert.equal(harness.dom.window.document.getElementById("transcript").textContent, "விளக்கை ஆன் பண்ணு");
  harness.scheduler.runDelay(1200);
  assert.deepEqual(harness.transcripts, ["விளக்கை ஆன் பண்ணு"]);
  assert.equal(harness.controller.state(), "armed");
  harness.controller.destroy();
  harness.dom.window.close();
});

test("replaces a revised interim wake result instead of duplicating stale text", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  const recognition = harness.controller.recognition();

  emit(recognition, ["Deepy லைட்டை"], false);
  emit(recognition, ["Deepy லைட்டை ஆஃப் பண்ணு"], true);
  harness.scheduler.runDelay(1200);

  assert.deepEqual(harness.transcripts, ["லைட்டை ஆஃப் பண்ணு"]);
  assert.equal(harness.dom.window.document.getElementById("transcript").textContent, "லைட்டை ஆஃப் பண்ணு");
  assert.match(harness.dom.window.document.getElementById("activity").textContent, /Command finalized/);
  harness.controller.destroy();
  harness.dom.window.close();
});

test("deduplicates overlapping final result slots from Chrome", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  const recognition = harness.controller.recognition();

  emitResults(recognition, [
    { alternatives: ["டிபி லைட் ஆஃப் பண்ணு"], isFinal: true },
    { alternatives: ["ஆஃப் பண்ணு"], isFinal: true },
  ]);
  harness.scheduler.runDelay(1200);

  assert.deepEqual(harness.transcripts, ["லைட் ஆஃப் பண்ணு"]);
  harness.controller.destroy();
  harness.dom.window.close();
});

test("captures subsequent interim and final Tamil speech", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  const recognition = harness.controller.recognition();

  emit(recognition, ["டீப்பி"], true);
  emit(recognition, ["ஏசியை இருபத்தி நாலு"], false);
  assert.equal(harness.dom.window.document.getElementById("transcript").textContent, "ஏசியை இருபத்தி நாலு");
  emit(recognition, ["ஏசியை இருபத்தி நாலு டிகிரிக்கு வை"], true);
  harness.scheduler.runDelay(1200);

  assert.deepEqual(harness.transcripts, ["ஏசியை இருபத்தி நாலு டிகிரிக்கு வை"]);
  harness.controller.destroy();
  harness.dom.window.close();
});

test("hard timeout finalizes the best available interim command", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  const recognition = harness.controller.recognition();
  emit(recognition, ["Deep E light ah on pannu"], false);

  harness.scheduler.runDelay(10000);

  assert.deepEqual(harness.transcripts, ["light ah on pannu"]);
  assert.equal(harness.controller.state(), "armed");
  harness.controller.destroy();
  harness.dom.window.close();
});

test("pauses while hidden, resumes when visible, and restarts ordinary endings", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  const recognition = harness.controller.recognition();
  assert.equal(recognition.startCalls, 1);

  Object.defineProperty(harness.dom.window.document, "hidden", { configurable: true, value: true });
  harness.dom.window.document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
  assert.equal(recognition.abortCalls, 1);
  assert.equal(harness.dom.window.document.getElementById("strip").dataset.state, "paused");

  Object.defineProperty(harness.dom.window.document, "hidden", { configurable: true, value: false });
  harness.dom.window.document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
  assert.equal(recognition.startCalls, 2);

  recognition.onend();
  harness.scheduler.runDelay(250);
  assert.equal(recognition.startCalls, 3);
  harness.controller.destroy();
  harness.dom.window.close();
});

test("disable and destroy stop recognition and clear pending work", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  const recognition = harness.controller.recognition();
  emit(recognition, ["Deepy fan on"], false);
  assert.ok(harness.scheduler.size() > 0);

  harness.controller.disable();

  assert.equal(harness.controller.isEnabled(), false);
  assert.equal(recognition.abortCalls, 1);
  assert.equal(harness.scheduler.size(), 0);
  assert.equal(harness.dom.window.document.getElementById("strip").dataset.state, "idle");
  harness.controller.destroy();
  harness.dom.window.close();
});
