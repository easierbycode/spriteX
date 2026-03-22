/**
 * canvas-shim.mjs
 *
 * Thin wrapper around @napi-rs/canvas for Node.js scripts that need
 * Canvas/Image APIs (extract-frames, etc.).
 */

import { createCanvas as _createCanvas, loadImage as _loadImage } from "@napi-rs/canvas";

export const createCanvas = _createCanvas;
export const loadImage = _loadImage;
