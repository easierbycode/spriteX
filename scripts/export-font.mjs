#!/usr/bin/env node
/**
 * Export a Font Builder sheet from RTDB as a TrueType font.
 *
 *   node scripts/export-font.mjs --atlasName silverFont [--outDir downloads/fonts]
 *                                [--family silverFont] [--gameName <game>]
 *
 * A Font Builder record under atlases/{name} holds the glyph sheet PNG and a
 * Phaser RetroFont config ({ width, height, chars: TEXT_SETn }). This traces
 * every opaque pixel of every glyph cell into rectangles and writes them as
 * OpenType outlines, so the pixel font can be used anywhere a CSS font-family
 * is — canvas text, Phaser text styles, DOM — with no bitmap-font code.
 *
 * Metrics: one em = the cell width in glyph pixels (16 for a 16×12 sheet), so
 * at a CSS font-size equal to the cell width every glyph pixel is exactly one
 * device pixel, and at 8px each glyph sits in an 8px cell — the runtime's
 * Dezaemon text grid. Every glyph advances by one cell (a RetroFont is fixed
 * pitch). Lowercase letters map onto the uppercase glyphs when the sheet has
 * no lowercase of its own, so mixed-case strings still render in the font.
 *
 * Outputs: <family>.ttf, <family>.png (the sheet) and <family>.retrofont.js
 * (the config) in outDir.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import { createCanvas, loadImage } from "./canvas-shim.mjs";

const RTDB = "https://evil-invaders-default-rtdb.firebaseio.com";

/** Phaser.GameObjects.RetroFont.TEXT_SET* — glyph order for grid sheets. */
const TEXT_SETS = {
  TEXT_SET1: " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
  TEXT_SET2: " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  TEXT_SET3: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ",
  TEXT_SET4: "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789",
  TEXT_SET5: "ABCDEFGHIJKLMNOPQRSTUVWXYZ.,/() '!?-*:0123456789",
  TEXT_SET6: "ABCDEFGHIJKLMNOPQRSTUVWXYZ!?:;0123456789\"(),-.' ",
  TEXT_SET7: "AGMSY+:4BHNTZ!;5CIOU.?06DJPV,(17EKQW\")28FLRX-'39",
  TEXT_SET8: "0123456789 .ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  TEXT_SET9: "ABCDEFGHIJKLMNOPQRSTUVWXYZ()-0123456789.:,'\"?!",
  TEXT_SET10: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  TEXT_SET11: "ABCDEFGHIJKLMNOPQRSTUVWXYZ.,\"-+!?()':;0123456789",
};

