import base64
import binascii
import json
import mimetypes
import struct
import uuid
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT_DIR = Path(__file__).resolve().parent
WEB_ROOT = ROOT_DIR / "dist"
SESSIONS_DIR = ROOT_DIR / "sessions"
HOST = "127.0.0.1"
PORT = 8000
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000


def create_session_id():
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    return f"{timestamp}_{uuid.uuid4().hex[:8]}"


def decode_image_data_url(data_url):
    if not isinstance(data_url, str) or "," not in data_url:
        raise ValueError("촬영 이미지 형식이 올바르지 않습니다.")

    header, encoded = data_url.split(",", 1)
    if header != "data:image/png;base64":
        raise ValueError("PNG 이미지만 사용할 수 있습니다.")

    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("촬영 이미지 데이터를 해석할 수 없습니다.") from error

    png_signature = b"\x89PNG\r\n\x1a\n"
    if len(image_bytes) < 24 or not image_bytes.startswith(png_signature):
        raise ValueError("촬영 PNG 파일이 올바르지 않습니다.")

    width, height = struct.unpack(">II", image_bytes[16:24])
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise ValueError("촬영 이미지 크기가 허용 범위를 벗어났습니다.")
    return image_bytes


class PoseCaptureService:
    def capture(self, image_bytes):
        session_id = create_session_id()
        session_dir = SESSIONS_DIR / session_id
        session_dir.mkdir(parents=True, exist_ok=False)

        try:
            (session_dir / "original.png").write_bytes(image_bytes)
        except OSError as error:
            raise OSError("원본 이미지를 저장하지 못했습니다.")

        return session_id


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
            image_bytes = decode_image_data_url(payload.get("image_data_url"))
            session_id = self.service.capture(image_bytes)
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

        base_url = f"/sessions/{session_id}"
        self._send_json(
            HTTPStatus.CREATED,
            {
                "session_id": session_id,
                "status": "captured",
                "files": {
                    "original": f"{base_url}/original.png",
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


if __name__ == "__main__":
    main()
