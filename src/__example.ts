/**
 * Example: extract a single glyph from the packed dataset at runtime.
 *
 *   bun run src/__example.ts "00011/K_楷体" out.png
 *   bun run src/__example.ts "00011/K_楷体" out.png path/to/dataset.bin
 *
 * The `__` prefix marks this as an internal entry: it is a demo, not part of the
 * package's public exports.
 */
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { openDatasetFile, rawGlyphToPng } from "./+node.ts";
import { datasetPath } from "./path.ts";

const [key, outPath = "out.png", datasetFile = datasetPath] = process.argv.slice(2);
if (!key) {
  console.error("Usage: __example.ts <key> [out.png] [dataset.bin]");
  process.exit(1);
}

const reader = await openDatasetFile(datasetFile);
console.log(`dataset has ${reader.size} images`);
if (!reader.has(key)) {
  console.error(`Key not found: ${key}`);
  console.error("First few keys:", reader.keys().slice(0, 5));
  process.exit(1);
}

const meta = reader.entry(key)!;
console.log(
  `extracting ${key}: ${meta.width}x${meta.height}, ${meta.channels === 1 ? "grayscale" : "rgb"}`,
);

const png = await rawGlyphToPng(reader.getRaw(key));
await writeFile(outPath, png);
console.log(`wrote ${png.length} bytes -> ${outPath}`);
