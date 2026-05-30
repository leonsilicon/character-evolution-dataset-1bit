/**
 * CLI: build the single-file dataset.
 *
 * Input modes (mutually exclusive; checked in this order):
 *
 *   # Normal build — from the committed, split lossless source of truth. Auto-
 *   # reassembles data/Dataset.bin.NNN then re-packs with the chosen params.
 *   # The distributable lives at the repo root (./dataset.bin), not under data/,
 *   # to avoid a case-only clash with data/Dataset.bin:
 *   bun run src/__build-dataset.ts --out dataset.bin
 *
 *   # From an already-reassembled Dataset.bin:
 *   bun run src/__build-dataset.ts --from-bin data/Dataset.bin --out dataset.bin
 *
 *   # From the raw image tree (first-time pack / regenerating Dataset.bin):
 *   bun run src/__build-dataset.ts --source data/Dataset --out data/Dataset.bin \
 *     --black-white false --quantize 256 --max-side 0   # lossless source of truth
 *
 * The `__` prefix marks this as an internal entry: it is build tooling, not part
 * of the package's public exports.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pack } from "./_pack.ts";
import { datasetPath } from "./path.ts";
import { reassembleSource } from "./__source.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required --${name}`);
}

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

// Input is either a raw image tree (--source) or a committed lossless dataset
// (--from-bin). When --from-bin is given it wins; otherwise --source applies,
// defaulting to the bundled image tree.
// Resolve the input. Precedence: an explicit --source image tree, else an
// explicit --from-bin file, else (the default build) reassemble the committed
// split source and pack from that. Exactly one of sourceDir/sourceBin reaches
// pack().
const explicitSource = arg("source", "");
const explicitBin = arg("from-bin", "");
let sourceDir: string | undefined;
let sourceBin: string | undefined;
if (explicitSource) {
  sourceDir = path.resolve(explicitSource);
} else if (explicitBin) {
  sourceBin = path.resolve(explicitBin);
} else {
  // Default: reassemble data/Dataset.bin from its committed parts (skip if it is
  // already present, so repeat builds don't redo the I/O).
  const reassembled = path.resolve("data/Dataset.bin");
  if (!existsSync(reassembled)) {
    console.log("Reassembling data/Dataset.bin from parts...");
    await reassembleSource(reassembled);
  }
  sourceBin = reassembled;
}

// Default to the path the package exports, so a plain build produces the
// bundled artifact that consumers resolve via `datasetPath`.
const outFile = path.resolve(arg("out", datasetPath));
// Larger blocks let the compressor match against the many near-identical glyphs
// spread across the corpus (the same fonts rendered for 15k characters), which
// 256-image blocks could not reach.
const blockSize = Number(arg("block-size", "4096"));
const level = Number(arg("level", "19"));
const concurrency = Number(arg("concurrency", "0")) || undefined;
// 16 levels = "4-bit gray". Ignored when --black-white is set (that forces 2).
// Pass --quantize 0 (or 256) for full gray depth.
const quantizeLevels = Number(arg("quantize", "16")) || undefined;
// Cap the longest side (px); the app renders glyphs small, so 64 is invisibly
// lossy while being the cheapest size lever. Pass --max-side 0 for full res.
const maxSide = Number(arg("max-side", "64"));
// Default build is 1-bit black & white: smallest, and chosen for this dataset
// after a visual review at display size. Pass --black-white false to keep gray.
const blackWhite = arg("black-white", "true") !== "false";
// Optional ID -> modern character map embedded in the header for labeling.
// Disabled by default: the repo's `Key&Value.json` uses a *different* ID
// numbering than the packed image folders (it maps 㐁 to "00001" while that
// glyph lives in folder "00011"), so joining it by folder name attaches the
// wrong characters. Pass --characters <path> with a map keyed to the folder IDs
// to embed labels. Only IDs present in both the map and the dataset are kept.
const charactersPath = arg("characters", "");
let characters: Record<string, string> | undefined;
if (charactersPath) {
  try {
    characters = JSON.parse(readFileSync(path.resolve(charactersPath), "utf8")) as Record<
      string,
      string
    >;
  } catch {
    console.warn(`  (no character map at ${charactersPath}; building without labels)`);
  }
}

console.log(`Packing ${sourceBin ?? sourceDir} -> ${outFile}`);
console.log(
  `  block-size=${blockSize} level=${level} max-side=${maxSide || "off"} ` +
    `${blackWhite ? "black-white" : `quantize=${quantizeLevels ?? "off (full gray)"}`}` +
    `${characters ? ` characters=${Object.keys(characters).length}` : ""}\n`,
);

let lastPct = -1;
const start = Date.now();

const stats = await pack({
  sourceDir,
  sourceBin,
  outFile,
  blockSize,
  level,
  concurrency,
  quantizeLevels,
  maxSide,
  blackWhite,
  characters,
  onProgress(done, total) {
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      process.stdout.write(`\r  ${pct}% (${done}/${total})`);
    }
  },
});

const secs = ((Date.now() - start) / 1000).toFixed(1);
const ratio = ((stats.outputBytes / stats.sourceBytes) * 100).toFixed(1);

console.log(`\n\nDone in ${secs}s`);
console.log(`  images:      ${stats.imageCount}`);
console.log(`  blocks:      ${stats.blockCount}`);
console.log(`  grayscale:   ${stats.grayscaleCount}`);
console.log(`  rgb (color): ${stats.rgbCount}`);
console.log(`  labeled ids: ${stats.labeledCount}`);
console.log(`  source:      ${fmtBytes(stats.sourceBytes)}`);
console.log(`  output:      ${fmtBytes(stats.outputBytes)}  (${ratio}% of source)`);
