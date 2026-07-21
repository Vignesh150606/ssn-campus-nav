/**
 * ManageFestAdmins.jsx — RBAC redesign.
 *
 * Lazy-loaded from AdminDashboard.jsx, Super Admin only (the tab that
 * renders this is never even shown to a Fest Admin — see AdminDashboard's
 * role branch). Create / list / disable / enable / reset-password / delete
 * Fest Admin accounts, plus a lightweight audit log view underneath.
 */
import { useEffect, useState } from 'react'
import { adminFetch, inputStyle, pill } from './adminShared'

const ACTION_LABEL = {
  fest_admin_created: 'Fest Admin created',
  fest_admin_deleted: 'Fest Admin deleted',
  fest_admin_disabled: 'Fest Admin disabled',
  fest_admin_enabled: 'Fest Admin enabled',
  password_reset: 'Password reset',
  fest_submitted: 'Fest schedule submitted',
  fest_approved: 'Fest schedule approved',
  fest_rejected: 'Fest schedule rejected',
  fest_needs_changes: 'Fest schedule sent back for changes',
  fest_updated: 'Fest schedule edited',
  fest_deleted: 'Fest schedule deleted',
}

// Shown once, right after creating an account or resetting a password —
// bcrypt is one-way, so a freshly generated password can never be shown
// again after this. copy-to-clipboard is a plain best-effort convenience;
// falls back silently to "just select the text" on browsers/contexts
// without Clipboard API access (e.g. non-HTTPS).
function GeneratedCredentialPanel({ username, password, onDismiss }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(password)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable — text is still selectable below */ }
  }
  return (
    <div style={{background:'#2E9E5B18',border:'1px solid #2E9E5B',borderRadius:12,padding:'14px 16px',marginBottom:14}}>
      <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.88rem',color:'var(--ink)',marginBottom:6}}>
        Save these credentials now — the password won't be shown again
      </div>
      <div style={{fontFamily:'monospace',fontSize:'0.88rem',color:'var(--ink)',marginBottom:2}}>Username: <strong>{username}</strong></div>
      <div style={{fontFamily:'monospace',fontSize:'0.88rem',color:'var(--ink)',display:'flex',alignItems:'center',gap:8}}>
        Password: <strong style={{userSelect:'all'}}>{password}</strong>
        <button onClick={copy} style={{...pill,padding:'3px 10px',fontSize:'0.7rem',background:'var(--canvas)',border:'1px solid var(--line)',color:'var(--ink)'}}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <button onClick={onDismiss} style={{...pill,marginTop:10,padding:'4px 12px',fontSize:'0.74rem',background:'transparent',border:'1px solid var(--line)',color:'var(--muted)'}}>
        Done, I've saved it
      </button>
    </div>
  )
}

