import { decompress as fzstdDecompress } from "fzstd";
import { MAGIC } from "./constants.ts";
import type { DatasetEntry, DatasetHeader } from "./types.ts";

/** Raw pixels plus the metadata needed to interpret them. */
export interface RawGlyph {
  width: number;
  height: number;
  /** 1 = grayscale, 3 = RGB. */
  channels: 1 | 3;
  /** Raw, row-major pixel bytes of length width * height * channels. */
  pixels: Uint8Array;
}

/**
 * Broad script category of a glyph, derived from its filename prefix. Ordered
 * oldest → newest, which is also the chronological order used to lay out a
 * character's evolution.
 */
export type Script = "oracle-bone" | "bronze" | "seal" | "clerical" | "regular" | "other";

/** Chronological rank of each {@link Script}, oldest first. */
const SCRIPT_ORDER: Record<Script, number> = {
  "oracle-bone": 0,
  bronze: 1,
  seal: 2,
  clerical: 3,
  regular: 4,
  other: 5,
};

/**
 * One glyph for a character, with its script classified and a chronological
 * sort rank. `key` is the dataset key to pass to {@link DatasetReader.getRaw}.
 */
export interface CharacterGlyph {
  key: string;
  script: Script;
  /** Chronological rank (oldest = 0); ties broken by key for stability. */
  order: number;
}

/**
 * Classify a glyph key (or bare filename) into a {@link Script} from its prefix.
 * The dataset encodes the script in the filename: `O_*` = oracle-bone, `J_` =
 * bronze (金文), `Z_` = seal/Shuowen small-seal (說文/篆), `L_` = clerical (隸),
 * `K_` = modern regular (楷体). Anything else falls back to "other".
 */
export function parseScript(keyOrFilename: string): Script {
  const slash = keyOrFilename.lastIndexOf("/");
  const filename = slash === -1 ? keyOrFilename : keyOrFilename.slice(slash + 1);
  if (filename.startsWith("O_")) return "oracle-bone";
  if (filename.startsWith("J_")) return "bronze";
  if (filename.startsWith("Z_")) return "seal";
  if (filename.startsWith("L_")) return "clerical";
  if (filename.startsWith("K_")) return "regular";
  return "other";
}

/**
 * Decompress one zstd block. The reader is deliberately agnostic about *how*
 * decompression happens so it can run anywhere a `Uint8Array` is available
 * (Node, the browser, React Native) — the host supplies the implementation.
 * On Node, {@link import("./+node.ts").nodeDecompress} wires up `node:zlib`.
 *
 * @param compressed The compressed block bytes.
 * @param windowLog  The zstd window log the block was compressed with; needed
 *   by some decoders to size their window. May be ignored if unused.
 */
export type Decompress = (compressed: Uint8Array, windowLog: number) => Uint8Array;

/**
 * Default block decompressor: the pure-JS/WASM-free {@link fzstdDecompress}.
 * Works in any JS runtime (browser, React Native, Node) with no native module,
 * which is what lets {@link DatasetReader} run out of the box everywhere. It is
 * slower than a native zstd binding — supply your own {@link Decompress} (e.g.
 * `nodeDecompress` from the `/node` entry) when raw speed matters.
 *
 * `fzstd` ignores the window log (its second argument is an output buffer, not a
 * window), so we deliberately call it with one argument.
 */
export const defaultDecompress: Decompress = (compressed) => fzstdDecompress(compressed);

export interface DatasetReaderOptions {
  /**
   * Max number of decompressed blocks to keep cached in memory. Reading many
   * glyphs that live in the same block then costs a single decompress. Set to 0
   * to disable caching. Default 8.
   */
  blockCacheSize?: number;
  /**
   * Block decompressor to use. Defaults to {@link defaultDecompress} (bundled
   * `fzstd`), so the reader works in any runtime without wiring. Override with a
   * faster native zstd binding when needed. A positional `decompress` argument
   * to the constructor takes precedence over this.
   */
  decompress?: Decompress;
}

const textDecoder = new TextDecoder();

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Rebuild the row-shaped {@link DatasetEntry} index from the columnar header.
 * The header omits each record's block, within-block offset, and byte length
 * because they are derivable: records fill blocks of `blockSize` in stored
 * order, a record's length is `width * height * channels`, and its offset is the
 * running sum of lengths since the start of its block.
 */
