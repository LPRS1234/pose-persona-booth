import QRCode from "qrcode";


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
const captureQr = document.querySelector("#capture-qr");
const captureQrCanvas = document.querySelector("#capture-qr-canvas");
const captureQrLink = document.querySelector("#capture-qr-link");
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
const AVATAR_DIRECTION_CONFIDENCE = 0.05;
const SUPPORTED_AVATAR_KEY = "male-police";
const AVATAR_PREVIEW_POSE = new URLSearchParams(window.location.search).get(
  "avatarPreview",
);
const BACKGROUND_IMAGES = {
  "neon-alley": "/backgrounds/neon-alley.png",
  "police-command-center": "/backgrounds/police-command-center.png",
  "sunset-rooftop": "/backgrounds/sunset-rooftop.png",
};
const AVATAR_DRAW_ORDER = [
  "left-foot",
  "right-foot",
  "left-thigh",
  "left-calf",
  "right-thigh",
  "right-calf",
  "pelvis",
  "left-upper-arm",
  "right-upper-arm",
  "torso",
  "left-lower-arm",
  "right-lower-arm",
  "left-fist",
  "right-fist",
  "head",
];

const AVATAR_RIG = Object.freeze({
  torso: {
    width: 1.25,
    originX: 0.5,
    originY: 0.17,
    neckAnchor: { x: 0.5, y: 0.08 },
    waistAnchor: { x: 0.5, y: 0.9 },
  },
  pelvis: {
    parentPart: "torso",
    startAnchor: 0.14,
    endAnchor: 0.86,
    thicknessScale: 1,
    hipSocketSpan: 0.64,
    overlap: 0.36,
    minThickness: 0.3,
    maxThickness: 0.48,
  },
  upperArm: {
    parentPart: "torso",
    startAnchor: 0.16,
    endAnchor: 0.94,
    thicknessScale: 0.88,
    boneLength: 0.72,
    sides: {
      left: { clipStart: 0.48, clipTop: 0.3, startAnchor: 0.5 },
      right: { clipStart: 0.44, clipTop: 0.36, startAnchor: 0.46 },
    },
  },
  lowerArm: {
    parentPart: "upperArm",
    startAnchor: 0.12,
    endAnchor: 0.94,
    thicknessScale: 0.84,
    boneLength: 0.68,
  },
  thigh: {
    parentPart: "pelvis",
    startAnchor: 0.1,
    endAnchor: 0.9,
    thicknessScale: 0.96,
    boneLength: 1.03,
  },
  calf: {
    parentPart: "thigh",
    startAnchor: 0.12,
    endAnchor: 0.94,
    thicknessScale: 0.88,
    boneLength: 0.98,
  },
  fist: {
    parentPart: "lowerArm",
    startAnchor: { x: 0.5, y: 0.12 },
    width: 0.25,
  },
  foot: {
    parentPart: "calf",
    startAnchor: { x: 0.5, y: 0.08 },
    width: 0.46,
  },
  head: {
    parentPart: "torso",
    minWidth: 0.58,
    maxWidth: 0.76,
    fallbackWidth: 0.67,
    originX: 0.5,
    originY: 0.4,
    neckAnchorY: 0.78,
  },
});

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
let captureQrGeneration = 0;
let lastHeadAngle = 0;
const avatarDirectionCache = new Map();

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
    avatarDirectionCache.clear();
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

