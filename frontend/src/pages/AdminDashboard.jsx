import { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { API_BASE } from '../api'
import PosterManager from '../components/PosterManager'
import VenueMenuAdmin from '../components/VenueMenuAdmin'
import {
  adminFetch, decodeJwtPayload, TOKEN_STORAGE_KEY,
  STATUS_COLOR, STATUS_LABEL, LOCATION_IDS, LOCATION_DISPLAY_NAMES,
  BLANK_EVENT_FORM, inputStyle, textareaStyle, selectStyle, pill,
} from './admin/adminShared'

// Phase X — lazy-loaded (PERFORMANCE: "lazy-load heavy admin pages"). Public
// users never download either of these; even admins only do on demand.
const AdminAnalytics   = lazy(() => import('./admin/AdminAnalytics'))
const AdminFeedback    = lazy(() => import('./admin/AdminFeedback'))
// RBAC redesign — Super Admin only, so also lazy: nobody downloads this
// unless they're actually a Super Admin opening this specific tab.
const ManageFestAdmins = lazy(() => import('./admin/ManageFestAdmins'))
// Production audit Part 8 — same reasoning, Super Admin dashboard only.
const AccountSettings  = lazy(() => import('./admin/AccountSettings'))
// Production audit — Dev Tools panel, Super Admin only. See DevTools.jsx's
// own header comment for the exact steps to remove this feature later.
const DevTools = lazy(() => import('./admin/DevTools'))
// A Fest Admin never needs any of the Super Admin dashboard code above —
// lazy-loaded and rendered instead of everything below the login check.
const FestAdminDashboard = lazy(() => import('./FestAdminDashboard'))

const BLANK_FORM = BLANK_EVENT_FORM

export default function AdminDashboard() {
  const usernameRef = useRef(null)
  const passwordRef = useRef(null)
  const [token, setToken]     = useState(() => sessionStorage.getItem(TOKEN_STORAGE_KEY) || '')
  const [authed, setAuthed]   = useState(false)
  // RBAC redesign — which dashboard to render. Decoded from the JWT (see
  // adminShared.js's decodeJwtPayload) the moment we have a token, so the
  // branch below can pick Super Admin vs Fest Admin without a network
  // round trip just to find out.
  const [role, setRole]       = useState(null)
  // Production audit Part 8 — decoded alongside role, kept in sync locally
  // after a successful Account Settings rename (the JWT itself still has
  // the old value baked in until next login — see AccountSettings.jsx's
  // onUsernameChanged callback below).
  const [username, setUsername] = useState(null)
  // Phase 4A.1 — true while we're verifying a stored token on mount, so the
  // login form doesn't flash for an already-signed-in admin (previously
  // there was no loading state here at all: the dashboard rendered the
  // login form first, then swapped to the real dashboard once the token
  // check resolved — a blank-feeling flicker on every refresh, worse on a
  // slow/cold backend).
  const [checkingSession, setCheckingSession] = useState(() => !!sessionStorage.getItem(TOKEN_STORAGE_KEY))
  const [events, setEvents]   = useState([])
  const [segments, setSegments] = useState([])
  const [venues,   setVenues]   = useState([])
  const [error, setError]     = useState(null)
  const [msg, setMsg]         = useState(null)
  const [tab, setTab]         = useState('events')
  const [form, setForm]       = useState(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  // Phase 4.2: which event card has its poster manager open
  const [expandedEventId, setExpandedEventId] = useState(null)

  function flash(text, isErr=false) {
    if (isErr) setError(text); else setMsg(text)
    setTimeout(()=>{ setError(null); setMsg(null) }, 4000)
  }

  // Phase 3 — if a JWT from a previous session is still in sessionStorage,
  // try it once on mount instead of forcing a fresh login every refresh.
  useEffect(() => {
    if (!token) { setCheckingSession(false); return }
    let cancelled = false
    const decoded = decodeJwtPayload(token)
    const tokenRole = decoded?.role || null
    setRole(tokenRole)
    setUsername(decoded?.username || null)
    // A Fest Admin's own dashboard (FestAdminDashboard.jsx) fetches its own
    // events with this same token — nothing Super-Admin-specific (road
    // segments, venues list for the Add Event venue picker) needs to load
    // here for that role, so skip straight to "authed" and let it render.
    if (tokenRole === 'festadmin') {
      setAuthed(true); setCheckingSession(false)
      return
    }
    adminFetch('/api/admin/events', 'GET', null, token)
      .then(data => {
        if (cancelled) return
        setEvents(data); setAuthed(true)
        fetch(`${API_BASE}/api/road-segments`).then(r=>r.json()).then((s) => { if (!cancelled) setSegments(s) })
        fetch(`${API_BASE}/api/locations`).then(r=>r.json()).then((v) => { if (!cancelled) setVenues(v) })
      })
      .catch((e) => {
        if (cancelled) return
        // Phase 4A.1 fix: only treat this as "your session is invalid" on a
        // real 401/403 from the server. A network/cold-start failure
        // (status 0, or no status at all) means we simply couldn't ask —
        // wiping a perfectly good token in that case used to force a
        // needless re-login the moment Render's free tier was asleep.
        if (e.status === 401 || e.status === 403) {
          sessionStorage.removeItem(TOKEN_STORAGE_KEY)
          setToken('')
        } else {
          flash('Could not verify your session — please retry or sign in again.', true)
        }
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function login() {
    // Priority 5 — read the live DOM value via ref, not React state. See the
    // note above the refs: this is what actually fixes the profile-specific
    // autofill failure (state can be stale/blank even when the field is
    // visibly filled).
    const usernameVal = usernameRef.current?.value.trim() ?? ''
    const passwordVal = passwordRef.current?.value ?? ''
    try {
      const data = await adminFetch('/api/admin/login', 'POST', { username: usernameVal, password: passwordVal })
      sessionStorage.setItem(TOKEN_STORAGE_KEY, data.access_token)
      setToken(data.access_token)
      setRole(data.role)
      setUsername(data.username)
      // "There should still be one login page. After login: Role determines
      // destination." — for a Fest Admin, that destination is
      // FestAdminDashboard, which fetches its own data; nothing else here
      // (road segments, venues, the full events list) is relevant to them.
      if (data.role === 'festadmin') { setAuthed(true); return }
      const events = await adminFetch('/api/admin/events', 'GET', null, data.access_token)
      setEvents(events); setAuthed(true)
      fetch(`${API_BASE}/api/road-segments`).then(r=>r.json()).then(setSegments)
      fetch(`${API_BASE}/api/locations`).then(r=>r.json()).then(setVenues)
    } catch(e) { flash(e.message,true) }
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY)
    setToken(''); setAuthed(false); setRole(null)
  }

  // Priority 7 (Phase 4.2.3) — manual escape hatch for the "admin login
  // fails only on this one Android Chrome profile" report. main.jsx's
  // controllerchange listener now force-reloads once a *new* service
  // worker takes over, but that only helps once Chrome has actually
  // finished installing/activating the new one — a profile that's badly
  // stuck (e.g. an installed PWA window Android never lets fully close)
  // may need a harder nudge. This clears every layer called out in the
  // investigation checklist — Service Worker registrations, the Cache
  // Storage entries Workbox created, and this tab's own token/session
  // state — then reloads straight from the network.
  async function hardResetAndRetry() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map(r => r.unregister()))
      }
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
      }
    } catch {
      // best-effort — fall through to reload regardless
    }
    sessionStorage.removeItem(TOKEN_STORAGE_KEY)
    window.location.reload()
  }

  async function reload() {
    try {
      const data = await adminFetch('/api/admin/events','GET',null,token)
      setEvents(data)
    } catch(e) { flash(e.message,true) }
  }

  async function reloadSegments() {
    const data = await fetch(`${API_BASE}/api/road-segments`).then(r=>r.json())
    setSegments(data)
  }

  async function action(path, method='PATCH') {
    try {
      const res = await adminFetch(path, method, null, token)
      flash(res.message)
      reload()
      // Task 2 — broadcast to EventsList + Copilot that a new event is approved
      if (path.includes('/verify')) {
        window.dispatchEvent(new CustomEvent('campus:eventApproved'))
      }
    }
    catch(e) { flash(e.message,true) }
  }

  async function toggleSegment(seg) {
    const endpoint = seg.closed ? 'open' : 'close'
    try {
      const res = await adminFetch(`/api/admin/road-segments/${seg.id}/${endpoint}`,'PATCH',null,token)
      flash(res.message); reloadSegments()
    } catch(e) { flash(e.message,true) }
  }

  async function submitEvent() {
    // Phase 4.2.1 — P1: validate required fields before hitting the API so
    // admins get a clear error instead of a silent Supabase constraint failure.
    const required = { 'Event name': form.name, 'Date': form.date, 'Start time': form.start_time, 'End time': form.end_time, 'Description': form.description }
    const missing = Object.entries(required).filter(([, v]) => !v?.trim()).map(([k]) => k)
    if (missing.length) { flash(`Please fill in: ${missing.join(', ')}`, true); return }
    setSubmitting(true)
    try {
      const payload = {
        ...form,
        photo_urls: form.photo_urls
          ? form.photo_urls.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 10)
          : [],
        building:     form.building     || null,
        room_number:  form.room_number  || null,
        floor:        form.floor        || null,
        wing:         form.wing         || null,
      }
      const res = await adminFetch('/api/admin/events','POST',payload,token)
      flash(`Submitted! ID: ${res.event_id}`); setForm(BLANK_FORM); setTab('events'); reload()
    } catch(e) { flash(e.message,true) }
    finally { setSubmitting(false) }
  }

  if (checkingSession) {
    return (
    <div className="admin-fullpage">
      <div className="boot-gate-spinner" aria-hidden="true" />
      <div style={{fontFamily:'var(--font-sans)',fontSize:'0.9rem',color:'var(--muted)'}}>Checking session…</div>
    </div>
  )}

  if (!authed) {
    return (
    <div className="admin-fullpage">
      <div style={{fontFamily:'var(--font-display)',fontSize:'1.3rem',fontWeight:700}}>Admin Login</div>
      {/* Task 3 — dark mode safe input */}
      <input type="text" placeholder="Username" defaultValue="" autoComplete="username"
        ref={usernameRef} onKeyDown={e=>e.key==='Enter'&&login()}
        className="admin-input"
        style={{...inputStyle, width:260}} />
      <input type="password" placeholder="Password" defaultValue="" autoComplete="current-password"
        ref={passwordRef} onKeyDown={e=>e.key==='Enter'&&login()}
        className="admin-input"
        style={{...inputStyle, width:260}} />
      <button onClick={login} style={{background:'var(--brand)',color:'#fff',padding:'10px 28px',borderRadius:999,fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.9rem'}}>Sign in</button>
      {error && <div style={{color:'#D7263D',fontSize:'0.85rem'}}>{error}</div>}
      {/* Priority 7 — recovery path for a profile stuck on a stale
          service worker / cached bundle (see hardResetAndRetry above). */}
      <button onClick={hardResetAndRetry}
        style={{background:'transparent',border:'none',color:'var(--muted)',fontSize:'0.78rem',textDecoration:'underline',cursor:'pointer',marginTop:2}}>
        Trouble logging in? Clear cached data &amp; retry
      </button>
    </div>
  )}

  // RBAC redesign — "one login page, role determines destination". Same
  // login form above for both roles; once authed, a Fest Admin gets a
  // completely separate, much simpler dashboard instead of anything below.
  if (role === 'festadmin') {
    return (
      <Suspense fallback={<div className="admin-fullpage"><div className="boot-gate-spinner" aria-hidden="true" /></div>}>
        <FestAdminDashboard token={token} onLogout={logout} />
      </Suspense>
    )
  }

  return (
    <div style={{height:'100%',overflow:'hidden',display:'flex',flexDirection:'column'}}>
      {/* Tab bar */}
      <div style={{display:'flex',gap:8,padding:'12px 16px',borderBottom:'1px solid var(--line)',flexShrink:0,flexWrap:'wrap',alignItems:'center'}}>
        <span style={{fontSize:'0.68rem',fontWeight:700,padding:'4px 10px',borderRadius:999,
          background:'var(--brand)22',color:'var(--brand)',border:'1px solid var(--brand)',
          textTransform:'uppercase',letterSpacing:'0.06em',marginRight:2}}>
          Role: Super Admin
        </span>
        {[['events',`Events (${events.length})`],['roads','Road Closures'],['menus','🍽 Menus'],['analytics','📊 Analytics'],['feedback','💬 Feedback'],['festadmins','👥 Manage Fest Admins'],['devtools','🛠 Dev Tools'],['account','⚙ Account Settings'],['add','+ Add Event']].map(([t,label])=>(
          <button key={t} onClick={()=>setTab(t)} style={{...pill,
            background:tab===t?'var(--ink)':'transparent',
            color:tab===t?'var(--canvas)':'var(--ink)',
            border:'1px solid var(--line)'}}>
            {label}
          </button>
        ))}
        <div style={{flex:1}}/>
        {msg   && <span style={{fontSize:'0.8rem',color:'#2E9E5B',alignSelf:'center'}}>{msg}</span>}
        {error && <span style={{fontSize:'0.8rem',color:'#D7263D',alignSelf:'center'}}>{error}</span>}
        <button onClick={logout} style={{...pill,background:'transparent',border:'1px solid var(--line)',color:'var(--muted)'}}>Sign out</button>
      </div>

      {/* Events list */}
      {tab==='events' && (
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
          {events.length===0 && <div className="state-message">No events yet.</div>}
          {events.map(e=>(
            <div key={e.id} style={{background:'var(--surface)',borderRadius:14,padding:'14px 18px',boxShadow:'var(--shadow-md)'}}>
              <div style={{display:'flex',alignItems:'flex-start',gap:10,flexWrap:'wrap'}}>
                <span style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.97rem',flex:1,color:'var(--ink)'}}>{e.name}</span>
                <span style={{fontSize:'0.7rem',fontWeight:700,padding:'3px 10px',borderRadius:999,
                  background:STATUS_COLOR[e.status]+'22',color:STATUS_COLOR[e.status],
                  border:`1px solid ${STATUS_COLOR[e.status]}`,textTransform:'uppercase',letterSpacing:'0.06em'}}>
                  {STATUS_LABEL[e.status] || e.status}
                </span>
              </div>
              <div style={{fontSize:'0.78rem',color:'var(--muted)',marginTop:4}}>
                {e.fest} · {e.location ? (LOCATION_DISPLAY_NAMES[e.location.id] || e.location.name) : (LOCATION_DISPLAY_NAMES[e.location_id] || e.location_id)} · {e.date} {e.start_time}–{e.end_time}
              </div>
              {/* RBAC redesign — who submitted it and who last reviewed it */}
              {(e.submitted_by || e.reviewed_by) && (
                <div style={{fontSize:'0.72rem',color:'var(--muted)',marginTop:4}}>
                  {e.submitted_by && <>Submitted by <strong>{e.submitted_by}</strong></>}
                  {e.submitted_by && e.reviewed_by && ' · '}
                  {e.reviewed_by && <>Reviewed by <strong>{e.reviewed_by}</strong></>}
                </div>
              )}
              {e.review_notes && (
                <div style={{fontSize:'0.78rem',color: e.status==='rejected' ? '#D7263D' : 'var(--ink)', marginTop:4}}>
                  {e.status==='needs_changes' ? 'Requested changes: ' : e.status==='rejected' ? 'Reason: ' : 'Note: '}{e.review_notes}
                </div>
              )}
              <div style={{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}}>
                {e.status!=='verified' && (
                  <button onClick={()=>action(`/api/admin/events/${e.id}/verify`)}
                    style={{...pill,background:'#2E9E5B',color:'#fff'}}>✓ Approve</button>
                )}
                <button onClick={()=>{
                    const reason = window.prompt('Reason for rejecting?', '')
                    if (reason===null) return   // cancelled
                    action(`/api/admin/events/${e.id}/reject?reason=${encodeURIComponent(reason)}`)
                  }}
                  style={{...pill,background:'#E03E52',color:'#fff'}}>✗ Reject</button>
                <button onClick={()=>{
                    const notes = window.prompt('What needs to change?', '')
                    if (notes===null) return   // cancelled
                    if (!notes.trim()) { flash('Add a note explaining what needs to change.', true); return }
                    action(`/api/admin/events/${e.id}/request-changes?notes=${encodeURIComponent(notes)}`)
                  }}
                  style={{...pill,background:'#B8860B',color:'#fff'}}>↩ Request Changes</button>
                <button onClick={()=>{ if(window.confirm('Delete permanently?')) action(`/api/admin/events/${e.id}`,'DELETE') }}
                  style={{...pill,background:'transparent',border:'1px solid var(--line)',color:'var(--ink)'}}>Delete</button>
                <a href={`/event/${e.id}`} target="_blank" rel="noreferrer"
                  style={{...pill,background:'var(--canvas)',border:'1px solid var(--line)',color:'var(--ink)'}}>Preview →</a>
                <a href={`${API_BASE}/api/events/${e.id}/qr`} target="_blank" rel="noreferrer"
                  style={{...pill,background:'var(--canvas)',border:'1px solid var(--line)',color:'var(--ink)'}}>QR ↓</a>
                {/* Phase 4.2 — replaced inline upload labels with proper PosterManager */}
                <button
                  onClick={()=>setExpandedEventId(prev => prev===e.id ? null : e.id)}
                  style={{...pill,background:'var(--canvas)',border:'1px solid var(--line)',color:'var(--ink)'}}>
                  {expandedEventId===e.id ? '▲ Hide Posters' : '🖼 Manage Posters'}
                </button>
              </div>
              {/* Phase 4.2 — expandable PosterManager panel per event */}
              {expandedEventId===e.id && (
                <div style={{marginTop:12,borderTop:'1px solid var(--line)',paddingTop:12}}>
                  <PosterManager
                    eventId={e.id}
                    token={token}
                    onUpdated={() => flash('Images updated.')}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Food Court Menus tab */}
      {tab==='menus' && (
        <div style={{flex:1,overflowY:'auto',padding:'16px'}}>
          <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'1.05rem',marginBottom:6,color:'var(--ink)'}}>
            Food Court Menus
          </div>
          <div style={{fontSize:'0.8rem',color:'var(--muted)',marginBottom:16,lineHeight:1.5}}>
            Upload or replace the daily menu image for each food court.
            Students see today's menu on the venue card and via Campus Copilot.
          </div>
          <VenueMenuAdmin venues={venues} token={token} />
        </div>
      )}

      {/* Phase X — Analytics */}
      {tab==='analytics' && (
        <Suspense fallback={<div className="state-message" style={{padding:16}}>Loading analytics…</div>}>
          <AdminAnalytics token={token} />
        </Suspense>
      )}

      {/* Phase X — Route Feedback */}
      {tab==='feedback' && (
        <Suspense fallback={<div className="state-message" style={{padding:16}}>Loading feedback…</div>}>
          <AdminFeedback token={token} />
        </Suspense>
      )}

      {/* RBAC redesign — Manage Fest Admins */}
      {tab==='festadmins' && (
        <Suspense fallback={<div className="state-message" style={{padding:16}}>Loading…</div>}>
          <ManageFestAdmins token={token} flash={flash} />
        </Suspense>
      )}

      {/* Production audit Part 8 — Account Settings */}
      {tab==='account' && (
        <Suspense fallback={<div className="state-message" style={{padding:16}}>Loading…</div>}>
          <AccountSettings token={token} currentUsername={username} onLogout={logout} flash={flash}
            onUsernameChanged={(u)=>setUsername(u)} />
        </Suspense>
      )}

      {/* Production audit — Dev Tools panel */}
      {tab==='devtools' && (
        <Suspense fallback={<div className="state-message" style={{padding:16}}>Loading…</div>}>
          <DevTools token={token} />
        </Suspense>
      )}

      {/* Road closures */}
      {tab==='roads' && (
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
          <div style={{fontFamily:'var(--font-sans)',fontSize:'0.82rem',color:'var(--muted)',marginBottom:4}}>
            Toggle road segments on/off. Closed roads get a very high penalty — the router automatically finds an alternate route.
          </div>
          {segments.map(seg=>(
            <div key={seg.id} style={{background:'var(--surface)',borderRadius:14,padding:'14px 18px',boxShadow:'var(--shadow-md)',
              borderLeft:`4px solid ${seg.closed?'#D7263D':'#2E9E5B'}`}}>
              <div style={{display:'flex',alignItems:'center',gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.92rem',color:'var(--ink)'}}>{seg.name}</div>
                  <div style={{fontSize:'0.78rem',color:'var(--muted)',marginTop:2}}>{seg.description}</div>
                </div>
                <button onClick={()=>toggleSegment(seg)}
                  style={{...pill,
                    background: seg.closed ? '#2E9E5B' : '#D7263D',
                    color:'#fff', flexShrink:0}}>
                  {seg.closed ? '✓ Reopen' : '⚠ Close'}
                </button>
              </div>
              {seg.closed && (
                <div style={{marginTop:8,fontSize:'0.75rem',color:'#D7263D',fontWeight:600}}>
                  🚧 CLOSED — router is using alternate path
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add event form */}
      {tab==='add' && (
        <div style={{flex:1,overflowY:'auto',padding:'16px',maxWidth:540}}>
          <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'1.1rem',marginBottom:14,color:'var(--ink)'}}>Add New Event</div>

          {/* Task 3 — all inputs use theme-aware inputStyle */}
          {[['name','Event name *','text'],['fest','Fest (Invente / Instincts) *','text'],
            ['department','Organising department *','text'],
            ['organizer','Organiser / club name','text'],
            ['category','Category (Workshop / Competition / Performance / Exhibition)','text'],
            ['date','Date *','date'],
            ['start_time','Start time *','time'],['end_time','End time *','time']].map(([key,label,type])=>(
            <div key={key} style={{marginBottom:12}}>
              <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>{label}</label>
              <input type={type} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}
                style={inputStyle} />
            </div>
          ))}

          <div style={{marginBottom:12}}>
            <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>Venue *</label>
            <select value={form.location_id} onChange={e=>setForm(f=>({...f,location_id:e.target.value}))}
              style={selectStyle}>
              {LOCATION_IDS.map(id=><option key={id} value={id}>{LOCATION_DISPLAY_NAMES[id] || id}</option>)}
            </select>
          </div>

          <div style={{marginBottom:12}}>
            <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>Description *</label>
            <textarea rows={4} value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))}
              style={textareaStyle} />
          </div>

          <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.85rem',marginBottom:10,marginTop:4,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.05em'}}>
            📸 Media & Contact (optional)
          </div>
          {[
            ['contact_info','Contact info (email / phone)','text'],
            ['registration_link','Registration link (URL)','url'],
            ['poster_url','Event poster image URL','url'],
          ].map(([key,label,type])=>(
            <div key={key} style={{marginBottom:12}}>
              <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>{label}</label>
              <input type={type} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}
                placeholder={type==='url'?'https://…':''}
                style={inputStyle} />
            </div>
          ))}
          <div style={{marginBottom:12}}>
            <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>
              Event photos (up to 10 URLs, one per line)
            </label>
            <textarea rows={4}
              value={form.photo_urls}
              onChange={e=>setForm(f=>({...f,photo_urls:e.target.value}))}
              placeholder={'https://example.com/photo1.jpg\nhttps://example.com/photo2.jpg'}
              style={{...textareaStyle,fontSize:'0.85rem'}} />
            <div style={{fontSize:'0.72rem',color:'var(--muted)',marginTop:4}}>Supports 0–10 photos. Each URL on a new line.</div>
          </div>

          <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.85rem',marginBottom:10,marginTop:4,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.05em'}}>
            📍 Venue Details (Room / Floor / Wing)
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
            {[
              ['building','Building (e.g. EEE Block)'],
              ['room_number','Room No. (e.g. EEE-302)'],
              ['floor','Floor (e.g. 3rd Floor)'],
              ['wing','Wing (e.g. Left Wing)'],
            ].map(([key,label])=>(
              <div key={key}>
                <label style={{fontSize:'0.72rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>{label}</label>
                <input type="text" value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}
                  style={{...inputStyle,fontSize:'0.88rem'}} />
              </div>
            ))}
          </div>

          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:18}}>
            <input type="checkbox" id="ext" checked={form.open_to_external}
              onChange={e=>setForm(f=>({...f,open_to_external:e.target.checked}))}
              style={{accentColor:'var(--brand)',width:16,height:16}} />
            <label htmlFor="ext" style={{fontSize:'0.88rem',color:'var(--ink)'}}>Open to external/visiting colleges</label>
          </div>

          <button onClick={submitEvent} disabled={submitting}
            style={{width:'100%',padding:'13px',borderRadius:999,background:'var(--brand)',fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.95rem',color:'#fff',cursor:'pointer'}}>
            {submitting ? 'Submitting…' : 'Submit Event (pending verification)'}
          </button>
        </div>
      )}
    </div>
  )
}
