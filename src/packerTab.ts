// src/packerTab.ts
// PACKER tab — PackerScene-style atlas frame replacement.
//
// The current atlas frames and the available sprites (Firebase sprites/*,
// frames from any other atlas, or local uploads) are visible side by side.
// The player clicks a frame in the atlas to set the replace target, then
// selects one or more replacement sprites; N selected sprites replace N
// consecutive frames starting at the target (extras past the end of the
// atlas are skipped). Selected sprites can also be appended as new frames.
//
// Saving writes the atlas back to RTDB (atlases/{key}) in the exact layout it
// came out of the cloud in: the original PNG is repainted in place so every
// untouched frame keeps its byte-identical rect. A replacement bigger than the
// frame's box therefore has to lose pixels, and the player picks which ones in
// the crop dialog — a mask the size of the original frame that they slide over
// the replacement. Turning PRESERVE LAYOUT off falls back to a full repack,
// which re-derives the grid and moves everything.

import {
  fetchAtlas,
  fetchAllSprites,
  buildAtlas,
  saveAtlas,
  decodeAtlasFrameKey,
  type SpriteData,
} from "./atlasManager";
import { wireFileDrop, isImageFile } from "./fileDrop";
import {
  boxSignature,
  frameBox,
  framesByKey,
  rebuildPreservingLayout,
  type AdditionPaint,
  type FrameSlot,
  type Rect,
  type SlotPaint,
} from "./packerLayout";
import { openCropDialog, type CropResult } from "./packerCrop";

interface PackerSprite {
  name: string;
  dataURL: string;
  /** Stable identity for selection tracking across source reloads. */
  id?: string;
}

/** An atlas frame as loaded: its thumbnail plus the sheet region it owns. */
interface FrameEntry extends PackerSprite, FrameSlot {}

/** How a replacement sprite is fitted into the frame's box. */
type FitMode = "center" | "crop" | "scale";

interface Replacement {
  /** The sprite the player picked, at full size. */
  source: PackerSprite;
  srcW: number;
  srcH: number;
  mode: FitMode;
  /** Top-left of the box-sized mask inside the source, for mode "crop". */
  crop?: { x: number; y: number };
  /** What actually gets painted — post crop or scale. */
  dataURL: string;
  outW: number;
  outH: number;
}

// Current atlas being edited
let atlasKey = "";
let frames: FrameEntry[] = []; // original frames, in atlas order
let replacements = new Map<number, Replacement>(); // frame index -> replacement
let additions: PackerSprite[] = []; // frames appended via ADD AS NEW
let targetIndex: number | null = null; // anchor frame for the next replace
let selectedSources: PackerSprite[] = []; // replacements, in click order

// The atlas exactly as it came from RTDB — the base the preserved rebuild
// repaints, and the source of the crop dialog's ghost frames.
let sheetImg: HTMLImageElement | null = null;
let sheetJson: any = null;

// Available-sprites panel
let uploads: PackerSprite[] = [];
let availableEntries: PackerSprite[] = [];
let spriteCache: PackerSprite[] | null = null; // sprites/* entries
const atlasSourceCache = new Map<string, PackerSprite[]>();
let availableLoadToken = 0;

let atlasLoadToken = 0;
let saving = false;
let cropping = false; // a crop dialog owns the screen
let firstShowDone = false;

function $(id: string) {
  return document.getElementById(id);
}

function setStatus(msg: string) {
  const el = $("sxStatusLine");
  if (el) el.textContent = msg;
}

