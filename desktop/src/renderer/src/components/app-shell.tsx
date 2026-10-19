import { useEffect, type JSX } from 'react'
import { Outlet, useNavigate } from 'react-router'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/app-sidebar'
import { RecordDialog } from '@/components/recording/record-dialog'
import { openRecordDialog } from '@/components/recording/record-request'
import { RecordControl } from '@/components/recording/record-control'
import { SigninDialog } from '@/components/signin/signin-dialog'
import { openSignin } from '@/components/signin/signin-request'
import { WindowDropOverlay } from '@/components/upload-dropzone'
import { WorkerBanner } from '@/components/worker-banner'
import { useSearchToasts } from '@/hooks/use-search-toasts'
import { videoPath } from '@/lib/paths'
import { SetupWizard } from '@/pages/setup-wizard'
import { useApp } from '@/store'

/**
 * Sidebar + banners + the current page, or the first-run wizard while setup is needed (11d). Also follows main's
 * navigation requests (toast and tray clicks), and hosts the Google sign-in dialog (11d·T1b) and the recording picker
 * (RC·T21).
 */
export function AppShell(): JSX.Element {
  const navigate = useNavigate()
  const state = useApp((s) => s.state)
  useEffect(
    () =>
      window.api.onNavigate((request) => {
        if (request.to === 'signin') openSignin('signin')
        else if (request.to === 'record') {
          navigate('/')
          openRecordDialog()
        } else navigate(request.to === 'video' ? videoPath(request.key) : '/')
      }),
    [navigate]
  )
  useSearchToasts()

  if (state?.setupNeeded)
    return (
      <>
        <SetupWizard state={state} />
        <SigninDialog />
      </>
    )

  return (
    <SidebarProvider className="h-screen">
      <SigninDialog />
      <RecordDialog />
      <AppSidebar />
      <SidebarInset className="retro-grid min-h-0 overflow-hidden">
        {/* The one in-app place for recording (RC·T28): Record, or the live REC pill with Mute and Stop. */}
        <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-background/85 pr-10 pl-6 backdrop-blur">
          <RecordControl />
        </header>
        <WorkerBanner />
        <div className="min-h-0 flex-1 overflow-auto p-6">
          <Outlet />
        </div>
      </SidebarInset>
      <WindowDropOverlay />
    </SidebarProvider>
  )
}
