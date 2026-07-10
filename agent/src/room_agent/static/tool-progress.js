(function registerToolProgress(global) {
  function resolveToolResult(steps, { toolCallId = "", success = true, content = "", elapsedMs = 0 }) {
    const matchingStep = [...steps].reverse().find(
      (step) => step.type === "tool_call" && step.success === null && (!toolCallId || step.toolCallId === toolCallId)
    );
    if (!matchingStep) return false;
    matchingStep.success = success;
    matchingStep.content = content;
    matchingStep.elapsedMs = Math.max(0, Number(elapsedMs) || 0);
    return true;
  }

  function failPendingToolCalls(steps, status) {
    steps.forEach((step) => {
      if (step.type !== "tool_call" || step.success !== null) return;
      step.success = false;
      step.content = status === "stopped" ? "Stopped before a result was received." : "No result was received.";
    });
  }

  global.RoomToolProgress = { resolveToolResult, failPendingToolCalls };
})(window);
