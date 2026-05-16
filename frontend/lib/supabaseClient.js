// ============================================================
// FILE: lib/supabaseClient.js
// PURPOSE: Browser-side Supabase client using @supabase/ssr.
//
// WHY @supabase/ssr INSTEAD OF @supabase/supabase-js createClient?
// ----------------------------------------------------------------
// The standard createClient stores the session ONLY in localStorage.
// In Next.js App Router, server components and middleware cannot read
// localStorage – they rely on HTTP cookies. When window.location.href
// triggers a full page reload, the server renders the page before any
// client JavaScript runs, so getSession() returns null on the server.
//
// createBrowserClient from @supabase/ssr stores the session in BOTH
// cookies AND localStorage, and it syncs with the session cookies that
// the middleware writes on every request. This is what makes the session
// survive hard page reloads and server-side checks.
// ============================================================

import { createBrowserClient } from "@supabase/ssr";

// Read Supabase connection details from environment variables.
// These NEXT_PUBLIC_ vars are safe to expose to the browser.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Validate that env vars are present so we get a clear error during
// development if the .env.local file is misconfigured.
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "[AscendAI] Missing Supabase env vars. " +
      "Make sure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY " +
      "are set in your .env.local file."
  );
}

// createBrowserClient is safe to call multiple times – it returns a
// singleton, so importing this module from many components is fine.
// It automatically reads/writes the session to cookies so the middleware
// can refresh it on every request.
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);
