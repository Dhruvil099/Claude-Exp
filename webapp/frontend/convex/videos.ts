// VideoHub Convex functions.
//
// Public client functions (called from the Next.js frontend):
//   list                    query   — auth required
//   get                     query   — auth required (NEVER returns contentKey)
//   isAdmin                 query
//   generateRawUploadUrl    mutation — admin only
//   createVideo             action  — admin only; kicks off backend processing
//
// Internal functions (called by http.ts / by the createVideo action):
//   insertProcessingVideo   internalMutation
//   internalGenerateUploadUrl  internalMutation
//   getFileUrl              internalQuery
//   getKeyMaterial          internalQuery
//   saveVideoResult         internalMutation
import { v } from "convex/values";
import {
  query,
  mutation,
  action,
  internalQuery,
  internalMutation,
  QueryCtx,
  MutationCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// ------------------------------------------------------------------ auth utils
// The Convex Auth session JWT carries only `sub` (no email), so identity/admin
// checks must read the user record (the Google provider stores .email there).

/** The signed-in user's doc (has .email), or null. Query/mutation ctx only. */
async function getUser(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  return userId ? await ctx.db.get(userId) : null;
}

/** Require a signed-in user; returns the user doc. */
async function requireUser(ctx: QueryCtx | MutationCtx) {
  const user = await getUser(ctx);
  if (!user) throw new Error("Not authenticated");
  return user;
}

/** Require the configured admin; returns the user doc. */
async function requireAdminUser(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  if (user.email !== process.env.ADMIN_EMAIL) throw new Error("Admin only");
  return user;
}

/** The signed-in user's email (for ACTIONS, via runQuery). null if signed out. */
export const currentUser = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ email: string } | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const u = await ctx.db.get(userId);
    return { email: u?.email ?? "" };
  },
});

/** Lowercase hex of raw bytes (matches Python bytes.hex() / hmac hexdigest()). */
function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** SHA-256 (hex) of an ASCII string. */
async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return toHex(new Uint8Array(digest));
}

// The renditions validator, reused by saveVideoResult.
const renditionsValidator = v.array(
  v.object({
    name: v.string(),
    isAudio: v.boolean(),
    groupId: v.optional(v.string()),
    bandwidth: v.number(),
    resolution: v.optional(v.string()),
    codecs: v.string(),
    segments: v.array(v.object({ url: v.string(), duration: v.number() })),
  }),
);

// ----------------------------------------------------------------- public API

/** List all videos for the video grid. Auth required. Never leaks secrets. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const videos = await ctx.db.query("videos").order("desc").collect();
    return videos.map((doc) => ({
      _id: doc._id,
      title: doc.title,
      description: doc.description,
      status: doc.status,
      duration: doc.duration,
      createdAt: doc.createdAt,
    }));
  },
});

/**
 * Fetch one video's display metadata. Auth required. NEVER returns secrets.
 * The tokenized master playlist URL comes from getStreamToken (below), not here.
 */
export const get = query({
  args: { id: v.id("videos") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const doc = await ctx.db.get(id);
    if (!doc) {
      throw new Error("Video not found");
    }
    return {
      _id: doc._id,
      title: doc.title,
      description: doc.description,
      status: doc.status,
      duration: doc.duration,
    };
  },
});

/**
 * Mint a per-user stream token and return the tokenized master playlist URL —
 * the Spayee /u/<token>/ access layer. Auth required. The token is HMAC-signed
 * with STREAM_TOKEN_SECRET (shared with the backend, which verifies it) and
 * binds {user email, videoId, expiry}. Action (needs Date.now + Web Crypto).
 */
