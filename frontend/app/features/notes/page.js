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

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle,
  Loader2,
  NotebookText,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { supabase } from "../../../lib/supabaseClient";
import { SUBJECTS } from "../../../lib/subjects";
import PageHeader from "../../components/PageHeader";
import SubjectBadge from "../../components/SubjectBadge";

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
const NOTE_LEFT_BORDER_CLASS = {
  economics: "border-l-economics-text",
  business:  "border-l-business-text",
  english:   "border-l-english-text",
  ict:       "border-l-ict-text",
};


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
    <div className="bg-card border border-input-border rounded-4px p-5 shadow-sm">
      <div className="animate-pulse space-y-3">
        {/* Badge placeholder */}
        <div className="h-4 w-20 bg-hover rounded-4px" />
        {/* Title placeholder */}
        <div className="h-5 w-3/4 bg-hover rounded-4px" />
        {/* Metadata placeholder */}
        <div className="h-3 w-1/2 bg-hover rounded-4px" />
        {/* Summary placeholder — three lines of decreasing width */}
        <div className="space-y-2 pt-2">
          <div className="h-3 w-full bg-hover rounded-4px" />
          <div className="h-3 w-11/12 bg-hover rounded-4px" />
          <div className="h-3 w-2/3 bg-hover rounded-4px" />
        </div>
        {/* Key-points placeholder */}
        <div className="space-y-2 pt-3">
          <div className="h-3 w-1/3 bg-hover rounded-4px" />
          <div className="h-3 w-4/5 bg-hover rounded-4px" />
          <div className="h-3 w-3/5 bg-hover rounded-4px" />
        </div>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// SUB-COMPONENT: EmptyState
