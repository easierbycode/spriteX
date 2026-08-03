#!/usr/bin/env node
/**
 * spriteX MCP server (stdio).
 *
 * Exposes the spriteX / Evil Invaders Firebase atlas catalog to MCP clients:
 *   spritex_list_games          — game names in the catalog
 *   spritex_list_atlases        — atlas names (global or game-scoped)
 *   spritex_list_frames         — frame names inside one atlas
 *   spritex_download_atlas      — write an atlas PNG + JSON to disk
 *   spritex_extract_frames      — pack a subset of frames into a new atlas
 *   spritex_optimize_game_atlas — build the optimized atlas for a game (only
 *                                 the assets the game actually uses, from
 *                                 static game data + runtime usage reports)
 *   spritex_get_usage_report    — runtime usage recorded by the Phaser plugin
 *
 * Registered for this repo via .mcp.json; run manually with:
 *   node mcp/server.mjs
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { optimizeGameAtlas, decodeFrameKey } from "../scripts/optimize-atlas.mjs";

const DATABASE_URL = "https://evil-invaders-default-rtdb.firebaseio.com";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "downloads");

/** ─── helpers ──────────────────────────────────────────────────────────── */

async function fetchJson(rtdbPath) {
  const res = await fetch(`${DATABASE_URL}/${rtdbPath}.json`);
  if (!res.ok) {
    throw new Error(`RTDB request failed (${res.status} ${res.statusText}) for ${rtdbPath}`);
  }
  return res.json();
}

function normalizeAtlasJson(jsonVal) {
  if (jsonVal == null) return null;
  if (typeof jsonVal === "object") return jsonVal;
  if (typeof jsonVal !== "string") return null;
  try {
    const once = JSON.parse(jsonVal.trim());
    return typeof once === "string" ? JSON.parse(once) : once;
  } catch {
    return null;
  }
}

