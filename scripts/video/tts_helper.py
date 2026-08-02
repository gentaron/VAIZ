#!/usr/bin/env python3
"""
VAIZ TTS Helper — Kokoro (primary) → edge-tts (fallback)

Usage:
  python3 scripts/video/tts_helper.py --text "..." --output out/audio/0.wav
  # writes WAV and prints duration in seconds to stdout
"""

import argparse
import json
import subprocess
import sys
import struct
import wave
import tempfile
import os


def get_wav_duration(filepath: str) -> float:
    """Read actual WAV duration from file header."""
    try:
        with wave.open(filepath, 'rb') as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            return frames / rate
    except Exception:
        # Fallback: ffprobe
        try:
            r = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", filepath],
                capture_output=True,
                text=True,
                timeout=30,
            )
            info = json.loads(r.stdout)
            return float(info["format"]["duration"])
        except Exception:
            return 0.0


def tts_kokoro(text: str, output: str) -> bool:
    """Try Kokoro-onnx for TTS. Returns True on success."""
    try:
        from kokoro_onnx import Kokoro

        # Download model if not present
        model_path = os.path.expanduser("~/.cache/kokoro/kokoro-v0_19.onnx")
        voices_path = os.path.expanduser("~/.cache/kokoro/voices.bin")
        os.makedirs(os.path.dirname(model_path), exist_ok=True)

        if not os.path.exists(model_path) or not os.path.exists(voices_path):
            print("  [kokoro] Downloading model files...", file=sys.stderr)
            from huggingface_hub import hf_hub_download

            model_path = hf_hub_download(
                "hexgrad/Kokoro-82M-v0.19-ONNX", "kokoro-v0_19.onnx", local_dir=os.path.dirname(model_path)
            )
            voices_path = hf_hub_download(
                "hexgrad/Kokoro-82M-v0.19-ONNX", "voices.bin", local_dir=os.path.dirname(voices_path)
            )

        k = Kokoro(model_path, voices_path)
        samples, sample_rate = k.create(text, voice="ja_JP-NanamiNeural", speed=1.0, lang="ja")

        # Save as WAV
        with wave.open(output, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(samples.tobytes())

        return True
    except Exception as e:
        print(f"  [kokoro] Failed: {e}", file=sys.stderr)
        return False


def tts_edge(text: str, output: str) -> bool:
    """Fallback: edge-tts CLI."""
    try:
        # Use edge-tts with Japanese voice
        cmd = [
            sys.executable, "-m", "edge_tts",
            "--text", text,
            "--voice", "ja-JP-NanamiNeural",
            "--write-media", output,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            print(f"  [edge-tts] Error: {r.stderr.strip()}", file=sys.stderr)
            return False
        return True
    except Exception as e:
        print(f"  [edge-tts] Failed: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="VAIZ TTS Helper")
    parser.add_argument("--text", required=True, help="Japanese narration text")
    parser.add_argument("--output", required=True, help="Output WAV path")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    # Try Kokoro first, then edge-tts
    success = tts_kokoro(args.text, args.output)
    if not success:
        print("  Falling back to edge-tts...", file=sys.stderr)
        success = tts_edge(args.text, args.output)

    if not success:
        print("ERROR: All TTS engines failed", file=sys.stderr)
        sys.exit(1)

    duration = get_wav_duration(args.output)
    # Print only the duration so the caller can parse it
    print(f"{duration:.3f}")


if __name__ == "__main__":
    main()
