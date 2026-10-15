"""Turn meeting recordings into structured Markdown notes by driving Google AI Studio in Chrome.

No API key is used: the script attaches (via Playwright/CDP) to a dedicated Chrome profile in
.chrome-automation/ that is signed in to Google, uploads the video to AI Studio, runs the prompt
and copies the answer with "Copy as markdown". The first run opens Chrome; sign in once and the
session is reused afterwards.

Usage:
    python meeting_notes.py path/to/meeting.mp4
    python meeting_notes.py recordings/ --out docs/ --context "Sprint planning for the billing module"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterator

from playwright.sync_api import Page, sync_playwright

DEFAULT_MODEL = "gemini-3.8-flash"
VIDEO_EXTENSIONS = {".mp4", ".mpeg", ".mpg", ".mov", ".avi", ".flv", ".webm", ".wmv", ".3gp", ".3gpp"}
AISTUDIO_ORIGIN = "https://aistudio.google.com"
PROFILE_DIR = Path(__file__).with_name(".chrome-automation")  # default; --profile-dir overrides it
CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
]

SYSTEM_INSTRUCTION = """\
You are a senior business analyst and technical writer. You watch recorded meetings
(screen shares, demos, walkthroughs, discussions) and produce precise, reusable
documentation for people who did not attend.

Rules:
- Use BOTH the audio (what was said) and the visuals (slides, screens, code, diagrams,
  UI clicked through). When something was shown on screen, describe what was shown.
- Be faithful to the recording. Never invent decisions, numbers, names or rules.
  If something was ambiguous or left unresolved, say so explicitly.
- Cite timestamps in [MM:SS] (or [HH:MM:SS] for recordings over an hour) for every
  substantive point so readers can jump back to the source.
- Prefer concrete specifics (field names, statuses, thresholds, screen names, formulas)
  over vague summaries.
- Refer to people by the name used in the meeting; if unknown, use their role
  (e.g. "Presenter", "Client", "Developer").
- Output ONLY the Markdown document, with no preamble or closing remarks.
"""

# Category = the meeting's main purpose; used to route notes into library/notes/<category>/.
CATEGORIES = {
    "flow-walkthrough": "explains or demonstrates an end-to-end business/system flow",
    "requirements": "gathers new requirements or features",
    "change-request": "modifies an existing flow, feature or rule",
    "doubt-clearing": "mainly questions and clarifications on something already known",
    "demo-review": "demo or review of built work, with feedback",
    "technical-design": "architecture, data model, APIs, code or infrastructure discussion",
    "planning-status": "standup, sprint planning, status update or prioritisation",
    "other": "none of the above",
}
# Suggested tags; the model may add new kebab-case tags when none of these fit.
SUGGESTED_TAGS = [
    "discusses-flow", "doubts-queries", "modify-existing-flow", "new-information", "requirements",
    "business-rules", "decisions", "action-items", "bug-issue", "ui-ux", "data-model", "integration",
    "reporting", "permissions-roles", "deadline-timeline", "client-feedback", "blocker", "demo",
]

METADATA_PROMPT = """\
Start your response with a ```json code block containing exactly this object, then a blank
line, then the Markdown document:
{{"title": "<concise meeting title>",
  "category": "<one category id>",
  "tags": ["<tag>", ...],
  "summary": "<one sentence>",
  "participants": ["<name or role>", ...]}}

Category ids (pick the single best fit for the meeting's main purpose):
{categories}

Tags: choose every tag that applies (usually 3-8) from: {tags}.
If an important aspect is not covered, add your own short kebab-case tag.

"""

DOCUMENT_PROMPT = """\
Analyse this meeting recording end to end and produce a Markdown document with exactly
these sections (if the meeting truly contains nothing for a section, keep the heading
and write "_None discussed._"):

# <Concise meeting title>

## Overview
2-4 sentences: purpose of the meeting, who took part (names/roles), and the outcome.

## Agenda / Topics Covered
Bulleted list of the topics in the order discussed, each with a [timestamp].

## Process Flow
The end-to-end flow(s) explained or demonstrated, as numbered steps (actor -> action ->
result). For each distinct flow, also include a Mermaid `flowchart TD` diagram in a
```mermaid code block. Keep node labels short and quote any label with special characters.

