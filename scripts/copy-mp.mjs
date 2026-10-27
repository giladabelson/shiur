// Copies the MediaPipe wasm runtime into public/ so the background-blur model is served from our
// own domain (no third-party CDN during lessons). Runs before every build.
import fs from "node:fs";
import path from "node:path";

const src = path.resolve("node_modules/@mediapipe/tasks-vision/wasm");
const dst = path.resolve("public/mp/wasm");
fs.mkdirSync(dst, { recursive: true });
for (const f of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) {
  const from = path.join(src, f), to = path.join(dst, f);
  if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) fs.copyFileSync(from, to);
}
console.log("mediapipe wasm ready");
