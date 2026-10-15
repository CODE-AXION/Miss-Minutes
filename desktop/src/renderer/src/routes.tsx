import { createHashRouter } from 'react-router'
import { AppShell } from '@/components/app-shell'
import { DashboardPage } from '@/pages/dashboard'
import { LogsPage } from '@/pages/logs'
import { LibraryPage } from '@/pages/library'
import { QueuePage } from '@/pages/queue'
import { SettingsPage } from '@/pages/settings'
import { VideoDetailPage } from '@/pages/video-detail'

// Hash routes: the app is loaded from a file in production. Video keys are encodeURIComponent'd paths.
export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/queue', element: <QueuePage /> },
      { path: '/library', element: <LibraryPage /> },
      { path: '/video/:key', element: <VideoDetailPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/logs', element: <LogsPage /> },
      { path: '*', element: <DashboardPage /> }
    ]
  }
])
