# -*- mode: python ; coding: utf-8 -*-
# Freezes watcher.py (+ meeting_notes.py and the Playwright driver) into mm-engine/ (11b).
# Build with `npm run engine`, which uses the separate build venv in desktop/engine/.venv.
import os

ROOT = os.path.abspath(os.path.join(SPECPATH, '..', '..'))  # repo root, so `import meeting_notes` resolves

a = Analysis(
    [os.path.join(ROOT, 'watcher.py')],
    pathex=[ROOT],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    # Python run-time options: unbuffered stdio (events reach the app at once) and UTF-8 mode
    # (stderr log encoding; cmd_serve already reconfigures stdout/stdin).
    [('u', None, 'OPTION'), ('X utf8', None, 'OPTION')],
    exclude_binaries=True,
    name='mm-engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # the app starts it with windowsHide
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='mm-engine',
)
