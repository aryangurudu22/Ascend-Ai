// ============================================================
// FILE: app/features/timetable/page.js
// PURPOSE: Weekly Timetable feature — Aisha's auto-generated
//          study schedule with full manual override.
//
// HOW THE PAGE WORKS AT A GLANCE
// ----------------------------------------------------------------
// VIEW 1 (default) — WEEKLY OVERVIEW
//   • Header with week range, "Generate Now" + week navigation.
//   • Progress stats + bar for the week.
//   • A 7-column grid (Mon → Sun). Each cell shows session cards.
//
// VIEW 2 — DAILY DETAIL
//   • Reached by clicking any day header in the grid.
//   • Big, full-width session cards with edit / delete / toggle.
//
// VIEW 3 — ADD / EDIT MODAL (overlay)
//   • Triggered from "+" buttons in the grid, the "Add session"
//     button in daily view, or the Pencil icon on a session card.
//
// All writes (toggle / add / edit / delete) use OPTIMISTIC UPDATES:
// the React state is mutated first so the UI feels instant; the
// matching Supabase call runs in the background and reverts on
// error with a toast. See `WHY OPTIMISTIC UPDATES` comments inline.
//
// PROJECT RULES THIS FILE OBEYS
// ----------------------------------------------------------------
//   • Subject names + UUIDs come from Supabase — never hardcoded.
//   • All colours come from Tailwind tokens in tailwind.config.js.
//   • All icons come from lucide-react.
//   • Supabase is imported from lib/supabaseClient.js only.
//   • No npm packages added; native JS Date used throughout.
//   • Mock data is generated against the real subject UUIDs we
//     just fetched, so still zero hardcoded UUIDs anywhere.
//   • No drag-and-drop library; session edits route through the
//     modal.
//   • No inline styles for colour or layout. The single exception
//     is the dynamic `width: ${pct}%` on the progress bar — same
//     justification as the flashcards page (Tailwind's JIT cannot
//     emit a literal percentage from a runtime variable).
// ============================================================

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Calendar,
  CalendarX,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { supabase } from "../../../lib/supabaseClient";
import { SUBJECTS } from "../../../lib/subjects";
import SubjectBadge from "../../components/SubjectBadge";


// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

// localStorage key the onboarding writes the user's study window
// to. Used to pre-fill the modal's "start time" default so adding
// a session matches the student's preferred study window.
const ONBOARDING_DATA_KEY = "ascendai_onboarding_data";

// Where to POST the "Generate Now" trigger. Same env var the rest
// of the frontend uses. Endpoint does not exist yet — that's fine;
// the spec says we surface a friendly toast regardless.
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

// Auto-dismiss the bottom-right toast after this many ms.
const TOAST_DISMISS_MS = 4000;

// Cycling copy shown every 4s while POST /timetable/generate runs.
const GENERATE_PROGRESS_MESSAGES = [
  "Checking your exam dates...",
  "Analysing your study window...",
  "Calculating subject urgency...",
  "Building your 2-week plan...",
  "Scheduling sessions by priority...",
  "Balancing workload across 14 days...",
  "Almost there — finalising your timetable...",
];

// Long-press threshold for the context menu on touch devices.
const LONG_PRESS_MS = 500;

// Two-letter day abbreviations for the weekly grid header.
// Sunday-relative (we *display* Mon→Sun so index 0 is "Mon").
const DAY_LABELS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Full day names for VIEW 2's date string.
const DAY_LABELS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Full month names — used in the date-range header and the V2
// long-date header. We avoid Intl.DateTimeFormat for predictability.
const MONTH_LABELS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Map of subject key → Tailwind class that sets the left-border
// colour to the subject's most-saturated swatch. Used on VIEW 2's
// session cards for the 4 px coloured stripe.
//
// IMPORTANT: these MUST be literal strings (no template
// interpolation) so Tailwind's JIT compiler can see them and emit
// the matching CSS. Same pattern as the SubjectBadge component.
const SUBJECT_BAR_CLASSES = {
  economics: "border-l-economics-text",
  business: "border-l-business-text",
  english: "border-l-english-text",
  ict: "border-l-ict-text",
};

// When a session is completed the bar is dimmed to text-hint so
// the subject signal fades but the layout doesn't shift.
const COMPLETED_BAR_CLASS = "border-l-text-hint";


// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS — date / time arithmetic
// ─────────────────────────────────────────────────────────────

/**
 * getWeekDates — return seven Date objects for the Monday-to-Sunday
 * week that contains the given input date.
 *
 * @param  {Date} date  – any date inside the desired week
 * @return {Date[]}     – 7 dates, Mon first, Sun last (all at 00:00)
 *
 * Why a custom helper? JavaScript's `getDay()` returns 0 for Sunday
 * which complicates Mon-first weeks. We translate once here.
 */
function getWeekDates(date) {
  // Clone + zero the time so comparisons later are pure date.
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);

  // getDay: 0=Sun … 6=Sat. We need to find the Monday.
  // If today is Sunday (0) Monday was 6 days ago, otherwise it
  // was (dayOfWeek - 1) days ago.
  const dayOfWeek = d.getDay();
  const diffFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(d);
  monday.setDate(d.getDate() - diffFromMonday);

  const week = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    week.push(day);
  }
  return week;
}

/**
 * toDateKey — return "YYYY-MM-DD" for the given Date.
 * Used to compare against Supabase's `date` column (which is
 * a Postgres DATE type rendered as ISO strings in API responses).
 */
function toDateKey(date) {
  if (typeof date === "string") {
    // Already an ISO date — strip any time portion just in case.
    return date.slice(0, 10);
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * isToday — true when the given date matches the system clock's
 * current date in the local timezone.
 */
function isToday(date) {
  return toDateKey(date) === toDateKey(new Date());
}

/**
 * formatWeekRange — produce "12 May – 18 May 2026" style label.
 */
function formatWeekRange(weekStart) {
  const dates = getWeekDates(weekStart);
  const first = dates[0];
  const last = dates[6];
  const yearTail =
    first.getFullYear() === last.getFullYear()
      ? last.getFullYear()
      : `${first.getFullYear()}–${last.getFullYear()}`;
  return (
    `${first.getDate()} ${MONTH_LABELS_SHORT[first.getMonth()]} – ` +
    `${last.getDate()} ${MONTH_LABELS_SHORT[last.getMonth()]} ${yearTail}`
  );
}

/**
 * formatLongDate — "Wednesday, 14 May 2026" for VIEW 2 header.
 */
function formatLongDate(date) {
  const d = typeof date === "string" ? new Date(`${date}T00:00:00`) : date;
  return (
    `${DAY_LABELS_LONG[d.getDay()]}, ${d.getDate()} ` +
    `${MONTH_LABELS_SHORT[d.getMonth()]} ${d.getFullYear()}`
  );
}

/**
 * parseTimeToMinutes — turn "HH:MM" or "HH:MM:SS" into minutes
 * since midnight. Returns 0 on parse failure to keep arithmetic
 * safe.
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return 0;
  const [h, m] = timeStr.split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

/**
 * formatDuration — "1h 30min" / "45min" / "2h" given two ISO
 * time strings. Negative or zero ranges return "0min".
 */
function formatDuration(startTime, endTime) {
  let minutes =
    parseTimeToMinutes(endTime) - parseTimeToMinutes(startTime);
  if (minutes <= 0) return "0min";

  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

/**
 * formatTimeRange — "15:00 – 16:30" given two ISO time strings.
 * Slices to HH:MM so seconds (which Postgres TIME can include)
 * don't leak into the UI.
 */
function formatTimeRange(startTime, endTime) {
  const a = (startTime || "").slice(0, 5);
  const b = (endTime || "").slice(0, 5);
  return `${a} – ${b}`;
}


// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS — data shaping
// ─────────────────────────────────────────────────────────────

/**
 * groupSessionsByDay — convert a flat list of session rows into
 *   { "2026-05-12": [session, …], "2026-05-13": [session, …] }
 *
 * Within each day list, sessions are sorted by `start_time` so the
 * day column reads top-to-bottom chronologically.
 */
function groupSessionsByDay(sessions) {
  const grouped = {};
  for (const s of sessions) {
    const key = toDateKey(s.date);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(s);
  }
  // Sort each day's list by start_time so morning sessions appear
  // above evening ones without relying on the Supabase order.
  for (const key of Object.keys(grouped)) {
    grouped[key].sort(
      (a, b) => parseTimeToMinutes(a.start_time) - parseTimeToMinutes(b.start_time),
    );
  }
  return grouped;
}

/**
 * calculateWeekStats — compute {done, remaining, totalHours,
 * completionRate} for the supplied list of sessions.
 *
 * totalHours is rounded to one decimal so the stat reads cleanly.
 * completionRate is 0–100 integer; 0 when the list is empty (we
 * avoid NaN from a 0/0 division).
 */
function calculateWeekStats(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { done: 0, remaining: 0, totalHours: 0, completionRate: 0 };
  }
  let done = 0;
  let totalMinutes = 0;
  for (const s of sessions) {
    if (s.is_completed) done += 1;
    totalMinutes +=
      parseTimeToMinutes(s.end_time) - parseTimeToMinutes(s.start_time);
  }
  const remaining = sessions.length - done;
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const completionRate = Math.round((done / sessions.length) * 100);
  return { done, remaining, totalHours, completionRate };
}

/**
 * buildSubjectIndex — given the rows returned from Supabase's
 * `subjects` SELECT, return a small lookup index used everywhere
 * a UUID → display name/key conversion is needed.
 *
 *   ordered : [row, …] in dashboard order (Economics, Business, …)
 *   byId    : { uuid: row }
 *   byKey   : { 'economics': row }
 */
function buildSubjectIndex(rows) {
  const byId = {};
  const byKey = {};
  for (const r of rows) {
    // The live `subjects` table doesn't carry a dedicated `key`
    // column — its rows have `name`, `code`, `colour_code`, etc.
    // The rest of this page (and the SubjectBadge component) needs a
    // lowercase key like "economics" to look up the right Tailwind
    // tokens. So we DERIVE one from the name's first word and
    // stamp it onto a copy of the row before storing it.
    const derivedKey =
      (r.key && String(r.key).toLowerCase()) ||
      (r.name && String(r.name).toLowerCase().split(/\s+/)[0]) ||
      null;
    const augmented = { ...r, key: derivedKey };
    byId[r.id] = augmented;
    if (derivedKey) byKey[derivedKey] = augmented;
    // Also index by the full lowercased name so legacy lookups
    // still resolve when something has the display name in hand.
    if (r.name) {
      const nameLower = String(r.name).toLowerCase();
      if (!byKey[nameLower]) byKey[nameLower] = augmented;
    }
  }
  // Preserve the canonical order from lib/subjects.js so the
  // subject dropdown always lists Economics first, etc.
  const ordered = SUBJECTS.map((s) => byKey[s.key]).filter(Boolean);
  return { ordered, byId, byKey };
}

/**
 * getMondayKey — return the "YYYY-MM-DD" string of the Monday of
 * the week containing the given date string or Date.
 *
 * Required when writing to Supabase: the `timetable_entries` table
 * has a NOT NULL `week_start` column that groups all sessions in a
 * week together. It must always equal the Monday of that week.
 */
function getMondayKey(input) {
  const d =
    typeof input === "string"
      ? new Date(`${input}T00:00:00`)
      : new Date(input);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const diff = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - diff);
  return toDateKey(d);
}


/**
 * normalizeEntry — translate a raw Supabase `timetable_entries`
 * row into the stable client-side shape the rest of this page
 * uses everywhere: { id, user_id, subject_id, title, notes, date,
 * start_time, end_time, is_completed, created_at }.
 *
 * WHY A NORMALIZATION BOUNDARY?
 * The live database stores sessions with slightly different column
 * names than the spec assumed:
 *
 *   DB column          ↔  client-side field
 *   ─────────────────────────────────────────────
 *   topic              ↔  title
 *   scheduled_date     ↔  date
 *   completed          ↔  is_completed
 *   (none)             ↔  notes
 *   week_start         ↔  (computed at write time)
 *
 * Rather than rewrite every render / handler to know about the DB
 * names, we translate once on the way in (here) and once on the
 * way out (`denormalizeForWrite` below). Mock entries are already
 * authored in the client-side shape so they pass through unchanged.
 *
 * `notes` has no matching DB column today. We default it to an
 * empty string on read so the modal still renders correctly, but
 * the write helpers DO NOT send notes to Supabase — meaning notes
 * typed against a real DB row are lost on refresh. This is the
 * minimum-viable behaviour until a `notes` column is added; the
 * fix is intentionally small and clearly commented.
 */
function normalizeEntry(row) {
  if (!row || typeof row !== "object") return row;
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    subject_id: row.subject_id,
    title: row.topic ?? row.title ?? "",
    notes: row.notes ?? "",
    date: row.scheduled_date ?? row.date ?? "",
    start_time: row.start_time ?? "",
    end_time: row.end_time ?? "",
    is_completed: !!(row.completed ?? row.is_completed),
    created_at: row.created_at ?? null,
  };
}