function createAvatarPreviewLandmarks(poseName) {
  const landmarks = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.2,
    z: 0,
    visibility: 1,
    presence: 1,
  }));
  const place = (index, x, y) => {
    landmarks[index] = { ...landmarks[index], x, y };
  };

  place(0, 0.5, 0.12);
  place(7, 0.535, 0.16);
  place(8, 0.465, 0.16);
  place(11, 0.6, 0.28);
  place(12, 0.4, 0.28);
  place(23, 0.555, 0.54);
  place(24, 0.445, 0.54);
  place(25, 0.565, 0.72);
  place(26, 0.435, 0.72);
  place(27, 0.575, 0.89);
  place(28, 0.425, 0.89);
  place(29, 0.57, 0.915);
  place(30, 0.43, 0.915);
  place(31, 0.59, 0.95);
  place(32, 0.41, 0.95);

  if (poseName === "bent") {
    place(13, 0.7, 0.36);
    place(14, 0.3, 0.36);
    place(15, 0.62, 0.46);
    place(16, 0.38, 0.46);
    place(17, 0.595, 0.49);
    place(18, 0.405, 0.49);
    place(19, 0.6, 0.5);
    place(20, 0.4, 0.5);
    place(21, 0.61, 0.49);
    place(22, 0.39, 0.49);
  } else if (
    [
      "neutral",
      "upper",
      "missing-left",
      "missing-left-leg",
      "close",
      "distant",
      "cropped",
      "cropped-legs",
      "cropped-fallback",
    ].includes(poseName)
  ) {
    place(13, 0.63, 0.42);
    place(14, 0.37, 0.42);
    place(15, 0.61, 0.58);
    place(16, 0.39, 0.58);
    place(17, 0.605, 0.62);
    place(18, 0.395, 0.62);
    place(19, 0.61, 0.625);
    place(20, 0.39, 0.625);
    place(21, 0.615, 0.615);
    place(22, 0.385, 0.615);
  } else {
    place(13, 0.72, 0.28);
    place(14, 0.28, 0.28);
    place(15, 0.84, 0.28);
    place(16, 0.16, 0.28);
    place(17, 0.875, 0.28);
    place(18, 0.125, 0.28);
    place(19, 0.88, 0.28);
    place(20, 0.12, 0.28);
    place(21, 0.87, 0.27);
    place(22, 0.13, 0.27);
  }

  if (poseName === "upper") {
    for (let index = 23; index <= 32; index += 1) {
      landmarks[index] = {
        ...landmarks[index],
        visibility: 0,
        presence: 0,
      };
    }
  }

  if (poseName === "missing-left") {
    for (const index of [13, 15, 17, 19, 21]) {
      landmarks[index] = {
        ...landmarks[index],
        visibility: 0,
        presence: 0,
      };
    }
  }

  if (poseName === "missing-left-leg") {
    for (const index of [23, 25, 27, 29, 31]) {
      landmarks[index] = {
        ...landmarks[index],
        visibility: 0,
        presence: 0,
      };
    }
  }

  if (poseName === "cropped") {
    place(11, 0.72, 0.28);
    place(12, 0.28, 0.28);
    place(13, 0.76, 0.42);
    place(14, 0.24, 0.42);
    place(15, 1.12, 0.58);
    place(16, -0.12, 0.58);
    place(17, 1.16, 0.61);
    place(18, -0.16, 0.61);
    place(19, 1.17, 0.62);
    place(20, -0.17, 0.62);
    place(21, 1.15, 0.6);
    place(22, -0.15, 0.6);
  }

  if (poseName === "cropped" || poseName === "cropped-legs") {
    const kneeY = poseName === "cropped" ? 1.08 : 0.84;
    const ankleY = poseName === "cropped" ? 1.36 : 1.2;
    if (poseName === "cropped-legs") {
      place(11, 0.6, 0.22);
      place(12, 0.4, 0.22);
    }
    place(23, poseName === "cropped" ? 0.62 : 0.565, 0.64);
    place(24, poseName === "cropped" ? 0.38 : 0.435, 0.64);
    place(25, 0.59, kneeY);
    place(26, 0.41, kneeY);
    place(27, 0.6, ankleY);
    place(28, 0.4, ankleY);
    place(29, 0.59, ankleY + 0.04);
    place(30, 0.41, ankleY + 0.04);
    place(31, 0.62, ankleY + 0.07);
    place(32, 0.38, ankleY + 0.07);
  }

  if (poseName === "cropped-fallback") {
    place(11, 0.68, 0.28);
    place(12, 0.32, 0.28);
    place(23, 0.6, 0.62);
    place(24, 0.4, 0.62);
    for (const index of [
      13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 26, 27, 28, 29, 30,
      31, 32,
    ]) {
      landmarks[index] = {
        ...landmarks[index],
        visibility: 0,
        presence: 0,
      };
    }
  }

  if (poseName === "close" || poseName === "distant") {
    const scale = poseName === "close" ? 1.55 : 0.58;
    for (const landmark of landmarks) {
      landmark.x = 0.5 + (landmark.x - 0.5) * scale;
      landmark.y = 0.48 + (landmark.y - 0.48) * scale;
    }
  }

  return landmarks;
}

