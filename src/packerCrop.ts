// src/packerCrop.ts
// Crop dialog for oversized PACKER replacements.
//
// Preserving the atlas layout means a replacement has to fit the box the old
// frame already owns in the sheet. When it doesn't, the player decides what
// survives: a mask the exact size of the original frame — with the frame it is
// about to overwrite ghosted inside it — floats over the replacement, and
// whatever the mask covers is what gets kept.

export interface CropTarget {
  /** Frame being overwritten, for the dialog title. */
  frameName: string;
  /** Replacement sprite's name. */
  sourceName: string;
  /** The frame's box in the sheet — the mask size, in sheet pixels. */
  box: { w: number; h: number };
  /** Original sheet pixels for that box, ghosted inside the mask. */
  ghost: CanvasImageSource | null;
  source: HTMLImageElement;
  /** Position in a multi-frame replace, for the "2 / 5" counter. */
  step?: number;
  total?: number;
  /** Mask offset to open at, in source pixels. Defaults to centered. */
  initial?: { x: number; y: number };
  /** Offer SKIP (drop this one replacement and move on). */
  allowSkip?: boolean;
}

export type CropResult =
  | { action: "crop"; x: number; y: number }
  | { action: "scale" }
  | { action: "skip" }
  | { action: "cancel" };

