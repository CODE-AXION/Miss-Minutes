import { useEffect, useId, useState, type JSX } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useIsDark } from '@/hooks/use-is-dark'

type Result = { svg: string } | { error: string } | null

/**
 * A ```mermaid block of a note (07·T3). Mermaid is loaded on first use and runs with securityLevel 'strict' (its SVG
 * output is sanitised). A diagram that does not parse shows its source instead, so it never breaks the page.
 */
export function MermaidBlock({ code }: { code: string }): JSX.Element {
  const dark = useIsDark()
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [result, setResult] = useState<Result>(null)

  useEffect(() => {
    let live = true
    const renderId = `${id}-${dark ? 'd' : 'l'}`
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default'
        })
        const { svg } = await mermaid.render(renderId, code)
        if (live) setResult({ svg })
      } catch (error) {
        // A failed render can leave its scratch element behind.
        document.getElementById(`d${renderId}`)?.remove()
        if (live) setResult({ error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      live = false
    }
  }, [code, dark, id])

  if (result && 'svg' in result) {
    return (
      <div
        className="my-4 flex justify-center overflow-x-auto rounded-md border border-border bg-card p-3"
        // Mermaid's own output, sanitised by DOMPurify under securityLevel 'strict'.
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    )
  }
  if (result && 'error' in result) {
    return (
      <div className="my-4 flex flex-col gap-2 rounded-md border border-warning/50 p-3">
        <p className="flex items-center gap-2 text-sm text-warning">
          <TriangleAlert className="size-4" aria-hidden /> The diagram could not be rendered
        </p>
        <pre className="overflow-x-auto font-mono text-xs">{code}</pre>
      </div>
    )
  }
  return (
    <div className="my-4 h-24 animate-pulse rounded-md bg-muted" aria-label="Drawing diagram" />
  )
}
