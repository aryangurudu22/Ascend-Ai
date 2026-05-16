// ============================================================
// FILE: app/features/notes/page.js
// PURPOSE: Note Summariser — a read-only "personal notebook"
//          that fills itself automatically.
//
// HOW IT WORKS AT A GLANCE
// ----------------------------------------------------------------
// Behind the scenes, an n8n workflow polls the student's Google
// Classroom every 30 minutes, sends new posts to the FastAPI
// backend, which asks Groq to summarise them into structured notes
// and saves the result to the Supabase `notes` table. This page
// simply reads those notes and shows them grouped by subject.
//
// THE STUDENT NEVER TYPES ON THIS PAGE.
// She opens it, scans her latest summaries, and optionally clicks
// "Sync Now" to ask the backend to re-poll Google Classroom early.
//
// EVERYTHING IS DRIVEN BY DATABASE TOKENS:
//   • Subject names come from the Supabase `subjects` table.
//   • Subject UUIDs are NEVER hardcoded — mock notes are generated
//     after the real subjects load, attaching to real UUIDs.
//   • Every colour comes from tailwind.config.js — no hex literals.
//   • The page is protected at the proxy level (see /proxy.js).
//     The client-side auth check here is defence-in-depth and
//     mirrors the dashboard's pattern exactly.
// ============================================================

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useInView } from "framer-motion";
import { supabase } from "../../../lib/supabaseClient";
import { getSubjectByKey, SUBJECTS } from "../../../lib/subjects";
import SubjectBadge from "../../components/SubjectBadge";
import { staggerContainer, staggerItem } from "../../lib/animations";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
// All "magic strings" live here so they only have to change in
// one place if the rule ever changes. Nothing here is a real
// piece of subject or note data — those come from the database.

// localStorage key that the onboarding flow sets to "true" on the
// final step. Same key the dashboard reads. Defined once so we
// never re-type it (no hardcoded strings scattered around).
const ONBOARDING_KEY = "ascendai_onboarding_completed";

// FastAPI backend base URL. Pulled from .env.local. We fall back
// to localhost so the page still works during local development
// even if the env var is missing.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";

// Sentinel value used by the filter tabs to mean "show every
// subject". Anything OTHER than this is a subject key (e.g.
// "economics") that comes from lib/subjects.js / the DB.
const FILTER_ALL = "all";

// How long the bottom-right toast stays on screen before vanishing.
const TOAST_DISMISS_MS = 4000;

// How many skeleton cards to show while the notes are loading.
// Six fills a typical desktop grid neatly without being slow on
// mobile (where only one column is shown anyway).
const SKELETON_COUNT = 6;

// Placeholder notes when the list is empty — same pattern as the dashboard
const PLACEHOLDER_NOTES = [
  {
    id: "p1",
    subject: "economics",
    title: "Market Failure — Types and Government Response",
    summary:
      "Market failure occurs when the free market fails to allocate resources efficiently...",
    key_points: [
      "Public goods are non-rivalrous",
      "Externalities cause market failure",
      "Government intervention corrects failures",
    ],
    created_at: new Date().toISOString(),
  },
  {
    id: "p2",
    subject: "business",
    title: "The Marketing Mix — Four Ps",
    summary:
      "Product, Price, Place, Promotion — the four controllable elements...",
    key_points: [
      "Product strategy drives brand",
      "Pricing affects demand",
      "Place ensures accessibility",
    ],
    created_at: new Date().toISOString(),
  },
  {
    id: "p3",
    subject: "english",
    title: "Analysing Tone with CLS Framework",
    summary:
      "Context, Language, Structure framework for analytical essays...",
    key_points: [
      "Context sets the scene",
      "Language reveals intent",
      "Structure shapes meaning",
    ],
    created_at: new Date().toISOString(),
  },
];

// Supabase table that stores generated revision flashcards. Used
// here to compute the "Cards exist for this note" badge — we read
// the distinct set of `topic` values (which our backend stores as
// the source note's title — see backend/routers/flashcards.py for
// the SCHEMA-NOTE explaining why title-as-topic is the link key).
const FLASHCARDS_TABLE = "flashcards";

// How long the per-note "Cards generated" success state stays
// visible on the button before reverting to "Cards exist". Spec:
// 3 seconds.
const GENERATE_SUCCESS_LINGER_MS = 3000;


// ─────────────────────────────────────────────────────────────
// HELPER: formatNoteDate
// ─────────────────────────────────────────────────────────────
// Converts an ISO timestamp ("2026-05-14T10:00:00.000+00:00")
// into a friendly UK date like "14 May 2026". Returns "—" when
// the input is missing or unparseable so the UI never crashes
// on a malformed row from the database.
function formatNoteDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}


