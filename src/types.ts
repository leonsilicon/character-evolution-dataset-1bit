/**
 * Type definitions for the dataset's self-describing header. See
 * `./constants.ts` for the on-disk file layout these types describe.
 *
 * The on-disk header ({@link DatasetHeader}) is *columnar and compressed*: it
 * stores only the irreducible facts (keys, dimensions, channel count, block
 * sizes) and lets the reader reconstruct the rest. {@link DatasetEntry} is the
 * row-shaped view the reader rebuilds and exposes to callers — it is not what
 * sits on disk.
 */

/**
 * Per-image metadata as exposed by the reader. Reconstructed at load time from
 * the columnar header; `block`, `offset`, and `length` are all derived (see
 * {@link DatasetHeader}), not stored.
 */
export interface DatasetEntry {
  /** Logical key, e.g. "15970/K_楷体". Stable, used for lookups. */
  key: string;
  /** Pixel width of the stored image. */
  width: number;
  /** Pixel height of the stored image. */
  height: number;
  /** 1 = grayscale, 3 = RGB. Grayscale-equivalent images are stored as 1ch. */
  channels: 1 | 3;
  /** Index of the block this record lives in. */
  block: number;
  /** Byte offset of the raw pixels within the *decompressed* block. */
  offset: number;
  /** Length in bytes of the raw pixels (width * height * channels). */
  length: number;
}

/** Location of one compressed block within the file. */
export interface BlockRef {
  /** Body-relative byte offset of the compressed block. */
  fileOffset: number;
  /** Compressed byte length of the block. */
  compressedLength: number;
  /** Decompressed byte length of the block. */
  rawLength: number;
}

/**
 * The columnar, zstd-compressed header at the start of the file.
 *
 * Stored columnar so each field compresses against its own kind (run-like keys
 * together, small integers together). Fields that are fully derivable are
 * omitted to keep the index tiny:
 *   - a record's `block` and within-block `offset` follow from the stored order
 *     plus the per-record byte lengths;
 *   - a record's byte `length` is exactly `width * height * channels`.
 * The reader rebuilds {@link DatasetEntry} rows from these columns on load.
 */
export interface DatasetHeader {
  version: 2;
  /** zstd window log the blocks were compressed with. */
  windowLog: number;
  /** Records per block (the last block may hold fewer). */
  blockSize: number;
  /**
   * If present, pixel values were quantized to this many levels at pack time
   * (lossy). Purely informational for the reader — values are stored as 8-bit
   * either way. Absent means the gray levels are bit-exact with the source.
   */
  quantizeLevels?: number;
  /**
   * If present, glyphs were downscaled at pack time so their longest side is at
   * most this many pixels (lossy). Informational only. Absent means full
   * resolution.
   */
  maxSide?: number;
  /**
   * True if pixels were reduced to pure black & white (1-bit) at pack time
   * (lossy). Informational only. Implies `quantizeLevels: 2`.
   */
  blackWhite?: boolean;
  /**
   * Optional map from character ID (the folder-name prefix of a key, e.g.
   * `"00011"`) to its modern character (e.g. `"㐁"`). Coverage may be partial —
   * only IDs present here have a known character. Sourced from the dataset's
   * `Key&Value.json` at pack time.
   */
  characters?: Record<string, string>;
  /** Per-block location/size table. */
  blocks: BlockRef[];
  /** All keys, newline-joined, in stored order. */
  keys: string;
  /** Per-record pixel widths, in stored order. */
  widths: number[];
  /** Per-record pixel heights, in stored order. */
  heights: number[];
  /** Per-record channel count (1 or 3), in stored order. */
  channels: Array<1 | 3>;
}
