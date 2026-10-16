/**
 * Anchor id for a note heading (SS·T1): 'h-' + the heading in lowercase kebab-case. The note viewer puts it on each
 * `h2` and the search chunker stores it on every passage, so a search result opens the note at the right section.
 */
export function slug(text: string): string {
  return (
    'h-' +
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  )
}