export const getStreamToken = action({
  args: { videoId: v.id("videos") },
  handler: async (
    ctx,
    { videoId },
  ): Promise<{ masterUrl: string; watermark: string }> => {
    const me = await ctx.runQuery(internal.videos.currentUser, {});
    if (!me) throw new Error("Not authenticated");
    const backendUrl = process.env.BACKEND_URL;
    const orgId = process.env.ORG_ID ?? "000000000000000000000000";
    if (!backendUrl) {
      throw new Error("Missing BACKEND_URL");
    }

    const meta = await ctx.runQuery(internal.videos.getVideoMeta, { videoId });
    if (meta.status !== "ready") {
      throw new Error("Video is not ready");
    }

    // Opaque 32-hex token (16 random bytes) — byte-identical to Spayee's t/<token>.
    // Stored server-side; the backend validates it by lookup (no info in the value).
    const email = me.email;
    const token = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const expiresAt = Date.now() + 6 * 60 * 60 * 1000; // 6h TTL
    await ctx.runMutation(internal.videos.insertStreamToken, {
      token,
      email,
      videoId,
      expiresAt,
    });

    // uid: 24-hex derived from the email (Spayee's /u/<uid> is a 24-hex id).
    const uid = (await sha256Hex(email)).slice(0, 24);

    // date path segments from the video's createdAt (Spayee: .../videos/<org>/YYYY/MM/DD/<vid>/).
    const dt = new Date(meta.createdAt);
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const da = String(dt.getUTCDate()).padStart(2, "0");

    const masterUrl =
      `${backendUrl}/spees/w/o/${orgId}/v/${videoId}/u/${uid}/t/${token}` +
      `/p/assets/videos/${orgId}/${y}/${mo}/${da}/${videoId}/index.m3u8`;

    // Watermark: viewer email + short session tag (from the token); host is prepended in the browser.
    const watermark = `${email || "user"} · ${token.slice(0, 6)}`;
    return { masterUrl, watermark };
  },
});

/** Whether the signed-in user is the admin. Returns false when signed out. */
export const isAdmin = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUser(ctx);
    return !!user && user.email === process.env.ADMIN_EMAIL;
  },
});

/** Admin-only: mint a Convex storage upload URL for the raw source video. */
export const generateRawUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdminUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Admin-only: create a video record and hand it to the backend for processing.
 * Inserts a "processing" doc, resolves the raw storage id to a URL, then POSTs
 * BACKEND_URL/process with the X-Admin-Secret header (fire-and-forget).
 */
export const createVideo = action({
  args: {
    rawStorageId: v.id("_storage"),
    title: v.string(),
    description: v.string(),
  },
  handler: async (ctx, { rawStorageId, title, description }) => {
    const me = await ctx.runQuery(internal.videos.currentUser, {});
    if (!me || me.email !== process.env.ADMIN_EMAIL) {
      throw new Error("Admin only");
    }

    // Insert the placeholder doc first so we have a videoId for the callback.
    const videoId: Id<"videos"> = await ctx.runMutation(
      internal.videos.insertProcessingVideo,
      { title, description, createdBy: me.email },
    );

    // Resolve the uploaded raw file to a fetchable URL for the backend.
    const rawUrl = await ctx.storage.getUrl(rawStorageId);
    if (!rawUrl) {
      throw new Error("Raw upload not found in storage");
    }

    const backendUrl = process.env.BACKEND_URL;
    const adminSecret = process.env.ADMIN_SHARED_SECRET;
    if (!backendUrl || !adminSecret) {
      throw new Error("Missing BACKEND_URL or ADMIN_SHARED_SECRET");
    }

    // Fire-and-forget: backend returns 202 immediately and processes async,
    // then calls back into our http actions to save the result.
    await fetch(`${backendUrl}/process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Secret": adminSecret,
      },
      body: JSON.stringify({ videoId, rawUrl }),
    });

    return { videoId };
  },
});

/**
 * Real-DRM tier: mint a PallyCon license token via the backend (SCAFFOLD).
 * Auth required. The backend holds PALLYCON_ACCESS_KEY and generates the token;
 * we pass the browser-detected drmType. See DrmPlayer.tsx / DRM_SETUP.md.
 */
export const getDrmToken = action({
  args: { videoId: v.id("videos"), drmType: v.string() },
  handler: async (
    ctx,
    { videoId, drmType },
  ): Promise<{ token: string; licenseUrl: string; siteId: string; manifestUrl: string }> => {
    const me = await ctx.runQuery(internal.videos.currentUser, {});
    if (!me) throw new Error("Not authenticated");
    const backendUrl = process.env.BACKEND_URL;
    const adminSecret = process.env.ADMIN_SHARED_SECRET;
    if (!backendUrl || !adminSecret) {
      throw new Error("Missing BACKEND_URL or ADMIN_SHARED_SECRET");
    }
    const meta = await ctx.runQuery(internal.videos.getVideoMeta, { videoId });
    if (meta.status !== "ready") throw new Error("Video is not ready");

    const res = await fetch(`${backendUrl}/drm/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Secret": adminSecret },
      body: JSON.stringify({ videoId, userId: me.email, drmType }),
    });
    if (!res.ok) throw new Error(`drm/token failed: ${res.status}`);
    const t = await res.json();
    return {
      token: t.token,
      licenseUrl: t.licenseUrl,
      siteId: t.siteId,
      manifestUrl: meta.drmManifestUrl ?? "",
    };
  },
});

