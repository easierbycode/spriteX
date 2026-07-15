// src/tilemapEditor.ts
// Tiled JSON tilemap editor for the TILEMAP tab.
// - Upload a Tiled map JSON + tileset JSON + tileset PNG (file input or drag & drop)
// - Render tile layers + object layers on a zoomable canvas
// - Edit: place/erase tiles on tile layers, add/delete/rename objects on object layers
// - Grid cursor driven by mouse, keyboard, or gamepad (see gamepad.ts)
// - Download the edited map JSON, or save/load via RTDB tilemaps/*

import { getDB, ref, get, set } from "./firebase-config";

/** ============================ Types ============================ */

export interface TiledProperty {
  name: string;
  type?: string;
  value: any;
}

export interface TiledTilesetEntry {
  firstgid?: number;
  source?: string;
  name?: string;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  tilewidth?: number;
  tileheight?: number;
  margin?: number;
  spacing?: number;
  columns?: number;
  tilecount?: number;
  tiles?: Array<{ id: number; properties?: TiledProperty[] }>;
  [k: string]: any;
}

export interface TiledObject {
  id: number;
  name?: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  visible?: boolean;
  gid?: number;
  point?: boolean;
  ellipse?: boolean;
  properties?: TiledProperty[];
  [k: string]: any;
}

export interface TiledLayer {
  id?: number;
  name: string;
  type: string; // "tilelayer" | "objectgroup" | ...
  visible?: boolean;
  opacity?: number;
  data?: number[] | string;
  encoding?: string;
  compression?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  objects?: TiledObject[];
  draworder?: string;
  [k: string]: any;
}

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTilesetEntry[];
  nextlayerid?: number;
  nextobjectid?: number;
  infinite?: boolean;
  type?: string;
  [k: string]: any;
}

type EditorDeps = {
  downloadFile: (filename: string, content: string, type: string) => void;
  setStatus: (msg: string) => void;
};

/** ====================== GID flip-flag masks ==================== */

const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;
const FLIP_D = 0x20000000;
const GID_MASK = 0x1fffffff;

/** ============================ State ============================ */

let deps: EditorDeps = {
  downloadFile: () => {},
  setStatus: () => {},
};

let map: TiledMap | null = null;
let mapFileName = "";
let tilesetImage: HTMLImageElement | null = null;
let tilesetImageDataURL = "";
let externalTilesetJson: any | null = null;

// Resolved tileset params (actual image dimensions win, Phaser-style).
const ts = {
  firstgid: 1,
  name: "tiles",
  tilewidth: 8,
  tileheight: 8,
  margin: 0,
  spacing: 0,
  columns: 1,
  tilecount: 0,
};
let collideByTileId = new Map<number, boolean>();

// Flattened, editable view of the layer tree (group layers contribute their
// children, not themselves). Rebuilt on load and when layers are added.
type FlatLayer = {
  layer: TiledLayer;
  depth: number;
  groupVisible: boolean; // ancestors' visibility
  groupOpacity: number; // product of ancestors' opacity
  label: string;
};
let flatLayers: FlatLayer[] = [];

let activeLayerIndex = 0; // index into flatLayers
let selectedGid = 1; // 0 = eraser
let cursor: { cx: number; cy: number } = { cx: 0, cy: 0 };
let zoom = 3;
let showGrid = true;
let inspectedObject: TiledObject | null = null;
let mapDirty = false;

// Drag-paint strokes push a single undo snapshot for the whole stroke.
let strokeActive = false;
let strokePushed = false;

const PALETTE_SCALE = 2;

type UndoEntry =
  | { kind: "tiles"; layerIndex: number; data: number[]; nextobjectid?: number }
  | { kind: "objects"; layerIndex: number; objects: TiledObject[]; nextobjectid?: number };
const undoStack: UndoEntry[] = [];
const UNDO_LIMIT = 60;

// Pending upload pieces (user may drop files one at a time).
let pendingMapJson: TiledMap | null = null;
let pendingMapName = "";
let pendingTilesetJson: any | null = null;
let pendingPngDataURL = "";
let pendingPngName = "";

let baseCanvas: HTMLCanvasElement;
let baseCtx: CanvasRenderingContext2D;
let overlayCanvas: HTMLCanvasElement;
let overlayCtx: CanvasRenderingContext2D;

function $(id: string) {
  return document.getElementById(id);
}

function activeTab(): string {
  return (
    document.querySelector(".sx-tab.active")?.getAttribute("data-sx-tab") ||
    "extract"
  );
}

function setStatus(msg: string) {
  deps.setStatus(msg);
}

/** =========================== Helpers =========================== */

function isTileLayer(layer: TiledLayer): boolean {
  return layer.type === "tilelayer";
}

function isObjectLayer(layer: TiledLayer): boolean {
  return layer.type === "objectgroup";
}

function rebuildFlatLayers() {
  flatLayers = [];
  if (!map) return;
  const walk = (
    layers: TiledLayer[],
    depth: number,
    groupVisible: boolean,
    groupOpacity: number,
    prefix: string
  ) => {
    for (const l of layers) {
      if (l.type === "group") {
        walk(
          ((l as any).layers as TiledLayer[]) || [],
          depth + 1,
          groupVisible && l.visible !== false,
          groupOpacity * (l.opacity ?? 1),
          `${prefix}${l.name || "group"}/`
        );
      } else {
        flatLayers.push({
          layer: l,
          depth,
          groupVisible,
          groupOpacity,
          label: `${prefix}${l.name || "layer"}`,
        });
      }
    }
  };
  walk(map.layers, 0, true, 1, "");
}

function activeLayer(): TiledLayer | null {
  return flatLayers[activeLayerIndex]?.layer || null;
}

function forEachLayer(fn: (layer: TiledLayer) => void) {
  for (const fl of flatLayers) fn(fl.layer);
}

function maxObjectId(): number {
  let m = 0;
  forEachLayer((l) => {
    if (!isObjectLayer(l)) return;
    for (const o of l.objects || []) m = Math.max(m, o.id || 0);
  });
  return m;
}

function maxLayerId(): number {
  let m = 0;
  if (!map) return m;
  const walk = (layers: TiledLayer[]) => {
    for (const l of layers) {
      m = Math.max(m, l.id || 0);
      if (l.type === "group") walk(((l as any).layers as TiledLayer[]) || []);
    }
  };
  walk(map.layers);
  return m;
}

function layerData(layer: TiledLayer): number[] {
  return Array.isArray(layer.data) ? layer.data : [];
}

