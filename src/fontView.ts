/**
 * VIEW tab — FONT mode.
 *
 * Bitmap font sheets live under RTDB `atlases/*` alongside regular atlases:
 * the EXTRACT tab's Font Builder saves the packed glyph sheet as the PNG and
 * a Phaser RetroFont config (a JS object literal, not JSON) as the "json".
 * Older font sheets (goldFont, scoreNumbers, …) were saved as plain atlases
 * whose frame order is the glyph order.
 *
 * This view previews either kind: glyphs are sliced from the atlas frames
 * (variable-width, one glyph per frame) or from a fixed RetroFont grid
 * (exactly what Phaser's ParseRetroFont does), mapped onto a character set,
 * and rendered as sample text at an integer pixel scale.
 */
import { fetchAtlas } from "./atlasManager";

/** Phaser.GameObjects.RetroFont.TEXT_SET* — glyph order for grid sheets. */
export const RETRO_FONT_CHAR_SETS: Record<string, string> = {
  TEXT_SET1:
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
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

export interface RetroFontConfig {
  image: string;
  width: number;
  height: number;
  /** Resolved glyph order. */
  chars: string;
  /** The TEXT_SET name the config referenced, if it used one. */
  charSet: string | null;
  charsPerRow: number | null;
  offsetX: number;
  offsetY: number;
  spacingX: number;
  spacingY: number;
  lineSpacing: number;
}

/** True when an atlas record's `json` is a Font Builder RetroFont config. */
export function isRetroFontConfigText(val: unknown): boolean {
  if (typeof val !== "string") return false;
  return /\bchars\s*:/.test(val) && /\bwidth\s*:/.test(val) && /\bheight\s*:/.test(val);
}

function num(text: string, key: string): number | null {
  const m = text.match(new RegExp(`\\b${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return m ? Number(m[1]) : null;
}

function pair(text: string, key: string): { x: number; y: number } | null {
  const m = text.match(new RegExp(`\\b${key}\\s*:\\s*\\{([^}]*)\\}`));
  if (!m) return null;
  return { x: num(m[1], "x") ?? 0, y: num(m[1], "y") ?? 0 };
}

/**
 * Parse the Font Builder's config text (`{ image: "…", width: 16, … }`).
 * It is a JS object literal, so a regex pass is more robust than any JSON
 * repair; every field beyond width/height/chars is optional.
 */
export function parseRetroFontConfigText(text: string): RetroFontConfig | null {
  if (!isRetroFontConfigText(text)) return null;
  const width = num(text, "width");
  const height = num(text, "height");
  if (!width || !height) return null;

  const setMatch = text.match(/\bchars\s*:\s*(?:Phaser\.GameObjects\.RetroFont\.)?(TEXT_SET\d+)/);
  const strMatch = text.match(/\bchars\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/);
  const charSet = setMatch && RETRO_FONT_CHAR_SETS[setMatch[1]] ? setMatch[1] : null;
  const chars = charSet
    ? RETRO_FONT_CHAR_SETS[charSet]
    : strMatch
      ? unescapeLiteral(strMatch[1] ?? strMatch[2] ?? "")
      : RETRO_FONT_CHAR_SETS.TEXT_SET3;

  const imageMatch = text.match(/\bimage\s*:\s*(?:"([^"]*)"|'([^']*)')/);
  const offset = pair(text, "offset");
  const spacing = pair(text, "spacing");

  return {
    image: imageMatch ? (imageMatch[1] ?? imageMatch[2] ?? "") : "",
    width,
    height,
    chars,
    charSet,
    charsPerRow: num(text, "charsPerRow"),
    offsetX: offset?.x ?? 0,
    offsetY: offset?.y ?? 0,
    spacingX: spacing?.x ?? 0,
    spacingY: spacing?.y ?? 0,
    lineSpacing: num(text, "lineSpacing") ?? 0,
  };
}

function unescapeLiteral(s: string): string {
  return s.replace(/\\(.)/g, (_m, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c
  );
}

/* ───────────────────────────── state ───────────────────────────── */

type GlyphSource = "frames" | "grid";

interface Glyph {
  ch: string;
  /** Source frame name (frames mode) or null (grid mode). */
  frame: string | null;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

interface FontDeps {
  setStatus: (msg: string) => void;
  downloadFile: (filename: string, content: string, type: string) => void;
  downloadDataUrl: (url: string, filename: string, type: string) => void;
}

const $ = (id: string) => document.getElementById(id);

let deps: FontDeps = {
  setStatus: () => {},
  downloadFile: () => {},
  downloadDataUrl: () => {},
};

let sheetName = "";
let sheetImg: HTMLImageElement | null = null;
let sheetJson: any = null;
let sheetConfig: RetroFontConfig | null = null;
let glyphSource: GlyphSource = "frames";
let glyphs: Glyph[] = [];
let loadGen = 0;

/* ─────────────────────────── dropdown ─────────────────────────── */

/**
 * Fill the font dropdown from the atlases record the VIEW tab already
 * fetched. Sheets that are obviously fonts (Font Builder config, or a name
 * containing "font") are grouped first; any atlas can still be opened as a
 * font, since older sheets are plain atlases.
 */
export function setFontSheetNames(atlases: Record<string, { json?: unknown }>) {
  const select = $("fontSelect") as HTMLSelectElement | null;
  if (!select) return;
  const prev = select.value;

  const fonts: string[] = [];
  const others: string[] = [];
  Object.keys(atlases)
    .sort((a, b) => a.localeCompare(b))
    .forEach((name) => {
      const looksLikeFont =
        /font/i.test(name) || isRetroFontConfigText(atlases[name]?.json);
      (looksLikeFont ? fonts : others).push(name);
    });

  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- Select a font sheet --";
  select.appendChild(placeholder);

  const addGroup = (label: string, names: string[]) => {
    if (!names.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      group.appendChild(opt);
    });
    select.appendChild(group);
  };
  addGroup("FONT SHEETS", fonts);
  addGroup("OTHER ATLASES", others);

  select.disabled = false;
  if (prev && atlases[prev]) select.value = prev;
}

/* ───────────────────────────── loading ─────────────────────────── */

function frameEntries(json: any): [string, any][] {
  const frames = json?.frames ?? json?.textures?.[0]?.frames;
  if (Array.isArray(frames)) {
    return orderGlyphFrames(
      frames
        .filter((f) => f && typeof f.frame?.w === "number")
        .map((f, i) => [f.filename ?? String(i), f] as [string, any])
    );
  }
  if (frames && typeof frames === "object") {
    return orderGlyphFrames(
      Object.entries(frames).filter(
        ([, f]: [string, any]) => f && typeof f.frame?.w === "number"
      )
    );
  }
  return [];
}

/**
 * Glyph order is frame order, but atlases saved as RTDB object trees come
 * back with keys re-sorted lexicographically (atlas_s10 before atlas_s2).
 * When every frame shares one `<prefix><n>` name, restore the numeric order;
 * anything else keeps the stored order.
 */
function orderGlyphFrames(entries: [string, any][]): [string, any][] {
  const parsed = entries.map(([name]) => name.match(/^(.*?)(\d+)$/));
  if (!parsed.length || parsed.some((m) => !m)) return entries;
  const prefix = parsed[0]![1];
  if (parsed.some((m) => m![1] !== prefix)) return entries;
  return entries
    .map((e, i) => ({ e, i, n: Number(parsed[i]![2]) }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.e);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode font sheet PNG"));
    img.src = src;
  });
}

/** Select a sheet in the dropdown, switch the VIEW dock to FONT, and load it. */
export async function openFontSheet(name: string) {
  const select = $("fontSelect") as HTMLSelectElement | null;
  if (select && select.value !== name) {
    if (![...select.options].some((o) => o.value === name)) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    select.value = name;
  }
  ($("viewModeFontBtn") as HTMLButtonElement | null)?.click();
  await loadFontSheet(name);
}

async function loadFontSheet(name: string) {
  const gen = ++loadGen;
  const note = $("fontGlyphNote");
  if (!name) {
    sheetName = "";
    sheetImg = null;
    sheetJson = null;
    sheetConfig = null;
    glyphs = [];
    render();
    return;
  }

  if (note) note.textContent = "LOADING…";
  const data = await fetchAtlas(name);
  if (gen !== loadGen) return;
  if (!data?.png) {
    if (note) note.textContent = "FAILED TO LOAD FONT SHEET";
    return;
  }

  let png = String(data.png);
  if (!png.startsWith("data:")) png = `data:image/png;base64,${png}`;
  let img: HTMLImageElement;
  try {
    img = await loadImage(png);
  } catch (err) {
    console.error(err);
    if (note) note.textContent = "FAILED TO DECODE FONT SHEET PNG";
    return;
  }
  if (gen !== loadGen) return;

  sheetName = name;
  sheetImg = img;
  sheetConfig = isRetroFontConfigText(data.json)
    ? parseRetroFontConfigText(data.json as string)
    : null;
  sheetJson = sheetConfig ? null : data.json;

  applySheetDefaults();
  render();
}

/**
 * Seed the controls from the sheet: a Font Builder config dictates the grid
 * and char set; a plain atlas defaults to one glyph per frame with the char
 * set left as the user last chose it.
 */
function applySheetDefaults() {
  const hasFrames = frameEntries(sheetJson).length > 0;
  if (sheetConfig) {
    setGlyphSource("grid");
    setNum("fontGlyphWInput", sheetConfig.width);
    setNum("fontGlyphHInput", sheetConfig.height);
    setNum("fontPerRowInput", sheetConfig.charsPerRow ?? 0);
    setNum("fontOffsetXInput", sheetConfig.offsetX);
    setNum("fontOffsetYInput", sheetConfig.offsetY);
    setNum("fontSpacingXInput", sheetConfig.spacingX);
    setNum("fontSpacingYInput", sheetConfig.spacingY);
    setNum("fontLineSpacingInput", sheetConfig.lineSpacing);
    const charsetSelect = $("fontCharsetSelect") as HTMLSelectElement | null;
    const charsInput = $("fontCharsInput") as HTMLInputElement | null;
    if (charsetSelect) charsetSelect.value = sheetConfig.charSet ?? "custom";
    if (!sheetConfig.charSet && charsInput) charsInput.value = sheetConfig.chars;
  } else {
    setGlyphSource(hasFrames ? "frames" : "grid");
    // Grid cell defaults for a frames atlas: the largest frame, so toggling
    // to GRID lines up with a Font Builder sheet (every cell is max-size).
    const entries = frameEntries(sheetJson);
    if (entries.length) {
      setNum("fontGlyphWInput", Math.max(...entries.map(([, f]) => f.frame.w)));
      setNum("fontGlyphHInput", Math.max(...entries.map(([, f]) => f.frame.h)));
    } else if (sheetImg) {
      setNum("fontGlyphWInput", Math.max(1, Math.round(sheetImg.naturalHeight)));
      setNum("fontGlyphHInput", Math.max(1, Math.round(sheetImg.naturalHeight)));
    }
    setNum("fontPerRowInput", 0);
    setNum("fontOffsetXInput", 0);
    setNum("fontOffsetYInput", 0);
    setNum("fontSpacingXInput", 0);
    setNum("fontSpacingYInput", 0);
  }
  syncCharsetUI();
}

/* ───────────────────────────── glyphs ──────────────────────────── */

function getNum(id: string, fallback = 0): number {
  const el = $(id) as HTMLInputElement | null;
  const v = Number(el?.value);
  return Number.isFinite(v) ? v : fallback;
}

function setNum(id: string, value: number) {
  const el = $(id) as HTMLInputElement | null;
  if (el) el.value = String(value);
}

function currentChars(): string {
  const select = $("fontCharsetSelect") as HTMLSelectElement | null;
  const key = select?.value || "TEXT_SET3";
  if (key === "custom") {
    return ($("fontCharsInput") as HTMLInputElement | null)?.value ?? "";
  }
  return RETRO_FONT_CHAR_SETS[key] ?? RETRO_FONT_CHAR_SETS.TEXT_SET3;
}

function computeGlyphs(): Glyph[] {
  if (!sheetImg) return [];
  const chars = currentChars();
  const out: Glyph[] = [];

  if (glyphSource === "frames") {
    const entries = frameEntries(sheetJson);
    const n = Math.min(entries.length, chars.length);
    for (let i = 0; i < n; i++) {
      const [name, f] = entries[i];
      out.push({
        ch: chars[i],
        frame: name,
        sx: f.frame.x,
        sy: f.frame.y,
        sw: f.frame.w,
        sh: f.frame.h,
      });
    }
    return out;
  }

  // Grid: mirror Phaser.GameObjects.RetroFont's ParseRetroFont walk.
  const w = Math.max(1, Math.floor(getNum("fontGlyphWInput", 8)));
  const h = Math.max(1, Math.floor(getNum("fontGlyphHInput", 8)));
  const offsetX = getNum("fontOffsetXInput");
  const offsetY = getNum("fontOffsetYInput");
  const spacingX = getNum("fontSpacingXInput");
  const spacingY = getNum("fontSpacingYInput");
  let charsPerRow = Math.floor(getNum("fontPerRowInput"));
  if (charsPerRow <= 0) {
    charsPerRow = Math.floor(sheetImg.naturalWidth / w);
    if (charsPerRow > chars.length) charsPerRow = chars.length;
  }
  if (charsPerRow <= 0) return [];

  let x = offsetX;
  let y = offsetY;
  let r = 0;
  for (let i = 0; i < chars.length; i++) {
    out.push({ ch: chars[i], frame: null, sx: x, sy: y, sw: w, sh: h });
    r++;
    if (r === charsPerRow) {
      r = 0;
      x = offsetX;
      y += h + spacingY;
    } else {
      x += w + spacingX;
    }
  }
  return out;
}

/** Glyph for a character, falling back across letter case. */
function glyphFor(ch: string, map: Map<string, Glyph>): Glyph | null {
  return (
    map.get(ch) ??
    map.get(ch.toUpperCase()) ??
    map.get(ch.toLowerCase()) ??
    null
  );
}

/* ──────────────────────────── rendering ────────────────────────── */

function setGlyphSource(source: GlyphSource) {
  glyphSource = source;
  $("fontSourceFramesBtn")?.classList.toggle("active", source === "frames");
  $("fontSourceGridBtn")?.classList.toggle("active", source === "grid");
  const gridFields = $("fontGridFields");
  if (gridFields) gridFields.style.display = source === "grid" ? "grid" : "none";
  const cfgBtn = $("downloadFontConfigBtn") as HTMLButtonElement | null;
  if (cfgBtn) cfgBtn.textContent = source === "grid" ? "RETROFONT CFG" : "GLYPH MAP";
}

function syncCharsetUI() {
  const select = $("fontCharsetSelect") as HTMLSelectElement | null;
  const input = $("fontCharsInput") as HTMLInputElement | null;
  if (input) input.style.display = select?.value === "custom" ? "" : "none";
}

function render() {
  glyphs = computeGlyphs();
  renderSheet();
  renderGlyphGrid();
  renderSample();

  const loaded = !!sheetImg;
  ($("downloadFontSampleBtn") as HTMLButtonElement | null)?.toggleAttribute("disabled", !loaded || !glyphs.length);
  ($("downloadFontConfigBtn") as HTMLButtonElement | null)?.toggleAttribute("disabled", !loaded || !glyphs.length);
  // A Font Builder sheet carries no frames, so the ATLAS view has nothing to slice.
  ($("fontOpenAtlasBtn") as HTMLButtonElement | null)?.toggleAttribute(
    "disabled",
    !loaded || frameEntries(sheetJson).length === 0
  );

  if (loaded) {
    deps.setStatus(
      `VIEW · FONT ${sheetName} · ${glyphs.length} GLYPH${glyphs.length === 1 ? "" : "S"} · ${
        glyphSource === "grid" ? "GRID" : "FRAMES"
      }`
    );
  }
}

function renderSheet() {
  const img = $("fontSheetImg") as HTMLImageElement | null;
  const dims = $("fontSheetDims");
  if (!img) return;
  if (!sheetImg) {
    img.removeAttribute("src");
    if (dims) dims.textContent = "";
    return;
  }
  img.src = sheetImg.src;
  if (dims) dims.textContent = `${sheetImg.naturalWidth} × ${sheetImg.naturalHeight}`;
}

function renderGlyphGrid() {
  const cont = $("fontGlyphsContainer");
  const count = $("fontGlyphCount");
  const note = $("fontGlyphNote");
  if (!cont) return;
  cont.innerHTML = "";
  if (count) count.textContent = String(glyphs.length);

  if (!sheetImg) {
    cont.textContent = "Font not loaded yet.";
    if (note) note.textContent = "";
    return;
  }

  const chars = currentChars();
  const frameCount = frameEntries(sheetJson).length;
  if (note) {
    if (glyphSource === "frames" && frameCount === 0) {
      note.textContent = "NO FRAMES IN THIS SHEET — SWITCH TO GRID";
    } else if (glyphSource === "frames" && frameCount > chars.length) {
      note.textContent = `${frameCount - chars.length} FRAME${frameCount - chars.length === 1 ? "" : "S"} BEYOND THE CHAR SET ARE UNMAPPED`;
    } else if (glyphSource === "frames" && chars.length > frameCount) {
      note.textContent = `${chars.length - frameCount} CHAR${chars.length - frameCount === 1 ? "" : "S"} HAVE NO FRAME`;
    } else if (glyphSource === "grid") {
      const outside = glyphs.filter(
        (g) => g.sx + g.sw > sheetImg!.naturalWidth || g.sy + g.sh > sheetImg!.naturalHeight
      ).length;
      note.textContent = outside
        ? `${outside} CELL${outside === 1 ? " FALLS" : "S FALL"} OUTSIDE THE SHEET`
        : "";
    } else {
      note.textContent = "";
    }
  }

  if (!glyphs.length) {
    cont.textContent = "No glyphs mapped.";
    return;
  }

  const scale = 2;
  const frag = document.createDocumentFragment();
  glyphs.forEach((g) => {
    const cell = document.createElement("div");
    cell.className = "font-glyph";
    cell.title = g.frame ? `${g.frame} → "${g.ch}"` : `"${g.ch}" @ ${g.sx},${g.sy}`;

    const c = document.createElement("canvas");
    c.width = Math.max(1, g.sw * scale);
    c.height = Math.max(1, g.sh * scale);
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheetImg!, g.sx, g.sy, g.sw, g.sh, 0, 0, g.sw * scale, g.sh * scale);

    const label = document.createElement("span");
    label.textContent = g.ch === " " ? "␣" : g.ch;

    cell.appendChild(c);
    cell.appendChild(label);
    frag.appendChild(cell);
  });
  cont.appendChild(frag);
}

function renderSample() {
  const canvas = $("fontSampleCanvas") as HTMLCanvasElement | null;
  const empty = $("fontSampleEmpty");
  if (!canvas) return;

  const text = ($("fontSampleInput") as HTMLTextAreaElement | null)?.value ?? "";
  const scale = Math.max(1, Math.floor(getNum("fontScaleSelect", 4)));
  const letterSpacing = Math.floor(getNum("fontLetterSpacingInput"));
  const lineSpacing = Math.floor(getNum("fontLineSpacingInput"));

  const map = new Map<string, Glyph>();
  glyphs.forEach((g) => {
    if (!map.has(g.ch)) map.set(g.ch, g);
  });

  const lineHeight = glyphs.reduce((m, g) => Math.max(m, g.sh), 0);
  const spaceAdvance =
    map.get(" ")?.sw ??
    (glyphs.length ? Math.round(glyphs.reduce((s, g) => s + g.sw, 0) / glyphs.length) : 0);

  const lines = text.replace(/\r/g, "").split("\n");
  type Placed = { g: Glyph | null; x: number; y: number };
  const placed: Placed[] = [];
  let width = 0;
  let y = 0;
  lines.forEach((line) => {
    let x = 0;
    for (const ch of line) {
      const g = ch === " " ? map.get(" ") ?? null : glyphFor(ch, map);
      if (g) {
        placed.push({ g, x, y });
        x += g.sw + letterSpacing;
      } else {
        // Missing glyph (or a space with no space glyph): leave a gap.
        x += spaceAdvance + letterSpacing;
      }
    }
    width = Math.max(width, Math.max(0, x - letterSpacing));
    y += lineHeight + lineSpacing;
  });
  const height = Math.max(0, y - lineSpacing);

  const hasInk = !!sheetImg && placed.length > 0 && width > 0 && height > 0;
  canvas.style.display = hasInk ? "" : "none";
  if (empty) {
    empty.style.display = hasInk ? "none" : "";
    empty.textContent = !sheetImg
      ? "PICK A FONT SHEET"
      : !glyphs.length
        ? "NO GLYPHS MAPPED"
        : "TYPE SAMPLE TEXT IN THE DOCK";
  }
  if (!hasInk) {
    canvas.width = 1;
    canvas.height = 1;
    return;
  }

  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  placed.forEach(({ g, x, y }) => {
    if (!g) return;
    ctx.drawImage(
      sheetImg!,
      g.sx, g.sy, g.sw, g.sh,
      x * scale, y * scale, g.sw * scale, g.sh * scale
    );
  });
}

/* ──────────────────────────── downloads ────────────────────────── */

function downloadSample() {
  const canvas = $("fontSampleCanvas") as HTMLCanvasElement | null;
  if (!canvas || !sheetImg || canvas.style.display === "none") return;
  deps.downloadDataUrl(canvas.toDataURL("image/png"), `${sheetName}_sample.png`, "image/png");
}

/** RetroFont config for grid sheets; a char → frame map for frame sheets. */
function downloadConfig() {
  if (!sheetImg || !glyphs.length) return;
  const select = $("fontCharsetSelect") as HTMLSelectElement | null;
  const charSet = select?.value && select.value !== "custom" ? select.value : null;
  const chars = currentChars();
  const charsLiteral = charSet
    ? `Phaser.GameObjects.RetroFont.${charSet}`
    : JSON.stringify(chars);

  if (glyphSource === "grid") {
    const lines = [
      `  image: ${JSON.stringify(sheetName)},`,
      `  width: ${Math.max(1, Math.floor(getNum("fontGlyphWInput", 8)))},`,
      `  height: ${Math.max(1, Math.floor(getNum("fontGlyphHInput", 8)))},`,
      `  chars: ${charsLiteral},`,
    ];
    const perRow = Math.floor(getNum("fontPerRowInput"));
    if (perRow > 0) lines.push(`  charsPerRow: ${perRow},`);
    const ox = getNum("fontOffsetXInput"), oy = getNum("fontOffsetYInput");
    if (ox || oy) lines.push(`  offset: { x: ${ox}, y: ${oy} },`);
    const sx = getNum("fontSpacingXInput"), sy = getNum("fontSpacingYInput");
    if (sx || sy) lines.push(`  spacing: { x: ${sx}, y: ${sy} },`);
    const ls = getNum("fontLineSpacingInput");
    if (ls) lines.push(`  lineSpacing: ${ls},`);
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "");
    deps.downloadFile(`${sheetName}.retrofont.js`, `{\n${lines.join("\n")}\n}\n`, "text/javascript");
    return;
  }

  const map: Record<string, string> = {};
  glyphs.forEach((g) => {
    if (g.frame && !(g.ch in map)) map[g.ch] = g.frame;
  });
  const payload = { image: sheetName, chars, glyphs: map };
  deps.downloadFile(`${sheetName}.glyphmap.json`, JSON.stringify(payload, null, 2), "application/json");
}

/* ────────────────────────────── init ───────────────────────────── */

export function initFontView(d: Partial<FontDeps>) {
  deps = { ...deps, ...d };

  const select = $("fontSelect") as HTMLSelectElement | null;
  if (!select) return;
  select.addEventListener("change", () => {
    loadFontSheet(select.value).catch((err) => console.error("font sheet load failed:", err));
  });

  $("fontSourceFramesBtn")?.addEventListener("click", () => {
    setGlyphSource("frames");
    render();
  });
  $("fontSourceGridBtn")?.addEventListener("click", () => {
    setGlyphSource("grid");
    render();
  });

  const charsetSelect = $("fontCharsetSelect") as HTMLSelectElement | null;
  charsetSelect?.addEventListener("change", () => {
    syncCharsetUI();
    render();
  });

  // Every control re-renders live; slicing a few dozen glyphs is cheap.
  [
    "fontSampleInput",
    "fontCharsInput",
    "fontGlyphWInput",
    "fontGlyphHInput",
    "fontPerRowInput",
    "fontOffsetXInput",
    "fontOffsetYInput",
    "fontSpacingXInput",
    "fontSpacingYInput",
    "fontLetterSpacingInput",
    "fontLineSpacingInput",
  ].forEach((id) => $(id)?.addEventListener("input", render));
  $("fontScaleSelect")?.addEventListener("change", render);

  $("fontBgBtn")?.addEventListener("click", () => {
    $("fontSampleContainer")?.classList.toggle("bg-checkered");
  });
  $("fontFullscreenBtn")?.addEventListener("click", () => {
    $("fontSampleContainer")?.requestFullscreen?.();
  });
  $("downloadFontSampleBtn")?.addEventListener("click", downloadSample);
  $("downloadFontConfigBtn")?.addEventListener("click", downloadConfig);

  $("fontOpenAtlasBtn")?.addEventListener("click", () => {
    if (!sheetName) return;
    const atlasSelect = $("atlasSelect") as HTMLSelectElement | null;
    if (!atlasSelect) return;
    atlasSelect.value = sheetName;
    atlasSelect.dispatchEvent(new Event("change"));
    ($("viewModeAtlasBtn") as HTMLButtonElement | null)?.click();
  });

  setGlyphSource("frames");
  syncCharsetUI();
  render();
}
