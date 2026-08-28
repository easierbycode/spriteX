/**
 * frame-keys.mjs
 *
 * Pure helpers for the k_-hex frame-key encoding that legacy RTDB object-tree
 * atlas records carry (RTDB keys cannot contain . # $ / [ ]). No dependencies,
 * safe to import from any script. Mirrors src/atlasManager.ts.
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
