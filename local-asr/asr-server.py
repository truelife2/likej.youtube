#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本機 Whisper 語音辨識服務（給 YouTube 即時翻譯擴充功能用）

做「語音 → 文字」，翻譯預設交給 Gemini 文字模型（在擴充功能裡呼叫），
也可以改用這支服務的 /translate（外接本機 LLM），完全不吃 Gemini 額度。
另外提供通用的 TTS（文字 → 語音）介面，讓本機 Whisper 模式也能配音；
實際的語音模型由 command / http 後端接上。

啟動：
    start.cmd                        # 用預設模型路徑
    start.cmd --model "D:\\models\\whisper-large-v3-turbo"
    start.cmd --port 8791 --lang en --model "...\\openai_whisper-large-v3-turbo"
    start.cmd --tts-backend command --tts-cmd "python my_tts.py --text {textfile} --out {out}"

API：
    GET  /health          → {"ok":true,"model":"...","device":"cuda","tts":{...}}
    POST /asr             → 身體放 16kHz / 16-bit / 單聲道 PCM，回 {"text":"...","ms":620}
    （可加 header X-Lang: en 指定語言，留空則自動偵測）
    POST /tts             → body {"text":"...","lang":"zh-Hant","voice":""}
                            回 {"ok":true,"rate":24000,"pcm":"<base64 int16 單聲道>"}
    POST /translate       → body {"text":"...","lang":"zh-Hant"}
                            回 {"ok":true,"text":"...","ms":120}
    （翻譯可走 OpenAI 相容的 HTTP 服務，或外部指令）

