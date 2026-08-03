/**
 * SpriteXPlugin — Phaser 3 global plugin for the spriteX asset pipeline.
 *
 * Capabilities:
 *  1. Live loading: `this.load.image(key)`, `this.load.spritesheet(key, null, frameConfig)`
 *     and `this.load.atlas(key)` calls without a URL are fetched straight from the
 *     spriteX Firebase RTDB (`/sprites/*`, `/atlases/*`, `/games/{game}/atlases/*`).
 *     Explicit `spritex://` URLs are also supported and always intercepted.
 *  2. Usage tracking: records every texture frame the game actually touches at
 *     runtime and can persist the report to `/games/{game}/assetUsage` so tooling
 *     (scripts/optimize-atlas.mjs, the spriteX MCP server) can build an optimized
 *     atlas containing only those frames.
 *  3. Optimized atlas: `createOptimizedAtlas()` packs the used frames into a single
 *     atlas in the browser and can save it to RTDB or download it. With
 *     `useOptimizedAtlas: true` the plugin loads that atlas at boot and satisfies
 *     intercepted load calls from it without further network requests.
 *
 * The plugin has zero dependencies: it talks to RTDB over REST and never imports
 * Phaser — the Phaser namespace is auto-detected from `globalThis.Phaser` or can
 * be supplied via `SpriteXPlugin.install(Phaser)` / plugin data `{ phaser }`.
 *
 * Usage:
 *   new Phaser.Game({
 *     ...,
 *     plugins: {
 *       global: [{
 *         key: 'SpriteXPlugin',
 *         plugin: SpriteXPlugin,
 *         start: true,
 *         data: { gameName: 'evil-invaders', trackUsage: true, autoSaveUsage: true },
 *       }],
 *     },
 *   });
 */

export interface SpriteXFrameConfig {
  frameWidth: number;
  frameHeight?: number;
  startFrame?: number;
  endFrame?: number;
  margin?: number;
  spacing?: number;
}

export interface SpriteXPluginConfig {
  /** Game scope used for `/games/{game}/atlases/*` lookups and usage reports. */
  gameName?: string;
  /** Firebase RTDB base URL. */
  databaseURL?: string;
  /** Intercept bare `load.image/spritesheet/atlas` calls that omit a URL. Default true. */
  liveLoad?: boolean;
  /** Record which texture frames the game actually uses. Default true. */
  trackUsage?: boolean;
  /** Periodically persist the usage report to RTDB. Default false. */
  autoSaveUsage?: boolean;
  /** Auto-save interval in ms. Default 30000. */
  autoSaveIntervalMs?: number;
  /** Atlas key used by loadOptimizedAtlas/createOptimizedAtlas. Default `${gameName}_optimized`. */
  optimizedAtlasKey?: string;
  /** Fetch the optimized atlas at boot and satisfy intercepted loads from it. Default false. */
  useOptimizedAtlas?: boolean;
  /** Max packed atlas width in px. Default 2048. */
  maxAtlasWidth?: number;
  /** Padding between packed frames in px. Default 1. */
  padding?: number;
  /** Explicit Phaser namespace (otherwise globalThis.Phaser is used). */
  phaser?: any;
  /** Log resolved assets and tracking events. Default false. */
  debug?: boolean;
}

export interface OptimizedAtlasResult {
  name: string;
  json: any;
  dataURL: string;
  frameCount: number;
  size: { w: number; h: number };
}

