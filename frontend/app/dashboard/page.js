// ============================================================
// FILE: app/dashboard/page.js
// PURPOSE: AscendAI home dashboard â€” hero greeting, feature
//          accordion, today's sessions, exam countdown, weekly
//          stats, and latest notes. Data from existing backend
//          endpoints; UI matches the approved mockup.
// ============================================================

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useInView } from "framer-motion";
import { supabase } from "../../lib/supabaseClient";
import { SUBJECTS } from "../../lib/subjects";
import SubjectBadge from "../components/SubjectBadge";
import {
  wordPullUp,
  fadeIn,
  staggerContainer,
  staggerItem,
} from "../lib/animations";

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CONSTANTS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// localStorage keys â€” onboarding completion flag + saved exam dates
const ONBOARDING_KEY = "ascendai_onboarding_completed";
const ONBOARDING_DATA_KEY = "ascendai_onboarding_data";

// Backend base URL for profile safety-net and dashboard data fetches
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

// Default study window when the profile safety-net creates a row
const DEFAULT_STUDY_START = "15:00";
const DEFAULT_STUDY_END = "23:00";

// Fallback exam dates when onboarding storage has no dates yet
const FALLBACK_EXAM_DATES = {
  economics: "2026-11-10",
  business: "2026-11-12",
  english: "2026-11-14",
  ict: "2026-11-16",
};

// Left accent border colour per subject for note cards (CSS vars only)
const NOTE_ACCENT_VAR = {
  economics: "var(--econ-accent)",
  business: "var(--biz-accent)",
  english: "var(--eng-accent)",
  ict: "var(--ict-accent)",
};

// Five feature shortcuts â€” SVG icons and copy from the approved mockup
const FEATURE_ACCORDION = [
  {
    id: "homework",
    href: "/features/homework",
    name: "Homework Assistant",
    desc: "Ask any Cambridge question",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    ),
  },
  {
    id: "notes",
    href: "/features/notes",
    name: "Note Summariser",
    desc: "Auto-generated from Classroom",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
  {
    id: "flashcards",
    href: "/features/flashcards",
    name: "Adaptive Flashcards",
    desc: "AI revision cards + spaced repetition",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
  },
  {
    id: "timetable",
    href: "/features/timetable",
    name: "Weekly Timetable",
    desc: "Your intelligent 2-week plan",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    id: "past-papers",
    href: "/features/past-papers",
    name: "Past Paper Solver",
    desc: "Upload and solve with AI",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    ),
  },
];

