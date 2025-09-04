// src/main.ts
import {
  smartDetectSprites,
  extractSpriteDataURLs,
  saveSpritesBatchToRTDB,
  buildAtlas,
  saveAtlas,
  loadCharacterPreview,
  rgbToHex,
  hexToRgb,
  type DetectedSprite,
  type RGB,
} from "./atlasManager";

let originalCanvas: HTMLCanvasElement;
let originalCtx: CanvasRenderingContext2D;
let overlayCanvas: HTMLCanvasElement;
let overlayCtx: CanvasRenderingContext2D;

let detected: DetectedSprite[] = [];
let selected = new Set<number>();
let detectedBg: RGB | null = null;
let detectedTolerance = 12;

let characterAnimTimer: number | null = null;

function $(id: string) {
  return document.getElementById(id);
}

function setupCanvases() {
  originalCanvas = $("originalCanvas") as HTMLCanvasElement;
  overlayCanvas = $("overlayCanvas") as HTMLCanvasElement;

  originalCtx = originalCanvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;
  overlayCtx = overlayCanvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;

  overlayCanvas.addEventListener("click", (ev) => {
    const rect = overlayCanvas.getBoundingClientRect();
    const x = Math.floor(ev.clientX - rect.left);
    const y = Math.floor(ev.clientY - rect.top);

    const idx = detected.findIndex(
      (s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h
    );

    if (idx >= 0) {
      if (selected.has(idx)) selected.delete(idx);
      else selected.add(idx);
      drawOverlay();
      renderSelectedThumbs();
    }
  });
}

function setCanvasSize(w: number, h: number) {
  originalCanvas.width = w;
  originalCanvas.height = h;
  overlayCanvas.width = w;
  overlayCanvas.height = h;
}

function drawOverlay() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.lineWidth = 1;

  for (let i = 0; i < detected.length; i++) {
    const s = detected[i];
    overlayCtx.strokeStyle = selected.has(i)
      ? "rgba(0,200,0,0.9)"
      : "rgba(255,0,0,0.85)";
    overlayCtx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
  }
}

function renderSelectedThumbs() {
  const cont = $("selectedSpritesContainer") as HTMLDivElement;
  cont.innerHTML = "";

  if (!selected.size) {
    cont.textContent =
      'No sprites selected. Tap detected boxes on the canvas to select.';
    return;
  }

  selected.forEach((i) => {
    const s = detected[i];
    const c = document.createElement("canvas");
    c.width = s.w;
    c.height = s.h;

    const cctx = c.getContext("2d")!;
    cctx.drawImage(originalCanvas, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);

    const img = document.createElement("img");
    img.src = c.toDataURL("image/png");
    img.style.width = "96px";
    img.style.height = "auto";
    img.style.border = "1px dashed #aaa";
    img.style.margin = "4px";

    cont.appendChild(img);
  });
}

async function loadFromURL(url: string) {
  const img = new Image();
  img.crossOrigin = "Anonymous";

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });

  setCanvasSize(img.naturalWidth, img.naturalHeight);
  originalCtx.clearRect(0, 0, originalCanvas.width, originalCanvas.height);
  originalCtx.drawImage(img, 0, 0);

  detected = [];
  selected.clear();
  drawOverlay();
  renderSelectedThumbs();
}

