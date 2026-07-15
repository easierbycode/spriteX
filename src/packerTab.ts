// src/packerTab.ts
// PACKER tab — PackerScene-style atlas frame replacement.
//
// The current atlas frames and the available sprites (Firebase sprites/*,
// frames from any other atlas, or local uploads) are visible side by side.
// The player clicks a frame in the atlas to set the replace target, then
// selects one or more replacement sprites; N selected sprites replace N
// consecutive frames starting at the target (extras past the end of the
// atlas are skipped). Selected sprites can also be appended as new frames.
// Saving repacks the atlas and writes it back to RTDB (atlases/{key}).

import {
  fetchAtlas,
  fetchAllSprites,
  buildAtlas,
  saveAtlas,
  decodeAtlasFrameKey,
  type SpriteData,
} from "./atlasManager";

interface PackerSprite {
  name: string;
  dataURL: string;
  /** Stable identity for selection tracking across source reloads. */
  id?: string;
}

// Current atlas being edited
let atlasKey = "";
let frames: PackerSprite[] = []; // original frames, in atlas order
let replacements = new Map<number, PackerSprite>(); // frame index -> replacement
let additions: PackerSprite[] = []; // frames appended via ADD AS NEW
let targetIndex: number | null = null; // anchor frame for the next replace
let selectedSources: PackerSprite[] = []; // replacements, in click order

// Available-sprites panel
let uploads: PackerSprite[] = [];
let availableEntries: PackerSprite[] = [];
let spriteCache: PackerSprite[] | null = null; // sprites/* entries
const atlasSourceCache = new Map<string, PackerSprite[]>();
let availableLoadToken = 0;

let atlasLoadToken = 0;
let saving = false;
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

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/** Frames map from atlas JSON — handles top-level/texture frames and the
 *  Phaser multi-atlas array form. */
function getFramesMap(json: any): Record<string, any> {
  if (!json) return {};
  const raw = json.frames ?? json.textures?.[0]?.frames;
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const map: Record<string, any> = {};
    raw.forEach((f: any, i: number) => {
      if (f && f.frame) map[f.filename ?? String(i)] = f;
    });
    return map;
  }
  return raw;
}

/** Tight source rect for a frame. Untrimmed spriteX-style atlases center the
 *  sprite inside a uniform cell via spriteSourceSize — crop to the sprite so
 *  replacements and repacks don't accumulate cell padding. */
