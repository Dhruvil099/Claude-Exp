// Convex Auth setup with Google as the only provider.
// AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are read from the Convex dashboard env.
// The Google provider comes from @auth/core (a @convex-dev/auth dependency),
// NOT from @convex-dev/auth/providers (which only has Anonymous/Email/Credentials).
import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google],
});
