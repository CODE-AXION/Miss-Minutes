"""Watch a recordings folder, compress new meetings with HandBrake, generate notes and keep an index.

Pipeline per new recording (one at a time):
    1. wait until the file stops growing and is no longer locked by the recorder
    2. compress with HandBrakeCLI (Fast 1080p30, constant 30 fps, RF 25 - same as the GUI setup),
       in the background by default: low priority, efficiency mode, veryfast (--hb-speed full to skip that)
    3. generate notes from the *compressed* video via Google AI Studio (meeting_notes.py)
    4. file the notes under library/notes/<category>/ and update library/index.json + INDEX.md

Usage:
    python watcher.py watch                      # poll C:\\Users\\Aadil\\Videos forever
    python watcher.py watch --once               # single scan, process what is ready, exit
    python watcher.py watch --backfill           # also process recordings that existed before
    python watcher.py list --tag doubts-queries --category flow-walkthrough
    python watcher.py reindex                    # rebuild INDEX.md from index.json
    python watcher.py serve                      # worker for the desktop app (JSON lines on stdin/stdout)
    python watcher.py check                      # health checks as one JSON line (setup wizard)
    python watcher.py signin [--switch]          # visible Chrome: sign in to Google (or --signout-only)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Callable

import meeting_notes as mn

ROOT = Path(__file__).parent
DEFAULT_WATCH_DIR = Path.home() / "Videos"
DEFAULT_LIBRARY = ROOT / "library"
HANDBRAKE_CANDIDATES = [ROOT / "tools" / "handbrake" / "HandBrakeCLI.exe", Path(r"C:\Program Files\HandBrake\HandBrakeCLI.exe")]
IN_PROGRESS = {"compressing", "generating"}
RETRY_COOLDOWN = 600  # seconds before a failed recording is retried
HISTORY_LIMIT = 300  # stage records kept per entry (oldest dropped first)
log = mn.log
events: EventStream | None = None  # set by `serve`; the CLI never emits events


# --- Index -------------------------------------------------------------------------------

class Library:
    """library/ layout: compressed/, notes/<category>/, logs/, index.json, INDEX.md."""

    def __init__(self, root: Path, on_change: Callable[[str, dict], None] | None = None):
        self.root = root
        self.on_change = on_change
        self.lock = threading.RLock()
        self.index_path = root / "index.json"
        self.compressed_dir = root / "compressed"
        self.notes_dir = root / "notes"
        self.logs_dir = root / "logs"
        self.uploads_dir = root / "uploads"  # files added from the desktop app (copied as *.part, then renamed)
        self.data: dict = {"version": 1, "videos": {}}
        if self.index_path.exists():
            self.data = json.loads(self.index_path.read_text(encoding="utf-8"))

    @property
    def videos(self) -> dict[str, dict]:
        return self.data["videos"]

    @property
    def is_new(self) -> bool:
        return not self.index_path.exists()

    def save(self) -> None:
        with self.lock:
            self.root.mkdir(parents=True, exist_ok=True)
            tmp = self.index_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=2, ensure_ascii=False), encoding="utf-8")
            # On Windows the replace fails while another process has index.json open (the app reading it, antivirus,
            # the search indexer); those locks are brief, so retry for about 3 s before giving up.
            for attempt in range(6):
                try:
                    tmp.replace(self.index_path)
                    break
                except PermissionError:
                    if attempt == 5:
                        raise
                    time.sleep(0.1 * 2**attempt)
            self.write_markdown_index()

    def update(self, key: str, **fields) -> dict:
        with self.lock:
            entry = self.videos.setdefault(key, {})
            entry.update(fields, updated=now_iso())
            self.save()
            if self.on_change:
                self.on_change(key, entry)
            return entry

    def remove(self, key: str) -> None:
        """Forget a video entirely (the app's Delete with its video); the caller sends a fresh snapshot."""
        with self.lock:
            self.videos.pop(key, None)
            self.save()

    def write_markdown_index(self) -> None:
        done = sorted((e for e in self.videos.values() if e.get("status") == "done"), key=lambda e: e.get("recorded", ""), reverse=True)
        lines = ["# Meeting Library", "", f"_{len(done)} meetings · updated {datetime.now().strftime('%Y-%m-%d %H:%M')}_", ""]
        lines += ["## All meetings", "", "| Recorded | Title | Category | Tags |", "| --- | --- | --- | --- |"]
        for e in done:
            lines.append(f"| {e['recorded'][:16].replace('T', ' ')} | {md_link(e)} | {e['category']} | {', '.join(e['tags'])} |")

        lines += ["", "## By category", ""]
        for category in mn.CATEGORIES:
            items = [e for e in done if e["category"] == category]
            if items:
                lines += [f"### {category} ({len(items)})", ""] + [bullet(e) for e in items] + [""]

        lines += ["## By tag", ""]
        for tag in sorted({t for e in done for t in e["tags"]}):
            items = [e for e in done if tag in e["tags"]]
            lines += [f"### {tag} ({len(items)})", ""] + [bullet(e) for e in items] + [""]

        pending = [e for e in self.videos.values() if e.get("status") not in ("done", "baseline")]
        if pending:
            lines += ["## In progress / failed", "", "| Source | Status | Error |", "| --- | --- | --- |"]
            for e in pending:
                lines.append(f"| {Path(e['source']).name} | {e['status']} | {(e.get('error') or '').replace('|', '/')[:150]} |")
        (self.root / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def md_link(entry: dict) -> str:
    title = (entry.get("title") or Path(entry["source"]).stem).replace("|", "/").replace("]", ")")
    return f"[{title}]({entry['notes'].replace(' ', '%20')})"


def bullet(entry: dict) -> str:
    summary = f" — {entry['summary']}" if entry.get("summary") else ""
    return f"- {entry['recorded'][:10]} {md_link(entry)}{summary}"


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


class EventStream:
    """JSON-lines events on stdout for the desktop app (protocol v1); logs stay on stderr."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.broken = False

    def send(self, type: str, **fields) -> None:
        """Never raises: sends happen inside Library.update(), so a dead app must not fail the current video."""
        line = json.dumps({"type": type, "ts": now_iso(), **fields}, ensure_ascii=False)
        with self.lock:
            if self.broken:
                return
            try:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            except (OSError, ValueError) as exc:  # pipe closed: the app is gone
                self.broken = True
                log(f"[serve] event stream closed ({exc}); continuing without events")


def record(lib: Library, key: str, stage: str, attempt: int, **detail) -> None:
    """Append a pipeline stage to the entry's history and, under `serve`, send it as a `stage` event."""
    with lib.lock:
        item = {"stage": stage, "at": now_iso(), "attempt": attempt, **detail}
        history = (lib.videos.get(key, {}).get("history", []) + [item])[-HISTORY_LIMIT:]
        lib.update(key, history=history)
    if events:
        events.send("stage", key=key, stage=stage, attempt=attempt, detail=detail)


def recorded_at(video: Path) -> str:
    """Recording time from OBS-style names (2026-10-06 13-00-07.mp4), else the file's mtime."""
    m = re.search(r"(\d{4}-\d{2}-\d{2})[ _T](\d{2})-(\d{2})-(\d{2})", video.stem)
    if m:
        return f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4)}"
    return datetime.fromtimestamp(video.stat().st_mtime).isoformat(timespec="seconds")


