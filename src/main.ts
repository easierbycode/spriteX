// src/main.ts
declare const GIF: any;
import {
  smartDetectSprites,
  extractSpriteDataURLs,
  saveSpritesBatchToRTDB,
  buildAtlas,
  saveAtlas,
  loadCharacterPreviewFromAtlas,
  fetchAllCharacters,
  fetchAllAtlases,
  fetchAtlas,
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
let selectionAnimTimer: number | null = null;
let selectionFrames: string[] = [];
let selectionFrameIndex = 0;
let selectionPlaying = false;

// Atlas animation preview state
let atlasAnimTimer: number | null = null;
let atlasFrames: string[] = []; // All frames extracted from atlas
let atlasSelectedFrameIndices = new Set<number>();
let atlasAnimFrameIndex = 0;
let atlasAnimPlaying = false;

// BG color eyedropper state
let bgPickActive = false;
let bgPickPrevHex: string | null = null;
let bgPickHoverHex: string | null = null;

// Erase color pick state
let erasePickActive = false;
let erasePickPrevHex: string | null = null;
let erasePickHoverHex: string | null = null;

function $(id: string) {
  return document.getElementById(id);
}

function setupCanvases() {
  originalCanvas = $("originalCanvas") as HTMLCanvasElement;
  overlayCanvas = $("overlayCanvas") as HTMLCanvasElement;

  originalCtx = originalCanvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;
  originalCtx.imageSmoothingEnabled = false;
  overlayCtx = overlayCanvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D;
  overlayCtx.imageSmoothingEnabled = false;

  overlayCanvas.addEventListener("click", (ev) => {
    // If eyedropper is active, finalize the current hovered color
    if (bgPickActive) {
      finishBgPick(true);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (erasePickActive) {
      finishErasePick(true);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

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
      onSelectionChanged();
    }
  });

  // Real-time sampling while in BG pick mode
  overlayCanvas.addEventListener("mousemove", (ev) => {
    if (!bgPickActive && !erasePickActive) return;
    const rect = overlayCanvas.getBoundingClientRect();
    const x = Math.floor(ev.clientX - rect.left);
    const y = Math.floor(ev.clientY - rect.top);
    if (
      x < 0 ||
      y < 0 ||
      x >= originalCanvas.width ||
      y >= originalCanvas.height
    ) {
      return;
    }
    try {
      const data = originalCtx.getImageData(x, y, 1, 1).data;
      const hex = rgbToHex({ r: data[0], g: data[1], b: data[2] });
      if (bgPickActive) {
        bgPickHoverHex = hex;
        const bgInput = $("bgColorInput") as HTMLInputElement;
        if (bgInput) bgInput.value = hex; // preview in realtime
      } else if (erasePickActive) {
        erasePickHoverHex = hex;
        const eInput = $("eraseColorInput") as HTMLInputElement;
        if (eInput) eInput.value = hex; // preview in realtime
      }
    } catch {
      // ignore sampling errors
    }
  });

  overlayCanvas.addEventListener("mouseleave", () => {
    if (bgPickActive) {
      // revert preview while outside
      const bgInput = $("bgColorInput") as HTMLInputElement;
      if (bgInput && bgPickPrevHex) bgInput.value = bgPickPrevHex;
    }
    if (erasePickActive) {
      const eInput = $("eraseColorInput") as HTMLInputElement;
      if (eInput && erasePickPrevHex) eInput.value = erasePickPrevHex;
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
    // Clear preview image when nothing selected
    const img = $("selectionPreviewImg") as HTMLImageElement | null;
    if (img) img.src = "";
    return;
  }

  selected.forEach((i) => {
    const s = detected[i];
    const c = document.createElement("canvas");
    c.width = s.w;
    c.height = s.h;

    const cctx = c.getContext("2d")!;
    cctx.imageSmoothingEnabled = false;
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

function getSortedSelectedIndices(): number[] {
  const arr = [...selected];
  arr.sort((a, b) => {
    const sa = detected[a];
    const sb = detected[b];
    if (!sa || !sb) return a - b;
    if (sa.x !== sb.x) return sa.x - sb.x;
    return sa.y - sb.y;
  });
  return arr;
}

function collectSelectionFrames(): string[] {
  if (!selected.size) return [];
  const indices = getSortedSelectedIndices();
  const boxes = indices.map((i) => detected[i]);
  const bgInput = $("bgColorInput") as HTMLInputElement | null;
  const chosenBg = bgInput?.value ? hexToRgb(bgInput.value) : detectedBg;
  const map = extractSpriteDataURLs(originalCanvas, boxes, {
    bgColor: chosenBg,
    tolerance: detectedTolerance,
  });
  const frames: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const k = `sprite_${i}`;
    if (map[k]) frames.push(map[k]);
  }
  return frames;
}

function stopSelectionPreview() {
  if (selectionAnimTimer) {
    window.clearInterval(selectionAnimTimer);
    selectionAnimTimer = null;
  }
  selectionPlaying = false;
  const btn = $("selectionPreviewBtn") as HTMLButtonElement | null;
  if (btn) btn.textContent = "Preview Selected";
}

function startSelectionPreview() {
  const fpsInput = $("selectionFpsInput") as HTMLInputElement | null;
  const fps = Math.max(1, Math.min(60, Number(fpsInput?.value || 6)));
  const dur = Math.round(1000 / fps);

  selectionFrames = collectSelectionFrames();
  selectionFrameIndex = 0;

  const img = $("selectionPreviewImg") as HTMLImageElement | null;
  if (!selectionFrames.length || !img) {
    stopSelectionPreview();
    return;
  }

  img.src = selectionFrames[0];
  if (selectionAnimTimer) window.clearInterval(selectionAnimTimer);
  selectionAnimTimer = window.setInterval(() => {
    selectionFrameIndex = (selectionFrameIndex + 1) % selectionFrames.length;
    img.src = selectionFrames[selectionFrameIndex];
  }, dur);

  selectionPlaying = true;
  const btn = $("selectionPreviewBtn") as HTMLButtonElement | null;
  if (btn) btn.textContent = "Stop Preview";
}

function refreshSelectionPreviewFrames(keepPlaying = true) {
  // Update frames and restart timer if we were playing
  const img = $("selectionPreviewImg") as HTMLImageElement | null;
  selectionFrames = collectSelectionFrames();
  selectionFrameIndex = 0;
  if (img) img.src = selectionFrames[0] || "";
  if (selectionPlaying && keepPlaying) {
    startSelectionPreview();
  }
}

function onSelectionChanged() {
  // Keep preview in sync with selection
  refreshSelectionPreviewFrames(true);
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
  onSelectionChanged();
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
  onSelectionChanged();
}

async function extractFramesFromAtlas(
  atlasImg: HTMLImageElement,
  atlasJson: any
): Promise<string[]> {
  const frames: string[] = [];
  const frameData = atlasJson.frames || {};

  for (const key in frameData) {
    const frame = frameData[key].frame;
    const c = document.createElement("canvas");
    c.width = frame.w;
    c.height = frame.h;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(atlasImg, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
    frames.push(c.toDataURL("image/png"));
  }

  return frames;
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

  // --- New logic for atlas frame preview ---
  stopAtlasPreview();
  atlasSelectedFrameIndices.clear();

  await new Promise<void>(resolve => {
    const atlasImg = new Image();
    atlasImg.onload = async () => {
      atlasFrames = await extractFramesFromAtlas(atlasImg, json);
      renderAtlasFrames();
      resolve();
    };
    atlasImg.onerror = () => {
      console.error("Failed to load atlas image for preview");
      resolve();
    }
    atlasImg.src = dataURL;
  });
}

function renderAtlasFrames() {
  const cont = $("atlasFramesContainer") as HTMLDivElement;
  cont.innerHTML = "";

  if (!atlasFrames.length) {
    cont.textContent = "No frames found in atlas.";
    return;
  }

  atlasFrames.forEach((frameDataURL, index) => {
    const img = document.createElement("img");
    img.src = frameDataURL;
    img.style.width = "64px";
    img.style.height = "auto";
    img.style.margin = "4px";
    img.dataset.frameIndex = String(index);

    if (atlasSelectedFrameIndices.has(index)) {
      img.classList.add("selected");
    }

    img.addEventListener("click", () => {
      if (atlasSelectedFrameIndices.has(index)) {
        atlasSelectedFrameIndices.delete(index);
        img.classList.remove("selected");
      } else {
        atlasSelectedFrameIndices.add(index);
        img.classList.add("selected");
      }
      refreshAtlasPreviewFrames(false); // Update preview but don't start playing
    });

    cont.appendChild(img);
  });
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
  await populateAtlasSelect(); // Refresh atlas list
}

function stopAtlasPreview() {
  if (atlasAnimTimer) {
    window.clearInterval(atlasAnimTimer);
    atlasAnimTimer = null;
  }
  atlasAnimPlaying = false;
  const btn = $("atlasPreviewBtn") as HTMLButtonElement | null;
  if (btn) btn.textContent = "Preview Atlas Anim";
}

function startAtlasPreview() {
  const fpsInput = $("atlasFpsInput") as HTMLInputElement | null;
  const fps = Math.max(1, Math.min(60, Number(fpsInput?.value || 6)));
  const dur = Math.round(1000 / fps);

  const selectedFrames = [...atlasSelectedFrameIndices].sort((a,b) => a-b).map(i => atlasFrames[i]);

  atlasAnimFrameIndex = 0;

  const img = $("atlasAnimPreviewImg") as HTMLImageElement | null;
  if (!selectedFrames.length || !img) {
    stopAtlasPreview();
    return;
  }

  // --- GIF generation ---
  generateAtlasGif(selectedFrames, fps);
  // --- End GIF generation ---

  img.src = selectedFrames[0];
  if (atlasAnimTimer) window.clearInterval(atlasAnimTimer);
  atlasAnimTimer = window.setInterval(() => {
    atlasAnimFrameIndex = (atlasAnimFrameIndex + 1) % selectedFrames.length;
    img.src = selectedFrames[atlasAnimFrameIndex];
  }, dur);

  atlasAnimPlaying = true;
  const btn = $("atlasPreviewBtn") as HTMLButtonElement | null;
  if (btn) btn.textContent = "Stop Preview";
}

function generateAtlasGif(frames: string[], fps: number) {
  if (!frames.length) return;

  const img = $("atlasAnimPreviewImg") as any;
  if (img) img._gifBlob = null;

  const scale = Number(($("gifScaleInput") as HTMLSelectElement)?.value || 1);

  const firstFrame = new Image();
  firstFrame.src = frames[0];
  firstFrame.onload = () => {
    const gif = new GIF({
      workers: 2,
      quality: 10,
      width: firstFrame.width * scale,
      height: firstFrame.height * scale,
      workerScript: 'gif.worker.js',
      transparent: 0xFF00FF,
    });

    const framePromises = frames.map(frameSrc => {
      return new Promise<HTMLCanvasElement>(resolve => {
        const frameImg = new Image();
        frameImg.onload = () => {
          // Step 1: Create a temporary canvas of the original size
          const tempCanvas = document.createElement("canvas");
          tempCanvas.width = frameImg.width;
          tempCanvas.height = frameImg.height;
          const tempCtx = tempCanvas.getContext("2d")!;

          // Step 2: Draw the image on it
          tempCtx.drawImage(frameImg, 0, 0);

          // Step 3: Get ImageData and apply transparency logic
          const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
          const data = imageData.data;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) {
              data[i] = 255;
              data[i + 1] = 0;
              data[i + 2] = 255;
              data[i + 3] = 255;
            }
          }
          tempCtx.putImageData(imageData, 0, 0);

          // Step 4: Create the final, scaled canvas
          const scaledCanvas = document.createElement("canvas");
          scaledCanvas.width = frameImg.width * scale;
          scaledCanvas.height = frameImg.height * scale;
          const scaledCtx = scaledCanvas.getContext("2d")!;
          scaledCtx.imageSmoothingEnabled = false;

          // Step 5: Draw the temporary canvas onto the scaled canvas
          scaledCtx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, 0, 0, scaledCanvas.width, scaledCanvas.height);

          resolve(scaledCanvas);
        };
        frameImg.src = frameSrc;
      });
    });

    Promise.all(framePromises).then(canvases => {
      canvases.forEach(canvas => {
        gif.addFrame(canvas, { delay: 1000 / fps });
      });

      gif.on('finished', (blob: Blob) => {
        if (img) img._gifBlob = blob;
      });

      gif.render();
    });
  };
}

function refreshAtlasPreviewFrames(keepPlaying = true) {
  const img = $("atlasAnimPreviewImg") as HTMLImageElement | null;
  const selectedFrames = [...atlasSelectedFrameIndices].sort((a,b) => a-b).map(i => atlasFrames[i]);
  atlasAnimFrameIndex = 0;
  if (img) img.src = selectedFrames[0] || "";

  if (atlasAnimPlaying && keepPlaying) {
    startAtlasPreview();
  } else if (!keepPlaying) {
    stopAtlasPreview();
  }
}

async function populateCharacterSelect() {
  const select = $("characterSelect") as HTMLSelectElement;
  if (!select) return;

  // Placeholder while loading
  select.innerHTML = "";
  const loadingOpt = document.createElement("option");
  loadingOpt.value = "";
  loadingOpt.textContent = "Loading characters...";
  select.appendChild(loadingOpt);
  select.disabled = true;

  try {
    const chars = await fetchAllCharacters();
    select.innerHTML = "";

    // Default placeholder
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- Select a character --";
    select.appendChild(placeholder);

    // Populate list (use character name if present, else key)
    Object.entries(chars).forEach(([id, data]) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = data?.name || id;
      select.appendChild(opt);
    });

    select.disabled = false;
  } catch (err) {
    select.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Failed to load characters";
    select.appendChild(opt);
    select.disabled = true;
    console.error(err);
  }
}

async function populateAtlasSelect() {
    const select = $("atlasSelect") as HTMLSelectElement;
    if (!select) return;

    select.innerHTML = "";
    const loadingOpt = document.createElement("option");
    loadingOpt.value = "";
    loadingOpt.textContent = "Loading atlases...";
    select.appendChild(loadingOpt);
    select.disabled = true;

    try {
        const atlases = await fetchAllAtlases();
        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "-- Select an atlas --";
        select.appendChild(placeholder);

        Object.keys(atlases).forEach(id => {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = id;
            select.appendChild(opt);
        });

        select.disabled = false;
    } catch (err) {
        select.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "Failed to load atlases";
        select.appendChild(opt);
        select.disabled = true;
        console.error(err);
    }
}

async function loadAtlasAndPreview() {
    const select = $("atlasSelect") as HTMLSelectElement;
    const id = select?.value || "";
    if (!id) {
        // Silently return if no atlas is selected. This can happen when the
        // list is populated or the user selects the placeholder.
        return;
    }

    const atlasData = await fetchAtlas(id);
    if (!atlasData) {
        alert("Failed to load atlas data.");
        return;
    }

    const { png: dataURL, json } = atlasData;

    const img = $("atlasPreviewImg") as HTMLImageElement;
    img.src = dataURL;

    (img as any)._atlasJson = json;
    (img as any)._atlasDataURL = dataURL;

    // This part is the same as in buildAtlasAndPreview
    stopAtlasPreview();
    atlasSelectedFrameIndices.clear();

    await new Promise<void>(resolve => {
        const atlasImg = new Image();
        atlasImg.onload = async () => {
            atlasFrames = await extractFramesFromAtlas(atlasImg, json);
            renderAtlasFrames();
            resolve();
        };
        atlasImg.onerror = () => {
            console.error("Failed to load atlas image for preview");
            resolve();
        }
        atlasImg.src = dataURL;
    });
}

async function loadCharacterAndPreview() {
  const select = $("characterSelect") as HTMLSelectElement;
  const id = select?.value || "";
  if (!id) {
    alert("Select a character.");
    return;
  }

  // Atlas-based preview: fetch character, then its atlas, and slice frames by keys.
  const res = await loadCharacterPreviewFromAtlas(id);
  if (!res || !res.frames.length) {
    alert("No frames found for character or its atlas.");
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

  ($("atlasSelect") as HTMLSelectElement).addEventListener(
    "change",
    loadAtlasAndPreview
  );

  // Selection preview controls
  const selBtn = $("selectionPreviewBtn") as HTMLButtonElement | null;
  if (selBtn) {
    selBtn.addEventListener("click", () => {
      if (selectionPlaying) stopSelectionPreview();
      else startSelectionPreview();
    });
  }

  const fpsInput = $("selectionFpsInput") as HTMLInputElement | null;
  if (fpsInput) {
    fpsInput.addEventListener("change", () => {
      if (selectionPlaying) startSelectionPreview(); // restart with new fps
    });
  }

  // Atlas preview controls
  const atlasBtn = $("atlasPreviewBtn") as HTMLButtonElement | null;
  if (atlasBtn) {
    atlasBtn.addEventListener("click", () => {
      if (atlasAnimPlaying) stopAtlasPreview();
      else startAtlasPreview();
    });
  }

  const atlasAnimPreviewImg = $("atlasAnimPreviewImg") as HTMLImageElement | null;

  const downloadGifBtn = $("downloadGifBtn") as HTMLButtonElement | null;
  if (downloadGifBtn) {
    downloadGifBtn.addEventListener("click", () => {
      if (atlasAnimPreviewImg) {
        const blob = (atlasAnimPreviewImg as any)._gifBlob as Blob | null;
        if (blob) {
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
        } else {
          alert("No animation generated yet. Click 'Preview Atlas Anim' first.");
        }
      }
    });
  }

  const atlasFpsInput = $("atlasFpsInput") as HTMLInputElement | null;
  if (atlasFpsInput) {
    atlasFpsInput.addEventListener("change", () => {
      if (atlasAnimPlaying) startAtlasPreview(); // restart with new fps
    });
  }

  // Eyedropper: pick BG color from canvas in realtime
  const pickBtn = $("bgColorPickBtn") as HTMLButtonElement | null;
  if (pickBtn) {
    pickBtn.addEventListener("click", () => {
      if (bgPickActive) finishBgPick(false); // toggle off, revert to previous
      else startBgPick();
    });
  }

  // Erase color: pick + apply
  const erasePickBtn = $("eraseColorPickBtn") as HTMLButtonElement | null;
  if (erasePickBtn) {
    erasePickBtn.addEventListener("click", () => {
      if (erasePickActive) finishErasePick(false);
      else startErasePick();
    });
  }
  const eraseApplyBtn = $("eraseApplyBtn") as HTMLButtonElement | null;
  if (eraseApplyBtn) {
    eraseApplyBtn.addEventListener("click", () => {
      applyEraseColorNow();
    });
  }

  // Allow ESC to cancel picking and revert
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && bgPickActive) {
      finishBgPick(false);
    }
    if (e.key === "Escape" && erasePickActive) {
      finishErasePick(false);
    }
  });
}

function setupTheme() {
  const toggle = document.getElementById('theme-toggle') as HTMLInputElement;
  if (!toggle) return;

  const applyTheme = (isDark: boolean) => {
    document.body.classList.toggle('dark-mode', isDark);
    toggle.checked = isDark;
  };

  // Check for saved preference
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    applyTheme(true);
  } else if (savedTheme === 'light') {
    applyTheme(false);
  } else {
    // Fallback to system preference if no explicit choice is saved
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark);
  }

  toggle.addEventListener('change', () => {
    const isDark = toggle.checked;
    applyTheme(isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    // Only apply if no explicit user choice is stored
    if (!localStorage.getItem('theme')) {
      applyTheme(e.matches);
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  setupCanvases();
  setupTheme();
  wireUI();
  await populateCharacterSelect();
  await populateAtlasSelect();
});

function startBgPick() {
  if (bgPickActive) return;
  const bgInput = $("bgColorInput") as HTMLInputElement | null;
  const btn = $("bgColorPickBtn") as HTMLButtonElement | null;
  bgPickPrevHex = bgInput?.value ?? null;
  bgPickHoverHex = null;
  bgPickActive = true;
  if (btn) {
    btn.textContent = "Picking… (ESC to cancel)";
    btn.disabled = false;
  }
  if (overlayCanvas) overlayCanvas.style.cursor = "crosshair";
}

function finishBgPick(commit: boolean) {
  if (!bgPickActive) return;
  const bgInput = $("bgColorInput") as HTMLInputElement | null;
  const btn = $("bgColorPickBtn") as HTMLButtonElement | null;

  if (!commit && bgInput && bgPickPrevHex) {
    // revert to original value
    bgInput.value = bgPickPrevHex;
  }
  // if commit, we keep whatever hover color was last previewed

  bgPickActive = false;
  bgPickHoverHex = null;
  bgPickPrevHex = null;
  if (btn) btn.textContent = "Pick BG";
  if (overlayCanvas) overlayCanvas.style.cursor = "default";
}

// ============ Erase color pick + apply ==========

function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function removeColorFromCanvas(color: RGB, tolerance: number) {
  try {
    const w = originalCanvas.width;
    const h = originalCanvas.height;
    if (w <= 0 || h <= 0) return;
    const id = originalCtx.getImageData(0, 0, w, h);
    const data = id.data;
    const tol = Math.max(0, Math.min(200, Math.floor(tolerance)));
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (colorDistance({ r, g, b }, color) <= tol) {
        data[i + 3] = 0;
      }
    }
    originalCtx.putImageData(id, 0, 0);
  } catch (err) {
    alert("Failed to erase color. If using an external image URL, ensure it allows CORS.");
    console.error(err);
  }
}

function applyEraseColorNow() {
  const eInput = $("eraseColorInput") as HTMLInputElement | null;
  const tInput = $("eraseToleranceInput") as HTMLInputElement | null;
  const rgb = eInput?.value ? hexToRgb(eInput.value) : null;
  const tol = Number(tInput?.value || 12);
  if (!rgb) return;
  removeColorFromCanvas(rgb, tol);
  renderSelectedThumbs();
}

function startErasePick() {
  if (erasePickActive) return;
  const eInput = $("eraseColorInput") as HTMLInputElement | null;
  const btn = $("eraseColorPickBtn") as HTMLButtonElement | null;
  erasePickPrevHex = eInput?.value ?? null;
  erasePickHoverHex = null;
  erasePickActive = true;
  if (btn) {
    btn.textContent = "Picking… (ESC to cancel)";
    btn.disabled = false;
  }
  if (overlayCanvas) overlayCanvas.style.cursor = "crosshair";
}

function finishErasePick(commit: boolean) {
  if (!erasePickActive) return;
  const eInput = $("eraseColorInput") as HTMLInputElement | null;
  const btn = $("eraseColorPickBtn") as HTMLButtonElement | null;

  if (!commit && eInput && erasePickPrevHex) {
    // revert to original value
    eInput.value = erasePickPrevHex;
  }

  // On commit, immediately apply erase using chosen color and tolerance
  if (commit) applyEraseColorNow();

  erasePickActive = false;
  erasePickHoverHex = null;
  erasePickPrevHex = null;
  if (btn) btn.textContent = "Pick Erase";
  if (overlayCanvas) overlayCanvas.style.cursor = "default";
}
