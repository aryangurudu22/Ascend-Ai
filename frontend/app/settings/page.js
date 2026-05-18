// ============================================================
// FILE: app/settings/page.js
// PURPOSE: Centralised AscendAI preferences — profile, theme,
//          study window, email reminders, and data privacy.
// ============================================================

"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useTheme } from "@/app/context/ThemeContext";
import { SUBJECTS } from "@/lib/subjects";
import SubjectBadge from "@/app/components/SubjectBadge";

// Backend base URL — same env var as dashboard and analytics.
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

// Grain localStorage key — ON by default unless explicitly 'off'.
const GRAIN_STORAGE_KEY = "ascendai-grain";

/** Normalise DB time strings (HH:MM:SS) to HTML time input value (HH:MM). */
function toTimeInputValue(raw) {
  if (!raw) return "";
  const s = String(raw);
  return s.length >= 5 ? s.slice(0, 5) : s;
}

/** GET /reminders/preferences — load saved email reminder settings. */
async function fetchReminderPreferences(token) {
  try {
    const res = await fetch(`${API_URL}/reminders/preferences`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return data;
  } catch {
    return null;
  }
}

/** GET /onboarding/profile/check then Supabase profiles row for study times. */
async function fetchStudyWindow(userId, token) {
  try {
    const checkUrl =
      `${API_URL}/onboarding/profile/check` +
      `?user_id=${encodeURIComponent(userId)}`;
    const checkRes = await fetch(checkUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!checkRes.ok) return { start: "15:00", end: "23:00" };

    const checkData = await checkRes.json().catch(() => ({}));
    if (!checkData?.profile_exists) {
      return { start: "15:00", end: "23:00" };
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("study_start_time, study_end_time")
      .eq("user_id", userId)
      .maybeSingle();

    return {
      start: toTimeInputValue(profile?.study_start_time) || "15:00",
      end: toTimeInputValue(profile?.study_end_time) || "23:00",
    };
  } catch {
    return { start: "15:00", end: "23:00" };
  }
}

/** Apply grain overlay visibility from the enabled flag. */
function applyGrainOverlay(enabled) {
  if (typeof document === "undefined") return;
  const el = document.querySelector(".grain-overlay");
  if (el) el.style.opacity = enabled ? "" : "0";
  localStorage.setItem(GRAIN_STORAGE_KEY, enabled ? "on" : "off");
}

/** Reusable toggle switch — same visual as former dashboard reminders card. */
function ToggleSwitch({ checked, onChange, ariaLabel }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: checked ? "var(--gold)" : "var(--card-hover)",
        border: "0.5px solid var(--gold-dim)",
        position: "relative",
        cursor: "pointer",
        transition: "background 200ms",
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--text)",
          top: 2,
          left: checked ? 20 : 2,
          transition: "left 200ms",
        }}
      />
    </button>
  );
}

/** One settings section — header label + card with rows. */
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

