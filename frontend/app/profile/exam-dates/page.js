// ============================================================
// FILE: app/profile/exam-dates/page.js
// PURPOSE: Standalone exam dates editor — outside onboarding.
//          Matches settings page layout; saves via POST /onboarding/exam-dates.
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { SUBJECTS } from "@/lib/subjects";
import SubjectBadge from "@/app/components/SubjectBadge";

// localStorage key — keeps exam dates in sync with onboarding flow
const ONBOARDING_DATA_KEY = "ascendai_onboarding_data";

// Backend base URL — same env var as settings and onboarding
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

/** Build empty date map keyed by subject key (economics, business, …). */
function buildInitialDates() {
  return SUBJECTS.reduce((acc, subject) => {
    acc[subject.key] = "";
    return acc;
  }, {});
}

/** Normalise DB date to YYYY-MM-DD for HTML date inputs. */
function toDateInputValue(raw) {
  if (!raw) return "";
  return String(raw).slice(0, 10);
}

/** Merge Supabase subject rows (filtered by user) with local SUBJECTS list. */
function mergeExamDatesFromRows(dbRows) {
  const dates = buildInitialDates();
  for (const meta of SUBJECTS) {
    const row =
      (dbRows || []).find(
        (r) =>
          String(r.code || "") === meta.code ||
          String(r.name || "").toLowerCase().includes(meta.key),
      ) || null;
    if (row?.exam_date) {
      dates[meta.key] = toDateInputValue(row.exam_date);
    }
  }
  return dates;
}

/** Section label — same uppercase caption as settings page. */
function SettingsSection({ title, children, footer }) {
  return (
    <section style={{ margin: "24px var(--page-padding) 0" }}>
      <h2
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--date-color)",
          marginBottom: 12,
          marginTop: 0,
        }}
      >
        {title}
      </h2>
      <div
        style={{
          background: "var(--card)",
          border: "0.5px solid var(--gold-border)",
          borderRadius: 10,
          padding: "0 24px",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
      {footer}
    </section>
  );
}

/** Single row — label left, date input right (settings row layout). */
function SettingsRow({ name, description, children, isLast }) {
  return (
    <div
      className="profile-exam-dates-row"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
        padding: "16px 0",
        borderBottom: isLast ? "none" : "0.5px solid var(--border)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 200px" }}>
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 14,
            fontWeight: 500,
            color: "var(--text)",
            margin: 0,
          }}
        >
          {name}
        </p>
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 2,
            marginBottom: 0,
          }}
        >
          {description}
        </p>
      </div>
      <div className="profile-exam-dates-row-control">{children}</div>
    </div>
  );
}

