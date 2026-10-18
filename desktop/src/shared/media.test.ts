import { describe, expect, it } from 'vitest'
import { mediaUrl, parseMediaUrl, parseRange, videoContentType } from './media'

describe('mediaUrl / parseMediaUrl', () => {
  const key = 'C:\\Users\\A B\\Videos\\Meet #1 & co — ü.mp4'

  it('round-trips a Windows path with spaces, #, & and non-ASCII', () => {
    for (const file of ['compressed', 'source'] as const) {
      expect(parseMediaUrl(mediaUrl(key, file, '2026-10-18T10:00:00'))).toEqual({ key, file })
    }
  })

  it('builds the documented shape', () => {
    const url = mediaUrl('C:\\a.mp4', 'compressed', 'v1')
    expect(url.startsWith('mm-media://video/?key=')).toBe(true)
    expect(url).toContain('file=compressed')
    expect(url).toContain('v=v1')
    expect(mediaUrl('C:\\a.mp4', 'source')).toContain('v=')
  })

  it.each([
    ['wrong scheme', 'https://video/?key=a&file=source'],
    ['wrong host', 'mm-media://other/?key=a&file=source'],
    ['missing key', 'mm-media://video/?file=source'],
    ['empty key', 'mm-media://video/?key=&file=source'],
    ['bad file', 'mm-media://video/?key=a&file=thumbs'],
    ['missing file', 'mm-media://video/?key=a'],
    ['not a URL', 'not a url']
  ])('rejects %s', (_, url) => {
    expect(parseMediaUrl(url)).toBeNull()
  })
})

describe('parseRange', () => {
  const size = 1000

  it.each([
    ['no header', null, null],
    ['empty header', '', null],
    ['open range', 'bytes=0-', { start: 0, end: 999 }],
    ['open range mid-file', 'bytes=500-', { start: 500, end: 999 }],
    ['closed range', 'bytes=100-199', { start: 100, end: 199 }],
    ['suffix range', 'bytes=-500', { start: 500, end: 999 }],
    ['suffix longer than file', 'bytes=-5000', { start: 0, end: 999 }],
    ['end past the size', 'bytes=900-5000', { start: 900, end: 999 }],
    ['start at size', 'bytes=1000-', 'unsatisfiable'],
    ['start past size', 'bytes=2000-3000', 'unsatisfiable'],
    ['start after end', 'bytes=200-100', 'unsatisfiable'],
    ['zero suffix', 'bytes=-0', 'unsatisfiable'],
    ['bare dash', 'bytes=-', 'unsatisfiable'],
    ['garbage spec', 'bytes=abc', 'unsatisfiable'],
    ['garbage header', 'nonsense', null],
    ['multi-range uses the first', 'bytes=0-1,5-9', { start: 0, end: 1 }],
    ['other unit', 'items=0-5', null]
  ] as const)('%s', (_, header, expected) => {
    expect(parseRange(header, size)).toEqual(expected)
  })

  it('treats any range of an empty file as unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })
})

describe('videoContentType', () => {
  it.each([
    ['C:\\v\\a.mp4', 'video/mp4'],
    ['C:\\v\\a.M4V', 'video/mp4'],
    ['C:\\v\\a.webm', 'video/webm'],
    ['C:\\v\\a.mov', 'video/quicktime'],
    ['C:\\v\\a.mkv', 'video/x-matroska'],
    ['C:\\v\\a.avi', 'application/octet-stream'],
    ['C:\\v.d\\noext', 'application/octet-stream']
  ])('%s → %s', (path, type) => {
    expect(videoContentType(path)).toBe(type)
  })
})