const DEFAULT_DATABASE_URL = "https://evil-invaders-default-rtdb.firebaseio.com";
const SPRITEX_SCHEME = "spritex://";
const RTDB_INVALID_KEY_CHARS = /[.#$\/\[\]]/;

/** ================= frame-key helpers (in sync with atlasManager.ts) ========= */

/** Firebase RTDB keys cannot contain . # $ / [ ] — hex-encode UTF-16 code units. */
export function encodeFrameKey(name: string): string {
  let hex = "";
  for (let i = 0; i < name.length; i++) {
    hex += name.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return `k_${hex}`;
}

/** Decode a `k_`-prefixed hex frame key back to its original name. */
export function decodeFrameKey(key: string): string {
  if (typeof key !== "string" || !key.startsWith("k_")) return key;
  const hex = key.slice(2);
  if (hex.length === 0 || hex.length % 4 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return key;
  }
  let out = "";
  for (let i = 0; i < hex.length; i += 4) {
    out += String.fromCodePoint(parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

function rtdbSafeKey(key: string): string {
  if (key && !RTDB_INVALID_KEY_CHARS.test(key)) return key;
  return encodeFrameKey(key);
}

/** Atlas JSON may be an object, a JSON string, or a double-encoded JSON string. */
function normalizeAtlasJson(jsonVal: any): any | null {
  if (jsonVal == null) return null;
  if (typeof jsonVal === "object") return jsonVal;
  if (typeof jsonVal !== "string") return null;
  const str = jsonVal.trim();
  try {
    const once = JSON.parse(str);
    if (typeof once === "string") {
      try {
        return JSON.parse(once);
      } catch {
        return null;
      }
    }
    return once;
  } catch {
    try {
      return JSON.parse(str.replace(/^﻿/, "").trim());
    } catch {
      return null;
    }
  }
}

function getFramesMap(atlasJson: any): Record<string, any> | null {
  return atlasJson?.frames ?? atlasJson?.textures?.[0]?.frames ?? null;
}

/**
 * Return a copy of the atlas JSON with hex-encoded frame keys decoded and
 * non-frame entries dropped (catalog atlases may contain stray "comment"
 * strings and similar junk that would crash Phaser's JSONHash parser).
 */
function decodeAtlasJsonKeys(atlasJson: any): any {
  const framesMap = getFramesMap(atlasJson);
  if (!framesMap || Array.isArray(framesMap)) return atlasJson;
  const decoded: Record<string, any> = {};
  for (const [k, v] of Object.entries(framesMap)) {
    if (typeof (v as any)?.frame?.x !== "number") continue;
    decoded[decodeFrameKey(k)] = v;
  }
  const copy = { ...atlasJson };
  if (copy.frames) {
    copy.frames = decoded;
  } else if (Array.isArray(copy.textures) && copy.textures[0]) {
    copy.textures = [...copy.textures];
    copy.textures[0] = { ...copy.textures[0], frames: decoded };
  }
  return copy;
}

/** Return a copy of the atlas JSON with RTDB-unsafe frame keys hex-encoded. */
function encodeAtlasJsonKeys(atlasJson: any): any {
  const framesMap = getFramesMap(atlasJson);
  if (!framesMap || Array.isArray(framesMap)) return atlasJson;
  const encoded: Record<string, any> = {};
  for (const [k, v] of Object.entries(framesMap)) {
    encoded[rtdbSafeKey(k)] = v;
  }
  const copy = { ...atlasJson, frames: encoded };
  return copy;
}

function ensureDataURL(s: string): string {
  return s.startsWith("data:") ? s : `data:image/png;base64,${s}`;
}

/** ============================ shelf packer ================================= */

interface PackInput {
  name: string;
  w: number;
  h: number;
  data?: any;
}

interface Placement extends PackInput {
  x: number;
  y: number;
}

function packShelf(
  inputs: PackInput[],
  maxWidth: number,
  padding: number
): { placements: Placement[]; width: number; height: number } {
  const sorted = [...inputs].sort((a, b) => b.h - a.h || b.w - a.w);
  let curX = 0;
  let curY = 0;
  let rowHeight = 0;
  let width = 0;
  const placements: Placement[] = [];

  for (const item of sorted) {
    if (curX > 0 && curX + item.w > maxWidth) {
      width = Math.max(width, curX - padding);
      curX = 0;
      curY += rowHeight + padding;
      rowHeight = 0;
    }
    placements.push({ ...item, x: curX, y: curY });
    curX += item.w + padding;
    rowHeight = Math.max(rowHeight, item.h);
  }

  width = Math.max(width, curX - padding);
  return { placements, width: Math.max(1, width), height: Math.max(1, curY + rowHeight) };
}

/** ============================ the plugin =================================== */

type UsageMap = Map<string, Set<string>>;

interface ResolvedAsset {
  kind: "image" | "spritesheet" | "atlas";
  dataURL?: string;
  atlasJson?: any;
  frameConfig?: SpriteXFrameConfig;
  /** Set when the asset was satisfied from the loaded optimized atlas. */
  aliasedFromOptimized?: boolean;
}

export default class SpriteXPlugin {
  static readonly VERSION = "1.0.0";

  /** Game → plugin instance, so prototype patches can find their owner. */
  private static registry = new Map<any, SpriteXPlugin>();
  private static patchedPhaser: any = null;

  pluginManager: any;
  game: any;
  config: Required<Omit<SpriteXPluginConfig, "phaser" | "gameName" | "optimizedAtlasKey">> & {
    gameName?: string;
    optimizedAtlasKey: string;
    phaser?: any;
  };

  private usage: UsageMap = new Map();
  /** frameConfigs captured from intercepted load.spritesheet calls */
  private sheetConfigs = new Map<string, SpriteXFrameConfig>();
  private suppressTracking = 0;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private optimizedPromise: Promise<any | null> | null = null;
  private optimizedTexture: any = null;
  private optimizedMeta: any = null;
  private flushListener: (() => void) | null = null;

  constructor(pluginManager: any) {
    this.pluginManager = pluginManager;
    this.game = pluginManager?.game ?? null;
    this.config = SpriteXPlugin.defaults();
  }

  private static defaults(): SpriteXPlugin["config"] {
    return {
      gameName: undefined,
      databaseURL: DEFAULT_DATABASE_URL,
      liveLoad: true,
      trackUsage: true,
      autoSaveUsage: false,
      autoSaveIntervalMs: 30000,
      optimizedAtlasKey: "optimized",
      useOptimizedAtlas: false,
      maxAtlasWidth: 2048,
      padding: 1,
      debug: false,
    };
  }

  /**
   * Explicitly provide the Phaser namespace and patch it. Optional — `init`
   * auto-detects `globalThis.Phaser` — but required for bundlers that do not
   * expose a Phaser global. Call before creating the game.
   */
  static install(PhaserNS: any): void {
    SpriteXPlugin.patchPhaser(PhaserNS);
  }

  /** BasePlugin lifecycle: called by the PluginManager during game boot. */
  init(data?: SpriteXPluginConfig): void {
    const defaults = SpriteXPlugin.defaults();
    this.config = { ...defaults, ...(data ?? {}) } as SpriteXPlugin["config"];
    if (!data?.optimizedAtlasKey) {
      this.config.optimizedAtlasKey = this.config.gameName
        ? `${this.config.gameName}_optimized`
        : "optimized";
    }

    const PhaserNS = this.config.phaser ?? (globalThis as any).Phaser ?? SpriteXPlugin.patchedPhaser;
    if (!PhaserNS) {
      console.error(
        "[spriteX] Phaser namespace not found. Pass it via plugin data { phaser: Phaser } " +
          "or call SpriteXPlugin.install(Phaser) before creating the game. " +
          "Live loading and usage tracking are disabled."
      );
      return;
    }

    SpriteXPlugin.patchPhaser(PhaserNS);
    SpriteXPlugin.registry.set(this.game, this);

    if (this.config.autoSaveUsage && this.config.gameName) {
      this.autoSaveTimer = setInterval(() => {
        this.saveUsageReport().catch(() => undefined);
      }, this.config.autoSaveIntervalMs);
      this.flushListener = () => {
        void this.saveUsageReport({ keepalive: true });
      };
      if (typeof window !== "undefined") {
        window.addEventListener("pagehide", this.flushListener);
      }
    }

    if (this.config.useOptimizedAtlas) {
      // Kick off early; intercepted loads await this before hitting the network.
      void this.ensureOptimizedLoaded();
    }

    this.log(`initialized (game=${this.config.gameName ?? "-"}, liveLoad=${this.config.liveLoad})`);
  }

  start(): void {
    /* BasePlugin lifecycle — nothing to do. */
  }

  stop(): void {
    /* BasePlugin lifecycle — nothing to do. */
  }

  destroy(): void {
    if (this.autoSaveTimer) clearInterval(this.autoSaveTimer);
    this.autoSaveTimer = null;
    if (this.flushListener && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.flushListener);
    }
    this.flushListener = null;
    SpriteXPlugin.registry.delete(this.game);
  }

  private log(...args: any[]): void {
    if (this.config.debug) console.log("[spriteX]", ...args);
  }

  /** =================== Phaser prototype patching =========================== */

  private static patchPhaser(PhaserNS: any): void {
    if (!PhaserNS || SpriteXPlugin.patchedPhaser === PhaserNS) return;
    if (SpriteXPlugin.patchedPhaser && SpriteXPlugin.patchedPhaser !== PhaserNS) {
      console.warn("[spriteX] a different Phaser namespace was already patched; skipping.");
      return;
    }
    SpriteXPlugin.patchedPhaser = PhaserNS;

    const fileTypesManager = PhaserNS.Loader?.FileTypesManager;
    const textureProto = PhaserNS.Textures?.Texture?.prototype;
    if (!fileTypesManager || !textureProto) {
      console.error("[spriteX] unexpected Phaser namespace shape; cannot patch loader/textures.");
      return;
    }

    // Phaser installs load.image/spritesheet/atlas as OWN properties on every
    // LoaderPlugin instance (FileTypesManager.install runs in its constructor),
    // so prototype patches would be shadowed. Hook install() instead and wrap
    // each new loader right after Phaser populates it.
    const origInstall = fileTypesManager.install;
    fileTypesManager.install = function (loader: any) {
      origInstall.call(this, loader);
      SpriteXPlugin.wrapLoader(loader);
    };

    const origTextureGet = textureProto.get;
    textureProto.get = function (name?: any) {
      const frame = origTextureGet.call(this, name);
      const plugin = SpriteXPlugin.registry.get(this.manager?.game);
      if (plugin && plugin.config.trackUsage && plugin.suppressTracking === 0) {
        plugin.recordUsage(this.key, frame?.name ?? name);
      }
      return frame;
    };
  }

  /** Wrap one loader instance's file-type methods with spriteX interception. */
  private static wrapLoader(loader: any): void {
    if (!loader || loader.__spritexWrapped || typeof loader.image !== "function") return;
    loader.__spritexWrapped = true;

    const pluginOf = (): SpriteXPlugin | undefined => {
      const game = loader?.scene?.sys?.game ?? loader?.systems?.game;
      return SpriteXPlugin.registry.get(game);
    };

    const origImage = loader.image;
    loader.image = function (key: any, url?: any, xhrSettings?: any) {
      const plugin = pluginOf();
      if (plugin && plugin.tryIntercept(this, "image", key, url)) return this;
      return origImage.call(this, key, url, xhrSettings);
    };

    const origSpritesheet = loader.spritesheet;
    loader.spritesheet = function (key: any, url?: any, frameConfig?: any, xhrSettings?: any) {
      const plugin = pluginOf();
      // Ergonomic form: load.spritesheet('key', { frameWidth: 16, ... })
      if (plugin && url && typeof url === "object" && typeof url.frameWidth === "number") {
        frameConfig = url;
        url = null;
      }
      if (plugin && typeof key === "string" && frameConfig) {
        plugin.sheetConfigs.set(key, { ...frameConfig });
      }
      if (plugin && plugin.tryIntercept(this, "spritesheet", key, url, frameConfig)) return this;
      return origSpritesheet.call(this, key, url, frameConfig, xhrSettings);
    };

    const origAtlas = loader.atlas;
    loader.atlas = function (key: any, textureURL?: any, atlasURL?: any, ...rest: any[]) {
      const plugin = pluginOf();
      if (plugin && atlasURL == null && plugin.tryIntercept(this, "atlas", key, textureURL)) {
        return this;
      }
      return origAtlas.call(this, key, textureURL, atlasURL, ...rest);
    };
  }

  /** =================== load interception =================================== */

  /**
   * Decide whether this load call is ours. Returns true when the call was
   * fully handled (files enqueued); false lets the original loader run.
   */
  private tryIntercept(loader: any, kind: ResolvedAsset["kind"], key: any, url?: any, frameConfig?: any): boolean {
    // spritex:// URLs are always ours, regardless of liveLoad.
    if (typeof key === "string" && typeof url === "string" && url.startsWith(SPRITEX_SCHEME)) {
      this.enqueueFile(loader, kind, key, url.slice(SPRITEX_SCHEME.length), frameConfig);
      return true;
    }
    if (!this.config.liveLoad) return false;

    if (Array.isArray(key) && key.every((k) => typeof k === "string")) {
      if (url != null) return false;
      for (const k of key) this.enqueueFile(loader, kind, k, null, frameConfig);
      return true;
    }
    if (typeof key !== "string" || url != null) return false;
    if (kind === "spritesheet" && !frameConfig) return false;

    this.enqueueFile(loader, kind, key, null, frameConfig);
    return true;
  }

  private enqueueFile(
    loader: any,
    kind: ResolvedAsset["kind"],
    key: string,
    explicitPath: string | null,
    frameConfig?: SpriteXFrameConfig
  ): void {
    const PhaserNS = SpriteXPlugin.patchedPhaser;
    const plugin = this;

    if (loader.textureManager?.exists?.(key)) {
      this.log(`skip ${kind} "${key}" — texture already exists`);
      return;
    }

    const FileClass = PhaserNS.Loader.File;
    const file = new FileClass(loader, {
      type: `spritex-${kind}`,
      key,
      // A concrete URL keeps Phaser's internals happy; never actually requested.
      url: `${SPRITEX_SCHEME}${explicitPath ?? key}`,
    });

    file.load = function () {
      plugin
        .resolveAsset(kind, key, explicitPath, frameConfig)
        .then((asset: ResolvedAsset) => {
          (this as any).spritexAsset = asset;
          this.loader.nextFile(this, true);
        })
        .catch((err: any) => {
          console.error(`[spriteX] failed to resolve ${kind} "${key}":`, err?.message ?? err);
          this.loader.nextFile(this, false);
        });
    };

    file.onProcess = function () {
      this.state = PhaserNS.Loader.FILE_PROCESSING;
      const asset: ResolvedAsset = (this as any).spritexAsset;
      const tm = this.loader.textureManager;

      const finish = () => this.onProcessComplete();

      if (asset.aliasedFromOptimized) {
        // Texture was already created from the optimized atlas during resolve.
        finish();
        return;
      }

      const img = new Image();
      img.onload = () => {
        plugin.suppressTracking++;
        try {
          if (asset.kind === "image") {
            tm.addImage(key, img);
          } else if (asset.kind === "spritesheet") {
            tm.addSpriteSheet(key, img, asset.frameConfig);
          } else {
            tm.addAtlas(key, img, decodeAtlasJsonKeys(asset.atlasJson));
          }
        } catch (err) {
          console.error(`[spriteX] failed to add ${asset.kind} "${key}":`, err);
          this.onProcessError(err);
          return;
        } finally {
          plugin.suppressTracking--;
        }
        plugin.log(`loaded ${asset.kind} "${key}" from spriteX`);
        finish();
      };
      img.onerror = () => this.onProcessError(new Error(`[spriteX] could not decode image for "${key}"`));
      img.src = asset.dataURL!;
    };

    loader.addFile(file);
  }

  /** =================== asset resolution ==================================== */

  private async fetchRTDB(path: string): Promise<any> {
    const url = `${this.config.databaseURL}/${path}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`RTDB request failed (${res.status}) for ${path}`);
    return res.json();
  }

  private async resolveAsset(
    kind: ResolvedAsset["kind"],
    key: string,
    explicitPath: string | null,
    frameConfig?: SpriteXFrameConfig
  ): Promise<ResolvedAsset> {
    // Explicit spritex://<path> — path maps directly into the RTDB tree.
    if (explicitPath && explicitPath !== key) {
      return this.resolveFromPath(kind, key, explicitPath, frameConfig);
    }

    if (this.config.useOptimizedAtlas) {
      await this.ensureOptimizedLoaded();
      const aliased = this.tryAliasFromOptimized(kind, key, frameConfig);
      if (aliased) return aliased;
    }

    if (kind === "atlas") {
      const atlas = await this.fetchAtlasRecord(key);
      if (!atlas) throw new Error(`atlas "${key}" not found in spriteX`);
      return { kind, dataURL: ensureDataURL(atlas.png), atlasJson: atlas.json };
    }

    const dataURL = await this.fetchSpriteImage(key);
    if (!dataURL) throw new Error(`sprite "${key}" not found in spriteX (/sprites)`);
    return { kind, dataURL, frameConfig };
  }

  private async resolveFromPath(
    kind: ResolvedAsset["kind"],
    key: string,
    path: string,
    frameConfig?: SpriteXFrameConfig
  ): Promise<ResolvedAsset> {
    const val = await this.fetchRTDB(path.replace(/^\/+|\/+$/g, ""));
    if (val == null) throw new Error(`nothing at spritex://${path}`);
    if (kind === "atlas") {
      const json = normalizeAtlasJson(val.json);
      if (!json || typeof val.png !== "string") throw new Error(`spritex://${path} is not an atlas record`);
      return { kind, dataURL: ensureDataURL(val.png), atlasJson: json };
    }
    const png = typeof val === "string" ? val : val?.png;
    if (typeof png !== "string") throw new Error(`spritex://${path} is not an image record`);
    return { kind, dataURL: ensureDataURL(png), frameConfig };
  }

  private async fetchAtlasRecord(name: string): Promise<{ json: any; png: string } | null> {
    const paths = [];
    if (this.config.gameName) paths.push(`games/${this.config.gameName}/atlases/${name}`);
    paths.push(`atlases/${name}`);
    for (const p of paths) {
      try {
        const val = await this.fetchRTDB(p);
        const json = normalizeAtlasJson(val?.json);
        if (json && typeof val?.png === "string") return { json, png: val.png };
      } catch {
        /* try next location */
      }
    }
    return null;
  }

  private async fetchSpriteImage(key: string): Promise<string | null> {
    for (const candidate of [key, encodeFrameKey(key)]) {
      if (RTDB_INVALID_KEY_CHARS.test(candidate)) continue;
      try {
        const val = await this.fetchRTDB(`sprites/${candidate}`);
        const png = typeof val === "string" ? val : val?.png;
        if (typeof png === "string") return ensureDataURL(png);
      } catch {
        /* try next candidate */
      }
    }
    return null;
  }

  /** =================== optimized atlas: load & alias ======================= */

  /** Fetch the optimized atlas once and register it as a texture. */
  async ensureOptimizedLoaded(): Promise<any | null> {
    if (!this.optimizedPromise) {
      this.optimizedPromise = (async () => {
        const record = await this.fetchAtlasRecord(this.config.optimizedAtlasKey);
        if (!record) {
          this.log(`optimized atlas "${this.config.optimizedAtlasKey}" not found — falling back to live loads`);
          return null;
        }
        const decoded = decodeAtlasJsonKeys(record.json);
        await new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            this.suppressTracking++;
            try {
              const tm = this.game.textures;
              if (!tm.exists(this.config.optimizedAtlasKey)) {
                tm.addAtlas(this.config.optimizedAtlasKey, img, decoded);
              }
              this.optimizedTexture = tm.get(this.config.optimizedAtlasKey);
            } finally {
              this.suppressTracking--;
            }
            resolve();
          };
          img.onerror = () => reject(new Error("could not decode optimized atlas image"));
          img.src = ensureDataURL(record.png);
        });
        this.optimizedMeta = decoded?.meta?.spritex ?? null;
        this.log(`optimized atlas "${this.config.optimizedAtlasKey}" loaded`);
        return decoded;
      })().catch((err) => {
        console.error("[spriteX] failed to load optimized atlas:", err?.message ?? err);
        return null;
      });
    }
    return this.optimizedPromise;
  }

  /**
   * Satisfy a load request from the already-loaded optimized atlas by creating
   * a texture that references the optimized atlas image (no network, no new pixels).
   */
  private tryAliasFromOptimized(
    kind: ResolvedAsset["kind"],
    key: string,
    frameConfig?: SpriteXFrameConfig
  ): ResolvedAsset | null {
    const tex = this.optimizedTexture;
    if (!tex) return null;
    const tm = this.game.textures;
    const source = tex.getSourceImage();

    this.suppressTracking++;
    try {
      if (kind === "image") {
        if (!tex.has(key)) return null;
        const f = tex.get(key);
        const t = tm.create(key, source);
        t.add("__BASE", 0, f.cutX, f.cutY, f.cutWidth, f.cutHeight);
        this.log(`aliased image "${key}" from optimized atlas`);
        return { kind, aliasedFromOptimized: true };
      }

      if (kind === "spritesheet") {
        if (!tex.has(key)) return null;
        const f = tex.get(key);
        const fc: SpriteXFrameConfig | undefined =
          frameConfig ?? this.optimizedMeta?.sheets?.[key] ?? this.sheetConfigs.get(key);
        if (!fc || !fc.frameWidth) return null;
        const t = tm.create(key, source);
        t.add("__BASE", 0, f.cutX, f.cutY, f.cutWidth, f.cutHeight);
        this.addGridFrames(t, f.cutX, f.cutY, f.cutWidth, f.cutHeight, fc);
        this.log(`aliased spritesheet "${key}" from optimized atlas`);
        return { kind, aliasedFromOptimized: true };
      }

      // atlas: only alias when the optimized meta says which frames came from it.
      const frameList: string[] | undefined = this.optimizedMeta?.atlases?.[rtdbSafeKey(key)] ?? this.optimizedMeta?.atlases?.[key];
      if (!frameList || frameList.length === 0) return null;
      const names = frameList.map(decodeFrameKey);
      if (!names.every((n) => tex.has(n))) return null;
      const t = tm.create(key, source);
      const first = tex.get(names[0]);
      t.add("__BASE", 0, first.cutX, first.cutY, first.cutWidth, first.cutHeight);
      for (const n of names) {
        const f = tex.get(n);
        const added = t.add(n, 0, f.cutX, f.cutY, f.cutWidth, f.cutHeight);
        if (added && f.customPivot) added.setPivot(f.pivotX, f.pivotY);
      }
      this.log(`aliased atlas "${key}" (${names.length} frames) from optimized atlas`);
      return { kind, aliasedFromOptimized: true };
    } finally {
      this.suppressTracking--;
    }
  }

  private addGridFrames(
    texture: any,
    x: number,
    y: number,
    w: number,
    h: number,
    fc: SpriteXFrameConfig
  ): void {
    const fw = fc.frameWidth;
    const fh = fc.frameHeight ?? fc.frameWidth;
    const margin = fc.margin ?? 0;
    const spacing = fc.spacing ?? 0;
    const cols = Math.floor((w - margin * 2 + spacing) / (fw + spacing));
    const rows = Math.floor((h - margin * 2 + spacing) / (fh + spacing));
    let idx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        texture.add(
          idx++,
          0,
          x + margin + c * (fw + spacing),
          y + margin + r * (fh + spacing),
          fw,
          fh
        );
      }
    }
  }

  /** =================== usage tracking ====================================== */

  private recordUsage(textureKey: string, frameName: any): void {
    if (typeof textureKey !== "string" || textureKey.startsWith("__")) return;
    if (textureKey === this.config.optimizedAtlasKey) return;
    let frames = this.usage.get(textureKey);
    if (!frames) {
      frames = new Set();
      this.usage.set(textureKey, frames);
    }
    frames.add(String(frameName ?? "__BASE"));
  }

  /** The frames the game has touched so far this session. */
  getUsageReport(): { gameName: string | null; textures: Record<string, string[]> } {
    const textures: Record<string, string[]> = {};
    for (const [key, frames] of this.usage) {
      textures[key] = [...frames].sort();
    }
    return { gameName: this.config.gameName ?? null, textures };
  }

  clearUsage(): void {
    this.usage.clear();
  }

  /**
   * Merge this session's usage into `/games/{game}/assetUsage` so server-side
   * tooling can build the optimized atlas. Accumulates across sessions.
   */
  async saveUsageReport(opts?: { keepalive?: boolean }): Promise<void> {
    const game = this.config.gameName;
    if (!game) throw new Error("[spriteX] saveUsageReport requires config.gameName");
    if (this.usage.size === 0) return;

    const body: Record<string, any> = {};
    for (const [texKey, frames] of this.usage) {
      const safeTex = rtdbSafeKey(texKey);
      for (const frame of frames) {
        body[`${safeTex}/${rtdbSafeKey(frame)}`] = true;
      }
    }
    body["_meta/lastUpdated"] = { ".sv": "timestamp" };

    const res = await fetch(`${this.config.databaseURL}/games/${game}/assetUsage.json`, {
      method: "PATCH",
      body: JSON.stringify(body),
      keepalive: opts?.keepalive ?? false,
    });
    if (!res.ok) throw new Error(`[spriteX] usage save failed (${res.status})`);
    this.log(`usage report saved (${this.usage.size} textures)`);
  }

  /** =================== optimized atlas: create ============================= */

  /**
   * Pack every frame the game has used this session into a single atlas.
   * Options: `save` writes it to RTDB under the game scope; `download` triggers
   * browser downloads of the PNG + JSON.
   */
  async createOptimizedAtlas(opts?: {
    name?: string;
    save?: boolean;
    download?: boolean;
  }): Promise<OptimizedAtlasResult> {
    if (this.usage.size === 0) {
      throw new Error("[spriteX] no usage recorded yet — play the game first, then create the atlas");
    }
    const name = opts?.name ?? this.config.optimizedAtlasKey;
    const tm = this.game.textures;

    interface Entry extends PackInput {
      source: any; // CanvasImageSource
      frameData: any;
    }
    const entries: Entry[] = [];
    const meta: { images: string[]; sheets: Record<string, any>; atlases: Record<string, string[]> } = {
      images: [],
      sheets: {},
      atlases: {},
    };
    const taken = new Map<string, string>(); // frameName -> textureKey

    this.suppressTracking++;
    try {
      for (const [texKey, frames] of this.usage) {
        if (!tm.exists(texKey)) continue;
        const tex = tm.get(texKey);
        const source = tex.getSourceImage();
        const frameNames: string[] = tex.getFrameNames(false);
        const numeric = frameNames.length > 0 && frameNames.every((n: any) => /^\d+$/.test(String(n)));

        if (frameNames.length === 0 || numeric) {
          // Plain image (only __BASE) or spritesheet (numeric frames): pack the
          // whole source once, keyed by texture key, so indices survive.
          const base = tex.get("__BASE");
          if (taken.has(texKey)) continue;
          taken.set(texKey, texKey);
          entries.push({
            name: texKey,
            w: base.cutWidth,
            h: base.cutHeight,
            source,
            frameData: { cutX: base.cutX, cutY: base.cutY },
          });
          if (numeric) {
            const fc = this.sheetConfigs.get(texKey) ?? this.inferSheetConfig(tex);
            if (fc) meta.sheets[texKey] = fc;
          } else {
            meta.images.push(texKey);
          }
          continue;
        }

        // Atlas texture: pack each used frame under its own name.
        const used = [...frames].filter((f) => f !== "__BASE");
        const included: string[] = [];
        for (const frameName of used) {
          if (!tex.has(frameName)) continue;
          const f = tex.get(frameName);
          const claimedBy = taken.get(frameName);
          const outName = claimedBy && claimedBy !== texKey ? `${texKey}__${frameName}` : frameName;
          if (!taken.has(outName)) {
            taken.set(outName, texKey);
            entries.push({
              name: outName,
              w: f.cutWidth,
              h: f.cutHeight,
              source: f.source?.image ?? source,
              frameData: { cutX: f.cutX, cutY: f.cutY },
            });
          }
          included.push(outName);
        }
        if (included.length > 0) meta.atlases[texKey] = included;
      }
    } finally {
      this.suppressTracking--;
    }

    if (entries.length === 0) {
      throw new Error("[spriteX] none of the used textures are still loaded — nothing to pack");
    }

    const { placements, width, height } = packShelf(entries, this.config.maxAtlasWidth, this.config.padding);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    const framesJson: Record<string, any> = {};
    for (const p of placements as (Placement & Entry)[]) {
      ctx.drawImage(p.source, p.frameData.cutX, p.frameData.cutY, p.w, p.h, p.x, p.y, p.w, p.h);
      framesJson[p.name] = {
        frame: { x: p.x, y: p.y, w: p.w, h: p.h },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: p.w, h: p.h },
        sourceSize: { w: p.w, h: p.h },
      };
    }

    const json = {
      frames: framesJson,
      meta: {
        app: "spriteX SpriteXPlugin",
        version: SpriteXPlugin.VERSION,
        image: `${name}.png`,
        format: "RGBA8888",
        size: { w: width, h: height },
        scale: "1",
        spritex: { gameName: this.config.gameName ?? null, ...meta },
      },
    };

    const dataURL = canvas.toDataURL("image/png");
    const result: OptimizedAtlasResult = {
      name,
      json,
      dataURL,
      frameCount: entries.length,
      size: { w: width, h: height },
    };

    if (opts?.save) await this.saveOptimizedAtlas(result);
    if (opts?.download) this.downloadOptimizedAtlas(result);
    return result;
  }

  private inferSheetConfig(tex: any): SpriteXFrameConfig | null {
    const f0 = tex.has(0) ? tex.get(0) : tex.has("0") ? tex.get("0") : null;
    if (!f0) return null;
    return { frameWidth: f0.cutWidth, frameHeight: f0.cutHeight };
  }

  /** Write an optimized atlas to RTDB (game scope when gameName is set). */
  async saveOptimizedAtlas(atlas: OptimizedAtlasResult): Promise<string> {
    const path = this.config.gameName
      ? `games/${this.config.gameName}/atlases/${atlas.name}`
      : `atlases/${atlas.name}`;
    const res = await fetch(`${this.config.databaseURL}/${path}.json`, {
      method: "PUT",
      body: JSON.stringify({ json: encodeAtlasJsonKeys(atlas.json), png: atlas.dataURL }),
    });
    if (!res.ok) throw new Error(`[spriteX] optimized atlas save failed (${res.status})`);
    this.log(`optimized atlas saved to ${path}`);
    return path;
  }

  downloadOptimizedAtlas(atlas: OptimizedAtlasResult): void {
    const save = (href: string, filename: string) => {
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      a.click();
    };
    save(atlas.dataURL, `${atlas.name}.png`);
    const jsonBlob = new Blob([JSON.stringify(atlas.json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(jsonBlob);
    save(url, `${atlas.name}.json`);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

export { SpriteXPlugin };
