/** The parts of a KeyboardEvent a shortcut is made of. */
export type KeyPress = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

const NAMED: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`'
}

/** The key part of an accelerator, by physical key (`code`), so Shift or the keyboard layout don't change it. */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return NAMED[code] ?? null
}

/**
 * Settings → Recording → Change (RC·T25): a key press as an Electron accelerator ("CommandOrControl+Alt+R"), or
 * null while only modifiers are down or for a key that isn't a usable global shortcut. Without Ctrl, Alt or Win
 * only F-keys count: a plain letter would fire in every app.
 */
export function acceleratorFromKey(e: KeyPress): string | null {
  const key = keyName(e.code)
  if (!key) return null
  const mods = [
    e.ctrlKey && 'CommandOrControl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Super'
  ].filter((m): m is string => !!m)
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !/^F\d+$/.test(key)) return null
  return [...mods, key].join('+')
}
