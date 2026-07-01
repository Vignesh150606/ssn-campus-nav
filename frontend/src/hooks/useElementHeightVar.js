/**
 * useElementHeightVar — Phase 4.2: dynamic floating-control positioning.
 *
 * Continuously mirrors the live rendered height of a DOM node into a CSS
 * custom property on the document root (e.g. `--sheet-h`), so other
 * elements — floating action buttons, Leaflet's zoom control — can
 * position themselves with `calc(var(--sheet-h) + gap)` instead of a
 * hardcoded pixel guess that silently drifts out of sync whenever the
 * sheet's real height changes (collapsed/expanded, content-driven,
 * future redesign, a different breakpoint, …).
 *
 * Backed by ResizeObserver, which fires on the element's actual rendered
 * box — including while a CSS `max-height`/`height` transition is
 * animating it — so dependents stay in lock-step with the sheet's own
 * motion without duplicating its timing/easing.
 *
 * Returns a callback ref. Safe to attach to a different DOM node across
 * renders (e.g. switching between two conditionally-rendered sheet
 * variants): the previous observer is torn down automatically, and the
 * variable resets to 0 the instant the node unmounts, so dependents
 * collapse back down immediately rather than staying offset for
 * something that's gone.
 */
import { useCallback, useRef } from 'react'

export function useElementHeightVar(varName) {
  const roRef = useRef(null)

  const setVar = useCallback((px) => {
    document.documentElement.style.setProperty(varName, `${Math.max(0, Math.round(px))}px`)
  }, [varName])

  const ref = useCallback((node) => {
    if (roRef.current) {
      roRef.current.disconnect()
      roRef.current = null
    }
    if (!node) {
      setVar(0)
      return
    }
    // Set immediately so there's no one-frame jump waiting on the first
    // ResizeObserver callback (most browsers fire it async on next tick).
    setVar(node.getBoundingClientRect().height)
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect?.height
      if (h != null) setVar(h)
    })
    ro.observe(node)
    roRef.current = ro
  }, [setVar])

  return ref
}