async function loadFromFile(file: File) {
  const url = URL.createObjectURL(file);
  try {
    await loadFromURL(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function runDetect(explicitBg?: RGB | null) {
  const res = smartDetectSprites(
    originalCtx,
    originalCanvas.width,
    originalCanvas.height,
    explicitBg
  );

  detected = res.sprites;
  detectedBg = res.bgColor;
  detectedTolerance = res.tolerance;

  // Start with no selection; user taps to select/deselect.
  selected = new Set();

  const bgInput = $("bgColorInput") as HTMLInputElement;
  if (detectedBg && bgInput) {
    bgInput.value = rgbToHex(detectedBg);
  }

  drawOverlay();
  renderSelectedThumbs();
}

async function saveSelectedSpritesToFirebase() {
  if (!selected.size) {
    alert("No sprites selected.");
    return;
  }

  const nameInput = $("spriteNamePrefix") as HTMLInputElement;
  const baseName = (nameInput?.value || "sprite").trim();

  const boxes = [...selected].map((i) => detected[i]);
  const map = extractSpriteDataURLs(originalCanvas, boxes, {
    bgColor: detectedBg,
    tolerance: detectedTolerance,
  });

  await saveSpritesBatchToRTDB(map, {
    baseName,
    stripPrefix: true, // store raw base64 (no data: prefix)
  });

  alert(`Saved ${selected.size} sprites to Firebase (sprites/*).`);
}

async function buildAtlasAndPreview() {
  if (!selected.size) {
    alert("No sprites selected.");
    return;
  }

  const boxes = [...selected].map((i) => detected[i]);
  const map = extractSpriteDataURLs(originalCanvas, boxes, {
    bgColor: detectedBg,
    tolerance: detectedTolerance,
  });

  const named: Record<string, string> = {};
  let idx = 0;
  for (const k of Object.keys(map)) {
    named[`atlas_s${idx++}`] = map[k];
  }

  const { dataURL, json } = await buildAtlas(named);

  const img = $("atlasPreviewImg") as HTMLImageElement;
  img.src = dataURL;

  (img as any)._atlasJson = json;
  (img as any)._atlasDataURL = dataURL;

  $("saveAtlasFirebaseBtn")!.removeAttribute("disabled");
}

async function saveAtlasToFirebase() {
  const nameInput = $("atlasNameInput") as HTMLInputElement;
  const atlasName = (nameInput?.value || "untitled_atlas").trim();

  const img = $("atlasPreviewImg") as HTMLImageElement;
  const json = (img as any)._atlasJson;
  const dataURL = (img as any)._atlasDataURL;

  if (!json || !dataURL) {
    alert("Build an atlas first.");
    return;
  }

  await saveAtlas(atlasName, { json, png: dataURL });
  alert(`Atlas "${atlasName}" saved to RTDB (atlases/${atlasName}).`);
}

async function loadCharacterAndPreview() {
  const input = $("characterIdInput") as HTMLInputElement;
  const id = (input?.value || "").trim();
  if (!id) {
    alert("Enter a character id.");
    return;
  }

  const res = await loadCharacterPreview(id);
  if (!res || !res.frames.length) {
    alert("No frames found for character.");
    return;
  }

  const fps = res.frameRate || 6;
  const dur = Math.max(1, Math.round(1000 / fps));

  const img = $("characterPreviewImg") as HTMLImageElement;
  const fpsSpan = $("frameRateSpan") as HTMLSpanElement;

  fpsSpan.textContent = String(fps);

  let i = 0;
  if (characterAnimTimer) window.clearInterval(characterAnimTimer);
  characterAnimTimer = window.setInterval(() => {
    img.src = res.frames[i % res.frames.length];
    i++;
  }, dur);
}

function wireUI() {
  ($("btnAddUrl") as HTMLButtonElement).addEventListener("click", async () => {
    const val = ($("fileUrl") as HTMLInputElement).value.trim();
    if (!val) {
      alert("Enter an image URL.");
      return;
    }
    try {
      await loadFromURL(val);
    } catch (e: any) {
      alert("Failed to load: " + e?.message);
    }
  });

  ($("fileInput") as HTMLInputElement).addEventListener(
    "change",
    async (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.files && t.files[0]) {
        await loadFromFile(t.files[0]);
      }
    }
  );

  ($("detectSpritesBtn") as HTMLButtonElement).addEventListener(
    "click",
    () => {
      const bgInput = $("bgColorInput") as HTMLInputElement;
      const explicit = bgInput?.value ? hexToRgb(bgInput.value) : null;
      runDetect(explicit ?? undefined);
    }
  );

  ($("saveSpritesFirebaseBtn") as HTMLButtonElement).addEventListener(
    "click",
    saveSelectedSpritesToFirebase
  );

  ($("buildAtlasBtn") as HTMLButtonElement).addEventListener(
    "click",
    buildAtlasAndPreview
  );

  ($("saveAtlasFirebaseBtn") as HTMLButtonElement).addEventListener(
    "click",
    saveAtlasToFirebase
  );

  ($("loadCharacterBtn") as HTMLButtonElement).addEventListener(
    "click",
    loadCharacterAndPreview
  );
}

document.addEventListener("DOMContentLoaded", () => {
  setupCanvases();
  wireUI();
});