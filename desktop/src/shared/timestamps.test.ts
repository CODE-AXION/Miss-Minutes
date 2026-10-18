import { describe, expect, it } from 'vitest'
import { LEAD_SECONDS, TIMESTAMP, parseClock, seekTarget, splitRun } from './timestamps'

describe('parseClock', () => {
  it.each([
    ['36:15', 2175],
    ['1:02:03', 3723],
    ['75:20', 4520],
    ['0:00', 0],
    ['09:27', 567]
  ])('%s → %d', (text, seconds) => {
    expect(parseClock(text)).toBe(seconds)
  })

  it.each(['12:60', '1:60:00', '1:02:60', '', '12', '1:2:3:4', 'ab:cd', '1:5'])(
    'rejects %j',
    (text) => {
      expect(parseClock(text)).toBeNull()
    }
  )
})

describe('splitRun', () => {
  const join = (run: string): string =>
    splitRun(run)
      .map((p) => p.text)
      .join('')

  it('splits a single timestamp', () => {
    expect(splitRun('[36:15]')).toEqual([
      { text: '[', seconds: null },
      { text: '36:15', seconds: 2175 },
      { text: ']', seconds: null }
    ])
    expect(splitRun('[1:02:03]')[1]).toEqual({ text: '1:02:03', seconds: 3723 })
  })

  it('makes every clock of a range or list its own target', () => {
    expect(splitRun('[38:40 – 39:37]')).toEqual([
      { text: '[', seconds: null },
      { text: '38:40', seconds: 2320 },
      { text: ' – ', seconds: null },
      { text: '39:37', seconds: 2377 },
      { text: ']', seconds: null }
    ])
    expect(splitRun('[38:40, 39:37]').filter((p) => p.seconds !== null)).toHaveLength(2)
  })

  it('keeps a clock that does not parse as plain text', () => {
    expect(splitRun('[12:60]')[1]).toEqual({ text: '12:60', seconds: null })
  })

  it.each([
    '[36:15]',
    '[1:02:03]',
    '[38:40, 39:37]',
    '[38:40–39:37]',
    '[38:40 - 39:37]',
    '[38:40 – 39:37]'
  ])('round-trips %j character for character', (run) => {
    expect(join(run)).toBe(run)
  })
})

describe('seekTarget', () => {
  it('starts LEAD_SECONDS early', () => {
    expect(seekTarget(567)).toBe(567 - LEAD_SECONDS)
  })

  it('never goes below 0', () => {
    expect(seekTarget(1)).toBe(0)
    expect(seekTarget(1, 3600)).toBe(0)
  })

  it('caps at the last second once the duration is known', () => {
    expect(seekTarget(3670, 3520)).toBe(3519)
    expect(seekTarget(100, 3520)).toBe(98)
  })

  it('ignores a duration that is not known yet', () => {
    expect(seekTarget(3670, NaN)).toBe(3668)
    expect(seekTarget(3670, 0)).toBe(3668)
    expect(seekTarget(3670, Infinity)).toBe(3668)
  })
})

describe('TIMESTAMP', () => {
  it.each(['[36:15]', '[1:02:03]', '[38:40, 39:37]', '[38:40–39:37]', '[38:40 - 39:37]'])(
    'matches %j whole',
    (run) => {
      expect(run.match(TIMESTAMP)).toEqual([run])
    }
  )

  it('finds runs inside prose', () => {
    const text = 'Agreed at [09:27] and again [38:40 – 39:37], see [1:02:03].'
    expect(text.match(TIMESTAMP)).toEqual(['[09:27]', '[38:40 – 39:37]', '[1:02:03]'])
  })
})
