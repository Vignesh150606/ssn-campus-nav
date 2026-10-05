# Fallback: serve the frontend from Cloudflare Pages

Purpose: if Vercel Hobby usage nears its monthly cap (edge requests / data
transfer, hard-capped, no overage), send **new** visitors to an identical
copy of the app on Cloudflare Pages. Static hosting only; the backend
(Render) and Supabase are unchanged.

## 0. Why act early

When a Hobby project passes its limit Vercel blocks it, and a blocked
project cannot serve a redirect either. So this is a "switch at ~70–80%",
not a "switch after it breaks" plan. Check **Vercel dashboard → Usage**
(Edge Requests and Fast Data Transfer) every few hours on event days.

Returning visitors who already have the PWA installed are mostly unaffected:
their navigations are answered by the service worker cache, and API calls go
to Render, not Vercel. A redirect only reaches people with no cached shell
(new visitors, QR scans on fresh phones) and the occasional `sw.js` check.
That check will hit the redirect, which a service-worker update cannot
follow, so those users simply stay on the version they already have.

## 1. One-time setup (do this BEFORE the event and test it)

### 1a. Create the Pages project

Option A — Git integration (recommended, stays in sync with pushes):
Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| `NODE_VERSION` (env) | `22` |
| `VITE_API_BASE` (env) | same value as on Vercel (your Render URL) |
| `VITE_SNAPSHOT_BASE_URL` (env, W2) | same value as on Vercel |

The build fails without `VITE_API_BASE` (vite.config.js guard), exactly like
on Vercel.

Option B — direct upload from your PC (PowerShell):

```powershell
cd frontend
$env:VITE_API_BASE = "https://YOUR-RENDER-URL.onrender.com"
$env:VITE_SNAPSHOT_BASE_URL = "https://YOUR-PROJECT.supabase.co/storage/v1/object/public/snapshots"
npm ci
npm run build
npx wrangler pages deploy dist --project-name ssn-campus-nav --branch main
```

Note your URL: `https://ssn-campus-nav.pages.dev` (name may differ).

### 1b. Headers file (mirrors vercel.json)

Cloudflare Pages ignores `vercel.json`. Create `frontend/public/_headers`
(it is copied into `dist/`; Vercel just serves it as an unused static file):

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/workbox-*
  Cache-Control: public, max-age=31536000, immutable
/sw.js
  Cache-Control: public, max-age=0, must-revalidate
/registerSW.js
  Cache-Control: public, max-age=0, must-revalidate
/index.html
  Cache-Control: public, max-age=0, must-revalidate
/manifest.webmanifest
  Cache-Control: public, max-age=86400
/icons/*
  Cache-Control: public, max-age=604800, stale-while-revalidate=86400
/ssn-logo.*
  Cache-Control: public, max-age=604800, stale-while-revalidate=86400
```

SPA deep links (`/location/:id`, `/event/:id`): Pages serves `index.html`
for unknown paths when the project has **no top-level `404.html`** (this app
has none). Do not add a `/* /index.html 200` rule. Verify after deploy (step 2).

### 1c. Allow the new origin on the backend (easy to forget)

The backend CORS allow-list is built from env vars (`backend/main.py`). On
Render, set:

```
ADDITIONAL_ALLOWED_ORIGINS=https://ssn-campus-nav.pages.dev
```

(comma-separate if you already have values there). Without this, the Pages
copy loads but every API call fails CORS. Do it now, not during the incident.

`FRONTEND_BASE_URL` (used to encode QR codes as `{FRONTEND_BASE_URL}/event/{id}`)
should stay on the Vercel URL: printed QR codes keep working through the
redirect in step 3.

## 2. Test the Pages copy

1. Open `https://<project>.pages.dev/`, then `/location/main-gate`,
   `/event/f1-4aae7d`, and refresh on each: all must load the app.
2. DevTools → Network: `/assets/*.js` responses show `immutable`;
   `/sw.js` shows `max-age=0, must-revalidate`.
3. DevTools → Console: no CORS errors on API calls.
4. `cd scripts; node measure-load.mjs https://<project>.pages.dev/` for
   cold/warm numbers.

The Pages origin is a different origin from Vercel: separate service worker,
IndexedDB and geolocation permission. Redirected users start cold there once.

## 3. The switch (when Vercel usage nears the limit)

Replace the contents of `frontend/vercel.json` with this and push:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "redirects": [
    { "source": "/(.*)", "destination": "https://ssn-campus-nav.pages.dev/$1", "permanent": false }
  ]
}
```

- `permanent: false` (307): browsers don't cache it, so you can undo it.
- Vercel runs redirects before serving files, so every path, including
  `/assets/*`, becomes one tiny redirect response instead of a file download.
- Keep a copy of the normal `vercel.json` (git history is enough:
  `git revert <commit>` undoes the switch).
- Query strings: confirm with
  `curl.exe -I "https://YOUR-APP.vercel.app/event/f1-4aae7d?x=1"` and look at
  the `location` header. URL fragments (`#...`) are preserved by browsers.
  If the query is dropped, tell me and I will add a `has`-based rule.
- Don't run the redirect build as a drive-by: the push triggers a normal
  Vercel build, which does not count against request/transfer limits but
  does need a minute or two.

Optional hard-copy fallback if redirects misbehave: deploy a one-file page
(`<script>location.replace("https://ssn-campus-nav.pages.dev"+location.pathname+location.search+location.hash)</script>`
plus a `<noscript>` link) as the Vercel build output instead.

## 4. Switching back

`git revert` the commit that replaced `vercel.json`, push, and wait for the
Vercel build. Usage counters reset at the start of the next billing cycle.

## 5. Limits worth knowing (checked against Cloudflare's Pages limits page)

- Free plan: 500 builds/month, 20 minute build timeout, 20,000 files per
  site, 25 MiB per file, `_headers` max 100 rules, `_redirects` max 2,100.
- "Unlimited bandwidth / unlimited static requests" is how Cloudflare Pages
  is widely described. I could confirm it from third-party summaries but not
  from the Cloudflare limits page itself, so check Cloudflare's pricing page
  before relying on it for a specific traffic number.
- Pages Functions (not used here) would count against the Workers quota.
