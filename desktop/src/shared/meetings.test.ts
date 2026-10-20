import { describe, expect, it } from 'vitest'
import {
  audioLine,
  MeetingTracker,
  findMeetings,
  hwndOf,
  matchMeeting,
  meetingLabel,
  promptChoice,
  screenLabel
} from './meetings'
import type { RecordingChoice } from './recording'

describe('matchMeeting', () => {
  it.each([
    // Observed live on 2026-10-20.
    ['Meet - wer-cqne-rvx - Google Chrome', 'wer-cqne-rvx'],
    ['Meet – abc-defg-hij - Microsoft​ Edge', 'abc-defg-hij']
  ])('matches %s', (title, code) => {
    expect(matchMeeting(title)).toEqual({ app: 'meet', code })
  })

  it.each([
    'Google Meet - Google Chrome',
    'Meet - Google Chrome',
    'Meeting notes - Docs',
    'Meet - abc-defg-hijk',
    'Meet - ABC-DEFG-HIJ',
    ''
  ])('rejects %j', (title) => {
    expect(matchMeeting(title)).toBeNull()
  })

  it('labels the app', () => {
    expect(meetingLabel('meet')).toBe('Google Meet')
  })
})

describe('findMeetings', () => {
  it('ignores screens, dedupes codes and keeps the first window', () => {
    expect(
      findMeetings([
        { id: 'screen:0:0', name: 'Meet - aaa-bbbb-ccc - Google Chrome' },
        { id: 'window:11:0', name: 'Inbox - Gmail' },
        { id: 'window:22:0', name: 'Meet - wer-cqne-rvx - Google Chrome' },
        { id: 'window:33:0', name: 'Meet - wer-cqne-rvx - Microsoft Edge' },
        { id: 'window:44:0', name: 'Meet - abc-defg-hij - Google Chrome' }
      ])
    ).toEqual([
      { app: 'meet', code: 'wer-cqne-rvx', sourceId: 'window:22:0' },
      { app: 'meet', code: 'abc-defg-hij', sourceId: 'window:44:0' }
    ])
  })
})

describe('MeetingTracker', () => {
  const code = 'wer-cqne-rvx'

  it('prompts once and stays quiet while seen', () => {
    const t = new MeetingTracker(1000)
    t.seen([code], 0)
    expect(t.shouldPrompt(code, 0)).toBe(true)
    t.prompted(code, 0)
    t.seen([code], 900)
    expect(t.shouldPrompt(code, 900)).toBe(false)
  })

  it('keeps a code alive while it is seen', () => {
    const t = new MeetingTracker(1000)
    t.prompted(code, 0)
    for (let now = 500; now <= 5000; now += 500) t.seen([code], now)
    expect(t.shouldPrompt(code, 5000)).toBe(false)
  })

  it('prompts again once unseen for longer than forgetMs', () => {
    const t = new MeetingTracker(1000)
    t.prompted(code, 0)
    t.seen([], 1000)
    expect(t.shouldPrompt(code, 1000)).toBe(false)
    t.seen([], 1001)
    expect(t.shouldPrompt(code, 1001)).toBe(true)
  })

  it('defaults to forgetting after 2 minutes', () => {
    const t = new MeetingTracker()
    t.prompted(code, 0)
    expect(t.shouldPrompt(code, 120_000)).toBe(false)
    expect(t.shouldPrompt(code, 120_001)).toBe(true)
  })
})

describe('hwndOf', () => {
  it('returns the HWND of a window source', () => {
    expect(hwndOf('window:2033812:0')).toBe('2033812')
  })

  it.each(['screen:0:0', 'window:abc:0', 'window:12;rm:0', 'window:12', 'window::0', ''])(
    'rejects %j',
    (id) => {
      expect(hwndOf(id)).toBeNull()
    }
  )
})

describe('promptChoice', () => {
  const screen = { id: 'screen:1:0', displayId: '2528732444' }
  const last = (over: Partial<RecordingChoice>): RecordingChoice => ({
    sourceId: 'screen:0:0',
    kind: 'screen',
    displayId: '1',
    systemAudio: false,
    micDeviceId: 'mic-1',
    ...over
  })

  it('uses the picker defaults without a last choice', () => {
    expect(promptChoice(screen, null)).toEqual({
      sourceId: 'screen:1:0',
      kind: 'screen',
      displayId: '2528732444',
      systemAudio: true,
      micDeviceId: 'default'
    })
  })

  it('keeps the last audio choice', () => {
    expect(promptChoice(screen, last({}))).toMatchObject({
      systemAudio: false,
      micDeviceId: 'mic-1'
    })
  })

  it('keeps "no mic"', () => {
    expect(promptChoice(screen, last({ micDeviceId: null })).micDeviceId).toBeNull()
  })

  it('records the screen even after a window choice', () => {
    const choice = promptChoice(
      screen,
      last({ kind: 'window', sourceId: 'window:9:0', displayId: null })
    )
    expect(choice).toMatchObject({
      kind: 'screen',
      sourceId: 'screen:1:0',
      displayId: '2528732444'
    })
  })
})

describe('screenLabel', () => {
  it('says "Your screen" with one display', () => {
    expect(screenLabel(1, 1, { width: 1920, height: 1080 })).toBe('Your screen · 1920×1080')
  })

  it('numbers screens with several displays', () => {
    expect(screenLabel(2, 2, { width: 2560, height: 1440 })).toBe('Screen 2 · 2560×1440')
  })
})

describe('audioLine', () => {
  const mics = [
    { deviceId: 'default', label: 'Default - Microphone (Realtek(R) Audio)' },
    { deviceId: 'usb', label: 'USB Mic' },
    { deviceId: 'nolabel', label: '' }
  ]

  it('names the default mic without the "Default - " prefix', () => {
    expect(audioLine(true, 'default', mics)).toBe(
      '🔊 System audio + 🎤 Microphone (Realtek(R) Audio)'
    )
  })

  it('names a specific mic without system audio', () => {
    expect(audioLine(false, 'usb', mics)).toBe('🎤 USB Mic')
  })

  it('says when the last mic is gone', () => {
    expect(audioLine(true, 'unplugged', mics)).toBe(
      "🔊 System audio + 🎤 Default mic (your last one isn't connected)"
    )
  })

  it('falls back to "Microphone" for an empty label', () => {
    expect(audioLine(false, 'nolabel', mics)).toBe('🎤 Microphone')
  })

  it('handles no mic', () => {
    expect(audioLine(true, null, mics)).toBe('🔊 System audio + no mic')
    expect(audioLine(false, null, mics)).toBe('🔇 No audio')
  })
})