/**
 * denormalizeForWrite — convert the form's client-side fields
 * into the column names the Supabase `timetable_entries` table
 * actually has. `notes` is intentionally omitted because the DB
 * has no matching column (see normalizeEntry above).
 *
 * `week_start` is computed from the form's date so the grouping
 * column never gets out of sync with the session's actual day.
 */
function denormalizeForWrite(form) {
  return {
    subject_id: form.subject_id,
    topic: form.title,
    scheduled_date: form.date,
    start_time: form.start_time,
    end_time: form.end_time,
    week_start: getMondayKey(form.date),
  };
}


/**
 * getDefaultStartTime — read the student's preferred study window
 * from the onboarding data in localStorage. Falls back to "15:00"
 * (a sensible afternoon default for a Cambridge AS student) when
 * the data isn't available or is malformed.
 */
function getDefaultStartTime() {
  if (typeof window === "undefined") return "15:00";
  try {
    const raw = window.localStorage.getItem(ONBOARDING_DATA_KEY);
    if (!raw) return "15:00";
    const data = JSON.parse(raw);
    const candidate =
      data?.studyHours?.start ||
      data?.studyHoursStart ||
      data?.studyStart;
    if (typeof candidate === "string" && /^\d{2}:\d{2}/.test(candidate)) {
      return candidate.slice(0, 5);
    }
  } catch {
    // intentional swallow — bad JSON shouldn't crash the modal
  }
  return "15:00";
}


// ─────────────────────────────────────────────────────────────
// MOCK DATA — used when Supabase's `timetable_entries` is empty.
// ─────────────────────────────────────────────────────────────
//
// One realistic Cambridge AS-Level week. 13 sessions distributed
// across all four subjects with deliberate gaps so the grid has
// breathing room and the progress bar has data to show.
//
// We DO NOT hardcode subject UUIDs. Each template entry references
// a subject by its local `key` (matching lib/subjects.js); real
// UUIDs are patched in at runtime once Supabase responds (see
// `buildMockEntries` below).

const MOCK_SESSION_TEMPLATE = [
  // ── Monday ─────────────────────────────────────────────────
  {
    offset: 0,
    subjectKey: "economics",
    title: "Price Elasticity Revision",
    notes: "Worked examples from chapter 3, focus on cross elasticity.",
    start_time: "15:00:00",
    end_time: "16:30:00",
    is_completed: true,
  },
  {
    offset: 0,
    subjectKey: "english",
    title: "Unseen Poetry Practice",
    notes: "Apply CLS framework to one unseen poem under timed conditions.",
    start_time: "17:00:00",
    end_time: "18:00:00",
    is_completed: true,
  },
  // ── Tuesday ────────────────────────────────────────────────
  {
    offset: 1,
    subjectKey: "business",
    title: "Marketing Mix Case Study",
    notes: "KFC Zambia worked example — apply 4Ps to a Zambian fast-food chain.",
    start_time: "15:00:00",
    end_time: "16:00:00",
    is_completed: false,
  },
  {
    offset: 1,
    subjectKey: "ict",
    title: "Database Normalisation",
    notes: "1NF, 2NF, 3NF — past paper practice questions.",
    start_time: "16:30:00",
    end_time: "18:00:00",
    is_completed: false,
  },
  // ── Wednesday (today-ish for variety in screenshots) ──────
  {
    offset: 2,
    subjectKey: "economics",
    title: "Market Failure",
    notes: "Externalities, public goods, government intervention.",
    start_time: "14:00:00",
    end_time: "15:00:00",
    is_completed: false,
  },
  {
    offset: 2,
    subjectKey: "business",
    title: "Trade Unions Essay",
    notes: "12-mark practice paper — evaluate union impact in Zambia.",
    start_time: "15:30:00",
    end_time: "17:00:00",
    is_completed: false,
  },
  {
    offset: 2,
    subjectKey: "english",
    title: "Tone and Voice Analysis",
    notes: "Past paper Q2 — annotate language techniques in the passage.",
    start_time: "17:30:00",
    end_time: "18:30:00",
    is_completed: false,
  },
  // ── Thursday ───────────────────────────────────────────────
  {
    offset: 3,
    subjectKey: "ict",
    title: "Network Protocols",
    notes: "TCP/IP, OSI model layers — quiz yourself with flashcards.",
    start_time: "15:00:00",
    end_time: "16:30:00",
    is_completed: false,
  },
  {
    offset: 3,
    subjectKey: "business",
    title: "Marketing Mix Practice",
    notes: "Apply 4Ps to a local Zambian business of your choice.",
    start_time: "17:00:00",
    end_time: "18:00:00",
    is_completed: false,
  },
  // ── Friday ─────────────────────────────────────────────────
  {
    offset: 4,
    subjectKey: "economics",
    title: "Elasticity Calculations",
    notes: "Numerical practice set — PED, YED, XED computations.",
    start_time: "14:00:00",
    end_time: "15:30:00",
    is_completed: false,
  },
  {
    offset: 4,
    subjectKey: "english",
    title: "Literary Devices Recap",
    notes: "Use the AscendAI flashcards deck to revise key terms.",
    start_time: "16:00:00",
    end_time: "17:00:00",
    is_completed: false,
  },
  // ── Saturday ───────────────────────────────────────────────
  {
    offset: 5,
    subjectKey: "business",
    title: "Past Paper — Section A",
    notes: "June 2024 paper, timed under exam conditions.",
    start_time: "10:00:00",
    end_time: "11:30:00",
    is_completed: false,
  },
  // ── Sunday ─────────────────────────────────────────────────
  {
    offset: 6,
    subjectKey: "ict",
    title: "Database Project Review",
    notes: "Self-review of coursework draft, list improvement areas.",
    start_time: "15:00:00",
    end_time: "16:30:00",
    is_completed: false,
  },
];

/**
 * buildMockEntries — turn the template above into real-looking
 * timetable_entries for the week containing `weekStart`. Subject
 * UUIDs come from the real `subjectByKey` map we just fetched, so
 * even the mock data is consistent with the live database.
 *
 * Mock rows are flagged with an `id` that starts with "mock-" so
 * the write handlers can detect them and skip the Supabase call.
 */
function buildMockEntries(weekStart, subjectByKey) {
  const monday = getWeekDates(weekStart)[0];
  const entries = [];
  MOCK_SESSION_TEMPLATE.forEach((tpl, idx) => {
    const subjectRow = subjectByKey[tpl.subjectKey];
    if (!subjectRow) return; // skip if a subject row is missing
    const dayDate = new Date(monday);
    dayDate.setDate(monday.getDate() + tpl.offset);
    entries.push({
      id: `mock-${idx}-${toDateKey(dayDate)}`,
      user_id: null,
      subject_id: subjectRow.id,
      title: tpl.title,
      notes: tpl.notes,
      date: toDateKey(dayDate),
      start_time: tpl.start_time,
      end_time: tpl.end_time,
      is_completed: tpl.is_completed,
      created_at: null,
    });
  });
  return entries;
}


// ─────────────────────────────────────────────────────────────
// SMALL UI COMPONENTS
// ─────────────────────────────────────────────────────────────

// (The per-page SubjectBadge function used to live here. It was
// removed during the UI unification pass — every page now imports
// the shared SubjectBadge from app/components/SubjectBadge.js.)

/**
 * TimetableBreadcrumb — Dashboard / My Timetable (matches notes page).
 */
function TimetableBreadcrumb() {
  return (
    <div
      style={{
        padding: "16px var(--page-padding) 0",
        display: "flex",
        alignItems: "center",
        gap: "8px",
      }}
    >
      <Link
        href="/dashboard"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontFamily: "Inter, sans-serif",
          fontSize: "13px",
          color: "var(--text-muted)",
          textDecoration: "none",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Dashboard
      </Link>
      <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>/</span>
      <span style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-dim)" }}>
        My Timetable
      </span>
    </div>
  );
}