function reconstructEntries(header: DatasetHeader): DatasetEntry[] {
  const { widths, heights, channels, blockSize } = header;
  const keys = header.keys.length > 0 ? header.keys.split("\n") : [];
  const entries: DatasetEntry[] = Array.from({ length: keys.length });
  let blockOffset = 0;
  for (let i = 0; i < keys.length; i++) {
    const within = i % blockSize;
    if (within === 0) blockOffset = 0; // new block starts fresh.
    const width = widths[i]!;
    const height = heights[i]!;
    const ch = channels[i]!;
    const length = width * height * ch;
    entries[i] = {
      key: keys[i]!,
      width,
      height,
      channels: ch,
      block: Math.floor(i / blockSize),
      offset: blockOffset,
      length,
    };
    blockOffset += length;
  }
  return entries;
}

/**
 * Random-access reader over a single-file character dataset produced by the
 * packer. The whole dataset is held as one in-memory `Uint8Array`; image pixels
 * are sliced out one decompressed block at a time, so extraction is cheap and
 * the reader has **no I/O dependency** — the caller is responsible for getting
 * the bytes into memory (read a file on Node, `fetch()` in a browser, bundle an
 * asset in React Native) and for supplying a zstd {@link Decompress}.
 */
export class DatasetReader {
  #bytes: Uint8Array;
  #decompress: Decompress;
  #header: DatasetHeader;
  #bodyOffset: number;
  #entries: DatasetEntry[];
  #entryByKey: Map<string, DatasetEntry>;
  #cache = new Map<number, Uint8Array>();
  #cacheLimit: number;
  /** Lazily built character → keys index (see {@link #ensureCharacterIndex}). */
  #keysByCharacter: Map<string, string[]> | null = null;