function decodeLayerDataInPlace(layer: TiledLayer) {
  if (Array.isArray(layer.data)) return;
  if (typeof layer.data === "string") {
    if (layer.compression) {
      throw new Error(
        `Layer "${layer.name}" uses compressed tile data (${layer.compression}); re-export from Tiled as CSV or uncompressed base64.`
      );
    }
    const bin = atob(layer.data);
    const out: number[] = new Array(Math.floor(bin.length / 4));
    for (let i = 0; i < out.length; i++) {
      const j = i * 4;
      out[i] =
        (bin.charCodeAt(j) |
          (bin.charCodeAt(j + 1) << 8) |
          (bin.charCodeAt(j + 2) << 16) |
          (bin.charCodeAt(j + 3) << 24)) >>>
        0;
    }
    layer.data = out;
    delete layer.encoding;
    delete layer.compression;
  }
}

function tilePropertiesSource(): Array<{ id: number; properties?: TiledProperty[] }> {
  const ext = externalTilesetJson;
  if (ext && Array.isArray(ext.tiles)) return ext.tiles;
  const entry = map?.tilesets?.[0];
  if (entry && Array.isArray(entry.tiles)) return entry.tiles;
  return [];
}

function rebuildCollideMap() {
  collideByTileId = new Map();
  for (const t of tilePropertiesSource()) {
    const prop = (t.properties || []).find((p) => p.name === "collide");
    if (prop) collideByTileId.set(t.id, !!prop.value);
  }
}

/** ====================== Loading / files ======================== */

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    r.readAsText(file);
  });
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    r.readAsDataURL(file);
  });
}

function looksLikeMap(json: any): boolean {
  return (
    json &&
    (json.type === "map" || (Array.isArray(json.layers) && json.width != null))
  );
}

function looksLikeTileset(json: any): boolean {
  return (
    json &&
    (json.type === "tileset" ||
      (json.columns != null && json.image != null && json.layers == null))
  );
}

export async function tilemapLoadFiles(files: File[]): Promise<void> {
  for (const file of files) {
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith(".png") || file.type === "image/png") {
        pendingPngDataURL = await readFileAsDataURL(file);
        pendingPngName = file.name;
      } else if (lower.endsWith(".json") || file.type === "application/json") {
        const json = JSON.parse(await readFileAsText(file));
        if (looksLikeMap(json)) {
          pendingMapJson = json as TiledMap;
          pendingMapName = file.name.replace(/\.json$/i, "");
        } else if (looksLikeTileset(json)) {
          pendingTilesetJson = json;
        } else {
          setStatus(`UNRECOGNIZED JSON: ${file.name.toUpperCase()}`);
        }
      }
    } catch (err: any) {
      console.error(err);
      setStatus(`FAILED TO READ ${file.name.toUpperCase()}`);
    }
  }
  if (pendingMapJson && pendingPngDataURL) {
    await initFromPending();
    refreshFileStatus();
    return;
  }

  // A tileset JSON dropped on its own re-slices the already-loaded map.
  if (map && pendingTilesetJson && !pendingMapJson && !pendingPngDataURL) {
    externalTilesetJson = pendingTilesetJson;
    pendingTilesetJson = null;
    resolveTilesetParams();
    rebuildCollideMap();
    rebuildBase();
    drawTilemapOverlay();
    renderPalette();
    updatePaletteInfo();
    setStatus("TILESET JSON APPLIED");
  }
  refreshFileStatus();
}

function refreshFileStatus() {
  const el = $("tilemapFileStatus");
  if (!el) return;
  if (map && !pendingMapJson && !pendingPngDataURL) {
    el.textContent = `LOADED: ${mapFileName} — DROP NEW FILES TO REPLACE`;
    return;
  }
  const needsExternal = !!pendingMapJson?.tilesets?.[0]?.source;
  const parts = [
    pendingMapJson ? `MAP: ${pendingMapName}` : "MAP: missing",
    pendingTilesetJson
      ? "TILESET JSON: ok"
      : needsExternal
        ? `TILESET JSON: required (${pendingMapJson!.tilesets![0].source})`
        : "TILESET JSON: optional",
    pendingPngDataURL ? `PNG: ${pendingPngName}` : "PNG: missing",
  ];
  el.textContent = parts.join(" | ");
}

async function initFromPending() {
  const mj = pendingMapJson!;
  if (mj.infinite) {
    setStatus("INFINITE MAPS NOT SUPPORTED");
    alert("Infinite Tiled maps are not supported. Re-export with a fixed size.");
    return;
  }
  try {
    const decodeWalk = (layers: TiledLayer[]) => {
      for (const layer of layers) {
        if (isTileLayer(layer)) decodeLayerDataInPlace(layer);
        else if (layer.type === "group") {
          decodeWalk(((layer as any).layers as TiledLayer[]) || []);
        }
      }
    };
    decodeWalk(mj.layers);
  } catch (err: any) {
    alert(err?.message || "Failed to decode layer data.");
    return;
  }

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load tileset image"));
    img.src = pendingPngDataURL;
  }).catch((err) => {
    alert(err.message);
    throw err;
  });

  map = mj;
  mapFileName = pendingMapName || "tilemap";
  tilesetImage = img;
  tilesetImageDataURL = pendingPngDataURL;
  externalTilesetJson = pendingTilesetJson;
  undoStack.length = 0;
  inspectedObject = null;
  mapDirty = false;

  // Consume the pending pieces so a later upload starts a fresh set — a stale
  // tileset JSON from the previous map must not contaminate the next one.
  pendingMapJson = null;
  pendingMapName = "";
  pendingTilesetJson = null;
  pendingPngDataURL = "";
  pendingPngName = "";

  resolveTilesetParams();
  rebuildCollideMap();
  rebuildFlatLayers();

  activeLayerIndex = Math.max(
    0,
    flatLayers.findIndex((fl) => isTileLayer(fl.layer))
  );
  selectedGid = ts.firstgid;
  cursor = { cx: 0, cy: 0 };
  zoom = Math.max(1, Math.min(6, Math.round(24 / Math.max(1, map.tileheight))));

  // Name follows the loaded map so saves can't silently target the
  // previously loaded map's cloud entry.
  const nameInput = $("tilemapNameInput") as HTMLInputElement | null;
  if (nameInput) nameInput.value = mapFileName;

  ($("tilemapDownloadBtn") as HTMLButtonElement | null)?.removeAttribute("disabled");
  ($("tilemapSaveCloudBtn") as HTMLButtonElement | null)?.removeAttribute("disabled");
  ($("tilemapDownloadTilesetBtn") as HTMLButtonElement | null)?.removeAttribute("disabled");

  const dims = $("tilemapDims");
  if (dims) {
    dims.textContent = `${map.width}×${map.height} @ ${map.tilewidth}px`;
  }

  resizeCanvases();
  rebuildBase();
  drawTilemapOverlay();
  renderLayersList();
  renderPalette();
  updateInfoChip();
  updatePaletteInfo();
  renderObjectInspector();

  const firstEntry = map.tilesets?.[0];
  if ((map.tilesets || []).length > 1) {
    setStatus("MAP HAS MULTIPLE TILESETS — USING FIRST ONLY");
  } else if (firstEntry?.source && !externalTilesetJson) {
    setStatus(
      `MAP USES EXTERNAL TILESET "${firstEntry.source.toUpperCase()}" — UPLOAD IT FOR CORRECT TILE GEOMETRY`
    );
  } else {
    setStatus(`TILEMAP LOADED · ${mapFileName.toUpperCase()}`);
  }
}

