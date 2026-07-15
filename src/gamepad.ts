// src/gamepad.ts
// App-wide gamepad support (standard mapping):
// - Left stick moves a virtual cursor across the whole UI
// - A: click the control under the cursor (selects cycle instead of opening)
// - B: close open modal / cancel an active eyedropper pick (ESC)
// - LB / RB: previous / next section tab
// - Right stick: scroll the scrollable region under the cursor
// In the TILEMAP tab with a map loaded, the cursor becomes a tile cursor:
// - D-pad steps cell by cell (left stick still free-moves)
// - A place · X delete · Y pick · LT/RT layer cycle · Start grid · Select undo
//
// The virtual cursor synthesizes real DOM events, so every mouse-driven
// feature (sprite toggling, BG eyedropper, palette, buttons) works from a pad.

import {
  tilemapLoaded,
  tilemapMoveCursor,
  tilemapSetCursorFromClient,
  tilemapClientPointOnMap,
  tilemapCursorClientPos,
  tilemapPlace,
  tilemapDelete,
  tilemapPick,
  tilemapCycleLayer,
  tilemapToggleGrid,
  tilemapUndo,
} from "./tilemapEditor";

type GamepadDeps = {
  setStatus: (msg: string) => void;
};

const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  SELECT: 8,
  START: 9,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
};

const DEADZONE = 0.25;
const POINTER_SPEED = 1100; // px/s at full deflection
const SCROLL_SPEED = 1400; // px/s at full deflection
const REPEAT_DELAY = 300; // ms before a held direction repeats
const REPEAT_RATE = 95; // ms between repeats

let deps: GamepadDeps = { setStatus: () => {} };

let cursorEl: HTMLDivElement | null = null;
let px = 0;
let py = 0;
let cursorShown = false;
let lastTime = 0;
let prevPressed: boolean[] = [];
let lastPadKey = ""; // identity of the pad prevPressed belongs to
const repeatState = new Map<number, { downSince: number; lastFire: number }>();
let lastMoveTarget: Element | null = null;

function activeTab(): string {
  return (
    document.querySelector(".sx-tab.active")?.getAttribute("data-sx-tab") ||
    "extract"
  );
}

function inTilemapGrid(): boolean {
  return activeTab() === "tilemap" && tilemapLoaded();
}

function ensureCursorEl(): HTMLDivElement {
  if (cursorEl) return cursorEl;
  const el = document.createElement("div");
  el.id = "padCursor";
  el.innerHTML =
    '<div class="pad-cursor-ring"></div><div class="pad-cursor-dot"></div>';
  document.body.appendChild(el);
  cursorEl = el;
  return el;
}

function showCursor() {
  if (cursorShown) return;
  cursorShown = true;
  px = window.innerWidth / 2;
  py = window.innerHeight / 2;
  const el = ensureCursorEl();
  el.style.display = "block";
  positionCursor();
}

function positionCursor() {
  if (!cursorEl) return;
  cursorEl.style.left = `${px}px`;
  cursorEl.style.top = `${py}px`;
}

function pulseCursor() {
  if (!cursorEl) return;
  cursorEl.classList.remove("pad-cursor-pulse");
  // Force a reflow so the animation can retrigger back-to-back.
  void cursorEl.offsetWidth;
  cursorEl.classList.add("pad-cursor-pulse");
}

function warpTo(pos: { x: number; y: number } | null) {
  if (!pos) return;
  px = pos.x;
  py = pos.y;
  positionCursor();
}

function elementAt(x: number, y: number): HTMLElement | null {
  return (document.elementFromPoint(x, y) as HTMLElement | null) || null;
}

function mouseOpts(x: number, y: number): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
  };
}

function dispatchMove(x: number, y: number) {
  const el = elementAt(x, y);
  if (!el) return;
  el.dispatchEvent(new MouseEvent("mousemove", mouseOpts(x, y)));
  if (lastMoveTarget && lastMoveTarget !== el) {
    lastMoveTarget.dispatchEvent(new MouseEvent("mouseleave", mouseOpts(x, y)));
  }
  lastMoveTarget = el;
}

