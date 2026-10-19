import { describe, expect, it } from 'vitest'
import { acceleratorFromKey, type KeyPress } from './hotkey'

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('acceleratorFromKey', () => {
  it('builds Electron accelerators with modifiers in a fixed order', () => {
    expect(acceleratorFromKey(press('KeyR', { ctrlKey: true, altKey: true }))).toBe(
      'CommandOrControl+Alt+R'
    )
    expect(acceleratorFromKey(press('Digit5', { altKey: true, shiftKey: true }))).toBe(
      'Alt+Shift+5'
    )
    expect(acceleratorFromKey(press('ArrowUp', { metaKey: true }))).toBe('Super+Up')
  })

  it('allows a bare F-key', () => {
    expect(acceleratorFromKey(press('F9'))).toBe('F9')
    expect(acceleratorFromKey(press('F13', { shiftKey: true }))).toBe('Shift+F13')
  })

  it('waits while only modifiers are down', () => {
    expect(acceleratorFromKey(press('ControlLeft', { ctrlKey: true }))).toBeNull()
    expect(acceleratorFromKey(press('AltRight', { altKey: true }))).toBeNull()
  })

  it('refuses keys that would fire in every app', () => {
    expect(acceleratorFromKey(press('KeyR'))).toBeNull()
    expect(acceleratorFromKey(press('KeyR', { shiftKey: true }))).toBeNull()
    expect(acceleratorFromKey(press('Numpad1', { ctrlKey: true }))).toBeNull()
  })
})