function resolveTilesetParams() {
  const entry: TiledTilesetEntry = map?.tilesets?.[0] || {};
  const ext = externalTilesetJson || {};
  ts.firstgid = entry.firstgid || 1;
  ts.name = ext.name || entry.name || "tiles";
  ts.tilewidth = ext.tilewidth || entry.tilewidth || map?.tilewidth || 8;
  ts.tileheight = ext.tileheight || entry.tileheight || map?.tileheight || 8;
  ts.margin = ext.margin ?? entry.margin ?? 0;
  ts.spacing = ext.spacing ?? entry.spacing ?? 0;

  // Like Phaser, trust the actual image dimensions over any stale JSON
  // metadata (the map's embedded tileset often predates image growth).
  const img = tilesetImage!;
  ts.columns = Math.max(
    1,
    Math.floor(
      (img.naturalWidth - ts.margin * 2 + ts.spacing) /
        (ts.tilewidth + ts.spacing)
    )
  );
  const rows = Math.max(
    1,
    Math.floor(
      (img.naturalHeight - ts.margin * 2 + ts.spacing) /
        (ts.tileheight + ts.spacing)
    )
  );
  ts.tilecount = ts.columns * rows;
}

/** ========================= Rendering =========================== */

function resizeCanvases() {
  if (!map) return;
  const w = map.width * map.tilewidth;
  const h = map.height * map.tileheight;
  baseCanvas.width = w;
  baseCanvas.height = h;
  overlayCanvas.width = w;
  overlayCanvas.height = h;
  applyZoom();
}

function applyZoom() {
  if (!map) return;
  const w = map.width * map.tilewidth * zoom;
  const h = map.height * map.tileheight * zoom;
  baseCanvas.style.width = `${w}px`;
  baseCanvas.style.height = `${h}px`;
  overlayCanvas.style.width = `${w}px`;
  overlayCanvas.style.height = `${h}px`;
  const zoomBtn = $("tilemapZoomBtn");
  if (zoomBtn) zoomBtn.textContent = `ZOOM: ${zoom}x`;
}

function drawGid(ctx: CanvasRenderingContext2D, rawGid: number, dx: number, dy: number, dw?: number, dh?: number) {
  const gid = rawGid & GID_MASK;
  const tw = ts.tilewidth;
  const th = ts.tileheight;
  const outW = dw ?? tw;
  const outH = dh ?? th;
  const id = gid - ts.firstgid;

  if (!tilesetImage || id < 0 || id >= ts.tilecount) {
    ctx.fillStyle = "rgba(255,0,255,0.6)";
    ctx.fillRect(dx, dy, outW, outH);
    return;
  }

  const sx = ts.margin + (id % ts.columns) * (tw + ts.spacing);
  const sy = ts.margin + Math.floor(id / ts.columns) * (th + ts.spacing);

  const flipH = !!(rawGid & FLIP_H);
  const flipV = !!(rawGid & FLIP_V);
  const flipD = !!(rawGid & FLIP_D);

  if (!flipH && !flipV && !flipD) {
    ctx.drawImage(tilesetImage, sx, sy, tw, th, dx, dy, outW, outH);
    return;
  }

  ctx.save();
  ctx.translate(dx + outW / 2, dy + outH / 2);
  // Tiled applies the diagonal flip to the tile image first, then H/V.
  // Canvas composes transforms so the last call acts on the image first —
  // hence H/V scale must be issued before the diagonal rotate/scale pair.
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  if (flipD) {
    ctx.rotate(Math.PI / 2);
    ctx.scale(1, -1);
  }
  ctx.drawImage(tilesetImage, sx, sy, tw, th, -outW / 2, -outH / 2, outW, outH);
  ctx.restore();
}

export function rebuildBase() {
  if (!map) return;
  baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
  baseCtx.imageSmoothingEnabled = false;

  for (const fl of flatLayers) {
    const layer = fl.layer;
    if (!fl.groupVisible || layer.visible === false) continue;
    baseCtx.globalAlpha = fl.groupOpacity * (layer.opacity ?? 1);

    if (isTileLayer(layer)) {
      const data = layerData(layer);
      const lw = layer.width ?? map.width;
      const lh = layer.height ?? map.height;
      // Tiles taller/wider than the map grid anchor at the cell's
      // bottom-left in Tiled, extending up/right.
      const dyOff = map.tileheight - ts.tileheight;
      for (let i = 0; i < data.length; i++) {
        const gid = data[i];
        if (!gid) continue;
        const cx = i % lw;
        const cy = Math.floor(i / lw);
        if (cy >= lh) break;
        drawGid(baseCtx, gid, cx * map.tilewidth, cy * map.tileheight + dyOff);
      }
    } else if (isObjectLayer(layer)) {
      for (const obj of layer.objects || []) {
        if (obj.visible === false) continue;
        if (obj.gid) {
          const w = obj.width || map.tilewidth;
          const h = obj.height || map.tileheight;
          const rot = ((obj.rotation || 0) * Math.PI) / 180;
          if (rot) {
            // Tiled rotates tile objects clockwise around their
            // bottom-left anchor.
            baseCtx.save();
            baseCtx.translate(obj.x, obj.y);
            baseCtx.rotate(rot);
            drawGid(baseCtx, obj.gid, 0, -h, w, h);
            baseCtx.restore();
          } else {
            drawGid(baseCtx, obj.gid, obj.x, obj.y - h, w, h);
          }
        }
      }
    }
  }
  baseCtx.globalAlpha = 1;
}

