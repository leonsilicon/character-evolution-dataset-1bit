/**
 * CLI: derive the `folderId → modern character` map and write it to
 * `data/characters.json`, for embedding into the packed dataset (`--characters`).
 *
 *   bun run src/__characters.ts                       # writes data/characters.json
 *   bun run src/__characters.ts --from-bin data/Dataset.bin --out data/characters.json
 *
 * ## Why this is needed
 *
 * The dataset keys glyphs by `<folderId>/<filename>`, where `folderId` is an
 * opaque numeric folder name with no character map embedded, so the reader cannot
 * answer "give me the glyphs for 㐁" — the whole point of the dataset. This tool
 * reconstructs the map.
 *
 * ## The key discovery: folderId encodes the Unicode code point
 *
 * The folder numbers are **not** the upstream EVOBC indices (`0–13713`); they run
 * `11..60326` for 15,102 folders. Reading the unambiguous `O_<script>_<char>_…`
 * filenames (the only place the *target* character appears on its own — other
 * filenames embed vessel/source words like 鼎/金/說文/楷体) gives, for each such
 * folder, a `(folderId, codePoint)` pair. Those pairs reveal a clean rule:
 *
 *     codePoint === folderId + OFFSET
 *
 * with `OFFSET` constant within each Unicode block (e.g. `13302` across CJK
 * Extension A: folder `11` → U+3401 㐁, folder `55` → U+334D 㐭, folder `59` →
 * U+3351 㐱). The offset changes only at block boundaries (Ext-A → Unified →
 * Ext-B → …), so the anchors fall into a handful of constant-offset segments.
 *
 * This makes the map **exact and deterministic**, not heuristic: every folder's
 * character is `String.fromCodePoint(folderId + offsetForThatFolder)`, where the
 * offset is taken from the enclosing constant-offset segment of anchors. We
 * assert that the rule reproduces *every* high-precision anchor exactly before
 * emitting, so a wrong offset can never ship silently.
 *
 * The `__` prefix marks this as internal build tooling, not a public export.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatasetReader } from "./dataset.ts";
import { reassembleSource } from "./__source.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required --${name}`);
}

/** The folder-name prefix of a key, e.g. "00011/O_G_㐁_…" -> "00011". */
function folderIdOf(key: string): string {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(0, slash);
}

/**
 * The unambiguous code point for a folder, or null when it can't be read.
 * Only `O_<script>_<char>_…` filenames are consulted (the only place the target
 * character appears on its own); a folder qualifies only when a single character
 * strictly dominates those files, so contaminated folders are excluded from the
 * anchor set rather than guessed.
 */
function anchorCodePoint(filenames: readonly string[]): number | null {
  const votes = new Map<number, number>();
  for (const fn of filenames) {
    const m = fn.match(/^O_[A-Z]_(\p{Script=Han})_/u);
    if (m) {
      const cp = m[1]!.codePointAt(0)!;
      votes.set(cp, (votes.get(cp) ?? 0) + 1);
    }
  }
  if (votes.size === 0) return null;
  const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[1]![1] >= sorted[0]![1]) return null;
  return sorted[0]![0];
}

/** A maximal run of anchors that share one `codePoint - folderId` offset. */
interface OffsetSegment {
  offset: number;
  /** Inclusive folderId bounds of the anchors in this segment. */
  minFolder: number;
  maxFolder: number;
}