export default function ProfileExamDatesPage() {
  const router = useRouter();

  // Session — required for auth guard and API save
  const [session, setSession] = useState(null);
  // Exam dates keyed by subject.key
  const [examDates, setExamDates] = useState(buildInitialDates);
  // True while initial load or save is in flight
  const [isSaving, setIsSaving] = useState(false);
  // True until session + subjects are loaded
  const [loading, setLoading] = useState(true);
  // Shows success copy for 3 seconds after save
  const [saved, setSaved] = useState(false);
  // Narrow screens stack row controls full width
  const [isMobile, setIsMobile] = useState(false);

  const userId = session?.user?.id;
  const token = session?.access_token;

  // Date input — matches settings time/date control styling
  const dateInputStyle = {
    width: isMobile ? "100%" : 160,
    maxWidth: "100%",
    background: "var(--card-hover)",
    border: "0.5px solid var(--gold-border-hover)",
    borderRadius: 6,
    padding: "8px 12px",
    fontFamily: "Inter, sans-serif",
    fontSize: 13,
    color: "var(--text)",
    outline: "none",
    colorScheme: "dark",
    boxSizing: "border-box",
  };

  const spinnerStyle = {
    display: "inline-block",
    width: 12,
    height: 12,
    border: "2px solid var(--gold-dim)",
    borderTopColor: "var(--gold)",
    borderRadius: "50%",
    animation: "profile-exam-dates-spin 0.8s linear infinite",
  };

  // Track mobile breakpoint — same pattern as settings page
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Auth guard + load existing exam dates from subjects for this user
  useEffect(() => {
    const init = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const s = sessionData?.session;
      if (!s) {
        router.replace("/login");
        return;
      }
      setSession(s);

      const uid = s.user.id;
      const { data: subjectRows, error } = await supabase
        .from("subjects")
        .select("code, name, exam_date, user_id")
        .eq("user_id", uid);

      if (error) {
        console.warn("[ProfileExamDates] subjects load failed:", error);
      } else {
        setExamDates(mergeExamDatesFromRows(subjectRows || []));
      }

      setLoading(false);
    };

    init();
  }, [router]);

  // Update one subject's date in local state
  const handleDateChange = (subjectKey, value) => {
    setExamDates((prev) => ({ ...prev, [subjectKey]: value }));
  };

  // Save — POST /onboarding/exam-dates (same payload as onboarding step)
  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setSaved(false);

    try {
      const stored = localStorage.getItem(ONBOARDING_DATA_KEY);
      const onboardingData = stored ? JSON.parse(stored) : {};
      onboardingData.examDates = examDates;
      localStorage.setItem(ONBOARDING_DATA_KEY, JSON.stringify(onboardingData));
    } catch (storageErr) {
      console.warn("[ProfileExamDates] localStorage mirror failed:", storageErr);
    }

    try {
      const { data: sessionData, error: sessionErr } =
        await supabase.auth.getSession();
      const s = sessionData?.session;
      const t = s?.access_token;
      const uid = s?.user?.id;

      if (sessionErr || !t || !uid) {
        console.warn("[ProfileExamDates] No session — save skipped", sessionErr);
      } else {
        const payloadEntries = SUBJECTS.map((subject) => ({
          subject_code: subject.code,
          exam_date: examDates[subject.key] || "",
        })).filter((entry) => entry.exam_date);

        const res = await fetch(`${API_URL}/onboarding/exam-dates`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${t}`,
          },
          body: JSON.stringify({
            user_id: uid,
            exam_dates: payloadEntries,
          }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.warn(
            "[ProfileExamDates] /onboarding/exam-dates failed:",
            res.status,
            text,
          );
        } else {
          const data = await res.json().catch(() => ({}));
          console.log("[ProfileExamDates] Exam dates saved:", data?.dates_saved);
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        }
      }
    } catch (apiErr) {
      console.warn("[ProfileExamDates] save threw:", apiErr);
    } finally {
      setIsSaving(false);
    }
  };

  const focusInput = (e) => {
    e.target.style.borderColor = "var(--gold)";
  };

  const blurInput = (e) => {
    e.target.style.borderColor = "var(--gold-border-hover)";
  };

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Inter, sans-serif",
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        Loading exam dates…
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", paddingBottom: 48 }}>
      <style jsx global>{`
        @keyframes profile-exam-dates-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (max-width: 767px) {
          .profile-exam-dates-row {
            flex-direction: column;
            align-items: flex-start !important;
          }
          .profile-exam-dates-row-control {
            width: 100%;
          }
        }
      `}</style>

      {/* Back navigation — returns to profile or previous page */}
      <div style={{ padding: "16px var(--page-padding) 0" }}>
        <button
          type="button"
          onClick={() => router.back()}
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--text-muted)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          ← Back
        </button>
      </div>

      {/* Page header — same typography as settings */}
      <header style={{ padding: "20px var(--page-padding) 0" }}>
        <h1
          style={{
            fontFamily: "var(--font-playfair), 'Playfair Display', serif",
            fontSize: 28,
            color: "var(--text)",
            fontWeight: 700,
            margin: 0,
          }}
        >
          Exam Dates
        </h1>
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--text-muted)",
            marginTop: 4,
            marginBottom: 0,
          }}
        >
          Set your Cambridge AS Level exam dates for each subject
        </p>
      </header>

      {/* Success message — shown for 3 seconds after save */}
      {saved && (
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--gold)",
            textAlign: "center",
            margin: "0 var(--page-padding) 12px",
          }}
        >
          Exam dates saved successfully
        </p>
      )}

      {/* Exam dates — one row per subject */}
      <SettingsSection
        title="Your Subjects"
        footer={
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            style={{
              width: "100%",
              marginTop: 12,
              background: "var(--gold)",
              border: "none",
              borderRadius: 6,
              padding: "12px 16px",
              fontFamily: "Inter, sans-serif",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--bg)",
              cursor: isSaving ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            {isSaving && <span style={spinnerStyle} aria-hidden />}
            {isSaving ? "Saving…" : "Save Exam Dates"}
          </button>
        }
      >
        {SUBJECTS.map((subject, idx) => {
          const isLast = idx === SUBJECTS.length - 1;
          return (
            <SettingsRow
              key={subject.key}
              name={subject.fullName}
              description={`${subject.name} · ${subject.code}`}
              isLast={isLast}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                  justifyContent: isMobile ? "flex-start" : "flex-end",
                  width: isMobile ? "100%" : "auto",
                }}
              >
                <SubjectBadge subject={subject.key} label={subject.name} />
                <input
                  type="date"
                  value={examDates[subject.key]}
                  onChange={(e) =>
                    handleDateChange(subject.key, e.target.value)
                  }
                  style={dateInputStyle}
                  onFocus={focusInput}
                  onBlur={blurInput}
                />
              </div>
            </SettingsRow>
          );
        })}
      </SettingsSection>
    </div>
  );
}
