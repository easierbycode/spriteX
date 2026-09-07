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
 *   spritex_list_fonts          — bitmap fonts published under /fonts (meta + sizes only)
 *   spritex_get_font            — one font's RetroFont config + meta; outDir also
 *                                 writes its TTF, sheet PNG and config to disk
 *
 * Registered for this repo via .mcp.json; run manually with:
 *   node mcp/server.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { optimizeGameAtlas, decodeFrameKey } from "../scripts/optimize-atlas.mjs";
import { listFrameNames } from "../scripts/frame-keys.mjs";

const DATABASE_URL = "https://evil-invaders-default-rtdb.firebaseio.com";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "downloads");

/** ─── helpers ──────────────────────────────────────────────────────────── */

async function fetchJson(rtdbPath, { shallow = false } = {}) {
  const res = await fetch(`${DATABASE_URL}/${rtdbPath}.json${shallow ? "?shallow=true" : ""}`);
  if (!res.ok) {
    throw new Error(`RTDB request failed (${res.status} ${res.statusText}) for ${rtdbPath}`);
  }
  return res.json();
}

/**
 * Byte length of a leaf's JSON body without downloading it. Firebase rejects
 * HEAD, so read Content-Length off a GET and drop the stream — base64 sheets
 * and TTFs run to megabytes and a listing only needs their size. identity
 * encoding keeps the header at the raw length (fetch asks for gzip otherwise).
 */
