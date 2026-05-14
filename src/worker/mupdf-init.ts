// Provide the mupdf WASM binary via Emscripten's instantiateWasm hook.
// This module MUST be imported before any `mupdf` import so the
// globalThis hook is set before mupdf initializes.
//
// In dev, `import x from "./foo.wasm"` returns a Uint8Array.
// In production (Cloudflare Workers), it returns a WebAssembly.Module.
// WebAssembly.instantiate accepts both forms.

// eslint-disable-next-line import/no-relative-packages -- mupdf package.json doesn't expose the wasm file via exports
import wasmBinary from "../../node_modules/mupdf/dist/mupdf-wasm.wasm";

// Cloudflare Workers (current Fling compat date) does not expose
// FinalizationRegistry. mupdf only uses it as a GC fallback for freeing
// native resources; we call .destroy() on every object we create, so a
// no-op polyfill is sufficient.
type GlobalWithFR = { FinalizationRegistry?: unknown };
const _g = globalThis as unknown as GlobalWithFR;
if (typeof _g.FinalizationRegistry === "undefined") {
  _g.FinalizationRegistry = class {
    register(): void {}
    unregister(): void {}
  };
}

(globalThis as unknown as Record<string, unknown>)["$libmupdf_wasm_Module"] = {
  instantiateWasm(
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
  ) {
    WebAssembly.instantiate(
      wasmBinary as unknown as BufferSource | WebAssembly.Module,
      imports,
    ).then((result) => {
      if ("instance" in (result as object)) {
        const r = result as WebAssembly.WebAssemblyInstantiatedSource;
        successCallback(r.instance, r.module);
      } else {
        successCallback(result as WebAssembly.Instance);
      }
    });
    return {};
  },
};
