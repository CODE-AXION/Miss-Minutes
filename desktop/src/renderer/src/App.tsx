import { useEffect, type JSX } from 'react'
import { RouterProvider } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { router } from '@/routes'
import { connectStore } from '@/store'

function App(): JSX.Element {
  // All data comes from main: hydrate once, then follow its pushes.
  useEffect(() => connectStore(), [])

  return (
    <TooltipProvider delayDuration={300}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  )
}

export default App
