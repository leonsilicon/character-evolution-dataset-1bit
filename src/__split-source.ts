/**
 * Split `data/Dataset.bin` into committable `data/Dataset.bin.NNN` chunks.
 *
 * The lossless source of truth is ~332 MB — over GitHub's 100 MB per-file cap —
 * so it is committed as fixed-size chunks instead of one blob (and reassembled
 * by `__source.ts` at build time). Run after regenerating `Dataset.bin`:
 *
 *   bun run src/__split-source.ts [chunkBytes]
 *
 * Default chunk size is 90 MiB, comfortably under the cap. Existing parts are
 * removed first so a smaller source never leaves stale trailing chunks behind.
 * Build tooling only (the `__` prefix), run from the repo root.
 */
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const SOURCE = path.join(DATA_DIR, "Dataset.bin");
const PART_PREFIX = "Dataset.bin.";
const PART_RE = /^Dataset\.bin\.\d+$/;
const DEFAULT_CHUNK = 90 * 1024 * 1024; // 90 MiB

const chunkBytes = Number(process.argv[2]) || DEFAULT_CHUNK;

if (!existsSync(SOURCE)) {
  throw new Error(`${SOURCE} not found; run the lossless pack first`);
}

// Clear any previous parts.
for (const name of await readdir(DATA_DIR)) {
  if (PART_RE.test(name)) await unlink(path.join(DATA_DIR, name));
}

// Stream the source, cutting a new part every `chunkBytes`. Three-digit, 1-based
// zero-padded suffixes (.001, .002, …) keep lexical order == numeric order for
// reassembly.
await new Promise<void>((resolve, reject) => {
  const rs = createReadStream(SOURCE, { highWaterMark: 4 * 1024 * 1024 });
  let index = 1;
  let written = 0;
  let ws = createWriteStream(partPath(index));

  function partPath(i: number): string {
    return path.join(DATA_DIR, `${PART_PREFIX}${String(i).padStart(3, "0")}`);
  }

  rs.on("error", reject);
  ws.on("error", reject);

  rs.on("data", (chunkRaw) => {
    let chunk = chunkRaw as Buffer;
    while (chunk.length > 0) {
      const room = chunkBytes - written;
      if (chunk.length < room) {
        ws.write(chunk);
        written += chunk.length;
        chunk = Buffer.alloc(0);
      } else {
        // Fill the current part, roll over to the next.
        ws.write(chunk.subarray(0, room));
        chunk = chunk.subarray(room);
        ws.end();
        index++;
        ws = createWriteStream(partPath(index));
        ws.on("error", reject);
        written = 0;
      }
    }
  });

  rs.on("end", () => {
    ws.end(() => {
      console.log(`Split ${SOURCE} into ${index} part(s) of <= ${chunkBytes} bytes`);
      resolve();
    });
  });
});
