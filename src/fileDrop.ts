// src/fileDrop.ts
// Drag & drop file loading — the drop counterpart to each tab's upload button.

/** True for the image types the workbench can decode. */
export function isImageFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    /\.(png|gif|webp|jpe?g|bmp)$/i.test(file.name)
  );
}

/** A drag carrying files from the OS, as opposed to an in-app element drag
 *  (atlas frame reordering) which only carries text. */
function carriesFiles(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types || []).includes("Files");
}

/**
 * Accept files dropped anywhere inside `panel`, outlining `hint` while the
 * drag hovers. In-app element drags pass straight through.
 */
export function wireFileDrop(
  panel: Element | null,
  hint: Element | null,
  onFiles: (files: File[]) => void
): void {
  if (!panel) return;

  // dragenter/dragleave fire again for every child the pointer crosses, so the
  // outline is refcounted rather than toggled per event.
  let depth = 0;
  const setActive = (on: boolean) => {
    depth = on ? depth : 0;
    hint?.classList.toggle("sx-drop-active", on);
  };

  panel.addEventListener("dragenter", (e) => {
    const ev = e as DragEvent;
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    depth++;
    hint?.classList.add("sx-drop-active");
  });

  panel.addEventListener("dragover", (e) => {
    const ev = e as DragEvent;
    if (!carriesFiles(ev)) return;
    ev.preventDefault(); // without this the browser refuses the drop
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });

  panel.addEventListener("dragleave", (e) => {
    const ev = e as DragEvent;
    if (!carriesFiles(ev)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setActive(false);
  });

  panel.addEventListener("drop", (e) => {
    const ev = e as DragEvent;
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    setActive(false);
    const files = Array.from(ev.dataTransfer?.files || []);
    if (files.length) onFiles(files);
  });
}

/** Swallow file drops that miss a drop zone — the browser would otherwise
 *  navigate away to the dropped file and take the session with it. */
export function blockStrayFileDrops(): void {
  // These run last, after bubbling past every drop zone — a zone that wants the
  // drop has already called preventDefault, so leave those alone.
  window.addEventListener("dragover", (e) => {
    const ev = e as DragEvent;
    if (!carriesFiles(ev) || ev.defaultPrevented) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "none";
  });

  window.addEventListener("drop", (e) => {
    const ev = e as DragEvent;
    if (carriesFiles(ev)) ev.preventDefault();
  });
}
