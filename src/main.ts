// src/main.ts
declare const GIF: any;
import {
  smartDetectSprites,
  extractSpriteDataURLs,
  drawSpriteRect,
  saveSpritesBatchToRTDB,
  buildAtlas,
  saveAtlas,
  saveMap,
  sanitizeMapKey,
  loadCharacterPreviewFromAtlas,
  fetchAllCharacters,
  fetchAllAtlases,
  fetchAllSprites,
  fetchAtlas,
  fetchCharacter,
  rgbToHex,
  hexToRgb,
  getAtlasActualWidth,
  decodeAtlasFrameKey,
  encodeAtlasFrameKey,
  type DetectedSprite,
  type RGB,
  type SpriteData,
} from "./atlasManager";
import { initPackerTab, setPackerAtlasNames } from "./packerTab";
import { initTilemapEditor, initTilemapGameBridge } from "./tilemapEditor";
import { initGamepad } from "./gamepad";

let originalCanvas: HTMLCanvasElement;
let originalCtx: CanvasRenderingContext2D;
let overlayCanvas: HTMLCanvasElement;
let overlayCtx: CanvasRenderingContext2D;

let detected: DetectedSprite[] = [];
let selected = new Set<number>();
let detectedBg: RGB | null = null;
let detectedTolerance = 12;

let characterAnimTimer: number | null = null;
let lastCharPreview: {
  frameRate: number;
  frames: string[];
  textures: string[];
} | null = null;
let selectionAnimTimer: number | null = null;
let selectionFrames: string[] = [];
let selectionFrameIndex = 0;
let selectionPlaying = false;

// Atlas animation preview state
let atlasAnimTimer: number | null = null;
let atlasFrames: string[] = []; // All frames extracted from atlas
let atlasFrameNames: string[] = []; // Frame keys from atlas JSON
let atlasFrameRects: DetectedSprite[] = []; // Frame rects (atlas px), parallel to atlasFrames
let atlasSelectedFrameIndices = new Set<number>();
// Anchor for shift-click range selection in the View tab (index of the last
// frame clicked without shift). null when there is no valid anchor.
let atlasLastClickedFrameIndex: number | null = null;
let atlasAnimFrameIndex = 0;
let atlasAnimPlaying = false;
let atlasReorderEnabled = false;
let atlasOrderDirty = false;
let atlasSyncPromise: Promise<void> | null = null;
// Bumped on every mutation of the frame arrays (duplicate, reorder, load). An
// in-flight order sync compares against its starting value and discards its
// result instead of clobbering state that changed under it.
let atlasStateGen = 0;
let importAtlasJsonFile: File | null = null;
let importAtlasPngFile: File | null = null;

// BG color eyedropper state
let bgPickActive = false;
let bgPickPrevHex: string | null = null;
let bgPickHoverHex: string | null = null;

// Erase color pick state
let erasePickActive = false;
let erasePickPrevHex: string | null = null;
let erasePickHoverHex: string | null = null;

// Canvas view state
let canvasZoom = 1;

// Grid slicing state. While grid mode is on, `detected` holds the grid cells
// (enumerated row-major) and the normal selection pipeline operates on them.
type GridParams = {
  cellW: number;
  cellH: number;
  gapX: number; // spacing between cells
  gapY: number;
  offX: number; // margin / grid origin offset
  offY: number;
};
let gridActive = false;
let gridParams: GridParams = { cellW: 16, cellH: 16, gapX: 0, gapY: 0, offX: 0, offY: 0 };
let gridCols = 0;
let gridRows = 0;
let gridLayerCanvas: HTMLCanvasElement | null = null; // cached dim + cell-outline layer
let gridHoverIndex = -1;
let gridAnchorIndex: number | null = null; // anchor for shift+click run selection
let gridTool: "select" | "move" = "select";
// Auto-detect results stashed while grid mode is on, restored on exit.
let preGridState: {
  detected: DetectedSprite[];
  selected: Set<number>;
  splits: Map<number, SpriteSplitChoice>;
  joins: Map<JoinGroupId, number[]>;
} | null = null;
// Snapshot of grid geometry + selection taken at drag start, so move-drags can
// rebuild from the start state each frame (only net displacement matters) and
// Escape can restore exactly.
type GridDragBase = {
  cols: number;
  rows: number;
  selected: number[];
  splits: [number, SpriteSplitChoice][];
  joins: [JoinGroupId, number[]][];
  anchor: number | null;
};
let gridDrag: {
  mode: "select" | "move";
  startClient: { x: number; y: number };
  startImg: { x: number; y: number };
  lastImg: { x: number; y: number };
  startOff: { x: number; y: number };
  moved: boolean;
  subtract: boolean;
  base: GridDragBase;
} | null = null;
// Move-drag updates are coalesced to one grid rebuild per animation frame.
let gridMovePending: { x: number; y: number; base: GridDragBase } | null = null;
let gridMoveRaf: number | null = null;
let suppressNextClick = false;
const GRID_MAX_CELLS = 50000;
// Bound on how many selected cells the thumbnail strip / animation preview
// will process at once — selecting thousands of cells (e.g. via ALL on a
// dense grid) must not hang the tab. Atlas building is not capped.
const GRID_UI_LIMIT = 400;

// Data state
let dbSprites: Record<string, string | SpriteData> = {};

type BuilderMode = "atlas" | "font";

type SpriteSplitChoice = {
  axis: "h" | "v";
  parts: number;
};

let splitMenuEl: HTMLDivElement | null = null;
const spriteSplitChoices = new Map<number, SpriteSplitChoice>();
let splitLongPressTimer: number | null = null;

// Join groups: combine multiple detected sprite indices into a single piece.
type JoinGroupId = number;
const joinGroups = new Map<JoinGroupId, number[]>(); // id -> sorted member sprite indices
const spriteToGroup = new Map<number, JoinGroupId>(); // sprite index -> group id
let nextJoinGroupId = 1;

type RenderUnit =
  | { kind: "single"; spriteIndex: number; rect: DetectedSprite }
  | { kind: "group"; groupId: JoinGroupId; members: number[]; rect: DetectedSprite };

function $(id: string) {
  return document.getElementById(id);
}

// Map a mouse event to image-pixel coordinates on the (CSS-zoomed) canvases.
function toImageCoords(ev: MouseEvent): { x: number; y: number } {
  const rect = overlayCanvas.getBoundingClientRect();
  const sx = rect.width ? overlayCanvas.width / rect.width : 1;
  const sy = rect.height ? overlayCanvas.height / rect.height : 1;
  return {
    x: Math.floor((ev.clientX - rect.left) * sx),
    y: Math.floor((ev.clientY - rect.top) * sy),
  };
}

function setupCanvases() {
  originalCanvas = $("originalCanvas") as HTMLCanvasElement;
  overlayCanvas = $("overlayCanvas") as HTMLCanvasElement;

  originalCtx = originalCanvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;
  originalCtx.imageSmoothingEnabled = false;
  overlayCtx = overlayCanvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;
  overlayCtx.imageSmoothingEnabled = false;

  overlayCanvas.addEventListener("click", (ev) => {
    // A completed drag gesture must not also fire the click-toggle.
    if (suppressNextClick) {
      suppressNextClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    // If eyedropper is active, finalize the current hovered color
    if (bgPickActive) {
      finishBgPick(true);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (erasePickActive) {
      finishErasePick(true);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    const { x, y } = toImageCoords(ev);

    const idx = gridActive
      ? gridCellIndexAt(x, y)
      : detected.findIndex(
          (s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h
        );

    if (idx >= 0) {
      if (
        gridActive &&
        ev.shiftKey &&
        gridAnchorIndex != null &&
        detected[gridAnchorIndex]
      ) {
        // Cells are enumerated row-major, so the index range between the
        // anchor and the clicked cell is the reading-order run — ideal for
        // grabbing an animation sequence in one shift+click.
        const lo = Math.min(gridAnchorIndex, idx);
        const hi = Math.max(gridAnchorIndex, idx);
        for (let i = lo; i <= hi; i++) selected.add(i);
      } else if (selected.has(idx)) {
        selected.delete(idx);
        // Detach from any join group when deselected so the group reflects
        // only currently-active selections.
        removeFromAnyGroup(idx);
        if (gridActive) gridAnchorIndex = idx;
      } else {
        selected.add(idx);
        if (gridActive) gridAnchorIndex = idx;
      }
      drawOverlay();
      renderSelectedThumbs();
      onSelectionChanged();
    }
  });

  // Grid drag: marquee-select cells, or move the grid (MOVE tool / Alt /
  // dragging the origin handle). Mouse events only — the gamepad synthesizes
  // MouseEvents, and its zero-movement mousedown+mouseup+click stays below the
  // drag threshold so its A-button click-toggle keeps working.
  overlayCanvas.addEventListener("mousedown", (ev) => {
    // A stale suppression flag (drag released off-canvas) must not eat the
    // click of a brand-new gesture.
    suppressNextClick = false;
    if (!gridActive || bgPickActive || erasePickActive) return;
    if (ev.button !== 0) return;
    const img = toImageCoords(ev);
    const mode =
      ev.altKey || gridTool === "move" || isOverGridHandle(img.x, img.y)
        ? "move"
        : "select";
    gridDrag = {
      mode,
      startClient: { x: ev.clientX, y: ev.clientY },
      startImg: img,
      lastImg: img,
      startOff: { x: gridParams.offX, y: gridParams.offY },
      moved: false,
      subtract: ev.ctrlKey || ev.metaKey,
      base: {
        cols: gridCols,
        rows: gridRows,
        selected: [...selected],
        splits: [...spriteSplitChoices.entries()],
        joins: [...joinGroups.entries()].map(
          ([k, v]) => [k, [...v]] as [JoinGroupId, number[]]
        ),
        anchor: gridAnchorIndex,
      },
    };
    if (mode === "move") overlayCanvas.style.cursor = "grabbing";
    ev.preventDefault();
  });

  window.addEventListener("mousemove", (ev) => {
    if (!gridDrag) return;
    if (!gridDrag.moved) {
      const dx = ev.clientX - gridDrag.startClient.x;
      const dy = ev.clientY - gridDrag.startClient.y;
      if (Math.hypot(dx, dy) < 3) return;
      gridDrag.moved = true;
    }
    const img = toImageCoords(ev);
    if (gridDrag.mode === "move") {
      // Coalesce to one rebuild per animation frame — a rebuild remaps the
      // whole cell array and can't keep up with raw mousemove rates.
      gridMovePending = {
        x: gridDrag.startOff.x + (img.x - gridDrag.startImg.x),
        y: gridDrag.startOff.y + (img.y - gridDrag.startImg.y),
        base: gridDrag.base,
      };
      if (gridMoveRaf == null) {
        gridMoveRaf = window.requestAnimationFrame(() => {
          gridMoveRaf = null;
          const p = gridMovePending;
          gridMovePending = null;
          if (p) moveGridTo(p.x, p.y, p.base);
        });
      }
    } else {
      gridDrag.lastImg = img;
      drawOverlay();
    }
  });

  window.addEventListener("mouseup", (ev) => {
    if (!gridDrag) return;
    // Only the initiating left button ends the drag — a right/middle release
    // mid-marquee must not commit it early.
    if (ev.button !== 0) return;
    flushPendingGridMove();
    const drag = gridDrag;
    gridDrag = null;
    updateGridCursorBase();
    if (drag.moved) {
      // Swallow the click event the browser fires right after this mouseup.
      suppressNextClick = true;
      window.setTimeout(() => {
        suppressNextClick = false;
      }, 0);

      if (drag.mode === "select") {
        drag.lastImg = toImageCoords(ev);
        const covered = gridCellsInRect(drag.startImg, drag.lastImg);
        if (covered.length) {
          if (drag.subtract) {
            covered.forEach((i) => {
              selected.delete(i);
              removeFromAnyGroup(i);
            });
          } else {
            covered.forEach((i) => selected.add(i));
            gridAnchorIndex = covered[covered.length - 1];
          }
        }
      }
      // Thumbs/preview refresh is deferred to mouseup so grid-move drags stay
      // smooth even with a large selection.
      renderSelectedThumbs();
      onSelectionChanged();
    }
    drawOverlay();
  });

  // A drag whose mouseup never arrives (alt-tab, OS dialog) must not keep
  // marqueeing/moving on buttons-up mousemoves — cancel it on focus loss.
  window.addEventListener("blur", () => cancelGridDrag());

  // Real-time sampling while in BG pick mode, plus grid cell hover highlight.
  overlayCanvas.addEventListener("mousemove", (ev) => {
    if (gridActive && !gridDrag && !bgPickActive && !erasePickActive) {
      const pt = toImageCoords(ev);
      updateGridCursor(pt.x, pt.y);
      const idx = gridCellIndexAt(pt.x, pt.y);
      if (idx !== gridHoverIndex) {
        gridHoverIndex = idx;
        drawOverlay();
      }
      return;
    }
    if (!bgPickActive && !erasePickActive) return;
    const { x, y } = toImageCoords(ev);
    if (
      x < 0 ||
      y < 0 ||
      x >= originalCanvas.width ||
      y >= originalCanvas.height
    ) {
      return;
    }
    try {
      const data = originalCtx.getImageData(x, y, 1, 1).data;
      const hex = rgbToHex({ r: data[0], g: data[1], b: data[2] });
      if (bgPickActive) {
        bgPickHoverHex = hex;
        const bgInput = $("bgColorInput") as HTMLInputElement;
        if (bgInput) bgInput.value = hex; // preview in realtime
      } else if (erasePickActive) {
        erasePickHoverHex = hex;
        const eInput = $("eraseColorInput") as HTMLInputElement;
        if (eInput) eInput.value = hex; // preview in realtime
      }
    } catch {
      // ignore sampling errors
    }
  });

  overlayCanvas.addEventListener("mouseleave", () => {
    if (gridHoverIndex !== -1) {
      gridHoverIndex = -1;
      if (gridActive) drawOverlay();
    }
    if (bgPickActive) {
      // revert preview while outside
      const bgInput = $("bgColorInput") as HTMLInputElement;
      if (bgInput && bgPickPrevHex) bgInput.value = bgPickPrevHex;
    }
    if (erasePickActive) {
      const eInput = $("eraseColorInput") as HTMLInputElement;
      if (eInput && erasePickPrevHex) eInput.value = erasePickPrevHex;
    }
  });
}

function setCanvasSize(w: number, h: number) {
  originalCanvas.width = w;
  originalCanvas.height = h;
  overlayCanvas.width = w;
  overlayCanvas.height = h;
  applyCanvasZoom();
}

function applyCanvasZoom() {
  const scale = canvasZoom;
  const w = originalCanvas.width;
  const h = originalCanvas.height;

  originalCanvas.style.width = `${w * scale}px`;
  originalCanvas.style.height = `${h * scale}px`;
  overlayCanvas.style.width = `${w * scale}px`;
  overlayCanvas.style.height = `${h * scale}px`;
}

function drawOverlay() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.lineWidth = 1;

  if (gridActive) {
    drawGridOverlay();
  } else {
    for (let i = 0; i < detected.length; i++) {
      const s = detected[i];
      const inActiveGroup =
        spriteToGroup.has(i) && selected.has(i) && groupHasMultipleSelected(i);
      if (inActiveGroup) {
        overlayCtx.strokeStyle = "rgba(0,180,255,0.85)";
      } else {
        overlayCtx.strokeStyle = selected.has(i)
          ? "rgba(0,200,0,0.9)"
          : "rgba(255,0,0,0.85)";
      }
      overlayCtx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
    }
  }

  // Highlight active join groups with a thicker bounding outline.
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeStyle = "rgba(255,140,0,0.95)";
  overlayCtx.setLineDash([6, 3]);
  const drawnGroups = new Set<JoinGroupId>();
  for (const idx of selected) {
    const gid = spriteToGroup.get(idx);
    if (gid === undefined || drawnGroups.has(gid)) continue;
    const members = (joinGroups.get(gid) || []).filter((m) => selected.has(m));
    if (members.length < 2) continue;
    const rect = getGroupBounds(members);
    if (!rect) continue;
    overlayCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    drawnGroups.add(gid);
  }
  overlayCtx.setLineDash([]);
  overlayCtx.lineWidth = 1;

  // Add a data attribute to signal test scripts that drawing is complete.
  overlayCanvas.dataset.drawn = String(detected.length);
}

function groupHasMultipleSelected(spriteIdx: number): boolean {
  const gid = spriteToGroup.get(spriteIdx);
  if (gid === undefined) return false;
  const members = joinGroups.get(gid) || [];
  let count = 0;
  for (const m of members) {
    if (selected.has(m)) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
}

function renderSelectedThumbs() {
  const cont = $("selectedSpritesContainer") as HTMLDivElement;
  cont.innerHTML = "";

  if (!selected.size) {
    cont.textContent =
      'No sprites selected. Tap detected boxes on the canvas to select.';
    const img = $("selectionPreviewImg") as HTMLImageElement | null;
    if (img) img.src = "";
    hideSplitMenu();
    return;
  }

  const smallest = getSmallestSelectedDimensions();
  const units = getSelectedRenderUnits();
  // A huge grid selection (e.g. ALL on a dense grid) would hang the tab if
  // every cell got a thumbnail — cap the strip; the full selection still
  // builds into the atlas.
  const shownUnits =
    gridActive && units.length > GRID_UI_LIMIT
      ? units.slice(0, GRID_UI_LIMIT)
      : units;

  // Toolbar with Join / Clear-joins controls.
  const toolbar = document.createElement("div");
  toolbar.style.display = "flex";
  toolbar.style.flexWrap = "wrap";
  toolbar.style.gap = "6px";
  toolbar.style.marginBottom = "6px";

  const joinBtn = document.createElement("button");
  joinBtn.type = "button";
  joinBtn.className = "btn";
  joinBtn.textContent = `Join Selected (${selected.size})`;
  joinBtn.title =
    "Combine the selected pieces into a single sprite (their bounding box).";
  const canJoin = selected.size >= 2 && !selectionAllInSameGroup();
  joinBtn.disabled = !canJoin;
  joinBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (joinSelectedSprites() == null) return;
    drawOverlay();
    renderSelectedThumbs();
    onSelectionChanged();
  });
  toolbar.appendChild(joinBtn);

  if (joinGroups.size > 0) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn";
    clearBtn.textContent = "Clear All Joins";
    clearBtn.title = "Dissolve all join groups, restoring individual pieces.";
    clearBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      clearJoinGroups();
      drawOverlay();
      renderSelectedThumbs();
      onSelectionChanged();
    });
    toolbar.appendChild(clearBtn);
  }

  cont.appendChild(toolbar);

  shownUnits.forEach((unit) => {
    const s = unit.rect;
    const c = document.createElement("canvas");
    c.width = s.w;
    c.height = s.h;

    const cctx = c.getContext("2d")!;
    cctx.imageSmoothingEnabled = false;
    drawSpriteRect(cctx, originalCanvas, s);

    const wrap = document.createElement("div");
    wrap.style.display = "inline-flex";
    wrap.style.flexDirection = "column";
    wrap.style.alignItems = "center";
    wrap.style.margin = "4px";

    const img = document.createElement("img");
    img.src = c.toDataURL("image/png");
    img.style.width = "96px";
    img.style.height = "auto";
    img.style.border =
      unit.kind === "group" ? "2px solid rgba(255,140,0,0.95)" : "1px dashed #aaa";

    const info = document.createElement("small");
    info.style.opacity = "0.8";
    info.style.fontSize = "11px";

    if (unit.kind === "group") {
      img.dataset.joinGroupId = String(unit.groupId);
      info.textContent = `Joined ×${unit.members.length}`;

      const unjoinBtn = document.createElement("button");
      unjoinBtn.type = "button";
      unjoinBtn.className = "btn";
      unjoinBtn.textContent = "Unjoin";
      unjoinBtn.style.marginTop = "2px";
      unjoinBtn.style.fontSize = "11px";
      unjoinBtn.style.padding = "2px 6px";
      unjoinBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        dissolveJoinGroup(unit.groupId);
        drawOverlay();
        renderSelectedThumbs();
        onSelectionChanged();
      });

      wrap.appendChild(img);
      wrap.appendChild(info);
      wrap.appendChild(unjoinBtn);
      cont.appendChild(wrap);
      return;
    }

    const i = unit.spriteIndex;
    img.dataset.spriteIndex = String(i);

    const splitChoice = spriteSplitChoices.get(i);
    info.textContent = splitChoice
      ? `Split ${splitChoice.axis === "h" ? "H" : "V"} x${splitChoice.parts}`
      : "No split";

    const splitOptions = getSplitOptionsForSprite(s, smallest);
    if (splitOptions.length > 0) {
      info.title = "Right-click or tap-and-hold to split";
      img.style.cursor = "context-menu";

      img.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showSplitMenu(i, ev.clientX, ev.clientY, splitOptions);
      });

      img.addEventListener("touchstart", (ev) => {
        if (!ev.touches.length) return;
        const touch = ev.touches[0];
        if (splitLongPressTimer) window.clearTimeout(splitLongPressTimer);
        splitLongPressTimer = window.setTimeout(() => {
          showSplitMenu(i, touch.clientX, touch.clientY, splitOptions);
        }, 500);
      }, { passive: true });

      const clearLongPress = () => {
        if (splitLongPressTimer) {
          window.clearTimeout(splitLongPressTimer);
          splitLongPressTimer = null;
        }
      };

      img.addEventListener("touchend", clearLongPress, { passive: true });
      img.addEventListener("touchcancel", clearLongPress, { passive: true });
    }

    wrap.appendChild(img);
    wrap.appendChild(info);
    cont.appendChild(wrap);
  });

  if (shownUnits.length < units.length) {
    const more = document.createElement("div");
    more.className = "sx-note";
    more.textContent = `+${units.length - shownUnits.length} more cells selected (thumbnails capped — all build into the atlas)`;
    cont.appendChild(more);
  }
}