function objectBounds(obj: TiledObject): { x: number; y: number; w: number; h: number } {
  const w = obj.width || (map ? map.tilewidth : 8);
  const h = obj.height || (map ? map.tileheight : 8);
  if (obj.gid) return { x: obj.x, y: obj.y - h, w, h };
  if (obj.point) return { x: obj.x - 3, y: obj.y - 3, w: 6, h: 6 };
  return { x: obj.x, y: obj.y, w, h };
}

export function drawTilemapOverlay() {
  if (!map) return;
  const w = overlayCanvas.width;
  const h = overlayCanvas.height;
  overlayCtx.clearRect(0, 0, w, h);

  const tw = map.tilewidth;
  const th = map.tileheight;

  if (showGrid) {
    overlayCtx.strokeStyle = "rgba(140,255,110,0.14)";
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    for (let x = 0; x <= map.width; x++) {
      overlayCtx.moveTo(x * tw + 0.5, 0);
      overlayCtx.lineTo(x * tw + 0.5, h);
    }
    for (let y = 0; y <= map.height; y++) {
      overlayCtx.moveTo(0, y * th + 0.5);
      overlayCtx.lineTo(w, y * th + 0.5);
    }
    overlayCtx.stroke();
  }

  // Object outlines for every object layer; the active layer is brighter.
  flatLayers.forEach((fl, li) => {
    const layer = fl.layer;
    if (!isObjectLayer(layer) || !fl.groupVisible || layer.visible === false) return;
    const isActive = li === activeLayerIndex;
    for (const obj of layer.objects || []) {
      const b = objectBounds(obj);
      const isInspected = obj === inspectedObject;
      overlayCtx.lineWidth = isInspected ? 2 : 1;
      overlayCtx.strokeStyle = isInspected
        ? "rgba(246,255,74,0.95)"
        : isActive
          ? "rgba(0,200,255,0.9)"
          : "rgba(0,200,255,0.35)";
      const rot = ((obj.rotation || 0) * Math.PI) / 180;
      if (rot) {
        // Rotate the outline around the object's Tiled anchor
        // (bottom-left for tile objects, top-left for shapes).
        overlayCtx.save();
        if (obj.gid) {
          overlayCtx.translate(obj.x, obj.y);
          overlayCtx.rotate(rot);
          overlayCtx.strokeRect(0.5, -b.h + 0.5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
        } else {
          overlayCtx.translate(obj.x, obj.y);
          overlayCtx.rotate(rot);
          overlayCtx.strokeRect(0.5, 0.5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
        }
        overlayCtx.restore();
      } else if (obj.ellipse) {
        overlayCtx.beginPath();
        overlayCtx.ellipse(
          b.x + b.w / 2,
          b.y + b.h / 2,
          b.w / 2,
          b.h / 2,
          0,
          0,
          Math.PI * 2
        );
        overlayCtx.stroke();
      } else {
        overlayCtx.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
      }
    }
  });

  // Cursor cell highlight
  overlayCtx.lineWidth = Math.max(1, Math.round(2 / Math.max(1, zoom / 2)));
  overlayCtx.strokeStyle = "rgba(246,255,74,0.95)";
  overlayCtx.strokeRect(
    cursor.cx * tw + 0.5,
    cursor.cy * th + 0.5,
    tw - 1,
    th - 1
  );
}

/** ===================== Layers list / palette =================== */

function renderLayersList() {
  const cont = $("tilemapLayersList") as HTMLDivElement | null;
  if (!cont) return;
  cont.innerHTML = "";
  cont.classList.remove("sx-empty-hint");

  if (!map) {
    cont.classList.add("sx-empty-hint");
    cont.textContent = "Load a tilemap to see layers.";
    return;
  }

  flatLayers.forEach((fl, i) => {
    const layer = fl.layer;
    const row = document.createElement("div");
    row.className = "tm-layer-row" + (i === activeLayerIndex ? " active" : "");
    row.dataset.layerIndex = String(i);
    if (fl.depth > 0) row.style.marginLeft = `${fl.depth * 14}px`;

    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = layer.visible !== false;
    vis.title = "Toggle layer visibility";
    vis.addEventListener("click", (ev) => ev.stopPropagation());
    vis.addEventListener("change", () => {
      layer.visible = vis.checked;
      rebuildBase();
      drawTilemapOverlay();
    });

    const name = document.createElement("span");
    name.className = "tm-layer-name";
    name.textContent = fl.label || `layer ${i}`;

    const badge = document.createElement("span");
    badge.className = "tm-layer-badge";
    badge.textContent = isTileLayer(layer)
      ? "TILES"
      : isObjectLayer(layer)
        ? `OBJ ${(layer.objects || []).length}`
        : layer.type.toUpperCase();

    row.appendChild(vis);
    row.appendChild(name);
    row.appendChild(badge);
    row.addEventListener("click", () => {
      setActiveLayer(i);
    });
    cont.appendChild(row);
  });
}

function setActiveLayer(i: number) {
  if (!map || !flatLayers.length) return;
  activeLayerIndex = Math.max(0, Math.min(flatLayers.length - 1, i));
  inspectedObject = null;
  renderLayersList();
  renderObjectInspector();
  drawTilemapOverlay();
  updateInfoChip();
  const layer = activeLayer();
  if (layer) setStatus(`LAYER · ${layer.name.toUpperCase()} (${layer.type.toUpperCase()})`);
}

export function tilemapCycleLayer(d: number) {
  if (!map || !flatLayers.length) return;
  setActiveLayer(
    (activeLayerIndex + d + flatLayers.length) % flatLayers.length
  );
}

function renderPalette() {
  const canvas = $("tilemapPaletteCanvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d")!;

  if (!map || !tilesetImage) {
    canvas.width = 10;
    canvas.height = 10;
    ctx.clearRect(0, 0, 10, 10);
    return;
  }

  const tw = ts.tilewidth;
  const th = ts.tileheight;
  const cols = ts.columns;
  const rows = Math.ceil(ts.tilecount / cols);
  const s = PALETTE_SCALE;

  canvas.width = cols * tw * s;
  canvas.height = rows * th * s;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let id = 0; id < ts.tilecount; id++) {
    const cx = id % cols;
    const cy = Math.floor(id / cols);
    const sx = ts.margin + cx * (tw + ts.spacing);
    const sy = ts.margin + cy * (th + ts.spacing);
    ctx.drawImage(
      tilesetImage,
      sx, sy, tw, th,
      cx * tw * s, cy * th * s, tw * s, th * s
    );
    if (collideByTileId.get(id)) {
      ctx.fillStyle = "rgba(255,80,80,0.9)";
      ctx.fillRect(cx * tw * s + tw * s - 3, cy * th * s, 3, 3);
    }
  }

  // Selected tile highlight
  if (selectedGid >= ts.firstgid) {
    const id = selectedGid - ts.firstgid;
    if (id < ts.tilecount) {
      const cx = id % cols;
      const cy = Math.floor(id / cols);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(246,255,74,0.95)";
      ctx.strokeRect(cx * tw * s + 1, cy * th * s + 1, tw * s - 2, th * s - 2);
    }
  }

  const eraserBtn = $("tilemapEraserBtn");
  if (eraserBtn) eraserBtn.classList.toggle("active", selectedGid === 0);
}

function updatePaletteInfo() {
  const el = $("tilemapPaletteInfo");
  if (!el) return;
  if (!map || !tilesetImage) {
    el.textContent = "NO TILESET LOADED";
    return;
  }
  if (selectedGid === 0) {
    el.textContent = "ERASER — PLACES EMPTY (GID 0)";
    return;
  }
  const id = selectedGid - ts.firstgid;
  const collide = collideByTileId.get(id) ? " · COLLIDE" : "";
  el.textContent = `TILE ${id} · GID ${selectedGid}${collide} · ${ts.name} ${ts.columns}×${Math.ceil(ts.tilecount / ts.columns)}`;
}

function selectGid(gid: number) {
  selectedGid = gid;
  renderPalette();
  updatePaletteInfo();
  updateInfoChip();
}

function updateInfoChip() {
  const el = $("tilemapInfoChip");
  if (!el) return;
  if (!map) {
    el.textContent = "NO MAP LOADED";
    return;
  }
  const fl = flatLayers[activeLayerIndex];
  const gidLabel = selectedGid === 0 ? "ERASE" : `GID ${selectedGid}`;
  el.textContent = `${fl ? fl.label : "-"} · CELL ${cursor.cx},${cursor.cy} · ${gidLabel}`;
}

/** ====================== Editing operations ===================== */

function pushUndo() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer) return;
  // One snapshot per drag-paint stroke, not per painted cell.
  if (strokeActive) {
    if (strokePushed) return;
    strokePushed = true;
  }
  if (isTileLayer(layer)) {
    undoStack.push({
      kind: "tiles",
      layerIndex: activeLayerIndex,
      data: layerData(layer).slice(),
      nextobjectid: map.nextobjectid,
    });
  } else if (isObjectLayer(layer)) {
    undoStack.push({
      kind: "objects",
      layerIndex: activeLayerIndex,
      objects: JSON.parse(JSON.stringify(layer.objects || [])),
      nextobjectid: map.nextobjectid,
    });
  }
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

