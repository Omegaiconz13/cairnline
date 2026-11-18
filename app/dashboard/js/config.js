/**
 * Backend configuration.
 *
 * The Supabase anon key is a public client key: it ships in the public
 * bundle and is designed to be readable by any browser. It grants only the
 * access that Postgres row-level security allows for an anonymous caller, so
 * reading it here is not a secret exposure.
 */
export const SUPABASE = {
  url: 'https://jwaplyyxkxfrhmbcycmc.supabase.co',
  projectRef: 'jwaplyyxkxfrhmbcycmc',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3YXBseXl4a3hmcmhtYmN5Y21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIwNzAxMzIsImV4cCI6MjA3NzY0NjEzMn0.nKbLDZ9voBs4iRPXnSFyRfHA8zLq-5UbWhkB50Oopgg',
  storageKey: 'sb-jwaplyyxkxfrhmbcycmc-auth-token',
};

/**
 * The product's public domain.
 *
 * Empty on purpose. No domain has been registered for this project, and a link to
 * a site we do not own is worse than no link — so while this is empty the UI shows
 * "not configured" instead of building a URL. Set it once a domain is bought, e.g.
 * `cairnline.ai` (checked unregistered on 2026-11-17, as were .io, .co and .app).
 */
export const BRAND_DOMAIN = '';

/** `support@<domain>`, or null while no domain is configured. */
export function supportEmail() {
  return BRAND_DOMAIN ? `support@${BRAND_DOMAIN}` : null;
}

/** `<domain><path>?ref=<id>`, or null while no domain is configured. */
export function referralUrl(path, accountId) {
  if (!BRAND_DOMAIN) return null;
  return `https://${BRAND_DOMAIN}${path}?ref=${encodeURIComponent(accountId)}`;
}