## Business Logic & Rules
Every rule, condition, validation, calculation, status transition, permission or edge
case mentioned. Use a table: | Rule | Details / Conditions | Timestamp |

## Key Terms & Glossary
Domain terms, acronyms, entities, system/module names. Table: | Term | Meaning in this context |

## Doubts Raised & Resolutions
Each question or confusion raised and how it was answered/explained.
Format each as:
**Q [timestamp] (asked by):** the question
**A (answered by):** the explanation given
Mark anything left unanswered as **Unresolved**.

## Decisions Made
Bulleted list of agreed decisions with [timestamp].

## Action Items
Table: | Owner | Task | Due / Priority (if mentioned) | Timestamp |

## Important Notes
Warnings, caveats, dependencies, risks, assumptions, and anything a developer or
stakeholder must not miss.

## Open Questions / Follow-ups
Items explicitly deferred or still unclear at the end of the meeting.
"""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# Optional observer for pipeline steps (watcher.py serve installs one); a no-op by default.
on_event: Callable[[str, dict], None] | None = None


def emit(stage: str, **detail) -> None:
    """Report a pipeline step to on_event; a failing hook is logged and never breaks the run."""
    if on_event is None:
        return
    try:
        on_event(stage, detail)
    except Exception as exc:
        log(f"[warn] event hook failed on {stage}: {exc}")


def collect_videos(inputs: list[str]) -> list[Path]:
    videos: list[Path] = []
    for raw in inputs:
        p = Path(raw)
        if p.is_dir():
            videos.extend(sorted(f for f in p.iterdir() if f.suffix.lower() in VIDEO_EXTENSIONS))
        elif p.is_file():
            videos.append(p)
        else:
            log(f"[skip] not found: {p}")
    return videos


def build_prompt(context: str | None, language: str) -> str:
    categories = "\n".join(f"- {cid}: {desc}" for cid, desc in CATEGORIES.items())
    prompt = METADATA_PROMPT.format(categories=categories, tags=", ".join(SUGGESTED_TAGS)) + DOCUMENT_PROMPT
    if context:
        prompt += f"\nBackground context provided by the user (use it to interpret terms, do not copy it verbatim):\n{context}\n"
    if language.lower() != "english":
        prompt += f"\nWrite the document in {language}. Keep code, field names and quoted UI text as-is.\n"
    return prompt


def strip_code_fence(text: str) -> str:
    """Some responses wrap the whole document in ```markdown ... ``` - unwrap it."""
    stripped = text.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        first_newline = stripped.find("\n")
        if stripped[3:first_newline].strip().lower() in ("", "markdown", "md"):
            return stripped[first_newline + 1 : -3].strip()
    return stripped


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def split_metadata(text: str) -> tuple[dict, str]:
    """Separate the leading ```json metadata block from the Markdown document and normalise it."""
    meta: dict = {}
    # The clipboard answer has CRLF line endings; write_text adds its own \r on Windows, so keep plain \n here.
    body = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    match = re.match(r"```(?:json)?\s*(\{.*?\})\s*```\s*", body, re.DOTALL)
    if match:
        try:
            meta = json.loads(match.group(1))
            body = body[match.end():]
        except json.JSONDecodeError as exc:
            log(f"[warn] metadata block is not valid JSON ({exc}); category/tags left empty")
    else:
        log("[warn] response has no metadata block; category/tags left empty")

    category = slugify(str(meta.get("category", "")))
    meta["category"] = category if category in CATEGORIES else "other"
    meta["tags"] = sorted({slugify(str(t)) for t in meta.get("tags", []) if slugify(str(t))})
    meta["participants"] = [str(p) for p in meta.get("participants", [])]
    for key in ("title", "summary"):
        meta[key] = " ".join(str(meta.get(key, "")).split())
    body = strip_code_fence(body)
    if not meta["title"]:
        heading = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
        meta["title"] = heading.group(1).strip() if heading else ""
    return meta, body


def render_header(video: Path, model: str, thinking_level: str, meta: dict | None = None) -> str:
    meta = meta or {}
    lines = ["---"]
    if meta.get("title"):
        lines.append(f"title: {json.dumps(meta['title'], ensure_ascii=False)}")
    if meta.get("category"):
        lines.append(f"category: {meta['category']}")
    if "tags" in meta:
        lines.append(f"tags: [{', '.join(meta['tags'])}]")
    if meta.get("summary"):
        lines.append(f"summary: {json.dumps(meta['summary'], ensure_ascii=False)}")
    if meta.get("participants"):
        lines.append(f"participants: {json.dumps(meta['participants'], ensure_ascii=False)}")
    if meta.get("recorded"):
        lines.append(f"recorded: {meta['recorded']}")
    lines += [
        f"source: {json.dumps(video.name, ensure_ascii=False)}",
        f"generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"model: {model}",
        f"thinking_level: {thinking_level}",
        "via: Google AI Studio",
        "---\n",
    ]
    return "\n".join(lines)


# --- Chrome ------------------------------------------------------------------------------

def cdp_ready(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2):
            return True
    except OSError:
        return False


def registry_chrome() -> str | None:
    """Chrome's path from the Windows "App Paths" registration (per-user first, then machine-wide)."""
    if sys.platform != "win32":
        return None
    import winreg
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe") as key:
                path = str(winreg.QueryValueEx(key, "")[0]).strip('"')
        except OSError:
            continue
        if path and Path(path).exists():
            return path
    return None


def find_chrome() -> str | None:
    # Per-user installs (no admin rights) live under %LOCALAPPDATA%, not Program Files.
    local = os.environ.get("LOCALAPPDATA")
    candidates = CHROME_CANDIDATES + ([str(Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe")] if local else [])
    return (next((c for c in candidates if Path(c).exists()), None) or registry_chrome()
            or shutil.which("chrome") or shutil.which("google-chrome"))


def profile_path(profile_dir: str | Path | None) -> Path:
    return Path(profile_dir).resolve() if profile_dir else PROFILE_DIR


# --- Hidden desktop (Windows) ----------------------------------------------------------------
# Headless Chrome can't be used: AI Studio answers GenerateContent with 403 "The caller does not have permission"
# for it (11f·T1). A normal Chrome on a second, never-shown Windows desktop has no window or taskbar button for the
# user, yet AI Studio treats it like any visible browser.

HIDDEN_DESKTOP = "MissMinutesAutomation"
# Fixed size, so AI Studio gets the same layout on every monitor (Windows only trims a window taller than the screen).
HIDDEN_WINDOW = ["--window-size=1280,800", "--window-position=0,0"]
_hidden_handles: list = []  # the desktop and the job: held for the life of this process, never closed by hand


def start_on_hidden_desktop(cmd: list[str]) -> bool:
    """Start cmd on the hidden desktop, inside a kill-on-close job. False (logged) when that isn't possible.

    The job ties Chrome to this process: however the engine ends (even killed), Windows closes the job and ends
    Chrome with it, so an invisible Chrome is never left behind.
    """
    if sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR),
                    ("lpTitle", wintypes.LPWSTR), ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
                    ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD), ("dwXCountChars", wintypes.DWORD),
                    ("dwYCountChars", wintypes.DWORD), ("dwFillAttribute", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
                    ("lpReserved2", ctypes.c_void_p), ("hStdInput", wintypes.HANDLE),
                    ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE)]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
                    ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION), ("IoInfo", ctypes.c_uint64 * 6),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.CreateDesktopW.restype = wintypes.HANDLE
    user32.CreateDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD,
                                      wintypes.DWORD, ctypes.c_void_p]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    if not _hidden_handles:  # once per process; every Chrome it starts (one per video) shares them
        # Opens the desktop when it already exists (e.g. kept alive by an orphaned Chrome).
        desktop = user32.CreateDesktopW(HIDDEN_DESKTOP, None, None, 0, 0x10000000, None)  # GENERIC_ALL
        if not desktop:
            log(f"[warn] could not create the hidden desktop (error {ctypes.get_last_error()}); Chrome will be visible")
            return False
        job = kernel32.CreateJobObjectW(None, None)
        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not job or not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            log(f"[warn] could not create the Chrome job (error {ctypes.get_last_error()}); Chrome will be visible")
            return False
        _hidden_handles.extend([desktop, job])
    job = _hidden_handles[1]

    startup = STARTUPINFOW()
    startup.cb = ctypes.sizeof(startup)
    startup.lpDesktop = f"WinSta0\\{HIDDEN_DESKTOP}"
    process = PROCESS_INFORMATION()
    # Suspended until it is in the job, so the processes Chrome starts right away are in it too.
    flags = 0x4 | 0x8 | 0x200  # CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    if not kernel32.CreateProcessW(None, ctypes.create_unicode_buffer(subprocess.list2cmdline(cmd)), None, None,
                                   False, flags, None, None, ctypes.byref(startup), ctypes.byref(process)):
        log(f"[warn] could not start Chrome on the hidden desktop (error {ctypes.get_last_error()}); it will be visible")
        return False
    try:
        if not kernel32.AssignProcessToJobObject(job, process.hProcess):
            kernel32.TerminateProcess(process.hProcess, 1)
            log(f"[warn] could not put Chrome in its job (error {ctypes.get_last_error()}); it will be visible")
            return False
        kernel32.ResumeThread(process.hThread)
        return True
    finally:
        kernel32.CloseHandle(process.hThread)
        kernel32.CloseHandle(process.hProcess)


def ensure_chrome(port: int, *, profile_dir: str | Path | None = None, hidden: bool = False) -> None:
    """Start a normal (non-automation-flagged) Chrome on the dedicated profile, so Google sign-in works."""
    if cdp_ready(port):
        return
    chrome = find_chrome()
    if not chrome:
        raise RuntimeError("Google Chrome not found; install it or add it to PATH")
    profile = profile_path(profile_dir)
    log(f"[chrome] starting Chrome{' on a hidden desktop' if hidden else ''} (profile: {profile})")
    emit("chrome_start")
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    cmd = [chrome, f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check"]
    if not (hidden and start_on_hidden_desktop(cmd + HIDDEN_WINDOW)):
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
    for _ in range(30):
        if cdp_ready(port):
            return
        time.sleep(1)
    raise RuntimeError(f"Chrome did not open its debugging port {port}")


# --- AI Studio page actions ----------------------------------------------------------------

class SignInRequired(RuntimeError):
    """The Google session is gone and Chrome runs on the hidden desktop, so nobody can sign in there."""


def open_new_chat(page: Page, model: str, login_wait: int, *, hidden: bool = False) -> None:
    page.goto(f"{AISTUDIO_ORIGIN}/prompts/new_chat?model={model}", wait_until="domcontentloaded", timeout=60_000)
    prompt_box = page.get_by_role("textbox", name="Enter a prompt")
    try:
        if "accounts.google.com" in page.url:  # already redirected; no need to wait for the prompt box
            raise RuntimeError("redirected to Google sign-in")
        prompt_box.wait_for(timeout=30_000)
    except Exception:
        if "accounts.google.com" not in page.url:
            raise
        if hidden:
            log("[login] Google sign-in required; it needs a visible Chrome window (watcher.py signin)")
            emit("login_required", wait_s=0, hidden=True)
            raise SignInRequired("Google sign-in required") from None
        log(f"[login] Sign in to Google in the Chrome window (waiting up to {login_wait // 60} min)...")
        emit("login_required", wait_s=login_wait)
        page.bring_to_front()
        page.wait_for_url(f"{AISTUDIO_ORIGIN}/**", timeout=login_wait * 1000)
        page.goto(f"{AISTUDIO_ORIGIN}/prompts/new_chat?model={model}", wait_until="domcontentloaded")
        prompt_box.wait_for(timeout=60_000)
    tour = page.get_by_role("button", name="Close guided tour")
    if tour.is_visible():
        tour.click()


def configure_run_settings(page: Page, system_instruction: str, thinking_level: str) -> None:
    thinking = page.locator("mat-select[aria-label='Thinking Level']")
    if not thinking.is_visible():
        page.get_by_role("button", name="Toggle run settings panel").click()
        page.wait_for_timeout(800)

    try:
        thinking.wait_for(state="visible", timeout=3_000)
        thinking.click()
        page.get_by_role("option", name=thinking_level.capitalize(), exact=True).click()
        page.wait_for_timeout(300)
    except Exception as exc:
        log(f"[warn] could not set thinking level ({exc.__class__.__name__}); using the model default")

    # System instructions open in their own panel (closing it also closes the settings sidebar);
    # AI Studio keeps the text in local storage.
    page.locator("button[aria-label='System instructions']").click()
    si_box = page.locator(".cdk-overlay-container textarea[aria-label='System instructions']")
    si_box.wait_for(timeout=10_000)
    si_box.fill(system_instruction)
    page.locator(".cdk-overlay-container").get_by_role("button", name="Close panel").click()
    page.wait_for_timeout(400)

    # On narrow windows the settings panel is an overlay that blocks the prompt area. Closing the
    # system-instructions panel usually fades it out; otherwise close it via its backdrop (the
    # panel's own close button sits next to "Get code" and moves while animating).
    # Wide windows dock the panel instead and keep zero-size overlay elements around, so only
    # visible overlays count.
    overlay = page.locator(".sidebar-overlay:visible")
    try:
        overlay.first.wait_for(state="hidden", timeout=3_000)
    except Exception:
        overlay.first.click(position={"x": 5, "y": 5}, timeout=5_000)
        overlay.first.wait_for(state="hidden", timeout=5_000)


def attach_video(page: Page, video: Path, upload_timeout: int) -> None:
    size_mb = video.stat().st_size / (1024 * 1024)
    log(f"[upload] {video.name} ({size_mb:.1f} MB)...")
    emit("upload_start", size_mb=round(size_mb, 1))
    page.locator('button[data-test-id="add-media-button"]').click()
    with page.expect_file_chooser() as chooser:
        page.locator("button.upload-file-menu-item").click()
    chooser.value.set_files(str(video))

    page.get_by_text(video.name).first.wait_for(timeout=60_000)
    wait_for_upload(page, upload_timeout)


def wait_for_upload(page: Page, upload_timeout: int) -> None:
    started = time.monotonic()
    while page.get_by_text(re.compile(r"^\s*Loading")).count():
        if time.monotonic() - started > upload_timeout:
            raise RuntimeError(f"upload still processing after {upload_timeout}s")
        time.sleep(3)
    log(f"[upload] ready ({time.monotonic() - started:.0f}s)")
    emit("upload_ready", seconds=round(time.monotonic() - started))


def run_prompt(page: Page, prompt: str, run_timeout: int) -> None:
    page.get_by_role("textbox", name="Enter a prompt").fill(prompt)
    run_btn = page.locator("ms-run-button button")
    turns_before = page.locator("ms-chat-turn").count()

    # The button turns into "Stop" while generating and back into "Run" when finished. Right after
    # the prompt is filled the page is still updating and a click can be swallowed, so retry.
    for click in range(1, 4):
        page.wait_for_function("b => b.getAttribute('aria-disabled') !== 'true'", arg=run_btn.element_handle(), timeout=30_000)
        run_btn.click()
        try:
            run_btn.filter(has_text="Stop").wait_for(timeout=15_000)
            break
        except Exception:
            if page.locator("ms-chat-turn").count() > turns_before + 1:  # finished before we saw "Stop"
                break
            hint = error_hint(page)
            log(f"[model] run did not start (click {click}/3){hint}")
            emit("run_retry_click", n=click, hint=hint.removeprefix(": "))
    else:
        raise RuntimeError(f"generation did not start{error_hint(page)}")
    log("[model] running (video analysis + writing; this can take several minutes)...")
    emit("generating")
    started = time.monotonic()
    last_report = 0.0
    while "Stop" in run_btn.inner_text():
        elapsed = time.monotonic() - started
        if elapsed > run_timeout:
            run_btn.click()
            raise RuntimeError(f"generation exceeded {run_timeout}s; stopped")
        if elapsed - last_report >= 60:
            log(f"[model] still generating ({elapsed:.0f}s)")
            last_report = elapsed
        time.sleep(2)
    page.wait_for_timeout(1500)


def error_hint(page: Page) -> str:
    """Collect any visible error/snackbar text so failures are explainable."""
    texts = []
    for sel in (".mat-mdc-snack-bar-label", "ms-callout", "[role='alert']"):
        for el in page.locator(sel).all():
            if el.is_visible():
                texts.append(" ".join(el.inner_text().split()))
    return f": {' | '.join(texts)}" if texts else ""


def copy_last_answer(page: Page) -> str:
    last_turn = page.locator("ms-chat-turn").last
    if last_turn.locator("[data-turn-role='Model']").count() == 0 or last_turn.locator("ms-text-chunk").count() == 0:
        raise RuntimeError(f"model produced no answer{error_hint(page)}")
    last_turn.scroll_into_view_if_needed()
    last_turn.hover()
    last_turn.locator("button[aria-label='Open options']").click(force=True)
    try:
        page.get_by_role("menuitem", name="Copy as markdown").click(timeout=5_000)
        page.wait_for_timeout(400)
        text = page.evaluate("navigator.clipboard.readText()")
    except Exception as exc:
        log(f"[warn] Copy as markdown failed ({exc.__class__.__name__}); falling back to page text")
        emit("copy_fallback")
        page.keyboard.press("Escape")
        text = last_turn.locator("ms-text-chunk").last.inner_text()
    if not text.strip():
        raise RuntimeError(f"answer was empty{error_hint(page)}")
    return text


# --- Orchestration -------------------------------------------------------------------------

def generate_document(studio: StudioSession, video: Path, model: str, args: argparse.Namespace) -> str:
    page, resumed = studio.page_for(video, model)
    if resumed:
        log("[resume] reusing the tab that already has the video attached")
        emit("resumed_tab")
        wait_for_upload(page, args.upload_timeout)
    else:
        open_new_chat(page, model, args.login_wait, hidden=getattr(args, "hidden", False))
        emit("chat_open", model=model)
        configure_run_settings(page, SYSTEM_INSTRUCTION, args.thinking_level)
        attach_video(page, video, args.upload_timeout)
    run_prompt(page, build_prompt(args.context, args.language), args.timeout)
    return copy_last_answer(page)


def generate_with_retries(studio: StudioSession, video: Path, args: argparse.Namespace) -> tuple[dict, str, str]:
    """Generate notes for one video, retrying with backoff and falling back to --fallback-model.

    Returns (metadata, markdown body, model used).
    """
    models = [args.model] + ([args.fallback_model] if args.fallback_model else [])
    last_exc: Exception | None = None
    for model in models:
        for attempt in range(1, args.retries + 2):
            try:
                meta, body = split_metadata(generate_document(studio, video, model, args))
                return meta, body, model
            except SignInRequired:
                raise  # retrying cannot help until someone signs in
            except Exception as exc:
                last_exc = exc
                log(f"[retry] {model} attempt {attempt} failed: {str(exc).splitlines()[0][:200]}")
                if attempt > args.retries:
                    break
                wait = min(30 * 2 ** (attempt - 1), 300)
                log(f"[retry] waiting {wait}s before retry {attempt}/{args.retries}...")
                emit("retry_wait", model=model, retry=attempt, retries=args.retries, wait_s=wait, error=str(exc).splitlines()[0][:200])
                time.sleep(wait)
        if model != models[-1]:
            log(f"[retry] {model} still failing; switching to fallback model {models[models.index(model) + 1]}")
            emit("fallback_model", model=models[models.index(model) + 1])
    raise RuntimeError(f"All attempts failed: {last_exc}")


def process_video(studio: StudioSession, video: Path, args: argparse.Namespace) -> Path:
    out_path = Path(args.out) / f"{video.stem}.md"
    if out_path.exists() and not args.overwrite:
        log(f"[skip] {out_path} already exists (use --overwrite to regenerate)")
        return out_path

    started = time.monotonic()
    meta, body, model = generate_with_retries(studio, video, args)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(render_header(video, model, args.thinking_level, meta) + body + "\n", encoding="utf-8")
    log(f"[done] {out_path} [{meta['category']}] {', '.join(meta['tags'])} ({time.monotonic() - started:.0f}s)")
    return out_path


class StudioSession:
    """Playwright's attachment to the automation Chrome, re-established when it drops.

    The CDP connection can break while a large video uploads even though Chrome and the tab keep
    going (the upload then finishes in the background). A dead connection makes every later call
    fail with "Target page, context or browser has been closed", so each attempt asks for a page
    here and gets a reconnected one, resuming the tab that already holds the video when possible.
    """

    def __init__(self, playwright, port: int, *, profile_dir: str | Path | None = None, hidden: bool = False) -> None:
        self.playwright = playwright
        self.port = port
        self.profile_dir = profile_dir
        self.hidden = hidden
        self.browser = None
        self.page: Page | None = None
        self.try_resume = True  # look for a leftover tab with the video before uploading again

    def connect(self) -> None:
        ensure_chrome(self.port, profile_dir=self.profile_dir, hidden=self.hidden)
        # Attaching over CDP (instead of launching via Playwright) keeps Chrome free of
        # automation flags, so Google keeps the session signed in. is_local lets Chrome read the
        # video straight from disk; otherwise Playwright streams it and refuses files over 50 MB.
        self.browser = self.playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{self.port}", is_local=True)
        self.context = self.browser.contexts[0]
        self.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=AISTUDIO_ORIGIN)
        self.page = None

    @property
    def alive(self) -> bool:
        return self.browser is not None and self.browser.is_connected() and self.page is not None and not self.page.is_closed()

    def page_for(self, video: Path, model: str) -> tuple[Page, bool]:
        """Return (page, resumed); resumed means the page already has `video` attached."""
        if self.browser is not None and not self.browser.is_connected():
            log("[chrome] lost the connection to Chrome; reconnecting")
            emit("chrome_reconnect")
            self.connect()
            self.try_resume = True
        if self.try_resume:
            self.try_resume = False
            tab = self._tab_with_video(video, model)
            if tab is not None:
                self.page = tab
                return tab, True
        if not self.alive:
            self.page = self.context.new_page()
        return self.page, False

    def _tab_with_video(self, video: Path, model: str) -> Page | None:
        """An AI Studio tab left by the dropped connection: video attached, prompt not run yet."""
        for tab in self.context.pages:
            try:
                if (tab.url.startswith(f"{AISTUDIO_ORIGIN}/prompts/") and f"model={model}" in tab.url
                        and tab.get_by_text(video.name).count() and not tab.locator("ms-chat-turn").count()):
                    return tab
            except Exception:
                continue
        return None

    def close(self, keep_browser: bool) -> None:
        try:
            if self.browser is None or not self.browser.is_connected():
                self.connect()
            if keep_browser:
                for tab in self.context.pages:
                    if tab.url.startswith(f"{AISTUDIO_ORIGIN}/prompts/"):
                        tab.close()
            else:
                # browser.close() only disconnects a CDP session; Browser.close quits Chrome itself.
                self.browser.new_browser_cdp_session().send("Browser.close")
        except Exception as exc:
            log(f"[warn] could not close Chrome: {exc}")


@contextmanager
def ai_studio_page(port: int, keep_browser: bool = False, *, profile_dir: str | Path | None = None,
                   hidden: bool = False) -> Iterator[StudioSession]:
    """Attach to the automation Chrome (starting it if needed) and yield a StudioSession.

    Chrome is shut down afterwards unless keep_browser is set; the Google login lives in the
    profile folder, so the next run starts signed in.
    """
    with sync_playwright() as p:
        studio = StudioSession(p, port, profile_dir=profile_dir, hidden=hidden)
        studio.connect()
        try:
            yield studio
        finally:
            studio.close(keep_browser)


def add_generation_args(parser: argparse.ArgumentParser) -> None:
    """AI Studio options shared by this script and watcher.py."""
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"AI Studio model id (default: {DEFAULT_MODEL})")
    parser.add_argument("--fallback-model", help="Model to try if --model keeps failing (e.g. gemini-3.7-flash)")
    parser.add_argument("--thinking-level", choices=["low", "medium", "high"], default="low")
    parser.add_argument("--context", help="Optional background (project, attendees, domain) to improve accuracy")
    parser.add_argument("--context-file", help="Read --context from a text/markdown file")
    parser.add_argument("--language", default="English", help="Language of the output document")
    parser.add_argument("--retries", type=int, default=2, help="Retries per model on failure, with backoff (default: 2)")
    parser.add_argument("--timeout", type=int, default=1800, help="Max seconds to wait for one generation (default: 1800)")
    parser.add_argument("--upload-timeout", type=int, default=1800, help="Max seconds to wait for the video upload (default: 1800)")
    parser.add_argument("--login-wait", type=int, default=600, help="Seconds to wait for you to sign in on first run (default: 600)")
    parser.add_argument("--port", type=int, default=9333, help="Chrome remote-debugging port (default: 9333)")
    parser.add_argument("--keep-browser", action="store_true", help="Leave the automation Chrome open after processing")
    parser.add_argument("--profile-dir", help="Chrome profile folder for the automation Chrome (default: .chrome-automation next to the script)")
    parser.add_argument("--hidden", action="store_true",
                        help="Run the automation Chrome on a hidden Windows desktop (no window, no taskbar button); sign-in needs a visible window")


def load_context(args: argparse.Namespace) -> None:
    if args.context_file:
        args.context = Path(args.context_file).read_text(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Markdown meeting notes from video recordings via Google AI Studio.")
    parser.add_argument("inputs", nargs="+", help="Video file(s) and/or folder(s) of videos")
    parser.add_argument("--out", default="docs", help="Output folder for .md files (default: docs)")
    parser.add_argument("--overwrite", action="store_true", help="Regenerate even if the .md already exists")
    add_generation_args(parser)
    args = parser.parse_args()
    load_context(args)
    return args


def main() -> int:
    args = parse_args()
    videos = collect_videos(args.inputs)
    if not videos:
        log("No video files found.")
        return 1

    failures = 0
    with ai_studio_page(args.port, args.keep_browser, profile_dir=args.profile_dir, hidden=args.hidden) as studio:
        for video in videos:
            log(f"\n=== {video} ===")
            try:
                process_video(studio, video.resolve(), args)
            except Exception as exc:
                failures += 1
                log(f"[error] {video.name}: {exc}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
