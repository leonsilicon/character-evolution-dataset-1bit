import { existsSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { parseScript } from "../src/dataset.ts";
import { openBundledDataset } from "../src/+node.ts";
import { datasetPath } from "../src/path.ts";

/** 一 (U+4E00, yī) — the simplest common character, heavily represented in the corpus. */
const YI = "一";

describe("glyphsForCharacter (bundled)", () => {
  test(`${YI} (yi): returns sorted evolution glyphs from folder 06592`, async () => {
    if (!existsSync(datasetPath)) return;

    const reader = await openBundledDataset();
    const glyphs = reader.glyphsForCharacter(YI);
    const keys = reader.keysForCharacter(YI);

    expect(glyphs.length).toBe(403);
    expect(keys.length).toBe(403);
    expect(new Set(keys)).toEqual(new Set(glyphs.map((g) => g.key)));

    for (const { key } of glyphs) {
      expect(key.startsWith("06592/")).toBe(true);
    }

    expect(glyphs[0]).toEqual({
      key: "06592/O_G_一_甲骨文",
      script: "oracle-bone",
      order: 0,
    });
    expect(glyphs.at(-1)).toEqual({
      key: "06592/X_康熙字",
      script: "regular",
      order: 5,
    });

    for (const g of glyphs) {
      expect(g.script).toBe(parseScript(g.key));
    }

    for (let i = 1; i < glyphs.length; i++) {
      const prev = glyphs[i - 1]!;
      const cur = glyphs[i]!;
      expect(cur.order).toBeGreaterThanOrEqual(prev.order);
      if (cur.order === prev.order) {
        expect(cur.key >= prev.key).toBe(true);
      }
    }

    const raw = reader.getRaw(glyphs[0]!.key);
    expect(raw.channels).toBe(1);
    expect(raw.width).toBeGreaterThan(0);
    expect(raw.height).toBeGreaterThan(0);
    expect(raw.pixels.length).toBe(raw.width * raw.height);
  });
});