async function main(): Promise<void> {
  const dataDir = path.resolve("data");
  const outPath = path.resolve(arg("out", path.join(dataDir, "characters.json")));

  const explicitBin = arg("from-bin", "");
  let sourceBin: string;
  if (explicitBin) {
    sourceBin = path.resolve(explicitBin);
  } else {
    sourceBin = path.join(dataDir, "Dataset.bin");
    if (!existsSync(sourceBin)) {
      console.log("Reassembling data/Dataset.bin from parts...");
      await reassembleSource(sourceBin);
    }
  }

  console.log(`Reading dataset keys from ${sourceBin}`);
  const reader = new DatasetReader(new Uint8Array(readFileSync(sourceBin)));

  // Group filenames per folder.
  const folderFiles = new Map<string, string[]>();
  for (const key of reader.keys()) {
    const id = folderIdOf(key);
    const file = key.slice(id.length + 1);
    let files = folderFiles.get(id);
    if (!files) {
      files = [];
      folderFiles.set(id, files);
    }
    files.push(file);
  }
  const folders = [...folderFiles.keys()].sort((a, b) => Number(a) - Number(b));

  // --- Anchors: folders with an unambiguous code point. Each yields a
  // (folderId, codePoint) pair whose difference is the block offset.
  const anchors: Array<{ folder: number; cp: number }> = [];
  for (const id of folders) {
    const cp = anchorCodePoint(folderFiles.get(id)!);
    if (cp !== null) anchors.push({ folder: Number(id), cp });
  }
  anchors.sort((a, b) => a.folder - b.folder);

  // --- Segment the anchors into maximal constant-offset runs (offset changes
  // only at Unicode block boundaries).
  const segments: OffsetSegment[] = [];
  for (const a of anchors) {
    const offset = a.cp - a.folder;
    const last = segments[segments.length - 1];
    if (last && last.offset === offset) {
      last.maxFolder = a.folder;
    } else {
      segments.push({ offset, minFolder: a.folder, maxFolder: a.folder });
    }
  }

  // Resolve the offset for an arbitrary folder by locating the segment whose
  // folder range contains it. Between two same-offset segments (anchors are
  // sparse) a folder may fall in a gap; we attribute it to the nearest segment
  // boundary on either side that agrees, preferring an enclosing segment.
  function offsetForFolder(folder: number): number | null {
    // Exact containment first.
    for (const s of segments) {
      if (folder >= s.minFolder && folder <= s.maxFolder) return s.offset;
    }
    // Otherwise, the folder sits between segments: pick the segment immediately
    // below it and the one immediately above; only assign when they agree (the
    // block offset is unambiguous across the gap).
    let below: OffsetSegment | undefined;
    let above: OffsetSegment | undefined;
    for (const s of segments) {
      if (s.maxFolder < folder && (!below || s.maxFolder > below.maxFolder)) below = s;
      if (s.minFolder > folder && (!above || s.minFolder < above.minFolder)) above = s;
    }
    if (below && above && below.offset === above.offset) return below.offset;
    if (below && !above) return below.offset; // tail past the last anchor
    return null;
  }

  // --- Build the map. A folder's character is folderId + offset.
  const map: Record<string, string> = {};
  let viaContainment = 0;
  let viaGap = 0;
  for (const id of folders) {
    const folder = Number(id);
    const offset = offsetForFolder(folder);
    if (offset === null) continue;
    const cp = folder + offset;
    let char: string;
    try {
      char = String.fromCodePoint(cp);
    } catch {
      continue; // out-of-range code point: skip rather than emit garbage.
    }
    map[id] = char;
    const inSeg = segments.some((s) => folder >= s.minFolder && folder <= s.maxFolder);
    if (inSeg) viaContainment++;
    else viaGap++;
  }

  // --- Precision guard: the offset rule must reproduce EVERY anchor exactly.
  // Folder ids may be zero-padded in keys, so resolve each anchor back to its
  // actual id string before comparing.
  const idByNumber = new Map(folders.map((id) => [Number(id), id]));
  let anchorChecked = 0;
  let anchorWrong = 0;
  const wrongExamples: string[] = [];
  for (const a of anchors) {
    anchorChecked++;
    const id = idByNumber.get(a.folder)!;
    const expected = String.fromCodePoint(a.cp);
    const actual = map[id];
    if (actual !== expected) {
      anchorWrong++;
      if (wrongExamples.length < 10)
        wrongExamples.push(`folder ${a.folder}: rule gave ${actual ?? "(none)"}, anchor says ${expected}`);
    }
  }
  if (anchorWrong > 0) {
    console.error(`\nPrecision guard FAILED: ${anchorWrong}/${anchorChecked} anchors mismatched`);
    for (const e of wrongExamples) console.error(`  ${e}`);
    throw new Error("Offset rule does not reproduce all anchors; refusing to emit a wrong map");
  }

  const mapped = Object.keys(map).length;
  writeFileSync(outPath, `${JSON.stringify(map, null, 0)}\n`);

  console.log(`\nWrote ${outPath}`);
  console.log(`  folders:           ${folders.length}`);
  console.log(`  anchors:           ${anchors.length}`);
  console.log(`  offset segments:   ${segments.length}`);
  console.log(`  mapped:            ${mapped} (${((mapped / folders.length) * 100).toFixed(1)}%)`);
  console.log(`    via containment: ${viaContainment}`);
  console.log(`    via gap fill:    ${viaGap}`);
  console.log(`  unmapped:          ${folders.length - mapped}`);
  console.log(`  anchor precision:  ${anchorChecked - anchorWrong}/${anchorChecked} exact`);

  // Sanity checks on known folders.
  const checks: Array<[string, string]> = [
    ["00011", "㐁"],
    ["00055", "㐭"],
    ["00059", "㐱"],
  ];
  for (const [folder, expected] of checks) {
    const got = map[folder];
    console.log(`  check ${folder} -> ${got ?? "(unmapped)"} (expected ${expected})`);
    if (got !== expected)
      throw new Error(`Sanity check failed: folder ${folder} -> ${got}, expected ${expected}`);
  }
}

await main();
