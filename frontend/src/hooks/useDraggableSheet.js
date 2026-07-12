/**
 * useDraggableSheet — Phase 4.2.2: draggable 3-snap-point bottom sheet.
 *
 * Presentation layer ONLY. This hook never reads or writes navigation,
 * GPS, tracking, or routing state — it only positions a DOM node.
 *
 * Every frame (drag or animated snap) writes exactly two things, both via
 * direct DOM mutation instead of React state, so dragging never triggers a
 * re-render:
 *   1. `transform: translate3d(0, y, 0)` on the sheet — compositor-only,
 *      no layout reflow, so 60fps holds even on mid-range phones.
 *   2. the `--sheet-h` CSS custom property on <html> — the SAME variable
 *      `useElementHeightVar` already writes for the other (non-draggable)
 *      sheets, so the existing floating-control CSS
 *      (`bottom: calc(var(--sheet-h) + gap)`) tracks this sheet with zero
 *      changes and the identical animation curve, satisfying "floating
 *      controls follow the same animation curve as the sheet" for free.
 *
 * React state (`tier`) only updates once a drag/animation settles, so
 * conditional content (which of the 3 tiers' markup is mounted) doesn't
 * thrash mid-gesture.
 *
 * Priority 1 (Phase 4.4) — root cause of "Exit / Campus Copilot buttons
 * overlap the sheet in certain tiers": Home.jsx mounts THREE of these
 * (nav / route-preview / browse), and React's rules of hooks mean all
 * three are always live — only one sheet's DOM is ever rendered at a
 * time, but all three instances' effects can still fire. Since every
 * instance wrote the SAME shared `--sheet-h` var unconditionally,
 * whichever sheet's own peeks/tier last changed (e.g. a background
 * sheet recomputing on a viewport resize while a different sheet is the
 * one actually visible) silently overwrote the height the floating
 * controls were anchored to, even though its own DOM wasn't on screen.
 * The `active` flag below scopes each instance's writes to only the
 * currently-visible sheet, and re-asserts its own height the instant it
 * becomes active — so a stale value left by whichever sheet was active
 * before is corrected immediately rather than waiting for that new
 * sheet's next drag/resize.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const EASE_OUT_CUBIC = t => 1 - Math.pow(1 - t, 3)
const SNAP_ANIM_MS = 280
const DRAG_ACTIVATE_PX = 4        // ignore sub-pixel jitter before committing to a drag
const VELOCITY_FLING_PX_MS = 0.5  // fast flick threshold

export function useDraggableSheet(snapPeeks, initialTier = 'collapsed', active = true, boxHeight) {
  const sheetRef      = useRef(null)
  const rafRef         = useRef(null)
  const peekRef        = useRef(snapPeeks[initialTier])
  const dragRef        = useRef(null)   // { startY, startPeek, lastY, lastT, v, active }
  const tiersRef       = useRef(snapPeeks)
  const listenersRef   = useRef(null)   // { move, up } while a drag is in progress

  // Keep the ref in sync with the latest peeks without touching it during
  // render (refs must only be read/written in effects or event handlers).
  useEffect(() => { tiersRef.current = snapPeeks }, [snapPeeks])

  const [tier, setTier]         = useState(initialTier)
  const [dragging, setDragging] = useState(false)

  // Priority 1 (Phase 4.8) root-cause fix — proven via runtime instrumentation
  // (real Chrome, real drag, getBoundingClientRect vs --sheet-h at every
  // frame): `maxH` here is the pivot for `translateY = maxH - peek`, so it
  // must equal the sheet's TRUE, fixed CSS box height (`height: 86dvh` for
  // the nav sheet) — that's the only thing translateY is actually measured
  // against. It used to be inferred as `Math.max(collapsed, half, full)`,
  // which is only correct if `full` always equals the box's real height.
  // That assumption broke the moment the nav sheet's `full` tier started
  // being capped below its natural 86dvh to avoid covering the turn-by-turn
  // card (maxFullBeforeCollision in Home.jsx) — the capped `full` got used
  // as the transform pivot too, so EVERY tier's rendered peek ended up
  // taller than intended by exactly (true box height − capped full), with
  // the floating controls' `bottom: calc(var(--sheet-h) + gap)` anchored to
  // the (correct, uncapped) intended peek — hence a real, constant,
  // gap-sized-or-larger overlap, confirmed at ~21px on a capped session.
  // Callers whose `full` tier is never capped (preview/browse sheets) don't
  // pass `boxHeight`, so they keep the exact previous (correct) behaviour.
  const maxH = boxHeight ?? Math.max(snapPeeks.collapsed, snapPeeks.half, snapPeeks.full)

  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])

  const applyPeek = useCallback((peek) => {
    peekRef.current = peek
    const node = sheetRef.current
    if (node) node.style.transform = `translate3d(0, ${Math.round(maxH - peek)}px, 0)`
    // Priority 1 (Phase 4.4): only the currently-active/visible sheet is
    // allowed to drive the shared --sheet-h var — see file header comment.
    if (activeRef.current) {
      document.documentElement.style.setProperty('--sheet-h', `${Math.round(Math.max(0, peek))}px`)
    }
  }, [maxH])

  // The moment this instance becomes the active/visible sheet, immediately
  // re-assert ITS current height onto --sheet-h. Without this, a sheet that
  // just became active would leave whatever value the previously-active
  // sheet last wrote in place until its own next drag/tier/resize event.
  useEffect(() => {
    if (active) {
      document.documentElement.style.setProperty('--sheet-h', `${Math.round(Math.max(0, peekRef.current))}px`)
    }
  }, [active])

  const animateTo = useCallback((targetPeek, targetTier) => {
    cancelAnimationFrame(rafRef.current)
    const from = peekRef.current
    const delta = targetPeek - from
    if (Math.abs(delta) < 0.5) {
      applyPeek(targetPeek)
      setTier(targetTier)
      return
    }
    const start = performance.now()
    const tick = (now) => {
      const t = Math.min(1, (now - start) / SNAP_ANIM_MS)
      applyPeek(from + delta * EASE_OUT_CUBIC(t))
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setTier(targetTier)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [applyPeek])

  const snapToTier = useCallback((t) => {
    animateTo(tiersRef.current[t], t)
  }, [animateTo])

  // Keep the sheet pinned at its committed tier when the viewport resizes
  // (e.g. mobile keyboard, orientation change) or the tier changes
  // programmatically (grip tap).
  useEffect(() => {
    applyPeek(snapPeeks[tier])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapPeeks.collapsed, snapPeeks.half, snapPeeks.full, tier])

  const nearestTier = useCallback((peek, velocity) => {
    const peeks = tiersRef.current
    const order = ['collapsed', 'half', 'full']
    // A fast flick commits to the next tier in the flick direction even if
    // the drag hasn't crossed the midpoint yet — feels far more natural
    // than pure nearest-distance snapping.
    if (Math.abs(velocity) > VELOCITY_FLING_PX_MS) {
      const dir = velocity < 0 ? 1 : -1 // moving up (negative dy) → expand
      const idx = order.reduce((best, t, i) =>
        Math.abs(peeks[t] - peek) < Math.abs(peeks[order[best]] - peek) ? i : best, 0)
      return order[Math.min(order.length - 1, Math.max(0, idx + dir))]
    }
    return order.reduce((best, t) =>
      Math.abs(peeks[t] - peek) < Math.abs(peeks[best] - peek) ? t : best, order[0])
  }, [])

  // Removes whatever move/up listeners the most recent drag registered.
  // Reads them from a ref instead of referencing a handler by name, so
  // there's no circular "function removes its own listener" closure.
  const stopDragListening = useCallback(() => {
    const l = listenersRef.current
    if (!l) return
    window.removeEventListener('pointermove', l.move)
    window.removeEventListener('pointerup', l.up)
    window.removeEventListener('pointercancel', l.up)
    listenersRef.current = null
  }, [])

  const onPointerDown = useCallback((e) => {
    // Only the primary mouse button / a real touch/pen point starts a drag.
    if (e.button != null && e.button !== 0) return
    cancelAnimationFrame(rafRef.current)
    stopDragListening() // clear any prior drag's listeners first (e.g. multi-touch) — never stack duplicates

    // Priority 7 (Phase 4.2.7) root-cause fix for "sheet occasionally gets
    // stuck when fully expanded": without pointer capture, a fast drag
    // near a screen edge could have its pointer events hijacked mid-gesture
    // by the browser's own competing gesture recognizer (iOS edge-swipe,
    // overscroll/refresh, etc). When that happened, neither `pointerup`
    // nor `pointercancel` ever fired on `window`, so `up()` never ran —
    // the sheet was left wherever the last raw drag frame had put it,
    // never snapped to a tier, and no longer responded to the next drag
    // (a stale, never-cleared dragRef). Capturing the pointer on the grip
    // itself guarantees this element keeps receiving move/up events for
    // that pointer for its entire lifetime, regardless of where it
    // physically travels or what other gesture the OS tries to start.
    const pointerId = e.pointerId
    try { e.currentTarget.setPointerCapture?.(pointerId) } catch { /* already released — ignore */ }

    dragRef.current = {
      startY: e.clientY, startPeek: peekRef.current,
      lastY: e.clientY, lastT: performance.now(), v: 0, active: false,
    }
    setDragging(true)

    const move = (ev) => {
      const d = dragRef.current
      if (!d) return
      const y = ev.clientY
      const now = performance.now()
      if (now > d.lastT) d.v = (y - d.lastY) / (now - d.lastT)
      d.lastY = y; d.lastT = now
      const dy = d.startY - y   // dragging up = positive = more peek
      if (!d.active && Math.abs(dy) > DRAG_ACTIVATE_PX) d.active = true
      if (!d.active) return
      // Once a real drag is underway, stop the browser from also treating
      // it as a page scroll/refresh gesture — belt-and-braces alongside
      // pointer capture above.
      ev.preventDefault?.()
      const peeks = tiersRef.current
      const lo = Math.min(peeks.collapsed, peeks.half, peeks.full)
      const hi = Math.max(peeks.collapsed, peeks.half, peeks.full)
      // Small rubber-band past the ends instead of a hard stop.
      let next = d.startPeek + dy
      if (next < lo) next = lo - (lo - next) * 0.35
      if (next > hi) next = hi + (next - hi) * 0.35
      applyPeek(next)
    }

    const up = () => {
      const d = dragRef.current
      dragRef.current = null
      setDragging(false)
      stopDragListening()
      try { e.currentTarget.releasePointerCapture?.(pointerId) } catch { /* already released — ignore */ }
      if (!d || !d.active) return // was a tap, not a drag — click handler on the grip handles it
      const target = nearestTier(peekRef.current, d.v || 0)
      snapToTier(target)
    }

    listenersRef.current = { move, up }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [applyPeek, nearestTier, snapToTier, stopDragListening])

  const cycleTier = useCallback(() => {
    const order = ['collapsed', 'half', 'full']
    const next = order[(order.indexOf(tier) + 1) % order.length]
    snapToTier(next)
  }, [tier, snapToTier])

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current)
    stopDragListening()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { sheetRef, tier, dragging, snapToTier, cycleTier, onPointerDown }
}
