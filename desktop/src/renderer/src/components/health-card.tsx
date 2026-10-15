import type { JSX, ReactNode } from 'react'
import { CheckCircle2, CircleHelp, FolderOpen, LogIn, XCircle, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from 'cn'
import type { AppState, RestartMode, Settings } from '@shared/api'
import { openSignin } from '@/components/signin/signin-request'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatRelative } from '@/lib/format'
import { chooseProjectRoot } from '@/lib/project-root'

type Health = 'ok' | 'fail' | 'unknown'

interface Check {
  label: string
  health: Health
  detail: ReactNode
  action?: { label: string; run: () => Promise<void> | void; icon?: LucideIcon }
}

async function save(patch: Partial<Settings>, restart: RestartMode, done: string): Promise<void> {
  try {
    await window.api.saveSettings(patch, { restart })
    toast.success(done)
  } catch (error) {
    toast.error((error as Error).message)
  }
}

/** Google session from the timelines: a `login_required` with no later `chat_open` means it needs a sign-in. */
function googleSession(state: AppState): Pick<Check, 'health' | 'detail'> {
  if (state.lastLoginRequired || state.google.needsSignin) {
    return {
      health: 'fail',
      detail: 'Needs a sign-in: your Google session expired.'
    }
  }
  let login = ''
  let chat = ''
  for (const entry of Object.values(state.videos)) {
    for (const item of entry.history ?? []) {
      if (item.stage === 'login_required' && item.at > login) login = item.at
      if (item.stage === 'chat_open' && item.at > chat) chat = item.at
    }
  }
  if (login && login > chat) return { health: 'fail', detail: 'The last attempt needed a sign-in.' }
  const email = state.google.account?.email
  const who = email ? `Signed in as ${email}` : 'Signed in'
  if (chat) return { health: 'ok', detail: `${who} (last chat opened ${formatRelative(chat)})` }
  if (state.google.account) return { health: 'ok', detail: who }
  return { health: 'unknown', detail: 'Not known yet: the next video shows it.' }
}

function checks(state: AppState): Check[] {
  const { hello, worker, settings } = state
  const up = worker.connection === 'up'
  const problem = state.engineProblem
  const health: Health = up ? 'ok' : problem ? 'fail' : 'unknown'

  const list: Check[] = [
    settings.engine === 'bundled'
      ? { label: 'Miss Minutes engine', health, detail: problem ?? 'Installed with Miss Minutes' }
      : {
          label: 'Python environment (developer mode)',
          health,
          detail: problem ?? `${settings.projectRoot}\\.venv\\Scripts\\python.exe`,
          action: problem
            ? { label: 'Choose project folder', run: () => chooseProjectRoot(settings) }
            : undefined
        }
  ]
  if (!hello) {
    list.push({
      label: 'HandBrake, Chrome, watch folder',
      health: 'unknown',
      detail: 'Checked when the worker starts.'
    })
  } else {
    const { handbrake, chrome, watch_dir_ok } = hello.checks
    list.push(
      {
        label: 'HandBrakeCLI',
        health: handbrake.ok ? 'ok' : 'fail',
        detail: handbrake.ok ? handbrake.path : handbrake.error,
        action: handbrake.ok
          ? undefined
          : {
              label: 'Choose HandBrakeCLI.exe',
              run: async () => {
                const file = await window.api.pickFile([
                  { name: 'HandBrakeCLI', extensions: ['exe'] }
                ])
                if (file) await save({ handbrake: file }, 'after-current', 'HandBrakeCLI saved')
              }
            }
      },
      {
        label: 'Google Chrome',
        health: chrome.ok ? 'ok' : 'fail',
        detail: chrome.ok ? chrome.path : `${chrome.error}. Then restart the worker.`
      },
      {
        label: 'Watch folder',
        health: watch_dir_ok ? 'ok' : 'fail',
        detail: watch_dir_ok ? hello.watch_dir : `${hello.watch_dir} does not exist.`,
        action: watch_dir_ok
          ? undefined
          : {
              label: 'Choose folder',
              run: async () => {
                const folder = await window.api.pickFolder()
                if (folder) await save({ watchDir: folder }, 'after-current', 'Watch folder saved')
              }
            }
      }
    )
  }
  const session = googleSession(state)
  list.push({
    label: 'Google session',
    ...session,
    // 11d·T1b: opens the same sign-in dialog as Settings → Google account.
    action:
      session.health === 'ok'
        ? undefined
        : { label: 'Sign in', icon: LogIn, run: () => openSignin('signin') }
  })
  return list
}

const ICON: Record<Health, JSX.Element> = {
  ok: <CheckCircle2 className="size-5 shrink-0 text-success" aria-label="OK" />,
  fail: <XCircle className="size-5 shrink-0 text-destructive" aria-label="Problem" />,
  unknown: <CircleHelp className="size-5 shrink-0 text-muted-foreground" aria-label="Unknown" />
}

/** Can Miss Minutes do its job (08·T3)? Used at the top of Settings and on the first-run screen (09). */
export function HealthCard({ state }: { state: AppState }): JSX.Element {
  const items = checks(state)
  const stale = state.worker.connection !== 'up' && state.hello
  const failing = items.filter((c) => c.health === 'fail').length
  return (
    <Card>
      <CardHeader>
        <CardTitle>Health</CardTitle>
        <CardDescription>
          {failing
            ? `${failing} problem${failing > 1 ? 's' : ''} to fix`
            : 'Everything Miss Minutes needs'}
          {stale ? ' · from the last time the worker ran' : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {items.map((check) => (
            <li key={check.label} className="flex items-center gap-3 py-2.5">
              {ICON[check.health]}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{check.label}</span>
                <span
                  className={cn(
                    'truncate text-sm',
                    check.health === 'fail' ? 'text-destructive' : 'text-muted-foreground'
                  )}
                  title={typeof check.detail === 'string' ? check.detail : undefined}
                >
                  {check.detail}
                </span>
              </div>
              {check.action && (
                <Button size="sm" variant="outline" onClick={() => void check.action?.run()}>
                  {check.action.icon ? <check.action.icon /> : <FolderOpen />} {check.action.label}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
