#!/usr/bin/env python3
"""Download Whisper model files so your own site can serve them.

Usage:
    pip install huggingface_hub
    python scripts/fetch_models.py --out models tiny base small

Files land in <out>/Xenova/whisper-<size>/ which is where worker.js looks first.
Only the 8-bit quantized ONNX files are fetched (the ones the CPU path uses).
"""
import argparse
import pathlib
import shutil
import sys

from huggingface_hub import snapshot_download

PATTERNS = [
    "*.json",
    "*.txt",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
]
REQUIRED = [
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="models", help="output folder (default: models)")
    ap.add_argument("sizes", nargs="*", default=["tiny", "base", "small"])
    args = ap.parse_args()

    out = pathlib.Path(args.out)
    for size in args.sizes:
        repo = f"Xenova/whisper-{size}"
        dest = out / repo
        print(f"Downloading {repo} -> {dest}", flush=True)
        snapshot_download(repo_id=repo, local_dir=str(dest), allow_patterns=PATTERNS)
        shutil.rmtree(dest / ".cache", ignore_errors=True)  # download bookkeeping

        missing = [f for f in REQUIRED if not (dest / f).is_file()]
        if missing:
            print(f"ERROR: {repo} is missing {missing}", file=sys.stderr)
            return 1
        total = sum(p.stat().st_size for p in dest.rglob("*") if p.is_file())
        print(f"  ok, {total / 1048576:.0f} MB", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