// ─────────────────────────────────────────────────────────────
// HELPER: stripMarkdown
// ─────────────────────────────────────────────────────────────
// Defensive: even though the AI summarisation prompt explicitly
// forbids Markdown, an LLM can still slip in a `**bold**` or
// `## heading`. This strips those symbols so the student never
// sees a raw `**` or `##` in her notes. Line breaks are preserved
// because the summary card uses `whitespace-pre-line` for display.
function stripMarkdown(text) {
  if (!text) return "";
  return String(text)
    .replace(/\*\*/g, "")      // bold markers
    .replace(/__/g, "")        // alternate bold markers
    .replace(/^#{1,6}\s+/gm, "") // ATX headings (## Heading)
    .replace(/^>\s+/gm, "")    // blockquotes
    .replace(/`/g, "");        // inline code ticks
}


// ─────────────────────────────────────────────────────────────
// HELPER: buildSubjectIndex
// ─────────────────────────────────────────────────────────────
// Given the rows returned by `SELECT * FROM subjects`, walk the
// local SUBJECTS list (lib/subjects.js) in its declared order
// and find the matching DB row for each. We cross-reference
// because:
//
//   • The DB row supplies the source-of-truth NAME and UUID.
//   • The local SUBJECTS list supplies the `key` that we need
//     to pick the right colour scheme via SubjectBadge.
//
// The matcher is loose on purpose: it accepts a match against
// either the `name` ("Economics") or the syllabus `code` ("9708")
// column. This is the same matcher used by the homework page so
// the behaviour stays consistent across the app.
//
// Returns three views of the same data so callers can pick the
// shape that fits their use-case without re-walking the list:
//
//   ordered : [{ id, name, key }]            (for tab rendering)
//   byId    : { uuid: { name, key } }        (for note lookup)
//   byKey   : { key: { id, name } }          (for mock generation)
function buildSubjectIndex(dbRows) {
  const ordered = [];
  const byId = {};
  const byKey = {};

  if (!Array.isArray(dbRows)) {
    return { ordered, byId, byKey };
  }

  for (const local of SUBJECTS) {
    // All the strings that could legitimately identify this
    // subject — lowercased so the comparison is case-insensitive.
    const candidates = [
      local.key,
      local.slug,
      local.name,
      local.fullName,
      local.code,
    ]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());

    const row = dbRows.find((r) => {
      const rowValues = [r.name, r.code]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      return rowValues.some((v) => candidates.includes(v));
    });

    if (row?.id) {
      const entry = { id: row.id, name: row.name, key: local.key };
      ordered.push(entry);
      byId[row.id] = { name: row.name, key: local.key };
      byKey[local.key] = { id: row.id, name: row.name };
    }
  }

  return { ordered, byId, byKey };
}


// ─────────────────────────────────────────────────────────────
// HELPER: buildMockNotes
// ─────────────────────────────────────────────────────────────
// Generates a small set of realistic Cambridge AS Level notes —
// ONE PER SUBJECT — so the page looks alive during development
// before n8n + the backend pipeline has filled the DB.
//
// Critically, this is called ONLY AFTER the real `subjects` table
// has been fetched, and it uses those real UUIDs. There are NO
// hardcoded UUIDs in this file — that's a project rule.
//
// If a subject couldn't be resolved (e.g. one row missing from
// the DB), its mock note is skipped silently.
function buildMockNotes(subjectByKey) {
  const mocks = [
    {
      // ── Economics 9708 ──────────────────────────────────────
      subjectKey: "economics",
      title: "Price Elasticity of Demand",
      summary:
        "Price elasticity of demand measures how the quantity demanded of a good responds to a change in its price. The measure matters when firms set prices, when governments levy indirect taxes, and when economists evaluate market reactions to policy.\n\nA good with elastic demand sees a large change in quantity for a small change in price. A good with inelastic demand sees a small change in quantity for a large change in price. The sign of the result is usually negative because price and quantity move in opposite directions, but Cambridge examiners focus on the magnitude.\n\nThe main determinants are the availability of close substitutes, the proportion of household income spent on the good, whether the good is a necessity or a luxury, the time horizon under consideration, and brand loyalty.",
      key_points: [
        "Elastic demand has a magnitude greater than one",
        "Inelastic demand has a magnitude less than one",
        "Goods with many close substitutes tend to be more elastic",
        "Demand becomes more elastic over time as consumers find alternatives",
        "Necessities are usually inelastic, luxuries are usually elastic",
        "Apple iPhone illustrates relatively inelastic demand due to brand loyalty",
      ],
      source: "Google Classroom",
      daysAgo: 1,
    },
    {
      // ── Business Studies 9609 ───────────────────────────────
      subjectKey: "business",
      title: "The Marketing Mix — Four Ps",
      summary:
        "The marketing mix is the set of controllable variables a firm uses to influence buyer response. The four classical elements are Product, Price, Place and Promotion. A successful mix aligns all four elements with the chosen target market segment.\n\nProduct covers the physical good or service, including features, quality, packaging and brand. Price covers list price, discounts, payment terms and the firm's overall pricing strategy. Place covers distribution channels and where the customer can actually buy. Promotion covers advertising, public relations, sales promotions and personal selling.\n\nA fast food chain like KFC in Zambia adapts each P for the local market: smaller portion options to match lower disposable income, payment via Airtel Money for digital convenience, kiosks in busy urban districts, and radio advertising in both Bemba and English to reach a wider audience.",
      key_points: [
        "The four Ps must be internally consistent and aligned to the target segment",
        "Penetration pricing builds market share quickly at the cost of short-run profit",
        "Skimming pricing extracts profit from early adopters before lowering price",
        "Place decisions include selling direct versus selling through wholesalers",
        "Promotion mix should match the customer's media habits",
      ],
      source: "Google Classroom",
      daysAgo: 2,
    },
    {
      // ── English Language 9093 ───────────────────────────────
      subjectKey: "english",
      title: "Analysing Tone and Voice with the CLS Framework",
      summary:
        "Tone is the writer's attitude toward the subject and the audience. Voice is the distinctive personality conveyed through diction, syntax and rhythm. Cambridge examiners reward students who can name specific language techniques and explain how they shape meaning, rather than students who simply list devices.\n\nThe CLS framework — Context, Language, Structure — gives an analytical answer a clear shape. Begin by establishing the context of the extract: who, when, why. Move to the language choices, citing short quotations and naming the linguistic technique used. Finish with structural choices, including paragraph length, sentence variety, and the order in which ideas appear.\n\nA confident answer integrates evidence and analysis on every line — it never separates them into a quotation followed by a generic comment.",
      key_points: [
        "Diction shapes tone — formal lexis suggests authority, colloquial lexis suggests intimacy",
        "Sentence length controls pace — short sentences create urgency, longer ones create reflection",
        "Imagery, metaphor and symbolism build emotional resonance",
        "Anaphora and repetition emphasise key ideas",
        "Always name the technique, quote the evidence, explain the effect",
      ],
      source: "YouTube",
      daysAgo: 3,
    },
    {
      // ── ICT 9626 ────────────────────────────────────────────
      subjectKey: "ict",
      title: "Database Normalisation up to Third Normal Form",
      summary:
        "Normalisation is the process of organising the columns and tables of a relational database so that data redundancy is reduced and data integrity is improved. The standard target for an AS Level answer is third normal form, in which each non-key attribute depends on the entire primary key and on nothing else.\n\nFirst normal form removes repeating groups by ensuring each cell holds a single atomic value. Second normal form removes partial dependencies on a composite primary key. Third normal form removes transitive dependencies — non-key attributes that depend on another non-key attribute rather than on the primary key.\n\nA point-of-sale system at Shoprite Zambia benefits from normalisation because customer details, product details and transaction details are stored exactly once and then linked together by foreign keys. This avoids inconsistent customer addresses being copied across thousands of receipts.",
      key_points: [
        "1NF: every cell holds a single value, no repeating groups",
        "2NF: every non-key attribute depends on the whole primary key",
        "3NF: no transitive dependencies between non-key attributes",
        "Primary keys uniquely identify each row in a table",
        "Foreign keys link tables and maintain referential integrity",
        "Denormalisation may improve read performance at the cost of redundancy",
      ],
      source: "Drive",
      daysAgo: 5,
    },
  ];

  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  // Build the final list, skipping any subject whose UUID we
  // couldn't resolve from the DB (would be a config issue, not
  // a user-facing error).
  return mocks
    .map((m, idx) => {
      const meta = subjectByKey[m.subjectKey];
      if (!meta) return null;
      return {
        // Mock IDs are not real UUIDs — they're React keys only.
        // The prefix makes them easy to spot in the React devtools.
        id: `mock-${m.subjectKey}-${idx}`,
        title: m.title,
        summary: m.summary,
        key_points: m.key_points,
        subject_id: meta.id, // REAL UUID from the DB
        created_at: new Date(now - m.daysAgo * ONE_DAY_MS).toISOString(),
        source: m.source,
      };
    })
    .filter(Boolean);
}


// ─────────────────────────────────────────────────────────────
// (The per-page SubjectBadge function used to live here. It was
// removed during the UI unification pass — every page now imports
// the shared SubjectBadge from app/components/SubjectBadge.js,
// which guarantees identical sizing, colours and borders.)


// ─────────────────────────────────────────────────────────────
// HELPER: subject-coloured left border classes
// ─────────────────────────────────────────────────────────────
// Lookup of canonical subject key → Tailwind border-l class. We
// keep these as literal strings so the JIT keeps the CSS in the
// final bundle. Used by NoteCard to apply the 3 px coloured edge
// described in the design audit.
// Subject-key → left accent border (CSS variables only)
const NOTE_LEFT_BORDER_VAR = {
  economics: "var(--econ-accent)",
  business: "var(--biz-accent)",
  english: "var(--eng-accent)",
  ict: "var(--ict-accent)",
};

// Filter tab labels — order matches lib/subjects.js
const NOTES_FILTER_OPTIONS = [
  { value: FILTER_ALL, label: "All" },
  { value: "economics", label: "Economics" },
  { value: "business", label: "Business" },
  { value: "english", label: "English" },
  { value: "ict", label: "ICT" },
];


// ─────────────────────────────────────────────────────────────
// SUB-COMPONENT: SkeletonCard
// ─────────────────────────────────────────────────────────────
// A pulsing placeholder shown while the real notes are loading.
// It uses `animate-pulse` on `bg-hover` so the user sees a
// rhythmic shimmer in the same brand colour as the rest of the
// page. Six of these are stacked into the same grid as the real
// cards so the layout doesn't reflow when notes arrive.
function SkeletonCard() {
  return (
    <div
      style={{
        background: "var(--card)",
        borderRadius: "10px",
        padding: "20px",
      }}
    >
      <div
        style={{
          animation: "notes-pulse 1.5s ease-in-out infinite",
        }}
      >
        <div
          style={{
            width: "60%",
            height: "12px",
            background: "var(--card-hover)",
            borderRadius: "4px",
          }}
        />
        <div
          style={{
            width: "100%",
            height: "8px",
            marginTop: "8px",
            background: "var(--card-hover)",
            borderRadius: "4px",
          }}
        />
        <div
          style={{
            width: "80%",
            height: "8px",
            marginTop: "6px",
            background: "var(--card-hover)",
            borderRadius: "4px",
          }}
        />
      </div>
    </div>
  );
}


function NotesTabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontFamily: "Inter, sans-serif",
        fontSize: "13px",
        fontWeight: active ? 500 : 400,
        color: active ? "var(--gold)" : "var(--text-muted)",
        borderBottom: active ? "2px solid var(--gold)" : "2px solid transparent",
        paddingBottom: "10px",
        paddingLeft: "4px",
        paddingRight: "4px",
        marginBottom: "-1px",
        background: "none",
        borderTop: "none",
        borderLeft: "none",
        borderRight: "none",
        cursor: "pointer",
        transition: "color 200ms ease",
      }}
    >
      {children}
    </button>
  );
}


function EmptyState({ activeFilter, onSync, isSyncing }) {
  const subjectName =
    activeFilter === FILTER_ALL
      ? null
      : getSubjectByKey(activeFilter)?.name ?? activeFilter;

  return (
    <div
      style={{
        background: "var(--card)",
        border: "0.5px solid var(--gold-border)",
        borderRadius: "10px",
        padding: "48px 32px",
        textAlign: "center",
        maxWidth: "480px",
        margin: "0 auto",
      }}
    >
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--gold-icon)"
        strokeWidth="1.5"
        aria-hidden
        style={{ margin: "0 auto", display: "block" }}
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <h2
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: "16px",
          color: "var(--text)",
          fontWeight: 700,
          margin: "12px 0 0",
        }}
      >
        No notes yet
      </h2>
      <p
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: "13px",
          color: "var(--text-muted)",
          marginTop: "8px",
          lineHeight: 1.5,
        }}
      >
        {activeFilter === FILTER_ALL
          ? "Sync your Google Classroom to get started"
          : `No ${subjectName} notes yet`}
      </p>
      <button
        type="button"
        onClick={onSync}
        disabled={isSyncing}
        style={{
          marginTop: "20px",
          background: "transparent",
          border: "0.5px solid var(--gold-border-active)",
          borderRadius: "8px",
          padding: "10px 16px",
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          fontFamily: "Inter, sans-serif",
          fontSize: "13px",
          fontWeight: 500,
          color: "var(--gold)",
          cursor: isSyncing ? "wait" : "pointer",
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
          style={{
            animation: isSyncing ? "notes-sync-spin 0.7s linear infinite" : "none",
          }}
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.5 10c.84-2.5 2.87-4.52 5.5-5.32C13.56 3.19 18.21 4.65 20.5 7.4" />
          <path d="M20.5 14c-.84 2.5-2.87 4.52-5.5 5.32C10.44 20.81 5.79 19.35 3.5 16.6" />
        </svg>
        {isSyncing ? "Syncing..." : "Sync Now"}
      </button>
    </div>
  );
}


function BtnSpinnerSmall() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid var(--gold)",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "notes-sync-spin 0.7s linear infinite",
      }}
    />
  );
}


function GenerateCardsButton({ note, state, onGenerate }) {
  let icon = null;
  let label = "Generate Cards";
  let disabled = false;

  const zapIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );

  const checkIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );

  if (state === "exists") {
    icon = checkIcon;
    label = "Cards Exist";
  } else if (state === "loading") {
    icon = <BtnSpinnerSmall />;
    label = "Generating...";
    disabled = true;
  } else if (state === "success") {
    icon = checkIcon;
    label = "Cards Generated!";
    disabled = true;
  } else {
    icon = zapIcon;
    label = "Generate Cards";
  }

  return (
    <button
      type="button"
      onClick={() => onGenerate(note)}
      disabled={disabled}
      aria-label={label + ` for "${note.title}"`}
      style={{
        width: "100%",
        background: "transparent",
        border: "0.5px solid var(--gold-dim)",
        borderRadius: "6px",
        padding: "8px 12px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "6px",
        fontFamily: "Inter, sans-serif",
        fontSize: "12px",
        fontWeight: 500,
        color: "var(--gold)",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 200ms ease, border-color 200ms ease",
        opacity: disabled && state === "loading" ? 0.85 : 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}


function NoteCard({ note, subjectMeta, generateState, onGenerate }) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const cleanSummary = stripMarkdown(note.summary);
  const dateText = formatNoteDate(note.created_at);
  const leftAccent =
    (subjectMeta && NOTE_LEFT_BORDER_VAR[subjectMeta.key]) || "var(--border)";

  const keyPoints = Array.isArray(note.key_points)
    ? note.key_points.slice(0, 3)
    : [];
  const showReadMore = cleanSummary.length > 180;

  const sideBorder = hovered
    ? "0.5px solid var(--gold-border-active)"
    : "0.5px solid var(--gold-border)";

  return (
    <motion.article
      variants={staggerItem}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? "var(--card-hover)" : "var(--card)",
        borderTop: sideBorder,
        borderRight: sideBorder,
        borderBottom: sideBorder,
        borderLeft: `3px solid ${leftAccent}`,
        borderRadius: "10px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        transition: "background 200ms ease, border-color 200ms ease",
      }}
    >
      {subjectMeta && <SubjectBadge subject={subjectMeta} />}

      <h3
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: "16px",
          color: "var(--text)",
          fontWeight: 700,
          margin: "8px 0 4px",
          lineHeight: 1.3,
        }}
      >
        {note.title}
      </h3>

      <p
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: "11px",
          color: "var(--text-muted)",
          margin: 0,
        }}
      >
        {dateText}
      </p>

      <p
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: "13px",
          color: "var(--text-dim)",
          lineHeight: 1.6,
          marginTop: "8px",
          marginBottom: 0,
          display: expanded ? "block" : "-webkit-box",
          WebkitLineClamp: expanded ? undefined : 3,
          WebkitBoxOrient: "vertical",
          overflow: expanded ? "visible" : "hidden",
        }}
      >
        {cleanSummary}
      </p>

      {showReadMore && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          style={{
            alignSelf: "flex-end",
            marginTop: "4px",
            fontFamily: "Inter, sans-serif",
            fontSize: "12px",
            color: "var(--gold)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}

      {keyPoints.length > 0 && (
        <>
          <div
            aria-hidden="true"
            style={{
              height: "1px",
              background: "var(--border)",
              margin: "14px 0",
            }}
          />
          <p
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "10px",
              fontWeight: 500,
              letterSpacing: "0.1em",
              color: "var(--date-color)",
              textTransform: "uppercase",
              marginBottom: "10px",
            }}
          >
            KEY POINTS
          </p>
          {keyPoints.map((point, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                marginBottom: "6px",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: "4px",
                  height: "4px",
                  background: "var(--gold)",
                  flexShrink: 0,
                  marginTop: "6px",
                }}
              />
              <span
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "12px",
                  color: "var(--text-dim)",
                  lineHeight: 1.5,
                }}
              >
                {stripMarkdown(point)}
              </span>
            </div>
          ))}
        </>
      )}

      <div style={{ marginTop: "auto", paddingTop: "16px" }}>
        <GenerateCardsButton
          note={note}
          state={generateState}
          onGenerate={onGenerate}
        />
      </div>
    </motion.article>
  );
}


// ─────────────────────────────────────────────────────────────
// MAIN PAGE COMPONENT
// ─────────────────────────────────────────────────────────────
export default function NotesPage() {
  const router = useRouter();

  // ── Auth + gate state ─────────────────────────────────────
  // `authReady` flips to true only after Effect 1 has both
  // confirmed a valid session AND confirmed onboarding is done.
  // While it is false the page renders nothing (a brief flicker
  // is fine — the proxy has already redirected unauthed users).
  const [authReady, setAuthReady] = useState(false);

  // ── Subject state ─────────────────────────────────────────
  // `subjectIndex` holds three views of the subjects table data.
  // See buildSubjectIndex() above for the shape. While loading
  // or on failure we still render the page with no tabs and the
  // empty state — the page never crashes.
  const [subjectIndex, setSubjectIndex] = useState({
    ordered: [],
    byId: {},
    byKey: {},
  });

  // ── Notes state ──────────────────────────────────────────
  // `notes` is the unified list — either real DB rows or mock
  // notes if the DB returned empty. `notesLoading` controls the
  // skeleton view.
  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);

  // ── UI state ──────────────────────────────────────────────
  // `activeFilter` is either FILTER_ALL or one of the subject
  // keys ("economics", "business", ...). When a subject tab is
  // active we pass its UUID to GET /notes/list on the backend.
  const [activeFilter, setActiveFilter] = useState(FILTER_ALL);

  // `isSyncing` toggles the spinner on the Sync Now button.
  // `toast` shows the bottom-right success/error banner.
  const [isSyncing, setIsSyncing] = useState(false);
  const [toast, setToast] = useState(null);

  // ── Flashcard-generation state ────────────────────────────
  // `currentUserId` is the verified UUID of the signed-in
  // user. We cache it once Effect 1 confirms the session so
  // the per-note Generate handler doesn't have to round-trip
  // back to supabase.auth.getUser() on every click.
  //
  // `existingCardTitles` is a Set of every note TITLE for
  // which Aisha already has at least one flashcard. We compute
  // it by reading `flashcards.topic` for the signed-in user
  // (the backend stores the source-note title in that column;
  // see backend/routers/flashcards.py SCHEMA-NOTE for why).
  // The notes grid uses this set to render the "Cards exist"
  // chip on the appropriate buttons.
  //
  // `generateState` maps note.id → "idle" | "loading" |
  // "success" | "exists". The Generate Cards button reads
  // its visual state from here.  "exists" is set on mount
  // for every note whose title is in `existingCardTitles`,
  // and on demand when a generate call returns
  // already_existed=true.
  const [currentUserId, setCurrentUserId] = useState(null);
  const [existingCardTitles, setExistingCardTitles] = useState(
    () => new Set()
  );
  const [generateState, setGenerateState] = useState({});

  // Refs so async closures (the fetch handlers below) always
  // see the freshest cached values without being re-created in
  // a useCallback dependency array. Same pattern the homework
  // page uses for currentUserId.
  const currentUserIdRef = useRef(currentUserId);
  const existingCardTitlesRef = useRef(existingCardTitles);
  // Ref for stagger animation — fires when the notes grid scrolls into view
  const notesGridRef = useRef(null);

  const notesInView = useInView(notesGridRef, {
    once: true,
    margin: "-40px",
  });

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);
  useEffect(() => {
    existingCardTitlesRef.current = existingCardTitles;
  }, [existingCardTitles]);

  // ───────────────────────────────────────────────────────────
  // EFFECT 1 — Auth + onboarding guard.
  // ───────────────────────────────────────────────────────────
  // Runs once on mount. Mirrors the dashboard's pattern exactly:
  //
  //   1. Ask Supabase who the current user is. If there's no
  //      session, redirect to /login. (The proxy already does
  //      this server-side; this client-side check is a fallback.)
  //   2. Read the onboarding completion flag from localStorage.
  //      If it isn't "true", redirect to /onboarding/welcome.
  //   3. Otherwise mark the page ready to render.
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      console.log("[Notes] Verifying session (client-side fallback)...");
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (cancelled) return;

      if (error || !user) {
        console.warn("[Notes] No valid session – redirecting to /login");
        router.replace("/login");
        return;
      }

      // Onboarding flag check (localStorage – the proxy cannot see it).
      if (localStorage.getItem(ONBOARDING_KEY) !== "true") {
        console.log("[Notes] Onboarding incomplete – redirecting");
        router.replace("/onboarding/welcome");
        return;
      }

      console.log("[Notes] Auth + onboarding OK – rendering page");
      // Cache the verified user id so the per-note Generate
      // handler can build its request body without another
      // call to supabase.auth.getUser().
      setCurrentUserId(user.id);
      setAuthReady(true);
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [router]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 2 — Fetch subjects + notes once the user is verified.
  // ───────────────────────────────────────────────────────────
  // We deliberately wait for `authReady` so that we don't waste
  // a query on a session that's about to be redirected away.
  //
  //   QUERY 1: SELECT * FROM subjects
  //            → all four Cambridge subjects with their UUIDs.
  //            Feeds the filter tabs and the badge lookup.
  //
  //   QUERY 2: GET /notes/list on the FastAPI backend (Bearer
  //            token). Optional subject_id when a filter tab is
  //            active. Falls back to mock notes when empty/error.
  useEffect(() => {
    if (!authReady) return;

    let cancelled = false;

    const fetchAll = async () => {
      setNotesLoading(true);

      // ── QUERY 1: subjects ─────────────────────────────────
      const { data: subjectRows, error: subjectErr } = await supabase
        .from("subjects")
        .select("*");

      if (cancelled) return;

      let nextIndex = { ordered: [], byId: {}, byKey: {} };
      if (subjectErr) {
        console.warn(
          "[Notes] Could not load subjects – tabs will be hidden.",
          subjectErr
        );
      } else {
        nextIndex = buildSubjectIndex(subjectRows ?? []);
        if (nextIndex.ordered.length === 0) {
          console.warn(
            "[Notes] subjects table returned no matchable rows – check the seed."
          );
        }
      }
      setSubjectIndex(nextIndex);

      // ── QUERY 2: notes via backend ────────────────────────
      let noteRows = null;
      let notesErr = null;
      try {
        const { data: sessionData, error: sessionError } =
          await supabase.auth.getSession();
        const token = sessionData?.session?.access_token ?? null;
        const userId =
          sessionData?.session?.user?.id ?? currentUserIdRef.current;

        if (sessionError || !token || !userId) {
          notesErr = sessionError || new Error("Missing session for notes list.");
        } else {
          const params = new URLSearchParams({
            user_id: userId,
            limit: "50",
            offset: "0",
          });
          if (activeFilter !== FILTER_ALL) {
            const subjMeta = nextIndex.byKey[activeFilter];
            if (subjMeta?.id) {
              params.set("subject_id", subjMeta.id);
            }
          }

          const listResponse = await fetch(
            `${API_URL}/notes/list?${params.toString()}`,
            {
              method: "GET",
              headers: { Authorization: `Bearer ${token}` },
            }
          );

          if (!listResponse.ok) {
            notesErr = new Error(`Backend returned HTTP ${listResponse.status}.`);
          } else {
            const listBody = await listResponse.json().catch(() => ({}));
            noteRows = Array.isArray(listBody?.data) ? listBody.data : [];
          }
        }
      } catch (fetchErr) {
        notesErr = fetchErr;
      }

      if (cancelled) return;

      if (notesErr) {
        console.warn(
          "[Notes] Could not load notes from backend – falling back to mock data.",
          notesErr
        );
        setNotes(buildMockNotes(nextIndex.byKey));
        setUsingMock(true);
      } else if (!noteRows || noteRows.length === 0) {
        console.log(
          "[Notes] No notes from backend – showing mock notes for development."
        );
        setNotes(buildMockNotes(nextIndex.byKey));
        setUsingMock(true);
      } else {
        setNotes(noteRows);
        setUsingMock(false);
      }

      // ── QUERY 3: existing flashcards (the cards-exist set) ──
      // ONE round-trip to figure out which notes already have at
      // least one flashcard generated. We only need the `topic`
      // column — the backend stores the source-note title there
      // (see backend/routers/flashcards.py SCHEMA-NOTE for the
      // reason). RLS scopes the rows to the signed-in user, so
      // no explicit user_id filter is needed.
      //
      // Empty result on a fresh account is normal — the Set just
      // stays empty and every note shows the idle "Generate
      // Cards" button.
      try {
        const { data: cardRows, error: cardsErr } = await supabase
          .from(FLASHCARDS_TABLE)
          .select("topic");

        if (cancelled) return;

        if (cardsErr) {
          console.warn(
            "[Notes] Could not load existing flashcards – buttons " +
              "will default to 'Generate Cards' for every note.",
            cardsErr
          );
          setExistingCardTitles(new Set());
        } else {
          // Distinct, non-empty topic strings → the set of notes
          // that already have cards.
          const titles = new Set();
          for (const row of cardRows ?? []) {
            const topic = (row?.topic ?? "").toString().trim();
            if (topic) titles.add(topic);
          }
          setExistingCardTitles(titles);
        }
      } catch (e) {
        console.warn(
          "[Notes] Unexpected error fetching flashcards.topic:",
          e
        );
        if (!cancelled) setExistingCardTitles(new Set());
      }

      setNotesLoading(false);
    };

    fetchAll();

    return () => {
      cancelled = true;
    };
  }, [authReady, activeFilter]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 3 — Auto-dismiss the toast after a few seconds.
  // ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(() => setToast(null), TOAST_DISMISS_MS);
    return () => clearTimeout(handle);
  }, [toast]);


  // ───────────────────────────────────────────────────────────
  // HANDLER: handleSync
  // ───────────────────────────────────────────────────────────
  // Calls POST /notes/sync on the FastAPI backend, which triggers
  // the n8n Google Classroom poll when N8N_WEBHOOK_URL is set.
  // This handler:
  //
  //   • Disables the button + shows a spinner while in-flight.
  //   • Shows a success toast on 2xx (and refetches notes so any
  //     new rows appear immediately without a page reload).
  //   • Shows an error toast on any other outcome (e.g. the
  //     endpoint is still 404, or the server is offline).
  //   • Never crashes the page — every failure path is handled.
  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);

    try {
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession();
      const token = sessionData?.session?.access_token ?? null;
      const userId =
        sessionData?.session?.user?.id ?? currentUserIdRef.current;

      if (sessionError || !token || !userId) {
        throw new Error("Your session has expired. Please sign in again.");
      }

      const response = await fetch(`${API_URL}/notes/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ user_id: userId }),
      });

      if (!response.ok) {
        throw new Error(`Backend returned HTTP ${response.status}.`);
      }

      setToast({
        tone: "success",
        message:
          "Sync triggered — checking Google Classroom for new posts.",
      });

      const params = new URLSearchParams({
        user_id: userId,
        limit: "50",
        offset: "0",
      });
      if (activeFilter !== FILTER_ALL) {
        const subjMeta = subjectIndex.byKey[activeFilter];
        if (subjMeta?.id) {
          params.set("subject_id", subjMeta.id);
        }
      }

      const listResponse = await fetch(
        `${API_URL}/notes/list?${params.toString()}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (listResponse.ok) {
        const listBody = await listResponse.json().catch(() => ({}));
        const noteRows = Array.isArray(listBody?.data) ? listBody.data : [];
        if (noteRows.length > 0) {
          setNotes(noteRows);
          setUsingMock(false);
        }
      }
    } catch (err) {
      console.warn("[Notes] Sync failed:", err);
      setToast({
        tone: "error",
        message: "Sync failed — please try again.",
      });
    } finally {
      setIsSyncing(false);
    }
  };


  // ───────────────────────────────────────────────────────────
  // HANDLER: handleGenerateForNote
  // ───────────────────────────────────────────────────────────
  // The Generate Cards button on every NoteCard calls this with
  // the full `note` object. Its job:
  //
  //   1. If we already know cards exist for this note → show a
  //      gentle toast pointing the student to /features/flashcards
  //      and do nothing else. No API call. No spinner.
  //   2. Otherwise: read the access token + user id from the
  //      Supabase session, then POST /flashcards/generate.
  //   3. On success: flip the button to a 3-second "Cards
  //      generated" success state, add the note's title to the
  //      cards-exist set so future clicks short-circuit, and
  //      show a toast.
  //   4. On any error: flip the button back to idle and show a
  //      friendly error toast. The notes themselves are never
  //      touched — we never crash the page.
  //
  // This handler is *not* wrapped in useCallback because the
  // NoteCard render is already lightweight (no React.memo) and
  // we'd lose more in dependency-tracking complexity than we'd
  // gain in re-render savings.
  const handleGenerateForNote = async (note) => {
    if (!note || !note.id || !note.title) {
      console.warn("[Notes] Generate called with an invalid note:", note);
      return;
    }

    // Don't allow a second click while a generation is in flight.
    if (generateState[note.id] === "loading") return;

    // ── Short-circuit: cards already exist for this note. ──
    // The duplicate-prevention spec says: no API call, just a
    // toast telling Aisha where to study.
    const alreadyExists =
      existingCardTitlesRef.current.has(note.title) ||
      generateState[note.id] === "exists";
    if (alreadyExists) {
      setToast({
        tone: "success",
        message:
          "Cards already exist for this note. " +
          "Go to Flashcards to study them.",
      });
      return;
    }

    // Mock notes (rendered before n8n has filled the table) have
    // ids like "mock-economics-0". We can't generate cards from
    // those because the backend would 404 looking them up in the
    // notes table — surface a clean message instead of a crash.
    if (String(note.id).startsWith("mock-")) {
      setToast({
        tone: "error",
        message:
          "This is a sample note. Generate Cards will work once " +
          "your real notes have arrived from Google Classroom.",
      });
      return;
    }

    // ── Resolve auth: token + user id. ─────────────────────
    let token = null;
    let userId = currentUserIdRef.current;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      token = data?.session?.access_token ?? null;
      userId = data?.session?.user?.id ?? userId;
    } catch (e) {
      console.warn("[Notes] Could not read Supabase session:", e);
    }

    if (!token || !userId) {
      setToast({
        tone: "error",
        message: "Your session has expired. Please sign in again.",
      });
      return;
    }

    // Optimistically flip the button into its loading state so
    // the spinner appears the instant the click registers.
    setGenerateState((prev) => ({ ...prev, [note.id]: "loading" }));

    try {
      // ── Fire the request. ───────────────────────────────
      // Spec body: { note_id, user_id }. The Authorization
      // header carries the bearer JWT the backend re-verifies.
      const response = await fetch(`${API_URL}/flashcards/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ note_id: note.id, user_id: userId }),
      });

      // Parse the JSON body whether the request succeeded or
      // failed — both shapes are useful for the toast.
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Try to surface the backend's friendly error string,
        // not the internal stack trace.
        const detail = body?.detail;
        const friendly =
          (detail && typeof detail === "object" && detail.error) ||
          (typeof detail === "string" ? detail : null) ||
          body?.error ||
          `HTTP ${response.status}`;
        throw new Error(friendly);
      }

      // ── Success path — handle 3 sub-cases. ─────────────
      //   (a) already_existed=true   → cards were there already
      //   (b) cards_saved === 0      → Groq couldn't use the note
      //   (c) cards_saved > 0        → the happy path
      const savedCount = Number(body?.cards_saved) || 0;
      const noteTitle = body?.note_title || note.title;

      if (body?.already_existed) {
        // Add to the set so the button locks into "exists"
        // mode without another fetch.
        setExistingCardTitles((prev) => {
          const next = new Set(prev);
          next.add(noteTitle);
          return next;
        });
        setGenerateState((prev) => ({ ...prev, [note.id]: "exists" }));
        setToast({
          tone: "success",
          message:
            "Cards already exist for this note. " +
            "Go to Flashcards to study them.",
        });
        return;
      }

      if (savedCount === 0) {
        // Groq couldn't draft any cards. Treat as a soft error.
        setGenerateState((prev) => ({ ...prev, [note.id]: "idle" }));
        setToast({
          tone: "error",
          message:
            `Could not generate cards from "${noteTitle}". ` +
            "The note may be too short — try syncing more content.",
        });
        return;
      }

      // Happy path. Lock the button into the 3-second success
      // state, add the title to the cards-exist set, then drop
      // the button into "exists" after the linger window.
      setExistingCardTitles((prev) => {
        const next = new Set(prev);
        next.add(noteTitle);
        return next;
      });
      setGenerateState((prev) => ({ ...prev, [note.id]: "success" }));
      window.setTimeout(() => {
        setGenerateState((prev) => ({ ...prev, [note.id]: "exists" }));
      }, GENERATE_SUCCESS_LINGER_MS);
      setToast({
        tone: "success",
        message: `${savedCount} flashcards generated for "${noteTitle}".`,
      });
    } catch (err) {
      // Any thrown error — network failure, 4xx/5xx, JSON parse
      // error — lands here. We log the technical detail but show
      // the student a friendly recovery message.
      console.error("[Notes] Flashcard generate failed:", err);
      setGenerateState((prev) => ({ ...prev, [note.id]: "idle" }));
      setToast({
        tone: "error",
        message:
          `Could not generate cards for "${note.title}". ` +
          "Please try again.",
      });
    }
  };


  // Notes to render — real API rows when present, otherwise placeholders
  const displayNotes = notes && notes.length > 0 ? notes : PLACEHOLDER_NOTES;

  // Client-side filter by subject key (supports `subject` on placeholders
  // and subject_id lookup for API rows)
  const filteredNotes =
    activeFilter === FILTER_ALL
      ? displayNotes
      : displayNotes.filter((n) => {
          const subjectKey =
            n.subject?.toLowerCase?.() ??
            subjectIndex.byId[n.subject_id]?.key ??
            "";
          return subjectKey === activeFilter.toLowerCase();
        });

  // ───────────────────────────────────────────────────────────
  // RENDER GATE
  // ───────────────────────────────────────────────────────────
  // While the auth check is still running we render nothing so
  // an unauthenticated user never glimpses page content. The
  // proxy.js redirect will have arrived a few ms earlier anyway.
  if (!authReady) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-text-muted text-sm">Loading…</div>
      </main>
    );
  }

  // ───────────────────────────────────────────────────────────
  // PAGE LAYOUT
  // ───────────────────────────────────────────────────────────
  return (
    <motion.main
      className="notes-page"
      style={{ minHeight: "100vh", background: "var(--bg)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
    >
      <style jsx global>{`
        @keyframes notes-sync-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes notes-pulse {
          0%,
          100% {
            opacity: 0.45;
          }
          50% {
            opacity: 0.85;
          }
        }
        .notes-grid-wrap {
          margin: 20px var(--page-padding) 32px;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }
        @media (max-width: 1023px) {
          .notes-grid-wrap {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (max-width: 767px) {
          .notes-grid-wrap {
            grid-template-columns: 1fr;
          }
          .notes-sync-label {
            display: none;
          }
        }
        .notes-sync-btn:hover:not(:disabled) {
          background: var(--nav-icon-bg);
        }
      `}</style>

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
            transition: "color 200ms",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Dashboard
        </Link>
        <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>/</span>
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            color: "var(--text-dim)",
          }}
        >
          My Notes
        </span>
      </div>

      <header
        style={{
          padding: "20px var(--page-padding) 0",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: "28px",
              color: "var(--text)",
              fontWeight: 700,
              margin: 0,
            }}
          >
            My Notes
          </h1>
          <p
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "13px",
              color: "var(--text-muted)",
              marginTop: "4px",
              marginBottom: 0,
            }}
          >
            Auto-generated from your Google Classroom
          </p>
        </div>
        <button
          type="button"
          className="notes-sync-btn"
          onClick={handleSync}
          disabled={isSyncing}
          style={{
            background: "transparent",
            border: "0.5px solid var(--gold-border-active)",
            borderRadius: "8px",
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            fontWeight: 500,
            color: "var(--gold)",
            cursor: isSyncing ? "wait" : "pointer",
            transition: "background 200ms ease, border-color 200ms ease",
            flexShrink: 0,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
            style={{
              animation: isSyncing
                ? "notes-sync-spin 0.7s linear infinite"
                : "none",
            }}
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.5 10c.84-2.5 2.87-4.52 5.5-5.32C13.56 3.19 18.21 4.65 20.5 7.4" />
            <path d="M20.5 14c-.84 2.5-2.87 4.52-5.5 5.32C10.44 20.81 5.79 19.35 3.5 16.6" />
          </svg>
          <span className="notes-sync-label">
            {isSyncing ? "Syncing..." : "Sync Now"}
          </span>
        </button>
      </header>

      <nav
        aria-label="Notes filters"
        style={{
          margin: "20px var(--page-padding) 0",
          borderBottom: "1px solid var(--border-light)",
          display: "flex",
          gap: "24px",
        }}
      >
        {NOTES_FILTER_OPTIONS.map((opt) => (
          <NotesTabButton
            key={opt.value}
            active={activeFilter === opt.value}
            onClick={() => setActiveFilter(opt.value)}
          >
            {opt.label}
          </NotesTabButton>
        ))}
      </nav>

      {notesLoading ? (
        <section
          aria-label="Loading notes"
          className="notes-grid-wrap"
        >
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </section>
      ) : (
        <>
          {filteredNotes.length === 0 && (
            <section
              aria-label="No notes"
              style={{ margin: "20px var(--page-padding) 32px" }}
            >
              <EmptyState
                activeFilter={activeFilter}
                onSync={handleSync}
                isSyncing={isSyncing}
              />
            </section>
          )}
          <motion.section
            ref={notesGridRef}
            aria-label="Notes grid"
            className="notes-grid-wrap"
            variants={staggerContainer}
            initial="hidden"
            animate={notesInView || filteredNotes.length > 0 ? "visible" : "hidden"}
          >
            {console.log("[Notes] filteredNotes:", filteredNotes)}
            {console.log(
              "[Notes] filteredNotes length:",
              filteredNotes?.length
            )}
            {console.log("[Notes] loading:", notesLoading)}
            {filteredNotes.map((note, index) => {
              const liveState = generateState[note.id];
              let buttonState = liveState ?? "idle";
              if (
                buttonState === "idle" &&
                existingCardTitles.has(note.title)
              ) {
                buttonState = "exists";
              }
              const subjectMeta =
                subjectIndex.byId[note.subject_id] ??
                (note.subject
                  ? {
                      key: note.subject,
                      name:
                        getSubjectByKey(note.subject)?.name ?? note.subject,
                    }
                  : undefined);
              return (
                <NoteCard
                  key={note.id ?? index}
                  note={note}
                  subjectMeta={subjectMeta}
                  generateState={buttonState}
                  onGenerate={handleGenerateForNote}
                />
              );
            })}
          </motion.section>
        </>
      )}

      {usingMock && !notesLoading && filteredNotes.length > 0 && (
        <p
          style={{
            marginTop: "24px",
            textAlign: "center",
            fontFamily: "Inter, sans-serif",
            fontSize: "11px",
            color: "var(--text-extra-dim)",
          }}
        >
          Showing sample notes while your Google Classroom sync is being set up.
          Real notes will replace these automatically.
        </p>
      )}

      {toast && (
        <motion.div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            zIndex: 50,
            maxWidth: "360px",
            borderRadius: "8px",
            padding: "16px 40px 16px 16px",
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            background: "var(--card)",
            border:
              toast.tone === "error"
                ? "0.5px solid color-mix(in srgb, var(--exam-urgent) 30%, transparent)"
                : "0.5px solid var(--gold-border)",
            color:
              toast.tone === "error" ? "var(--exam-urgent)" : "var(--text)",
            boxShadow: "var(--chat-panel-shadow)",
          }}
        >
          <p style={{ margin: 0, lineHeight: 1.5 }}>{toast.message}</p>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            style={{
              position: "absolute",
              top: "8px",
              right: "8px",
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: "18px",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </motion.div>
      )}
    </motion.main>
  );
}

