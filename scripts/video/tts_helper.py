#!/usr/bin/env python3
"""
VAIZ TTS Helper — edge-tts で日本語ナレーションを WAV 化する。

Usage:
  python3 scripts/video/tts_helper.py --text "..." --output out/audio/0.wav
  # WAV を書き出し、実測秒数を stdout に 1 行だけ出力する

なぜ Kokoro ではなく edge-tts か:
  Kokoro v0.19 は英語専用モデルで、日本語の音素化ができない。
  日本語対応の Kokoro v1.0 は misaki[ja] (fugashi / unidic / pyopenjtalk) を
  必要とし、CI で毎回 300MB 超を入れることになる。
  edge-tts は追加モデル不要・APIキー不要・日本語ネイティブ音声なので、
  「完全無料 + CI で軽い」という制約にはこちらが合う。
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave

DEFAULT_VOICE = os.environ.get("TTS_VOICE", "ja-JP-NanamiNeural")
DEFAULT_RATE = os.environ.get("TTS_RATE", "+0%")
SAMPLE_RATE = 24000
MAX_ATTEMPTS = 3


def log(msg: str) -> None:
    """stdout は秒数専用なので、ログは必ず stderr に出す。"""
    print(msg, file=sys.stderr)


def tail(text: str, lines: int = 3, limit: int = 400) -> str:
    """例外の原因は traceback の末尾にあるので、先頭ではなく末尾を残す。"""
    kept = [ln for ln in (text or "").strip().splitlines() if ln.strip()][-lines:]
    return " | ".join(ln.strip() for ln in kept)[-limit:]


def wav_duration(filepath: str) -> float:
    """WAV ヘッダから実尺を読む。読めなければ ffprobe にフォールバック。"""
    try:
        with wave.open(filepath, "rb") as wf:
            return wf.getnframes() / float(wf.getframerate())
    except Exception:
        try:
            r = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", filepath],
                capture_output=True,
                text=True,
                timeout=30,
            )
            return float(json.loads(r.stdout)["format"]["duration"])
        except Exception:
            return 0.0


def synthesize(text: str, voice: str, rate: str, output: str) -> bool:
    """edge-tts で MP3 を作り、ffmpeg で 24kHz mono PCM WAV に変換する。

    edge-tts の出力は --write-media の拡張子に関わらず MP3 なので、
    ここで必ず本物の WAV に変換しておく (render.mjs が WAV を前提にしている)。
    """
    with tempfile.TemporaryDirectory() as tmp:
        mp3_path = os.path.join(tmp, "speech.mp3")

        cmd = [
            sys.executable, "-m", "edge_tts",
            "--text", text,
            "--voice", voice,
            "--rate", rate,
            "--write-media", mp3_path,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            log(f"  [edge-tts] exit {r.returncode}: {tail(r.stderr)}")
            return False
        if not os.path.exists(mp3_path) or os.path.getsize(mp3_path) == 0:
            log("  [edge-tts] produced an empty file")
            return False

        conv = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", mp3_path,
                "-ac", "1",
                "-ar", str(SAMPLE_RATE),
                "-c:a", "pcm_s16le",
                output,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if conv.returncode != 0:
            log(f"  [ffmpeg] mp3->wav failed: {tail(conv.stderr)}")
            return False

    return os.path.exists(output) and os.path.getsize(output) > 0


def main():
    parser = argparse.ArgumentParser(description="VAIZ TTS Helper")
    parser.add_argument("--text", required=True, help="Japanese narration text")
    parser.add_argument("--output", required=True, help="Output WAV path")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--rate", default=DEFAULT_RATE)
    args = parser.parse_args()

    text = " ".join(args.text.split())
    if not text:
        log("ERROR: empty narration text")
        sys.exit(1)

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    for attempt in range(1, MAX_ATTEMPTS + 1):
        if synthesize(text, args.voice, args.rate, args.output):
            break
        if attempt < MAX_ATTEMPTS:
            wait = 2 ** attempt
            log(f"  [tts] attempt {attempt} failed, retrying in {wait}s...")
            import time

            time.sleep(wait)
    else:
        log("ERROR: edge-tts failed after all attempts")
        sys.exit(1)

    duration = wav_duration(args.output)
    if duration <= 0:
        log(f"ERROR: could not determine duration of {args.output}")
        sys.exit(1)

    # stdout に出すのは秒数だけ (呼び出し側がパースする)
    print(f"{duration:.3f}")


if __name__ == "__main__":
    main()
