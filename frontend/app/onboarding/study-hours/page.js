// ============================================================
// FILE: app/onboarding/study-hours/page.js
// PURPOSE: Onboarding Step 3 – Set preferred study hours
// URL: /onboarding/study-hours
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "../../../lib/supabaseClient";

// Backend base URL. Falls back to the localhost dev port so a
// missing env var doesn't crash the page — the call still
// fires, fails fast, and we continue onboarding (see handleNext).
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

export default function OnboardingStudyHours() {
  const router = useRouter();

  // State for study start and end times
  const [startTime, setStartTime] = useState("15:00");
  const [endTime, setEndTime] = useState("23:00");

  // Disables the Next button while the POST /onboarding/profile
  // request is in flight. Two reasons:
  //   1. Stops the user from double-clicking and creating two
  //      writes to Supabase from a single user action.
  //   2. Gives clear visual feedback that something is happening
  //      between click and route change (the API call usually
  //      finishes in <300 ms but a slow connection makes the
  //      delay noticeable).
  const [isSaving, setIsSaving] = useState(false);

  // Load previously saved data from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("ascendai_onboarding_data");
    if (stored) {
      try {
        const data = JSON.parse(stored);
        if (data.studyStart) setStartTime(data.studyStart);
        if (data.studyEnd) setEndTime(data.studyEnd);
      } catch (e) {}
    }
  }, []);

  // Check if onboarding already completed – redirect to dashboard
  useEffect(() => {
    const completed = localStorage.getItem("ascendai_onboarding_completed");
    if (completed === "true") {
      router.push("/dashboard");
    }
  }, [router]);

  // Save study hours and proceed to next step.
  //
  // PERSISTENCE STRATEGY — read both halves below carefully.
  //   1. localStorage (synchronous, never blocks the UI).
  //      Keeps the current behaviour: every other onboarding
  //      page reads from this key, so we MUST keep writing it
  //      or the back-button flow breaks.
  //   2. Supabase /onboarding/profile (async, may fail).
  //      The Timetable feature reads study_start_time +
  //      study_end_time from the `profiles` table; without
  //      this write, the timetable endpoint returns 404
  //      "Profile not found". Saving here closes that loop.
  //
  // GRACEFUL DEGRADATION:
  //   • If the Supabase write fails (network drop, expired
  //     session, server down) we LOG the error and STILL
  //     navigate to the next step. The dashboard has a safety
  //     net that retries the same write on load, so a one-off
  //     failure here is recoverable later.
  //   • We never surface the error to the user during
  //     onboarding — a broken-looking onboarding flow is
  //     worse than a quiet retry.
  const handleNext = async () => {
    // Guard: ignore repeat clicks while a save is in flight.
    if (isSaving) return;
    setIsSaving(true);

    // ── 1. Mirror to localStorage (synchronous, always runs). ──
    // Read the existing onboarding blob (so we don't trample
    // any other step's data), merge in the new times, and
    // write it straight back.
    try {
      const stored = localStorage.getItem("ascendai_onboarding_data");
      const onboardingData = stored ? JSON.parse(stored) : {};
      onboardingData.studyStart = startTime;
      onboardingData.studyEnd = endTime;
      localStorage.setItem(
        "ascendai_onboarding_data",
        JSON.stringify(onboardingData),
      );
    } catch (storageErr) {
      // localStorage can throw in private browsing or when the
      // quota is exceeded. Logged, never blocking — the
      // Supabase write below is the real source of truth.
      console.warn(
        "[StudyHours] Failed to mirror to localStorage:",
        storageErr,
      );
    }

    // ── 2. Persist to Supabase via POST /onboarding/profile. ──
    // This is the write that fixes the "Profile not found"
    // 404 from /timetable/generate.
    try {
      // Pull the current session — we need the access token
      // for the Authorization header AND the user_id/email
      // for the request body. If there's no valid session
      // we just skip the call (logged) and keep going.
      const { data: sessionData, error: sessionErr } =
        await supabase.auth.getSession();

      const session = sessionData?.session;
      const token = session?.access_token;
      const uid = session?.user?.id;
      const userEmail = session?.user?.email;

      if (sessionErr || !token || !uid || !userEmail) {
        console.warn(
          "[StudyHours] No active session — skipping profile save",
          sessionErr,
        );
      } else {
        // Best-effort: pull the Google display name when
        // available, fall back to the email's local-part so
        // the row always has SOMETHING in full_name.
        const fullName =
          session?.user?.user_metadata?.full_name ||
          userEmail.split("@")[0];

        // Fire the POST. We deliberately don't `await` on a
        // separate variable so the error handler also sees a
        // thrown fetch (TypeError on offline). Both `!ok` and
        // throw paths are handled identically below.
        const res = await fetch(`${API_URL}/onboarding/profile`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Bearer token — same pattern every protected
            // backend endpoint uses.
            Authorization: `Bearer ${token}`,
          },
          // Body fields map 1:1 onto OnboardingProfileRequest
          // in backend/routers/onboarding.py.
          body: JSON.stringify({
            user_id: uid,
            full_name: fullName,
            email: userEmail,
            study_start_time: startTime,
            study_end_time: endTime,
          }),
        });

        if (!res.ok) {
          // Non-2xx → log the status + body for debugging
          // but DO NOT block the user. The dashboard safety
          // net will retry the same write on load.
          const text = await res.text().catch(() => "");
          console.warn(
            "[StudyHours] /onboarding/profile failed:",
            res.status,
            text,
          );
        } else {
          console.log("[StudyHours] Profile saved to Supabase");
        }
      }
    } catch (apiErr) {
      // Network / fetch threw — logged + ignored. The
      // dashboard safety net will pick this up.
      console.warn(
        "[StudyHours] /onboarding/profile threw:",
        apiErr,
      );
    } finally {
      // Release the button before navigating so the next
      // page render doesn't briefly inherit the disabled
      // state on a back-button return.
      setIsSaving(false);
    }

    // ── 3. Always navigate to the next step. ─────────────────
    // The whole point of "graceful degradation" — onboarding
    // never gets stuck on a failed write.
    router.push("/onboarding/connect-google");
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-2xl w-full bg-white rounded-4px shadow-lg border border-hover overflow-hidden">
        {/* Progress bar – 60% (step 3 of 5) */}
        <div className="h-1 bg-hover">
          <div className="h-full w-3/5 bg-gold"></div>
        </div>

        <div className="p-8 md:p-10">
          <div className="text-gold text-xs font-semibold uppercase tracking-wider mb-2">
            Step 3 of 5
          </div>
          <h1 className="font-heading text-3xl md:text-4xl font-bold text-text-primary mb-3">
            Your preferred study hours
          </h1>
          <p className="text-text-muted text-base mb-6 border-l-3 border-gold pl-3">
            We'll schedule your timetable within this window
          </p>

          <div className="flex gap-6 items-center flex-wrap bg-background p-5 rounded-4px border border-hover mt-4">
            <div className="flex items-center gap-3">
              <span className="font-medium">Start time:</span>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="border border-hover rounded-4px px-3 py-2 focus:border-gold focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="font-medium">End time:</span>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="border border-hover rounded-4px px-3 py-2 focus:border-gold focus:outline-none"
              />
            </div>
          </div>

          <div className="mt-8 flex justify-between">
            <Link
              href="/onboarding/exam-dates"
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