def safe_filename(text: str, limit: int = 80) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", text)
    return " ".join(cleaned.split())[:limit].rstrip(" .") or "untitled"


def notes_path_for(lib: Library, recorded: str, category: str, title: str, fallback_stem: str) -> Path:
    """notes/<category>/<YYYY-MM-DD HHMM> - <title>.md"""
    return lib.notes_dir / category / f"{recorded[:16].replace('T', ' ').replace(':', '')} - {safe_filename(title or fallback_stem)}.md"


# --- Detecting finished recordings ---------------------------------------------------------

def is_locked(path: Path) -> bool:
    """True while another process (the recorder) holds the file open for writing."""
    try:
        fd = os.open(path, os.O_RDWR | os.O_APPEND)
    except OSError:
        return True
    os.close(fd)
    return False


class Stabilizer:
    """Tracks size/mtime across polls; a file is ready once unchanged for `settle` seconds and unlocked."""

    def __init__(self, settle: int):
        self.settle = settle
        self.seen: dict[str, tuple[int, float, float]] = {}

    def ready(self, path: Path) -> bool:
        stat = path.stat()
        key, signature = str(path), (stat.st_size, stat.st_mtime)
        previous = self.seen.get(key)
        if previous is None or previous[:2] != signature:
            self.seen[key] = (*signature, time.monotonic())
            return False
        return time.monotonic() - previous[2] >= self.settle and stat.st_size > 0 and not is_locked(path)

    def remaining(self, path: Path) -> float | None:
        """Seconds of the settle wait left for a file seen before (None if never seen)."""
        previous = self.seen.get(str(path))
        if previous is None:
            return None
        return max(0.0, self.settle - (time.monotonic() - previous[2]))


# --- Compression -----------------------------------------------------------------------------

def find_handbrake(explicit: str | None) -> Path:
    for candidate in ([Path(explicit)] if explicit else []) + HANDBRAKE_CANDIDATES:
        if candidate.exists():
            return candidate
    raise RuntimeError("HandBrakeCLI.exe not found; pass --handbrake <path>")


def handbrake_command(handbrake: Path, video: Path, partial: Path, args: argparse.Namespace) -> list[str]:
    """HandBrakeCLI arguments. speed "full" is the plain GUI setup; "background" (default) also drops the
    deinterlace filters (screen recordings are progressive) and, for x264, uses veryfast on half the threads:
    measured on a 10-minute 1080p recording, ~1.45x the time for ~30% of the CPU, ~60% of the RAM, a smaller file."""
    cmd = [str(handbrake), "-i", str(video), "-o", str(partial),
           "-Z", args.hb_preset, "-q", str(args.hb_quality), "--cfr", "-O"]
    if args.hb_encoder:
        cmd += ["-e", args.hb_encoder]
    if args.hb_speed == "background":
        cmd += ["--no-comb-detect", "--no-decomb"]
        if args.hb_encoder in (None, "", "x264"):  # hardware encoders take neither option
            cmd += ["--encoder-preset", "veryfast", "-x", f"threads={max(2, (os.cpu_count() or 4) // 2)}"]
    return cmd


def run_in_background(pid: int) -> None:
    """Windows efficiency mode (EcoQoS) for a started process: the scheduler prefers efficiency cores and low
    clocks. Best effort: older Windows lacks it and the encode just runs at below-normal priority."""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    class PowerThrottling(ctypes.Structure):
        _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(0x0200 | 0x1000, False, pid)  # PROCESS_SET_INFORMATION | QUERY_LIMITED_INFORMATION
    if not handle:
        return
    try:
        state = PowerThrottling(1, 1, 1)  # version 1, EXECUTION_SPEED throttled
        kernel32.SetProcessInformation(wintypes.HANDLE(handle), 4, ctypes.byref(state), ctypes.sizeof(state))  # ProcessPowerThrottling
    finally:
        kernel32.CloseHandle(wintypes.HANDLE(handle))


