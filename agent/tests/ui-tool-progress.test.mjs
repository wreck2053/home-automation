import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

function createProgressHelpers() {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  const source = readFileSync(new URL("../src/room_agent/static/tool-progress.js", import.meta.url), "utf8");
  dom.window.eval(source);
  return dom.window.RoomToolProgress;
}

test("matches out-of-order results to the correct repeated tool calls", () => {
  const { resolveToolResult } = createProgressHelpers();
  const steps = [
    { type: "tool_call", toolCallId: "toggle-1", success: null, content: "Waiting" },
    { type: "tool_call", toolCallId: "toggle-2", success: null, content: "Waiting" },
  ];

  assert.equal(resolveToolResult(steps, { toolCallId: "toggle-2", success: true, content: "Light on", elapsedMs: 2000 }), true);
  assert.equal(resolveToolResult(steps, { toolCallId: "toggle-1", success: true, content: "Light off", elapsedMs: 1000 }), true);
  assert.deepEqual(steps.map((step) => [step.toolCallId, step.success, step.content]), [
    ["toggle-1", true, "Light off"],
    ["toggle-2", true, "Light on"],
  ]);
});

test("marks unfinished actions failed when a run ends", () => {
  const { failPendingToolCalls } = createProgressHelpers();
  const steps = [
    { type: "tool_call", success: true, content: "Done" },
    { type: "tool_call", success: null, content: "Waiting" },
  ];

  failPendingToolCalls(steps, "stopped");
  assert.equal(steps[0].success, true);
  assert.equal(steps[1].success, false);
  assert.equal(steps[1].content, "Stopped before a result was received.");
});
