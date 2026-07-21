/**
 * FestAdminDashboard.jsx — RBAC redesign.
 *
 * Lazy-loaded from AdminDashboard.jsx, rendered instead of the whole Super
 * Admin dashboard when the logged-in account's role is 'festadmin' (see
 * AdminDashboard's role branch — one login page, role determines
 * destination). Deliberately much smaller in scope than AdminDashboard:
 * a Fest Admin can only add/edit their own fest schedule entries and see
 * their status — no analytics, road closures, menus, feedback, or other
 * admin accounts anywhere in this file.
 */
import { useEffect, useState } from 'react'
import {
  adminFetch, STATUS_COLOR, STATUS_LABEL,
  LOCATION_IDS, LOCATION_DISPLAY_NAMES, BLANK_EVENT_FORM,
  inputStyle, textareaStyle, selectStyle, pill,
} from './admin/adminShared'

// Only these statuses can still be edited — "Edit their own submitted
// schedules (until approved)". Editing any of these resets status back to
// 'pending' server-side (a fresh review cycle) — see backend
// data_access.update_event.
const EDITABLE_STATUSES = ['pending', 'needs_changes', 'rejected']

export default function FestAdminDashboard({ token, onLogout }) {
  const [view, setView] = useState('list')  // 'list' | 'form'
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)
  const [form, setForm] = useState(BLANK_EVENT_FORM)
  const [editingId, setEditingId] = useState(null)  // null = creating new
  const [submitting, setSubmitting] = useState(false)

  function flash(text, isErr=false) {
    if (isErr) setError(text); else setMsg(text)
    setTimeout(()=>{ setError(null); setMsg(null) }, 4000)
  }

  function load() {
    setLoading(true)
    adminFetch('/api/admin/events', 'GET', null, token)
      .then(setEvents)
      .catch((e) => flash(e.message, true))
      .finally(() => setLoading(false))
  }
  useEffect(load, [token])

  function startNew() {
    setForm(BLANK_EVENT_FORM); setEditingId(null); setView('form')
  }

  function startEdit(e) {
    setForm({
      name: e.name || '', fest: e.fest || '', department: e.department || '',
      location_id: e.location_id || e.location?.id || 'tcs-auditorium',
      date: e.date || '', start_time: e.start_time || '', end_time: e.end_time || '',
      description: e.description || '', open_to_external: e.open_to_external ?? true,
      organizer: e.organizer || '', category: e.category || '',
      contact_info: e.contact_info || '', registration_link: e.registration_link || '',
      poster_url: '', photo_urls: '',  // images managed separately, not part of this form's edit payload
      building: e.building || '', room_number: e.room_number || '', floor: e.floor || '', wing: e.wing || '',
    })
    setEditingId(e.id); setView('form')
  }

  async function submit() {
    const required = { 'Event name': form.name, 'Date': form.date, 'Start time': form.start_time, 'End time': form.end_time, 'Description': form.description }
    const missing = Object.entries(required).filter(([, v]) => !v?.trim()).map(([k]) => k)
    if (missing.length) { flash(`Please fill in: ${missing.join(', ')}`, true); return }
    setSubmitting(true)
    try {
      if (editingId) {
        // Edit — PATCH the core fields only; poster_url/photo_urls are
        // never part of this payload (images aren't editable through this
        // form at all when editing — see the "Once submitted…" note below
        // the image fields, which only render on create anyway).
        const {
          name, fest, department, location_id, date, start_time, end_time,
          description, open_to_external, organizer, category,
          contact_info, registration_link, building, room_number, floor, wing,
        } = form
        const editable = {
          name, fest, department, location_id, date, start_time, end_time,
          description, open_to_external, organizer, category,
          contact_info, registration_link, building, room_number, floor, wing,
        }
        await adminFetch(`/api/admin/events/${editingId}`, 'PATCH', editable, token)
        flash('Updated — back in the review queue.')
      } else {
        const payload = {
          ...form,
          photo_urls: form.photo_urls
            ? form.photo_urls.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 10)
            : [],
          building: form.building || null, room_number: form.room_number || null,
          floor: form.floor || null, wing: form.wing || null,
        }
        await adminFetch('/api/admin/events', 'POST', payload, token)
        flash('Submitted — pending review.')
      }
      setForm(BLANK_EVENT_FORM); setEditingId(null); setView('list'); load()
    } catch (e) { flash(e.message, true) }
    finally { setSubmitting(false) }
  }

  return (
    <div style={{height:'100%',overflow:'hidden',display:'flex',flexDirection:'column'}}>
      {/* Header — kept deliberately minimal, per "Fest Admin dashboard
          should be extremely simple. Only show what they need." */}
      <div style={{display:'flex',gap:8,padding:'12px 16px',borderBottom:'1px solid var(--line)',flexShrink:0,alignItems:'center',flexWrap:'wrap'}}>
        <span style={{fontSize:'0.68rem',fontWeight:700,padding:'4px 10px',borderRadius:999,
          background:'var(--brand)22',color:'var(--brand)',border:'1px solid var(--brand)',
          textTransform:'uppercase',letterSpacing:'0.06em'}}>
          Role: Fest Admin
        </span>
        <button onClick={()=>setView('list')} style={{...pill,
          background: view==='list' ? 'var(--ink)' : 'transparent',
          color: view==='list' ? 'var(--canvas)' : 'var(--ink)', border:'1px solid var(--line)'}}>
          My Schedules ({events.length})
        </button>
        <button onClick={startNew} style={{...pill,
          background: view==='form' ? 'var(--ink)' : 'transparent',
          color: view==='form' ? 'var(--canvas)' : 'var(--ink)', border:'1px solid var(--line)'}}>
          + Add Fest Schedule
        </button>
        <div style={{flex:1}} />
        {msg   && <span style={{fontSize:'0.8rem',color:'#2E9E5B',alignSelf:'center'}}>{msg}</span>}
        {error && <span style={{fontSize:'0.8rem',color:'#D7263D',alignSelf:'center'}}>{error}</span>}
        <button onClick={onLogout} style={{...pill,background:'transparent',border:'1px solid var(--line)',color:'var(--muted)'}}>Sign out</button>
      </div>

      {view === 'list' && (
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
          {loading && <div className="state-message">Loading…</div>}
          {!loading && events.length===0 && (
            <div className="state-message">You haven't submitted any fest schedules yet — tap "+ Add Fest Schedule" to get started.</div>
          )}
          {events.map(e => {
            const editable = EDITABLE_STATUSES.includes(e.status)
            return (
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
                  {e.fest} · {LOCATION_DISPLAY_NAMES[e.location_id] || e.location?.name || e.location_id} · {e.date} {e.start_time}–{e.end_time}
                </div>
                {e.review_notes && (
                  <div style={{fontSize:'0.78rem',color: e.status==='rejected' ? '#D7263D' : 'var(--ink)', marginTop:4}}>
                    {e.status==='needs_changes' ? 'Requested changes: ' : e.status==='rejected' ? 'Reason: ' : 'Note: '}{e.review_notes}
                  </div>
                )}
                <div style={{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}}>
                  {editable ? (
                    <button onClick={()=>startEdit(e)} style={{...pill,background:'var(--brand)',color:'#fff'}}>✎ Edit</button>
                  ) : (
                    <span style={{fontSize:'0.74rem',color:'var(--muted)',alignSelf:'center'}}>
                      {e.status === 'verified' ? 'Approved — contact a Super Admin to change it.' : ''}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {view === 'form' && (
        <div style={{flex:1,overflowY:'auto',padding:'16px',maxWidth:540}}>
          <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'1.1rem',marginBottom:14,color:'var(--ink)'}}>
            {editingId ? 'Edit Fest Schedule' : 'Add Fest Schedule'}
          </div>
          {editingId && (
            <div style={{fontSize:'0.78rem',color:'var(--muted)',marginBottom:14,lineHeight:1.5}}>
              Saving will send this back to "Pending Review" for a Super Admin to look at again.
            </div>
          )}

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
            📸 Contact (optional)
          </div>
          {[
            ['contact_info','Contact info (email / phone)','text'],
            ['registration_link','Registration link (URL)','url'],
          ].map(([key,label,type])=>(
            <div key={key} style={{marginBottom:12}}>
              <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>{label}</label>
              <input type={type} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}
                placeholder={type==='url'?'https://…':''}
                style={inputStyle} />
            </div>
          ))}

          {!editingId && (
            <>
              <div style={{marginBottom:12}}>
                <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>Event poster image URL</label>
                <input type="url" value={form.poster_url} onChange={e=>setForm(f=>({...f,poster_url:e.target.value}))}
                  placeholder="https://…" style={inputStyle} />
              </div>
              <div style={{marginBottom:12}}>
                <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>
                  Event photos (up to 10 URLs, one per line)
                </label>
                <textarea rows={3} value={form.photo_urls} onChange={e=>setForm(f=>({...f,photo_urls:e.target.value}))}
                  placeholder={'https://example.com/photo1.jpg\nhttps://example.com/photo2.jpg'}
                  style={{...textareaStyle,fontSize:'0.85rem'}} />
              </div>
              <div style={{fontSize:'0.72rem',color:'var(--muted)',marginBottom:12,marginTop:-6}}>
                Once submitted, ask a Super Admin if you need to add or change images later.
              </div>
            </>
          )}

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

          <div style={{display:'flex',gap:10}}>
            <button onClick={submit} disabled={submitting}
              style={{flex:1,padding:'13px',borderRadius:999,background:'var(--brand)',fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.95rem',color:'#fff',cursor:'pointer'}}>
              {submitting ? 'Saving…' : editingId ? 'Save (back to review)' : 'Submit (pending review)'}
            </button>
            <button onClick={()=>{ setForm(BLANK_EVENT_FORM); setEditingId(null); setView('list') }}
              style={{padding:'13px 20px',borderRadius:999,background:'transparent',border:'1px solid var(--line)',fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.9rem',color:'var(--ink)',cursor:'pointer'}}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