export function tilemapUndo() {
  if (!map || !undoStack.length) return;
  const entry = undoStack.pop()!;
  const layer = flatLayers[entry.layerIndex]?.layer;
  if (!layer) return;
  if (entry.kind === "tiles") {
    layer.data = entry.data;
  } else {
    layer.objects = entry.objects;
    inspectedObject = null;
  }
  if (entry.nextobjectid != null) map.nextobjectid = entry.nextobjectid;
  mapDirty = true;
  rebuildBase();
  drawTilemapOverlay();
  renderLayersList();
  renderObjectInspector();
  setStatus("UNDO");
}

function cellIndex(layer: TiledLayer, cx: number, cy: number): number {
  const lw = layer.width ?? map!.width;
  return cy * lw + cx;
}

function hitObjectAt(px: number, py: number): TiledObject | null {
  const layer = activeLayer();
  if (!layer || !isObjectLayer(layer)) return null;
  const objs = layer.objects || [];
  for (let i = objs.length - 1; i >= 0; i--) {
    const b = objectBounds(objs[i]);
    if (px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) {
      return objs[i];
    }
  }
  return null;
}

export function tilemapPlace() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer) return;

  if (isTileLayer(layer)) {
    const idx = cellIndex(layer, cursor.cx, cursor.cy);
    const data = layerData(layer);
    if (idx < 0 || idx >= data.length) return;
    if (data[idx] === selectedGid) return;
    pushUndo();
    data[idx] = selectedGid;
    mapDirty = true;
    rebuildBase();
    drawTilemapOverlay();
    setStatus(
      selectedGid === 0
        ? `ERASED TILE ${cursor.cx},${cursor.cy}`
        : `PLACED GID ${selectedGid} AT ${cursor.cx},${cursor.cy}`
    );
    return;
  }

  if (isObjectLayer(layer)) {
    pushUndo();
    if (!layer.objects) layer.objects = [];
    const tw = map.tilewidth;
    const th = map.tileheight;
    // Object ids must be unique across the whole map, not just this layer.
    const id = Math.max(map.nextobjectid || 1, maxObjectId() + 1);
    const obj: TiledObject =
      selectedGid > 0
        ? {
            id,
            gid: selectedGid,
            name: "",
            type: "",
            rotation: 0,
            visible: true,
            width: tw,
            height: th,
            x: cursor.cx * tw,
            y: (cursor.cy + 1) * th, // tile objects anchor bottom-left
          }
        : {
            id,
            name: "",
            type: "",
            rotation: 0,
            visible: true,
            width: tw,
            height: th,
            x: cursor.cx * tw,
            y: cursor.cy * th,
          };
    layer.objects.push(obj);
    map.nextobjectid = id + 1;
    mapDirty = true;
    inspectedObject = obj;
    rebuildBase();
    drawTilemapOverlay();
    renderLayersList();
    renderObjectInspector();
    setStatus(`ADDED OBJECT #${id}${selectedGid ? ` (GID ${selectedGid})` : ""}`);
  }
}

export function tilemapDelete() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer) return;

  if (isTileLayer(layer)) {
    const idx = cellIndex(layer, cursor.cx, cursor.cy);
    const data = layerData(layer);
    if (idx < 0 || idx >= data.length || !data[idx]) return;
    pushUndo();
    data[idx] = 0;
    mapDirty = true;
    rebuildBase();
    drawTilemapOverlay();
    setStatus(`ERASED TILE ${cursor.cx},${cursor.cy}`);
    return;
  }

  if (isObjectLayer(layer)) {
    const tw = map.tilewidth;
    const th = map.tileheight;
    const px = cursor.cx * tw + tw / 2;
    const py = cursor.cy * th + th / 2;
    const obj = hitObjectAt(px, py);
    if (!obj) {
      setStatus("NO OBJECT AT CURSOR");
      return;
    }
    pushUndo();
    layer.objects = (layer.objects || []).filter((o) => o !== obj);
    if (inspectedObject === obj) inspectedObject = null;
    mapDirty = true;
    rebuildBase();
    drawTilemapOverlay();
    renderLayersList();
    renderObjectInspector();
    setStatus(`DELETED OBJECT #${obj.id}`);
  }
}

