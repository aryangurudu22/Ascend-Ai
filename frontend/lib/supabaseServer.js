// ============================================================
// FILE: lib/supabaseServer.js
// PURPOSE: Server-side Supabase client for Route Handlers and
//          Server Components (middleware uses its own inline client).
//
// WHY A SEPARATE SERVER CLIENT?
// ----------------------------------------------------------------
// Server Components and Route Handlers run on Node.js, not in the
// browser, so they cannot access localStorage. Instead they read and
// write the session via HTTP cookies using next/headers.
//
// This function creates a new client per request because each request
// carries its own cookie jar – sharing a singleton would leak sessions
// across requests.
// ============================================================

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Read the same env vars as the browser client.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * createSupabaseServerClient
 *
 * Returns an authenticated Supabase client that can read and write
 * session cookies on the current server request/response cycle.
 *
 * Usage:
 *   const supabase = await createSupabaseServerClient();
 *   const { data: { user } } = await supabase.auth.getUser();
 */
export async function createSupabaseServerClient() {
  // cookies() from next/headers gives us access to the request's
  // cookie store. We await it because Next.js 15+ made it async.
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      // getAll: called by Supabase to read the current session token
      // from the incoming request cookies.
      getAll() {
        return cookieStore.getAll();
      },

      // setAll: called by Supabase to write refreshed session tokens
      // back to the response cookies. Wrapped in try/catch because
      // Server Components cannot set cookies (only Route Handlers can).
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Silently ignore – this is expected when called from a
          // Server Component where cookies are read-only. The middleware
          // is responsible for refreshing the session on those requests.
        }
      },
    },
  });
}