function getSortedSelectedIndices(): number[] {
  const arr = [...selected];
  if (gridActive) {
    // Grid cells are enumerated row-major, so index order IS reading order
    // (left-to-right, top-to-bottom) — what animation sequences expect.
    arr.sort((a, b) => a - b);
    return arr;
  }
  arr.sort((a, b) => {
    const sa = detected[a];
    const sb = detected[b];
    if (!sa || !sb) return a - b;
    if (sa.x !== sb.x) return sa.x - sb.x;
    return sa.y - sb.y;
  });
  return arr;
}

function getSmallestSelectedDimensions(): { w: number; h: number } {
  const indices = [...selected];
  let minW = Number.POSITIVE_INFINITY;
  let minH = Number.POSITIVE_INFINITY;

  indices.forEach((i) => {
    const s = detected[i];
    if (!s) return;
    minW = Math.min(minW, Math.max(1, s.w));
    minH = Math.min(minH, Math.max(1, s.h));
  });

  if (!Number.isFinite(minW) || !Number.isFinite(minH)) {
    return { w: 1, h: 1 };
  }

  return { w: minW, h: minH };
}

function getSplitOptionsForSprite(
  sprite: DetectedSprite,
  smallest: { w: number; h: number }
): SpriteSplitChoice[] {
  const options: SpriteSplitChoice[] = [];
  const maxH = Math.floor(sprite.w / Math.max(1, smallest.w));
  const maxV = Math.floor(sprite.h / Math.max(1, smallest.h));

  for (let n = 2; n <= maxH; n++) options.push({ axis: "h", parts: n });
  for (let n = 2; n <= maxV; n++) options.push({ axis: "v", parts: n });
  return options;
}

function splitSpriteRect(
  sprite: DetectedSprite,
  split: SpriteSplitChoice
): DetectedSprite[] {
  const parts: DetectedSprite[] = [];
  if (split.parts < 2) return [sprite];

  if (split.axis === "h") {
    for (let i = 0; i < split.parts; i++) {
      const x0 = sprite.x + Math.floor((i * sprite.w) / split.parts);
      const x1 = sprite.x + Math.floor(((i + 1) * sprite.w) / split.parts);
      parts.push({ x: x0, y: sprite.y, w: Math.max(1, x1 - x0), h: sprite.h });
    }
  } else {
    for (let i = 0; i < split.parts; i++) {
      const y0 = sprite.y + Math.floor((i * sprite.h) / split.parts);
      const y1 = sprite.y + Math.floor(((i + 1) * sprite.h) / split.parts);
      parts.push({ x: sprite.x, y: y0, w: sprite.w, h: Math.max(1, y1 - y0) });
    }
  }

  return parts;
}

function getSelectedBoxesExpanded(): DetectedSprite[] {
  const units = getSelectedRenderUnits();
  const boxes: DetectedSprite[] = [];
  const smallest = getSmallestSelectedDimensions();

  units.forEach((unit) => {
    if (unit.kind === "group") {
      // Joined pieces are emitted as a single combined rect; splits are not
      // applicable to joined groups.
      boxes.push(unit.rect);
      return;
    }

    const idx = unit.spriteIndex;
    const sprite = unit.rect;
    const split = spriteSplitChoices.get(idx);

    if (!split) {
      boxes.push(sprite);
      return;
    }

    const valid = getSplitOptionsForSprite(sprite, smallest).some(
      (opt) => opt.axis === split.axis && opt.parts === split.parts
    );

    if (!valid) {
      spriteSplitChoices.delete(idx);
      boxes.push(sprite);
      return;
    }

    boxes.push(...splitSpriteRect(sprite, split));
  });

  return boxes;
}

function clearJoinGroups() {
  joinGroups.clear();
  spriteToGroup.clear();
}

function removeFromAnyGroup(idx: number) {
  const gid = spriteToGroup.get(idx);
  if (gid === undefined) return;
  spriteToGroup.delete(idx);
  const members = joinGroups.get(gid);
  if (!members) return;
  const remaining = members.filter((i) => i !== idx);
  if (remaining.length < 2) {
    for (const m of remaining) spriteToGroup.delete(m);
    joinGroups.delete(gid);
  } else {
    joinGroups.set(gid, remaining);
  }
}

function dissolveJoinGroup(gid: JoinGroupId) {
  const members = joinGroups.get(gid);
  if (!members) return;
  for (const idx of members) spriteToGroup.delete(idx);
  joinGroups.delete(gid);
}

type Span = [number, number];

/** Merge overlapping/touching spans into sorted, maximal runs. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Position of a source coordinate once the blank bands between runs collapse. */
function collapseCoord(coord: number, runs: Span[]): number {
  let offset = 0;
  for (const [start, end] of runs) {
    if (coord < end) return offset + Math.max(0, coord - start);
    offset += end - start;
  }
  return offset;
}

/**
 * Combined rect for a join group with the empty gaps between members squeezed
 * out. Members keep their relative alignment inside each contiguous run of
 * occupied rows/columns, but the blank bands separating runs collapse to zero
 * so joined pieces sit flush against each other.
 */
function getGroupComposite(members: number[]): DetectedSprite | null {
  const rects = members
    .map((idx) => detected[idx])
    .filter((s): s is DetectedSprite => !!s);
  if (!rects.length) return null;

  const xRuns = mergeSpans(rects.map((s) => [s.x, s.x + s.w] as Span));
  const yRuns = mergeSpans(rects.map((s) => [s.y, s.y + s.h] as Span));

  const parts = rects.map((s) => ({
    sx: s.x,
    sy: s.y,
    w: s.w,
    h: s.h,
    dx: collapseCoord(s.x, xRuns),
    dy: collapseCoord(s.y, yRuns),
  }));

  const w = xRuns.reduce((sum, [start, end]) => sum + (end - start), 0);
  const h = yRuns.reduce((sum, [start, end]) => sum + (end - start), 0);

  return {
    x: xRuns[0][0],
    y: yRuns[0][0],
    w: Math.max(1, w),
    h: Math.max(1, h),
    parts,
  };
}

function getGroupBounds(members: number[]): DetectedSprite | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let any = false;
  for (const idx of members) {
    const s = detected[idx];
    if (!s) continue;
    any = true;
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x + s.w > maxX) maxX = s.x + s.w;
    if (s.y + s.h > maxY) maxY = s.y + s.h;
  }
  if (!any) return null;
  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

function joinSelectedSprites(): JoinGroupId | null {
  const indices = [...selected];
  if (indices.length < 2) return null;

  // Detach members from any prior groups, then create a fresh group.
  for (const idx of indices) removeFromAnyGroup(idx);
  // Joining replaces splits on the involved members, since splits don't apply
  // to combined pieces.
  for (const idx of indices) spriteSplitChoices.delete(idx);

  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const id = nextJoinGroupId++;
  joinGroups.set(id, sorted);
  for (const idx of sorted) spriteToGroup.set(idx, id);
  return id;
}

function selectionAllInSameGroup(): boolean {
  if (selected.size < 2) return false;
  const gids = new Set<JoinGroupId>();
  for (const idx of selected) {
    const gid = spriteToGroup.get(idx);
    if (gid === undefined) return false;
    gids.add(gid);
  }
  if (gids.size !== 1) return false;
  // All currently-selected sprites map to one group, but the group may
  // contain other selected members not in `selected`. Compare member sets.
  const onlyGid = gids.values().next().value as JoinGroupId;
  const members = joinGroups.get(onlyGid) || [];
  if (members.length !== selected.size) return false;
  for (const m of members) if (!selected.has(m)) return false;
  return true;
}

function getSelectedRenderUnits(): RenderUnit[] {
  const visited = new Set<number>();
  const units: RenderUnit[] = [];

  for (const idx of getSortedSelectedIndices()) {
    if (visited.has(idx)) continue;
    const gid = spriteToGroup.get(idx);
    if (gid !== undefined) {
      const members = joinGroups.get(gid) || [];
      const selectedMembers = members.filter((m) => selected.has(m));
      if (selectedMembers.length >= 2) {
        const rect = getGroupComposite(selectedMembers);
        if (rect) {
          units.push({
            kind: "group",
            groupId: gid,
            members: selectedMembers,
            rect,
          });
          for (const m of selectedMembers) visited.add(m);
          continue;
        }
      }
    }
    const s = detected[idx];
    if (!s) {
      visited.add(idx);
      continue;
    }
    units.push({ kind: "single", spriteIndex: idx, rect: s });
    visited.add(idx);
  }

  units.sort((a, b) => {
    if (gridActive) {
      // Reading order for grid cells: top-to-bottom rows, left-to-right.
      if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y;
      return a.rect.x - b.rect.x;
    }
    if (a.rect.x !== b.rect.x) return a.rect.x - b.rect.x;
    return a.rect.y - b.rect.y;
  });

  return units;
}

function createSplitIcon(axis: "h" | "v", parts: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 48;
  c.height = 28;
  const ctx = c.getContext("2d")!;
  ctx.strokeStyle = "#666";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);

  if (axis === "h") {
    for (let i = 1; i < parts; i++) {
      const x = Math.round((i * c.width) / parts) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0.5);
      ctx.lineTo(x, c.height - 0.5);
      ctx.stroke();
    }
  } else {
    for (let i = 1; i < parts; i++) {
      const y = Math.round((i * c.height) / parts) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0.5, y);
      ctx.lineTo(c.width - 0.5, y);
      ctx.stroke();
    }
  }

  c.style.display = "block";
  c.style.marginRight = "8px";
  return c;
}

function ensureSplitMenu(): HTMLDivElement {
  if (splitMenuEl) return splitMenuEl;
  splitMenuEl = document.createElement("div");
  splitMenuEl.id = "splitMenu";
  splitMenuEl.style.position = "fixed";
  splitMenuEl.style.display = "none";
  splitMenuEl.style.background = "var(--panel-bg)";
  splitMenuEl.style.border = "1px solid var(--panel-border)";
  splitMenuEl.style.borderRadius = "8px";
  splitMenuEl.style.padding = "6px";
  splitMenuEl.style.zIndex = "2000";
  splitMenuEl.style.minWidth = "170px";
  splitMenuEl.style.boxShadow = "0 4px 14px rgba(0,0,0,0.2)";
  document.body.appendChild(splitMenuEl);

  document.addEventListener("click", () => hideSplitMenu());
  document.addEventListener("contextmenu", () => hideSplitMenu());

  return splitMenuEl;
}

function hideSplitMenu() {
  if (splitMenuEl) splitMenuEl.style.display = "none";
}

function showSplitMenu(
  spriteIndex: number,
  clientX: number,
  clientY: number,
  options: SpriteSplitChoice[]
) {
  const menu = ensureSplitMenu();
  menu.innerHTML = "";

  const noneBtn = document.createElement("button");
  noneBtn.type = "button";
  noneBtn.className = "btn";
  noneBtn.textContent = "No split";
  noneBtn.style.display = "block";
  noneBtn.style.width = "100%";
  noneBtn.style.marginBottom = "4px";
  noneBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    spriteSplitChoices.delete(spriteIndex);
    hideSplitMenu();
    renderSelectedThumbs();
    onSelectionChanged();
  });
  menu.appendChild(noneBtn);

  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.style.display = "flex";
    btn.style.alignItems = "center";
    btn.style.width = "100%";
    btn.style.marginBottom = "4px";

    btn.appendChild(createSplitIcon(opt.axis, opt.parts));
    const text = document.createElement("span");
    text.textContent = `${opt.parts} ${opt.axis === "h" ? "horizontal" : "vertical"}`;
    btn.appendChild(text);

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      spriteSplitChoices.set(spriteIndex, opt);
      hideSplitMenu();
      renderSelectedThumbs();
      onSelectionChanged();
    });

    menu.appendChild(btn);
  });

  menu.style.left = `${Math.min(clientX, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(clientY, window.innerHeight - 220)}px`;
  menu.style.display = "block";
}