export function tilemapPick() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer) return;

  if (isTileLayer(layer)) {
    const idx = cellIndex(layer, cursor.cx, cursor.cy);
    const data = layerData(layer);
    const gid = (data[idx] || 0) & GID_MASK;
    if (gid > 0) {
      selectGid(gid);
      setStatus(`PICKED GID ${gid}`);
    } else {
      setStatus("EMPTY CELL — NOTHING TO PICK");
    }
    return;
  }

  if (isObjectLayer(layer)) {
    const tw = map.tilewidth;
    const th = map.tileheight;
    const obj = hitObjectAt(cursor.cx * tw + tw / 2, cursor.cy * th + th / 2);
    if (obj?.gid) {
      selectGid(obj.gid & GID_MASK);
      setStatus(`PICKED GID ${obj.gid & GID_MASK} FROM OBJECT #${obj.id}`);
    } else if (obj) {
      inspectedObject = obj;
      renderObjectInspector();
      drawTilemapOverlay();
      setStatus(`INSPECTING OBJECT #${obj.id}`);
    }
  }
}

export function tilemapToggleGrid() {
  showGrid = !showGrid;
  const btn = $("tilemapGridBtn");
  if (btn) btn.classList.toggle("active", showGrid);
  drawTilemapOverlay();
}

export function tilemapToggleActiveLayerVisibility() {
  const layer = activeLayer();
  if (!layer) return;
  layer.visible = layer.visible === false;
  rebuildBase();
  drawTilemapOverlay();
  renderLayersList();
}

function addObjectLayer() {
  if (!map) {
    alert("Load a tilemap first.");
    return;
  }
  // Layer ids must be unique map-wide (including inside groups).
  const id = Math.max(map.nextlayerid || 1, maxLayerId() + 1);
  const layer: TiledLayer = {
    draworder: "topdown",
    id,
    name: `objects_${id}`,
    objects: [],
    opacity: 1,
    type: "objectgroup",
    visible: true,
    x: 0,
    y: 0,
  };
  map.layers.push(layer);
  map.nextlayerid = id + 1;
  mapDirty = true;
  rebuildFlatLayers();
  setActiveLayer(flatLayers.length - 1);
  setStatus(`ADDED OBJECT LAYER "${layer.name.toUpperCase()}"`);
}

/** ================ Cursor movement / hit testing ================ */

export function tilemapLoaded(): boolean {
  return !!map;
}

function clampCursor() {
  if (!map) return;
  cursor.cx = Math.max(0, Math.min(map.width - 1, cursor.cx));
  cursor.cy = Math.max(0, Math.min(map.height - 1, cursor.cy));
}

function afterCursorMove() {
  clampCursor();
  updateHoveredObject();
  drawTilemapOverlay();
  updateInfoChip();
}

function updateHoveredObject() {
  if (!map) return;
  const layer = activeLayer();
  if (!layer || !isObjectLayer(layer)) return;
  const tw = map.tilewidth;
  const th = map.tileheight;
  const obj = hitObjectAt(cursor.cx * tw + tw / 2, cursor.cy * th + th / 2);
  if (obj) {
    inspectedObject = obj;
    renderObjectInspector();
  }
}

function scrollCursorIntoView() {
  if (!map) return;
  const container = $("tilemapCanvasContainer") as HTMLDivElement | null;
  if (!container) return;
  const tw = map.tilewidth * zoom;
  const th = map.tileheight * zoom;
  const x = cursor.cx * tw;
  const y = cursor.cy * th;
  const margin = 2 * tw;

  if (x < container.scrollLeft + margin) {
    container.scrollLeft = Math.max(0, x - margin);
  } else if (x + tw > container.scrollLeft + container.clientWidth - margin) {
    container.scrollLeft = x + tw + margin - container.clientWidth;
  }
  if (y < container.scrollTop + th) {
    container.scrollTop = Math.max(0, y - th);
  } else if (y + th > container.scrollTop + container.clientHeight - th) {
    container.scrollTop = y + 2 * th - container.clientHeight;
  }
}

/**
 * Move the grid cursor by whole cells (keyboard / gamepad d-pad).
 * Returns the cursor cell's center in client (viewport) coordinates so the
 * gamepad's virtual pointer can warp onto it.
 */
export function tilemapMoveCursor(dx: number, dy: number): { x: number; y: number } | null {
  if (!map) return null;
  cursor.cx += dx;
  cursor.cy += dy;
  afterCursorMove();
  scrollCursorIntoView();
  return tilemapCursorClientPos();
}

export function tilemapCursorClientPos(): { x: number; y: number } | null {
  if (!map) return null;
  const rect = overlayCanvas.getBoundingClientRect();
  const tw = map.tilewidth * zoom;
  const th = map.tileheight * zoom;
  return {
    x: rect.left + cursor.cx * tw + tw / 2,
    y: rect.top + cursor.cy * th + th / 2,
  };
}

/**
 * Pure hit test: is this client coordinate over the map canvas?
 * Unlike tilemapSetCursorFromClient this never mutates the grid cursor,
 * so it is safe to call every frame.
 */
export function tilemapClientPointOnMap(clientX: number, clientY: number): boolean {
  if (!map) return false;
  const container = $("tilemapCanvasContainer");
  if (!container) return false;
  const cRect = container.getBoundingClientRect();
  if (
    clientX < cRect.left ||
    clientY < cRect.top ||
    clientX >= cRect.right ||
    clientY >= cRect.bottom
  ) {
    return false;
  }
  const rect = overlayCanvas.getBoundingClientRect();
  const cx = Math.floor((clientX - rect.left) / (map.tilewidth * zoom));
  const cy = Math.floor((clientY - rect.top) / (map.tileheight * zoom));
  return cx >= 0 && cy >= 0 && cx < map.width && cy < map.height;
}

/**
 * Point the grid cursor at the cell under a client coordinate.
 * Returns true when the coordinate is over the map canvas.
 */
