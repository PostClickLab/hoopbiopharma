import { createClient } from "@supabase/supabase-js";

// Public project URL + anon/publishable key — safe to ship in front-end
// code. Access control lives in Supabase's Row Level Security policies,
// not in keeping this key secret.
const SUPABASE_URL = "https://smgddndtchfctqpiequs.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtZ2RkbmR0Y2hmY3RxcGllcXVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyMjQyNDEsImV4cCI6MjEwMzgwMDI0MX0.YsKgAAekGbGA5jc1XHIAMHKKCgS1og4NETtBcS_ovlo";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
