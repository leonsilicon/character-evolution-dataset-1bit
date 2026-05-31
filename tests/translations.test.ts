import { describe, expect, test } from "vite-plus/test";
import {
  describeGlyphKey,
  parseScript,
  translateGlyphLabel,
  translateGlyphTerm,
} from "../src/+.ts";

describe("glyph source translations", () => {
  test("maps common Chinese source terms to English", () => {
    expect(translateGlyphTerm("甲骨文")).toBe("Oracle Bone Script");
    expect(translateGlyphTerm("毛公鼎")).toBe("Mao Gong Ding");
    expect(translateGlyphTerm("康熙字")).toBe("Kangxi Dictionary form");
    expect(translateGlyphTerm("not-in-map")).toBeUndefined();
  });

  test("translates known terms inside filenames while preserving catalog numbers", () => {
    expect(translateGlyphLabel("O_G_一_甲骨文")).toBe("O_G_一_Oracle Bone Script");
    expect(translateGlyphLabel("J_毛公鼎西周晚期集成2841")).toBe(
      "J_Mao Gong Ding Late Western Zhou Jicheng 2841",
    );
    expect(translateGlyphLabel("W_包2.260副本0")).toBe(
      "W_Baoshan Chu Slips 2.260 copy 0",
    );
    expect(translateGlyphLabel("Z_說文‧一部")).toBe(
      "Z_Shuowen Jiezi‧Radical One section",
    );
  });

  test("describes keys with script metadata and duplicate markers", () => {
    expect(describeGlyphKey("06592/W_包2.260副本0.png")).toEqual({
      key: "06592/W_包2.260副本0.png",
      filename: "W_包2.260副本0.png",
      stem: "W_包2.260副本0",
      script: "bamboo-silk",
      scriptLabel: "Bamboo and Silk Slips",
      scriptChinese: "简牍帛书",
      period: "Warring States through Qin/Han, c. 475 BCE-220 CE",
      translatedLabel: "W_Baoshan Chu Slips 2.260 copy 0",
      duplicate: true,
    });

    expect(describeGlyphKey("06592/X_康熙字").script).toBe("regular");
  });

  test("classifies bamboo/silk and Kangxi filename prefixes", () => {
    expect(parseScript("W_郭.太.1")).toBe("bamboo-silk");
    expect(parseScript("X_康熙字")).toBe("regular");
  });
});
