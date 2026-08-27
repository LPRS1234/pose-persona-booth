const form = document.querySelector("#capture-form");
const optionInputs = [...form.querySelectorAll('input[type="radio"]')];
const formMessage = document.querySelector("#form-message");
const captureButton = document.querySelector("#capture-button");
const captureButtonText = document.querySelector("#capture-button-text");
const video = document.querySelector("#camera-video");
const sceneBackground = document.querySelector("#scene-background");
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
const avatarPartGeometry = new Map();
const poseReadiness = document.querySelector("#pose-readiness");
const poseMessage = document.querySelector("#pose-message");

const POSE_INPUT_WIDTH = 640;
const POSE_INPUT_HEIGHT = 360;
const POSE_INTERVAL_MS = 80;
const STABLE_FRAME_COUNT = 6;
const AVATAR_SMOOTHING = 0.35;
const AVATAR_CONFIDENCE = 0.3;
const SUPPORTED_AVATAR_KEY = "male-police";
const BACKGROUND_IMAGES = {
  "neon-alley": "/backgrounds/neon-alley.png",
  "police-command-center": "/backgrounds/police-command-center.png",
  "sunset-rooftop": "/backgrounds/sunset-rooftop.png",
};
const AVATAR_DRAW_ORDER = [
  "left-thigh",
  "left-calf",
  "right-thigh",
  "right-calf",
  "pelvis",
  "torso",
  "left-upper-arm",
  "left-lower-arm",
  "right-upper-arm",
  "right-lower-arm",
  "head",
];

const poseInputCanvas = document.createElement("canvas");
poseInputCanvas.width = POSE_INPUT_WIDTH;
poseInputCanvas.height = POSE_INPUT_HEIGHT;
const poseInputContext = poseInputCanvas.getContext("2d", { alpha: false });

const poseWorker = new Worker(new URL("./pose-worker.js", import.meta.url));

let cameraStream = null;
let cameraReady = false;
let captureInProgress = false;
let showingResult = false;
let poseWorkerReady = false;
let poseWorkerBusy = false;
let poseReady = false;
let stablePoseFrames = 0;
let lastPoseFrameAt = 0;
let smoothedLandmarks = null;

function getAvatarOptions() {
  return {
    gender: form.elements.gender.value || null,
    profession: form.elements.profession.value || null,
    background: form.elements.background.value || null,
  };
}

function getMissingOption(options) {
  if (!options.gender) return { name: "gender", label: "성별" };
  if (!options.profession) return { name: "profession", label: "직업" };
  if (!options.background) return { name: "background", label: "배경" };
  return null;
}

function buildAvatarKey(options) {
  return `${options.gender}-${options.profession}`;
}

function updateButtonState() {
  const options = getAvatarOptions();
  const missingOption = getMissingOption(options);
  const avatarSupported = isSupportedAvatar(options);
  captureButton.disabled =
    !cameraReady ||
    !poseWorkerReady ||
    Boolean(missingOption) ||
    !avatarSupported ||
    !poseReady ||
    captureInProgress ||
    showingResult;

  if (showingResult) {
    captureButtonText.textContent = "촬영 완료";
  } else if (captureInProgress) {
    captureButtonText.textContent = "최종 화면을 저장하는 중";
  } else if (!cameraReady) {
    captureButtonText.textContent = "카메라 준비 중";
  } else if (!poseWorkerReady) {
    captureButtonText.textContent = "포즈 모델 준비 중";
  } else if (missingOption) {
    captureButtonText.textContent = `${missingOption.label}을 선택하세요`;
  } else if (!avatarSupported) {
    captureButtonText.textContent = "선택한 아바타 준비 중";
  } else if (!poseReady) {
    captureButtonText.textContent = "포즈를 인식하는 중";
  } else {
    captureButtonText.textContent = "지금 촬영하기";
  }
}

function updateOptions() {
  formMessage.textContent = "";
  updateSceneBackground();
  updateAvatarTheme();
  updateButtonState();
}

function updateSceneBackground() {
  const background = form.elements.background.value;
  const imageUrl = BACKGROUND_IMAGES[background];
  if (!imageUrl) return;

  sceneBackground.src = imageUrl;
  cameraStage.dataset.background = background;
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
  clearAvatarOverlay(true);
  setPoseState(message, state);
  updateButtonState();
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
    formMessage.textContent = "현재 남성 · 경찰 아바타만 준비되어 있습니다.";
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
  if (!element) return;
  element.hidden = !visible;
  if (!visible) {
    avatarPartGeometry.delete(element);
  }
}

