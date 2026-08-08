// src/gamepad.ts
// App-wide gamepad support:
// - Left stick moves a virtual cursor across the whole UI
// - D-pad moves it too — tap to nudge, hold to glide — so pads with no analog
//   stick (SNES and friends) can drive the cursor. The d-pad is read from
//   buttons 12-15 and from a hat axis, whichever the pad reports.
// - A: click the control under the cursor (selects cycle instead of opening)
// - B: close open modal / cancel an active eyedropper pick (ESC)
// - LB / RB: previous / next section tab
// - Right stick: scroll the scrollable region under the cursor
// In the TILEMAP tab with a map loaded, the cursor becomes a tile cursor:
// - D-pad steps cell by cell instead of gliding (left stick still free-moves)
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
const DPAD_NUDGE = 14; // px moved by a d-pad tap
const DPAD_GLIDE_DELAY = 200; // ms held before the d-pad starts gliding
const DPAD_GLIDE_RAMP = 420; // ms from glide start to full pointer speed

type Dir = "left" | "right" | "up" | "down";
const DIRS: Array<[Dir, number, number]> = [
  ["left", -1, 0],
  ["right", 1, 0],
  ["up", 0, -1],
  ["down", 0, 1],
];

let deps: GamepadDeps = { setStatus: () => {} };

let cursorEl: HTMLDivElement | null = null;
let px = 0;
let py = 0;
let cursorShown = false;
let lastTime = 0;
let prevPressed: boolean[] = [];
let lastPadKey = ""; // identity of the pad prevPressed belongs to
const repeatState = new Map<string, { downSince: number; lastFire: number }>();
const dpadHeldSince = new Map<Dir, number>();
let lastMoveTarget: Element | null = null;
/** Axes carrying a hat switch rather than a stick — see noteHatAxes(). */
const hatAxes = new Set<number>();
/** Where each axis sits when the pad is untouched. */
let restAxes: number[] = [];

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

/** SNES/DirectInput pads usually report the d-pad as a HID hat switch on one
 *  axis instead of buttons 12-15. Browsers spread the 8 directions evenly over
 *  [-1, 1] and park the centered value outside that range — an impossible
 *  reading for a stick, which is what identifies the axis. */
function noteHatAxes(pad: Gamepad) {
  for (let i = 0; i < pad.axes.length; i++) {
    const v = pad.axes[i];
    if (Number.isFinite(v) && Math.abs(v) > 1.05) hatAxes.add(i);
  }
}

const HAT_DIRS: Array<[number, number]> = [
  [0, -1], // up
  [1, -1], // up-right
  [1, 0], // right
  [1, 1], // down-right
  [0, 1], // down
  [-1, 1], // down-left
  [-1, 0], // left
  [-1, -1], // up-left
];

/** Combined direction of every hat on the pad, as -1/0/1 per axis. */
function hatVector(pad: Gamepad): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const i of hatAxes) {
    const v = pad.axes[i];
    if (!Number.isFinite(v) || Math.abs(v) > 1.05) continue; // centered
    const dir = HAT_DIRS[Math.round((v + 1) * 3.5)];
    if (!dir) continue;
    x += dir[0];
    y += dir[1];
  }
  return { x: Math.sign(x), y: Math.sign(y) };
}

/** Stick deflection measured from where the axis rests, so a non-standard pad
 *  whose triggers idle at ±1 can't drag the cursor across the screen. */
