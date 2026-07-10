import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const staticRoot = new URL("../src/room_agent/static/", import.meta.url);

function createRenderer() {
  const dom = new JSDOM("<main id=target></main>", { runScripts: "outside-only" });
  [
    "vendor/marked.umd.js",
    "vendor/purify.min.js",
    "vendor/highlight.min.js",
    "markdown.js",
  ].forEach((path) => dom.window.eval(readFileSync(new URL(path, staticRoot), "utf8")));
  return { dom, target: dom.window.document.getElementById("target") };
}

test("renders GFM headings, tables, tasks, and strikethrough", () => {
  const { dom, target } = createRenderer();
  dom.window.RoomMarkdown.setMarkdown(
    target,
    "### Room tools\n\n| Tool | State |\n| --- | --- |\n| Light | On |\n\n- [x] Ready\n\n~~old~~",
  );

  assert.equal(target.querySelector("h3")?.textContent, "Room tools");
  assert.equal(target.querySelectorAll(".markdown-table-wrap table tbody tr").length, 1);
  assert.equal(target.querySelector("input[type=checkbox]")?.checked, true);
  assert.equal(target.querySelector("del")?.textContent, "old");
});

test("highlights known code languages and labels unknown languages as plaintext", () => {
  const { dom, target } = createRenderer();
  dom.window.RoomMarkdown.setMarkdown(
    target,
    "```python\nimport time\n```\n\n```madeuplang\nhello\n```",
  );

  const blocks = target.querySelectorAll("pre");
  assert.equal(blocks[0].dataset.language, "python");
  assert.ok(blocks[0].querySelector(".hljs-keyword"));
  assert.equal(blocks[1].dataset.language, "plaintext");
  assert.ok(blocks[1].querySelector("code")?.classList.contains("language-plaintext"));
});

test("sanitizes markup and permits only safe external links", () => {
  const { dom, target } = createRenderer();
  dom.window.RoomMarkdown.setMarkdown(
    target,
    '<img src="x" onerror="alert(1)"> [bad](javascript:alert(1)) [safe](https://example.com)',
  );

  assert.equal(target.querySelector("img")?.hasAttribute("onerror"), false);
  assert.equal(target.querySelectorAll("a").length, 1);
  const link = target.querySelector("a");
  assert.equal(link?.getAttribute("href"), "https://example.com");
  assert.equal(link?.getAttribute("target"), "_blank");
  assert.equal(link?.getAttribute("rel"), "noopener noreferrer");
});
