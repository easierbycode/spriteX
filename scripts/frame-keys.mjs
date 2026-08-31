/**
 * frame-keys.mjs
 *
 * Pure helpers for reading atlas frames: the k_-hex frame-key encoding that
 * legacy RTDB object-tree atlas records carry (RTDB keys cannot contain
 * . # $ / [ ]), plus shape-agnostic accessors for the two frame layouts an
 * atlas JSON can use. No dependencies, safe to import from any script.
 * Mirrors src/atlasManager.ts.
 */

export function encodeFrameKey(name) {
  // Idempotent: a name that already decodes as a k_-hex key is passed through
  // untouched, so rebuilding an atlas never stacks a second encoding layer.
  if (decodeFrameKey(name) !== name) return name;
  // Encode UTF-16 code units, not code points: decodeFrameKey slices the hex
  // in fixed 4-digit chunks, and astral chars (emoji) would emit 5-digit
  // groups that break the round-trip.
  let hex = "";
  for (let i = 0; i < name.length; i += 1) {
    hex += name.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return `k_${hex}`;
}

export function decodeFrameKey(key) {
  if (typeof key !== "string" || !key.startsWith("k_")) return key;
  const hex = key.slice(2);
  // Not an encoding, just a name that happens to start with k_ — pass through.
  if (hex.length === 0 || hex.length % 4 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return key;
  }
  let result = "";
  for (let i = 0; i < hex.length; i += 4) {
    result += String.fromCodePoint(parseInt(hex.slice(i, i + 4), 16));
  }
  return result;
}

/**
 * Return a copy of atlas JSON with every k_-hex frame key decoded back to its
 * real name. Atlases that round-tripped through RTDB as object trees carry the
 * encoded keys; anything writing atlas JSON to disk should pass it through
 * this first. Idempotent on already-clean JSON.
 */
export function decodeAtlasJsonFrames(atlasJson) {
  if (!atlasJson || typeof atlasJson !== "object") return atlasJson;
  const decodeMap = (framesMap) => {
    if (!framesMap || typeof framesMap !== "object") return framesMap;
    if (Array.isArray(framesMap)) {
      return framesMap.map((f) =>
        f && typeof f === "object" && typeof f.filename === "string"
          ? { ...f, filename: decodeFrameKey(f.filename) }
          : f
      );
    }
    const decoded = {};
    for (const [k, v] of Object.entries(framesMap)) decoded[decodeFrameKey(k)] = v;
    return decoded;
  };

  const copy = JSON.parse(JSON.stringify(atlasJson));
  if (copy.frames) copy.frames = decodeMap(copy.frames);
  if (Array.isArray(copy.textures)) {
    copy.textures = copy.textures.map((t) =>
      t && typeof t === "object" && t.frames ? { ...t, frames: decodeMap(t.frames) } : t
    );
  }
  return copy;
}

// ─── frame layout helpers ────────────────────────────────────────────────────
//
// Atlas JSON stores frames in one of two shapes:
//
//   hash form   { frames: { "hexagram0.png": { frame, … } } }
//   array form  { textures: [ { frames: [ { filename: "hexagram0.png", … } ] } ] }
//
// TexturePacker's "Phaser 3" export writes the array form, so anything that
// treats frames as a plain map sees the array indices ("0", "1", …) as the
// frame names and can never match a real one. Read frames through these
// helpers instead of indexing `.frames` directly.

/**
 * Flatten an atlas JSON's frames into `[{ name, rawKey, data }]`, where `name`
 * is the decoded frame name and `rawKey` is the key/filename exactly as stored
 * (still k_-hex encoded if it was). Handles both layouts, plus multi-texture
 * JSON. Entries without a usable name are skipped; first occurrence of a name
 * wins.
 */
export function getFrameEntries(atlasJson) {
  if (!atlasJson || typeof atlasJson !== "object") return [];
  const entries = [];
  const seen = new Set();
  const push = (rawKey, data) => {
    if (typeof rawKey !== "string" || !data || typeof data !== "object") return;
    const name = decodeFrameKey(rawKey);
    if (seen.has(name)) return;
    seen.add(name);
    entries.push({ name, rawKey, data });
  };
  const collect = (frames) => {
    if (!frames || typeof frames !== "object") return;
    // Array form keys each frame by its own `filename` field.
    if (Array.isArray(frames)) for (const f of frames) push(f?.filename, f);
    else for (const [k, v] of Object.entries(frames)) push(k, v);
  };
  collect(atlasJson.frames);
  if (Array.isArray(atlasJson.textures)) for (const t of atlasJson.textures) collect(t?.frames);
  return entries;
}

/** Decoded frame names of an atlas JSON, in stored order. */
export function listFrameNames(atlasJson) {
  return getFrameEntries(atlasJson).map((e) => e.name);
}

/**
 * Look up one frame by name in either layout. Matches the decoded name first,
 * then the raw stored key, so callers can pass a readable name or a k_-hex key.
 */
export function findFrameEntry(atlasJson, name) {
  if (typeof name !== "string") return null;
  const decoded = decodeFrameKey(name);
  const entries = getFrameEntries(atlasJson);
  return (
    entries.find((e) => e.name === decoded) ??
    entries.find((e) => e.rawKey === name) ??
    null
  );
}

/**
 * Blit one source frame from an atlas image onto a 2D context at (dx, dy),
 * undoing the packer's 90° rotation when the frame is stored rotated. A
 * rotated frame occupies an (h x w) region in the sheet while frame.w/h stay
 * the upright dimensions, so the source rect is read swapped and rotated back
 * counter-clockwise — the same convention Phaser uses to render such a frame.
 *
 * Takes the context from the caller, so this module stays dependency-free.
 */
export function drawFrame(ctx, image, data, dx, dy) {
  const f = data.frame;
  if (data.rotated) {
    ctx.save();
    ctx.translate(dx, dy + f.h);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(image, f.x, f.y, f.h, f.w, 0, 0, f.h, f.w);
    ctx.restore();
  } else {
    ctx.drawImage(image, f.x, f.y, f.w, f.h, dx, dy, f.w, f.h);
  }
}
