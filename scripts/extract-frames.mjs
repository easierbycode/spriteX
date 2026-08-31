#!/usr/bin/env node
/**
 * extract-frames.mjs
 *
 * Downloads an atlas from Firebase RTDB and extracts a subset of frames by
 * name, either repacked into a new atlas PNG + JSON or split into one PNG per
 * frame.
 *
 * Usage:
 *   node scripts/extract-frames.mjs \
 *     --atlasName <name> \
 *     --frames "frame1,frame2,frame3" \
 *     [--gameName <name>] \
 *     [--outDir <dir>] \
 *     [--outName <name>] \
 *     [--split]
 *
 * The --frames flag accepts a comma-separated list of frame names.
 * Frame names are matched against both raw keys and decoded hex-encoded keys,
 * in both the hash and array atlas layouts (see frame-keys.mjs).
 *
 * Output: <outName>.png and <outName>.json in <outDir> (default: downloads/),
 * or with --split, one <frameName>.png per frame — each restored to its full
 * sourceSize, so trimmed frames come back padded to their original dimensions.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

import {
  encodeFrameKey,
  decodeFrameKey,
  decodeAtlasJsonFrames,
  getFrameEntries,
  drawFrame,
} from "./frame-keys.mjs";
export { encodeFrameKey, decodeFrameKey, decodeAtlasJsonFrames };

// ─── Frame drawing ───────────────────────────────────────────────────────────

/** Frame names double as file names; keep them from escaping the output dir. */
function frameFileName(name) {
  const flat = name.replace(/[\\/]+/g, "_").replace(/^\.+/, "_");
  return flat.toLowerCase().endsWith(".png") ? flat : `${flat}.png`;
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
  const split = args.split === "true";

  if (!atlasName || !framesCsv) {
    console.error(
      `Usage: node scripts/extract-frames.mjs \\
  --atlasName <name> \\
  --frames "frame1,frame2,frame3" \\
  [--gameName <name>] \\
  [--outDir <dir>] \\
  [--outName <name>] \\
  [--split]`
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

  const entries = getFrameEntries(atlasJson);
  if (entries.length === 0) {
    throw new Error("Atlas JSON has no frames.");
  }

  // ── Match requested frames ─────────────────────────────────────────────────

  // Index once rather than re-flattening the atlas per requested frame.
  // Readable names win over raw k_-hex keys, matching findFrameEntry.
  const byKey = new Map();
  for (const e of entries) if (!byKey.has(e.rawKey)) byKey.set(e.rawKey, e);
  for (const e of entries) byKey.set(e.name, e);

  const matched = [];
  const missing = [];
  for (const name of requestedFrames) {
    const found = byKey.get(decodeFrameKey(name)) ?? byKey.get(name) ?? null;
    if (found) {
      matched.push({ requestedName: name, key: found.rawKey, data: found.data });
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

  const outputDirectory = path.resolve(outDir);
  await mkdir(outputDirectory, { recursive: true });

  // ── --split: one PNG per frame, no atlas ───────────────────────────────────

  if (split) {
    const written = [];
    for (const m of matched) {
      const f = m.data.frame;
      // Restore the untrimmed image: a trimmed frame is placed back at its
      // spriteSourceSize offset inside a canvas of the original sourceSize.
      const offset = m.data.spriteSourceSize ?? { x: 0, y: 0 };
      const size = m.data.sourceSize ?? { w: f.w, h: f.h };
      const canvas = createCanvas(Math.max(1, size.w), Math.max(1, size.h));
      drawFrame(canvas.getContext("2d"), srcImage, m.data, offset.x ?? 0, offset.y ?? 0);
      const file = path.join(outputDirectory, frameFileName(m.requestedName));
      await writeFile(file, canvas.toBuffer("image/png"));
      written.push({ frame: m.requestedName, file, size: { w: size.w, h: size.h } });
    }

    console.log(
      JSON.stringify(
        {
          atlasName,
          gameName: gameName || null,
          rtdbPath,
          split: true,
          outDir: outputDirectory,
          extractedFrames: written.map((w) => w.frame),
          missingFrames: missing,
          files: written,
        },
        null,
        2
      )
    );
    return;
  }

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
    drawFrame(ctx, srcImage, p.srcData, p.destX, p.destY);
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

const runAsCli =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runAsCli) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
