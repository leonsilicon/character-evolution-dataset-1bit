/**
 * Node-only conveniences for the dataset reader.
 *
 * The core {@link DatasetReader} is environment-agnostic: it works over an
 * in-memory `Uint8Array` and a host-supplied decompressor. This module wires it
 * up to Node's `node:zlib` (zstd) and `node:fs`, and adds PNG re-encoding via
 * `sharp`, so a Node consumer can open a dataset from a file path in one call.
 * Importing this module pulls in native modules; runtime targets like React
 * Native should import {@link DatasetReader} from the package root instead.
 */
import { readFile } from "node:fs/promises";
import { constants as zc, zstdDecompressSync } from "node:zlib";
import {
  DatasetReader,
  type DatasetReaderOptions,
  type Decompress,
  type RawGlyph,
} from "./dataset.ts";
import { datasetPath } from "./path.ts";

export { datasetPath } from "./path.ts";

/** zstd block decompressor backed by `node:zlib`. */
export const nodeDecompress: Decompress = (compressed, windowLog) =>
  zstdDecompressSync(compressed, {
    params: { [zc.ZSTD_d_windowLogMax]: windowLog },
  });

/** Read a dataset file into memory and open a reader over it. */
export async function openDatasetFile(
  filePath: string,
  options?: DatasetReaderOptions,
): Promise<DatasetReader> {
  const bytes = await readFile(filePath);
  // Default to the fast native zstd on Node, but let callers override it.
  return new DatasetReader(bytes, options?.decompress ?? nodeDecompress, options);
}

/** Open a reader over the `dataset.bin` bundled with this package. */
export function openBundledDataset(options?: DatasetReaderOptions): Promise<DatasetReader> {
  return openDatasetFile(datasetPath, options);
}

/**
 * Re-encode a raw glyph as a PNG buffer, reconstructing the original image.
 * Grayscale records expand back to a standard PNG.
 *
 * Node-only, and the *only* helper that needs `sharp`. `sharp` is an optional
 * peer dependency, so it is imported lazily here: the rest of the `/node` entry
 * (reading files, opening readers) works without it, and only calling this
 * function requires it to be installed.
 */
export async function rawGlyphToPng(glyph: RawGlyph): Promise<Buffer> {
  const { width, height, channels, pixels } = glyph;
  let mod: Awaited<ReturnType<typeof importSharp>>;
  try {
    mod = await importSharp();
  } catch {
    throw new Error(
      "rawGlyphToPng requires the optional peer dependency 'sharp'. Install it with: npm install sharp",
    );
  }
  // `sharp` is a CJS `export =`; under esModuleInterop the callable is on
  // `.default`, but fall back to the namespace itself for safety.
  const sharp = mod.default ?? (mod as unknown as typeof import("sharp"));
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

/** Lazy, typed dynamic import of the optional `sharp` peer dependency. */
function importSharp() {
  return import("sharp");
}
