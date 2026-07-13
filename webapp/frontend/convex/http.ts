// HTTP actions mounted on CONVEX_SITE_URL (the *.convex.site origin).
//
// The Convex Auth routes handle Google OAuth. The four custom endpoints below
// are the server-to-server API used by the FastAPI backend; each one requires
// the shared secret in the `X-Admin-Secret` header.
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const http = httpRouter();

// Mount Convex Auth's OAuth/callback routes (/api/auth/*).
auth.addHttpRoutes(http);

/** Constant-time-ish check of the shared admin secret header. */
function authorized(request: Request): boolean {
  const provided = request.headers.get("X-Admin-Secret");
  const expected = process.env.ADMIN_SHARED_SECRET;
  return !!expected && provided === expected;
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// POST /generateUploadUrl -> { uploadUrl }
http.route({
  path: "/generateUploadUrl",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return unauthorized();
    const uploadUrl = await ctx.runMutation(
      internal.videos.internalGenerateUploadUrl,
      {},
    );
    return json({ uploadUrl });
  }),
});

// POST /fileUrl { storageId } -> { url }
http.route({
  path: "/fileUrl",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return unauthorized();
    const { storageId } = await request.json();
    const url = await ctx.runQuery(internal.videos.getFileUrl, {
      storageId: storageId as Id<"_storage">,
    });
    return json({ url });
  }),
});

// POST /getKeyMaterial { videoId } -> { contentKey, iv, keyVariant }  (apkId is global)
http.route({
  path: "/getKeyMaterial",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return unauthorized();
    const { videoId } = await request.json();
    const material = await ctx.runQuery(internal.videos.getKeyMaterial, {
      videoId: videoId as Id<"videos">,
    });
    return json(material);
  }),
});

// POST /getVideo { videoId } -> { status, iv, keyVariant, duration, renditions }
// Used by the backend's master/variant playlist endpoints. NEVER returns contentKey.
http.route({
  path: "/getVideo",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return unauthorized();
    const { videoId } = await request.json();
    const meta = await ctx.runQuery(internal.videos.getVideoMeta, {
      videoId: videoId as Id<"videos">,
    });
    return json(meta);
  }),
});

// POST /validateStreamToken { token, videoId } -> { ok, email?, expiresAt? }
// The backend calls this to validate the opaque t/<token> on every stream request.
http.route({
  path: "/validateStreamToken",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return unauthorized();
    const { token, videoId } = await request.json();
    const res = await ctx.runQuery(internal.videos.validateStreamToken, {
      token,
      videoId: videoId as Id<"videos">,
    });
    return json(res);
  }),
});

// POST /saveVideoResult { videoId, contentKey, iv, keyVariant,
//                         duration, renditions, status } -> { ok: true }
http.route({
  path: "/saveVideoResult",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return unauthorized();
    const body = await request.json();
    const result = await ctx.runMutation(internal.videos.saveVideoResult, {
      videoId: body.videoId as Id<"videos">,
      contentKey: body.contentKey,
      iv: body.iv,
      keyVariant: body.keyVariant,
      duration: body.duration,
      renditions: body.renditions,
      status: body.status,
    });
    return json(result);
  }),
});

export default http;
