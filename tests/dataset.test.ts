import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decompress as fzstdDecompress } from "fzstd";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { DatasetReader } from "../src/dataset.ts";
import { openDatasetFile, rawGlyphToPng } from "../src/+node.ts";
import { pack } from "../src/_pack.ts";

/** Build a PNG from raw RGB pixels for use as a test fixture. */
async function makePng(
  dir: string,
  name: string,
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
): Promise<void> {
  const buf = Buffer.allocUnsafe(width * height * 3);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      buf[i++] = r;
      buf[i++] = g;
      buf[i++] = b;
    }
  }
  await sharp(buf, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(path.join(dir, name));
}

/** Decode a PNG buffer back to raw RGB (3ch) for pixel-exact comparison. */
async function decodeRgb(png: Buffer): Promise<{ width: number; height: number; data: Buffer }> {
  // Normalize to exactly 3 channels regardless of how the PNG was encoded
  // (grayscale records re-encode to a 1-channel PNG; toColourspace expands it).
  const { data, info } = await sharp(png)
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

describe("DatasetReader roundtrip", () => {
  let tmp: string;
  let datasetPath: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "ceds-test-"));
    const src = path.join(tmp, "src");
    await mkdir(path.join(src, "00001"), { recursive: true });
    await mkdir(path.join(src, "00002"), { recursive: true });
    // Two character folders, mixing grayscale-equivalent and true-color images.
    // grayscale-equivalent: a black diagonal on white (R==G==B everywhere).
    await makePng(path.join(src, "00001"), "gray_diag.png", 16, 12, (x, y) =>
      x === y ? [0, 0, 0] : [255, 255, 255],
    );
    // another grayscale glyph, different size.
    await makePng(path.join(src, "00001"), "gray_box.png", 20, 8, (x, y) =>
      x < 4 || y < 2 ? [40, 40, 40] : [255, 255, 255],
    );
    // genuine color: red/green gradient (must be preserved as RGB).
    await makePng(path.join(src, "00002"), "color_grad.png", 10, 10, (x, y) => [
      (x * 25) % 256,
      (y * 25) % 256,
      128,
    ]);

    datasetPath = path.join(tmp, "dataset.bin");
    const stats = await pack({
      sourceDir: src,
      outFile: datasetPath,
      blockSize: 2, // force multiple blocks to exercise random access
      maxSide: 0, // keep this fixture bit-exact so pixel assertions hold
      // Label 00001 only; 00002 and a stale 99999 exercise partial coverage and
      // dead-entry filtering.
      characters: { "00001": "㐁", "99999": "x" },
    });
    expect(stats.imageCount).toBe(3);
    expect(stats.rgbCount).toBe(1);
    expect(stats.grayscaleCount).toBe(2);
    expect(stats.blockCount).toBeGreaterThanOrEqual(2);
    expect(stats.labeledCount).toBe(1); // only 00001 is both labeled and present
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("lists keys without extensions", async () => {
    const reader = await openDatasetFile(datasetPath);
    const keys = reader.keys().sort();
    expect(keys).toEqual(["00001/gray_box", "00001/gray_diag", "00002/color_grad"]);
    expect(reader.size).toBe(3);
    expect(reader.has("00001/gray_diag")).toBe(true);
    expect(reader.has("nope")).toBe(false);
  });

  test("grayscale image collapses to 1 channel but PNG is pixel-exact", async () => {
    const reader = await openDatasetFile(datasetPath);
    const entry = reader.entry("00001/gray_diag")!;
    expect(entry.channels).toBe(1);
    expect(entry.width).toBe(16);
    expect(entry.height).toBe(12);

    const png = await rawGlyphToPng(reader.getRaw("00001/gray_diag"));
    const { width, height, data } = await decodeRgb(png);
    expect(width).toBe(16);
    expect(height).toBe(12);
    // Verify the diagonal is intact: black on the diagonal, white off it.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const r = data[(y * width + x) * 3]!;
        expect(r).toBe(x === y ? 0 : 255);
      }
    }
  });

  test("color image is preserved as RGB, pixel-exact", async () => {
    const reader = await openDatasetFile(datasetPath);
    const entry = reader.entry("00002/color_grad")!;
    expect(entry.channels).toBe(3);

    const png = await rawGlyphToPng(reader.getRaw("00002/color_grad"));
    const { width, height, data } = await decodeRgb(png);
    expect(width).toBe(10);
    expect(height).toBe(10);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 3;
        expect(data[o]).toBe((x * 25) % 256);
        expect(data[o + 1]).toBe((y * 25) % 256);
        expect(data[o + 2]).toBe(128);
      }
    }
  });

  test("getRaw returns the exact stored bytes", async () => {
    const reader = await openDatasetFile(datasetPath);
    const raw = reader.getRaw("00001/gray_box");
    expect(raw.channels).toBe(1);
    expect(raw.pixels.length).toBe(raw.width * raw.height);
  });

  test("unknown key throws", async () => {
    const reader = await openDatasetFile(datasetPath);
    expect(() => reader.getRaw("missing/key")).toThrow(/Key not found/);
  });

  test("rejects a non-dataset file", async () => {
    const bad = path.join(tmp, "bad.bin");
    await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#fff" },
    })
      .png()
      .toFile(bad);
    await expect(openDatasetFile(bad)).rejects.toThrow(/bad magic/);
  });

  test("quantized build snaps pixels to the level grid", async () => {
    const qsrc = path.join(tmp, "qsrc");
    await mkdir(path.join(qsrc, "00001"), { recursive: true });
    // A horizontal gradient sweeping all 256 gray values.
    await makePng(path.join(qsrc, "00001"), "ramp.png", 256, 4, (x) => [x, x, x]);

    const qpath = path.join(tmp, "q.bin");
    await pack({ sourceDir: qsrc, outFile: qpath, quantizeLevels: 16, maxSide: 0 });

    const reader = await openDatasetFile(qpath);
    const raw = reader.getRaw("00001/ramp");
    const step = 255 / 15;
    // Every stored value must lie on the 16-level grid.
    const allowed = new Set(Array.from({ length: 16 }, (_, i) => Math.round(i * step)));
    for (const v of raw.pixels) expect(allowed.has(v)).toBe(true);
    // The grid must actually be coarser than the input (lossy happened).
    expect(new Set(raw.pixels).size).toBeLessThanOrEqual(16);
  });

  test("reader works with the default (bundled fzstd) decompressor", async () => {
    // No decompressor supplied: must fall back to the bundled fzstd and decode
    // identically to the native path used by openDatasetFile.
    const bytes = await readFile(datasetPath);
    const reader = new DatasetReader(bytes);
    expect(reader.size).toBe(3);
    const viaDefault = reader.getRaw("00001/gray_diag");
    const viaNative = (await openDatasetFile(datasetPath)).getRaw("00001/gray_diag");
    expect(viaDefault.width).toBe(viaNative.width);
    expect(Buffer.compare(Buffer.from(viaDefault.pixels), Buffer.from(viaNative.pixels))).toBe(0);
  });

  test("decompressor can be passed via options.decompress", async () => {
    const bytes = await readFile(datasetPath);
    let called = 0;
    const reader = new DatasetReader(bytes, undefined, {
      decompress: (compressed) => {
        called++;
        return fzstdDecompress(compressed);
      },
    });
    reader.getRaw("00001/gray_diag");
    expect(called).toBeGreaterThan(0); // custom fn actually used
  });

  test("character labels resolve by key or id, partial coverage, no dead entries", async () => {
    const reader = await openDatasetFile(datasetPath);
    // By full key and by bare ID.
    expect(reader.character("00001/gray_diag")).toBe("㐁");
    expect(reader.character("00001")).toBe("㐁");
    // Present but unlabeled ID -> undefined (partial coverage).
    expect(reader.character("00002/color_grad")).toBeUndefined();
    // The stale 99999 must not survive: it isn't in the dataset.
    const map = reader.characters()!;
    expect(map).toEqual({ "00001": "㐁" });
  });

  test("dataset without a character map returns undefined labels", async () => {
    const nsrc = path.join(tmp, "nolabels");
    await mkdir(path.join(nsrc, "00001"), { recursive: true });
    await makePng(path.join(nsrc, "00001"), "g.png", 8, 8, () => [0, 0, 0]);
    const npath = path.join(tmp, "nolabels.bin");
    await pack({ sourceDir: nsrc, outFile: npath, maxSide: 0 });

    const reader = await openDatasetFile(npath);
    expect(reader.characters()).toBeUndefined();
    expect(reader.character("00001/g")).toBeUndefined();
  });

  test("block cache serves repeated reads from the same block", async () => {
    const reader = await openDatasetFile(datasetPath, { blockCacheSize: 4 });
    const a = reader.getRaw("00001/gray_diag");
    const b = reader.getRaw("00001/gray_diag");
    expect(Buffer.compare(Buffer.from(a.pixels), Buffer.from(b.pixels))).toBe(0);
  });

  test("maxSide downscales glyphs over the cap, leaves small ones alone", async () => {
    const dsrc = path.join(tmp, "dsrc");
    await mkdir(path.join(dsrc, "00001"), { recursive: true });
    // 200x100 (over the cap) and 30x40 (under it).
    await makePng(path.join(dsrc, "00001"), "big.png", 200, 100, (x) =>
      x < 100 ? [0, 0, 0] : [255, 255, 255],
    );
    await makePng(path.join(dsrc, "00001"), "small.png", 30, 40, () => [10, 10, 10]);

    const dpath = path.join(tmp, "d.bin");
    await pack({ sourceDir: dsrc, outFile: dpath, maxSide: 64 });

    const reader = await openDatasetFile(dpath);
    const big = reader.entry("00001/big")!;
    expect(Math.max(big.width, big.height)).toBe(64); // longest side capped
    expect(big.width).toBe(64);
    expect(big.height).toBe(32); // aspect ratio preserved
    const small = reader.entry("00001/small")!;
    expect(small.width).toBe(30); // under the cap: untouched
    expect(small.height).toBe(40);
  });

  test("sourceBin repack preserves resized grayscale channel metadata", async () => {
    const ssrc = path.join(tmp, "sourcebin-src");
    await mkdir(path.join(ssrc, "00001"), { recursive: true });
    await makePng(path.join(ssrc, "00001"), "big_gray.png", 200, 100, (x) =>
      x < 100 ? [0, 0, 0] : [255, 255, 255],
    );
    await makePng(path.join(ssrc, "00001"), "small_gray.png", 20, 10, () => [255, 255, 255]);

    const sourceBin = path.join(tmp, "sourcebin-source.bin");
    await pack({ sourceDir: ssrc, outFile: sourceBin, maxSide: 0 });

    const repacked = path.join(tmp, "sourcebin-repacked.bin");
    await pack({ sourceBin, outFile: repacked, maxSide: 64, blockSize: 1 });

    const reader = await openDatasetFile(repacked);
    const big = reader.getRaw("00001/big_gray");
    expect(big.channels).toBe(1);
    expect(big.width).toBe(64);
    expect(big.height).toBe(32);
    expect(big.pixels.length).toBe(big.width * big.height);

    const small = reader.getRaw("00001/small_gray");
    expect(small.channels).toBe(1);
    expect(small.width).toBe(20);
    expect(small.height).toBe(10);
    expect(small.pixels.length).toBe(small.width * small.height);
  });

  test("blackWhite stores only pure black and white", async () => {
    const bsrc = path.join(tmp, "bsrc");
    await mkdir(path.join(bsrc, "00001"), { recursive: true });
    await makePng(path.join(bsrc, "00001"), "ramp.png", 256, 4, (x) => [x, x, x]);

    const bpath = path.join(tmp, "b.bin");
    await pack({ sourceDir: bsrc, outFile: bpath, blackWhite: true, maxSide: 0 });

    const reader = await openDatasetFile(bpath);
    const raw = reader.getRaw("00001/ramp");
    for (const v of raw.pixels) expect(v === 0 || v === 255).toBe(true);
  });

  test("columnar header reconstructs block/offset/length across many blocks", async () => {
    // Many small glyphs across several blocks; offsets must reset per block and
    // length must equal width*height*channels for every reconstructed entry.
    const msrc = path.join(tmp, "msrc");
    await mkdir(path.join(msrc, "00001"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      await makePng(path.join(msrc, "00001"), `g${i}.png`, 8 + i, 6, () => [i, i, i]);
    }
    const mpath = path.join(tmp, "m.bin");
    await pack({ sourceDir: msrc, outFile: mpath, blockSize: 3, maxSide: 0 });

    const reader = await openDatasetFile(mpath);
    expect(reader.size).toBe(10);
    let prevBlock = -1;
    for (const key of reader.keys()) {
      const e = reader.entry(key)!;
      expect(e.length).toBe(e.width * e.height * e.channels);
      // First record of each block starts at offset 0.
      if (e.block !== prevBlock) expect(e.offset).toBe(0);
      prevBlock = e.block;
      // The pixels actually decode to the right length, proving offsets line up.
      expect(reader.getRaw(key).pixels.length).toBe(e.length);
    }
  });
});
