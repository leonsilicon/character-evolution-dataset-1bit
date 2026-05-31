import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    // Two public entries: the runtime-agnostic root and the Node-only
    // conveniences. The `__`-prefixed files in src/ are internal CLI/demo
    // tooling and are deliberately omitted, so they never become package
    // exports. The `exports` map in package.json is maintained by hand (no
    // auto-generation) so the public subpaths stay `.` and `./node`.
    entry: ["src/+.ts", "src/+node.ts"],
    dts: {
      tsgo: true,
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ['**']
  },
});