function collectSelectionFrames(): string[] {
  if (!selected.size) return [];
  let boxes = getSelectedBoxesExpanded();
  // Preview only — extracting thousands of grid cells would hang the tab.
  // Atlas building uses getSelectedBoxesExpanded() directly and is not capped.
  if (gridActive && boxes.length > GRID_UI_LIMIT) {
    boxes = boxes.slice(0, GRID_UI_LIMIT);
  }
  const bgInput = $("bgColorInput") as HTMLInputElement | null;
  const chosenBg = bgInput?.value ? hexToRgb(bgInput.value) : detectedBg;
  const map = extractSpriteDataURLs(originalCanvas, boxes, {
    bgColor: chosenBg,
    tolerance: detectedTolerance,
  });
  const frames: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const k = `sprite_${i}`;
    if (map[k]) frames.push(map[k]);
  }
  return frames;
}

function stopSelectionPreview() {
  if (selectionAnimTimer) {
    window.clearInterval(selectionAnimTimer);
    selectionAnimTimer = null;
  }
  selectionPlaying = false;
  const btn = $("selectionPreviewBtn") as HTMLButtonElement | null;
  if (btn) btn.textContent = "Preview Selected";
}

async function startSelectionPreview() {
  const fpsInput = $("selectionFpsInput") as HTMLInputElement | null;
  const fps = Math.max(1, Math.min(60, Number(fpsInput?.value || 6)));
  const dur = Math.round(1000 / fps);

  selectionFrames = collectSelectionFrames();
  selectionFrameIndex = 0;

  await setContainerSize(
    $("selectionPreviewContainer") as HTMLElement,
    selectionFrames
  );

  const img = $("selectionPreviewImg") as HTMLImageElement | null;
  if (!selectionFrames.length || !img) {
    stopSelectionPreview();
    return;
  }

  img.src = selectionFrames[0];
  if (selectionAnimTimer) window.clearInterval(selectionAnimTimer);
  selectionAnimTimer = window.setInterval(() => {
    selectionFrameIndex = (selectionFrameIndex + 1) % selectionFrames.length;
    img.src = selectionFrames[selectionFrameIndex];
  }, dur);

  selectionPlaying = true;
  const btn = $("selectionPreviewBtn") as HTMLButtonElement | null;
  if (btn) btn.textContent = "Stop Preview";
}

async function refreshSelectionPreviewFrames(keepPlaying = true) {
  // Update frames and restart timer if we were playing
  const img = $("selectionPreviewImg") as HTMLImageElement | null;
  selectionFrames = collectSelectionFrames();
  selectionFrameIndex = 0;
  if (img) img.src = selectionFrames[0] || "";
  if (selectionPlaying && keepPlaying) {
    await startSelectionPreview();
  }
}

// This function is now replaced by populateSpritePreviewDropdownFromDB
/*
function updateSpritePreviewDropdown() {
  const select = $('spritePreviewSelect') as HTMLSelectElement;
  if (!select) return;

  const sorted = getSortedSelectedIndices();
  const currentVal = select.value;

  select.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Select a sprite --';
  select.appendChild(placeholder);

  sorted.forEach(idx => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `Sprite ${idx}`;
    select.appendChild(opt);
  });

  // Try to preserve the selection if it still exists
  if (sorted.includes(Number(currentVal))) {
    select.value = currentVal;
  }
}
*/

function onSelectionChanged() {
  for (const key of [...spriteSplitChoices.keys()]) {
    if (!selected.has(key)) spriteSplitChoices.delete(key);
  }
  // Drop join group members that are no longer selected, dissolving groups
  // that fall below two members.
  for (const idx of [...spriteToGroup.keys()]) {
    if (!selected.has(idx)) removeFromAnyGroup(idx);
  }
  // Keep preview in sync with selection
  refreshSelectionPreviewFrames(true);
  // The sprite preview dropdown is now populated from the DB, not from the local selection.
  // updateSpritePreviewDropdown();
}

// ───────────────────────── Grid slicing ─────────────────────────

function gridPeriod(): { px: number; py: number } {
  return {
    px: Math.max(1, gridParams.cellW + gridParams.gapX),
    py: Math.max(1, gridParams.cellH + gridParams.gapY),
  };
}

function gridCellIndexAt(x: number, y: number): number {
  if (!gridActive || gridCols <= 0 || gridRows <= 0) return -1;
  if (!detected.length) return -1; // over-cap state: geometry kept, cells inert
  const { px, py } = gridPeriod();
  const lx = x - gridParams.offX;
  const ly = y - gridParams.offY;
  if (lx < 0 || ly < 0) return -1;
  const c = Math.floor(lx / px);
  const r = Math.floor(ly / py);
  if (c >= gridCols || r >= gridRows) return -1;
  // Points in the spacing gutters belong to no cell.
  if (lx - c * px >= gridParams.cellW || ly - r * py >= gridParams.cellH)
    return -1;
  return r * gridCols + c;
}

// All cell indices whose area intersects the rect spanned by two points.
function gridCellsInRect(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number[] {
  if (gridCols <= 0 || gridRows <= 0 || !detected.length) return [];
  const { px, py } = gridPeriod();
  const { cellW, cellH, offX, offY } = gridParams;
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  if (x1 < offX || y1 < offY) return [];
  let cMin = Math.floor((x0 - offX) / px);
  if (cMin >= 0 && x0 - offX - cMin * px >= cellW) cMin++; // started in a gutter
  cMin = Math.max(0, cMin);
  let rMin = Math.floor((y0 - offY) / py);
  if (rMin >= 0 && y0 - offY - rMin * py >= cellH) rMin++;
  rMin = Math.max(0, rMin);
  const cMax = Math.min(gridCols - 1, Math.floor((x1 - offX) / px));
  const rMax = Math.min(gridRows - 1, Math.floor((y1 - offY) / py));
  const out: number[] = [];
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) out.push(r * gridCols + c);
  }
  return out;
}

// Recompute the cell rects into `detected`, carrying the selection (and
// splits/joins) across the rebuild by (row, col) so tweaking a parameter or
// dragging the grid doesn't wipe the user's picks.
function rebuildGridCells(opts?: {
  remapSelection?: boolean;
  // When a move-drag wraps the origin past zero by n periods, every column/row
  // is renumbered by n — the remap shifts by these to keep the selection over
  // the same screen region.
  shiftCols?: number;
  shiftRows?: number;
}) {
  const oldCols = gridCols;
  const oldRows = gridRows;
  const { px, py } = gridPeriod();
  const { cellW, cellH, offX, offY } = gridParams;
  const W = originalCanvas.width;
  const H = originalCanvas.height;

  const cols = W - offX >= cellW ? Math.floor((W - offX - cellW) / px) + 1 : 0;
  const rows = H - offY >= cellH ? Math.floor((H - offY - cellH) / py) + 1 : 0;

  if (cols * rows > GRID_MAX_CELLS) {
    // A transient over-cap value (e.g. mid-typing a cell size) must not
    // destroy the user's picks: keep the selection and the last good
    // geometry, empty the cells so interactions go inert, and let the next
    // valid rebuild remap from the preserved geometry.
    detected = [];
    gridLayerCanvas = null;
    gridHoverIndex = -1;
    updateGridInfo(`TOO MANY CELLS (${cols * rows})`);
    return;
  }

  gridCols = cols;
  gridRows = rows;
  const cells: DetectedSprite[] = [];
  for (let r = 0; r < rows; r++) {
    const y = offY + r * py;
    for (let c = 0; c < cols; c++) {
      cells.push({ x: offX + c * px, y, w: cellW, h: cellH });
    }
  }
  detected = cells;

  const shiftC = opts?.shiftCols ?? 0;
  const shiftR = opts?.shiftRows ?? 0;
  const mapIdx = (i: number): number | null => {
    if (oldCols <= 0) return null;
    const r = Math.floor(i / oldCols) + shiftR;
    const c = (i % oldCols) + shiftC;
    return r >= 0 && c >= 0 && r < rows && c < cols ? r * cols + c : null;
  };

  if (opts?.remapSelection && oldCols > 0 && oldRows > 0) {
    const newSelected = new Set<number>();
    for (const i of selected) {
      const m = mapIdx(i);
      if (m != null) newSelected.add(m);
    }
    selected = newSelected;

    const remappedSplits = new Map<number, SpriteSplitChoice>();
    for (const [i, choice] of spriteSplitChoices) {
      const m = mapIdx(i);
      if (m != null && newSelected.has(m)) remappedSplits.set(m, choice);
    }
    spriteSplitChoices.clear();
    for (const [k, v] of remappedSplits) spriteSplitChoices.set(k, v);

    const groups = [...joinGroups.entries()];
    clearJoinGroups();
    for (const [gid, members] of groups) {
      const mapped = members
        .map(mapIdx)
        .filter((m): m is number => m != null && newSelected.has(m))
        .sort((x, y) => x - y);
      if (mapped.length >= 2) {
        joinGroups.set(gid, mapped);
        mapped.forEach((m) => spriteToGroup.set(m, gid));
      }
    }

    gridAnchorIndex =
      gridAnchorIndex != null ? mapIdx(gridAnchorIndex) : null;
  } else {
    selected.clear();
    spriteSplitChoices.clear();
    clearJoinGroups();
    gridAnchorIndex = null;
  }
  gridHoverIndex = -1;

  renderGridLayer();
  updateGridInfo();
}

// Cached base layer: dim the margins/gutters and outline every cell once, so
// per-frame drawing is a single drawImage regardless of cell count.
function renderGridLayer() {
  const W = originalCanvas.width;
  const H = originalCanvas.height;
  let layer = gridLayerCanvas;
  if (!layer || layer.width !== W || layer.height !== H) {
    layer = document.createElement("canvas");
    layer.width = W;
    layer.height = H;
  }
  const ctx = layer.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, W, H);
  for (const cell of detected) ctx.clearRect(cell.x, cell.y, cell.w, cell.h);

  const path = new Path2D();
  for (const cell of detected) {
    path.rect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(156,255,107,0.55)";
  ctx.stroke(path);

  gridLayerCanvas = layer;
}

function drawGridOverlay() {
  if (gridLayerCanvas) overlayCtx.drawImage(gridLayerCanvas, 0, 0);

  if (selected.size) {
    const path = new Path2D();
    for (const i of selected) {
      const s = detected[i];
      if (s) path.rect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
    }
    overlayCtx.fillStyle = "rgba(0,220,90,0.22)";
    overlayCtx.fill(path);
    overlayCtx.strokeStyle = "rgba(120,255,170,0.95)";
    overlayCtx.stroke(path);
  }

  const hover = gridHoverIndex >= 0 ? detected[gridHoverIndex] : null;
  if (hover && !gridDrag) {
    overlayCtx.strokeStyle = "rgba(246,255,74,0.9)";
    overlayCtx.strokeRect(hover.x + 0.5, hover.y + 0.5, hover.w - 1, hover.h - 1);
  }

  if (gridDrag?.mode === "select" && gridDrag.moved) {
    const covered = gridCellsInRect(gridDrag.startImg, gridDrag.lastImg);
    if (covered.length) {
      const path = new Path2D();
      for (const i of covered) {
        const s = detected[i];
        if (s) path.rect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
      }
      overlayCtx.strokeStyle = gridDrag.subtract
        ? "rgba(255,80,80,0.9)"
        : "rgba(246,255,74,0.85)";
      overlayCtx.stroke(path);
    }

    const rx = Math.min(gridDrag.startImg.x, gridDrag.lastImg.x);
    const ry = Math.min(gridDrag.startImg.y, gridDrag.lastImg.y);
    const rw = Math.max(1, Math.abs(gridDrag.lastImg.x - gridDrag.startImg.x));
    const rh = Math.max(1, Math.abs(gridDrag.lastImg.y - gridDrag.startImg.y));
    overlayCtx.fillStyle = "rgba(246,255,74,0.08)";
    overlayCtx.fillRect(rx, ry, rw, rh);
    overlayCtx.setLineDash([5, 3]);
    overlayCtx.strokeStyle = "rgba(246,255,74,0.9)";
    overlayCtx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
    overlayCtx.setLineDash([]);
  }

  drawGridHandle();
}

// Origin handle: a constant ~12 screen-px square at the grid origin that can
// be dragged to move the grid in any tool mode.
function gridHandleSize(): number {
  return Math.max(3, Math.round(12 / canvasZoom));
}

function drawGridHandle() {
  const size = gridHandleSize();
  const x = gridParams.offX;
  const y = gridParams.offY;
  overlayCtx.fillStyle = "rgba(246,255,74,0.85)";
  overlayCtx.fillRect(x - size / 2, y - size / 2, size, size);
  overlayCtx.strokeStyle = "rgba(0,0,0,0.8)";
  overlayCtx.strokeRect(x - size / 2 + 0.5, y - size / 2 + 0.5, size - 1, size - 1);
}

function isOverGridHandle(x: number, y: number): boolean {
  const half = gridHandleSize() / 2 + 2 / canvasZoom;
  return (
    Math.abs(x - gridParams.offX) <= half && Math.abs(y - gridParams.offY) <= half
  );
}

function moveGridTo(rawX: number, rawY: number, base?: GridDragBase) {
  if (!gridActive) return;
  const { px, py } = gridPeriod();
  const W = originalCanvas.width;
  const H = originalCanvas.height;
  const maxX = Math.max(0, W - gridParams.cellW);
  const maxY = Math.max(0, H - gridParams.cellH);
  // Wrap negatives by whole periods so the grid slides seamlessly past zero —
  // but only when every wrapped position is a valid origin (otherwise a
  // single-column grid would jump to the far side on a left drag; clamp to 0
  // instead). Wrapping renumbers columns/rows, so the wrap counts feed the
  // selection remap shift below.
  let x = rawX;
  let y = rawY;
  let wrapX = 0;
  let wrapY = 0;
  if (maxX >= px - 1) {
    while (x < 0) {
      x += px;
      wrapX++;
    }
  }
  if (maxY >= py - 1) {
    while (y < 0) {
      y += py;
      wrapY++;
    }
  }
  x = Math.min(Math.max(0, x), maxX);
  y = Math.min(Math.max(0, y), maxY);
  if (x === gridParams.offX && y === gridParams.offY) return;
  // During a drag, rebuild from the drag-start snapshot each time so only the
  // net displacement matters — chained incremental remaps would accumulate
  // losses at the edges.
  if (base) restoreGridBaseline(base);
  gridParams.offX = x;
  gridParams.offY = y;
  syncGridInputs();
  rebuildGridCells({
    remapSelection: true,
    shiftCols: -wrapX,
    shiftRows: -wrapY,
  });
  drawOverlay();
}

function restoreGridBaseline(base: GridDragBase) {
  gridCols = base.cols;
  gridRows = base.rows;
  selected = new Set(base.selected);
  spriteSplitChoices.clear();
  for (const [k, v] of base.splits) spriteSplitChoices.set(k, v);
  clearJoinGroups();
  for (const [gid, members] of base.joins) {
    joinGroups.set(gid, [...members]);
    members.forEach((m) => spriteToGroup.set(m, gid));
  }
  gridAnchorIndex = base.anchor;
}

// Apply a coalesced move-drag update immediately (used at mouseup so the drag
// commits at its final position).
function flushPendingGridMove() {
  if (gridMoveRaf != null) {
    window.cancelAnimationFrame(gridMoveRaf);
    gridMoveRaf = null;
  }
  const p = gridMovePending;
  gridMovePending = null;
  if (p) moveGridTo(p.x, p.y, p.base);
}

function discardPendingGridMove() {
  if (gridMoveRaf != null) {
    window.cancelAnimationFrame(gridMoveRaf);
    gridMoveRaf = null;
  }
  gridMovePending = null;
}

// Cancel an in-flight grid drag (Escape, window blur): a moved grid goes back
// to where it started, with the drag-start selection restored exactly.
function cancelGridDrag() {
  if (!gridDrag) return;
  const drag = gridDrag;
  gridDrag = null;
  discardPendingGridMove();
  if (drag.moved) {
    // Swallow the click that fires when the still-held button is released.
    // (If it is released off-canvas no click fires; the next mousedown clears
    // the stale flag.)
    suppressNextClick = true;
    if (drag.mode === "move") {
      // Restore explicitly rather than via moveGridTo: after a full-period
      // wrap the offset can equal the start value while the selection is
      // shifted, which moveGridTo's no-op check would skip.
      restoreGridBaseline(drag.base);
      gridParams.offX = drag.startOff.x;
      gridParams.offY = drag.startOff.y;
      syncGridInputs();
      rebuildGridCells({ remapSelection: true });
      renderSelectedThumbs();
      onSelectionChanged();
    }
  }
  updateGridCursorBase();
  drawOverlay();
}

function syncGridInputs() {
  const set = (id: string, v: number) => {
    const el = $(id) as HTMLInputElement | null;
    if (el) el.value = String(v);
  };
  set("gridCellWInput", gridParams.cellW);
  set("gridCellHInput", gridParams.cellH);
  set("gridGapXInput", gridParams.gapX);
  set("gridGapYInput", gridParams.gapY);
  set("gridOffXInput", gridParams.offX);
  set("gridOffYInput", gridParams.offY);
}

