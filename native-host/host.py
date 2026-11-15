"""Native messaging host for the YTLT extension (stdlib only).

Chrome starts this process and talks to it with 4-byte length-prefixed JSON.
It exists so the extension can start / stop the local Whisper server and edit
its settings from the options page instead of the user running .cmd files.

Commands (each is {"cmd": "...", "id": n, ...}):
  ping                         -> basic info
  status                       -> is the ASR server up?
  start                        -> start the ASR server hidden
  stop                         -> ask the ASR server to shut down
  get-config                   -> read local-asr/config.json
  set-config   {config}        -> merge + write local-asr/config.json
  list-models                  -> scan modelsRoot for HF whisper dirs
  detect-python                -> find python.exe candidates
  autostart    {on: true|false}
"""

import json
import os
import socket
import struct
import subprocess
import sys
import sysconfig
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASR_DIR = os.path.join(ROOT, "local-asr")
CONFIG_PATH = os.path.join(ASR_DIR, "config.json")
LOG_DIR = os.path.join(ROOT, ".logs")

DEFAULT_CONFIG = {
    "python": r"C:\ai\ComfyUI_windows_portable\python_embeded\python.exe",
    "modelsRoot": r"C:\ai\ComfyUI_windows_portable\ComfyUI\models\audio_encoders",
    "port": 8791,
    "model": "",
    "autostart": False,
}


def log(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, "host.log"), "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def read_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f) or {})
    except Exception:
        pass
    return cfg


def write_config(cfg):
    os.makedirs(ASR_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def port_of(cfg):
    try:
        return int(cfg.get("port") or 8791)
    except Exception:
        return 8791


def http_json(path, cfg, method="GET", body=None, timeout=1.5):
    url = "http://127.0.0.1:%d%s" % (port_of(cfg), path)
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8") or "{}")


def asr_status(cfg):
    try:
        info = http_json("/health", cfg)
        return {"ok": True, "running": True, "info": info}
    except Exception:
        # 連不上 = 沒在跑，這不是錯誤（設定頁會顯示「未啟動」）
        return {"ok": True, "running": False}


def python_candidates(cfg):
    out = []
    for p in [
        cfg.get("python") or "",
        r"C:\ai\ComfyUI_windows_portable\python_embeded\python.exe",
        sys.executable,
    ]:
        if p and os.path.isfile(p) and p not in out:
            out.append(p)
    return out


def start_server(cfg):
    st = asr_status(cfg)
    if st.get("running"):
        return {"ok": True, "already": True, "info": st.get("info")}
    py = cfg.get("python") or ""
    if not os.path.isfile(py):
        cands = python_candidates(cfg)
        if not cands:
            return {"ok": False, "error": "找不到 python，請在設定頁指定 ComfyUI 的 python.exe"}
        py = cands[0]
    args = [
        py,
        os.path.join(ASR_DIR, "asr-server.py"),
        "--preload",
        "--port",
        str(port_of(cfg)),
        "--models-root",
        cfg.get("modelsRoot") or DEFAULT_CONFIG["modelsRoot"],
    ]
    if cfg.get("model"):
        args += ["--model", cfg["model"]]
    os.makedirs(LOG_DIR, exist_ok=True)
    logf = open(os.path.join(LOG_DIR, "asr.log"), "ab", buffering=0)
    flags = 0
    if os.name == "nt":
        flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    try:
        proc = subprocess.Popen(
            args,
            cwd=ASR_DIR,
            stdin=subprocess.DEVNULL,
            stdout=logf,
            stderr=logf,
            creationflags=flags,
            close_fds=True,
        )
    except Exception as e:
        return {"ok": False, "error": str(e)}
    # 等它開始聽 port（模型載入可能要幾秒，但 port 通常 1–2 秒就開）
    for _ in range(40):
        time.sleep(0.5)
        if asr_status(cfg).get("running"):
            return {"ok": True, "pid": proc.pid}
    return {"ok": True, "pid": proc.pid, "note": "已啟動，但還沒開始回應（可能正在載入模型）"}


def stop_server(cfg):
    st = asr_status(cfg)
    if not st.get("running"):
        return {"ok": True, "already": True}
    try:
        http_json("/shutdown", cfg, method="POST", body={})
        return {"ok": True}
    except Exception:
        pass
    # 沒有 /shutdown 的舊版：用 netstat 找 PID 再砍
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, timeout=10
        ).stdout
        port = ":%d" % port_of(cfg)
        for line in out.splitlines():
            if port in line and "LISTENING" in line.upper():
                pid = int(line.split()[-1])
                subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, timeout=10)
                return {"ok": True, "killed": pid}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": False, "error": "找不到正在執行的服務"}


