/**
 * The click-to-edit overlay runtime that gets injected into every preview
 * page (`dist/index.html` and friends). Exported as a string so we can splice
 * it into the served HTML right before `</body>`.
 *
 * Behavior:
 *   - Off by default. Toggled on by parent → iframe message
 *     `{ type: "lab:edit-mode", on: true }` OR by Cmd/Ctrl+E inside the iframe
 *     (which posts `lab:edit-mode-toggle` back so the parent flips its own
 *     state and stays in sync).
 *   - In edit mode: hover any text-bearing leaf element → orange dashed
 *     outline. Click → popover with a textarea pre-filled with the current
 *     text. Save → posts `lab:edit-text` to the parent with the old + new
 *     text plus element context (tag, class). The parent forwards that as a
 *     chat message into the existing agent pipeline.
 *
 * Designed to be tiny and have zero dependencies — it runs inside the
 * student's rendered static site, where we can't assume any framework.
 */

export const PREVIEW_EDITOR_RUNTIME = String.raw`
(function () {
  if (window.__cloudwiseLabEditor) return;
  window.__cloudwiseLabEditor = true;

  let editMode = false;
  let popover = null;
  let hoveredEl = null;
  let editingEl = null;

  // ── Console forwarder ────────────────────────────────────────────────────
  // The lab's PreviewPane renders a console drawer fed by these messages.
  // We forward console.log/info/warn/error/debug plus uncaught errors and
  // unhandled promise rejections. Use a different message type ("lab:console")
  // from the edit-mode plumbing so the parent's listeners don't cross wires.

  function safeStringify(value) {
    try {
      if (value === null) return "null";
      if (value === undefined) return "undefined";
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      if (typeof value === "function") return "[Function" + (value.name ? ": " + value.name : "") + "]";
      if (value instanceof Error) return value.stack || (value.name + ": " + value.message);
      if (typeof value === "object") {
        try { return JSON.stringify(value); }
        catch (_) {
          try { return String(value); } catch (__) { return "[unstringifiable]"; }
        }
      }
      return String(value);
    } catch (_) {
      return "[unstringifiable]";
    }
  }

  function postConsole(level, args) {
    try {
      var serialized = [];
      for (var i = 0; i < args.length; i++) {
        var s = safeStringify(args[i]);
        if (s.length > 4000) s = s.slice(0, 4000) + "…";
        serialized.push(s);
      }
      window.parent.postMessage({
        type: "lab:console",
        level: level,
        args: serialized,
        ts: Date.now(),
      }, "*");
    } catch (_) {}
  }

  var levels = ["log", "info", "warn", "error", "debug"];
  for (var li = 0; li < levels.length; li++) {
    (function (lvl) {
      var orig = console[lvl];
      console[lvl] = function () {
        var args = Array.prototype.slice.call(arguments);
        postConsole(lvl, args);
        if (typeof orig === "function") {
          try { orig.apply(console, args); } catch (_) {}
        }
      };
    })(levels[li]);
  }

  window.addEventListener("error", function (e) {
    var msg = (e && e.message) ? e.message : "Uncaught error";
    var loc = e && e.filename ? (e.filename + ":" + (e.lineno || 0) + ":" + (e.colno || 0)) : "";
    postConsole("error", [msg + (loc ? " (" + loc + ")" : "")]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var reason = e && e.reason;
    postConsole("error", ["Unhandled promise rejection: " + safeStringify(reason)]);
  });

  // ── Style ────────────────────────────────────────────────────────────────

  const style = document.createElement("style");
  style.textContent = [
    "body.cw-lab-edit-mode { cursor: crosshair !important; }",
    "body.cw-lab-edit-mode * { cursor: inherit !important; }",
    "body.cw-lab-edit-mode .cw-lab-hover { outline: 2px dashed #f5a524 !important; outline-offset: 2px !important; cursor: pointer !important; }",
    ".cw-lab-popover { position: absolute; z-index: 2147483647; background: #161b22; border: 1px solid #2a3340; border-radius: 8px; padding: 10px; min-width: 280px; max-width: 480px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); font-family: -apple-system, system-ui, sans-serif; color: #e6edf3; }",
    ".cw-lab-popover textarea { width: 100%; box-sizing: border-box; background: #0d1117; color: #e6edf3; border: 1px solid #2a3340; border-radius: 4px; padding: 6px 10px; font-size: 13px; font-family: inherit; line-height: 1.5; outline: none; resize: vertical; min-height: 60px; }",
    ".cw-lab-popover textarea:focus { border-color: #f5a524; }",
    ".cw-lab-popover .cw-lab-meta { font-size: 11px; color: #8b949e; margin-bottom: 6px; font-family: ui-monospace, SF Mono, monospace; }",
    ".cw-lab-popover .cw-lab-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; align-items: center; }",
    ".cw-lab-popover button { padding: 5px 12px; font-size: 12px; font-weight: 600; border-radius: 4px; border: none; cursor: pointer; font-family: inherit; }",
    ".cw-lab-popover .cw-lab-cancel { background: #2a3340; color: #c9d1d9; }",
    ".cw-lab-popover .cw-lab-save { background: #f5a524; color: #1a1a1a; }",
    ".cw-lab-popover .cw-lab-hint { flex: 1; font-size: 10px; color: #6e7681; font-family: ui-monospace, SF Mono, monospace; }",
  ].join("\n");
  document.head.appendChild(style);

  // ── Mode plumbing ────────────────────────────────────────────────────────

  window.addEventListener("message", function (e) {
    if (!e.data || typeof e.data !== "object") return;
    if (e.data.type === "lab:edit-mode") {
      setEditMode(!!e.data.on);
    }
  });

  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      // Tell the parent — let it flip and broadcast back.
      try {
        window.parent.postMessage({ type: "lab:edit-mode-toggle" }, "*");
      } catch (_) {}
    }
    if (e.key === "Escape" && popover) {
      closePopover();
    }
  });

  function setEditMode(on) {
    if (editMode === on) return;
    editMode = on;
    document.body.classList.toggle("cw-lab-edit-mode", on);
    if (!on) {
      clearHover();
      closePopover();
    }
  }

  // ── Editable element detection ───────────────────────────────────────────

  // A "leaf text element" is one whose direct contents are only text — no
  // element children. That's where we want the click target to land. We walk
  // up from the actual click target to the nearest such element.
  function findEditable(target) {
    let el = target;
    while (el && el !== document.body && el !== document.documentElement) {
      const tag = el.tagName;
      // Skip technical elements
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" ||
          tag === "META" || tag === "IFRAME" || tag === "NOSCRIPT" ||
          el.classList.contains("cw-lab-popover") ||
          (el.closest && el.closest(".cw-lab-popover"))) {
        return null;
      }
      const text = (el.textContent || "").trim();
      if (text.length > 0) {
        // Has text. Only "editable" if no element children — leaf.
        let hasElementChild = false;
        for (let i = 0; i < el.children.length; i++) {
          if (el.children[i].nodeType === 1) {
            hasElementChild = true;
            break;
          }
        }
        if (!hasElementChild) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // ── Hover ────────────────────────────────────────────────────────────────

  document.addEventListener("mouseover", function (e) {
    if (!editMode) return;
    const el = findEditable(e.target);
    if (el === hoveredEl) return;
    clearHover();
    if (el) {
      el.classList.add("cw-lab-hover");
      hoveredEl = el;
    }
  });

  document.addEventListener("mouseout", function () {
    if (!editMode) return;
    clearHover();
  });

  function clearHover() {
    if (hoveredEl) {
      hoveredEl.classList.remove("cw-lab-hover");
      hoveredEl = null;
    }
  }

  // ── Click → open popover ─────────────────────────────────────────────────

  // Capture phase + preventDefault so we override links/buttons in the page.
  document.addEventListener("click", function (e) {
    if (!editMode) return;
    const inPopover = e.target.closest && e.target.closest(".cw-lab-popover");
    if (inPopover) return; // let popover clicks through
    const el = findEditable(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    showPopover(el);
  }, true);

  function showPopover(el) {
    closePopover();
    editingEl = el;
    const oldText = (el.textContent || "").replace(/\s+/g, " ").trim();
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === "string"
      ? el.className.split(/\s+/).filter(c => c && !c.startsWith("cw-lab-")).slice(0, 3).join(" ")
      : "";

    const meta = "<" + tag + (cls ? " class=\"" + cls + "\"" : "") + ">";

    popover = document.createElement("div");
    popover.className = "cw-lab-popover";
    popover.innerHTML =
      '<div class="cw-lab-meta"></div>' +
      '<textarea rows="3"></textarea>' +
      '<div class="cw-lab-actions">' +
        '<span class="cw-lab-hint">⌘↵ to save · Esc to cancel</span>' +
        '<button class="cw-lab-cancel">Cancel</button>' +
        '<button class="cw-lab-save">Save</button>' +
      '</div>';

    document.body.appendChild(popover);
    popover.querySelector(".cw-lab-meta").textContent = meta;
    const ta = popover.querySelector("textarea");
    ta.value = oldText;

    // Position below the element, clamped to viewport
    const rect = el.getBoundingClientRect();
    const popW = 360;
    let top = window.scrollY + rect.bottom + 6;
    let left = window.scrollX + rect.left;
    const maxLeft = window.scrollX + window.innerWidth - popW - 16;
    if (left > maxLeft) left = maxLeft;
    if (left < window.scrollX + 8) left = window.scrollX + 8;
    popover.style.top = top + "px";
    popover.style.left = left + "px";
    popover.style.width = popW + "px";

    setTimeout(function () { ta.focus(); ta.select(); }, 0);

    popover.querySelector(".cw-lab-cancel").addEventListener("click", closePopover);
    popover.querySelector(".cw-lab-save").addEventListener("click", saveEdit);

    ta.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        saveEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePopover();
      }
    });

    function saveEdit() {
      const newText = ta.value;
      if (newText !== oldText && newText.length > 0) {
        try {
          window.parent.postMessage({
            type: "lab:edit-text",
            oldText: oldText,
            newText: newText,
            elementTag: tag,
            elementClass: cls,
          }, "*");
        } catch (_) {}
      }
      closePopover();
    }
  }

  function closePopover() {
    if (popover && popover.parentElement) {
      popover.parentElement.removeChild(popover);
    }
    popover = null;
    editingEl = null;
  }
})();
`;
