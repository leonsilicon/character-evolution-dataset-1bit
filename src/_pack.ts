import { constants as zc, zstdCompressSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { createWriteStream, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_LEVEL,
  DEFAULT_MAX_SIDE,
  MAGIC,
  WINDOW_LOG,
} from "./constants.ts";
import { DatasetReader } from "./dataset.ts";
import type { BlockRef, DatasetHeader } from "./types.ts";

export interface PackOptions {
  /**
   * Root directory containing per-character subfolders of PNG/JPG images.
   * Mutually exclusive with {@link sourceBin}; exactly one must be set.
   */
  sourceDir?: string;
  /**
   * Path to a previously-packed *lossless* dataset (`source.bin`) to re-pack
   * from, instead of walking an image tree. This is the repo's committed source
   * of truth: it holds every glyph's full-resolution, bit-exact pixels, so a
   * build can regenerate `dataset.bin` with any lossy params (quantize, maxSide,
   * blackWhite) without needing the original 783 MB image tree on disk. The
   * input must itself be lossless (no quantize/maxSide/blackWhite) or the output
   * would compound losses. Mutually exclusive with {@link sourceDir}.
   */
  sourceBin?: string;
  /** Destination single-file dataset path. */
  outFile: string;
  /** Records per independently-compressed block. */
  blockSize?: number;
  /** zstd compression level. */
  level?: number;
  /**
   * Number of images to decode concurrently. sharp decodes are async and
   * release the event loop, so a pool well above the core count keeps all
   * cores busy. Defaults to (CPU count * 2).
   */
  concurrency?: number;
  /**
   * If set, quantize pixel values to this many evenly-spaced levels before
   * storing (e.g. 16 = "4-bit gray"). This is **lossy** but, for these
   * anti-aliased black-on-white glyphs, visually indistinguishable at display
   * sizes while roughly halving the compressed size. Values are still stored as
   * 8-bit, so the reader and PNG output are unchanged. Omit (or 256) to keep
   * the data bit-exact. Applied to color channels too.
   */
  quantizeLevels?: number;
  /**
   * If set (> 0), downscale each glyph so its longest side is at most this many
   * pixels before storing. Glyphs already within the cap are left untouched.
   * Compressed size tracks pixel count almost linearly, so this is the cheapest
   * size lever — but it is **lossy** (lower native resolution). Defaults to
   * {@link DEFAULT_MAX_SIDE}; pass 0 to keep full resolution.
   */
  maxSide?: number;
  /**
   * If true, reduce pixels to pure black & white (1-bit) by thresholding at mid
   * gray. Much smaller than gray, but **lossy**: anti-aliased edges become
   * hard-aliased. Equivalent to (and recorded as) `quantizeLevels: 2`, but also
   * sets the `blackWhite` provenance flag in the header.
   */
  blackWhite?: boolean;
  /**
   * Optional map from character ID (a key's folder-name prefix, e.g. `"00011"`)
   * to its modern character (e.g. `"㐁"`), stored verbatim in the header so the
   * reader can label glyphs. Typically the parsed `Key&Value.json`. Coverage may
   * be partial; unknown IDs are simply absent.
   */
  characters?: Record<string, string>;
  /** Optional progress callback, called once per processed image. */
  onProgress?: (done: number, total: number) => void;
}

export interface PackStats {
  imageCount: number;
  blockCount: number;
  grayscaleCount: number;
  rgbCount: number;
  /** Number of distinct character IDs that got a label from the character map. */
  labeledCount: number;
  /** Total size of the source images on disk, in bytes. */
  sourceBytes: number;
  /** Size of the produced dataset file, in bytes. */
  outputBytes: number;
}

interface RawImage {
  key: string;
  width: number;
  height: number;
  channels: 1 | 3;
  pixels: Buffer;
}

const IMAGE_RE = /\.(png|jpe?g)$/i;

/** Recursively collect image files as { key, absPath } pairs. */
async function collectImages(
  root: string,
): Promise<Array<{ key: string; absPath: string; size: number }>> {
  const out: Array<{ key: string; absPath: string; size: number }> = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      // Resolve symlinks so a tree of linked directories is still traversed.
      const s = ent.isSymbolicLink() ? await stat(abs) : undefined;
      const isDir = ent.isDirectory() || (s?.isDirectory() ?? false);
      const isFile = ent.isFile() || (s?.isFile() ?? false);
      if (isDir) {
        await walk(abs, rel);
      } else if (isFile && IMAGE_RE.test(ent.name)) {
        const st = s ?? (await stat(abs));
        // Drop the file extension from the key; it is recoverable as PNG.
        out.push({ key: rel.replace(IMAGE_RE, ""), absPath: abs, size: st.size });
      }
    }
  }

  await walk(root, "");
  return out;
}

