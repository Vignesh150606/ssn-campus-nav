/**
 * ErrorBoundary — diagnostic + safety net.
 *
 * The app previously had ZERO error boundaries anywhere. If any component
 * threw during render (a malformed event from the API, an unexpected null,
 * etc.), React unmounts the *entire* tree up to the nearest boundary — and
 * with none present, that means the WHOLE app, including the header/nav,
 * disappears. All that's left on screen is <body style="background:
 * var(--canvas)"> — a plain white (light theme) or black (dark theme)
 * rectangle. That matches "blank, white or black depending on theme"
 * exactly, which is why this is being added now: it turns an invisible,
 * unreported crash into a visible, logged one.
 *
 * If this boundary never fires during testing, that's a real, useful
 * result too — it rules out "uncaught render exception" as the cause and
 * narrows the search to the data/fetch layer instead.
 */
import { Component } from 'react'
import { dwarn } from '../utils/debugLog'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // TEMPORARY diagnostic — see utils/debugLog.js
    dwarn('ErrorBoundary', 'CAUGHT A RENDER CRASH:', error?.message || error, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 99999,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center',
          background: '#1a1a1a', color: '#fff', fontFamily: 'monospace',
        }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>
            ⚠ A component crashed while rendering
          </div>
          <div style={{ fontSize: '0.85rem', opacity: 0.8, maxWidth: 480, wordBreak: 'break-word' }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <div style={{ fontSize: '0.75rem', opacity: 0.5, maxWidth: 480 }}>
            This is diagnostic output for the blank-page bug. Please copy this
            message and the full console log and send it back.
          </div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 8, padding: '8px 20px', borderRadius: 999, background: '#fff', color: '#000', fontWeight: 700 }}
          >
            Try to recover
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
