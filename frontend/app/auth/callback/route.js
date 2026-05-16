// ============================================================
// FILE: app/auth/callback/route.js
// PURPOSE: Server-side OAuth callback handler for the PKCE auth flow.
//
// THE PKCE FLOW EXPLAINED
// ----------------------------------------------------------------
// When the user clicks "Sign in with Google", the Supabase client:
//   1. Generates a random "code verifier" and stores it in a cookie.
//   2. Derives a "code challenge" from it (SHA-256 hash).
//   3. Redirects the browser to Google with the code challenge.
//
// After Google authenticates the user, it redirects back to THIS route
// with a short-lived ?code=... query parameter. We then:
//   4. Exchange the code + stored code verifier for a real access/refresh token.
//   5. Write the session tokens into HTTP-only cookies.
//   6. Redirect the user to their intended destination.
//
// WHY DO WE NEED THIS ROUTE?
// ----------------------------------------------------------------
// The old approach pointed redirectTo at /onboarding/welcome and
// relied on detectSessionInUrl in the browser client to exchange the
// code. That is unreliable in App Router because:
//   - The server renders the page before any client JS runs.
//   - The code can only be exchanged once; a race condition or page
//     reload after the redirect consumes or loses the code.
//   - The resulting session is only in localStorage, not in cookies,
//     so the middleware never sees it and refreshes it incorrectly.
//
// This route handler runs on the SERVER, exchanges the code
// immediately (no race condition), and writes session cookies that
// the middleware can refresh on every subsequent request.
// ============================================================

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(request) {
  // Parse the callback URL to extract the auth code and any
  // custom "next" parameter we may have appended in the future.
  const { searchParams, origin } = new URL(request.url);

  // ?code is the one-time authorization code Google returned after OAuth.
  const code = searchParams.get("code");

  // Optional: a "next" param can specify where to land after login.
  // Defaults to /onboarding/welcome; the welcome page redirects to
  // /dashboard if onboarding is already complete.
  // After PKCE exchange we land on the client page that saves Google
  // tokens to the backend, then routes to onboarding or dashboard.
  const next = searchParams.get("next") ?? "/auth/callback/complete";

  console.log(`[AuthCallback] Received code: ${code ? "yes" : "no"}, next: ${next}`);

  if (code) {
    // Get the request's cookie store so we can read the code verifier
    // (stored by Supabase during signInWithOAuth) and write the session
    // tokens after a successful exchange.
    const cookieStore = await cookies();

    // Build a server-side Supabase client that reads/writes cookies
    // for this specific request.
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        cookies: {
          // Read all cookies to find the PKCE code verifier
          getAll() {
            return cookieStore.getAll();
          },
          // Write the session tokens returned by Supabase into cookies
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              console.log(`[AuthCallback] Setting cookie: ${name}`);
              cookieStore.set(name, value, options);
            });
          },
        },
      }
    );

    // Exchange the one-time code for a real session.
    // This makes an API call to Supabase and writes the access_token,
    // refresh_token, and expiry into the response cookies.
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      // Log the error for debugging; show a friendly error page.
      console.error("[AuthCallback] Code exchange failed:", error.message);
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&message=${encodeURIComponent(error.message)}`
      );
    }

    console.log(`[AuthCallback] Session established – redirecting to ${next}`);

    // Exchange succeeded. Redirect the user to the intended destination.
    // The session cookies have already been set by setAll above, so the
    // middleware will pick them up on the next request and keep them fresh.
    return NextResponse.redirect(`${origin}${next}`);
  }

  // If we reach here, there was no ?code parameter – something went wrong
  // with the OAuth flow (e.g. user denied permission, CSRF mismatch).
  console.warn("[AuthCallback] No code parameter in callback URL.");
  return NextResponse.redirect(`${origin}/login?error=auth_cancelled`);
}