const NUDGE_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function $(id: string) {
  return document.getElementById(id);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Show the dialog and resolve with the player's decision. Only one dialog runs
 * at a time; the promise settles exactly once, on whichever exit they take.
 */
export function openCropDialog(target: CropTarget): Promise<CropResult> {
  const modal = $("packerCropModal") as HTMLDivElement | null;
  const canvas = $("packerCropCanvas") as HTMLCanvasElement | null;
  const stage = $("packerCropStage") as HTMLDivElement | null;
  if (!modal || !canvas || !stage) return Promise.resolve({ action: "cancel" });

  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve({ action: "cancel" });

  const titleEl = $("packerCropTitle");
  const stepEl = $("packerCropStep");
  const subtitleEl = $("packerCropSubtitle");
  const infoEl = $("packerCropInfo");
  const ghostToggle = $("packerCropGhostToggle") as HTMLInputElement | null;
  const zoomInput = $("packerCropZoom") as HTMLInputElement | null;
  const zoomLabel = $("packerCropZoomLabel");
  const closeBtn = $("packerCropCloseBtn") as HTMLButtonElement | null;
  const centerBtn = $("packerCropCenterBtn") as HTMLButtonElement | null;
  const scaleBtn = $("packerCropScaleBtn") as HTMLButtonElement | null;
  const skipBtn = $("packerCropSkipBtn") as HTMLButtonElement | null;
  const applyBtn = $("packerCropApplyBtn") as HTMLButtonElement | null;

  const src = target.source;
  const srcW = Math.max(1, src.naturalWidth || src.width);
  const srcH = Math.max(1, src.naturalHeight || src.height);
  const maskW = Math.max(1, Math.round(target.box.w));
  const maskH = Math.max(1, Math.round(target.box.h));

  // A mask larger than the source in one axis has to be allowed to hang off
  // the edge, so the travel range runs through zero in whichever direction.
  const spanX = srcW - maskW;
  const spanY = srcH - maskH;
  const minX = Math.min(0, spanX);
  const maxX = Math.max(0, spanX);
  const minY = Math.min(0, spanY);
  const maxY = Math.max(0, spanY);
  const padX = Math.max(0, maskW - srcW);
  const padY = Math.max(0, maskH - srcH);
  const worldW = srcW + padX * 2;
  const worldH = srcH + padY * 2;

  let x = clamp(Math.round(target.initial?.x ?? spanX / 2), minX, maxX);
  let y = clamp(Math.round(target.initial?.y ?? spanY / 2), minY, maxY);
  let zoom = 1;
  let dragging = false;
  let grabX = 0;
  let grabY = 0;

  if (titleEl) titleEl.textContent = "CROP REPLACEMENT";
  if (stepEl) {
    stepEl.textContent =
      target.total && target.total > 1 ? `${target.step ?? 1} / ${target.total}` : "";
  }
  if (subtitleEl) {
    subtitleEl.textContent =
      `${target.sourceName} → ${target.frameName} · ` +
      `SOURCE ${srcW}×${srcH} · FRAME ${maskW}×${maskH}`;
  }
  if (skipBtn) skipBtn.style.display = target.allowSkip ? "" : "none";
  if (ghostToggle) ghostToggle.checked = true;

  function fitZoom(): number {
    const availW = Math.max(80, stage!.clientWidth - 24);
    const availH = Math.max(80, stage!.clientHeight - 24);
    return clamp(Math.floor(Math.min(availW / worldW, availH / worldH)), 1, 12);
  }

  function draw() {
    const z = zoom;
    const cw = worldW * z;
    const ch = worldH * z;
    if (canvas!.width !== cw || canvas!.height !== ch) {
      canvas!.width = cw;
      canvas!.height = ch;
      canvas!.style.width = `${cw}px`;
      canvas!.style.height = `${ch}px`;
    }
    ctx!.imageSmoothingEnabled = false;
    ctx!.clearRect(0, 0, cw, ch);
    ctx!.drawImage(src, padX * z, padY * z, srcW * z, srcH * z);

    const mx = (padX + x) * z;
    const my = (padY + y) * z;
    const mw = maskW * z;
    const mh = maskH * z;

    // Everything outside the mask is being thrown away — dim it so what
    // survives reads at a glance.
    ctx!.fillStyle = "rgba(2, 10, 4, .74)";
    ctx!.fillRect(0, 0, cw, my);
    ctx!.fillRect(0, my + mh, cw, ch - (my + mh));
    ctx!.fillRect(0, my, mx, mh);
    ctx!.fillRect(mx + mw, my, cw - (mx + mw), mh);

    if (target.ghost && ghostToggle?.checked) {
      ctx!.globalAlpha = 0.42;
      ctx!.drawImage(target.ghost, mx, my, mw, mh);
      ctx!.globalAlpha = 1;
    }

    ctx!.strokeStyle = "#f6ff4a";
    ctx!.lineWidth = 2;
    ctx!.strokeRect(mx + 1, my + 1, Math.max(0, mw - 2), Math.max(0, mh - 2));
    ctx!.strokeStyle = "rgba(2, 10, 4, .8)";
    ctx!.lineWidth = 1;
    ctx!.strokeRect(mx + 3, my + 3, Math.max(0, mw - 6), Math.max(0, mh - 6));

    if (infoEl) infoEl.textContent = `KEEP ${maskW}×${maskH} AT ${x},${y}`;
    if (zoomLabel) zoomLabel.textContent = `${zoom}×`;
  }

  function move(nx: number, ny: number) {
    const cx = clamp(Math.round(nx), minX, maxX);
    const cy = clamp(Math.round(ny), minY, maxY);
    if (cx === x && cy === y) return;
    x = cx;
    y = cy;
    draw();
  }

  /** Pointer position in source pixels. */
  function toSource(ev: MouseEvent): { sx: number; sy: number } {
    const r = canvas!.getBoundingClientRect();
    return {
      sx: (ev.clientX - r.left) / zoom - padX,
      sy: (ev.clientY - r.top) / zoom - padY,
    };
  }

  function onDown(ev: MouseEvent) {
    ev.preventDefault();
    const { sx, sy } = toSource(ev);
    const inside = sx >= x && sx < x + maskW && sy >= y && sy < y + maskH;
    if (inside) {
      grabX = sx - x;
      grabY = sy - y;
    } else {
      // Clicking away recentres the mask there — the whole interaction the
      // gamepad can drive, since its A button synthesises a click in place.
      grabX = maskW / 2;
      grabY = maskH / 2;
      move(sx - grabX, sy - grabY);
    }
    dragging = true;
  }

  function onMove(ev: MouseEvent) {
    if (!dragging) return;
    ev.preventDefault();
    const { sx, sy } = toSource(ev);
    move(sx - grabX, sy - grabY);
  }

  function onUp() {
    dragging = false;
  }

  function onKey(ev: KeyboardEvent) {
    const nudge = NUDGE_KEYS[ev.key];
    if (nudge) {
      const stepPx = ev.shiftKey ? 8 : 1;
      ev.preventDefault();
      ev.stopPropagation();
      move(x + nudge[0] * stepPx, y + nudge[1] * stepPx);
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      finish({ action: "crop", x, y });
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      finish({ action: "cancel" });
      return;
    }
    // The workbench binds bare keys globally (F fullscreen, Q/E tabs, space
    // pan) — none of them should fire while this dialog owns the screen.
    if (ev.key.length === 1 || ev.key === "Tab") ev.stopPropagation();
  }

  let settled = false;
  let resolveFn: (r: CropResult) => void = () => {};

  function finish(result: CropResult) {
    if (settled) return;
    settled = true;
    canvas!.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    ghostToggle?.removeEventListener("change", draw);
    zoomInput?.removeEventListener("input", onZoom);
    closeBtn?.removeEventListener("click", onCancel);
    centerBtn?.removeEventListener("click", onCenter);
    scaleBtn?.removeEventListener("click", onScale);
    skipBtn?.removeEventListener("click", onSkip);
    applyBtn?.removeEventListener("click", onApply);
    modal!.removeEventListener("mousedown", onBackdrop);
    modal!.classList.remove("open");
    resolveFn(result);
  }

  function onCancel() {
    finish({ action: "cancel" });
  }
  function onSkip() {
    finish({ action: "skip" });
  }
  function onScale() {
    finish({ action: "scale" });
  }
  function onApply() {
    finish({ action: "crop", x, y });
  }
  function onCenter() {
    move(spanX / 2, spanY / 2);
  }
  function onZoom() {
    zoom = clamp(Number(zoomInput?.value) || 1, 1, 12);
    if (zoomInput) zoomInput.dataset.touched = "1";
    draw();
  }
  function onResize() {
    if (zoomInput && zoomInput.dataset.touched !== "1") {
      zoom = fitZoom();
      zoomInput.value = String(zoom);
    }
    draw();
  }
  function onBackdrop(ev: MouseEvent) {
    if (ev.target === modal) finish({ action: "cancel" });
  }

  modal.classList.add("open");
  zoom = fitZoom();
  if (zoomInput) {
    zoomInput.value = String(zoom);
    zoomInput.dataset.touched = "0";
  }
  draw();

  canvas.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // Capture phase: the app's global key handlers listen on document, and this
  // dialog has to win the arrow keys back from the workspace zoom.
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  ghostToggle?.addEventListener("change", draw);
  zoomInput?.addEventListener("input", onZoom);
  closeBtn?.addEventListener("click", onCancel);
  centerBtn?.addEventListener("click", onCenter);
  scaleBtn?.addEventListener("click", onScale);
  skipBtn?.addEventListener("click", onSkip);
  applyBtn?.addEventListener("click", onApply);
  modal.addEventListener("mousedown", onBackdrop);

  return new Promise<CropResult>((resolve) => {
    resolveFn = resolve;
  });
}
