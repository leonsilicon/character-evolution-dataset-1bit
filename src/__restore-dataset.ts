/**
 * Reconstruct the `data/Dataset` image tree from the committed lossless source.
 *
 *   bun run src/__restore-dataset.ts [outDir]
 *
 * Reassembles `data/Dataset.bin` from its parts (if not already present), then
 * writes every glyph back to `<outDir>/<key>.png` (default outDir `data/Dataset`),
 * recreating the original folder/file layout.
 *
 * Fidelity: the **pixels and the tree layout are exact** — keys are the original
 * relative paths minus extension, so a character's folder and filenames come back
 * verbatim. The **file encoding is not** the original: Dataset.bin stores decoded
 * pixels, not the original compressed bytes, so everything is re-encoded as PNG.
 * In particular, the ~11k source JPGs come back as PNG, and images that were
 * grayscale-equivalent RGB come back as single-channel gray PNGs. What you see is
 * identical; the bytes on disk are not the original files.
 *
 * Build tooling only (the `__` prefix), run from the repo root.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { openDatasetFile, rawGlyphToPng } from "./+node.ts";
import { reassembleSource } from "./__source.ts";

const outDir = path.resolve(process.argv[2] ?? "data/Dataset");

// Ensure the reassembled lossless source exists, then open it.
const sourcePath = path.resolve("data/Dataset.bin");
if (!existsSync(sourcePath)) {
  console.log("Reassembling data/Dataset.bin from parts...");
  await reassembleSource(sourcePath);
}
const reader = await openDatasetFile(sourcePath);

const keys = reader.keys();
const total = keys.length;
console.log(`Restoring ${total} glyphs -> ${outDir}`);

// Pre-create every directory once, so the per-glyph writes don't each stat/mkdir.
const dirs = new Set<string>();
for (const key of keys) dirs.add(path.dirname(path.join(outDir, key)));
for (const dir of dirs) await mkdir(dir, { recursive: true });

// Bounded concurrency: PNG encoding is CPU-bound in sharp's threadpool, so a pool
// around the core count keeps things busy without thrashing.
const concurrency = Math.max(1, availableParallelism());
let done = 0;
let lastPct = -1;

async function restoreOne(key: string): Promise<void> {
  const raw = reader.getRaw(key);
  const png = await rawGlyphToPng(raw);
  await writeFile(path.join(outDir, `${key}.png`), png);
  done++;
  const pct = Math.floor((done / total) * 100);
  if (pct !== lastPct) {
    lastPct = pct;
    process.stdout.write(`\r  ${pct}% (${done}/${total})`);
  }
}

// Simple fixed-size worker pool over the key list.
let next = 0;
async function worker(): Promise<void> {
  while (next < keys.length) {
    const i = next++;
    await restoreOne(keys[i]!);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));

console.log(`\nDone. Wrote ${done} PNG files to ${outDir}`);
