/**
 * ChatbotWidget — Phase 1 "AI Campus Copilot" UI.
 *
 * A small floating button (bottom-right) that opens a bottom-sheet chat
 * panel. The map stays visible behind it. All the actual "what does the
 * user want" / "where is that" work happens in copilotEngine.js — this
 * file is purely presentation + wiring to the navigation actions Home.jsx
 * already has (preview route / start navigation / view event details).
 */
import { useEffect, useRef, useState } from 'react'
import { runTurn } from './copilotEngine'

const STARTER_PROMPTS = [
  'Where is the library?',
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
  const [messages, setMessages] = useState([
    { role: 'assistant', text: "Hi! I'm the SSN Campus Copilot. Ask me about a building, department, classroom, event, or nearby facility." },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const stateRef = useRef({})
  const listRef = useRef(null)
  const lastArrivedRef = useRef(null)

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, open])

  // Smart suggestions: when the user arrives at a destination, offer
  // relevant nearby facilities without taking over the screen.
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
      <button
        className={`copilot-fab ${hasUnread ? 'copilot-fab-unread' : ''}`}
        onClick={toggleOpen}
        aria-label={open ? 'Close campus assistant' : 'Open campus assistant'}
        aria-expanded={open}
      >
        {open ? '✕' : '💬'}
        {hasUnread && !open && <span className="copilot-fab-dot" />}
      </button>

      {open && (
        <div className="copilot-sheet" role="dialog" aria-label="Campus Copilot chat">
          <div className="copilot-sheet-header">
            <div className="copilot-sheet-title">
              <span className="copilot-sheet-avatar">🧭</span>
              <div>
                <div className="copilot-sheet-title-text">Campus Copilot</div>
                <div className="copilot-sheet-subtitle">Ask about buildings, events, or facilities</div>
              </div>
            </div>
            <button className="copilot-sheet-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          <div className="copilot-sheet-messages" ref={listRef}>
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
            {busy && (
              <div className="copilot-msg copilot-msg-assistant">
                <span className="copilot-msg-avatar">{initials('SC')}</span>
                <div className="copilot-msg-bubble copilot-msg-typing"><span /><span /><span /></div>
              </div>
            )}
          </div>

          {messages.length <= 1 && (
            <div className="copilot-starters">
              {STARTER_PROMPTS.map((p, i) => (
                <button key={i} className="copilot-chip" onClick={() => send(p)}>{p}</button>
              ))}
            </div>
          )}

          <form
            className="copilot-sheet-input-row"
            onSubmit={e => { e.preventDefault(); send(input) }}
          >
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask about campus…"
              className="copilot-input"
              disabled={busy}
            />
            <button type="submit" className="copilot-send-btn" disabled={busy || !input.trim()} aria-label="Send">➤</button>
          </form>
        </div>
      )}
    </>
  )
}
