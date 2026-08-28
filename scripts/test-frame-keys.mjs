#!/usr/bin/env node
/**
 * test-frame-keys.mjs
 *
 * Round-trip checks for the hex frame-key encoding shared by
 * scripts/frame-keys.mjs (used by extract-frames / download-atlas /
 * optimize-atlas) and src/atlasManager.ts / src/main.ts.
 *
 * Usage: npm test
 */

import assert from "node:assert/strict";
import { decodeFrameKey, encodeFrameKey, decodeAtlasJsonFrames } from "./frame-keys.mjs";

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

console.log("frame-key tests passed");