function synthClick(x: number, y: number) {
  const el = elementAt(x, y);
  if (!el) return;
  pulseCursor();

  // Native dropdowns cannot be opened programmatically — cycle options
  // instead so <select> controls remain fully pad-usable.
  const select = el.closest("select") as HTMLSelectElement | null;
  if (select && select.options.length) {
    let next = (select.selectedIndex + 1) % select.options.length;
    // Skip disabled/placeholder-only wrap when possible.
    if (select.options[next]?.disabled) {
      next = (next + 1) % select.options.length;
    }
    select.selectedIndex = next;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    deps.setStatus(
      `PAD · ${select.options[next]?.textContent?.trim().toUpperCase() || "OPTION"}`
    );
    return;
  }

  el.dispatchEvent(new MouseEvent("mousedown", mouseOpts(x, y)));
  el.dispatchEvent(new MouseEvent("mouseup", mouseOpts(x, y)));
  el.dispatchEvent(new MouseEvent("click", mouseOpts(x, y)));
  if (typeof el.focus === "function") {
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
}

function scrollAt(x: number, y: number, dx: number, dy: number) {
  let el: Element | null = elementAt(x, y);
  while (el && el !== document.documentElement) {
    const canY = el.scrollHeight > el.clientHeight + 2;
    const canX = el.scrollWidth > el.clientWidth + 2;
    if (canY || canX) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) {
        el.scrollLeft += dx;
        el.scrollTop += dy;
        return;
      }
    }
    el = el.parentElement;
  }
  window.scrollBy(dx, dy);
}

function closeModalOrCancel() {
  const modal = document.querySelector(".modal.open");
  if (modal) {
    const closeBtn = modal.querySelector(
      "#closeImportAtlasModalBtn, .btn"
    ) as HTMLButtonElement | null;
    closeBtn?.click();
    return;
  }
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
}

