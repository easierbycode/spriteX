// src/atlasManager.ts
// - Firebase RTDB helpers (uses your firebase-config wrappers)
// - Improved sprite detection (auto background detect + keying)
// - Atlas build (JSON + PNG DataURL) and save
// - Save individual sprites to RTDB (optional strip prefix)
// - Character preview from atlas (handles atlas.json as object or string)

import { getDB, ref, get, set } from "./firebase-config";

/** ============================ Types ============================ */

export interface CharacterData {
  name: string;
  textureKey: string;
  texture: string[];
  size?: { x: number; y: number };
  anchor?: { x: number; y: number };
  body?: { x: number; y: number };

  // Enemy-like fields
  hp?: number;
  spgage?: number;
  interval?: number;
  score?: number;
  shadowOffsetY?: number;
  shadowReverse?: boolean;
  speed?: number;

  // Player-like fields
  barrier?: any;
  spDamage?: number;
  defaultShootName?: string;
  defaultShootSpeed?: string;
  maxHp?: number;
  shoot3way?: any;
  shootBig?: any;
  shootNormal?: any;
}

export interface AtlasData {
  json: any;
  png: string; // DataURL with prefix
}

export interface SpriteData {
  name: string;
  png: string; // base64 (may or may not have prefix depending on your DB)
}

export interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface DetectedSprite extends SpriteRect {
  area?: number;
}

export interface SmartDetectResult {
  sprites: DetectedSprite[];
  bgColor: RGB | null;
  tolerance: number;
  usedKeyOut: boolean;
}

/** ========================= Firebase =========================== */

export async function fetchAllCharacters(): Promise<
  Record<string, CharacterData>
> {
  const db = getDB();
  try {
    const snapshot = await get(ref(db, "characters"));
    return snapshot.exists()
      ? (snapshot.val() as Record<string, CharacterData>)
      : {};
  } catch (error) {
    console.error("Error fetching characters:", error);
    return {};
  }
}

export async function fetchCharacter(
  characterId: string
): Promise<CharacterData | null> {
  const db = getDB();
  try {
    const snapshot = await get(ref(db, `characters/${characterId}`));
    return snapshot.exists() ? (snapshot.val() as CharacterData) : null;
  } catch (error) {
    console.error(`Error fetching character ${characterId}:`, error);
    return null;
  }
}

export async function fetchAtlas(atlasKey: string): Promise<AtlasData | null> {
  const db = getDB();
  try {
    const snapshot = await get(ref(db, `atlases/${atlasKey}`));
    if (!snapshot.exists()) return null;
    const val = snapshot.val();
    const parsedJson = normalizeAtlasJson(val?.json);
    return { json: parsedJson ?? val?.json ?? null, png: val?.png } as AtlasData;
  } catch (error) {
    console.error(`Error fetching atlas ${atlasKey}:`, error);
    return null;
  }
}

export async function fetchAllSprites(): Promise<
  Record<string, string | SpriteData>
> {
  const db = getDB();
  try {
    const snapshot = await get(ref(db, "sprites"));
    return snapshot.exists()
      ? (snapshot.val() as Record<string, string | SpriteData>)
      : {};
  } catch (error) {
    console.error("Error fetching sprites:", error);
    return {};
  }
}

export async function saveCharacter(
  characterId: string,
  data: CharacterData
): Promise<void> {
  const db = getDB();
  try {
    await set(ref(db, `characters/${characterId}`), data);
  } catch (error) {
    console.error(`Error saving character ${characterId}:`, error);
    throw error;
  }
}

export async function saveAtlas(
  atlasKey: string,
  data: AtlasData
): Promise<void> {
  const db = getDB();
  try {
    await set(ref(db, `atlases/${atlasKey}`), data);
  } catch (error) {
    console.error(`Error saving atlas ${atlasKey}:`, error);
    throw error;
  }
}

