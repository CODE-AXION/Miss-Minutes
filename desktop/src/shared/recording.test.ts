import { describe, expect, it } from 'vitest'
import {
  DISK,
  diskVerdict,
  extForMime,
  isRecordingPart,
  pickMime,
  recordingStem,
  shouldAutoStop,
  uniqueStem
} from './recording'
import { formatClock } from './timestamps'

// Copied from watcher.recorded_at (watcher.py:173); a stem it can't parse falls back to the file's mtime.
const RECORDED_AT = /(\d{4}-\d{2}-\d{2})[ _T](\d{2})-(\d{2})-(\d{2})/

const MP4 = 'video/mp4;codecs=avc1,mp4a.40.2'
const WEBM = 'video/webm;codecs=h264,opus'

describe('recordingStem', () => {
  it.each([
    ['midnight', new Date(2026, 9, 19, 0, 0, 0), '2026-10-19 00-00-00'],
    ['the 1st of the month', new Date(2026, 0, 1, 14, 3, 27), '2026-01-01 14-03-27'],
    ['a single-digit hour', new Date(2026, 9, 19, 7, 5, 9), '2026-10-19 07-05-09'],
    ['the last second of the year', new Date(2026, 11, 31, 23, 59, 59), '2026-12-31 23-59-59']
  ])('zero-pads %s in local time', (_, date, stem) => {
    expect(recordingStem(date)).toBe(stem)
  })

  it('is parsed by the engine back to the same wall-clock time', () => {
    const m = RECORDED_AT.exec(recordingStem(new Date(2026, 9, 19, 14, 3, 27)))
    expect(m && `${m[1]}T${m[2]}:${m[3]}:${m[4]}`).toBe('2026-10-19T14:03:27')
  })
})

describe('uniqueStem', () => {
  const stem = '2026-10-19 14-03-27'

  it('keeps a free stem', () => {
    expect(uniqueStem(stem, new Set(['other']))).toBe(stem)
  })

  it('adds (2) when taken once and (3) when taken twice', () => {
    expect(uniqueStem(stem, new Set([stem]))).toBe(`${stem} (2)`)
    expect(uniqueStem(stem, new Set([stem, `${stem} (2)`]))).toBe(`${stem} (3)`)
  })

  it('compares case-insensitively, keeping the original case', () => {
    expect(uniqueStem('Meeting', new Set(['meeting']))).toBe('Meeting (2)')
  })
})

describe('isRecordingPart', () => {
  it.each([
    '2026-10-19 14-03-27.mp4.part',
    '2026-10-19 14-03-27 (2).mp4.part',
    '2026-10-19 14-03-27.WEBM.PART'
  ])('accepts %s', (name) => {
    expect(isRecordingPart(name)).toBe(true)
  })

  it.each([
    'meeting.mp4.part',
    'x.part',
    '2026-10-19 14-03-27.mp4',
    '2026-10-19 14-03-27.mkv.part',
    'copy of 2026-10-19 14-03-27.mp4.part'
  ])('rejects %s', (name) => {
    expect(isRecordingPart(name)).toBe(false)
  })
})

describe('diskVerdict / shouldAutoStop', () => {
  it('warns below 2 GiB and refuses below 500 MiB', () => {
    expect(diskVerdict(DISK.warnBytes)).toBe('ok')
    expect(diskVerdict(DISK.warnBytes - 1)).toBe('low')
    expect(diskVerdict(DISK.refuseBytes)).toBe('low')
    expect(diskVerdict(DISK.refuseBytes - 1)).toBe('refuse')
    expect(diskVerdict(0)).toBe('refuse')
  })

  it('auto-stops below 300 MiB', () => {
    expect(shouldAutoStop(DISK.stopBytes)).toBe(false)
    expect(shouldAutoStop(DISK.stopBytes - 1)).toBe(true)
  })

  it('orders the thresholds warn > refuse > stop', () => {
    expect(DISK.warnBytes).toBeGreaterThan(DISK.refuseBytes)
    expect(DISK.refuseBytes).toBeGreaterThan(DISK.stopBytes)
  })
})

describe('pickMime / extForMime', () => {
  it('prefers MP4', () => {
    expect(pickMime(() => true)).toBe(MP4)
  })

  it('falls back to WebM', () => {
    expect(pickMime((m) => m === WEBM)).toBe(WEBM)
  })

  it('returns null when nothing is supported', () => {
    expect(pickMime(() => false)).toBeNull()
  })

  it('maps a MIME back to its extension', () => {
    expect(extForMime(MP4)).toBe('.mp4')
    expect(extForMime(WEBM)).toBe('.webm')
    expect(extForMime('video/x-matroska')).toBeNull()
  })
})

describe('formatClock (shared for the recording timer)', () => {
  it('formats elapsed time, adding hours when needed', () => {
    expect(formatClock(12)).toBe('00:12')
    expect(formatClock(42 * 60 + 10)).toBe('42:10')
    expect(formatClock(3600 + 2 * 60 + 3)).toBe('1:02:03')
    expect(formatClock(-5)).toBe('00:00')
  })
})