function stickValue(pad: Gamepad, i: number): number {
  if (hatAxes.has(i)) return 0;
  const v = pad.axes[i];
  if (!Number.isFinite(v)) return 0;
  const rest = Math.abs(restAxes[i] ?? 0) > 0.5 ? restAxes[i] : 0;
  // An axis that idles at ±1 only travels one way — rescale it to full range.
  return axisValue((v - rest) / (rest ? 1 + Math.abs(rest) : 1));
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
function heldWithRepeat(key: string, down: boolean, now: number): boolean {
  const state = repeatState.get(key);
  if (!down) {
    repeatState.delete(key);
    return false;
  }
  if (!state) {
    repeatState.set(key, { downSince: now, lastFire: now });
    return true;
  }
  if (now - state.downSince >= REPEAT_DELAY && now - state.lastFire >= REPEAT_RATE) {
    state.lastFire = now;
    return true;
  }
  return false;
}

/** Which directions the pad is calling for, from either d-pad source. */
function dpadState(
  pad: Gamepad,
  hat = hatVector(pad)
): Record<Dir, boolean> {
  return {
    left: isPressed(pad, BTN.DPAD_LEFT) || hat.x < 0,
    right: isPressed(pad, BTN.DPAD_RIGHT) || hat.x > 0,
    up: isPressed(pad, BTN.DPAD_UP) || hat.y < 0,
    down: isPressed(pad, BTN.DPAD_DOWN) || hat.y > 0,
  };
}

function movePointerBy(dx: number, dy: number) {
  if (!dx && !dy) return;
  px = Math.max(0, Math.min(window.innerWidth - 1, px + dx));
  py = Math.max(0, Math.min(window.innerHeight - 1, py + dy));
  positionCursor();
  dispatchMove(px, py);
  if (inTilemapGrid()) tilemapSetCursorFromClient(px, py);
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
    dpadHeldSince.clear();
    hatAxes.clear();
    restAxes = Array.from(pad.axes);
    noteHatAxes(pad);
    return;
  }

  noteHatAxes(pad);
  const isStandard = pad.mapping === "standard";
  const hat = hatVector(pad);
  // Axes are read relative to their resting value, so a non-standard pad whose
  // triggers idle at ±1 no longer has to be excluded here.
  const anyInput =
    pad.buttons.some((b, i) => isPressed(pad, i)) ||
    !!(hat.x || hat.y) ||
    pad.axes.some((_a, i) => stickValue(pad, i) !== 0);
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
    const ax = stickValue(pad, 0);
    const ay = stickValue(pad, 1);
    movePointerBy(ax * POINTER_SPEED * dt, ay * POINTER_SPEED * dt);

    // ---- d-pad: grid steps in tilemap, pointer drive elsewhere ----
    const now = time;
    const down = dpadState(pad, hat);
    if (inTilemapGrid()) {
      dpadHeldSince.clear();
      for (const [dir, dx, dy] of DIRS) {
        if (heldWithRepeat(dir, down[dir], now)) warpTo(tilemapMoveCursor(dx, dy));
      }
    } else {
      // A tap nudges by a few pixels; holding glides at stick speed, which is
      // the only way across the screen on a pad with no analog stick.
      repeatState.clear(); // grid-step state, stale outside the tilemap
      let gx = 0;
      let gy = 0;
      let nx = 0;
      let ny = 0;
      for (const [dir, dx, dy] of DIRS) {
        if (!down[dir]) {
          dpadHeldSince.delete(dir);
          continue;
        }
        if (!dpadHeldSince.has(dir)) {
          dpadHeldSince.set(dir, now);
          nx += dx * DPAD_NUDGE;
          ny += dy * DPAD_NUDGE;
        }
        const held = now - (dpadHeldSince.get(dir) ?? now);
        if (held >= DPAD_GLIDE_DELAY) {
          const ramp = Math.min(1, (held - DPAD_GLIDE_DELAY) / DPAD_GLIDE_RAMP);
          gx += dx * ramp;
          gy += dy * ramp;
        }
      }
      movePointerBy(
        nx + gx * POINTER_SPEED * dt,
        ny + gy * POINTER_SPEED * dt
      );
    }

    // ---- right stick: scroll under cursor (standard mapping only) ----
    if (isStandard) {
      const rx = stickValue(pad, 2);
      const ry = stickValue(pad, 3);
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
    const pad = ev.gamepad;
    deps.setStatus(
      `GAMEPAD CONNECTED · ${(pad?.id || "PAD").slice(0, 24).toUpperCase()}`
    );
    // Pads vary wildly in where they put the d-pad — log the layout so an
    // unmapped one can be diagnosed without guesswork (see __sxPadInfo).
    console.info("[spriteX] gamepad connected:", pad?.id, {
      mapping: pad?.mapping,
      axes: pad?.axes.length,
      buttons: pad?.buttons.length,
    });
    showCursor();
  });

  window.addEventListener("gamepaddisconnected", () => {
    deps.setStatus("GAMEPAD DISCONNECTED");
  });

  // Test hook: lets scripted tests step the poll loop deterministically
  // (rAF does not fire in hidden tabs). Mirrors __sxTilemap in tilemapEditor.
  (window as any).__sxGamepadPump = (time: number) => pollOnce(time);

  // Diagnostic hook: `__sxPadInfo()` in the console dumps what the live pad
  // reports, which is how to find an unrecognised d-pad.
  (window as any).__sxPadInfo = () => {
    const pad = getPad();
    if (!pad) return null;
    return {
      id: pad.id,
      index: pad.index,
      mapping: pad.mapping,
      axes: Array.from(pad.axes),
      restAxes: [...restAxes],
      hatAxes: [...hatAxes],
      dpad: dpadState(pad),
      pressedButtons: pad.buttons
        .map((_b, i) => (isPressed(pad, i) ? i : -1))
        .filter((i) => i >= 0),
    };
  };

  requestAnimationFrame(poll);
}
