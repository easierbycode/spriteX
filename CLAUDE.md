# spriteX — Claude Project Guide

## Project Overview
spriteX is a browser-based sprite atlas builder and manager for the Evil Invaders game engine. It uses Firebase Realtime Database (RTDB) to store atlas assets (PNG as base64, JSON metadata).

## Key Architecture
- **`src/main.ts`** — Browser UI entry point (atlas builder, sprite detection, animation preview)
- **`src/atlasManager.ts`** — Core atlas logic: Firebase CRUD, sprite detection, atlas packing, frame key encoding
- **`src/tilemapEditor.ts`** — TILEMAP tab: Tiled JSON map upload (map + tileset JSON + tileset PNG), layer rendering, tile/object editing, undo, RTDB tilemaps/* save/load
- **`src/gamepad.ts`** — App-wide gamepad support: virtual cursor, synthesized clicks, tab switching, tilemap grid-mode bindings
- **`src/firebase-config.ts`** — Firebase initialization and DB exports
- **`src/phaser-plugin/spritexPlugin.ts`** — SpriteXPlugin: Phaser 3 global plugin (live asset loading from RTDB, runtime usage tracking, optimized atlas creation). Built to `dist/plugin/` (ESM + IIFE)
- **`scripts/download-atlas.mjs`** — CLI: download full atlas from RTDB
- **`scripts/extract-frames.mjs`** — CLI: extract subset of frames into new atlas PNG+JSON
- **`scripts/optimize-atlas.mjs`** — CLI: build a game's optimized atlas (only the assets it actually uses, from static game data + runtime usage reports)
- **`scripts/canvas-shim.mjs`** — Node.js canvas wrapper (@napi-rs/canvas)
- **`mcp/server.mjs`** — spriteX MCP server (stdio; registered via `.mcp.json`): list/download/extract atlas tools plus `spritex_optimize_game_atlas` and `spritex_get_usage_report`

## Firebase RTDB Structure
```
/atlases/{atlasName}/json  — Atlas JSON (may be stringified/double-encoded)
/atlases/{atlasName}/png   — Base64 PNG (may have data:image/png;base64, prefix)
/games/{gameName}/atlases/{atlasName}/  — Game-specific atlases (same shape)
/games/{gameName}/assetUsage/{texKey}/{frameKey}  — Runtime usage recorded by SpriteXPlugin (keys hex-encoded)
/characters/{id}/          — Character data with texture[] frame references
/sprites/{id}/             — Individual sprite images
/tilemaps/{name}/json      — Tiled map JSON (stringified)
/tilemaps/{name}/tileset   — External tileset JSON (stringified, optional)
/tilemaps/{name}/png       — Tileset image as data URL
```

## Atlas JSON Format
Standard texture atlas format with:
- `frames` map: `{ "frameName": { frame: {x,y,w,h}, rotated, trimmed, spriteSourceSize, sourceSize } }`
- `meta`: `{ app, version, image, format, size: {w,h}, scale }`
- Frame keys may be hex-encoded (`k_` prefix) for Firebase RTDB compatibility

## CLI Tools

### Download full atlas
```bash
node scripts/download-atlas.mjs --atlasName <name> [--gameName <name>] [--outDir <dir>] [--list]
```
- `--list` mode outputs frame names as JSON without saving files

### Extract specific frames
```bash
node scripts/extract-frames.mjs --atlasName <name> --frames "f1,f2,f3" [--gameName <name>] [--outDir <dir>] [--outName <name>]
```
- Fetches atlas from RTDB, extracts named frames, packs into new atlas
- Output: new PNG + JSON in outDir

### Build a game's optimized atlas
```bash
node scripts/optimize-atlas.mjs --gameName <name> [--source static|usage|both] [--outDir <dir>] [--outName <name>] [--list] [--save] [--atlases "a,b"] [--no-scan]
```
- Used assets = the game's `texture[]` references in RTDB merged with runtime usage from `/games/{name}/assetUsage`
- Frames resolve against game atlases, hinted atlases, then a JSON-only scan of the whole catalog
- `--list` = dry-run report; `--save` publishes to `/games/{name}/atlases/{outName}`

## Phaser Plugin (SpriteXPlugin)
`src/phaser-plugin/spritexPlugin.ts` → `dist/plugin/spritex-phaser-plugin.js` (ESM) and `.iife.js` (`window.SpriteXPlugin`). Zero deps; talks to RTDB over REST. Register as a Phaser global plugin with data `{ gameName, liveLoad, trackUsage, autoSaveUsage, useOptimizedAtlas }`:
- **Live loading**: `load.image(key)` / `load.spritesheet(key, null, frameConfig)` / `load.atlas(key)` without URLs fetch from RTDB (`/sprites`, `/atlases`, `/games/{g}/atlases`); `spritex://<rtdb-path>` URLs always intercept
- **Usage tracking**: records touched texture frames; `saveUsageReport()` PATCHes them to `/games/{g}/assetUsage` (hex-encoded keys)
- **Optimized atlas**: `createOptimizedAtlas({save, download})` packs used frames in-browser; `useOptimizedAtlas: true` boots from the saved optimized atlas and satisfies load calls from it (aliasing textures, no network)
- Needs the Phaser namespace: auto-detects `globalThis.Phaser`, or `SpriteXPlugin.install(Phaser)` / plugin data `{ phaser }`

## MCP Server
`mcp/server.mjs` (stdio, `@modelcontextprotocol/sdk`), registered in `.mcp.json`. Tools: `spritex_list_games`, `spritex_list_atlases`, `spritex_list_frames`, `spritex_download_atlas`, `spritex_extract_frames`, `spritex_optimize_game_atlas` (the optimizer above; `list`/`save` flags), `spritex_get_usage_report`.

## Build
```bash
npm run build        # esbuild (app + plugin) + copy static assets
npm run build:web    # app esbuild only
npm run build:plugin # Phaser plugin only → dist/plugin/
```

## Common Tasks
- List all atlases: `curl -s "https://evil-invaders-default-rtdb.firebaseio.com/atlases.json?shallow=true"`
- List frames: `npm run download:atlas -- --atlasName <name> --list`
- Download atlas: `npm run download:atlas -- --atlasName <name>`
- Extract frames: `npm run extract:frames -- --atlasName <name> --frames "f1,f2"`
