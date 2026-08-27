import json
import time
from datetime import datetime
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    PoseLandmarker,
    PoseLandmarkerOptions,
    PoseLandmarksConnections,
    RunningMode,
    drawing_styles,
    drawing_utils,
)


MODEL_PATH = Path(__file__).with_name("pose_landmarker_lite.task")
CAPTURE_DIR = Path(__file__).with_name("captures")
CAMERA_INDEX = 0


def make_skeleton_image(frame_shape, landmarks):
    """검은 배경에 MediaPipe의 33개 포즈 랜드마크만 그린다."""
    skeleton = np.zeros(frame_shape, dtype=np.uint8)
    drawing_utils.draw_landmarks(
        skeleton,
        landmarks,
        PoseLandmarksConnections.POSE_LANDMARKS,
        landmark_drawing_spec=drawing_styles.get_default_pose_landmarks_style(),
    )
    return skeleton


def landmarks_to_dict(landmarks, frame_width, frame_height):
    """33개 랜드마크를 정규화 좌표와 픽셀 좌표로 변환한다."""
    points = []
    for index, landmark in enumerate(landmarks):
        points.append(
            {
                "id": index,
                "x": float(landmark.x),
                "y": float(landmark.y),
                "z": float(landmark.z),
                "pixel_x": int(round(landmark.x * frame_width)),
                "pixel_y": int(round(landmark.y * frame_height)),
                "visibility": float(landmark.visibility),
                "presence": float(landmark.presence),
            }
        )
    return points


def save_capture(frame, skeleton, landmarks):
    """원본, 스켈레톤, 좌표 JSON을 동일한 타임스탬프로 저장한다."""
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    height, width = frame.shape[:2]

    original_path = CAPTURE_DIR / f"original_{timestamp}.png"
    skeleton_path = CAPTURE_DIR / f"skeleton_{timestamp}.png"
    landmarks_path = CAPTURE_DIR / f"landmarks_{timestamp}.json"

    original_saved = cv2.imwrite(str(original_path), frame)
    skeleton_saved = cv2.imwrite(str(skeleton_path), skeleton)
    if not original_saved or not skeleton_saved:
        raise OSError("PNG 파일을 저장하지 못했습니다.")

    data = {
        "captured_at": datetime.now().astimezone().isoformat(),
        "image_width": width,
        "image_height": height,
        "landmark_count": len(landmarks),
        "landmarks": landmarks_to_dict(landmarks, width, height),
    }
    with landmarks_path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)

    return original_path, skeleton_path, landmarks_path


def main():
    if not MODEL_PATH.exists():
        raise FileNotFoundError(
            f"포즈 모델을 찾을 수 없습니다: {MODEL_PATH}\n"
            "pose_landmarker_lite.task 파일을 같은 폴더에 두세요."
        )

    options = PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=RunningMode.VIDEO,
    )

    camera = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)
    if not camera.isOpened():
        raise RuntimeError("웹캠을 열 수 없습니다.")

    start = time.monotonic()
    last_timestamp_ms = -1

    print("S: 현재 포즈 저장 | Q: 종료")

    try:
        with PoseLandmarker.create_from_options(options) as landmarker:
            while True:
                ok, frame = camera.read()
                if not ok:
                    print("웹캠 프레임을 읽지 못했습니다.")
                    break

                frame = cv2.flip(frame, 1)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

                timestamp_ms = int((time.monotonic() - start) * 1000)
                timestamp_ms = max(timestamp_ms, last_timestamp_ms + 1)
                last_timestamp_ms = timestamp_ms
                result = landmarker.detect_for_video(mp_image, timestamp_ms)

                display = frame.copy()
                skeleton = np.zeros_like(frame)
                landmarks = None

                if result.pose_landmarks:
                    landmarks = result.pose_landmarks[0]
                    drawing_utils.draw_landmarks(
                        display,
                        landmarks,
                        PoseLandmarksConnections.POSE_LANDMARKS,
                        landmark_drawing_spec=(
                            drawing_styles.get_default_pose_landmarks_style()
                        ),
                    )
                    skeleton = make_skeleton_image(frame.shape, landmarks)
                    status = "POSE DETECTED - Press S to capture"
                    status_color = (0, 255, 0)
                else:
                    status = "NO POSE"
                    status_color = (0, 0, 255)

                cv2.putText(
                    display,
                    status,
                    (20, 35),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    status_color,
                    2,
                    cv2.LINE_AA,
                )
                cv2.imshow("Pose Camera", display)

                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    break
                if key == ord("s"):
                    if landmarks is None:
                        print("저장하지 않았습니다: 포즈가 검출되지 않았습니다.")
                        continue

                    try:
                        paths = save_capture(frame, skeleton, landmarks)
                    except OSError as error:
                        print(f"저장 실패: {error}")
                    else:
                        print("저장 완료:")
                        for path in paths:
                            print(f"  {path}")
    finally:
        camera.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
