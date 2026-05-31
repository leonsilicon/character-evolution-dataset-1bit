import { parseScript, type Script } from "./dataset.ts";

export interface ScriptMetadata {
  /** Human-readable English label for display. */
  label: string;
  /** Common Chinese label for the script or source class. */
  chinese: string;
  /** Dataset filename prefixes that usually map to this script class. */
  prefixes: readonly string[];
  /** Broad historical period for educational UIs. */
  period: string;
}

export const SCRIPT_METADATA: Record<Script, ScriptMetadata> = {
  "oracle-bone": {
    label: "Oracle Bone Script",
    chinese: "甲骨文",
    prefixes: ["O_"],
    period: "Shang Dynasty, c. 1250 BCE",
  },
  bronze: {
    label: "Bronze Script",
    chinese: "金文",
    prefixes: ["J_"],
    period: "Zhou Dynasty, c. 1046-256 BCE",
  },
  "bamboo-silk": {
    label: "Bamboo and Silk Slips",
    chinese: "简牍帛书",
    prefixes: ["W_"],
    period: "Warring States through Qin/Han, c. 475 BCE-220 CE",
  },
  seal: {
    label: "Seal Script",
    chinese: "篆文",
    prefixes: ["Z_"],
    period: "Qin Dynasty, 221-206 BCE",
  },
  clerical: {
    label: "Clerical Script",
    chinese: "隶书",
    prefixes: ["L_"],
    period: "Han Dynasty, 202 BCE-220 CE",
  },
  regular: {
    label: "Regular Script",
    chinese: "楷书",
    prefixes: ["K_", "X_"],
    period: "Modern standard forms",
  },
  other: {
    label: "Other",
    chinese: "其他",
    prefixes: [],
    period: "Unclassified",
  },
};

export const GLYPH_TERM_TRANSLATIONS = {
  甲骨文: "Oracle Bone Script",
  新甲: "Xin Jia oracle-bone collection",
  新乙: "Xin Yi oracle-bone collection",
  天卜: "Tianbu oracle-bone collection",
  金文: "Bronze Script",
  毛公鼎: "Mao Gong Ding",
  大盂鼎: "Da Yu Ding",
  散氏盤: "San Shi Pan",
  散氏盘: "San Shi Pan",
  秦公簋: "Qin Gong Gui",
  鼎: "ding ritual cauldron",
  簋: "gui ritual vessel",
  盤: "pan basin",
  盘: "pan basin",
  简牍帛书: "Bamboo and Silk Slips",
  簡牘帛書: "Bamboo and Silk Slips",
  郭店楚简: "Guodian Chu Slips",
  郭店楚簡: "Guodian Chu Slips",
  郭: "Guodian Chu Slips",
  包山楚简: "Baoshan Chu Slips",
  包山楚簡: "Baoshan Chu Slips",
  包: "Baoshan Chu Slips",
  信阳楚简: "Xinyang Chu Slips",
  信陽楚簡: "Xinyang Chu Slips",
  信: "Xinyang Chu Slips",
  望山楚简: "Wangshan Chu Slips",
  望山楚簡: "Wangshan Chu Slips",
  望: "Wangshan Chu Slips",
  曾侯乙简: "Marquis Yi of Zeng Slips",
  曾侯乙簡: "Marquis Yi of Zeng Slips",
  曾: "Marquis Yi of Zeng Slips",
  睡虎地秦简: "Shuihudi Qin Slips",
  睡虎地秦簡: "Shuihudi Qin Slips",
  睡: "Shuihudi Qin Slips",
  战国文字: "Warring States Script",
  戰國文字: "Warring States Script",
  篆文: "Seal Script",
  小篆: "Small Seal Script",
  說文: "Shuowen Jiezi",
  说文: "Shuowen Jiezi",
  一部: "Radical One section",
  隶书: "Clerical Script",
  隸書: "Clerical Script",
  楷书: "Regular Script",
  楷書: "Regular Script",
  楷体: "Regular Script",
  楷體: "Regular Script",
  康熙字: "Kangxi Dictionary form",
  西周早期: "Early Western Zhou",
  西周中期: "Middle Western Zhou",
  西周晚期: "Late Western Zhou",
  春秋中期: "Middle Spring and Autumn period",
  秦: "Qin",
  楚: "Chu",
  反: "verso",
  背: "back",
} as const;

export type GlyphTerm = keyof typeof GLYPH_TERM_TRANSLATIONS;

export interface GlyphKeyDescription {
  /** Original key or filename passed by the caller. */
  key: string;
  /** Last path segment, including extension if present. */
  filename: string;
  /** Filename without its image extension. */
  stem: string;
  script: Script;
  scriptLabel: string;
  scriptChinese: string;
  period: string;
  /** English-ish label with known Chinese source terms translated. */
  translatedLabel: string;
  /** True when the source filename marks this as a duplicate/copy variant. */
  duplicate: boolean;
}

const TERM_REPLACEMENTS = Object.entries(GLYPH_TERM_TRANSLATIONS).sort(
  (a, b) => b[0].length - a[0].length,
);

function filenameFromKey(keyOrFilename: string): string {
  const slash = keyOrFilename.lastIndexOf("/");
  return slash === -1 ? keyOrFilename : keyOrFilename.slice(slash + 1);
}

function stripImageExtension(filename: string): string {
  return filename.replace(/\.(?:png|jpg|jpeg|webp)$/i, "");
}

/** Translate one known Chinese dataset term, if this library has a mapping for it. */
export function translateGlyphTerm(term: string): string | undefined {
  return GLYPH_TERM_TRANSLATIONS[term as GlyphTerm];
}

/**
 * Translate the known Chinese source terms inside a glyph key or filename.
 * Unknown artifact names and catalog abbreviations are preserved verbatim.
 */
export function translateGlyphLabel(label: string): string {
  let translated = label
    .replace(/副本(\d*)/g, (_, n: string) => (n ? `copy ${n}` : "copy"))
    .replace(/集成(\d+)/g, "Jicheng $1");

  for (const [chinese, english] of TERM_REPLACEMENTS) {
    translated = translated.replaceAll(chinese, english);
  }

  return translated
    .replace(/([a-z)])(?=[A-Z])/g, "$1 ")
    .replace(/([A-Za-z])(?=\d)/g, "$1 ")
    .replace(/(\d)(?=[A-Za-z])/g, "$1 ");
}

/**
 * Describe a dataset glyph key for display: broad script metadata, duplicate
 * marker, and a translated source label derived from the filename.
 */
export function describeGlyphKey(keyOrFilename: string): GlyphKeyDescription {
  const filename = filenameFromKey(keyOrFilename);
  const stem = stripImageExtension(filename);
  const script = parseScript(stem);
  const metadata = SCRIPT_METADATA[script];
  return {
    key: keyOrFilename,
    filename,
    stem,
    script,
    scriptLabel: metadata.label,
    scriptChinese: metadata.chinese,
    period: metadata.period,
    translatedLabel: translateGlyphLabel(stem),
    duplicate: /副本\d*/.test(stem),
  };
}
