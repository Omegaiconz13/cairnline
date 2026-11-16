/**
 * Backend configuration.
 *
 * The Supabase anon key is a public client key: it ships in the pipnex-ai.com
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