function ensureDataURL(s: string): string {
  return s.startsWith("data:") ? s : `data:image/png;base64,${s}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

/** Decoded sprites, keyed by data URL — replacing a frame needs the source's
 *  pixel size before anything can be laid out. */
const imageCache = new Map<string, HTMLImageElement>();

async function getImage(dataURL: string): Promise<HTMLImageElement> {
  const hit = imageCache.get(dataURL);
  if (hit) return hit;
  const img = await loadImage(dataURL);
  // Data URLs are big; keep the cache to the working set rather than every
  // sprite the player has ever hovered.
  if (imageCache.size > 240) imageCache.clear();
  imageCache.set(dataURL, img);
  return img;
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/** Tight source rect for a frame. Untrimmed spriteX-style atlases center the
 *  sprite inside a uniform cell via spriteSourceSize — crop to the sprite so
 *  replacements and repacks don't accumulate cell padding. */
function frameSourceRect(entry: any): Rect | null {
  const f = entry?.frame;
  if (!f || typeof f.w !== "number" || typeof f.h !== "number") return null;
  const ss = entry.spriteSourceSize;
  if (!entry.trimmed && ss && ss.w > 0 && ss.h > 0 && ss.w <= f.w && ss.h <= f.h) {
    return { x: f.x + (ss.x || 0), y: f.y + (ss.y || 0), w: ss.w, h: ss.h };
  }
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

/** Slice a stored atlas into per-frame thumbnails, keeping each frame's key
 *  and its box in the sheet so the layout can be rebuilt around it. */
async function sliceAtlasFrames(
  png: string,
  json: any
): Promise<{ img: HTMLImageElement; entries: FrameEntry[] }> {
  const img = await loadImage(ensureDataURL(png));
  const map = framesByKey(json);
  const entries: FrameEntry[] = [];
  for (const key of Object.keys(map)) {
    const entry = map[key];
    const box = frameBox(entry);
    const rect = frameSourceRect(entry);
    if (!box || !rect) continue;
    const f = entry.frame;
    const ss = entry.spriteSourceSize;
    const srcSize = entry.sourceSize;
    // Trimmed frames hold only the tight pixels in the sheet; restore them
    // into the full source box so registration survives the repack.
    const canRestoreTrim =
      entry.trimmed === true && ss && srcSize &&
      srcSize.w > 0 && srcSize.h > 0 &&
      (ss.x || 0) >= 0 && (ss.y || 0) >= 0 &&
      (ss.x || 0) + f.w <= srcSize.w && (ss.y || 0) + f.h <= srcSize.h;

    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    if (canRestoreTrim) {
      c.width = Math.max(1, srcSize.w);
      c.height = Math.max(1, srcSize.h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, f.x, f.y, f.w, f.h, ss.x || 0, ss.y || 0, f.w, f.h);
    } else {
      c.width = Math.max(1, rect.w);
      c.height = Math.max(1, rect.h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    }
    entries.push({
      key,
      name: decodeAtlasFrameKey(entry?.filename ?? key),
      dataURL: c.toDataURL("image/png"),
      box,
    });
  }
  return { img, entries };
}

async function sliceAtlasToSprites(png: string, json: any): Promise<PackerSprite[]> {
  const { entries } = await sliceAtlasFrames(png, json);
  return entries.map(({ name, dataURL }) => ({ name, dataURL }));
}

function dedupName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** ==================== layout mode ==================== */

function preserveLayout(): boolean {
  const box = $("packerPreserveLayout") as HTMLInputElement | null;
  return box ? box.checked : true;
}

/** True once the atlas is loaded well enough to repaint in place. */
function canPreserveLayout(): boolean {
  return !!(sheetImg && sheetJson && frames.length);
}

/** Frames sharing a sheet region are aliases of the same pixels: repainting
 *  one necessarily repaints the others, so they always move together. */
function aliasIndices(index: number): number[] {
  const box = frames[index]?.box;
  if (!box) return [];
  const sig = boxSignature(box);
  const out: number[] = [];
  frames.forEach((f, i) => {
    if (i !== index && boxSignature(f.box) === sig) out.push(i);
  });
  return out;
}

function setReplacement(index: number, rep: Replacement | null) {
  const targets = [index, ...aliasIndices(index)];
  for (const i of targets) {
    if (rep) replacements.set(i, rep);
    else replacements.delete(i);
  }
}

/** Replacements that no longer fit their frame's box — they must be cropped or
 *  scaled before the layout can be preserved. */
function unfittedIndices(): number[] {
  const out: number[] = [];
  replacements.forEach((rep, i) => {
    const box = frames[i]?.box;
    if (!box) return;
    if (rep.outW > box.w || rep.outH > box.h) out.push(i);
  });
  return out;
}

/** Render a source sprite as it will be painted into `box`. */
async function makeReplacement(
  box: Rect,
  source: PackerSprite,
  img: HTMLImageElement,
  choice:
    | { mode: "center" }
    | { mode: "crop"; x: number; y: number }
    | { mode: "scale" }
): Promise<Replacement> {
  const srcW = Math.max(1, img.naturalWidth || img.width);
  const srcH = Math.max(1, img.naturalHeight || img.height);
  const base = { source, srcW, srcH };

  if (choice.mode === "crop") {
    const c = document.createElement("canvas");
    c.width = box.w;
    c.height = box.h;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, -choice.x, -choice.y);
    return {
      ...base,
      mode: "crop",
      crop: { x: choice.x, y: choice.y },
      dataURL: c.toDataURL("image/png"),
      outW: box.w,
      outH: box.h,
    };
  }

  if (choice.mode === "scale") {
    const s = Math.min(box.w / srcW, box.h / srcH, 1);
    const outW = Math.max(1, Math.floor(srcW * s));
    const outH = Math.max(1, Math.floor(srcH * s));
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext("2d")!;
    // Nearest-neighbour: a blurred downscale would quietly wreck pixel art.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, outW, outH);
    return {
      ...base,
      mode: "scale",
      dataURL: c.toDataURL("image/png"),
      outW,
      outH,
    };
  }

  return {
    ...base,
    mode: "center",
    dataURL: source.dataURL,
    outW: srcW,
    outH: srcH,
  };
}

/** The frame's current pixels in the sheet — the mask the crop dialog ghosts
 *  over the replacement. */
function ghostForFrame(index: number): HTMLCanvasElement | null {
  const frame = frames[index];
  if (!frame || !sheetImg) return null;
  const { box } = frame;
  const c = document.createElement("canvas");
  c.width = box.w;
  c.height = box.h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheetImg, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return c;
}

/**
 * Walk the player through the crop dialog for every oversized pairing.
 * Returns false if they cancelled, which aborts the whole operation rather
 * than half-applying it.
 */
async function resolveOversized(
  jobs: Array<{ index: number; source: PackerSprite; img: HTMLImageElement }>,
  opts: { allowSkip: boolean }
): Promise<boolean> {
  const guardKey = atlasKey;
  const guardToken = atlasLoadToken;
  cropping = true;
  updateDock();
  try {
    for (let i = 0; i < jobs.length; i++) {
      const { index, source, img } = jobs[i];
      const frame = frames[index];
      if (!frame) continue;
      const existing = replacements.get(index);
      const result: CropResult = await openCropDialog({
        frameName: frame.name,
        sourceName: source.name,
        box: { w: frame.box.w, h: frame.box.h },
        ghost: ghostForFrame(index),
        source: img,
        step: i + 1,
        total: jobs.length,
        initial: existing?.crop,
        allowSkip: opts.allowSkip,
      });
      // The atlas can be swapped from under a long crop session; landing a
      // replacement on whatever loaded since would corrupt the wrong sheet.
      if (guardKey !== atlasKey || guardToken !== atlasLoadToken) return false;
      if (result.action === "cancel") return false;
      if (result.action === "skip") {
        setReplacement(index, null);
        continue;
      }
      const choice =
        result.action === "scale"
          ? ({ mode: "scale" } as const)
          : ({ mode: "crop", x: result.x, y: result.y } as const);
      setReplacement(index, await makeReplacement(frame.box, source, img, choice));
    }
    return true;
  } finally {
    cropping = false;
  }
}

/** ==================== current atlas panel ==================== */

function clearPendingState() {
  targetIndex = null;
  replacements.clear();
  additions = [];
}

async function loadPackerAtlas(key: string) {
  const token = ++atlasLoadToken;
  const status = $("packerAtlasStatus");
  atlasKey = "";
  frames = [];
  sheetImg = null;
  sheetJson = null;
  imageCache.clear();
  clearPendingState();
  if (!key) {
    if (status) status.textContent = "";
    renderCurrentGrid();
    updateDock();
    return;
  }
  if (status) status.textContent = `LOADING ${key}…`;
  renderCurrentGrid();
  updateDock();
  try {
    const atlas = await fetchAtlas(key);
    if (token !== atlasLoadToken) return; // a newer load superseded this one
    if (!atlas || !atlas.json || !atlas.png) {
      throw new Error("Atlas data incomplete");
    }
    // Editing then saving would silently drop anything we can't represent —
    // refuse those atlases instead of corrupting them.
    if (typeof atlas.json !== "object") {
      throw new Error("Atlas JSON is unreadable");
    }
    if (
      !atlas.json.frames &&
      Array.isArray(atlas.json.textures) &&
      atlas.json.textures.length > 1
    ) {
      throw new Error("Multi-texture atlas not supported");
    }
    const framesMap = framesByKey(atlas.json);
    if (Object.values(framesMap).some((f: any) => f?.rotated === true)) {
      throw new Error("Atlas contains rotated frames — not supported");
    }
    const sliced = await sliceAtlasFrames(atlas.png, atlas.json);
    if (token !== atlasLoadToken) return;
    frames = sliced.entries;
    sheetImg = sliced.img;
    sheetJson = atlas.json;
    atlasKey = key;
    if (status) {
      status.textContent =
        `${frames.length} FRAMES · SHEET ${sliced.img.naturalWidth}×${sliced.img.naturalHeight}`;
    }
  } catch (e: any) {
    if (token !== atlasLoadToken) return;
    console.error(e);
    if (status) status.textContent = `FAILED TO LOAD: ${e?.message || "unknown error"}`;
    // Keep the dropdown in sync so re-selecting the failed atlas fires change.
    const sel = $("packerAtlasSelect") as HTMLSelectElement | null;
    if (sel) sel.value = "";
  }
  if (token !== atlasLoadToken) return;
  renderCurrentGrid();
  updateDock();
}

function makeCellButton(
  label: string,
  title: string,
  cls: string,
  onClick: () => void
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls;
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return btn;
}

function renderCurrentGrid() {
  const grid = $("packerCurrentGrid") as HTMLDivElement | null;
  if (!grid) return;
  grid.innerHTML = "";

  const countEl = $("packerFrameCount");
  if (countEl) countEl.textContent = String(frames.length + additions.length);

  if (!frames.length && !additions.length) {
    const empty = document.createElement("div");
    empty.className = "pk-empty";
    empty.textContent = atlasKey
      ? "Atlas has no frames."
      : "Select an atlas to see its frames.";
    grid.appendChild(empty);
    return;
  }

  const preserve = preserveLayout();

  frames.forEach((frame, index) => {
    const replacement = replacements.get(index);
    const cell = document.createElement("div");
    cell.className = "pk-cell";
    cell.dataset.frameIndex = String(index);
    cell.title = replacement
      ? `${frame.name} — replaced with ${replacement.source.name}` +
        ` (${frame.box.w}×${frame.box.h} slot at ${frame.box.x},${frame.box.y})`
      : `${frame.name} — ${frame.box.w}×${frame.box.h} at ${frame.box.x},${frame.box.y}`;

    const img = document.createElement("img");
    img.src = replacement ? replacement.dataURL : frame.dataURL;
    cell.appendChild(img);

    const label = document.createElement("span");
    label.className = "pk-cell-label";
    label.textContent = frame.name;
    cell.appendChild(label);

    if (replacement) {
      cell.classList.add("replaced");
      const oversized =
        replacement.outW > frame.box.w || replacement.outH > frame.box.h;
      if (preserve && oversized) cell.classList.add("oversized");
      cell.appendChild(
        makeCellButton("↶", "Revert to original frame", "pk-cell-btn", () => {
          setReplacement(index, null);
          renderCurrentGrid();
          updateDock();
        })
      );
      // Anything the frame's box can't hold outright is the player's call —
      // offer the mask even when they already made it, so it can be nudged.
      const resizable =
        replacement.srcW > frame.box.w || replacement.srcH > frame.box.h;
      if (preserve && resizable) {
        cell.appendChild(
          makeCellButton(
            "✂",
            oversized
              ? "Too big for this frame — choose what to keep"
              : "Adjust what this replacement keeps",
            "pk-cell-btn pk-cell-btn2",
            () => void recropFrame(index)
          )
        );
      }
    }

    cell.addEventListener("click", () => {
      targetIndex = targetIndex === index ? null : index;
      updateCurrentGridClasses();
      updateDock();
    });

    grid.appendChild(cell);
  });

  additions.forEach((sprite, index) => {
    const cell = document.createElement("div");
    cell.className = "pk-cell added";
    cell.title = `${sprite.name} — new frame`;

    const img = document.createElement("img");
    img.src = sprite.dataURL;
    cell.appendChild(img);

    const label = document.createElement("span");
    label.className = "pk-cell-label";
    label.textContent = sprite.name;
    cell.appendChild(label);

    cell.appendChild(
      makeCellButton("✕", "Remove this new frame", "pk-cell-btn", () => {
        additions.splice(index, 1);
        renderCurrentGrid();
        updateDock();
      })
    );

    grid.appendChild(cell);
  });

  updateCurrentGridClasses();
}

/** Highlight the target frame and the frames the queued sources would land on. */
function updateCurrentGridClasses() {
  const grid = $("packerCurrentGrid") as HTMLDivElement | null;
  if (!grid) return;
  const n = selectedSources.length;
  for (const el of Array.from(grid.children)) {
    const cell = el as HTMLElement;
    const idxStr = cell.dataset?.frameIndex;
    if (idxStr === undefined) continue;
    const idx = Number(idxStr);
    cell.classList.toggle("target", targetIndex === idx);
    const pending =
      targetIndex !== null && n > 0 && idx > targetIndex && idx < targetIndex + n;
    cell.classList.toggle("pending", pending);
  }
}

/** ==================== available sprites panel ==================== */

/** After a source's entries are rebuilt, re-point queued selections at the
 *  fresh objects (matched by stable id) so badges and toggling keep working. */
function remapSelection(entries: PackerSprite[]) {
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id!, e]));
  selectedSources = selectedSources.map((s) => (s.id && byId.get(s.id)) || s);
}

async function loadAvailableSource(force = false) {
  const sel = $("packerSourceSelect") as HTMLSelectElement | null;
  const status = $("packerSourceStatus");
  const source = sel?.value || "sprites";
  const token = ++availableLoadToken;

  try {
    if (source === "uploads") {
      availableEntries = uploads;
      if (status) {
        status.textContent = uploads.length
          ? `${uploads.length} UPLOADED`
          : "NO UPLOADS YET — USE THE UPLOAD BUTTON";
      }
    } else if (source === "sprites") {
      if (!spriteCache || force) {
        if (status) status.textContent = "LOADING sprites/*…";
        const sprites = await fetchAllSprites();
        if (token !== availableLoadToken) return;
        spriteCache = Object.entries(sprites)
          .map(([name, val]): PackerSprite | null => {
            const png = typeof val === "string" ? val : (val as SpriteData)?.png;
            return png
              ? { name, dataURL: ensureDataURL(png), id: `sprites:${name}` }
              : null;
          })
          .filter((s): s is PackerSprite => !!s);
        remapSelection(spriteCache);
      }
      availableEntries = spriteCache;
      if (status) status.textContent = `${availableEntries.length} SPRITES — sprites/*`;
    } else if (source.startsWith("atlas:")) {
      const key = source.slice("atlas:".length);
      if (!atlasSourceCache.has(key) || force) {
        if (status) status.textContent = `LOADING ${key}…`;
        const atlas = await fetchAtlas(key);
        if (!atlas || !atlas.json || !atlas.png) {
          throw new Error("Atlas data incomplete");
        }
        const sliced = await sliceAtlasToSprites(atlas.png, atlas.json);
        if (token !== availableLoadToken) return;
        const withIds = sliced.map((s, i) => ({
          ...s,
          id: `atlas:${key}:${i}:${s.name}`,
        }));
        atlasSourceCache.set(key, withIds);
        remapSelection(withIds);
      }
      availableEntries = atlasSourceCache.get(key)!;
      if (status) status.textContent = `${availableEntries.length} FRAMES — ${key}`;
    }
  } catch (e: any) {
    if (token !== availableLoadToken) return;
    console.error(e);
    availableEntries = [];
    if (status) status.textContent = `FAILED TO LOAD: ${e?.message || "unknown error"}`;
  }

  if (token !== availableLoadToken) return;
  renderAvailableGrid();
  updateDock();
}

function renderAvailableGrid() {
  const grid = $("packerAvailableGrid") as HTMLDivElement | null;
  if (!grid) return;
  grid.innerHTML = "";

  if (!availableEntries.length) {
    const empty = document.createElement("div");
    empty.className = "pk-empty";
    empty.textContent = "No sprites in this source.";
    grid.appendChild(empty);
    return;
  }

  availableEntries.forEach((sprite) => {
    const cell = document.createElement("div") as HTMLDivElement & {
      _sprite?: PackerSprite;
    };
    cell.className = "pk-cell";
    cell.title = sprite.name;
    cell._sprite = sprite;

    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = sprite.dataURL;
    cell.appendChild(img);

    const label = document.createElement("span");
    label.className = "pk-cell-label";
    label.textContent = sprite.name;
    cell.appendChild(label);

    const badge = document.createElement("span");
    badge.className = "pk-badge";
    badge.style.display = "none";
    cell.appendChild(badge);

    cell.addEventListener("click", () => toggleSourceSelection(sprite));
    grid.appendChild(cell);
  });

  refreshAvailableSelectionUI();
}

function selectionIndexOf(sprite: PackerSprite): number {
  return selectedSources.findIndex((s) =>
    s.id && sprite.id ? s.id === sprite.id : s === sprite
  );
}

function toggleSourceSelection(sprite: PackerSprite) {
  const i = selectionIndexOf(sprite);
  if (i >= 0) selectedSources.splice(i, 1);
  else selectedSources.push(sprite);
  refreshAvailableSelectionUI();
  updateCurrentGridClasses();
  updateDock();
}

/** Sync selection outlines + order badges on the available grid. */
function refreshAvailableSelectionUI() {
  const grid = $("packerAvailableGrid") as HTMLDivElement | null;
  if (!grid) return;
  for (const el of Array.from(grid.children)) {
    const cell = el as HTMLElement & { _sprite?: PackerSprite };
    const sprite = cell._sprite;
    if (!sprite) continue;
    const order = selectionIndexOf(sprite);
    cell.classList.toggle("selected", order >= 0);
    const badge = cell.querySelector(".pk-badge") as HTMLElement | null;
    if (badge) {
      badge.style.display = order >= 0 ? "flex" : "none";
      badge.textContent = String(order + 1);
    }
  }
}

async function handlePackerUpload(fileList: FileList | File[] | null) {
  if (!fileList || !fileList.length) return;
  const files = Array.from(fileList).filter(
    (f) => f.type.startsWith("image/") || /\.(png|gif|webp|jpe?g)$/i.test(f.name)
  );
  if (!files.length) return;

  const added: PackerSprite[] = [];
  const taken = new Set(uploads.map((u) => u.name));
  for (const file of files) {
    try {
      const dataURL = await readFileAsDataURL(file);
      const base = file.name.replace(/\.[^.]+$/, "") || "sprite";
      const name = dedupName(base, taken);
      taken.add(name);
      const sprite: PackerSprite = { name, dataURL, id: `uploads:${name}` };
      uploads.push(sprite);
      added.push(sprite);
    } catch (e) {
      console.error(e);
    }
  }
  if (!added.length) return;

  // Show the uploads source and queue the new sprites as replacements in
  // upload order — the player already picked the target, so this completes
  // the "select frame, then replacement(s)" flow in one step.
  const sel = $("packerSourceSelect") as HTMLSelectElement | null;
  if (sel) sel.value = "uploads";
  selectedSources.push(...added);
  await loadAvailableSource();
  updateCurrentGridClasses();
  updateDock();
}

/** ==================== actions ==================== */

async function applyReplace() {
  if (cropping || saving) return;
  if (targetIndex === null || !selectedSources.length || !frames.length) return;

  const start = targetIndex;
  const queued = selectedSources.slice(0, Math.max(0, frames.length - start));
  const skipped = selectedSources.length - queued.length;
  if (!queued.length) return;

  const guardKey = atlasKey;
  const guardToken = atlasLoadToken;
  const preserve = preserveLayout() && canPreserveLayout();
  // Backing out of the crop queue has to restore whatever was pending before,
  // not wipe replacements the player had already settled on these frames.
  const priorReplacements = new Map(replacements);

  let sized: Array<{ index: number; source: PackerSprite; img: HTMLImageElement }>;
  try {
    sized = await Promise.all(
      queued.map(async (source, i) => ({
        index: start + i,
        source,
        img: await getImage(source.dataURL),
      }))
    );
  } catch (e: any) {
    console.error(e);
    setStatus(`COULD NOT READ REPLACEMENT: ${e?.message || "unknown error"}`);
    return;
  }
  if (guardKey !== atlasKey || guardToken !== atlasLoadToken) return;

  // Everything that already fits lands straight away; the rest goes through
  // the mask so the player says what to keep.
  const oversized: typeof sized = [];
  for (const job of sized) {
    const frame = frames[job.index];
    if (!frame) continue;
    const tooBig =
      job.img.naturalWidth > frame.box.w || job.img.naturalHeight > frame.box.h;
    if (preserve && tooBig) {
      oversized.push(job);
      continue;
    }
    setReplacement(
      job.index,
      await makeReplacement(frame.box, job.source, job.img, { mode: "center" })
    );
  }

  if (oversized.length) {
    const ok = await resolveOversized(oversized, { allowSkip: true });
    if (!ok) {
      // Cancelling backs the whole batch out rather than leaving a partly
      // applied replace the player didn't ask for.
      replacements = priorReplacements;
      setStatus("REPLACE CANCELLED");
      renderCurrentGrid();
      updateDock();
      return;
    }
  }

  const landed = sized.filter((job) => replacements.has(job.index));
  const resized = landed.filter(
    (job) => replacements.get(job.index)!.mode !== "center"
  ).length;
  const dropped = sized.length - landed.length;
  const notes: string[] = [];
  if (resized) notes.push(`${resized} RESIZED TO FIT`);
  if (dropped) notes.push(`${dropped} LEFT AS-IS`);
  if (skipped > 0) notes.push(`SKIPPED ${skipped} PAST END OF ATLAS`);
  setStatus(
    `REPLACED ${landed.length} FRAME(S)${notes.length ? ` — ${notes.join(" · ")}` : ""}`
  );

  targetIndex = null;
  selectedSources = [];
  renderCurrentGrid();
  refreshAvailableSelectionUI();
  updateDock();
}

/** Re-open the mask for a replacement that is bigger than its frame's box. */
async function recropFrame(index: number) {
  if (cropping || saving) return;
  const rep = replacements.get(index);
  const frame = frames[index];
  if (!rep || !frame) return;
  let img: HTMLImageElement;
  try {
    img = await getImage(rep.source.dataURL);
  } catch (e: any) {
    console.error(e);
    setStatus(`COULD NOT READ REPLACEMENT: ${e?.message || "unknown error"}`);
    return;
  }
  await resolveOversized([{ index, source: rep.source, img }], { allowSkip: false });
  renderCurrentGrid();
  updateDock();
}

function applyAddAsNew() {
  if (!selectedSources.length || !atlasKey) return;
  const taken = new Set<string>([
    ...frames.map((f) => f.name),
    ...additions.map((a) => a.name),
  ]);
  for (const s of selectedSources) {
    const name = dedupName(s.name, taken);
    taken.add(name);
    additions.push({ name, dataURL: s.dataURL });
  }
  setStatus(`ADDED ${selectedSources.length} NEW FRAME(S)`);
  selectedSources = [];
  renderCurrentGrid();
  refreshAvailableSelectionUI();
  updateDock();
}

function clearSelection() {
  targetIndex = null;
  selectedSources = [];
  refreshAvailableSelectionUI();
  updateCurrentGridClasses();
  updateDock();
}

function resetPacker() {
  if (!atlasKey) return;
  if (
    (replacements.size || additions.length) &&
    !confirm("Discard all pending changes?")
  ) {
    return;
  }
  clearPendingState();
  selectedSources = [];
  renderCurrentGrid();
  refreshAvailableSelectionUI();
  updateDock();
}

/** Repack from scratch — every frame is re-laid-out on a fresh uniform grid. */
async function buildRepacked(): Promise<{ dataURL: string; json: any }> {
  // Built from a snapshot so later state changes can't alter the payload.
  // Names are uniquified in case two RTDB keys decode to the same name —
  // a collapsed map would silently drop frames.
  const named: Record<string, string> = {};
  const taken = new Set<string>();
  frames.forEach((frame, i) => {
    const name = dedupName(frame.name, taken);
    taken.add(name);
    named[name] = replacements.get(i)?.dataURL ?? frame.dataURL;
  });
  additions.forEach((s) => {
    const name = dedupName(s.name, taken);
    taken.add(name);
    named[name] = s.dataURL;
  });
  return buildAtlas(named);
}

/** Repaint the original sheet in place, leaving untouched frames byte-identical. */
async function buildPreserved(): Promise<{ dataURL: string; json: any }> {
  if (!sheetImg || !sheetJson) throw new Error("Original atlas is not loaded");

  const paints = new Map<number, SlotPaint>();
  for (const [index, rep] of replacements) {
    paints.set(index, {
      image: await getImage(rep.dataURL),
      w: rep.outW,
      h: rep.outH,
    });
  }

  const adds: AdditionPaint[] = [];
  for (const add of additions) {
    const img = await getImage(add.dataURL);
    adds.push({
      name: add.name,
      image: img,
      w: img.naturalWidth || img.width,
      h: img.naturalHeight || img.height,
    });
  }

  const built = rebuildPreservingLayout(
    sheetImg,
    sheetImg.naturalWidth || sheetImg.width,
    sheetImg.naturalHeight || sheetImg.height,
    sheetJson,
    frames,
    paints,
    adds
  );
  return { dataURL: built.dataURL, json: built.json };
}

async function savePackerAtlas() {
  if (saving || cropping || !atlasKey) return;
  const changeCount = replacements.size + additions.length;
  if (!changeCount) return;

  const preserve = preserveLayout() && canPreserveLayout();

  // Nothing can be written in the original layout while a replacement still
  // overflows its frame — send those back through the mask first.
  if (preserve) {
    const unfitted = unfittedIndices();
    if (unfitted.length) {
      const jobs: Array<{
        index: number;
        source: PackerSprite;
        img: HTMLImageElement;
      }> = [];
      for (const index of unfitted) {
        const rep = replacements.get(index);
        if (!rep) continue;
        jobs.push({ index, source: rep.source, img: await getImage(rep.source.dataURL) });
      }
      const ok = await resolveOversized(jobs, { allowSkip: true });
      renderCurrentGrid();
      updateDock();
      if (!ok) {
        setStatus("SAVE CANCELLED — REPLACEMENTS STILL LARGER THAN THEIR FRAMES");
        return;
      }
      if (!replacements.size && !additions.length) return;
    }
  }

  // Snapshot the key before any await: the module-level atlasKey is mutable,
  // and saving to a stale/blank key would overwrite the wrong RTDB node.
  const key = atlasKey;
  const total = frames.length + additions.length;
  if (
    !confirm(
      `Save "${key}" to Firebase?\n` +
        `${replacements.size} frame(s) replaced, ${additions.length} added — ${total} total frames.\n` +
        (preserve
          ? "Original layout preserved — untouched frames keep their exact rects."
          : "Full repack — every frame is repositioned on a new grid.")
    )
  ) {
    return;
  }

  saving = true;
  const saveBtn = $("packerSaveBtn") as HTMLButtonElement | null;
  const atlasSel = $("packerAtlasSelect") as HTMLSelectElement | null;
  const labelEl = saveBtn?.querySelector(".label") as HTMLElement | null;
  const prevLabel = labelEl?.textContent || "SAVE TO CLOUD";
  if (labelEl) labelEl.textContent = "SAVING…";
  if (saveBtn) saveBtn.disabled = true;
  if (atlasSel) atlasSel.disabled = true;

  try {
    const { dataURL, json } = preserve ? await buildPreserved() : await buildRepacked();
    if (!key) throw new Error("No atlas key"); // never write to the atlases root
    await saveAtlas(key, { json, png: dataURL });

    atlasSourceCache.delete(key); // this atlas is stale as a source now
    setStatus(
      preserve
        ? `ATLAS "${key}" SAVED TO CLOUD — LAYOUT PRESERVED`
        : `ATLAS "${key}" REPACKED AND SAVED TO CLOUD`
    );
    if (atlasKey === key) {
      await loadPackerAtlas(key);
    }
  } catch (e: any) {
    console.error(e);
    alert(`Failed to save atlas: ${e?.message || "unknown error"}`);
  } finally {
    saving = false;
    if (labelEl) labelEl.textContent = prevLabel;
    if (atlasSel) atlasSel.disabled = false;
    updateDock();
  }
}

/** ==================== dock / hints ==================== */

function makeMapRow(): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "pk-map-row";
  return row;
}