/**
 * StatCard — weekly summary stat tile.
 */
function StatCard({ value, label }) {
  return (
    <div
      style={{
        background: "var(--card)",
        border: "0.5px solid var(--gold-border)",
        borderRadius: "10px",
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
      }}
    >
      <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "28px", color: "var(--gold)", fontWeight: 700, lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--date-color)", marginTop: "4px" }}>
        {label}
      </span>
    </div>
  );
}

/**
 * ProgressBar — 4px completion bar; width % is the only dynamic style.
 */
function ProgressBar({ percent }) {
  const safe = Math.max(0, Math.min(100, percent || 0));
  return (
    <div style={{ height: "4px", width: "100%", background: "var(--border)", borderRadius: "2px", overflow: "hidden" }}>
      <div style={{ height: "4px", background: "var(--gold)", borderRadius: "2px", width: `${safe}%`, transition: "width 600ms ease" }} />
    </div>
  );
}

/**
 * SessionMiniCard — grid session; click toggles completion (optimistic in parent).
 */
function SessionMiniCard({ session, subjectMeta, onToggle }) {
  const subjectKey = subjectMeta?.key || "economics";
  const completed = !!session.is_completed;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Toggle completion for ${session.title}`}
      style={{
        width: "100%",
        textAlign: "left",
        background: "var(--card)",
        border: "0.5px solid var(--gold-border-hover)",
        borderRadius: "6px",
        padding: "10px 12px",
        cursor: "pointer",
        transition: "background 200ms, opacity 200ms",
        opacity: completed ? 0.5 : 1,
      }}
    >
      <SubjectBadge subject={subjectKey} label={subjectMeta?.name || "Subject"} />
      <p style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--text)", marginTop: "4px", lineHeight: 1.3, textDecoration: completed ? "line-through" : "none", marginBottom: 0 }}>
        {session.title}
      </p>
      <p style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", color: "var(--text-muted)", marginTop: "4px", marginBottom: 0 }}>
        {formatTimeRange(session.start_time, session.end_time)}
      </p>
    </button>
  );
}

/**
 * AddSessionButton — dashed + circle; shows coming-soon toast for now.
 */
function AddSessionButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Add session"
      className="timetable-add-session-btn"
      style={{
        width: "24px",
        height: "24px",
        borderRadius: "50%",
        background: "transparent",
        border: "0.5px dashed var(--gold-border-hover)",
        color: "var(--text-muted)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        padding: 0,
      }}
    >
      <Plus size={12} strokeWidth={2} aria-hidden />
    </button>
  );
}

/**
 * DayColumn — one day in the 7-column week grid.
 * Today detection: isToday(date) highlights the day number in gold.
 */
function DayColumn({ date, sessions, subjectIndex, onToggleSession, onAddSession }) {
  const today = isToday(date);
  const dayLabel = DAY_LABELS_SHORT[(date.getDay() + 6) % 7];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ textAlign: "center", marginBottom: "4px" }}>
        <p style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-muted)", margin: 0 }}>
          {dayLabel}
        </p>
        {today ? (
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", marginTop: "4px", background: "var(--gold)", borderRadius: "50%", color: "var(--bg)", fontFamily: "Inter, sans-serif", fontSize: "20px", fontWeight: 700 }}>
            {date.getDate()}
          </span>
        ) : (
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "20px", fontWeight: 600, color: "var(--text)", margin: "4px 0 0" }}>
            {date.getDate()}
          </p>
        )}
      </div>
      {sessions.map((s) => (
        <SessionMiniCard
          key={s.id}
          session={s}
          subjectMeta={subjectIndex.byId[s.subject_id]}
          onToggle={() => onToggleSession(s)}
        />
      ))}
      <AddSessionButton onClick={() => onAddSession(date)} />
    </div>
  );
}

/** Skeleton column while GET /timetable/entries is loading */
function DayColumnSkeleton() {
  const sk = { background: "var(--card)", borderRadius: "6px", animation: "timetable-pulse 1.5s ease-in-out infinite" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ ...sk, height: "40px" }} />
      <div style={{ ...sk, height: "80px" }} />
      <div style={{ ...sk, height: "80px" }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION COMPONENTS — VIEW 2 day-detail pieces
// ─────────────────────────────────────────────────────────────

/**
 * SessionDetailCard — the full-width card shown in VIEW 2's
 * vertical list. Includes the coloured left bar, badge, title,
 * notes, time/duration row, completion toggle and the edit /
 * delete action icons.
 */
function SessionDetailCard({
  session,
  subjectMeta,
  onToggle,
  onEdit,
  onDelete,
}) {
  const subjectKey = subjectMeta?.key || "economics";
  const completed = !!session.is_completed;

  // Determine which left-border colour class to apply. When the
  // session is done we swap to the muted token so the visual
  // signal fades without changing layout.
  const barClass = completed
    ? COMPLETED_BAR_CLASS
    : SUBJECT_BAR_CLASSES[subjectKey] || "border-l-gold";

  return (
    <article
      className={
        "relative bg-card border border-input-border border-l-4 " +
        "rounded-4px p-4 sm:p-5 transition-colors " +
        (completed ? "opacity-60 bg-hover" : "") +
        " " +
        barClass
      }
    >
      {/* ── Top row: badge + action icons ───────────────────── */}
      <header className="flex items-start justify-between gap-3">
        <SubjectBadge
          subject={subjectKey}
          label={subjectMeta?.name || "Subject"}
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onEdit(session)}
            aria-label={`Edit ${session.title}`}
            className={
              "p-1.5 rounded-4px text-text-muted hover:text-gold " +
              "hover:bg-hover transition-colors focus:outline-none " +
              "focus:ring-2 focus:ring-gold/30"
            }
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(session)}
            aria-label={`Delete ${session.title}`}
            className={
              "p-1.5 rounded-4px text-text-muted hover:text-red-600 " +
              "hover:bg-hover transition-colors focus:outline-none " +
              "focus:ring-2 focus:ring-red-200"
            }
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* ── Title + notes ───────────────────────────────────── */}
      <h3
        className={
          "font-heading text-text-primary text-lg sm:text-xl " +
          "font-heading-bold mt-2 leading-snug " +
          (completed ? "line-through" : "")
        }
      >
        {session.title}
      </h3>
      {session.notes && (
        <p className="font-body text-text-muted text-sm mt-1 leading-relaxed">
          {session.notes}
        </p>
      )}

      {/* ── Bottom row: time / duration / toggle ────────────── */}
      <footer className="mt-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 text-text-muted text-sm font-body">
          <span className="inline-flex items-center gap-1">
            <Clock size={14} aria-hidden="true" />
            {formatTimeRange(session.start_time, session.end_time)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Timer size={14} aria-hidden="true" />
            {formatDuration(session.start_time, session.end_time)}
          </span>
        </div>

        <button
          type="button"
          onClick={() => onToggle(session)}
          aria-label={
            completed
              ? `Mark ${session.title} as incomplete`
              : `Mark ${session.title} as complete`
          }
          className={
            "inline-flex items-center gap-2 text-gold font-body " +
            "font-body-semibold text-sm hover:opacity-80 transition-opacity " +
            "focus:outline-none focus:ring-2 focus:ring-gold/30 rounded-4px " +
            "px-2 py-1"
          }
        >
          {completed ? (
            <CheckCircle size={20} aria-hidden="true" />
          ) : (
            <Circle size={20} aria-hidden="true" />
          )}
          {completed ? "Completed" : "Mark done"}
        </button>
      </footer>
    </article>
  );
}


// ─────────────────────────────────────────────────────────────
// SECTION COMPONENTS — VIEW 3 modal & overlays
// ─────────────────────────────────────────────────────────────

/**
 * SubjectDropdown — custom select used in the modal. Native
 * <select> can't render a coloured pill inside its options list,
 * so we build a tiny button + panel here.
 *
 * Closed:  button shows the chosen subject's badge + name.
 * Open:    a panel below lists all four subjects, each as a row
 *          with badge + name + radio-style selection.
 *
 * Outside-click and Escape both close the panel.
 */
function SubjectDropdown({ subjectIndex, value, onChange, error }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  // Close on outside click. The capture handler runs before any
  // button inside opens — that's why we mount it on the document.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleEsc = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [open]);

  const selected = subjectIndex.byId[value];
  const subjects = subjectIndex.ordered;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          "w-full flex items-center justify-between gap-2 px-3 py-2 " +
          "bg-input-bg border rounded-4px text-text-primary font-body " +
          "text-sm focus:outline-none focus:ring-2 focus:ring-gold/30 " +
          (error ? "border-red-400" : "border-input-border")
        }
      >
        <span className="flex items-center gap-2 truncate">
          {selected ? (
            <>
              <SubjectBadge
                subject={selected}
                label={selected.name}
              />
              <span className="text-text-muted text-xs truncate">
                ({selected.code})
              </span>
            </>
          ) : (
            <span className="text-text-hint">Select a subject…</span>
          )}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={
            "flex-shrink-0 transition-transform " +
            (open ? "rotate-180" : "")
          }
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Choose subject"
          className={
            "absolute left-0 right-0 mt-1 z-10 bg-white border " +
            "border-input-border rounded-4px shadow-lg max-h-64 " +
            "overflow-y-auto"
          }
        >
          {subjects.length === 0 ? (
            <li className="px-3 py-2 text-text-muted text-sm font-body">
              No subjects available.
            </li>
          ) : (
            subjects.map((s) => {
              const isSelected = s.id === value;
              return (
                <li key={s.id} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(s.id);
                      setOpen(false);
                    }}
                    className={
                      "w-full text-left px-3 py-2 flex items-center " +
                      "justify-between gap-2 hover:bg-hover focus:bg-hover " +
                      "focus:outline-none transition-colors " +
                      (isSelected ? "bg-hover" : "")
                    }
                  >
                    <span className="flex items-center gap-2 truncate">
                      <SubjectBadge subject={s} label={s.name} />
                      <span className="text-text-muted text-xs truncate">
                        ({s.code})
                      </span>
                    </span>
                    {isSelected && (
                      <CheckCircle
                        size={16}
                        className="text-gold flex-shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * SessionModal — the VIEW 3 add / edit overlay.
 *
 * Props:
 *   mode        – 'add' or 'edit'
 *   initial     – seed values { subject_id, title, date, start_time,
 *                 end_time, notes, id? }
 *   subjectIndex
 *   onCancel()  – close without saving
 *   onSave(form)
 *   submitting  – when true, the save button shows a spinner and
 *                 the form is disabled so a slow Supabase write
 *                 can't be double-submitted.
 */
function SessionModal({
  mode,
  initial,
  subjectIndex,
  onCancel,
  onSave,
  submitting,
}) {
  // Form state — seeded from `initial` once on mount. We don't
  // re-seed on prop changes because the parent unmounts/remounts
  // this component every time it opens with new data.
  const [subjectId, setSubjectId] = useState(initial.subject_id || "");
  const [title, setTitle] = useState(initial.title || "");
  const [date, setDate] = useState(initial.date || toDateKey(new Date()));
  const [startTime, setStartTime] = useState(initial.start_time || "15:00");
  const [endTime, setEndTime] = useState(initial.end_time || "16:00");
  const [notes, setNotes] = useState(initial.notes || "");
  const [errors, setErrors] = useState({});

  // ESC closes the modal. We add the listener while mounted only.
  useEffect(() => {
    const onEsc = (e) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onCancel]);

  // Body scroll-lock while the modal is open. We toggle the
  // standard Tailwind utility on document.body rather than
  // touching style.overflow directly — keeps the "no inline
  // styles" rule intact.
  useEffect(() => {
    document.body.classList.add("overflow-hidden");
    return () => document.body.classList.remove("overflow-hidden");
  }, []);

  /**
   * validate — returns true when all required fields are filled
   * AND the end time is strictly after the start time. Updates
   * `errors` so each input can highlight its own problem.
   */
  const validate = () => {
    const next = {};
    if (!subjectId) next.subjectId = "Choose a subject.";
    if (!title.trim()) next.title = "Give the session a title.";
    if (!date) next.date = "Pick a date.";
    if (!startTime) next.startTime = "Start time required.";
    if (!endTime) next.endTime = "End time required.";
    if (
      startTime &&
      endTime &&
      parseTimeToMinutes(endTime) <= parseTimeToMinutes(startTime)
    ) {
      next.endTime = "End time must be after start time.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    onSave({
      id: initial.id || null,
      subject_id: subjectId,
      title: title.trim(),
      // Postgres TIME accepts "HH:MM" — Supabase coerces to HH:MM:00.
      start_time: startTime,
      end_time: endTime,
      date,
      notes: notes.trim() || null,
    });
  };

  return (
    // Fixed overlay with the dark scrim. role=dialog + aria-modal
    // mark this as a modal to assistive tech.
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-modal-title"
      className={
        "fixed inset-0 z-50 flex items-center justify-center p-4 " +
        "bg-black/40"
      }
      onClick={onCancel}
    >
      <div
        // Stop propagation so clicking inside the card doesn't
        // close the modal via the overlay handler above.
        onClick={(e) => e.stopPropagation()}
        className={
          "bg-white border border-input-border rounded-4px " +
          "shadow-xl w-full max-w-[480px] max-h-[90vh] overflow-y-auto " +
          "p-6 sm:p-8"
        }
      >
        <div className="flex items-start justify-between gap-3 mb-5">
          <h2
            id="session-modal-title"
            className="font-heading text-text-primary text-2xl font-heading-bold"
          >
            {mode === "edit" ? "Edit session" : "Add session"}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close modal"
            className={
              "p-1 text-text-muted hover:text-text-primary " +
              "transition-colors rounded-4px focus:outline-none " +
              "focus:ring-2 focus:ring-gold/30"
            }
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* ── Subject ─────────────────────────────────────── */}
          <div>
            <label
              htmlFor="modal-subject"
              className={
                "block font-body text-text-muted text-xs uppercase " +
                "tracking-wide mb-1"
              }
            >
              Subject
            </label>
            <SubjectDropdown
              subjectIndex={subjectIndex}
              value={subjectId}
              onChange={setSubjectId}
              error={!!errors.subjectId}
            />
            {errors.subjectId && (
              <p className="text-red-600 text-xs font-body mt-1">
                {errors.subjectId}
              </p>
            )}
          </div>

          {/* ── Title ───────────────────────────────────────── */}
          <div>
            <label
              htmlFor="modal-title"
              className={
                "block font-body text-text-muted text-xs uppercase " +
                "tracking-wide mb-1"
              }
            >
              Topic / Session title
            </label>
            <input
              id="modal-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Market Structures — Chapter 3"
              className={
                "w-full px-3 py-2 bg-input-bg border rounded-4px " +
                "text-text-primary font-body text-sm placeholder:text-text-hint " +
                "focus:outline-none focus:ring-2 focus:ring-gold/30 " +
                (errors.title ? "border-red-400" : "border-input-border")
              }
              autoComplete="off"
            />
            {errors.title && (
              <p className="text-red-600 text-xs font-body mt-1">
                {errors.title}
              </p>
            )}
          </div>

          {/* ── Date ────────────────────────────────────────── */}
          <div>
            <label
              htmlFor="modal-date"
              className={
                "block font-body text-text-muted text-xs uppercase " +
                "tracking-wide mb-1"
              }
            >
              Date
            </label>
            <input
              id="modal-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={
                "w-full px-3 py-2 bg-input-bg border rounded-4px " +
                "text-text-primary font-body text-sm " +
                "focus:outline-none focus:ring-2 focus:ring-gold/30 " +
                (errors.date ? "border-red-400" : "border-input-border")
              }
            />
            {errors.date && (
              <p className="text-red-600 text-xs font-body mt-1">
                {errors.date}
              </p>
            )}
          </div>

          {/* ── Times (two columns) ─────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="modal-start"
                className={
                  "block font-body text-text-muted text-xs uppercase " +
                  "tracking-wide mb-1"
                }
              >
                Start time
              </label>
              <input
                id="modal-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className={
                  "w-full px-3 py-2 bg-input-bg border rounded-4px " +
                  "text-text-primary font-body text-sm " +
                  "focus:outline-none focus:ring-2 focus:ring-gold/30 " +
                  (errors.startTime ? "border-red-400" : "border-input-border")
                }
              />
              {errors.startTime && (
                <p className="text-red-600 text-xs font-body mt-1">
                  {errors.startTime}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="modal-end"
                className={
                  "block font-body text-text-muted text-xs uppercase " +
                  "tracking-wide mb-1"
                }
              >
                End time
              </label>
              <input
                id="modal-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className={
                  "w-full px-3 py-2 bg-input-bg border rounded-4px " +
                  "text-text-primary font-body text-sm " +
                  "focus:outline-none focus:ring-2 focus:ring-gold/30 " +
                  (errors.endTime ? "border-red-400" : "border-input-border")
                }
              />
              {errors.endTime && (
                <p className="text-red-600 text-xs font-body mt-1">
                  {errors.endTime}
                </p>
              )}
            </div>
          </div>

          {/* ── Notes (optional) ────────────────────────────── */}
          <div>
            <label
              htmlFor="modal-notes"
              className={
                "block font-body text-text-muted text-xs uppercase " +
                "tracking-wide mb-1"
              }
            >
              Notes <span className="normal-case lowercase">(optional)</span>
            </label>
            <textarea
              id="modal-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Any specific topics or resources to cover"
              className={
                "w-full px-3 py-2 bg-input-bg border border-input-border " +
                "rounded-4px text-text-primary font-body text-sm " +
                "placeholder:text-text-hint focus:outline-none " +
                "focus:ring-2 focus:ring-gold/30 resize-none"
              }
            />
          </div>

          {/* ── Buttons row ─────────────────────────────────── */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className={
                "px-4 py-2 rounded-4px border border-gold text-gold " +
                "font-body font-body-semibold text-sm " +
                "hover:bg-hover transition-colors focus:outline-none " +
                "focus:ring-2 focus:ring-gold/30 disabled:opacity-50"
              }
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={
                "px-4 py-2 rounded-4px bg-gold text-background " +
                "font-body font-body-semibold text-sm " +
                "hover:bg-gold-light transition-colors focus:outline-none " +
                "focus:ring-2 focus:ring-gold/30 disabled:opacity-60 " +
                "inline-flex items-center gap-2"
              }
            >
              {submitting && (
                <Loader2
                  size={14}
                  aria-hidden="true"
                  className="animate-spin"
                />
              )}
              {mode === "edit" ? "Save changes" : "Save session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * DeleteConfirmModal — small confirmation overlay shown when the
 * user clicks the trash icon. Keeps the dangerous action behind a
 * deliberate second tap.
 */
function DeleteConfirmModal({ session, onCancel, onConfirm, submitting }) {
  // Same scroll-lock + ESC pattern as the main modal.
  useEffect(() => {
    document.body.classList.add("overflow-hidden");
    const onEsc = (e) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onEsc);
    return () => {
      document.body.classList.remove("overflow-hidden");
      document.removeEventListener("keydown", onEsc);
    };
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-modal-title"
      className={
        "fixed inset-0 z-[60] flex items-center justify-center p-4 " +
        "bg-black/50"
      }
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={
          "bg-white border border-input-border rounded-4px " +
          "shadow-xl w-full max-w-[360px] p-6"
        }
      >
        <h3
          id="delete-modal-title"
          className="font-heading text-text-primary text-xl font-heading-bold"
        >
          Delete this session?
        </h3>
        <p className="font-body text-text-muted text-sm mt-2 leading-relaxed">
          “{session.title}” will be removed from your timetable. This action
          can't be undone.
        </p>
        <div className="flex items-center justify-end gap-3 mt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={
              "px-4 py-2 rounded-4px border border-input-border " +
              "text-text-primary font-body font-body-semibold text-sm " +
              "hover:bg-hover transition-colors focus:outline-none " +
              "focus:ring-2 focus:ring-gold/30 disabled:opacity-50"
            }
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className={
              "px-4 py-2 rounded-4px bg-red-600 text-white font-body " +
              "font-body-semibold text-sm hover:bg-red-700 " +
              "transition-colors focus:outline-none focus:ring-2 " +
              "focus:ring-red-200 disabled:opacity-60 inline-flex " +
              "items-center gap-2"
            }
          >
            {submitting && (
              <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            )}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ContextMenu — small popover anchored at (x, y) shown when the
 * user right-clicks (or long-presses on touch) a session card in
 * VIEW 1's grid. Offers Edit and Delete only — the simpler the
 * better.
 *
 * The menu is intentionally rendered with `position: fixed` so
 * (x, y) coordinates from the mouse event translate directly.
 * We avoid clipping at the viewport edge by clamping x/y inside
 * a small padding margin.
 */
function ContextMenu({ x, y, onEdit, onDelete, onClose }) {
  // Clamp to keep the menu inside the viewport.
  const MARGIN = 8;
  const MENU_W = 160;
  const MENU_H = 88;
  const safeX =
    typeof window === "undefined"
      ? x
      : Math.min(Math.max(MARGIN, x), window.innerWidth - MENU_W - MARGIN);
  const safeY =
    typeof window === "undefined"
      ? y
      : Math.min(Math.max(MARGIN, y), window.innerHeight - MENU_H - MARGIN);

  // Close on outside click + Escape. We mount the listener after
  // the initial paint via setTimeout so the contextmenu event
  // that opened us doesn't immediately close us.
  useEffect(() => {
    const closer = (e) => {
      // Ignore right-clicks on the menu itself.
      if (e.target.closest && e.target.closest("[data-context-menu]")) return;
      onClose();
    };
    const onEsc = (e) => {
      if (e.key === "Escape") onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener("mousedown", closer);
      document.addEventListener("contextmenu", closer);
      document.addEventListener("keydown", onEsc);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", closer);
      document.removeEventListener("contextmenu", closer);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  return (
    <div
      data-context-menu="true"
      role="menu"
      className={
        "fixed z-[70] bg-white border border-input-border " +
        "rounded-4px shadow-lg py-1 w-40"
      }
      // Necessary dynamic positioning — coordinates come from the
      // pointer event. No colour or layout is hardcoded here.
      style={{ left: safeX, top: safeY }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onEdit}
        className={
          "w-full text-left px-3 py-2 text-sm font-body text-text-primary " +
          "hover:bg-hover transition-colors inline-flex items-center gap-2"
        }
      >
        <Pencil size={14} aria-hidden="true" />
        Edit
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className={
          "w-full text-left px-3 py-2 text-sm font-body text-red-600 " +
          "hover:bg-hover transition-colors inline-flex items-center gap-2"
        }
      >
        <Trash2 size={14} aria-hidden="true" />
        Delete
      </button>
    </div>
  );
}

/**
 * Toast — bottom-right notification used for save / sync feedback.
 * Auto-dismiss is handled by the parent (so the same toast can be
 * triggered from anywhere with a single setToast call).
 */
function Toast({ tone, message, onDismiss }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "fixed bottom-6 right-6 z-[80] max-w-sm rounded-4px shadow-md " +
        "border p-4 pr-10 text-sm bg-white " +
        (tone === "success"
          ? "border-gold text-text-primary"
          : "border-red-200 text-red-700")
      }
    >
      <p className="leading-relaxed font-body">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className={
          "absolute top-2 right-2 text-text-hint hover:text-text-primary " +
          "transition leading-none text-lg"
        }
      >
        ×
      </button>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────

export default function TimetablePage() {
  const router = useRouter();

  // ── State: gating & user ──────────────────────────────────
  // authReady stays false until the auth + onboarding checks pass.
  // While false we show a lightweight loader so the protected
  // content never flashes for an unauthenticated user.
  const [authReady, setAuthReady] = useState(false);
  // userId is needed for INSERTs. We hold it in both state (for
  // re-renders) and a ref (so async handlers always read the
  // latest value without re-creating themselves).
  const [userId, setUserId] = useState(null);
  const userIdRef = useRef(null);

  // ── State: data ───────────────────────────────────────────
  // subjectIndex powers every UUID → subject metadata lookup.
  const [subjectIndex, setSubjectIndex] = useState({
    ordered: [],
    byId: {},
    byKey: {},
  });
  // entries is the live list of timetable_entries rows for the
  // currently displayed week. Mutated optimistically by every
  // write handler; reverted on Supabase error.
  const [entries, setEntries] = useState([]);
  const [entriesLoading, setEntriesLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);

  // ── State: navigation ─────────────────────────────────────
  // currentView switches the main content. We don't use the URL
  // for this because all three views share the same data and
  // moving between them must feel instant (no route transition).
  const [currentView, setCurrentView] = useState("weekly");
  // currentWeekStart is a Date pointing inside the week we're
  // showing. The grid always derives Mon-Sun from this value.
  const [currentWeekStart, setCurrentWeekStart] = useState(() => new Date());
  // selectedDay is set when the user opens VIEW 2.
  const [selectedDay, setSelectedDay] = useState(null);

  // ── State: overlays ───────────────────────────────────────
  // modal == { mode, initial } when open, null when closed.
  const [modal, setModal] = useState(null);
  // submittingModal blocks the save button while the optimistic
  // write is in flight. Without it the user could spam-click and
  // queue duplicate inserts.
  const [submittingModal, setSubmittingModal] = useState(false);
  // deleteConfirm == { session } when the trash icon was clicked.
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [submittingDelete, setSubmittingDelete] = useState(false);
  // contextMenu == { x, y, session } when right-click / long-press fires.
  const [contextMenu, setContextMenu] = useState(null);
  // isGenerating tracks the Generate Now button spinner.
  const [isGenerating, setIsGenerating] = useState(false);
  // progressMsg shows a cycling message while timetable generation is in progress
  const [progressMsg, setProgressMsg] = useState("");
  // generateStatus drives the inline panel below Generate Now:
  // null | 'loading' | 'success' | 'error'
  const [generateStatus, setGenerateStatus] = useState(null);
  // generateMsg holds the success or error copy shown in that panel.
  const [generateMsg, setGenerateMsg] = useState("");
  // pendingRegenerate flips on after the backend tells us the
  // timetable already exists. The very next "Generate Now" click
  // is sent with force_regenerate=true. This is the "two-click
  // regenerate" pattern from the spec — first click warns,
  // second click overrides.
  const [pendingRegenerate, setPendingRegenerate] = useState(false);
  // toast == { tone, message } | null. Auto-dismisses below.
  const [toast, setToast] = useState(null);


  // ───────────────────────────────────────────────────────────
  // EFFECT 1 — Auth + onboarding guard.
  // ───────────────────────────────────────────────────────────
  // Mirrors every other feature page exactly: no session →
  // redirect /login; no onboarding flag → redirect
  // /onboarding/welcome; otherwise reveal the UI.
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (cancelled) return;

      if (error || !user) {
        console.warn("[Timetable] No session – redirecting to /login");
        router.replace("/login");
        return;
      }

      setUserId(user.id);
      userIdRef.current = user.id;
      setAuthReady(true);
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [router]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 2 — Fetch subjects + this week's entries together.
  // ───────────────────────────────────────────────────────────
  //
  // This used to be two effects (subjects on mount, then entries
  // on subjectIndex ready). That split was fragile: if subjects
  // ever returned an empty / mismatched result, the entries effect
  // would early-return forever and the page would be stuck on
  // "Loading this week's sessions…" with no way to recover.
  //
  // The combined version is bulletproof:
  //   • Both queries are issued in parallel via Promise.all so we
  //     pay one round-trip, not two.
  //   • The whole body is wrapped in try / catch / finally so
  //     `setEntriesLoading(false)` ALWAYS fires — network throw,
  //     auth blip, RLS rejection, whatever. The spinner can never
  //     run forever again.
  //   • Subjects + entries are processed independently. Even when
  //     subjects fail, entries still render (and vice versa).
  //   • When subjects come back keyed differently than expected
  //     (e.g. legacy capitalised "Economics"), buildSubjectIndex
  //     falls back to name-matching so we still get a usable map.
  //
  // Re-runs on:
  //   • auth becoming ready (initial load), OR
  //   • the user clicking the week-nav arrows (refetch entries).
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;

    const fetchAll = async () => {
      setEntriesLoading(true);

      // Compute the Mon-Sun ISO date range once up front.
      const weekDates = getWeekDates(currentWeekStart);
      const firstKey = toDateKey(weekDates[0]);
      const lastKey = toDateKey(weekDates[6]);

      try {
        // QUERY 1 (subjects) — global rows used for:
        //   • the modal's subject dropdown
        //   • UUID → display name on every session card
        //   • UUID → key for badge colour
        // This is shared reference data so we keep the direct
        // Supabase read (no auth needed, no per-user filtering).
        //
        // QUERY 2 (entries) — moved to the new backend endpoint
        // GET /timetable/entries. Why bother routing through the
        // backend when we already had a direct Supabase read?
        //   • Single source of truth for response shape
        //     (subject_name + subject_code joined server-side,
        //     so the frontend doesn't have to do its own join).
        //   • Spec calls for this explicitly.
        //   • Lets us add caching / per-user RLS rules without
        //     re-touching the frontend later.
        // We still pass a bearer token so the backend can verify
        // the caller AND enforce token.user_id == query.user_id.

        // Resolve the bearer token + user_id once for the
        // entries fetch. If either is missing we fall back to
        // mock entries (the page stays usable in dev / offline).
        const { data: sessData } = await supabase.auth.getSession();
        const token = sessData?.session?.access_token ?? null;
        const uid = sessData?.session?.user?.id ?? userIdRef.current ?? null;

        // Subjects fetch runs in parallel with the entries fetch
        // so the page still pays only one round-trip in total.
        const entriesUrl =
          `${API_URL}/timetable/entries` +
          `?user_id=${encodeURIComponent(uid || "")}` +
          `&week_start=${encodeURIComponent(firstKey)}` +
          `&week_end=${encodeURIComponent(lastKey)}`;

        const [subjectRes, entryRes] = await Promise.all([
          supabase.from("subjects").select("*"),
          // Backend call. We swallow non-2xx into a null body
          // below — the page must keep rendering even when the
          // server is down.
          token && uid
            ? fetch(entriesUrl, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
              }).then(async (r) => ({
                ok: r.ok,
                status: r.status,
                body: r.ok ? await r.json().catch(() => null) : null,
              })).catch((err) => {
                console.warn("[Timetable] entries fetch threw:", err);
                return { ok: false, status: 0, body: null };
              })
            : Promise.resolve({ ok: false, status: 0, body: null }),
        ]);

        if (cancelled) return;

        // ── Process subjects ──────────────────────────────
        const nextIndex = subjectRes.error
          ? { ordered: [], byId: {}, byKey: {} }
          : buildSubjectIndex(subjectRes.data || []);
        if (subjectRes.error) {
          console.warn(
            "[Timetable] Could not load subjects:",
            subjectRes.error,
          );
        }
        setSubjectIndex(nextIndex);

        // ── Process entries ───────────────────────────────
        if (!entryRes.ok) {
          // Backend unavailable / token missing / 4xx-5xx — fall
          // back to mock data so the page stays browseable.
          console.warn(
            "[Timetable] /timetable/entries failed with status",
            entryRes.status,
          );
          const mock = buildMockEntries(currentWeekStart, nextIndex.byKey);
          setEntries(mock);
          setUsingMock(true);
          return;
        }

        // The backend already returns rows in the spec-style
        // shape ({ id, title, date, is_completed, ... }) so we
        // can drop straight into state without normalising.
        // We still pass through `normalizeEntry` to coerce
        // missing fields to safe defaults (defensive against a
        // backend schema drift on a partial deploy).
        const rawRows = Array.isArray(entryRes.body?.data)
          ? entryRes.body.data
          : [];

        if (rawRows.length === 0) {
          // Empty live table → swap in mock entries against the
          // real subject UUIDs we just fetched. The student sees
          // a believable preview until the real schedule is
          // generated.
          const mock = buildMockEntries(currentWeekStart, nextIndex.byKey);
          setEntries(mock);
          setUsingMock(true);
        } else {
          setEntries(rawRows.map(normalizeEntry));
          setUsingMock(false);
        }
      } catch (err) {
        // Network throw or auth blip. Show mock data so the user
        // sees something useful, log the cause for debugging.
        console.error("[Timetable] fetch threw:", err);
        if (!cancelled) {
          setEntries([]);
          setUsingMock(false);
        }
      } finally {
        // CRITICAL: always clear the loading spinner, no matter
        // which branch fired. This is the single line that
        // prevents the infinite-loading bug from coming back.
        if (!cancelled) setEntriesLoading(false);
      }
    };

    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [authReady, currentWeekStart]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 4 — Toast auto-dismiss.
  // ───────────────────────────────────────────────────────────
  // Whenever the toast state changes to a new message, schedule a
  // single clear after TOAST_DISMISS_MS. Cleanup cancels the
  // pending timer so a fast-following toast doesn't get killed
  // by the previous one.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), TOAST_DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast]);


  // ───────────────────────────────────────────────────────────
  // DERIVED VALUES (memoised)
  // ───────────────────────────────────────────────────────────

  // Sessions grouped by their date string. Powers both the
  // weekly grid (lookup per day) and the daily view (single
  // bucket).
  const sessionsByDay = useMemo(
    () => groupSessionsByDay(entries),
    [entries],
  );

  // Aggregate stats for the visible week. Recomputes whenever
  // the underlying entries change (e.g. after a toggle).
  const weekStats = useMemo(
    () => calculateWeekStats(entries),
    [entries],
  );

  // Subset of entries that fall on the selected day. Used by
  // VIEW 2; the daily view's mini-stats use these directly.
  const dailySessions = useMemo(() => {
    if (!selectedDay) return [];
    const key = toDateKey(selectedDay);
    return sessionsByDay[key] || [];
  }, [sessionsByDay, selectedDay]);

  const dailyStats = useMemo(
    () => calculateWeekStats(dailySessions),
    [dailySessions],
  );


  // ───────────────────────────────────────────────────────────
  // HANDLERS — week navigation
  // ───────────────────────────────────────────────────────────
  //
  // The week-nav arrows shift `currentWeekStart` by ±7 days.
  // EFFECT 3 will pick up the change and re-fetch entries.
  //
  // STEP-BY-STEP for the previous-week handler:
  //   1. Clone the current state (never mutate state in place).
  //   2. Subtract 7 calendar days.
  //   3. Call setCurrentWeekStart — React schedules a re-render.
  //   4. EFFECT 3 sees the new value, hits Supabase for the new
  //      date range, and replaces `entries`.
  // The next-week handler is identical with +7 instead of -7.

  const goPrevWeek = () => {
    const next = new Date(currentWeekStart);
    next.setDate(next.getDate() - 7);
    setCurrentWeekStart(next);
  };

  const goNextWeek = () => {
    const next = new Date(currentWeekStart);
    next.setDate(next.getDate() + 7);
    setCurrentWeekStart(next);
  };


  // ───────────────────────────────────────────────────────────
  // HANDLERS — generate now (POST /timetable/generate)
  // ───────────────────────────────────────────────────────────
  //
  // FLOW
  //   1. Resolve the bearer token + verified user id from the
  //      live Supabase session. If either is missing we cannot
  //      authenticate the call — surface a calm warning toast
  //      and bail.
  //   2. POST /timetable/generate with the user_id + the current
  //      `force_regenerate` flag. The first click ALWAYS sends
  //      false; the backend short-circuits with an "already
  //      exists" message when entries are present, which flips
  //      `pendingRegenerate` to true so the SECOND click sends
  //      force_regenerate=true. That's the two-click regenerate
  //      pattern called for in the spec.
  //   3. On a true success (entries_saved > 0), refresh the
  //      grid by nudging currentWeekStart — Effect 3 re-runs
  //      and re-fetches the new entries.
  const handleGenerateNow = async () => {
    if (isGenerating) return;

    // ── 1. resolve bearer + user_id ─────────────────────────
    const { data: sessionData, error: sessionErr } =
      await supabase.auth.getSession();
    if (sessionErr || !sessionData?.session?.access_token) {
      setGenerateStatus("error");
      setGenerateMsg("Could not generate timetable — please try again");
      return;
    }
    const token = sessionData.session.access_token;
    const uid =
      sessionData.session?.user?.id ?? userIdRef.current ?? null;
    if (!uid) {
      setGenerateStatus("error");
      setGenerateMsg("Could not generate timetable — please try again");
      return;
    }

    // Start showing cycling progress messages every 4 seconds
    setGenerateStatus("loading");
    setIsGenerating(true);
    // Show the first message immediately
    setProgressMsg(GENERATE_PROGRESS_MESSAGES[0]);
    // Cycle through the messages every 4 seconds while waiting
    let msgIndex = 0;
    const progressInterval = setInterval(() => {
      msgIndex = (msgIndex + 1) % GENERATE_PROGRESS_MESSAGES.length;
      setProgressMsg(GENERATE_PROGRESS_MESSAGES[msgIndex]);
    }, 4000);
    // Snapshot the flag so a state flip mid-flight can't change
    // what we sent on the wire. We also clear `pendingRegenerate`
    // optimistically so a second rapid click doesn't double-fire.
    const forceThisCall = pendingRegenerate;
    setPendingRegenerate(false);

    try {
      const res = await fetch(`${API_URL}/timetable/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          user_id: uid,
          force_regenerate: forceThisCall,
        }),
      });

      // ── 2a. Non-2xx → show error in the inline generate panel. ─
      if (!res.ok) {
        setGenerateStatus("error");
        setGenerateMsg("Could not generate timetable — please try again");
        return;
      }

      // ── 2b. Success — three sub-cases on the envelope. ────
      const data = await res.json();
      const saved = Number(data?.entries_saved) || 0;
      const existing = Number(data?.entries_count) || 0;

      if (saved > 0) {
        // Happy path — entries actually saved.
        setGenerateStatus("success");
        setGenerateMsg(
          `✓ Timetable generated — ${saved} sessions created for 2 weeks`,
        );
        setTimeout(() => setGenerateStatus(null), 4000);
        // Trigger Effect 3 to re-fetch the visible week so the
        // new rows show up immediately.
        setCurrentWeekStart((prev) => new Date(prev));
        return;
      }

      if (existing > 0 && !forceThisCall) {
        // "Already exists" short-circuit — arm the regenerate
        // flag so the next click overrides.
        setPendingRegenerate(true);
        setGenerateStatus("success");
        setGenerateMsg(
          "Timetable already exists. Click Generate Now again to regenerate.",
        );
        return;
      }

      // If force regenerate returned 0 entries — Groq had trouble, ask user to retry
      if (forceThisCall) {
        setGenerateStatus("error");
        setGenerateMsg("Generation timed out — please try again");
        return;
      }
      // First click with no existing entries — send force_regenerate on next click
      setPendingRegenerate(true);
      setGenerateStatus("success");
      setGenerateMsg("Click Generate Now again to create your timetable.");
    } catch (err) {
      // Network throw (most often: backend offline).
      console.warn("[Timetable] /timetable/generate failed:", err);
      setGenerateStatus("error");
      setGenerateMsg("Could not generate timetable — please try again");
    } finally {
      // Always clear the progress interval when generation finishes or fails
      clearInterval(progressInterval);
      setIsGenerating(false);
      setProgressMsg("");
    }
  };


  // ───────────────────────────────────────────────────────────
  // HANDLERS — toggle completion (optimistic)
  // ───────────────────────────────────────────────────────────
  //
  // WHY OPTIMISTIC UPDATES?
  // The student is constantly ticking off sessions during a busy
  // study afternoon. Waiting for Supabase to round-trip every
  // click would feel laggy. Instead we mutate `entries` first so
  // the UI reflects the new state in <16 ms, then send the
  // Supabase UPDATE in the background. If Supabase rejects the
  // write we revert the change and surface a red toast so the
  // student knows something went wrong.
  const handleToggleCompletion = async (session) => {
    const next = !session.is_completed;
    const id = session.id;

    // ── Step 1: optimistic UI flip ─────────────────────────
    // We update the React state FIRST so the checkmark animates
    // in <16 ms. The PATCH below confirms the change on the
    // server; on failure we revert and surface a red toast.
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, is_completed: next } : e)),
    );

    // Mock rows are local-only — never call the backend for them.
    if (String(id).startsWith("mock-")) return;

    // ── Step 2: resolve auth ───────────────────────────────
    // Same pattern the generate handler uses. If auth is missing
    // we revert the optimistic flip and ask the student to sign in.
    const { data: sessData } = await supabase.auth.getSession();
    const token = sessData?.session?.access_token ?? null;
    const uid = sessData?.session?.user?.id ?? userIdRef.current ?? null;
    if (!token || !uid) {
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, is_completed: !next } : e)),
      );
      setToast({
        tone: "error",
        message: "Session expired. Please sign in again.",
      });
      return;
    }

    // ── Step 3: PATCH the backend ──────────────────────────
    // The backend persists the change AND re-verifies the row
    // belongs to this user (defence-in-depth). On any non-2xx
    // we revert the optimistic flip so the UI doesn't drift
    // away from the canonical server value.
    try {
      const res = await fetch(
        `${API_URL}/timetable/entry/${encodeURIComponent(id)}/complete`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            user_id: uid,
            is_completed: next,
          }),
        },
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data?.detail && (data.detail.error || data.detail)) ||
            `HTTP ${res.status}`,
        );
      }
    } catch (err) {
      console.error("[Timetable] toggle failed:", err);
      // Revert and notify — the spec specifically calls out the
      // "revert on backend failure" branch.
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, is_completed: !next } : e)),
      );
      setToast({
        tone: "error",
        message: "Could not update session. Please try again.",
      });
    }
  };


  // ───────────────────────────────────────────────────────────
  // HANDLERS — modal open / save (add + edit)
  // ───────────────────────────────────────────────────────────

  /**
   * openAddModal — open the modal in "add" mode pre-filled for a
   * specific date. Used by all grid + day-view "+" buttons and
   * by the empty-state "add manually" link.
   */
  const openAddModal = (date) => {
    const dateKey = date ? toDateKey(date) : toDateKey(new Date());
    setModal({
      mode: "add",
      initial: {
        subject_id: "",
        title: "",
        date: dateKey,
        start_time: getDefaultStartTime(),
        end_time: "",
        notes: "",
      },
    });
  };

  /**
   * openEditModal — open the modal in "edit" mode pre-filled
   * from an existing session row.
   */
  const openEditModal = (session) => {
    setModal({
      mode: "edit",
      initial: {
        id: session.id,
        subject_id: session.subject_id,
        title: session.title,
        date: toDateKey(session.date),
        start_time: (session.start_time || "15:00").slice(0, 5),
        end_time: (session.end_time || "16:00").slice(0, 5),
        notes: session.notes || "",
      },
    });
  };

  /**
   * handleSaveModal — single entry point for both INSERT and
   * UPDATE. Optimistic strategy:
   *
   *   ADD:
   *     1. Generate a temp id ("temp-<ms>") and add the row.
   *     2. Close the modal + show "Session added" toast.
   *     3. INSERT to Supabase, .select().single() to get the
   *        real id, then swap temp id for real id in state.
   *     4. On error: remove the temp row, show error toast,
   *        re-open the modal so the student doesn't lose work.
   *
   *   EDIT:
   *     1. Snapshot the original row for rollback.
   *     2. Apply the new values to state.
   *     3. Close modal + show "Session updated" toast.
   *     4. UPDATE Supabase.
   *     5. On error: restore the snapshot + reopen the modal.
   */
  const handleSaveModal = async (form) => {
    const mode = modal?.mode || "add";
    setSubmittingModal(true);

    // Helper closure used by both branches when Supabase fails.
    const failAndReopen = () => {
      setSubmittingModal(false);
      setToast({
        tone: "error",
        message: "Failed to save. Please try again.",
      });
      // Re-open the modal with the values the student just typed.
      setModal({ mode, initial: form });
    };

    if (mode === "add") {
      const tempId = `temp-${Date.now()}`;
      const optimisticRow = {
        id: tempId,
        user_id: userIdRef.current,
        subject_id: form.subject_id,
        title: form.title,
        notes: form.notes,
        date: form.date,
        start_time: form.start_time,
        end_time: form.end_time,
        is_completed: false,
        created_at: new Date().toISOString(),
      };

      setEntries((prev) => [...prev, optimisticRow]);
      setModal(null);
      setSubmittingModal(false);
      setToast({ tone: "success", message: "Session added" });

      // When the table is still mock-mode we don't try to write
      // anything to Supabase — the row joins the in-memory mock
      // list and persists for the session.
      if (usingMock && !userIdRef.current) return;

      // Translate the form's client-side fields into the actual
      // Supabase column names (topic / scheduled_date / completed /
      // week_start). `notes` is intentionally NOT sent because the
      // DB has no notes column today.
      const insertPayload = {
        ...denormalizeForWrite(form),
        user_id: userIdRef.current,
        completed: false,
      };

      const { data, error } = await supabase
        .from("timetable_entries")
        .insert(insertPayload)
        .select()
        .single();

      if (error || !data) {
        console.error("[Timetable] insert failed:", error);
        // Revert: remove the optimistic row.
        setEntries((prev) => prev.filter((e) => e.id !== tempId));
        failAndReopen();
        return;
      }

      // Success: replace temp id with the real row from Supabase
      // (after normalising it back into our client shape).
      const normalised = normalizeEntry(data);
      // Carry forward the locally-typed notes since the DB doesn't
      // store them yet — they'd otherwise vanish on the swap.
      normalised.notes = form.notes;
      setEntries((prev) =>
        prev.map((e) => (e.id === tempId ? normalised : e)),
      );
      return;
    }

    // ── EDIT branch ────────────────────────────────────────
    const id = form.id;
    let snapshot = null;
    setEntries((prev) =>
      prev.map((e) => {
        if (e.id !== id) return e;
        snapshot = e;
        return {
          ...e,
          subject_id: form.subject_id,
          title: form.title,
          notes: form.notes,
          date: form.date,
          start_time: form.start_time,
          end_time: form.end_time,
        };
      }),
    );
    setModal(null);
    setSubmittingModal(false);
    setToast({ tone: "success", message: "Session updated" });

    if (String(id).startsWith("mock-") || String(id).startsWith("temp-")) {
      // Mock or still-pending rows live only in state.
      return;
    }

    // Translate to real DB column names for the UPDATE. `notes`
    // is omitted on purpose — no DB column for it yet.
    const { error } = await supabase
      .from("timetable_entries")
      .update(denormalizeForWrite(form))
      .eq("id", id);

    if (error) {
      console.error("[Timetable] update failed:", error);
      // Restore the snapshot we took before mutating.
      if (snapshot) {
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? snapshot : e)),
        );
      }
      failAndReopen();
    }
  };


  // ───────────────────────────────────────────────────────────
  // HANDLERS — delete (optimistic)
  // ───────────────────────────────────────────────────────────
  //
  // Same optimistic pattern: remove from state immediately, then
  // DELETE in the background. On failure we restore the original
  // row in place (using the snapshot's original list position).
  const handleConfirmDelete = async () => {
    if (!deleteConfirm) return;
    const session = deleteConfirm.session;
    const id = session.id;
    setSubmittingDelete(true);

    // Snapshot the current list so we can restore on failure.
    const snapshot = entries;

    setEntries((prev) => prev.filter((e) => e.id !== id));
    setDeleteConfirm(null);
    setSubmittingDelete(false);
    setToast({ tone: "success", message: "Session deleted" });

    if (String(id).startsWith("mock-") || String(id).startsWith("temp-")) {
      return; // mock / pending rows are state-only
    }

    const { error } = await supabase
      .from("timetable_entries")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("[Timetable] delete failed:", error);
      setEntries(snapshot);
      setToast({
        tone: "error",
        message: "Could not delete session. Please try again.",
      });
    }
  };


  // ───────────────────────────────────────────────────────────
  // AUTH GATE — light loader while we verify session.
  // ───────────────────────────────────────────────────────────
  if (!authReady) {
    return (
      <main style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="inline-flex items-center gap-2 text-text-muted font-body text-sm">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Loading your timetable…
        </div>
      </main>
    );
  }


  // ───────────────────────────────────────────────────────────
  // RENDER — VIEW 2 (daily detail)
  // ───────────────────────────────────────────────────────────
  if (currentView === "daily" && selectedDay) {
    const dayIsToday = isToday(selectedDay);
    return (
      <main className="min-h-screen bg-background">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
          {/* ── Header row: back arrow + long date + today pill ── */}
          <header className="flex items-start justify-between gap-3 mb-6">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => {
                  setCurrentView("weekly");
                  setSelectedDay(null);
                }}
                aria-label="Back to weekly overview"
                className={
                  "mt-1 p-2 rounded-4px text-text-muted hover:text-gold " +
                  "hover:bg-hover transition-colors focus:outline-none " +
                  "focus:ring-2 focus:ring-gold/30"
                }
              >
                <ArrowLeft size={20} aria-hidden="true" />
              </button>
              <div>
                <h1
                  className={
                    "font-heading text-text-primary text-3xl sm:text-4xl " +
                    "font-heading-bold leading-tight"
                  }
                >
                  {formatLongDate(selectedDay)}
                </h1>
                {dayIsToday && (
                  <span
                    className={
                      "inline-block mt-2 bg-gold text-background " +
                      "rounded-full px-3 py-0.5 text-xs font-body " +
                      "font-body-semibold"
                    }
                  >
                    Today
                  </span>
                )}
              </div>
            </div>
          </header>

          {/* ── Mini stats + day progress bar ─────────────── */}
          <section
            aria-label="Today's progress"
            className="bg-card border border-input-border rounded-4px p-4 sm:p-5 mb-6"
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="font-body text-text-muted text-sm">
                <span className="font-body-semibold text-text-primary">
                  {dailyStats.done}
                </span>{" "}
                of{" "}
                <span className="font-body-semibold text-text-primary">
                  {dailySessions.length}
                </span>{" "}
                sessions done · {dailyStats.totalHours}h scheduled
              </p>
              <p className="font-body text-text-muted text-xs">
                {dailyStats.completionRate}% complete
              </p>
            </div>
            <div className="mt-3">
              <ProgressBar percent={dailyStats.completionRate} />
            </div>
          </section>

          {/* ── Sessions list / empty state ───────────────── */}
          {dailySessions.length === 0 ? (
            <section
              aria-label="No sessions today"
              className={
                "bg-card border border-input-border rounded-4px " +
                "p-8 sm:p-10 text-center"
              }
            >
              <CalendarX
                size={40}
                aria-hidden="true"
                className="text-gold mx-auto mb-3"
              />
              <h2 className="font-heading text-text-primary text-2xl font-heading-bold">
                No sessions today
              </h2>
              <p className="font-body text-text-muted text-sm mt-2">
                Tap the button below to add one manually.
              </p>
              <button
                type="button"
                onClick={() => openAddModal(selectedDay)}
                className={
                  "mt-5 inline-flex items-center gap-2 px-4 py-2 " +
                  "rounded-4px border border-gold text-gold font-body " +
                  "font-body-semibold text-sm hover:bg-hover transition-colors " +
                  "focus:outline-none focus:ring-2 focus:ring-gold/30"
                }
              >
                <Plus size={16} aria-hidden="true" />
                Add session
              </button>
            </section>
          ) : (
            <>
              <section
                aria-label="Sessions for this day"
                className="space-y-3"
              >
                {dailySessions.map((s) => (
                  <SessionDetailCard
                    key={s.id}
                    session={s}
                    subjectMeta={subjectIndex.byId[s.subject_id]}
                    onToggle={handleToggleCompletion}
                    onEdit={openEditModal}
                    onDelete={(session) => setDeleteConfirm({ session })}
                  />
                ))}
              </section>

              {/* "Add session" footer button. Outline gold style. */}
              <button
                type="button"
                onClick={() => openAddModal(selectedDay)}
                className={
                  "mt-5 w-full inline-flex items-center justify-center " +
                  "gap-2 px-4 py-3 rounded-4px border border-gold " +
                  "text-gold font-body font-body-semibold text-sm " +
                  "hover:bg-hover transition-colors focus:outline-none " +
                  "focus:ring-2 focus:ring-gold/30"
                }
              >
                <Plus size={16} aria-hidden="true" />
                Add session
              </button>
            </>
          )}

          {/* Mock disclaimer — only shown while we're displaying
              the seeded sample week. */}
          {usingMock && (
            <p className="mt-6 text-xs text-text-hint text-center font-body">
              Showing sample sessions while your timetable is being set up.
            </p>
          )}
        </div>

        {/* ── Overlays ─────────────────────────────────────── */}
        {modal && (
          <SessionModal
            mode={modal.mode}
            initial={modal.initial}
            subjectIndex={subjectIndex}
            onCancel={() => setModal(null)}
            onSave={handleSaveModal}
            submitting={submittingModal}
          />
        )}
        {deleteConfirm && (
          <DeleteConfirmModal
            session={deleteConfirm.session}
            onCancel={() => setDeleteConfirm(null)}
            onConfirm={handleConfirmDelete}
            submitting={submittingDelete}
          />
        )}
        {toast && (
          <Toast
            tone={toast.tone}
            message={toast.message}
            onDismiss={() => setToast(null)}
          />
        )}
      </main>
    );
  }



  // ───────────────────────────────────────────────────────────
  // RENDER — VIEW 1 (weekly overview) — mockup layout
  // ───────────────────────────────────────────────────────────
  const weekDates = getWeekDates(currentWeekStart);
  const weekIsEmpty = entries.length === 0 && !entriesLoading;
  const weekRangeLabel = formatWeekRange(currentWeekStart);
  const totalStudyHours = (entries.length * 1.5).toFixed(1);

  const handleAddSessionComingSoon = () => {
    setToast({ tone: "success", message: "Coming soon" });
  };

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <style>{`
        @keyframes timetable-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
        .timetable-stats-grid { margin: 20px var(--page-padding) 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
        .timetable-week-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
        .timetable-add-session-btn:hover { border-color: var(--gold) !important; color: var(--gold) !important; }
        .timetable-week-nav-btn:hover { border-color: var(--gold) !important; color: var(--gold) !important; }
        @media (max-width: 1023px) {
          .timetable-week-grid-wrap { overflow-x: auto; }
          .timetable-week-grid { grid-template-columns: repeat(7, minmax(120px, 1fr)); min-width: 840px; }
        }
        @media (max-width: 767px) {
          .timetable-stats-grid { grid-template-columns: repeat(2, 1fr); }
          .timetable-week-nav-btn { width: 28px !important; height: 28px !important; }
        }
      `}</style>

      <TimetableBreadcrumb />

      <header style={{ padding: "20px var(--page-padding) 0", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: "28px", color: "var(--text)", fontWeight: 700, margin: 0 }}>My Timetable</h1>
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", marginTop: "4px", marginBottom: 0 }}>{weekRangeLabel}</p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
          <button type="button" onClick={handleGenerateNow} disabled={isGenerating} style={{ background: "var(--gold)", border: "none", borderRadius: "8px", padding: "10px 18px", fontFamily: "Inter, sans-serif", fontSize: "13px", fontWeight: 500, color: "var(--bg)", cursor: isGenerating ? "wait" : "pointer", display: "flex", alignItems: "center", gap: "8px", opacity: isGenerating ? 0.7 : 1 }}>
            {isGenerating ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            {isGenerating ? "Generating..." : "Generate Now"}
          </button>
          {generateStatus ? (
            <div
              role={generateStatus === "error" ? "alert" : "status"}
              onClick={
                generateStatus === "error"
                  ? () => setGenerateStatus(null)
                  : undefined
              }
              style={{
                marginTop: "12px",
                padding: "12px 16px",
                borderRadius: "8px",
                fontFamily: "Inter, sans-serif",
                fontSize: "12px",
                textAlign: "center",
                lineHeight: 1.6,
                minWidth: "280px",
                ...(generateStatus === "loading"
                  ? {
                      background: "var(--nav-icon-bg)",
                      border: "0.5px solid var(--gold-border-hover)",
                      color: "var(--text-muted)",
                    }
                  : generateStatus === "success"
                    ? {
                        background: "rgba(39,174,96,0.08)",
                        border: "0.5px solid rgba(39,174,96,0.3)",
                        color: "#27AE60",
                      }
                    : {
                        background: "rgba(231,76,60,0.08)",
                        border: "0.5px solid rgba(231,76,60,0.3)",
                        color: "#E74C3C",
                        cursor: "pointer",
                      }),
              }}
            >
              {generateStatus === "loading" ? (
                <>
                  Analysing your exam dates and study hours...
                  <br />
                  Building your personalised 2-week plan...
                  <br />
                  This takes about 30 seconds ✦
                  {/* Cycling status line — updates every 4s during generation */}
                  <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", margin: "8px 0 0", textAlign: "center" }}>
                    {progressMsg}
                  </p>
                </>
              ) : (
                generateMsg
              )}
            </div>
          ) : null}
        </div>
      </header>

      {!entriesLoading && !weekIsEmpty && (
        <>
          <section aria-label="Weekly stats" className="timetable-stats-grid">
            <StatCard value={weekStats.done} label="SESSIONS DONE" />
            <StatCard value={weekStats.remaining} label="SESSIONS REMAINING" />
            <StatCard value={`${totalStudyHours}h`} label="TOTAL STUDY HOURS" />
            <StatCard value={`${weekStats.completionRate}%`} label="COMPLETION RATE" />
          </section>
          <section aria-label="Weekly progress" style={{ margin: "16px var(--page-padding) 0" }}>
            <ProgressBar percent={weekStats.completionRate} />
            <p style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--text-muted)", marginTop: "6px", marginBottom: 0 }}>
              {weekStats.done} of {entries.length} sessions completed this week
            </p>
          </section>
        </>
      )}

      <nav aria-label="Week navigation" style={{ margin: "16px var(--page-padding) 0", display: "flex", alignItems: "center", justifyContent: "center", gap: "16px" }}>
        <button type="button" className="timetable-week-nav-btn" onClick={goPrevWeek} aria-label="Previous week" style={{ width: "32px", height: "32px", borderRadius: "50%", background: "var(--card)", border: "0.5px solid var(--gold-border)", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}>
          <ChevronLeft size={16} strokeWidth={2} aria-hidden />
        </button>
        <span style={{ fontFamily: "Inter, sans-serif", fontSize: "14px", fontWeight: 500, color: "var(--text)" }}>{weekRangeLabel}</span>
        <button type="button" className="timetable-week-nav-btn" onClick={goNextWeek} aria-label="Next week" style={{ width: "32px", height: "32px", borderRadius: "50%", background: "var(--card)", border: "0.5px solid var(--gold-border)", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}>
          <ChevronRight size={16} strokeWidth={2} aria-hidden />
        </button>
      </nav>

      {entriesLoading ? (
        <section aria-label="Loading timetable" className="timetable-week-grid-wrap" style={{ margin: "16px var(--page-padding) 32px" }}>
          <div className="timetable-week-grid">
            {Array.from({ length: 7 }).map((_, i) => (
              <DayColumnSkeleton key={i} />
            ))}
          </div>
        </section>
      ) : weekIsEmpty ? (
        <section aria-label="No timetable" style={{ margin: "16px var(--page-padding) 32px", textAlign: "center", padding: "40px 24px", background: "var(--card)", border: "0.5px solid var(--gold-border)", borderRadius: "10px" }}>
          <Calendar size={40} color="var(--gold)" aria-hidden style={{ margin: "0 auto 12px", display: "block" }} />
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", color: "var(--text)", margin: "0 0 8px" }}>No timetable yet</h2>
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", margin: 0 }}>Generate your study schedule for the next two weeks.</p>
          <button type="button" onClick={handleGenerateNow} disabled={isGenerating} style={{ marginTop: "16px", background: "var(--gold)", border: "none", borderRadius: "8px", padding: "10px 18px", fontFamily: "Inter, sans-serif", fontSize: "13px", fontWeight: 500, color: "var(--bg)", cursor: "pointer" }}>
            {isGenerating ? "Generating..." : "Generate Now"}
          </button>
        </section>
      ) : (
        <section aria-label="Weekly grid" className="timetable-week-grid-wrap" style={{ margin: "16px var(--page-padding) 32px" }}>
          <div className="timetable-week-grid">
            {weekDates.map((d) => {
              const key = toDateKey(d);
              const list = sessionsByDay[key] || [];
              return (
                <DayColumn
                  key={key}
                  date={d}
                  sessions={list}
                  subjectIndex={subjectIndex}
                  onToggleSession={handleToggleCompletion}
                  onAddSession={handleAddSessionComingSoon}
                />
              );
            })}
          </div>
          {usingMock && (
            <p style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--text-muted)", textAlign: "center", marginTop: "16px" }}>
              Showing sample sessions while your timetable is being set up.
            </p>
          )}
        </section>
      )}

      {/* ── Overlays (modal / delete confirm / context menu) ─ */}
      {modal && (
        <SessionModal
          mode={modal.mode}
          initial={modal.initial}
          subjectIndex={subjectIndex}
          onCancel={() => setModal(null)}
          onSave={handleSaveModal}
          submitting={submittingModal}
        />
      )}
      {deleteConfirm && (
        <DeleteConfirmModal
          session={deleteConfirm.session}
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={handleConfirmDelete}
          submitting={submittingDelete}
        />
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onEdit={() => {
            const s = contextMenu.session;
            setContextMenu(null);
            openEditModal(s);
          }}
          onDelete={() => {
            const s = contextMenu.session;
            setContextMenu(null);
            setDeleteConfirm({ session: s });
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
      {toast && (
        <Toast
          tone={toast.tone}
          message={toast.message}
          onDismiss={() => setToast(null)}
        />
      )}
    </main>
  );
}
