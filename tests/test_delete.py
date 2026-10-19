"""DM·T1: the worker's `delete` command (the app moves the files to the Recycle Bin first; this only updates the index)."""
import argparse
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import watcher  # noqa: E402


class Events:
    """Stands in for serve's EventStream: records what would go to the app."""

    def __init__(self):
        self.sent: list[tuple[str, dict]] = []

    def send(self, type: str, **fields) -> None:
        self.sent.append((type, fields))


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(watcher, "events", Events())
    lib = watcher.Library(tmp_path / "library")
    watch = tmp_path / "videos"
    watch.mkdir()
    source = watch / "2026-10-19 14-03-27.mp4"
    source.write_bytes(b"video")
    note = lib.notes_dir / "planning" / "2026-10-19 Sprint review.md"
    note.parent.mkdir(parents=True)
    note.write_text("# Sprint review", encoding="utf-8")
    lib.update(str(source), source=str(source), status="done", recorded="2026-10-19T14:03:27",
               notes="notes/planning/2026-10-19 Sprint review.md", title="Sprint review", category="planning", tags=[],
               processed="2026-10-19T15:00:00")
    worker = watcher.Worker(lib, argparse.Namespace(), watch)
    return worker, lib, str(source), source, note


def test_note_only_keeps_the_recording_as_baseline(setup):
    worker, lib, key, source, note = setup
    note.unlink()  # the app moved it to the Recycle Bin
    worker.handle({"cmd": "delete", "key": key, "video": False})
    entry = lib.videos[key]
    assert entry["status"] == "baseline"  # not picked up again by a scan
    assert entry["notes"] is None and entry["processed"] is None
    assert source.is_file()


def test_with_video_drops_the_entry(setup):
    worker, lib, key, source, note = setup
    note.unlink()
    source.unlink()
    worker.handle({"cmd": "delete", "key": key, "video": True})
    assert key not in lib.videos
    assert key not in json.loads(lib.index_path.read_text(encoding="utf-8"))["videos"]
    # The app learns about a removal from a fresh snapshot (a `video` event can only add or change).
    assert [t for t, _ in watcher.events.sent] == ["snapshot"]


@pytest.mark.parametrize("video", [False, True])
def test_refused_while_the_note_is_still_there(setup, video):
    worker, lib, key, source, note = setup
    with pytest.raises(ValueError, match="note is still there"):
        worker.handle({"cmd": "delete", "key": key, "video": video})
    assert lib.videos[key]["status"] == "done"


def test_with_video_refused_while_the_recording_is_still_there(setup):
    worker, lib, key, source, note = setup
    note.unlink()
    with pytest.raises(ValueError, match="recording is still there"):
        worker.handle({"cmd": "delete", "key": key, "video": True})
    assert key in lib.videos


def test_refused_while_processing(setup):
    worker, lib, key, source, note = setup
    note.unlink()
    worker.current = key
    with pytest.raises(ValueError, match="being processed"):
        worker.handle({"cmd": "delete", "key": key, "video": False})


def test_note_only_needs_a_note(setup):
    worker, lib, key, source, note = setup
    lib.update(key, status="failed", notes=None)
    with pytest.raises(ValueError, match="no note"):
        worker.handle({"cmd": "delete", "key": key, "video": False})
