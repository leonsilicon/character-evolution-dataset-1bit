# character-evolution-dataset-1bit

A single-file, random-access dataset of **~263,000 Chinese character-evolution glyph
images** — oracle-bone, bronze, seal, clerical, and modern forms across ~15,000
characters — bundled with a tiny reader for Node, the browser, and React Native.

The raw images are ~263k tiny PNGs (~783 MB on disk). This package packs all of
them into **one ~48 MB file** and lets you pull out any individual glyph at
runtime without unpacking the rest.

> **Black & white build.** Glyphs are stored downscaled (longest side ≤ 64px) and
> reduced to 1-bit black & white, which keeps the file small. This is
> lossy: it's meant for displaying reference glyphs at small sizes, not for
> pixel-exact reproduction. If you need grayscale or full resolution, see
> [Building your own dataset](#building-your-own-dataset).

## Install

```bash
npm install character-evolution-dataset-1bit
# or: bun add / pnpm add / yarn add
```

The packed `dataset.bin` (~48 MB) ships inside the package, so there's nothing
else to download.

The core reader has no native dependencies and runs anywhere. `sharp` is an
**optional peer dependency**, needed only for `rawGlyphToPng` (PNG re-encoding on
Node) — install it (`npm install sharp`) if you use that helper; everything else
works without it.

## Quick start (Node)

```ts
import { openBundledDataset, rawGlyphToPng } from "character-evolution-dataset-1bit/node";
import { writeFile } from "node:fs/promises";

const reader = await openBundledDataset();

console.log(reader.size); // 262993

const key = "00011/K_楷体";
const raw = reader.getRaw(key); // { width, height, channels, pixels }
const png = await rawGlyphToPng(raw); // reconstructed PNG Buffer
await writeFile("glyph.png", png);
```

**Keys** are the image's path relative to the source root, without the file
extension — e.g. `00011/K_楷体`. List them with `reader.keys()`. To go the other
way — from a character to its glyphs — use `reader.glyphsForCharacter(char)`,
which returns the character's forms classified by script and ordered oldest →
newest:

```ts
for (const { key, script } of reader.glyphsForCharacter("㐁")) {
  console.log(script, key); // oracle-bone, bronze, seal, regular, …
}
```

## API

### Reader (any runtime)

```ts
import { DatasetReader } from "character-evolution-dataset-1bit";
```

`DatasetReader` works over an in-memory `Uint8Array`, so it has **no filesystem
dependency**. Load the bytes however your platform does (read a file, `fetch()`,
bundle an asset) and pass them in — a `zstd` decompressor is included by
default (the bundled, dependency-free [`fzstd`](https://github.com/101arrowz/fzstd)),
so it works in any runtime out of the box:

```ts
const reader = new DatasetReader(bytes); // uses bundled fzstd
```

To use a faster (e.g. native) zstd binding, pass your own decompressor — either
positionally or via options:

```ts
const reader = new DatasetReader(bytes, (compressed /*, windowLog */) => myZstd(compressed));
// or:
const reader = new DatasetReader(bytes, undefined, { decompress: (c) => myZstd(c) });
```

A decompressor is `(compressed: Uint8Array, windowLog: number) => Uint8Array`;
`windowLog` may be ignored (most decoders don't need it). `defaultDecompress` is
also exported if you want to reference the built-in one.

| Member                      | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| `reader.size`               | Number of images.                                            |
| `reader.keys()`             | All keys, in stored order.                                   |
| `reader.has(key)`           | Whether a key exists.                                        |
| `reader.entry(key)`         | Metadata `{ width, height, channels, ... }`, or `undefined`. |
| `reader.getRaw(key)`        | `{ width, height, channels, pixels }` — raw row-major bytes. |
| `reader.character(keyOrId)` | The glyph's modern character (e.g. `"㐁"`), or `undefined`.  |
| `reader.characters()`       | The full ID → character map, or `undefined` if none.         |
| `reader.keysForCharacter(char)`   | All glyph keys for a character, in stored order (empty if unknown). |
| `reader.glyphsForCharacter(char)` | `{ key, script, order }[]` for a character, sorted oldest → newest. |
| `reader.clearCache()`       | Drop cached decompressed blocks.                             |

`getRaw` returns `channels: 1` (grayscale) or `3` (RGB) and a `pixels`
`Uint8Array` of length `width * height * channels`. Reads decompress one block
at a time; recently used blocks are cached (`new DatasetReader(bytes, undefined,
{ blockCacheSize: 8 })`, default 8, set `0` to disable).

A key is `"<id>/<filename>"`, where `<id>` is the character folder (e.g.
`"00011"`). The bundled build **ships with a character map**, so
`reader.character()`, `reader.characters()`, `reader.keysForCharacter()`, and
`reader.glyphsForCharacter()` all work out of the box (~15k characters; a lookup
for a character that isn't covered returns `undefined`/empty rather than
throwing). `parseScript(key)` is also exported: it classifies a key by its
filename prefix into a `Script` — `"oracle-bone"` (`O_*`), `"bronze"` (`J_`, 金文),
`"bamboo-silk"` (`W_`, 简牍帛书), `"seal"` (`Z_`, 說文/篆), `"clerical"` (`L_`, 隸),
`"regular"` (`K_`/`X_`, modern 楷体/Kangxi forms), or `"other"` — which is how
`glyphsForCharacter` labels and chronologically orders a character's forms.

For UI labels, `describeGlyphKey(key)` and `translateGlyphLabel(label)` translate
the dataset's common Chinese source terms into English while preserving catalog
numbers and unknown artifact names:

```ts
describeGlyphKey("06592/J_毛公鼎西周晚期集成2841");
// {
//   script: "bronze",
//   scriptLabel: "Bronze Script",
//   translatedLabel: "J_Mao Gong Ding Late Western Zhou Jicheng 2841",
//   duplicate: false,
//   ...
// }
```

The map is **not** taken from the repo's `Key&Value.json` — that file uses a
different ID numbering than the image folders (it maps 㐁 to `"00001"`, but that
glyph lives in folder `"00011"`), so joining it by folder name would attach the
wrong characters. Instead, the folder id encodes the character's Unicode code
point: `codePoint = folderId + offset`, where `offset` is constant within each
Unicode block (e.g. `13302` across CJK Extension A, so folder `11` → U+3401 㐁).
The build derives the offsets from the unambiguous `O_<script>_<char>_…`
filenames and asserts the rule reproduces every one of them before embedding the
map (see [`src/__characters.ts`](./src/__characters.ts)). To rebuild or customize
the map, see [Building your own dataset](#building-your-own-dataset).

### Node helpers

```ts
import {
  openBundledDataset, // reader over the bundled dataset.bin
  openDatasetFile, // reader over a dataset file you point at
  rawGlyphToPng, // RawGlyph -> PNG Buffer (uses sharp)
  datasetPath, // absolute path to the bundled dataset.bin
} from "character-evolution-dataset-1bit/node";

const reader = await openDatasetFile("/path/to/dataset.bin", { blockCacheSize: 16 });
```

These wire the reader up to `node:fs`, `node:zlib`, and `sharp`, and use Node's
**native** zstd (faster than the bundled default). On other runtimes, import
`DatasetReader` from the package root — see below.

## React Native / browser

It just works — get the dataset bytes into a `Uint8Array` and construct a reader.
The bundled `fzstd` decompressor is pure JS (no native module, no I/O), so there
is nothing to wire up:

```ts
import { DatasetReader } from "character-evolution-dataset-1bit";

// `bytes`: the dataset.bin loaded into a Uint8Array (bundled asset, fetch, fs…).
const reader = new DatasetReader(bytes);

const { width, height, channels, pixels } = reader.getRaw("00011/K_楷体");
```

**Performance note.** `fzstd` is convenient but ~4× slower than a native zstd
decoder. Because glyphs are grouped into blocks and decompressed blocks are
cached, you only pay the decode cost the first time you touch a block (then every
other glyph in it is free) — fine for browsing a character's variants, which sit
in the same block. If you need fast _random_ access across the whole set on a
low-end device, pass a native binding instead:

```ts
const reader = new DatasetReader(bytes, undefined, { decompress: myNativeZstd });
```

Whatever you pass must decode **binary** data, `(Uint8Array) => Uint8Array`. Two
common modules don't fit and can't be used directly: `react-native-nitro-zlib`
has no zstd at all (deflate/gzip/brotli/LZO only), and `react-native-zstd`'s
public API is string-only (`decompress(buf): string`), which corrupts binary
pixel data through UTF-8.

## How it works

- Each image is decoded to raw pixels. Achromatic images (~99% of the set, where
  `R == G == B`) are stored single-channel; genuinely colored ones keep RGB.
- Glyphs are downscaled so the longest side is ≤ 64px, then reduced to 1-bit
  black & white. Compressed size tracks pixel count almost linearly, so the
  resolution cap — not the bit depth — does most of the shrinking.
- Images are sorted by key so a character's variants and shared script styles sit
  next to each other; their raw pixels are concatenated and compressed with
  long-window `zstd`. The huge shared white margins and repeated stroke shapes
  across glyphs compress away — this cross-glyph redundancy is the real win.
- Records are grouped into independently-compressed **blocks**, so reading one
  glyph decompresses only one block. The index is a compact columnar header
  (also `zstd`-compressed) that omits everything derivable.

The file format is documented in
[`src/constants.ts`](./src/constants.ts) (magic `CEDS0002`, then a compressed
header and `zstd` blocks).

## Building your own dataset

### Regenerating the bundled dataset

The bundled `dataset.bin` (at the repo root) is generated from a **lossless source of truth**
kept in the repo, so its packing parameters can be re-tweaked at any time without
the original 783 MB image tree. That source — every glyph at full resolution and
full 8-bit gray depth, bit-for-bit identical to the originals — is ~332 MB, over
GitHub's 100 MB per-file limit, so it is committed as `data/Dataset.bin.NNN`
chunks (each < 100 MB) and reassembled on demand. **No Git LFS required.**

```bash
# Re-pack dataset.bin (repo root) from the committed source parts. Auto-reassembles
# data/Dataset.bin from parts first; tweak the lossy defaults in src/__build-dataset.ts.
bun run dataset:build

# Regenerate the lossless source from a local data/Dataset tree, then re-split
# it into committable parts (run after updating the raw images).
bun run dataset:source

# Reconstruct the data/Dataset image tree from the source parts. Same folders
# and filenames, pixel-identical, all written as PNG (see note below).
bun run dataset:restore
```

`data/Dataset.bin` (the reassembled source), `dataset.bin` (the built
distributable, at the repo root), and `data/Dataset/` are gitignored; only the
`data/Dataset.bin.NNN` chunks are tracked.

> **Restore fidelity.** `dataset:restore` recreates the exact folder/file layout
> with pixel-identical glyphs, but not the original file bytes: the source stores
> decoded pixels, so everything is re-encoded as PNG. The ~11k source JPGs come
> back as PNG, and grayscale-equivalent RGB images come back as single-channel
> gray PNGs. What you see is identical; the bytes on disk are not the originals.

### From a raw image tree

The packer can also produce other quality/size trade-offs directly from a
directory of per-character image folders:

```bash
bun run src/__build-dataset.ts --source path/to/Dataset --out dataset.bin
```

It can equally re-pack from an existing lossless `Dataset.bin` with
`--from-bin data/Dataset.bin` (it refuses a lossy `Dataset.bin`, to avoid
compounding loss). Approximate sizes for the full set (~263k images, ~783 MB of
source PNGs):

| Build                    | Flags                                           | Output  | Notes                                          |
| ------------------------ | ----------------------------------------------- | ------- | ---------------------------------------------- |
| **B&W, 64px (default)**  | _(defaults)_                                    | ~46 MB  | The bundled build (packed from `Dataset.bin`). |
| Gray, 64px               | `--black-white false`                           | ~76 MB  | Keeps anti-aliasing.                           |
| Full-resolution lossless | `--max-side 0 --black-white false --quantize 0` | ~332 MB | Bit-exact with source (this is `Dataset.bin`). |

- `--source <dir>` — root with per-character image subfolders. Pass one of
  `--source` / `--from-bin`, or neither (defaults to reassembling the committed
  source parts).
- `--from-bin <path>` — re-pack from an existing lossless `Dataset.bin`.
- `--out <path>` — output file (default: the bundled `dataset.bin` at the repo root).
- `--max-side <n>` — cap the longest side in pixels (default `64`; `0` = full res).
- `--black-white <bool>` — 1-bit B&W (default `true`; `false` keeps gray).
- `--quantize <n>` — gray levels when not B&W (default `16`; `0` = full depth).
- `--block-size <n>` — records per block (default `4096`).
- `--level <n>` — zstd compression level (default `19`).
- `--characters <path>` — folder-id → character JSON embedded as labels. The
  default build passes `data/characters.json` (generated by `dataset:characters`,
  see below); only IDs present in both the map and the dataset are kept. The
  repo's `Key&Value.json` does _not_ match the folder numbering, so it is not used.

### Regenerating the character map

`data/characters.json` (folder id → character) is derived from the dataset's own
filenames and embedded into `dataset.bin` at build time. `dataset:build` runs this
automatically; to regenerate it on its own:

```bash
bun run dataset:characters   # writes data/characters.json
```

It anchors on the unambiguous `O_<script>_<char>_…` filenames, recovers the
`codePoint = folderId + offset` rule per Unicode block, and **asserts the rule
reproduces every anchor exactly** before writing — so a wrong offset can't ship
silently. See [`src/__characters.ts`](./src/__characters.ts).

## Development

```bash
vp install   # install dependencies
vp test      # run tests
vp check     # format, lint, type-check
vp pack      # build the library
```

## License

MIT © [Leon Si](https://github.com/leonsilicon)
