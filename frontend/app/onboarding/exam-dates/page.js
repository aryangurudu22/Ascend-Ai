// ============================================================
// FILE: app/onboarding/exam-dates/page.js
// PURPOSE: Onboarding Step 2 – User enters one exam date per subject.
// URL: /onboarding/exam-dates
//
// CHANGE LOG
// ----------------------------------------------------------------
// Previously the four subject names were hardcoded as state keys
// ("Economics", "Business", ...). They now come from lib/subjects.js
// (the single source of truth that mirrors the Supabase subjects table),
// satisfying the project rule "no hardcoding of subjects in components".
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SUBJECTS } from "../../../lib/subjects";
import { supabase } from "../../../lib/supabaseClient";

// localStorage keys used for persistence across onboarding steps.
const ONBOARDING_DATA_KEY = "ascendai_onboarding_data";
const ONBOARDING_COMPLETED_KEY = "ascendai_onboarding_completed";

// Backend base URL. Same fallback the other onboarding +
// feature pages use — keeps localhost dev working when the env
// var hasn't been set.
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

// Build the initial date map from the shared subjects list.
// Result shape: { economics: "", business: "", english: "", ict: "" }
const buildInitialDates = () =>
  SUBJECTS.reduce((acc, subject) => {
    acc[subject.key] = "";
    return acc;
  }, {});

