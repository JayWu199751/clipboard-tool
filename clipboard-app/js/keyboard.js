/* ============================================================
   ClipFlow — keyboard.js
   Keyboard-first input layer: one real `keydown` listener on
   document (capture) dispatches through a registered keymap.
   Every shortcut advertised in the UI must exist here — the
   cheat-sheet overlay renders live from `Keyboard.list()`.
   Electron seam: mirror `register()` entries into
   `globalShortcut.register()` (browser-reserved combos like
   Ctrl+1 / Ctrl+, / Ctrl+D work natively there).
   ============================================================ */
(function () {
  "use strict";

  var IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform || "");
  var MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

  /* Normalize a KeyboardEvent into a string id like "ctrl+k", "enter", "arrowdown". */
  function keyId(e) {
    var parts = [];
    if (e.ctrlKey || (IS_MAC && e.metaKey)) parts.push("ctrl");
    else if (e.metaKey) parts.push("meta");
    if (e.shiftKey && e.key !== "Shift") parts.push("shift");
    if (e.altKey && e.key !== "Alt") parts.push("alt");

    var k = (e.key || "").toLowerCase();
    // Ignore bare modifier presses
    if (k === "control" || k === "shift" || k === "alt" || k === "meta") return null;
    parts.push(k);
    return parts.join("+");
  }

  var globalMap = []; // [{keys:[], keySet:Set, handler, desc, group, reserved}]

  /**
   * register(keys, handler, desc, meta)
   * meta: { group: "Navigation" | "Actions" | ..., reserved: bool }
   * `reserved` marks combos the browser steals (tab strip, settings, bookmark) —
   * always register a browser-safe fallback key alongside them.
   */
  function register(keys, handler, desc, meta) {
    if (!Array.isArray(keys)) keys = [keys];
    meta = meta || {};
    globalMap.push({
      keys: keys.slice(),
      keySet: new Set(keys),
      handler: handler,
      desc: desc || "",
      group: meta.group || "General",
      reserved: !!meta.reserved
    });
  }

  function dispatch(e) {
    var id = keyId(e);
    if (!id) return;
    for (var i = 0; i < globalMap.length; i++) {
      if (globalMap[i].keySet.has(id)) {
        globalMap[i].handler(e, id);
        return;
      }
    }
  }

  document.addEventListener("keydown", dispatch, true); // capture: app owns keys

  /* ---------- Platform-aware display ---------- */
  var KEY_NAMES = {
    "meta": "⌘", "arrowup": "↑", "arrowdown": "↓", "arrowleft": "←", "arrowright": "→",
    "enter": "⏎", "escape": "Esc", "backspace": "⌫", "delete": "Del",
    "home": "Home", "end": "End", " ": "空格", "tab": "Tab"
  };

  function token(p) {
    if (p === "ctrl") return MOD_LABEL;
    if (p === "alt") return IS_MAC ? "⌥" : "Alt";
    if (p === "shift") return "⇧";
    if (KEY_NAMES[p]) return KEY_NAMES[p];
    return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
  }

  /** "ctrl+shift+v" → "Ctrl ⇧ V" (or "⌘ ⇧ V" on macOS) */
  function combo(id) {
    return id.split("+").map(token).join("\u2009");
  }

  /** Live registry dump — single source of truth for the cheat sheet. */
  function list() {
    return globalMap.map(function (e) {
      return {
        desc: e.desc,
        group: e.group,
        reserved: e.reserved,
        keys: e.keys.map(combo),
        raw: e.keys.slice()
      };
    });
  }

  /* ---------- Local list navigation helper ---------- */
  function createNavigator(getCount, onMove) {
    return {
      down: function (e) { e.preventDefault(); onMove(+1, e); },
      up: function (e) { e.preventDefault(); onMove(-1, e); },
      first: function (e) { e.preventDefault(); onMove(0, e, 0); },
      last: function (e) { e.preventDefault(); onMove(0, e, getCount() - 1); },
      count: getCount
    };
  }

  window.Keyboard = {
    IS_MAC: IS_MAC,
    MOD_LABEL: MOD_LABEL,
    keyId: keyId,
    register: register,
    combo: combo,
    list: list,
    createNavigator: createNavigator
  };
})();