async function fetchLeafLength(rtdbPath) {
  const controller = new AbortController();
  const res = await fetch(`${DATABASE_URL}/${rtdbPath}.json`, {
    headers: { "accept-encoding": "identity" },
    signal: controller.signal,
  });
  const length = res.headers.get("content-length");
  controller.abort();
  return res.ok && length != null ? Number(length) : null;
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

/** Base64 leaf → bytes. Sheets carry a data:image/png;base64, prefix; TTFs are bare. */
function decodeBase64(raw) {
  return Buffer.from(raw.replace(/^data:[^,]*;base64,/, ""), "base64");
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
    const frames = listFrameNames(json).sort();
    if (frames.length === 0) {
      return fail(
        `No atlas JSON found at ${rtdbPath}. Use spritex_list_atlases to see valid names` +
          (game ? " (or drop 'game' to search the global catalog)." : ".")
      );
    }
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
    title: "Extract frames from an atlas",
    description:
      "Extract a named subset of frames from a spriteX atlas to disk: repacked into a new atlas PNG + JSON, or with split=true one PNG per frame (restored to its untrimmed size). Use spritex_list_frames first to get exact frame names.",
    inputSchema: {
      atlas: z.string().describe("Source atlas name"),
      frames: z.array(z.string()).min(1).describe("Frame names to extract (readable names, e.g. 'player00.gif')"),
      game: gameParam,
      outDir: z.string().optional().describe("Output directory (default: <spriteX>/downloads)"),
      outName: z.string().optional().describe("Output atlas name (default: <atlas>_extract); ignored when split is true"),
      split: z
        .boolean()
        .optional()
        .describe("Write one PNG per frame (named after the frame) instead of a packed atlas"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ atlas, frames, game, outDir, outName, split }) => {
    const args = ["--atlasName", atlas, "--frames", frames.join(","), "--outDir", outDir ?? DEFAULT_OUT_DIR];
    if (game) args.push("--gameName", game);
    if (outName) args.push("--outName", outName);
    if (split) args.push("--split");
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

server.registerTool(
  "spritex_list_fonts",
  {
    title: "List spriteX fonts",
    description:
      "List the bitmap fonts published under /fonts/*: glyph cell size, character order, TrueType glyph count, " +
      "provenance, and whether a TTF is present. Reads each font's meta plus leaf sizes only — never the sheet or TTF bodies.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const res = await fetch(`${DATABASE_URL}/fonts.json?shallow=true`);
    if (!res.ok) return fail(`RTDB request failed (${res.status}) for fonts`);
    const data = await res.json();
    const families = data && typeof data === "object" ? Object.keys(data).sort() : [];
    const fonts = await Promise.all(
      families.map(async (family) => {
        const [meta, leaves] = await Promise.all([
          fetchJson(`fonts/${family}/meta`),
          fetchJson(`fonts/${family}`, { shallow: true }),
        ]);
        const chars = typeof meta?.chars === "string" ? meta.chars : null;
        let pngBytes = 0;
        if (leaves?.png === true) {
          // The body is the quoted data-URL string; base64 never needs escaping,
          // so minus the quotes is the string's length. Report the decoded PNG
          // size (3/4 of the base64 after the data: prefix) so it lines up with
          // spritex_get_font's sizes.png rather than the stored string length.
          const bodyLength = await fetchLeafLength(`fonts/${family}/png`);
          pngBytes = bodyLength == null
            ? null
            : Math.max(0, Math.floor((bodyLength - 2 - "data:image/png;base64,".length) * 3 / 4));
        }
        return {
          family,
          cell: meta?.cell ?? null,
          chars: chars == null ? null : { length: chars.length, head: chars.slice(0, 40) },
          charSet: meta?.charSet ?? null,
          glyphs: meta?.glyphs ?? null,
          source: meta?.source ?? null,
          exportedAt: meta?.exportedAt ?? null,
          hasTtf: leaves?.ttf === true,
          pngBytes,
        };
      })
    );
    return ok({ count: fonts.length, fonts });
  }
);

server.registerTool(
  "spritex_get_font",
  {
    title: "Get a spriteX font",
    description:
      "Read one bitmap font from /fonts/{family}: its Phaser RetroFont config, meta, and decoded PNG/TTF byte sizes. " +
      "Give outDir to also write <family>.ttf, <family>.png and <family>.retrofont.js there and return the paths. " +
      "Base64 bodies are never returned inline. Use spritex_list_fonts for valid family names.",
    inputSchema: {
      family: z.string().describe("Font family name, e.g. 'athenaFont' (the key under /fonts)"),
      outDir: z
        .string()
        .optional()
        .describe("Output directory (relative paths resolve against the spriteX repo); omit to write no files"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ family, outDir }) => {
    // The family is both the RTDB key and an output filename: anything but a
    // plain identifier could walk the URL to another node ("../atlases/x") or
    // the files out of outDir. Same rule scripts/export-font.mjs publishes by.
    if (!/^[\w-]+$/.test(family)) {
      return fail(`Font family must be a plain identifier (letters, digits, _ or -), got ${JSON.stringify(family)}.`);
    }
    const rtdbPath = `fonts/${family}`;
    const record = await fetchJson(rtdbPath);
    if (!record || typeof record !== "object") {
      return fail(`No font found at ${rtdbPath}. Use spritex_list_fonts to see valid names.`);
    }
    const json = typeof record.json === "string" ? record.json : null;
    const png = typeof record.png === "string" ? decodeBase64(record.png) : null;
    const ttf = typeof record.ttf === "string" ? decodeBase64(record.ttf) : null;
    let files = null;
    if (outDir) {
      const dir = path.resolve(REPO_ROOT, outDir);
      await mkdir(dir, { recursive: true });
      files = { ttf: null, png: null, retrofont: null };
      if (ttf) {
        files.ttf = path.join(dir, `${family}.ttf`);
        await writeFile(files.ttf, ttf);
      }
      if (png) {
        files.png = path.join(dir, `${family}.png`);
        await writeFile(files.png, png);
      }
      if (json != null) {
        files.retrofont = path.join(dir, `${family}.retrofont.js`);
        await writeFile(files.retrofont, json.endsWith("\n") ? json : `${json}\n`, "utf8");
      }
    }
    return ok({
      family,
      rtdbPath,
      json,
      meta: record.meta ?? null,
      sizes: { png: png?.length ?? 0, ttf: ttf?.length ?? 0 },
      files,
    });
  }
);

/** ─── start ────────────────────────────────────────────────────────────── */

await server.connect(new StdioServerTransport());
console.error("spritex MCP server running on stdio");