function ok(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run one of the repo's CLI scripts and parse its JSON stdout. */
function runScript(scriptName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "scripts", scriptName), ...args], {
      cwd: REPO_ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${scriptName} exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`${scriptName} produced non-JSON output: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

const gameParam = z
  .string()
  .optional()
  .describe("Game name for game-scoped lookups (e.g. 'evil-invaders'). Omit for the global catalog.");

/** ─── server ───────────────────────────────────────────────────────────── */

const server = new McpServer({ name: "spritex", version: "1.0.0" });

server.registerTool(
  "spritex_list_games",
  {
    title: "List spriteX games",
    description:
      "List the game names stored in the spriteX catalog (/games/*). Games hold character data, game-scoped atlases, and runtime asset-usage reports.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const res = await fetch(`${DATABASE_URL}/games.json?shallow=true`);
    if (!res.ok) return fail(`RTDB request failed (${res.status}) for games`);
    const data = await res.json();
    const names = data && typeof data === "object" ? Object.keys(data).sort() : [];
    return ok({ count: names.length, games: names });
  }
);

server.registerTool(
  "spritex_list_atlases",
  {
    title: "List spriteX atlases",
    description:
      "List atlas names in the spriteX catalog — the global catalog by default, or one game's atlases when 'game' is given.",
    inputSchema: { game: gameParam },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ game }) => {
    const base = game ? `games/${game}/atlases` : "atlases";
    const res = await fetch(`${DATABASE_URL}/${base}.json?shallow=true`);
    if (!res.ok) return fail(`RTDB request failed (${res.status}) for ${base}`);
    const data = await res.json();
    const names = data && typeof data === "object" ? Object.keys(data).sort() : [];
    return ok({ scope: game ? `game:${game}` : "global", count: names.length, atlases: names });
  }
);

server.registerTool(
  "spritex_list_frames",
  {
    title: "List frames in an atlas",
    description:
      "List the (decoded, human-readable) frame names inside one spriteX atlas, plus the atlas sheet dimensions.",
    inputSchema: {
      atlas: z.string().describe("Atlas name, e.g. '2028_game_asset'"),
      game: gameParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ atlas, game }) => {
    const rtdbPath = game ? `games/${game}/atlases/${atlas}` : `atlases/${atlas}`;
    const json = normalizeAtlasJson(await fetchJson(`${rtdbPath}/json`));
    const framesMap = json?.frames ?? json?.textures?.[0]?.frames;
    if (!framesMap) {
      return fail(
        `No atlas JSON found at ${rtdbPath}. Use spritex_list_atlases to see valid names` +
          (game ? " (or drop 'game' to search the global catalog)." : ".")
      );
    }
    const frames = Object.keys(framesMap).map(decodeFrameKey).sort();
    return ok({ atlas, game: game ?? null, frameCount: frames.length, size: json?.meta?.size ?? null, frames });
  }
);

server.registerTool(
  "spritex_download_atlas",
  {
    title: "Download an atlas",
    description:
      "Download a full spriteX atlas (PNG sprite sheet + TexturePacker-style JSON) to disk and return the file paths. Files go to the spriteX downloads/ directory unless outDir is given.",
    inputSchema: {
      atlas: z.string().describe("Atlas name to download"),
      game: gameParam,
      outDir: z.string().optional().describe("Output directory (default: <spriteX>/downloads)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ atlas, game, outDir }) => {
    const args = ["--atlasName", atlas, "--outDir", outDir ?? DEFAULT_OUT_DIR];
    if (game) args.push("--gameName", game);
    return ok(await runScript("download-atlas.mjs", args));
  }
);

server.registerTool(
  "spritex_extract_frames",
  {
    title: "Extract frames into a new atlas",
    description:
      "Extract a named subset of frames from a spriteX atlas and repack them into a new atlas PNG + JSON on disk. Use spritex_list_frames first to get exact frame names.",
    inputSchema: {
      atlas: z.string().describe("Source atlas name"),
      frames: z.array(z.string()).min(1).describe("Frame names to extract (readable names, e.g. 'player00.gif')"),
      game: gameParam,
      outDir: z.string().optional().describe("Output directory (default: <spriteX>/downloads)"),
      outName: z.string().optional().describe("Output atlas name (default: <atlas>_extract)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ atlas, frames, game, outDir, outName }) => {
    const args = ["--atlasName", atlas, "--frames", frames.join(","), "--outDir", outDir ?? DEFAULT_OUT_DIR];
    if (game) args.push("--gameName", game);
    if (outName) args.push("--outName", outName);
    return ok(await runScript("extract-frames.mjs", args));
  }
);

server.registerTool(
  "spritex_optimize_game_atlas",
  {
    title: "Build a game's optimized atlas",
    description:
      "Build an optimized atlas for a game containing only the assets the game actually uses. " +
      "Used assets come from the game's data tree in RTDB (texture[] frame references) merged with " +
      "runtime usage recorded by the SpriteXPlugin Phaser plugin (/games/{game}/assetUsage). " +
      "Frames are resolved across the whole atlas catalog, packed into a single sheet, and written " +
      "to disk as PNG + JSON. Set list=true for a dry-run report (no files); set save=true to also " +
      "publish the atlas to RTDB at /games/{game}/atlases/{outName} so games can boot from it.",
    inputSchema: {
      game: z.string().describe("Game name, e.g. 'evil-invaders'"),
      source: z
        .enum(["static", "usage", "both"])
        .optional()
        .describe("Which used-asset sources to read: 'static' (game data), 'usage' (runtime reports), 'both' (default)"),
      outDir: z.string().optional().describe("Output directory (default: <spriteX>/downloads)"),
      outName: z.string().optional().describe("Atlas name (default: <game>_optimized)"),
      atlases: z.array(z.string()).optional().describe("Extra candidate atlases to resolve frames against"),
      list: z.boolean().optional().describe("Dry run: report used/resolved frames without writing files"),
      save: z.boolean().optional().describe("Also publish the optimized atlas to RTDB under the game scope"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ game, source, outDir, outName, atlases, list, save }) => {
    const messages = [];
    const result = await optimizeGameAtlas({
      gameName: game,
      source: source ?? "both",
      outDir: outDir ?? DEFAULT_OUT_DIR,
      outName: outName || undefined,
      extraAtlases: atlases ?? [],
      listOnly: list ?? false,
      save: save ?? false,
      log: (msg) => messages.push(msg),
    });
    return ok({ ...result, log: messages });
  }
);

server.registerTool(
  "spritex_get_usage_report",
  {
    title: "Get a game's runtime asset usage",
    description:
      "Read the runtime asset-usage report recorded by the SpriteXPlugin Phaser plugin at /games/{game}/assetUsage: which texture frames the game actually touched. Returns decoded texture keys and frame names.",
    inputSchema: { game: z.string().describe("Game name, e.g. 'evil-invaders'") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ game }) => {
    const raw = await fetchJson(`games/${game}/assetUsage`);
    if (!raw || typeof raw !== "object") {
      return ok({
        game,
        textures: {},
        note:
          "No runtime usage recorded yet. Run the game with the SpriteXPlugin " +
          "(trackUsage + autoSaveUsage, or call plugin.saveUsageReport()) to populate it.",
      });
    }
    const textures = {};
    let lastUpdated = null;
    for (const [texKey, frameMap] of Object.entries(raw)) {
      if (texKey === "_meta") {
        lastUpdated = frameMap?.lastUpdated ?? null;
        continue;
      }
      textures[decodeFrameKey(texKey)] =
        frameMap && typeof frameMap === "object" ? Object.keys(frameMap).map(decodeFrameKey).sort() : [];
    }
    return ok({ game, lastUpdated, textureCount: Object.keys(textures).length, textures });
  }
);

/** ─── start ────────────────────────────────────────────────────────────── */

await server.connect(new StdioServerTransport());
console.error("spritex MCP server running on stdio");