function getImageAspectRatio(element, fallback = 1) {
  if (!element?.naturalWidth || !element?.naturalHeight) return fallback;
  return element.naturalWidth / element.naturalHeight;
}

function updateSegment(
  element,
  start,
  end,
  {
    startPaddingRatio = 0.08,
    endPaddingRatio = startPaddingRatio,
    thicknessScale = 1,
    minThickness = 0,
  } = {},
) {
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

  const startPadding = baseLength * startPaddingRatio;
  const endPadding = baseLength * endPaddingRatio;
  const unitX = dx / baseLength;
  const unitY = dy / baseLength;
  const length = baseLength + startPadding + endPadding;
  const thickness = Math.max(
    (length / getImageAspectRatio(element, 3)) * thicknessScale,
    minThickness,
  );

  element.style.left = `${start.x - unitX * startPadding}px`;
  element.style.top = `${start.y - unitY * startPadding}px`;
  element.style.width = `${length}px`;
  element.style.height = `${thickness}px`;
  element.style.transform = `translateY(-50%) rotate(${Math.atan2(dy, dx)}rad)`;
  avatarPartGeometry.set(element, {
    type: "segment",
    x: start.x - unitX * startPadding,
    y: start.y - unitY * startPadding,
    width: length,
    height: thickness,
    angle: Math.atan2(dy, dx),
  });
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
  avatarPartGeometry.set(element, {
    type: "anchored",
    x: anchor.x,
    y: anchor.y,
    width: imageWidth,
    height: imageHeight,
    angle,
    originX,
    originY,
  });
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
    leftShoulder.y - rightShoulder.y,
    leftShoulder.x - rightShoulder.x,
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
    0.08,
  );
  const upperArmOptions = {
    startPaddingRatio: 0.24,
    endPaddingRatio: 0.3,
    thicknessScale: 1.35,
    minThickness: shoulderWidth * 0.2,
  };
  const lowerArmOptions = {
    startPaddingRatio: 0.3,
    endPaddingRatio: 0.28,
    thicknessScale: 1.3,
    minThickness: shoulderWidth * 0.18,
  };
  const thighOptions = {
    startPaddingRatio: 0.24,
    endPaddingRatio: 0.32,
    thicknessScale: 1.45,
    minThickness: shoulderWidth * 0.28,
  };
  const calfOptions = {
    startPaddingRatio: 0.32,
    endPaddingRatio: 0.28,
    thicknessScale: 1.35,
    minThickness: shoulderWidth * 0.22,
  };

  updateSegment(
    avatarParts["left-upper-arm"],
    leftShoulder,
    leftElbow,
    upperArmOptions,
  );
  updateSegment(
    avatarParts["left-lower-arm"],
    leftElbow,
    leftWrist,
    lowerArmOptions,
  );
  updateSegment(
    avatarParts["right-upper-arm"],
    rightShoulder,
    rightElbow,
    upperArmOptions,
  );
  updateSegment(
    avatarParts["right-lower-arm"],
    rightElbow,
    rightWrist,
    lowerArmOptions,
  );
  updateSegment(avatarParts.pelvis, leftHip, rightHip, {
    startPaddingRatio: 0.25,
    endPaddingRatio: 0.25,
    thicknessScale: 1.12,
    minThickness: shoulderWidth * 0.25,
  });
  updateSegment(avatarParts["left-thigh"], leftHip, leftKnee, thighOptions);
  updateSegment(avatarParts["left-calf"], leftKnee, leftAnkle, calfOptions);
  updateSegment(avatarParts["right-thigh"], rightHip, rightKnee, thighOptions);
  updateSegment(avatarParts["right-calf"], rightKnee, rightAnkle, calfOptions);

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
      earDistance * 2.35,
      shoulderWidth * 1.25,
      shoulderWidth * 1.55,
    );
    const headOriginY = 0.52;
    const headHeight = headWidth / getImageAspectRatio(avatarParts.head);
    const connectionFloorY =
      shoulderCenter.y + shoulderWidth * 0.02 - headHeight * (1 - headOriginY);
    const connectedHeadCenter = {
      x: headCenter.x,
      y: clamp(
        connectionFloorY,
        headCenter.y,
        headCenter.y + headHeight * 0.08,
      ),
    };
    updateAnchoredImage(
      avatarParts.head,
      connectedHeadCenter,
      headWidth,
      Math.atan2(leftEar.y - rightEar.y, leftEar.x - rightEar.x),
      0.5,
      headOriginY,
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

function handlePoseResult(landmarks) {
  const inspection = inspectPose(landmarks);
  if (!inspection.valid) {
    stablePoseFrames = 0;
    poseReady = false;
    clearAvatarOverlay(true);
    setPoseState(inspection.message, "missing");
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

function waitForImage(image) {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return image.decode();
}

function drawImageCover(context, image, width, height) {
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const canvasRatio = width / height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = image.naturalWidth;
  let sourceHeight = image.naturalHeight;

  if (imageRatio > canvasRatio) {
    sourceWidth = image.naturalHeight * canvasRatio;
    sourceX = (image.naturalWidth - sourceWidth) / 2;
  } else {
    sourceHeight = image.naturalWidth / canvasRatio;
    sourceY = (image.naturalHeight - sourceHeight) / 2;
  }

  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );
}

function drawSceneShade(context, width, height, background) {
  const isSunset = background === "sunset-rooftop";
  const centerX = width * 0.5;
  const centerY = height * (isSunset ? 0.42 : 0.45);
  const innerRadius = Math.min(width, height) * (isSunset ? 0.1 : 0.18);
  const outerRadius = Math.hypot(width, height) * 0.58;
  const shade = context.createRadialGradient(
    centerX,
    centerY,
    innerRadius,
    centerX,
    centerY,
    outerRadius,
  );
  shade.addColorStop(0, isSunset ? "rgba(0, 0, 0, 0.1)" : "rgba(0, 0, 0, 0)");
  shade.addColorStop(1, isSunset ? "rgba(0, 0, 0, 0.24)" : "rgba(0, 0, 0, 0.1)");
  context.fillStyle = shade;
  context.fillRect(0, 0, width, height);
}

function drawAvatarPart(context, image, geometry, scale) {
  if (!geometry || image.hidden || image.naturalWidth <= 0) return;

  context.save();
  context.translate(geometry.x, geometry.y);
  context.rotate(geometry.angle);
  context.shadowColor = "rgba(49, 220, 255, 0.46)";
  context.shadowBlur = 5 * scale;

  if (geometry.type === "segment") {
    context.drawImage(
      image,
      0,
      -geometry.height / 2,
      geometry.width,
      geometry.height,
    );
  } else {
    context.drawImage(
      image,
      -geometry.width * geometry.originX,
      -geometry.height * geometry.originY,
      geometry.width,
      geometry.height,
    );
  }
  context.restore();
}

async function captureCompositeFrame() {
  const stageWidth = cameraStage.clientWidth;
  const stageHeight = cameraStage.clientHeight;
  if (
    !stageWidth ||
    !stageHeight ||
    !poseReady ||
    avatarOverlay.dataset.visible !== "true"
  ) {
    throw new Error("합성할 아바타 포즈가 아직 준비되지 않았습니다.");
  }

  await Promise.all([
    waitForImage(sceneBackground),
    ...Object.values(avatarParts).map(waitForImage),
  ]);

  const width = sceneBackground.naturalWidth || 1672;
  const height = Math.round(width * (stageHeight / stageWidth));
  const scaleX = width / stageWidth;
  const scaleY = height / stageHeight;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  drawImageCover(context, sceneBackground, width, height);
  drawSceneShade(context, width, height, getAvatarOptions().background);

  context.save();
  context.translate(width, 0);
  context.scale(-scaleX, scaleY);
  for (const partName of AVATAR_DRAW_ORDER) {
    const image = avatarParts[partName];
    drawAvatarPart(context, image, avatarPartGeometry.get(image), scaleX);
  }
  context.restore();

  return {
    width,
    height,
    dataUrl: canvas.toDataURL("image/png"),
  };
}

async function saveCapture(frame) {
  const response = await fetch("/api/captures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_data_url: frame.dataUrl,
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
  cameraHelp.textContent = "배경과 아바타가 합성된 최종 사진이 세션에 저장됐습니다.";
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
  if (
    !cameraReady ||
    !poseWorkerReady ||
    !poseReady ||
    !isSupportedAvatar(avatarOptions) ||
    captureInProgress
  ) return;

  captureInProgress = true;
  formMessage.textContent = "";
  updateButtonState();

  try {
    const frame = await captureCompositeFrame();
    const payload = await saveCapture(frame);
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
