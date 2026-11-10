"""Beat tracker for tempo:fill (QWW-40). Reads one audio file path per line on stdin and answers one
JSON line per path on stdout: {"bpm": 123.4} or {"error": "..."}. Uses librosa.feature.tempo on the
first 30 seconds. Nothing is kept; the caller deletes the file. Needs librosa (and ffmpeg for mp3
when libsndfile cannot read it). Usage: python3 scripts/tempo-tracker.py"""
import json
import sys

import librosa

for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    try:
        y, sr = librosa.load(path, sr=22050, mono=True, duration=30)
        bpm = float(librosa.feature.tempo(y=y, sr=sr)[0])
        print(json.dumps({"bpm": round(bpm, 2)}), flush=True)
    except Exception as e:  # a bad download must not stop the run
        print(json.dumps({"error": str(e)[:120]}), flush=True)
