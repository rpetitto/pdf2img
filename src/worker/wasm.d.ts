declare module "*.wasm" {
  const value: Uint8Array & WebAssembly.Module;
  export default value;
}
