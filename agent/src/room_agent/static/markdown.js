(function registerRoomMarkdown(global) {
  function renderMarkdown(markdown) {
    if (!global.marked || !global.DOMPurify) return "";
    const rendered = global.marked.parse(String(markdown || ""), {
      async: false,
      breaks: true,
      gfm: true,
    });
    return global.DOMPurify.sanitize(rendered, {
      FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["style"],
    });
  }

  function setMarkdown(target, markdown) {
    target.innerHTML = renderMarkdown(markdown);
    target.querySelectorAll("a").forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (!/^(https?:|mailto:)/i.test(href)) {
        link.replaceWith(global.document.createTextNode(link.textContent || href));
        return;
      }
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
    target.querySelectorAll("table").forEach((table) => {
      const wrapper = global.document.createElement("div");
      wrapper.className = "markdown-table-wrap";
      table.before(wrapper);
      wrapper.appendChild(table);
    });
    target.querySelectorAll("pre > code").forEach((code) => {
      const languageClass = [...code.classList].find((name) => name.startsWith("language-"));
      const requestedLanguage = languageClass ? languageClass.slice("language-".length) : "";
      const supportedLanguage = requestedLanguage && global.hljs && global.hljs.getLanguage(requestedLanguage);
      const language = supportedLanguage ? requestedLanguage : "plaintext";
      if (!supportedLanguage) code.className = "language-plaintext";
      code.parentElement.dataset.language = language;
      if (global.hljs) global.hljs.highlightElement(code);
    });
  }

  global.RoomMarkdown = { renderMarkdown, setMarkdown };
})(window);
