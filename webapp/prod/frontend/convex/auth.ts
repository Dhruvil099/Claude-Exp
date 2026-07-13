// Convex Auth setup: Google + Anonymous ("guest").
// AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are read from the Convex dashboard env.
// The Google provider comes from @auth/core (a @convex-dev/auth dependency).
// Anonymous lets a visitor in with NO email/password (creates a user with no
// email) — so guests can watch, but never pass the admin check (email !== ADMIN_EMAIL).
import Google from "@auth/core/providers/google";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google, Anonymous],
});
