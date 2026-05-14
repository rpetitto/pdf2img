// Strip Node-only dynamic imports from the mupdf package so it can be
// bundled for Cloudflare Workers. We provide the wasm binary via the
// instantiateWasm hook in src/worker/mupdf-init.ts, so these Node-only
// fallback paths are never taken at runtime.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const patches = [
  {
    file: "node_modules/mupdf/dist/mupdf.js",
    from: 'var node_fs = null;\nif (typeof process !== "undefined" && process.versions && process.versions.node)\n\tnode_fs = await import("node:fs");',
    to: "var node_fs = null;",
  },
  {
    file: "node_modules/mupdf/dist/mupdf-wasm.js",
    // Replace the literal `await import("module")` so esbuild doesn't try to
    // resolve the `module` builtin. The Node branch is never taken under
    // Workers, so stubbing `r` to undefined is safe.
    from: 'if(m){const{createRequire:_}=await import("module");var r=_(import.meta.url)}',
    to: "var r;",
  },
];

let changed = 0;
for (const { file, from, to } of patches) {
  if (!existsSync(file)) {
    console.log(`[patch-mupdf] skipping missing ${file}`);
    continue;
  }
  const src = readFileSync(file, "utf8");
  if (src.includes(to) && !src.includes(from)) {
    console.log(`[patch-mupdf] already patched: ${file}`);
    continue;
  }
  if (!src.includes(from)) {
    console.warn(`[patch-mupdf] target snippet not found in ${file}; mupdf version may have changed`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(file, src.replace(from, to));
  console.log(`[patch-mupdf] patched ${file}`);
  changed++;
}
console.log(`[patch-mupdf] done (${changed} file(s) updated)`);