def list_models(cfg):
    root = cfg.get("modelsRoot") or DEFAULT_CONFIG["modelsRoot"]
    out = []
    try:
        names = sorted(os.listdir(root))
    except OSError as e:
        return {"ok": False, "error": str(e), "root": root, "models": []}
    for name in names:
        path = os.path.join(root, name)
        if not os.path.isdir(path) or not os.path.isfile(os.path.join(path, "config.json")):
            continue
        mb = 0
        for f in ("model.safetensors", "pytorch_model.bin", "model.bin"):
            fp = os.path.join(path, f)
            if os.path.isfile(fp):
                mb += int(os.path.getsize(fp) / (1024 * 1024))
        out.append({"name": name, "path": path, "mb": mb})
    return {"ok": True, "root": root, "models": out}


def detect_python(cfg):
    found = python_candidates(cfg)
    for p in [
        r"C:\ai\ComfyUI_windows_portable\python_embeded\python.exe",
        os.path.join(sysconfig.get_paths().get("data", ""), "python.exe"),
    ]:
        if p and os.path.isfile(p) and p not in found:
            found.append(p)
    try:
        out = subprocess.run(["where", "python"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            line = line.strip()
            if line and os.path.isfile(line) and line not in found:
                found.append(line)
    except Exception:
        pass
    return {"ok": True, "python": found}


STARTUP_LNK = os.path.join(
    os.environ.get("APPDATA", ""),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "YTLT ASR.lnk",
)


def set_autostart(cfg, on):
    cfg["autostart"] = bool(on)
    write_config(cfg)
    ps = (
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s');"
        "$s.TargetPath='%s';"
        "$s.Arguments='\"%s\" --preload --port %d --models-root \"%s\"';"
        "$s.WorkingDirectory='%s';"
        "$s.WindowStyle=7;"
        "$s.Save()"
    ) % (
        STARTUP_LNK,
        (cfg.get("python") or "").replace("'", "''"),
        os.path.join(ASR_DIR, "asr-server.py"),
        port_of(cfg),
        (cfg.get("modelsRoot") or "").replace("'", "''"),
        ASR_DIR,
    )
    try:
        if on:
            subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
                capture_output=True,
                timeout=30,
            )
        elif os.path.isfile(STARTUP_LNK):
            os.remove(STARTUP_LNK)
        return {"ok": True, "autostart": bool(on), "path": STARTUP_LNK}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle(msg):
    cfg = read_config()
    cmd = (msg.get("cmd") or "").strip()
    if cmd == "ping":
        return {"ok": True, "root": ROOT, "python": cfg.get("python"), "version": 1}
    if cmd == "status":
        st = asr_status(cfg)
        st["config"] = cfg
        return st
    if cmd == "start":
        return start_server(cfg)
    if cmd == "stop":
        return stop_server(cfg)
    if cmd == "get-config":
        return {"ok": True, "config": cfg}
    if cmd == "set-config":
        patch = msg.get("config") or {}
        for k, v in patch.items():
            if k in DEFAULT_CONFIG:
                cfg[k] = v
        write_config(cfg)
        return {"ok": True, "config": cfg}
    if cmd == "list-models":
        return list_models(cfg)
    if cmd == "detect-python":
        return detect_python(cfg)
    if cmd == "autostart":
        return set_autostart(cfg, bool(msg.get("on")))
    return {"ok": False, "error": "unknown cmd: " + cmd}


def read_frame():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    data = sys.stdin.buffer.read(n)
    if len(data) < n:
        return None
    return json.loads(data.decode("utf-8"))


def write_frame(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main():
    log("host start pid=%d" % os.getpid())
    while True:
        try:
            msg = read_frame()
        except Exception as e:
            log("read error: %s" % e)
            break
        if msg is None:
            break
        try:
            res = handle(msg)
        except Exception as e:  # noqa: BLE001
            log("handle error: %s" % e)
            res = {"ok": False, "error": str(e)}
        res["id"] = msg.get("id")
        try:
            write_frame(res)
        except Exception as e:
            log("write error: %s" % e)
            break


if __name__ == "__main__":
    main()
