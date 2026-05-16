// ============================================================
// FILE: app/onboarding/welcome/page.js
// PURPOSE: Onboarding Step 1 – Welcome screen
// URL: /onboarding/welcome
// ============================================================

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function OnboardingWelcome() {
  const router = useRouter();

  // Check if user already completed onboarding
  useEffect(() => {
    const completed = localStorage.getItem("ascendai_onboarding_completed");
    if (completed === "true") {
      router.push("/dashboard");
    }
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-2xl w-full bg-white rounded-4px shadow-lg border border-hover overflow-hidden">
        {/* Progress bar – 20% (step 1 of 5) */}
        <div className="h-1 bg-hover">
          <div className="h-full w-1/5 bg-gold"></div>
        </div>

        <div className="p-8 md:p-10">
          {/* Step indicator */}
          <div className="text-gold text-xs font-semibold uppercase tracking-wider mb-2">
            Step 1 of 5
          </div>

          {/* Heading */}
          <h1 className="font-heading text-3xl md:text-4xl font-bold text-text-primary mb-3">
            Welcome to AscendAI
          </h1>

          {/* Subtitle with gold left border */}
          <p className="text-text-muted text-base mb-6 border-l-3 border-gold pl-3">
            Your intelligent Cambridge AS Level study companion
          </p>

          {/* Feature list */}
          <div className="space-y-3 text-text-primary">
            <p>✨ AI‑powered homework answers in Cambridge format</p>
            <p>📄 Automatic note summarisation from Google Classroom</p>
            <p>🃏 Adaptive flashcards with spaced repetition</p>
            <p>📅 Intelligent weekly timetable based on exam dates</p>
            <p>📖 Past paper solver with step‑by‑step explanations</p>
          </div>

          {/* Navigation button to step 2 */}
          <div className="mt-8 flex justify-end">
            <Link
              href="/onboarding/exam-dates"
              className="bg-gold text-white px-6 py-2 rounded-4px font-semibold hover:bg-gold/90 transition"
            >
              Get Started →
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}