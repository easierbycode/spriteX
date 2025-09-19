import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function copyAsset(from, to) {
  await ensureDir(dirname(to));
  await copyFile(from, to);
}

async function main() {
  await ensureDir(dist);
  await copyAsset(resolve(root, "index.html"), resolve(dist, "index.html"));
  await copyAsset(
    resolve(root, "src/vendor/gif.worker.js"),
    resolve(dist, "gif.worker.js")
  );
  await copyAsset(resolve(root, "sw.js"), resolve(dist, "sw.js"));
  await copyAsset(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
  await copyAsset(resolve(root, "favicon.ico"), resolve(dist, "favicon.ico"));
  await copyAsset(
    resolve(root, "icons/icon-192.png"),
    resolve(dist, "icons/icon-192.png")
  );
  await copyAsset(
    resolve(root, "icons/icon-512.png"),
    resolve(dist, "icons/icon-512.png")
  );
  await writeFile(
    resolve(dist, "404.html"),
    '<meta http-equiv="refresh" content="0; url=./" />'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});