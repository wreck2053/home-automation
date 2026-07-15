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
  recognition.onresult({ resultIndex: 0, results: [speechResult(alternatives, isFinal)] });
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

function createHarness({
  permissionError = null,
  Recognition = FakeRecognition,
  transcriptionPayload = { text: "turn on the light", upstream_latency_ms: 80 },
  transcriptionStatus = 200,
  hardTimeoutMs = 60000,
} = {}) {
  FakeRecognition.instances = [];
  const dom = new JSDOM(`
    <button id="launcher"></button>
    <button id="toggle"><span id="toggleText"></span></button>
    <button id="clear"></button>
    <section id="strip"><strong id="status"></strong><span id="detail"></span></section>
    <span id="heard"></span><span id="alternatives"></span><span id="transcript"></span>
    <span id="engine"></span><span id="restarts"></span><span id="latency"></span><ol id="activity"></ol>
  `, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
  dom.window.eval(script);
  const scheduler = createScheduler();
  const stopCalls = [];
  const permissionCalls = [];
  const fetchCalls = [];
  const captureCalls = [];
  let onAudioFrame = null;
  const stream = { getTracks: () => [{ stop: () => stopCalls.push(true) }] };
  const mediaDevices = {
    async getUserMedia(constraints) {
      permissionCalls.push(constraints);
      if (permissionError) throw permissionError;
      return stream;
    },
  };
  const capture = {
    begin: () => captureCalls.push("begin"),
    finish: () => {
      captureCalls.push("finish");
      return new dom.window.Blob(["wav"], { type: "audio/wav" });
    },
    cancel: () => captureCalls.push("cancel"),
    suspend: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    destroy: () => captureCalls.push("destroy"),
  };
  const createAudioCapture = async (options) => {
    assert.equal(options.stream, stream);
    assert.equal(options.preRollSeconds, 3);
    assert.equal(typeof options.onAudioFrame, "function");
    onAudioFrame = options.onAudioFrame;
    return capture;
  };
  const fetchRef = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: transcriptionStatus >= 200 && transcriptionStatus < 300,
      status: transcriptionStatus,
      json: async () => transcriptionPayload,
    };
  };
  const nowValues = [100, 225];
  const controller = dom.window.RoomVoiceMode.createVoiceModeController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    Recognition,
    mediaDevices,
    fetchRef,
    createAudioCapture,
    now: () => nowValues.shift() ?? 225,
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
    latency: dom.window.document.getElementById("latency"),
    activity: dom.window.document.getElementById("activity"),
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    silenceMs: 1200,
    finalResultMs: 300,
    speechEndMs: 800,
    hardTimeoutMs,
    restartMs: 250,
    vadSilenceMs: 900,
    vadArmMs: 160,
    speechThresholdRms: 0.008,
  });
  controller.init();
  return {
    dom,
    controller,
    scheduler,
    permissionCalls,
    stopCalls,
    fetchCalls,
    captureCalls,
    emitAudioFrame(rms) {
      assert.ok(onAudioFrame, "audio capture must be initialized before emitting frames");
      onAudioFrame({ rms });
    },
  };
}

test("recognizes configured Deepy aliases and preserves following text", () => {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  dom.window.eval(script);
  ["Deepy", "deep e", "Deepi", "deep i", "deepie", "DP", "டீபி", "டிப்பி", "தீப்பி"].forEach((alias) => {
    const match = dom.window.RoomVoiceMode.findWakeWord(`${alias}, turn on the light`);
    assert.ok(match, `expected wake match for ${alias}`);
    assert.equal(match.command, "turn on the light");
  });
  assert.equal(dom.window.RoomVoiceMode.findWakeWord("deep system"), null);
  dom.window.close();
});

test("encodes captured PCM as a 16 kHz mono WAV", () => {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  dom.window.eval(script);
  const wav = dom.window.RoomVoiceMode.encodeMonoWav(
    [new Float32Array(4800).fill(0.25)],
    48000,
    dom.window.Blob,
  );
  assert.equal(wav.type, "audio/wav");
  assert.equal(wav.size, 44 + 1600 * 2);
  dom.window.close();
});

