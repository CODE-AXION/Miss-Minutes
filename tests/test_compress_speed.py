"""--hb-speed: background (default) adds the lighter HandBrake options; full is the plain GUI setup."""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import watcher  # noqa: E402

PLAIN = ["HandBrakeCLI.exe", "-i", "in.mp4", "-o", "out.partial.mp4", "-Z", "Fast 1080p30", "-q", "25", "--cfr", "-O"]
NO_FILTERS = ["--no-comb-detect", "--no-decomb"]


def parse(*argv: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    watcher.add_watch_args(parser)
    return parser.parse_args(list(argv))


def command(args: argparse.Namespace) -> list[str]:
    return watcher.handbrake_command(Path("HandBrakeCLI.exe"), Path("in.mp4"), Path("out.partial.mp4"), args)


def test_background_is_default(monkeypatch):
    monkeypatch.setattr(watcher.os, "cpu_count", lambda: 16)
    assert command(parse()) == [*PLAIN, *NO_FILTERS, "--encoder-preset", "veryfast", "-x", "threads=8"]


def test_threads_never_below_two(monkeypatch):
    monkeypatch.setattr(watcher.os, "cpu_count", lambda: 2)
    assert command(parse())[-1] == "threads=2"
    monkeypatch.setattr(watcher.os, "cpu_count", lambda: None)
    assert command(parse())[-1] == "threads=2"


def test_full_speed_is_the_plain_setup():
    assert command(parse("--hb-speed", "full")) == PLAIN


def test_hardware_encoder_gets_no_x264_options():
    assert command(parse("--hb-encoder", "qsv_h264")) == [*PLAIN, "-e", "qsv_h264", *NO_FILTERS]


def test_x264_encoder_keeps_x264_options():
    assert "veryfast" in command(parse("--hb-encoder", "x264"))


def test_run_in_background_tolerates_a_gone_process():
    watcher.run_in_background(2**31 - 1)  # no such pid: OpenProcess fails, nothing raises