function readGridParamsFromInputs() {
  const readNum = (id: string, fallback: number, min: number) => {
    const el = $(id) as HTMLInputElement | null;
    const s = el?.value.trim();
    if (!s) return fallback; // mid-edit cleared field: keep the current value
    const v = Number(s);
    return Number.isFinite(v) ? Math.max(min, Math.floor(v)) : fallback;
  };
  gridParams.cellW = readNum("gridCellWInput", gridParams.cellW, 1);
  gridParams.cellH = readNum("gridCellHInput", gridParams.cellH, 1);
  gridParams.gapX = readNum("gridGapXInput", gridParams.gapX, 0);
  gridParams.gapY = readNum("gridGapYInput", gridParams.gapY, 0);
  gridParams.offX = readNum("gridOffXInput", gridParams.offX, 0);
  gridParams.offY = readNum("gridOffYInput", gridParams.offY, 0);
}

function updateGridInfo(warning?: string) {
  const el = $("gridInfo");
  if (!el) return;
  el.textContent = warning
    ? `⚠ ${warning}`
    : gridCols > 0 && gridRows > 0
      ? `${gridCols}×${gridRows} — ${gridCols * gridRows} CELLS`
      : "NO CELLS FIT";
}

// If sprites are selected when grid mode turns on, the topmost-leftmost one
// drives the defaults: its size becomes the cell size and the grid is aligned
// so a cell lands exactly on it.
function seedGridDefaultsFromSelection() {
  if (!selected.size) return;
  let seed: DetectedSprite | null = null;
  for (const i of selected) {
    const s = detected[i];
    if (!s) continue;
    if (!seed || s.y < seed.y || (s.y === seed.y && s.x < seed.x)) seed = s;
  }
  if (!seed) return;
  gridParams.cellW = Math.max(1, seed.w);
  gridParams.cellH = Math.max(1, seed.h);
  const { px, py } = gridPeriod();
  gridParams.offX = seed.x % px;
  gridParams.offY = seed.y % py;
}

function setGridActive(on: boolean) {
  if (on === gridActive) return;

  if (on) {
    seedGridDefaultsFromSelection();
    preGridState = {
      detected,
      selected: new Set(selected),
      splits: new Map(spriteSplitChoices),
      joins: new Map([...joinGroups.entries()].map(([k, v]) => [k, [...v]])),
    };
    gridActive = true;
    selected = new Set();
    spriteSplitChoices.clear();
    clearJoinGroups();
    hideSplitMenu();
    gridCols = 0;
    gridRows = 0;
    rebuildGridCells();
    syncGridInputs();
  } else {
    gridActive = false;
    gridLayerCanvas = null;
    gridHoverIndex = -1;
    gridAnchorIndex = null;
    gridDrag = null;
    discardPendingGridMove();
    if (preGridState) {
      detected = preGridState.detected;
      selected = preGridState.selected;
      spriteSplitChoices.clear();
      for (const [k, v] of preGridState.splits) spriteSplitChoices.set(k, v);
      clearJoinGroups();
      for (const [gid, members] of preGridState.joins) {
        joinGroups.set(gid, members);
        members.forEach((m) => spriteToGroup.set(m, gid));
      }
      preGridState = null;
    } else {
      detected = [];
      selected = new Set();
      spriteSplitChoices.clear();
      clearJoinGroups();
    }
    hideSplitMenu();
  }

  updateGridModeUI();
  drawOverlay();
  renderSelectedThumbs();
  onSelectionChanged();
}

// Drop grid mode without restoring the stash — used when a new image loads and
// the stashed detection results no longer apply.
function discardGridMode() {
  if (!gridActive && !preGridState) return;
  gridActive = false;
  preGridState = null;
  gridLayerCanvas = null;
  gridHoverIndex = -1;
  gridAnchorIndex = null;
  gridDrag = null;
  discardPendingGridMove();
  gridCols = 0;
  gridRows = 0;
  updateGridModeUI();
}

function updateGridModeUI() {
  ($("gridModeBtn") as HTMLButtonElement | null)?.classList.toggle(
    "active",
    gridActive
  );
  const bar = $("gridToolbar");
  if (bar) bar.hidden = !gridActive;
  const hint = $("workspaceHint");
  const hintDim = $("workspaceHintDim");
  if (hint) {
    hint.textContent = gridActive
      ? "CLICK / DRAG CELLS — SELECT"
      : "CLICK SPRITE — TOGGLE SELECT";
  }
  if (hintDim) {
    hintDim.textContent = gridActive
      ? "SHIFT+CLICK — RANGE · ALT+DRAG — MOVE GRID"
      : "RIGHT-CLICK THUMB — SPLIT";
  }
  updateGridToolButtons();
  updateGridCursorBase();
}

function updateGridToolButtons() {
  ($("gridToolSelectBtn") as HTMLButtonElement | null)?.classList.toggle(
    "active",
    gridTool === "select"
  );
  ($("gridToolMoveBtn") as HTMLButtonElement | null)?.classList.toggle(
    "active",
    gridTool === "move"
  );
}

function updateGridCursorBase() {
  overlayCanvas.style.cursor = gridActive
    ? gridTool === "move"
      ? "grab"
      : "crosshair"
    : "";
}

function updateGridCursor(x: number, y: number) {
  if (!gridActive) return;
  overlayCanvas.style.cursor = isOverGridHandle(x, y)
    ? "move"
    : gridTool === "move"
      ? "grab"
      : "crosshair";
}

// Select every cell that has any content: a pixel that is neither transparent
// nor (when a background color is known) within tolerance of the background.
// Faint particle-only frames count as content, so animation tails survive.
function gridSelectAllCells() {
  if (!gridActive || !detected.length) return;
  const W = originalCanvas.width;
  let data: Uint8ClampedArray | null = null;
  try {
    data = originalCtx.getImageData(0, 0, W, originalCanvas.height).data;
  } catch {
    data = null; // tainted canvas — fall back to selecting every cell
  }
  const bg = detectedBg;
  const tol = detectedTolerance;
  const cellHasContent = (cell: DetectedSprite): boolean => {
    if (!data) return true;
    for (let y = cell.y; y < cell.y + cell.h; y++) {
      let i = (y * W + cell.x) * 4;
      for (let x = 0; x < cell.w; x++, i += 4) {
        const a = data[i + 3];
        if (a === 0) continue;
        if (
          bg &&
          Math.abs(data[i] - bg.r) <= tol &&
          Math.abs(data[i + 1] - bg.g) <= tol &&
          Math.abs(data[i + 2] - bg.b) <= tol
        ) {
          continue;
        }
        return true;
      }
    }
    return false;
  };
  selected = new Set(
    detected.map((c, i) => (cellHasContent(c) ? i : -1)).filter((i) => i >= 0)
  );
  gridAnchorIndex = null;
  drawOverlay();
  renderSelectedThumbs();
  onSelectionChanged();
}

// ─────────────────────── End grid slicing ───────────────────────

function ensureDataURL(s: string): string {
    return s.startsWith("data:") ? s : `data:image/png;base64,${s}`;
}

function extractSingleSpriteDataURL(index: number): string | null {
    const s = detected[index];
    if (!s) return null;

    const c = document.createElement("canvas");
    c.width = s.w;
    c.height = s.h;

    const cctx = c.getContext("2d")!;
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(originalCanvas, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);

    return c.toDataURL("image/png");
}

async function loadFromURL(url: string, opts?: { autoDetect?: boolean }) {
  const img = new Image();
  img.crossOrigin = "Anonymous";

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });

  setCanvasSize(img.naturalWidth, img.naturalHeight);
  originalCtx.clearRect(0, 0, originalCanvas.width, originalCanvas.height);
  originalCtx.drawImage(img, 0, 0);

  // A stashed grid session belongs to the previous image — drop it.
  discardGridMode();

  detected = [];
  selected.clear();
  spriteSplitChoices.clear();
  clearJoinGroups();
  hideSplitMenu();

  // Reset BG controls to default state when a new image is loaded.
  const bgInput = $("bgColorInput") as HTMLInputElement;
  const bgPickBtn = $("bgColorPickBtn") as HTMLButtonElement;
  const bgStatus = $("bgStatus") as HTMLSpanElement;
  bgInput.disabled = false;
  bgPickBtn.disabled = false;
  bgStatus.style.display = "none";

  if (opts?.autoDetect === false) {
    drawOverlay();
    renderSelectedThumbs();
    onSelectionChanged();
    return;
  }

  // Task 4: automatically detect background color + sprites on open, using the
  // same smartDetectSprites approach as the sprite-picker-extension.
  runDetect();
}

/**
 * Load an atlas texture into the Extract workspace and seed the detected
 * sprites directly from the atlas frame rects, so the frames are ready to
 * use without re-running detection.
 */
async function sendAtlasFramesToExtract(
  dataURL: string,
  rects: DetectedSprite[]
) {
  await loadFromURL(dataURL, { autoDetect: false });

  detected = rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
  selected = new Set(detected.map((_, i) => i));
  detectedBg = null;
  detectedTolerance = 0; // frames carry their own transparency; no keying
  spriteSplitChoices.clear();
  clearJoinGroups();
  hideSplitMenu();

  // Atlas frames are pre-cut with transparency — mirror the transparent-image
  // detection state (BG keying disabled).
  const bgInput = $("bgColorInput") as HTMLInputElement;
  const bgPickBtn = $("bgColorPickBtn") as HTMLButtonElement;
  const bgStatus = $("bgStatus") as HTMLSpanElement;
  bgInput.value = "#cccccc";
  bgInput.disabled = true;
  bgPickBtn.disabled = true;
  bgStatus.style.display = "inline";

  drawOverlay();
  renderSelectedThumbs();
  onSelectionChanged();
}