/**
 * Decode one image to raw pixels, collapsing it to single-channel grayscale
 * when doing so is lossless (i.e. R === G === B for every pixel). Roughly 99%
 * of the dataset is achromatic, so this is where most of the size win comes
 * from while staying bit-exact.
 */
async function decodeRaw(absPath: string, key: string, maxSide: number): Promise<RawImage> {
  // Downscale at decode time, before reading raw pixels, so the resize runs on
  // the encoded image (cheaper) and everything downstream sees the smaller
  // dimensions. `withoutEnlargement` keeps already-small glyphs untouched.
  let pipeline = sharp(absPath);
  if (maxSide > 0) {
    pipeline = pipeline.resize(maxSide, maxSide, {
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const channels = info.channels;

  // Already single channel.
  if (channels === 1) {
    return { key, width, height, channels: 1, pixels: data };
  }

  // Detect grayscale-equivalence and, if so, keep only the first channel.
  if (channels === 3 || channels === 4) {
    let isGray = true;
    for (let i = 0; i < data.length; i += channels) {
      if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) {
        isGray = false;
        break;
      }
    }
    if (isGray) {
      const gray = Buffer.allocUnsafe(width * height);
      for (let p = 0, i = 0; i < data.length; i += channels, p++) {
        gray[p] = data[i]!;
      }
      return { key, width, height, channels: 1, pixels: gray };
    }
    // Genuine color: store RGB, dropping any alpha (the dataset has none).
    if (channels === 4) {
      const rgb = Buffer.allocUnsafe(width * height * 3);
      for (let p = 0, i = 0; i < data.length; i += 4, p += 3) {
        rgb[p] = data[i]!;
        rgb[p + 1] = data[i + 1]!;
        rgb[p + 2] = data[i + 2]!;
      }
      return { key, width, height, channels: 3, pixels: rgb };
    }
    return { key, width, height, channels: 3, pixels: data };
  }

  throw new Error(`Unsupported channel count ${channels} for ${absPath}`);
}

/**
 * Produce a {@link RawImage} from a lossless `source.bin` reader. The stored
 * pixels are already decoded and grayscale-collapsed, so there is no image to
 * decode — we just slice them out. When `maxSide` is smaller than the glyph, we
 * downscale the raw pixels through sharp (`withoutEnlargement` leaves smaller
 * glyphs alone).
 *
 * Note: resizing here runs on the source's *full-resolution* pixels, exactly as
 * a from-tree build resizes the original image, so a lossy re-pack from a
 * full-res lossless source.bin produces the same result as packing from the
 * image tree. (Re-packing from an already-downscaled source would differ — hence
 * the lossless-source guard in `pack`.)
 */
async function decodeFromReader(
  reader: DatasetReader,
  key: string,
  maxSide: number,
): Promise<RawImage> {
  const g = reader.getRaw(key);
  const channels = g.channels;
  if (maxSide <= 0 || (g.width <= maxSide && g.height <= maxSide)) {
    return {
      key,
      width: g.width,
      height: g.height,
      channels,
      pixels: Buffer.from(g.pixels),
    };
  }
  let pipeline = sharp(Buffer.from(g.pixels), {
    raw: { width: g.width, height: g.height, channels },
  })
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" });
  if (channels === 1) {
    pipeline = pipeline.greyscale();
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 && info.channels !== 3) {
    throw new Error(`Unsupported resized channel count ${info.channels} for ${key}`);
  }
  return { key, width: info.width, height: info.height, channels: info.channels, pixels: data };
}

/**
 * Quantize an 8-bit pixel buffer in place to `levels` evenly-spaced values
 * (e.g. 16 -> 4-bit). Lossy, but the snapped values are still valid 8-bit, so
 * nothing downstream needs to know. A 256-entry lookup table keeps it cheap.
 */
function quantizeInPlace(pixels: Buffer, levels: number): void {
  const step = 255 / (levels - 1);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(Math.round(v / step) * step);
  for (let i = 0; i < pixels.length; i++) pixels[i] = lut[pixels[i]!]!;
}

function compressBlock(raw: Buffer, level: number): Buffer {
  return zstdCompressSync(raw, {
    params: {
      [zc.ZSTD_c_compressionLevel]: level,
      [zc.ZSTD_c_windowLog]: WINDOW_LOG,
      [zc.ZSTD_c_enableLongDistanceMatching]: 1,
    },
  });
}

/**
 * Compress the header with zstd's *default* window so the reader can decompress
 * it without raising `ZSTD_d_windowLogMax`. Unlike the pixel blocks (which force
 * a large long-distance-matching window), the header is small enough that the
 * default window already captures all its redundancy.
 */
function compressHeader(raw: Buffer, level: number): Buffer {
  return zstdCompressSync(raw, { params: { [zc.ZSTD_c_compressionLevel]: level } });
}

/**
 * Map `mapper` over `items` with bounded concurrency, yielding results in the
 * original input order. Keeps up to `concurrency` tasks in flight so all cores
 * stay busy, while the consumer still sees a deterministic sequence — essential
 * here because output ordering drives block assignment and compression layout.
 */
async function* mapOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  // Ring of in-flight promises; we always await the head (oldest) to preserve
  // input order, and top the ring back up to `limit` after each yield.
  const inflight: Array<Promise<R>> = [];
  let next = 0;
  for (; next < limit; next++) inflight.push(mapper(items[next]!));
  while (inflight.length > 0) {
    const result = await inflight.shift()!;
    if (next < items.length) inflight.push(mapper(items[next++]!));
    yield result;
  }
}

/**
 * Build the single-file dataset.
 *
 * Images are sorted by key so that the same character's variants and the same
 * script types end up adjacent in the stream — this groups visually similar
 * glyphs together and gives the compressor long, cheap cross-glyph matches.
 */
export async function pack(options: PackOptions): Promise<PackStats> {
  const {
    sourceDir,
    sourceBin,
    outFile,
    blockSize = DEFAULT_BLOCK_SIZE,
    level = DEFAULT_LEVEL,
    concurrency = availableParallelism() * 2,
    quantizeLevels,
    maxSide = DEFAULT_MAX_SIDE,
    blackWhite = false,
    characters,
    onProgress,
  } = options;

  // Black & white is just 2-level quantization with a provenance flag.
  const requestedLevels = blackWhite ? 2 : quantizeLevels;
  const quantize =
    requestedLevels && requestedLevels >= 2 && requestedLevels < 256 ? requestedLevels : undefined;
  const cap = maxSide && maxSide > 0 ? maxSide : 0;

  if ((sourceDir == null) === (sourceBin == null)) {
    throw new Error("pack() requires exactly one of sourceDir or sourceBin");
  }

  // A reader is held open for the whole pack when re-packing from source.bin, so
  // its memory-mapped bytes back the per-glyph reads below.
  const reader = sourceBin ? new DatasetReader(new Uint8Array(readFileSync(sourceBin))) : undefined;
  if (reader) {
    const p = reader.provenance;
    if (p.quantizeLevels || p.maxSide || p.blackWhite) {
      throw new Error(
        `source.bin at ${sourceBin} is not lossless ` +
          `(quantizeLevels=${p.quantizeLevels ?? "-"}, maxSide=${p.maxSide ?? "-"}, ` +
          `blackWhite=${p.blackWhite ?? false}); re-packing from it would compound loss`,
      );
    }
  }

  // Unify both inputs into a sorted list of { key, size, absPath? }. `size` is the
  // source's raw byte cost, used only for the reported compression ratio; `absPath`
  // is present only for the image-tree input (the reader input has no files).
  const files: Array<{ key: string; size: number; absPath?: string }> = reader
    ? reader.keys().map((key) => {
        const e = reader.entry(key)!;
        return { key, size: e.length };
      })
    : await collectImages(sourceDir!);
  // Sort so identical characters / script prefixes are contiguous.
  files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const sourceBytes = files.reduce((sum, f) => sum + f.size, 0);
  const total = files.length;

  // Columnar header accumulators: one parallel entry per record, in stored
  // order. Block membership and within-block offsets are *not* stored — they are
  // reconstructed by the reader from order + per-record byte lengths.
  const keys: string[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  const channelsCol: Array<1 | 3> = [];
  const blocks: BlockRef[] = [];
  let grayscaleCount = 0;
  let rgbCount = 0;

  // Compressed blocks are buffered (they are small relative to the raw images)
  // and written after the header at the end. Block offsets are body-relative,
  // so the header needs no second pass once block sizes are known.
  const compressedBlocks: Buffer[] = [];
  let fileCursor = 0; // running body-relative byte offset of the next block.

  let blockRecords: RawImage[] = [];
  let processed = 0;

  const flushBlock = (): void => {
    if (blockRecords.length === 0) return;
    const rawLength = blockRecords.reduce((s, r) => s + r.pixels.length, 0);
    const raw = Buffer.allocUnsafe(rawLength);
    let off = 0;
    for (const rec of blockRecords) {
      keys.push(rec.key);
      widths.push(rec.width);
      heights.push(rec.height);
      channelsCol.push(rec.channels);
      rec.pixels.copy(raw, off);
      off += rec.pixels.length;
    }
    const compressed = compressBlock(raw, level);
    compressedBlocks.push(compressed);
    blocks.push({
      // Body-relative offset. The reader adds the (known) prefix length, so the
      // header never has to be re-serialized to absolute positions.
      fileOffset: fileCursor,
      compressedLength: compressed.length,
      rawLength,
    });
    fileCursor += compressed.length;
    blockRecords = [];
  };

  // Decode in parallel but consume strictly in sorted input order, so block
  // membership and the on-disk layout are identical to a serial run. From a
  // source.bin the pixels are already decoded, so we read them from the reader
  // (and only re-resize when a smaller cap than the source is requested);
  // otherwise we decode the image file from disk.
  const decoded = reader
    ? mapOrdered(files, concurrency, (file) => decodeFromReader(reader, file.key, cap))
    : mapOrdered(files, concurrency, (file) => decodeRaw(file.absPath!, file.key, cap));
  for await (const img of decoded) {
    if (img.channels === 1) grayscaleCount++;
    else rgbCount++;
    if (quantize) quantizeInPlace(img.pixels, quantize);
    blockRecords.push(img);
    if (blockRecords.length >= blockSize) flushBlock();
    processed++;
    onProgress?.(processed, total);
  }
  flushBlock();

  // Keep only character labels whose ID (a key's folder prefix) actually appears
  // in this dataset, so a partial/stale source map doesn't carry dead entries.
  let characterMap: Record<string, string> | undefined;
  if (characters) {
    const presentIds = new Set<string>();
    for (const k of keys) {
      const slash = k.indexOf("/");
      presentIds.add(slash === -1 ? k : k.slice(0, slash));
    }
    const filtered: Record<string, string> = {};
    for (const id of presentIds) {
      const ch = characters[id];
      if (ch !== undefined) filtered[id] = ch;
    }
    if (Object.keys(filtered).length > 0) characterMap = filtered;
  }

  // Columnar header: keys joined, dimensions/channels as parallel arrays, with
  // all derivable fields omitted. Block offsets are *body-relative*; the reader
  // adds the prefix length. The whole header is then zstd-compressed — at ~263k
  // records this turns ~30 MB of JSON into ~1.3 MB with no loss.
  const header: DatasetHeader = {
    version: 2,
    windowLog: WINDOW_LOG,
    blockSize,
    ...(quantize ? { quantizeLevels: quantize } : {}),
    ...(cap ? { maxSide: cap } : {}),
    ...(blackWhite ? { blackWhite: true } : {}),
    ...(characterMap ? { characters: characterMap } : {}),
    blocks,
    keys: keys.join("\n"),
    widths,
    heights,
    channels: channelsCol,
  };
  const headerBytes = compressHeader(Buffer.from(JSON.stringify(header), "utf8"), level);

  const lengthBuf = Buffer.allocUnsafe(4);
  lengthBuf.writeUInt32LE(headerBytes.length, 0);

  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(outFile);
    ws.on("error", reject);
    ws.on("finish", resolve);
    ws.write(MAGIC);
    ws.write(lengthBuf);
    ws.write(headerBytes);
    for (const block of compressedBlocks) ws.write(block);
    ws.end();
  });

  const outStat = await stat(outFile);

  return {
    imageCount: total,
    blockCount: blocks.length,
    grayscaleCount,
    rgbCount,
    labeledCount: characterMap ? Object.keys(characterMap).length : 0,
    sourceBytes,
    outputBytes: outStat.size,
  };
}
