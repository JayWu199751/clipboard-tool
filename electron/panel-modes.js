// 面板模式状态机：浏览 / 搜索模式（含 IME 组合子态）/ 备注编辑 / 快捷键捕获。
// 纯逻辑 module：不依赖 electron。模式状态、转换级联、全局热键集合的推导与差量应用
// 全部收在本 module 的 interface 之后；窗口焦点、渲染层通知、焦点快照等效果经 ports 注入。
//
// 设计要点：
// - 全局快捷键（呼出键 + 面板导航键）由「当前模式」唯一推导：desiredKeys() 给出目标集合，
//   applyHotkeys() 与已注册集合做差量同步。模式转换不再各自手写 register/unregister。
// - 焦点快照（focusTarget）的生命周期归本 module：呼出/进入输入态前确保有快照，
//   退出输入态归还焦点（快照保留，同一次呼出内复用），隐藏面板时消费快照并清空。
// - 转换规则（进入输入态先退出其它输入态、退出时归还焦点、隐藏时逐层退出）集中在此，
//   新增模式 = 加一个 mode 成员 + 它的热键集合推导。
// - 渲染层仍通过原有 panel:key / panel:shown / shortcut:capture-* 事件感知模式变化（协议不变）。

// 面板导航键：[accelerator, action, 是否在搜索模式下继续拦截]。
// 搜索模式里 Space/Z/Del/B 让位给搜索输入框，↑↓/Enter/Esc 保持面板语义。
const NAV_SHORTCUTS = [
  ['Up', 'up', true],
  ['Down', 'down', true],
  ['Enter', 'enter', true],
  ['Esc', 'escape', true],
  ['Delete', 'delete', false],
  ['Z', 'pin', false],
  ['B', 'note', false],
  ['Space', 'search', false],
];