async function loadFromFile(file: File) {
  const url = URL.createObjectURL(file);
  try {
    await loadFromURL(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function runDetect(explicitBg?: RGB | null) {
  // AUTO DETECT replaces the working set — leave grid mode first (restoring
  // any stash, which the detection results below then overwrite).
  if (gridActive) setGridActive(false);

  const res = smartDetectSprites(
    originalCtx,
    originalCanvas.width,
    originalCanvas.height,
    explicitBg
  );

  detected = res.sprites;
  detectedBg = res.bgColor;
  detectedTolerance = res.tolerance;

  // Start with no selection; user taps to select/deselect.
  selected = new Set();
  spriteSplitChoices.clear();
  clearJoinGroups();
  hideSplitMenu();

  const bgInput = $("bgColorInput") as HTMLInputElement;
  const bgPickBtn = $("bgColorPickBtn") as HTMLButtonElement;
  const bgStatus = $("bgStatus") as HTMLSpanElement;

  if (res.bgColor) {
    // Opaque image with a detected background color.
    bgInput.value = rgbToHex(res.bgColor);
    bgInput.disabled = false;
    bgPickBtn.disabled = false;
    bgStatus.style.display = "none";
  } else {
    // Image has transparency, detection will be based on alpha.
    bgInput.value = "#cccccc"; // Use a neutral gray for the disabled state.
    bgInput.disabled = true;
    bgPickBtn.disabled = true;
    bgStatus.style.display = "inline";
  }

  drawOverlay();
  renderSelectedThumbs();
  onSelectionChanged();
}

async function extractFramesFromAtlas(
  atlasImg: HTMLImageElement,
  atlasJson: any
): Promise<{ frames: string[]; names: string[]; rects: DetectedSprite[] }> {
  const frames: string[] = [];
  const names: string[] = [];
  const rects: DetectedSprite[] = [];
  const frameData = atlasJson.frames || atlasJson.textures?.[0]?.frames || {};

  for (const key in frameData) {
    const frame = frameData[key]?.frame;
    if (!frame || typeof frame.w !== "number" || typeof frame.h !== "number") {
      continue;
    }
    const c = document.createElement("canvas");
    c.width = frame.w;
    c.height = frame.h;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(atlasImg, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
    frames.push(c.toDataURL("image/png"));
    names.push(frameData[key]?.filename || key);
    rects.push({ x: frame.x, y: frame.y, w: frame.w, h: frame.h });
  }

  return { frames, names, rects };
}

async function saveSelectedSpritesToFirebase() {
  if (!selected.size) {
    alert("No sprites selected.");
    return;
  }

  const nameInput = $("spriteNamePrefix") as HTMLInputElement;
  const baseName = (nameInput?.value || "sprite").trim();

  const boxes = getSelectedBoxesExpanded();
  const map = extractSpriteDataURLs(originalCanvas, boxes, {
    bgColor: detectedBg,
    tolerance: detectedTolerance,
  });

  await saveSpritesBatchToRTDB(map, {
    baseName,
    stripPrefix: true, // store raw base64 (no data: prefix)
  });

  alert(`Saved ${selected.size} sprites to Firebase (sprites/*).`);
}

function getBuilderMode(): BuilderMode {
  const select = $("builderTypeSelect") as HTMLSelectElement | null;
  const val = (select?.value || "atlas").toLowerCase();
  return val === "font" ? "font" : "atlas";
}

function getFontConfigText(name: string, json: any): string {
  const frame = Object.values(json?.frames || {})[0] as any;
  const width = frame?.frame?.w || 16;
  const height = frame?.frame?.h || 16;
  const imageName = (name || "font_sheet").trim();

  return `{
  image: "${imageName}",
  height: ${height},
  width: ${width},

  chars: Phaser.GameObjects.RetroFont.TEXT_SET3
}`;
}

function applyBuilderModeUI(mode: BuilderMode) {
  const spriteSaveSubtitle = $("spriteSaveSubtitle");
  const builderSubtitle = $("builderSubtitle");
  const spritePrefixInput = $("spriteNamePrefix") as HTMLInputElement | null;
  const atlasNameInput = $("atlasNameInput") as HTMLInputElement | null;
  const buildBtn = $("buildAtlasBtn") as HTMLButtonElement | null;
  const saveBtn = $("saveAtlasFirebaseBtn") as HTMLButtonElement | null;
  const downloadJsonBtn = $("downloadAtlasJsonBtn") as HTMLButtonElement | null;

  if (mode === "font") {
    if (spriteSaveSubtitle) spriteSaveSubtitle.textContent = "Save Glyphs to Firebase";
    if (builderSubtitle) builderSubtitle.textContent = "Font Builder";
    if (spritePrefixInput) spritePrefixInput.placeholder = "Glyph name prefix (e.g., gold_font)";
    if (atlasNameInput) atlasNameInput.placeholder = "Font sheet name (e.g., gold_font)";
    if (buildBtn) buildBtn.textContent = "Build Font Sheet";
    if (saveBtn) saveBtn.textContent = "Save Font Sheet (RTDB)";
    if (downloadJsonBtn) downloadJsonBtn.textContent = "Download Font Config";
  } else {
    if (spriteSaveSubtitle) spriteSaveSubtitle.textContent = "Save Sprites to Firebase";
    if (builderSubtitle) builderSubtitle.textContent = "Atlas Builder";
    if (spritePrefixInput) spritePrefixInput.placeholder = "Sprite name prefix (e.g., enemy)";
    if (atlasNameInput) atlasNameInput.placeholder = "Atlas name (e.g., enemy_atlas)";
    if (buildBtn) buildBtn.textContent = "Build Atlas";
    if (saveBtn) saveBtn.textContent = "Save to Cloud";
    if (downloadJsonBtn) downloadJsonBtn.textContent = "Download JSON";
  }
}

async function buildAtlasAndPreview() {
  if (!selected.size) {
    alert("No sprites selected.");
    return;
  }

  const boxes = getSelectedBoxesExpanded();
  const map = extractSpriteDataURLs(originalCanvas, boxes, {
    bgColor: detectedBg,
    tolerance: detectedTolerance,
  });

  const named: Record<string, string> = {};
  if (atlasOrderDirty && atlasFrames.length === Object.keys(map).length) {
    atlasFrames.forEach((frameData, i) => {
      named[`atlas_s${i}`] = frameData;
    });
  } else {
    let idx = 0;
    for (const k of Object.keys(map)) {
      named[`atlas_s${idx++}`] = map[k];
    }
    atlasOrderDirty = false;
  }

  const mode = getBuilderMode();
  const { dataURL, json } = await buildAtlas(named);

  const img = $("atlasPreviewImg") as HTMLImageElement;
  img.src = dataURL;

  (img as any)._atlasJson = json;
  (img as any)._atlasDataURL = dataURL;
  (img as any)._atlasOutputJson = mode === "font"
    ? getFontConfigText(($("atlasNameInput") as HTMLInputElement)?.value || "font_sheet", json)
    : json;

  $("saveAtlasFirebaseBtn")!.removeAttribute("disabled");
  $("downloadAtlasJsonBtn")!.removeAttribute("disabled");
  $("downloadAtlasPngBtn")!.removeAttribute("disabled");
  $("downloadAtlasTmxBtn")?.removeAttribute("disabled");
  $("downloadAtlasAllBtn")?.removeAttribute("disabled");

  // --- New logic for atlas frame preview ---
  stopAtlasPreview();
  atlasSelectedFrameIndices.clear();
  atlasLastClickedFrameIndex = null;

  await new Promise<void>(resolve => {
    const atlasImg = new Image();
    atlasImg.onload = async () => {
      const result = await extractFramesFromAtlas(atlasImg, json);
      atlasFrames = result.frames;
      atlasFrameNames = result.names;
      atlasFrameRects = result.rects;
      atlasStateGen++;
      atlasOrderDirty = false;
      renderAtlasFrames();
      resolve();
    };
    atlasImg.onerror = () => {
      console.error("Failed to load atlas image for preview");
      resolve();
    }
    atlasImg.src = dataURL;
  });
}

function remapSelectedFrameIndicesAfterMove(
  selectedIndices: Set<number>,
  length: number,
  from: number,
  to: number
): Set<number> {
  if (
    from < 0 ||
    to < 0 ||
    from >= length ||
    to >= length ||
    from === to
  ) {
    return new Set(selectedIndices);
  }

  const order = Array.from({ length }, (_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);

  const oldToNew = new Map<number, number>();
  order.forEach((oldIndex, newIndex) => {
    oldToNew.set(oldIndex, newIndex);
  });

  const nextSelected = new Set<number>();
  selectedIndices.forEach((oldIndex) => {
    const mapped = oldToNew.get(oldIndex);
    if (typeof mapped === "number") nextSelected.add(mapped);
  });

  return nextSelected;
}

function toggleAtlasReorder() {
  atlasReorderEnabled = !atlasReorderEnabled;
  const btn = $("reorderAtlasFramesBtn") as HTMLButtonElement | null;
  if (btn) {
    btn.classList.toggle("active", atlasReorderEnabled);
    btn.setAttribute("aria-pressed", String(atlasReorderEnabled));
    btn.textContent = atlasReorderEnabled ? "✓ Reorder" : "↕ Reorder";
  }
  renderAtlasFrames();
}

function scheduleAtlasOrderSync() {
  if (atlasSyncPromise) return atlasSyncPromise;

  atlasSyncPromise = (async () => {
    if (!atlasOrderDirty || !atlasFrames.length) {
      atlasOrderDirty = false;
      return;
    }

    const gen = atlasStateGen;

    // Key the rebuild map by ENCODED names: k_-prefixed keys are never
    // integer-like, so plain-object insertion order (= animation order)
    // survives frames whose real names are digits. Dedup on decoded names,
    // skipping suffixes that would collide with another frame's real name.
    const decodedNames = atlasFrames.map((_, i) =>
      decodeAtlasFrameKey(atlasFrameNames[i] || `atlas_s${i}`)
    );
    const allNames = new Set(decodedNames);
    const usedNames = new Set<string>();
    const named: Record<string, string> = {};
    atlasFrames.forEach((frameData, i) => {
      const base = decodedNames[i];
      let name = base;
      for (let n = 2; usedNames.has(name) || (name !== base && allNames.has(name)); n++) {
        name = `${base}_${n}`;
      }
      usedNames.add(name);
      named[encodeAtlasFrameKey(name)] = frameData;
    });

    const { dataURL, json } = await buildAtlas(named);
    // A duplicate/reorder/load landed while the sheet was rebuilding; discard
    // this stale rebuild and leave the dirty flag for the next round.
    if (gen !== atlasStateGen) return;

    const img = $("atlasPreviewImg") as HTMLImageElement;
    const mode = getBuilderMode();

    img.src = dataURL;
    (img as any)._atlasJson = json;
    (img as any)._atlasDataURL = dataURL;
    (img as any)._atlasOutputJson = mode === "font"
      ? getFontConfigText(($("atlasNameInput") as HTMLInputElement)?.value || "font_sheet", json)
      : json;

    // Re-slice frames from the rebuilt sheet: duplication changes the frame
    // count, so the old rects no longer line up with the new packing.
    await new Promise<void>((resolve) => {
      const atlasImg = new Image();
      atlasImg.onload = async () => {
        const result = await extractFramesFromAtlas(atlasImg, json);
        if (gen !== atlasStateGen) {
          resolve();
          return;
        }
        atlasFrames = result.frames;
        atlasFrameNames = result.names;
        atlasFrameRects = result.rects;
        atlasSelectedFrameIndices = new Set(
          [...atlasSelectedFrameIndices].filter((idx) => idx < atlasFrames.length)
        );
        renderAtlasFrames();
        resolve();
      };
      atlasImg.onerror = () => {
        console.error("Failed to reload rebuilt atlas for frame rects");
        resolve();
      };
      atlasImg.src = dataURL;
    });

    if (gen !== atlasStateGen) return;
    atlasOrderDirty = false;
  })().finally(() => {
    atlasSyncPromise = null;
  });

  return atlasSyncPromise;
}

/** Settle the frame order fully: a mutation that lands mid-sync leaves the
 *  dirty flag set, so keep running rounds until the state is clean. */
async function ensureAtlasOrderSynced() {
  while (atlasSyncPromise || atlasOrderDirty) {
    if (atlasSyncPromise) await atlasSyncPromise;
    else await scheduleAtlasOrderSync();
  }
}

function renderAtlasFrames() {
  const cont = $("atlasFramesContainer") as HTMLDivElement;
  cont.innerHTML = "";

  if (!atlasFrames.length) {
    cont.textContent = "No frames found in atlas.";
    updateSelectAllFramesBtn();
    return;
  }

  atlasFrames.forEach((frameDataURL, index) => {
    const rawName = atlasFrameNames[index] || `frame_${index}`;
    const frameName = decodeAtlasFrameKey(rawName);

    const wrapper = document.createElement("div");
    wrapper.className = "atlas-frame-wrapper";
    wrapper.title = frameName;
    wrapper.dataset.frameIndex = String(index);
    wrapper.draggable = atlasReorderEnabled;
    wrapper.style.cursor = atlasReorderEnabled ? "grab" : "pointer";

    const img = document.createElement("img");
    img.src = frameDataURL;
    img.style.width = "64px";
    img.style.height = "auto";

    if (atlasSelectedFrameIndices.has(index)) {
      wrapper.classList.add("selected");
    }

    const label = document.createElement("span");
    label.className = "atlas-frame-label";
    label.textContent = frameName;

    // Prevent the browser from highlighting label text when shift-clicking
    // to extend a selection.
    wrapper.style.userSelect = "none";

    wrapper.appendChild(img);
    wrapper.appendChild(label);

    wrapper.addEventListener("click", (ev) => {
      if (
        ev.shiftKey &&
        atlasLastClickedFrameIndex !== null &&
        atlasLastClickedFrameIndex < atlasFrames.length
      ) {
        // Shift-click: select every frame between the anchor (last frame
        // clicked without shift) and the one just clicked, inclusive.
        const start = Math.min(atlasLastClickedFrameIndex, index);
        const end = Math.max(atlasLastClickedFrameIndex, index);
        for (let i = start; i <= end; i++) {
          atlasSelectedFrameIndices.add(i);
        }
        // Reflect the whole range in the DOM; only this wrapper is in scope.
        cont.querySelectorAll<HTMLElement>(".atlas-frame-wrapper").forEach((el) => {
          const idx = Number(el.dataset.frameIndex);
          if (atlasSelectedFrameIndices.has(idx)) el.classList.add("selected");
        });
      } else {
        // Plain click: toggle this frame and make it the new anchor.
        if (atlasSelectedFrameIndices.has(index)) {
          atlasSelectedFrameIndices.delete(index);
          wrapper.classList.remove("selected");
        } else {
          atlasSelectedFrameIndices.add(index);
          wrapper.classList.add("selected");
        }
        atlasLastClickedFrameIndex = index;
      }
      refreshAtlasPreviewFrames(false);
      updateSelectAllFramesBtn();
    });

    if (atlasReorderEnabled) {
      wrapper.addEventListener("dragstart", (ev) => {
        wrapper.style.opacity = "0.45";
        ev.dataTransfer?.setData("text/plain", String(index));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      });

      wrapper.addEventListener("dragend", () => {
        wrapper.style.opacity = "1";
      });

      wrapper.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      });

      wrapper.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const from = Number(ev.dataTransfer?.getData("text/plain"));
        const to = index;

        if (!Number.isFinite(from) || from === to) return;
        if (from < 0 || from >= atlasFrames.length || to < 0 || to >= atlasFrames.length) return;

        const moved = atlasFrames.splice(from, 1)[0];
        atlasFrames.splice(to, 0, moved);
        const movedName = atlasFrameNames.splice(from, 1)[0];
        atlasFrameNames.splice(to, 0, movedName);
        const movedRect = atlasFrameRects.splice(from, 1)[0];
        atlasFrameRects.splice(to, 0, movedRect);
        atlasSelectedFrameIndices = remapSelectedFrameIndicesAfterMove(
          atlasSelectedFrameIndices,
          atlasFrames.length,
          from,
          to
        );
        // Reordering remaps indices, so the shift-click anchor is no longer valid.
        atlasLastClickedFrameIndex = null;
        atlasStateGen++;
        atlasOrderDirty = true;

        renderAtlasFrames();
        refreshAtlasPreviewFrames(false);
      });
    }

    cont.appendChild(wrapper);
  });

  updateSelectAllFramesBtn();
}

function updateSelectAllFramesBtn() {
  const btn = $("selectAllFramesBtn") as HTMLButtonElement | null;
  if (!btn) return;
  const total = atlasFrames.length;
  btn.disabled = total === 0;
  const allSelected = total > 0 && atlasSelectedFrameIndices.size === total;
  btn.textContent = allSelected ? "SELECT NONE" : "SELECT ALL";
  btn.setAttribute("aria-pressed", String(allSelected));

  const dupBtn = $("duplicateFramesBtn") as HTMLButtonElement | null;
  if (dupBtn) dupBtn.disabled = atlasSelectedFrameIndices.size === 0;
}

function duplicateSelectedAtlasFrames() {
  if (!atlasFrames.length || !atlasSelectedFrameIndices.size) {
    setStatusLine("SELECT FRAME(S) TO DUPLICATE");
    return;
  }

  const takenNames = new Set(atlasFrameNames.map((n) => decodeAtlasFrameKey(n)));
  const nextFrames: string[] = [];
  const nextNames: string[] = [];
  const nextRects: DetectedSprite[] = [];
  const nextSelected = new Set<number>();

  atlasFrames.forEach((frameData, i) => {
    nextFrames.push(frameData);
    nextNames.push(atlasFrameNames[i]);
    nextRects.push(atlasFrameRects[i]);
    if (!atlasSelectedFrameIndices.has(i)) return;

    // Keep the source selected and insert its copy right after, so the pair
    // plays back-to-back in the animation preview / GIF.
    nextSelected.add(nextFrames.length - 1);

    const base = decodeAtlasFrameKey(atlasFrameNames[i] || `frame_${i}`);
    let copyName = `${base}_copy`;
    for (let n = 2; takenNames.has(copyName); n++) copyName = `${base}_copy${n}`;
    takenNames.add(copyName);

    nextFrames.push(frameData);
    nextNames.push(copyName);
    // Copies show the same pixels of the current sheet until the next rebuild.
    nextRects.push(atlasFrameRects[i] ? { ...atlasFrameRects[i] } : atlasFrameRects[i]);
    nextSelected.add(nextFrames.length - 1);
  });

  atlasFrames = nextFrames;
  atlasFrameNames = nextNames;
  atlasFrameRects = nextRects;
  atlasSelectedFrameIndices = nextSelected;
  // Duplication remaps indices, so the shift-click anchor is no longer valid.
  atlasLastClickedFrameIndex = null;
  atlasStateGen++;
  atlasOrderDirty = true;

  renderAtlasFrames();
  refreshAtlasPreviewFrames(false);
}

function toggleSelectAllFrames() {
  if (!atlasFrames.length) return;
  const allSelected = atlasSelectedFrameIndices.size === atlasFrames.length;
  if (allSelected) {
    atlasSelectedFrameIndices.clear();
  } else {
    atlasSelectedFrameIndices = new Set(atlasFrames.map((_, i) => i));
  }
  renderAtlasFrames();
  refreshAtlasPreviewFrames(false);
}

async function saveAtlasToFirebase() {
  const nameInput = $("atlasNameInput") as HTMLInputElement;
  const atlasName = (nameInput?.value || "untitled_atlas").trim();

  await ensureAtlasOrderSynced();

  const img = $("atlasPreviewImg") as HTMLImageElement;
  const json = (img as any)._atlasJson;
  const outputJson = (img as any)._atlasOutputJson ?? json;
  const dataURL = (img as any)._atlasDataURL;

  if (!json || !dataURL) {
    alert("Build an atlas first.");
    return;
  }

  await saveAtlas(atlasName, { json: outputJson, png: dataURL });
  alert(`Atlas "${atlasName}" saved to RTDB (atlases/${atlasName}).`);
  await populateAtlasSelect(); // Refresh atlas list
}

function stopAtlasPreview() {
  if (atlasAnimTimer) {
    window.clearInterval(atlasAnimTimer);
    atlasAnimTimer = null;
  }
  atlasAnimPlaying = false;
  const btn = $("atlasPreviewBtn") as HTMLButtonElement | null;
  if (btn) btn.textContent = "Preview Atlas Anim";
}

async function startAtlasPreview() {
  const fpsInput = $("atlasFpsInput") as HTMLInputElement | null;
  const fps = Math.max(1, Math.min(60, Number(fpsInput?.value || 6)));
  const dur = Math.round(1000 / fps);

  const scale = Number(($("gifScaleInput") as HTMLSelectElement)?.value || 1);

  const selectedFrames = [...atlasSelectedFrameIndices]
    .sort((a, b) => a - b)
    .map((i) => atlasFrames[i]);

  atlasAnimFrameIndex = 0;

  const container = $("atlasAnimPreviewContainer") as HTMLElement;
  await setContainerSize(container, selectedFrames, scale);


  const img = $("atlasAnimPreviewImg") as HTMLImageElement | null;
  if (!selectedFrames.length || !img) {
    stopAtlasPreview();
    return;
  }

  img.style.transform = `scale(${scale})`;
  img.style.transformOrigin = "top left";

  // --- GIF generation ---
  generateAtlasGif(selectedFrames, fps);
  // --- End GIF generation ---

  img.src = selectedFrames[0];
  if (atlasAnimTimer) window.clearInterval(atlasAnimTimer);
  atlasAnimTimer = window.setInterval(() => {
    atlasAnimFrameIndex = (atlasAnimFrameIndex + 1) % selectedFrames.length;
    img.src = selectedFrames[atlasAnimFrameIndex];
  }, dur);

  atlasAnimPlaying = true;
  const btn = $("atlasPreviewBtn") as HTMLButtonElement | null;
  if (btn) btn.textContent = "Stop Preview";
}

async function generateAtlasGif(frames: string[], fps: number) {
  if (!frames.length) return;

  const img = $("atlasAnimPreviewImg") as any;
  if (img) img._gifBlob = null;

  const scale = Number(($("gifScaleInput") as HTMLSelectElement)?.value || 1);

  // 1. Load all frame images and find max dimensions
  const frameImages = await Promise.all(
    frames.map(frameSrc => new Promise<HTMLImageElement>(resolve => {
      const frameImg = new Image();
      frameImg.onload = () => resolve(frameImg);
      frameImg.onerror = () => {
        // Resolve with an empty image on error to avoid breaking Promise.all
        // It will have width/height of 0 and won't affect max size.
        resolve(new Image());
      };
      frameImg.src = frameSrc;
    }))
  );

  let maxWidth = 0;
  let maxHeight = 0;
  for (const frameImg of frameImages) {
    if (frameImg.width > maxWidth) maxWidth = frameImg.width;
    if (frameImg.height > maxHeight) maxHeight = frameImg.height;
  }

  const gifWidth = maxWidth * scale;
  const gifHeight = maxHeight * scale;

  if (gifWidth === 0 || gifHeight === 0) {
    console.error("Could not generate GIF, max dimensions are zero.");
    return;
  }

  const gif = new GIF({
    workers: 2,
    quality: 10,
    width: gifWidth,
    height: gifHeight,
    workerScript: 'gif.worker.js',
    transparent: 0xFF00FF, // Magic pink
  });

  // 2. Process each frame on a consistently-sized canvas
  for (const frameImg of frameImages) {
    if (frameImg.width === 0 || frameImg.height === 0) continue; // Skip failed images

    // Step 1: Create a temporary canvas of the original size to apply transparency
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = frameImg.width;
    tempCanvas.height = frameImg.height;
    const tempCtx = tempCanvas.getContext("2d")!;
    tempCtx.drawImage(frameImg, 0, 0);

    // Step 2: Apply transparency logic (replace semi-transparent with magic pink)
    try {
      const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) { // alpha channel
          data[i] = 255;     // r
          data[i + 1] = 0;       // g
          data[i + 2] = 255;     // b
          data[i + 3] = 255;     // a
        }
      }
      tempCtx.putImageData(imageData, 0, 0);
    } catch (e) {
      console.warn("Could not process image data for GIF, likely a CORS issue with an external image.", e);
      // Continue with the original image if processing fails
    }

    // Step 3: Create the final, max-sized canvas for this frame
    const finalFrameCanvas = document.createElement("canvas");
    finalFrameCanvas.width = gifWidth;
    finalFrameCanvas.height = gifHeight;
    const finalFrameCtx = finalFrameCanvas.getContext("2d")!;
    finalFrameCtx.imageSmoothingEnabled = false;

    // Fill with magic pink for transparency
    finalFrameCtx.fillStyle = '#FF00FF';
    finalFrameCtx.fillRect(0, 0, gifWidth, gifHeight);

    // Step 4: Draw the processed temp canvas onto the final canvas (centered)
    const scaledWidth = frameImg.width * scale;
    const scaledHeight = frameImg.height * scale;
    const x = (gifWidth - scaledWidth) / 2;
    const y = (gifHeight - scaledHeight) / 2;
    finalFrameCtx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, x, y, scaledWidth, scaledHeight);

    // Step 5: Add the final, consistently-sized frame to the GIF
    gif.addFrame(finalFrameCanvas, { delay: 1000 / fps });
  }

  gif.on('finished', (blob: Blob) => {
    if (img) img._gifBlob = blob;
  });

  gif.render();
}

