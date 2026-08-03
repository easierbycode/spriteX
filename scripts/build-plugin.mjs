#!/usr/bin/env node
/**
 * Build the SpriteXPlugin Phaser plugin into dist/plugin/:
 *   - spritex-phaser-plugin.js       (ESM, for bundlers / <script type="module">)
 *   - spritex-phaser-plugin.iife.js  (classic <script>, exposes window.SpriteXPlugin)
 */
import { build } from "esbuild";

const entry = "src/phaser-plugin/spritexPlugin.ts";
const common = {
  entryPoints: [entry],
  bundle: true,
  sourcemap: true,
  minify: true,
  platform: "browser",
  target: "es2020",
  logLevel: "info",
};

await build({
  ...common,
  format: "esm",
  outfile: "dist/plugin/spritex-phaser-plugin.js",
});

await build({
  ...common,
  format: "iife",
  globalName: "SpriteXPluginNS",
  outfile: "dist/plugin/spritex-phaser-plugin.iife.js",
  footer: {
    js: "globalThis.SpriteXPlugin = SpriteXPluginNS.default;",
  },
});