def compress(video: Path, lib: Library, args: argparse.Namespace,
             on_progress: Callable[[float, str | None, float | None], None] | None = None) -> Path:
    """Encode like the HandBrake GUI setup (Fast 1080p30 preset, constant framerate, RF 25), by default lighter
    on the PC: see handbrake_command and run_in_background."""
    lib.compressed_dir.mkdir(parents=True, exist_ok=True)
    lib.logs_dir.mkdir(parents=True, exist_ok=True)
    out = lib.compressed_dir / f"{video.stem}.mp4"
    partial = out.with_name(f"{video.stem}.partial.mp4")
    cmd = handbrake_command(find_handbrake(args.handbrake), video, partial, args)
    background = args.hb_speed == "background"
    log(f"[compress] {video.name} ({video.stat().st_size / 2**20:.0f} MB) -> RF {args.hb_quality}, constant framerate"
        + (", in the background" if background else ", full speed"))
    started = time.monotonic()
    with open(lib.logs_dir / f"{video.stem}.handbrake.log", "w", encoding="utf-8", errors="replace") as hb_log:
        flags = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0) if background else 0
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=hb_log, text=True, errors="replace", bufsize=1,
                                creationflags=flags)
        if background:
            run_in_background(proc.pid)
        try:
            next_report = 10.0
            last_pct, last_sent = 0.0, 0.0
            buffer = ""
            assert proc.stdout is not None
            while chunk := proc.stdout.read(256):
                buffer = (buffer + chunk)[-512:]
                # e.g. "Encoding: task 1 of 1, 8.07 % (228.27 fps, avg 240.98 fps, ETA 00h07m21s)"; only
                # complete statuses are parsed (HandBrake's \r arrives as \n in text mode), so a half-read
                # one cannot cut the ETA short.
                complete = buffer[:buffer.rfind("\n") + 1]
                found = re.findall(r"Encoding: task \d+ of \d+, (\d+\.\d+) %(?:.*?avg (\d+\.\d+) fps)?(?:.*?ETA (\w+))?", complete)
                if found and float(found[-1][0]) >= next_report:
                    pct, _, eta = found[-1]
                    log(f"[compress] {float(pct):.0f}%" + (f" (ETA {eta})" if eta else ""))
                    next_report = (float(pct) // 10 + 1) * 10
                if found and on_progress and float(found[-1][0]) > last_pct and time.monotonic() - last_sent >= 1:
                    pct, fps, eta = found[-1]
                    last_pct, last_sent = float(pct), time.monotonic()
                    on_progress(last_pct, eta or None, float(fps) if fps else None)
            code = proc.wait()
        finally:
            if proc.poll() is None:
                proc.kill()
    if code != 0 or not partial.exists() or partial.stat().st_size == 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"HandBrakeCLI failed (exit {code}); see {lib.logs_dir / (video.stem + '.handbrake.log')}")
    partial.replace(out)
    ratio = out.stat().st_size / max(video.stat().st_size, 1)
    log(f"[compress] done: {out.stat().st_size / 2**20:.0f} MB ({ratio:.0%} of original, {time.monotonic() - started:.0f}s)")
    return out


# --- Pipeline --------------------------------------------------------------------------------

def process(video: Path, lib: Library, args: argparse.Namespace,
            on_progress: Callable[[float, str | None, float | None], None] | None = None) -> None:
    key = str(video)
    entry = lib.videos.get(key, {})
    attempts = entry.get("attempts", 0) + 1
    recorded = recorded_at(video)
    lib.update(key, source=key, size=video.stat().st_size, recorded=recorded, attempts=attempts, error=None)
    log(f"\n=== {video.name} (attempt {attempts}) ===")
    try:
        # Reuse an earlier encode: the index path, or a finished file in compressed/ (encodes are
        # written as .partial.mp4 and renamed only on success, so <stem>.mp4 is always complete).
        candidates = [Path(entry["compressed"])] if entry.get("compressed") else []
        candidates.append(lib.compressed_dir / f"{video.stem}.mp4")
        compressed = next((c for c in candidates if c.exists() and c.stat().st_size > 0), None)
        if compressed is not None:
            log(f"[compress] reusing {compressed.name}")
            lib.update(key, compressed=str(compressed), compressed_size=compressed.stat().st_size)
            record(lib, key, "compress_reused", attempts, file=compressed.name)
        else:
            lib.update(key, status="compressing")
            source_size = video.stat().st_size
            record(lib, key, "compress_start", attempts, size_mb=round(source_size / 2**20),
                   quality=args.hb_quality, encoder=args.hb_encoder, speed=args.hb_speed)
            started = time.monotonic()
            compressed = compress(video, lib, args, on_progress)
            lib.update(key, status="compressed", compressed=str(compressed), compressed_size=compressed.stat().st_size)
            record(lib, key, "compress_done", attempts, size_mb=round(compressed.stat().st_size / 2**20),
                   ratio=round(compressed.stat().st_size / max(source_size, 1), 3), seconds=round(time.monotonic() - started))

        lib.update(key, status="generating")
        # Installed around the session (not inside it) so chrome_start from connect() is recorded too.
        previous_hook = mn.on_event
        mn.on_event = lambda stage, detail: record(lib, key, stage, attempts, **detail)
        try:
            with mn.ai_studio_page(args.port, args.keep_browser, profile_dir=args.profile_dir, hidden=args.hidden) as studio:
                meta, body, model = mn.generate_with_retries(studio, compressed, args)
        finally:
            mn.on_event = previous_hook
        meta["recorded"] = recorded

        # Route by category; drop notes from a previous attempt filed under another category.
        notes_path = notes_path_for(lib, recorded, meta["category"], meta["title"], video.stem)
        if entry.get("notes") and (lib.root / entry["notes"]) != notes_path:
            (lib.root / entry["notes"]).unlink(missing_ok=True)
        notes_path.parent.mkdir(parents=True, exist_ok=True)
        notes_path.write_text(mn.render_header(video, model, args.thinking_level, meta) + body + "\n", encoding="utf-8")

        lib.update(key, status="done", notes=notes_path.relative_to(lib.root).as_posix(), model=model, processed=now_iso(),
                   **{k: meta[k] for k in ("title", "category", "tags", "summary", "participants")})
        record(lib, key, "saved", attempts, notes=notes_path.relative_to(lib.root).as_posix(),
               category=meta["category"], tags=meta["tags"])
        log(f"[done] {notes_path.relative_to(lib.root)} [{meta['category']}] {', '.join(meta['tags'])}")
    except KeyboardInterrupt:
        lib.update(key, status="pending", error="interrupted")
        record(lib, key, "interrupted", attempts)
        raise
    except mn.SignInRequired:
        # Not the video's fault: back in the queue without using an attempt. The caller stops until a sign-in.
        lib.update(key, status="pending", attempts=attempts - 1, error="Google sign-in required")
        log(f"[signin] {video.name}: Google sign-in required; it waits until you sign in")
        raise
    except Exception as exc:
        error = str(exc).splitlines()[0][:500]
        lib.update(key, status="failed", error=error, next_try=time.time() + RETRY_COOLDOWN)
        record(lib, key, "failed", attempts, error=error)
        log(f"[error] {video.name}: {exc}")


# --- Metadata edits --------------------------------------------------------------------------