export default function ManageFestAdmins({ token, flash }) {
  const [admins, setAdmins] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')  // blank = auto-generate
  const [creating, setCreating] = useState(false)
  const [reveal, setReveal] = useState(null)  // {username, password} shown once after create/reset
  const [showAudit, setShowAudit] = useState(false)
  const [audit, setAudit] = useState([])
  const [auditLoading, setAuditLoading] = useState(false)

  function load() {
    setLoading(true); setError(null)
    adminFetch('/api/admin/fest-admins', 'GET', null, token)
      .then(setAdmins)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [token])

  function loadAudit() {
    setAuditLoading(true)
    adminFetch('/api/admin/audit-log?limit=100', 'GET', null, token)
      .then(setAudit)
      .catch((e) => flash?.(e.message, true))
      .finally(() => setAuditLoading(false))
  }

  async function createAdmin() {
    const username = newUsername.trim()
    if (!username) { flash?.('Enter a username.', true); return }
    setCreating(true)
    try {
      const res = await adminFetch('/api/admin/fest-admins', 'POST',
        { username, password: newPassword.trim() || null }, token)
      flash?.(res.message)
      setNewUsername(''); setNewPassword('')
      if (res.generated_password) setReveal({ username: res.username, password: res.generated_password })
      load()
    } catch (e) { flash?.(e.message, true) }
    finally { setCreating(false) }
  }

  async function toggleDisabled(a) {
    const path = a.disabled ? `/api/admin/fest-admins/${a.id}/enable` : `/api/admin/fest-admins/${a.id}/disable`
    try {
      const res = await adminFetch(path, 'PATCH', null, token)
      flash?.(res.message); load()
    } catch (e) { flash?.(e.message, true) }
  }

  async function resetPassword(a) {
    const typed = window.prompt(`New password for '${a.username}'? Leave blank to auto-generate one.`, '')
    if (typed === null) return  // cancelled
    try {
      const res = await adminFetch(`/api/admin/fest-admins/${a.id}/reset-password`, 'POST',
        { password: typed.trim() || null }, token)
      flash?.(res.message)
      if (res.generated_password) setReveal({ username: a.username, password: res.generated_password })
    } catch (e) { flash?.(e.message, true) }
  }

  async function deleteAdmin(a) {
    if (!window.confirm(`Delete Fest Admin '${a.username}'? Their past submissions stay on the schedule (just no longer attributed to them). This can't be undone.`)) return
    try {
      const res = await adminFetch(`/api/admin/fest-admins/${a.id}`, 'DELETE', null, token)
      flash?.(res.message); load()
    } catch (e) { flash?.(e.message, true) }
  }

  return (
    <div style={{flex:1,overflowY:'auto',padding:'16px',maxWidth:640}}>
      <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'1.05rem',marginBottom:6,color:'var(--ink)'}}>
        Manage Fest Admins
      </div>
      <div style={{fontSize:'0.8rem',color:'var(--muted)',marginBottom:16,lineHeight:1.5}}>
        Fest Admins can only submit and edit their own fest schedule entries — nothing else (no analytics, road closures, menus, feedback, or other admins). Each submission needs your approval before it goes public.
      </div>

      {reveal && (
        <GeneratedCredentialPanel username={reveal.username} password={reveal.password} onDismiss={() => setReveal(null)} />
      )}

      {/* Create new */}
      <div style={{background:'var(--surface)',borderRadius:14,padding:'14px 16px',boxShadow:'var(--shadow-md)',marginBottom:18}}>
        <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.88rem',marginBottom:10,color:'var(--ink)'}}>+ Create Fest Admin</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}>
          <input type="text" placeholder="Username (e.g. cse-coordinator)" value={newUsername}
            onChange={e=>setNewUsername(e.target.value)} style={{...inputStyle,flex:'1 1 200px'}} />
          <input type="text" placeholder="Password (blank = auto-generate)" value={newPassword}
            onChange={e=>setNewPassword(e.target.value)} style={{...inputStyle,flex:'1 1 220px'}} />
        </div>
        <button onClick={createAdmin} disabled={creating}
          style={{...pill,background:'var(--brand)',color:'#fff',padding:'9px 20px'}}>
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>

      {loading && <div className="state-message">Loading…</div>}
      {error && <div style={{color:'#D7263D',fontSize:'0.85rem',marginBottom:12}}>{error}</div>}

      {!loading && admins.length===0 && <div className="state-message">No Fest Admins yet — create one above.</div>}

      <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:24}}>
        {admins.map(a => (
          <div key={a.id} style={{background:'var(--surface)',borderRadius:14,padding:'12px 16px',boxShadow:'var(--shadow-md)'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <span style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'0.92rem',flex:1,color:'var(--ink)'}}>{a.username}</span>
              <span style={{fontSize:'0.68rem',fontWeight:700,padding:'3px 10px',borderRadius:999,
                background: a.disabled ? '#D7263D22' : '#2E9E5B22',
                color: a.disabled ? '#D7263D' : '#2E9E5B',
                border: `1px solid ${a.disabled ? '#D7263D' : '#2E9E5B'}`,
                textTransform:'uppercase',letterSpacing:'0.06em'}}>
                {a.disabled ? 'Disabled' : 'Active'}
              </span>
            </div>
            <div style={{fontSize:'0.74rem',color:'var(--muted)',marginTop:4}}>
              Created by {a.created_by_username || 'unknown'} · {a.created_at ? new Date(a.created_at).toLocaleDateString() : ''}
              {a.last_login_at && <> · last login {new Date(a.last_login_at).toLocaleString()}</>}
            </div>
            <div style={{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}}>
              <button onClick={()=>toggleDisabled(a)}
                style={{...pill, background: a.disabled ? '#2E9E5B' : '#E07414', color:'#fff'}}>
                {a.disabled ? '✓ Enable' : '⛔ Disable'}
              </button>
              <button onClick={()=>resetPassword(a)}
                style={{...pill,background:'var(--canvas)',border:'1px solid var(--line)',color:'var(--ink)'}}>
                🔑 Reset Password
              </button>
              <button onClick={()=>deleteAdmin(a)}
                style={{...pill,background:'transparent',border:'1px solid #D7263D',color:'#D7263D'}}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Audit log */}
      <button onClick={()=>{ setShowAudit(s=>!s); if (!showAudit && audit.length===0) loadAudit() }}
        style={{...pill,background:'transparent',border:'1px solid var(--line)',color:'var(--ink)',marginBottom:10}}>
        {showAudit ? '▲ Hide Audit Log' : '▼ Show Audit Log'}
      </button>
      {showAudit && (
        <div style={{background:'var(--surface)',borderRadius:14,padding:'12px 16px',boxShadow:'var(--shadow-md)'}}>
          {auditLoading && <div className="state-message">Loading…</div>}
          {!auditLoading && audit.length===0 && <div className="state-message">No actions logged yet.</div>}
          <div style={{display:'flex',flexDirection:'column',gap:8,maxHeight:360,overflowY:'auto'}}>
            {audit.map(entry => (
              <div key={entry.id} style={{fontSize:'0.78rem',color:'var(--ink)',borderBottom:'1px solid var(--line)',paddingBottom:8}}>
                <strong>{ACTION_LABEL[entry.action] || entry.action}</strong> by {entry.actor_username}
                {entry.target_id && <> · {entry.target_type} <code style={{fontSize:'0.72rem'}}>{entry.target_id}</code></>}
                <div style={{color:'var(--muted)',fontSize:'0.72rem',marginTop:2}}>
                  {entry.created_at ? new Date(entry.created_at).toLocaleString() : ''}
                  {entry.details?.reason && <> · reason: {entry.details.reason}</>}
                  {entry.details?.notes && <> · notes: {entry.details.notes}</>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
