// ============================================================
// FILE: app/onboarding/exam-dates/page.js
// PURPOSE: Onboarding Step 2 — User enters one exam date per subject.
// URL: /onboarding/exam-dates
// ============================================================

"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { SUBJECTS } from "../../../lib/subjects";
import { supabase } from "../../../lib/supabaseClient";
import SubjectBadge from "../../components/SubjectBadge";
import {
  OnboardingShell,
  OnboardingHeading,
  OnboardingSubheading,
  ContinueButton,
} from "../onboarding-ui";

const ONBOARDING_DATA_KEY = "ascendai_onboarding_data";
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

const buildInitialDates = () =>
  SUBJECTS.reduce((acc, subject) => {
    acc[subject.key] = "";
    return acc;
  }, {});

function OnboardingExamDatesContent() {
  const router = useRouter();
  const [examDates, setExamDates] = useState(buildInitialDates);
  const [isSaving, setIsSaving] = useState(false);
  // searchParams lets us check if user came from edit mode or onboarding
  const searchParams = useSearchParams();
  // saved controls the success message shown after saving in edit mode
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(ONBOARDING_DATA_KEY);
    if (!stored) return;
    try {
      const data = JSON.parse(stored);
      if (!data.examDates) return;
      const migrated = buildInitialDates();
      for (const subject of SUBJECTS) {
        migrated[subject.key] =
          data.examDates[subject.key] ?? data.examDates[subject.name] ?? "";
      }
      setExamDates(migrated);
    } catch (e) {
      console.warn("[ExamDates] Failed to parse stored onboarding data", e);
    }
  }, []);

  const handleDateChange = (subjectKey, value) => {
    setExamDates((prev) => ({ ...prev, [subjectKey]: value }));
  };

  // POST /onboarding/exam-dates + localStorage mirror, then navigate.
  const handleNext = async () => {
    if (isSaving) return;
    setIsSaving(true);

    try {
      const stored = localStorage.getItem(ONBOARDING_DATA_KEY);
      const onboardingData = stored ? JSON.parse(stored) : {};
      onboardingData.examDates = examDates;
      localStorage.setItem(ONBOARDING_DATA_KEY, JSON.stringify(onboardingData));
    } catch (storageErr) {
      console.warn("[ExamDates] Failed to mirror to localStorage:", storageErr);
    }

    try {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      const session = sessionData?.session;
      const token = session?.access_token;
      const uid = session?.user?.id;

      if (sessionErr || !token || !uid) {
        console.warn("[ExamDates] No active session — skipping exam-dates save", sessionErr);
      } else {
        const payloadEntries = SUBJECTS.map((subject) => ({
          subject_code: subject.code,
          exam_date: examDates[subject.key] || "",
        })).filter((entry) => entry.exam_date);

        const res = await fetch(`${API_URL}/onboarding/exam-dates`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            user_id: uid,
            exam_dates: payloadEntries,
          }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.warn("[ExamDates] /onboarding/exam-dates failed:", res.status, text);
        } else {
          const data = await res.json().catch(() => ({}));
          console.log("[ExamDates] Exam dates saved:", data?.dates_saved);
        }
      }
    } catch (apiErr) {
      console.warn("[ExamDates] /onboarding/exam-dates threw:", apiErr);
    } finally {
      setIsSaving(false);
    }

    console.log("[ExamDates] Proceeding to study-hours");
    // Check if user came from edit mode — if yes stay on page, if no continue onboarding
    const fromEdit = searchParams.get("from") === "edit";
    if (fromEdit) {
      // Show a success message instead of redirecting
      setSaved(true);
      // Hide the success message after 3 seconds
      setTimeout(() => setSaved(false), 3000);
    } else {
      // Normal onboarding flow — go to next step
      router.push("/onboarding/study-hours");
    }
  };

  return (
    <OnboardingShell step={2} backHref="/onboarding/welcome">
      <OnboardingHeading>When are your exams?</OnboardingHeading>
      <OnboardingSubheading>We&apos;ll build your revision plan around these dates</OnboardingSubheading>

      {/* ── STEP 2 — One date input per subject ─────────────── */}
      <div
        style={{
          background: "var(--card)",
          border: "0.5px solid var(--gold-border)",
          borderRadius: "10px",
          padding: "4px 16px",
        }}
      >
        {SUBJECTS.map((subject, idx) => (
          <div
            key={subject.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              padding: "12px 0",
              borderBottom: idx < SUBJECTS.length - 1 ? "0.5px solid var(--border)" : "none",
            }}
          >
            <SubjectBadge subject={subject.key} label={subject.name} />
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text)", flex: 1 }}>
              {subject.fullName}
            </span>
            <input
              type="date"
              value={examDates[subject.key]}
              onChange={(e) => handleDateChange(subject.key, e.target.value)}
              style={{
                background: "var(--card-hover)",
                border: "0.5px solid var(--gold-border-hover)",
                borderRadius: "6px",
                padding: "8px 12px",
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                color: "var(--text)",
                width: "160px",
                colorScheme: "dark",
              }}
              onFocus={(e) => {
                e.target.style.borderColor = "var(--gold)";
                e.target.style.outline = "none";
              }}
              onBlur={(e) => {
                e.target.style.borderColor = "var(--gold-border-hover)";
              }}
            />
          </div>
        ))}
      </div>

      {/* Success message shown after saving in edit mode */}
      {saved && (
        <p style={{
          fontFamily: "Inter, sans-serif",
          fontSize: "13px",
          color: "var(--gold)",
          textAlign: "center",
          margin: "0 0 12px 0",
        }}>
          Exam dates saved successfully
        </p>
      )}

      <ContinueButton onClick={handleNext} loading={isSaving} disabled={isSaving}>
        Save Exam Dates →
      </ContinueButton>
    </OnboardingShell>
  );
}

// Next.js requires useSearchParams inside a Suspense boundary at build time.
export default function OnboardingExamDates() {
  return (
    <Suspense fallback={null}>
      <OnboardingExamDatesContent />
    </Suspense>
  );
}
