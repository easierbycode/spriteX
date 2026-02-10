// src/main.ts
declare const GIF: any;
import {
  smartDetectSprites,
  extractSpriteDataURLs,
  saveSpritesBatchToRTDB,
  buildAtlas,
  saveAtlas,
  loadCharacterPreviewFromAtlas,
  fetchAllCharacters,
  fetchAllAtlases,
  fetchAllSprites,
  fetchAtlas,
  fetchCharacter,
  rgbToHex,
  hexToRgb,
  getAtlasActualWidth,
  type DetectedSprite,
  type RGB,
  type SpriteData,
} from "./atlasManager";

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
let atlasSelectedFrameIndices = new Set<number>();
let atlasAnimFrameIndex = 0;
let atlasAnimPlaying = false;
let atlasReorderEnabled = false;

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

function $(id: string) {
  return document.getElementById(id);
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

    const rect = overlayCanvas.getBoundingClientRect();
    const x = Math.floor(ev.clientX - rect.left);
    const y = Math.floor(ev.clientY - rect.top);

    const idx = detected.findIndex(
      (s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h
    );

    if (idx >= 0) {
      if (selected.has(idx)) selected.delete(idx);
      else selected.add(idx);
      drawOverlay();
      renderSelectedThumbs();
      onSelectionChanged();
    }
  });

  // Real-time sampling while in BG pick mode
  overlayCanvas.addEventListener("mousemove", (ev) => {
    if (!bgPickActive && !erasePickActive) return;
    const rect = overlayCanvas.getBoundingClientRect();
    const x = Math.floor(ev.clientX - rect.left);
    const y = Math.floor(ev.clientY - rect.top);
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

  for (let i = 0; i < detected.length; i++) {
    const s = detected[i];
    overlayCtx.strokeStyle = selected.has(i)
      ? "rgba(0,200,0,0.9)"
      : "rgba(255,0,0,0.85)";
    overlayCtx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
  }
  // Add a data attribute to signal test scripts that drawing is complete.
  overlayCanvas.dataset.drawn = String(detected.length);
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

  selected.forEach((i) => {
    const s = detected[i];
    const c = document.createElement("canvas");
    c.width = s.w;
    c.height = s.h;

    const cctx = c.getContext("2d")!;
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(originalCanvas, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);

    const wrap = document.createElement("div");
    wrap.style.display = "inline-flex";
    wrap.style.flexDirection = "column";
    wrap.style.alignItems = "center";
    wrap.style.margin = "4px";

    const img = document.createElement("img");
    img.src = c.toDataURL("image/png");
    img.style.width = "96px";
    img.style.height = "auto";
    img.style.border = "1px dashed #aaa";
    img.dataset.spriteIndex = String(i);

    const info = document.createElement("small");
    info.style.opacity = "0.8";
    info.style.fontSize = "11px";

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
}

function getSortedSelectedIndices(): number[] {
  const arr = [...selected];
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
  const indices = getSortedSelectedIndices();
  const boxes: DetectedSprite[] = [];
  const smallest = getSmallestSelectedDimensions();

  indices.forEach((idx) => {
    const sprite = detected[idx];
    if (!sprite) return;
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
  const boxes = getSelectedBoxesExpanded();
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
  // Keep preview in sync with selection
  refreshSelectionPreviewFrames(true);
  // The sprite preview dropdown is now populated from the DB, not from the local selection.
  // updateSpritePreviewDropdown();
}

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

async function loadFromURL(url: string) {
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

  detected = [];
  selected.clear();
  spriteSplitChoices.clear();
  hideSplitMenu();
  drawOverlay();
  renderSelectedThumbs();
  onSelectionChanged();

  // Reset BG controls to default state when a new image is loaded.
  const bgInput = $("bgColorInput") as HTMLInputElement;
  const bgPickBtn = $("bgColorPickBtn") as HTMLButtonElement;
  const bgStatus = $("bgStatus") as HTMLSpanElement;
  bgInput.disabled = false;
  bgPickBtn.disabled = false;
  bgStatus.style.display = "none";
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
): Promise<string[]> {
  const frames: string[] = [];
  const frameData = atlasJson.frames || {};

  for (const key in frameData) {
    const frame = frameData[key].frame;
    const c = document.createElement("canvas");
    c.width = frame.w;
    c.height = frame.h;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(atlasImg, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
    frames.push(c.toDataURL("image/png"));
  }

  return frames;
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
    if (saveBtn) saveBtn.textContent = "Save Atlas (RTDB)";
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
  let idx = 0;
  for (const k of Object.keys(map)) {
    named[`atlas_s${idx++}`] = map[k];
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

  const trimBtn = $("trimAtlasBtn") as HTMLButtonElement;
  if (json?.meta?.size?.w === 2048) {
      trimBtn.style.display = 'inline-block';
  } else {
      trimBtn.style.display = 'none';
  }

  $("saveAtlasFirebaseBtn")!.removeAttribute("disabled");
  $("downloadAtlasJsonBtn")!.removeAttribute("disabled");
  $("downloadAtlasPngBtn")!.removeAttribute("disabled");

  // --- New logic for atlas frame preview ---
  stopAtlasPreview();
  atlasSelectedFrameIndices.clear();

  await new Promise<void>(resolve => {
    const atlasImg = new Image();
    atlasImg.onload = async () => {
      atlasFrames = await extractFramesFromAtlas(atlasImg, json);
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

function renderAtlasFrames() {
  const cont = $("atlasFramesContainer") as HTMLDivElement;
  cont.innerHTML = "";

  if (!atlasFrames.length) {
    cont.textContent = "No frames found in atlas.";
    return;
  }

  atlasFrames.forEach((frameDataURL, index) => {
    const img = document.createElement("img");
    img.src = frameDataURL;
    img.style.width = "64px";
    img.style.height = "auto";
    img.style.margin = "4px";
    img.dataset.frameIndex = String(index);
    img.draggable = atlasReorderEnabled;
    img.style.cursor = atlasReorderEnabled ? "grab" : "pointer";

    if (atlasSelectedFrameIndices.has(index)) {
      img.classList.add("selected");
    }

    img.addEventListener("click", () => {
      if (atlasSelectedFrameIndices.has(index)) {
        atlasSelectedFrameIndices.delete(index);
        img.classList.remove("selected");
      } else {
        atlasSelectedFrameIndices.add(index);
        img.classList.add("selected");
      }
      refreshAtlasPreviewFrames(false); // Update preview but don't start playing
    });

    if (atlasReorderEnabled) {
      img.addEventListener("dragstart", (ev) => {
        img.style.opacity = "0.45";
        if (ev.dataTransfer) {
          ev.dataTransfer.setData("application/x-atlas-frame-index", String(index));
          ev.dataTransfer.setData("text/plain", String(index));
          ev.dataTransfer.effectAllowed = "move";
        }
      });

      img.addEventListener("dragend", () => {
        img.style.opacity = "1";
      });

      img.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      });

      img.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const rawFrom =
          ev.dataTransfer?.getData("application/x-atlas-frame-index") ||
          ev.dataTransfer?.getData("text/plain") ||
          "";
        if (!/^\d+$/.test(rawFrom)) return;

        const from = Number(rawFrom);
        const to = index;

        if (!Number.isFinite(from) || from === to) return;
        if (from < 0 || from >= atlasFrames.length || to < 0 || to >= atlasFrames.length) return;

        const moved = atlasFrames.splice(from, 1)[0];
        atlasFrames.splice(to, 0, moved);
        atlasSelectedFrameIndices = remapSelectedFrameIndicesAfterMove(
          atlasSelectedFrameIndices,
          atlasFrames.length,
          from,
          to
        );

        renderAtlasFrames();
        refreshAtlasPreviewFrames(false);
      });
    }

    cont.appendChild(img);
  });
}

async function saveAtlasToFirebase() {
  const nameInput = $("atlasNameInput") as HTMLInputElement;
  const atlasName = (nameInput?.value || "untitled_atlas").trim();

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

    const img = $("atlasPreviewImg") as HTMLImageElement;
    img.src = dataURL;

    (img as any)._atlasJson = json;
    (img as any)._atlasDataURL = dataURL;
    (img as any)._atlasOutputJson = json;

    const trimBtn = $("trimAtlasBtn") as HTMLButtonElement;
    if (json?.meta?.size?.w === 2048) {
        trimBtn.style.display = 'inline-block';
    } else {
        trimBtn.style.display = 'none';
    }

    $("saveAtlasFirebaseBtn")!.removeAttribute("disabled");
    $("downloadAtlasJsonBtn")!.removeAttribute("disabled");
    $("downloadAtlasPngBtn")!.removeAttribute("disabled");

    // This part is the same as in buildAtlasAndPreview
    stopAtlasPreview();
    atlasSelectedFrameIndices.clear();

    await new Promise<void>(resolve => {
        const atlasImg = new Image();
        atlasImg.onload = async () => {
            atlasFrames = await extractFramesFromAtlas(atlasImg, json);
            // Select all frames by default
            atlasSelectedFrameIndices = new Set(atlasFrames.map((_, i) => i));
            renderAtlasFrames();
            startAtlasPreview();
            resolve();
        };
        atlasImg.onerror = () => {
            console.error("Failed to load atlas image for preview");
            resolve();
        }
        atlasImg.src = dataURL;
    });
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
 * Triggers a file download by either calling the native Android interface
 * or by using the standard web anchor tag method as a fallback.
 * @param url The data URL of the file to download.
 * @param filename The desired name of the file.
 * @param mimeType The MIME type of the file.
 */
function triggerDownload(url: string, filename: string, mimeType: string) {
  // Check for a native Android interface
  if ((window as any).Android?.downloadFile) {
    (window as any).Android.downloadFile(url, filename, mimeType);
  } else {
    // Fallback for standard web browsers
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

/**
 * Creates a data URL from the given content and triggers a browser download.
 * This is more reliable than blob URLs for webviews.
 * @param filename The name of the file to save.
 * @param content The string content to put in the file.
 * @param type The MIME type of the file.
 */
function downloadFile(filename: string, content: string, type: string) {
  const url = `data:${type};charset=utf-8,${encodeURIComponent(content)}`;
  triggerDownload(url, filename, type);
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

function downloadAtlasJson() {
  const img = $("atlasPreviewImg") as HTMLImageElement;
  const json = (img as any)._atlasJson;

  if (!json) {
    alert("Build or load an atlas first.");
    return;
  }

  const nameInput = $("atlasNameInput") as HTMLInputElement;
  const select = $("atlasSelect") as HTMLSelectElement;
  const atlasName = (nameInput?.value.trim()) || (select?.value) || "atlas";
  const filename = `${atlasName}.json`;
  const outputJson = (img as any)._atlasOutputJson ?? json;
  const content =
    typeof outputJson === "string"
      ? outputJson
      : JSON.stringify(outputJson, null, 2);

  downloadFile(filename, content, "application/json");
}

function downloadAtlasPng() {
  const img = $("atlasPreviewImg") as HTMLImageElement;
  const dataURL = (img as any)._atlasDataURL;

  if (!dataURL) {
    alert("Build or load an atlas first.");
    return;
  }

  const nameInput = $("atlasNameInput") as HTMLInputElement;
  const select = $("atlasSelect") as HTMLSelectElement;
  const atlasName = (nameInput?.value.trim()) || (select?.value) || "atlas";
  const filename = `${atlasName}.png`;

  triggerDownload(dataURL, filename, "image/png");
}

async function trimCurrentAtlas() {
    const img = $("atlasPreviewImg") as HTMLImageElement;
    const json = (img as any)._atlasJson;
    const dataURL = (img as any)._atlasDataURL;

    if (!json || !dataURL) {
        alert("No atlas loaded to trim.");
        return;
    }

    const actualWidth = getAtlasActualWidth(json);
    const originalWidth = json.meta.size.w;

    if (actualWidth === 0 || actualWidth >= originalWidth) {
        alert("Atlas is already at its optimal width or cannot be trimmed.");
        return;
    }

    const originalHeight = json.meta.size.h;

    // Create a new canvas with the trimmed width
    const trimmedCanvas = document.createElement('canvas');
    trimmedCanvas.width = actualWidth;
    trimmedCanvas.height = originalHeight;
    const trimmedCtx = trimmedCanvas.getContext('2d')!;

    // Draw the old atlas image onto the new, smaller canvas
    const atlasImage = new Image();
    await new Promise(resolve => {
        atlasImage.onload = resolve;
        atlasImage.src = dataURL;
    });
    trimmedCtx.drawImage(atlasImage, 0, 0);

    // Get the new data URL
    const trimmedDataURL = trimmedCanvas.toDataURL('image/png');

    // Update the JSON metadata
    const newJson = JSON.parse(JSON.stringify(json)); // Deep copy
    newJson.meta.size.w = actualWidth;

    // Update the UI
    img.src = trimmedDataURL;
    (img as any)._atlasJson = newJson;
    (img as any)._atlasDataURL = trimmedDataURL;

    // Hide the trim button as it's no longer needed
    ($("trimAtlasBtn") as HTMLButtonElement).style.display = 'none';

    alert(`Atlas trimmed from ${originalWidth}px to ${actualWidth}px wide. You can now save the trimmed version.`);
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

  ($("trimAtlasBtn") as HTMLButtonElement).addEventListener(
    "click",
    trimCurrentAtlas
  );

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

  ($("atlasSelect") as HTMLSelectElement).addEventListener(
    "change",
    loadAtlasAndPreview
  );

  const reorderBtn = $("reorderAtlasFramesBtn") as HTMLButtonElement | null;
  if (reorderBtn) {
    reorderBtn.addEventListener("click", toggleAtlasReorder);
  }

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
  setupPWA();
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
