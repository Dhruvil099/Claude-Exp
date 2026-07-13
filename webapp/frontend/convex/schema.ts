// Convex schema for VideoHub.
// Includes the Convex Auth tables (users/sessions/etc.) plus the `videos` table.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// A single encrypted segment: a Convex storage URL + its duration in seconds.
const segment = v.object({
  url: v.string(), // absolute Convex storage URL for the encrypted .ts segment
  duration: v.number(),
});

// One rendition (video variant or the audio-only group).
const rendition = v.object({
  name: v.string(), // "hls_1M_" | "hls_500k_" | "hls_audio_"
  isAudio: v.boolean(),
  groupId: v.optional(v.string()), // "audio-0" for the audio rendition
  bandwidth: v.number(),
  resolution: v.optional(v.string()),
  codecs: v.string(),
  segments: v.array(segment),
});

export default defineSchema({
  // Convex Auth tables (users, authSessions, authAccounts, ...).
  ...authTables,

  // Per-user stream tokens (Spayee's opaque t/<32-hex>). The 16-byte random token
  // is the lookup key; the backend validates it via the /validateStreamToken action.
  streamTokens: defineTable({
    token: v.string(), // 32 hex (16 random bytes)
    email: v.string(),
    videoId: v.id("videos"),
    expiresAt: v.number(), // unix ms
  }).index("by_token", ["token"]),

  videos: defineTable({
    title: v.string(),
    description: v.string(),
    // Lifecycle status. Backend flips "processing" -> "ready" | "failed".
    status: v.union(
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    // apkId is a single GLOBAL constant (env APK_ID / NEXT_PUBLIC_APK_ID), not per-video.
    contentKey: v.string(), // 32 hex, SECRET — never returned by a public query
    iv: v.string(), // 32 hex
    keyVariant: v.string(), // "" (default)
    duration: v.number(),
    renditions: v.array(rendition),
    createdBy: v.string(), // creator email
    createdAt: v.number(),
    // Real-DRM tier (Widevine/PlayReady/FairPlay). When true, the player uses
    // DrmPlayer + getDrmToken instead of the AES-128 tier. See DRM_SETUP.md.
    drmEnabled: v.optional(v.boolean()),
    drmManifestUrl: v.optional(v.string()), // DASH .mpd / HLS-fMP4 master
  }),
});
