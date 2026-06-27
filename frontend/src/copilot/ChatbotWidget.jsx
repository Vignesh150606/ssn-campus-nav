/**
 * ChatbotWidget — Phase 1 "AI Campus Copilot" UI.
 *
 * Phase 1.1 polish:
 *   Task 4  — FAB repositioned above My Location button (done via CSS).
 *   Task 5  — Only one close button (header); FAB hidden when sheet is open.
 *   Task 6  — Auto-focus on open, improved placeholder, better UX.
 *   Task 7  — Rich welcome screen with onboarding content.
 *   Task 8  — 4 starter suggestion chips.
 *   Task 9  — Typing animation (already in CSS; kept as-is).
 *   Task 10 — Smooth open/close animation, chip/button feedback.
 */
import { useEffect, useRef, useState } from 'react'
import { runTurn } from './copilotEngine'

// Task 8 — exactly four high-value quick suggestions
const STARTER_PROMPTS = [
  'Where is the Library?',
  "What's happening today?",
  "I'm hungry",
  'EEE 302',
]

function initials(name) {
  return (name || '?').slice(0, 1).toUpperCase()
}

function ChatCard({ card, onPreview, onStart, onDetails }) {
  if (card.type === 'info') {
    return (
      <div className="copilot-card copilot-card-info">
        <div className="copilot-card-title">{card.title}</div>
        {card.description && <div className="copilot-card-desc">{card.description}</div>}
      </div>
    )
  }

  if (card.type === 'event') {
    return (
      <div className="copilot-card copilot-card-event">
        <div className="copilot-card-media">
          {card.thumbnail ? <img src={card.thumbnail} alt="" /> : <span className="copilot-card-media-fallback">🎉</span>}
        </div>
        <div className="copilot-card-body">
          <div className="copilot-card-title">{card.title}</div>
          <div className="copilot-card-subtitle">{card.subtitle}</div>
          {card.description && <div className="copilot-card-desc copilot-card-desc-clamp">{card.description}</div>}
          <div className="copilot-card-actions">
            <button className="copilot-chip" onClick={() => onDetails(card)}>View Details</button>
            {card.location && <button className="copilot-chip" onClick={() => onPreview(card)}>Preview Route</button>}
            {card.location && <button className="copilot-chip copilot-chip-primary" onClick={() => onStart(card)}>Start Navigation</button>}
          </div>
        </div>
      </div>
    )
  }

  // location card
  return (
    <div className="copilot-card copilot-card-location">
      <div className="copilot-card-body">
        <div className="copilot-card-title">{card.title}</div>
        {card.subtitle && <div className="copilot-card-subtitle">{card.subtitle}</div>}
        {card.meta?.room && (
          <div className="copilot-card-meta-row">
            <span>Room {card.meta.room}</span>
            {card.meta.floor && <span>Floor {card.meta.floor}</span>}
          </div>
        )}
        {card.description && <div className="copilot-card-desc copilot-card-desc-clamp">{card.description}</div>}
        <div className="copilot-card-actions">
          <button className="copilot-chip" onClick={() => onPreview(card)}>Preview Route</button>
          <button className="copilot-chip copilot-chip-primary" onClick={() => onStart(card)}>Start Navigation</button>
        </div>
      </div>
    </div>
  )
}

// Task 7 — Rich onboarding welcome screen
function WelcomeScreen({ onSend }) {
  return (
    <div className="copilot-welcome">
      <div className="copilot-welcome-icon">🧭</div>
      <div className="copilot-welcome-title">Welcome to SSN Campus Copilot</div>
      <div className="copilot-welcome-subtitle">I can help you:</div>
      <div className="copilot-welcome-features">
        <div className="copilot-welcome-feature"><span>📍</span> Find Buildings</div>
        <div className="copilot-welcome-feature"><span>🏫</span> Find Classrooms</div>
        <div className="copilot-welcome-feature"><span>🎉</span> Discover Today's Events</div>
        <div className="copilot-welcome-feature"><span>🍽️</span> Find Nearby Facilities</div>
        <div className="copilot-welcome-feature"><span>🗺️</span> Start Navigation</div>
      </div>
      <div className="copilot-welcome-hint">Try asking:</div>
      <div className="copilot-starters">
        {STARTER_PROMPTS.map((p, i) => (
          <button key={i} className="copilot-chip" onClick={() => onSend(p)}>{p}</button>
        ))}
      </div>
    </div>
  )
}

