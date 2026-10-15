import type { JSX } from 'react'
import { NavLink, useLocation } from 'react-router'
import {
  LayoutDashboard,
  ListOrdered,
  Library,
  ScrollText,
  Settings,
  Pause,
  Play,
  Radar
} from 'lucide-react'
import { cn } from 'cn'
import type { AppState } from '@shared/api'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Mascot } from '@/components/brand/mascot'
import { canCommand, doneCount, queueEntries, runCommand, useApp } from '@/store'

function workerLabel(state: AppState | null): { text: string; dot: string } {
  if (!state) return { text: 'Connecting…', dot: 'bg-muted-foreground' }
  const { worker } = state
  switch (worker.connection) {
    case 'crashed':
      return { text: 'Worker stopped', dot: 'bg-destructive' }
    case 'locked':
      return { text: 'Another watcher running', dot: 'bg-destructive' }
    case 'starting':
    case 'reconnecting':
      return { text: 'Connecting…', dot: 'bg-warning animate-dot-pulse' }
  }
  if (worker.state === 'busy')
    return {
      text: worker.paused ? 'Finishing, then paused' : 'Working',
      dot: 'bg-brand animate-dot-pulse'
    }
  if (worker.paused) return { text: 'Paused', dot: 'bg-warning' }
  return { text: 'Watching', dot: 'bg-success' }
}

export function AppSidebar(): JSX.Element {
  const state = useApp((s) => s.state)
  const { pathname } = useLocation()
  const queued = state ? queueEntries(state).length : 0
  const done = state ? doneCount(state) : 0
  const status = workerLabel(state)
  const up = canCommand(state)

  const items = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, badge: 0 },
    { to: '/queue', label: 'Queue', icon: ListOrdered, badge: queued },
    { to: '/library', label: 'Library', icon: Library, badge: done },
    { to: '/logs', label: 'Logs', icon: ScrollText, badge: 0 },
    { to: '/settings', label: 'Settings', icon: Settings, badge: 0 }
  ]

  return (
    <Sidebar>
      <SidebarHeader className="flex-row items-center gap-2 px-3 py-4">
        <Mascot pose={state?.worker.state === 'busy' ? 'busy' : 'wave'} size={40} />
        <span className="wordmark text-xl text-sidebar-primary">Miss Minutes</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={active}>
                      <NavLink to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                    {item.badge > 0 && <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-2 p-3">
        <div className="flex items-center gap-2 text-sm" role="status">
          <span className={cn('size-2.5 shrink-0 rounded-full', status.dot)} aria-hidden />
          <span className="truncate">{status.text}</span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            disabled={!up}
            onClick={() => void runCommand({ cmd: state?.worker.paused ? 'resume' : 'pause' })}
          >
            {state?.worker.paused ? <Play /> : <Pause />}
            {state?.worker.paused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            disabled={!up}
            onClick={() => void runCommand({ cmd: 'scan_now' }, 'Scanning the folder now')}
          >
            <Radar /> Scan now
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