test("keeps a bounded wake pre-roll so Chrome detection latency does not clip the command", async () => {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  dom.window.eval(script);
  let processor;
  const audioNode = () => ({ connect() {}, disconnect() {} });
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 16000;
      this.destination = {};
    }

    createMediaStreamSource() {
      return audioNode();
    }

    createScriptProcessor() {
      processor = audioNode();
      return processor;
    }

    createGain() {
      return { ...audioNode(), gain: { value: 1 } };
    }

    resume() {
      return Promise.resolve();
    }

    suspend() {
      return Promise.resolve();
    }

    close() {
      return Promise.resolve();
    }
  }
  dom.window.AudioContext = FakeAudioContext;
  const audioFrames = [];
  const capture = await dom.window.RoomVoiceMode.createPcmAudioCapture({
    windowRef: dom.window,
    stream: {},
    preRollSeconds: 0.1,
    onAudioFrame: (frame) => audioFrames.push(frame),
  });
  const feedSamples = (length) => processor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array(length).fill(0.25) },
  });

  feedSamples(2400);
  capture.begin();
  feedSamples(800);
  const wav = capture.finish();

  assert.equal(wav.size, 44 + (1600 + 800) * 2);
  assert.equal(audioFrames.length, 2);
  assert.ok(Math.abs(audioFrames[0].rms - 0.25) < 0.000001);
  capture.destroy();
  dom.window.close();
});

test("marks unsupported browsers without requesting permission", () => {
  const { dom, controller, permissionCalls } = createHarness({ Recognition: null });
  assert.equal(dom.window.document.getElementById("strip").dataset.state, "unsupported");
  assert.equal(permissionCalls.length, 0);
  controller.destroy();
  dom.window.close();
});

test("retains the microphone and configures English wake recognition", async () => {
  const harness = createHarness();
  await harness.controller.enable();

  assert.equal(harness.permissionCalls.length, 1);
  assert.equal(harness.permissionCalls[0].audio.channelCount, 1);
  assert.equal(harness.stopCalls.length, 0);
  const recognition = harness.controller.recognition();
  assert.equal(recognition.lang, "en-IN");
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.maxAlternatives, 3);
  assert.equal(recognition.startCalls, 1);
  harness.controller.disable();
  assert.equal(harness.stopCalls.length, 1);
  assert.ok(harness.captureCalls.includes("destroy"));
  harness.dom.window.close();
});

test("shows a clear state when microphone permission is denied", async () => {
  const harness = createHarness({ permissionError: new Error("denied") });
  await harness.controller.enable();
  assert.equal(harness.controller.isEnabled(), false);
  assert.equal(harness.dom.window.document.getElementById("strip").dataset.state, "denied");
  harness.dom.window.close();
});

test("uses bounded wake pre-roll and displays only the post-wake model command", async () => {
  const harness = createHarness({
    transcriptionPayload: {
      text: "Laptop is on the table. Deepi, turn off the light and fan.",
      upstream_latency_ms: 80,
    },
  });
  await harness.controller.enable();
  const recognition = harness.controller.recognition();

  emit(recognition, ["laptop is on the table DP"], false);
  assert.equal(harness.controller.state(), "listening");
  assert.equal(harness.dom.window.document.getElementById("heard").textContent, "DP");
  assert.equal(harness.dom.window.document.getElementById("transcript").textContent, "Recording…");
  assert.deepEqual(harness.captureCalls, ["begin"]);
  emit(recognition, ["turn off the light and fan"], true);
  harness.scheduler.runDelay(300);
  await flushPromises();

  assert.deepEqual(harness.captureCalls.slice(-2), ["begin", "finish"]);
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, "/api/voice/transcribe");
  assert.equal(harness.fetchCalls[0].options.headers["Content-Type"], "audio/wav");
  assert.equal(harness.dom.window.document.getElementById("transcript").textContent, "turn off the light and fan.");
  assert.equal(harness.dom.window.document.getElementById("latency").textContent, "125 ms");
  assert.equal(harness.controller.state(), "armed");
  harness.controller.destroy();
  harness.dom.window.close();
});

test("refreshes wake recognition and accepts consecutive same-breath commands", async () => {
  const harness = createHarness({
    transcriptionPayload: { text: "Deepy, turn off the light and fan.", upstream_latency_ms: 80 },
  });
  await harness.controller.enable();
  let recognition = harness.controller.recognition();

  emit(recognition, ["Deepy turn off the light and fan"], true);
  harness.scheduler.runDelay(300);
  await flushPromises();

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(recognition.abortCalls, 1);
  const refreshedRecognition = harness.controller.recognition();
  assert.notEqual(refreshedRecognition, recognition);
  harness.scheduler.runDelay(250);
  assert.equal(refreshedRecognition.startCalls, 1);

  recognition = refreshedRecognition;
  emit(recognition, ["Deepy turn on the fan"], true);
  harness.scheduler.runDelay(300);
  await flushPromises();

  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(recognition.abortCalls, 1);
  assert.equal(harness.controller.state(), "armed");
  harness.controller.destroy();
  harness.dom.window.close();
});