注意：模型只在第一次請求時載入（約 6 秒），之後常駐 GPU。
"""
import argparse
import base64
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# 設定也可以寫在 local-asr\config.json（設定頁／原生主機會寫這個檔）。
# 優先順序：命令列參數 > 環境變數 > config.json > 內建預設。
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def read_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:  # noqa: BLE001
        return {}


CONFIG = read_config()

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


# ---------------------------------------------------------------------------
# TTS（通用介面）
#   任何語音模型都能接：把它包成「讀一個文字檔、寫出一個 WAV」的指令，
#   或開一個吃 JSON 的 HTTP 服務。擴充功能只認 /tts 這一種介面。
#   設定（環境變數或命令列參數皆可）：
#     YTLT_TTS_BACKEND = none | edge | sapi | command | http
#     YTLT_TTS_CMD     = 例：python my_tts.py --text "{textfile}" --out "{out}" --voice "{voice}"
#                        （可用的替代字：{text} {textfile} {out} {lang} {voice}）
#     YTLT_TTS_URL     = 例：http://127.0.0.1:9880/tts（POST JSON {text,lang,voice}）
#     YTLT_TTS_VOICE   = 預設音色（擴充功能沒指定時使用）
#   回應格式：{"ok":true,"rate":24000,"pcm":"<base64，16-bit 單聲道 PCM>"}
# ---------------------------------------------------------------------------
TTS_BACKEND = (
    os.environ.get("YTLT_TTS_BACKEND") or str(CONFIG.get("ttsBackend") or "") or "none"
).strip().lower()
TTS_CMD = (os.environ.get("YTLT_TTS_CMD") or str(CONFIG.get("ttsCmd") or "") or "").strip()
TTS_URL = (os.environ.get("YTLT_TTS_URL") or str(CONFIG.get("ttsUrl") or "") or "").strip()
TTS_VOICE = (
    os.environ.get("YTLT_TTS_VOICE") or str(CONFIG.get("ttsVoice") or "") or ""
).strip()
try:
    TTS_TIMEOUT = float(os.environ.get("YTLT_TTS_TIMEOUT", "30") or "30")
except ValueError:
    TTS_TIMEOUT = 30.0
TTS_DEFAULT_RATE = 24000  # 後端只給裸 PCM 時，假設是這個取樣率
TTS_DIR = os.path.dirname(os.path.abspath(__file__))
TTS_DEFAULT_VOICE = {
    "edge": "zh-TW-HsiaoChenNeural",
    "sapi": "Microsoft Hanhan Desktop",
}
TTS_LOCK = threading.Lock()


def tts_voice_for(backend: str = "") -> str:
    """實際會用到的音色（沒指定或跟引擎不合時用該引擎的預設）。"""
    b = backend or TTS_BACKEND
    v = TTS_VOICE
    if b == "edge" and (not v or not v.endswith("Neural")):
        return TTS_DEFAULT_VOICE["edge"]
    if b == "sapi" and (not v or "Neural" in v):
        return TTS_DEFAULT_VOICE["sapi"]
    return v or TTS_DEFAULT_VOICE.get(b, "")


def tts_ready() -> bool:
    if TTS_BACKEND == "edge":
        return os.path.isfile(os.path.join(TTS_DIR, "tts-edge.py"))
    if TTS_BACKEND == "sapi":
        return os.path.isfile(os.path.join(TTS_DIR, "tts-sapi.ps1"))
    if TTS_BACKEND == "command":
        return bool(TTS_CMD)
    if TTS_BACKEND == "http":
        return bool(TTS_URL)
    return False


def wav_to_pcm16(data: bytes):
    """WAV → (取樣率, 16-bit 單聲道 PCM)。支援 PCM 8/16/24/32-bit 與 float32/64。"""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("語音模型輸出不是 WAV（需要 RIFF/WAVE）")
    fmt = None
    body = None
    pos = 12
    while pos + 8 <= len(data):
        cid = data[pos : pos + 4]
        size = int.from_bytes(data[pos + 4 : pos + 8], "little")
        chunk = data[pos + 8 : pos + 8 + size]
        pos += 8 + size + (size & 1)
        if cid == b"fmt ":
            fmt = chunk
        elif cid == b"data":
            body = chunk
            break
    if not fmt or body is None or len(fmt) < 16:
        raise ValueError("WAV 缺少 fmt 或 data 區塊")

    codec = int.from_bytes(fmt[0:2], "little")
    channels = int.from_bytes(fmt[2:4], "little") or 1
    rate = int.from_bytes(fmt[4:8], "little") or TTS_DEFAULT_RATE
    bits = int.from_bytes(fmt[14:16], "little")

    if codec == 3:  # IEEE float
        arr = np.frombuffer(body, dtype="<f8" if bits == 64 else "<f4").astype(np.float32)
        arr = np.clip(arr, -1.0, 1.0) * 32767.0
    elif codec == 1:  # 整數 PCM
        if bits == 8:
            arr = (np.frombuffer(body, dtype=np.uint8).astype(np.float32) - 128.0) * 256.0
        elif bits == 16:
            arr = np.frombuffer(body, dtype="<i2").astype(np.float32)
        elif bits == 24:
            raw = np.frombuffer(body, dtype=np.uint8)
            raw = raw[: raw.size - raw.size % 3].reshape(-1, 3).astype(np.int32)
            v = raw[:, 0] | (raw[:, 1] << 8) | (raw[:, 2] << 16)
            v = np.where(v >= (1 << 23), v - (1 << 24), v)
            arr = (v >> 8).astype(np.float32)
        elif bits == 32:
            arr = np.frombuffer(body, dtype="<i4").astype(np.float64) / 65536.0
        else:
            raise ValueError("不支援的 WAV 位元深度：%d" % bits)
    else:
        raise ValueError("不支援的 WAV 格式（codec=%d；請輸出 PCM 或 float WAV）" % codec)

    arr = arr.reshape(-1, channels).mean(axis=1) if channels > 1 else arr.reshape(-1)
    pcm = np.clip(arr, -32768, 32767).astype("<i2").tobytes()
    return int(rate), pcm


def tts_exec(cmd: str, text: str, lang: str, voice: str):
    """執行一個產 WAV 的指令；{textfile}{out}{lang}{voice}{text} 會被代入。"""
    import subprocess
    import tempfile

    tmp = tempfile.mkdtemp(prefix="ytts_")
    txt_path = os.path.join(tmp, "in.txt")
    out_path = os.path.join(tmp, "out.wav")
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(text)

    for key, val in (
        ("{textfile}", txt_path),
        ("{out}", out_path),
        ("{lang}", lang or ""),
        ("{voice}", voice or ""),
        ("{text}", text),
    ):
        cmd = cmd.replace(key, val)

    try:
        proc = subprocess.run(
            cmd, shell=True, cwd=tmp, capture_output=True, timeout=TTS_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("TTS 指令逾時（%.0f 秒）" % TTS_TIMEOUT)

    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace").strip()
        raise RuntimeError("TTS 指令失敗（%d）：%s" % (proc.returncode, err[-300:] or cmd))
    if not os.path.isfile(out_path):
        raise RuntimeError("TTS 指令沒有產出 {out} 指定的 WAV 檔")

    with open(out_path, "rb") as f:
        return wav_to_pcm16(f.read())


def tts_command(text: str, lang: str, voice: str):
    """把文字交給外部指令，讀回它寫出的 WAV。"""
    return tts_exec(TTS_CMD, text, lang, voice)


def tts_edge(text: str, lang: str, voice: str):
    """內建的 Edge TTS 指令稿（需要網路）。"""
    script = os.path.join(TTS_DIR, "tts-edge.py")
    if not os.path.isfile(script):
        raise RuntimeError("找不到 tts-edge.py（應該跟 asr-server.py 放在一起）")
    if not voice or not voice.endswith("Neural"):
        voice = TTS_DEFAULT_VOICE["edge"]  # 避免把 SAPI 音色名餵給 Edge
    cmd = '"%s" "%s" --file "{textfile}" --out "{out}" --voice "{voice}"' % (
        sys.executable,
        script,
    )
    return tts_exec(cmd, text, lang, voice)


def tts_sapi(text: str, lang: str, voice: str):
    """內建的 Windows SAPI 指令稿（完全離線）。"""
    script = os.path.join(TTS_DIR, "tts-sapi.ps1")
    if not os.path.isfile(script):
        raise RuntimeError("找不到 tts-sapi.ps1（應該跟 asr-server.py 放在一起）")
    if not voice or "Neural" in voice:
        voice = TTS_DEFAULT_VOICE["sapi"]
    cmd = (
        'powershell -NoProfile -ExecutionPolicy Bypass -File "%s" '
        '-File "{textfile}" -Out "{out}" -Voice "{voice}"'
    ) % script
    return tts_exec(cmd, text, lang, voice)


def tts_http(text: str, lang: str, voice: str):
    """把文字 POST 給另一個 TTS 服務；回應可以是 JSON 或 WAV 檔。"""
    import urllib.request

    body = json.dumps(
        {"text": text, "lang": lang or "", "voice": voice or ""}, ensure_ascii=False
    ).encode("utf-8")
    req = urllib.request.Request(
        TTS_URL, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=TTS_TIMEOUT) as res:
        ctype = (res.headers.get("Content-Type") or "").lower()
        raw = res.read()

    if "json" in ctype:
        obj = json.loads(raw.decode("utf-8", "replace")) or {}
        rate = int(obj.get("rate") or TTS_DEFAULT_RATE)
        if obj.get("pcm"):
            return rate, base64.b64decode(obj["pcm"])
        if obj.get("audio"):
            return wav_to_pcm16(base64.b64decode(obj["audio"]))
        raise RuntimeError("TTS 服務回應缺少 pcm 或 audio 欄位")
    return wav_to_pcm16(raw)


def synthesize(text: str, lang: str, voice: str):
    if not tts_ready():
        raise RuntimeError(
            "這個服務沒有接上語音模型（YTLT_TTS_BACKEND=%s）。"
            "請看 local-asr/README.md 的「TTS 介面」設定。" % TTS_BACKEND
        )
    voice = voice or TTS_VOICE
    # 多數語音模型不支援同時推論，排隊處理
    with TTS_LOCK:
        if TTS_BACKEND == "edge":
            return tts_edge(text, lang, voice)
        if TTS_BACKEND == "sapi":
            return tts_sapi(text, lang, voice)
        if TTS_BACKEND == "command":
            return tts_command(text, lang, voice)
        return tts_http(text, lang, voice)


# ---------------------------------------------------------------------------
# 本機翻譯（通用介面）：POST /translate  {"text":"...","lang":"zh-Hant"}
#   後端三選一（預設 none）：
#     YTLT_TRANSLATE_BACKEND = none | http | command
#     YTLT_TRANSLATE_MODEL   = 送給 http 伺服器的 model 名稱（llama.cpp 的 -a）
#     YTLT_TRANSLATE_URL     = http 後端（OpenAI 相容 /v1/chat/completions，
#                              或任何回 {"text": ...} 的服務）
#     YTLT_TRANSLATE_KEY     = http 後端的 Bearer token（本機服務多半不用）
#     YTLT_TRANSLATE_CMD     = command 後端：原文從 stdin 進去、譯文從 stdout 出來
#     YTLT_TRANSLATE_SRC     = 來源語言（只給 command 後端的 {src} 用）
#   回應格式：{"ok":true,"text":"...","ms":120,"backend":"http"}
# ---------------------------------------------------------------------------
TR_BACKEND = (
    os.environ.get("YTLT_TRANSLATE_BACKEND")
    or str(CONFIG.get("translateBackend") or "")
    or "none"
).strip().lower()
TR_MODEL = (
    os.environ.get("YTLT_TRANSLATE_MODEL")
    or str(CONFIG.get("translateModel") or "")
    or ""
).strip()
TR_URL = (
    os.environ.get("YTLT_TRANSLATE_URL") or str(CONFIG.get("translateUrl") or "") or ""
).strip()
TR_KEY = (os.environ.get("YTLT_TRANSLATE_KEY", "") or "").strip()
TR_CMD = (
    os.environ.get("YTLT_TRANSLATE_CMD") or str(CONFIG.get("translateCmd") or "") or ""
).strip()
TR_SRC = (
    os.environ.get("YTLT_TRANSLATE_SRC") or str(CONFIG.get("translateSrc") or "") or "en"
).strip()
try:
    TR_TIMEOUT = float(os.environ.get("YTLT_TRANSLATE_TIMEOUT", "30") or "30")
except ValueError:
    TR_TIMEOUT = 30.0

TR_LOCK = threading.RLock()

# 擴充功能送來的是 BCP-47（zh-Hant、en…），翻譯提示詞需要看得懂的名字
TR_LANG_NAME = {
    "zh": "繁體中文（台灣）",
    "zh-hant": "繁體中文（台灣）",
    "zh-tw": "繁體中文（台灣）",
    "zh_hant": "繁體中文（台灣）",
    "zho_hant": "繁體中文（台灣）",
    "zh-hans": "简体中文",
    "zh-cn": "简体中文",
    "zh_hans": "简体中文",
    "zho_hans": "简体中文",
    "en": "英文",
    "en-us": "英文",
    "en-gb": "英文",
    "eng": "英文",
    "eng_latn": "英文",
    "ja": "日文",
    "ja-jp": "日文",
    "jpn": "日文",
    "ko": "韓文",
    "ko-kr": "韓文",
    "kor": "韓文",
}


def tr_lang_name(value, default="繁體中文（台灣）"):
    return TR_LANG_NAME.get((value or "").strip().lower(), default)


def translate_ready() -> bool:
    if TR_BACKEND == "http":
        return bool(TR_URL)
    if TR_BACKEND == "command":
        return bool(TR_CMD)
    return False


def translate_http(text: str, target: str, src: str):
    """打 OpenAI 相容的 /v1/chat/completions（llama.cpp、Ollama、LM Studio…）。"""
    import urllib.request

    name = tr_lang_name(target)
    system = (
        "你是即時字幕翻譯器。把使用者給的句子翻成%s，只輸出譯文本身："
        "不要解釋、不要引號、不要保留原文、不要加「譯：」之類的前綴。" % name
    )
    body = {
        "model": TR_MODEL or "local",
        "temperature": 0,
        "stream": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if TR_KEY:
        headers["Authorization"] = "Bearer " + TR_KEY
    req = urllib.request.Request(
        TR_URL, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers=headers
    )
    with urllib.request.urlopen(req, timeout=TR_TIMEOUT) as res:
        raw = res.read()

    try:
        obj = json.loads(raw.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return raw.decode("utf-8", "replace").strip()

    if isinstance(obj, dict):
        for key in ("text", "translation", "output"):
            if obj.get(key):
                return str(obj[key]).strip()
        choices = obj.get("choices") or []
        if choices:
            msg = choices[0].get("message") or {}
            out = msg.get("content")
            if isinstance(out, list):  # 少數伺服器回 content parts
                out = "".join(
                    (p.get("text") or "") if isinstance(p, dict) else str(p) for p in out
                )
            if out:
                return str(out).strip()
    raise RuntimeError("翻譯服務回應沒有 text／choices[0].message.content 欄位")


def translate_command(text: str, target: str, src: str):
    """把原文從 stdin 餵給外部指令，讀 stdout 當譯文。"""
    import subprocess

    cmd = TR_CMD.replace("{lang}", target or "zh-Hant").replace("{src}", src or "")
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=TR_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("翻譯指令逾時（%.0f 秒）" % TR_TIMEOUT)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace").strip()
        raise RuntimeError("翻譯指令失敗（%d）：%s" % (proc.returncode, err[-300:] or cmd))
    return proc.stdout.decode("utf-8", "replace").strip()


def translate_text(text: str, target: str, src: str):
    if not translate_ready():
        raise RuntimeError(
            "這個服務沒有接上翻譯模型（YTLT_TRANSLATE_BACKEND=%s）。"
            "請看 local-asr/README.md 的「翻譯介面」設定。" % TR_BACKEND
        )
    # 同一時間只跑一個推論，避免搶 GPU 讓每句都變慢
    with TR_LOCK:
        if TR_BACKEND == "http":
            out = translate_http(text, target, src)
        else:
            out = translate_command(text, target, src)
    # 去掉模型偶爾加的引號與多餘空白
    return out.strip().strip("\"“”「」『』").strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "YTLT-ASR/1.2"

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
                    "tts": {
                        "backend": TTS_BACKEND,
                        "ready": tts_ready(),
                        "voice": tts_voice_for(),
                    },
                    "translate": {
                        "backend": TR_BACKEND,
                        "ready": translate_ready(),
                        "model": TR_MODEL,
                        "url": TR_URL,
                    },
                }
            )
        elif path in ("/translate/health", "/translate_info"):
            self._json(
                {
                    "ok": True,
                    "backend": TR_BACKEND,
                    "ready": translate_ready(),
                    "model": TR_MODEL,
                    "src": TR_SRC,
                }
            )
        elif path in ("/tts/health", "/tts_info"):
            self._json(
                {
                    "ok": True,
                    "backend": TTS_BACKEND,
                    "ready": tts_ready(),
                    "voice": tts_voice_for(),
                    "timeout": TTS_TIMEOUT,
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

        # 通用 TTS：body {"text": "...", "lang": "zh-Hant", "voice": ""}
        if path in ("/tts", "/v1/tts"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n <= 0 or n > 256 * 1024:
                self._json({"ok": False, "error": "bad content-length"}, 400)
                return
            raw = self.rfile.read(n).decode("utf-8", "replace")
            try:
                obj = json.loads(raw) or {}
            except Exception:  # noqa: BLE001
                self._json({"ok": False, "error": "body 必須是 JSON"}, 400)
                return

            text = str(obj.get("text") or "").strip()
            if not text:
                self._json({"ok": False, "error": "text 是空的"}, 400)
                return
            text = text[:2000]  # 一句話不會更長，避免被餵整篇文章
            lang = str(obj.get("lang") or "zh").strip()
            voice = str(obj.get("voice") or "").strip()

            t0 = time.time()
            try:
                rate, pcm = synthesize(text, lang, voice)
            except Exception as err:  # noqa: BLE001
                print("[tts] 失敗：", err, flush=True)
                code = 501 if not tts_ready() else 500
                self._json({"ok": False, "error": str(err)}, code)
                return
            self._json(
                {
                    "ok": True,
                    "rate": rate,
                    "pcm": base64.b64encode(pcm).decode("ascii"),
                    "ms": int((time.time() - t0) * 1000),
                    "backend": TTS_BACKEND,
                }
            )
            return

        # 通用翻譯：body {"text": "...", "lang": "zh-Hant", "src": "en"}
        if path in ("/translate", "/v1/translate"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n <= 0 or n > 256 * 1024:
                self._json({"ok": False, "error": "bad content-length"}, 400)
                return
            raw = self.rfile.read(n).decode("utf-8", "replace")
            try:
                obj = json.loads(raw) or {}
            except Exception:  # noqa: BLE001
                self._json({"ok": False, "error": "body 必須是 JSON"}, 400)
                return

            text = str(obj.get("text") or "").strip()
            if not text:
                self._json({"ok": False, "error": "text 是空的"}, 400)
                return
            text = text[:2000]
            target = str(obj.get("lang") or obj.get("target") or "zh-Hant").strip()
            src = str(obj.get("src") or obj.get("source") or TR_SRC).strip()

            t0 = time.time()
            try:
                out = translate_text(text, target, src)
            except Exception as err:  # noqa: BLE001
                print("[tr] 失敗：", err, flush=True)
                code = 501 if not translate_ready() else 500
                self._json({"ok": False, "error": str(err)}, code)
                return
            self._json(
                {
                    "ok": True,
                    "text": out,
                    "ms": int((time.time() - t0) * 1000),
                    "backend": TR_BACKEND,
                }
            )
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
    global TTS_BACKEND, TTS_CMD, TTS_URL, TTS_VOICE, TTS_TIMEOUT
    global TR_BACKEND, TR_MODEL, TR_URL, TR_CMD, TR_SRC

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
    ap.add_argument(
        "--tts-backend",
        default=os.environ.get("YTLT_TTS_BACKEND", TTS_BACKEND),
        choices=("none", "edge", "sapi", "command", "http"),
        help="本機配音後端：none / edge（內建 Edge TTS）/ sapi（Windows SAPI）/ command（外部指令產 WAV）/ http（外部 TTS 服務）",
    )
    ap.add_argument(
        "--tts-cmd",
        default=os.environ.get("YTLT_TTS_CMD", TTS_CMD),
        help='command 後端的指令，例：python my_tts.py --text "{textfile}" --out "{out}"',
    )
    ap.add_argument(
        "--tts-url",
        default=os.environ.get("YTLT_TTS_URL", TTS_URL),
        help="http 後端的網址，例：http://127.0.0.1:9880/tts",
    )
    ap.add_argument(
        "--tts-voice",
        default=os.environ.get("YTLT_TTS_VOICE", TTS_VOICE),
        help="預設音色（擴充功能沒指定時使用）",
    )
    ap.add_argument(
        "--translate-backend",
        default=os.environ.get("YTLT_TRANSLATE_BACKEND", TR_BACKEND),
        choices=("none", "http", "command"),
        help="本機翻譯後端：none / http（OpenAI 相容）/ command",
    )
    ap.add_argument(
        "--translate-model",
        default=os.environ.get("YTLT_TRANSLATE_MODEL", TR_MODEL),
        help="http 後端要用的 model 名稱（llama.cpp 的 -a）",
    )
    ap.add_argument(
        "--translate-url",
        default=os.environ.get("YTLT_TRANSLATE_URL", TR_URL),
        help="http 後端網址，例：http://127.0.0.1:8080/v1/chat/completions",
    )
    ap.add_argument(
        "--translate-cmd",
        default=os.environ.get("YTLT_TRANSLATE_CMD", TR_CMD),
        help='command 後端指令（stdin→stdout），例：python mt.py --to {lang}',
    )
    ap.add_argument(
        "--translate-src",
        default=os.environ.get("YTLT_TRANSLATE_SRC", TR_SRC),
        help="來源語言標籤（只給 command 後端的 {src} 用，預設 en）",
    )
    args = ap.parse_args()

    TTS_BACKEND = (args.tts_backend or "none").strip().lower()
    TTS_CMD = (args.tts_cmd or "").strip()
    TTS_URL = (args.tts_url or "").strip()
    TTS_VOICE = (args.tts_voice or "").strip()
    TR_BACKEND = (args.translate_backend or "none").strip().lower()
    TR_MODEL = (args.translate_model or "").strip()
    TR_URL = (args.translate_url or "").strip()
    TR_CMD = (args.translate_cmd or "").strip()
    TR_SRC = (args.translate_src or "en").strip()

    # 已經有一份在跑就不要重複載入（12GB 顯示記憶體塞不下兩份）
    if _port_busy(args.host, args.port):
        print("[asr] 連接埠 %d 已有服務在執行，這一份結束。" % args.port, flush=True)
        return

    MODEL = args.model
    MODELS_ROOT = args.models_root
    print("[asr] 模型：%s" % MODEL, flush=True)
    print("[asr] 模型資料夾：%s" % MODELS_ROOT, flush=True)
    if tts_ready():
        print("[tts] 後端：%s（voice=%s）" % (TTS_BACKEND, TTS_VOICE or "預設"), flush=True)
    else:
        print(
            "[tts] 沒有接上語音模型（後端 %s）。本機配音會沒有聲音，字幕照常。"
            % TTS_BACKEND,
            flush=True,
        )

    if translate_ready():
        extra = TR_URL if TR_BACKEND == "http" else TR_CMD
        print("[tr] 翻譯後端：%s（%s）" % (TR_BACKEND, extra), flush=True)
    else:
        print(
            "[tr] 沒有接上翻譯模型（後端 %s）。本機模式會改用 Gemini 文字翻譯。" % TR_BACKEND,
            flush=True,
        )

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