export default function ChatbotWidget({
  locations,
  position,
  arrivedLocationId,
  arrivedLocationName,
  onPreviewRoute,
  onStartNavigation,
  onViewEventDetails,
}) {
  const [open, setOpen] = useState(false)
  const [hasUnread, setHasUnread] = useState(false)
  const [messages, setMessages] = useState([])   // Task 7: start empty, show welcome screen instead
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const stateRef = useRef({})
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const lastArrivedRef = useRef(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, open])

  // Task 6 — Auto-focus input when sheet opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 120)
    }
  }, [open])

  // Smart arrival suggestion
  useEffect(() => {
    if (arrivedLocationId && arrivedLocationId !== lastArrivedRef.current) {
      lastArrivedRef.current = arrivedLocationId
      setMessages(m => [...m, {
        role: 'assistant',
        text: `You've arrived${arrivedLocationName ? ` at ${arrivedLocationName}` : ''}! Need anything nearby?`,
        quickReplies: ['Need water?', 'Need a restroom?', 'Need canteen?'],
      }])
      if (!open) setHasUnread(true)
    }
    if (!arrivedLocationId) lastArrivedRef.current = null
  }, [arrivedLocationId, arrivedLocationName, open])

  function toggleOpen() {
    setOpen(o => {
      if (!o) setHasUnread(false)
      return !o
    })
  }

  const isWelcomeScreen = messages.length === 0

  async function send(text) {
    const trimmed = (text || '').trim()
    if (!trimmed || busy) return
    setMessages(m => [...m, { role: 'user', text: trimmed }])
    setInput('')
    setBusy(true)
    try {
      const { replyText, cards, action, newState } = await runTurn(trimmed, stateRef.current, { locations, position })
      stateRef.current = newState

      if (action) {
        await handleAction(action)
      }
      if (replyText) {
        setMessages(m => [...m, { role: 'assistant', text: replyText, cards }])
      } else if (cards?.length) {
        setMessages(m => [...m, { role: 'assistant', text: null, cards }])
      }
    } catch (err) {
      setMessages(m => [...m, { role: 'assistant', text: "Sorry, I couldn't reach the campus service. Please try again." }])
    } finally {
      setBusy(false)
    }
  }

  async function handleAction(action) {
    const loc = locations.find(l => l.id === action.locationId)
    if (action.type === 'preview_route' && loc) {
      onPreviewRoute(loc)
      setOpen(false)
    } else if (action.type === 'start_navigation' && loc) {
      onStartNavigation(loc, stateRef.current.pendingClassroom || null)
      setOpen(false)
    } else if (action.type === 'view_event_details' && action.eventId) {
      onViewEventDetails(action.eventId)
      setOpen(false)
    }
  }

  function cardToLocation(card) {
    return card.location ? locations.find(l => l.id === card.location.id) || card.location : null
  }

  function handleCardPreview(card) {
    const loc = cardToLocation(card)
    if (!loc) return
    onPreviewRoute(loc)
    setOpen(false)
  }

  function handleCardStart(card) {
    const loc = cardToLocation(card)
    if (!loc) return
    const eventInfo = card.meta?.room ? { room: card.meta.room, floor: card.meta.floor, wing: card.meta.wing, building: card.meta.building } : null
    onStartNavigation(loc, eventInfo)
    setOpen(false)
  }

  function handleCardDetails(card) {
    if (card.type === 'event') {
      onViewEventDetails(card.id)
      setOpen(false)
    }
  }

  function handleQuickReply(text) {
    send(text)
  }

  return (
    <>
      {/* Task 5 — FAB only shown when closed (no duplicate close button) */}
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
          <div className="copilot-sheet-header">
            <div className="copilot-sheet-title">
              <span className="copilot-sheet-avatar">🧭</span>
              <div>
                <div className="copilot-sheet-title-text">Campus Copilot</div>
                <div className="copilot-sheet-subtitle">
                  {busy ? 'Thinking…' : 'Ask about buildings, events, or facilities'}
                </div>
              </div>
            </div>
            {/* Task 5 — single close button, in the header */}
            <button className="copilot-sheet-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          <div className="copilot-sheet-messages" ref={listRef}>
            {/* Task 7 — Welcome screen when no messages yet */}
            {isWelcomeScreen && !busy && (
              <WelcomeScreen onSend={send} />
            )}

            {messages.map((m, i) => (
              <div key={i} className={`copilot-msg copilot-msg-${m.role}`}>
                {m.role === 'assistant' && <span className="copilot-msg-avatar">{initials('SC')}</span>}
                <div className="copilot-msg-bubble-wrap">
                  {m.text && <div className="copilot-msg-bubble">{m.text}</div>}
                  {m.cards?.length > 0 && (
                    <div className="copilot-cards">
                      {m.cards.map((c, ci) => (
                        <ChatCard key={ci} card={c} onPreview={handleCardPreview} onStart={handleCardStart} onDetails={handleCardDetails} />
                      ))}
                    </div>
                  )}
                  {m.quickReplies?.length > 0 && (
                    <div className="copilot-quick-replies">
                      {m.quickReplies.map((q, qi) => (
                        <button key={qi} className="copilot-chip" onClick={() => handleQuickReply(q)}>{q}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Task 9 — Typing indicator while processing */}
            {busy && (
              <div className="copilot-msg copilot-msg-assistant copilot-msg-typing-row">
                <span className="copilot-msg-avatar">{initials('SC')}</span>
                <div className="copilot-msg-bubble copilot-msg-typing"><span /><span /><span /></div>
              </div>
            )}
          </div>

          {/* Task 6 — Input always at bottom, auto-focused */}
          <form
            className="copilot-sheet-input-row"
            onSubmit={e => { e.preventDefault(); send(input) }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask about buildings, classrooms, events or facilities…"
              className="copilot-input"
              disabled={busy}
              autoComplete="off"
              enterKeyHint="send"
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
