#!/usr/bin/env node
/**
 * test-frame-keys.mjs
 *
 * Checks for scripts/frame-keys.mjs: the hex frame-key encoding shared with
 * src/atlasManager.ts / src/main.ts, plus the layout helpers that let
 * extract-frames / download-atlas / optimize-atlas read either atlas frame
 * shape (hash map or TexturePacker array).
 *
 * Usage: npm test
 */

import assert from "node:assert/strict";
import {
  decodeFrameKey,
  encodeFrameKey,
  decodeAtlasJsonFrames,
  getFrameEntries,
  listFrameNames,
  findFrameEntry,
  drawFrame,
} from "./frame-keys.mjs";

// Astral characters (emoji, U+10000+) must round-trip. They encode as two
// 4-hex-digit UTF-16 surrogate groups; the old per-code-point encoding
// emitted a 5-digit group that decoders could not re-chunk.
for (const name of ["boss💥.png", "😀", "explosion🎮/frame.0"]) {
  assert.equal(decodeFrameKey(encodeFrameKey(name)), name, `round-trip failed for ${name}`);
}

// BMP-only names must keep their existing encoding byte-identical, so keys
// already stored in RTDB still match.
const legacyEncode = (name) =>
  `k_${Array.from(name)
    .map((ch) => ch.codePointAt(0).toString(16).padStart(4, "0"))
    .join("")}`;
for (const name of ["player/idle_0.png", "enemy.boss[1]", "sprite#2$", "ünïcode™"]) {
  assert.equal(encodeFrameKey(name), legacyEncode(name), `BMP encoding changed for ${name}`);
  assert.equal(decodeFrameKey(encodeFrameKey(name)), name, `round-trip failed for ${name}`);
}

// Keys without the k_ prefix pass through decode untouched.
assert.equal(decodeFrameKey("plain_key"), "plain_key");

// A name that merely starts with k_ but isn't valid hex is NOT an encoding.
for (const name of ["k_foo", "k_12", "k_zzzz0000"]) {
  assert.equal(decodeFrameKey(name), name, `false decode of ${name}`);
}

// Encoding is idempotent: re-encoding an already-encoded key must not stack a
// second layer (the exact failure that broke rebuilt-atlas round trips).
const once = encodeFrameKey("explosion00.gif");
assert.equal(encodeFrameKey(once), once, "encode stacked a second layer");

// ── decodeAtlasJsonFrames ────────────────────────────────────────────────────
// Regression for the game_asset export bug: an atlas fetched from a legacy
// RTDB object tree carries k_-hex keys for every dotted name (plain names like
// duke_0 survive). Decoding must restore the real names and leave everything
// else untouched.
const entry = { frame: { x: 0, y: 0, w: 16, h: 16 } };
const legacyTree = {
  frames: {
    duke_0: entry,
    [encodeFrameKey("explosion00.gif")]: entry,
    [encodeFrameKey("soliderA0.gif")]: entry,
  },
  meta: { image: "img/game_asset.png" },
};
const healed = decodeAtlasJsonFrames(legacyTree);
assert.deepEqual(
  Object.keys(healed.frames),
  ["duke_0", "explosion00.gif", "soliderA0.gif"],
  "legacy k_ keys were not decoded to real frame names"
);
assert.deepEqual(healed.meta, legacyTree.meta, "meta must pass through untouched");
// Idempotent on already-clean JSON, and the input object is never mutated.
assert.deepEqual(decodeAtlasJsonFrames(healed), healed);
assert.ok(legacyTree.frames[encodeFrameKey("explosion00.gif")], "input was mutated");

// Phaser multi-atlas array form: filenames decode in place.
const arrayForm = {
  textures: [
    { image: "sheet.png", frames: [{ filename: encodeFrameKey("hit0.gif"), ...entry }] },
  ],
};
assert.equal(
  decodeAtlasJsonFrames(arrayForm).textures[0].frames[0].filename,
  "hit0.gif",
  "array-form filename was not decoded"
);

// ── frame layout helpers ─────────────────────────────────────────────────────
// Regression for the evil_invaders_game_asset bug: a TexturePacker "Phaser 3"
// export stores frames as an ARRAY keyed by each entry's `filename`. Reading
// `.frames` as a map yields the array indices ("0", "1", …), so no real frame
// name ever matches and every lookup misses.
const arrayAtlas = {
  textures: [
    {
      frames: [
        { filename: "hexagram0.png", frame: { x: 0, y: 0, w: 12, h: 16 } },
        { filename: encodeFrameKey("evilEye2.png"), frame: { x: 12, y: 0, w: 46, h: 44 } },
      ],
    },
  ],
};
assert.deepEqual(listFrameNames(arrayAtlas), ["hexagram0.png", "evilEye2.png"]);
assert.equal(findFrameEntry(arrayAtlas, "hexagram0.png").data.frame.w, 12);
// k_-hex filenames resolve by their readable name, and by the raw stored key.
assert.equal(findFrameEntry(arrayAtlas, "evilEye2.png").data.frame.w, 46);
assert.equal(findFrameEntry(arrayAtlas, encodeFrameKey("evilEye2.png")).name, "evilEye2.png");
assert.equal(findFrameEntry(arrayAtlas, "nope.png"), null);

// Hash form keeps working, and reports the raw key alongside the decoded name.
const hashAtlas = { frames: { [encodeFrameKey("boss.0.png")]: { frame: { x: 1, y: 2, w: 3, h: 4 } } } };
assert.deepEqual(listFrameNames(hashAtlas), ["boss.0.png"]);
assert.equal(findFrameEntry(hashAtlas, "boss.0.png").rawKey, encodeFrameKey("boss.0.png"));

// Multi-texture JSON contributes every page; junk shapes are skipped, not thrown on.
assert.deepEqual(
  listFrameNames({ textures: [{ frames: [{ filename: "a.png", frame: {} }] }, { frames: { "b.png": {} } }] }),
  ["a.png", "b.png"]
);
assert.deepEqual(getFrameEntries(null), []);
assert.deepEqual(listFrameNames({ frames: [{ noFilename: true }, null, 7] }), []);

// ── drawFrame ────────────────────────────────────────────────────────────────
// A rotated frame is stored as an (h x w) region and must be blitted back
// upright; an unrotated one is a straight copy.
const calls = [];
const stubCtx = {
  save: () => calls.push(["save"]),
  restore: () => calls.push(["restore"]),
  translate: (x, y) => calls.push(["translate", x, y]),
  rotate: (r) => calls.push(["rotate", r]),
  drawImage: (...a) => calls.push(["drawImage", ...a]),
};
drawFrame(stubCtx, "img", { frame: { x: 5, y: 6, w: 10, h: 20 } }, 100, 200);
assert.deepEqual(calls, [["drawImage", "img", 5, 6, 10, 20, 100, 200, 10, 20]]);

calls.length = 0;
drawFrame(stubCtx, "img", { rotated: true, frame: { x: 5, y: 6, w: 10, h: 20 } }, 100, 200);
assert.deepEqual(calls, [
  ["save"],
  ["translate", 100, 220],
  ["rotate", -Math.PI / 2],
  ["drawImage", "img", 5, 6, 20, 10, 0, 0, 20, 10],
  ["restore"],
]);

console.log("frame-key tests passed");