// ─────────────────────────────────────────────────────────────
// Shown when the filtered list is empty — either because no notes
// have been generated yet at all, or because the active filter
// matched zero notes. A friendly notebook icon plus a one-line
// explanation tells the student WHY the page is empty.
function EmptyState() {
  return (
    <div className="bg-card border border-input-border rounded-4px p-10 shadow-sm text-center max-w-xl mx-auto">
      <div className="flex justify-center mb-4">
        <NotebookText
          size={48}
          strokeWidth={1.5}
          className="text-gold"
        />
      </div>
      <h2 className="font-heading text-2xl font-bold text-text-primary mb-2">
        No notes yet
      </h2>
      <p className="text-text-muted leading-relaxed">
        Your notes will appear here automatically after your Google Classroom is
        connected and synced.
      </p>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// SUB-COMPONENT: NoteCard
// ─────────────────────────────────────────────────────────────
// A single note: coloured left edge → subject badge → title →
// metadata → summary (line-clamped to 4 lines until expanded) →
// "Key Points" label → bullet list.
//
// VISUAL SPEC (post-audit):
//   • Standard card shell (bg-card, 1 px input-border, 4 px
//     radius, shadow-sm → shadow-md on hover).
//   • 3 px subject-coloured left edge (Task 4).
//   • Collapsed height capped at 320 px; summary is clamped to
//     four lines so cards in the grid stay visually balanced.
//   • "Read more" toggles to "Show less" and expands the card
//     to its natural height (Task 5).
//   • Key Points section sits OUTSIDE the clamp so students
//     never lose the high-signal bullets when collapsed.
//
// `whitespace-pre-line` on the summary preserves the line breaks
// the AI summariser produces without rendering Markdown — exactly
// what the original spec asked for.
// ─────────────────────────────────────────────────────────────
// SUB-COMPONENT: GenerateCardsButton
// ─────────────────────────────────────────────────────────────
// The small button that lives at the bottom-right of every
// NoteCard. Its appearance depends on a single `state` string
// passed down from the parent NotesPage:
//
//   "idle"      → outline-gold "Generate Cards" with Sparkles
//   "loading"   → disabled spinner "Generating…"
//   "success"   → green "✓ Cards generated" (3 sec linger)
//   "exists"    → muted "Cards exist" (still clickable so the
//                 click can fire a toast telling the user where
//                 to study — see handleGenerateForNote()).
//
// Keeping it as its own component means the rest of NoteCard
// doesn't re-render when only the button state changes.
// ─────────────────────────────────────────────────────────────
function GenerateCardsButton({ note, state, onGenerate }) {
  // Base classes shared across every state. We use `text-[12px]`
  // for the Inter-12 size called for in the spec; everything
  // else uses standard Tailwind tokens so the look stays
  // consistent with the rest of the design system.
  const base =
    "inline-flex items-center gap-1.5 text-[12px] font-body " +
    "font-body-medium rounded-4px px-3 py-1.5 border transition " +
    "focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-gold focus-visible:ring-offset-2 " +
    "focus-visible:ring-offset-card";

  // Pick the right icon, label, and per-state class list.
  let icon = null;
  let label = "";
  let stateCls = "";
  // Loading and the transient success state both disable the
  // button so we can't fire a second request mid-flight.
  let disabled = false;

  if (state === "exists") {
    // Cards already exist for this note — clicking only shows
    // a "go to flashcards to study" toast (handled by the
    // parent's onGenerate handler).
    icon = <CheckCircle size={14} aria-hidden="true" />;
    label = "Cards exist";
    stateCls =
      "border-input-border text-text-muted bg-transparent " +
      "hover:bg-hover";
  } else if (state === "loading") {
    // Mid-flight Groq call — show a spinner and lock the button.
    icon = <Loader2 size={14} className="animate-spin" aria-hidden="true" />;
    label = "Generating…";
    stateCls =
      "border-gold text-gold bg-transparent cursor-wait opacity-80";
    disabled = true;
  } else if (state === "success") {
    // Briefly celebrate. Uses Tailwind's built-in green palette
    // (NOT a hex literal) so the design-system rule isn't bent.
    icon = <CheckCircle size={14} aria-hidden="true" />;
    label = "Cards generated";
    stateCls = "border-green-600 text-green-700 bg-transparent";
    disabled = true;
  } else {
    // Default idle state — the standard "Generate Cards" button.
    icon = <Sparkles size={14} aria-hidden="true" />;
    label = "Generate Cards";
    stateCls =
      "border-gold text-gold bg-transparent " +
      "hover:bg-gold hover:text-background";
  }

  return (
    <button
      type="button"
      onClick={() => onGenerate(note)}
      disabled={disabled}
      aria-label={label + ` for "${note.title}"`}
      className={base + " " + stateCls}
    >
      {icon}
      {label}
    </button>
  );
}


function NoteCard({ note, subjectMeta, generateState, onGenerate }) {
  // Local expand/collapse state. Defaults to collapsed so the
  // grid renders compact + uniform on first paint.
  const [expanded, setExpanded] = useState(false);

  // Defensive: even if a row arrived with stray Markdown, strip
  // it so the student never sees raw symbols.
  const cleanSummary = stripMarkdown(note.summary);

  // Metadata line is "14 May 2026" plus an optional source,
  // separated by a thin middle dot. If `source` is null/empty
  // we omit both the dot and the source span — the design has
  // to stay tidy regardless of which fields the DB row has.
  const dateText = formatNoteDate(note.created_at);
  const hasSource = !!note.source && String(note.source).trim().length > 0;

  // Subject-coloured 3 px left border. Falls back to the neutral
  // input-border token when the subject can't be matched.
  const leftBorderClass =
    (subjectMeta && NOTE_LEFT_BORDER_CLASS[subjectMeta.key]) ||
    "border-l-input-border";

  return (
    <article
      className={
        "bg-card border border-input-border border-l-[3px] " +
        leftBorderClass +
        " rounded-4px p-5 shadow-sm flex flex-col gap-3 " +
        "transition duration-200 ease-in-out " +
        "hover:bg-hover hover:shadow-md"
      }
    >
      {/* 1. Subject badge — colour driven by subjectMeta.key.
              Uses the shared SubjectBadge so every page renders
              this pill identically. */}
      {subjectMeta && (
        <div>
          <SubjectBadge subject={subjectMeta} />
        </div>
      )}

      {/* 2. Title — Playfair Display, primary text token */}
      <h3 className="font-heading text-lg font-bold text-text-primary leading-snug">
        {note.title}
      </h3>

      {/* 3. Metadata row — date + optional source */}
      <p className="text-xs text-text-muted flex flex-wrap items-center gap-1.5">
        <span>{dateText}</span>
        {hasSource && (
          <>
            <span aria-hidden="true">·</span>
            <span>{note.source}</span>
          </>
        )}
      </p>

      {/* 4. Summary — flowing plain text, line breaks preserved.
              When collapsed we clamp to 4 lines so every card in
              the grid is the same visual weight; clicking "Read
              more" removes the clamp and the card expands to fit. */}
      <p
        className={
          "text-sm text-text-primary leading-relaxed whitespace-pre-line " +
          (expanded ? "" : "line-clamp-4")
        }
      >
        {cleanSummary}
      </p>

      {/* 4b. Read more / Show less toggle. Renders only when the
               summary is long enough that the clamp would actually
               truncate (a rough proxy: >280 chars). Keeps shorter
               notes from showing an unnecessary control. */}
      {cleanSummary.length > 280 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className={
              "text-xs font-body font-body-medium text-gold " +
              "hover:underline focus:outline-none focus:underline"
            }
          >
            {expanded ? "Show less" : "Read more"}
          </button>
        </div>
      )}

      {/* 5. Key Points section — only render if the array has items.
              ALWAYS visible (never clamped) because these are the
              highest-signal bullets and the student should see them
              even when the card is collapsed. */}
      {Array.isArray(note.key_points) && note.key_points.length > 0 && (
        <div className="pt-1">
          <h4 className="text-[11px] font-body font-body-semibold uppercase tracking-widest text-text-muted mb-2">
            Key Points
          </h4>
          <ul className="space-y-1.5">
            {note.key_points.map((point, idx) => (
              <li
                key={idx}
                className="text-sm text-text-primary leading-relaxed flex gap-2"
              >
                <span aria-hidden="true" className="text-gold leading-relaxed">
                  •
                </span>
                <span>{stripMarkdown(point)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 6. Generate Cards action — bottom-right corner. The
              `mt-auto` pushes it to the bottom of the flex column
              so every card in the grid lines its button up at the
              same y position regardless of summary length. */}
      <div className="mt-auto flex justify-end pt-3">
        <GenerateCardsButton
          note={note}
          state={generateState}
          onGenerate={onGenerate}
        />
      </div>
    </article>
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
  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);
  const existingCardTitlesRef = useRef(existingCardTitles);
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


  // ───────────────────────────────────────────────────────────
  // DERIVED VALUE: filteredNotes
  // ───────────────────────────────────────────────────────────
  // Pure client-side filter. When the user clicks "Economics"
  // we keep only notes whose `subject_id` resolves to that key.
  // useMemo avoids redoing the filter on every keystroke / render.
  const filteredNotes = useMemo(() => {
    if (activeFilter === FILTER_ALL) return notes;
    return notes.filter((n) => {
      const meta = subjectIndex.byId[n.subject_id];
      return meta?.key === activeFilter;
    });
  }, [notes, activeFilter, subjectIndex.byId]);


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
    <main className="min-h-screen bg-background py-6 px-4 sm:px-8">
      <div className="max-w-7xl mx-auto">

        {/* SECTION 2 — PAGE HEADER
            Uses the shared PageHeader. The Sync Now button is
            passed via the action slot so its visual treatment
            (size, position, spacing) is identical to every other
            page's primary CTA. */}
        <PageHeader
          title="My Notes"
          subtitle="Auto-generated from your Google Classroom"
          action={
            <button
              type="button"
              onClick={handleSync}
              disabled={isSyncing}
              // Primary button — gold filled. Matches the unified
              // primary style used on every page (Task 10).
              className={
                "bg-gold text-background font-body font-body-semibold " +
                "text-sm px-5 py-2.5 rounded-4px inline-flex items-center " +
                "gap-2 transition hover:brightness-90 " +
                "disabled:opacity-60 disabled:cursor-not-allowed " +
                "focus-visible:outline-none focus-visible:ring-2 " +
                "focus-visible:ring-gold focus-visible:ring-offset-2 " +
                "focus-visible:ring-offset-background"
              }
            >
              <RefreshCw
                size={16}
                strokeWidth={2.25}
                className={isSyncing ? "animate-spin" : ""}
                aria-hidden="true"
              />
              {isSyncing ? "Syncing…" : "Sync Now"}
            </button>
          }
        />


        {/* ────────────────────────────────────────────────────
            SECTION 3 — FILTER TABS
            ────────────────────────────────────────────────────
            One row of pill buttons: All + every subject from the
            DB in the order declared in lib/subjects.js. Active
            tab uses bg-gold + text-background (the "cream") with
            no border. Inactive tabs use bg-card + text-text-muted
            with the input-border token. The row scrolls horizontally
            on mobile so all five fit at 375px without wrapping
            awkwardly. */}
        <nav className="mb-6 -mx-1 overflow-x-auto">
          <ul className="flex items-center gap-2 px-1 min-w-max">
            <li>
              <FilterTab
                isActive={activeFilter === FILTER_ALL}
                onClick={() => setActiveFilter(FILTER_ALL)}
              >
                All
              </FilterTab>
            </li>
            {subjectIndex.ordered.map((s) => (
              <li key={s.id}>
                <FilterTab
                  isActive={activeFilter === s.key}
                  onClick={() => setActiveFilter(s.key)}
                >
                  {s.name}
                </FilterTab>
              </li>
            ))}
          </ul>
        </nav>


        {/* ────────────────────────────────────────────────────
            SECTION 4/5/6 — NOTES GRID / EMPTY / LOADING
            ────────────────────────────────────────────────────
            Three mutually exclusive states share the same outer
            container so the layout stays stable when content
            swaps. The grid is 1 column on mobile, 2 on tablet,
            3 on desktop — driven entirely by Tailwind responsive
            prefixes (no media-query JS). */}
        {notesLoading ? (
          /* ── LOADING ─────────────────────────────────────── */
          <section
            aria-label="Loading notes"
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </section>
        ) : filteredNotes.length === 0 ? (
          /* ── EMPTY ───────────────────────────────────────── */
          <section aria-label="No notes" className="mt-6">
            <EmptyState />
          </section>
        ) : (
          /* ── NOTES GRID ──────────────────────────────────── */
          <section
            aria-label="Notes grid"
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            {filteredNotes.map((note) => {
              // Resolve the Generate Cards button state for this
              // specific note. Priority order:
              //   1. An in-flight handler state ("loading"/"success").
              //   2. "exists" if the title is in our cards-exist set.
              //   3. Otherwise default to "idle".
              const liveState = generateState[note.id];
              let buttonState = liveState ?? "idle";
              if (
                buttonState === "idle" &&
                existingCardTitles.has(note.title)
              ) {
                buttonState = "exists";
              }
              return (
                <NoteCard
                  key={note.id}
                  note={note}
                  subjectMeta={subjectIndex.byId[note.subject_id]}
                  generateState={buttonState}
                  onGenerate={handleGenerateForNote}
                />
              );
            })}
          </section>
        )}

        {/* Mock-data disclaimer — only visible during development
            when we've substituted in mock notes because the real
            table is empty. Keeps the dev experience honest. */}
        {usingMock && !notesLoading && filteredNotes.length > 0 && (
          <p className="mt-6 text-xs text-text-hint text-center">
            Showing sample notes while your Google Classroom sync is being set
            up. Real notes will replace these automatically.
          </p>
        )}


        {/* ────────────────────────────────────────────────────
            TOAST
            ────────────────────────────────────────────────────
            Fixed bottom-right notification. Used for sync
            success / failure messages. Auto-dismisses after
            TOAST_DISMISS_MS. role + aria-live ensure screen
            readers announce the result. */}
        {toast && (
          <div
            role="status"
            aria-live="polite"
            className={
              "fixed bottom-6 right-6 z-50 max-w-sm rounded-4px shadow-md " +
              "border p-4 pr-10 text-sm bg-white " +
              (toast.tone === "success"
                ? "border-gold text-text-primary"
                : "border-red-200 text-red-700")
            }
          >
            <p className="leading-relaxed">{toast.message}</p>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Dismiss"
              className="absolute top-2 right-2 text-text-hint hover:text-text-primary transition leading-none text-lg"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </main>
  );
}


// ─────────────────────────────────────────────────────────────
// SUB-COMPONENT: FilterTab
// ─────────────────────────────────────────────────────────────
// One pill in the filter row. The active variant uses the gold
// token as background and the page-background colour ("cream")
// as the foreground. The inactive variant uses card + muted text
// + the input-border token for a soft outline that doesn't shout
// when there are five tabs in a row.
function FilterTab({ isActive, onClick, children }) {
  const base =
    "inline-flex items-center px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background";
  const active = "bg-gold text-background border border-transparent";
  const inactive =
    "bg-card text-text-muted border border-input-border hover:bg-hover";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={`${base} ${isActive ? active : inactive}`}
    >
      {children}
    </button>
  );
}
