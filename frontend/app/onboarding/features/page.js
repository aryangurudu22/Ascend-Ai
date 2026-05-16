// ============================================================
// FILE: app/onboarding/features/page.js
// PURPOSE: Onboarding Step 5 – Feature walkthrough and final step.
//          Sets the onboarding completion flag and navigates to /dashboard.
//
// KEY FIX IN THIS FILE
// ----------------------------------------------------------------
// The previous version used window.location.href = "/dashboard" for the
// final redirect. That triggers a FULL PAGE RELOAD (hard navigation):
//
//   window.location.href = "/dashboard"  ← BAD: hard reload, bypasses
//                                            Next.js router and causes
//                                            the session to be re-validated
//                                            from scratch mid-render.
//
// With the old localStorage-only session storage, this worked intermittently.
// With @supabase/ssr, the session is in cookies that the middleware refreshes
// on every request. A hard reload IS fine now, but we use router.push() for
// consistency with the rest of the app (it's faster – no full page reload).
//
//   router.push("/dashboard")  ← GOOD: client-side navigation, React keeps
//                                       running, session cookies are intact.
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

// Key used across all onboarding pages – must match exactly.
const ONBOARDING_KEY = "ascendai_onboarding_completed";

// Feature list shown in the card grid.
const features = [
  {
    name: "Homework Assistant",
    icon: "📝",
    description: "AI-powered model answers in Cambridge format.",
  },
  {
    name: "Note Summariser",
    icon: "📄",
    description: "Auto-summarise Google Classroom posts, PDFs, videos.",
  },
  {
    name: "Adaptive Flashcards",
    icon: "🃏",
    description: "Spaced repetition to master weak topics.",
  },
  {
    name: "Weekly Timetable",
    icon: "📅",
    description: "Intelligent schedule based on exam dates and performance.",
  },
  {
    name: "Past Paper Solver",
    icon: "📖",
    description: "Upload PDF, AI solves with mark scheme guidance.",
  },
];

export default function OnboardingFeatures() {
  const router = useRouter();

  // Tracks which feature card is expanded to show its description.
  const [selectedFeature, setSelectedFeature] = useState(null);

  // If the user already completed onboarding (e.g. they navigated back),
  // skip straight to the dashboard.
  useEffect(() => {
    const alreadyCompleted = localStorage.getItem(ONBOARDING_KEY) === "true";
    if (alreadyCompleted) {
      console.log(
        "[OnboardingFeatures] Onboarding already done – redirecting to /dashboard"
      );
      router.replace("/dashboard");
    }
  }, [router]);

  const completeOnboarding = () => {
    // Persist the completion flag so the dashboard (and all other onboarding
    // pages) know not to show the onboarding flow again on future visits.
    localStorage.setItem(ONBOARDING_KEY, "true");
    console.log(
      "[OnboardingFeatures] Flag set – navigating to /dashboard via router.push"
    );

    // Use router.push (client-side navigation) instead of window.location.href
    // (hard reload). Both work with the cookie-based session, but router.push
    // is faster and keeps the React tree alive.
    router.push("/dashboard");
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-3xl w-full bg-white rounded-4px shadow-lg border border-hover overflow-hidden">
        {/* Progress bar – 100% (final step) */}
        <div className="h-1 bg-hover">
          <div className="h-full w-full bg-gold"></div>
        </div>

        <div className="p-8 md:p-10">
          {/* Step indicator */}
          <div className="text-gold text-xs font-semibold uppercase tracking-wider mb-2">
            Step 5 of 5
          </div>

          <h1 className="font-heading text-3xl md:text-4xl font-bold text-text-primary mb-3">
            You're all set
          </h1>
          <p className="text-text-muted text-base mb-6 border-l-3 border-gold pl-3">
            Explore these powerful features
          </p>

          {/* Feature cards – click to expand description */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mt-4">
            {features.map((feature) => (
              <div
                key={feature.name}
                onClick={() =>
                  setSelectedFeature(
                    selectedFeature === feature.name ? null : feature.name
                  )
                }
                className="bg-background border border-hover rounded-4px p-4 text-center cursor-pointer transition-all hover:shadow-md hover:border-gold"
              >
                <div className="text-3xl mb-2">{feature.icon}</div>
                <div className="font-semibold text-text-primary">
                  {feature.name}
                </div>
                {/* Expand description on click */}
                {selectedFeature === feature.name && (
                  <div className="text-xs text-text-muted mt-2 pt-2 border-t border-hover">
                    {feature.description}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Navigation */}
          <div className="mt-8 flex justify-between">
            <Link
              href="/onboarding/connect-google"
              className="border border-gold text-gold px-6 py-2 rounded-4px font-semibold hover:bg-gold/10 transition"
            >
              ← Back
            </Link>
            <button
              onClick={completeOnboarding}
              className="bg-gold text-white px-6 py-2 rounded-4px font-semibold hover:bg-gold/90 transition"
            >
              Go to Dashboard →
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
