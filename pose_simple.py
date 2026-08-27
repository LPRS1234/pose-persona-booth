import os
import time
import urllib.request


import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    PoseLandmarker,
    PoseLandmarkerOptions,
    RunningMode,
    PoseLandmarksConnections,
    drawing_utils,
    drawing_styles,
)


# --- 모델 파일 준비 (처음 한 번만 다운로드, 약 5MB) ---
MODEL = "pose_landmarker_lite.task"
if not os.path.exists(MODEL):
    print("모델 다운로드 중...")
    urllib.request.urlretrieve(
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
        MODEL,
    )


# --- STEP 3: 포즈 검출기 설정 ---
options = PoseLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=MODEL),
    running_mode=RunningMode.VIDEO,      # 웹캠 영상이므로 VIDEO
)


# --- STEP 1: 웹캠 연결 ---
cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)   # 맥/리눅스는 cv2.CAP_DSHOW 빼기
start = time.monotonic()


with PoseLandmarker.create_from_options(options) as landmarker:
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame = cv2.flip(frame, 1)         # 거울처럼 보이게


        # OpenCV 이미지(BGR) -> MediaPipe 이미지(RGB)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)


        # 흘러간 시간(ms)을 같이 넘겨야 한다
        ms = int((time.monotonic() - start) * 1000)
        result = landmarker.detect_for_video(image, ms)


        if result.pose_landmarks:
            lms = result.pose_landmarks[0]   # 첫 번째 사람의 관절 33개


            # 뼈대 그리기
            drawing_utils.draw_landmarks(
                frame,
                lms,
                PoseLandmarksConnections.POSE_LANDMARKS,
                landmark_drawing_spec=drawing_styles.get_default_pose_landmarks_style(),
            )


            # --- STEP 4: 주요 관절 좌표 표시 ---
            h, w = frame.shape[:2]
            for i in (0, 11, 12, 15, 16, 25, 26, 27, 28):
                lm = lms[i]
                px, py = int(lm.x * w), int(lm.y * h)   # 0~1 -> 픽셀
                cv2.putText(frame, f"{i}:({px},{py})", (px + 6, py - 6),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)


        # --- STEP 2: 화면 출력 ---
        cv2.imshow("Pose", frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break


cap.release()
cv2.destroyAllWindows()