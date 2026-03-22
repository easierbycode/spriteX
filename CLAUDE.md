# spriteX — Claude Project Guide

## Project Overview
spriteX is a browser-based sprite atlas builder and manager for the Evil Invaders game engine. It uses Firebase Realtime Database (RTDB) to store atlas assets (PNG as base64, JSON metadata).

## Key Architecture
- **`src/main.ts`** — Browser UI entry point (atlas builder, sprite detection, animation preview)
- **`src/atlasManager.ts`** — Core atlas logic: Firebase CRUD, sprite detection, atlas packing, frame key encoding
- **`src/firebase-config.ts`** — Firebase initialization and DB exports
- **`scripts/download-atlas.mjs`** — CLI: download full atlas from RTDB
- **`scripts/extract-frames.mjs`** — CLI: extract subset of frames into new atlas PNG+JSON
- **`scripts/canvas-shim.mjs`** — Node.js canvas wrapper (@napi-rs/canvas)

## Firebase RTDB Structure
```
/atlases/{atlasName}/json  — Atlas JSON (may be stringified/double-encoded)
/atlases/{atlasName}/png   — Base64 PNG (may have data:image/png;base64, prefix)
/games/{gameName}/atlases/{atlasName}/  — Game-specific atlases (same shape)
/characters/{id}/          — Character data with texture[] frame references
/sprites/{id}/             — Individual sprite images
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

## Build
```bash
npm run build        # esbuild + copy static assets
npm run build:web    # esbuild only
```

## Common Tasks
- List all atlases: `curl -s "https://evil-invaders-default-rtdb.firebaseio.com/atlases.json?shallow=true"`
- List frames: `npm run download:atlas -- --atlasName <name> --list`
- Download atlas: `npm run download:atlas -- --atlasName <name>`
- Extract frames: `npm run extract:frames -- --atlasName <name> --frames "f1,f2"`