export default function OnboardingExamDates() {
  const router = useRouter();

  // Date-per-subject state, keyed by subject.key (lowercase).
  const [examDates, setExamDates] = useState(buildInitialDates);

  // Disables the Next button while POST /onboarding/exam-dates
  // is in flight. Same UX reasoning as the Study Hours page —
  // stops accidental double-clicks AND gives clear visual
  // feedback that the save is running in the background.
  const [isSaving, setIsSaving] = useState(false);

  // ── Load previously saved dates from localStorage (if any) ───
  // Handles both the new shape (keyed by lowercase) and any legacy
  // shape from earlier builds (keyed by display name like "Economics").
  useEffect(() => {
    const stored = localStorage.getItem(ONBOARDING_DATA_KEY);
    if (!stored) return;

    try {
      const data = JSON.parse(stored);
      if (!data.examDates) return;

      // Migrate legacy keys ("Economics") to new keys ("economics")
      // so we never lose user input across the refactor.
      const migrated = buildInitialDates();
      for (const subject of SUBJECTS) {
        migrated[subject.key] =
          data.examDates[subject.key] ?? // new format
          data.examDates[subject.name] ?? // legacy: "Economics", "Business"
          "";
      }
      setExamDates(migrated);
    } catch (e) {
      console.warn("[ExamDates] Failed to parse stored onboarding data", e);
    }
  }, []);

  // ── Redirect if user has already completed onboarding ────────
  useEffect(() => {
    if (localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "true") {
      router.push("/dashboard");
    }
  }, [router]);

  // ── Update one subject's date when the user picks one ────────
  const handleDateChange = (subjectKey, value) => {
    setExamDates((prev) => ({ ...prev, [subjectKey]: value }));
  };

  // ── Save and move to the next onboarding step ────────────────
  //
  // Same dual-write strategy as the Study Hours page:
  //   1. localStorage (synchronous) — keeps every other
  //      onboarding step working, AND lets the dashboard read
  //      exam dates instantly without an API round-trip.
  //   2. POST /onboarding/exam-dates (async) — writes each
  //      exam date to the `subjects.exam_date` column so the
  //      Timetable feature can read it when computing urgency.
  //
  // Graceful degradation: a failed API call is logged and
  // SWALLOWED — onboarding never gets stuck. The user's data
  // is still safe in localStorage, and they can re-trigger the
  // write later (e.g. by editing dates from a settings page).
  const handleNext = async () => {
    // Guard against duplicate clicks while the save is running.
    if (isSaving) return;
    setIsSaving(true);

    // ── 1. Mirror to localStorage (synchronous). ────────────
    try {
      const stored = localStorage.getItem(ONBOARDING_DATA_KEY);
      const onboardingData = stored ? JSON.parse(stored) : {};
      onboardingData.examDates = examDates;
      localStorage.setItem(
        ONBOARDING_DATA_KEY,
        JSON.stringify(onboardingData),
      );
    } catch (storageErr) {
      // localStorage can throw in private browsing / quota
      // overflow. Logged, never blocking.
      console.warn(
        "[ExamDates] Failed to mirror to localStorage:",
        storageErr,
      );
    }

    // ── 2. Persist to Supabase via POST /onboarding/exam-dates. ──
    try {
      // Pull the current session — same shape as Study Hours.
      const { data: sessionData, error: sessionErr } =
        await supabase.auth.getSession();
      const session = sessionData?.session;
      const token = session?.access_token;
      const uid = session?.user?.id;

      if (sessionErr || !token || !uid) {
        // No valid session → log + skip the write. The user
        // will likely be bounced to /login by the proxy
        // anyway on their next protected request.
        console.warn(
          "[ExamDates] No active session — skipping exam-dates save",
          sessionErr,
        );
      } else {
        // Build the payload from the form state. For each
        // SUBJECTS entry we emit one { subject_code, exam_date }
        // pair, then filter out any subject the user didn't
        // fill in (empty string). The backend treats an empty
        // list as a successful no-op so this filter is safe.
        const payloadEntries = SUBJECTS
          .map((subject) => ({
            subject_code: subject.code,
            exam_date: examDates[subject.key] || "",
          }))
          .filter((entry) => entry.exam_date);

        const res = await fetch(`${API_URL}/onboarding/exam-dates`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Bearer token — same auth pattern as the rest of
            // the protected backend endpoints.
            Authorization: `Bearer ${token}`,
          },
          // Body shape matches OnboardingExamDatesRequest in
          // backend/routers/onboarding.py.
          body: JSON.stringify({
            user_id: uid,
            exam_dates: payloadEntries,
          }),
        });

        if (!res.ok) {
          // Non-2xx → log status + body. Never raised to the
          // user; onboarding continues regardless.
          const text = await res.text().catch(() => "");
          console.warn(
            "[ExamDates] /onboarding/exam-dates failed:",
            res.status,
            text,
          );
        } else {
          // Parse the response so we can log how many rows
          // were actually updated — useful when the user
          // entered codes we don't recognise.
          const data = await res.json().catch(() => ({}));
          console.log(
            "[ExamDates] Exam dates saved:",
            data?.dates_saved,
          );
        }
      }
    } catch (apiErr) {
      // Network / fetch threw — logged + ignored. Same
      // reasoning as Study Hours: never block onboarding.
      console.warn(
        "[ExamDates] /onboarding/exam-dates threw:",
        apiErr,
      );
    } finally {
      // Release the button before navigation so the next page
      // never inherits a stuck "saving" state.
      setIsSaving(false);
    }

    // ── 3. Always navigate to the next step. ────────────────
    console.log("[ExamDates] Proceeding to study-hours");
    router.push("/onboarding/study-hours");
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-2xl w-full bg-white rounded-4px shadow-lg border border-hover overflow-hidden">
        {/* Progress bar – 40% (step 2 of 5) */}
        <div className="h-1 bg-hover">
          <div className="h-full w-2/5 bg-gold"></div>
        </div>

        <div className="p-8 md:p-10">
          <div className="text-gold text-xs font-semibold uppercase tracking-wider mb-2">
            Step 2 of 5
          </div>
          <h1 className="font-heading text-3xl md:text-4xl font-bold text-text-primary mb-3">
            Set your exam dates
          </h1>
          <p className="text-text-muted text-base mb-6 border-l-3 border-gold pl-3">
            We'll prioritise subjects with closer exams in your timetable
          </p>

          {/* One row per subject – sourced from the shared subjects list */}
          <div className="space-y-4 mt-6">
            {SUBJECTS.map((subject) => (
              <div
                key={subject.key}
                className="flex justify-between items-center bg-background p-4 rounded-4px border border-hover"
              >
                <div className="flex flex-col">
                  <span className="font-semibold text-text-primary">
                    {subject.fullName}
                  </span>
                  <span className="text-text-hint text-xs">{subject.code}</span>
                </div>
                <input
                  type="date"
                  value={examDates[subject.key]}
                  onChange={(e) => handleDateChange(subject.key, e.target.value)}
                  className="border border-hover rounded-4px px-3 py-2 text-sm focus:border-gold focus:outline-none"
                />
              </div>
            ))}
          </div>

          {/* Navigation buttons */}
          <div className="mt-8 flex justify-between">
            <Link
              href="/onboarding/welcome"
              className="border border-gold text-gold px-6 py-2 rounded-4px font-semibold hover:bg-gold/10 transition"
            >
              ← Back
            </Link>
            <button
              onClick={handleNext}
              disabled={isSaving}
              className="bg-gold text-white px-6 py-2 rounded-4px font-semibold hover:bg-gold/90 transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSaving ? "Saving…" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
