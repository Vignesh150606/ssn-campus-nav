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
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const EASE_OUT_CUBIC = t => 1 - Math.pow(1 - t, 3)
const SNAP_ANIM_MS = 280
const DRAG_ACTIVATE_PX = 4        // ignore sub-pixel jitter before committing to a drag
const VELOCITY_FLING_PX_MS = 0.5  // fast flick threshold

export function useDraggableSheet(snapPeeks, initialTier = 'collapsed') {
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

  const maxH = Math.max(snapPeeks.collapsed, snapPeeks.half, snapPeeks.full)

  const applyPeek = useCallback((peek) => {
    peekRef.current = peek
    const node = sheetRef.current
    if (node) node.style.transform = `translate3d(0, ${Math.round(maxH - peek)}px, 0)`
    document.documentElement.style.setProperty('--sheet-h', `${Math.round(Math.max(0, peek))}px`)
  }, [maxH])

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

  const beginDrag = useCallback((startY, startPeek) => {
    cancelAnimationFrame(rafRef.current)
    stopDragListening() // clear any prior drag's listeners first (e.g. multi-touch) — never stack duplicates
    dragRef.current = {
      startY, startPeek,
      lastY: startY, lastT: performance.now(), v: 0, active: false,
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
      if (!d || !d.active) return // was a tap, not a drag — click handler on the grip handles it
      const target = nearestTier(peekRef.current, d.v || 0)
      snapToTier(target)
    }

    listenersRef.current = { move, up }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [applyPeek, nearestTier, snapToTier, stopDragListening])

  const onPointerDown = useCallback((e) => {
    // Only the primary mouse button / a real touch/pen point starts a drag.
    if (e.button != null && e.button !== 0) return
    beginDrag(e.clientY, peekRef.current)
  }, [beginDrag])

  // Priority 9 (Phase 4.2.6): the grip alone (however large) is still a
  // second, separate touch target from "the directions I'm reading" — at
  // the 'full' tier that's most of the screen, so the natural gesture is
  // to just pull down on the list itself. This hands a downward pull off
  // to the exact same drag machinery as the grip, but ONLY when the list
  // is already scrolled to its very top when the gesture starts — reading
  // further down the list (scrolling up, or starting mid-scroll) is left
  // completely untouched, still native scrolling. Nothing is decided at
  // pointerdown itself: it watches the first few pixels of movement to
  // tell "pulling the sheet down" and "scrolling the list" apart before
  // committing to either.
  //
  // Priority 8 (Phase 4.2.7) root-cause fix: the old version decided ONCE,
  // on the first few px of movement, whether this gesture was "scrolling"
  // or "dragging the sheet" — if the content had ANY scroll position at
  // that instant, the whole rest of that same continuous pull was
  // permanently handed to native scrolling, even once the list reached
  // its top a moment later. In practice that meant collapsing Fully
  // Expanded by swiping down on the content only worked if you happened
  // to already be scrolled to the very top when the swipe began —
  // otherwise nothing happened until you released and swiped a SECOND
  // time. Now it keeps re-checking scrollTop on every move instead of
  // deciding once, so the moment the content runs out of room to scroll
  // (scrollTop reaches 0) during the SAME pull, it hands off into the
  // sheet drag right then, anchored at the current finger position so
  // the sheet doesn't jump — matching the "scroll up, then the pull keeps
  // going and drags the sheet down" pattern used by other mobile bottom
  // sheets.
  const onContentPointerDown = useCallback((e) => {
    if (e.button != null && e.button !== 0) return
    const scrollEl = e.currentTarget
    const startY = e.clientY
    const startPeek = peekRef.current
    let handedOff = false

    const preMove = (ev) => {
      if (handedOff) return
      const dy = ev.clientY - startY // positive = finger moving down
      if (Math.abs(dy) < DRAG_ACTIVATE_PX) return
      if (scrollEl.scrollTop > 0) return // still room to scroll — keep watching, don't decide yet
      handedOff = true
      window.removeEventListener('pointermove', preMove)
      window.removeEventListener('pointerup', preUp)
      window.removeEventListener('pointercancel', preUp)
      // Anchor at the CURRENT pointer position, not the gesture's
      // original start, so the sheet doesn't jump by however far the
      // finger already travelled while it was still just scrolling.
      beginDrag(ev.clientY, startPeek)
    }
    const preUp = () => {
      window.removeEventListener('pointermove', preMove)
      window.removeEventListener('pointerup', preUp)
      window.removeEventListener('pointercancel', preUp)
    }
    window.addEventListener('pointermove', preMove)
    window.addEventListener('pointerup', preUp)
    window.addEventListener('pointercancel', preUp)
  }, [beginDrag])

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

  return { sheetRef, tier, dragging, snapToTier, cycleTier, onPointerDown, onContentPointerDown }
}
