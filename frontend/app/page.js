// ============================================================
// FILE: app/page.js  (root route – rendered at "/")
// PURPOSE: Acts as the entry-point redirect for the application.
//
// The middleware already handles the two main cases server-side:
//   - Authenticated user   → redirected to /dashboard
//   - Unauthenticated user → redirected to /login
// ...so this page should almost never be seen. It exists as a
// client-side fallback for cases where the middleware redirect is
// delayed or the user navigates directly in a way that bypasses it.
// ============================================================

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabaseClient";

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    const redirectUser = async () => {
      console.log("[Root] Checking session for root redirect...");

      // getUser() validates the cookie-based session server-side.
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        // Authenticated – go to dashboard (dashboard will check onboarding).
        console.log("[Root] Authenticated – redirecting to /dashboard");
        router.replace("/dashboard");
      } else {
        // Not authenticated – go to login.
        console.log("[Root] Not authenticated – redirecting to /login");
        router.replace("/login");
      }
    };

    redirectUser();
  }, [router]);

  // Minimal loading state while the check runs. The middleware should have
  // already redirected before this renders, so this is rarely visible.
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-gold font-medium">Loading...</div>
    </div>
  );
}
