// ============================================================
// FILE: app/login/page.js
// PURPOSE: Login page – initiates Google OAuth using the PKCE flow.
//
// WHAT CHANGED AND WHY
// ----------------------------------------------------------------
// Previously, redirectTo pointed to /onboarding/welcome. The browser
// client then tried to exchange the OAuth code client-side using
// detectSessionInUrl. This was unreliable:
//   - The code exchange is async; if the page re-rendered before it
//     finished, the code was consumed but the session wasn't saved.
//   - The session ended up only in localStorage, invisible to the
//     middleware and server components.
//
// Now, redirectTo points to /auth/callback – a server-side Route
// Handler that exchanges the code immediately and writes the session
// into secure HTTP-only cookies that both the browser client and
// middleware can read.
//
// The middleware handles redirecting authenticated users away from
// this page (to /dashboard), so the useEffect below is a client-side
// safety-net only.
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";

export default function LoginPage() {
  // Track button loading state so the user knows the OAuth redirect
  // is in progress (the button greys out / text changes).
  const [loading, setLoading] = useState(false);

  // Store any error message to display below the button.
  const [error, setError] = useState(null);

  // Extract an error message from the URL if the auth callback
  // redirected back to /login?error=... (e.g. user cancelled OAuth).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlError = params.get("error");
    if (urlError === "auth_cancelled") {
      setError("Sign-in was cancelled. Please try again.");
    } else if (urlError === "auth_failed") {
      const msg = params.get("message") ?? "Authentication failed.";
      setError(msg);
    }
  }, []);

  const router = useRouter();

  // Client-side safety-net: if the user somehow lands on /login while
  // already authenticated (e.g. they navigate back after login), redirect
  // them to the dashboard. The middleware normally handles this server-side
  // before the page renders, but this covers edge cases.
  useEffect(() => {
    const checkExistingSession = async () => {
      console.log("[Login] Checking for existing session...");
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        console.log("[Login] Already authenticated, redirecting to /dashboard");
        router.replace("/dashboard");
      }
    };
    checkExistingSession();
  }, [router]);

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError(null);

    try {
      // Build the callback URL dynamically from the current origin so
      // this works in both localhost development and production without
      // hardcoding any URLs.
      const callbackUrl = `${window.location.origin}/auth/callback`;

      console.log(`[Login] Starting OAuth flow – callback URL: ${callbackUrl}`);

      // Google OAuth scopes — space-separated list passed to Google.
      // Each scope unlocks one slice of Aisha's school Google account.
      const googleScopes = [
        // email — basic account email for Supabase profile rows.
        "email",
        // profile — display name and avatar for the UI header.
        "profile",
        // classroom.courses.readonly — read list of courses she is enrolled in.
        "https://www.googleapis.com/auth/classroom.courses.readonly",
        // classroom.coursework.me.readonly — read assignments posted to her.
        "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
        // classroom.announcements.readonly — read teacher announcement posts.
        "https://www.googleapis.com/auth/classroom.announcements.readonly",
        // drive.readonly — read Drive files teachers attach to posts.
        "https://www.googleapis.com/auth/drive.readonly",
        // youtube.readonly — read YouTube metadata when teachers share videos.
        "https://www.googleapis.com/auth/youtube.readonly",
      ].join(" ");

      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          // The browser will be redirected here after Google authenticates the user.
          // /auth/callback (a server Route Handler) will exchange the code for a session.
          redirectTo: callbackUrl,

          // scopes — ask Google for Classroom + Drive + YouTube access up front.
          scopes: googleScopes,

          // Request offline access so Supabase receives a refresh token.
          // access_type: offline — gets refresh token so we can access Classroom
          // even when she is not logged in (backend refresh flow).
          // prompt: consent — forces Google to show the permission screen and
          // issue a new refresh token every time she reconnects.
          queryParams: {
            access_type: "offline",
            prompt: "consent",
          },
        },
      });

      if (oauthError) {
        // The OAuth redirect itself failed (e.g. misconfigured provider).
        throw oauthError;
      }

      // If we reach this point, the browser is being redirected to Google.
      // The try block won't continue; the page will unload. setLoading(false)
      // is not needed here but we leave it in case the redirect is delayed.
    } catch (err) {
      console.error("[Login] OAuth error:", err.message);
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-6xl w-full flex flex-wrap bg-white rounded-4px shadow-lg border border-hover overflow-hidden">
        {/* ── Left panel: branding + sign-in button ── */}
        <div className="flex-1 p-8 md:p-12">
          {/* Subject badge */}
          <div className="inline-block bg-gold text-white text-xs font-semibold px-3 py-1 rounded-full uppercase tracking-wide mb-6">
            Cambridge AS Level
          </div>

          {/* App title */}
          <h1 className="font-heading text-5xl md:text-6xl font-bold text-text-primary mb-1">
            Ascend<span className="text-gold">AI</span>
          </h1>
          <div className="text-gold text-xs uppercase tracking-wider mb-2">
            by Shivora
          </div>
          <p className="text-text-muted text-sm mb-6">
            Intelligent study assistant for top grades.
            <br />
            Built for Economics, Business, English & ICT.
          </p>

          {/* Error message (from URL params or OAuth failure) */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-4px text-red-700 text-sm">
              {error}
            </div>
          )}

          {/* Google sign-in button */}
          <button
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 bg-white border border-hover rounded-4px py-3 px-4 font-medium text-text-primary hover:border-gold hover:bg-hover transition-all disabled:opacity-50"
          >
            {/* Google "G" logo SVG */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            {loading ? "Redirecting to Google..." : "Sign in with Google"}
          </button>

          <div className="relative text-center text-xs text-text-hint my-4">
            <span className="px-2 bg-white">Secure & private</span>
          </div>
          <div className="text-center text-xs text-text-hint">
            Premium Cambridge-focused AI study assistant
          </div>
        </div>

        {/* ── Right panel: feature list ── */}
        <div className="flex-0.8 bg-background p-8 md:p-12 relative">
          {/* Decorative vertical separator */}
          <div className="hidden md:block absolute left-0 top-1/4 h-1/2 w-px bg-gradient-to-b from-transparent via-gold/50 to-transparent"></div>

          <h3 className="font-heading text-2xl font-semibold text-text-primary mb-6">
            Everything you need
          </h3>

          <ul className="space-y-4">
            <li className="flex items-center gap-3 text-text-primary font-medium">
              <span className="w-9 h-9 bg-white rounded-4px border border-hover flex items-center justify-center text-gold">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
              </span>
              Homework Assistant
            </li>
            <li className="flex items-center gap-3 text-text-primary font-medium">
              <span className="w-9 h-9 bg-white rounded-4px border border-hover flex items-center justify-center text-gold">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
              </span>
              Note Summariser
            </li>
            <li className="flex items-center gap-3 text-text-primary font-medium">
              <span className="w-9 h-9 bg-white rounded-4px border border-hover flex items-center justify-center text-gold">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
              </span>
              Adaptive Flashcards
            </li>
            <li className="flex items-center gap-3 text-text-primary font-medium">
              <span className="w-9 h-9 bg-white rounded-4px border border-hover flex items-center justify-center text-gold">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                  <line x1="16" y1="2" x2="16" y2="6"/>
                  <line x1="8" y1="2" x2="8" y2="6"/>
                  <line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
              </span>
              Weekly Timetable
            </li>
            <li className="flex items-center gap-3 text-text-primary font-medium">
              <span className="w-9 h-9 bg-white rounded-4px border border-hover flex items-center justify-center text-gold">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="8" y1="13" x2="16" y2="13"/>
                  <line x1="8" y1="17" x2="16" y2="17"/>
                </svg>
              </span>
              Past Paper Solver
            </li>
          </ul>

          <div className="mt-6 pt-4 border-t border-dotted border-hover text-center text-xs text-text-muted">
            <span className="font-semibold text-gold">Economics 9708</span> •{" "}
            <span className="font-semibold text-gold">Business 9609</span> •{" "}
            <span className="font-semibold text-gold">English 9093</span> •{" "}
            <span className="font-semibold text-gold">ICT 9626</span>
          </div>
        </div>
      </div>
    </main>
  );
}
