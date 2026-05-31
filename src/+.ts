export { MAGIC } from "./constants.ts";
export type { BlockRef, DatasetEntry, DatasetHeader } from "./types.ts";
export {
  type CharacterGlyph,
  DatasetReader,
  type DatasetReaderOptions,
  type Decompress,
  defaultDecompress,
  parseScript,
  type RawGlyph,
  type Script,
} from "./dataset.ts";
export {
  describeGlyphKey,
  type GlyphKeyDescription,
  type GlyphTerm,
  GLYPH_TERM_TRANSLATIONS,
  SCRIPT_METADATA,
  type ScriptMetadata,
  translateGlyphLabel,
  translateGlyphTerm,
} from "./translations.ts";