function refreshAtlasPreviewFrames(keepPlaying = true) {
  const img = $("atlasAnimPreviewImg") as HTMLImageElement | null;
  const selectedFrames = [...atlasSelectedFrameIndices].sort((a,b) => a-b).map(i => atlasFrames[i]);
  atlasAnimFrameIndex = 0;
  if (img) img.src = selectedFrames[0] || "";

  if (atlasAnimPlaying && keepPlaying) {
    startAtlasPreview();
  } else if (!keepPlaying) {
    stopAtlasPreview();
  }
}

async function populateCharacterSelect() {
  const select = $("characterSelect") as HTMLSelectElement;
  if (!select) return;

  // Placeholder while loading
  select.innerHTML = "";
  const loadingOpt = document.createElement("option");
  loadingOpt.value = "";
  loadingOpt.textContent = "Loading characters...";
  select.appendChild(loadingOpt);
  select.disabled = true;

  try {
    const chars = await fetchAllCharacters();
    select.innerHTML = "";

    // Default placeholder
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- Select a character --";
    select.appendChild(placeholder);

    // Populate list (use character name if present, else key)
    Object.entries(chars).forEach(([id, data]) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = data?.name || id;
      select.appendChild(opt);
    });

    select.disabled = false;
  } catch (err) {
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Failed to load characters";
    select.appendChild(opt);
    select.disabled = true;
    console.error(err);
  }
}

async function populateAtlasSelect() {
    const select = $("atlasSelect") as HTMLSelectElement;
    if (!select) return;

    select.innerHTML = "";
    const loadingOpt = document.createElement("option");
    loadingOpt.value = "";
    loadingOpt.textContent = "Loading atlases...";
    select.appendChild(loadingOpt);
    select.disabled = true;

    try {
        const atlases = await fetchAllAtlases();
        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "-- Select an atlas --";
        select.appendChild(placeholder);

        Object.keys(atlases).forEach(id => {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = id;
            select.appendChild(opt);
        });

        select.disabled = false;

        // Keep the PACKER tab's atlas dropdowns in sync with the same fetch.
        setPackerAtlasNames(Object.keys(atlases));
    } catch (err) {
        select.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "Failed to load atlases";
        select.appendChild(opt);
        select.disabled = true;
        console.error(err);
    }
}

async function loadAtlasAndPreview() {
    const select = $("atlasSelect") as HTMLSelectElement;
    const id = select?.value || "";
    if (!id) {
        // Silently return if no atlas is selected. This can happen when the
        // list is populated or the user selects the placeholder.
        return;
    }

    const atlasData = await fetchAtlas(id);
    if (!atlasData) {
        alert("Failed to load atlas data.");
        return;
    }

    const { png: dataURL, json } = atlasData;
    await applyAtlasPreview(dataURL, json, { selectAllFrames: true, startPreviewNow: true });
}

async function applyAtlasPreview(
  rawDataURL: string,
  rawJson: any,
  options?: { selectAllFrames?: boolean; startPreviewNow?: boolean; outputJson?: any }
) {
  // Atlases built elsewhere (older builds, imported sheets) can carry empty
  // padding on the right; trim it so what is previewed and saved is tight.
  const { dataURL, json } = await trimAtlasToContent(rawDataURL, rawJson);

  const img = $("atlasPreviewImg") as HTMLImageElement;
  img.src = dataURL;

  (img as any)._atlasJson = json;
  (img as any)._atlasDataURL = dataURL;
  (img as any)._atlasOutputJson = options?.outputJson ?? json;

  $("saveAtlasFirebaseBtn")!.removeAttribute("disabled");
  $("downloadAtlasJsonBtn")!.removeAttribute("disabled");
  $("downloadAtlasPngBtn")!.removeAttribute("disabled");
  $("downloadAtlasTmxBtn")?.removeAttribute("disabled");
  $("downloadAtlasAllBtn")?.removeAttribute("disabled");

  stopAtlasPreview();
  atlasSelectedFrameIndices.clear();
  atlasLastClickedFrameIndex = null;

  await new Promise<void>((resolve) => {
    const atlasImg = new Image();
    atlasImg.onload = async () => {
      const result = await extractFramesFromAtlas(atlasImg, json);
      atlasFrames = result.frames;
      atlasFrameNames = result.names;
      atlasFrameRects = result.rects;
      atlasStateGen++;
      atlasOrderDirty = false;
      if (options?.selectAllFrames) {
        atlasSelectedFrameIndices = new Set(atlasFrames.map((_, i) => i));
      }
      renderAtlasFrames();
      if (options?.startPreviewNow) {
        startAtlasPreview();
      }
      resolve();
    };
    atlasImg.onerror = () => {
      console.error("Failed to load atlas image for preview");
      resolve();
    };
    atlasImg.src = dataURL;
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsText(file);
  });
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function setAtlasImportStatus(message: string) {
  const status = $("atlasImportStatus") as HTMLDivElement | null;
  if (status) status.textContent = message;
}

function refreshImportAtlasStatus() {
  const jsonLabel = importAtlasJsonFile ? `JSON: ${importAtlasJsonFile.name}` : "JSON: missing";
  const pngLabel = importAtlasPngFile ? `PNG: ${importAtlasPngFile.name}` : "PNG: missing";
  setAtlasImportStatus(`${jsonLabel} | ${pngLabel}`);
}

function clearImportAtlasState() {
  importAtlasJsonFile = null;
  importAtlasPngFile = null;
  const jsonInput = $("importAtlasJsonInput") as HTMLInputElement | null;
  const pngInput = $("importAtlasPngInput") as HTMLInputElement | null;
  if (jsonInput) jsonInput.value = "";
  if (pngInput) pngInput.value = "";
  setAtlasImportStatus("Select both files to import.");
}

function setImportAtlasFile(file: File) {
  const fileName = file.name.toLowerCase();
  const isJson = file.type === "application/json" || fileName.endsWith(".json");
  const isPng = file.type === "image/png" || fileName.endsWith(".png");

  if (isJson) {
    importAtlasJsonFile = file;
  } else if (isPng) {
    importAtlasPngFile = file;
  }
}

function openImportAtlasModal() {
  const modal = $("importAtlasModal") as HTMLDivElement | null;
  modal?.classList.add("open");
  refreshImportAtlasStatus();
}

function closeImportAtlasModal(reset = false) {
  const modal = $("importAtlasModal") as HTMLDivElement | null;
  modal?.classList.remove("open");
  if (reset) clearImportAtlasState();
}

async function importAtlasFromSelectedFiles() {
  if (!importAtlasJsonFile || !importAtlasPngFile) {
    alert("Select both atlas JSON and PNG files.");
    return;
  }

  try {
    const [jsonText, dataURL] = await Promise.all([
      readFileAsText(importAtlasJsonFile),
      readFileAsDataURL(importAtlasPngFile),
    ]);
    const json = JSON.parse(jsonText);

    // Tiled tilemap JSON (layers/tilesets, no frames object) — import it as
    // a map record next to the atlases instead of rejecting it
    if (isTiledMapJson(json)) {
      await importTilemapFromSelectedFiles(json, dataURL);
      return;
    }

    const hasFrames = json?.frames && typeof json.frames === "object";
    const hasTextures = Array.isArray(json?.textures) && json.textures[0]?.frames && typeof json.textures[0].frames === "object";
    if (!hasFrames && !hasTextures) {
      alert("Invalid atlas JSON. Missing frames object (and not a Tiled map).");
      return;
    }

    const atlasNameInput = $("atlasNameInput") as HTMLInputElement | null;
    if (atlasNameInput && !atlasNameInput.value.trim()) {
      atlasNameInput.value = importAtlasJsonFile.name.replace(/\.json$/i, "");
    }

    await applyAtlasPreview(dataURL, json, { selectAllFrames: true, startPreviewNow: false });
    closeImportAtlasModal(true);

    // Task 2: IMPORT lives in the Extract tab — surface the imported frames
    // right there as ready-to-use selected sprites (no switch to View needed).
    const rects = atlasFrameRects.filter(Boolean);
    if (rects.length) {
      const previewImg = $("atlasPreviewImg") as HTMLImageElement;
      const atlasURL = (previewImg as any)._atlasDataURL || dataURL;
      await sendAtlasFramesToExtract(atlasURL, rects);
    }
  } catch (err: any) {
    console.error(err);
    alert(`Failed to import atlas: ${err?.message || "Unknown error"}`);
  }
}

function isTiledMapJson(json: any): boolean {
  return (
    json?.type === "map" ||
    (Array.isArray(json?.layers) && Array.isArray(json?.tilesets))
  );
}

/**
 * Import a Tiled map + tileset PNG picked in the atlas-import modal.
 * Stored at maps/<key> = { json, png } in the RTDB, alongside the atlases —
 * mario-sp (and friends) load these at runtime and the in-game level editor
 * writes its saves to the same records.
 */
/** Group layers nest their children, so a compressed tile layer can sit any
 *  depth down. Mirrors the recursive walk the TILEMAP tab loader does. */
function findCompressedLayer(layers: any): any {
  if (!Array.isArray(layers)) return null;
  for (const l of layers) {
    if (l?.compression) return l;
    const nested = findCompressedLayer(l?.layers);
    if (nested) return nested;
  }
  return null;
}

async function importTilemapFromSelectedFiles(json: any, dataURL: string) {
  // only embedded-tileset, uncompressed maps are playable by the games
  const tilesets: any[] = Array.isArray(json.tilesets) ? json.tilesets : [];
  if (tilesets.some((t: any) => t.source)) {
    alert(
      "This Tiled map references an external tileset (.tsx). " +
        "In Tiled use Map > Embed Tilesets, re-export, and import again."
    );
    return;
  }
  // The record carries exactly one PNG, so GIDs from a second tileset image
  // would have nothing to render against.
  const tilesetImages = new Set(
    tilesets.map((t: any) => t.image).filter((img: any) => typeof img === "string")
  );
  if (tilesetImages.size > 1) {
    alert(
      `This map uses ${tilesetImages.size} tileset images ` +
        `(${[...tilesetImages].join(", ")}), but a map record stores only one. ` +
        "In Tiled merge them into a single tileset and re-export."
    );
    return;
  }
  const compressed = findCompressedLayer(json.layers);
  if (compressed) {
    alert(
      `Layer "${compressed.name || "?"}" uses compressed tile data ` +
        `(${compressed.compression}). Re-export with ` +
        "Tile Layer Format = CSV or Base64 (uncompressed)."
    );
    return;
  }

  const suggested = sanitizeMapKey(
    importAtlasJsonFile!.name.replace(/\.json$/i, "")
  );
  const entered = window.prompt("Import Tiled map to RTDB as maps/<name>:", suggested);
  if (entered === null) return; // cancelled
  // Both sides can sanitize to nothing (a file literally named ".json", a name
  // of only forbidden chars) — never let that reach saveMap as `maps/`.
  const key = sanitizeMapKey(entered) || suggested;
  if (!key) {
    alert("Enter a name for the map.");
    return;
  }

  const layerCount = Array.isArray(json.layers) ? json.layers.length : 0;
  await saveMap(key, { json, png: dataURL });
  alert(
    `Tiled map "${key}" saved to RTDB (maps/${key}) — ` +
      `${json.width}x${json.height} tiles, ${layerCount} layer(s).`
  );
  closeImportAtlasModal(true);
}

async function loadCharacterAndPreview() {
  const select = $("characterSelect") as HTMLSelectElement;
  const id = select?.value || "";
  if (!id) {
    alert("Select a character.");
    return;
  }

  // Atlas-based preview: fetch character, then its atlas, and slice frames by keys.
  const res = await loadCharacterPreviewFromAtlas(id);
  if (!res || !res.frames.length) {
    alert("No frames found for character or its atlas.");
    lastCharPreview = null;
    return;
  }

  await setContainerSize(
    $("characterPreviewContainer") as HTMLElement,
    res.frames
  );

  lastCharPreview = res; // Save for PNG download
  const fps = res.frameRate || 6;
  const dur = Math.max(1, Math.round(1000 / fps));

  const img = $("characterPreviewImg") as HTMLImageElement;
  const fpsSpan = $("frameRateSpan") as HTMLSpanElement;

  fpsSpan.textContent = String(fps);

  let i = 0;
  if (characterAnimTimer) window.clearInterval(characterAnimTimer);
  characterAnimTimer = window.setInterval(() => {
    img.src = res.frames[i % res.frames.length];
    i++;
  }, dur);
}

/**
 * Triggers a file download using the best available method:
 * 1. Native Android interface (if available via WebView bridge)
 * 2. Web Share API with File (for Android TWA/APK where <a download> fails)
 * 3. Standard anchor tag download (web browsers and PWA)
 * @param url The data URL of the file to download.
 * @param filename The desired name of the file.
 * @param mimeType The MIME type of the file.
 */
interface DownloadItem {
  url: string;
  filename: string;
  mimeType: string;
}

/** In Android standalone mode (TWA/APK), <a download> with data URLs fails,
 *  so the Web Share API is used to let the user save the file instead. */
function isAndroidStandalone(): boolean {
  return /Android/i.test(navigator.userAgent) &&
    (window.matchMedia("(display-mode: standalone)").matches ||
     window.matchMedia("(display-mode: fullscreen)").matches);
}

/**
 * Save one or more files. Multiple files go out in a *single* Web Share:
 * navigator.share() needs transient user activation, which the first share
 * consumes, so successive shares from one click would be rejected and fall
 * back to the anchor path that does not work here.
 */
async function triggerDownloadMany(items: DownloadItem[]) {
  if (!items.length) return;

  // Check for a native Android interface
  if ((window as any).Android?.downloadFile) {
    for (const it of items) {
      (window as any).Android.downloadFile(it.url, it.filename, it.mimeType);
    }
    return;
  }

  if (isAndroidStandalone() && navigator.canShare) {
    try {
      const files = await Promise.all(
        items.map(async (it) => {
          const blob = await (await fetch(it.url)).blob();
          return new File([blob], it.filename, { type: it.mimeType });
        })
      );
      if (navigator.canShare({ files })) {
        await navigator.share({ files });
        return;
      }
    } catch (e) {
      // User cancelled the share — don't fall through to anchor download
      if (e instanceof DOMException && e.name === "AbortError") return;
      // Other errors: fall through to standard download
      console.warn("Share failed, falling back to standard download:", e);
    }
  }

  // Fallback for standard web browsers
  for (const it of items) {
    const a = document.createElement("a");
    a.href = it.url;
    a.download = it.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

async function triggerDownload(url: string, filename: string, mimeType: string) {
  await triggerDownloadMany([{ url, filename, mimeType }]);
}

/**
 * Creates a data URL from the given content and triggers a browser download.
 * This is more reliable than blob URLs for webviews.
 * @param filename The name of the file to save.
 * @param content The string content to put in the file.
 * @param type The MIME type of the file.
 */
function downloadFile(filename: string, content: string, type: string) {
  return triggerDownload(dataUrlFor(content, type), filename, type);
}

function dataUrlFor(content: string, type: string): string {
  return `data:${type};charset=utf-8,${encodeURIComponent(content)}`;
}

/**
 * Calculates the max dimensions of a set of images and resizes a container to fit.
 * @param container The container element to resize.
 * @param sources A list of image data URLs.
 */
async function setContainerSize(
  container: HTMLElement,
  sources: string[],
  scale = 1
) {
  if (!container) return;

  // If there are no sources, reset the container to its default min-size.
  if (!sources.length) {
    container.style.width = "";
    container.style.height = "";
    return;
  }

  const imageSizes = await Promise.all(
    sources.map(
      (src) =>
        new Promise<{ width: number; height: number }>((resolve) => {
          const img = new Image();
          img.onload = () =>
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => resolve({ width: 0, height: 0 }); // Resolve with 0 on error
          img.src = src;
        })
    )
  );

  const maxWidth = Math.max(0, ...imageSizes.map((s) => s.width));
  const maxHeight = Math.max(0, ...imageSizes.map((s) => s.height));

  // Apply the calculated max dimensions to the container if valid.
  if (maxWidth > 0 && maxHeight > 0) {
    container.style.width = `${maxWidth * scale}px`;
    container.style.height = `${maxHeight * scale}px`;
  } else {
    // Reset if no valid images were found
    container.style.width = "";
    container.style.height = "";
  }
}

async function downloadCharacterJson() {
  const select = $("characterSelect") as HTMLSelectElement;
  const id = select?.value || "";
  if (!id) {
    alert("Select a character first.");
    return;
  }

  const character = await fetchCharacter(id);
  if (!character) {
    alert("Failed to fetch character data.");
    return;
  }

  const filename = `${character.name || id}.json`;
  const content = JSON.stringify(character, null, 2);
  downloadFile(filename, content, "application/json");
}

async function downloadCharacterPng() {
  const select = $("characterSelect") as HTMLSelectElement;
  const id = select?.value || "";
  if (!id || !lastCharPreview || !lastCharPreview.frames.length) {
    alert("Load a character preview first.");
    return;
  }

  const charName =
    select.options[select.selectedIndex]?.textContent || id || "character";
  const filename = `${charName}.png`;

  const frames = lastCharPreview.frames;
  const frameImages = await Promise.all(
    frames.map((src) => {
      return new Promise<HTMLImageElement>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(new Image()); // resolve with empty image on error
        img.src = src;
      });
    })
  );

  const maxWidth = frameImages.reduce((max, img) => Math.max(max, img.width), 0);
  const totalHeight = frameImages.reduce((sum, img) => sum + img.height, 0);

  if (maxWidth === 0 || totalHeight === 0) {
    alert("Could not load character frame images.");
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = maxWidth;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d")!;

  let currentY = 0;
  frameImages.forEach((img) => {
    ctx.drawImage(img, 0, currentY);
    currentY += img.height;
  });

  const dataURL = canvas.toDataURL("image/png");
  triggerDownload(dataURL, filename, "image/png");
}

function currentAtlasName(): string {
  const nameInput = $("atlasNameInput") as HTMLInputElement;
  const select = $("atlasSelect") as HTMLSelectElement;
  return (nameInput?.value.trim()) || (select?.value) || "atlas";
}

/** Null when no atlas is loaded. Callers that a user triggered directly do the
 *  alerting; the ALL export collects whatever is available. */
function atlasJsonItem(): DownloadItem | null {
  const img = $("atlasPreviewImg") as HTMLImageElement;
  const json = (img as any)._atlasJson;
  if (!json) return null;

  const outputJson = (img as any)._atlasOutputJson ?? json;
  const content =
    typeof outputJson === "string"
      ? outputJson
      : JSON.stringify(outputJson, null, 2);
  const mimeType = "application/json";

  return {
    url: dataUrlFor(content, mimeType),
    filename: `${currentAtlasName()}.json`,
    mimeType,
  };
}

function atlasPngItem(): DownloadItem | null {
  const img = $("atlasPreviewImg") as HTMLImageElement;
  const dataURL = (img as any)._atlasDataURL;
  if (!dataURL) return null;

  return {
    url: dataURL,
    filename: `${currentAtlasName()}.png`,
    mimeType: "image/png",
  };
}

async function downloadAtlasJson() {
  await ensureAtlasOrderSynced();

  const item = atlasJsonItem();
  if (!item) {
    alert("Build or load an atlas first.");
    return;
  }
  await triggerDownloadMany([item]);
}

async function downloadAtlasPng() {
  await ensureAtlasOrderSynced();

  const item = atlasPngItem();
  if (!item) {
    alert("Build or load an atlas first.");
    return;
  }
  await triggerDownloadMany([item]);
}

function getAtlasFrameRects(json: any): { x: number; y: number; w: number; h: number }[] {
  const frameData = json?.frames || json?.textures?.[0]?.frames || {};
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (const key in frameData) {
    const frame = frameData[key]?.frame;
    if (!frame || typeof frame.w !== "number" || typeof frame.h !== "number") {
      continue;
    }
    rects.push({ x: frame.x || 0, y: frame.y || 0, w: frame.w, h: frame.h });
  }
  return rects;
}

/**
 * Builds a Tiled .tmx map from the loaded atlas, mirroring exportTiledFormat()
 * from easierbycode.github.io/tileset-extractor: the atlas PNG is the tileset
 * image and a single layer lays the tiles out in grid order (gid 0 = cells not
 * covered by any frame). Requires a uniform, grid-aligned tile atlas.
 */
function buildAtlasTmx(json: any, atlasName: string, imageW: number, imageH: number): string {
  const rects = getAtlasFrameRects(json);
  if (!rects.length) throw new Error("Atlas JSON has no frames.");

  const tileWidth = rects[0].w;
  const tileHeight = rects[0].h;
  if (rects.some((r) => r.w !== tileWidth || r.h !== tileHeight)) {
    throw new Error("Atlas frames are not a uniform size — a tile map needs one tile size.");
  }
  if (!imageW || !imageH) throw new Error("Unknown atlas image size.");

  const numCols = imageW / tileWidth;
  const numRows = imageH / tileHeight;
  if (numCols !== Math.floor(numCols) || !numCols) {
    throw new Error(`Image width (${imageW}px) is not dividable by tile width (${tileWidth}px).`);
  }
  if (numRows !== Math.floor(numRows) || !numRows) {
    throw new Error(`Image height (${imageH}px) is not dividable by tile height (${tileHeight}px).`);
  }

  const coveredCells = new Set<number>();
  for (const r of rects) {
    if (r.x % tileWidth !== 0 || r.y % tileHeight !== 0) {
      throw new Error("Atlas frames are not aligned to the tile grid.");
    }
    coveredCells.add((r.y / tileHeight) * numCols + r.x / tileWidth);
  }

  const doc = document.implementation.createDocument(null, "map", null);
  const xmlMap = doc.documentElement;
  xmlMap.setAttribute("version", "1.0");
  xmlMap.setAttribute("orientation", "orthogonal");
  xmlMap.setAttribute("renderorder", "right-down");
  xmlMap.setAttribute("width", String(numCols));
  xmlMap.setAttribute("height", String(numRows));
  xmlMap.setAttribute("tilewidth", String(tileWidth));
  xmlMap.setAttribute("tileheight", String(tileHeight));
  xmlMap.setAttribute("nextobjectid", "1");

  const xmlTileSet = doc.createElement("tileset");
  xmlTileSet.setAttribute("firstgid", "1");
  xmlTileSet.setAttribute("name", atlasName);
  xmlTileSet.setAttribute("tilewidth", String(tileWidth));
  xmlTileSet.setAttribute("tileheight", String(tileHeight));
  const xmlImage = doc.createElement("image");
  xmlImage.setAttribute("source", `${atlasName}.png`);
  xmlImage.setAttribute("width", String(imageW));
  xmlImage.setAttribute("height", String(imageH));
  xmlTileSet.appendChild(xmlImage);
  xmlMap.appendChild(xmlTileSet);

  const xmlLayer = doc.createElement("layer");
  xmlLayer.setAttribute("name", "layer");
  xmlLayer.setAttribute("width", String(numCols));
  xmlLayer.setAttribute("height", String(numRows));
  const xmlData = doc.createElement("data");
  for (let i = 0, n = numCols * numRows; i < n; ++i) {
    const xmlTile = doc.createElement("tile");
    xmlTile.setAttribute("gid", String(coveredCells.has(i) ? i + 1 : 0));
    xmlData.appendChild(xmlTile);
  }
  xmlLayer.appendChild(xmlData);
  xmlMap.appendChild(xmlLayer);

  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(xmlMap);
}

/** Throws with the reason the atlas cannot become a tile map. */
function atlasTmxItem(): DownloadItem | null {
  const img = $("atlasPreviewImg") as HTMLImageElement;
  const json = (img as any)._atlasJson;
  if (!json) return null;

  const atlasName = currentAtlasName();
  // Prefer the real PNG dimensions — meta.size can be stale (e.g. untrimmed 2048)
  // and the .tmx must describe the PNG file that gets downloaded alongside it.
  const imageW = img.naturalWidth || json?.meta?.size?.w || json?.textures?.[0]?.size?.w;
  const imageH = img.naturalHeight || json?.meta?.size?.h || json?.textures?.[0]?.size?.h;
  const mimeType = "text/xml";

  return {
    url: dataUrlFor(buildAtlasTmx(json, atlasName, imageW, imageH), mimeType),
    filename: `${atlasName}.tmx`,
    mimeType,
  };
}

async function downloadAtlasTmx() {
  await ensureAtlasOrderSynced();

  let item: DownloadItem | null;
  try {
    item = atlasTmxItem();
  } catch (err: any) {
    alert(`TMX export failed: ${err?.message || err}`);
    return;
  }
  if (!item) {
    alert("Build or load an atlas first.");
    return;
  }
  await triggerDownloadMany([item]);
}

async function downloadAtlasAll() {
  await ensureAtlasOrderSynced();

  const png = atlasPngItem();
  const json = atlasJsonItem();
  if (!png || !json) {
    alert("Build or load an atlas first.");
    return;
  }

  // A non-grid atlas still exports fine as PNG + JSON — take the TMX if we can
  // get it and report the reason if we cannot.
  let tmx: DownloadItem | null = null;
  let tmxError = "";
  try {
    tmx = atlasTmxItem();
  } catch (err: any) {
    tmxError = err?.message || String(err);
  }

  // One call, so the Android standalone path shares all three files together —
  // it only gets one user activation to spend.
  await triggerDownloadMany([png, json, ...(tmx ? [tmx] : [])]);
  if (tmxError) alert(`TMX export failed: ${tmxError}`);
}

/** Crop the empty right-hand padding off an atlas. Returns the input untouched
 *  when the sheet is already as wide as its widest frame. */
async function trimAtlasToContent(
  dataURL: string,
  json: any
): Promise<{ dataURL: string; json: any }> {
  const actualWidth = getAtlasActualWidth(json);
  const width = json?.meta?.size?.w;
  const height = json?.meta?.size?.h;

  if (!dataURL || !actualWidth || !width || !height || actualWidth >= width) {
    return { dataURL, json };
  }

  const atlasImage = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    atlasImage.onload = () => resolve(true);
    atlasImage.onerror = () => resolve(false);
    atlasImage.src = dataURL;
  });
  if (!loaded) return { dataURL, json };

  const trimmedCanvas = document.createElement("canvas");
  trimmedCanvas.width = actualWidth;
  trimmedCanvas.height = height;
  const trimmedCtx = trimmedCanvas.getContext("2d")!;
  trimmedCtx.imageSmoothingEnabled = false;
  trimmedCtx.drawImage(atlasImage, 0, 0);

  const trimmedJson = JSON.parse(JSON.stringify(json)); // Deep copy
  trimmedJson.meta.size.w = actualWidth;

  return { dataURL: trimmedCanvas.toDataURL("image/png"), json: trimmedJson };
}

