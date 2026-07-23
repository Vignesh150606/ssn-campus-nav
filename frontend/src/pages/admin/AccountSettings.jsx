/**
 * AccountSettings.jsx — production audit Part 8.
 *
 * Lazy-loaded from AdminDashboard.jsx. Backend endpoint (PATCH
 * /api/admin/account) works for either role, but only the Super Admin
 * dashboard has a tab for this — see main.py's endpoint docstring.
 */
import { useState } from 'react'
import { adminFetch, TOKEN_STORAGE_KEY, inputStyle, pill } from './adminShared'

export default function AccountSettings({ token, currentUsername, onLogout, flash, onUsernameChanged }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState(null)

  async function save() {
    setLocalError(null)
    if (!currentPassword) { setLocalError('Enter your current password to confirm this change.'); return }
    if (!newUsername.trim() && !newPassword) { setLocalError('Change your username and/or password first.'); return }
    if (newPassword && newPassword !== confirmPassword) { setLocalError("New password and confirmation don't match."); return }

    setSaving(true)
    try {
      const body = { current_password: currentPassword }
      if (newUsername.trim()) body.new_username = newUsername.trim()
      if (newPassword) { body.new_password = newPassword; body.confirm_password = confirmPassword }

      const res = await adminFetch('/api/admin/account', 'PATCH', body, token)
      setCurrentPassword(''); setNewUsername(''); setNewPassword(''); setConfirmPassword('')

      if (res.logout_required) {
        // "No logout required unless password changes" — sign out this
        // device so a stale session can't linger after a credential change.
        flash?.('Password changed — please sign in again.')
        sessionStorage.removeItem(TOKEN_STORAGE_KEY)
        setTimeout(() => onLogout?.(), 1200)
      } else {
        flash?.(res.message)
        // Username-only change — no logout, but the JWT already issued
        // still has the OLD username baked in until next login. Update
        // local UI state directly so it doesn't look stale in the
        // meantime (the backend is the actual source of truth either way).
        if (res.username && res.username !== currentUsername) onUsernameChanged?.(res.username)
      }
    } catch (e) { setLocalError(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div style={{flex:1,overflowY:'auto',padding:'16px',maxWidth:460}}>
      <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'1.05rem',marginBottom:6,color:'var(--ink)'}}>
        Account Settings
      </div>
      <div style={{fontSize:'0.8rem',color:'var(--muted)',marginBottom:18}}>
        Signed in as <strong>{currentUsername}</strong>. Changing your password will sign you out of this device — sign back in with the new one.
      </div>

      {localError && <div style={{color:'#D7263D',fontSize:'0.85rem',marginBottom:12}}>{localError}</div>}

      <div style={{marginBottom:16}}>
        <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>
          Current password *
        </label>
        <input type="password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}
          autoComplete="current-password" style={inputStyle} placeholder="Required to confirm any change" />
      </div>

      <div style={{borderTop:'1px solid var(--line)',paddingTop:16,marginBottom:16}}>
        <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>
          New username (optional)
        </label>
        <input type="text" value={newUsername} onChange={e=>setNewUsername(e.target.value)}
          autoComplete="username" style={inputStyle} placeholder={currentUsername} />
      </div>

      <div style={{borderTop:'1px solid var(--line)',paddingTop:16,marginBottom:20}}>
        <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>
          New password (optional)
        </label>
        <input type="password" value={newPassword} onChange={e=>setNewPassword(e.target.value)}
          autoComplete="new-password" style={{...inputStyle,marginBottom:10}} placeholder="At least 8 characters, one letter and one number" />
        <label style={{fontSize:'0.75rem',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)',display:'block',marginBottom:4}}>
          Confirm new password
        </label>
        <input type="password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}
          autoComplete="new-password" style={inputStyle} placeholder="Repeat the new password" />
      </div>

      <button onClick={save} disabled={saving}
        style={{...pill,background:'var(--brand)',color:'#fff',padding:'11px 26px',fontSize:'0.88rem'}}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  )
}
