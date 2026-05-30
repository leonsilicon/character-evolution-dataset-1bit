import { withoutProtocol } from "ufo";

/**
 * Absolute path to the bundled `dataset.bin` that ships with the package.
 *
 * The reader itself takes a `Uint8Array`, not a path, so it can run anywhere
 * (browser, React Native). This export is the Node-friendly bridge: read the
 * file at this path into memory, then hand the bytes to `DatasetReader`.
 *
 * Resolved relative to this module, so it is correct whether running from source
 * (`src/`) or the published build (`dist/`) — both sit one directory below the
 * package root, where `dataset.bin` lives. It is kept at the root (not under
 * `data/`) to avoid a case-only clash with the lossless source `data/Dataset.bin`
 * on case-insensitive filesystems.
 */
export const datasetPath: string = withoutProtocol(new URL("../dataset.bin", import.meta.url).href);
