(function initRoomVoiceMode(global) {
  "use strict";

  const WAKE_WORD_ALIASES = [
    "deepy",
    "deep e",
    "deepie",
    "deep ee",
    "dp",
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

  function normalizeSpeech(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase("en-IN")
      .replace(/[.,!?;:\"'()[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanCommand(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/^[\s,!?;:.-]+/u, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function mergeSpeechSegments(values) {
    const mergedTokens = [];
    for (const value of values) {
      const text = cleanCommand(value);
      if (!text) continue;
      const tokens = text.split(/\s+/);
      const comparableMerged = mergedTokens.map((token) => normalizeSpeech(token));
      const comparableNext = tokens.map((token) => normalizeSpeech(token));
      let overlap = 0;
      const maximum = Math.min(comparableMerged.length, comparableNext.length);
      for (let size = maximum; size > 0; size -= 1) {
        const tail = comparableMerged.slice(-size);
        const head = comparableNext.slice(0, size);
        if (tail.every((token, index) => token === head[index])) {
          overlap = size;
          break;
        }
      }
      mergedTokens.push(...tokens.slice(overlap));
    }
    return cleanCommand(mergedTokens.join(" "));
  }

  function findWakeWord(value, aliases = WAKE_WORD_ALIASES) {
    const original = String(value || "").normalize("NFKC").trim();
    const transcript = normalizeSpeech(original);
    const candidates = aliases
      .map((alias) => normalizeSpeech(alias))
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);

    for (const alias of candidates) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const latinAlias = /[a-z]/i.test(alias);
      const pattern = latinAlias
        ? new RegExp(`(?:^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, "iu")
        : new RegExp(`(${escaped})`, "u");
      const match = pattern.exec(original);
      if (match) {
        const matchedWakeWord = match[1];
        const wakeStart = match.index + match[0].indexOf(matchedWakeWord);
        return {
          alias,
          transcript: original,
          normalizedTranscript: transcript,
          command: cleanCommand(original.slice(wakeStart + matchedWakeWord.length)),
        };
      }
    }
    return null;
  }

  function createVoiceModeController(options = {}) {
    const windowRef = options.windowRef || global;
    const documentRef = options.documentRef || windowRef.document;
    const button = options.button;
    const buttonText = options.buttonText;
    const clearButton = options.clearButton;
    const launcher = options.launcher;
    const strip = options.strip;
    const status = options.status;
    const statusDetail = options.statusDetail;
    const heard = options.heard;
    const alternatives = options.alternatives;
    const transcript = options.transcript;
    const engineStatus = options.engineStatus;
    const restartCount = options.restartCount;
    const activity = options.activity;
    const onTranscript = options.onTranscript || (() => {});
    const Recognition = options.Recognition || windowRef.SpeechRecognition || windowRef.webkitSpeechRecognition;
    const mediaDevices = options.mediaDevices || (windowRef.navigator && windowRef.navigator.mediaDevices);
    const schedule = options.setTimeout || windowRef.setTimeout.bind(windowRef);
    const cancel = options.clearTimeout || windowRef.clearTimeout.bind(windowRef);
    const silenceMs = options.silenceMs ?? 2200;
    const speechEndMs = options.speechEndMs ?? 800;
    const recognitionEndMs = options.recognitionEndMs ?? 450;
    const hardTimeoutMs = options.hardTimeoutMs ?? 12000;
    const restartMs = options.restartMs ?? 250;

    let recognition = null;
    let recognitionActive = false;
    let enabled = false;
    let paused = false;
    let mode = "idle";
    let recognitionCycle = 0;
    let restarts = 0;
    let activityInitialized = false;
    let silenceTimer = null;
    let hardTimer = null;
    let restartTimer = null;
    const finalSegments = new Map();
    const interimSegments = new Map();

    function setText(element, value) {
      if (element) element.textContent = value;
    }

    function engineLabel(state) {
      const labels = {
        idle: "Off",
        requesting: "Requesting permission",
        armed: "Listening for wake word",
        listening: "Capturing command",
        paused: "Paused",
        denied: "Permission denied",
        unsupported: "Unsupported",
        error: "Error",
      };
      return labels[state] || state;
    }

    function render(state, label, detail) {
      if (strip) strip.dataset.state = state;
      if (launcher) {
        launcher.dataset.voiceState = state;
        launcher.setAttribute("aria-label", `Voice: ${label}`);
      }
      setText(status, label);
      setText(statusDetail, detail);
      setText(engineStatus, engineLabel(state));
      setText(restartCount, String(restarts));
      setText(buttonText, enabled ? "Stop voice" : "Enable voice");
      if (button) {
        button.setAttribute("aria-pressed", String(enabled));
        button.disabled = state === "unsupported" || state === "requesting";
      }
    }

    function logActivity(message) {
      if (!activity) return;
      if (!activityInitialized) {
        activity.replaceChildren();
        activityInitialized = true;
      }
      const item = documentRef.createElement("li");
      const time = documentRef.createElement("time");
      const text = documentRef.createElement("span");
      time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      text.textContent = message;
      item.append(time, text);
      activity.prepend(item);
      while (activity.children.length > 10) activity.lastElementChild.remove();
    }

    function clearTimer(timer) {
      if (timer !== null) cancel(timer);
    }

    function clearCommandTimers() {
      clearTimer(silenceTimer);
      clearTimer(hardTimer);
      silenceTimer = null;
      hardTimer = null;
    }

    function sortedSegments() {
      const segments = [...finalSegments.values(), ...interimSegments.values()];
      return segments.sort((left, right) => left.cycle - right.cycle || left.index - right.index);
    }

    function combinedCommand() {
      return mergeSpeechSegments(sortedSegments().map((segment) => segment.text));
    }

    function renderArmed(detail = "Say “Deepy” followed by a Tamil command.") {
      mode = "armed";
      render("armed", "Waiting for “Deepy”", detail);
    }

    function renderListening() {
      render("listening", "Listening for your command", "Speak naturally, then pause when finished.");
      setText(transcript, combinedCommand() || "Listening…");
    }

    function resetCommand() {
      finalSegments.clear();
      interimSegments.clear();
      clearCommandTimers();
    }

    function finalizeCommand(reason = "silence") {
      const command = combinedCommand();
      resetCommand();
      if (command) {
        setText(transcript, command);
        onTranscript(command);
        logActivity(`Command finalized after ${reason}: ${command}`);
        renderArmed("Transcript copied to the composer. Say “Deepy” again when ready.");
      } else {
        setText(transcript, "—");
        logActivity("Wake word detected, but no command was captured.");
        renderArmed("No command heard. Say “Deepy” to try again.");
      }
    }

    function scheduleSilence(delay = silenceMs, reason = "silence") {
      clearTimer(silenceTimer);
      silenceTimer = schedule(() => finalizeCommand(reason), delay);
    }

    function commandText(value) {
      const wake = findWakeWord(value);
      return wake ? wake.command : cleanCommand(value);
    }

    function setCommandSegment(key, cycle, index, value, isFinal) {
      const text = commandText(value);
      if (!text) {
        interimSegments.delete(key);
        if (!isFinal) finalSegments.delete(key);
        renderListening();
        return;
      }
      const segment = { key, cycle, index, text };
      if (isFinal) {
        finalSegments.set(key, segment);
        interimSegments.delete(key);
      } else if (!finalSegments.has(key)) {
        interimSegments.set(key, segment);
      }
      renderListening();
      scheduleSilence();
    }

    function beginCommand(value, isFinal, resultIndex) {
      mode = "listening";
      resetCommand();
      hardTimer = schedule(() => finalizeCommand("maximum command time"), hardTimeoutMs);
      const key = `${recognitionCycle}:${resultIndex}`;
      setCommandSegment(key, recognitionCycle, resultIndex, value, isFinal);
      renderListening();
    }

    function alternativesFor(result) {
      const values = [];
      if (!result) return values;
      for (let index = 0; index < result.length; index += 1) {
        const value = result[index] && result[index].transcript;
        if (value) values.push(value);
      }
      return values;
    }

    function handleResult(event) {
      const start = Number(event.resultIndex) || 0;
      for (let index = start; index < event.results.length; index += 1) {
        const result = event.results[index];
        const resultAlternatives = alternativesFor(result);
        const primary = resultAlternatives[0] || "";
        if (primary) setText(heard, primary);
        setText(
          alternatives,
          resultAlternatives.length > 1
            ? `Alternatives: ${resultAlternatives.slice(1).join(" · ")}`
            : "No alternate recognition result returned.",
        );

        if (mode === "armed") {
          let wake = null;
          for (const alternative of resultAlternatives) {
            wake = findWakeWord(alternative);
            if (wake) break;
          }
          if (!wake) continue;
          setText(heard, wake.transcript);
          logActivity(`Wake word matched as “${wake.alias}”.`);
          beginCommand(wake.transcript, Boolean(result.isFinal), index);
          continue;
        }

        if (mode === "listening") {
          const key = `${recognitionCycle}:${index}`;
          setCommandSegment(key, recognitionCycle, index, primary, Boolean(result.isFinal));
        }
      }
    }

    function startRecognition() {
      if (!enabled || paused || recognitionActive || !recognition) return;
      try {
        recognition.start();
        recognitionActive = true;
      } catch (error) {
        if (!error || error.name !== "InvalidStateError") {
          logActivity(`Recognition start failed: ${String((error && error.message) || error)}`);
          render("error", "Voice recognition failed", String((error && error.message) || error));
        }
      }
    }

    function scheduleRestart() {
      clearTimer(restartTimer);
      if (!enabled || paused) return;
      restartTimer = schedule(() => {
        restartTimer = null;
        startRecognition();
      }, restartMs);
    }

    function configureRecognition() {
      recognition = new Recognition();
      recognition.lang = "ta-IN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 3;
      recognition.onstart = () => {
        recognitionActive = true;
        recognitionCycle += 1;
        restarts = Math.max(0, recognitionCycle - 1);
        logActivity(restarts ? `Recognition restarted (${restarts}).` : "Recognition started in Tamil (ta-IN)." );
        if (mode !== "listening") renderArmed();
        else renderListening();
      };
      recognition.onspeechend = () => {
        if (mode === "listening" && combinedCommand()) scheduleSilence(speechEndMs, "end of speech");
      };
      recognition.onresult = handleResult;
      recognition.onend = () => {
        recognitionActive = false;
        if (enabled && !paused) logActivity("Recognition stream ended; restarting automatically.");
        if (mode === "listening" && combinedCommand()) {
          scheduleSilence(recognitionEndMs, "recognition stream end");
        }
        scheduleRestart();
      };
      recognition.onerror = (event) => {
        const error = event && event.error;
        if (error && error !== "no-speech" && error !== "aborted") logActivity(`Recognition error: ${error}.`);
        if (error === "not-allowed" || error === "service-not-allowed") {
          disable("Microphone permission denied. Allow microphone access and enable voice again.", "denied");
        } else if (error === "audio-capture") {
          disable("No microphone is available to Chrome.", "error");
        } else if (error === "network") {
          render("error", "Speech service unavailable", "Network error; Chrome will retry.");
        }
      };
    }

    async function enable() {
      if (enabled || !Recognition || !mediaDevices || typeof mediaDevices.getUserMedia !== "function") return;
      enabled = true;
      logActivity("Requesting microphone permission.");
      render("requesting", "Requesting microphone access", "Approve the browser microphone prompt to continue.");
      try {
        const stream = await mediaDevices.getUserMedia({ audio: true });
        if (stream && typeof stream.getTracks === "function") {
          stream.getTracks().forEach((track) => track.stop());
        }
      } catch (_) {
        enabled = false;
        logActivity("Microphone permission was denied.");
        render("denied", "Microphone permission denied", "Allow microphone access in Chrome, then try again.");
        return;
      }
      logActivity("Microphone permission granted.");
      if (!recognition) configureRecognition();
      paused = Boolean(documentRef.hidden);
      if (paused) {
        render("paused", "Voice mode paused", "Return to this tab to resume listening.");
      } else {
        renderArmed();
        startRecognition();
      }
    }

    function disable(detail = "Press Enable voice to request microphone access.", state = "idle") {
      const wasEnabled = enabled;
      enabled = false;
      paused = false;
      mode = "idle";
      resetCommand();
      clearTimer(restartTimer);
      restartTimer = null;
      if (recognition) {
        try {
          recognition.abort();
        } catch (_) {
          // The recognizer may already be stopped.
        }
      }
      recognitionActive = false;
      const labels = {
        idle: "Voice mode off",
        denied: "Microphone permission denied",
        error: "Voice mode unavailable",
      };
      if (wasEnabled) logActivity(state === "idle" ? "Voice mode stopped." : detail);
      render(state, labels[state] || "Voice mode unavailable", detail);
    }

    function clearDiagnostics() {
      resetCommand();
      setText(heard, "—");
      setText(transcript, "—");
      setText(alternatives, "Recognition alternatives will appear here.");
      if (activity) activity.replaceChildren();
      activityInitialized = true;
      logActivity("Voice diagnostics cleared.");
      if (enabled && !paused) renderArmed("Diagnostics cleared. Say “Deepy” when ready.");
    }

    function toggle() {
      if (enabled) disable();
      else void enable();
    }

    function handleVisibilityChange() {
      if (!enabled) return;
      paused = Boolean(documentRef.hidden);
      if (paused) {
        resetCommand();
        mode = "armed";
        clearTimer(restartTimer);
        restartTimer = null;
        if (recognition) recognition.abort();
        recognitionActive = false;
        logActivity("Voice mode paused because the page was hidden.");
        render("paused", "Voice mode paused", "Return to this tab to resume listening.");
      } else {
        logActivity("Page visible; resuming recognition.");
        renderArmed();
        startRecognition();
      }
    }

    function init() {
      if (clearButton) clearButton.addEventListener("click", clearDiagnostics);
      if (!Recognition || !mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
        render("unsupported", "Voice mode unsupported", "Use Chrome with the page served from localhost or HTTPS.");
        logActivity("Speech Recognition API is unavailable in this browser.");
        return;
      }
      render("idle", "Voice mode off", "Press Enable voice to request microphone access.");
      if (button) button.addEventListener("click", toggle);
      documentRef.addEventListener("visibilitychange", handleVisibilityChange);
    }

    function destroy() {
      disable();
      if (button) button.removeEventListener("click", toggle);
      if (clearButton) clearButton.removeEventListener("click", clearDiagnostics);
      documentRef.removeEventListener("visibilitychange", handleVisibilityChange);
    }

    return {
      init,
      enable,
      disable,
      clearDiagnostics,
      destroy,
      isEnabled: () => enabled,
      state: () => mode,
      recognition: () => recognition,
    };
  }

  global.RoomVoiceMode = {
    WAKE_WORD_ALIASES,
    normalizeSpeech,
    cleanCommand,
    mergeSpeechSegments,
    findWakeWord,
    createVoiceModeController,
  };
})(window);
