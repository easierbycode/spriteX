#!/usr/bin/env node
/**
 * optimize-atlas.mjs — build an optimized atlas containing only the assets a
 * game actually uses.
 *
 * Used-asset sources (combined by default):
 *   static — the game's data tree in RTDB (`/games/{game}`): every `texture`
 *            array of frame names, plus `textureKey` atlas hints.
 *   usage  — runtime usage recorded by the SpriteXPlugin Phaser plugin at
 *            `/games/{game}/assetUsage` (texture key → frame keys).
 *
 * Frame names are resolved against candidate atlases (the game's own atlases,
 * usage texture keys, character textureKeys, --atlases hints). Any still-
 * unresolved frames trigger a JSON-only scan of the full global atlas catalog.
 *
 * Usage:
 *   node scripts/optimize-atlas.mjs --gameName <name>
 *     [--outDir <dir>]            output directory (default: downloads)
 *     [--outName <name>]          output atlas name (default: <game>_optimized)
 *     [--source static|usage|both]  which used-asset sources to read (default: both)
 *     [--atlases "a,b"]           extra candidate atlases to resolve against
 *     [--maxWidth <px>]           packed atlas max width (default: 2048)
 *     [--padding <px>]            padding between frames (default: 1)
 *     [--no-scan]                 skip the global catalog scan fallback
 *     [--list]                    dry run: report used frames + resolution, no files
 *     [--save]                    also upload to RTDB /games/<game>/atlases/<outName>
 *
 * Output: <outName>.png + <outName>.json in outDir, and a JSON report on stdout.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATABASE_URL = "https://evil-invaders-default-rtdb.firebaseio.com";
const RTDB_INVALID_KEY_CHARS = /[.#$\/\[\]]/;

// ─── arg parsing (same shape as sibling scripts) ─────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

// ─── frame-key + atlas JSON helpers (in sync with atlasManager.ts) ───────────

export function decodeFrameKey(key) {
  if (typeof key !== "string" || !key.startsWith("k_")) return key;
  const hex = key.slice(2);
  if (hex.length === 0 || hex.length % 4 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return key;
  let out = "";
  for (let i = 0; i < hex.length; i += 4) {
    out += String.fromCodePoint(parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

export function encodeFrameKey(name) {
  let hex = "";
  for (let i = 0; i < name.length; i += 1) {
    hex += name.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return `k_${hex}`;
}

function rtdbSafeKey(key) {
  if (key && !RTDB_INVALID_KEY_CHARS.test(key)) return key;
  return encodeFrameKey(key);
}

function normalizeAtlasJson(jsonVal) {
  if (jsonVal == null) return null;
  if (typeof jsonVal === "object") return jsonVal;
  if (typeof jsonVal !== "string") return null;
  let str = jsonVal.trim();
  try {
    const once = JSON.parse(str);
    if (typeof once === "string") {
      try { return JSON.parse(once); } catch { return null; }
    }
    return once;
  } catch {
    try {
      str = str.replace(/^﻿/, "").trim();
      return JSON.parse(str);
    } catch { return null; }
  }
}

function getFramesMap(atlasJson) {
  return atlasJson?.frames ?? atlasJson?.textures?.[0]?.frames ?? null;
}

function decodeBase64Png(raw) {
  return Buffer.from(raw.replace(/^data:image\/png;base64,/, ""), "base64");
}

async function fetchJson(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${DATABASE_URL}/${pathOrUrl}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RTDB request failed (${res.status}) for ${url}`);
  return res.json();
}

// ─── used-asset collection ───────────────────────────────────────────────────

/**
 * Walk the game data tree collecting frame names from `texture` arrays and
 * atlas hints from `textureKey` strings. The `atlases` / `assetUsage` subtrees
 * are skipped — they describe storage, not usage.
 */
function collectStaticUsage(gameData) {
  const frames = new Set();
  const atlasHints = new Set();
  const walk = (node, keyInParent) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      if (keyInParent === "texture") {
        for (const v of node) if (typeof v === "string") frames.add(v);
      } else {
        node.forEach((v) => walk(v, keyInParent));
      }
      return;
    }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "atlases" || k === "assetUsage") continue;
      if (k === "textureKey" && typeof v === "string") atlasHints.add(v);
      walk(v, k);
    }
  };
  walk(gameData, null);
  return { frames, atlasHints };
}

