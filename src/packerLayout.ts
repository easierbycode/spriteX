// src/packerLayout.ts
// Layout-preserving atlas rebuild for the PACKER tab.
//
// atlasManager.buildAtlas re-derives a uniform grid from scratch, so every
// frame moves — anything that already references the old rects (a game's
// baked frame data, an exported sheet) comes back wrong. When the player is
// only swapping sprites into an existing atlas, the PNG should come back in
// the exact layout it went out in: this module repaints the original bitmap
// in place and edits only the JSON entries of the frames that were touched.

import { decodeAtlasFrameKey } from "./atlasManager";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A frame's fixed home in the sheet. The box never moves — everything the
 *  packer does in preserve mode happens inside it. */
export interface FrameSlot {
  /** Key in the atlas JSON frames map (may be `k_`-hex encoded). */
  key: string;
  /** Decoded, human-readable name. */
  name: string;
  box: Rect;
}

/** Pixels to paint into a box. `w`/`h` are clamped to the box on the way in. */
export interface SlotPaint {
  image: CanvasImageSource;
  w: number;
  h: number;
}

export interface AdditionPaint extends SlotPaint {
  name: string;
}

export interface PreservedBuild {
  dataURL: string;
  json: any;
  width: number;
  height: number;
}

/** The live frames container of an atlas JSON — top-level or first texture.
 *  Returns the owner object so callers can replace or append to it in place. */
export function framesHolder(json: any): { holder: any; prop: string } | null {
  if (!json || typeof json !== "object") return null;
  if (json.frames && typeof json.frames === "object") {
    return { holder: json, prop: "frames" };
  }
  const tex = Array.isArray(json.textures) ? json.textures[0] : null;
  if (tex?.frames && typeof tex.frames === "object") {
    return { holder: tex, prop: "frames" };
  }
  return null;
}

/** Frame entries keyed the way FrameSlot.key names them. Entries are returned
 *  by reference, so mutating one edits the JSON it came from — true for the
 *  Phaser array form too. */
export function framesByKey(json: any): Record<string, any> {
  const h = framesHolder(json);
  if (!h) return {};
  const raw = h.holder[h.prop];
  if (Array.isArray(raw)) {
    const map: Record<string, any> = {};
    raw.forEach((f: any, i: number) => {
      if (f && f.frame) map[f.filename ?? String(i)] = f;
    });
    return map;
  }
  return raw;
}

