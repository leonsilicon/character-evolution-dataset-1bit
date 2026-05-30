/**
 * Reassemble the committed, split `Dataset.bin` into a single file.
 *
 * The lossless source of truth — every glyph's full-resolution, bit-exact
 * pixels — is ~332 MB, over GitHub's 100 MB per-file limit, so it is committed
 * as `data/Dataset.bin.NNN` chunks (`.001`, `.002`, …). This concatenates them
 * back into `data/Dataset.bin`, which the build then re-packs into the
 * distributable `dataset.bin` with whatever lossy params are chosen.
 *
 * Concatenation joins the parts in ascending numeric-suffix order, byte-for-byte,
 * so the result is identical to the original. Build tooling only (the `__`
 * prefix), run from the repo root.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const PART_RE = /^Dataset\.bin\.\d+$/;

/**
 * Concatenate `<dataDir>/Dataset.bin.NNN` into `outFile`. `dataDir` defaults to
 * `data` (relative to the current working directory, matching the rest of the
 * build tooling); `outFile` defaults to `<dataDir>/Dataset.bin`. Returns the
 * absolute output path. Throws if no parts are found, so a misconfigured build
 * fails loudly instead of producing a truncated source.
 */
export async function reassembleSource(outFile?: string, dataDir = "data"): Promise<string> {
  const dir = path.resolve(dataDir);
  const out = path.resolve(outFile ?? path.join(dir, "Dataset.bin"));

  const entries = await readdir(dir);
  const parts = entries
    .filter((n) => PART_RE.test(n))
    .sort() // zero-padded numeric suffixes, so lexical sort == numeric order.
    .map((n) => path.join(dir, n));

  if (parts.length === 0) {
    throw new Error(`No Dataset.bin.NNN parts found in ${dir}; cannot reassemble Dataset.bin`);
  }

  const ws = createWriteStream(out);
  for (const part of parts) {
    await pipeline(createReadStream(part), ws, { end: false });
  }
  await new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("finish", resolve);
    ws.end();
  });

  return out;
}