/** Read the plugin-recorded runtime usage: { texKey: { frameKey: true } }. */
function collectRuntimeUsage(assetUsage) {
  const frames = new Set();
  const atlasHints = new Set();
  const sheetOrImageKeys = new Set();
  if (!assetUsage || typeof assetUsage !== "object") return { frames, atlasHints, sheetOrImageKeys };
  for (const [texKeyRaw, frameMap] of Object.entries(assetUsage)) {
    if (texKeyRaw === "_meta") continue;
    const texKey = decodeFrameKey(texKeyRaw);
    atlasHints.add(texKey);
    if (!frameMap || typeof frameMap !== "object") continue;
    const names = Object.keys(frameMap).map(decodeFrameKey);
    const nonBase = names.filter((n) => n !== "__BASE");
    if (nonBase.length === 0 || nonBase.every((n) => /^\d+$/.test(n))) {
      // Image or spritesheet texture — the whole source image is the asset.
      sheetOrImageKeys.add(texKey);
    } else {
      for (const n of nonBase) frames.add(n);
    }
  }
  return { frames, atlasHints, sheetOrImageKeys };
}

// ─── frame resolution ────────────────────────────────────────────────────────

class AtlasIndex {
  constructor() {
    /** atlasRef ("name" or "game/name") → { name, gameName, json, frameLookup: Map<decodedName, rawKey> } */
    this.atlases = new Map();
    this.checked = new Set();
  }

  async addCandidate(name, gameName = null) {
    const ref = gameName ? `${gameName}/${name}` : name;
    if (this.checked.has(ref)) return this.atlases.get(ref) ?? null;
    this.checked.add(ref);
    const rtdbPath = gameName ? `games/${gameName}/atlases/${name}/json` : `atlases/${name}/json`;
    let json = null;
    try {
      json = normalizeAtlasJson(await fetchJson(rtdbPath));
    } catch {
      return null;
    }
    const framesMap = getFramesMap(json);
    if (!framesMap || typeof framesMap !== "object") return null;
    const frameLookup = new Map();
    for (const [raw, val] of Object.entries(framesMap)) {
      // Catalog atlases may contain stray non-frame entries (e.g. "comment"
      // strings); only index entries with real frame rects.
      if (typeof val?.frame?.x !== "number") continue;
      frameLookup.set(decodeFrameKey(raw), raw);
    }
    const entry = { name, gameName, json, framesMap, frameLookup };
    this.atlases.set(ref, entry);
    return entry;
  }

  findFrame(frameName) {
    for (const entry of this.atlases.values()) {
      const raw = entry.frameLookup.get(frameName);
      if (raw != null) return { entry, rawKey: raw, data: entry.framesMap[raw] };
    }
    return null;
  }
}

/** Scan every global atlas JSON (a few hundred small requests, ~seconds). */
async function scanGlobalCatalog(index, log) {
  const names = Object.keys((await fetchJson(`${DATABASE_URL}/atlases.json?shallow=true`)) ?? {});
  log(`scanning global catalog (${names.length} atlases) for unresolved frames…`);
  const queue = [...names];
  const workers = Array.from({ length: 16 }, async () => {
    while (queue.length > 0) {
      const name = queue.shift();
      await index.addCandidate(name);
    }
  });
  await Promise.all(workers);
}

// ─── main ────────────────────────────────────────────────────────────────────

