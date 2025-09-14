import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function main() {
  await ensureDir(dist);
  await copyFile(resolve(root, "index.html"), resolve(dist, "index.html"));
  await copyFile(
    resolve(root, "src/vendor/gif.worker.js"),
    resolve(dist, "gif.worker.js")
  );
  await copyFile(resolve(root, "sw.js"), resolve(dist, "sw.js"));
  await copyFile(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
  await writeFile(
    resolve(dist, "404.html"),
    '<meta http-equiv="refresh" content="0; url=./" />'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});