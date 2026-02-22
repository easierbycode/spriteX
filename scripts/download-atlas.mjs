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

function normalizeGameName(gameName) {
  return gameName.replace(/-phaser\d+$/i, "");
}

function normalizeAtlasName(atlasName) {
  if (atlasName === "game_asset") return "game_ui";
  return atlasName;
}

function decodeBase64Png(raw) {
  const cleaned = raw.replace(/^data:image\/png;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gameName = args.gameName;
  const atlasName = args.atlasName;
  const outDir = args.outDir || "downloads";

  if (!gameName || !atlasName) {
    console.error(
      "Usage: node scripts/download-atlas.mjs --gameName <name> --atlasName <name> [--outDir <dir>]"
    );
    process.exit(1);
  }

  const normalizedGameName = normalizeGameName(gameName);
  const normalizedAtlasName = normalizeAtlasName(atlasName);
  const rtdbPath = `games/${normalizedGameName}/atlases/${normalizedAtlasName}`;
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

  const pngBuffer = decodeBase64Png(pngRaw);

  let jsonText;
  if (typeof jsonRaw === "string") {
    try {
      jsonText = `${JSON.stringify(JSON.parse(jsonRaw), null, 2)}\n`;
    } catch {
      jsonText = `${jsonRaw}\n`;
    }
  } else {
    jsonText = `${JSON.stringify(jsonRaw, null, 2)}\n`;
  }

  const outputDirectory = path.resolve(outDir);
  await mkdir(outputDirectory, { recursive: true });

  const pngFilePath = path.join(outputDirectory, `${normalizedAtlasName}.png`);
  const jsonFilePath = path.join(outputDirectory, `${normalizedAtlasName}.json`);

  await writeFile(pngFilePath, pngBuffer);
  await writeFile(jsonFilePath, jsonText, "utf8");

  console.log(
    JSON.stringify(
      {
        gameName,
        atlasName,
        normalizedGameName,
        normalizedAtlasName,
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
