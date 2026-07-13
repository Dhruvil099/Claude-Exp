import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";

// Public routes that an unauthenticated visitor is allowed to reach.
// Everything else (home grid, video player, admin) requires being signed in.
const isSignInPage = createRouteMatcher(["/signin"]);
const isProtectedRoute = createRouteMatcher(["/", "/videos(.*)", "/admin(.*)"]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  const authed = await convexAuth.isAuthenticated();

  // Bounce authenticated users off the dedicated sign-in page (if used).
  if (isSignInPage(request) && authed) {
    return nextjsMiddlewareRedirect(request, "/");
  }

  // Gate protected app routes behind authentication. The home page itself
  // renders a sign-in button when signed out, so we only redirect the
  // deeper protected routes and leave "/" reachable.
  if (isProtectedRoute(request) && !isSignInPage(request) && !authed) {
    // "/" is allowed through so it can show the Google sign-in button;
    // /videos/* and /admin/* are redirected home to sign in first.
    if (request.nextUrl.pathname !== "/") {
      return nextjsMiddlewareRedirect(request, "/");
    }
  }
});

export const config = {
  // Run on all routes except Next.js internals and static assets.
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