function makeThumb(dataURL: string): HTMLImageElement {
  const img = document.createElement("img");
  img.src = dataURL;
  return img;
}

function updateDock() {
  const targetInfo = $("packerTargetInfo") as HTMLDivElement | null;
  const sourceInfo = $("packerSourceInfo") as HTMLDivElement | null;
  const replaceBtn = $("packerReplaceBtn") as HTMLButtonElement | null;
  const addBtn = $("packerAddBtn") as HTMLButtonElement | null;
  const clearBtn = $("packerClearBtn") as HTMLButtonElement | null;
  const resetBtn = $("packerResetBtn") as HTMLButtonElement | null;
  const saveBtn = $("packerSaveBtn") as HTMLButtonElement | null;
  const changesInfo = $("packerChangesInfo") as HTMLDivElement | null;
  const pendingCount = $("packerPendingCount");
  if (!targetInfo || !sourceInfo) return;

  // Target frame
  targetInfo.innerHTML = "";
  if (targetIndex !== null && frames[targetIndex]) {
    const frame = frames[targetIndex];
    const row = makeMapRow();
    row.appendChild(makeThumb(frame.dataURL));
    const name = document.createElement("span");
    name.className = "pk-map-name";
    name.textContent = frame.name;
    row.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "pk-map-meta";
    meta.textContent = `${frame.box.w}×${frame.box.h} · ${targetIndex + 1}/${frames.length}`;
    row.appendChild(meta);
    targetInfo.appendChild(row);
    targetInfo.className = "pk-map-list";
  } else {
    targetInfo.className = "sx-empty-hint";
    targetInfo.textContent = frames.length
      ? "No target — click a frame in CURRENT ATLAS FRAMES."
      : "Load an atlas, then click the frame to replace.";
  }

  // Selected replacement sources, in click order, mapped onto frames
  sourceInfo.innerHTML = "";
  if (!selectedSources.length) {
    sourceInfo.className = "sx-empty-hint";
    sourceInfo.textContent =
      "No sprites selected. Click sprites in AVAILABLE SPRITES — order matters.";
  } else {
    sourceInfo.className = "pk-map-list";
    selectedSources.forEach((s, i) => {
      const row = makeMapRow();
      const order = document.createElement("span");
      order.className = "pk-map-order";
      order.textContent = String(i + 1);
      row.appendChild(order);
      row.appendChild(makeThumb(s.dataURL));
      const name = document.createElement("span");
      name.className = "pk-map-name";
      name.textContent = s.name;
      row.appendChild(name);
      if (targetIndex !== null) {
        const dest = frames[targetIndex + i];
        const meta = document.createElement("span");
        meta.className = "pk-map-meta";
        meta.textContent = dest ? `→ ${dest.name}` : "→ (past end)";
        row.appendChild(meta);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pk-map-remove";
      remove.textContent = "✕";
      remove.title = "Remove from selection";
      remove.addEventListener("click", () => toggleSourceSelection(s));
      row.appendChild(remove);
      sourceInfo.appendChild(row);
    });
  }

  const busy = saving || cropping;
  const replaceCount =
    targetIndex !== null && frames.length
      ? Math.min(selectedSources.length, frames.length - targetIndex)
      : 0;
  if (replaceBtn) {
    replaceBtn.disabled = replaceCount === 0 || busy;
    replaceBtn.textContent =
      replaceCount > 0 ? `↻ REPLACE ${replaceCount} FRAME(S)` : "↻ REPLACE";
  }
  if (addBtn) addBtn.disabled = !selectedSources.length || !atlasKey || busy;
  if (clearBtn) clearBtn.disabled = (!selectedSources.length && targetIndex === null) || busy;

  const changeCount = replacements.size + additions.length;
  if (changesInfo) {
    if (!changeCount) {
      changesInfo.textContent = "No pending changes.";
    } else {
      const cropped = [...replacements.values()].filter(
        (r) => r.mode !== "center"
      ).length;
      changesInfo.textContent =
        `${replacements.size} REPLACED · ${additions.length} ADDED` +
        (preserveLayout() && cropped ? ` · ${cropped} RESIZED` : "");
    }
  }
  if (pendingCount) {
    pendingCount.textContent = changeCount ? `${changeCount} PENDING` : "";
  }
  if (resetBtn) resetBtn.disabled = !changeCount || busy;
  if (saveBtn) saveBtn.disabled = !changeCount || !atlasKey || busy;

  updateHint();
}

function updateHint() {
  const hint = $("packerHint");
  if (!hint) return;
  const n = selectedSources.length;
  if (cropping) {
    hint.textContent = "ALIGN THE MASK OVER WHAT YOU WANT TO KEEP";
  } else if (!atlasKey) {
    hint.textContent = "SELECT AN ATLAS TO EDIT";
  } else if (targetIndex === null && !n) {
    hint.textContent = "CLICK A FRAME TO SET REPLACE TARGET";
  } else if (targetIndex !== null && !n) {
    const frame = frames[targetIndex];
    hint.textContent = frame
      ? `TARGET SET — FRAME SLOT IS ${frame.box.w}×${frame.box.h}`
      : "TARGET SET — SELECT REPLACEMENT SPRITE(S) BELOW";
  } else if (targetIndex !== null && n) {
    const take = Math.min(n, frames.length - targetIndex);
    const skipped = n - take;
    hint.textContent =
      skipped > 0
        ? `WILL REPLACE ${take} FRAME(S) — ${skipped} PAST END SKIPPED`
        : `WILL REPLACE ${take} FRAME(S) FROM ${frames[targetIndex]?.name ?? ""}`;
  } else {
    hint.textContent = `${n} SPRITE(S) SELECTED — SET A TARGET OR ADD AS NEW`;
  }
}

/** ==================== wiring ==================== */

/** Fill the packer dropdowns; called whenever the atlas list is (re)fetched. */
export function setPackerAtlasNames(names: string[]) {
  const sorted = [...names].sort();

  const atlasSel = $("packerAtlasSelect") as HTMLSelectElement | null;
  if (atlasSel) {
    const prev = atlasSel.value;
    atlasSel.innerHTML = "";
    atlasSel.appendChild(new Option("-- Select an atlas --", ""));
    sorted.forEach((n) => atlasSel.appendChild(new Option(n, n)));
    if (prev && sorted.includes(prev)) atlasSel.value = prev;
    atlasSel.disabled = false;
  }

  const sourceSel = $("packerSourceSelect") as HTMLSelectElement | null;
  if (sourceSel) {
    const prev = sourceSel.value || "sprites";
    sourceSel.innerHTML = "";
    sourceSel.appendChild(new Option("FIREBASE SPRITES — sprites/*", "sprites"));
    sourceSel.appendChild(new Option("UPLOADED SPRITES", "uploads"));
    const group = document.createElement("optgroup");
    group.label = "ATLAS FRAMES";
    sorted.forEach((n) => group.appendChild(new Option(`atlas: ${n}`, `atlas:${n}`)));
    sourceSel.appendChild(group);
    sourceSel.value = prev;
    if (sourceSel.selectedIndex < 0) {
      // The previous source vanished (e.g. its atlas was deleted); fall back
      // and resync the grid so it doesn't keep showing the stale source.
      sourceSel.value = "sprites";
      if (firstShowDone && prev !== "sprites") void loadAvailableSource();
    }
  }
}

export function initPackerTab() {
  ($("packerAtlasSelect") as HTMLSelectElement | null)?.addEventListener(
    "change",
    async (ev) => {
      const sel = ev.target as HTMLSelectElement;
      if (saving || cropping) {
        sel.value = atlasKey;
        return;
      }
      if (
        (replacements.size || additions.length) &&
        !confirm("Discard pending changes for the current atlas?")
      ) {
        sel.value = atlasKey;
        return;
      }
      await loadPackerAtlas(sel.value);
    }
  );

  ($("packerPreserveLayout") as HTMLInputElement | null)?.addEventListener(
    "change",
    () => {
      // Frames that overflow their box only matter in preserve mode, so the
      // grid's warnings and crop buttons come and go with the toggle.
      renderCurrentGrid();
      updateDock();
    }
  );

  ($("packerSourceSelect") as HTMLSelectElement | null)?.addEventListener(
    "change",
    () => loadAvailableSource()
  );
  ($("packerRefreshSourceBtn") as HTMLButtonElement | null)?.addEventListener(
    "click",
    () => loadAvailableSource(true)
  );
  ($("packerUploadInput") as HTMLInputElement | null)?.addEventListener(
    "change",
    async (ev) => {
      const input = ev.target as HTMLInputElement;
      await handlePackerUpload(input.files);
      input.value = "";
    }
  );

  // Same thing by drag & drop: anywhere on the PACKER tab uploads sprites.
  wireFileDrop(
    document.querySelector('[data-sx-panel="packer"]'),
    $("packerAvailableGrid"),
    (files) => {
      const images = files.filter(isImageFile);
      if (!images.length) {
        setStatus("DROPPED FILES ARE NOT IMAGES");
        return;
      }
      handlePackerUpload(images);
    }
  );

  $("packerReplaceBtn")?.addEventListener("click", () => void applyReplace());
  $("packerAddBtn")?.addEventListener("click", applyAddAsNew);
  $("packerClearBtn")?.addEventListener("click", clearSelection);
  $("packerResetBtn")?.addEventListener("click", resetPacker);
  $("packerSaveBtn")?.addEventListener("click", () => void savePackerAtlas());

  // Lazy-load the default sprite source the first time the tab is shown.
  const panel = document.querySelector('[data-sx-panel="packer"]') as HTMLElement | null;
  if (panel) {
    const maybeLoad = () => {
      if (!panel.hidden && !firstShowDone) {
        firstShowDone = true;
        loadAvailableSource();
      }
    };
    new MutationObserver(maybeLoad).observe(panel, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
    maybeLoad();
  }

  renderCurrentGrid();
  updateDock();
}