function axisValue(v: number): number {
  if (Math.abs(v) < DEADZONE) return 0;
  const sign = v < 0 ? -1 : 1;
  const t = (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
  return sign * t * t; // quadratic curve for fine control
}

function getPad(): Gamepad | null {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  // Prefer standard-mapping pads, then the most recently active one, so an
  // idle wheel/dongle in slot 0 can't shadow the controller in slot 1.
  let best: Gamepad | null = null;
  for (const p of pads) {
    if (!p || !p.connected) continue;
    if (!best) {
      best = p;
      continue;
    }
    const bestStd = best.mapping === "standard";
    const pStd = p.mapping === "standard";
    if (pStd !== bestStd) {
      if (pStd) best = p;
      continue;
    }
    if ((p.timestamp || 0) > (best.timestamp || 0)) best = p;
  }
  return best;
}

function isPressed(pad: Gamepad, i: number): boolean {
  const b = pad.buttons[i];
  if (!b) return false;
  return typeof b.value === "number" ? b.value > 0.5 || b.pressed : b.pressed;
}

function justPressed(pad: Gamepad, i: number): boolean {
  return isPressed(pad, i) && !prevPressed[i];
}

/** Held-direction repeat (d-pad): fires on press, then repeats after a delay. */
function pressedWithRepeat(pad: Gamepad, i: number, now: number): boolean {
  const down = isPressed(pad, i);
  const state = repeatState.get(i);
  if (!down) {
    repeatState.delete(i);
    return false;
  }
  if (!state) {
    repeatState.set(i, { downSince: now, lastFire: now });
    return true;
  }
  if (now - state.downSince >= REPEAT_DELAY && now - state.lastFire >= REPEAT_RATE) {
    state.lastFire = now;
    return true;
  }
  return false;
}

function clickTabStep(direction: -1 | 1) {
  const id = direction < 0 ? "sxPrevTab" : "sxNextTab";
  (document.getElementById(id) as HTMLButtonElement | null)?.click();
  deps.setStatus(`PAD · SECTION ${direction < 0 ? "PREV" : "NEXT"}`);
}

function poll(time: number) {
  pollOnce(time);
  requestAnimationFrame(poll);
}

function pollOnce(time: number) {
  const dt = lastTime ? Math.min(0.1, (time - lastTime) / 1000) : 0;
  lastTime = time;

  const pad = getPad();
  if (!pad) {
    lastPadKey = "";
    return;
  }

  // When the driving pad changes (first appearance, reconnect, or slot
  // switch), snapshot its state and skip a frame: held buttons must not
  // read as fresh presses, and edge/repeat state from another pad is stale.
  const padKey = `${pad.index}:${pad.id}`;
  if (padKey !== lastPadKey) {
    lastPadKey = padKey;
    prevPressed = pad.buttons.map((_, i) => isPressed(pad, i));
    repeatState.clear();
    return;
  }

  const isStandard = pad.mapping === "standard";
  // Non-standard pads often expose triggers as axes resting at ±1 — only
  // trust axes for wake-up/scroll when the mapping is known.
  const anyInput =
    pad.buttons.some((b, i) => isPressed(pad, i)) ||
    (isStandard && pad.axes.some((a) => Math.abs(a) > DEADZONE));
  const wasShown = cursorShown;
  if (anyInput) showCursor();
  if (!wasShown && cursorShown) {
    // Reveal frame: show the cursor but swallow the input that revealed it,
    // so the waking button press can't click whatever sits at screen center.
    prevPressed = pad.buttons.map((_, i) => isPressed(pad, i));
    return;
  }

  if (cursorShown) {
    // Keep the cursor reachable if the window shrank underneath it.
    px = Math.min(px, window.innerWidth - 1);
    py = Math.min(py, window.innerHeight - 1);

    // ---- pointer movement (left stick) ----
    const ax = axisValue(pad.axes[0] || 0);
    const ay = axisValue(pad.axes[1] || 0);
    if (ax || ay) {
      px = Math.max(0, Math.min(window.innerWidth - 1, px + ax * POINTER_SPEED * dt));
      py = Math.max(0, Math.min(window.innerHeight - 1, py + ay * POINTER_SPEED * dt));
      positionCursor();
      dispatchMove(px, py);
      if (inTilemapGrid()) tilemapSetCursorFromClient(px, py);
    }

    // ---- d-pad: grid steps in tilemap, pointer nudges elsewhere ----
    const now = time;
    const dirs: Array<[number, number, number]> = [
      [BTN.DPAD_LEFT, -1, 0],
      [BTN.DPAD_RIGHT, 1, 0],
      [BTN.DPAD_UP, 0, -1],
      [BTN.DPAD_DOWN, 0, 1],
    ];
    for (const [btn, dx, dy] of dirs) {
      if (pressedWithRepeat(pad, btn, now)) {
        if (inTilemapGrid()) {
          warpTo(tilemapMoveCursor(dx, dy));
        } else {
          px = Math.max(0, Math.min(window.innerWidth - 1, px + dx * 14));
          py = Math.max(0, Math.min(window.innerHeight - 1, py + dy * 14));
          positionCursor();
          dispatchMove(px, py);
        }
      }
    }

    // ---- right stick: scroll under cursor (standard mapping only) ----
    if (isStandard) {
      const rx = axisValue(pad.axes[2] || 0);
      const ry = axisValue(pad.axes[3] || 0);
      if (rx || ry) {
        scrollAt(px, py, rx * SCROLL_SPEED * dt, ry * SCROLL_SPEED * dt);
      }
    }

    // ---- face buttons ----
    // Pure hit test only — the grid cursor is synced at press time, not per
    // frame, so an idle pad never fights keyboard/mouse cursor control.
    const overMap = inTilemapGrid() && tilemapClientPointOnMap(px, py);

    if (justPressed(pad, BTN.A)) {
      if (overMap) {
        tilemapSetCursorFromClient(px, py);
        tilemapPlace();
        warpTo(tilemapCursorClientPos());
      } else {
        synthClick(px, py);
      }
    }
    if (justPressed(pad, BTN.X) && overMap) {
      tilemapSetCursorFromClient(px, py);
      tilemapDelete();
    }
    if (justPressed(pad, BTN.Y) && overMap) {
      tilemapSetCursorFromClient(px, py);
      tilemapPick();
    }
    if (justPressed(pad, BTN.B)) {
      closeModalOrCancel();
    }

    // ---- shoulders / triggers / meta ----
    if (justPressed(pad, BTN.LB)) clickTabStep(-1);
    if (justPressed(pad, BTN.RB)) clickTabStep(1);
    if (inTilemapGrid()) {
      if (justPressed(pad, BTN.LT)) tilemapCycleLayer(-1);
      if (justPressed(pad, BTN.RT)) tilemapCycleLayer(1);
      if (justPressed(pad, BTN.START)) tilemapToggleGrid();
      if (justPressed(pad, BTN.SELECT)) tilemapUndo();
    }
  }

  prevPressed = pad.buttons.map((_, i) => isPressed(pad, i));
}

export function initGamepad(d: GamepadDeps) {
  deps = d;

  window.addEventListener("gamepadconnected", (e) => {
    const ev = e as GamepadEvent;
    deps.setStatus(
      `GAMEPAD CONNECTED · ${(ev.gamepad?.id || "PAD").slice(0, 24).toUpperCase()}`
    );
    showCursor();
  });

  window.addEventListener("gamepaddisconnected", () => {
    deps.setStatus("GAMEPAD DISCONNECTED");
  });

  // Test hook: lets scripted tests step the poll loop deterministically
  // (rAF does not fire in hidden tabs). Mirrors __sxTilemap in tilemapEditor.
  (window as any).__sxGamepadPump = (time: number) => pollOnce(time);

  requestAnimationFrame(poll);
}
