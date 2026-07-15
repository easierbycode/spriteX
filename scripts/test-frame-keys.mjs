#!/usr/bin/env node
/**
 * test-frame-keys.mjs
 *
 * Round-trip checks for the hex frame-key encoding shared by
 * scripts/extract-frames.mjs, scripts/download-atlas.mjs, and
 * src/atlasManager.ts / src/main.ts.
 *
 * Usage: npm test
 */

import assert from "node:assert/strict";
import { decodeFrameKey, encodeFrameKey } from "./extract-frames.mjs";

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

console.log("frame-key tests passed");
