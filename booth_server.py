import base64
import binascii
import json
import mimetypes
import threading
import uuid
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

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


ROOT_DIR = Path(__file__).resolve().parent
MODEL_PATH = ROOT_DIR / "pose_landmarker_lite.task"
WEB_ROOT = ROOT_DIR / "dist"
SESSIONS_DIR = ROOT_DIR / "sessions"
HOST = "127.0.0.1"
PORT = 8000
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_STYLE_LENGTH = 300
MAX_IMAGE_PIXELS = 16_000_000

POSE_LANDMARK_NAMES = (
    "nose",
    "left_eye_inner",
    "left_eye",
    "left_eye_outer",
    "right_eye_inner",
    "right_eye",
    "right_eye_outer",
    "left_ear",
    "right_ear",
    "mouth_left",
    "mouth_right",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_pinky",
    "right_pinky",
    "left_index",
    "right_index",
    "left_thumb",
    "right_thumb",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
    "left_heel",
    "right_heel",
    "left_foot_index",
    "right_foot_index",
)


def now_iso():
    return datetime.now().astimezone().isoformat()


def create_session_id():
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    return f"{timestamp}_{uuid.uuid4().hex[:8]}"


def write_json(path, data):
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    with temporary_path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
    temporary_path.replace(path)


def decode_image_data_url(data_url):
    if not isinstance(data_url, str) or "," not in data_url:
        raise ValueError("촬영 이미지 형식이 올바르지 않습니다.")

    header, encoded = data_url.split(",", 1)
    if header not in ("data:image/jpeg;base64", "data:image/png;base64"):
        raise ValueError("JPEG 또는 PNG 이미지만 사용할 수 있습니다.")

    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("촬영 이미지 데이터를 해석할 수 없습니다.") from error

    encoded_image = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(encoded_image, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("촬영 이미지를 열 수 없습니다.")

    height, width = image.shape[:2]
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise ValueError("촬영 이미지 크기가 허용 범위를 벗어났습니다.")
    return image


def serialize_landmarks(landmarks, width, height):
    points = []
    for index, landmark in enumerate(landmarks):
        points.append(
            {
                "id": index,
                "name": POSE_LANDMARK_NAMES[index],
                "x": float(landmark.x),
                "y": float(landmark.y),
                "z": float(landmark.z),
                "pixel_x": int(round(landmark.x * width)),
                "pixel_y": int(round(landmark.y * height)),
                "visibility": float(landmark.visibility),
                "presence": float(landmark.presence),
            }
        )
    return points


class PoseCaptureService:
    def __init__(self):
        if not MODEL_PATH.exists():
            raise FileNotFoundError(f"포즈 모델을 찾을 수 없습니다: {MODEL_PATH}")

        options = PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(MODEL_PATH)),
            running_mode=RunningMode.IMAGE,
        )
        self.landmarker = PoseLandmarker.create_from_options(options)
        self.lock = threading.Lock()

    def close(self):
        self.landmarker.close()

    def capture(self, image, style_prompt, client_captured_at=None):
        session_id = create_session_id()
        session_dir = SESSIONS_DIR / session_id
        session_dir.mkdir(parents=True, exist_ok=False)
        captured_at = now_iso()
        height, width = image.shape[:2]

        request_data = {
            "session_id": session_id,
            "captured_at": captured_at,
            "client_captured_at": client_captured_at,
            "style_prompt": style_prompt,
            "image_width": width,
            "image_height": height,
        }
        write_json(session_dir / "request.json", request_data)
        write_json(
            session_dir / "status.json",
            {
                "session_id": session_id,
                "status": "processing_pose",
                "updated_at": now_iso(),
            },
        )

        if not cv2.imwrite(str(session_dir / "original.png"), image):
            self._mark_failed(session_dir, session_id, "원본 이미지를 저장하지 못했습니다.")
            raise OSError("원본 이미지를 저장하지 못했습니다.")

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        with self.lock:
            result = self.landmarker.detect(mp_image)

        landmarks = result.pose_landmarks[0] if result.pose_landmarks else []
        skeleton = np.zeros_like(image)
        if landmarks:
            drawing_utils.draw_landmarks(
                skeleton,
                landmarks,
                PoseLandmarksConnections.POSE_LANDMARKS,
                landmark_drawing_spec=drawing_styles.get_default_pose_landmarks_style(),
            )
        if not cv2.imwrite(str(session_dir / "skeleton.png"), skeleton):
            self._mark_failed(session_dir, session_id, "스켈레톤 이미지를 저장하지 못했습니다.")
            raise OSError("스켈레톤 이미지를 저장하지 못했습니다.")

        landmarks_data = {
            "session_id": session_id,
            "captured_at": captured_at,
            "image_width": width,
            "image_height": height,
            "pose_detected": bool(landmarks),
            "landmark_count": len(landmarks),
            "landmarks": serialize_landmarks(landmarks, width, height),
        }
        write_json(session_dir / "landmarks.json", landmarks_data)
        write_json(
            session_dir / "status.json",
            {
                "session_id": session_id,
                "status": "captured",
                "pose_detected": bool(landmarks),
                "updated_at": now_iso(),
                "files": {
                    "original": "original.png",
                    "skeleton": "skeleton.png",
                    "landmarks": "landmarks.json",
                    "request": "request.json",
                    "avatar": None,
                },
            },
        )
        return session_id, landmarks_data, None

    @staticmethod
    def _mark_failed(session_dir, session_id, message):
        write_json(
            session_dir / "status.json",
            {
                "session_id": session_id,
                "status": "failed",
                "message": message,
                "updated_at": now_iso(),
            },
        )