def rewrite_front_matter(text: str, old_title: str, title: str, category: str, tags: list[str]) -> str:
    """Replace only the title/category/tags lines of a note's front matter (formats as in render_header).

    generated/model/thinking_level are not in the index, so the header is edited in place, never re-rendered.
    Line endings are kept as they are (notes mix \\r\\n and \\r\\r\\n). The first "# " heading of the body
    follows the title only if it still equals the old title.
    """
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        raise ValueError("the note has no front matter")
    end = next((i for i in range(1, len(lines)) if lines[i].rstrip("\r\n") == "---"), None)
    if end is None:
        raise ValueError("the note's front matter is not closed")
    eol = lines[0][3:]
    wanted = {"title": f"title: {json.dumps(title, ensure_ascii=False)}", "category": f"category: {category}",
              "tags": f"tags: [{', '.join(tags)}]"}
    missing = []
    for field, line in wanted.items():
        index = next((i for i in range(1, end) if lines[i].startswith(f"{field}:")), None)
        if index is None:
            missing.append(line + eol)
        else:
            lines[index] = line + lines[index][len(lines[index].rstrip("\r\n")):]
    lines[1:1] = missing
    end += len(missing)
    for i in range(end + 1, len(lines)):
        if lines[i].startswith("# "):
            if old_title and lines[i][2:].strip() == old_title:
                lines[i] = f"# {title}" + lines[i][len(lines[i].rstrip("\r\n")):]
            break
    return "".join(lines)


