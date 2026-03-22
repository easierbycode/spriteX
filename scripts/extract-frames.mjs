#!/usr/bin/env node
/**
 * extract-frames.mjs
 *
 * Downloads an atlas from Firebase RTDB, extracts a subset of frames by name,
 * and produces a new tightly-packed atlas PNG + JSON.
 *
 * Usage:
 *   node scripts/extract-frames.mjs \
 *     --atlasName <name> \
 *     --frames "frame1,frame2,frame3" \
 *     [--gameName <name>] \
 *     [--outDir <dir>] \
 *     [--outName <name>]
 *
 * The --frames flag accepts a comma-separated list of frame names.
 * Frame names are matched against both raw keys and decoded hex-encoded keys.
 *
 * Output: <outName>.png and <outName>.json in <outDir> (default: downloads/).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "./canvas-shim.mjs";

const DATABASE_URL = "https://evil-invaders-default-rtdb.firebaseio.com";

// ─── Argument parsing ────────────────────────────────────────────────────────

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

// ─── Atlas JSON helpers ──────────────────────────────────────────────────────

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
      str = str.replace(/^\uFEFF/, "").trim();
      return JSON.parse(str);
    } catch { return null; }
  }
}

function decodeFrameKey(key) {
  if (!key.startsWith("k_")) return key;
  const hex = key.slice(2);
  let result = "";
  for (let i = 0; i < hex.length; i += 4) {
    result += String.fromCodePoint(parseInt(hex.slice(i, i + 4), 16));
  }
  return result;
}

function encodeFrameKey(name) {
  return `k_${Array.from(name)
    .map((ch) => ch.codePointAt(0).toString(16).padStart(4, "0"))
    .join("")}`;
}

/** Get the frames map from an atlas JSON (handles both flat and textures[] formats). */
function getFramesMap(atlasJson) {
  return atlasJson?.frames ?? atlasJson?.textures?.[0]?.frames ?? null;
}

/** Look up a frame by name, trying raw key, decoded key, and encoded key. */
function findFrame(framesMap, name) {
  if (!framesMap) return null;
  // Direct match
  if (framesMap[name]) return { key: name, data: framesMap[name] };
  // Try encoded version
  const encoded = encodeFrameKey(name);
  if (framesMap[encoded]) return { key: encoded, data: framesMap[encoded] };
  // Try reverse: iterate and decode
  for (const [k, v] of Object.entries(framesMap)) {
    if (decodeFrameKey(k) === name) return { key: k, data: v };
  }
  return null;
}

// ─── PNG helpers (pure Node, no native deps) ─────────────────────────────────

