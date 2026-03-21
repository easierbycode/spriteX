#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DATABASE_URL = "https://evil-invaders-default-rtdb.firebaseio.com";

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

function decodeBase64Png(raw) {
  const cleaned = raw.replace(/^data:image\/png;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

/** Normalize atlas JSON that may be stored as a string (possibly double-encoded). */
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

/** Decode hex-encoded frame keys produced by encodeAtlasFrameKey. */
function decodeFrameKey(key) {
  if (!key.startsWith("k_")) return key;
  const hex = key.slice(2);
  let result = "";
  for (let i = 0; i < hex.length; i += 4) {
    result += String.fromCodePoint(parseInt(hex.slice(i, i + 4), 16));
  }
  return result;
}

/** List all frame names in an atlas JSON object. */
function listFrameNames(atlasJson) {
  const framesMap = atlasJson?.frames ?? atlasJson?.textures?.[0]?.frames;
  if (!framesMap || typeof framesMap !== "object") return [];
  return Object.keys(framesMap).map(decodeFrameKey);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gameName = args.gameName;
  const atlasName = args.atlasName;
  const outDir = args.outDir || "downloads";
  const listOnly = args.list === "true";

  if (!atlasName) {
    console.error(
      "Usage: node scripts/download-atlas.mjs --atlasName <name> [--gameName <name>] [--outDir <dir>] [--list]"
    );
    process.exit(1);
  }

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

  const pngRaw = atlas.png;
  const jsonRaw = atlas.json;

  if (typeof pngRaw !== "string") {
    throw new Error(`Missing png base64 at ${rtdbPath}/png`);
  }

  if (jsonRaw == null) {
    throw new Error(`Missing json payload at ${rtdbPath}/json`);
  }

  // Normalize JSON (may be double-encoded string)
  const atlasJson = normalizeAtlasJson(jsonRaw) ?? jsonRaw;

  // --list mode: just print frame names and exit
  if (listOnly) {
    const names = listFrameNames(typeof atlasJson === "object" ? atlasJson : null);
    console.log(JSON.stringify({ atlasName, rtdbPath, frameCount: names.length, frames: names }, null, 2));
    return;
  }

  const pngBuffer = decodeBase64Png(pngRaw);

  let jsonText;
  if (typeof atlasJson === "object") {
    jsonText = `${JSON.stringify(atlasJson, null, 2)}\n`;
  } else if (typeof atlasJson === "string") {
    try {
      jsonText = `${JSON.stringify(JSON.parse(atlasJson), null, 2)}\n`;
    } catch {
      jsonText = `${atlasJson}\n`;
    }
  } else {
    jsonText = `${JSON.stringify(jsonRaw, null, 2)}\n`;
  }

  const outputDirectory = path.resolve(outDir);
  await mkdir(outputDirectory, { recursive: true });

  const pngFilePath = path.join(outputDirectory, `${atlasName}.png`);
  const jsonFilePath = path.join(outputDirectory, `${atlasName}.json`);

  await writeFile(pngFilePath, pngBuffer);
  await writeFile(jsonFilePath, jsonText, "utf8");

  console.log(
    JSON.stringify(
      {
        atlasName,
        gameName: gameName || null,
        rtdbPath,
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
