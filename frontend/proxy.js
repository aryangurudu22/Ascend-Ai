// ============================================================
// FILE: proxy.js  (must live at the project root, beside package.json)
// PURPOSE: Runs on EVERY request before it reaches a page or route
//          handler. Responsible for two things:
//
//   1. SESSION REFRESH – reads the Supabase session from the incoming
//      request cookies, calls getUser() which refreshes the access
//      token if it has expired, then writes the updated tokens back
//      into the response cookies. Without this step, the session expires
//      silently and the user gets logged out.
//
//   2. ROUTE PROTECTION – redirects unauthenticated users away from
//      protected pages (/dashboard, /onboarding/*) to /login, and
//      redirects already-authenticated users away from /login to /dashboard
//      so they don't end up on the login page by mistake.
//
// NOTE: In Next.js 16+, this file is named proxy.js (the old middleware.js
// convention was deprecated). The function must be named "proxy", not
// "middleware". Everything else (config, matcher, NextResponse API) is
// identical to the old middleware convention.
//
// WHY A PROXY AND NOT JUST CLIENT-SIDE useEffect?
// ----------------------------------------------------------------
// useEffect runs AFTER the page renders in the browser. Between the
// first render and the effect, the protected content is briefly visible.
// The proxy runs on the server BEFORE any HTML is sent to the browser,
// so the redirect is instantaneous and the protected page never renders.
//
// IMPORTANT: Always call supabase.auth.getUser() (not getSession()) in
// this file. getUser() makes a round-trip to Supabase to validate the
// token, which is required for the cookie refresh to work correctly.
// getSession() only reads from cookies without validating or refreshing.
// ============================================================

import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

export async function proxy(request) {
  // Start with a pass-through response; we may replace it with a
  // redirect below, but we must construct it first so that the
  // Supabase cookie-setter can write to it.
  let supabaseResponse = NextResponse.next({ request });

  // Build a lightweight Supabase server client that reads cookies from
  // the incoming request and writes refreshed tokens to supabaseResponse.
  // We inline this here (rather than using lib/supabaseServer.js) because
  // the proxy requires a special cookie-handling pattern that mutates
  // the response object.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        // Read all cookies from the incoming request
        getAll() {
          return request.cookies.getAll();
        },

        // Write refreshed session tokens to BOTH the request object
        // (so downstream code sees them) and the response object
        // (so the browser receives and stores the updated cookies).
        setAll(cookiesToSet) {
          // First update the request so subsequent getAll() calls are fresh
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );

          // Rebuild the response with the mutated request so it inherits
          // any headers the caller set before us
          supabaseResponse = NextResponse.next({ request });

          // Write each refreshed cookie to the response
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // ── CRITICAL: Do NOT add any logic between createServerClient and
  // supabase.auth.getUser(). The SDK's token-refresh side-effects happen
  // inside getUser(), so anything in between could read a stale session. ──

  // Validate the session token with Supabase's servers and get the user.
  // Returns null user if no session exists or the token is invalid.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  console.log(
    `[Proxy] ${request.nextUrl.pathname} | user: ${user?.email ?? "none"}`
  );

  const { pathname } = request.nextUrl;

  // ── PROTECTED ROUTES ─────────────────────────────────────────────────
  // If the user is not authenticated and tries to access a protected page,
  // redirect them to /login.
  // All authenticated-only sections of the app. Feature pages
  // (/features/homework, /features/notes, ...) also need this guard
  // because they are linked from the dashboard's feature grid.
  const isProtectedRoute =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/onboarding") ||
    pathname.startsWith("/features");

  if (isProtectedRoute && !user) {
    console.log(
      `[Proxy] Unauthenticated access to ${pathname} – redirecting to /login`
    );
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    // Preserve the intended destination so we can redirect back after login (future feature)
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // ── AUTH PAGES ────────────────────────────────────────────────────────
  // If the user IS authenticated and visits /login or the root (/),
  // send them straight to /dashboard. The dashboard page will then
  // check the onboarding completion flag and redirect to /onboarding
  // if needed.
  const isAuthPage = pathname === "/login" || pathname === "/";

  if (isAuthPage && user) {
    console.log(
      `[Proxy] Authenticated user on ${pathname} – redirecting to /dashboard`
    );
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/dashboard";
    return NextResponse.redirect(dashboardUrl);
  }

  // ── PASS THROUGH ─────────────────────────────────────────────────────
  // Return supabaseResponse (NOT a plain NextResponse.next()) so that
  // the refreshed session cookies we wrote above are sent to the browser.
  return supabaseResponse;
}

// ── MATCHER ────────────────────────────────────────────────────────────
// Run the proxy on all routes EXCEPT Next.js internals and static assets.
// Without this, it would fire on every image/font/etc. request and
// massively slow down the app.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