def edit_note(lib: Library, key: str, title: str | None = None, category: str | None = None,
              tags: list | None = None) -> str | None:
    """Change a done meeting's title/category/tags: rewrite and move its note, update the index.

    Fields left as None keep their value. Returns a warning when the old file could not be removed.
    """
    entry = lib.videos.get(key)
    if entry is None:
        raise ValueError(f"unknown video: {key}")
    if entry.get("status") != "done":
        raise ValueError(f"only processed meetings can be edited (this one is {entry.get('status')})")
    title = " ".join(str(entry.get("title", "") if title is None else title).split())
    if not title:
        raise ValueError("the title cannot be empty")
    category = entry.get("category", "other") if category is None else str(category)
    if category not in mn.CATEGORIES:
        raise ValueError(f"unknown category: {category} (one of: {', '.join(mn.CATEGORIES)})")
    if tags is None:
        tags = entry.get("tags", [])
    elif not isinstance(tags, list):
        raise ValueError("tags must be a list")
    tags = sorted({mn.slugify(str(t)) for t in tags if mn.slugify(str(t))})

    old_path = lib.root / entry["notes"]
    if not old_path.is_file():
        raise ValueError(f"note file not found: {old_path}")
    with open(old_path, encoding="utf-8", newline="") as f:  # newline="": keep line endings byte for byte
        content = rewrite_front_matter(f.read(), entry.get("title", ""), title, category, tags)

    new_path = notes_path_for(lib, entry["recorded"], category, title, Path(key).stem)
    same_file = new_path.exists() and os.path.samefile(new_path, old_path)
    if same_file and new_path.name != old_path.name:  # case-only rename on a case-insensitive disk
        old_path.rename(new_path)
    elif not same_file:
        base, n = new_path, 2
        while new_path.exists():  # never overwrite another meeting's note
            new_path = base.with_name(f"{base.stem} ({n}).md")
            n += 1
    new_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = new_path.with_name(new_path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    tmp.replace(new_path)

    warning = None
    if not same_file:
        try:
            old_path.unlink()
        except OSError as exc:  # e.g. open in an editor
            warning = f"the old note could not be removed ({exc.__class__.__name__}): {old_path}"
            log(f"[warn] {warning}")
    lib.update(key, title=title, category=category, tags=tags, notes=new_path.relative_to(lib.root).as_posix(), edited=now_iso())
    log(f"[edit] {new_path.relative_to(lib.root)} [{category}] {', '.join(tags)}")
    return warning


def mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:  # vanished between listing and stat (e.g. an upload being renamed from .part)
        return 0.0


def scan(sources: list[tuple[Path, bool]], lib: Library, stabilizer: Stabilizer, args: argparse.Namespace,
         instant_keys: set[str] | frozenset[str] = frozenset()) -> list[Path]:
    """Register new recordings and return those ready to process, oldest first.

    sources are (folder, instant) pairs. Files in an instant folder (uploads/) and instant_keys (manual
    requests) skip the settle wait: they are ready as soon as they are non-empty and not locked.
    """
    ready = []
    files = [(f, instant) for folder, instant in sources if folder.is_dir() for f in folder.iterdir()]
    for video, instant in sorted(files, key=lambda item: mtime(item[0])):
        if not video.is_file() or video.suffix.lower() not in mn.VIDEO_EXTENSIONS:
            continue
        key = str(video)
        entry = lib.videos.get(key)
        status = entry.get("status") if entry else None
        if status in ("done", "baseline"):
            continue
        if status == "failed" and (entry.get("attempts", 0) >= args.max_attempts or time.time() < entry.get("next_try", 0)):
            continue
        if entry is None:
            origin = "upload" if video.parent == lib.uploads_dir else "watch"
            log(f"[watch] new {'upload' if origin == 'upload' else 'recording'}: {video.name}")
            lib.update(key, source=key, status="pending", recorded=recorded_at(video), attempts=0, origin=origin)
            record(lib, key, "detected", 0)
        if instant or key in instant_keys:
            is_ready = video.stat().st_size > 0 and not is_locked(video)
        else:
            is_ready = stabilizer.ready(video)
        if is_ready:
            ready.append(video)
        elif events and status in (None, "pending") and (remaining := stabilizer.remaining(video)) is not None:
            events.send("settling", key=key, remaining_s=round(remaining))
    return ready


_worker_lock_fd: int | None = None  # held for the life of the process; the OS releases it on exit


def acquire_worker_lock(root: Path) -> bool:
    """Single writer per library: an exclusive lock on library/.worker.lock (holds the owner's PID)."""
    global _worker_lock_fd
    root.mkdir(parents=True, exist_ok=True)
    fd = os.open(root / ".worker.lock", os.O_RDWR | os.O_CREAT)
    try:
        if os.name == "nt":
            import msvcrt
            os.lseek(fd, 1024, os.SEEK_SET)  # lock a byte past the PID so other processes can still read it
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.lseek(fd, 0, os.SEEK_SET)
        pid = os.read(fd, 32).decode(errors="replace").strip() or "?"
        os.close(fd)
        log(f"[watch] another watcher is already running (pid {pid})")
        return False
    os.ftruncate(fd, 0)
    os.lseek(fd, 0, os.SEEK_SET)
    os.write(fd, str(os.getpid()).encode())
    _worker_lock_fd = fd
    return True


def prepare(args: argparse.Namespace, lib: Library, strict: bool = True) -> Path | None:
    """Startup shared by watch and serve: folder/tool checks, the worker lock, then baseline or restart reset.

    Returns the watch folder, or None when the worker must not start. strict (watch) stops on a missing
    folder or HandBrake; serve keeps running and reports them in `hello` instead.
    """
    watch_dir = Path(args.watch_dir).resolve()
    if not watch_dir.is_dir():
        log(f"Watch folder not found: {watch_dir}")
        if strict:
            return None
    if strict:
        find_handbrake(args.handbrake)
    if not acquire_worker_lock(lib.root):
        return None

    if lib.is_new:
        if not watch_dir.is_dir():  # baseline needs the folder; do not create the library without it
            return watch_dir
        existing = [f for f in watch_dir.iterdir() if f.is_file() and f.suffix.lower() in mn.VIDEO_EXTENSIONS]
        for video in existing:
            lib.videos[str(video)] = {"source": str(video), "status": "pending" if args.backfill else "baseline",
                                      "recorded": recorded_at(video), "attempts": 0, "updated": now_iso()}
        lib.save()
        log(f"[watch] new library at {lib.root}; {len(existing)} existing recordings "
            + ("queued (--backfill)" if args.backfill else "marked as baseline (use --backfill to process them)"))
    else:
        for entry in lib.videos.values():
            if entry.get("status") in IN_PROGRESS:  # interrupted by a crash or Ctrl+C
                entry["status"] = "pending"
            if entry.get("status") == "failed":  # restarting = retry now, not after the cool-down
                entry["next_try"] = 0
            if args.backfill and entry.get("status") == "baseline":
                entry["status"] = "pending"
        lib.save()
    return watch_dir


def cmd_watch(args: argparse.Namespace) -> int:
    lib = Library(Path(args.library).resolve())
    watch_dir = prepare(args, lib)
    if watch_dir is None:
        return 1

    stabilizer = Stabilizer(0 if args.once else args.settle)
    sources = [(watch_dir, False)]
    log(f"[watch] watching {watch_dir} every {args.interval}s (settle {args.settle}s); Ctrl+C to stop")
    try:
        while True:
            ready = scan(sources, lib, stabilizer, args)
            if args.once:
                ready = scan(sources, lib, stabilizer, args)  # second look confirms the files are not growing
            for video in ready:
                try:
                    process(video, lib, args)
                except mn.SignInRequired:
                    log("[watch] run `watcher.py signin`, then start the watcher again")
                    return 1
            if args.once:
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("\n[watch] stopped")
        return 0


# --- Desktop worker (serve) ----------------------------------------------------------------
# Protocol v1 (.claude/plans/desktop-app/01-python-event-protocol.md): events as JSON lines on stdout,
# commands as JSON lines on stdin ({"id", "cmd", ...} -> "ack"), logs unchanged on stderr.

class Worker:
    """State shared by serve's main loop and its stdin command thread (mutations under lib.lock)."""

    def __init__(self, lib: Library, args: argparse.Namespace, watch_dir: Path):
        self.lib, self.args, self.watch_dir = lib, args, watch_dir
        self.priority: deque[str] = deque()  # manual requests, processed first
        self.included: set[str] = set()  # baseline recordings included by hand: no settle wait, normal order
        self.paused = threading.Event()
        self.pause_reason: str | None = None  # "signin": paused by the worker itself (session expired on the hidden desktop)
        self.wake = threading.Event()
        self.stopping = False
        self.current: str | None = None

    # --- events

    def send_snapshot(self) -> None:
        with self.lib.lock:
            events.send("snapshot", videos=self.lib.videos)

    def send_state(self) -> None:
        with self.lib.lock:
            pending = sorted((k for k, e in self.lib.videos.items() if e.get("status") == "pending" and k not in self.priority),
                             key=lambda k: self.lib.videos[k].get("recorded", ""))
            queue = [k for k in [*self.priority, *pending] if k != self.current]
        state = "busy" if self.current else "paused" if self.paused.is_set() else "idle"
        events.send("worker", state=state, paused=self.paused.is_set(), queue=queue,
                    **({"current": self.current} if self.current else {}),
                    **({"pause_reason": self.pause_reason} if self.paused.is_set() and self.pause_reason else {}))

    # --- commands

    def read_commands(self) -> None:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                cmd = json.loads(line)
                if not isinstance(cmd, dict):
                    raise ValueError("a command must be a JSON object")
            except ValueError as exc:
                events.send("ack", id=None, ok=False, error=f"bad command: {exc}")
                continue
            try:
                warning = self.handle(cmd)
            except Exception as exc:  # refusals are ValueErrors; nothing may kill this thread
                events.send("ack", id=cmd.get("id"), ok=False, error=str(exc))
                continue
            events.send("ack", id=cmd.get("id"), ok=True, **({"warning": warning} if warning else {}))
        log("[serve] stdin closed; stopping after the current video")
        self.stopping = True
        self.wake.set()

    def handle(self, cmd: dict) -> str | None:
        name = cmd.get("cmd")
        handler = getattr(self, f"do_{name}", None) if isinstance(name, str) and name.isidentifier() else None
        if handler is None:
            raise ValueError(f"unknown command: {name}")
        with self.lib.lock:
            return handler(cmd)

    def entry(self, cmd: dict) -> tuple[str, dict]:
        key = cmd.get("key")
        if not isinstance(key, str) or key not in self.lib.videos:
            raise ValueError(f"unknown video: {key}")
        return key, self.lib.videos[key]

    def check_idle(self, key: str) -> None:
        if key == self.current:
            raise ValueError("this video is being processed")

    def check_source(self, key: str) -> None:
        if not Path(key).is_file():
            raise ValueError(f"the recording no longer exists: {key}")

    def push(self, key: str) -> None:
        if key in self.priority:
            self.priority.remove(key)
        self.priority.appendleft(key)
        self.wake.set()

    def do_ping(self, cmd: dict) -> None:
        pass

    def do_snapshot(self, cmd: dict) -> None:
        self.send_snapshot()

    def do_scan_now(self, cmd: dict) -> None:
        self.wake.set()

    def do_pause(self, cmd: dict) -> None:
        self.paused.set()
        self.wake.set()
        self.send_state()

    def do_resume(self, cmd: dict) -> None:
        self.paused.clear()
        self.pause_reason = None
        self.wake.set()
        self.send_state()

    def do_enqueue(self, cmd: dict) -> None:
        path = Path(str(cmd.get("path", ""))).resolve()
        if not path.is_file():
            raise ValueError(f"file not found: {path}")
        if path.suffix.lower() not in mn.VIDEO_EXTENSIONS:
            raise ValueError(f"not a video file: {path.name}")
        if path.parent not in (self.watch_dir, self.lib.uploads_dir):
            raise ValueError("only files in the watch folder or library/uploads can be queued")
        key = str(path)
        self.check_idle(key)
        status = self.lib.videos.get(key, {}).get("status")
        if status is None:
            origin = "upload" if path.parent == self.lib.uploads_dir else "watch"
            self.lib.update(key, source=key, status="pending", recorded=recorded_at(path), attempts=0, origin=origin)
            record(self.lib, key, "detected", 0)
        elif status != "pending":
            raise ValueError(f"already {status}; use retry, reprocess or include")
        self.push(key)

    def do_retry(self, cmd: dict) -> None:
        key, entry = self.entry(cmd)
        if entry.get("status") != "failed":
            raise ValueError(f"only failed videos can be retried (this one is {entry.get('status')})")
        self.check_source(key)
        self.lib.update(key, status="pending", attempts=0, next_try=0, error=None)
        self.push(key)

    def do_reprocess(self, cmd: dict) -> None:
        key, entry = self.entry(cmd)
        self.check_idle(key)
        if entry.get("status") in IN_PROGRESS:
            raise ValueError("this video is being processed")
        self.check_source(key)
        fields: dict = {"status": "pending", "attempts": 0, "next_try": 0, "error": None}
        if cmd.get("recompress"):
            for encode in {Path(entry["compressed"]) if entry.get("compressed") else None, self.lib.compressed_dir / f"{Path(key).stem}.mp4"}:
                if encode is not None and encode.parent == self.lib.compressed_dir:
                    encode.unlink(missing_ok=True)
            fields.update(compressed=None, compressed_size=None)
        self.lib.update(key, **fields)
        self.push(key)

    def do_include(self, cmd: dict) -> None:
        key, entry = self.entry(cmd)
        if entry.get("status") != "baseline":
            raise ValueError(f"only baseline recordings can be included (this one is {entry.get('status')})")
        self.check_source(key)
        self.lib.update(key, status="pending")
        self.included.add(key)
        self.wake.set()

    def do_include_all_baseline(self, cmd: dict) -> str | None:
        keys = [k for k, e in self.lib.videos.items() if e.get("status") == "baseline" and Path(k).is_file()]
        for key in keys:
            self.lib.videos[key].update(status="pending", updated=now_iso())
            self.included.add(key)
        self.lib.save()  # one write for all of them; each changed entry is still sent as a `video` event
        for key in keys:
            events.send("video", key=key, entry=self.lib.videos[key])
        self.wake.set()
        missing = sum(1 for e in self.lib.videos.values() if e.get("status") == "baseline")
        return f"{missing} baseline recording(s) skipped: file no longer exists" if missing else None

    def do_exclude(self, cmd: dict) -> None:
        key, entry = self.entry(cmd)
        self.check_idle(key)
        if entry.get("status") not in ("pending", "failed"):
            raise ValueError(f"only pending or failed videos can be excluded (this one is {entry.get('status')})")
        self.lib.update(key, status="baseline")
        if key in self.priority:
            self.priority.remove(key)
        self.included.discard(key)

    def do_edit(self, cmd: dict) -> str | None:
        key, _ = self.entry(cmd)
        self.check_idle(key)
        return edit_note(self.lib, key, cmd.get("title"), cmd.get("category"), cmd.get("tags"))

    def do_delete(self, cmd: dict) -> None:
        """The app's Delete. The app moves the files to the Recycle Bin first; this only updates the index.

        video=false: the note is gone and the recording stays, as a baseline entry (not processed again unless
        included). video=true: the recording and its compressed copy are gone too, and the entry is dropped. Refused
        while a file is still there, so a scan can never pick the recording up again as new.
        """
        key, entry = self.entry(cmd)
        self.check_idle(key)
        if entry.get("status") in IN_PROGRESS:
            raise ValueError("this video is being processed")
        note = self.lib.root / entry["notes"] if entry.get("notes") else None
        if note is not None and note.is_file():
            raise ValueError(f"the note is still there: {note}")
        if key in self.priority:
            self.priority.remove(key)
        self.included.discard(key)
        if cmd.get("video"):
            if Path(key).is_file():
                raise ValueError(f"the recording is still there: {key}")
            self.lib.remove(key)
            self.send_snapshot()
        else:
            if note is None:
                raise ValueError("this recording has no note")
            self.lib.update(key, status="baseline", notes=None, processed=None)

    def do_reindex(self, cmd: dict) -> None:
        self.lib.write_markdown_index()

    def do_shutdown(self, cmd: dict) -> None:
        # Busy: refuse unless after_current; the app then asks the user and hard-kills if confirmed.
        if self.current and not cmd.get("after_current"):
            raise ValueError("busy")
        self.stopping = True
        self.wake.set()

    # --- main loop

    def run(self) -> int:
        stabilizer = Stabilizer(self.args.settle)
        sources = [(self.lib.uploads_dir, True)] + ([(self.watch_dir, False)] if self.watch_dir.is_dir() else [])
        log(f"[serve] watching {self.watch_dir} + {self.lib.uploads_dir} every {self.args.interval}s (settle {self.args.settle}s)")
        self.send_state()
        try:
            while not self.stopping:
                if self.paused.is_set():
                    self.send_state()
                    self.wake.wait()
                    self.wake.clear()
                    continue
                with self.lib.lock:
                    instant = set(self.priority) | self.included
                try:
                    ready = scan(sources, self.lib, stabilizer, self.args, instant)
                except OSError as exc:  # a file vanished mid-scan; try again next round
                    log(f"[warn] scan failed: {exc}")
                    ready = []
                by_key = {str(v): v for v in ready}
                with self.lib.lock:
                    first = [k for k in self.priority if k in by_key]
                ordered = [by_key[k] for k in first] + [v for v in ready if str(v) not in first]
                for video in ordered:
                    if self.paused.is_set() or self.stopping:
                        break
                    key = str(video)
                    with self.lib.lock:
                        entry = self.lib.videos.get(key, {})
                        if entry.get("status") not in ("pending", "failed"):  # changed by a command since the scan
                            continue
                        if key in self.priority:
                            self.priority.remove(key)
                        self.included.discard(key)
                        self.current = key
                    self.send_state()
                    record(self.lib, key, "ready", entry.get("attempts", 0) + 1)
                    try:
                        process(video, self.lib, self.args, on_progress=lambda pct, eta, fps, key=key: events.send(
                            "progress", key=key, stage="compressing", pct=round(pct, 2),
                            **{k: v for k, v in (("eta", eta), ("fps", fps)) if v is not None}))
                    except mn.SignInRequired:
                        # Every video would hit the same wall: pause until the app's sign-in resumes us,
                        # then this one goes first. A pause the user asked for keeps its (empty) reason.
                        with self.lib.lock:
                            if not self.paused.is_set():
                                self.pause_reason = "signin"
                                self.paused.set()
                            if key not in self.priority:
                                self.priority.appendleft(key)
                    self.current = None
                    self.send_state()
                if self.stopping:
                    break
                self.wake.wait(self.args.interval)
                self.wake.clear()
        except KeyboardInterrupt:
            log("\n[serve] stopped")
        return 0


def health_checks(args: argparse.Namespace, watch_dir: Path) -> dict:
    checks: dict = {"watch_dir_ok": watch_dir.is_dir()}
    try:
        checks["handbrake"] = {"ok": True, "path": str(find_handbrake(args.handbrake))}
    except RuntimeError as exc:
        checks["handbrake"] = {"ok": False, "error": str(exc)}
    chrome = mn.find_chrome()
    checks["chrome"] = {"ok": True, "path": chrome} if chrome else {"ok": False, "error": "Google Chrome not found; install it or add it to PATH"}
    return checks


def cmd_serve(args: argparse.Namespace) -> int:
    global events
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    events = EventStream()
    lib = Library(Path(args.library).resolve(), on_change=lambda key, entry: events.send("video", key=key, entry=entry))
    watch_dir = prepare(args, lib, strict=False)
    if watch_dir is None:
        return 1
    lib.uploads_dir.mkdir(parents=True, exist_ok=True)
    worker = Worker(lib, args, watch_dir)
    events.send("hello", protocol=1, pid=os.getpid(), library=str(lib.root), watch_dir=str(watch_dir),
                categories=mn.CATEGORIES, suggested_tags=mn.SUGGESTED_TAGS, video_extensions=sorted(mn.VIDEO_EXTENSIONS),
                checks=health_checks(args, watch_dir), settings={k: v for k, v in vars(args).items() if k != "command"})
    worker.send_snapshot()
    threading.Thread(target=worker.read_commands, name="commands", daemon=True).start()
    close_orphaned_chrome(args.port)
    code = worker.run()
    sys.stdout.flush()
    sys.stderr.flush()
    # The command thread may be blocked reading stdin; a normal interpreter exit can hang or abort on
    # its buffer lock, so leave directly (the OS releases the worker lock).
    os._exit(code)


def cmd_check(args: argparse.Namespace) -> int:
    """Health checks for the setup wizard: no worker lock, no library (none may be chosen yet)."""
    sys.stdout.reconfigure(encoding="utf-8")
    profile = mn.profile_path(args.profile_dir)
    result = {**health_checks(args, Path(args.watch_dir).resolve()), "profile_dir": str(profile),
              "signed_in_hint": profile.is_dir() and any(profile.iterdir())}
    log(f"[check] chrome {'ok' if result['chrome']['ok'] else 'missing'}, handbrake {'ok' if result['handbrake']['ok'] else 'missing'}, "
        f"watch folder {'ok' if result['watch_dir_ok'] else 'missing'}")
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


GOOGLE_LOGOUT = "https://accounts.google.com/Logout"


def quit_chrome(playwright, port: int) -> None:
    """Quit whatever Chrome answers on the port (e.g. one on the hidden desktop, same profile) and wait until it is gone."""
    browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
    try:
        browser.new_browser_cdp_session().send("Browser.close")
    except Exception:
        pass  # the connection drops while Chrome quits
    for _ in range(20):
        if not mn.cdp_ready(port):
            time.sleep(1)  # let Chrome release the profile folder too
            return
        time.sleep(0.5)
    raise RuntimeError(f"Chrome on port {port} did not quit")


def close_orphaned_chrome(port: int) -> None:
    """At worker start, quit any Chrome already on the port: this worker didn't start it.

    Chrome on the hidden desktop normally dies with the engine (kill-on-close job), but one can outlive it, e.g.
    from an older build or a failed job setup. Invisible, it would otherwise hold memory and the profile until logoff.
    """
    if not mn.cdp_ready(port):
        return
    log(f"[serve] closing a Chrome left on port {port} by an earlier run")
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as p:
            quit_chrome(p, port)
    except Exception as exc:  # not fatal: the next video attaches to it as before
        log(f"[warn] could not close it: {exc}")


def signed_in_account(page) -> str | None:
    """The signed-in email from AI Studio's account button label; None when it cannot be read."""
    try:
        for label in page.locator("[aria-label*='Google Account'], [aria-label*='@']").evaluate_all(
                "els => els.map(e => e.getAttribute('aria-label'))"):
            if match := re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", label or ""):
                return match.group(0)
    except Exception as exc:
        log(f"[signin] could not read the account ({exc.__class__.__name__})")
    return None


def cmd_signin(args: argparse.Namespace) -> int:
    """Open a visible AI Studio window and wait for Google sign-in (always visible, whatever --hidden says).

    Events (JSON lines on stdout): chrome_start, login_required, then signin_ok {account} / signout_ok,
    or signin_failed {error} with exit code 1. Chrome is closed at the end, so the next video starts fresh.
    """
    from playwright.sync_api import sync_playwright

    sys.stdout.reconfigure(encoding="utf-8")
    stream = EventStream()
    mn.on_event = lambda stage, detail: stream.send(stage, **detail)
    page = None
    try:
        with sync_playwright() as p:
            if mn.cdp_ready(args.port):
                log(f"[signin] closing the Chrome already running on port {args.port}")
                quit_chrome(p, args.port)
            mn.ensure_chrome(args.port, profile_dir=args.profile_dir)
            browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{args.port}")
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.new_page()
            page.bring_to_front()
            if args.switch or args.signout_only:
                log("[signin] signing out of Google")
                page.goto(GOOGLE_LOGOUT, wait_until="domcontentloaded", timeout=60_000)
            if args.signout_only:
                stream.send("signout_ok")
            else:
                mn.open_new_chat(page, args.model, args.login_wait)
                account = signed_in_account(page)
                log(f"[signin] signed in{f' as {account}' if account else ''}")
                stream.send("signin_ok", account=account)
            try:
                browser.new_browser_cdp_session().send("Browser.close")
            except Exception as exc:
                log(f"[warn] could not close Chrome: {exc}")
        return 0
    except Exception as exc:
        error = str(exc).splitlines()[0][:300] if str(exc) else exc.__class__.__name__
        try:
            if page is not None and "accounts.google.com" in page.url and "Timeout" in error:
                error = f"Google sign-in was not finished within {args.login_wait}s"
        except Exception:
            pass  # Chrome was closed by the user
        log(f"[signin] failed: {error}")
        stream.send("signin_failed", error=error)
        return 1


def cmd_list(args: argparse.Namespace) -> int:
    lib = Library(Path(args.library).resolve())
    wanted_tags = {mn.slugify(t) for t in args.tag}
    rows = []
    for e in lib.videos.values():
        if e.get("status") != "done":
            continue
        if args.category and e["category"] != mn.slugify(args.category):
            continue
        if not wanted_tags <= set(e["tags"]):
            continue
        if args.search and args.search.lower() not in f"{e.get('title', '')} {e.get('summary', '')}".lower():
            continue
        rows.append(e)
    for e in sorted(rows, key=lambda e: e["recorded"], reverse=True):
        print(f"{e['recorded'][:16].replace('T', ' ')}  [{e['category']}]  {e['title']}")
        print(f"    tags: {', '.join(e['tags'])}")
        print(f"    notes: {lib.root / e['notes']}")
    print(f"\n{len(rows)} meeting(s)")
    return 0


def cmd_reindex(args: argparse.Namespace) -> int:
    lib = Library(Path(args.library).resolve())
    lib.write_markdown_index()
    print(lib.root / "INDEX.md")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Watch recordings, compress, generate notes and index them.")
    parser.add_argument("--library", default=str(DEFAULT_LIBRARY), help=f"Library folder (default: {DEFAULT_LIBRARY})")
    sub = parser.add_subparsers(dest="command", required=True)

    watch = sub.add_parser("watch", help="Poll the recordings folder and process new meetings")
    watch.add_argument("--once", action="store_true", help="Scan once, process what is ready, then exit")
    add_watch_args(watch)

    serve = sub.add_parser("serve", help="Long-running worker for the desktop app (JSON lines on stdin/stdout)")
    add_watch_args(serve)

    lst = sub.add_parser("list", help="Filter processed meetings")
    lst.add_argument("--category", help=f"One of: {', '.join(mn.CATEGORIES)}")
    lst.add_argument("--tag", action="append", default=[], help="Required tag (repeat for AND)")
    lst.add_argument("--search", help="Text to find in title/summary")

    sub.add_parser("reindex", help="Rebuild INDEX.md from index.json")

    check = sub.add_parser("check", help="Print health checks (HandBrake, Chrome, watch folder, profile) as one JSON line")
    check.add_argument("--watch-dir", default=str(DEFAULT_WATCH_DIR), help=f"Folder to watch (default: {DEFAULT_WATCH_DIR})")
    check.add_argument("--handbrake", help="Path to HandBrakeCLI.exe (default: tools/handbrake or Program Files)")
    check.add_argument("--profile-dir", help="Chrome profile folder for the automation Chrome (default: .chrome-automation next to the script)")

    signin = sub.add_parser("signin", help="Open AI Studio in a visible Chrome and wait for Google sign-in (JSON events on stdout)")
    mode = signin.add_mutually_exclusive_group()
    mode.add_argument("--switch", action="store_true", help="Sign out of Google first, so any account can sign in")
    mode.add_argument("--signout-only", action="store_true", help="Only sign out of Google")
    mn.add_generation_args(signin)
    args = parser.parse_args()
    if args.command in ("watch", "serve"):
        mn.load_context(args)
    return args


def add_watch_args(parser: argparse.ArgumentParser) -> None:
    """Options shared by watch and serve."""
    parser.add_argument("--watch-dir", default=str(DEFAULT_WATCH_DIR), help=f"Folder to watch (default: {DEFAULT_WATCH_DIR})")
    parser.add_argument("--interval", type=int, default=60, help="Seconds between scans (default: 60)")
    parser.add_argument("--settle", type=int, default=120, help="Seconds a file must stay unchanged before processing (default: 120)")
    parser.add_argument("--backfill", action="store_true", help="Also process recordings that existed before the library was created")
    parser.add_argument("--max-attempts", type=int, default=3, help="Give up on a recording after this many failed runs (default: 3)")
    parser.add_argument("--handbrake", help="Path to HandBrakeCLI.exe (default: tools/handbrake or Program Files)")
    parser.add_argument("--hb-preset", default="Fast 1080p30", help='HandBrake base preset (default: "Fast 1080p30")')
    parser.add_argument("--hb-quality", type=float, default=25, help="Constant quality RF; higher = smaller (default: 25)")
    parser.add_argument("--hb-encoder", help="Override the video encoder, e.g. qsv_h264 for Intel Quick Sync (faster)")
    parser.add_argument("--hb-speed", choices=["background", "full"], default="background",
                        help="background = low priority and efficiency mode, lighter on the PC but slower; "
                             "full = as fast as possible (default: background)")
    mn.add_generation_args(parser)


def main() -> int:
    args = parse_args()
    return {"watch": cmd_watch, "serve": cmd_serve, "list": cmd_list, "reindex": cmd_reindex,
            "check": cmd_check, "signin": cmd_signin}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
