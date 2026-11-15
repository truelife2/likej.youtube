#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本機 Whisper 語音辨識服務（給 YouTube 即時翻譯擴充功能用）

只做「語音 → 文字」，翻譯交給 Gemini 文字模型（在擴充功能裡呼叫）。

啟動：
    start.cmd                        # 用預設模型路徑
    start.cmd --model "D:\\models\\whisper-large-v3-turbo"
    start.cmd --port 8791 --lang en --model "...\\openai_whisper-large-v3-turbo"

API：
    GET  /health          → {"ok":true,"model":"...","device":"cuda"}
    POST /asr             → 身體放 16kHz / 16-bit / 單聲道 PCM，回 {"text":"...","ms":620}
    （可加 header X-Lang: en 指定語言，留空則自動偵測）

注意：模型只在第一次請求時載入（約 6 秒），之後常駐 GPU。
"""
import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

DEFAULT_MODEL = (
    r"C:\ai\ComfyUI_windows_portable\ComfyUI\models\audio_encoders"
    r"\openai_whisper-large-v3-turbo"
)

ASR = None
MODEL = ""
DEVICE = ""
LOCK = threading.Lock()
LOADING = False
SERVER = None


def load_model(path):
    """第一次使用時才載入，避免開機就吃掉 GPU 記憶體。"""
    global ASR, MODEL, DEVICE, LOADING
    if ASR is not None:
        return
    with LOCK:
        if ASR is not None:
            return
        LOADING = True
        try:
            import torch
            from transformers import pipeline

            if not os.path.isdir(path):
                raise RuntimeError("找不到模型資料夾：" + path)

            DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
            dtype = torch.float16 if DEVICE == "cuda" else torch.float32
            t0 = time.time()
            try:
                ASR = pipeline(
                    "automatic-speech-recognition",
                    model=path,
                    device=DEVICE,
                    dtype=dtype,
                )
            except TypeError:  # 舊版 transformers 只認 torch_dtype
                ASR = pipeline(
                    "automatic-speech-recognition",
                    model=path,
                    device=DEVICE,
                    torch_dtype=dtype,
                )
            MODEL = path
            print(
                "[asr] 模型載入完成 %.1fs（device=%s）" % (time.time() - t0, DEVICE),
                flush=True,
            )
        finally:
            LOADING = False


def transcribe(pcm: bytes, lang: str):
    if ASR is None:
        load_model(MODEL)

    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size < 1600:  # 少於 0.1 秒直接當沒有
        return {"text": "", "ms": 0}

    # 近乎靜音就別送進模型：Whisper 在靜音/音樂上會幻覺出 "Thank you." 之類的句子
    rms = float(np.sqrt(np.mean(audio * audio)))
    if rms < 0.004:
        return {"text": "", "ms": 0}

    kwargs = {}
    # 每一句都是獨立音檔，不要讓前一句的結果影響這一句（預設會串接，長片容易愈翻愈歪）。
    # 另外把三個「不要亂編」的門檻設嚴一點：靜音/吵雜會讓 Whisper 生出整段幻覺。
    gen = {
        "condition_on_prev_tokens": False,
        "no_speech_threshold": 0.6,
        "compression_ratio_threshold": 2.4,
        "logprob_threshold": -1.0,
        "temperature": 0.0,
    }
    if lang:
        gen["language"] = lang
    kwargs["generate_kwargs"] = gen

    t0 = time.time()
    with LOCK:
        out = ASR(audio, **kwargs)
    ms = int((time.time() - t0) * 1000)
    text = str((out or {}).get("text", "")).strip()
    return {"text": text, "ms": ms}


MODELS_ROOT = os.environ.get(
    "YTLT_ASR_MODELS_ROOT", r"C:\ai\ComfyUI_windows_portable\ComfyUI\models\audio_encoders"
)


def list_models():
    """掃描 models 根目錄，找出可用的 Whisper（HF 格式：有 config.json + 權重）。"""
    found = []
    try:
        names = sorted(os.listdir(MODELS_ROOT))
    except OSError:
        return found
    for name in names:
        path = os.path.join(MODELS_ROOT, name)
        if not os.path.isdir(path) or not os.path.isfile(os.path.join(path, "config.json")):
            continue
        size = 0
        for f in ("model.safetensors", "pytorch_model.bin", "model.bin"):
            fp = os.path.join(path, f)
            if os.path.isfile(fp):
                size += os.path.getsize(fp)
        found.append({"name": name, "path": path, "mb": int(size / (1024 * 1024))})
    return found


def resolve_model(target: str) -> str:
    """允許三種寫法：完整路徑、models 根目錄下的資料夾名、HuggingFace 模型名稱。"""
    target = (target or "").strip()
    if not target:
        raise ValueError("模型路徑是空的")
    if os.path.isdir(target):
        return target
    for item in list_models():
        if item["name"] == target:
            return item["path"]
    return target  # 交給 transformers 當成 Hub 名稱


def switch_model(target: str) -> int:
    """換模型：先釋放舊模型的顯示記憶體，再載入新的。回傳載入毫秒數。"""
    global ASR, MODEL
    path = resolve_model(target)
    with LOCK:
        ASR = None
    try:
        import gc

        import torch

        gc.collect()
        torch.cuda.empty_cache()
    except Exception:  # 沒有 torch 就略過
        pass
    MODEL = path
    print("[asr] 切換模型：%s" % MODEL, flush=True)
    t0 = time.time()
    load_model(MODEL)
    return int((time.time() - t0) * 1000)


class Handler(BaseHTTPRequestHandler):
    server_version = "YTLT-ASR/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Lang")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path in ("/health", "/asr/health", ""):
            self._json(
                {
                    "ok": True,
                    "model": MODEL,
                    "modelName": os.path.basename(MODEL.rstrip("\\/")),
                    "modelsRoot": MODELS_ROOT,
                    "device": DEVICE,
                    "loading": LOADING,
                }
            )
        elif path in ("/models", "/asr/models"):
            self._json({"ok": True, "root": MODELS_ROOT, "current": MODEL, "models": list_models()})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")

        # 讓擴充功能／原生主機能把服務關掉（只在本機，且 CORS 已限制在 127.0.0.1 存取）
        if path in ("/shutdown", "/asr/shutdown"):
            self._json({"ok": True})
            global SERVER
            if SERVER is not None:
                threading.Thread(target=SERVER.shutdown, daemon=True).start()
            return

        # 換模型（body 可以是 JSON {"path": ...} 或純文字路徑）
        if path in ("/model", "/asr/model"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            raw = self.rfile.read(n).decode("utf-8", "replace").strip() if n > 0 else ""
            target = raw
            if raw.startswith("{"):
                try:
                    target = str((json.loads(raw) or {}).get("path") or "")
                except Exception:  # noqa: BLE001
                    target = ""
            try:
                ms = switch_model(target)
                self._json({"ok": True, "model": MODEL, "ms": ms, "device": DEVICE})
            except Exception as err:  # noqa: BLE001
                self._json({"ok": False, "error": str(err)}, 400)
            return

        if path not in ("/asr", "/v1/asr"):
            self._json({"error": "not found"}, 404)
            return

        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > 20 * 1024 * 1024:
            self._json({"error": "bad content-length"}, 400)
            return

        pcm = self.rfile.read(n)
        lang = (self.headers.get("X-Lang") or "").strip().lower()
        if lang in ("auto", "none"):
            lang = ""

        try:
            # 大型檔案逾時保護：模型沒載入時第一次會比較久
            res = transcribe(pcm, lang)
            res["ok"] = True
            self._json(res)
        except Exception as err:  # noqa: BLE001
            print("[asr] 失敗：", err, flush=True)
            self._json({"ok": False, "error": str(err)}, 500)

    def log_message(self, fmt, *args):  # 靜音，只印重點
        pass


def _port_busy(host: str, port: int) -> bool:
    import socket

    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def warmup():
    """先跑一次假的音訊，把 CUDA kernel 與解碼流程熱起來（第一次請求才不會多等一秒）。"""
    try:
        import numpy as _np

        noise = (_np.random.randn(16000) * 0.02 * 32768).astype("<i2").tobytes()
        t0 = time.time()
        transcribe(noise, "en")
        print("[asr] 暖機完成 %.2fs" % (time.time() - t0), flush=True)
    except Exception as e:  # 暖機失敗不影響正常使用
        print("[asr] 暖機略過：%s" % e, flush=True)


def main():
    global MODEL, MODELS_ROOT, SERVER

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("YTLT_ASR_MODEL", DEFAULT_MODEL))
    ap.add_argument(
        "--models-root",
        default=os.environ.get("YTLT_ASR_MODELS_ROOT", MODELS_ROOT),
        help="掃描這個資料夾底下的 Whisper 模型（popup 的下拉選單用）",
    )
    ap.add_argument("--port", type=int, default=int(os.environ.get("YTLT_ASR_PORT", "8791")))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--lang", default="en", help="預設語言；留空 = 自動偵測")
    ap.add_argument("--preload", action="store_true", help="啟動時就載入模型")
    args = ap.parse_args()

    # 已經有一份在跑就不要重複載入（12GB 顯示記憶體塞不下兩份）
    if _port_busy(args.host, args.port):
        print("[asr] 連接埠 %d 已有服務在執行，這一份結束。" % args.port, flush=True)
        return

    MODEL = args.model
    MODELS_ROOT = args.models_root
    print("[asr] 模型：%s" % MODEL, flush=True)
    print("[asr] 模型資料夾：%s" % MODELS_ROOT, flush=True)

    if args.preload:
        load_model(MODEL)
        warmup()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    SERVER = srv
    print("[asr] 監聽 http://%s:%d  （Ctrl+C 結束）" % (args.host, args.port), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[asr] 結束", flush=True)
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
