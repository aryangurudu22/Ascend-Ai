// ============================================================
// FILE: app/auth/callback/complete/page.js
// PURPOSE: Finishes Google login after the server PKCE handler.
//
// FLOW
// ----------------------------------------------------------------
// 1. /auth/callback/route.js exchanges the OAuth ?code= for a
//    Supabase session (HTTP-only cookies).
// 2. This page loads, reads that session, and sends Google tokens
//    to POST /auth/save-google-tokens on the FastAPI backend.
// 3. We redirect to onboarding or the dashboard — never block login
//    if the token save fails (logged only).
//
// NOTE: Next.js cannot host route.js and page.js in the same folder,
// so this lives at /auth/callback/complete while PKCE stays in
// /auth/callback/route.js (same as Cursur_AscendAi.md).
// ============================================================

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { supabase } from "../../../../lib/supabaseClient";

// Backend base URL from public env (never hardcoded host).
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";

// Same onboarding flag every other page uses.
const ONBOARDING_KEY = "ascendai_onboarding_completed";

export default function AuthCallbackCompletePage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    const handleCallback = async () => {
      // STEP 1 — read the Supabase session the server route wrote.
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();

      if (cancelled) return;

      if (error || !session) {
        console.error("[AuthCallback] No session:", error);
        router.replace("/login");
        return;
      }

      // STEP 2 — extract Google tokens from the session object.
      // provider_token / provider_refresh_token are set by Supabase
      // when the Google OAuth flow includes the Classroom scopes.
      const googleAccessToken = session.provider_token;
      const googleRefreshToken = session.provider_refresh_token;
      const googleId =
        session.user?.user_metadata?.sub ??
        session.user?.user_metadata?.provider_id ??
        null;

      // STEP 3 — persist tokens on the backend profiles row.
      // Never block the student if this network call fails.
      if (googleAccessToken) {
        try {
          await fetch(`${API_URL}/auth/save-google-tokens`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              user_id: session.user.id,
              google_access_token: googleAccessToken,
              google_refresh_token: googleRefreshToken || null,
              google_id: googleId,
            }),
          });
          console.log("[AuthCallback] Google tokens saved");
        } catch (err) {
          console.error("[AuthCallback] Token save failed:", err);
        }
      } else {
        console.warn(
          "[AuthCallback] No provider_token on session — " +
            "check Google scopes in Supabase + login page."
        );
      }

      if (cancelled) return;

      // STEP 4 — route to onboarding or dashboard.
      const onboardingComplete =
        localStorage.getItem(ONBOARDING_KEY) === "true";

      if (onboardingComplete) {
        router.replace("/dashboard");
      } else {
        router.replace("/onboarding/welcome");
      }
    };

    handleCallback();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background px-4">
      <Loader2
        className="h-10 w-10 animate-spin text-gold"
        aria-hidden="true"
      />
      <p className="text-sm text-text-muted">
        Connecting your Google account...
      </p>
    </main>
  );
}