function setStatusLine(msg: string) {
  const el = $("sxStatusLine");
  if (el) el.textContent = msg;
}

function switchToExtractTab() {
  (
    document.querySelector('.sx-tab[data-sx-tab="extract"]') as HTMLButtonElement | null
  )?.click();
}

function wireUI() {
  ($("btnAddUrl") as HTMLButtonElement).addEventListener("click", async () => {
    const val = ($("fileUrl") as HTMLInputElement).value.trim();
    if (!val) {
      alert("Enter an image URL.");
      return;
    }
    try {
      await loadFromURL(val);
    } catch (e: any) {
      alert("Failed to load: " + e?.message);
    }
  });

  ($("fileInput") as HTMLInputElement).addEventListener(
    "change",
    async (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.files && t.files[0]) {
        await loadFromFile(t.files[0]);
      }
    }
  );

  ($("detectSpritesBtn") as HTMLButtonElement).addEventListener(
    "click",
    () => {
      const bgInput = $("bgColorInput") as HTMLInputElement;
      const explicit = bgInput?.value ? hexToRgb(bgInput.value) : null;
      runDetect(explicit ?? undefined);
    }
  );

  // Grid slicing controls
  ($("gridModeBtn") as HTMLButtonElement | null)?.addEventListener(
    "click",
    () => setGridActive(!gridActive)
  );
  ($("gridToolSelectBtn") as HTMLButtonElement | null)?.addEventListener(
    "click",
    () => {
      gridTool = "select";
      updateGridToolButtons();
      updateGridCursorBase();
    }
  );
  ($("gridToolMoveBtn") as HTMLButtonElement | null)?.addEventListener(
    "click",
    () => {
      gridTool = "move";
      updateGridToolButtons();
      updateGridCursorBase();
    }
  );
  ($("gridSelectAllBtn") as HTMLButtonElement | null)?.addEventListener(
    "click",
    gridSelectAllCells
  );
  ($("gridClearBtn") as HTMLButtonElement | null)?.addEventListener(
    "click",
    () => {
      if (!gridActive) return;
      selected.clear();
      gridAnchorIndex = null;
      drawOverlay();
      renderSelectedThumbs();
      onSelectionChanged();
    }
  );
  [
    "gridCellWInput",
    "gridCellHInput",
    "gridGapXInput",
    "gridGapYInput",
    "gridOffXInput",
    "gridOffYInput",
  ].forEach((id) => {
    ($(id) as HTMLInputElement | null)?.addEventListener("input", () => {
      if (!gridActive) return;
      readGridParamsFromInputs();
      rebuildGridCells({ remapSelection: true });
      drawOverlay();
      renderSelectedThumbs();
      onSelectionChanged();
    });
  });

  ($("saveSpritesFirebaseBtn") as HTMLButtonElement).addEventListener(
    "click",
    saveSelectedSpritesToFirebase
  );

  const builderSelect = $("builderTypeSelect") as HTMLSelectElement | null;
  if (builderSelect) {
    builderSelect.addEventListener("change", () => {
      applyBuilderModeUI(getBuilderMode());
    });
    applyBuilderModeUI(getBuilderMode());
  }

  ($("buildAtlasBtn") as HTMLButtonElement).addEventListener(
    "click",
    buildAtlasAndPreview
  );

  ($("openImportAtlasModalBtn") as HTMLButtonElement)?.addEventListener(
    "click",
    () => openImportAtlasModal()
  );

  ($("closeImportAtlasModalBtn") as HTMLButtonElement)?.addEventListener(
    "click",
    () => closeImportAtlasModal(false)
  );

  ($("confirmImportAtlasBtn") as HTMLButtonElement)?.addEventListener(
    "click",
    importAtlasFromSelectedFiles
  );

  ($("importAtlasJsonInput") as HTMLInputElement)?.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    importAtlasJsonFile = file;
    refreshImportAtlasStatus();
  });

  ($("importAtlasPngInput") as HTMLInputElement)?.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    importAtlasPngFile = file;
    refreshImportAtlasStatus();
  });

  const dropzone = $("atlasImportDropzone") as HTMLDivElement | null;
  if (dropzone) {
    const setDropActive = (active: boolean) => dropzone.classList.toggle("active", active);

    ["dragenter", "dragover"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (ev) => {
        ev.preventDefault();
        setDropActive(true);
      });
    });

    ["dragleave", "dragend", "drop"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (ev) => {
        ev.preventDefault();
        setDropActive(false);
      });
    });

    dropzone.addEventListener("drop", (ev) => {
      const files = Array.from(ev.dataTransfer?.files || []);
      files.forEach((file) => setImportAtlasFile(file));
      refreshImportAtlasStatus();
    });
  }

  ($("importAtlasModal") as HTMLDivElement | null)?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) {
      closeImportAtlasModal(false);
    }
  });

  ($("saveAtlasFirebaseBtn") as HTMLButtonElement).addEventListener(
    "click",
    saveAtlasToFirebase
  );

  ($("loadCharacterBtn") as HTMLButtonElement).addEventListener(
    "click",
    loadCharacterAndPreview
  );

  ($("downloadCharJsonBtn") as HTMLButtonElement).addEventListener(
    "click",
    downloadCharacterJson
  );

  ($("downloadCharPngBtn") as HTMLButtonElement).addEventListener(
    "click",
    downloadCharacterPng
  );

  ($("downloadAtlasJsonBtn") as HTMLButtonElement).addEventListener(
    "click",
    downloadAtlasJson
  );

  ($("downloadAtlasPngBtn") as HTMLButtonElement).addEventListener(
    "click",
    downloadAtlasPng
  );

  ($("downloadAtlasTmxBtn") as HTMLButtonElement | null)?.addEventListener(
    "click",
    downloadAtlasTmx
  );

  ($("downloadAtlasAllBtn") as HTMLButtonElement | null)?.addEventListener(
    "click",
    downloadAtlasAll
  );

  ($("atlasSelect") as HTMLSelectElement).addEventListener(
    "change",
    loadAtlasAndPreview
  );

  const reorderBtn = $("reorderAtlasFramesBtn") as HTMLButtonElement | null;
  if (reorderBtn) {
    reorderBtn.addEventListener("click", toggleAtlasReorder);
  }

  // Task 1: select all / none toggle for atlas frames in the View tab.
  $("selectAllFramesBtn")?.addEventListener("click", toggleSelectAllFrames);

  // Duplicate the selected frames in place (copies insert after their sources).
  $("duplicateFramesBtn")?.addEventListener("click", duplicateSelectedAtlasFrames);

  // Task 3: send the frames selected in View straight to the Extract tab as
  // detected sprites, skipping re-detection.
  $("viewExtractBtn")?.addEventListener("click", async () => {
    // A rebuild kicked off by save/download may be mid-flight; settle it fully
    // so the data URL and frame rects we read below belong to the same sheet.
    if (atlasSyncPromise) await ensureAtlasOrderSynced();

    const previewImg = $("atlasPreviewImg") as HTMLImageElement;
    const dataURL = (previewImg as any)._atlasDataURL || previewImg.src || "";
    if (!dataURL.startsWith("data:")) {
      setStatusLine("SELECT AN ATLAS FIRST");
      return;
    }

    const indices = atlasSelectedFrameIndices.size
      ? [...atlasSelectedFrameIndices].sort((a, b) => a - b)
      : atlasFrames.map((_, i) => i);
    const rects = indices.map((i) => atlasFrameRects[i]).filter(Boolean);

    if (rects.length) {
      await sendAtlasFramesToExtract(dataURL, rects);
    } else {
      // No frame metadata available — fall back to loading + auto-detecting.
      await loadFromURL(dataURL);
    }
    switchToExtractTab();
  });

  // Selection preview controls
  const selBtn = $("selectionPreviewBtn") as HTMLButtonElement | null;
  if (selBtn) {
    selBtn.addEventListener("click", () => {
      if (selectionPlaying) stopSelectionPreview();
      else startSelectionPreview();
    });
  }

  const fpsInput = $("selectionFpsInput") as HTMLInputElement | null;
  if (fpsInput) {
    fpsInput.addEventListener("change", () => {
      if (selectionPlaying) startSelectionPreview(); // restart with new fps
    });
  }

  const spritePreviewSelect = $("spritePreviewSelect") as HTMLSelectElement | null;
  if (spritePreviewSelect) {
    spritePreviewSelect.addEventListener("change", async () => {
      const key = spritePreviewSelect.value;
      const img = $("spritePreviewImg") as HTMLImageElement;
      if (!key || !img) {
        if (img) img.src = "";
        await setContainerSize($("spritePreviewContainer") as HTMLElement, []);
        return;
      }

      const spriteData = dbSprites[key];
      let src = "";
      if (typeof spriteData === "string") {
        src = ensureDataURL(spriteData);
      } else if (spriteData?.png) {
        src = ensureDataURL(spriteData.png);
      }
      img.src = src;
      await setContainerSize(
        $("spritePreviewContainer") as HTMLElement,
        src ? [src] : []
      );
    });
  }

  // Preview containers' extra controls
  $("selectionBgBtn")?.addEventListener("click", () => {
    $("selectionPreviewContainer")?.classList.toggle("bg-checkered");
  });
  $("selectionFullscreenBtn")?.addEventListener("click", () => {
    $("selectionPreviewContainer")?.requestFullscreen();
  });
  $("atlasBgBtn")?.addEventListener("click", () => {
    $("atlasAnimPreviewContainer")?.classList.toggle("bg-checkered");
  });
  $("atlasFullscreenBtn")?.addEventListener("click", () => {
    $("atlasAnimPreviewContainer")?.requestFullscreen();
  });
  $("characterBgBtn")?.addEventListener("click", () => {
    $("characterPreviewContainer")?.classList.toggle("bg-checkered");
  });
  $("characterFullscreenBtn")?.addEventListener("click", () => {
    $("characterPreviewContainer")?.requestFullscreen();
  });

  // Atlas preview controls
  const atlasBtn = $("atlasPreviewBtn") as HTMLButtonElement | null;
  if (atlasBtn) {
    atlasBtn.addEventListener("click", () => {
      if (atlasAnimPlaying) stopAtlasPreview();
      else startAtlasPreview();
    });
  }

  const atlasAnimPreviewImg = $("atlasAnimPreviewImg") as HTMLImageElement | null;

  const downloadGifBtn = $("downloadGifBtn") as HTMLButtonElement | null;
  if (downloadGifBtn) {
    downloadGifBtn.addEventListener("click", async () => {
      if (atlasAnimPreviewImg) {
        const blob = (atlasAnimPreviewImg as any)._gifBlob as Blob | null;
        if (blob) {
          const atlasSelect = $("atlasSelect") as HTMLSelectElement;
          const atlasName =
            atlasSelect.options[atlasSelect.selectedIndex]?.textContent ||
            "animation";
          const filename = `${atlasName}.gif`;

          // Use FileReader to convert blob to data URL
          const reader = new FileReader();
          reader.onload = (e) => {
            if (e.target?.result) {
              const url = e.target.result as string;
              triggerDownload(url, filename, "image/gif");
            }
          };
          reader.onerror = () => {
            alert("Failed to read GIF data for download.");
          };
          reader.readAsDataURL(blob);
        } else {
          alert(
            "No animation generated yet. Click 'Preview Atlas Anim' first."
          );
        }
      }
    });
  }

  const atlasFpsInput = $("atlasFpsInput") as HTMLInputElement | null;
  if (atlasFpsInput) {
    atlasFpsInput.addEventListener("change", () => {
      if (atlasAnimPlaying) startAtlasPreview(); // restart with new fps
    });
  }

  const gifScaleInput = $("gifScaleInput") as HTMLSelectElement | null;
  if (gifScaleInput) {
    gifScaleInput.addEventListener("change", () => {
      if (atlasAnimPlaying) startAtlasPreview(); // restart with new scale
    });
  }

  // Main canvas controls
  const zoomBtn = $("canvasZoomBtn") as HTMLButtonElement;
  zoomBtn?.addEventListener("click", () => {
    canvasZoom = (canvasZoom % 4) + 1; // Cycle 1, 2, 3, 4
    zoomBtn.textContent = `Zoom: ${canvasZoom}x`;
    applyCanvasZoom();
    // The grid origin handle is sized in screen pixels — redraw at new zoom.
    drawOverlay();
  });

  $("canvasFullscreenBtn")?.addEventListener("click", () => {
    $("canvasContainer")?.requestFullscreen();
  });

  // Eyedropper: pick BG color from canvas in realtime
  const pickBtn = $("bgColorPickBtn") as HTMLButtonElement | null;
  if (pickBtn) {
    pickBtn.addEventListener("click", () => {
      if (bgPickActive) finishBgPick(false); // toggle off, revert to previous
      else startBgPick();
    });
  }

  // Erase color: pick + apply
  const erasePickBtn = $("eraseColorPickBtn") as HTMLButtonElement | null;
  if (erasePickBtn) {
    erasePickBtn.addEventListener("click", () => {
      if (erasePickActive) finishErasePick(false);
      else startErasePick();
    });
  }
  const eraseApplyBtn = $("eraseApplyBtn") as HTMLButtonElement | null;
  if (eraseApplyBtn) {
    eraseApplyBtn.addEventListener("click", () => {
      applyEraseColorNow();
    });
  }

  // Allow ESC to cancel picking and revert
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && bgPickActive) {
      finishBgPick(false);
    }
    if (e.key === "Escape" && erasePickActive) {
      finishErasePick(false);
    }
    if (e.key === "Escape" && gridDrag) {
      cancelGridDrag();
    }
  });
}