  /**
   * Build a reader over an in-memory dataset.
   *
   * @param bytes      The entire dataset file as a `Uint8Array`.
   * @param decompress Optional block decompressor (see {@link Decompress}).
   *   Defaults to the bundled `fzstd` ({@link defaultDecompress}); pass a faster
   *   native zstd binding to override. May also be set via `options.decompress`.
   * @param options    Reader tuning (block cache size, decompressor).
   */
  constructor(bytes: Uint8Array, decompress?: Decompress, options: DatasetReaderOptions = {}) {
    this.#bytes = bytes;
    // Precedence: positional arg, then options.decompress, then the default.
    this.#decompress = decompress ?? options.decompress ?? defaultDecompress;
    this.#cacheLimit = options.blockCacheSize ?? 8;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < MAGIC.length + 4 || !bytesEqual(bytes.subarray(0, MAGIC.length), MAGIC)) {
      throw new Error("Not a character-evolution dataset file (bad magic)");
    }
    const headerLength = view.getUint32(MAGIC.length, true);
    const headerStart = MAGIC.length + 4;
    // The header is zstd-compressed (windowLog 0 is fine — it is small and was
    // written with the default window). Decompress, then parse.
    const headerBytes = this.#decompress(
      bytes.subarray(headerStart, headerStart + headerLength),
      0,
    );
    this.#header = JSON.parse(textDecoder.decode(headerBytes)) as DatasetHeader;
    this.#bodyOffset = headerStart + headerLength;
    this.#entries = reconstructEntries(this.#header);
    this.#entryByKey = new Map(this.#entries.map((e) => [e.key, e]));
  }

  /** All keys in the dataset, in stored order. */
  keys(): string[] {
    return this.#entries.map((e) => e.key);
  }

  /**
   * The lossy transforms (if any) that were applied when this dataset was
   * packed. All fields absent/false means the stored pixels are bit-exact with
   * the original images — i.e. the file is a lossless source. Used by the packer
   * to refuse re-packing from a lossy input (which would compound loss).
   */
  get provenance(): {
    quantizeLevels?: number;
    maxSide?: number;
    blackWhite?: boolean;
  } {
    return {
      quantizeLevels: this.#header.quantizeLevels,
      maxSide: this.#header.maxSide,
      blackWhite: this.#header.blackWhite,
    };
  }

  /** Number of images in the dataset. */
  get size(): number {
    return this.#entries.length;
  }

  /** Whether a key exists. */
  has(key: string): boolean {
    return this.#entryByKey.has(key);
  }

  /** Metadata for a key, or undefined if absent. */
  entry(key: string): DatasetEntry | undefined {
    return this.#entryByKey.get(key);
  }

  /**
   * The modern character for a glyph, e.g. `"㐁"` — or `undefined` if unknown.
   * Accepts either a full key (`"00011/K_楷体"`) or a bare character ID
   * (`"00011"`); the ID is the folder-name prefix of a key. Labels come from the
   * dataset's `Key&Value.json` and may be **partially** present.
   */
  character(keyOrId: string): string | undefined {
    const map = this.#header.characters;
    if (!map) return undefined;
    const slash = keyOrId.indexOf("/");
    const id = slash === -1 ? keyOrId : keyOrId.slice(0, slash);
    return map[id];
  }

  /**
   * The full ID → character map (e.g. `{ "00011": "㐁" }`), or `undefined` if the
   * dataset carries no labels. Coverage may be partial.
   */
  characters(): Record<string, string> | undefined {
    return this.#header.characters;
  }

  /**
   * Build (once) and return the character → keys index. Requires an embedded
   * character map; without one there is no way to relate a character to its
   * folders, so the index is empty. Keys are grouped by the character of their
   * folder id and kept in stored order.
   */
  #ensureCharacterIndex(): Map<string, string[]> {
    if (this.#keysByCharacter) return this.#keysByCharacter;
    const index = new Map<string, string[]>();
    const characters = this.#header.characters;
    if (characters) {
      for (const entry of this.#entries) {
        const slash = entry.key.indexOf("/");
        const id = slash === -1 ? entry.key : entry.key.slice(0, slash);
        const char = characters[id];
        if (char === undefined) continue;
        let keys = index.get(char);
        if (!keys) {
          keys = [];
          index.set(char, keys);
        }
        keys.push(entry.key);
      }
    }
    this.#keysByCharacter = index;
    return index;
  }

  /**
   * All glyph keys for a character (e.g. `"㐁"`), in stored order. Empty when the
   * character is unknown or the dataset carries no character map. Pass a key to
   * {@link getRaw} to extract a glyph's pixels.
   */
  keysForCharacter(character: string): string[] {
    return this.#ensureCharacterIndex().get(character)?.slice() ?? [];
  }

  /**
   * The glyphs for a character with each key classified into a {@link Script}
   * and assigned a chronological rank, sorted oldest → newest (ties broken by
   * key). This is the shape a consumer renders as an evolution row. Empty when
   * the character is unknown or unlabeled.
   */
  glyphsForCharacter(character: string): CharacterGlyph[] {
    const keys = this.#ensureCharacterIndex().get(character);
    if (!keys) return [];
    return keys
      .map((key): CharacterGlyph => {
        const script = parseScript(key);
        return { key, script, order: SCRIPT_ORDER[script] };
      })
      .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Decompress (and cache) the block at the given index. */
  #readBlock(blockIndex: number): Uint8Array {
    const cached = this.#cache.get(blockIndex);
    if (cached) {
      // Refresh LRU position.
      this.#cache.delete(blockIndex);
      this.#cache.set(blockIndex, cached);
      return cached;
    }

    const ref = this.#header.blocks[blockIndex];
    if (!ref) throw new Error(`Block ${blockIndex} out of range`);

    const start = this.#bodyOffset + ref.fileOffset;
    const compressed = this.#bytes.subarray(start, start + ref.compressedLength);
    const raw = this.#decompress(compressed, this.#header.windowLog);

    if (this.#cacheLimit > 0) {
      this.#cache.set(blockIndex, raw);
      while (this.#cache.size > this.#cacheLimit) {
        const oldest = this.#cache.keys().next().value as number;
        this.#cache.delete(oldest);
      }
    }
    return raw;
  }

  /**
   * Extract the raw pixels for a key. This decompresses one block (cached) and
   * slices out the record — no image re-encoding.
   */
  getRaw(key: string): RawGlyph {
    const entry = this.#entryByKey.get(key);
    if (!entry) throw new Error(`Key not found: ${key}`);
    const block = this.#readBlock(entry.block);
    const view = block.subarray(entry.offset, entry.offset + entry.length);
    return {
      width: entry.width,
      height: entry.height,
      channels: entry.channels,
      // Copy so callers can't mutate the cached block.
      pixels: view.slice(),
    };
  }

  /** Drop all cached decompressed blocks. */
  clearCache(): void {
    this.#cache.clear();
  }
}
