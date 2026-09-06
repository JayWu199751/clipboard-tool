/* ============================================================
   ClipFlow — clipboard.js (simplified HUD)
   Data layer: text + image clips only; copy is the only action.
   Electron seam: replace `copy()` with `electron.clipboard
   .writeText / writeImage`; feed `items` from SQLite.
   ============================================================ */
(function () {
  "use strict";

  var NOW = Date.now();
  var MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;

  var SEED = [
    { id: "t01", type: "text", source: "Slack",     ts: NOW - 2 * MIN,
      content: "Standup moved to 10:30 — design review runs over. Notes in Notion, thread #team-eng." },
    { id: "i01", type: "image", source: "Figma",    ts: NOW - 14 * MIN,
      content: "clipflow-onboarding@2x.png", width: 1440, height: 900, c1: "#34315E", c2: "#14313B" },
    { id: "t02", type: "text", source: "Safari",    ts: NOW - 26 * MIN,
      content: "ssh -i ~/.ssh/id_ed25519_work deploy@prod-03.internal \"systemctl status clipflow\"" },
    { id: "t03", type: "text", source: "Mail",      ts: NOW - 51 * MIN,
      content: "Shipping address:\nMs. Ada Lovelace\n12 Analytical Engine Rd\nCambridge CB2 1TN, UK" },
    { id: "i02", type: "image", source: "Screenshot", ts: NOW - 2 * HOUR,
      content: "error-trace-2026-09-05.png", width: 2560, height: 1440, c1: "#4A2545", c2: "#16213A" },
    { id: "t04", type: "text", source: "Notion",    ts: NOW - 3 * HOUR,
      content: "Meeting notes — Q3 planning:\n1. Ship HUD panel\n2. Cut scope: copy-only\n3. Revisit sync in Q4" },
    { id: "t05", type: "text", source: "Linear",    ts: NOW - 4 * HOUR,
      content: "ENG-412 · Clipboard history leaks PII when synced — encrypt at rest with OS keychain, default OFF." },
    { id: "i03", type: "image", source: "Figma",    ts: NOW - 6 * HOUR,
      content: "icon-set-outline-24.png", width: 512, height: 512, c1: "#1F3A34", c2: "#3A2E52" },
    { id: "t06", type: "text", source: "Terminal",  ts: NOW - 8 * HOUR,
      content: "pnpm run dev:web && pnpm run build -- --minify css" },
    { id: "t07", type: "text", source: "WhatsApp",  ts: NOW - 11 * HOUR,
      content: "Gate code for the studio: 4821# — works until the 1st." },
    { id: "i04", type: "image", source: "Preview",  ts: NOW - 22 * HOUR,
      content: "office-photo-raw.png", width: 4032, height: 3024, c1: "#3E2F23", c2: "#1C2B3E" },
    { id: "t08", type: "text", source: "Obsidian",  ts: NOW - 26 * HOUR,
      content: "\"Simplicity is the ultimate sophistication.\" — keep in the HUD copy deck." },
    { id: "i05", type: "image", source: "Screenshot", ts: NOW - 2 * DAY,
      content: "dashboard-dark-mock.png", width: 1920, height: 1080, c1: "#232052", c2: "#103040" },
    { id: "t09", type: "text", source: "Chrome",    ts: NOW - 2.6 * DAY,
      content: "Invoice #2026-114 · Total due: $1,840.00 · Wire ref: 8FQ-2210-KL — pay before Friday." }
  ];

  /* ---------- Deletions (persisted by id) — declared BEFORE `items` so the
     load-time filter sees DEL_KEY (var hoisting would leave it undefined). ---------- */
  var DEL_KEY = "clipflow.deleted.v1";
  function deletedIds() {
    try { return JSON.parse(localStorage.getItem(DEL_KEY)) || []; } catch (e) { return []; }
  }
  function saveDeleted(ids) {
    try { localStorage.setItem(DEL_KEY, JSON.stringify(ids)); } catch (e) {}
  }
  function isDeleted(id) { return deletedIds().indexOf(id) !== -1; }

  var items = SEED.filter(function (i) { return !isDeleted(i.id); })
                  .sort(function (a, b) { return b.ts - a.ts; });

  function remove(id) {
    var idx = -1;
    for (var i = 0; i < items.length; i++) if (items[i].id === id) { idx = i; break; }
    if (idx === -1) return null;
    var removed = items.splice(idx, 1)[0];
    var ids = deletedIds(); ids.push(id); saveDeleted(ids);
    return { item: removed, index: idx };
  }

  function restore(item, index) {
    if (!item) return;
    saveDeleted(deletedIds().filter(function (d) { return d !== item.id; }));
    items.splice(Math.min(index == null ? items.length : index, items.length), 0, item);
  }

  /* ---------- Notes (备注) — persisted per item id ---------- */
  var NOTES_KEY = "clipflow.notes.v1";
  var notes = (function () {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || {}; } catch (e) { return {}; }
  })();

  function getNote(id) { return notes[id] || ""; }

  function setNote(id, text) {
    text = (text || "").trim();
    if (text) notes[id] = text; else delete notes[id];
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch (e) {}
  }

  function query(opts) {
    opts = opts || {};
    var q = (opts.search || "").trim().toLowerCase();
    if (!q) return items.slice();
    return items.filter(function (i) {
      return (i.content + " " + i.source).toLowerCase().indexOf(q) !== -1;
    });
  }

  function total() { return items.length; }

  /* ---------- Copy (Electron seam) ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacy(text); });
    }
    return Promise.resolve(legacy(text));
    function legacy(t) {
      try {
        var ta = document.createElement("textarea");
        ta.value = t; ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }
  }

  /** Image clips are rendered to a real PNG and written to the clipboard
      (falls back to the file name when the API is unavailable). */
  function copy(item) {
    if (item.type === "text") return copyText(item.content);
    return new Promise(function (resolve) {
      try {
        var w = 640, h = Math.max(1, Math.round(w * item.height / item.width));
        var cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        var ctx = cv.getContext("2d");
        var g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, item.c1); g.addColorStop(1, item.c2);
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        cv.toBlob(function (blob) {
          if (blob && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
            var payload = {}; payload["image/png"] = blob;
            navigator.clipboard.write([new ClipboardItem(payload)])
              .then(function () { resolve(true); }, function () { resolve(copyText(item.content)); });
          } else {
            resolve(copyText(item.content));
          }
        }, "image/png");
      } catch (e) { resolve(copyText(item.content)); }
    });
  }

  /* ---------- Formatting helpers ---------- */
  function timeAgo(ts) {
    var d = Date.now() - ts;
    if (d < MIN) return "刚刚";
    if (d < HOUR) return Math.floor(d / MIN) + " 分钟前";
    if (d < DAY) return Math.floor(d / HOUR) + " 小时前";
    if (d < 2 * DAY) return "昨天";
    return Math.floor(d / DAY) + " 天前";
  }

  function iconFor(item) { return item.type === "image" ? "i-image" : "i-text"; }
  function titleLine(item) { return item.type === "image" ? item.content : item.content.replace(/\s+/g, " "); }
  function metaFor(item) { return [item.source, timeAgo(item.ts)]; }

  window.ClipboardStore = {
    query: query, total: total, copy: copy,
    getNote: getNote, setNote: setNote,
    remove: remove, restore: restore,
    timeAgo: timeAgo, iconFor: iconFor, titleLine: titleLine, metaFor: metaFor
  };
})();
