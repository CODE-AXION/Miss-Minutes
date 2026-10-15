"""11e automated checks for the 11a standalone flags: --profile-dir, per-user Chrome, `check`, unchanged CLI output."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import meeting_notes as mn  # noqa: E402


def run_watcher(*argv: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(ROOT / "watcher.py"), *argv], capture_output=True, text=True,
                          encoding="utf-8", timeout=60, cwd=ROOT)


@pytest.fixture
def fake_chrome_start(monkeypatch):
    """ensure_chrome with no real Chrome: the port opens right after the first Popen; returns the captured commands."""
    started: list[list[str]] = []
    monkeypatch.setattr(mn, "find_chrome", lambda: "chrome.exe")
    monkeypatch.setattr(mn, "cdp_ready", lambda port: bool(started))
    monkeypatch.setattr(mn.time, "sleep", lambda s: None)
    monkeypatch.setattr(mn.subprocess, "Popen", lambda cmd, **kw: started.append(cmd))
    return started


def test_profile_dir_default(fake_chrome_start, tmp_path):
    assert mn.profile_path(None) == mn.PROFILE_DIR
    mn.ensure_chrome(9333)
    assert f"--user-data-dir={mn.PROFILE_DIR}" in fake_chrome_start[0]

    fake_chrome_start.clear()
    custom = tmp_path / "profile"
    mn.ensure_chrome(9333, profile_dir=custom)
    assert f"--user-data-dir={custom.resolve()}" in fake_chrome_start[0]
    assert "--remote-debugging-port=9333" in fake_chrome_start[0]


def test_find_chrome_localappdata(monkeypatch, tmp_path):
    chrome = tmp_path / "Google" / "Chrome" / "Application" / "chrome.exe"
    chrome.parent.mkdir(parents=True)
    chrome.touch()
    monkeypatch.setattr(mn, "CHROME_CANDIDATES", [str(tmp_path / "missing" / "chrome.exe")])
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert mn.find_chrome() == str(chrome)


def test_check_command_json(tmp_path):
    library, watch, profile = tmp_path / "library", tmp_path / "watch", tmp_path / "profile"
    library.mkdir()
    watch.mkdir()
    result = run_watcher("--library", str(library), "check", "--watch-dir", str(watch), "--profile-dir", str(profile))
    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    assert len(lines) == 1
    data = json.loads(lines[0])
    assert set(data) == {"watch_dir_ok", "handbrake", "chrome", "profile_dir", "signed_in_hint"}
    assert data["watch_dir_ok"] is True
    assert data["profile_dir"] == str(profile.resolve())
    assert data["signed_in_hint"] is False
    assert {"ok"} <= set(data["chrome"]) and {"ok"} <= set(data["handbrake"])
    assert not (library / ".worker.lock").exists()  # no worker lock taken


def test_cli_unchanged(tmp_path):
    library, watch = tmp_path / "library", tmp_path / "watch"
    library.mkdir()
    watch.mkdir()
    listed = run_watcher("--library", str(library), "list")
    assert listed.returncode == 0, listed.stderr
    assert listed.stdout == "\n0 meeting(s)\n"

    watched = run_watcher("--library", str(library), "watch", "--once", "--watch-dir", str(watch))
    assert watched.returncode == 0, watched.stderr
    assert watched.stdout == ""  # logs go to stderr only; stdout stays free for `serve`'s JSON lines
