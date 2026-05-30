/**
 * Binary container format for the character-evolution image dataset.
 *
 * The dataset ships as a *single* file (`dataset.bin`) that holds every glyph
 * image plus a self-describing index, so a consumer downloads one artifact and
 * can pull out any individual image at runtime without unpacking the rest.
 *
 * Why this layout instead of N PNG files or a 2D sprite atlas:
 *   - The glyphs are tiny (mostly < 150px) and hugely redundant across each
 *     other (vast white margins, repeated stroke shapes, the same modern fonts
 *     rendered for thousands of characters). Storing them as separate PNGs hides
 *     that redundancy from the compressor and wastes ~36% to filesystem block
 *     padding.
 *   - Concatenating the *raw* pixels of similar glyphs back-to-back and running
 *     a long-window zstd pass over the stream lets the compressor reference
 *     matches across many glyphs, which is where the real win comes from
 *     (measured ~38% of the original PNG size, fully lossless).
 *   - Records are grouped into independently-compressed *blocks*. A reader only
 *     decompresses the one block containing the wanted glyph, so random access
 *     stays cheap even though the whole dataset is one file.
 *
 * File layout:
 *
 *   [ MAGIC (8 bytes) ][ headerLength (u32 LE) ][ header (zstd-compressed) ]
 *   [ block 0 (zstd) ][ block 1 (zstd) ] ... [ block N-1 (zstd) ]
 *
 * The header is a *zstd-compressed* columnar index (see `./types.ts`). It is
 * stored columnar — keys in one string, widths/heights/channels in parallel
 * typed arrays — and omits anything derivable (a record's block, its offset
 * within that block, and its byte length all fall out of the stored order plus
 * `width * height * channels`). For ~263k records this shrinks the index from
 * ~30 MB of JSON to ~1.3 MB with no loss. Everything needed to extract an image
 * is in the header — the blocks are opaque zstd frames.
 */

/**
 * File signature. A plain `Uint8Array` (not a Node `Buffer`) so this module —
 * and the reader that consumes it — stays free of any Node-only dependency and
 * can run in the browser or React Native.
 */
export const MAGIC = new Uint8Array([0x43, 0x45, 0x44, 0x53, 0x30, 0x30, 0x30, 0x32]); // "CEDS0002"

/** zstd window log used for both compression and decompression. */
export const WINDOW_LOG = 27;

/** Default compression level for packing. */
export const DEFAULT_LEVEL = 19;

/**
 * Number of image records grouped into one independently-compressed block.
 * Larger blocks compress better (more cross-glyph matches) but make each random
 * read decompress more data. 256 is a good balance for ~5KB raw records.
 */
export const DEFAULT_BLOCK_SIZE = 256;

/**
 * Default cap on a glyph's longest side, in pixels. Source glyphs run up to
 * ~463px, but the app renders them small (≤64px), so storing them larger is
 * wasted bytes — and compressed size tracks pixel count almost linearly, making
 * a resolution cap the cheapest size lever of all. Glyphs already within the cap
 * are left untouched. Pass `maxSide: 0` to disable downscaling.
 */
export const DEFAULT_MAX_SIDE = 64;
