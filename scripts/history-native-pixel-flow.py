#!/usr/bin/env python3
"""Inspect consecutive private native History PNGs, not rAF coordinates.

Requires Pillow/numpy. Usage: script ARTIFACT [--expect=stable|reverse].
The fixed central text crop must have unchanged width and content. This is a
translation estimate; inspect reported reverse pairs and their RMS error. It is
not a general optical-flow or input-latency benchmark. No images are rewritten.
"""
from pathlib import Path
from PIL import Image
import numpy as np
import json
import sys

root = Path(sys.argv[1])
expected = next((arg.split("=", 1)[1] for arg in sys.argv[2:] if arg.startswith("--expect=")), None)
result = json.loads((root / "result.json").read_text())
paints = result["main"]["paints"]
comparisons = []
previous = None
for paint in paints:
    image = np.array(Image.open(root / paint["file"]).convert("L"), dtype=np.float64)
    image = image[:, 30:min(1200, paint["size"]["width"] - 50):8]
    if previous is not None:
        top, bottom = 290, min(730, image.shape[0] - 230)
        template = previous[top:bottom]
        height, width = template.shape
        assert height > 100 and width > 10, "Native text crop is too small"
        assert template.std() > 2, "Native text crop has no trackable content"
        length = 1 << (image.shape[0] + height - 1).bit_length()
        cross = np.fft.irfft((np.fft.rfft(image, n=length, axis=0)
                             * np.conj(np.fft.rfft(template, n=length, axis=0))).sum(axis=1), n=length)
        power = np.r_[0, np.cumsum(np.square(image).sum(axis=1))]
        offsets = np.arange(max(0, top - 280), min(image.shape[0] - height + 1, top + 430))
        score = (np.square(template).sum() + power[offsets + height] - power[offsets]
                 - 2 * cross[offsets]) / (height * width)
        index = int(score.argmin())
        near = [int(offsets[i] - top) for i in np.flatnonzero(score < score[index] + 0.01)]
        # Exact repeated textures are ambiguous; prefer the smallest motion.
        shift = min(near, key=abs)
        comparisons.append({"from": paint["index"] - 1, "to": paint["index"], "abs": paint["abs"],
                            "elapsedMs": paint["abs"] - paints[paint["index"] - 1]["abs"],
                            "shiftPx": shift, "rms": float(max(0, score[index]) ** .5),
                            "candidateShifts": near, "sampleFrame": (paint.get("sample") or {}).get("frame")})
    previous = image

reverse = [item for item in comparisons if item["shiftPx"] < -2]
summary = {"artifact": str(root), "pairs": len(comparisons), "reverseOver2px": reverse,
           "maxFrameGapMs": max((item["elapsedMs"] for item in comparisons), default=None),
           "stationary": sum(item["shiftPx"] == 0 for item in comparisons)}
(root / "native-pixel-flow.json").write_text(json.dumps(comparisons, indent=2))
(root / "native-pixel-summary.json").write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
if expected == "stable":
    assert comparisons and not reverse, "Native pixels reverse the upward gesture"
elif expected == "reverse":
    assert any(item["shiftPx"] <= -8 for item in reverse), "Paired control did not reproduce the visible regression"
elif expected is not None:
    raise ValueError("Unknown expectation")
