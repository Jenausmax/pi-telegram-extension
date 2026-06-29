#!/usr/bin/env python3
"""Локальный STT-сервис для pi-telegram-extension (faster-whisper).

Запускается самим extension'ом из venv. Слушает loopback.
  GET  /health      -> {"status":"ok","model": "<model>"}
  POST /transcribe  -> тело: сырые байты аудио (.oga); ответ {"text","language","duration"}
Конфиг через env: STT_MODEL (small), STT_LANGUAGE (ru), STT_COMPUTE (int8), STT_PORT (8765).
"""
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("STT_MODEL", "small")
LANGUAGE = os.environ.get("STT_LANGUAGE", "ru")
COMPUTE = os.environ.get("STT_COMPUTE", "int8")
PORT = int(os.environ.get("STT_PORT", "8765"))

print(f"[stt] loading faster-whisper model={MODEL} compute={COMPUTE} ...", flush=True)
from faster_whisper import WhisperModel  # noqa: E402

model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE)
print("[stt] model loaded", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok", "model": MODEL})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            self._json(400, {"error": "empty body"})
            return
        data = self.rfile.read(length)
        tmp = tempfile.NamedTemporaryFile(suffix=".oga", delete=False)
        try:
            tmp.write(data)
            tmp.flush()
            tmp.close()
            segments, info = model.transcribe(tmp.name, language=LANGUAGE)
            text = "".join(seg.text for seg in segments).strip()
            self._json(200, {"text": text, "language": info.language, "duration": info.duration})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": str(e)})
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    def log_message(self, *args):  # тише в лог
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[stt] listening on 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
