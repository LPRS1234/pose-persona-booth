const form = document.querySelector("#capture-form");
const optionInputs = [...form.querySelectorAll('input[type="radio"]')];
const formMessage = document.querySelector("#form-message");
const captureButton = document.querySelector("#capture-button");
const captureButtonText = document.querySelector("#capture-button-text");
const video = document.querySelector("#camera-video");
const canvas = document.querySelector("#capture-canvas");
const cameraStage = document.querySelector("#camera-stage");
const resultStage = document.querySelector("#result-stage");
const capturePreview = document.querySelector("#capture-preview");
const sessionLabel = document.querySelector("#session-label");
const cameraStatus = document.querySelector("#camera-status");
const cameraHelp = document.querySelector("#camera-help");
const cameraError = document.querySelector("#camera-error");
const retryCameraButton = document.querySelector("#retry-camera");
const retakeButton = document.querySelector("#retake-button");
const avatarOverlay = document.querySelector("#avatar-overlay");
const avatarParts = Object.fromEntries(
  [...avatarOverlay.querySelectorAll("[data-part]")].map((element) => [
    element.dataset.part,
    element,
  ]),
);
const poseOverlay = document.querySelector("#pose-overlay");
const poseReadiness = document.querySelector("#pose-readiness");
const poseMessage = document.querySelector("#pose-message");

const POSE_INPUT_WIDTH = 640;
const POSE_INPUT_HEIGHT = 360;
const POSE_INTERVAL_MS = 80;
const STABLE_FRAME_COUNT = 6;
const AVATAR_SMOOTHING = 0.35;
const AVATAR_CONFIDENCE = 0.3;
const SUPPORTED_AVATAR_KEY = "male-teen-police";

const poseInputCanvas = document.createElement("canvas");
poseInputCanvas.width = POSE_INPUT_WIDTH;
poseInputCanvas.height = POSE_INPUT_HEIGHT;
const poseInputContext = poseInputCanvas.getContext("2d", { alpha: false });

poseOverlay.width = POSE_INPUT_WIDTH;
poseOverlay.height = POSE_INPUT_HEIGHT;
const poseOverlayContext = poseOverlay.getContext("2d");

const poseWorker = new Worker(new URL("./pose-worker.js", import.meta.url));

let cameraStream = null;
let cameraReady = false;
let captureInProgress = false;
let showingResult = false;
let poseWorkerReady = false;
let poseWorkerBusy = false;
let poseConnections = [];
let poseReady = false;
let stablePoseFrames = 0;
let lastPoseFrameAt = 0;
let smoothedLandmarks = null;

function getAvatarOptions() {
  return {
    gender: form.elements.gender.value || null,
    age: form.elements.age.value || null,
    profession: form.elements.profession.value || null,
  };
}

function getMissingOption(options) {
  if (!options.gender) return { name: "gender", label: "성별" };
  if (!options.age) return { name: "age", label: "나이" };
  if (!options.profession) return { name: "profession", label: "직업" };
  return null;
}

function buildAvatarKey(options) {
  return `${options.gender}-${options.age}-${options.profession}`;
}

function updateButtonState() {
  const missingOption = getMissingOption(getAvatarOptions());
  captureButton.disabled =
    !cameraReady ||
    !poseWorkerReady ||
    Boolean(missingOption) ||
    captureInProgress ||
    showingResult;

  if (showingResult) {
    captureButtonText.textContent = "촬영 완료";
  } else if (captureInProgress) {
    captureButtonText.textContent = "포즈를 저장하는 중";
  } else if (!cameraReady) {
    captureButtonText.textContent = "카메라 준비 중";
  } else if (!poseWorkerReady) {
    captureButtonText.textContent = "포즈 모델 준비 중";
  } else if (missingOption) {
    captureButtonText.textContent = `${missingOption.label}을 선택하세요`;
  } else {
    captureButtonText.textContent = "지금 촬영하기";
  }
}

function updateOptions() {
  formMessage.textContent = "";
  updateAvatarTheme();
  updateButtonState();
}

function stopCamera() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  cameraReady = false;
  resetPoseTracking("카메라 연결을 기다리고 있습니다.", "loading");
}

function setPoseState(message, state) {
  poseMessage.textContent = message;
  poseReadiness.dataset.state = state;
}

function resetPoseTracking(message, state = "missing") {
  poseReady = false;
  stablePoseFrames = 0;
  clearPoseOverlay();
  clearAvatarOverlay(true);
  setPoseState(message, state);
  updateButtonState();
}

