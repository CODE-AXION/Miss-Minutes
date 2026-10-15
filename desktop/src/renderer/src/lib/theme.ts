/**
 * Mirror the OS/app theme onto the `.dark` class on <html> (shadcn's dark variant).
 * Electron reports nativeTheme.shouldUseDarkColors as `prefers-color-scheme`, so when main later sets
 * nativeTheme.themeSource from the theme setting (05/04a), the page follows without extra IPC.
 */
export function followSystemTheme(): void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = (): void => {
    document.documentElement.classList.toggle('dark', query.matches)
  }
  apply()
  query.addEventListener('change', apply)
}
