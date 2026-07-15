(function initRoomVoiceMode(global) {
  "use strict";

  const WAKE_WORD_ALIASES = [
    "deepy",
    "deep e",
    "deep i",
    "deepie",
    "deepi",
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
      if (overlap === 0 && comparableMerged.length && comparableNext.length) {
        const previousRow = new Array(comparableNext.length + 1).fill(0);
        for (const mergedToken of comparableMerged) {
          let diagonal = 0;
          for (let index = 1; index <= comparableNext.length; index += 1) {
            const above = previousRow[index];
            if (mergedToken === comparableNext[index - 1]) {
              previousRow[index] = diagonal + 1;
            } else {
              previousRow[index] = Math.max(previousRow[index], previousRow[index - 1]);
            }
            diagonal = above;
          }
        }
        const commonTokens = previousRow[comparableNext.length];
        const similarity = commonTokens / Math.min(comparableMerged.length, comparableNext.length);
        const sameStart = comparableMerged[0] === comparableNext[0];
        const sameEnd = comparableMerged.at(-1) === comparableNext.at(-1);
        if (similarity >= 0.7 && (sameStart || sameEnd)) continue;
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
          matchedWakeWord,
          transcript: original,
          normalizedTranscript: transcript,
          command: cleanCommand(original.slice(wakeStart + matchedWakeWord.length)),
        };
      }
    }
    return null;
  }

  function encodeMonoWav(chunks, inputRate, BlobCtor = Blob, outputRate = 16000) {
    const inputLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const input = new Float32Array(inputLength);
    let inputOffset = 0;
    for (const chunk of chunks) {
      input.set(chunk, inputOffset);
      inputOffset += chunk.length;
    }

    const rate = Math.min(inputRate, outputRate);
    const ratio = inputRate / rate;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const samples = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.max(start + 1, Math.min(input.length, Math.floor((index + 1) * ratio)));
      let total = 0;
      for (let cursor = start; cursor < end; cursor += 1) total += input[cursor];
      samples[index] = total / (end - start);
    }

    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeText = (offset, text) => {
      for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
    };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, index) => {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    });
    return new BlobCtor([buffer], { type: "audio/wav" });
  }

  async function createPcmAudioCapture({ windowRef, stream, preRollSeconds = 3, onAudioFrame = null }) {
    const AudioContext = windowRef.AudioContext || windowRef.webkitAudioContext;
    if (!AudioContext) throw new Error("Web Audio capture is unavailable in this browser.");
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;

    let rolling = [];
    let rollingSamples = 0;
    let active = null;
    const maximumRollingSamples = Math.ceil(context.sampleRate * preRollSeconds);

    processor.onaudioprocess = (event) => {
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
      if (onAudioFrame) {
        let energy = 0;
        for (const sample of chunk) energy += sample * sample;
        onAudioFrame({ rms: Math.sqrt(energy / Math.max(1, chunk.length)) });
      }
      if (active) {
        active.push(chunk);
        return;
      }
      rolling.push(chunk);
      rollingSamples += chunk.length;
      while (rollingSamples > maximumRollingSamples && rolling.length) {
        const overflow = rollingSamples - maximumRollingSamples;
        if (overflow >= rolling[0].length) {
          rollingSamples -= rolling[0].length;
          rolling.shift();
        } else {
          rolling[0] = rolling[0].slice(overflow);
          rollingSamples -= overflow;
        }
      }
    };
    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(context.destination);
    await context.resume();

    return {
      begin() {
        active = rolling;
        rolling = [];
        rollingSamples = 0;
      },
      finish() {
        const chunks = active || [];
        active = null;
        rolling = [];
        rollingSamples = 0;
        return encodeMonoWav(chunks, context.sampleRate, windowRef.Blob);
      },
      cancel() {
        active = null;
        rolling = [];
        rollingSamples = 0;
      },
      suspend() {
        return context.suspend();
      },
      resume() {
        return context.resume();
      },
      destroy() {
        processor.disconnect();
        source.disconnect();
        silentOutput.disconnect();
        void context.close();
      },
    };
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
    const latency = options.latency;
    const activity = options.activity;
    const Recognition = options.Recognition || windowRef.SpeechRecognition || windowRef.webkitSpeechRecognition;
    const mediaDevices = options.mediaDevices || (windowRef.navigator && windowRef.navigator.mediaDevices);
    const fetchRef = options.fetchRef || windowRef.fetch.bind(windowRef);
    const captureFactory = options.createAudioCapture || createPcmAudioCapture;
    const schedule = options.setTimeout || windowRef.setTimeout.bind(windowRef);
    const cancel = options.clearTimeout || windowRef.clearTimeout.bind(windowRef);
    const now = options.now || (() => windowRef.performance.now());
    const silenceMs = options.silenceMs ?? 900;
    const finalResultMs = options.finalResultMs ?? 250;
    const speechEndMs = options.speechEndMs ?? 350;
    const recognitionEndMs = options.recognitionEndMs ?? 250;
    // This is only a runaway-recording guard. Normal commands end through VAD silence.
    const hardTimeoutMs = options.hardTimeoutMs ?? 60000;
    const restartMs = options.restartMs ?? 250;
    const vadSilenceMs = options.vadSilenceMs ?? 900;
    const vadArmMs = options.vadArmMs ?? 160;
    const speechThresholdRms = options.speechThresholdRms ?? 0.008;
    const speechNoiseMultiplier = options.speechNoiseMultiplier ?? 2.5;

    let recognition = null;
    let recognitionActive = false;
    let mediaStream = null;
    let audioCapture = null;
    let requestController = null;
    let enabled = false;
    let paused = false;
    let mode = "idle";
    let commandHeard = false;
    let recognitionCycle = 0;
    let restarts = 0;
    let activityInitialized = false;
    let silenceTimer = null;
    let hardTimer = null;
    let restartTimer = null;
    let vadArmTimer = null;
    let recognitionRefreshRequested = false;
    let commandAudioArmed = false;
    let localSpeechDetected = false;
    let noiseFloorRms = 0.002;

    function setText(element, value) {
      if (element) element.textContent = value;
    }

    function engineLabel(state) {
      const labels = {
        idle: "Off",
        requesting: "Requesting permission",
        armed: "Listening for wake word",
        listening: "Recording command",
        transcribing: "Transcribing command",
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
      clearTimer(vadArmTimer);
      silenceTimer = null;
      hardTimer = null;
      vadArmTimer = null;
    }

    function resetCommand({ cancelRequest = false, preserveBufferedAudio = false } = {}) {
      commandHeard = false;
      commandAudioArmed = false;
      localSpeechDetected = false;
      clearCommandTimers();
      if (audioCapture && !preserveBufferedAudio) audioCapture.cancel();
      if (cancelRequest && requestController) requestController.abort();
      requestController = null;
    }

    function renderArmed(detail = "Say “Deepy” followed by a command.") {
      mode = "armed";
      render("armed", "Waiting for “Deepy”", detail);
    }

    function renderListening(detail = "Listening live. Pause briefly when your command is finished.") {
      render("listening", "Recording your command", detail);
    }

    function refreshWakeRecognition() {
      clearTimer(restartTimer);
      restartTimer = null;
      if (!enabled || paused || !recognition) return;
      if (!recognitionActive) {
        scheduleRestart();
        return;
      }
      recognitionRefreshRequested = true;
      try {
        recognition.abort();
      } catch (error) {
        recognitionRefreshRequested = false;
        recognitionActive = false;
        logActivity(`Wake recognition refresh failed: ${String((error && error.message) || error)}`);
        configureRecognition();
        scheduleRestart();
      }
    }

    function scheduleSilence(delay = silenceMs, reason = "silence") {
      clearTimer(silenceTimer);
      silenceTimer = schedule(() => void finalizeCommand(reason), delay);
    }

    function handleAudioFrame(frame) {
      const rms = Number(frame && frame.rms);
      if (!Number.isFinite(rms)) return;
      if (mode !== "listening" || !commandAudioArmed) {
        if (rms < 0.03) noiseFloorRms = noiseFloorRms * 0.98 + rms * 0.02;
        return;
      }

      const startThreshold = Math.max(
        speechThresholdRms,
        Math.min(0.04, noiseFloorRms * speechNoiseMultiplier),
      );
      const threshold = localSpeechDetected
        ? Math.max(speechThresholdRms * 0.55, startThreshold * 0.6)
        : startThreshold;
      if (rms < threshold) {
        noiseFloorRms = noiseFloorRms * 0.995 + rms * 0.005;
        return;
      }

      const firstSpeechFrame = !localSpeechDetected;
      localSpeechDetected = true;
      commandHeard = true;
      if (firstSpeechFrame) {
        logActivity("Local voice activity detected for the command.");
        renderListening("Speech detected. Pause briefly when your command is finished.");
      }
      scheduleSilence(vadSilenceMs, "local voice activity");
    }

    async function finalizeCommand(reason = "silence") {
      if (mode !== "listening") return;
      clearCommandTimers();
      if (!commandHeard) {
        if (audioCapture) audioCapture.cancel();
        setText(transcript, "—");
        logActivity("Wake word detected, but no command was captured.");
        renderArmed("No command heard. Say “Deepy” to try again.");
        refreshWakeRecognition();
        return;
      }

      mode = "transcribing";
      setText(transcript, "Transcribing…");
      render("transcribing", "Transcribing command", "Sending the captured command to GPT-4o Transcribe.");
      const recording = audioCapture.finish();
      const capturedSeconds = Math.max(0, (recording.size - 44) / (16000 * 2));
      requestController = new windowRef.AbortController();
      const thisRequest = requestController;
      const started = now();
      try {
        const response = await fetchRef("/api/voice/transcribe", {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: recording,
          signal: thisRequest.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || `Transcription failed (${response.status})`);
        if (thisRequest.signal.aborted || !enabled) return;
        const rawText = cleanCommand(payload.text);
        const wake = findWakeWord(rawText);
        const command = wake ? wake.command : rawText;
        const elapsedMs = Math.max(0, Math.round(now() - started));
        if (!command) {
          setText(transcript, "—");
          setText(latency, `${elapsedMs} ms`);
          logActivity("Only the wake word was transcribed; no command was submitted.");
          renderArmed("No command heard. Say “Deepy” followed by a command.");
          refreshWakeRecognition();
          return;
        }
        setText(transcript, command);
        setText(latency, `${elapsedMs} ms`);
        const upstream = Number(payload.upstream_latency_ms);
        const upstreamDetail = Number.isFinite(upstream) ? `; OpenRouter ${Math.round(upstream)} ms` : "";
        const billedSeconds = Number(payload.usage && payload.usage.seconds);
        const audioDetail = Number.isFinite(billedSeconds)
          ? `${billedSeconds.toFixed(1)} s billed`
          : `${capturedSeconds.toFixed(1)} s captured`;
        logActivity(`Command transcribed after ${reason} in ${elapsedMs} ms${upstreamDetail}; ${audioDetail}: ${command}`);
        renderArmed(`Transcribed in ${elapsedMs} ms. Say “Deepy” again when ready.`);
        refreshWakeRecognition();
      } catch (error) {
        if (error && error.name === "AbortError") return;
        if (!enabled) return;
        const message = String((error && error.message) || error || "Transcription failed");
        setText(transcript, "Transcription failed");
        setText(latency, "Failed");
        logActivity(`Transcription failed: ${message}`);
        renderArmed(`${message}. Say “Deepy” to try again.`);
        refreshWakeRecognition();
      } finally {
        if (requestController === thisRequest) requestController = null;
        commandHeard = false;
      }
    }

    function beginCommand(wake, isFinal) {
      resetCommand({ preserveBufferedAudio: true });
      mode = "listening";
      commandHeard = Boolean(wake.command);
      commandAudioArmed = commandHeard;
      audioCapture.begin();
      setText(transcript, "Recording…");
      hardTimer = schedule(() => void finalizeCommand("maximum command time"), hardTimeoutMs);
      if (!commandAudioArmed) {
        vadArmTimer = schedule(() => {
          vadArmTimer = null;
          commandAudioArmed = true;
          renderListening("Wake word detected. Listening live for your command.");
        }, vadArmMs);
      }
      if (commandHeard) {
        scheduleSilence(
          isFinal ? finalResultMs : silenceMs,
          isFinal ? "final recognition result" : "silence",
        );
      }
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

        if (mode === "armed") {
          const wakeMatches = resultAlternatives.map((alternative) => findWakeWord(alternative)).filter(Boolean);
          const wake = wakeMatches[0] || null;
          if (!wake) continue;
          setText(heard, wake.matchedWakeWord);
          const alternateWakeWords = wakeMatches
            .slice(1)
            .map((match) => match.matchedWakeWord)
            .filter((value, matchIndex, values) => values.indexOf(value) === matchIndex);
          setText(
            alternatives,
            alternateWakeWords.length
              ? `Wake alternatives: ${alternateWakeWords.join(" · ")}`
              : "No alternate wake-word match returned.",
          );
          logActivity(`Wake word matched as “${wake.alias}”.`);
          beginCommand(wake, Boolean(result.isFinal));
          continue;
        }

        if (mode === "listening") {
          const commandText = cleanCommand((findWakeWord(primary) || {}).command || primary);
          if (!commandText) continue;
          commandHeard = true;
          renderListening();
          if (!localSpeechDetected) {
            scheduleSilence(
              result.isFinal ? finalResultMs : silenceMs,
              result.isFinal ? "final recognition result" : "silence",
            );
          }
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
          render("error", "Wake recognition failed", String((error && error.message) || error));
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
      const configuredRecognition = new Recognition();
      recognition = configuredRecognition;
      configuredRecognition.lang = "en-IN";
      configuredRecognition.continuous = true;
      configuredRecognition.interimResults = true;
      configuredRecognition.maxAlternatives = 3;
      configuredRecognition.onstart = () => {
        if (recognition !== configuredRecognition) return;
        recognitionActive = true;
        recognitionCycle += 1;
        restarts = Math.max(0, recognitionCycle - 1);
        logActivity(restarts ? `Wake recognition restarted (${restarts}).` : "Wake recognition started in English (en-IN)." );
        if (mode === "armed") renderArmed();
        else if (mode === "listening") renderListening();
      };
      configuredRecognition.onspeechend = () => {
        if (mode === "listening" && commandHeard && !localSpeechDetected) {
          scheduleSilence(speechEndMs, "end of speech");
        }
      };
      configuredRecognition.onresult = handleResult;
      configuredRecognition.onend = () => {
        if (recognition !== configuredRecognition) return;
        recognitionActive = false;
        const wasRefresh = recognitionRefreshRequested;
        recognitionRefreshRequested = false;
        if (enabled && !paused) {
          logActivity(wasRefresh
            ? "Wake recognition refreshed for the next command."
            : "Wake recognition stream ended; restarting automatically.");
        }
        if (mode === "listening" && commandHeard && !localSpeechDetected) {
          scheduleSilence(recognitionEndMs, "recognition stream end");
        }
        if (enabled && !paused) configureRecognition();
        scheduleRestart();
      };
      configuredRecognition.onerror = (event) => {
        const error = event && event.error;
        if (error && error !== "no-speech" && error !== "aborted") logActivity(`Wake recognition error: ${error}.`);
        if (error === "not-allowed" || error === "service-not-allowed") {
          disable("Microphone permission denied. Allow microphone access and enable voice again.", "denied");
        } else if (error === "audio-capture") {
          disable("No microphone is available to Chrome.", "error");
        } else if (error === "network") {
          render("error", "Wake service unavailable", "Network error; Chrome will retry.");
        }
      };
    }

    async function enable() {
      if (enabled || !Recognition || !mediaDevices || typeof mediaDevices.getUserMedia !== "function") return;
      enabled = true;
      logActivity("Requesting microphone permission.");
      render("requesting", "Requesting microphone access", "Approve the browser microphone prompt to continue.");
      try {
        mediaStream = await mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        audioCapture = await captureFactory({
          windowRef,
          stream: mediaStream,
          preRollSeconds: 3,
          onAudioFrame: handleAudioFrame,
        });
      } catch (error) {
        enabled = false;
        if (mediaStream && typeof mediaStream.getTracks === "function") mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
        logActivity("Microphone access or audio capture initialization failed.");
        render("denied", "Microphone unavailable", String((error && error.message) || "Allow microphone access, then try again."));
        return;
      }
      logActivity("Microphone permission granted; local command buffer active.");
      if (!recognition) configureRecognition();
      paused = Boolean(documentRef.hidden);
      if (paused) {
        void audioCapture.suspend();
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
      recognitionRefreshRequested = false;
      resetCommand({ cancelRequest: true });
      clearTimer(restartTimer);
      restartTimer = null;
      if (recognition) {
        try {
          recognition.abort();
        } catch (_) {
          // The recognizer may already be stopped.
        }
      }
      recognition = null;
      recognitionActive = false;
      if (audioCapture) audioCapture.destroy();
      audioCapture = null;
      if (mediaStream && typeof mediaStream.getTracks === "function") mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
      const labels = { idle: "Voice mode off", denied: "Microphone permission denied", error: "Voice mode unavailable" };
      if (wasEnabled) logActivity(state === "idle" ? "Voice mode stopped." : detail);
      render(state, labels[state] || "Voice mode unavailable", detail);
    }

    function clearDiagnostics() {
      resetCommand({ cancelRequest: true });
      setText(heard, "—");
      setText(transcript, "—");
      setText(latency, "—");
      setText(alternatives, "Wake recognition alternatives will appear here.");
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
        resetCommand({ cancelRequest: true });
        mode = "armed";
        clearTimer(restartTimer);
        restartTimer = null;
        if (recognition) recognition.abort();
        recognitionActive = false;
        if (audioCapture) void audioCapture.suspend();
        logActivity("Voice mode paused because the page was hidden.");
        render("paused", "Voice mode paused", "Return to this tab to resume listening.");
      } else {
        if (audioCapture) void audioCapture.resume();
        logActivity("Page visible; resuming wake recognition.");
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
    encodeMonoWav,
    createPcmAudioCapture,
    createVoiceModeController,
  };
})(window);