test("live microphone activity captures a post-wake command without browser command text", async () => {
  const harness = createHarness();
  await harness.controller.enable();

  emit(harness.controller.recognition(), ["Deepy"], true);
  harness.scheduler.runDelay(160);
  harness.emitAudioFrame(0.05);

  assert.equal(harness.dom.window.document.getElementById("detail").textContent, "Speech detected. Pause briefly when your command is finished.");
  harness.scheduler.runDelay(900);
  await flushPromises();

  assert.equal(harness.fetchCalls.length, 1);
  assert.deepEqual(harness.captureCalls.slice(-2), ["begin", "finish"]);
  assert.equal(harness.controller.state(), "armed");
  harness.controller.destroy();
  harness.dom.window.close();
});

test("live wake-only audio rearms without displaying Deepy as a command", async () => {
  const harness = createHarness({ transcriptionPayload: { text: "Deepy.", upstream_latency_ms: 80 } });
  await harness.controller.enable();

  emit(harness.controller.recognition(), ["Deepy"], true);
  harness.scheduler.runDelay(160);
  harness.emitAudioFrame(0.05);
  harness.scheduler.runDelay(900);
  await flushPromises();

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.dom.window.document.getElementById("transcript").textContent, "—");
  assert.equal(harness.controller.state(), "armed");
  assert.doesNotMatch(harness.dom.window.document.getElementById("activity").textContent, /failed/i);
  harness.controller.destroy();
  harness.dom.window.close();
});

test("waits for post-wake speech before sending a separate command", async () => {
  const harness = createHarness({ transcriptionPayload: { text: "விளக்கை ஆன் பண்ணு", upstream_latency_ms: 90 } });
  await harness.controller.enable();
  const recognition = harness.controller.recognition();

  emit(recognition, ["Deepy"], true);
  recognition.onspeechend();
  harness.scheduler.runDelay(800);
  assert.equal(harness.fetchCalls.length, 0);

  emit(recognition, ["velakkai on pannu"], true);
  recognition.onspeechend();
  harness.scheduler.runDelay(800);
  await flushPromises();
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.dom.window.document.getElementById("transcript").textContent, "விளக்கை ஆன் பண்ணு");
  harness.controller.destroy();
  harness.dom.window.close();
});

test("wake without a command eventually times out without calling transcription", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  emit(harness.controller.recognition(), ["Deepy"], true);

  harness.scheduler.runDelay(60000);
  await flushPromises();
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.controller.state(), "armed");
  assert.match(harness.dom.window.document.getElementById("activity").textContent, /no command/i);
  harness.controller.destroy();
  harness.dom.window.close();
});

test("surfaces transcription failure in the popup and rearms", async () => {
  const harness = createHarness({
    transcriptionPayload: { detail: "OPENROUTER_API_KEY is required" },
    transcriptionStatus: 503,
  });
  await harness.controller.enable();
  emit(harness.controller.recognition(), ["Deepy"], true);
  emit(harness.controller.recognition(), ["test command"], true);
  harness.scheduler.runDelay(300);
  await flushPromises();

  assert.equal(harness.dom.window.document.getElementById("transcript").textContent, "Transcription failed");
  assert.equal(harness.dom.window.document.getElementById("latency").textContent, "Failed");
  assert.equal(harness.controller.state(), "armed");
  harness.controller.destroy();
  harness.dom.window.close();
});

test("pauses while hidden, resumes when visible, and restarts wake recognition", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  const recognition = harness.controller.recognition();

  Object.defineProperty(harness.dom.window.document, "hidden", { configurable: true, value: true });
  harness.dom.window.document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
  assert.equal(recognition.abortCalls, 1);
  assert.equal(harness.dom.window.document.getElementById("strip").dataset.state, "paused");

  Object.defineProperty(harness.dom.window.document, "hidden", { configurable: true, value: false });
  harness.dom.window.document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
  assert.equal(recognition.startCalls, 2);
  recognition.onend();
  const restartedRecognition = harness.controller.recognition();
  assert.notEqual(restartedRecognition, recognition);
  harness.scheduler.runDelay(250);
  assert.equal(restartedRecognition.startCalls, 1);
  harness.controller.destroy();
  harness.dom.window.close();
});

test("disable stops recognition, recording, microphone tracks, and pending work", async () => {
  const harness = createHarness();
  await harness.controller.enable();
  const recognition = harness.controller.recognition();
  emit(recognition, ["Deepy fan on"], false);
  assert.ok(harness.scheduler.size() > 0);

  harness.controller.disable();

  assert.equal(harness.controller.isEnabled(), false);
  assert.equal(recognition.abortCalls, 1);
  assert.equal(harness.scheduler.size(), 0);
  assert.equal(harness.stopCalls.length, 1);
  assert.ok(harness.captureCalls.includes("destroy"));
  harness.dom.window.close();
});
