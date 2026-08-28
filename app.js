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

const AVATAR_PART_LAYOUT = Object.freeze({
  upperArm: {
    startConnectorRatio: 0.16,
    endConnectorRatio: 0.94,
    thicknessScale: 0.88,
  },
  lowerArm: {
    startConnectorRatio: 0.12,
    endConnectorRatio: 0.94,
    thicknessScale: 0.84,
  },
  thigh: {
    startConnectorRatio: 0.1,
    endConnectorRatio: 0.9,
    thicknessScale: 0.96,
  },
  calf: {
    startConnectorRatio: 0.12,
    endConnectorRatio: 0.94,
    thicknessScale: 0.88,
  },
  pelvis: {
    startConnectorRatio: 0.14,
    endConnectorRatio: 0.86,
    thicknessScale: 1,
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
  } else if (poseName === "neutral") {
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
    startConnectorRatio = 0,
    endConnectorRatio = 1,
    thicknessScale = 1,
    minThickness = 0,
    maxThickness = Number.POSITIVE_INFINITY,
    flipY = false,
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

  element.style.left = `${imageX}px`;
  element.style.top = `${imageY}px`;
  element.style.width = `${length}px`;
  element.style.height = `${thickness}px`;
  element.style.transform = `translateY(-50%) rotate(${angle}rad) scaleY(${flipY ? -1 : 1})`;
  avatarPartGeometry.set(element, {
    type: "segment",
    x: imageX,
    y: imageY,
    width: length,
    height: thickness,
    angle,
    flipY,
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

function updateFoot(element, knee, ankle, heel, toe, shoulderWidth) {
  if (!element || !knee || !ankle || !toe) {
    setPartVisibility(element, false);
    return false;
  }

  const calfLength = Math.hypot(ankle.x - knee.x, ankle.y - knee.y);
  if (calfLength < 2) {
    setPartVisibility(element, false);
    return false;
  }

  const footTarget = heel
    ? {
        x: heel.x * 0.2 + toe.x * 0.8,
        y: heel.y * 0.2 + toe.y * 0.8,
      }
    : toe;
  const directionX = footTarget.x - ankle.x;
  const directionY = footTarget.y - ankle.y;
  if (Math.hypot(directionX, directionY) < 2) {
    setPartVisibility(element, false);
    return false;
  }

  // 발 이미지는 위(발목)에서 아래(발끝)로 그려져 있으므로 세로축을
  // MediaPipe의 발목-발끝 방향에 맞춘다. 뒤꿈치는 발끝 방향의
  // 순간적인 흔들림만 완화하도록 작은 비율로 섞는다.
  const angle = Math.atan2(directionY, directionX) - Math.PI / 2;
  const imageWidth = clamp(
    calfLength * 0.34,
    shoulderWidth * 0.38,
    shoulderWidth * 0.55,
  );

  return updateAnchoredImage(
    element,
    ankle,
    imageWidth,
    angle,
    0.5,
    0.08,
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
  elbow,
  wrist,
  indexFinger,
  pinky,
  thumb,
  shoulderWidth,
) {
  if (!element || !elbow || !wrist) {
    setPartVisibility(element, false);
    return false;
  }

  const forearmX = wrist.x - elbow.x;
  const forearmY = wrist.y - elbow.y;
  const forearmLength = Math.hypot(forearmX, forearmY);
  if (forearmLength < 2) {
    setPartVisibility(element, false);
    return false;
  }

  const handCenter = averagePoint([indexFinger, pinky, thumb]);
  let directionX = handCenter ? handCenter.x - wrist.x : forearmX;
  let directionY = handCenter ? handCenter.y - wrist.y : forearmY;

  if (Math.hypot(directionX, directionY) < shoulderWidth * 0.04) {
    directionX = forearmX;
    directionY = forearmY;
  }

  const imageWidth = clamp(
    forearmLength * 0.28,
    shoulderWidth * 0.2,
    shoulderWidth * 0.3,
  );
  const angle = Math.atan2(directionY, directionX) - Math.PI / 2;

  return updateAnchoredImage(element, wrist, imageWidth, angle, 0.5, 0.12);
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
  const leftPinky = point(17);
  const rightPinky = point(18);
  const leftIndex = point(19);
  const rightIndex = point(20);
  const leftThumb = point(21);
  const rightThumb = point(22);
  const leftHip = point(23);
  const rightHip = point(24);
  const leftKnee = point(25);
  const rightKnee = point(26);
  const leftAnkle = point(27);
  const rightAnkle = point(28);
  const leftHeel = point(29);
  const rightHeel = point(30);
  const leftToe = point(31);
  const rightToe = point(32);

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
    shoulderWidth * 1.25,
    shoulderAngle,
    0.5,
    0.17,
  );
  const upperArmOptions = {
    ...AVATAR_PART_LAYOUT.upperArm,
    minThickness: shoulderWidth * 0.16,
    maxThickness: shoulderWidth * 0.27,
  };
  const lowerArmOptions = {
    ...AVATAR_PART_LAYOUT.lowerArm,
    minThickness: shoulderWidth * 0.14,
    maxThickness: shoulderWidth * 0.23,
  };
  const thighOptions = {
    ...AVATAR_PART_LAYOUT.thigh,
    minThickness: shoulderWidth * 0.27,
    maxThickness: shoulderWidth * 0.4,
  };
  const calfOptions = {
    ...AVATAR_PART_LAYOUT.calf,
    minThickness: shoulderWidth * 0.23,
    maxThickness: shoulderWidth * 0.33,
  };

  updateSegment(
    avatarParts["left-upper-arm"],
    leftShoulder,
    leftElbow,
    { ...upperArmOptions, flipY: true },
  );
  updateSegment(
    avatarParts["left-lower-arm"],
    leftElbow,
    leftWrist,
    { ...lowerArmOptions, flipY: true },
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
    ...AVATAR_PART_LAYOUT.pelvis,
    minThickness: shoulderWidth * 0.3,
    maxThickness: shoulderWidth * 0.48,
  });
  updateSegment(avatarParts["left-thigh"], leftHip, leftKnee, {
    ...thighOptions,
    flipY: true,
  });
  updateSegment(avatarParts["left-calf"], leftKnee, leftAnkle, {
    ...calfOptions,
    flipY: true,
  });
  updateSegment(avatarParts["right-thigh"], rightHip, rightKnee, thighOptions);
  updateSegment(avatarParts["right-calf"], rightKnee, rightAnkle, calfOptions);
  updateFoot(
    avatarParts["left-foot"],
    leftKnee,
    leftAnkle,
    leftHeel,
    leftToe,
    shoulderWidth,
  );
  updateFoot(
    avatarParts["right-foot"],
    rightKnee,
    rightAnkle,
    rightHeel,
    rightToe,
    shoulderWidth,
  );
  updateFist(
    avatarParts["left-fist"],
    leftElbow,
    leftWrist,
    leftIndex,
    leftPinky,
    leftThumb,
    shoulderWidth,
  );
  updateFist(
    avatarParts["right-fist"],
    rightElbow,
    rightWrist,
    rightIndex,
    rightPinky,
    rightThumb,
    shoulderWidth,
  );

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
      earDistance * 2.25,
      shoulderWidth * 0.58,
      shoulderWidth * 0.76,
    );
    const headOriginY = 0.4;
    const headConnectorY = 0.78;
    const headHeight = headWidth / getImageAspectRatio(avatarParts.head);
    const headAngle = Math.atan2(
      leftEar.y - rightEar.y,
      leftEar.x - rightEar.x,
    );
    const shoulderDown = {
      x: -Math.sin(shoulderAngle),
      y: Math.cos(shoulderAngle),
    };
    const neckTarget = {
      x: shoulderCenter.x - shoulderDown.x * shoulderWidth * 0.1,
      y: shoulderCenter.y - shoulderDown.y * shoulderWidth * 0.1,
    };
    const connectorDistance = headHeight * (headConnectorY - headOriginY);
    const connectedAnchor = {
      x: neckTarget.x + Math.sin(headAngle) * connectorDistance,
      y: neckTarget.y - Math.cos(headAngle) * connectorDistance,
    };
    const connectedHeadCenter = {
      x: clamp(
        connectedAnchor.x,
        headCenter.x - headWidth * 0.08,
        headCenter.x + headWidth * 0.08,
      ),
      y: clamp(
        connectedAnchor.y,
        headCenter.y - headHeight * 0.08,
        headCenter.y + headHeight * 0.12,
      ),
    };
    updateAnchoredImage(
      avatarParts.head,
      connectedHeadCenter,
      headWidth,
      headAngle,
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
  if (geometry.flipY) {
    context.scale(1, -1);
  }
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