function parseArgs(argv) {
  const out = { outDir: "downloads/fonts" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--atlasName") out.atlasName = next();
    else if (a === "--gameName") out.gameName = next();
    else if (a === "--outDir") out.outDir = next();
    else if (a === "--family") out.family = next();
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/** The Font Builder's config is a JS object literal, not JSON — regex it. */
export function parseRetroFontConfig(text) {
  const num = (key) => {
    const m = text.match(new RegExp(`\\b${key}\\s*:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const set = text.match(/\bchars\s*:\s*(?:Phaser\.GameObjects\.RetroFont\.)?(TEXT_SET\d+)/);
  const str = text.match(/\bchars\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/);
  const chars = set && TEXT_SETS[set[1]]
    ? TEXT_SETS[set[1]]
    : str
      ? (str[1] ?? str[2] ?? "").replace(/\\(.)/g, "$1")
      : TEXT_SETS.TEXT_SET3;
  const width = num("width");
  const height = num("height");
  if (!width || !height) throw new Error("RetroFont config needs width and height");
  return { width, height, chars, charsPerRow: num("charsPerRow") };
}

async function fetchRecord(atlasName, gameName) {
  const base = gameName
    ? `${RTDB}/games/${encodeURIComponent(gameName)}/atlases/${encodeURIComponent(atlasName)}`
    : `${RTDB}/atlases/${encodeURIComponent(atlasName)}`;
  const res = await fetch(`${base}.json`);
  if (!res.ok) throw new Error(`RTDB ${res.status} for ${base}`);
  const rec = await res.json();
  if (!rec || !rec.png) throw new Error(`No record at ${base}`);
  const json = typeof rec.json === "string" ? rec.json : JSON.stringify(rec.json ?? "");
  if (!/\bchars\s*:/.test(json)) {
    throw new Error(`${atlasName} is not a Font Builder sheet (no RetroFont config); frame atlases are not supported yet`);
  }
  const png = Buffer.from(String(rec.png).replace(/^data:image\/png;base64,/, ""), "base64");
  return { png, config: json };
}

/**
 * Trace one glyph cell into an OpenType path: each horizontal run of opaque
 * pixels becomes a rectangle. Rectangles that merely touch are fine — the
 * non-zero fill rule unions them.
 */
function tracePath(data, imgW, cell, cfg, unitsPerPixel) {
  const p = new opentype.Path();
  const alpha = (x, y) => data[((cfg.y0 + y) * imgW + cfg.x0 + x) * 4 + 3];
  for (let y = 0; y < cell.h; y++) {
    let x = 0;
    while (x < cell.w) {
      if (!alpha(x, y)) { x++; continue; }
      let x1 = x;
      while (x1 < cell.w && alpha(x1, y)) x1++;
      // Font y goes up: row 0 is the top of the cell.
      const top = (cell.h - y) * unitsPerPixel;
      const bottom = (cell.h - y - 1) * unitsPerPixel;
      p.moveTo(x * unitsPerPixel, bottom);
      p.lineTo(x1 * unitsPerPixel, bottom);
      p.lineTo(x1 * unitsPerPixel, top);
      p.lineTo(x * unitsPerPixel, top);
      p.close();
      x = x1;
    }
  }
  return p;
}

export async function buildFont({ png, config, family }) {
  const cfg = parseRetroFontConfig(config);
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;

  const cell = { w: cfg.width, h: cfg.height };
  const unitsPerEm = 1024;
  const unitsPerPixel = unitsPerEm / cell.w;
  let charsPerRow = cfg.charsPerRow || Math.floor(img.width / cell.w);
  if (charsPerRow > cfg.chars.length) charsPerRow = cfg.chars.length;

  const glyphs = [
    new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: unitsPerEm, path: new opentype.Path() }),
  ];
  const have = new Set();
  const hasLower = /[a-z]/.test(cfg.chars);
  for (let i = 0; i < cfg.chars.length; i++) {
    const ch = cfg.chars[i];
    const col = i % charsPerRow;
    const row = Math.floor(i / charsPerRow);
    const x0 = col * cell.w;
    const y0 = row * cell.h;
    const inside = x0 + cell.w <= img.width && y0 + cell.h <= img.height;
    const path = inside ? tracePath(data, img.width, cell, { x0, y0 }, unitsPerPixel) : new opentype.Path();
    const codes = [ch.charCodeAt(0)];
    if (!hasLower && /[A-Z]/.test(ch)) codes.push(ch.toLowerCase().charCodeAt(0));
    for (const code of codes) {
      if (have.has(code)) continue;
      have.add(code);
      glyphs.push(new opentype.Glyph({
        name: code === 32 ? "space" : `uni${code.toString(16).toUpperCase().padStart(4, "0")}`,
        unicode: code,
        advanceWidth: unitsPerEm,
        path,
      }));
    }
  }

  const font = new opentype.Font({
    familyName: family,
    styleName: "Regular",
    unitsPerEm,
    ascender: cell.h * unitsPerPixel,
    descender: -Math.round(unitsPerPixel * 2),
    glyphs,
  });
  return { font, cfg, glyphCount: glyphs.length - 1 };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.atlasName) {
    console.log("Usage: node scripts/export-font.mjs --atlasName <name> [--gameName <game>] [--outDir <dir>] [--family <name>]");
    process.exit(args.help ? 0 : 1);
  }
  const family = args.family || args.atlasName;
  const { png, config } = await fetchRecord(args.atlasName, args.gameName);
  const { font, cfg, glyphCount } = await buildFont({ png, config, family });

  fs.mkdirSync(args.outDir, { recursive: true });
  const ttfPath = path.join(args.outDir, `${family}.ttf`);
  fs.writeFileSync(ttfPath, Buffer.from(font.toArrayBuffer()));
  fs.writeFileSync(path.join(args.outDir, `${family}.png`), png);
  fs.writeFileSync(path.join(args.outDir, `${family}.retrofont.js`), config.endsWith("\n") ? config : config + "\n");
  console.log(`${family}: ${glyphCount} glyphs from ${cfg.width}x${cfg.height} cells (${JSON.stringify(cfg.chars)})`);
  console.log(`wrote ${ttfPath} (${fs.statSync(ttfPath).size} bytes), ${family}.png, ${family}.retrofont.js`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
