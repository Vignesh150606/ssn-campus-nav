// W3: lazy wrapper for the Copilot chat widget (the heaviest non-admin
// module: ~23 KB min / ~7 KB gzip plus copilotEngine). Same prop interface as
// the real component, so Home.jsx's JSX is unchanged, only its import line.
//
// It mounts after first paint, once the browser is idle, so it is off the
// critical path of the first load. Requires ../copilot/ChatbotWidget.jsx to
// keep a default export (W4 owns that file's internals).
import { lazy, Suspense, useEffect, useState } from 'react'

function lazyWhenIdle(load, timeoutMs = 3000) {
  const Inner = lazy(load)
  return function LazyWhenIdle(props) {
    const [ready, setReady] = useState(false)
    useEffect(() => {
      if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(() => setReady(true), { timeout: timeoutMs })
        return () => window.cancelIdleCallback(id)
      }
      const t = setTimeout(() => setReady(true), 1500)
      return () => clearTimeout(t)
    }, [])
    if (!ready) return null
    return (
      <Suspense fallback={null}>
        <Inner {...props} />
      </Suspense>
    )
  }
}

export const ChatbotWidget = lazyWhenIdle(() => import('../copilot/ChatbotWidget.jsx'))