function createPanelModes({
  // —— 全局热键 seam（main.js 里对 globalShortcut 的唯一包装；registerKey 返回是否成功）
  registerKey = () => true,
  unregisterKey = () => {},
  // —— 面板窗口效果
  canInteract = () => true,      // 面板窗口存在且未销毁
  focusPanel = () => {},
  blurPanelIfFocused = () => {},
  // —— 渲染层通知（端口内部自行判断窗口可用性）
  send = () => {},
  // —— 焦点快照通道（focus-paste-helper）
  captureFocus = async () => null,   // 原始快照请求，成功返回 target
  restoreFocus: restoreFocusPort = () => {}, // (target) => void，异步恢复原输入框（含失败上报）
  reportNoFocusTarget = () => {},    // 快照失败的用户提示
  // —— 领域查询（备注编辑目标校验，由 main.js 用历史 store 回答）
  validateNoteTarget = () => true,
  // —— 呼出快捷键被按下（main.js 决定 togglePanel）
  onToggleRequested = () => {},
} = {}) {
  let visible = false;
  let mode = 'browse';        // 'browse' | 'search' | 'note-edit' | 'shortcut-capture'
  let composing = false;      // 搜索模式子态：中文输入法组合中
  let noteEntryId = null;
  let focusTarget = null;     // 本次呼出期间的前台焦点快照（退出输入态复用，隐藏时消费）
  let toggleAccel = null;     // 呼出快捷键（捕获期间临时注销，值不变）
  const registered = new Map(); // accel -> handler（本 module 维护的已注册集合）

  function toggleHandler() {
    onToggleRequested();
  }

  function navHandler(action) {
    return () => {
      if (action === 'search') {
        void beginSearch();
        return;
      }
      if (action === 'escape' && mode === 'search') {
        endSearch();
        return;
      }
      if (action === 'note') {
        void beginNoteEdit(null);
        return;
      }
      send('panel:key', action);
    };
  }

  // 由当前状态推导应当注册的全局快捷键集合
  function desiredKeys() {
    const desired = new Map();
    if (mode !== 'shortcut-capture' && toggleAccel) {
      desired.set(toggleAccel, toggleHandler);
    }
    if (!visible) return desired;
    if (mode === 'browse') {
      for (const [accel, action] of NAV_SHORTCUTS) desired.set(accel, navHandler(action));
    } else if (mode === 'search' && !composing) {
      // IME 组合期间所有导航键暂停，交给输入法
      for (const [accel, action, enabledInSearch] of NAV_SHORTCUTS) {
        if (enabledInSearch) desired.set(accel, navHandler(action));
      }
    }
    // note-edit / shortcut-capture：导航键全部让位
    return desired;
  }

  // 差量同步：只动需要动的键。替代原先散布 13 处的 register/unregister 舞步。
  function applyHotkeys() {
    const desired = desiredKeys();
    for (const accel of [...registered.keys()]) {
      if (!desired.has(accel)) {
        unregisterKey(accel);
        registered.delete(accel);
      }
    }
    for (const [accel, handler] of desired) {
      if (!registered.has(accel)) {
        if (registerKey(accel, handler)) registered.set(accel, handler);
      }
    }
  }

  // 焦点快照：呼出期间复用同一份。reportOnFailure=false 用于呼出面板（失败静默，面板照常显示）。
  async function ensureFocusTarget({ reportOnFailure = true } = {}) {
    if (focusTarget) return focusTarget;
    let target = null;
    try {
      target = await captureFocus();
    } catch (_) {
      target = null;
    }
    if (!target) {
      if (reportOnFailure) reportNoFocusTarget();
      return null;
    }
    focusTarget = target;
    return target;
  }

  // 归还焦点但保留快照（同一次呼出内，退出输入态后还能再进搜索/备注）
  function restoreFocusKeepingSnapshot() {
    if (focusTarget) restoreFocusPort(focusTarget);
  }

  // —— 输入态之间的互斥退出（进入另一输入态前调用，不归还焦点）——

  function exitNoteEditInternal() {
    mode = 'browse';
    noteEntryId = null;
    send('panel:key', 'note-edit-exit');
    blurPanelIfFocused();
    applyHotkeys();
  }

  function exitSearchInternal() {
    mode = 'browse';
    composing = false;
    send('panel:key', 'search-exit');
    blurPanelIfFocused();
    applyHotkeys();
  }

  function state() {
    return { visible, mode, composing, noteEntryId };
  }

  function isPanelVisible() {
    return visible;
  }

  // 输入态（搜索/备注/捕获）豁免「浏览态自动失焦」
  function isInputActive() {
    return visible && mode !== 'browse';
  }

  // 启动/更换呼出快捷键（捕获确认也走这里）
  function setToggleShortcut(accel) {
    toggleAccel = accel;
    applyHotkeys();
  }

  // 当前焦点快照（只读，不消费）。粘贴链路用它恢复原输入框；隐藏面板时才被消费清空。
  function focusTargetSnapshot() {
    return focusTarget;
  }

  // 呼出面板：重置搜索/备注态；捕获进行中则保持捕获（热键集合由 applyHotkeys 推导，不会误注册导航键）
  function show() {
    visible = true;
    if (mode !== 'shortcut-capture') {
      mode = 'browse';
      composing = false;
      noteEntryId = null;
    }
    applyHotkeys();
    send('panel:shown');
  }

  // 隐藏面板：按捕获→备注→搜索的顺序逐层退出（同一时刻最多一个输入态，逐层只为发对退出事件），
  // 然后注销导航键（呼出键保留）、消费焦点快照。
  function hide({ restoreFocus = true } = {}) {
    const prevMode = mode;
    const wasCapturing = prevMode === 'shortcut-capture';
    visible = false;
    mode = 'browse';
    composing = false;
    noteEntryId = null;
    if (wasCapturing) send('shortcut:capture-end');
    if (prevMode === 'note-edit') send('panel:key', 'note-edit-exit');
    if (prevMode === 'search') send('panel:key', 'search-exit');
    applyHotkeys();
    blurPanelIfFocused();
    const target = focusTarget;
    focusTarget = null;
    if (restoreFocus && target) restoreFocusPort(target);
  }

  // 进入搜索模式：先退出备注编辑；快照缺失先补拍（失败上报并放弃）；
  // 切换热键集合（Space/Z/Del/B 让位），聚焦面板，通知渲染层。
  async function beginSearch() {
    if (!canInteract() || !visible || mode === 'search') return false;
    if (mode === 'note-edit') exitNoteEditInternal();
    const target = await ensureFocusTarget();
    if (!target) return false;
    mode = 'search';
    composing = false;
    applyHotkeys();
    focusPanel();
    send('panel:key', 'search-enter');
    return true;
  }

  // 退出搜索模式：恢复浏览态热键集合，归还焦点（快照保留）。
  function endSearch({ restoreFocus = true } = {}) {
    if (mode !== 'search') return;
    mode = 'browse';
    composing = false;
    applyHotkeys();
    blurPanelIfFocused();
    send('panel:key', 'search-exit');
    if (restoreFocus) restoreFocusKeepingSnapshot();
  }

  // 中文输入法组合开始/结束：组合期间暂停全部导航键
  function setComposing(value) {
    const next = !!value;
    if (composing === next) return;
    composing = next;
    if (visible && mode === 'search') applyHotkeys();
  }

  // 进入备注编辑：先退出搜索；补拍快照（失败上报并放弃）；校验目标条目；注销导航键，聚焦面板。
  async function beginNoteEdit(targetId) {
    if (!canInteract() || !visible || mode === 'note-edit') return false;
    if (mode === 'search') exitSearchInternal();
    const target = await ensureFocusTarget();
    if (!target) return false;
    if (!validateNoteTarget(targetId ?? null)) return false;
    mode = 'note-edit';
    noteEntryId = targetId || null;
    applyHotkeys();
    focusPanel();
    send('panel:key', 'note-edit-enter', noteEntryId);
    return true;
  }

  // 退出备注编辑：通知渲染层保存草稿，归还焦点，恢复浏览态热键（快照保留）。
  function endNoteEdit({ restoreFocus = true } = {}) {
    if (mode !== 'note-edit') return;
    mode = 'browse';
    noteEntryId = null;
    send('panel:key', 'note-edit-exit');
    blurPanelIfFocused();
    applyHotkeys();
    if (restoreFocus) restoreFocusKeepingSnapshot();
  }

  // 开始快捷键捕获：先退出其它输入态，注销呼出键与全部导航键（按键让位给要捕获的组合键）。
  // 面板显示与 capture-start 事件由 main.js 随后编排（show 保持捕获态）。
  async function beginShortcutCapture() {
    if (!canInteract() || mode === 'shortcut-capture') return false;
    if (mode === 'note-edit') exitNoteEditInternal();
    if (mode === 'search') exitSearchInternal();
    const target = await ensureFocusTarget();
    if (!target) return false;
    mode = 'shortcut-capture';
    applyHotkeys();
    return true;
  }

  // 取消捕获：恢复原呼出键与（面板仍显示时的）导航键，通知渲染层收起覆盖层。
  function cancelShortcutCapture({ restoreFocus = true } = {}) {
    if (mode !== 'shortcut-capture') return;
    mode = 'browse';
    applyHotkeys();
    blurPanelIfFocused();
    send('shortcut:capture-end');
    if (restoreFocus) restoreFocusKeepingSnapshot();
  }

  // 捕获确认：新呼出键注册成功才算成功；成功则退出捕获态（不发 capture-end，覆盖层由渲染层自行收起）。
  function trySetToggleShortcut(accel) {
    if (mode !== 'shortcut-capture' || typeof accel !== 'string') return false;
    if (!registerKey(accel, toggleHandler)) return false;
    registered.set(accel, toggleHandler);
    toggleAccel = accel;
    mode = 'browse';
    applyHotkeys();
    blurPanelIfFocused();
    return true;
  }

  // 把焦点还回原程序（捕获确认路径使用；快照保留到 hidePanel 时消费）
  function restoreOriginalFocus() {
    restoreFocusKeepingSnapshot();
  }

  return {
    state,
    isPanelVisible,
    isInputActive,
    setToggleShortcut,
    ensureFocusTarget,
    focusTargetSnapshot,
    show,
    hide,
    beginSearch,
    endSearch,
    setComposing,
    beginNoteEdit,
    endNoteEdit,
    beginShortcutCapture,
    cancelShortcutCapture,
    trySetToggleShortcut,
    restoreOriginalFocus,
  };
}

module.exports = { createPanelModes, NAV_SHORTCUTS };