class BoothRequestHandler(BaseHTTPRequestHandler):
    service = None

    def do_GET(self):
        route = unquote(urlparse(self.path).path)
        if route.startswith("/sessions/"):
            relative_path = route.removeprefix("/sessions/")
            self._send_session_file(relative_path)
            return

        self._send_web_file(route)

    def do_POST(self):
        route = urlparse(self.path).path
        if route != "/api/captures":
            self._send_json(HTTPStatus.NOT_FOUND, {"message": "API를 찾을 수 없습니다."})
            return

        try:
            payload = self._read_json_body()
            style_prompt = self._validate_style_prompt(payload.get("style_prompt"))
            image = decode_image_data_url(payload.get("image_data_url"))
            session_id, landmarks_data, error_message = self.service.capture(
                image,
                style_prompt,
                payload.get("client_captured_at"),
            )
        except (ValueError, json.JSONDecodeError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"message": str(error)})
            return
        except OSError as error:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"message": str(error)})
            return
        except Exception as error:
            print(f"Capture error: {error}")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"message": "촬영 처리 중 오류가 발생했습니다."},
            )
            return

        if error_message:
            self._send_json(
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {"session_id": session_id, "message": error_message},
            )
            return

        base_url = f"/sessions/{session_id}"
        self._send_json(
            HTTPStatus.CREATED,
            {
                "session_id": session_id,
                "pose_detected": landmarks_data["pose_detected"],
                "landmark_count": landmarks_data["landmark_count"],
                "status": "captured",
                "files": {
                    "original": f"{base_url}/original.png",
                    "skeleton": f"{base_url}/skeleton.png",
                    "landmarks": f"{base_url}/landmarks.json",
                    "request": f"{base_url}/request.json",
                },
            },
        )

    def _read_json_body(self):
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
        if content_type != "application/json":
            raise ValueError("요청 형식은 application/json이어야 합니다.")

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("요청 크기를 확인할 수 없습니다.") from error
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            raise ValueError("요청 크기가 허용 범위를 벗어났습니다.")

        body = self.rfile.read(content_length)
        return json.loads(body.decode("utf-8"))

    @staticmethod
    def _validate_style_prompt(value):
        if not isinstance(value, str):
            raise ValueError("원하는 스타일을 입력해주세요.")
        value = value.strip()
        if not value:
            raise ValueError("원하는 스타일을 입력해주세요.")
        if len(value) > MAX_STYLE_LENGTH:
            raise ValueError(f"스타일은 {MAX_STYLE_LENGTH}자 이하로 입력해주세요.")
        if any(ord(character) < 32 and character not in "\n\t" for character in value):
            raise ValueError("스타일에 사용할 수 없는 문자가 포함되어 있습니다.")
        return value

    def _send_session_file(self, relative_path):
        candidate = (SESSIONS_DIR / relative_path).resolve()
        sessions_root = SESSIONS_DIR.resolve()
        try:
            candidate.relative_to(sessions_root)
        except ValueError:
            self._send_json(HTTPStatus.FORBIDDEN, {"message": "접근할 수 없는 경로입니다."})
            return

        if not candidate.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"message": "파일을 찾을 수 없습니다."})
            return
        if candidate.name not in {
            "original.png",
            "skeleton.png",
            "landmarks.json",
            "request.json",
            "status.json",
            "avatar.png",
        }:
            self._send_json(HTTPStatus.FORBIDDEN, {"message": "제공할 수 없는 파일입니다."})
            return
        self._send_file(candidate)

    def _send_web_file(self, route):
        relative_path = "index.html" if route == "/" else route.lstrip("/")
        candidate = (WEB_ROOT / relative_path).resolve()
        web_root = WEB_ROOT.resolve()
        try:
            candidate.relative_to(web_root)
        except ValueError:
            self._send_json(HTTPStatus.FORBIDDEN, {"message": "접근할 수 없는 경로입니다."})
            return

        if not candidate.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"message": "페이지를 찾을 수 없습니다."})
            return
        self._send_file(candidate)

    def _send_file(self, path):
        if not path.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"message": "파일을 찾을 수 없습니다."})
            return

        content_type, _ = mimetypes.guess_type(path.name)
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self._send_common_headers()
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _send_json(self, status, data):
        content = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _send_common_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Permissions-Policy", "camera=(self), microphone=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; "
            "media-src 'self' blob:; style-src 'self'; "
            "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
            "connect-src 'self'; frame-ancestors 'none'",
        )

    def log_message(self, format_string, *args):
        print(f"[{self.log_date_time_string()}] {format_string % args}")


def main():
    if not (WEB_ROOT / "index.html").exists():
        raise FileNotFoundError(
            "웹 빌드 결과를 찾을 수 없습니다. 먼저 'npm.cmd run build'를 실행하세요."
        )
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    service = PoseCaptureService()
    BoothRequestHandler.service = service
    server = ThreadingHTTPServer((HOST, PORT), BoothRequestHandler)

    print(f"Pose Persona 서버가 실행 중입니다: http://localhost:{PORT}")
    print("종료하려면 Ctrl+C를 누르세요.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
    finally:
        server.server_close()
        service.close()


if __name__ == "__main__":
    main()