function decodeBase64Png(raw) {
  const cleaned = raw.replace(/^data:image\/png;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gameName = args.gameName;
  const atlasName = args.atlasName;
  const framesCsv = args.frames;
  const outDir = args.outDir || "downloads";
  const outName = args.outName || (atlasName ? `${atlasName}_extract` : "extract");

  if (!atlasName || !framesCsv) {
    console.error(
      `Usage: node scripts/extract-frames.mjs \\
  --atlasName <name> \\
  --frames "frame1,frame2,frame3" \\
  [--gameName <name>] \\
  [--outDir <dir>] \\
  [--outName <name>]`
    );
    process.exit(1);
  }

  const requestedFrames = framesCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (requestedFrames.length === 0) {
    console.error("No frame names provided.");
    process.exit(1);
  }

  // ── Fetch atlas from Firebase ──────────────────────────────────────────────

  const rtdbPath = gameName
    ? `games/${gameName}/atlases/${atlasName}`
    : `atlases/${atlasName}`;
  const url = `${DATABASE_URL}/${rtdbPath}.json`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`RTDB request failed (${response.status} ${response.statusText})`);
  }

  const atlas = await response.json();
  if (!atlas || typeof atlas !== "object") {
    throw new Error(`No atlas found at ${rtdbPath}`);
  }

  if (typeof atlas.png !== "string") {
    throw new Error(`Missing png base64 at ${rtdbPath}/png`);
  }
  if (atlas.json == null) {
    throw new Error(`Missing json payload at ${rtdbPath}/json`);
  }

  const atlasJson = normalizeAtlasJson(atlas.json);
  if (!atlasJson || typeof atlasJson !== "object") {
    throw new Error("Could not parse atlas JSON.");
  }

  const framesMap = getFramesMap(atlasJson);
  if (!framesMap) {
    throw new Error("Atlas JSON has no frames map.");
  }

  // ── Match requested frames ─────────────────────────────────────────────────

  const matched = [];
  const missing = [];
  for (const name of requestedFrames) {
    const found = findFrame(framesMap, name);
    if (found) {
      matched.push({ requestedName: name, ...found });
    } else {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    console.error(`Warning: ${missing.length} frame(s) not found: ${missing.join(", ")}`);
  }
  if (matched.length === 0) {
    throw new Error("No matching frames found in atlas.");
  }

  // ── Load source atlas PNG ──────────────────────────────────────────────────

  const srcPngBuffer = decodeBase64Png(atlas.png);
  const srcImage = await loadImage(srcPngBuffer);

  // ── Pack extracted frames into a new atlas ─────────────────────────────────

  const MAX_WIDTH = 2048;
  let curX = 0;
  let curY = 0;
  let rowHeight = 0;
  let totalWidth = 0;

  const placements = [];

  for (const m of matched) {
    const srcFrame = m.data.frame;
    const fw = srcFrame.w;
    const fh = srcFrame.h;

    if (curX + fw > MAX_WIDTH) {
      totalWidth = Math.max(totalWidth, curX);
      curX = 0;
      curY += rowHeight;
      rowHeight = 0;
    }

    placements.push({
      requestedName: m.requestedName,
      key: m.key,
      srcData: m.data,
      destX: curX,
      destY: curY,
      w: fw,
      h: fh,
    });

    curX += fw;
    rowHeight = Math.max(rowHeight, fh);
  }

  totalWidth = Math.max(totalWidth, curX);
  const totalHeight = curY + rowHeight;

  // ── Draw new atlas PNG ─────────────────────────────────────────────────────

  const canvas = createCanvas(totalWidth, totalHeight);
  const ctx = canvas.getContext("2d");

  for (const p of placements) {
    const sf = p.srcData.frame;
    ctx.drawImage(srcImage, sf.x, sf.y, sf.w, sf.h, p.destX, p.destY, p.w, p.h);
  }

  // ── Build new atlas JSON ───────────────────────────────────────────────────

  const newFrames = {};
  for (const p of placements) {
    // Use the human-readable requested name as the key
    newFrames[p.requestedName] = {
      frame: { x: p.destX, y: p.destY, w: p.w, h: p.h },
      rotated: false,
      trimmed: p.srcData.trimmed || false,
      spriteSourceSize: p.srcData.spriteSourceSize || { x: 0, y: 0, w: p.w, h: p.h },
      sourceSize: p.srcData.sourceSize || { w: p.w, h: p.h },
    };
  }

  const newAtlasJson = {
    frames: newFrames,
    meta: {
      app: "spriteX extract-frames",
      version: "1.0",
      image: `${outName}.png`,
      format: "RGBA8888",
      size: { w: totalWidth, h: totalHeight },
      scale: "1",
    },
  };

  // ── Write output files ─────────────────────────────────────────────────────

  const outputDirectory = path.resolve(outDir);
  await mkdir(outputDirectory, { recursive: true });

  const pngFilePath = path.join(outputDirectory, `${outName}.png`);
  const jsonFilePath = path.join(outputDirectory, `${outName}.json`);

  const pngBuffer = canvas.toBuffer("image/png");
  await writeFile(pngFilePath, pngBuffer);
  await writeFile(jsonFilePath, JSON.stringify(newAtlasJson, null, 2) + "\n", "utf8");

  // ── Output result as JSON (for Claude to parse) ────────────────────────────

  console.log(
    JSON.stringify(
      {
        atlasName,
        gameName: gameName || null,
        outName,
        rtdbPath,
        extractedFrames: matched.map((m) => m.requestedName),
        missingFrames: missing,
        size: { w: totalWidth, h: totalHeight },
        files: {
          png: pngFilePath,
          json: jsonFilePath,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
