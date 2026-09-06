/* ============================================================
   ClipFlow — app.js (simplified HUD)
   One card list, one action: copy. Keyboard-first.
   ============================================================ */
(function () {
  "use strict";

  var Store = window.ClipboardStore;
  var KB = window.Keyboard;

  var $ = function (id) { return document.getElementById(id); };
  var elWindow = $("app-window");
  var elClosedHint = $("closed-hint");
  var elList = $("card-list");
  var elSearch = $("search-input");
  var elSearchClear = $("search-clear");
  var elEmpty = $("empty-state");
  var elToasts = $("toast-stack");
  var elStatusCount = $("status-count");

  var state = { items: [], selected: 0, search: "", editingId: null };

  /* ---------- Helpers ---------- */
  function svgIcon(id, size) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", size || 16);
    svg.setAttribute("height", size || 16);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Render ---------- */
  function render() {
    state.items = Store.query({ search: state.search });
    if (state.selected >= state.items.length) state.selected = Math.max(0, state.items.length - 1);
    elList.innerHTML = "";

    var n = state.items.length;
    elStatusCount.textContent = Store.total() + " 条";
    elEmpty.hidden = n !== 0;
    elList.hidden = n === 0;

    state.items.forEach(function (item, i) { elList.appendChild(buildCard(item, i)); });
    applySelection();
  }

  function buildCard(item, i) {
    var li = document.createElement("li");
    li.className = "card";
    li.setAttribute("role", "option");
    li.dataset.index = i;
    li.dataset.id = item.id;
    li.dataset.type = item.type;

    /* meta row — icon-only type chip · source · time */
    var meta = document.createElement("div");
    meta.className = "card__meta";
    var type = document.createElement("span");
    type.className = "card__type";
    type.appendChild(svgIcon(Store.iconFor(item), 12));
    meta.appendChild(type);
    Store.metaFor(item).forEach(function (b) {
      var sep = document.createElement("span"); sep.className = "sep"; sep.textContent = "·";
      var sp = document.createElement("span");
      if (b === item.source) sp.className = "src";
      sp.textContent = b;
      meta.appendChild(sep); meta.appendChild(sp);
    });

    /* note (备注): inline after the time — editor when active, ellipsis span when set, absent otherwise */
    if (state.editingId === item.id) {
      var sepE = document.createElement("span"); sepE.className = "sep"; sepE.textContent = "·";
      meta.appendChild(sepE);
      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "note-input";
      inp.placeholder = "添加备注…";
      inp.value = Store.getNote(item.id);
      inp.setAttribute("aria-label", "此条目的备注");
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); saveNote(item.id, inp.value); }
      });
      inp.addEventListener("blur", function () {
        if (state.editingId === item.id) saveNote(item.id, inp.value);
      });
      meta.appendChild(inp);
    } else {
      var note = Store.getNote(item.id);
      if (note) {
        var sepN = document.createElement("span"); sepN.className = "sep"; sepN.textContent = "·";
        var nd = document.createElement("span");
        nd.className = "card__note";
        nd.textContent = note;
        meta.appendChild(sepN); meta.appendChild(nd);
      }
    }
    li.appendChild(meta);

    /* body per type */
    if (item.type === "image") {
      var thumb = document.createElement("div");
      thumb.className = "card__thumb";
      thumb.style.setProperty("--thumb", "linear-gradient(135deg, " + item.c1 + ", " + item.c2 + ")");
      thumb.appendChild(svgIcon("i-image", 32));
      li.appendChild(thumb);
      var name = document.createElement("div");
      name.className = "card__name";
      name.textContent = item.content;
      li.appendChild(name);
    } else {
      var body = document.createElement("div");
      body.className = "card__body";
      body.textContent = item.content;
      li.appendChild(body);
    }

    /* copy affordance */
    var copy = document.createElement("button");
    copy.type = "button";
    copy.className = "card__copy";
    copy.setAttribute("aria-label", item.type === "image" ? "复制图片" : "复制文字");
    copy.appendChild(svgIcon("i-copy", 12));
    copy.appendChild(document.createTextNode("复制"));
    copy.addEventListener("click", function (e) { e.stopPropagation(); select(i); copySelected(); });
    li.appendChild(copy);

    /* HUD behavior: the card's only action is copy — click selects + copies */
    li.addEventListener("click", function () { select(i); copySelected(); });
    return li;
  }

  /* ---------- Selection ---------- */
  function select(i) {
    if (i < 0 || i >= state.items.length) return;
    state.selected = i;
    applySelection();
  }

  function applySelection() {
    Array.prototype.forEach.call(elList.querySelectorAll(".card"), function (c) {
      var sel = Number(c.dataset.index) === state.selected;
      c.classList.toggle("is-selected", sel);
      c.setAttribute("aria-selected", String(sel));
    });
    var row = elList.querySelector('.card[data-index="' + state.selected + '"]');
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  function moveSelection(delta) {
    if (!state.items.length) return;
    var next = Math.min(Math.max(state.selected + delta, 0), state.items.length - 1);
    select(next);
  }

  /* ---------- Copy ---------- */
  function copySelected() {
    var item = state.items[state.selected];
    if (!item) return;
    Store.copy(item).then(function (ok) {
      if (!ok) { toast("复制失败", "剪贴板不可用"); return; }
      var row = elList.querySelector('.card[data-index="' + state.selected + '"]');
      if (row) { row.classList.add("is-copied"); setTimeout(function () { row.classList.remove("is-copied"); }, 520); }
      toast(item.type === "image" ? "图片已复制" : "文字已复制", item.source + " · " + Store.timeAgo(item.ts));
    });
  }

  /* ---------- Delete (Del) — undoable via toast ---------- */
  function deleteSelected() {
    var item = state.items[state.selected];
    if (!item) return;
    var res = Store.remove(item.id);
    if (!res) return;
    state.editingId = null;
    render();
    select(Math.min(res.index, state.items.length - 1));
    toast("已删除", Store.titleLine(item).slice(0, 18), {
      label: "撤销",
      fn: function () {
        Store.restore(res.item, res.index);
        render();
        select(Math.min(res.index, state.items.length - 1));
      }
    }, "error");
  }

  /* ---------- Toast（支持可选操作按钮，如撤销） ---------- */
  function toast(msg, dim, action, kind) {
    var el = document.createElement("div");
    el.className = "toast";
    var ic = document.createElement("span");
    ic.className = "toast__icon" + (kind === "error" ? " toast__icon--error" : "");
    ic.appendChild(svgIcon(kind === "error" ? "i-x" : "i-check", 14));
    el.appendChild(ic);
    var m = document.createElement("span");
    m.className = "toast__msg";
    m.innerHTML = esc(msg) + (dim ? ' <span class="dim">' + esc(dim) + "</span>" : "");
    el.appendChild(m);
    if (action && action.label) {
      var a = document.createElement("button");
      a.type = "button";
      a.className = "toast__action";
      a.textContent = action.label;
      a.addEventListener("click", function () { action.fn(); dismiss(); });
      el.appendChild(a);
    }
    elToasts.appendChild(el);
    var timer = setTimeout(dismiss, action && action.label ? 6000 : 2600);
    function dismiss() {
      clearTimeout(timer);
      if (!el.parentNode) return;
      el.classList.add("is-leaving");
      setTimeout(function () { el.remove(); }, 160);
    }
  }

  /* ---------- Search ---------- */
  var searchTimer = null;
  elSearch.addEventListener("input", function () {
    elSearchClear.hidden = !elSearch.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.search = elSearch.value.trim();
      state.selected = 0;
      render();
    }, 120);
  });

  function clearSearch() {
    elSearch.value = ""; state.search = ""; elSearchClear.hidden = true;
    state.selected = 0;
    render();
  }
  elSearchClear.addEventListener("click", function () { clearSearch(); elSearch.focus(); });

  /* ---------- Note editing (B) ---------- */
  function editNote() {
    var item = state.items[state.selected];
    if (!item) return;
    state.editingId = item.id;
    render();
    var inp = elList.querySelector(".note-input");
    if (inp) { inp.focus(); if (inp.value) inp.select(); }
  }

  function saveNote(id, text) {
    var prev = Store.getNote(id);
    text = (text || "").trim();
    state.editingId = null;
    if (text !== prev) {
      Store.setNote(id, text);
      toast(text ? "备注已保存" : "备注已移除", text || undefined);
    }
    render();
    elList.focus({ preventScroll: true });
  }

  /* ---------- Close / reopen HUD (Esc closes; Electron: globalShortcut summons) ---------- */
  function closeHud() {
    state.editingId = null;
    elWindow.hidden = true;
    elClosedHint.hidden = false;
  }

  function openHud() {
    elWindow.hidden = false;
    elClosedHint.hidden = true;
    clearSearch();
    elList.focus({ preventScroll: true });
  }

  document.body.addEventListener("click", function () {
    if (elWindow.hidden) openHud();
  });

  /* ---------- Keyboard (real keydown events, central registry) ---------- */
  function isTyping(e) {
    var t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }
  function hudHidden() { return elWindow.hidden; }

  KB.register("arrowdown", function (e) {
    if (hudHidden() || (isTyping(e) && e.target !== elSearch)) return;
    e.preventDefault();
    moveSelection(+1);
  }, "选中下一张卡片", { group: "导航" });

  KB.register("arrowup", function (e) {
    if (hudHidden() || (isTyping(e) && e.target !== elSearch)) return;
    e.preventDefault();
    moveSelection(-1);
  }, "选中上一张卡片", { group: "导航" });

  KB.register("home", function (e) {
    if (hudHidden() || (isTyping(e) && e.target !== elSearch)) return;
    e.preventDefault();
    select(0);
  }, "选中第一张", { group: "导航" });

  KB.register("end", function (e) {
    if (hudHidden() || (isTyping(e) && e.target !== elSearch)) return;
    e.preventDefault();
    select(state.items.length - 1);
  }, "选中最后一张", { group: "导航" });

  KB.register("enter", function (e) {
    if (hudHidden()) return;
    if (e.target && e.target.classList && e.target.classList.contains("note-input")) return; // editor saves itself
    e.preventDefault();
    copySelected();
  }, "复制选中卡片", { group: "操作" });

  // Esc: cancel note edit → else close the HUD (Electron: win.hide())
  KB.register("escape", function () {
    if (state.editingId) { state.editingId = null; render(); elList.focus({ preventScroll: true }); return; }
    if (hudHidden()) return;
    closeHud();
  }, "关闭面板", { group: "操作" });

  KB.register("b", function (e) {
    if (hudHidden() || isTyping(e) || state.editingId) return;
    e.preventDefault();
    editNote();
  }, "添加 / 编辑备注", { group: "操作" });

  // Del (Backspace as laptop fallback): delete selected clip, undoable via toast
  KB.register(["delete", "backspace"], function (e) {
    if (hudHidden() || isTyping(e) || state.editingId) return;
    e.preventDefault();
    deleteSelected();
  }, "删除选中条目（可撤销）", { group: "操作" });

  // Space focuses search (type-to-search); never while typing or on a focused button
  KB.register(" ", function (e) {
    if (hudHidden() || isTyping(e)) return;
    if (e.target && e.target.tagName === "BUTTON") return;
    e.preventDefault();
    elSearch.focus();
  }, "聚焦搜索", { group: "搜索" });

  KB.register(["ctrl+f", "meta+f"], function (e) {
    if (hudHidden()) return;
    e.preventDefault();
    elSearch.focus(); elSearch.select();
  }, "聚焦搜索（选中已有文字）", { group: "搜索" });

  KB.register(["ctrl+shift+v", "meta+shift+v"], function (e) {
    e.preventDefault();
    hudHidden() ? openHud() : closeHud();
  }, "显示 / 隐藏 ClipFlow", { group: "面板" });

  /* Platform-aware kbd labels (⌘ on macOS) */
  Array.prototype.forEach.call(document.querySelectorAll("[data-kbd]"), function (el) {
    el.textContent = KB.combo(el.dataset.kbd);
  });

  /* ---------- Theme: live-follow the OS (Electron seam: nativeTheme.on("updated")) ---------- */
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var syncTheme = function () {
      document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    if (mq.addEventListener) mq.addEventListener("change", syncTheme);
    else if (mq.addListener) mq.addListener(syncTheme);
  }

  /* ---------- Boot ----------
     Focus starts on the list (B / arrows / Enter work immediately);
     Space jumps to search — type-to-search on demand. */
  render();
  select(0);
  elList.focus({ preventScroll: true });
})();
