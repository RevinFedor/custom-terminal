#!/usr/bin/env python3
"""
Video analysis pipeline: upload to Gemini → detect cuts → generate voiceover script.
Usage: python3 analyze_video.py <video_path>
"""
import sys
import time
import json
import re
import os
from google import genai
from google.genai import types

GEMINI_API_KEY = "AIzaSyCvLc8lk93m6wXQsu6DAFYoEa9HY6pePcs"

client = genai.Client(api_key=GEMINI_API_KEY)

def upload_video(video_path: str):
    print(f"[1/4] Uploading {os.path.basename(video_path)} ({os.path.getsize(video_path) // 1024 // 1024} MB)...")
    video_file = client.files.upload(file=video_path)
    print(f"      File URI: {video_file.uri}")
    print("      Waiting for processing...", end="", flush=True)
    while video_file.state.name == "PROCESSING":
        time.sleep(3)
        video_file = client.files.get(name=video_file.name)
        print(".", end="", flush=True)
    print(f" {video_file.state.name}")
    if video_file.state.name != "ACTIVE":
        raise RuntimeError(f"Video processing failed: {video_file.state.name}")
    return video_file

def detect_cuts(video_file) -> list:
    print("[2/4] Detecting segments to cut...")
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=types.Content(
            parts=[
                types.Part(
                    file_data=types.FileData(
                        file_uri=video_file.uri,
                        mime_type="video/mp4"
                    ),
                    video_metadata=types.VideoMetadata(fps=1)
                ),
                types.Part(text="""Analyze this screencast recording. Find ALL segments that should be CUT from the final video:
1. Loading/waiting states (spinners, progress bars, frozen UI, blank screens)
2. Mistakes where the speaker restarts a sentence (stutter/repeat)
3. Long pauses (>3 sec silence with no screen change)
4. Any irrelevant navigation (going to wrong tab/window by mistake)

Return ONLY valid JSON, no other text:
[
  {"start_sec": 12, "end_sec": 27, "reason": "loading spinner", "confidence": "high"},
  {"start_sec": 45, "end_sec": 47, "reason": "speech mistake/restart", "confidence": "medium"}
]

If nothing to cut, return: []""")
            ]
        ),
        config=types.GenerateContentConfig(
            temperature=0.1,
            response_mime_type="application/json"
        )
    )
    text = response.text.strip()
    # Strip markdown code blocks if present
    text = re.sub(r'^```(?:json)?\n?', '', text)
    text = re.sub(r'\n?```$', '', text)
    try:
        segments = json.loads(text)
    except json.JSONDecodeError:
        print(f"      Warning: could not parse JSON, raw response:\n{text}")
        segments = []
    print(f"      Found {len(segments)} segments to cut")
    for s in segments:
        m1, s1 = divmod(int(s['start_sec']), 60)
        m2, s2 = divmod(int(s['end_sec']), 60)
        print(f"      {m1:02d}:{s1:02d} - {m2:02d}:{s2:02d} | {s['reason']} ({s.get('confidence', '?')})")
    return segments

def analyze_content(video_file) -> str:
    print("[3/4] Analyzing content for voiceover script...")
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=types.Content(
            parts=[
                types.Part(
                    file_data=types.FileData(
                        file_uri=video_file.uri,
                        mime_type="video/mp4"
                    ),
                    video_metadata=types.VideoMetadata(fps=1)
                ),
                types.Part(text="""Watch this screencast carefully. The speaker is using a "debug voice" — narrating their actions out loud as they go.

Your task: write a clean, professional VOICEOVER SCRIPT for a final video where the speaker will re-record their narration.

Rules:
- Use MM:SS timestamps for each section
- Write what the speaker SHOULD say (clean, professional, no "ums", no "waiting", no mistakes)
- Match the timing so the viewer can read it while the action is on screen
- For complex UI actions (clicking, navigating), describe what's happening clearly
- Use Russian language (same as the speaker)
- Format: [MM:SS - MM:SS] Script text here

Output the complete script, section by section.""")
            ]
        ),
        config=types.GenerateContentConfig(temperature=0.3)
    )
    return response.text

def main():
    if len(sys.argv) < 2:
        video_path = '/Users/fedor/Desktop/Media (Screen & Video)/CleanShot 2026-04-08 at 05.28.15.mp4'
        print(f"No path provided, using default: {video_path}")
    else:
        video_path = sys.argv[1]

    if not os.path.exists(video_path):
        print(f"Error: file not found: {video_path}")
        sys.exit(1)

    video_file = upload_video(video_path)
    cuts = detect_cuts(video_file)
    script = analyze_content(video_file)

    # Save results
    output_dir = os.path.dirname(video_path)
    base = os.path.splitext(os.path.basename(video_path))[0]

    cuts_path = os.path.join(output_dir, f"{base}_cuts.json")
    script_path = os.path.join(output_dir, f"{base}_script.md")

    with open(cuts_path, "w") as f:
        json.dump(cuts, f, indent=2, ensure_ascii=False)

    with open(script_path, "w") as f:
        f.write(f"# Voiceover Script\n\n")
        f.write(f"Video: {os.path.basename(video_path)}\n\n")
        f.write("---\n\n")
        f.write(script)

    print(f"\n[4/4] Results saved:")
    print(f"      Cuts JSON: {cuts_path}")
    print(f"      Script:    {script_path}")
    print(f"\n--- VOICEOVER SCRIPT ---\n")
    print(script)

    if cuts:
        print(f"\n--- CUTS TO MAKE ({len(cuts)} segments) ---")
        print(f"Run this to generate FFmpeg command:")
        print(f"  python3 apply_cuts.py '{video_path}' '{cuts_path}'")

if __name__ == "__main__":
    main()