// Show placeholder notes when no real notes exist so the dashboard
// always looks complete and premium
const PLACEHOLDER_NOTES = [
  {
    id: "placeholder-1",
    subject: "economics",
    title: "Market Failure — Types and Government Response",
    summary:
      "Market failure occurs when the free market fails to allocate resources efficiently. Types include public goods, externalities, merit goods, and information failure.",
    created_at: "2026-05-15T10:00:00Z",
    isPlaceholder: true,
  },
  {
    id: "placeholder-2",
    subject: "business",
    title: "The Marketing Mix — Four Ps",
    summary:
      "Product, Price, Place, Promotion — the four controllable elements a company uses to influence demand for its products and services.",
    created_at: "2026-05-13T10:00:00Z",
    isPlaceholder: true,
  },
  {
    id: "placeholder-3",
    subject: "english",
    title: "Analysing Tone with CLS Framework",
    summary:
      "Context, Language, Structure framework for analytical essays. Helps to dissect author intent and the reader experience throughout a text.",
    created_at: "2026-05-12T10:00:00Z",
    isPlaceholder: true,
  },
];

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HELPER: ensureProfileExists
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function ensureProfileExists(authUser) {
  if (!authUser?.id || !authUser?.email) return;

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) return;

    const checkUrl =
      `${API_URL}/onboarding/profile/check` +
      `?user_id=${encodeURIComponent(authUser.id)}`;
    const checkRes = await fetch(checkUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!checkRes.ok) {
      console.warn(
        "[Dashboard safety-net] profile/check failed:",
        checkRes.status,
      );
      return;
    }

    const checkData = await checkRes.json().catch(() => ({}));
    if (checkData?.profile_exists) return;

    const fullName =
      authUser?.user_metadata?.full_name ||
      authUser.email.split("@")[0];

    const createRes = await fetch(`${API_URL}/onboarding/profile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        user_id: authUser.id,
        full_name: fullName,
        email: authUser.email,
        study_start_time: DEFAULT_STUDY_START,
        study_end_time: DEFAULT_STUDY_END,
      }),
    });

    if (!createRes.ok) {
      console.warn(
        "[Dashboard safety-net] profile create failed:",
        createRes.status,
      );
    }
  } catch (err) {
    console.warn(
      "[Dashboard safety-net] ensureProfileExists threw:",
      err,
    );
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DATE / TIME HELPERS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** ISO date key YYYY-MM-DD for comparisons */
function toDateKey(date) {
  if (typeof date === "string") return date.slice(0, 10);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Monday of the week containing the given date */
function getMondayKey(dateInput) {
  const d =
    typeof dateInput === "string"
      ? new Date(`${dateInput.slice(0, 10)}T00:00:00`)
      : new Date(dateInput);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const diff = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - diff);
  return toDateKey(d);
}

/** Sunday (end) of a week that starts on mondayKey */
function getSundayKey(mondayKey) {
  const d = new Date(`${mondayKey}T00:00:00`);
  d.setDate(d.getDate() + 6);
  return toDateKey(d);
}

/** Hero row date â€” "FRIDAY, 16 MAY 2026" */
function formatHeroDateUpper() {
  const raw = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return raw.toUpperCase();
}

/** Sessions card header â€” "Thursday 16 May" */
function formatTodayShort() {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** Exam row date â€” "10 Nov 2026" */
function formatExamShort(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Whole days from today until an ISO exam date (ceil, min 0) */
function daysUntil(iso) {
  if (!iso) return null;
  const target = new Date(`${iso.slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = target.getTime() - today.getTime();
  return Math.max(0, Math.ceil(diff / 86400000));
}

/** Urgency text colour for exam countdown days (CSS variables only) */
function examDaysColor(days) {
  if (days == null) return "var(--text-lighter)";
  if (days < 30) return "var(--gold)";
  if (days <= 90) return "var(--gold)";
  return "var(--text-lighter)";
}

/** Time-of-day word for the greeting (5amâ€“12 / 12â€“5 / 5â€“10 / 10â€“5) */
function getTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

/** First name from Supabase metadata, default "Aisha" */
function getFirstName(authUser) {
  const full =
    authUser?.user_metadata?.full_name ||
    authUser?.user_metadata?.name ||
    "";
  const first = String(full).trim().split(/\s+/)[0];
  return first || "Aisha";
}

/** Map backend subject name/code to local SUBJECTS key */
function resolveSubjectKey(name, code) {
  const n = String(name || "").toLowerCase();
  const c = String(code || "").toLowerCase();
  for (const s of SUBJECTS) {
    if (
      n.includes(s.key) ||
      n === s.name.toLowerCase() ||
      c === s.code.toLowerCase()
    ) {
      return s.key;
    }
  }
  return "economics";
}

/** Normalise a timetable entry from GET /timetable/entries */
function normalizeEntry(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    title: row.title ?? row.topic ?? "",
    date: row.date ?? row.scheduled_date ?? "",
    start_time: row.start_time ?? "",
    end_time: row.end_time ?? "",
    is_completed: !!(row.completed ?? row.is_completed),
    subject_name: row.subject_name ?? "",
    subject_code: row.subject_code ?? "",
    subject_key: resolveSubjectKey(row.subject_name, row.subject_code),
  };
}

/** "15:00 â€“ 16:30" from ISO time strings */
function formatTimeRange(startTime, endTime) {
  const a = (startTime || "").slice(0, 5);
  const b = (endTime || "").slice(0, 5);
  return `${a} – ${b}`;
}

