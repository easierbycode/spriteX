# Atlas Manager

Manage sprite atlas assets from the Firebase RTDB for the spriteX project.

## Available Operations

### 1. List all atlases
```bash
curl -s "https://evil-invaders-default-rtdb.firebaseio.com/atlases.json?shallow=true" | node -e "process.stdin.on('data',d=>console.log(Object.keys(JSON.parse(d)).join('\n')))"
```

### 2. List frames in an atlas
```bash
node scripts/download-atlas.mjs --atlasName <ATLAS_NAME> --list
```

### 3. Download a full atlas (PNG + JSON)
```bash
node scripts/download-atlas.mjs --atlasName <ATLAS_NAME> [--gameName <GAME_NAME>] [--outDir <DIR>]
```

### 4. Extract specific frames into a new sub-atlas
```bash
node scripts/extract-frames.mjs \
  --atlasName <ATLAS_NAME> \
  --frames "frame1,frame2,frame3" \
  [--gameName <GAME_NAME>] \
  [--outDir <DIR>] \
  [--outName <OUTPUT_NAME>]
```

## Workflow

When the user asks for atlas operations, follow this process:

1. **Identify the atlas**: If the user names an atlas, use it directly. Otherwise list available atlases and help them choose.
2. **Identify frames**: If the user needs specific frames, first list all frames in the atlas with `--list`, then confirm the frame names.
3. **Extract or download**: Use `extract-frames.mjs` for subsets or `download-atlas.mjs` for full atlases.
4. **Report results**: Show the user the output JSON which includes file paths, dimensions, and any missing frames.

## Arguments for $ARGUMENTS

The user may provide:
- An atlas name (e.g., "duke_atlas", "bowsette", "mario")
- Frame names (e.g., "duke_0,duke_1")
- A game name for game-specific atlases
- An output directory or name

Parse $ARGUMENTS to determine which operation to run.

## Notes

- Frame keys may be hex-encoded (prefixed with `k_`). The scripts handle decoding automatically.
- All output is JSON for easy parsing.
- Output files go to `downloads/` by default.
- The `--outName` flag controls the output filename prefix for extracted atlases.
