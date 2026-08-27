import { copyFile, cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";


const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(scriptDirectory, "..");
const publicDirectory = resolve(rootDirectory, "public");
const wasmSource = resolve(
  rootDirectory,
  "node_modules",
  "@mediapipe",
  "tasks-vision",
  "wasm",
);
const wasmTarget = resolve(publicDirectory, "mediapipe", "wasm");
const modelSource = resolve(rootDirectory, "pose_landmarker_lite.task");
const modelTarget = resolve(
  publicDirectory,
  "models",
  "pose_landmarker_lite.task",
);

await mkdir(wasmTarget, { recursive: true });
await mkdir(dirname(modelTarget), { recursive: true });
await cp(wasmSource, wasmTarget, { recursive: true, force: true });
await copyFile(modelSource, modelTarget);

console.log("MediaPipe WASM과 포즈 모델을 로컬 웹 자산으로 준비했습니다.");
