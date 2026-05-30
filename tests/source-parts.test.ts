import { describe, expect, it } from "vite-plus/test";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { reassembleSource } from "../src/__source.ts";

const DATA_DIR = path.resolve("data");
const PART_RE = /^Dataset\.bin\.\d+$/;

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(file);
    rs.on("error", reject);
    rs.on("data", (c) => hash.update(c));
    rs.on("end", resolve);
  });
  return hash.digest("hex");
}

describe("Dataset.bin parts", () => {
  it("are all under GitHub's 100 MB per-file cap", async () => {
    const parts = (await readdir(DATA_DIR)).filter((n) => PART_RE.test(n));
    expect(parts.length).toBeGreaterThan(0);
    for (const p of parts) {
      const { size } = await stat(path.join(DATA_DIR, p));
      expect(size).toBeLessThan(100 * 1000 * 1000);
    }
  });

  it("reassemble byte-identically to data/Dataset.bin when present", async () => {
    const source = path.join(DATA_DIR, "Dataset.bin");
    // Only meaningful when a reassembled reference exists locally; in CI the
    // build reassembles first, so this guards against drift between the parts and
    // the source they were split from.
    if (!existsSync(source)) return;
    const tmp = path.join(DATA_DIR, "Dataset.reassembled.test.bin");
    await reassembleSource(tmp);
    try {
      expect(await sha256(tmp)).toBe(await sha256(source));
    } finally {
      await unlink(tmp);
    }
  });
});
