# Convex dashboard environment variables

Set these in the **Convex dashboard → Settings → Environment Variables** for your deployment
(they are also read locally by `npx convex dev`). Names are fixed — do not rename.

| Variable              | Example / value                                   | Purpose |
|-----------------------|---------------------------------------------------|---------|
| `ADMIN_EMAIL`         | `shahdhruvil1310@gmail.com`                        | The only email allowed to upload. `api.videos.isAdmin` and the admin-only functions compare `identity.email` against this. |
| `ADMIN_SHARED_SECRET` | *(random high-entropy string)*                    | Server-to-server secret. MUST equal the backend's `ADMIN_SHARED_SECRET`. Checked on the `X-Admin-Secret` header of the HTTP actions; sent as `X-Admin-Secret` when Convex `createVideo` POSTs `{BACKEND_URL}/process`. |
| `BACKEND_URL`         | `https://videohub-backend.onrender.com`           | Public https URL of the FastAPI backend. `createVideo` POSTs `{BACKEND_URL}/process`. Same value as frontend `NEXT_PUBLIC_BACKEND_URL` and backend `PUBLIC_BACKEND_URL`. Local dev: `http://localhost:8000`. |
| `AUTH_GOOGLE_ID`      | `xxxxx.apps.googleusercontent.com`                | Google OAuth client ID for the Convex Auth Google provider. |
| `AUTH_GOOGLE_SECRET`  | *(Google OAuth client secret)*                    | Google OAuth client secret for the Convex Auth Google provider. |
| `SITE_URL`            | `http://localhost:3000` / your Vercel URL         | The frontend's public origin; Convex Auth redirect base. |
| `ORG_ID`              | `60e975430cf20278db21ff30` (24 hex)               | Org id used in the Spayee-style stream path `/spees/w/o/<ORG_ID>/…`. Cosmetic (auth is the token); any 24-hex value. |

> Stream tokens are now **opaque 32-hex** values stored in the `streamTokens` table and
> validated by the backend via the `X-Admin-Secret`-gated `/validateStreamToken` action —
> so there is no separate stream-token secret to configure.

## Notes

- **`ADMIN_SHARED_SECRET` must be identical** here and in the backend's env. It is the only thing
  authorizing the backend↔Convex HTTP actions (`/generateUploadUrl`, `/fileUrl`, `/getKeyMaterial`,
  `/saveVideoResult`) and Convex→backend `/process`.
- **Google OAuth redirect URI** (add in Google Cloud Console → Credentials → your OAuth client):
  - `https://<your-deployment>.convex.site/api/auth/callback/google`
- **`SITE_URL`** is where Convex Auth returns the user after sign-in — set it to the frontend origin
  you are actually using (`http://localhost:3000` locally, the Vercel domain in production).
- **`.convex.site` vs `.convex.cloud`:** the backend's `CONVEX_SITE_URL` and the Google redirect URI
  use the `*.convex.site` (HTTP-actions) origin; the frontend's `NEXT_PUBLIC_CONVEX_URL` uses the
  `*.convex.cloud` origin.

## Quick set via CLI (optional)

```bash
cd frontend
npx convex env set ADMIN_EMAIL shahdhruvil1310@gmail.com
npx convex env set ADMIN_SHARED_SECRET "<random-secret>"
npx convex env set BACKEND_URL "https://videohub-backend.onrender.com"
npx convex env set AUTH_GOOGLE_ID "<client-id>.apps.googleusercontent.com"
npx convex env set AUTH_GOOGLE_SECRET "<client-secret>"
npx convex env set SITE_URL "http://localhost:3000"
npx convex env set ORG_ID "60e975430cf20278db21ff30"
```

## Global apkId (frontend + backend, NOT Convex)

`apkId` is a single global constant shared by the **backend** (`APK_ID`) and the
**frontend** (`NEXT_PUBLIC_APK_ID`) — Convex does not need it. Generate one:

```bash
python3 -c "import secrets;s=secrets.token_bytes(16).hex();print(s[:16]+secrets.token_bytes(16).hex()+s[16:])"
```

Put the same 64-hex value in the backend's `APK_ID` and the frontend's `NEXT_PUBLIC_APK_ID`.
