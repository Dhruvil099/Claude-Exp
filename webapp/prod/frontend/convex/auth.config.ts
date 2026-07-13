// Convex Auth OIDC provider config.
// The token issuer is the deployment's HTTP Actions origin (CONVEX_SITE_URL, a
// built-in Convex env var = https://<deployment>.convex.site) — NOT the frontend
// SITE_URL. `domain` must match the `iss` of the session JWTs Convex Auth mints.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