/** The sheet region a frame owns, or null if the entry has no usable rect. */
export function frameBox(entry: any): Rect | null {
  const f = entry?.frame;
  if (!f) return null;
  const x = Number(f.x);
  const y = Number(f.y);
  const w = Number(f.w);
  const h = Number(f.h);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

export function boxSignature(box: Rect): string {
  return `${box.x},${box.y},${box.w},${box.h}`;
}

/**
 * Rebuild the sheet without moving anything.
 *
 * The original bitmap is blitted whole, so every frame the player left alone
 * survives pixel-for-pixel — including whatever padding or bleed lives between
 * the frames. Only the boxes of replaced frames are cleared and repainted, and
 * appended frames are shelf-packed onto fresh rows below the original content.
 */
export function rebuildPreservingLayout(
  sheet: CanvasImageSource,
  sheetW: number,
  sheetH: number,
  json: any,
  slots: FrameSlot[],
  paints: Map<number, SlotPaint>,
  additions: AdditionPaint[]
): PreservedBuild {
  const nextJson = JSON.parse(JSON.stringify(json));
  const holder = framesHolder(nextJson);
  if (!holder) throw new Error("Atlas JSON has no frames map");
  const container = holder.holder[holder.prop];
  const isList = Array.isArray(container);
  const byKey = framesByKey(nextJson);

  // Base size: the bitmap as it stands, grown only to cover a frame rect that
  // reaches past it, so a hand-edited atlas is never clipped. meta.size does
  // not get a vote — stored atlases carry stale sizes (a 413px sheet still
  // declaring the 2048px packing guide it was laid out against), and honouring
  // one would pad the sheet with dead pixels on every save.
  let baseW = Math.max(1, Math.round(sheetW));
  let baseH = Math.max(1, Math.round(sheetH));
  for (const slot of slots) {
    baseW = Math.max(baseW, slot.box.x + slot.box.w);
    baseH = Math.max(baseH, slot.box.y + slot.box.h);
  }

  // New frames go on their own rows underneath, in uniform cells like
  // createAtlasJson builds — the original rows above are never disturbed.
  let cellW = 0;
  let cellH = 0;
  for (const add of additions) {
    cellW = Math.max(cellW, add.w);
    cellH = Math.max(cellH, add.h);
  }
  cellW = Math.max(1, cellW);
  cellH = Math.max(1, cellH);

  const placements: Array<{ add: AdditionPaint; x: number; y: number }> = [];
  let finalW = baseW;
  let finalH = baseH;
  if (additions.length) {
    const packW = Math.max(baseW, cellW);
    let x = 0;
    let y = baseH;
    for (const add of additions) {
      if (x > 0 && x + cellW > packW) {
        x = 0;
        y += cellH;
      }
      placements.push({ add, x, y });
      x += cellW;
    }
    finalW = packW;
    finalH = y + cellH;
  }

  const canvas = document.createElement("canvas");
  canvas.width = finalW;
  canvas.height = finalH;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, finalW, finalH);
  ctx.drawImage(sheet, 0, 0);

  paints.forEach((paint, index) => {
    const slot = slots[index];
    if (!slot) return;
    const { box } = slot;
    // Clamp rather than scale: callers size their paint to the box, and a
    // silent resample here would soften pixel art without saying so.
    const w = Math.max(1, Math.min(Math.round(paint.w), box.w));
    const h = Math.max(1, Math.min(Math.round(paint.h), box.h));
    const offX = Math.floor((box.w - w) / 2);
    const offY = Math.floor((box.h - h) / 2);
    ctx.clearRect(box.x, box.y, box.w, box.h);
    ctx.drawImage(paint.image, 0, 0, w, h, box.x + offX, box.y + offY, w, h);

    const entry = byKey[slot.key];
    // A trimmed entry's spriteSourceSize describes the trim inside the source
    // image and must keep matching frame.w/h — the box is unchanged, so the
    // metadata still holds. Untrimmed (cell-style) frames record where the
    // sprite now sits inside its cell.
    if (entry && entry.trimmed !== true) {
      entry.spriteSourceSize = { x: offX, y: offY, w, h };
    }
  });

  // Dedup against decoded forms too: a sheet that still carries legacy k_-hex
  // keys must not gain a plain-named twin of one of its own frames.
  const takenKeys = new Set(
    Object.keys(byKey).flatMap((k) => [k, decodeAtlasFrameKey(k)])
  );
  for (const { add, x, y } of placements) {
    const w = Math.max(1, Math.min(Math.round(add.w), cellW));
    const h = Math.max(1, Math.min(Math.round(add.h), cellH));
    const offX = Math.floor((cellW - w) / 2);
    const offY = Math.floor((cellH - h) / 2);
    ctx.drawImage(add.image, 0, 0, w, h, x + offX, y + offY, w, h);

    const entry = {
      frame: { x, y, w: cellW, h: cellH },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: offX, y: offY, w, h },
      sourceSize: { w: cellW, h: cellH },
    };
    if (isList) {
      container.push({ filename: add.name, ...entry });
    } else {
      // Plain names: RTDB safety is handled at the save boundary (the json is
      // stored stringified), so the JSON itself always carries real names.
      let key = add.name;
      let n = 2;
      while (takenKeys.has(key)) key = `${add.name}_${n++}`;
      takenKeys.add(key);
      container[key] = entry;
    }
  }

  if (nextJson.meta && typeof nextJson.meta === "object") {
    nextJson.meta.size = { w: finalW, h: finalH };
  } else {
    nextJson.meta = {
      app: "Evil Invaders Atlas Builder",
      version: "1.0",
      image: "atlas.png",
      format: "RGBA8888",
      size: { w: finalW, h: finalH },
      scale: "1",
    };
  }

  return {
    dataURL: canvas.toDataURL("image/png"),
    json: nextJson,
    width: finalW,
    height: finalH,
  };
}
