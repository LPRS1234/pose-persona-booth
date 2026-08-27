import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";


let poseLandmarker = null;

async function initialize({ wasmRoot, modelUrl }) {
  const vision = await FilesetResolver.forVisionTasks(wasmRoot);
  const modelResponse = await fetch(modelUrl, { cache: "no-store" });
  if (!modelResponse.ok) {
    throw new Error(`포즈 모델을 불러오지 못했습니다: ${modelResponse.status}`);
  }
  const modelBuffer = await modelResponse.arrayBuffer();

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetBuffer: new Uint8Array(modelBuffer),
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });

  self.postMessage({
    type: "READY",
    connections: PoseLandmarker.POSE_CONNECTIONS,
  });
}

function detect({ bitmap, timestampMs }) {
  if (!poseLandmarker) {
    bitmap.close();
    throw new Error("포즈 모델이 아직 준비되지 않았습니다.");
  }

  try {
    const startedAt = performance.now();
    const result = poseLandmarker.detectForVideo(bitmap, timestampMs);
    const landmarks = result.landmarks?.[0] ?? null;
    self.postMessage({
      type: "RESULT",
      landmarks,
      inferenceMs: performance.now() - startedAt,
    });
  } finally {
    bitmap.close();
  }
}

self.addEventListener("message", async (event) => {
  const { type } = event.data;
  try {
    if (type === "INIT") {
      await initialize(event.data);
      return;
    }
    if (type === "DETECT") {
      detect(event.data);
    }
  } catch (error) {
    const bitmap = event.data.bitmap;
    if (bitmap) {
      try {
        bitmap.close();
      } catch {
        // 이미 해제된 프레임은 무시한다.
      }
    }
    self.postMessage({
      type: "ERROR",
      fatal: type === "INIT",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