export function tilemapSetCursorFromClient(clientX: number, clientY: number): boolean {
  if (!map) return false;
  const container = $("tilemapCanvasContainer");
  if (!container) return false;
  const cRect = container.getBoundingClientRect();
  if (
    clientX < cRect.left ||
    clientY < cRect.top ||
    clientX >= cRect.right ||
    clientY >= cRect.bottom
  ) {
    return false;
  }
  const rect = overlayCanvas.getBoundingClientRect();
  const cx = Math.floor((clientX - rect.left) / (map.tilewidth * zoom));
  const cy = Math.floor((clientY - rect.top) / (map.tileheight * zoom));
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return false;
  if (cx !== cursor.cx || cy !== cursor.cy) {
    cursor.cx = cx;
    cursor.cy = cy;
    afterCursorMove();
  }
  return true;
}

/** ====================== Object inspector ======================= */

function renderObjectInspector() {
  const wrap = $("tilemapObjectInspector") as HTMLDivElement | null;
  if (!wrap) return;
  const layer = activeLayer();
  const show = !!(layer && isObjectLayer(layer));
  wrap.style.display = show ? "flex" : "none";
  if (!show) return;

  const info = $("tilemapObjInfo");
  const nameInput = $("tilemapObjName") as HTMLInputElement | null;
  const typeInput = $("tilemapObjType") as HTMLInputElement | null;

  if (!inspectedObject) {
    if (info) info.textContent = "NO OBJECT UNDER CURSOR";
    if (nameInput) {
      nameInput.value = "";
      nameInput.disabled = true;
    }
    if (typeInput) {
      typeInput.value = "";
      typeInput.disabled = true;
    }
    return;
  }

  const o = inspectedObject;
  if (info) {
    info.textContent = `#${o.id} · ${o.gid ? `GID ${o.gid & GID_MASK}` : "SHAPE"} · ${Math.round(o.x)},${Math.round(o.y)}`;
  }
  if (nameInput) {
    nameInput.disabled = false;
    nameInput.value = o.name || "";
  }
  if (typeInput) {
    typeInput.disabled = false;
    typeInput.value = o.type || "";
  }
}

/** ==================== Download / cloud sync ==================== */

function serializeMap(): string {
  return JSON.stringify(map, null, 1);
}

function sanitizeKey(name: string): string {
  return name.replace(/[.#$\[\]\/]/g, "_");
}

function downloadMapJson() {
  if (!map) {
    alert("Load a tilemap first.");
    return;
  }
  const nameInput = $("tilemapNameInput") as HTMLInputElement | null;
  const name = (nameInput?.value.trim() || mapFileName || "tilemap");
  deps.downloadFile(`${name}.json`, serializeMap(), "application/json");
  mapDirty = false;
}

async function saveTilemapToCloud() {
  if (!map) {
    alert("Load a tilemap first.");
    return;
  }
  const nameInput = $("tilemapNameInput") as HTMLInputElement | null;
  const rawName = (nameInput?.value.trim() || mapFileName || "tilemap");
  const key = sanitizeKey(rawName);

  try {
    const db = getDB();
    await set(ref(db, `tilemaps/${key}`), {
      json: serializeMap(),
      tileset: externalTilesetJson ? JSON.stringify(externalTilesetJson) : null,
      png: tilesetImageDataURL || null,
    });
    mapDirty = false;
    setStatus(`SAVED · tilemaps/${key}`);
    alert(`Tilemap "${key}" saved to RTDB (tilemaps/${key}).`);
    await populateTilemapSelect();
  } catch (err: any) {
    console.error(err);
    alert(`Failed to save tilemap: ${err?.message || "unknown error"}`);
  }
}

async function populateTilemapSelect() {
  const select = $("tilemapSelect") as HTMLSelectElement | null;
  if (!select) return;

  const setOptions = (labels: string[], values: string[], disabled: boolean) => {
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- Load from cloud --";
    select.appendChild(placeholder);
    labels.forEach((label, i) => {
      const opt = document.createElement("option");
      opt.value = values[i];
      opt.textContent = label;
      select.appendChild(opt);
    });
    select.disabled = disabled;
  };

  try {
    // Shallow REST query: keys only, no payload download.
    const dbUrl =
      ((getDB() as any)?.app?.options?.databaseURL as string | undefined) ||
      "https://evil-invaders-default-rtdb.firebaseio.com";
    const res = await fetch(`${dbUrl}/tilemaps.json?shallow=true`);
    const data = res.ok ? await res.json() : null;
    const keys = data ? Object.keys(data) : [];
    setOptions(keys, keys, false);
  } catch (err) {
    console.error("Failed to list tilemaps:", err);
    setOptions([], [], false);
  }
}

async function loadTilemapFromCloud(key: string) {
  if (!key) return;
  try {
    const db = getDB();
    const snapshot = await get(ref(db, `tilemaps/${key}`));
    if (!snapshot.exists()) {
      alert(`Tilemap "${key}" not found.`);
      return;
    }
    const val = snapshot.val();
    const json = typeof val.json === "string" ? JSON.parse(val.json) : val.json;
    if (!looksLikeMap(json)) {
      alert("Stored tilemap JSON is not a valid Tiled map.");
      return;
    }
    let png: string = val.png || "";
    if (png && !png.startsWith("data:")) png = `data:image/png;base64,${png}`;
    if (!png) {
      alert("Stored tilemap has no tileset image.");
      return;
    }

    pendingMapJson = json;
    pendingMapName = key;
    pendingTilesetJson =
      typeof val.tileset === "string" ? JSON.parse(val.tileset) : val.tileset || null;
    pendingPngDataURL = png;
    pendingPngName = "cloud tileset";
    refreshFileStatus();
    await initFromPending();
  } catch (err: any) {
    console.error(err);
    alert(`Failed to load tilemap: ${err?.message || "unknown error"}`);
  }
}

/** ========================= UI wiring =========================== */

function cycleZoom() {
  zoom = (zoom % 6) + 1;
  applyZoom();
  drawTilemapOverlay();
  scrollCursorIntoView();
}

function onPaletteClick(ev: MouseEvent) {
  if (!map || !tilesetImage) return;
  const canvas = $("tilemapPaletteCanvas") as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const s = PALETTE_SCALE;
  const cx = Math.floor(x / (ts.tilewidth * s));
  const cy = Math.floor(y / (ts.tileheight * s));
  if (cx < 0 || cx >= ts.columns) return;
  const id = cy * ts.columns + cx;
  if (id < 0 || id >= ts.tilecount) return;
  selectGid(ts.firstgid + id);
  setStatus(`SELECTED GID ${ts.firstgid + id}`);
}

function wireCanvasMouse() {
  let painting = false;
  let paintButton = 0;

  overlayCanvas.addEventListener("mousemove", (ev) => {
    if (!map) return;
    tilemapSetCursorFromClient(ev.clientX, ev.clientY);
    if (painting && (ev.buttons & 1 || ev.buttons & 2)) {
      if (paintButton === 0) tilemapPlace();
      else tilemapDelete();
    } else if (painting) {
      painting = false;
    }
  });

  overlayCanvas.addEventListener("mousedown", (ev) => {
    if (!map) return;
    tilemapSetCursorFromClient(ev.clientX, ev.clientY);
    const layer = activeLayer();
    if (ev.button === 0) {
      painting = !!(layer && isTileLayer(layer)); // drag-paint only for tiles
      paintButton = 0;
      if (painting) {
        strokeActive = true;
        strokePushed = false;
      }
      tilemapPlace();
    } else if (ev.button === 2) {
      painting = !!(layer && isTileLayer(layer));
      paintButton = 2;
      if (painting) {
        strokeActive = true;
        strokePushed = false;
      }
      tilemapDelete();
    }
  });

  window.addEventListener("mouseup", () => {
    painting = false;
    strokeActive = false;
    strokePushed = false;
  });

  overlayCanvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
}

function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (activeTab() !== "tilemap" || !map) return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")
    ) {
      return;
    }

    if (e.ctrlKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      tilemapUndo();
      return;
    }

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        tilemapMoveCursor(-1, 0);
        break;
      case "ArrowRight":
        e.preventDefault();
        tilemapMoveCursor(1, 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        tilemapMoveCursor(0, -1);
        break;
      case "ArrowDown":
        e.preventDefault();
        tilemapMoveCursor(0, 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        tilemapPlace();
        break;
      case "Delete":
      case "Backspace":
      case "x":
      case "X":
        e.preventDefault();
        tilemapDelete();
        break;
      case "p":
      case "P":
        tilemapPick();
        break;
      case "[":
        tilemapCycleLayer(-1);
        break;
      case "]":
        tilemapCycleLayer(1);
        break;
      case "g":
      case "G":
        tilemapToggleGrid();
        break;
      case "+":
      case "=":
        cycleZoom();
        break;
    }
  });
}

