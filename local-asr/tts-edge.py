"""把 edge-tts（微軟線上神經語音）包成 asr-server 的 TTS command 後端。

用法（asr-server 的 --tts-cmd 會自動代入替代字）：
  python tts-edge.py --file "{textfile}" --out "{out}" --voice "zh-TW-HsiaoChenNeural"

- 文字從 --file（UTF-8）或 --text 讀。
- edge-tts 產出 mp3，這裡再用 ffmpeg 轉成 24 kHz 單聲道 16-bit WAV（asr-server 只吃 WAV）。
- ffmpeg 找 PATH 上的 ffmpeg；找不到時試 imageio-ffmpeg 內建的。
"""
import argparse
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile

import edge_tts

DEFAULT_VOICE = "zh-TW-HsiaoChenNeural"
# 微軟端偶有「某些句子 + 某個音色」直接回空音訊（NoAudioReceived），
# 例如台灣男聲 YunJhe 對「我們正在回家」會失敗。失敗時照這個順序換音色重試。
MALE_FALLBACKS = ["zh-CN-YunxiNeural", DEFAULT_VOICE]


def fallback_order(voice):
    """男聲先用男聲備援，其餘先用預設女聲。"""
    male = "Yun" in voice
    rest = MALE_FALLBACKS if male else [DEFAULT_VOICE, "zh-CN-YunxiNeural"]
    return [voice] + [v for v in rest if v != voice]



def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


async def synth(text, voice, mp3_path):
    """用指定音色合成；若微軟端回空音訊，依 FALLBACKS 換音色重試。

    回傳實際用到的音色。
    """
    last = None
    for v in fallback_order(voice):
        try:
            comm = edge_tts.Communicate(text, v)
            with open(mp3_path, "wb") as f:
                async for chunk in comm.stream():
                    if chunk["type"] == "audio":
                        f.write(chunk["data"])
            if os.path.getsize(mp3_path) >= 1000:
                if v != voice:
                    print("[tts-edge] %s 沒有回音訊，改用 %s" % (voice, v),
                          file=sys.stderr, flush=True)
                return v
            last = RuntimeError("edge-tts 沒有回傳音訊（%s）" % v)
        except Exception as exc:  # noqa: BLE001
            if "NoAudioReceived" not in type(exc).__name__ and "NoAudioReceived" not in str(exc):
                raise
            last = exc
    raise last or RuntimeError("edge-tts 沒有回傳音訊")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="")
    ap.add_argument("--text", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="")
    args = ap.parse_args()

    text = args.text
    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()
    text = (text or "").strip()
    if not text:
        sys.exit("沒有文字可合成")

    voice = args.voice.strip() or DEFAULT_VOICE
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        sys.exit("找不到 ffmpeg（請把 ffmpeg 放進 PATH）")

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    fd, mp3 = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)
    try:
        used = asyncio.run(synth(text, voice, mp3))
        if os.path.getsize(mp3) < 1000:
            sys.exit("edge-tts 沒有回傳音訊（檢查網路或音色名稱）")
        if used != voice:
            sys.stderr.write("[tts-edge] 實際使用音色：%s\n" % used)
        r = subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", mp3,
             "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", out],
            capture_output=True,
        )
        if r.returncode != 0:
            sys.exit("ffmpeg 轉檔失敗：" + r.stderr.decode("utf-8", "replace")[-300:])
    finally:
        try:
            os.remove(mp3)
        except OSError:
            pass
    print(out)


if __name__ == "__main__":
    main()