// --------------------------------------------------------------- internal API

/** Insert a fresh video doc in the "processing" state. Returns its id. */
export const insertProcessingVideo = internalMutation({
  args: {
    title: v.string(),
    description: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, { title, description, createdBy }) => {
    return await ctx.db.insert("videos", {
      title,
      description,
      status: "processing",
      contentKey: "",
      iv: "",
      keyVariant: "",
      duration: 0,
      renditions: [],
      createdBy,
      createdAt: Date.now(),
    });
  },
});

/** Mint a storage upload URL (used by the /generateUploadUrl http action). */
export const internalGenerateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

/** Resolve a storage id to a URL (used by the /fileUrl http action). */
export const getFileUrl = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    return await ctx.storage.getUrl(storageId);
  },
});

/** Return the secret key material for a video (used by /getKeyMaterial).
 *  apkId is NOT here — it is a global constant (env APK_ID) on the backend. */
export const getKeyMaterial = internalQuery({
  args: { videoId: v.id("videos") },
  handler: async (ctx, { videoId }) => {
    const doc = await ctx.db.get(videoId);
    if (!doc) {
      throw new Error("Video not found");
    }
    return {
      contentKey: doc.contentKey,
      iv: doc.iv,
      keyVariant: doc.keyVariant,
    };
  },
});

/**
 * Return a video's playlist metadata (used by the /getVideo http action).
 * Emits what the backend's playlist + segment-proxy endpoints need —
 * status, iv, keyVariant, duration, renditions — but DELIBERATELY omits the
 * secret contentKey (fetched via getKeyMaterial) and apkId (a global constant).
 */
export const getVideoMeta = internalQuery({
  args: { videoId: v.id("videos") },
  handler: async (ctx, { videoId }) => {
    const doc = await ctx.db.get(videoId);
    if (!doc) {
      throw new Error("Video not found");
    }
    return {
      status: doc.status,
      iv: doc.iv,
      keyVariant: doc.keyVariant,
      duration: doc.duration,
      renditions: doc.renditions,
      createdAt: doc.createdAt,
      drmManifestUrl: doc.drmManifestUrl,
    };
  },
});

/** Store a freshly minted opaque stream token (used by getStreamToken). */
export const insertStreamToken = internalMutation({
  args: {
    token: v.string(),
    email: v.string(),
    videoId: v.id("videos"),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("streamTokens", args);
  },
});

/** Validate an opaque stream token for a video (used by the /validateStreamToken action). */
export const validateStreamToken = internalQuery({
  args: { token: v.string(), videoId: v.id("videos") },
  handler: async (ctx, { token, videoId }) => {
    const row = await ctx.db
      .query("streamTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!row || row.videoId !== videoId || row.expiresAt < Date.now()) {
      return { ok: false as const };
    }
    return { ok: true as const, email: row.email, expiresAt: row.expiresAt };
  },
});

/** Patch a video with the backend's processing result (used by /saveVideoResult). */
export const saveVideoResult = internalMutation({
  args: {
    videoId: v.id("videos"),
    contentKey: v.string(),
    iv: v.string(),
    keyVariant: v.string(),
    duration: v.number(),
    renditions: renditionsValidator,
    status: v.union(
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, args) => {
    const { videoId, ...rest } = args;
    await ctx.db.patch(videoId, rest);
    return { ok: true as const };
  },
});