export async function optimizeGameAtlas(options) {
  const {
    gameName,
    outDir = "downloads",
    outName = `${gameName}_optimized`,
    source = "both",
    extraAtlases = [],
    maxWidth = 2048,
    padding = 1,
    scan = true,
    listOnly = false,
    save = false,
    log = (msg) => console.error(`[optimize-atlas] ${msg}`),
  } = options;

  if (!gameName) throw new Error("gameName is required");

  // ── 1. Collect used assets ────────────────────────────────────────────────
  const gameData = await fetchJson(`games/${gameName}`);
  if (!gameData || typeof gameData !== "object") {
    throw new Error(`No game found at games/${gameName}`);
  }

  const wantedFrames = new Set();
  const atlasHints = new Set(extraAtlases);
  const sheetOrImageKeys = new Set();

  if (source === "static" || source === "both") {
    const s = collectStaticUsage(gameData);
    for (const f of s.frames) wantedFrames.add(f);
    for (const a of s.atlasHints) atlasHints.add(a);
    log(`static analysis: ${s.frames.size} frame names, ${s.atlasHints.size} atlas hints`);
  }
  if (source === "usage" || source === "both") {
    const u = collectRuntimeUsage(gameData.assetUsage);
    for (const f of u.frames) wantedFrames.add(f);
    for (const a of u.atlasHints) atlasHints.add(a);
    for (const k of u.sheetOrImageKeys) sheetOrImageKeys.add(k);
    log(`runtime usage: ${u.frames.size} frames, ${u.sheetOrImageKeys.size} image/sheet textures`);
  }

  if (wantedFrames.size === 0 && sheetOrImageKeys.size === 0) {
    throw new Error(
      `No used assets found for "${gameName}". The game data has no texture[] references and ` +
        `no runtime usage has been recorded at games/${gameName}/assetUsage.`
    );
  }

  // ── 2. Resolve frames against candidate atlases ───────────────────────────
  const index = new AtlasIndex();

  // Game-scoped atlases first (highest priority), then hinted atlases.
  const gameAtlasNames = Object.keys(gameData.atlases ?? {});
  for (const name of gameAtlasNames) {
    if (name !== outName) await index.addCandidate(name, gameName);
  }
  for (const name of atlasHints) {
    await index.addCandidate(name, gameName);
    await index.addCandidate(name);
  }

  let resolved = new Map(); // frameName → { entry, rawKey, data }
  const resolveAll = () => {
    resolved = new Map();
    const unresolved = [];
    for (const frameName of wantedFrames) {
      const hit = index.findFrame(frameName);
      if (hit) resolved.set(frameName, hit);
      else unresolved.push(frameName);
    }
    return unresolved;
  };

  let unresolved = resolveAll();
  if (unresolved.length > 0 && scan) {
    await scanGlobalCatalog(index, log);
    unresolved = resolveAll();
  }

  // Sheet/image textures: resolve against /sprites (whole-image assets). A key
  // that already resolved as an atlas hint contributes frames instead.
  const sprites = new Map(); // key → dataURL/base64
  for (const key of sheetOrImageKeys) {
    const isAtlas = [...index.atlases.values()].some((e) => e.name === key);
    if (isAtlas) continue;
    for (const candidate of [key, encodeFrameKey(key)]) {
      if (RTDB_INVALID_KEY_CHARS.test(candidate)) continue;
      try {
        const val = await fetchJson(`sprites/${candidate}`);
        const png = typeof val === "string" ? val : val?.png;
        if (typeof png === "string") {
          sprites.set(key, png);
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!sprites.has(key)) log(`warning: image/sheet texture "${key}" not found in /sprites — skipped`);
  }

  const sourcesUsed = {};
  for (const { entry } of resolved.values()) {
    const ref = entry.gameName ? `games/${entry.gameName}/atlases/${entry.name}` : `atlases/${entry.name}`;
    sourcesUsed[ref] = (sourcesUsed[ref] ?? 0) + 1;
  }

  const report = {
    gameName,
    outName,
    source,
    wantedFrames: wantedFrames.size,
    resolvedFrames: resolved.size,
    unresolvedFrames: unresolved.sort(),
    imageTextures: [...sprites.keys()].sort(),
    sourceAtlases: sourcesUsed,
  };

  if (listOnly) {
    return { ...report, listOnly: true };
  }
  if (resolved.size === 0 && sprites.size === 0) {
    throw new Error(`None of the ${wantedFrames.size} used frames could be resolved to an atlas.`);
  }

  // ── 3. Load pixels and pack ───────────────────────────────────────────────
  const { createCanvas, loadImage } = await import("./canvas-shim.mjs");

  // Download PNGs only for atlases that actually contributed frames.
  const imagesByRef = new Map();
  for (const [frameName, hit] of resolved) {
    const ref = hit.entry.gameName ? `${hit.entry.gameName}/${hit.entry.name}` : hit.entry.name;
    if (!imagesByRef.has(ref)) {
      const rtdbPath = hit.entry.gameName
        ? `games/${hit.entry.gameName}/atlases/${hit.entry.name}/png`
        : `atlases/${hit.entry.name}/png`;
      const png = await fetchJson(rtdbPath);
      if (typeof png !== "string") throw new Error(`Missing png for source atlas ${ref}`);
      imagesByRef.set(ref, await loadImage(decodeBase64Png(png)));
    }
  }

  const inputs = [];
  const metaAtlases = {};
  for (const [frameName, hit] of resolved) {
    const ref = hit.entry.gameName ? `${hit.entry.gameName}/${hit.entry.name}` : hit.entry.name;
    const f = hit.data.frame;
    inputs.push({
      name: frameName,
      w: f.w,
      h: f.h,
      draw: { image: imagesByRef.get(ref), sx: f.x, sy: f.y },
      srcData: hit.data,
    });
    (metaAtlases[hit.entry.name] ??= []).push(frameName);
  }
  const metaImages = [];
  for (const [key, png] of sprites) {
    const img = await loadImage(decodeBase64Png(png));
    inputs.push({
      name: key,
      w: img.width,
      h: img.height,
      draw: { image: img, sx: 0, sy: 0 },
      srcData: null,
    });
    metaImages.push(key);
  }

  // Shelf pack, tallest first.
  const sorted = [...inputs].sort((a, b) => b.h - a.h || b.w - a.w);
  let curX = 0;
  let curY = 0;
  let rowHeight = 0;
  let width = 0;
  const placements = [];
  for (const item of sorted) {
    if (curX > 0 && curX + item.w > maxWidth) {
      width = Math.max(width, curX - padding);
      curX = 0;
      curY += rowHeight + padding;
      rowHeight = 0;
    }
    placements.push({ ...item, x: curX, y: curY });
    curX += item.w + padding;
    rowHeight = Math.max(rowHeight, item.h);
  }
  width = Math.max(1, Math.max(width, curX - padding));
  const height = Math.max(1, curY + rowHeight);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const frames = {};
  for (const p of placements) {
    ctx.drawImage(p.draw.image, p.draw.sx, p.draw.sy, p.w, p.h, p.x, p.y, p.w, p.h);
    frames[p.name] = {
      frame: { x: p.x, y: p.y, w: p.w, h: p.h },
      rotated: false,
      trimmed: p.srcData?.trimmed || false,
      spriteSourceSize: p.srcData?.spriteSourceSize || { x: 0, y: 0, w: p.w, h: p.h },
      sourceSize: p.srcData?.sourceSize || { w: p.w, h: p.h },
    };
  }

  const atlasJson = {
    frames,
    meta: {
      app: "spriteX optimize-atlas",
      version: "1.0",
      image: `${outName}.png`,
      format: "RGBA8888",
      size: { w: width, h: height },
      scale: "1",
      spritex: {
        gameName,
        images: metaImages,
        sheets: {},
        atlases: metaAtlases,
      },
    },
  };

  // ── 4. Write files (and optionally save to RTDB) ──────────────────────────
  const outputDirectory = path.resolve(outDir);
  await mkdir(outputDirectory, { recursive: true });
  const pngFilePath = path.join(outputDirectory, `${outName}.png`);
  const jsonFilePath = path.join(outputDirectory, `${outName}.json`);
  const pngBuffer = canvas.toBuffer("image/png");
  await writeFile(pngFilePath, pngBuffer);
  await writeFile(jsonFilePath, JSON.stringify(atlasJson, null, 2) + "\n", "utf8");

  let savedTo = null;
  if (save) {
    const safeFrames = {};
    for (const [k, v] of Object.entries(frames)) safeFrames[rtdbSafeKey(k)] = v;
    const safeJson = { ...atlasJson, frames: safeFrames };
    const rtdbPath = `games/${gameName}/atlases/${outName}`;
    const res = await fetch(`${DATABASE_URL}/${rtdbPath}.json`, {
      method: "PUT",
      body: JSON.stringify({
        json: safeJson,
        png: `data:image/png;base64,${pngBuffer.toString("base64")}`,
      }),
    });
    if (!res.ok) throw new Error(`RTDB save failed (${res.status}) for ${rtdbPath}`);
    savedTo = rtdbPath;
    log(`saved optimized atlas to ${rtdbPath}`);
  }

  return {
    ...report,
    packedFrames: placements.length,
    size: { w: width, h: height },
    files: { png: pngFilePath, json: jsonFilePath },
    savedTo,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.gameName) {
    console.error(
      `Usage: node scripts/optimize-atlas.mjs --gameName <name>
  [--outDir <dir>] [--outName <name>] [--source static|usage|both]
  [--atlases "a,b"] [--maxWidth <px>] [--padding <px>]
  [--no-scan] [--list] [--save]`
    );
    process.exit(1);
  }

  const result = await optimizeGameAtlas({
    gameName: args.gameName,
    outDir: args.outDir,
    outName: args.outName || undefined,
    source: args.source || "both",
    extraAtlases: args.atlases ? args.atlases.split(",").map((s) => s.trim()).filter(Boolean) : [],
    maxWidth: args.maxWidth ? Number(args.maxWidth) : undefined,
    padding: args.padding ? Number(args.padding) : undefined,
    scan: args["no-scan"] !== "true",
    listOnly: args.list === "true",
    save: args.save === "true",
  });

  console.log(JSON.stringify(result, null, 2));
}

const runAsCli =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runAsCli) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