/** Note preview date for card footer */
function formatNoteDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Strip markdown for note preview lines */
function stripMarkdown(text) {
  if (!text) return "";
  return String(text)
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`/g, "");
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HELPER: fetchDashboardData
// Uses the same endpoints as feature pages (no new backend routes)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function fetchDashboardData(userId, token) {
  const weekStart = getMondayKey(new Date());
  const weekEnd = getSundayKey(weekStart);

  const entriesUrl =
    `${API_URL}/timetable/entries` +
    `?user_id=${encodeURIComponent(userId)}` +
    `&week_start=${encodeURIComponent(weekStart)}` +
    `&week_end=${encodeURIComponent(weekEnd)}`;

  const notesParams = new URLSearchParams({
    user_id: userId,
    limit: "3",
    offset: "0",
  });

  const [entriesBody, notesBody, homeworkBody] = await Promise.all([
    fetch(entriesUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => (r.ok ? r.json().catch(() => null) : null))
      .catch(() => null),
    fetch(`${API_URL}/notes/list?${notesParams.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    })
      .then(async (r) => {
        if (!r.ok) {
          console.warn("[Dashboard] notes/list HTTP", r.status);
          return null;
        }
        return r.json().catch(() => null);
      })
      .catch((err) => {
        console.warn("[Dashboard] notes/list fetch failed:", err);
        return null;
      }),
    fetch(`${API_URL}/homework/history`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => (r.ok ? r.json().catch(() => null) : null))
      .catch(() => null),
  ]);

  const rawEntries = Array.isArray(entriesBody?.data)
    ? entriesBody.data
    : [];
  const entries = rawEntries
    .map(normalizeEntry)
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.start_time || "").localeCompare(b.start_time || ""),
    );

  const notes = Array.isArray(notesBody?.data) ? notesBody.data : [];
  console.log("[Dashboard] Notes fetched:", notes);
  console.log("[Dashboard] Notes count:", notes?.length);

  const homeworkRows = Array.isArray(homeworkBody?.data)
    ? homeworkBody.data
    : Array.isArray(homeworkBody)
      ? homeworkBody
      : [];

  return { entries, notes, homeworkRows, weekStart, weekEnd };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MAIN COMPONENT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function DashboardPage() {
  const router = useRouter();

  // loading â€” true until auth, onboarding, and dashboard data are ready
  const [loading, setLoading] = useState(true);

  // user â€” Supabase auth user after verification
  const [user, setUser] = useState(null);

  // checkedSessions â€” session id â†’ completed (checkbox UI + PATCH sync)
  const [checkedSessions, setCheckedSessions] = useState({});

  // examDates â€” subject key â†’ ISO date from onboarding localStorage
  const [examDates, setExamDates] = useState(FALLBACK_EXAM_DATES);

  // weekEntries â€” timetable rows for current week from GET /timetable/entries
  const [weekEntries, setWeekEntries] = useState([]);

  // latestNotes â€” up to 3 rows from GET /notes/list
  const [latestNotes, setLatestNotes] = useState([]);

  // homeworkRows â€” from GET /homework/history for weekly question count
  const [homeworkRows, setHomeworkRows] = useState([]);

  // weekBounds â€” Monday/Sunday keys used for stats filtering
  const [weekBounds, setWeekBounds] = useState({
    start: getMondayKey(new Date()),
    end: getSundayKey(getMondayKey(new Date())),
  });

  // mobileAccordionIndex â€” which feature card is expanded on small screens
  const [mobileAccordionIndex, setMobileAccordionIndex] = useState(0);

  // isMobile â€” true below 768px for click-to-expand accordion
  const [isMobile, setIsMobile] = useState(false);

  // notesInView ref â€” triggers stagger animation when notes scroll into view
  const notesSectionRef = useRef(null);
  const notesInView = useInView(notesSectionRef, { once: true, margin: "-40px" });

  const notes = latestNotes;
  const displayNotes =
    notes && notes.length > 0 ? notes.slice(0, 3) : PLACEHOLDER_NOTES;
  const isShowingPlaceholders =
    displayNotes === PLACEHOLDER_NOTES || displayNotes[0]?.isPlaceholder;

  // â”€â”€ Effect: track viewport width for mobile accordion â”€â”€â”€â”€â”€â”€â”€
  // Trigger: mount + resize. Purpose: switch accordion interaction.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // â”€â”€ Effect 1: Auth + onboarding guard + dashboard data â”€â”€â”€â”€â”€
  // Trigger: mount. Purpose: verify session, load exam dates, fetch
  // timetable/notes/homework, then render the mockup layout.
  useEffect(() => {
    const init = async () => {
      const {
        data: { user: authUser },
        error,
      } = await supabase.auth.getUser();

      if (error || !authUser) {
        router.replace("/login");
        return;
      }

      setUser(authUser);
      ensureProfileExists(authUser);

      if (localStorage.getItem(ONBOARDING_KEY) !== "true") {
        router.replace("/onboarding/welcome");
        return;
      }

      let mergedExams = { ...FALLBACK_EXAM_DATES };
      try {
        const stored = localStorage.getItem(ONBOARDING_DATA_KEY);
        if (stored) {
          const data = JSON.parse(stored);
          if (data?.examDates) {
            for (const subject of SUBJECTS) {
              const value =
                data.examDates[subject.key] ??
                data.examDates[subject.name];
              if (value) mergedExams[subject.key] = value;
            }
          }
        }
      } catch (e) {
        console.warn("[Dashboard] Failed to parse onboarding data", e);
      }
      setExamDates(mergedExams);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token ?? null;

      if (token && authUser.id) {
        const {
          entries,
          notes,
          homeworkRows: hw,
          weekStart,
          weekEnd,
        } = await fetchDashboardData(authUser.id, token);

        setWeekEntries(entries);
        console.log("[Dashboard] Notes fetched:", notes);
        console.log("[Dashboard] Notes count:", notes?.length);
        setLatestNotes(notes);
        setHomeworkRows(hw);
        setWeekBounds({ start: weekStart, end: weekEnd });

        const initialChecked = {};
        for (const e of entries) {
          if (e.is_completed) initialChecked[e.id] = true;
        }
        setCheckedSessions(initialChecked);
      }

      setLoading(false);
    };

    init();
  }, [router]);

  // â”€â”€ Handler: toggle session checkbox + PATCH completion â”€â”€â”€â”€â”€
  const toggleSession = async (session) => {
    const next = !checkedSessions[session.id];
    setCheckedSessions((prev) => ({ ...prev, [session.id]: next }));

    if (!user?.id || !session?.id) return;

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) return;

      await fetch(
        `${API_URL}/timetable/entry/${session.id}/complete`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            user_id: user.id,
            is_completed: next,
          }),
        },
      );
    } catch (err) {
      console.warn("[Dashboard] Could not PATCH session completion:", err);
    }
  };

  if (loading) {
    return (
      <motion.div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "var(--bg)", color: "var(--gold)" }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        Loading dashboard...
      </motion.div>
    );
  }

  const todayKey = toDateKey(new Date());
  const todaySessions = weekEntries.filter((e) => e.date === todayKey);

  const greetingWords = `Good ${getTimeOfDay()}, ${getFirstName(user)}.`.split(
    /\s+/,
  );

  const sessionCount = todaySessions.length;
  let nearestExam = null;
  for (const s of SUBJECTS) {
    const d = daysUntil(examDates[s.key]);
    if (d != null && (nearestExam == null || d < nearestExam.days)) {
      nearestExam = { subject: s.name, days: d };
    }
  }

  const weekSessions = weekEntries.filter(
    (e) => e.date >= weekBounds.start && e.date <= weekBounds.end,
  );
  const completedWeek = weekSessions.filter(
    (e) => checkedSessions[e.id] || e.is_completed,
  ).length;
  const hoursStudied = (completedWeek * 1.5).toFixed(1);

  const questionsThisWeek = homeworkRows.filter((q) => {
    if (!q?.created_at) return false;
    const created = new Date(q.created_at);
    const start = new Date(`${weekBounds.start}T00:00:00`);
    const end = new Date(`${weekBounds.end}T23:59:59`);
    return created >= start && created <= end;
  }).length;

  // Hero section outer padding (40px top on desktop, 24px on mobile via CSS)
  const heroWrapStyle = {
    padding: "40px var(--page-padding) 16px",
  };

  // Date line above greeting
  const heroDateStyle = {
    fontFamily: "Inter, sans-serif",
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.14em",
    color: "var(--date-color)",
    textTransform: "uppercase",
    marginBottom: "12px",
  };

  // Greeting headline container
  const greetingStyle = {
    display: "flex",
    flexWrap: "wrap",
    fontFamily: "'Playfair Display', serif",
    fontSize: "64px",
    color: "var(--text)",
    lineHeight: 1,
    letterSpacing: "-0.025em",
    fontWeight: 700,
    marginBottom: "8px",
  };

  // Subtext under greeting
  const heroSubStyle = {
    fontFamily: "Inter, sans-serif",
    fontSize: "14px",
    color: "var(--subtext)",
  };

  // Accordion strip container
  const accordionWrapStyle = {
    margin: "16px var(--page-padding)",
    display: "flex",
    height: "88px",
    gap: "6px",
    overflow: "hidden",
    background: "var(--accordion-gap-bg)",
    borderRadius: "8px",
  };

  // Main content stack: two-column row + latest notes row
  const mainContentStyle = {
    margin: "16px var(--page-padding) 32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  };

  // Two-column grid (sessions + sidebar)
  const twoColStyle = {
    display: "grid",
    gridTemplateColumns: "1fr 320px",
    gap: "16px",
    alignItems: "start",
  };

  // Subtle inner highlight on cards for depth
  const cardDepthStyle = {
    boxShadow: "var(--card-inset-shadow)",
  };

  // Full-width This Week stats bar (between accordion and two-column grid)
  const weekStatsBarStyle = {
    margin: "0 var(--page-padding) 16px",
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: "12px",
  };

  const weekStatCardStyle = {
    background: "var(--card)",
    border: "0.5px solid var(--gold-dim)",
    borderRadius: "10px",
    padding: "16px 20px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    ...cardDepthStyle,
  };

  const weekStatLabelStyle = {
    fontFamily: "Inter, sans-serif",
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--date-color)",
  };

  const weekStatValueStyle = {
    fontFamily: "Inter, sans-serif",
    fontSize: "18px",
    fontWeight: 600,
    color: "var(--text)",
  };

  // Today's sessions card shell â€” content-sized, no stretch in grid
  const sessionsCardStyle = {
    background: "var(--card)",
    border: "0.5px solid var(--gold-dim)",
    borderRadius: "10px",
    padding: "22px 24px",
    paddingBottom: 0,
    transition: "background 300ms, border-color 300ms",
    alignSelf: "start",
    ...cardDepthStyle,
  };

  return (
    <motion.div
      className="dashboard-page min-h-screen"
      style={{ background: "var(--bg)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      {/* Scoped CSS: accordion hover trick + responsive breakpoints */}
      <style jsx global>{`
        .dashboard-two-col {
          align-items: start;
        }
        @media (max-width: 767px) {
          .dashboard-page {
            --page-padding: 16px;
          }
          .feature-accordion .feature-collapsed {
            display: none !important;
          }
          .dashboard-hero {
            padding: 24px var(--page-padding) 16px !important;
          }
          .dashboard-greeting {
            font-size: 42px !important;
          }
          .feature-accordion {
            flex-direction: column !important;
            height: auto !important;
          }
          .feature-accordion .feature-card {
            flex: none !important;
            height: 48px;
          }
          .feature-accordion .feature-card.is-active-mobile {
            height: 80px;
          }
          .dashboard-week-stats {
            grid-template-columns: 1fr !important;
          }
          .dashboard-two-col {
            grid-template-columns: 1fr !important;
          }
          .dashboard-notes-grid {
            grid-template-columns: 1fr !important;
          }
        }
        @media (min-width: 768px) and (max-width: 1023px) {
          .dashboard-page {
            --page-padding: 24px;
          }
          .dashboard-two-col {
            grid-template-columns: 1fr 280px !important;
          }
          .dashboard-notes-grid {
            grid-template-columns: repeat(2, 1fr) !important;
          }
        }
        /* Desktop accordion: first card expanded; hover container collapses all;
           hover on one card expands only that card (pure CSS, no JS). */
        @media (min-width: 768px) {
          .feature-accordion .feature-card {
            flex: 1;
            transition:
              flex 450ms cubic-bezier(0.4, 0, 0.2, 1),
              background 250ms,
              border-color 250ms;
          }
          .feature-accordion .feature-card:first-child {
            flex: 5;
            background: var(--card-active);
            border-left: 2px solid var(--gold);
            border: 0.5px solid var(--gold-border-active);
          }
          .feature-accordion:hover .feature-card {
            flex: 1;
            background: var(--card);
            border-left: none;
          }
          .feature-accordion:hover .feature-card:hover {
            flex: 5;
            background: var(--card-active);
            border-left: 2px solid var(--gold);
            border: 0.5px solid var(--gold-border-active);
          }
          .feature-accordion .feature-card .feature-expanded {
            display: none;
          }
          .feature-accordion .feature-card .feature-collapsed {
            display: flex;
          }
          .feature-accordion .feature-card:first-child .feature-expanded,
          .feature-accordion:hover .feature-card:hover .feature-expanded {
            display: flex;
          }
          .feature-accordion .feature-card:first-child .feature-collapsed,
          .feature-accordion:hover .feature-card:hover .feature-collapsed {
            display: none;
          }
          .feature-accordion:hover .feature-card:first-child:not(:hover) .feature-expanded {
            display: none;
          }
          .feature-accordion:hover .feature-card:first-child:not(:hover) .feature-collapsed {
            display: flex;
          }
        }
      `}</style>

      {/* â•â•â• SECTION 1 â€” HERO GREETING â•â•â• */}
      <header className="dashboard-hero" style={heroWrapStyle}>
        <p style={heroDateStyle}>{formatHeroDateUpper()}</p>

        <h1 style={greetingStyle} className="dashboard-greeting" aria-label="Greeting">
          {greetingWords.map((word, index) => (
            <motion.span
              key={`${word}-${index}`}
              custom={index}
              variants={wordPullUp}
              initial="hidden"
              animate="visible"
              style={{ display: "inline-block", marginRight: "0.28em" }}
            >
              {word}
            </motion.span>
          ))}
        </h1>

        <motion.p
          style={heroSubStyle}
          variants={fadeIn}
          initial="hidden"
          animate="visible"
          transition={{ delay: 0.5, duration: 0.5, ease: "easeOut" }}
        >
          {sessionCount > 0 && nearestExam ? (
            <>
              {sessionCount} study session{sessionCount === 1 ? "" : "s"} today{" "}
              &middot;{" "}
              {nearestExam.subject} exam in {nearestExam.days} days
            </>
          ) : sessionCount > 0 ? (
            <>
              {sessionCount} study session{sessionCount === 1 ? "" : "s"} today
            </>
          ) : (
            <>Welcome back &mdash; your dashboard is ready.</>
          )}
        </motion.p>
      </header>

      {/* â•â•â• SECTION 2 â€” FEATURE ACCORDION â•â•â• */}
      <div
        className="feature-accordion"
        style={accordionWrapStyle}
        role="navigation"
        aria-label="Features"
      >
        {FEATURE_ACCORDION.map((feat, index) => {
          const isMobileActive = isMobile && mobileAccordionIndex === index;

          return (
            <Link
              key={feat.id}
              href={feat.href}
              className={`feature-card${isMobileActive ? " is-active-mobile" : ""}`}
              style={{
                flex: isMobile ? undefined : undefined,
                background: isMobileActive ? "var(--card-active)" : "var(--card)",
                border: "0.5px solid var(--gold-border)",
                borderRadius: "8px",
                cursor: "pointer",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: isMobile ? "flex-start" : "center",
                textDecoration: "none",
                borderLeft: isMobileActive ? "2px solid var(--gold)" : undefined,
              }}
              onClick={(e) => {
                if (!isMobile) return;
                if (mobileAccordionIndex !== index) {
                  e.preventDefault();
                  setMobileAccordionIndex(index);
                }
              }}
            >
              {/* Collapsed: icon only (desktop hover states via CSS) */}
              <span
                className="feature-collapsed"
                style={{
                  color: "var(--gold-icon)",
                  fontSize: "20px",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "100%",
                }}
              >
                {feat.icon}
              </span>

              {/* Expanded: icon + title + description */}
              <span
                className="feature-expanded"
                style={{
                  display: isMobile ? (isMobileActive ? "flex" : "none") : undefined,
                  alignItems: "center",
                  padding: "0 20px",
                  gap: "14px",
                  width: "100%",
                }}
              >
                <span style={{ color: "var(--gold)", fontSize: "22px", flexShrink: 0 }}>
                  {feat.icon}
                </span>
                <span style={{ borderLeft: "2px solid var(--gold)", paddingLeft: "14px" }}>
                  <span
                    style={{
                      display: "block",
                      fontFamily: "Inter, sans-serif",
                      fontSize: "15px",
                      fontWeight: 500,
                      color: "var(--text)",
                    }}
                  >
                    {feat.name}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontFamily: "Inter, sans-serif",
                      fontSize: "13px",
                      color: "var(--text-muted)",
                      marginTop: "2px",
                    }}
                  >
                    {feat.desc}
                  </span>
                </span>
              </span>

              {/* Mobile: always show icon + name in a row when collapsed */}
              {isMobile && !isMobileActive && (
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    padding: "0 16px",
                    color: "var(--gold-icon)",
                  }}
                >
                  {feat.icon}
                  <span
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "13px",
                      fontWeight: 500,
                      color: "var(--text)",
                    }}
                  >
                    {feat.name}
                  </span>
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* â•â•â• SECTION 3 â€” TWO COLUMN + LATEST NOTES â•â•â• */}
      <div className="dashboard-week-stats" style={weekStatsBarStyle}>
        <div style={weekStatCardStyle}>
          <span style={weekStatLabelStyle}>Study Sessions</span>
          <span style={weekStatValueStyle}>
            {completedWeek} / {weekSessions.length}
          </span>
        </div>
        <div style={weekStatCardStyle}>
          <span style={weekStatLabelStyle}>Hours Studied</span>
          <span style={weekStatValueStyle}>{hoursStudied}h</span>
        </div>
        <div style={weekStatCardStyle}>
          <span style={weekStatLabelStyle}>Questions Asked</span>
          <span style={weekStatValueStyle}>{questionsThisWeek}</span>
        </div>
      </div>

      <div style={mainContentStyle}>
        <div className="dashboard-two-col" style={twoColStyle}>
        {/* LEFT â€” Today's study sessions */}
        <section style={sessionsCardStyle}>
          <motion.div
            style={{ height: "auto", alignSelf: "start" }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <motion.div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: "8px",
              }}
            >
              <h2
                style={{
                  fontFamily: "'Playfair Display', serif",
                  fontSize: "19px",
                  color: "var(--text)",
                  fontWeight: 700,
                  margin: 0,
                }}
              >
                Today&apos;s Study Sessions
              </h2>
              <span
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "12px",
                  color: "var(--text-lighter)",
                }}
              >
                {formatTodayShort()}
              </span>
            </motion.div>

            {todaySessions.length === 0 ? (
              <p
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "13px",
                  color: "var(--text-muted)",
                  textAlign: "center",
                  padding: "24px 0",
                }}
              >
                No sessions scheduled for today
              </p>
            ) : (
              <div style={{ marginBottom: 0, paddingBottom: 0 }}>
              {todaySessions.map((session, idx) => {
                const done = !!checkedSessions[session.id];
                const isLast = idx === todaySessions.length - 1;
                const startTime = (session.start_time || "").slice(0, 5);
                const endTime = (session.end_time || "").slice(0, 5);
                return (
                  <div
                    key={session.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "11px 0",
                      borderBottom: isLast
                        ? "none"
                        : "0.5px solid var(--border-row)",
                      opacity: done ? 0.45 : 1,
                    }}
                  >
                    <button
                      type="button"
                      aria-label={`Mark ${session.title} complete`}
                      onClick={() => toggleSession(session)}
                      style={{
                        width: "15px",
                        height: "15px",
                        border: "0.5px solid var(--checkbox-border)",
                        borderRadius: "3px",
                        cursor: "pointer",
                        flexShrink: 0,
                        background: done ? "var(--gold)" : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                      }}
                    >
                      {done && (
                        <svg width="9" height="7" viewBox="0 0 10 8" fill="none" aria-hidden>
                          <path
                            d="M1 4L3.5 6.5L9 1"
                            stroke="var(--bg)"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </button>

                    <SubjectBadge subject={session.subject_key} />

                    <span
                      style={{
                        flex: 1,
                        fontFamily: "Inter, sans-serif",
                        fontSize: "13px",
                        color: "var(--text-emphasis)",
                        textDecoration: done ? "line-through" : "none",
                      }}
                    >
                      {session.title}
                    </span>

                    <span
                      style={{
                        fontFamily: "Inter, sans-serif",
                        fontSize: "12px",
                        color: "var(--text-dim)",
                        flexShrink: 0,
                      }}
                    >
                      {startTime}{" - "}{endTime}
                    </span>
                  </div>
                );
              })}
              </div>
            )}
          </motion.div>
        </section>

        {/* RIGHT â€” Exam countdown */}
        <aside style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <motion.div
            style={{
              background: "var(--card)",
              border: "0.5px solid var(--gold-dim)",
              borderRadius: "10px",
              padding: "18px 20px",
              ...cardDepthStyle,
            }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
          >
            <h3
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "11px",
                fontWeight: 500,
                letterSpacing: "0.12em",
                color: "var(--date-color)",
                textTransform: "uppercase",
                marginBottom: "14px",
              }}
            >
              Exam Countdown
            </h3>
            {SUBJECTS.map((subject, idx) => {
              const iso = examDates[subject.key];
              const days = daysUntil(iso);
              const isLast = idx === SUBJECTS.length - 1;
              const urgent = days != null && days < 30;
              return (
                <motion.div
                  key={subject.key}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 0",
                    borderBottom: isLast ? "none" : "0.5px solid var(--border-row)",
                  }}
                >
                  <SubjectBadge subject={subject.key} showCode />
                  <div style={{ textAlign: "right" }}>
                    <div
                      style={{
                        fontFamily: "Inter, sans-serif",
                        fontSize: "12px",
                        color: "var(--text)",
                      }}
                    >
                      {formatExamShort(iso)}
                    </div>
                    <motion.div
                      style={{
                        fontFamily: "Inter, sans-serif",
                        fontSize: "11px",
                        fontWeight: 500,
                        color: urgent ? "var(--exam-urgent)" : examDaysColor(days),
                      }}
                    >
                      {days != null ? `${days} days` : "—"}
                    </motion.div>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>

        </aside>
        </div>

        {/* Row B â€” Latest Notes (full width, directly below two-column grid) */}
        <div ref={notesSectionRef}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: "12px",
          }}
        >
          <h2
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "11px",
              fontWeight: 500,
              letterSpacing: "0.12em",
              color: "var(--text-dim)",
              textTransform: "uppercase",
            }}
          >
            Latest Notes
          </h2>
          <button
            type="button"
            onClick={() => router.push("/features/notes")}
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "11px",
              color: "var(--gold)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            View all &rarr;
          </button>
        </div>

        {console.log("[Notes Debug] displayNotes:", displayNotes)}
        {console.log("[Notes Debug] length:", displayNotes?.length)}

        <motion.div
          className="dashboard-notes-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "10px",
          }}
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
        >
          {displayNotes.map((note, index) => {
            if (!displayNotes || displayNotes.length === 0) {
              return null;
            }
            console.log("[Notes Render] rendering note:", note.title);
            const subject =
              note.subject?.toLowerCase() ||
              resolveSubjectKey(note.subject_name, note.subject_code) ||
              "economics";
            const accentColor =
              subject === "economics"
                ? "var(--econ-accent)"
                : subject === "business"
                  ? "var(--biz-accent)"
                  : subject === "english"
                    ? "var(--eng-accent)"
                    : "var(--ict-accent)";

            return (
              <motion.div
                key={note.id}
                variants={staggerItem}
                role="button"
                tabIndex={0}
                style={{
                  background: "var(--card)",
                  border: "0.5px solid var(--gold-dim)",
                  borderRadius: "10px",
                  padding: "18px 20px",
                  cursor: "pointer",
                  borderLeft: `3px solid ${accentColor}`,
                  transition: "background 200ms, border-color 200ms",
                  ...cardDepthStyle,
                }}
                whileHover={{
                  backgroundColor: "var(--card-hover)",
                  transition: { duration: 0.15 },
                }}
                onClick={() => router.push("/features/notes")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    router.push("/features/notes");
                  }
                }}
              >
                <div style={{ paddingLeft: "6px" }}>
                  <SubjectBadge subject={subject} />
                  <h3
                    style={{
                      fontFamily:
                        "var(--font-playfair), 'Playfair Display', serif",
                      fontSize: "15px",
                      color: "var(--text)",
                      margin: "8px 0 6px",
                      fontWeight: 700,
                      lineHeight: 1.3,
                    }}
                  >
                    {note.title}
                  </h3>
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "12px",
                      color: "var(--text-dim)",
                      lineHeight: 1.5,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {note.summary || note.preview
                      ? stripMarkdown(note.summary || note.preview)
                      : "No preview available."}
                  </p>
                  <span
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "10px",
                      color: "var(--text-extra-dim)",
                      marginTop: "10px",
                      display: "block",
                    }}
                  >
                    {note.created_at
                      ? new Date(note.created_at).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })
                      : ""}
                  </span>
                </div>
              </motion.div>
            );
          })}

          {isShowingPlaceholders && (
            <p
              style={{
                gridColumn: "1 / -1",
                fontFamily: "Inter, sans-serif",
                fontSize: "11px",
                color: "var(--text-muted)",
                fontStyle: "italic",
                textAlign: "center",
                marginTop: "8px",
              }}
            >
              Sample notes &mdash; sync Classroom to see yours
            </p>
          )}
        </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