function frameSourceRect(
  entry: any
): { x: number; y: number; w: number; h: number } | null {
  const f = entry?.frame;
  if (!f || typeof f.w !== "number" || typeof f.h !== "number") return null;
  const ss = entry.spriteSourceSize;
  if (!entry.trimmed && ss && ss.w > 0 && ss.h > 0 && ss.w <= f.w && ss.h <= f.h) {
    return { x: f.x + (ss.x || 0), y: f.y + (ss.y || 0), w: ss.w, h: ss.h };
  }
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

async function sliceAtlasToSprites(png: string, json: any): Promise<PackerSprite[]> {
  const img = await loadImage(ensureDataURL(png));
  const map = getFramesMap(json);
  const out: PackerSprite[] = [];
  for (const key of Object.keys(map)) {
    const entry = map[key];
    const rect = frameSourceRect(entry);
    if (!rect) continue;
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
    out.push({
      name: decodeAtlasFrameKey(entry?.filename ?? key),
      dataURL: c.toDataURL("image/png"),
    });
  }
  return out;
}

function dedupName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
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
    const framesMap = getFramesMap(atlas.json);
    if (Object.values(framesMap).some((f: any) => f?.rotated === true)) {
      throw new Error("Atlas contains rotated frames — not supported");
    }
    const sliced = await sliceAtlasToSprites(atlas.png, atlas.json);
    if (token !== atlasLoadToken) return;
    frames = sliced;
    atlasKey = key;
    if (status) status.textContent = `${frames.length} FRAMES`;
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

  frames.forEach((frame, index) => {
    const replacement = replacements.get(index);
    const cell = document.createElement("div");
    cell.className = "pk-cell";
    cell.dataset.frameIndex = String(index);
    cell.title = replacement
      ? `${frame.name} — replaced with ${replacement.name}`
      : frame.name;

    const img = document.createElement("img");
    img.src = (replacement ?? frame).dataURL;
    cell.appendChild(img);

    const label = document.createElement("span");
    label.className = "pk-cell-label";
    label.textContent = frame.name;
    cell.appendChild(label);

    if (replacement) {
      cell.classList.add("replaced");
      const revert = document.createElement("button");
      revert.type = "button";
      revert.className = "pk-cell-btn";
      revert.textContent = "↶";
      revert.title = "Revert to original frame";
      revert.addEventListener("click", (ev) => {
        ev.stopPropagation();
        replacements.delete(index);
        renderCurrentGrid();
        updateDock();
      });
      cell.appendChild(revert);
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

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pk-cell-btn";
    remove.textContent = "✕";
    remove.title = "Remove this new frame";
    remove.addEventListener("click", (ev) => {
      ev.stopPropagation();
      additions.splice(index, 1);
      renderCurrentGrid();
      updateDock();
    });
    cell.appendChild(remove);

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

async function handlePackerUpload(fileList: FileList | null) {
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

function applyReplace() {
  if (targetIndex === null || !selectedSources.length || !frames.length) return;
  const take = Math.min(selectedSources.length, frames.length - targetIndex);
  for (let i = 0; i < take; i++) {
    replacements.set(targetIndex + i, selectedSources[i]);
  }
  const skipped = selectedSources.length - take;
  setStatus(
    skipped > 0
      ? `REPLACED ${take} FRAME(S) — SKIPPED ${skipped} PAST END OF ATLAS`
      : `REPLACED ${take} FRAME(S)`
  );
  targetIndex = null;
  selectedSources = [];
  renderCurrentGrid();
  refreshAvailableSelectionUI();
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

async function savePackerAtlas() {
  if (saving || !atlasKey) return;
  const changeCount = replacements.size + additions.length;
  if (!changeCount) return;

  // Snapshot the key before any await: the module-level atlasKey is mutable,
  // and saving to a stale/blank key would overwrite the wrong RTDB node.
  const key = atlasKey;
  const total = frames.length + additions.length;
  if (
    !confirm(
      `Repack "${key}" and save to Firebase?\n` +
        `${replacements.size} frame(s) replaced, ${additions.length} added — ${total} total frames.`
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
    // Built synchronously so later state changes can't alter the payload.
    // Names are uniquified in case two RTDB keys decode to the same name —
    // a collapsed map would silently drop frames.
    const named: Record<string, string> = {};
    const taken = new Set<string>();
    frames.forEach((frame, i) => {
      const name = dedupName(frame.name, taken);
      taken.add(name);
      named[name] = (replacements.get(i) ?? frame).dataURL;
    });
    additions.forEach((s) => {
      const name = dedupName(s.name, taken);
      taken.add(name);
      named[name] = s.dataURL;
    });

    const { dataURL, json } = await buildAtlas(named);
    if (!key) throw new Error("No atlas key"); // never write to the atlases root
    await saveAtlas(key, { json, png: dataURL });

    atlasSourceCache.delete(key); // this atlas is stale as a source now
    setStatus(`ATLAS "${key}" SAVED TO CLOUD`);
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
    const row = makeMapRow();
    row.appendChild(makeThumb(frames[targetIndex].dataURL));
    const name = document.createElement("span");
    name.className = "pk-map-name";
    name.textContent = frames[targetIndex].name;
    row.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "pk-map-meta";
    meta.textContent = `FRAME ${targetIndex + 1}/${frames.length}`;
    row.appendChild(meta);
    targetInfo.appendChild(row);
  } else {
    targetInfo.className = "sx-empty-hint";
    targetInfo.textContent = frames.length
      ? "No target — click a frame in CURRENT ATLAS FRAMES."
      : "Load an atlas, then click the frame to replace.";
  }
  if (targetIndex !== null && frames[targetIndex]) {
    targetInfo.className = "pk-map-list";
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

  const replaceCount =
    targetIndex !== null && frames.length
      ? Math.min(selectedSources.length, frames.length - targetIndex)
      : 0;
  if (replaceBtn) {
    replaceBtn.disabled = replaceCount === 0;
    replaceBtn.textContent =
      replaceCount > 0 ? `↻ REPLACE ${replaceCount} FRAME(S)` : "↻ REPLACE";
  }
  if (addBtn) addBtn.disabled = !selectedSources.length || !atlasKey;
  if (clearBtn) clearBtn.disabled = !selectedSources.length && targetIndex === null;

  const changeCount = replacements.size + additions.length;
  if (changesInfo) {
    changesInfo.textContent = changeCount
      ? `${replacements.size} REPLACED · ${additions.length} ADDED`
      : "No pending changes.";
  }
  if (pendingCount) {
    pendingCount.textContent = changeCount ? `${changeCount} PENDING` : "";
  }
  if (resetBtn) resetBtn.disabled = !changeCount;
  if (saveBtn) saveBtn.disabled = !changeCount || !atlasKey || saving;

  updateHint();
}

function updateHint() {
  const hint = $("packerHint");
  if (!hint) return;
  const n = selectedSources.length;
  if (!atlasKey) {
    hint.textContent = "SELECT AN ATLAS TO EDIT";
  } else if (targetIndex === null && !n) {
    hint.textContent = "CLICK A FRAME TO SET REPLACE TARGET";
  } else if (targetIndex !== null && !n) {
    hint.textContent = "TARGET SET — SELECT REPLACEMENT SPRITE(S) BELOW";
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
      if (saving) {
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

  $("packerReplaceBtn")?.addEventListener("click", applyReplace);
  $("packerAddBtn")?.addEventListener("click", applyAddAsNew);
  $("packerClearBtn")?.addEventListener("click", clearSelection);
  $("packerResetBtn")?.addEventListener("click", resetPacker);
  $("packerSaveBtn")?.addEventListener("click", savePackerAtlas);

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
