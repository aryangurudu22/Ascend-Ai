// ============================================================
// FILE: app/onboarding/study-hours/page.js
// PURPOSE: Onboarding Step 3 — Set preferred study hours
// URL: /onboarding/study-hours
// ============================================================

"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import {
  OnboardingShell,
  OnboardingHeading,
  OnboardingSubheading,
  ContinueButton,
} from "../onboarding-ui";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

/** Parse "HH:MM" into total minutes since midnight. */
function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

/**
 * Time calculation — hours between start/end and estimated daily sessions.
 * Sessions assume ~1.5 hours each (timetable default block).
 */
function calcStudySummary(startTime, endTime) {
  let startM = timeToMinutes(startTime);
  let endM = timeToMinutes(endTime);
  let diff = endM - startM;
  if (diff <= 0) diff += 24 * 60;
  const hours = Math.round((diff / 60) * 10) / 10;
  const sessions = Math.max(1, Math.floor(hours / 1.5));
  return { hours, sessions };
}

export default function OnboardingStudyHours() {
  const router = useRouter();
  const [startTime, setStartTime] = useState("15:00");
  const [endTime, setEndTime] = useState("23:00");
  const [isSaving, setIsSaving] = useState(false);

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

  // Skip onboarding when profiles row already has full_name (works on every device).
  useEffect(() => {
    let cancelled = false;

    const checkProfile = async () => {
      // Read the signed-in session from Supabase auth.
      const { data: { session } } = await supabase.auth.getSession();

      if (cancelled) return;

      // Only query profiles when we have a logged-in user.
      if (session) {
        // Load this user's profile to see if onboarding is already done.
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("user_id", session.user.id)
          .single();

        if (cancelled) return;

        // If profile exists with full_name — onboarding is done.
        if (profile && profile.full_name) {
          router.replace("/dashboard");
          return;
        }
      }
    };

    checkProfile();

    return () => {
      cancelled = true;
    };
  }, [router]);

  const { hours, sessions } = useMemo(
    () => calcStudySummary(startTime, endTime),
    [startTime, endTime],
  );

  const handleNext = async () => {
    if (isSaving) return;
    setIsSaving(true);

    try {
      const stored = localStorage.getItem("ascendai_onboarding_data");
      const onboardingData = stored ? JSON.parse(stored) : {};
      onboardingData.studyStart = startTime;
      onboardingData.studyEnd = endTime;
      localStorage.setItem("ascendai_onboarding_data", JSON.stringify(onboardingData));
    } catch (storageErr) {
      console.warn("[StudyHours] Failed to mirror to localStorage:", storageErr);
    }

    try {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      const session = sessionData?.session;
      const token = session?.access_token;
      const uid = session?.user?.id;
      const userEmail = session?.user?.email;

      if (sessionErr || !token || !uid || !userEmail) {
        console.warn("[StudyHours] No active session — skipping profile save", sessionErr);
      } else {
        const fullName =
          session?.user?.user_metadata?.full_name || userEmail.split("@")[0];

        const res = await fetch(`${API_URL}/onboarding/profile`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            user_id: uid,
            full_name: fullName,
            email: userEmail,
            study_start_time: startTime,
            study_end_time: endTime,
          }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.warn("[StudyHours] /onboarding/profile failed:", res.status, text);
        } else {
          console.log("[StudyHours] Profile saved to Supabase");
        }
      }
    } catch (apiErr) {
      console.warn("[StudyHours] /onboarding/profile threw:", apiErr);
    } finally {
      setIsSaving(false);
    }

    router.push("/onboarding/connect-google");
  };

  const inputStyle = {
    width: "100%",
    background: "var(--card-hover)",
    border: "0.5px solid var(--gold-border-hover)",
    borderRadius: "8px",
    padding: "14px 16px",
    fontFamily: "Inter, sans-serif",
    fontSize: "16px",
    color: "var(--text)",
    textAlign: "center",
    colorScheme: "dark",
  };

  return (
    <OnboardingShell step={3} backHref="/onboarding/exam-dates">
      <OnboardingHeading>When do you study?</OnboardingHeading>
      <OnboardingSubheading>We&apos;ll schedule your sessions within these hours</OnboardingSubheading>

      {/* ── STEP 3 — Start / end time pickers ─────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        <div>
          <p
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "11px",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--date-color)",
              marginBottom: "6px",
            }}
          >
            STUDY START
          </p>
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            style={inputStyle}
            onFocus={(e) => {
              e.target.style.borderColor = "var(--gold)";
              e.target.style.outline = "none";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "var(--gold-border-hover)";
            }}
          />
        </div>
        <div>
          <p
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "11px",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--date-color)",
              marginBottom: "6px",
            }}
          >
            STUDY END
          </p>
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            style={inputStyle}
            onFocus={(e) => {
              e.target.style.borderColor = "var(--gold)";
              e.target.style.outline = "none";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "var(--gold-border-hover)";
            }}
          />
        </div>
      </div>

      {/* ── STEP 3 — Dynamic hours summary ────────────────────── */}
      <div
        style={{
          background: "var(--nav-icon-bg)",
          border: "0.5px solid var(--chat-bubble-border)",
          borderRadius: "8px",
          padding: "16px",
          textAlign: "center",
          marginTop: "16px",
        }}
      >
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "14px",
            fontWeight: 500,
            color: "var(--gold)",
            margin: 0,
          }}
        >
          {hours} hours of study time per day
        </p>
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "12px",
            color: "var(--text-muted)",
            marginTop: "4px",
            marginBottom: 0,
          }}
        >
          That&apos;s up to {sessions} study session{sessions === 1 ? "" : "s"} daily
        </p>
      </div>

      <ContinueButton onClick={handleNext} loading={isSaving} disabled={isSaving}>
        Continue →
      </ContinueButton>
    </OnboardingShell>
  );
}