async function renderAvatarPreview(poseName) {
  form.elements.gender.value = "male";
  form.elements.profession.value = "police";
  updateOptions();
  await Promise.all(Object.values(avatarParts).map(waitForImage));
  renderAvatar(createAvatarPreviewLandmarks(poseName));
  cameraStatus.className = "camera-status is-ready";
  cameraStatus.lastChild.textContent = " 미리보기";
  cameraHelp.textContent = "아바타 파츠 연결을 확인하는 개발용 미리보기입니다.";
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

function getAvatarPoint(
  landmarks,
  index,
  width,
  height,
  minimumConfidence = AVATAR_CONFIDENCE,
) {
  const landmark = landmarks[index];
  if (!landmark || landmarkConfidence(landmark) < minimumConfidence) return null;
  if (
    !Number.isFinite(landmark.x) ||
    !Number.isFinite(landmark.y)
  ) {
    return null;
  }
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

function getRigSegmentOptions(rig) {
  return {
    startConnectorRatio: rig.startAnchor,
    endConnectorRatio: rig.endAnchor,
    thicknessScale: rig.thicknessScale,
  };
}

function updateSegment(
  element,
  start,
  end,
  {
    startConnectorRatio = 0,
    endConnectorRatio = 1,
    thicknessScale = 1,
    minThickness = 0,
    maxThickness = Number.POSITIVE_INFINITY,
    flipY = false,
    clipStartRatio = 0,
    clipTopRatio = 0,
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

  const connectorSpan = endConnectorRatio - startConnectorRatio;
  if (connectorSpan <= 0.05) {
    setPartVisibility(element, false);
    return false;
  }

  const unitX = dx / baseLength;
  const unitY = dy / baseLength;
  const length = baseLength / connectorSpan;
  const startOffset = length * startConnectorRatio;
  const thickness = clamp(
    (length / getImageAspectRatio(element, 3)) * thicknessScale,
    minThickness,
    maxThickness,
  );
  const imageX = start.x - unitX * startOffset;
  const imageY = start.y - unitY * startOffset;
  const angle = Math.atan2(dy, dx);
  const normalizedClipStart = clamp(clipStartRatio, 0, 0.9);
  const normalizedClipTop = clamp(clipTopRatio, 0, 0.9);

  element.style.left = `${imageX}px`;
  element.style.top = `${imageY}px`;
  element.style.width = `${length}px`;
  element.style.height = `${thickness}px`;
  element.style.transform = `translateY(-50%) rotate(${angle}rad) scaleY(${flipY ? -1 : 1})`;
  element.style.clipPath = normalizedClipStart || normalizedClipTop
    ? `inset(${normalizedClipTop * 100}% 0 0 ${normalizedClipStart * 100}%)`
    : "";
  avatarPartGeometry.set(element, {
    type: "segment",
    x: imageX,
    y: imageY,
    width: length,
    height: thickness,
    angle,
    flipY,
    clipStartRatio: normalizedClipStart,
    clipTopRatio: normalizedClipTop,
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

function rotateLocalPoint(geometry, normalizedX, normalizedY) {
  if (!geometry) return null;
  const localX = (normalizedX - geometry.originX) * geometry.width;
  const localY = (normalizedY - geometry.originY) * geometry.height;
  const cosine = Math.cos(geometry.angle);
  const sine = Math.sin(geometry.angle);
  return {
    x: geometry.x + localX * cosine - localY * sine,
    y: geometry.y + localX * sine + localY * cosine,
  };
}

function getDirection(start, end) {
  if (!start || !end) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 2) return null;
  return { x: dx / length, y: dy / length };
}

function normalizeDirection(direction) {
  if (!direction) return null;
  const length = Math.hypot(direction.x, direction.y);
  if (!Number.isFinite(length) || length < 0.001) return null;
  return { x: direction.x / length, y: direction.y / length };
}

function resolveRigDirection(
  directionKey,
  detectedStart,
  detectedEnd,
  fallbackDirection,
) {
  const detectedDirection = getDirection(detectedStart, detectedEnd);
  if (detectedDirection) {
    avatarDirectionCache.set(directionKey, detectedDirection);
    return detectedDirection;
  }

  return (
    avatarDirectionCache.get(directionKey) ??
    normalizeDirection(fallbackDirection)
  );
}

function movePoint(point, direction, distance) {
  return {
    x: point.x + direction.x * distance,
    y: point.y + direction.y * distance,
  };
}

function hideParts(partNames) {
  for (const partName of partNames) {
    setPartVisibility(avatarParts[partName], false);
  }
}

function updateRigSegment(
  element,
  connectedStart,
  detectedStart,
  detectedEnd,
  shoulderWidth,
  rig,
  options,
  directionKey,
  fallbackDirection,
) {
  const direction = resolveRigDirection(
    directionKey,
    detectedStart,
    detectedEnd,
    fallbackDirection,
  );
  if (!connectedStart || !direction) {
    setPartVisibility(element, false);
    return null;
  }

  const connectedEnd = movePoint(
    connectedStart,
    direction,
    shoulderWidth * rig.boneLength,
  );
  if (!updateSegment(element, connectedStart, connectedEnd, options)) {
    return null;
  }
  return connectedEnd;
}

function updateFoot(
  element,
  connectedAnkle,
  ankle,
  heel,
  toe,
  shoulderWidth,
  directionKey,
  fallbackDirection,
) {
  if (!element || !connectedAnkle) {
    setPartVisibility(element, false);
    return false;
  }

  const footTarget = heel && toe
    ? {
        x: heel.x * 0.2 + toe.x * 0.8,
        y: heel.y * 0.2 + toe.y * 0.8,
      }
    : toe;
  const direction = resolveRigDirection(
    directionKey,
    ankle,
    footTarget,
    fallbackDirection,
  );
  if (!direction) {
    setPartVisibility(element, false);
    return false;
  }

  // 발 이미지는 위(발목)에서 아래(발끝)로 그려져 있으므로 세로축을
  // MediaPipe의 발목-발끝 방향에 맞춘다. 뒤꿈치는 발끝 방향의
  // 순간적인 흔들림만 완화하도록 작은 비율로 섞는다.
  const angle = Math.atan2(direction.y, direction.x) - Math.PI / 2;
  const imageWidth = shoulderWidth * AVATAR_RIG.foot.width;

  return updateAnchoredImage(
    element,
    connectedAnkle,
    imageWidth,
    angle,
    0.5,
    AVATAR_RIG.foot.startAnchor.y,
  );
}

function averagePoint(points) {
  const visiblePoints = points.filter(Boolean);
  if (!visiblePoints.length) return null;
  return {
    x:
      visiblePoints.reduce((total, point) => total + point.x, 0) /
      visiblePoints.length,
    y:
      visiblePoints.reduce((total, point) => total + point.y, 0) /
      visiblePoints.length,
  };
}

function updateFist(
  element,
  connectedWrist,
  elbow,
  wrist,
  indexFinger,
  pinky,
  thumb,
  shoulderWidth,
  directionKey,
  fallbackDirection,
) {
  if (!element || !connectedWrist) {
    setPartVisibility(element, false);
    return false;
  }

  const handCenter = averagePoint([indexFinger, pinky, thumb]);
  let directionStart = wrist;
  let directionEnd = handCenter;
  if (!getDirection(directionStart, directionEnd)) {
    directionStart = elbow;
    directionEnd = wrist;
  }
  const direction = resolveRigDirection(
    directionKey,
    directionStart,
    directionEnd,
    fallbackDirection,
  );
  if (!direction) {
    setPartVisibility(element, false);
    return false;
  }

  const imageWidth = shoulderWidth * AVATAR_RIG.fist.width;
  const angle = Math.atan2(direction.y, direction.x) - Math.PI / 2;

  return updateAnchoredImage(
    element,
    connectedWrist,
    imageWidth,
    angle,
    0.5,
    AVATAR_RIG.fist.startAnchor.y,
  );
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
  const directionPoint = (index) =>
    getAvatarPoint(
      landmarks,
      index,
      width,
      height,
      AVATAR_DIRECTION_CONFIDENCE,
    );
  const leftEar = point(7);
  const rightEar = point(8);
  const leftShoulder = point(11);
  const rightShoulder = point(12);
  const leftHip = point(23);
  const rightHip = point(24);
  const leftShoulderDirectionPoint = directionPoint(11);
  const rightShoulderDirectionPoint = directionPoint(12);
  const leftElbowDirectionPoint = directionPoint(13);
  const rightElbowDirectionPoint = directionPoint(14);
  const leftWristDirectionPoint = directionPoint(15);
  const rightWristDirectionPoint = directionPoint(16);
  const leftPinkyDirectionPoint = directionPoint(17);
  const rightPinkyDirectionPoint = directionPoint(18);
  const leftIndexDirectionPoint = directionPoint(19);
  const rightIndexDirectionPoint = directionPoint(20);
  const leftThumbDirectionPoint = directionPoint(21);
  const rightThumbDirectionPoint = directionPoint(22);
  const leftHipDirectionPoint = directionPoint(23);
  const rightHipDirectionPoint = directionPoint(24);
  const leftKneeDirectionPoint = directionPoint(25);
  const rightKneeDirectionPoint = directionPoint(26);
  const leftAnkleDirectionPoint = directionPoint(27);
  const rightAnkleDirectionPoint = directionPoint(28);
  const leftHeelDirectionPoint = directionPoint(29);
  const rightHeelDirectionPoint = directionPoint(30);
  const leftToeDirectionPoint = directionPoint(31);
  const rightToeDirectionPoint = directionPoint(32);

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
  const shoulderDown = {
    x: -Math.sin(shoulderAngle),
    y: Math.cos(shoulderAngle),
  };

  updateAnchoredImage(
    avatarParts.torso,
    shoulderCenter,
    shoulderWidth * AVATAR_RIG.torso.width,
    shoulderAngle,
    AVATAR_RIG.torso.originX,
    AVATAR_RIG.torso.originY,
  );
  const torsoGeometry = avatarPartGeometry.get(avatarParts.torso);
  const neckSocket = rotateLocalPoint(
    torsoGeometry,
    AVATAR_RIG.torso.neckAnchor.x,
    AVATAR_RIG.torso.neckAnchor.y,
  );
  const waistSocket = rotateLocalPoint(
    torsoGeometry,
    AVATAR_RIG.torso.waistAnchor.x,
    AVATAR_RIG.torso.waistAnchor.y,
  );
  const upperArmOptions = {
    ...getRigSegmentOptions(AVATAR_RIG.upperArm),
    minThickness: shoulderWidth * 0.16,
    maxThickness: shoulderWidth * 0.27,
  };
  const leftUpperArmOptions = {
    ...upperArmOptions,
    startConnectorRatio: AVATAR_RIG.upperArm.sides.left.startAnchor,
    clipStartRatio: AVATAR_RIG.upperArm.sides.left.clipStart,
    clipTopRatio: AVATAR_RIG.upperArm.sides.left.clipTop,
    flipY: true,
  };
  const rightUpperArmOptions = {
    ...upperArmOptions,
    startConnectorRatio: AVATAR_RIG.upperArm.sides.right.startAnchor,
    clipStartRatio: AVATAR_RIG.upperArm.sides.right.clipStart,
    clipTopRatio: AVATAR_RIG.upperArm.sides.right.clipTop,
  };
  const lowerArmOptions = {
    ...getRigSegmentOptions(AVATAR_RIG.lowerArm),
    minThickness: shoulderWidth * 0.14,
    maxThickness: shoulderWidth * 0.23,
  };
  const thighOptions = {
    ...getRigSegmentOptions(AVATAR_RIG.thigh),
    minThickness: shoulderWidth * 0.27,
    maxThickness: shoulderWidth * 0.4,
  };
  const calfOptions = {
    ...getRigSegmentOptions(AVATAR_RIG.calf),
    minThickness: shoulderWidth * 0.23,
    maxThickness: shoulderWidth * 0.33,
  };

  const leftConnectedElbow = updateRigSegment(
    avatarParts["left-upper-arm"],
    leftShoulder,
    leftShoulderDirectionPoint,
    leftElbowDirectionPoint ?? leftWristDirectionPoint,
    shoulderWidth,
    AVATAR_RIG.upperArm,
    leftUpperArmOptions,
    "leftUpperArm",
    shoulderDown,
  );
  const leftUpperArmDirection =
    getDirection(leftShoulder, leftConnectedElbow) ?? shoulderDown;
  const leftConnectedWrist = updateRigSegment(
    avatarParts["left-lower-arm"],
    leftConnectedElbow,
    leftElbowDirectionPoint ?? leftShoulderDirectionPoint,
    leftWristDirectionPoint ?? leftIndexDirectionPoint,
    shoulderWidth,
    AVATAR_RIG.lowerArm,
    { ...lowerArmOptions, flipY: true },
    "leftLowerArm",
    leftUpperArmDirection,
  );
  const leftLowerArmDirection =
    getDirection(leftConnectedElbow, leftConnectedWrist) ?? leftUpperArmDirection;
  updateFist(
    avatarParts["left-fist"],
    leftConnectedWrist,
    leftElbowDirectionPoint,
    leftWristDirectionPoint,
    leftIndexDirectionPoint,
    leftPinkyDirectionPoint,
    leftThumbDirectionPoint,
    shoulderWidth,
    "leftFist",
    leftLowerArmDirection,
  );

  const rightConnectedElbow = updateRigSegment(
    avatarParts["right-upper-arm"],
    rightShoulder,
    rightShoulderDirectionPoint,
    rightElbowDirectionPoint ?? rightWristDirectionPoint,
    shoulderWidth,
    AVATAR_RIG.upperArm,
    rightUpperArmOptions,
    "rightUpperArm",
    shoulderDown,
  );
  const rightUpperArmDirection =
    getDirection(rightShoulder, rightConnectedElbow) ?? shoulderDown;
  const rightConnectedWrist = updateRigSegment(
    avatarParts["right-lower-arm"],
    rightConnectedElbow,
    rightElbowDirectionPoint ?? rightShoulderDirectionPoint,
    rightWristDirectionPoint ?? rightIndexDirectionPoint,
    shoulderWidth,
    AVATAR_RIG.lowerArm,
    lowerArmOptions,
    "rightLowerArm",
    rightUpperArmDirection,
  );
  const rightLowerArmDirection =
    getDirection(rightConnectedElbow, rightConnectedWrist) ?? rightUpperArmDirection;
  updateFist(
    avatarParts["right-fist"],
    rightConnectedWrist,
    rightElbowDirectionPoint,
    rightWristDirectionPoint,
    rightIndexDirectionPoint,
    rightPinkyDirectionPoint,
    rightThumbDirectionPoint,
    shoulderWidth,
    "rightFist",
    rightLowerArmDirection,
  );

  if ((leftHip || rightHip) && waistSocket) {
    const detectedHipDirection = getDirection(
      leftHipDirectionPoint,
      rightHipDirectionPoint,
    );
    const fallbackHipDirection = {
      x: -Math.cos(shoulderAngle),
      y: -Math.sin(shoulderAngle),
    };
    const hipDirection = detectedHipDirection ?? fallbackHipDirection;
    const pelvisTargetThickness = shoulderWidth * AVATAR_RIG.pelvis.maxThickness;
    const pelvisCenter = movePoint(
      waistSocket,
      shoulderDown,
      pelvisTargetThickness * (0.5 - AVATAR_RIG.pelvis.overlap),
    );
    const halfHipSpan = shoulderWidth * AVATAR_RIG.pelvis.hipSocketSpan * 0.5;
    const leftHipSocket = movePoint(pelvisCenter, hipDirection, -halfHipSpan);
    const rightHipSocket = movePoint(pelvisCenter, hipDirection, halfHipSpan);

    updateSegment(avatarParts.pelvis, leftHipSocket, rightHipSocket, {
      ...getRigSegmentOptions(AVATAR_RIG.pelvis),
      minThickness: shoulderWidth * AVATAR_RIG.pelvis.minThickness,
      maxThickness: shoulderWidth * AVATAR_RIG.pelvis.maxThickness,
      flipY: true,
    });

    const leftConnectedKnee = updateRigSegment(
      avatarParts["left-thigh"],
      leftHip ? leftHipSocket : null,
      leftHipDirectionPoint,
      leftKneeDirectionPoint ?? leftAnkleDirectionPoint,
      shoulderWidth,
      AVATAR_RIG.thigh,
      { ...thighOptions, flipY: true },
      "leftThigh",
      shoulderDown,
    );
    const leftThighDirection =
      getDirection(leftHipSocket, leftConnectedKnee) ?? shoulderDown;
    const leftConnectedAnkle = updateRigSegment(
      avatarParts["left-calf"],
      leftConnectedKnee,
      leftKneeDirectionPoint ?? leftHipDirectionPoint,
      leftAnkleDirectionPoint ?? leftToeDirectionPoint,
      shoulderWidth,
      AVATAR_RIG.calf,
      { ...calfOptions, flipY: true },
      "leftCalf",
      leftThighDirection,
    );
    const leftCalfDirection =
      getDirection(leftConnectedKnee, leftConnectedAnkle) ?? leftThighDirection;
    updateFoot(
      avatarParts["left-foot"],
      leftConnectedAnkle,
      leftAnkleDirectionPoint,
      leftHeelDirectionPoint,
      leftToeDirectionPoint,
      shoulderWidth,
      "leftFoot",
      leftCalfDirection,
    );

    const rightConnectedKnee = updateRigSegment(
      avatarParts["right-thigh"],
      rightHip ? rightHipSocket : null,
      rightHipDirectionPoint,
      rightKneeDirectionPoint ?? rightAnkleDirectionPoint,
      shoulderWidth,
      AVATAR_RIG.thigh,
      thighOptions,
      "rightThigh",
      shoulderDown,
    );
    const rightThighDirection =
      getDirection(rightHipSocket, rightConnectedKnee) ?? shoulderDown;
    const rightConnectedAnkle = updateRigSegment(
      avatarParts["right-calf"],
      rightConnectedKnee,
      rightKneeDirectionPoint ?? rightHipDirectionPoint,
      rightAnkleDirectionPoint ?? rightToeDirectionPoint,
      shoulderWidth,
      AVATAR_RIG.calf,
      calfOptions,
      "rightCalf",
      rightThighDirection,
    );
    const rightCalfDirection =
      getDirection(rightConnectedKnee, rightConnectedAnkle) ?? rightThighDirection;
    updateFoot(
      avatarParts["right-foot"],
      rightConnectedAnkle,
      rightAnkleDirectionPoint,
      rightHeelDirectionPoint,
      rightToeDirectionPoint,
      shoulderWidth,
      "rightFoot",
      rightCalfDirection,
    );
  } else {
    hideParts([
      "pelvis",
      "left-thigh",
      "left-calf",
      "left-foot",
      "right-thigh",
      "right-calf",
      "right-foot",
    ]);
  }

  if (neckSocket) {
    let headAngle = lastHeadAngle || shoulderAngle;
    let headWidth = shoulderWidth * AVATAR_RIG.head.fallbackWidth;
    if (leftEar && rightEar) {
      const earDistance = Math.hypot(
        rightEar.x - leftEar.x,
        rightEar.y - leftEar.y,
      );
      headWidth = clamp(
        earDistance * 2.25,
        shoulderWidth * AVATAR_RIG.head.minWidth,
        shoulderWidth * AVATAR_RIG.head.maxWidth,
      );
      headAngle = Math.atan2(
        leftEar.y - rightEar.y,
        leftEar.x - rightEar.x,
      );
      lastHeadAngle = headAngle;
    }
    const headHeight = headWidth / getImageAspectRatio(avatarParts.head);
    const connectorDistance =
      headHeight * (AVATAR_RIG.head.neckAnchorY - AVATAR_RIG.head.originY);
    const connectedHeadAnchor = {
      x: neckSocket.x + Math.sin(headAngle) * connectorDistance,
      y: neckSocket.y - Math.cos(headAngle) * connectorDistance,
    };
    updateAnchoredImage(
      avatarParts.head,
      connectedHeadAnchor,
      headWidth,
      headAngle,
      AVATAR_RIG.head.originX,
      AVATAR_RIG.head.originY,
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
  if (geometry.flipY) {
    context.scale(1, -1);
  }
  context.shadowColor = "rgba(49, 220, 255, 0.46)";
  context.shadowBlur = 5 * scale;

  if (geometry.type === "segment") {
    const clipStart = geometry.clipStartRatio ?? 0;
    const clipTop = geometry.clipTopRatio ?? 0;
    if (clipStart > 0 || clipTop > 0) {
      const sourceX = image.naturalWidth * clipStart;
      const sourceY = image.naturalHeight * clipTop;
      const sourceWidth = image.naturalWidth - sourceX;
      const sourceHeight = image.naturalHeight - sourceY;
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        geometry.width * clipStart,
        -geometry.height / 2 + geometry.height * clipTop,
        geometry.width * (1 - clipStart),
        geometry.height * (1 - clipTop),
      );
    } else {
      context.drawImage(
        image,
        0,
        -geometry.height / 2,
        geometry.width,
        geometry.height,
      );
    }
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

function resetCaptureQr() {
  captureQrGeneration += 1;
  captureQr.hidden = true;
  captureQrLink.removeAttribute("href");
  const context = captureQrCanvas.getContext("2d");
  context.clearRect(0, 0, captureQrCanvas.width, captureQrCanvas.height);
}

async function renderCaptureQr(payload) {
  resetCaptureQr();
  const generation = captureQrGeneration;
  const sharePath = payload.share_url || payload.files?.original;
  if (!sharePath) return;

  try {
    const shareUrl = new URL(sharePath, window.location.origin).href;
    await QRCode.toCanvas(captureQrCanvas, shareUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 160,
      color: {
        dark: "#071015",
        light: "#ffffff",
      },
    });
    if (generation !== captureQrGeneration) return;
    captureQrLink.href = shareUrl;
    captureQr.hidden = false;
  } catch (error) {
    console.error("QR code error:", error);
  }
}

function showResult(payload) {
  showingResult = true;
  resetPoseTracking("다시 촬영하려면 촬영 화면으로 돌아가세요.", "loading");
  poseReadiness.hidden = true;
  capturePreview.src = `${payload.files.original}?v=${Date.now()}`;
  sessionLabel.textContent = `SESSION ${payload.session_id}`;
  cameraStage.hidden = true;
  resultStage.hidden = false;
  retakeButton.hidden = false;
  cameraHelp.textContent = "배경과 아바타가 합성된 최종 사진이 세션에 저장됐습니다.";
  void renderCaptureQr(payload);
}

function resetForRetake() {
  showingResult = false;
  poseReadiness.hidden = false;
  resultStage.hidden = true;
  cameraStage.hidden = false;
  retakeButton.hidden = true;
  capturePreview.removeAttribute("src");
  resetCaptureQr();
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

updateOptions();
if (AVATAR_PREVIEW_POSE) {
  void renderAvatarPreview(AVATAR_PREVIEW_POSE);
} else {
  poseWorker.postMessage({
    type: "INIT",
    wasmRoot: new URL("/mediapipe/wasm", window.location.origin).href,
    modelUrl: new URL(
      "/models/pose_landmarker_lite.task",
      window.location.origin,
    ).href,
  });
  startCamera();
  requestAnimationFrame(poseLoop);
}