/** =========================== Utils ============================ */

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((x, y) => x - y);
  const idx = clamp(Math.floor((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : null;
}

export function rgbToHex(rgb: RGB): string {
  const to2 = (v: number) => clamp(v | 0, 0, 255).toString(16).padStart(2, "0");
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`;
}

/** Border sampling + dominant color (quantized) */
function sampleBorderDominant(
  imageData: ImageData,
  sampleStride = 2
): { dominant: RGB | null; distances: number[] } {
  const { width, height, data } = imageData;
  const samples: RGB[] = [];
  const pick = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  };
  for (let x = 0; x < width; x += sampleStride) {
    pick(x, 0);
    pick(x, height - 1);
  }
  for (let y = 0; y < height; y += sampleStride) {
    pick(0, y);
    pick(width - 1, y);
  }
  if (!samples.length) return { dominant: null, distances: [] };

  const qKey = (c: RGB) =>
    `${(c.r >> 2) << 2},${(c.g >> 2) << 2},${(c.b >> 2) << 2}`;
  const counts = new Map<string, { rgb: RGB; count: number }>();
  for (const s of samples) {
    const k = qKey(s);
    const v = counts.get(k);
    if (v) v.count++;
    else counts.set(k, { rgb: s, count: 1 });
  }

  let dominant: RGB | null = null;
  let best = -1;
  counts.forEach((v) => {
    if (v.count > best) {
      best = v.count;
      dominant = v.rgb;
    }
  });

  const distances = dominant ? samples.map((s) => colorDistance(s, dominant!)) : [];
  return { dominant, distances };
}

function computeAdaptiveTolerance(
  distances: number[],
  min = 6,
  max = 48
): number {
  if (!distances.length) return 12;
  const p90 = percentile(distances, 90);
  const tol = Math.ceil(p90 + 2);
  return clamp(tol, min, max);
}

function keyOutBackground(imageData: ImageData, bg: RGB, tolerance: number) {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (colorDistance({ r, g, b }, bg) <= tolerance) {
      data[i + 3] = 0;
    }
  }
}

function ensureDataURL(s: string): string {
  return s.startsWith("data:") ? s : `data:image/png;base64,${s}`;
}

/** Some atlases store json as string. Handle object or (single/double) string. */
function normalizeAtlasJson(jsonVal: any): any | null {
  if (jsonVal == null) return null;
  if (typeof jsonVal === "object") return jsonVal;
  if (typeof jsonVal !== "string") return null;
  let str = jsonVal.trim();
  try {
    const once = JSON.parse(str);
    if (typeof once === "string") {
      try {
        return JSON.parse(once);
      } catch {
        return null;
      }
    }
    return once;
  } catch {
    try {
      str = str.replace(/^\uFEFF/, "").trim();
      return JSON.parse(str);
    } catch {
      return null;
    }
  }
}

/** ===================== Sprite Detection ======================= */

export function detectSpritesFromImageData(
  imageData: ImageData,
  opts?: {
    bgColor?: RGB | null;
    tolerance?: number;
    minArea?: number;
    use8Conn?: boolean;
    alphaThreshold?: number;
  }
): DetectedSprite[] {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;

  const alphaThreshold = opts?.alphaThreshold ?? 1;
  const minArea = opts?.minArea ?? 2;
  const use8Conn = !!opts?.use8Conn;
  const nearTolerance = opts?.tolerance ?? 12;
  const userBg = opts?.bgColor ?? null;

  let hasTransparency = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] <= alphaThreshold) {
      hasTransparency = true;
      break;
    }
  }

  let inferredBg: RGB | null = userBg;
  if (!inferredBg && !hasTransparency) {
    const s = sampleBorderDominant(imageData);
    inferredBg = s.dominant;
  }

  const pxCount = width * height;
  const visited = new Uint8Array(pxCount);
  const bgMark = new Uint8Array(pxCount);

  const neighbors = use8Conn
    ? [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
        { dx: 1, dy: 1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: 1 },
        { dx: -1, dy: -1 },
      ]
    : [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
      ];

  const getIdx = (x: number, y: number) => (y * width + x) * 4;
  const isTransparent = (a: number) => a <= alphaThreshold;
  const nearBg = (r: number, g: number, b: number) => {
    if (!inferredBg) return false;
    return colorDistance({ r, g, b }, inferredBg) <= nearTolerance;
  };

  const q: Array<{ x: number; y: number }> = [];
  const pushIfBg = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const lin = y * width + x;
    if (bgMark[lin]) return;
    const i = getIdx(x, y);
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    const isBg = isTransparent(a) || nearBg(r, g, b);
    if (isBg) {
      bgMark[lin] = 1;
      q.push({ x, y });
    }
  };

  for (let x = 0; x < width; x++) {
    pushIfBg(x, 0);
    pushIfBg(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    pushIfBg(0, y);
    pushIfBg(width - 1, y);
  }

  while (q.length) {
    const { x, y } = q.pop()!;
    for (const { dx, dy } of neighbors) {
      pushIfBg(x + dx, y + dy);
    }
  }

  const isSpritePixel = (x: number, y: number): boolean => {
    const lin = y * width + x;
    if (bgMark[lin]) return false;
    const i = getIdx(x, y);
    const a = data[i + 3];
    if (isTransparent(a)) return false;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (inferredBg && nearBg(r, g, b)) return false;
    return true;
  };

  function floodFill(startX: number, startY: number): DetectedSprite {
    const stack = [{ x: startX, y: startY }];
    let minX = startX,
      minY = startY,
      maxX = startX,
      maxY = startY,
      area = 0;

    visited[startY * width + startX] = 1;

    while (stack.length) {
      const { x, y } = stack.pop()!;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (const { dx, dy } of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const lin = ny * width + nx;
        if (visited[lin]) continue;
        if (isSpritePixel(nx, ny)) {
          visited[lin] = 1;
          stack.push({ x: nx, y: ny });
        }
      }
    }

    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area };
  }

  const out: DetectedSprite[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lin = y * width + x;
      if (visited[lin] || bgMark[lin]) continue;
      if (isSpritePixel(x, y)) {
        const box = floodFill(x, y);
        if ((box.area ?? 0) >= minArea) {
          delete box.area;
          out.push(box);
        }
      } else {
        visited[lin] = 1;
      }
    }
  }
  return out;
}

/** Auto bg detect, key-out, then detect on keyed result */
export function smartDetectSprites(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  explicitBg?: RGB | null
): SmartDetectResult {
  const imageData = ctx.getImageData(0, 0, width, height);

  let hasTransparency = false;
  for (let i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i] <= 1) {
      hasTransparency = true;
      break;
    }
  }

  const { dominant, distances } = sampleBorderDominant(imageData);
  const computedBg = explicitBg ?? dominant ?? null;
  const tolerance = computeAdaptiveTolerance(distances, 6, 48);

  const workData = new ImageData(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height
  );

  let usedKeyOut = false;
  if (computedBg && !hasTransparency) {
    keyOutBackground(workData, computedBg, tolerance);
    usedKeyOut = true;
  } else if (computedBg && hasTransparency) {
    keyOutBackground(workData, computedBg, Math.max(4, Math.floor(tolerance / 2)));
    usedKeyOut = true;
  }

  const sprites = detectSpritesFromImageData(workData, {
    bgColor: computedBg,
    tolerance,
    minArea: 2,
    use8Conn: false,
    alphaThreshold: 1,
  });

  return { sprites, bgColor: computedBg, tolerance, usedKeyOut };
}

/** ======================= Atlas Building ======================= */

export function createAtlasJson(
  sprites: Record<string, { width: number; height: number }>
): any {
  const frames: any = {};
  let currentX = 0;
  let currentY = 0;
  let rowHeight = 0;
  const maxWidth = 2048;

  Object.entries(sprites).forEach(([name, dimensions]) => {
    if (currentX + dimensions.width > maxWidth) {
      currentX = 0;
      currentY += rowHeight;
      rowHeight = 0;
    }

    frames[name] = {
      frame: {
        x: currentX,
        y: currentY,
        w: dimensions.width,
        h: dimensions.height,
      },
      rotated: false,
      trimmed: false,
      spriteSourceSize: {
        x: 0,
        y: 0,
        w: dimensions.width,
        h: dimensions.height,
      },
      sourceSize: { w: dimensions.width, h: dimensions.height },
    };

    currentX += dimensions.width;
    rowHeight = Math.max(rowHeight, dimensions.height);
  });

  return {
    frames,
    meta: {
      app: "Evil Invaders Atlas Builder",
      version: "1.0",
      image: "atlas.png",
      format: "RGBA8888",
      size: { w: maxWidth, h: currentY + rowHeight },
      scale: "1",
    },
  };
}

export async function createAtlasPng(
  sprites: Record<string, string>,
  atlasJson: any
): Promise<string> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  canvas.width = atlasJson.meta.size.w;
  canvas.height = atlasJson.meta.size.h;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const loadPromises = Object.entries(sprites).map(([name, base64]) => {
    return new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const frame = atlasJson.frames[name];
        if (frame) {
          ctx.drawImage(img, frame.frame.x, frame.frame.y);
        }
        resolve();
      };
      img.onerror = () => resolve();
      img.src = base64.startsWith("data:")
        ? base64
        : `data:image/png;base64,${base64}`;
    });
  });

  await Promise.all(loadPromises);
  return canvas.toDataURL("image/png").split(",")[1];
}

export async function createAtlasPngDataURL(
  sprites: Record<string, string>,
  atlasJson: any
): Promise<string> {
  const b64 = await createAtlasPng(sprites, atlasJson);
  return `data:image/png;base64,${b64}`;
}

export async function buildAtlas(
  namedSprites: Record<string, string>
): Promise<{ dataURL: string; json: any }> {
  const dims: Record<string, { width: number; height: number }> = {};
  for (const [name, b64] of Object.entries(namedSprites)) {
    const size = await measureImage(b64);
    dims[name] = size;
  }
  const json = createAtlasJson(dims);
  const dataURL = await createAtlasPngDataURL(namedSprites, json);
  return { dataURL, json };
}

async function measureImage(
  base64OrDataURL: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = base64OrDataURL.startsWith("data:")
      ? base64OrDataURL
      : `data:image/png;base64,${base64OrDataURL}`;
  });
}

/** ===================== Extraction & Saving ===================== */

export function extractSpriteDataURLs(
  originalCanvas: HTMLCanvasElement,
  boxes: SpriteRect[],
  opts?: { bgColor?: RGB | null; tolerance?: number }
): Record<string, string> {
  const out: Record<string, string> = {};
  boxes.forEach((spr, idx) => {
    const c = document.createElement("canvas");
    c.width = spr.w;
    c.height = spr.h;
    const cctx = c.getContext("2d", { willReadFrequently: true })!;
    cctx.drawImage(
      originalCanvas,
      spr.x,
      spr.y,
      spr.w,
      spr.h,
      0,
      0,
      spr.w,
      spr.h
    );

    if (opts?.bgColor) {
      const id = cctx.getImageData(0, 0, spr.w, spr.h);
      keyOutBackground(id, opts.bgColor, opts.tolerance ?? 12);
      cctx.putImageData(id, 0, 0);
    }

    out[`sprite_${idx}`] = c.toDataURL("image/png");
  });
  return out;
}

export async function saveSpritesBatchToRTDB(
  sprites: Record<string, string>,
  opts?: { baseName?: string; stripPrefix?: boolean }
): Promise<void> {
  const db = getDB();
  const base = (opts?.baseName || "sprite").replace(/[.#$\[\]/]/g, "_");
  let i = 0;
  for (const [, v] of Object.entries(sprites)) {
    let val = v;
    if (opts?.stripPrefix) {
      val = v.startsWith("data:") ? v.split(",")[1] : v;
    }
    const key = `${base}_${i++}`;
    await set(ref(db, `sprites/${key}`), val);
  }
}

/** ================== Character + Atlas Preview ================== */

/**
 * Load character preview frames by slicing from its atlas:
 * - Fetch characters/{id}
 * - Fetch atlases/{character.textureKey}
 * - Atlas json may be string or object
 * - Extract frames for each key in character.texture[]
 * - Default fps = 6 if interval <= 0 or not set
 */
export async function loadCharacterPreviewFromAtlas(
  characterId: string
): Promise<{ frameRate: number; frames: string[]; textures: string[] } | null> {
  const db = getDB();

  // Character
  const charSnap = await get(ref(db, `characters/${characterId}`));
  if (!charSnap.exists()) return null;
  const char = charSnap.val() as CharacterData;

  const textures = Array.isArray(char.texture) ? char.texture : [];
  const textureKey = char.textureKey || characterId;
  const frameRate =
    char.interval && char.interval > 0 ? Math.round(1000 / char.interval) : 6;

  if (!textureKey) {
    return { frameRate, frames: [], textures };
  }

  // Atlas
  const atlasSnap = await get(ref(db, `atlases/${textureKey}`));
  if (!atlasSnap.exists()) return { frameRate, frames: [], textures };
  const atlasVal = atlasSnap.val() as { json?: any; png?: string };

  const atlasJson = normalizeAtlasJson(atlasVal?.json);
  const atlasPngRaw = atlasVal?.png;
  if (!atlasJson || !atlasPngRaw) {
    return { frameRate, frames: [], textures };
  }

  const framesMap =
    atlasJson.frames || atlasJson.textures?.[0]?.frames || undefined;
  if (!framesMap) {
    return { frameRate, frames: [], textures };
  }

  const atlasPng = ensureDataURL(atlasPngRaw);

  // Load atlas image
  const atlasImg = await new Promise<HTMLImageElement>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = atlasPng;
  });

  // Slice frames
  const frames: string[] = [];
  for (const key of textures) {
    const f = framesMap[key];
    if (!f || !f.frame) continue;
    const { x, y, w, h } = f.frame;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cctx = c.getContext("2d")!;
    cctx.drawImage(atlasImg, x, y, w, h, 0, 0, w, h);
    frames.push(c.toDataURL("image/png"));
  }

  return { frameRate, frames, textures };
}

/** Validate frames from a character exist in atlas JSON shape */
export function validateCharacterFrames(
  character: CharacterData,
  atlasJson: any
): string[] {
  const missing: string[] = [];
  const atlasFrames =
    atlasJson.frames || atlasJson.textures?.[0]?.frames || {};
  character.texture.forEach((name) => {
    if (!atlasFrames[name]) missing.push(name);
  });
  return missing;
}

/** ========================= Default Export ======================= */

export default {
  // Firebase
  fetchAllCharacters,
  fetchCharacter,
  fetchAtlas,
  fetchAllSprites,
  saveCharacter,
  saveAtlas,

  // Detection
  smartDetectSprites,
  detectSpritesFromImageData,

  // Extraction + saving
  extractSpriteDataURLs,
  saveSpritesBatchToRTDB,

  // Atlas
  createAtlasJson,
  createAtlasPng,
  createAtlasPngDataURL,
  buildAtlas,

  // Character preview (atlas-based)
  loadCharacterPreviewFromAtlas,

  // Validation
  validateCharacterFrames,

  // Utils
  hexToRgb,
  rgbToHex,
};