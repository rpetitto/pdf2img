// Make mupdf bundleable for Cloudflare Workers without breaking Node-based
// local dev.
//
// mupdf.js and mupdf-wasm.js contain Node-only branches that
//   (1) dynamically `await import("node:fs")` / `await import("module")`,
//       which esbuild can't resolve when targeting Workers, and
//   (2) use the `require()` they import to set up `fs`/`path` wrappers.
//
// We never need either of those code paths at runtime, because
// src/worker/mupdf-init.ts always supplies an `instantiateWasm` hook that
// short-circuits mupdf's wasm loader. The safe fix is to empty out the
// Node branches entirely — they become no-ops in both Workers and Node.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MARKER = "/* patched-for-workers */";

const patches = [
  {
    file: "node_modules/mupdf/dist/mupdf.js",
    from:
      'var node_fs = null;\n' +
      'if (typeof process !== "undefined" && process.versions && process.versions.node)\n' +
      '\tnode_fs = await import("node:fs");',
    to: `var node_fs = null; ${MARKER}`,
  },
  // mupdf-wasm.js has two Node-only branches that depend on each other:
  // the first imports `module` to build a `require`; the second uses that
  // `require` to load `fs`/`path`/`url`. We empty both.
  {
    file: "node_modules/mupdf/dist/mupdf-wasm.js",
    from: 'if(m){const{createRequire:_}=await import("module");var r=_(import.meta.url)}',
    to: `${MARKER}`,
  },
  {
    file: "node_modules/mupdf/dist/mupdf-wasm.js",
    from:
      'if(m){var c=r("fs"),g=r("path");f.startsWith("file:")&&(l=g.dirname(r("url").fileURLToPath(f))+"/"),p=_=>(_=U(_)?new URL(_):_,c.readFileSync(_)),o=async(_,a=!0)=>(_=U(_)?new URL(_):_,c.readFileSync(_,a?void 0:"utf8")),process.argv.length>1&&(d=process.argv[1].replace(/\\\\/g,"/")),process.argv.slice(2),w=(_,a)=>{throw process.exitCode=_,a}}',
    to: "if(false){}",
  },
];

let changed = 0;
let missing = 0;
for (const { file, from, to } of patches) {
  if (!existsSync(file)) {
    console.log(`[patch-mupdf] skipping missing ${file}`);
    continue;
  }
  const src = readFileSync(file, "utf8");
  if (!src.includes(from)) {
    if (src.includes(to)) {
      console.log(`[patch-mupdf] already applied to ${file}`);
    } else {
      console.warn(`[patch-mupdf] target snippet not found in ${file}; mupdf version may have changed`);
      missing++;
    }
    continue;
  }
  writeFileSync(file, src.replace(from, to));
  console.log(`[patch-mupdf] patched ${file}`);
  changed++;
}
console.log(`[patch-mupdf] done (${changed} updated, ${missing} mismatched)`);
if (missing > 0) process.exitCode = 1;
