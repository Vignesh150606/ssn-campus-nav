/**
 * ChatbotWidget — Phase 2 UI.
 *
 * Phase 2 additions:
 *  • Suggestion chips after every assistant message
 *  • Status badge on event cards ("🔴 Happening now", "⏰ Starts in X min")
 *  • Distance + ETA shown on event/location cards
 *  • Compact WelcomeScreen with Phase 2 example prompts
 *  • Better mobile keyboard handling (form stays visible)
 *  • cancel_navigation action support
 */
import { useEffect, useRef, useState } from 'react'
import { runTurn } from './copilotEngine'

const STARTER_PROMPTS = [
  'Take me to Main Auditorium',
  "What's happening now?",
  'Nearest canteen',
  'ECE 302',
]

function initials(name) { return (name || '?').slice(0, 1).toUpperCase() }

// ── Card components ────────────────────────────────────────────────────────

function ChatCard({ card, onPreview, onStart, onDetails }) {
  if (card.type === 'info') {
    return (
      <div className="copilot-card copilot-card-info">
        <div className="copilot-card-title">{card.title}</div>
        {card.description && (
          <div className="copilot-card-desc" style={{ whiteSpace: 'pre-line' }}>{card.description}</div>
        )}
      </div>
    )
  }

  if (card.type === 'event') {
    return (
      <div className="copilot-card copilot-card-event">
        <div className="copilot-card-media">
          {card.thumbnail
            ? <img src={card.thumbnail} alt="" />
            : <span className="copilot-card-media-fallback">🎉</span>}
        </div>
        <div className="copilot-card-body">
          {card.statusBadge && (
            <div className="copilot-card-badge">{card.statusBadge}</div>
          )}
          <div className="copilot-card-title">{card.title}</div>
          <div className="copilot-card-subtitle">{card.subtitle}</div>
          {card.eta != null && (
            <div className="copilot-card-eta">🚶 {card.eta <= 1 ? '~1 min walk' : `~${card.eta} min walk`}</div>
          )}
          {card.description && (
            <div className="copilot-card-desc copilot-card-desc-clamp">{card.description}</div>
          )}
          <div className="copilot-card-actions">
            <button className="copilot-chip" onClick={() => onDetails(card)}>View Details</button>
            {card.location && <button className="copilot-chip" onClick={() => onPreview(card)}>Preview Route</button>}
            {card.location && (
              <button className="copilot-chip copilot-chip-primary" onClick={() => onStart(card)}>
                Navigate →
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Location card
  return (
    <div className="copilot-card copilot-card-location">
      {/* Phase 4.2 — show today's menu thumbnail if this is a food venue */}
      {card.menuImageUrl && (
        <div className="copilot-card-menu-img-wrap">
          <img
            src={card.menuImageUrl}
            alt="Today's menu"
            className="copilot-card-menu-img"
            loading="lazy"
          />
          <span className="copilot-card-menu-badge">🍽 Today's Menu</span>
        </div>
      )}
      <div className="copilot-card-body">
        <div className="copilot-card-title">{card.title}</div>
        {card.subtitle && <div className="copilot-card-subtitle">{card.subtitle}</div>}
        {card.eta != null && (
          <div className="copilot-card-eta">🚶 {card.eta <= 1 ? '~1 min walk' : `~${card.eta} min walk`}</div>
        )}
        {card.meta?.room && (
          <div className="copilot-card-meta-row">
            <span>Room {card.meta.room}</span>
            {card.meta.floor && <span> · Floor {card.meta.floor}</span>}
          </div>
        )}
        {card.description && (
          <div className="copilot-card-desc copilot-card-desc-clamp">{card.description}</div>
        )}
        <div className="copilot-card-actions">
          <button className="copilot-chip" onClick={() => onPreview(card)}>Preview Route</button>
          <button className="copilot-chip copilot-chip-primary" onClick={() => onStart(card)}>Navigate →</button>
        </div>
      </div>
    </div>
  )
}

// ── Welcome screen ─────────────────────────────────────────────────────────

function WelcomeScreen({ onSend }) {
  return (
    <div className="copilot-welcome">
      <div className="copilot-welcome-icon">🧭</div>
      <div className="copilot-welcome-title">Campus Copilot</div>
      <div className="copilot-welcome-subtitle">
        Buildings · Classrooms · Events · Facilities
      </div>
      <div className="copilot-starters">
        {STARTER_PROMPTS.map((p, i) => (
          <button key={i} className="copilot-chip" onClick={() => onSend(p)}>{p}</button>
        ))}
      </div>
    </div>
  )
}

// ── Main widget ────────────────────────────────────────────────────────────

export default function ChatbotWidget({
  locations,
  position,
  arrivedLocationId,
  arrivedLocationName,
  onPreviewRoute,
  onStartNavigation,
  onViewEventDetails,
  onCancelNavigation,
}) {
  const [open, setOpen]           = useState(false)
  const [hasUnread, setHasUnread] = useState(false)
  const [messages, setMessages]   = useState([])
  const [input, setInput]         = useState('')
  const [busy, setBusy]           = useState(false)
  const stateRef      = useRef({})
  const listRef       = useRef(null)
  const inputRef      = useRef(null)
  const lastArrivedRef = useRef(null)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, open])

  // Auto-focus input when sheet opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 120)
  }, [open])

  // Smart arrival suggestion
  useEffect(() => {
    if (arrivedLocationId && arrivedLocationId !== lastArrivedRef.current) {
      lastArrivedRef.current = arrivedLocationId
      setMessages(m => [...m, {
        role: 'assistant',
        text: `You've arrived${arrivedLocationName ? ` at ${arrivedLocationName}` : ''}! What do you need?`,
        suggestions: ['Nearest restroom', 'Nearest water station', 'Nearest canteen'],
      }])
      if (!open) setHasUnread(true)
    }
    if (!arrivedLocationId) lastArrivedRef.current = null
  }, [arrivedLocationId, arrivedLocationName, open])

  function toggleOpen() {
    setOpen(o => { if (!o) setHasUnread(false); return !o })
  }

  async function send(text) {
    const trimmed = (text || '').trim()
    if (!trimmed || busy) return
    setMessages(m => [...m, { role: 'user', text: trimmed }])
    setInput('')
    setBusy(true)
    try {
      const { replyText, cards, action, suggestions, newState } = await runTurn(
        trimmed, stateRef.current, { locations, position }
      )
      stateRef.current = newState

      if (action) await handleAction(action)

      if (replyText || cards?.length) {
        setMessages(m => [...m, { role: 'assistant', text: replyText, cards, suggestions }])
      }
    } catch {
      setMessages(m => [...m, {
        role: 'assistant',
        text: "Sorry, I couldn't reach the campus service. Please try again.",
      }])
    } finally {
      setBusy(false)
    }
  }

  async function handleAction(action) {
    const loc = locations.find(l => l.id === action.locationId)
    if (action.type === 'preview_route' && loc) {
      onPreviewRoute(loc); setOpen(false)
    } else if (action.type === 'start_navigation' && loc) {
      onStartNavigation(loc, stateRef.current.pendingClassroom || null); setOpen(false)
    } else if (action.type === 'view_event_details' && action.eventId) {
      onViewEventDetails(action.eventId); setOpen(false)
    } else if (action.type === 'cancel_navigation') {
      onCancelNavigation?.(); setOpen(false)
    }
  }

  function cardToLocation(card) {
    return card.location ? locations.find(l => l.id === card.location.id) || card.location : null
  }

  function handleCardPreview(card) {
    const loc = cardToLocation(card)
    if (!loc) return
    onPreviewRoute(loc); setOpen(false)
  }

  function handleCardStart(card) {
    const loc = cardToLocation(card)
    if (!loc) return
    const eventInfo = card.meta?.room
      ? { room: card.meta.room, floor: card.meta.floor, wing: card.meta.wing, building: card.meta.building }
      : null
    onStartNavigation(loc, eventInfo); setOpen(false)
  }

  function handleCardDetails(card) {
    if (card.type === 'event') { onViewEventDetails(card.id); setOpen(false) }
  }

  const isWelcomeScreen = messages.length === 0

  return (
    <>
      {/* FAB — hidden when sheet is open */}
      {!open && (
        <button
          className={`copilot-fab ${hasUnread ? 'copilot-fab-unread' : ''}`}
          onClick={toggleOpen}
          aria-label="Open campus assistant"
        >
          💬
          {hasUnread && <span className="copilot-fab-dot" />}
        </button>
      )}

      {open && (
        <div className="copilot-sheet" role="dialog" aria-label="Campus Copilot chat">
          {/* Header */}
          <div className="copilot-sheet-header">
            <div className="copilot-sheet-title">
              <span className="copilot-sheet-avatar">🧭</span>
              <div>
                <div className="copilot-sheet-title-text">Campus Copilot</div>
                <div className="copilot-sheet-subtitle">
                  {busy ? 'Thinking…' : 'Ask about buildings, events or facilities'}
                </div>
              </div>
            </div>
            <button className="copilot-sheet-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          {/* Messages */}
          <div className="copilot-sheet-messages" ref={listRef}>
            {isWelcomeScreen && !busy && <WelcomeScreen onSend={send} />}

            {messages.map((m, i) => (
              <div key={i} className={`copilot-msg copilot-msg-${m.role}`}>
                {m.role === 'assistant' && <span className="copilot-msg-avatar">{initials('SC')}</span>}
                <div className="copilot-msg-bubble-wrap">
                  {m.text && <div className="copilot-msg-bubble">{m.text}</div>}

                  {m.cards?.length > 0 && (
                    <div className="copilot-cards">
                      {m.cards.map((c, ci) => (
                        <ChatCard
                          key={ci} card={c}
                          onPreview={handleCardPreview}
                          onStart={handleCardStart}
                          onDetails={handleCardDetails}
                        />
                      ))}
                    </div>
                  )}

                  {/* Phase 2 — suggestion chips */}
                  {m.role === 'assistant' && m.suggestions?.length > 0 && (
                    <div className="copilot-suggestions">
                      {m.suggestions.map((s, si) => (
                        <button key={si} className="copilot-chip copilot-suggestion-chip" onClick={() => send(s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {busy && (
              <div className="copilot-msg copilot-msg-assistant copilot-msg-typing-row">
                <span className="copilot-msg-avatar">{initials('SC')}</span>
                <div className="copilot-msg-bubble copilot-msg-typing"><span /><span /><span /></div>
              </div>
            )}
          </div>

          {/* Input — always visible, mobile-keyboard-aware */}
          <form
            className="copilot-sheet-input-row"
            onSubmit={e => { e.preventDefault(); send(input) }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Buildings, classrooms, events, facilities…"
              className="copilot-input"
              disabled={busy}
              autoComplete="off"
              autoCorrect="off"
              enterKeyHint="send"
              inputMode="text"
            />
            <button
              type="submit"
              className={`copilot-send-btn ${(!busy && input.trim()) ? 'copilot-send-btn-active' : ''}`}
              disabled={busy || !input.trim()}
              aria-label="Send"
            >
              ➤
            </button>
          </form>
        </div>
      )}
    </>
  )
}