function clearPoseOverlay() {
  poseOverlayContext.clearRect(0, 0, poseOverlay.width, poseOverlay.height);
}

function landmarkConfidence(landmark) {
  return Math.min(landmark.visibility ?? 1, landmark.presence ?? 1);
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function clearAvatarOverlay(resetLandmarks = false) {
  avatarOverlay.dataset.visible = "false";
  if (resetLandmarks) {
    smoothedLandmarks = null;
  }
}

function isSupportedAvatar(options) {
  return !getMissingOption(options) && buildAvatarKey(options) === SUPPORTED_AVATAR_KEY;
}

function avatarImagesReady() {
  return Object.values(avatarParts).every(
    (image) => image.complete && image.naturalWidth > 0,
  );
}

function updateAvatarTheme() {
  const options = getAvatarOptions();
  if (getMissingOption(options)) {
    clearAvatarOverlay();
    return;
  }

  if (!isSupportedAvatar(options)) {
    clearAvatarOverlay();
    formMessage.textContent = "현재 남성 · 청소년 · 경찰 아바타만 준비되어 있습니다.";
    return;
  }

  if (smoothedLandmarks) {
    renderAvatar(smoothedLandmarks);
  }
}

function smoothLandmarks(landmarks) {
  if (!smoothedLandmarks || smoothedLandmarks.length !== landmarks.length) {
    smoothedLandmarks = landmarks.map((landmark) => ({ ...landmark }));
    return smoothedLandmarks;
  }

  smoothedLandmarks = landmarks.map((landmark, index) => {
    const previous = smoothedLandmarks[index];
    return {
      ...landmark,
      x: previous.x + (landmark.x - previous.x) * AVATAR_SMOOTHING,
      y: previous.y + (landmark.y - previous.y) * AVATAR_SMOOTHING,
      z: previous.z + (landmark.z - previous.z) * AVATAR_SMOOTHING,
    };
  });
  return smoothedLandmarks;
}

function getAvatarPoint(landmarks, index, width, height) {
  const landmark = landmarks[index];
  if (!landmark || landmarkConfidence(landmark) < AVATAR_CONFIDENCE) return null;
  return {
    x: landmark.x * width,
    y: landmark.y * height,
  };
}

function setPartVisibility(element, visible) {
  if (element) element.hidden = !visible;
}

function getImageAspectRatio(element, fallback = 1) {
  if (!element?.naturalWidth || !element?.naturalHeight) return fallback;
  return element.naturalWidth / element.naturalHeight;
}

function updateSegment(element, start, end, paddingRatio = 0.08) {
  if (!element || !start || !end) {
    setPartVisibility(element, false);
    return false;
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const baseLength = Math.hypot(dx, dy);
  if (baseLength < 2) {
    setPartVisibility(element, false);
    return false;
  }

  const padding = baseLength * paddingRatio;
  const unitX = dx / baseLength;
  const unitY = dy / baseLength;
  const length = baseLength + padding * 2;
  const thickness = length / getImageAspectRatio(element, 3);

  element.style.left = `${start.x - unitX * padding}px`;
  element.style.top = `${start.y - unitY * padding}px`;
  element.style.width = `${length}px`;
  element.style.height = `${thickness}px`;
  element.style.transform = `translateY(-50%) rotate(${Math.atan2(dy, dx)}rad)`;
  setPartVisibility(element, true);
  return true;
}

function updateAnchoredImage(
  element,
  anchor,
  imageWidth,
  angle,
  originX = 0.5,
  originY = 0.5,
) {
  if (!element || !anchor || imageWidth < 2) {
    setPartVisibility(element, false);
    return false;
  }

  const imageHeight = imageWidth / getImageAspectRatio(element);
  element.style.left = `${anchor.x - imageWidth * originX}px`;
  element.style.top = `${anchor.y - imageHeight * originY}px`;
  element.style.width = `${imageWidth}px`;
  element.style.height = `${imageHeight}px`;
  element.style.transformOrigin = `${originX * 100}% ${originY * 100}%`;
  element.style.transform = `rotate(${angle}rad)`;
  setPartVisibility(element, true);
  return true;
}

function renderAvatar(landmarks) {
  const options = getAvatarOptions();
  if (!isSupportedAvatar(options) || !avatarImagesReady() || !landmarks) {
    clearAvatarOverlay();
    return;
  }

  const width = avatarOverlay.clientWidth;
  const height = avatarOverlay.clientHeight;
  if (!width || !height) {
    clearAvatarOverlay();
    return;
  }

  const point = (index) => getAvatarPoint(landmarks, index, width, height);
  const leftEar = point(7);
  const rightEar = point(8);
  const leftShoulder = point(11);
  const rightShoulder = point(12);
  const leftElbow = point(13);
  const rightElbow = point(14);
  const leftWrist = point(15);
  const rightWrist = point(16);
  const leftHip = point(23);
  const rightHip = point(24);
  const leftKnee = point(25);
  const rightKnee = point(26);
  const leftAnkle = point(27);
  const rightAnkle = point(28);

  if (!leftShoulder || !rightShoulder) {
    clearAvatarOverlay();
    return;
  }

  const shoulderWidth = Math.hypot(
    rightShoulder.x - leftShoulder.x,
    rightShoulder.y - leftShoulder.y,
  );
  const shoulderAngle = Math.atan2(
    rightShoulder.y - leftShoulder.y,
    rightShoulder.x - leftShoulder.x,
  );
  const shoulderCenter = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };

  updateAnchoredImage(
    avatarParts.torso,
    shoulderCenter,
    shoulderWidth * 1.55,
    shoulderAngle,
    0.5,
    0.04,
  );
  updateSegment(avatarParts["left-upper-arm"], leftShoulder, leftElbow, 0.22);
  updateSegment(avatarParts["left-lower-arm"], leftElbow, leftWrist, 0.18);
  updateSegment(avatarParts["right-upper-arm"], rightShoulder, rightElbow, 0.22);
  updateSegment(avatarParts["right-lower-arm"], rightElbow, rightWrist, 0.18);
  updateSegment(avatarParts.pelvis, leftHip, rightHip, 0.25);
  updateSegment(avatarParts["left-thigh"], leftHip, leftKnee, 0.22);
  updateSegment(avatarParts["left-calf"], leftKnee, leftAnkle, 0.18);
  updateSegment(avatarParts["right-thigh"], rightHip, rightKnee, 0.22);
  updateSegment(avatarParts["right-calf"], rightKnee, rightAnkle, 0.18);

  if (leftEar && rightEar) {
    const earDistance = Math.hypot(
      rightEar.x - leftEar.x,
      rightEar.y - leftEar.y,
    );
    const headCenter = {
      x: (leftEar.x + rightEar.x) / 2,
      y: (leftEar.y + rightEar.y) / 2,
    };
    const headWidth = clamp(
      earDistance * 2.05,
      shoulderWidth * 0.9,
      shoulderWidth * 1.25,
    );
    const raisedHeadCenter = {
      x: headCenter.x,
      y: headCenter.y - headWidth * 0.12,
    };
    updateAnchoredImage(
      avatarParts.head,
      raisedHeadCenter,
      headWidth,
      Math.atan2(rightEar.y - leftEar.y, rightEar.x - leftEar.x),
      0.5,
      0.52,
    );
  } else {
    setPartVisibility(avatarParts.head, false);
  }

  avatarOverlay.dataset.visible = "true";
}

function inspectPose(landmarks) {
  if (!landmarks || landmarks.length !== 33) {
    return { valid: false, message: "포즈를 찾지 못해 아바타를 표시할 수 없습니다." };
  }

  return { valid: true, message: "자세를 잠시 유지해주세요." };
}

function drawPose(landmarks) {
  clearPoseOverlay();
  if (!landmarks) return;

  const width = poseOverlay.width;
  const height = poseOverlay.height;
  const lineColor = poseReady ? "#8de09b" : "#ff9f65";
  const pointColor = poseReady ? "#e9ffed" : "#fff3e8";

  poseOverlayContext.save();
  poseOverlayContext.lineCap = "round";
  poseOverlayContext.lineJoin = "round";
  poseOverlayContext.lineWidth = 4;
  poseOverlayContext.strokeStyle = lineColor;
  poseOverlayContext.shadowBlur = 9;
  poseOverlayContext.shadowColor = lineColor;

  for (const connection of poseConnections) {
    const start = landmarks[connection.start];
    const end = landmarks[connection.end];
    if (!start || !end) continue;
    if (landmarkConfidence(start) < 0.25 || landmarkConfidence(end) < 0.25) continue;

    poseOverlayContext.beginPath();
    poseOverlayContext.moveTo(start.x * width, start.y * height);
    poseOverlayContext.lineTo(end.x * width, end.y * height);
    poseOverlayContext.stroke();
  }

  poseOverlayContext.fillStyle = pointColor;
  poseOverlayContext.shadowBlur = 7;
  for (const landmark of landmarks) {
    if (landmarkConfidence(landmark) < 0.25) continue;
    poseOverlayContext.beginPath();
    poseOverlayContext.arc(landmark.x * width, landmark.y * height, 3.2, 0, Math.PI * 2);
    poseOverlayContext.fill();
  }
  poseOverlayContext.restore();
}

function handlePoseResult(landmarks) {
  const inspection = inspectPose(landmarks);
  if (!inspection.valid) {
    stablePoseFrames = 0;
    poseReady = false;
    clearAvatarOverlay(true);
    setPoseState(inspection.message, "missing");
    drawPose(landmarks);
    updateButtonState();
    return;
  }

  renderAvatar(smoothLandmarks(landmarks));
  stablePoseFrames = Math.min(stablePoseFrames + 1, STABLE_FRAME_COUNT);
  poseReady = stablePoseFrames >= STABLE_FRAME_COUNT;
  if (poseReady) {
    setPoseState("포즈 인식 완료 — 촬영할 수 있습니다.", "ready");
  } else {
    setPoseState(
      `자세를 유지해주세요. ${stablePoseFrames} / ${STABLE_FRAME_COUNT}`,
      "loading",
    );
  }
  drawPose(landmarks);
  updateButtonState();
}

async function sendPoseFrame(timestampMs) {
  poseWorkerBusy = true;
  try {
    poseInputContext.drawImage(
      video,
      0,
      0,
      POSE_INPUT_WIDTH,
      POSE_INPUT_HEIGHT,
    );
    const bitmap = await createImageBitmap(poseInputCanvas);
    poseWorker.postMessage(
      { type: "DETECT", bitmap, timestampMs },
      [bitmap],
    );
  } catch (error) {
    poseWorkerBusy = false;
    console.error("Pose frame error:", error);
  }
}

function poseLoop(timestampMs) {
  const canDetect =
    poseWorkerReady &&
    cameraReady &&
    !poseWorkerBusy &&
    !showingResult &&
    !document.hidden &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

  if (canDetect && timestampMs - lastPoseFrameAt >= POSE_INTERVAL_MS) {
    lastPoseFrameAt = timestampMs;
    sendPoseFrame(timestampMs);
  }
  requestAnimationFrame(poseLoop);
}

async function requestCamera(constraints) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: constraints,
  });
}

