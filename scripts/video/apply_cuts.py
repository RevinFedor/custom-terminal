#!/usr/bin/env python3
"""
Apply cuts to video using FFmpeg.
Usage: python3 apply_cuts.py <video_path> <cuts_json_path>
"""
import sys
import json
import subprocess
import os

def get_duration(video_path: str) -> float:
    out = subprocess.check_output([
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        video_path
    ]).decode().strip()
    return float(out)

def apply_cuts(video_path: str, cuts: list, output_path: str):
    total_dur = get_duration(video_path)
    print(f"Video duration: {total_dur:.1f}s")

    # Build keep segments (inverse of cuts)
    sorted_cuts = sorted(cuts, key=lambda x: x["start_sec"])
    keep = []
    prev = 0.0
    for cut in sorted_cuts:
        s = float(cut["start_sec"])
        e = float(cut["end_sec"])
        if s > prev + 0.1:
            keep.append((prev, s))
        prev = e
    if prev < total_dur - 0.1:
        keep.append((prev, total_dur))

    print(f"Keeping {len(keep)} segments:")
    for i, (s, e) in enumerate(keep):
        m1, s1 = divmod(int(s), 60)
        m2, s2 = divmod(int(e), 60)
        print(f"  [{i+1}] {m1:02d}:{s1:02d} - {m2:02d}:{s2:02d} ({e-s:.1f}s)")

    if not keep:
        print("Nothing to keep!")
        return

    if len(keep) == 1:
        # Simple trim, no concat needed
        s, e = keep[0]
        cmd = [
            "ffmpeg", "-y",
            "-i", video_path,
            "-ss", str(s), "-to", str(e),
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-c:a", "aac", "-b:a", "192k",
            output_path
        ]
    else:
        # Build filter_complex for concat
        filters = []
        for i, (s, e) in enumerate(keep):
            filters.append(f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{i}]")
            filters.append(f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}]")

        n = len(keep)
        concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(n))
        filters.append(f"{concat_inputs}concat=n={n}:v=1:a=1[vout][aout]")
        filter_str = ";".join(filters)

        cmd = [
            "ffmpeg", "-y",
            "-i", video_path,
            "-filter_complex", filter_str,
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-c:a", "aac", "-b:a", "192k",
            output_path
        ]

    print(f"\nRendering to: {output_path}")
    subprocess.run(cmd, check=True)
    out_size = os.path.getsize(output_path) // 1024 // 1024
    print(f"Done! Output: {out_size} MB")

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 apply_cuts.py <video_path> <cuts_json_path>")
        sys.exit(1)

    video_path = sys.argv[1]
    cuts_path = sys.argv[2]

    with open(cuts_path) as f:
        cuts = json.load(f)

    if not cuts:
        print("No cuts defined — nothing to do.")
        return

    print(f"Cuts to apply ({len(cuts)}):")
    for c in cuts:
        m1, s1 = divmod(int(c['start_sec']), 60)
        m2, s2 = divmod(int(c['end_sec']), 60)
        print(f"  {m1:02d}:{s1:02d} - {m2:02d}:{s2:02d} | {c['reason']}")

    base = os.path.splitext(video_path)[0]
    output_path = f"{base}_clean.mp4"

    apply_cuts(video_path, cuts, output_path)

if __name__ == "__main__":
    main()
