const aliases = { bme: 'biomedical', biomedical: 'bme', cdc: 'career development', admin: 'administration', mess: 'canteen' }

// The same longest matching blocks used by Python's SequenceMatcher for
// these short venue labels (no autojunk threshold applies below 200 chars).
function similarity(a, b) {
  function matches(al, ar, bl, br) {
    let size = 0, ai = al, bi = bl
    for (let i = al; i < ar; i++) for (let j = bl; j < br; j++) {
      let k = 0
      while (i + k < ar && j + k < br && a[i + k] === b[j + k]) k++
      if (k > size) { size = k; ai = i; bi = j }
    }
    if (!size) return 0
    return size + matches(al, ai, bl, bi) + matches(ai + size, ar, bi + size, br)
  }
  return a.length + b.length ? 2 * matches(0, a.length, 0, b.length) / (a.length + b.length) : 1
}

export function searchCampusLocations(locations, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return []
  const patterns = [q.replace(/[,()]/g, ''), aliases[q]].filter(Boolean)
  if (!patterns.length) return []
  const fields = l => [l.name || '', l.department || '', l.category || ''].map(f => f.toLowerCase())
  const rank = l => {
    const [name, dept, cat] = fields(l)
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const word = s => new RegExp(`\\b${escaped}`).test(s)
    return name === q ? 0 : name.startsWith(q) ? 1 : word(name) ? 2 : name.includes(q) ? 3 : dept.startsWith(q) || word(dept) ? 4 : dept.includes(q) ? 5 : cat.includes(q) ? 6 : 7
  }
  const found = locations.filter(l => patterns.some(p => fields(l).some(f => f.includes(p))))
  if (found.length) return found.sort((a, b) => {
    const an = (a.name || '').toLowerCase(), bn = (b.name || '').toLowerCase()
    return rank(a) - rank(b) || (an > bn ? 1 : an < bn ? -1 : 0)
  })
  if (q.length < 3) return []
  return locations.map(l => ({ l, score: Math.max(...fields(l).flatMap(f => [f, ...f.split(/\s+/)].filter(Boolean).map(f => similarity(q, f)))) }))
    .filter(x => x.score >= 0.7).sort((a, b) => b.score - a.score).slice(0, 8).map(x => x.l)
}