function wireDragDrop() {
  const panel = document.querySelector('[data-sx-panel="tilemap"]') as HTMLElement | null;
  if (!panel) return;

  ["dragenter", "dragover"].forEach((name) => {
    panel.addEventListener(name, (ev) => {
      ev.preventDefault();
    });
  });

  panel.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const files = Array.from((ev as DragEvent).dataTransfer?.files || []);
    if (files.length) tilemapLoadFiles(files);
  });
}

export function initTilemapEditor(d: EditorDeps) {
  deps = d;

  baseCanvas = $("tilemapCanvas") as HTMLCanvasElement;
  overlayCanvas = $("tilemapOverlayCanvas") as HTMLCanvasElement;
  if (!baseCanvas || !overlayCanvas) return;

  baseCtx = baseCanvas.getContext("2d")!;
  overlayCtx = overlayCanvas.getContext("2d")!;
  baseCtx.imageSmoothingEnabled = false;
  overlayCtx.imageSmoothingEnabled = false;

  ($("tilemapFileInput") as HTMLInputElement | null)?.addEventListener(
    "change",
    (ev) => {
      const input = ev.target as HTMLInputElement;
      const files = Array.from(input.files || []);
      if (files.length) tilemapLoadFiles(files);
      input.value = "";
    }
  );

  $("tilemapZoomBtn")?.addEventListener("click", cycleZoom);
  $("tilemapGridBtn")?.addEventListener("click", tilemapToggleGrid);
  $("tilemapGridBtn")?.classList.add("active");
  $("tilemapAddObjLayerBtn")?.addEventListener("click", addObjectLayer);
  $("tilemapEraserBtn")?.addEventListener("click", () => {
    selectGid(selectedGid === 0 ? ts.firstgid : 0);
    setStatus(selectedGid === 0 ? "ERASER SELECTED" : "ERASER OFF");
  });
  $("tilemapPaletteCanvas")?.addEventListener("click", onPaletteClick as any);
  $("tilemapDownloadBtn")?.addEventListener("click", downloadMapJson);
  $("tilemapSaveCloudBtn")?.addEventListener("click", saveTilemapToCloud);

  ($("tilemapSelect") as HTMLSelectElement | null)?.addEventListener(
    "change",
    (ev) => {
      const select = ev.target as HTMLSelectElement;
      if (!select.value) return;
      // Loading replaces the current map and wipes the undo stack — never
      // let an accidental pick (mouse or gamepad) destroy unsaved edits.
      if (
        map &&
        mapDirty &&
        !confirm(
          `Load "${select.value}" from the cloud and discard unsaved changes to "${mapFileName}"?`
        )
      ) {
        select.value = "";
        return;
      }
      loadTilemapFromCloud(select.value);
    }
  );

  ($("tilemapObjName") as HTMLInputElement | null)?.addEventListener(
    "input",
    (ev) => {
      if (inspectedObject) {
        inspectedObject.name = (ev.target as HTMLInputElement).value;
        mapDirty = true;
      }
    }
  );
  ($("tilemapObjType") as HTMLInputElement | null)?.addEventListener(
    "input",
    (ev) => {
      if (inspectedObject) {
        inspectedObject.type = (ev.target as HTMLInputElement).value;
        mapDirty = true;
      }
    }
  );

  wireCanvasMouse();
  wireKeyboard();
  wireDragDrop();
  populateTilemapSelect();

  // Test hook (mirrors overlayCanvas.dataset.drawn precedent in main.ts):
  // lets scripted tests feed files and inspect state without the OS picker.
  (window as any).__sxTilemap = {
    loadFiles: (files: File[]) => tilemapLoadFiles(files),
    getMap: () => map,
    getState: () => ({
      activeLayerIndex,
      selectedGid,
      cursor: { ...cursor },
      zoom,
      tileset: { ...ts },
      dirty: mapDirty,
      layerCount: flatLayers.length,
    }),
    place: tilemapPlace,
    erase: tilemapDelete,
    pick: tilemapPick,
    moveCursor: tilemapMoveCursor,
    cycleLayer: tilemapCycleLayer,
    undo: tilemapUndo,
    serialize: () => (map ? serializeMap() : null),
  };
}
