# VideoHub — Convex backend

This directory is the Convex deployment for VideoHub: the database (the `videos`
table), file storage, Convex Auth (Google), and the server-to-server HTTP API
consumed by the FastAPI processing backend.

## Files

| File | Purpose |
| --- | --- |
| `schema.ts` | `authTables` + the `videos` table (see data model below). |
| `auth.config.ts` | OIDC issuer config (uses `SITE_URL`). |
| `auth.ts` | `convexAuth` with the Google provider. |
| `videos.ts` | Client queries/mutations/action + internal helpers. |
| `http.ts` | Convex Auth routes + the 4 admin-secret HTTP actions. |

## Environment variables (set in the Convex dashboard)

Set these under **Settings → Environment Variables** for the deployment:

| Name | Meaning |
| --- | --- |
| `ADMIN_EMAIL` | `shahdhruvil1310@gmail.com` — the only user allowed to upload. |
| `ADMIN_SHARED_SECRET` | Shared secret for the `X-Admin-Secret` server-to-server header. |
| `BACKEND_URL` | Public HTTPS origin of the FastAPI backend (Render). Used to build `masterUrl` and to POST `/process`. |
| `AUTH_GOOGLE_ID` | Google OAuth client id (Convex Auth). |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret. |
| `SITE_URL` | The app's public origin — the Convex Auth OIDC issuer / redirect base. |

Convex also auto-provides `CONVEX_SITE_URL` (the `*.convex.site` origin) that the
backend must be pointed at for the HTTP actions below.

## Auth / admin wiring

- Sign-in is Google-only via Convex Auth (`auth.ts`, mounted in `http.ts` through
  `auth.addHttpRoutes`).
- **Every** public query requires a signed-in user (`list`, `get`, `isAdmin`).
- Admin is `identity.email === process.env.ADMIN_EMAIL`. Only the admin can call
  `generateRawUploadUrl` and `createVideo`.
- `get` returns playback metadata (`apkId`, `iv`, `keyVariant`, `masterUrl`) but
  **never** the secret `contentKey`. The content key only leaves Convex through
  `/getKeyMaterial`, which is guarded by the `X-Admin-Secret` header.

## Client functions (called from Next.js)

- `api.videos.list` — `query()` → `[{_id,title,description,status,duration,createdAt}]`
- `api.videos.get` — `query({id})` → `{_id,title,description,status,apkId,iv,keyVariant,duration,masterUrl}`
- `api.videos.isAdmin` — `query()` → `boolean`
- `api.videos.generateRawUploadUrl` — `mutation()` → `uploadUrl` (admin)
- `api.videos.createVideo` — `action({rawStorageId,title,description})` → `{videoId}` (admin)

## HTTP actions (called by the FastAPI backend; require `X-Admin-Secret`)

Mounted on `CONVEX_SITE_URL`:

- `POST /generateUploadUrl` → `{uploadUrl}`
- `POST /fileUrl` `{storageId}` → `{url}`
- `POST /getKeyMaterial` `{videoId}` → `{apkId,contentKey,iv,keyVariant}`
- `POST /saveVideoResult` `{videoId,apkId,contentKey,iv,keyVariant,duration,renditions,status}` → `{ok:true}`

## Video lifecycle

1. Admin calls `generateRawUploadUrl`, uploads the raw file to Convex storage.
2. Admin calls `createVideo` → inserts a `processing` doc, resolves the raw URL,
   POSTs `BACKEND_URL/process` with `{videoId, rawUrl}` and the admin secret.
3. Backend encrypts/encodes, uploads segments (via `/generateUploadUrl` +
   `/fileUrl`), then `POST /saveVideoResult` flips the doc to `ready` (or `failed`).

## Data model (`videos`)

`title`, `description`, `status` (`processing|ready|failed`), `apkId` (64 hex,
public), `contentKey` (32 hex, **secret**), `iv` (32 hex), `keyVariant` (`""`),
`duration`, `renditions[]` (`{name,isAudio,groupId?,bandwidth,resolution?,codecs,
segments[{url,duration}]}`), `createdBy`, `createdAt`.

## Setup notes

Run from `frontend/`:

```bash
npm install convex @convex-dev/auth
npx convex dev        # or: npx @convex-dev/auth   to bootstrap auth keys
```

The auth bootstrap sets `JWT_PRIVATE_KEY` / `JWKS` / `SITE_URL` on the deployment.
`package.json` is owned by the frontend app owner — not created here.