function setupTheme() {
  const toggle = document.getElementById('theme-toggle') as HTMLInputElement;
  if (!toggle) return;

  const applyTheme = (isDark: boolean) => {
    document.body.classList.toggle('dark-mode', isDark);
    toggle.checked = isDark;
  };

  // Check for saved preference
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    applyTheme(true);
  } else if (savedTheme === 'light') {
    applyTheme(false);
  } else {
    // Fallback to system preference if no explicit choice is saved
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark);
  }

  toggle.addEventListener('change', () => {
    const isDark = toggle.checked;
    applyTheme(isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    // Only apply if no explicit user choice is stored
    if (!localStorage.getItem('theme')) {
      applyTheme(e.matches);
    }
  });
}

function setupPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      console.log('Service worker registered.', reg);
    }).catch(err => {
      console.error('Service worker registration failed:', err);
    });
  }

  let deferredPrompt: any;
  const installBtn = $('installBtn') as HTMLButtonElement;

  // Check if the app is already installed and running in standalone mode
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone) {
    console.log('App is running in standalone mode, hiding install button.');
    installBtn.style.display = 'none';
    return;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Stash the event so it can be triggered later.
    deferredPrompt = e;
    // Update the install button visibility
    installBtn.style.display = 'block';

    installBtn.addEventListener('click', () => {
      // Hide the install button
      installBtn.style.display = 'none';
      // Show the install prompt
      deferredPrompt.prompt();
      // Wait for the user to respond to the prompt
      deferredPrompt.userChoice.then((choiceResult: any) => {
        if (choiceResult.outcome === 'accepted') {
          console.log('User accepted the install prompt');
        } else {
          console.log('User dismissed the install prompt');
        }
        deferredPrompt = null;
      });
    });
  });

  // Also hide the button if the app is installed
  window.addEventListener('appinstalled', () => {
    console.log('App was installed.');
    installBtn.style.display = 'none';
    deferredPrompt = null;
  });
}

// ============ CMG Sprite Picker preload bridge ==========
// The CMG launcher (github.com/easierbycode/cmg, tools/sprite-picker-extension)
// can boot SpriteX with sprites picked from any sprite-sheet site. The payload
// arrives as a window message from the embedding launcher frame (or an opener):
//   { type: "spritex-preload", sprites: [{ name, dataURL }, ...] }
// The sprites are packed with the existing atlas builder and shown in the View
// tab exactly as if an RTDB atlas had been selected, and the sender is answered
// with { type: "spritex-preload-ack", count } so it can stop re-posting.

const PRELOAD_MAX_SPRITES = 64;

function sanitizePreloadSprites(
  raw: unknown
): { name: string; dataURL: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; dataURL: string }[] = [];
  const seen = new Set<string>();
  for (const s of raw.slice(0, PRELOAD_MAX_SPRITES)) {
    const dataURL = typeof (s as any)?.dataURL === "string"
      ? (s as any).dataURL
      : "";
    if (!/^data:image\/(png|webp|gif|jpe?g);base64,/.test(dataURL)) continue;
    let name = typeof (s as any)?.name === "string" ? (s as any).name : "";
    name = name.replace(/[^\w-]/g, "").slice(0, 48) || `sprite_${out.length}`;
    while (seen.has(name)) name += "_";
    seen.add(name);
    out.push({ name, dataURL });
  }
  return out;
}

async function preloadSpritesIntoView(
  sprites: { name: string; dataURL: string }[]
) {
  const named: Record<string, string> = {};
  sprites.forEach((s, i) => {
    named[s.name || `sprite_${i}`] = s.dataURL;
  });
  const { dataURL, json } = await buildAtlas(named);
  await applyAtlasPreview(dataURL, json, {
    selectAllFrames: true,
    startPreviewNow: true,
  });
  // Tab switching lives in an inline IIFE in index.html (show() is closure
  // private), so drive it through the buttons like a user would.
  (document.querySelector(
    '.sx-tab[data-sx-tab="view"]'
  ) as HTMLButtonElement | null)?.click();
  (document.getElementById("viewModeAtlasBtn") as HTMLButtonElement | null)
    ?.click();
  const status = document.getElementById("sxStatusLine");
  if (status) {
    status.textContent = `VIEW · ${sprites.length} SPRITE${
      sprites.length === 1 ? "" : "S"
    } FROM SPRITE PICKER`;
  }
}

let preloadBusy = false;

function setupPreloadBridge() {
  window.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data;
    if (!d || d.type !== "spritex-preload") return;
    const sprites = sanitizePreloadSprites(d.sprites);
    if (!sprites.length || preloadBusy) return;
    preloadBusy = true;
    const src = ev.source as Window | null;
    preloadSpritesIntoView(sprites)
      .then(() => {
        try {
          src?.postMessage(
            { type: "spritex-preload-ack", count: sprites.length },
            "*"
          );
        } catch (_e) { /* sender gone — nothing to ack */ }
      })
      .catch((err) => console.error("spritex-preload failed:", err))
      .finally(() => {
        preloadBusy = false;
      });
  });
  // Tell an embedding launcher we can receive sprites now.
  const host = window.opener ||
    (window.parent !== window ? window.parent : null);
  try {
    host?.postMessage({ type: "spritex-ready" }, "*");
  } catch (_e) { /* not embedded */ }
}

async function populateSpritePreviewDropdownFromDB() {
    const select = $("spritePreviewSelect") as HTMLSelectElement;
    if (!select) return;

    select.innerHTML = "";
    const loadingOpt = document.createElement("option");
    loadingOpt.value = "";
    loadingOpt.textContent = "Loading sprites...";
    select.appendChild(loadingOpt);
    select.disabled = true;

    try {
        dbSprites = await fetchAllSprites();
        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "-- Select a sprite --";
        select.appendChild(placeholder);

        Object.keys(dbSprites).forEach(id => {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = id;
            select.appendChild(opt);
        });

        select.disabled = false;
    } catch (err) {
        select.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "Failed to load sprites";
        select.appendChild(opt);
        select.disabled = true;
        console.error(err);
    }
}

document.addEventListener("DOMContentLoaded", async () => {
  setupCanvases();
  setupTheme();
  wireUI();
  initPackerTab();
  setupPWA();
  initTilemapEditor({ downloadFile, setStatus: setStatusLine });
  initTilemapGameBridge();
  initGamepad({ setStatus: setStatusLine });
  // Before the RTDB awaits: preload must work even when Firebase is slow/down.
  setupPreloadBridge();
  await populateCharacterSelect();
  await populateAtlasSelect();
  await populateSpritePreviewDropdownFromDB();
});

function startBgPick() {
  if (bgPickActive) return;
  const bgInput = $("bgColorInput") as HTMLInputElement | null;
  const btn = $("bgColorPickBtn") as HTMLButtonElement | null;
  bgPickPrevHex = bgInput?.value ?? null;
  bgPickHoverHex = null;
  bgPickActive = true;
  if (btn) {
    btn.textContent = "Picking… (ESC to cancel)";
    btn.disabled = false;
  }
  if (overlayCanvas) overlayCanvas.style.cursor = "crosshair";
}

function finishBgPick(commit: boolean) {
  if (!bgPickActive) return;
  const bgInput = $("bgColorInput") as HTMLInputElement | null;
  const btn = $("bgColorPickBtn") as HTMLButtonElement | null;

  if (!commit && bgInput && bgPickPrevHex) {
    // revert to original value
    bgInput.value = bgPickPrevHex;
  }
  // if commit, we keep whatever hover color was last previewed

  bgPickActive = false;
  bgPickHoverHex = null;
  bgPickPrevHex = null;
  if (btn) btn.textContent = "Pick BG";
  if (overlayCanvas) overlayCanvas.style.cursor = "default";
}

// ============ Erase color pick + apply ==========

function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function removeColorFromCanvas(color: RGB, tolerance: number) {
  try {
    const w = originalCanvas.width;
    const h = originalCanvas.height;
    if (w <= 0 || h <= 0) return;
    const id = originalCtx.getImageData(0, 0, w, h);
    const data = id.data;
    const tol = Math.max(0, Math.min(200, Math.floor(tolerance)));
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (colorDistance({ r, g, b }, color) <= tol) {
        data[i + 3] = 0;
      }
    }
    originalCtx.putImageData(id, 0, 0);
  } catch (err) {
    alert("Failed to erase color. If using an external image URL, ensure it allows CORS.");
    console.error(err);
  }
}

function applyEraseColorNow() {
  const eInput = $("eraseColorInput") as HTMLInputElement | null;
  const tInput = $("eraseToleranceInput") as HTMLInputElement | null;
  const rgb = eInput?.value ? hexToRgb(eInput.value) : null;
  const tol = Number(tInput?.value || 12);
  if (!rgb) return;
  removeColorFromCanvas(rgb, tol);
  renderSelectedThumbs();
}

function startErasePick() {
  if (erasePickActive) return;
  const eInput = $("eraseColorInput") as HTMLInputElement | null;
  const btn = $("eraseColorPickBtn") as HTMLButtonElement | null;
  erasePickPrevHex = eInput?.value ?? null;
  erasePickHoverHex = null;
  erasePickActive = true;
  if (btn) {
    btn.textContent = "Picking… (ESC to cancel)";
    btn.disabled = false;
  }
  if (overlayCanvas) overlayCanvas.style.cursor = "crosshair";
}

function finishErasePick(commit: boolean) {
  if (!erasePickActive) return;
  const eInput = $("eraseColorInput") as HTMLInputElement | null;
  const btn = $("eraseColorPickBtn") as HTMLButtonElement | null;

  if (!commit && eInput && erasePickPrevHex) {
    // revert to original value
    eInput.value = erasePickPrevHex;
  }

  // On commit, immediately apply erase using chosen color and tolerance
  if (commit) applyEraseColorNow();

  erasePickActive = false;
  erasePickHoverHex = null;
  erasePickPrevHex = null;
  if (btn) btn.textContent = "Pick Erase";
  if (overlayCanvas) overlayCanvas.style.cursor = "default";
}
