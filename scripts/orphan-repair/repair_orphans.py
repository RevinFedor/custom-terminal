#!/usr/bin/env python3
"""
Repair orphan parentUuid entries in Claude JSONL transcripts.

For each entry whose parentUuid is NOT present anywhere in the same file:
- Rewrite its parentUuid to the uuid of the IMMEDIATELY PRECEDING valid
  entry in file order (the entry on the previous non-empty / parseable line
  that has a uuid).
- If no such predecessor exists (orphan at the very start), set parentUuid
  to null (it becomes a new root).

Default: --dry-run. Prints the diff and exits without touching files.
Use --apply to actually write. Backup is created next to original as
`<file>.orphan-repair-bak-<unix-ts>`. Write is atomic (tmp + rename).

Usage:
  python3 repair_orphans.py <file.jsonl> [<file.jsonl> ...]            # dry-run
  python3 repair_orphans.py --apply <file.jsonl> [<file.jsonl> ...]    # apply

Safety:
- NEVER pass a JSONL whose Claude CLI is currently running and writing to it.
  The CLI holds an fd on the inode and will keep appending to the OLD inode
  after our atomic rename, so the repair is silently lost.
"""
import argparse
import json
import os
import shutil
import sys
import time


def parse_file(path):
    # errors='replace' so NUL-byte / invalid-UTF-8 lines (from interrupted writes)
    # don't crash the whole scan — they become parse-fail lines and are skipped
    # in the orphan analysis, but the rest of the file is processed normally.
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().split("\n")
    parsed = []
    uuid_set = set()
    for i, line in enumerate(lines):
        if not line or line[0] != "{":
            parsed.append((line, None))
            continue
        try:
            d = json.loads(line)
            parsed.append((line, d))
            if d.get("uuid"):
                uuid_set.add(d["uuid"])
        except json.JSONDecodeError:
            parsed.append((line, None))
    return lines, parsed, uuid_set


def find_orphans(parsed, uuid_set):
    """Return list of (file_index, json_dict) for entries whose parentUuid is missing from the file."""
    orphans = []
    for idx, (_, d) in enumerate(parsed):
        if d is None:
            continue
        p = d.get("parentUuid")
        if p and p not in uuid_set:
            orphans.append((idx, d))
    return orphans


def find_prev_valid_uuid(parsed, idx):
    """Walk backwards from idx-1 looking for the nearest entry with a uuid."""
    for j in range(idx - 1, -1, -1):
        _, d = parsed[j]
        if d and d.get("uuid"):
            return d["uuid"], j
    return None, None


def short(content, n=80):
    if isinstance(content, str):
        return content[:n].replace("\n", " ")
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    return (b.get("text") or "")[:n].replace("\n", " ")
                if b.get("type") == "tool_use":
                    return f"<tool_use {b.get('name', '?')}>"
                if b.get("type") == "tool_result":
                    return "<tool_result>"
    return ""


def repair_file(path, apply=False):
    print(f"\n══════════════════════════════════════════════════════════════")
    print(f"FILE: {path}")
    print(f"══════════════════════════════════════════════════════════════")

    lines, parsed, uuid_set = parse_file(path)
    orphans = find_orphans(parsed, uuid_set)
    if not orphans:
        print(f"  No orphans. Skipping.")
        return False

    print(f"  Total entries: {sum(1 for _, d in parsed if d)}")
    print(f"  Orphan count:  {len(orphans)}\n")

    rewrites = []
    for file_idx, d in orphans:
        old_parent = d.get("parentUuid")
        new_parent, prev_idx = find_prev_valid_uuid(parsed, file_idx)
        rewrites.append((file_idx, d, old_parent, new_parent, prev_idx))

        c = d.get("message", {}).get("content")
        sample = short(c, 100)

        print(f"  L{file_idx+1}: type={d.get('type'):>11} uuid={d.get('uuid', '')[:8]}")
        print(f"    ts:          {d.get('timestamp', '')[:19]}")
        print(f"    OLD parent:  {(old_parent or 'null')[:8]}  (missing from file)")
        if new_parent is None:
            print(f"    NEW parent:  null  (becomes new root — no preceding valid entry)")
        else:
            print(f"    NEW parent:  {new_parent[:8]}  (from L{prev_idx+1})")
        if sample:
            print(f"    preview:     {sample}")
        print()

    if not apply:
        print(f"  [DRY-RUN] No changes written. Pass --apply to actually rewrite.")
        return True

    # Apply
    backup = f"{path}.orphan-repair-bak-{int(time.time())}"
    shutil.copy2(path, backup)
    print(f"  Backup saved: {backup}")

    # Rebuild content
    new_lines = list(lines)
    for file_idx, d, old_parent, new_parent, _ in rewrites:
        d["parentUuid"] = new_parent
        new_lines[file_idx] = json.dumps(d, ensure_ascii=False)

    tmp = f"{path}.orphan-repair-tmp-{os.getpid()}"
    with open(tmp, "w") as f:
        f.write("\n".join(new_lines))
    os.rename(tmp, path)
    print(f"  ✔ Applied {len(rewrites)} rewrite(s) atomically.")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="Actually write changes. Without this flag it's a dry-run.")
    ap.add_argument("files", nargs="+", help="JSONL files to repair.")
    args = ap.parse_args()

    if not args.apply:
        print("=== DRY-RUN MODE (no files will be modified) ===")
        print("Re-run with --apply to write changes.\n")
    else:
        print("=== APPLY MODE — files WILL be modified ===\n")

    any_changes = False
    for path in args.files:
        if not os.path.isfile(path):
            print(f"  ! Skipping (not a file): {path}", file=sys.stderr)
            continue
        if repair_file(path, apply=args.apply):
            any_changes = True

    if not any_changes:
        print("\nNothing to repair across all input files.")


if __name__ == "__main__":
    main()
