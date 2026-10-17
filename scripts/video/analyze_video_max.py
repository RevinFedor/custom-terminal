#!/usr/bin/env python3
"""
Video analysis pipeline — MAXIMUM QUALITY.
Model: Gemini 3.1 Pro Preview
FPS: 4 (4 frames per second)
Resolution: HIGH (258 tokens/frame)
"""
import sys
import time
import json
import re
import os
from google import genai
from google.genai import types

GEMINI_API_KEY = "AIzaSyCvLc8lk93m6wXQsu6DAFYoEa9HY6pePcs"
MODEL = "gemini-3.1-pro-preview"
FPS = 4.0
RESOLUTION = "MEDIA_RESOLUTION_HIGH"

client = genai.Client(api_key=GEMINI_API_KEY)

def upload_video(video_path: str):
    print(f"[UPLOAD] {os.path.basename(video_path)} ({os.path.getsize(video_path) // 1024 // 1024} MB)")
    print(f"[CONFIG] Model: {MODEL} | FPS: {FPS} | Resolution: HIGH")

    video_file = client.files.upload(file=video_path)
    print(f"[UPLOAD] URI: {video_file.uri}")
    print("[UPLOAD] Processing...", end="", flush=True)
    while video_file.state.name == "PROCESSING":
        time.sleep(3)
        video_file = client.files.get(name=video_file.name)
        print(".", end="", flush=True)
    print(f" {video_file.state.name}")
    if video_file.state.name != "ACTIVE":
        raise RuntimeError(f"Processing failed: {video_file.state.name}")
    return video_file


def detect_cuts(video_file) -> list:
    print(f"\n[DETECT] Analyzing with {MODEL} @ {FPS} fps, HIGH resolution...")

    response = client.models.generate_content(
        model=MODEL,
        contents=types.Content(
            parts=[
                types.Part(
                    file_data=types.FileData(
                        file_uri=video_file.uri,
                        mime_type="video/mp4"
                    ),
                    video_metadata=types.VideoMetadata(fps=FPS)
                ),
                types.Part(text="""You are a professional video editor analyzing a screencast of a custom terminal application.

Your task: find ALL segments that should be CUT from the final video. Be extremely thorough.

WHAT TO DETECT (even small/subtle UI elements count):
1. **Loading states** — ANY loading indicator, no matter how small:
   - Full-screen spinners
   - Inline loading indicators (small spinners next to buttons or in panels)
   - Progress bars (including thin/subtle ones)
   - Timeline loading (a sidebar/panel showing loading animation while data loads)
   - Skeleton screens or placeholder content
   - "Loading...", "Please wait..." text anywhere on screen

2. **Frozen/static UI** — screen unchanged for >3 seconds while the speaker is waiting

3. **Speech mistakes** — speaker restarts a sentence, stutters, or says "um/uh" repeatedly

4. **Dead time** — silence >3 seconds with no meaningful screen change

5. **Navigation errors** — clicking wrong button/tab and immediately going back

IMPORTANT: This is a terminal/IDE-like application. Loading states may appear as:
- A small area in a sidebar refreshing/loading
- A panel on the right side showing loading animation
- Timeline component loading history entries
- Any area that shows a spinner or animation while data is being fetched

Analyze EVERY SECOND of the video. For each detected segment, provide:
- Exact start and end times (to the nearest second)
- Category (loading/frozen/mistake/dead_time/nav_error)
- Description of what you see
- Confidence (high/medium/low)
- Screen region where the event occurs (full_screen/sidebar/main_panel/timeline/other)

Return ONLY valid JSON:
[
  {
    "start_sec": 12,
    "end_sec": 27,
    "category": "loading",
    "description": "Loading spinner visible in the timeline panel while history entries are being fetched",
    "confidence": "high",
    "region": "timeline"
  }
]

If nothing found, return: []""")
            ]
        ),
        config=types.GenerateContentConfig(
            temperature=0.1,
            media_resolution="MEDIA_RESOLUTION_HIGH",
            response_mime_type="application/json"
        )
    )

    text = response.text.strip()
    text = re.sub(r'^```(?:json)?\n?', '', text)
    text = re.sub(r'\n?```$', '', text)

    try:
        segments = json.loads(text)
    except json.JSONDecodeError:
        print(f"[ERROR] Could not parse JSON:\n{text}")
        segments = []

    print(f"[DETECT] Found {len(segments)} segments:\n")
    for s in segments:
        m1, s1 = divmod(int(s['start_sec']), 60)
        m2, s2 = divmod(int(s['end_sec']), 60)
        cat = s.get('category', '?')
        desc = s.get('description', '')
        conf = s.get('confidence', '?')
        region = s.get('region', '?')
        print(f"  {m1:02d}:{s1:02d} – {m2:02d}:{s2:02d} | {cat:12s} | {conf:6s} | {region:12s} | {desc}")

    return segments


