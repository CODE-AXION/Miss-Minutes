import { useState, type JSX } from 'react'
import { FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import type { EngineMode } from '@shared/api'
import { voice } from '@shared/voice'
import { AnimatedMascot } from '@/components/brand/animated-mascot'
import { PosterPanel } from '@/components/brand/poster-panel'
import type { StepProps } from '@/components/setup/types'
import { Button } from '@/components/ui/button'
import { chooseProjectRoot } from '@/lib/project-root'

/**
 * Step 1: the mascot, what the app does, and the developer escape hatch (11d·T2): switching the engine to a project
 * folder keeps the old setup reachable. That switch is saved right away (it changes what the other steps run).
 */
export function WelcomeStep({ state }: StepProps): JSX.Element {
  const { settings, engineProblem } = state
  const [switching, setSwitching] = useState(false)

  async function switchEngine(engine: EngineMode): Promise<void> {
    setSwitching(true)
    try {
      await window.api.saveSettings({ engine }, { restart: 'now' })
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PosterPanel heading="Welcome" art={<AnimatedMascot kind="hello" size={120} />}>
        {voice('setup.welcome', settings.voice)}
      </PosterPanel>
      <p>
        Miss Minutes watches the folder your meeting recordings are saved to, and turns each new
        recording into meeting notes with Google AI Studio. Everything runs on this computer, in the
        background.
      </p>

      {settings.engine === 'bundled' && engineProblem && (
        <p className="text-sm text-destructive">{engineProblem}</p>
      )}

      {settings.engine === 'project' ? (
        <div className="flex flex-col gap-3 rounded-md border border-dashed p-4">
          <span className="font-medium">Developer mode: project folder</span>
          <div className="flex items-center gap-3">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-sm">
              {settings.projectRoot}
            </code>
            <Button variant="outline" onClick={() => void chooseProjectRoot(settings)}>
              <FolderOpen /> Choose folder
            </Button>
          </div>
          {engineProblem && <p className="text-sm text-destructive">{engineProblem}</p>}
          <Button
            variant="link"
            className="self-start px-0"
            disabled={switching}
            onClick={() => void switchEngine('bundled')}
          >
            Use the built-in engine instead
          </Button>
        </div>
      ) : (
        <Button
          variant="link"
          size="sm"
          className="self-start px-0 text-muted-foreground"
          disabled={switching}
          onClick={() => void switchEngine('project')}
        >
          Developer: use a project folder
        </Button>
      )}
    </div>
  )
}
