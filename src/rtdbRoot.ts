/**
 * Which tree of the Realtime Database the catalog lives in.
 *
 * The database is shared: cmg's catalog is the root-level `characters/`,
 * `atlases/`, `levels/` and `levelAliases/`, and shmupX keeps its own copy of
 * those four under `shmupX/` (shmupX.github.io's lib/rtdb-root.ts). A page
 * that serves spriteX for one of them sets `window.__RTDB_ROOT__` before
 * spriteX loads — codemonkey.games/spriteX/ sets "shmupX" — and every read
 * and write of those four nodes goes under that root. Everything else
 * (`sprites/`, `fonts/`, `maps/`, `tilemaps/`, `games/`) is shared and stays
 * at the root, and with no root set (easierbycode.com/spriteX/) nothing moves.
 *
 * The root is read on every call rather than once at load, so a page that
 * sets it after loading spriteX's bundle is still heard. The Firebase
 * `databaseURL` is never changed: the SDK refuses one with a path in it, so
 * the root goes on the paths instead.
 */

/** The nodes that follow `__RTDB_ROOT__`. Every other node stays at the root. */
export const SCOPED_NODES = [
  "levels",
  "levelAliases",
  "atlases",
  "characters",
] as const;

const SCOPED = new Set<string>(SCOPED_NODES);

/** A root the page may set: one plain RTDB key. */
const ROOT_KEY = /^[A-Za-z0-9_-]+$/;

/** The root the page set, or "" for the database's own. */
export function rtdbRoot(): string {
  const root = (globalThis as { __RTDB_ROOT__?: unknown }).__RTDB_ROOT__;
  return typeof root === "string" && ROOT_KEY.test(root) ? root : "";
}

/**
 * A database path with the page's root in front of it when it names one of
 * the scoped nodes, and unchanged otherwise (with root "shmupX"):
 *
 *   rtdbPath("atlases")            -> "shmupX/atlases"
 *   rtdbPath("characters/boss1")   -> "shmupX/characters/boss1"
 *   rtdbPath("sprites/RAM_0")      -> "sprites/RAM_0"
 *   rtdbPath("shmupX/atlases/foo") -> "shmupX/atlases/foo" (already rooted)
 *
 * The same rule as shmupX's rtdbPath: the first segment ends at "/", "?" or
 * ".", and leading slashes stay where they were.
 */
export function rtdbPath(path: string, root: string = rtdbRoot()): string {
  if (!root) return path;
  const lead = /^\/*/.exec(path)![0];
  const rest = path.slice(lead.length);
  const first = /^[^/?.]*/.exec(rest)![0];
  return SCOPED.has(first) ? `${lead}${root}/${rest}` : path;
}