def generate_script(video_file) -> str:
    print(f"\n[SCRIPT] Generating voiceover script with {MODEL}...")

    response = client.models.generate_content(
        model=MODEL,
        contents=types.Content(
            parts=[
                types.Part(
                    file_data=types.FileData(
                        file_uri=video_file.uri,
                        mime_type="video/mp4"
                    ),
                    video_metadata=types.VideoMetadata(fps=FPS)
                ),
                types.Part(text="""Watch this screencast in detail. The speaker is recording a demo of a custom terminal application using a "debug voice" — narrating actions as they happen.

Your task: create a CLEAN, PROFESSIONAL voiceover script in Russian that the speaker will re-record over the edited video.

Rules:
1. Use [MM:SS - MM:SS] timestamps for each section
2. Clean up the debug narration: remove "ums", hesitations, repetitions
3. Make it sound professional but conversational (not robotic)
4. Match timing precisely — the speaker must have enough time to read each section while the action plays
5. For complex UI interactions, describe what the viewer should pay attention to
6. Group related actions into logical sections
7. Add brief [Пауза] markers where the video has natural breaks

Output the complete script section by section.""")
            ]
        ),
        config=types.GenerateContentConfig(
            temperature=0.3,
            media_resolution="MEDIA_RESOLUTION_HIGH"
        )
    )
    return response.text


def main():
    if len(sys.argv) < 2:
        video_path = '/Users/fedor/Desktop/Media (Screen & Video)/CleanShot 2026-04-08 at 05.28.15.mp4'
    else:
        video_path = sys.argv[1]

    if not os.path.exists(video_path):
        print(f"Error: {video_path} not found")
        sys.exit(1)

    video_file = upload_video(video_path)

    # Phase 1: Detect cuts
    cuts = detect_cuts(video_file)

    # Phase 2: Generate script
    script = generate_script(video_file)

    # Save results
    output_dir = os.path.dirname(video_path)
    base = os.path.splitext(os.path.basename(video_path))[0]

    cuts_path = os.path.join(output_dir, f"{base}_cuts_max.json")
    script_path = os.path.join(output_dir, f"{base}_script_max.md")

    with open(cuts_path, "w") as f:
        json.dump(cuts, f, indent=2, ensure_ascii=False)

    with open(script_path, "w") as f:
        f.write(f"# Voiceover Script (MAX QUALITY)\n\n")
        f.write(f"Model: {MODEL} | FPS: {FPS} | Resolution: HIGH\n\n")
        f.write(f"Video: {os.path.basename(video_path)}\n\n")
        f.write("---\n\n")
        f.write(script)

    print(f"\n[DONE] Saved:")
    print(f"  Cuts: {cuts_path}")
    print(f"  Script: {script_path}")

    print(f"\n{'='*60}")
    print(f"VOICEOVER SCRIPT")
    print(f"{'='*60}\n")
    print(script)

    if cuts:
        print(f"\n{'='*60}")
        print(f"DETECTED CUTS ({len(cuts)})")
        print(f"{'='*60}")
        total_cut = sum(s['end_sec'] - s['start_sec'] for s in cuts)
        print(f"Total cut time: {total_cut:.0f}s")
        print(f"\nTo apply: python3 scripts/apply_cuts.py '{video_path}' '{cuts_path}'")


if __name__ == "__main__":
    main()