async function startCamera() {
  stopCamera();
  cameraError.hidden = true;
  cameraStatus.className = "camera-status is-loading";
  cameraStatus.innerHTML = '<span aria-hidden="true"></span> 연결 중';
  cameraHelp.textContent = "카메라를 연결하고 있습니다.";
  resetPoseTracking("카메라 연결을 기다리고 있습니다.", "loading");
  updateButtonState();

  try {
    let stream = await requestCamera({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      facingMode: "user",
    });

    const devices = await navigator.mediaDevices.enumerateDevices();
    const fhdCamera = devices.find(
      (device) => device.kind === "videoinput" && /fhd\s*webcam/i.test(device.label),
    );
    const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;

    if (fhdCamera && fhdCamera.deviceId !== activeDeviceId) {
      stream.getTracks().forEach((track) => track.stop());
      stream = await requestCamera({
        deviceId: { exact: fhdCamera.deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      });
    }

    cameraStream = stream;
    video.srcObject = stream;
    await video.play();
    cameraStage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;

    cameraReady = true;
    cameraStatus.className = "camera-status";
    cameraStatus.innerHTML = '<span aria-hidden="true"></span> 준비됨';
    cameraHelp.textContent = "몸 전체가 보이도록 카메라 앞에 서주세요.";
    if (poseWorkerReady) {
      setPoseState("포즈 모델 준비 완료 — 촬영할 수 있습니다.", "ready");
    }
  } catch (error) {
    console.error("Camera error:", error);
    cameraReady = false;
    cameraError.hidden = false;
    cameraStatus.className = "camera-status is-error";
    cameraStatus.innerHTML = '<span aria-hidden="true"></span> 연결 실패';
    cameraHelp.textContent = "카메라 권한 또는 연결 상태를 확인해주세요.";
  }

  updateButtonState();
}

function captureFrame() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new Error("카메라 영상이 아직 준비되지 않았습니다.");
  }

  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.drawImage(video, 0, 0, width, height);

  return {
    width,
    height,
    dataUrl: canvas.toDataURL("image/jpeg", 0.92),
  };
}