/** Single row inside a section card — label left, control right. */
function SettingsRow({ name, description, children, isLast }) {
  return (
    <div
      className="settings-row"
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
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();

  const [session, setSession] = useState(null);
  const [reminderEmail, setReminderEmail] = useState("");
  const [dailyReminder, setDailyReminder] = useState(true);
  const [weeklyReport, setWeeklyReport] = useState(true);
  const [examAlerts, setExamAlerts] = useState(true);
  const [reminderTime, setReminderTime] = useState("08:00");
  const [savingReminders, setSavingReminders] = useState(false);
  const [reminderSaved, setReminderSaved] = useState(false);
  const [testEmailSent, setTestEmailSent] = useState(false);
  const [testEmailLoading, setTestEmailLoading] = useState(false);
  const [studyStart, setStudyStart] = useState("15:00");
  const [studyEnd, setStudyEnd] = useState("23:00");
  const [grainEnabled, setGrainEnabled] = useState(true);
  const [clearingChat, setClearingChat] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [loading, setLoading] = useState(true);

  const userId = session?.user?.id;
  const token = session?.access_token;
  const fullName =
    session?.user?.user_metadata?.full_name ||
    session?.user?.email?.split("@")[0] ||
    "";
  const accountEmail = session?.user?.email || "";

  const inputStyle = {
    width: isMobile ? "100%" : 200,
    maxWidth: "100%",
    background: "var(--card-hover)",
    border: "0.5px solid var(--gold-border-hover)",
    borderRadius: 6,
    padding: "6px 12px",
    fontFamily: "Inter, sans-serif",
    fontSize: 13,
    color: "var(--text)",
    outline: "none",
    boxSizing: "border-box",
  };

  const timeInputStyle = {
    ...inputStyle,
    width: isMobile ? "100%" : 120,
    textAlign: "center",
  };

  const emailInputStyle = {
    ...inputStyle,
    width: isMobile ? "100%" : 220,
  };

  const spinnerStyle = {
    display: "inline-block",
    width: 12,
    height: 12,
    border: "2px solid var(--gold-dim)",
    borderTopColor: "var(--gold)",
    borderRadius: "50%",
    animation: "settings-spin 0.8s linear infinite",
  };

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const grainStored = localStorage.getItem(GRAIN_STORAGE_KEY);
    const grainOn = grainStored !== "off";
    setGrainEnabled(grainOn);
    applyGrainOverlay(grainOn);
  }, []);

  useEffect(() => {
    const init = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const s = sessionData?.session;
      if (!s) {
        router.replace("/login");
        return;
      }
      setSession(s);

      const t = s.access_token;
      const uid = s.user.id;

      const [prefs, studyWindow] = await Promise.all([
        fetchReminderPreferences(t),
        fetchStudyWindow(uid, t),
      ]);

      if (prefs) {
        setReminderEmail(prefs.email || s.user.email || "");
        setDailyReminder(prefs.daily_reminder !== false);
        setWeeklyReport(prefs.weekly_report !== false);
        setExamAlerts(prefs.exam_alert !== false);
        setReminderTime(prefs.reminder_time || "08:00");
      } else {
        setReminderEmail(s.user.email || "");
      }

      setStudyStart(studyWindow.start);
      setStudyEnd(studyWindow.end);
      setLoading(false);
    };

    init();
  }, [router]);

  const saveStudyWindow = useCallback(
    async (start, end) => {
      if (!token || !userId || !accountEmail) return;
      try {
        await fetch(`${API_URL}/onboarding/profile`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            user_id: userId,
            full_name: fullName,
            email: accountEmail,
            study_start_time: start,
            study_end_time: end,
          }),
        });
      } catch {
        /* non-blocking — user can retry by changing time again */
      }
    },
    [token, userId, accountEmail, fullName],
  );

  const handleStudyStartChange = (value) => {
    setStudyStart(value);
    saveStudyWindow(value, studyEnd);
  };

  const handleStudyEndChange = (value) => {
    setStudyEnd(value);
    saveStudyWindow(studyStart, value);
  };

  const handleGrainToggle = (next) => {
    setGrainEnabled(next);
    applyGrainOverlay(next);
  };

  const selectTheme = (target) => {
    if (target === "dark" && theme === "light") toggleTheme();
    if (target === "light" && theme === "dark") toggleTheme();
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  const handleSaveReminders = async () => {
    if (!userId || !token) return;
    setSavingReminders(true);
    setReminderSaved(false);
    try {
      const res = await fetch(`${API_URL}/reminders/preferences`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          user_id: userId,
          email: reminderEmail,
          daily_reminder: dailyReminder,
          weekly_report: weeklyReport,
          exam_alert: examAlerts,
          reminder_time: reminderTime,
        }),
      });
      if (res.ok) {
        setReminderSaved(true);
        setTimeout(() => setReminderSaved(false), 2000);
      }
    } finally {
      setSavingReminders(false);
    }
  };

  const handleSendTestEmail = async () => {
    if (!reminderEmail.trim()) return;
    setTestEmailLoading(true);
    setTestEmailSent(false);
    try {
      const res = await fetch(`${API_URL}/reminders/test-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ email: reminderEmail }),
      });
      if (res.ok) {
        setTestEmailSent(true);
        setTimeout(() => setTestEmailSent(false), 2000);
      }
    } finally {
      setTestEmailLoading(false);
    }
  };

  const handleClearChat = async () => {
    if (!userId) return;
    if (!window.confirm("Are you sure? This will delete all your chat history.")) {
      return;
    }
    setClearingChat(true);
    try {
      await supabase.from("chat_messages").delete().eq("user_id", userId);
    } finally {
      setClearingChat(false);
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
        Loading settings…
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", paddingBottom: 48 }}>
      <style jsx global>{`
        @keyframes settings-spin {
          to {
            transform: rotate(360deg);
          }
        }
        .settings-test-btn:hover:not(:disabled) {
          background: color-mix(in srgb, var(--gold) 8%, transparent) !important;
        }
        .settings-danger-btn:hover:not(:disabled) {
          background: color-mix(in srgb, var(--exam-urgent) 8%, transparent) !important;
        }
        @media (max-width: 767px) {
          .settings-row {
            flex-direction: column;
            align-items: flex-start !important;
          }
          .settings-row-control {
            width: 100%;
          }
        }
      `}</style>

      {/* Back navigation */}
      <div style={{ padding: "16px var(--page-padding) 0" }}>
        <Link
          href="/dashboard"
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--text-muted)",
            textDecoration: "none",
          }}
        >
          ← Dashboard / <span style={{ color: "var(--text)" }}>Settings</span>
        </Link>
      </div>

      {/* Page header */}
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
          Settings
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
          Manage your AscendAI preferences
        </p>
      </header>

      {/* SECTION 1 — Appearance */}
      <SettingsSection title="Appearance">
        <SettingsRow
          name="Theme"
          description="Switch between dark and light mode"
        >
          <div style={{ display: "flex", gap: 8 }}>
            {["dark", "light"].map((t) => {
              const active = theme === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => selectTheme(t)}
                  style={{
                    background: active ? "var(--gold)" : "transparent",
                    border: active ? "none" : "0.5px solid var(--gold-dim)",
                    borderRadius: 6,
                    padding: "6px 16px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 12,
                    fontWeight: active ? 500 : 400,
                    color: active ? "var(--bg)" : "var(--text-muted)",
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {t === "dark" ? "Dark" : "Light"}
                </button>
              );
            })}
          </div>
        </SettingsRow>
        <SettingsRow
          name="Grain Texture"
          description="Subtle film grain on all pages"
          isLast
        >
          <ToggleSwitch
            checked={grainEnabled}
            onChange={handleGrainToggle}
            ariaLabel="Grain texture"
          />
        </SettingsRow>
      </SettingsSection>

      {/* SECTION 2 — Study preferences */}
      <SettingsSection title="Study Preferences">
        <SettingsRow
          name="Study Start"
          description="When your daily study window begins"
        >
          <input
            type="time"
            value={studyStart}
            onChange={(e) => handleStudyStartChange(e.target.value)}
            style={timeInputStyle}
            onFocus={focusInput}
            onBlur={blurInput}
          />
        </SettingsRow>
        <SettingsRow
          name="Study End"
          description="When your daily study window ends"
        >
          <input
            type="time"
            value={studyEnd}
            onChange={(e) => handleStudyEndChange(e.target.value)}
            style={timeInputStyle}
            onFocus={focusInput}
            onBlur={blurInput}
          />
        </SettingsRow>
        <SettingsRow
          name="My Subjects"
          description="Cambridge AS Level subjects"
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {SUBJECTS.map((s) => (
              <SubjectBadge key={s.key} subject={s.key} showCode />
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          name="Exam Dates"
          description="Update your Cambridge exam dates"
          isLast
        >
          <button
            type="button"
            onClick={() => router.push("/onboarding/exam-dates")}
            style={{
              background: "none",
              border: "none",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              color: "var(--gold)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Edit Dates →
          </button>
        </SettingsRow>
      </SettingsSection>

      {/* SECTION 3 — Email reminders */}
      <SettingsSection
        title="Email Reminders"
        footer={
          <button
            type="button"
            onClick={handleSaveReminders}
            disabled={savingReminders}
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
              cursor: savingReminders ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            {savingReminders && <span style={spinnerStyle} aria-hidden />}
            {reminderSaved
              ? "Saved!"
              : savingReminders
                ? "Saving..."
                : "Save Reminder Settings"}
          </button>
        }
      >
        <SettingsRow
          name="Reminder Email"
          description="Where reminders are sent"
        >
          <input
            type="email"
            placeholder="your@email.com"
            value={reminderEmail}
            onChange={(e) => setReminderEmail(e.target.value)}
            style={emailInputStyle}
            onFocus={focusInput}
            onBlur={blurInput}
          />
        </SettingsRow>
        <SettingsRow
          name="Daily Reminder"
          description="Morning email with today's sessions"
        >
          <ToggleSwitch
            checked={dailyReminder}
            onChange={setDailyReminder}
            ariaLabel="Daily reminder"
          />
        </SettingsRow>
        <SettingsRow
          name="Weekly Report"
          description="Sunday email with week's progress"
        >
          <ToggleSwitch
            checked={weeklyReport}
            onChange={setWeeklyReport}
            ariaLabel="Weekly report"
          />
        </SettingsRow>
        <SettingsRow
          name="Exam Alerts"
          description="Alert when exam is 14 days away"
        >
          <ToggleSwitch
            checked={examAlerts}
            onChange={setExamAlerts}
            ariaLabel="Exam alerts"
          />
        </SettingsRow>
        <SettingsRow
          name="Send Time"
          description="What time to send daily reminder"
        >
          <input
            type="time"
            value={reminderTime}
            onChange={(e) => setReminderTime(e.target.value)}
            style={timeInputStyle}
            onFocus={focusInput}
            onBlur={blurInput}
          />
        </SettingsRow>
        <SettingsRow
          name="Test Email"
          description="Send a test to confirm delivery"
          isLast
        >
          <button
            type="button"
            className="settings-test-btn"
            onClick={handleSendTestEmail}
            disabled={testEmailLoading || !reminderEmail.trim()}
            style={{
              background: "transparent",
              border: "0.5px solid var(--gold-dim)",
              borderRadius: 6,
              padding: "8px 16px",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              color: "var(--gold)",
              cursor: testEmailLoading ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {testEmailLoading && <span style={spinnerStyle} aria-hidden />}
            {testEmailSent ? "Sent!" : "Send Test"}
          </button>
        </SettingsRow>
      </SettingsSection>

      {/* SECTION 4 — Data and privacy */}
      <SettingsSection title="Data and Privacy">
        <SettingsRow
          name="Syllabus Data"
          description="Your uploaded Cambridge topics"
        >
          <button
            type="button"
            onClick={() => router.push("/syllabus")}
            style={{
              background: "none",
              border: "none",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              color: "var(--gold)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            View Syllabus →
          </button>
        </SettingsRow>
        <SettingsRow
          name="Study Analytics"
          description="View your detailed progress"
        >
          <button
            type="button"
            onClick={() => router.push("/analytics")}
            style={{
              background: "none",
              border: "none",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              color: "var(--gold)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            View Analytics →
          </button>
        </SettingsRow>
        <SettingsRow
          name="Chat History"
          description="Your conversations with AscendAI"
        >
          <button
            type="button"
            className="settings-danger-btn"
            onClick={handleClearChat}
            disabled={clearingChat}
            style={{
              background: "transparent",
              border: "0.5px solid color-mix(in srgb, var(--exam-urgent) 30%, transparent)",
              borderRadius: 6,
              padding: "6px 14px",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              color: "var(--exam-urgent)",
              cursor: clearingChat ? "wait" : "pointer",
            }}
          >
            {clearingChat ? "Clearing…" : "Clear History"}
          </button>
        </SettingsRow>
        <SettingsRow
          name="Essay Check History"
          description="Your saved essay analyses"
        >
          <button
            type="button"
            onClick={() => router.push("/features/homework")}
            style={{
              background: "none",
              border: "none",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              color: "var(--gold)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            View History →
          </button>
        </SettingsRow>

        {/* Divider before sign out */}
        <div
          role="presentation"
          style={{
            height: "0.5px",
            background: "var(--border)",
            margin: "4px 0",
          }}
        />

        <SettingsRow
          name="Sign Out"
          description="Sign out of your AscendAI account"
          isLast
        >
          <button
            type="button"
            className="settings-danger-btn"
            onClick={handleSignOut}
            style={{
              background: "transparent",
              border: "0.5px solid color-mix(in srgb, var(--exam-urgent) 40%, transparent)",
              borderRadius: 6,
              padding: "6px 16px",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              color: "var(--exam-urgent)",
              cursor: "pointer",
            }}
          >
            Sign Out
          </button>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