async function saveCapture(frame, avatarOptions) {
  const avatarKey = buildAvatarKey(avatarOptions);
  const response = await fetch("/api/captures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_data_url: frame.dataUrl,
      image_width: frame.width,
      image_height: frame.height,
      avatar_options: avatarOptions,
      avatar_key: avatarKey,
      style_prompt: avatarKey,
      client_captured_at: new Date().toISOString(),
    }),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("서버 응답을 확인할 수 없습니다.");
  }

  if (!response.ok) {
    const error = new Error(payload.message || "촬영 결과를 저장하지 못했습니다.");
    error.sessionId = payload.session_id;
    throw error;
  }

  return payload;
}

function showResult(payload) {
  showingResult = true;
  resetPoseTracking("다시 촬영하려면 촬영 화면으로 돌아가세요.", "loading");
  capturePreview.src = `${payload.files.original}?v=${Date.now()}`;
  sessionLabel.textContent = `SESSION ${payload.session_id}`;
  cameraStage.hidden = true;
  resultStage.hidden = false;
  retakeButton.hidden = false;
  cameraHelp.textContent = payload.landmark_count > 0
    ? "촬영 사진, 스켈레톤, 33개 좌표가 같은 세션에 저장됐습니다."
    : "촬영 사진은 저장됐으며, 포즈 좌표는 검출되지 않았습니다.";
}

function resetForRetake() {
  showingResult = false;
  resultStage.hidden = true;
  cameraStage.hidden = false;
  retakeButton.hidden = true;
  capturePreview.removeAttribute("src");
  sessionLabel.textContent = "";
  formMessage.textContent = "";
  cameraHelp.textContent = "몸 전체가 보이도록 카메라 앞에 서주세요.";
  resetPoseTracking("포즈 모델 준비 완료 — 촬영할 수 있습니다.", "ready");
  updateButtonState();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const avatarOptions = getAvatarOptions();
  const missingOption = getMissingOption(avatarOptions);

  if (missingOption) {
    formMessage.textContent = `${missingOption.label} 옵션을 선택해주세요.`;
    form.elements[missingOption.name][0].focus();
    return;
  }
  if (!cameraReady || !poseWorkerReady || captureInProgress) return;

  captureInProgress = true;
  formMessage.textContent = "";
  updateButtonState();

  try {
    const frame = captureFrame();
    const payload = await saveCapture(frame, avatarOptions);
    showResult(payload);
  } catch (error) {
    formMessage.textContent = error.message;
    if (error.sessionId) {
      cameraHelp.textContent = `저장 세션: ${error.sessionId}`;
    }
  } finally {
    captureInProgress = false;
    updateButtonState();
  }
});

optionInputs.forEach((input) => input.addEventListener("change", updateOptions));
retryCameraButton.addEventListener("click", startCamera);
retakeButton.addEventListener("click", resetForRetake);
window.addEventListener("beforeunload", () => {
  stopCamera();
  poseWorker.terminate();
});

poseWorker.addEventListener("message", (event) => {
  const { type } = event.data;
  if (type === "READY") {
    poseWorkerReady = true;
    poseConnections = event.data.connections ?? [];
    setPoseState(
      cameraReady
        ? "포즈 모델 준비 완료 — 촬영할 수 있습니다."
        : "카메라 연결을 기다리고 있습니다.",
      cameraReady ? "ready" : "loading",
    );
    updateButtonState();
    return;
  }

  if (type === "RESULT") {
    poseWorkerBusy = false;
    if (showingResult || !cameraReady) return;
    handlePoseResult(event.data.landmarks);
    return;
  }

  if (type === "ERROR") {
    poseWorkerBusy = false;
    console.error("Pose worker error:", event.data.message);
    if (event.data.fatal) {
      poseWorkerReady = false;
      resetPoseTracking("포즈 모델을 불러오지 못했습니다.", "error");
    } else {
      resetPoseTracking("포즈를 다시 인식하고 있습니다.", "loading");
    }
  }
});

poseWorker.postMessage({
  type: "INIT",
  wasmRoot: new URL("/mediapipe/wasm", window.location.origin).href,
  modelUrl: new URL(
    "/models/pose_landmarker_lite.task",
    window.location.origin,
  ).href,
});

updateOptions();
startCamera();
requestAnimationFrame(poseLoop);
