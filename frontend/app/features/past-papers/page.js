// ============================================================
// FILE: app/features/past-papers/page.js
// PURPOSE: Past Paper Solver — upload Cambridge AS Level past
//          papers and view AI-generated solutions in a single full-width solution panel.
//
// HOW THE PAGE WORKS AT A GLANCE
// ----------------------------------------------------------------
// VIEW 1 (default) — PAPERS LIBRARY
//   • Stats row + papers grouped by subject in a responsive grid.
//   • "Upload Paper" button opens VIEW 2.
//   • Clicking any paper opens VIEW 4.
//
// VIEW 2 — UPLOAD MODAL (overlay)
//   • Subject / year / session form
//   • Native HTML5 drag-and-drop PDF upload zone
//   • Solve-mode selection (full paper vs selected questions)
//
// VIEW 3 — SOLVING IN PROGRESS (full page replacement of VIEW 1)
//   • Animated pulsing brain icon
//   • 5 sequential processing steps that advance via setTimeout
//     (no backend yet — when /past-papers/solve exists this will
//     be driven by real server-sent events or polling).
//
// VIEW 4 — SOLUTION VIEW (full page replacement of VIEW 1)
//   • Single full-width panel: Cambridge model answers per
//     question, mark scheme + examiner insights (collapsible),
//     and paper summary. No PDF iframe.
//
// LIVE-DB SCHEMA REALITY (re-confirmed 2026-05-14)
// ----------------------------------------------------------------
// The real `past_papers` table carries these columns:
//     id, user_id, subject_id, file_url, paper_year,
//     paper_variant, questions_json (JSONB),
//     high_frequency_topics (JSONB), uploaded_at, created_at
// ⚠ `mode` is NOT a column — the earlier probe was fooled by
// Postgres's built-in aggregate function `mode()` returning an
// "ordered-set aggregate required" error rather than the usual
// "column does not exist", which was misread as success. The
// solve-mode value is UX-only and lives in client state via the
// `extras` argument of `normalizePaper`.
// Spec fields not yet in the DB (`status`, `selected_questions`,
// `solution`, `total_marks`, `filename`) likewise live in
// client-side state only and are lost on refresh. Mock data
// fills the visual richness during development.
//
// PROJECT RULES THIS FILE OBEYS
// ----------------------------------------------------------------
//   • Subject metadata read from Supabase — never hardcoded.
//   • All colours come from Tailwind tokens in tailwind.config.js.
//   • All icons come from lucide-react.
//   • Supabase imported from lib/supabaseClient.js only.
//   • Zero new npm packages.
//   • Drag-and-drop uses native HTML5 events only.
//   • No localStorage for paper data.
//   • No inline styles for colour. The single exception is the
//     dynamic upload-progress bar width (same justification as
//     the timetable and flashcards pages — Tailwind's JIT can't
//     synthesise a literal percentage from a runtime number).
// ============================================================

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Brain,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock,
  FileQuestion,
  FileText,
  FileUp,
  ListChecks,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { supabase } from "../../../lib/supabaseClient";
import { SUBJECTS } from "../../../lib/subjects";
import SubjectBadge from "../../components/SubjectBadge";


// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

// Where the future POST /past-papers/solve endpoint will live.
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

// Supabase Storage bucket that holds the uploaded PDFs.
// (Discovered via probe — bucket exists.)
const STORAGE_BUCKET = "past_papers";

// Toast auto-dismiss timeout.
const TOAST_DISMISS_MS = 4000;

// PDF upload validation thresholds (spec: PDF only, max 10 MB).
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = "application/pdf";

// Cambridge runs two exam sessions a year.
const SESSION_OPTIONS = ["May/June", "October/November"];

// Upload modal form field styles — design-system tokens only.
const UPLOAD_MODAL_LABEL_STYLE = {
  display: "block",
  fontFamily: "Inter, sans-serif",
  fontSize: "10px",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "var(--date-color)",
  marginBottom: "6px",
};

const UPLOAD_MODAL_FIELD_STYLE = {
  background: "var(--card-hover)",
  border: "0.5px solid var(--gold-border-hover)",
  borderRadius: "8px",
  padding: "10px 14px",
  fontFamily: "Inter, sans-serif",
  fontSize: "13px",
  color: "var(--text)",
  width: "100%",
  boxSizing: "border-box",
};

const UPLOAD_MODAL_FIELD_ERROR_BORDER = "0.5px solid var(--exam-urgent)";

function uploadFieldFocus(e) {
  e.target.style.borderColor = "var(--gold)";
  e.target.style.outline = "none";
}

function uploadFieldBlur(e, hasError) {
  e.target.style.outline = "none";
  e.target.style.border = hasError
    ? UPLOAD_MODAL_FIELD_ERROR_BORDER
    : UPLOAD_MODAL_FIELD_STYLE.border;
}

// VIEW 1 filter tabs — client-side only (no extra API call).
const FILTER_ALL = "all";
const FILTER_OPTIONS = [
  { value: FILTER_ALL, label: "All" },
  { value: "economics", label: "Economics" },
  { value: "business", label: "Business" },
  { value: "english", label: "English" },
  { value: "ict", label: "ICT" },
];

// Year input bounds.
const MIN_YEAR = 2015;

// Five processing steps shown in VIEW 3. The first two advance
// on fixed timers (step 1 at 1 s, step 2 at 3 s) — giving the
// user clear feedback that *something* is happening even on a
// slow Groq response. The remaining steps are driven by the
// REAL backend response:
//   • Step 3 completes when the response arrives OR at 8 s
//     (whichever comes first — keeps the UI feeling alive on
//     a long-running Groq call).
//   • Steps 4 + 5 complete the moment the backend returns.
//   • PROCESSING_FINAL_PAUSE_MS is the brief "Solution ready!"
//     beat before we jump to VIEW 4.
const PROCESSING_STEPS = [
  "Uploading PDF to secure storage",
  "Reading and extracting paper content",
  "Analysing Cambridge mark scheme format",
  "Generating step-by-step solutions",
  "Formatting final answer",
];
const PROCESSING_STEP_1_MS = 1000;
const PROCESSING_STEP_2_MS = 3000;
const PROCESSING_STEP_3_TIMEOUT_MS = 8000;
const PROCESSING_FINAL_PAUSE_MS = 1500;

// How long the "Study notes are being generated…" banner stays
// visible after VIEW 4 renders. Mirrors the spec's 30s.
const NOTES_BANNER_MS = 30_000;

// Three-view machine used to render the page body. We DON'T put
// the upload modal in this enum — it's an overlay on top of
// whichever main view is active.
const VIEW = {
  LIBRARY:    "library",
  PROCESSING: "processing",
  SPLIT:      "split",
};

// Solve-mode strings used throughout (matches the `mode` column
// in the real `past_papers` table).
const SOLVE_MODE = {
  FULL:     "full",
  SELECTED: "selected",
};

// Friendly labels for the chip / mode dropdown.
const SOLVE_MODE_LABELS = {
  [SOLVE_MODE.FULL]:     "Full Paper",
  [SOLVE_MODE.SELECTED]: "Selected Questions",
};


// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS — formatting & validation
// ─────────────────────────────────────────────────────────────

/**
 * timeAgo — render an ISO timestamp as a friendly relative
 * string like "3 days ago" or "Just now". Returns '' if the
 * input is missing so the caller never has to guard for it.
 */
function timeAgo(input) {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (Number.isNaN(seconds)) return "";
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return d.toLocaleDateString();
}

/**
 * formatFileSize — convert bytes to a human-readable size
 * ("4.2 MB"). Used in the upload modal's file-preview card.
 */
function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * isThisMonth — true when the given timestamp falls within the
 * system clock's current month (used for the "This month" stat).
 */
function isThisMonth(input) {
  if (!input) return false;
  const d = typeof input === "string" ? new Date(input) : input;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth()
  );
}

/**
 * validatePdfFile — accept a File and return { ok, error } so
 * the upload modal can show a single inline error string.
 *
 * Rules:
 *   • Must have a PDF MIME type (or .pdf suffix as a fallback
 *     for OSes that don't set the MIME correctly).
 *   • Must be at most MAX_PDF_BYTES (10 MB).
 */
function validatePdfFile(file) {
  if (!file) return { ok: false, error: "Please choose a file." };
  const isPdfMime = file.type === ACCEPTED_MIME;
  const isPdfName =
    typeof file.name === "string" && file.name.toLowerCase().endsWith(".pdf");
  if (!isPdfMime && !isPdfName) {
    return { ok: false, error: "Please upload a PDF file only." };
  }
  if (file.size > MAX_PDF_BYTES) {
    return { ok: false, error: "File must be under 10MB." };
  }
  return { ok: true, error: null };
}

/**
 * parseSelectedQuestions — turn "1, 2, 5, 7" into [1,2,5,7].
 * Used both to validate the input and to display the chip on
 * the paper card. Empty / invalid input returns [].
 */
function parseSelectedQuestions(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}


// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS — data shaping (subjects + papers)
// ─────────────────────────────────────────────────────────────

/**
 * buildSubjectIndex — same pattern used by every other feature
 * page. The live `subjects` table has columns id / name / code
 * (no `key`), so we derive a lowercase `key` from `name` and
 * stamp it onto each row before storing — that's what
 * the SubjectBadge component looks up.
 */
function buildSubjectIndex(rows) {
  const byId = {};
  const byKey = {};
  for (const r of rows) {
    const derivedKey =
      (r.key && String(r.key).toLowerCase()) ||
      (r.name && String(r.name).toLowerCase().split(/\s+/)[0]) ||
      null;
    const augmented = { ...r, key: derivedKey };
    byId[r.id] = augmented;
    if (derivedKey) byKey[derivedKey] = augmented;
    if (r.name) {
      const nameLower = String(r.name).toLowerCase();
      if (!byKey[nameLower]) byKey[nameLower] = augmented;
    }
  }
  const ordered = SUBJECTS.map((s) => byKey[s.key]).filter(Boolean);
  return { ordered, byId, byKey };
}

/**
 * normalizePaper — translate a raw `past_papers` row from
 * Supabase into the rich client-side shape used by the rest of
 * the page. Fields the DB doesn't carry yet (year, session,
 * status, solution) come back as null / sensible defaults so
 * defensive rendering elsewhere never has to check the source.
 *
 * The optional `extras` argument lets callers (specifically the
 * upload flow's optimistic insert) inject locally-known data
 * that wasn't returned by Supabase.
 */
function normalizePaper(row, extras = {}) {
  if (!row || typeof row !== "object") return row;
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    subject_id: row.subject_id ?? null,
    // `mode` is NOT a real DB column on `past_papers` — it's a
    // UX-only flag (Full Paper vs Selected Questions) decided
    // in the upload modal. We accept `row.mode` for forward
    // compatibility in case the schema gains the column later,
    // fall back to `extras.mode` (set during optimistic insert),
    // then default to "full".
    mode: row.mode ?? extras.mode ?? SOLVE_MODE.FULL,
    file_url: row.file_url ?? "",
    uploaded_at: row.uploaded_at ?? row.created_at ?? null,
    created_at: row.created_at ?? row.uploaded_at ?? null,
    // year / session — present on the row when the backend
    // /past-papers/list endpoint returns them, otherwise
    // injected via `extras` from the upload form.
    year: row.paper_year ?? extras.year ?? null,
    session: row.paper_variant ?? extras.session ?? null,
    // Client-only fields — overridable via `extras`.
    selected_questions: extras.selected_questions ?? null,
    status: extras.status ?? "solved",
    solution: extras.solution ?? null,
    high_frequency_topics: row.high_frequency_topics ?? null,
    filename: extras.filename ?? null,
    // storage_path — the actual key inside Supabase Storage
    // for this paper's PDF. We set it from `extras` during the
    // upload flow so the delete handler can remove the file
    // without re-deriving the path from the paper id (which
    // changed shape when we moved to a timestamp-prefixed
    // filename to satisfy Storage RLS).
    storage_path: extras.storage_path ?? null,
    is_mock: extras.is_mock === true,
  };
}


/**
 * normalizeBackendSolution — adapt the backend's solution
 * shape to the keys QuestionBlock + SolutionView render.
 *
 * Supports both formats:
 *   New: questions[].model_answer (flowing paragraphs)
 *   Old: questions[].steps[] (joined into model_answer)
 *
 * Also maps:
 *   questions[].question_number      → number
 *   questions[].mark_scheme[].criteria → criterion
 *   questions[].common_mistakes      array of "Mistake: …" strings
 *
 * Doing the mapping here (rather than touching the
 * components) keeps the API contract untouched if the backend
 * ever moves to a different model that produces the exact
 * shape one side wants.
 */
function normalizeBackendSolution(backendSolution) {
  if (!backendSolution || typeof backendSolution !== "object") {
    return null;
  }

  const rawQuestions = Array.isArray(backendSolution.questions)
    ? backendSolution.questions
    : [];

  const questions = rawQuestions.map((q) => {
    // Map mark_scheme[].criteria → criterion + coerce numeric
    // marks to a number-or-undefined.
    const markScheme = Array.isArray(q?.mark_scheme)
      ? q.mark_scheme.map((row) => ({
          criterion:
            row?.criterion ??
            row?.criteria ??
            "",
          marks:
            typeof row?.marks === "number"
              ? row.marks
              : Number(row?.marks) || undefined,
        }))
      : [];

    // Map common_mistakes — accept BOTH the backend's array-of-
    // strings format and any future array-of-objects format so
    // a backend tweak doesn't break the renderer.
    const commonMistakes = Array.isArray(q?.common_mistakes)
      ? q.common_mistakes.map((m) => {
          if (typeof m === "string") {
            // Strip the leading "Mistake: " label if present,
            // then split on " — " (em dash) so the head goes
            // into `mistake` and any trailing context lands
            // in `explanation`.
            const cleaned = m
              .replace(/^\s*mistake\s*:?\s*/i, "")
              .trim();
            const parts = cleaned.split(/\s—\s|\s-\s/, 2);
            return {
              mistake: parts[0] || cleaned || "",
              explanation: parts[1] || "",
            };
          }
          // Already an object — pass through.
          return {
            mistake: m?.mistake ?? "",
            explanation: m?.explanation ?? "",
          };
        })
      : [];

    // Legacy step-by-step answers → one model_answer string so
    // papers solved before the prompt change still display.
    const legacySteps = Array.isArray(q?.steps) ? q.steps : [];
    const fromSteps = legacySteps
      .map((s) =>
        typeof s?.content === "string" ? s.content.trim() : "",
      )
      .filter(Boolean)
      .join("\n\n");
    const modelAnswer =
      typeof q?.model_answer === "string" && q.model_answer.trim()
        ? q.model_answer.trim()
        : fromSteps;

    return {
      // QuestionBlock reads `number` for the heading.
      number: q?.question_number ?? q?.number ?? "",
      question_text: q?.question_text ?? "",
      marks_available:
        typeof q?.marks_available === "number"
          ? q.marks_available
          : Number(q?.marks_available) || undefined,
      model_answer: modelAnswer,
      steps: legacySteps,
      mark_scheme: markScheme,
      examiner_tip: q?.examiner_tip ?? "",
      common_mistakes: commonMistakes,
    };
  });

  // paper_summary doesn't need normalising — the backend keys
  // (total_marks, key_topics, difficulty, revision_areas)
  // match the renderer expectations already.
  const paperSummary =
    backendSolution.paper_summary &&
    typeof backendSolution.paper_summary === "object"
      ? backendSolution.paper_summary
      : {};

  return { questions, summary: paperSummary };
}


/**
 * getModelAnswerParagraphs — split model_answer into paragraphs
 * for rendering. Accepts normalized questions and legacy mock
 * rows that still only carry a steps[] array.
 */
function getModelAnswerParagraphs(question) {
  let text = "";
  if (
    typeof question?.model_answer === "string" &&
    question.model_answer.trim()
  ) {
    text = question.model_answer.trim();
  } else if (Array.isArray(question?.steps) && question.steps.length) {
    text = question.steps
      .map((s) =>
        typeof s?.content === "string" ? s.content.trim() : "",
      )
      .filter(Boolean)
      .join("\n\n");
  }
  if (!text) return [];
  const parts = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
}


// ─────────────────────────────────────────────────────────────
// MOCK SOLUTION TEMPLATES — one per subject.
// ─────────────────────────────────────────────────────────────
//
// Each solution has:
//   questions[]: { number, marks_available, steps[], mark_scheme[],
//                  examiner_tip, common_mistakes[] }
//   summary    : { total_marks, key_topics[], difficulty,
//                  revision_areas[] }
//
// Solutions are intentionally written in plain text — VIEW 4
// renders them with the design system fonts; no markdown.

const ECONOMICS_SOLUTION = {
  questions: [
    {
      number: 1,
      marks_available: 8,
      steps: [
        {
          content:
            "Begin by defining Price Elasticity of Demand (PED) as the responsiveness of quantity demanded to a change in price. Quote the formula explicitly: PED = % change in quantity demanded ÷ % change in price.",
          marks: 2,
        },
        {
          content:
            "Identify the main determinant: availability of close substitutes. When many close substitutes exist, demand is more elastic because consumers can switch easily when price rises.",
          marks: 2,
        },
        {
          content:
            "Apply to a Zambian context. The market for maize meal (a dietary staple) is inelastic — few close substitutes exist locally and it is essential, so households continue buying even when prices rise.",
          marks: 2,
        },
        {
          content:
            "Evaluate using PEEL: explain the implication for pricing strategy. Producers of inelastic goods can raise prices and increase total revenue, since the percentage fall in quantity demanded is smaller than the percentage rise in price.",
          marks: 2,
        },
      ],
      mark_scheme: [
        { criterion: "Correct definition with formula included", marks: 2 },
        { criterion: "Identification of at least one determinant with clear explanation", marks: 2 },
        { criterion: "Use of a real-world / Zambian example to illustrate", marks: 2 },
        { criterion: "Evaluation of implications for producers or consumers", marks: 2 },
      ],
      examiner_tip:
        "Always include the formula explicitly in your definition. Examiners look for the precise mathematical relationship — verbal description alone scores only one mark.",
      common_mistakes: [
        {
          mistake: "Confusing PED with YED (Income Elasticity).",
          explanation:
            "PED measures responsiveness to price changes; YED measures responsiveness to income changes. Read the question carefully before answering.",
        },
        {
          mistake: "Forgetting to take the absolute value.",
          explanation:
            "Since price and quantity demanded move in opposite directions, PED is technically negative. Always quote it as a positive number in AS-Level answers.",
        },
      ],
    },
    {
      number: 2,
      marks_available: 12,
      steps: [
        {
          content:
            "Define a price ceiling: a government-imposed maximum price set below the market equilibrium. Sketch a labelled demand-supply diagram showing the ceiling line, with quantity supplied (Qs) less than quantity demanded (Qd) — the shortage.",
          marks: 3,
        },
        {
          content:
            "Apply to a Zambian context: the government setting a maximum price on mealie meal during periods of high inflation to keep it affordable for low-income households.",
          marks: 2,
        },
        {
          content:
            "Evaluate the benefits: lower prices help consumers afford essentials, reduces inequality in the short term, and is politically popular with low-income voters.",
          marks: 3,
        },
        {
          content:
            "Evaluate the drawbacks: persistent shortages cause queues, encourage black markets, reduce supplier incentives to produce, and quality often falls over time.",
          marks: 2,
        },
        {
          content:
            "Reach a balanced judgement: in the short term price ceilings on essentials can be welfare-enhancing for vulnerable groups, but in the long term they distort markets and discourage investment. Targeted subsidies are usually a better policy.",
          marks: 2,
        },
      ],
      mark_scheme: [
        { criterion: "Clear definition supported by an accurate, labelled diagram", marks: 3 },
        { criterion: "Application to a relevant real-world / Zambian example", marks: 2 },
        { criterion: "Two-sided evaluation (at least two points on each side)", marks: 4 },
        { criterion: "Balanced judgement with reasoned policy recommendation", marks: 3 },
      ],
      examiner_tip:
        "12-mark essay questions ALWAYS require a balanced judgement at the end. State it explicitly — phrases like 'Overall, on balance...' followed by reasoning earn the top band.",
      common_mistakes: [
        {
          mistake: "Listing benefits without diagram analysis.",
          explanation:
            "AS Economics expects a diagram for any price-control question. Even a rough sketch with axes labelled and the ceiling marked scores marks.",
        },
        {
          mistake: "Treating evaluation as a list rather than analysis.",
          explanation:
            "Each evaluation point should be explained AND linked back to the question. 'It helps the poor' is not evaluation — explain HOW and link to government objectives.",
        },
      ],
    },
  ],
  summary: {
    total_marks: 20,
    key_topics: [
      "Price Elasticity of Demand",
      "Market intervention",
      "Price ceilings",
      "Government policy",
    ],
    difficulty: "Intermediate",
    revision_areas: [
      "Drawing accurate demand-supply diagrams under exam conditions.",
      "Memorising elasticity formulas (PED, YED, XED) and their determinants.",
      "Practising balanced two-sided evaluation in 10+ mark answers.",
    ],
  },
};

const BUSINESS_SOLUTION = {
  questions: [
    {
      number: 1,
      marks_available: 10,
      steps: [
        {
          content:
            "Define the marketing mix as the 4Ps (Product, Price, Place, Promotion) — the controllable elements a business combines to satisfy customers profitably.",
          marks: 2,
        },
        {
          content:
            "Choose a local Zambian firm — for example a small Lusaka-based fast-food chain, 'KFC Zambia'. Apply each P briefly: Product (chicken meals adapted to local tastes), Price (penetration pricing to compete with informal vendors), Place (high-street outlets near transport hubs), Promotion (radio adverts in Bemba and Nyanja).",
          marks: 4,
        },
        {
          content:
            "Explain how the 4Ps interact. Pricing must be consistent with the Product (premium product → premium pricing) and Promotion (the brand message must justify the price point).",
          marks: 2,
        },
        {
          content:
            "Evaluate which P is most important for this business. Argue Promotion is critical for a new entrant against established informal sellers, since brand awareness drives initial trial.",
          marks: 2,
        },
      ],
      mark_scheme: [
        { criterion: "Correct definition of the marketing mix and its purpose", marks: 2 },
        { criterion: "All four Ps applied to a real / hypothetical Zambian firm", marks: 4 },
        { criterion: "Explanation of how the Ps interact, with cause-effect chains", marks: 2 },
        { criterion: "Judgement on which P is most important for the chosen firm", marks: 2 },
      ],
      examiner_tip:
        "Always apply theory to a CONTEXT business. Generic answers describing the 4Ps without application top out at half marks. Name the firm and stick with it across all four Ps.",
      common_mistakes: [
        {
          mistake: "Listing the 4Ps without explanation.",
          explanation:
            "Examiners want to see HOW each P serves the customer — list-only answers score zero in the analysis band.",
        },
        {
          mistake: "Switching contexts mid-answer.",
          explanation:
            "Pick one business and stay with it. Jumping between examples breaks the cause-effect chain and loses marks.",
        },
      ],
    },
    {
      number: 2,
      marks_available: 12,
      steps: [
        {
          content:
            "Define a trade union as an organised group of workers that bargains collectively with employers over wages, working conditions and job security.",
          marks: 2,
        },
        {
          content:
            "Apply to a Zambian context: the Zambia Congress of Trade Unions (ZCTU) negotiating with the mining sector over wages and safety standards.",
          marks: 2,
        },
        {
          content:
            "Evaluate the benefits for workers: higher collective bargaining power leads to better wages, safer conditions, and protection against unfair dismissal.",
          marks: 3,
        },
        {
          content:
            "Evaluate the drawbacks for employers and the wider economy: wage rises may increase production costs, strike action disrupts output, and rigid agreements can reduce flexibility to respond to market changes.",
          marks: 3,
        },
        {
          content:
            "Balanced judgement: trade unions improve worker welfare and reduce exploitation, but their long-term success depends on cooperative bargaining rather than confrontational strike-first tactics. Recommend joint productivity agreements as a model.",
          marks: 2,
        },
      ],
      mark_scheme: [
        { criterion: "Accurate definition of a trade union with its functions", marks: 2 },
        { criterion: "Relevant Zambian / Southern African application", marks: 2 },
        { criterion: "Two-sided evaluation (workers AND employers)", marks: 6 },
        { criterion: "Reasoned judgement with policy recommendation", marks: 2 },
      ],
      examiner_tip:
        "For 'discuss' questions worth 12+ marks, label your judgement clearly with words like 'Therefore' or 'On balance'. Examiners scan for the judgement statement first.",
      common_mistakes: [
        {
          mistake: "Treating unions as purely negative for business.",
          explanation:
            "A balanced answer must include positives for workers — failing to do so caps marks in the AO3 (Evaluation) strand.",
        },
        {
          mistake: "Vague phrases like 'unions help workers'.",
          explanation:
            "Be specific — HOW do they help? Cite mechanisms (collective bargaining, legal representation, strike threat) and effects (higher wages, safer workplaces).",
        },
      ],
    },
  ],
  summary: {
    total_marks: 22,
    key_topics: [
      "Marketing mix (4Ps)",
      "Local business application",
      "Trade unions",
      "Stakeholder evaluation",
    ],
    difficulty: "Intermediate",
    revision_areas: [
      "Applying the 4Ps to local Zambian SMEs, not generic UK firms.",
      "Building cause-effect chains rather than listing benefits.",
      "Stating an explicit judgement at the end of 10+ mark answers.",
    ],
  },
};

const ENGLISH_SOLUTION = {
  questions: [
    {
      number: 1,
      marks_available: 15,
      steps: [
        {
          content:
            "Identify the writer's overall tone in the passage. Quote a specific phrase that signals it — e.g. 'a creeping unease' suggests a tone of guarded anxiety rather than outright fear.",
          marks: 3,
        },
        {
          content:
            "Analyse how diction (word choice) creates this tone. Focus on connotation — 'creeping' implies slow, hidden movement, intensifying the unease without overt drama.",
          marks: 4,
        },
        {
          content:
            "Examine sentence structure. Short, fragmented sentences mirror the narrator's clipped thinking; long, syntactically complex sentences slow the reader and add weight.",
          marks: 4,
        },
        {
          content:
            "Evaluate how the tone shifts (if at all) between paragraphs. Identify the pivot point — the moment a single image or phrase recasts the mood — and explain its effect on the reader.",
          marks: 4,
        },
      ],
      mark_scheme: [
        { criterion: "Accurate identification of tone with quoted evidence", marks: 3 },
        { criterion: "Close analysis of diction with connotation", marks: 4 },
        { criterion: "Analysis of sentence structure / syntax", marks: 4 },
        { criterion: "Tracking of tonal shift across the passage", marks: 4 },
      ],
      examiner_tip:
        "Use the CLS framework: Content, Language, Structure. For every point, ground it in a specific quotation and explain WHY the writer's choice produces the effect on the reader.",
      common_mistakes: [
        {
          mistake: "Naming techniques without explaining their effect.",
          explanation:
            "'The writer uses metaphor' is feature-spotting, not analysis. Always follow with 'which creates...' and explain the reader's response.",
        },
        {
          mistake: "Quoting without commentary.",
          explanation:
            "Embed short, sharp quotations into your sentences and unpack them. A 5-word quote analysed deeply beats a 20-word quote left to speak for itself.",
        },
      ],
    },
    {
      number: 2,
      marks_available: 10,
      steps: [
        {
          content:
            "Briefly summarise the central concern of each text in one sentence — what is each writer trying to make the reader feel or think?",
          marks: 2,
        },
        {
          content:
            "Compare ONE technique used by both writers (e.g. imagery). Quote a specific phrase from each text and explain the effect of each.",
          marks: 3,
        },
        {
          content:
            "Identify a key DIFFERENCE in approach — for example, one writer uses direct address while the other maintains an impersonal narrator. Explain why each choice suits the writer's purpose.",
          marks: 3,
        },
        {
          content:
            "Reach an overall judgement about which text is more effective at achieving its purpose, supported by reference to specific moments in both texts.",
          marks: 2,
        },
      ],
      mark_scheme: [
        { criterion: "Clear identification of each writer's central concern", marks: 2 },
        { criterion: "Comparison of one technique with quoted evidence from BOTH texts", marks: 3 },
        { criterion: "Analysis of a meaningful difference in approach", marks: 3 },
        { criterion: "Overall judgement with textual evidence", marks: 2 },
      ],
      examiner_tip:
        "Comparative questions reward CROSS-REFERENCING. Use linking words like 'similarly', 'in contrast', 'whereas' explicitly so the examiner can see comparison happening sentence-by-sentence.",
      common_mistakes: [
        {
          mistake: "Writing about each text separately.",
          explanation:
            "Side-by-side analysis is essential. If your answer has a chunk on Text A then a chunk on Text B with no cross-references, you'll cap out in the lowest band.",
        },
        {
          mistake: "Generic comparison statements.",
          explanation:
            "'Both writers use imagery' isn't comparison — anchor every comparison in a specific quotation from each text.",
        },
      ],
    },
  ],
  summary: {
    total_marks: 25,
    key_topics: [
      "Tone and voice analysis",
      "Diction & connotation",
      "Sentence structure",
      "Comparative analysis",
    ],
    difficulty: "Advanced",
    revision_areas: [
      "Practising tight, embedded quotations (5-7 words) under timed conditions.",
      "Building a personal glossary of analytical verbs ('signals', 'evokes', 'undercuts').",
      "Drilling the CLS framework on past unseen passages.",
    ],
  },
};

const ICT_SOLUTION = {
  questions: [
    {
      number: 1,
      marks_available: 8,
      steps: [
        {
          content:
            "Define database normalisation: the process of organising data to reduce redundancy and improve data integrity, by decomposing tables into smaller related ones.",
          marks: 2,
        },
        {
          content:
            "Explain First Normal Form (1NF): every column contains atomic values (no repeating groups), and each row is uniquely identifiable.",
          marks: 2,
        },
        {
          content:
            "Explain Second Normal Form (2NF): the table is already in 1NF AND every non-key attribute is fully functionally dependent on the entire primary key (eliminating partial dependencies).",
          marks: 2,
        },
        {
          content:
            "Explain Third Normal Form (3NF): the table is in 2NF AND no non-key attribute depends on another non-key attribute (eliminating transitive dependencies).",
          marks: 2,
        },
      ],
      mark_scheme: [
        { criterion: "Correct definition of normalisation and its purpose", marks: 2 },
        { criterion: "1NF correctly explained with example or rule", marks: 2 },
        { criterion: "2NF correctly explained — partial dependency identified", marks: 2 },
        { criterion: "3NF correctly explained — transitive dependency identified", marks: 2 },
      ],
      examiner_tip:
        "When asked to normalise a sample table, ALWAYS show the table at each stage (1NF → 2NF → 3NF). Examiners want to see the transformation, not just the final result.",
      common_mistakes: [
        {
          mistake: "Confusing the order of normal forms.",
          explanation:
            "Each NF requires the previous. You can't be in 3NF without first being in 2NF. State this dependency in your answer.",
        },
        {
          mistake: "Skipping the example.",
          explanation:
            "Definitions alone are worth 1 mark each at AS-Level. To hit the top band, illustrate each NF with a small worked table.",
        },
      ],
    },
    {
      number: 2,
      marks_available: 12,
      steps: [
        {
          content:
            "Define network security: the policies, processes and technologies that protect networks and data from unauthorised access, modification or destruction.",
          marks: 2,
        },
        {
          content:
            "Identify three common threats: malware (e.g. ransomware), phishing, and Distributed Denial-of-Service (DDoS) attacks. Briefly explain how each works.",
          marks: 3,
        },
        {
          content:
            "Describe countermeasures: firewalls filter incoming/outgoing traffic, anti-malware software detects known signatures, and user training reduces phishing success rates.",
          marks: 3,
        },
        {
          content:
            "Evaluate the trade-off between security and usability. Strong security (e.g. multi-factor authentication on every action) reduces productivity; the goal is proportionate protection based on risk assessment.",
          marks: 2,
        },
        {
          content:
            "Reach a judgement: the most cost-effective single intervention is staff training, because most successful breaches exploit human error (phishing, weak passwords) rather than technical flaws.",
          marks: 2,
        },
      ],
      mark_scheme: [
        { criterion: "Definition of network security with purpose", marks: 2 },
        { criterion: "Three threats correctly identified and explained", marks: 3 },
        { criterion: "Matching countermeasures explained", marks: 3 },
        { criterion: "Evaluation of security vs usability trade-off", marks: 2 },
        { criterion: "Reasoned judgement on most effective intervention", marks: 2 },
      ],
      examiner_tip:
        "For 'discuss' and 'evaluate' questions in ICT, link each technical control back to a business consequence — examiners want to see you connect the technology to the real-world impact.",
      common_mistakes: [
        {
          mistake: "Listing technologies without explaining how they work.",
          explanation:
            "'Use a firewall' is not analysis. Explain WHAT the firewall does (filters by IP/port/rule) and WHY it reduces a specific threat.",
        },
        {
          mistake: "Ignoring the human factor.",
          explanation:
            "Most breaches involve social engineering. Answers that focus only on hardware/software miss the strongest single intervention — training.",
        },
      ],
    },
  ],
  summary: {
    total_marks: 20,
    key_topics: [
      "Database normalisation (1NF, 2NF, 3NF)",
      "Network security threats",
      "Security countermeasures",
      "Cost-benefit analysis of controls",
    ],
    difficulty: "Intermediate",
    revision_areas: [
      "Practising normalisation by hand with sample tables.",
      "Memorising the OSI model layers and matching protocols.",
      "Linking security controls to real-world breach case studies.",
    ],
  },
};

const SOLUTION_BY_SUBJECT_KEY = {
  economics: ECONOMICS_SOLUTION,
  business:  BUSINESS_SOLUTION,
  english:   ENGLISH_SOLUTION,
  ict:       ICT_SOLUTION,
};


// ─────────────────────────────────────────────────────────────
// MOCK PAPER TEMPLATE — 8 papers, 2 per subject.
// ─────────────────────────────────────────────────────────────
// Each entry pairs a subject key with the year / session / mode
// metadata that would normally come from the form. Solutions are
// pulled from SOLUTION_BY_SUBJECT_KEY so we don't duplicate the
// rich content. `daysAgo` controls the "Solved X days ago" text.

const MOCK_PAPER_TEMPLATE = [
  { subjectKey: "economics", year: 2023, session: "May/June",          mode: SOLVE_MODE.FULL,     selectedQuestions: null,       daysAgo: 3  },
  { subjectKey: "economics", year: 2022, session: "October/November",  mode: SOLVE_MODE.SELECTED, selectedQuestions: "1, 2",     daysAgo: 14 },
  { subjectKey: "business",  year: 2023, session: "May/June",          mode: SOLVE_MODE.FULL,     selectedQuestions: null,       daysAgo: 5  },
  { subjectKey: "business",  year: 2022, session: "October/November",  mode: SOLVE_MODE.FULL,     selectedQuestions: null,       daysAgo: 21 },
  { subjectKey: "english",   year: 2023, session: "May/June",          mode: SOLVE_MODE.SELECTED, selectedQuestions: "2, 5",     daysAgo: 8  },
  { subjectKey: "english",   year: 2022, session: "October/November",  mode: SOLVE_MODE.FULL,     selectedQuestions: null,       daysAgo: 28 },
  { subjectKey: "ict",       year: 2023, session: "May/June",          mode: SOLVE_MODE.FULL,     selectedQuestions: null,       daysAgo: 2  },
  { subjectKey: "ict",       year: 2022, session: "October/November",  mode: SOLVE_MODE.FULL,     selectedQuestions: null,       daysAgo: 35 },
];

/**
 * buildMockPapers — render the template above into full paper
 * objects against whatever subjects we actually got back from
 * Supabase. Templates referencing missing subjects are skipped.
 * Mock papers carry an `is_mock: true` flag so the write
 * handlers (delete) know to skip the Supabase call.
 */
function buildMockPapers(subjectByKey) {
  const now = Date.now();
  const out = [];
  MOCK_PAPER_TEMPLATE.forEach((tpl, idx) => {
    const subjectRow = subjectByKey[tpl.subjectKey];
    if (!subjectRow) return;
    const solution = SOLUTION_BY_SUBJECT_KEY[tpl.subjectKey];
    const uploadedAt = new Date(
      now - tpl.daysAgo * 24 * 60 * 60 * 1000,
    ).toISOString();
    out.push({
      id: `mock-${idx}-${tpl.subjectKey}`,
      user_id: null,
      subject_id: subjectRow.id,
      mode: tpl.mode,
      file_url: `mock://${tpl.subjectKey}-${tpl.year}-${idx}`,
      uploaded_at: uploadedAt,
      created_at: uploadedAt,
      year: tpl.year,
      session: tpl.session,
      selected_questions: tpl.selectedQuestions,
      status: "solved",
      solution,
      filename: `${subjectRow.code}_${tpl.year}_${tpl.session === "May/June" ? "MJ" : "ON"}.pdf`,
      is_mock: true,
    });
  });
  return out;
}


// ─────────────────────────────────────────────────────────────
// SMALL UI COMPONENTS
// ─────────────────────────────────────────────────────────────

// (The per-page SubjectBadge function used to live here. It was
// removed during the UI unification pass — every page now imports
// the shared SubjectBadge from app/components/SubjectBadge.js.)

/** VIEW 1 — breadcrumb back to dashboard */
function PastPapersBreadcrumb() {
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
        Past Papers
      </span>
    </div>
  );
}

/** VIEW 1 — one stat tile in the three-column stats row */
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

/** VIEW 1 — subject filter tab (matches notes / homework tabs) */
function FilterTabButton({ active, onClick, children }) {
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

/** VIEW 1 — loading skeleton for one paper row */
function PaperCardSkeleton() {
  return (
    <div
      className="animate-pulse"
      style={{
        background: "var(--card)",
        border: "0.5px solid var(--gold-border)",
        borderRadius: "10px",
        padding: "20px 24px",
        height: "88px",
      }}
    />
  );
}

/**
 * Toast — bottom-right notification, same component pattern used
 * by the other feature pages.
 */
function Toast({ tone, message, onDismiss }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        zIndex: 80,
        maxWidth: "360px",
        background: "var(--card)",
        border: tone === "success" ? "0.5px solid var(--gold-border)" : "0.5px solid var(--border)",
        borderRadius: "10px",
        padding: "16px 40px 16px 16px",
        fontFamily: "Inter, sans-serif",
        fontSize: "13px",
        color: "var(--text)",
      }}
    >
      <p style={{ margin: 0, lineHeight: 1.5 }}>{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{
          position: "absolute",
          top: "8px",
          right: "8px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: "18px",
        }}
      >
        ×
      </button>
    </div>
  );
}

/**
 * SessionChip — small pill showing "May/June" (gold) or
 * "October/November" (neutral). Used on each paper card.
 */
function SessionChip({ session }) {
  if (!session) return null;
  const isMayJune = session === "May/June";
  const cls = isMayJune
    ? "bg-gold text-background"
    : "bg-card text-text-muted border border-input-border";
  return (
    <span
      className={
        "inline-block px-2 py-0.5 rounded-4px text-xs font-body-semibold " +
        cls
      }
    >
      {session}
    </span>
  );
}

/**
 * StatusIcon — render the right icon for the paper's processing
 * state. Used in the bottom-right of each library card.
 */
function StatusIcon({ status }) {
  if (status === "processing") {
    return (
      <Loader2
        size={18}
        aria-label="Processing"
        className="text-gold animate-spin"
      />
    );
  }
  if (status === "failed") {
    return (
      <AlertCircle size={18} aria-label="Failed" className="text-red-600" />
    );
  }
  return (
    <CheckCircle size={18} aria-label="Solved" className="text-gold" />
  );
}


// ─────────────────────────────────────────────────────────────
// SUBJECT DROPDOWN — custom picker used in the upload modal.
// ─────────────────────────────────────────────────────────────
// Native <select> can't render coloured pills inside its option
// list, so we build a small button + panel here. Outside-click
// and Escape both close the panel. Same component pattern used
// by the timetable modal.

function SubjectDropdown({ subjectIndex, value, onChange, error }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  // Close on outside click / Escape while open.
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
        style={{
          ...UPLOAD_MODAL_FIELD_STYLE,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          appearance: "none",
          cursor: "pointer",
          border: error ? UPLOAD_MODAL_FIELD_ERROR_BORDER : UPLOAD_MODAL_FIELD_STYLE.border,
        }}
        onFocus={uploadFieldFocus}
        onBlur={(e) => uploadFieldBlur(e, error)}
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
            "flex-shrink-0 transition-transform " + (open ? "rotate-180" : "")
          }
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Choose subject"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            marginTop: "4px",
            zIndex: 10,
            background: "var(--card)",
            color: "var(--text)",
            border: "0.5px solid var(--gold-border-hover)",
            borderRadius: "8px",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
            maxHeight: "16rem",
            overflowY: "auto",
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
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


// ─────────────────────────────────────────────────────────────
// PAPER CARD — single card shown in VIEW 1's subject sections.
// ─────────────────────────────────────────────────────────────

/** VIEW 1 — paper row; View Solution opens VIEW 4 */
function PaperCard({ paper, subjectMeta, onOpen, onDelete }) {
  const subjectKey = subjectMeta?.key || "economics";
  const subjectName = subjectMeta?.name || "Subject";
  const subjectCode = subjectMeta?.code || "";
  const title = `${subjectName} ${subjectCode} · ${paper.year || ""} ${paper.session || ""}`.trim();
  const modeLabel =
    paper.mode === SOLVE_MODE.SELECTED ? "Selected questions" : "Full paper";
  const yearSession =
    paper.year && paper.session
      ? `${paper.year} · ${paper.session}`
      : paper.year || paper.session || "";

  return (
    <div
      className="past-papers-card"
      style={{
        background: "var(--card)",
        border: "0.5px solid var(--gold-border)",
        borderRadius: "10px",
        padding: "20px 24px",
        display: "flex",
        alignItems: "center",
        gap: "20px",
        transition: "background 200ms, border-color 200ms",
        position: "relative",
      }}
    >
      <div className="past-papers-card-left" style={{ flexShrink: 0 }}>
        <SubjectBadge subject={subjectKey} label={subjectMeta?.name || "Subject"} />
        {yearSession ? (
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", marginBottom: 0 }}>
            {yearSession}
          </p>
        ) : null}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: "15px", color: "var(--text)", fontWeight: 700, margin: 0, lineHeight: 1.3 }}>
          {title}
        </h3>
        <p style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--text-muted)", marginTop: "4px", marginBottom: 0 }}>
          {modeLabel}
          {paper.mode === SOLVE_MODE.SELECTED && paper.selected_questions
            ? ` (Q${paper.selected_questions})`
            : ""}
        </p>
        <p style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--text-extra-dim)", marginTop: "2px", marginBottom: 0 }}>
          Solved {timeAgo(paper.uploaded_at)}
        </p>
      </div>

      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "8px" }}>
        <button
          type="button"
          onClick={() => onOpen(paper)}
          className="past-papers-view-btn"
          style={{
            background: "transparent",
            border: "0.5px solid var(--gold-border-active)",
            borderRadius: "6px",
            padding: "8px 16px",
            fontFamily: "Inter, sans-serif",
            fontSize: "12px",
            fontWeight: 500,
            color: "var(--gold)",
            cursor: "pointer",
          }}
        >
          View Solution →
        </button>
        <button
          type="button"
          onClick={() => onDelete(paper)}
          aria-label={`Delete ${title}`}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: "4px",
          }}
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// UPLOAD MODAL (VIEW 2)
// ─────────────────────────────────────────────────────────────
//
// Steps the user moves through inside this single modal:
//   1. Fill in subject / year / session
//   2. Drag-and-drop or browse for a PDF (validated for type/size)
//   3. Pick a solve mode (full vs selected). For "selected", a
//      text input collects the comma-separated question numbers.
//   4. Click "Solve Paper" — the upload + insert + transition to
//      VIEW 3 happens in the parent's handler.

function UploadModal({
  subjectIndex,
  onCancel,
  onSubmit,
  uploading,
  uploadProgress,
}) {
  // Form fields — local state because the modal is unmounted /
  // remounted every time it opens, so we don't need to lift this.
  const [subjectId, setSubjectId] = useState("");
  const [year, setYear] = useState("");
  const [session, setSession] = useState("");
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [mode, setMode] = useState(SOLVE_MODE.FULL);
  const [selectedQs, setSelectedQs] = useState("");
  const [errors, setErrors] = useState({});

  // Drag-state controls the visual "active" state of the drop
  // zone — we toggle on dragenter and clear on dragleave/drop.
  const [dragActive, setDragActive] = useState(false);

  // Hidden <input type="file"> we trigger from the "Browse" link.
  const fileInputRef = useRef(null);

  // ESC closes the modal (unless an upload is in flight — we
  // don't want a stray Escape to abandon a half-uploaded paper).
  useEffect(() => {
    const onEsc = (e) => {
      if (e.key === "Escape" && !uploading) onCancel();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onCancel, uploading]);

  // Body scroll-lock while the modal is open. Uses Tailwind's
  // overflow-hidden utility on document.body so we never touch
  // inline styles.
  useEffect(() => {
    document.body.classList.add("overflow-hidden");
    return () => document.body.classList.remove("overflow-hidden");
  }, []);


  /**
   * applyFile — central place that runs validatePdfFile on a
   * candidate File object and stores it (or the error) in state.
   * Used by both the drag-drop handler and the <input> change
   * handler so the validation logic lives in one place.
   */
  const applyFile = (candidate) => {
    const v = validatePdfFile(candidate);
    if (!v.ok) {
      setFile(null);
      setFileError(v.error);
      return;
    }
    setFile(candidate);
    setFileError(null);
  };


  // ── Drag / drop handlers (native HTML5, no library) ─────────
  const onDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };
  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };
  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) applyFile(dropped);
  };


  /**
   * validate — gather all field-level errors. Returns true iff
   * all required values are present. Each error is keyed by
   * field name so the inputs can highlight themselves.
   */
  const validate = () => {
    const next = {};
    if (!subjectId) next.subjectId = "Choose a subject.";
    const yr = parseInt(year, 10);
    const currentYear = new Date().getFullYear();
    if (!yr || Number.isNaN(yr)) next.year = "Enter the paper's year.";
    else if (yr < MIN_YEAR || yr > currentYear)
      next.year = `Year must be between ${MIN_YEAR} and ${currentYear}.`;
    if (!session) next.session = "Choose a session.";
    if (!file) next.file = "Attach a PDF file.";
    if (mode === SOLVE_MODE.SELECTED) {
      const qs = parseSelectedQuestions(selectedQs);
      if (qs.length === 0)
        next.selectedQs = "Enter at least one question number.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (uploading) return;
    if (!validate()) return;
    onSubmit({
      subjectId,
      year: parseInt(year, 10),
      session,
      file,
      mode,
      selectedQuestions:
        mode === SOLVE_MODE.SELECTED
          ? parseSelectedQuestions(selectedQs).join(", ")
          : null,
    });
  };

  // Visual classes for the two solve-mode option cards.
  const modeCardBase =
    "flex-1 text-left p-3 rounded-4px border transition-colors " +
    "focus:outline-none focus:ring-2 focus:ring-gold/30";
  const modeCardSelected = "border-gold border-2 bg-gold/10";
  const modeCardUnselected =
    "border-input-border bg-card hover:border-gold";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
      style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", background: "rgba(0,0,0,0.7)" }}
      onClick={uploading ? undefined : onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--card)", border: "0.5px solid var(--gold-border)", borderRadius: "12px", padding: "32px", maxWidth: "520px", width: "90vw", maxHeight: "90vh", overflowY: "auto", margin: "auto" }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-5">
          <h2
            id="upload-modal-title"
            style={{ fontFamily: "'Playfair Display', serif", fontSize: "20px", color: "var(--text)", fontWeight: 700, margin: 0 }}
          >
            Upload Past Paper
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={uploading}
            aria-label="Close modal"
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "50%",
              background: "var(--card-hover)",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <style>{`
            #paper-session {
              appearance: none;
              cursor: pointer;
            }
            #paper-session option {
              background: var(--card);
              color: var(--text);
            }
          `}</style>
          {/* ── Subject ─────────────────────────────────────── */}
          <div>
            <label style={UPLOAD_MODAL_LABEL_STYLE}>Subject</label>
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

          {/* ── Year + Session (two columns) ────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="paper-year" style={UPLOAD_MODAL_LABEL_STYLE}>
                Year
              </label>
              <input
                id="paper-year"
                type="number"
                min={MIN_YEAR}
                max={new Date().getFullYear()}
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder="e.g. 2023"
                style={{
                  ...UPLOAD_MODAL_FIELD_STYLE,
                  border: errors.year
                    ? UPLOAD_MODAL_FIELD_ERROR_BORDER
                    : UPLOAD_MODAL_FIELD_STYLE.border,
                }}
                onFocus={uploadFieldFocus}
                onBlur={(e) => uploadFieldBlur(e, !!errors.year)}
              />
              {errors.year && (
                <p className="text-red-600 text-xs font-body mt-1">
                  {errors.year}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="paper-session" style={UPLOAD_MODAL_LABEL_STYLE}>
                Session
              </label>
              <select
                id="paper-session"
                value={session}
                onChange={(e) => setSession(e.target.value)}
                style={{
                  ...UPLOAD_MODAL_FIELD_STYLE,
                  appearance: "none",
                  cursor: "pointer",
                  border: errors.session
                    ? UPLOAD_MODAL_FIELD_ERROR_BORDER
                    : UPLOAD_MODAL_FIELD_STYLE.border,
                }}
                onFocus={uploadFieldFocus}
                onBlur={(e) => uploadFieldBlur(e, !!errors.session)}
              >
                <option value="">Choose…</option>
                {SESSION_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {errors.session && (
                <p className="text-red-600 text-xs font-body mt-1">
                  {errors.session}
                </p>
              )}
            </div>
          </div>

          {/* ── PDF upload zone (native HTML5 drag/drop) ────── */}
          <div>
            <label className="block font-body text-text-muted text-xs uppercase tracking-wide mb-1">
              PDF file
            </label>
            <div
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={
                "rounded-4px py-10 px-4 text-center transition-colors " +
                (dragActive
                  ? "bg-hover border-2 border-solid border-gold"
                  : "bg-card border-2 border-dashed border-gold")
              }
            >
              <FileUp
                size={32}
                aria-hidden="true"
                className="mx-auto text-gold mb-2"
              />
              <p className="font-body font-body-medium text-text-primary text-sm">
                Drag and drop your PDF here
              </p>
              <p className="font-body text-text-muted text-xs my-1">or</p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={
                  "inline-flex items-center px-3 py-1.5 rounded-4px " +
                  "border border-gold text-gold font-body font-body-semibold " +
                  "text-xs hover:bg-hover transition-colors focus:outline-none " +
                  "focus:ring-2 focus:ring-gold/30"
                }
              >
                Browse files
              </button>
              {/* Hidden file picker so the "Browse" button can
                  trigger it imperatively. accept attribute hints
                  the OS to filter to PDFs, but we still validate
                  in JS as the user can override. */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) applyFile(f);
                  // Reset the input so picking the same file
                  // twice still fires onChange.
                  e.target.value = "";
                }}
              />
            </div>
            {(fileError || errors.file) && (
              <p className="text-red-600 text-xs font-body mt-1">
                {fileError || errors.file}
              </p>
            )}

            {/* File preview card — appears once a valid file is
                attached. Lets the user clear and pick another. */}
            {file && !fileError && (
              <div className="mt-2 flex items-center gap-3 p-3 bg-card border border-input-border rounded-4px">
                <FileText
                  size={20}
                  aria-hidden="true"
                  className="text-gold flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-body font-body-semibold text-text-primary text-sm truncate">
                    {file.name}
                  </p>
                  <p className="font-body text-text-muted text-xs">
                    {formatFileSize(file.size)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setFile(null);
                    setFileError(null);
                  }}
                  aria-label="Remove file"
                  className={
                    "p-1 text-text-muted hover:text-red-600 " +
                    "transition-colors rounded-4px focus:outline-none " +
                    "focus:ring-2 focus:ring-gold/30"
                  }
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>

          {/* ── Solve mode (two option cards) ──────────────── */}
          <div>
            <p className="font-body text-text-muted text-xs uppercase tracking-wide mb-2">
              How would you like to solve this paper?
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setMode(SOLVE_MODE.FULL)}
                aria-pressed={mode === SOLVE_MODE.FULL}
                className={
                  modeCardBase +
                  " " +
                  (mode === SOLVE_MODE.FULL
                    ? modeCardSelected
                    : modeCardUnselected)
                }
              >
                <BookOpen
                  size={18}
                  aria-hidden="true"
                  className="text-gold mb-1"
                />
                <p className="font-body font-body-semibold text-text-primary text-sm">
                  Full Paper
                </p>
                <p className="font-body text-text-muted text-xs mt-0.5">
                  AI solves every question in the paper
                </p>
              </button>
              <button
                type="button"
                onClick={() => setMode(SOLVE_MODE.SELECTED)}
                aria-pressed={mode === SOLVE_MODE.SELECTED}
                className={
                  modeCardBase +
                  " " +
                  (mode === SOLVE_MODE.SELECTED
                    ? modeCardSelected
                    : modeCardUnselected)
                }
              >
                <ListChecks
                  size={18}
                  aria-hidden="true"
                  className="text-gold mb-1"
                />
                <p className="font-body font-body-semibold text-text-primary text-sm">
                  Selected Questions
                </p>
                <p className="font-body text-text-muted text-xs mt-0.5">
                  Choose which questions to solve
                </p>
              </button>
            </div>

            {/* Selected-questions input is revealed only when
                that mode is active. */}
            {mode === SOLVE_MODE.SELECTED && (
              <div className="mt-3">
                <label
                  htmlFor="paper-questions"
                  className="block font-body text-text-muted text-xs uppercase tracking-wide mb-1"
                >
                  Question numbers
                </label>
                <input
                  id="paper-questions"
                  type="text"
                  value={selectedQs}
                  onChange={(e) => setSelectedQs(e.target.value)}
                  placeholder="e.g. 1, 2, 5, 7"
                  className={
                    "w-full px-3 py-2 bg-input-bg border rounded-4px " +
                    "text-text-primary font-body text-sm placeholder:text-text-hint " +
                    "focus:outline-none focus:ring-2 focus:ring-gold/30 " +
                    (errors.selectedQs
                      ? "border-red-400"
                      : "border-input-border")
                  }
                />
                <p className="font-body text-text-muted text-xs mt-1">
                  Enter question numbers separated by commas.
                </p>
                {errors.selectedQs && (
                  <p className="text-red-600 text-xs font-body mt-1">
                    {errors.selectedQs}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Buttons row ─────────────────────────────────── */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={uploading}
              className={
                "px-4 py-2 rounded-4px border border-gold text-gold " +
                "font-body font-body-semibold text-sm " +
                "hover:bg-hover transition-colors focus:outline-none " +
                "focus:ring-2 focus:ring-gold/30 disabled:opacity-50"
              }
            >
              Cancel
            </button>

            {/* Solve button — when `uploading` is true the button
                hosts an inline progress bar. The dynamic width
                IS the one allowed inline style on this page
                (Tailwind JIT can't generate runtime percentages). */}
            <button
              type="submit"
              disabled={uploading}
              className={
                "relative overflow-hidden px-4 py-2 rounded-4px " +
                "bg-gold text-background font-body font-body-semibold " +
                "text-sm hover:bg-gold-light transition-colors " +
                "focus:outline-none focus:ring-2 focus:ring-gold/30 " +
                "disabled:opacity-90 inline-flex items-center gap-2"
              }
            >
              {uploading && (
                <span
                  // Animating progress overlay. Sits behind the
                  // button label and grows horizontally as the
                  // upload progresses.
                  className="absolute inset-y-0 left-0 bg-gold-light transition-[width] duration-200"
                  style={{ width: `${Math.max(0, Math.min(100, uploadProgress))}%` }}
                  aria-hidden="true"
                />
              )}
              <span className="relative inline-flex items-center gap-2">
                {uploading ? (
                  <>
                    <Loader2
                      size={14}
                      aria-hidden="true"
                      className="animate-spin"
                    />
                    Uploading... {Math.round(uploadProgress)}%
                  </>
                ) : (
                  <>Solve Paper →</>
                )}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// PROCESSING VIEW (VIEW 3)
// ─────────────────────────────────────────────────────────────
//
// Full-page replacement of VIEW 1. Shows the simulated solving
// pipeline. The parent component controls the `currentStep`
// (advancing via setTimeout) and calls onComplete when done —
// this component just renders the visuals.

function ProcessingView({ paper, currentStep, subjectMeta, onCancel }) {
  const subjectName = subjectMeta?.name || "Subject";
  const subjectCode = subjectMeta?.code || "";
  const detail = [
    `${subjectName} ${subjectCode}`.trim(),
    paper?.year,
    paper?.session,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
      <div style={{ maxWidth: "480px", width: "100%", background: "var(--card)", border: "0.5px solid var(--gold-border)", borderRadius: "10px", padding: "32px", textAlign: "center" }}>
        <div style={{ width: "64px", height: "64px", margin: "0 auto 20px", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Loader2 size={40} strokeWidth={1.5} color="var(--gold)" className="animate-spin" aria-hidden />
        </div>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: "24px", color: "var(--text)", fontWeight: 700, margin: 0 }}>
          {currentStep >= PROCESSING_STEPS.length ? "Solution ready!" : "Solving your paper…"}
        </h2>
        {detail ? (
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", marginTop: "8px" }}>{detail}</p>
        ) : null}
        <ol style={{ textAlign: "left", marginTop: "24px", padding: 0, listStyle: "none" }}>
          {PROCESSING_STEPS.map((label, i) => {
            const done = i < currentStep;
            const active = i === currentStep;
            const Icon = done ? CheckCircle : active ? Loader2 : Circle;
            return (
              <li key={label} style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "12px" }}>
                <Icon
                  size={18}
                  aria-hidden
                  className={active ? "animate-spin" : ""}
                  color={done || active ? "var(--gold)" : "var(--text-muted)"}
                  style={{ flexShrink: 0, marginTop: "2px" }}
                />
                <span
                  style={{
                    fontFamily: "Inter, sans-serif",
                    fontSize: "13px",
                    color: done ? "var(--text-muted)" : active ? "var(--text)" : "var(--text-muted)",
                    textDecoration: done ? "line-through" : "none",
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
        <button
          type="button"
          onClick={onCancel}
          style={{ marginTop: "16px", background: "none", border: "none", fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", cursor: "pointer" }}
        >
          Cancel
        </button>
      </div>
    </main>
  );
}



// ─────────────────────────────────────────────────────────────
// QUESTION BLOCK (used inside VIEW 4)
// ─────────────────────────────────────────────────────────────
//
// One question: question text + model answer; mark scheme +
// examiner insights collapse independently. Each section's expanded state
// is held in the parent so navigating away and back wouldn't
// reset everything — but the parent always reinitialises on
// paper change anyway.

function QuestionBlock({
  question,
  qIndex,
  expanded,
  onToggle,
}) {
  // Build the three section keys upfront so we don't repeat
  // string concatenation in JSX.
  const schemeKey = `${qIndex}-scheme`;
  const tipsKey = `${qIndex}-tips`;
  const paragraphs = getModelAnswerParagraphs(question);

  /**
   * SectionHeader — small inline helper for the three section
   * headers that each act as the collapse toggle. We render the
   * chevron based on whether the section is expanded.
   */
  // Collapsible section header — toggles mark scheme / examiner insights
  const SectionHeader = ({ label, sectionKey, isOpen }) => (
    <button
      type="button"
      onClick={() => onToggle(sectionKey)}
      aria-expanded={isOpen}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: "8px 0",
      }}
    >
      <span style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-muted)" }}>
        {label}
      </span>
      {isOpen ? (
        <ChevronUp size={16} color="var(--text-muted)" aria-hidden />
      ) : (
        <ChevronDown size={16} color="var(--text-muted)" aria-hidden />
      )}
    </button>
  );

  return (
    <article>
      <header style={{ display: "flex", alignItems: "center", flexWrap: "wrap", marginBottom: "16px" }}>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: "20px", color: "var(--text)", fontWeight: 700, margin: 0 }}>
          Question {question.number}
        </h3>
        {question.marks_available != null && (
          <span
            style={{
              background: "var(--gold-dim)",
              border: "0.5px solid var(--gold-border-active)",
              borderRadius: "3px",
              padding: "3px 10px",
              fontFamily: "Inter, sans-serif",
              fontSize: "11px",
              color: "var(--gold)",
              marginLeft: "12px",
            }}
          >
            [{question.marks_available} marks]
          </span>
        )}
      </header>

      {question.question_text ? (
        <section style={{ marginBottom: "20px" }}>
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--date-color)", marginBottom: "8px" }}>
            QUESTION
          </p>
          <div
            style={{
              background: "var(--nav-icon-bg)",
              borderLeft: "2px solid var(--gold)",
              border: "0.5px solid var(--chat-bubble-border)",
              borderRadius: "6px",
              padding: "14px 16px",
              fontFamily: "Inter, sans-serif",
              fontSize: "13px",
              color: "var(--text)",
              lineHeight: 1.7,
            }}
          >
            {question.question_text}
          </div>
        </section>
      ) : null}

      <section style={{ marginBottom: "16px" }}>
        <p style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--date-color)", marginBottom: "8px" }}>
          MODEL ANSWER
        </p>
        {paragraphs.length > 0 ? (
          paragraphs.map((para, i) => (
            <p
              key={i}
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "14px",
                color: "var(--text)",
                lineHeight: 1.8,
                marginBottom: "12px",
              }}
            >
              {para}
            </p>
          ))
        ) : (
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)" }}>
            No model answer available for this question.
          </p>
        )}
      </section>

      <div style={{ marginTop: "16px" }}>
        <SectionHeader
          label="MARK SCHEME BREAKDOWN"
          sectionKey={schemeKey}
          isOpen={!!expanded[schemeKey]}
        />
        {expanded[schemeKey] && (
          <div style={{ marginTop: "8px", border: "0.5px solid var(--chat-bubble-border)", borderRadius: "6px", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
              <thead>
                <tr style={{ background: "var(--accordion-gap-bg)" }}>
                  <th style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", textTransform: "uppercase", color: "var(--date-color)", padding: "10px 14px" }}>
                    What examiners look for
                  </th>
                  <th style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", textTransform: "uppercase", color: "var(--date-color)", padding: "10px 14px", width: "80px", textAlign: "right" }}>
                    Marks
                  </th>
                </tr>
              </thead>
              <tbody>
                {question.mark_scheme?.map((row, i) => (
                  <tr key={i} style={{ borderTop: "0.5px solid var(--border)" }}>
                    <td style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text)", padding: "10px 14px", lineHeight: 1.5 }}>
                      {row.criterion}
                    </td>
                    <td style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text)", padding: "10px 14px", textAlign: "right" }}>
                      {row.marks}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ marginTop: "12px" }}>
        <SectionHeader
          label="EXAMINER INSIGHTS"
          sectionKey={tipsKey}
          isOpen={!!expanded[tipsKey]}
        />
        {expanded[tipsKey] && (
          <div style={{ padding: "8px 0 12px", fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-dim)", lineHeight: 1.7 }}>
            {question.examiner_tip && <p style={{ margin: "0 0 12px" }}>{question.examiner_tip}</p>}
            {question.common_mistakes?.map((m, i) => (
              <p key={i} style={{ margin: "0 0 8px" }}>
                <strong>Mistake:</strong> {m.mistake}
                {m.explanation ? ` — ${m.explanation}` : ""}
              </p>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}



// ─────────────────────────────────────────────────────────────
// SOLUTION VIEW (VIEW 4) — single full-width panel, no PDF iframe
// ─────────────────────────────────────────────────────────────

function SolutionView({
  paper,
  subjectMeta,
  showNotesBanner = false,
  onBack,
}) {
  const [expanded, setExpanded] = useState(() => {
    const seed = {};
    paper?.solution?.questions?.forEach((_, i) => {
      seed[`${i}-scheme`] = false;
      seed[`${i}-tips`] = false;
    });
    return seed;
  });
  const toggle = (k) => setExpanded((p) => ({ ...p, [k]: !p[k] }));

  const subjectName = subjectMeta?.name || "Subject";
  const subjectCode = subjectMeta?.code || "";
  const titlePieces = [
    `${subjectName}${subjectCode ? ` ${subjectCode}` : ""}`.trim(),
    paper?.year && paper?.session ? `${paper.year} ${paper.session}` : null,
  ].filter(Boolean);
  const headerTitle = titlePieces.join(" · ");

  const solution = paper?.solution;
  const modeLabel =
    paper?.mode === SOLVE_MODE.SELECTED
      ? "Selected Questions"
      : "Full Paper";

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "16px var(--page-padding)",
          borderBottom: "1px solid var(--border-light)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to papers library"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            color: "var(--text-muted)",
          }}
        >
          <ArrowLeft size={18} aria-hidden />
          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "16px", color: "var(--text)", fontWeight: 700 }}>
            {headerTitle}
          </span>
        </button>
        <span
          style={{
            border: "0.5px solid var(--gold-border-active)",
            borderRadius: "4px",
            padding: "3px 10px",
            fontFamily: "Inter, sans-serif",
            fontSize: "11px",
            color: "var(--gold)",
            flexShrink: 0,
          }}
        >
          {modeLabel}
        </span>
      </header>

      <div style={{ flex: 1, maxWidth: "860px", margin: "0 auto", width: "100%", padding: "24px var(--page-padding) 40px" }}>
        {!solution || !solution.questions?.length ? (
          <div style={{ textAlign: "center", padding: "48px 0" }}>
            <FileQuestion size={36} color="var(--text-muted)" aria-hidden style={{ margin: "0 auto 12px", display: "block" }} />
            <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text)" }}>No stored solution for this paper.</p>
            <p style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
              Re-upload to regenerate the AI solution.
            </p>
          </div>
        ) : (
          <>
            {solution.questions.map((q, i) => (
              <div key={i}>
                {i > 0 ? (
                  <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "28px 0" }} />
                ) : null}
                <QuestionBlock
                  question={q}
                  qIndex={i}
                  expanded={expanded}
                  onToggle={toggle}
                />
              </div>
            ))}

            {solution.summary ? (
              <section
                aria-label="Paper Summary"
                style={{
                  background: "var(--card)",
                  border: "0.5px solid var(--gold-border)",
                  borderRadius: "10px",
                  padding: "24px",
                  marginTop: "32px",
                }}
              >
                <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: "18px", color: "var(--text)", fontWeight: 700, margin: "0 0 16px" }}>
                  Paper Summary
                </h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "20px" }}>
                  <div>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--date-color)", marginBottom: "4px" }}>Total marks</p>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text)" }}>{solution.summary.total_marks ?? "—"}</p>
                  </div>
                  <div>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--date-color)", marginBottom: "4px" }}>Key topics</p>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text)", lineHeight: 1.5 }}>
                      {solution.summary.key_topics?.length ? solution.summary.key_topics.join(", ") : "—"}
                    </p>
                  </div>
                  <div>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--date-color)", marginBottom: "4px" }}>Difficulty</p>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text)" }}>{solution.summary.difficulty ?? "—"}</p>
                  </div>
                  <div>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--date-color)", marginBottom: "4px" }}>Revision areas</p>
                    <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text)", lineHeight: 1.5 }}>
                      {solution.summary.revision_areas?.length ? solution.summary.revision_areas.join(", ") : "—"}
                    </p>
                  </div>
                </div>
              </section>
            ) : null}
          </>
        )}

        {showNotesBanner ? (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginTop: "32px",
              display: "flex",
              alignItems: "flex-start",
              gap: "12px",
              padding: "16px",
              borderRadius: "6px",
              border: "0.5px solid var(--gold-border)",
              background: "var(--chat-bubble-bg)",
            }}
          >
            <Sparkles size={16} color="var(--gold)" aria-hidden style={{ flexShrink: 0, marginTop: "2px" }} />
            <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", margin: 0, lineHeight: 1.6 }}>
              Study notes are being generated from this paper…
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}


// ─────────────────────────────────────────────────────────────
// DELETE CONFIRM MODAL
// ─────────────────────────────────────────────────────────────

function DeleteConfirmModal({ paper, onCancel, onConfirm, submitting }) {
  useEffect(() => {
    document.body.classList.add("overflow-hidden");
    const onEsc = (e) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    document.addEventListener("keydown", onEsc);
    return () => {
      document.body.classList.remove("overflow-hidden");
      document.removeEventListener("keydown", onEsc);
    };
  }, [onCancel, submitting]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-paper-title"
      className={
        "fixed inset-0 z-[60] flex items-center justify-center p-4 " +
        "bg-black/50"
      }
      onClick={submitting ? undefined : onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={
          "bg-white border border-input-border rounded-4px " +
          "shadow-xl w-full max-w-[380px] p-6"
        }
      >
        <h3
          id="delete-paper-title"
          className="font-heading text-text-primary text-xl font-heading-bold"
        >
          Delete this paper and its solution?
        </h3>
        <p className="font-body text-text-muted text-sm mt-2 leading-relaxed">
          The original PDF and AI solution will be permanently removed. This
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


// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────

export default function PastPapersPage() {
  const router = useRouter();

  // ── State: gating / user ──────────────────────────────────
  const [authReady, setAuthReady] = useState(false);
  const [userId, setUserId] = useState(null);
  const userIdRef = useRef(null);

  // ── State: data ───────────────────────────────────────────
  // subjectIndex powers every subject_id → metadata lookup.
  const [subjectIndex, setSubjectIndex] = useState({
    ordered: [],
    byId: {},
    byKey: {},
  });
  // Papers shown in VIEW 1's grid. Optimistically updated on
  // upload / delete; reverted on Supabase error.
  const [papers, setPapers] = useState([]);
  const [papersLoading, setPapersLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);

  // ── State: view machine ──────────────────────────────────
  // currentView controls the big body switch (library /
  // processing / split). The upload modal is independent of
  // this and overlays the library view.
  const [currentView, setCurrentView] = useState(VIEW.LIBRARY);
  const [selectedPaper, setSelectedPaper] = useState(null);

  // ── State: overlays ──────────────────────────────────────
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [submittingDelete, setSubmittingDelete] = useState(false);
  const [toast, setToast] = useState(null);

  // ── State: processing (VIEW 3) ───────────────────────────
  // processingPaper is the paper currently being "solved".
  // processingStep is an index into PROCESSING_STEPS.
  const [processingPaper, setProcessingPaper] = useState(null);
  const [processingStep, setProcessingStep] = useState(0);

  // Tracks which paper id (if any) has background note
  // generation in flight. The banner inside VIEW 4 reads this
  // and auto-hides after NOTES_BANNER_MS. Stored as the paper
  // id (not a boolean) so opening a different paper doesn't
  // accidentally inherit the banner from a previous solve.
  const [notesGeneratingPaperId, setNotesGeneratingPaperId] = useState(null);

  // VIEW 1 — active subject filter tab (All | Economics | …).
  const [activeFilter, setActiveFilter] = useState(FILTER_ALL);


  // ───────────────────────────────────────────────────────────
  // EFFECT 1 — Auth + onboarding guard.
  // ───────────────────────────────────────────────────────────
  // Same pattern as every other feature page. Returns the user
  // to /login if not signed in, or to /onboarding/welcome if
  // they haven't finished onboarding yet.
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (cancelled) return;

      if (error || !user) {
        console.warn("[PastPapers] No session – redirecting to /login");
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
  // EFFECT 2 — Fetch subjects + papers in parallel.
  // ───────────────────────────────────────────────────────────
  // Combined into one effect (same pattern as timetable's
  // bug-fixed version) so the loading state is guaranteed to
  // resolve in a try/catch/finally regardless of which call
  // succeeds or fails.
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;

    const fetchAll = async () => {
      setPapersLoading(true);
      try {
        // ── Subjects come straight from Supabase (cheap read,
        // never authenticated since `subjects` is shared). ──
        const subjectRes = await supabase.from("subjects").select("*");
        if (cancelled) return;
        const nextIndex = subjectRes.error
          ? { ordered: [], byId: {}, byKey: {} }
          : buildSubjectIndex(subjectRes.data || []);
        if (subjectRes.error) {
          console.warn(
            "[PastPapers] Could not load subjects:",
            subjectRes.error,
          );
        }
        setSubjectIndex(nextIndex);

        // ── Papers come from the BACKEND /past-papers/list ──
        // endpoint. It carries the joined subject name + code
        // and a derived `has_solution` flag we wouldn't get
        // from a flat Supabase select. We still degrade to
        // the mock library if the call fails — the page never
        // shows a blank library in dev.
        let backendRows = null;
        try {
          const { data: sessionData } = await supabase.auth.getSession();
          const token = sessionData?.session?.access_token;
          const uid = sessionData?.session?.user?.id;
          if (token && uid) {
            const listUrl =
              `${API_URL}/past-papers/list` +
              `?user_id=${encodeURIComponent(uid)}`;
            const res = await fetch(listUrl, {
              method: "GET",
              headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
              const body = await res.json();
              if (Array.isArray(body?.data)) {
                backendRows = body.data;
              }
            } else {
              console.warn(
                "[PastPapers] /past-papers/list non-2xx:",
                res.status,
              );
            }
          }
        } catch (apiErr) {
          // Network / fetch threw — logged and we fall through
          // to the mock library below.
          console.warn(
            "[PastPapers] /past-papers/list threw:",
            apiErr,
          );
        }

        if (cancelled) return;

        if (backendRows && backendRows.length > 0) {
          // Real papers from the backend — normalise into the
          // rich client shape so VIEW 1 and VIEW 4 keep using
          // the same field names everywhere.
          setPapers(backendRows.map((r) => normalizePaper(r)));
          setUsingMock(false);
        } else if (backendRows && backendRows.length === 0) {
          // Backend was reachable but the user has zero papers.
          // Show the mock library as a friendly empty-state
          // hint (same behaviour the page had before).
          const mock = buildMockPapers(nextIndex.byKey);
          setPapers(mock);
          setUsingMock(true);
        } else {
          // Backend unreachable. Fall back to whatever Supabase
          // can return directly — same defensive read the page
          // used pre-backend. If even that fails we show mocks.
          const paperRes = await supabase
            .from("past_papers")
            .select("*")
            .order("uploaded_at", { ascending: false });
          if (cancelled) return;
          if (paperRes.error || !paperRes.data?.length) {
            const mock = buildMockPapers(nextIndex.byKey);
            setPapers(mock);
            setUsingMock(true);
          } else {
            setPapers(paperRes.data.map((r) => normalizePaper(r)));
            setUsingMock(false);
          }
        }
      } catch (err) {
        console.error("[PastPapers] fetch threw:", err);
        if (!cancelled) {
          setPapers([]);
          setUsingMock(false);
        }
      } finally {
        if (!cancelled) setPapersLoading(false);
      }
    };

    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [authReady]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 3 — REAL processing pipeline (backend-driven).
  // ───────────────────────────────────────────────────────────
  //
  // Runs whenever `currentView` flips to "processing". Two
  // parallel things happen inside this effect:
  //
  //   (a) Timer-driven step progress. Steps 1 + 2 advance on
  //       fixed timers so the user sees instant feedback that
  //       *something* is happening. Step 3 has a fallback
  //       timer that fires at 8 s in case Groq is taking its
  //       time — this keeps the UI from looking frozen.
  //
  //   (b) The actual POST /past-papers/solve call. The moment
  //       the backend returns a solution we cancel any
  //       remaining timers, jump the step indicator to "done",
  //       and transition into VIEW 4. If the backend errors
  //       out we show a toast and bounce back to VIEW 1.
  //
  // PROCESSING_STEPS (5 total) map to:
  //   0. "Uploading PDF to secure storage"         — done before
  //      this effect even runs (handled by handleUpload).
  //   1. "Reading and extracting paper content"    — t = 1 s.
  //   2. "Analysing Cambridge mark scheme format"  — t = 3 s.
  //   3. "Generating step-by-step solutions"       — when
  //      backend responds OR t = 8 s.
  //   4. "Formatting final answer"                 — when backend
  //      responds (the very last beat before VIEW 4).
  //
  // Falls back to the mock solution stash ONLY when the paper
  // is a mock row (so dev-time browsing still works without
  // hitting Groq for every click).
  useEffect(() => {
    if (currentView !== VIEW.PROCESSING) return;
    if (!processingPaper) return;

    let cancelled = false;
    const timers = [];

    // ── (a) timer-driven step progression ───────────────────
    // Step 1 done at 1 s.
    timers.push(
      setTimeout(() => {
        if (!cancelled) setProcessingStep(1);
      }, PROCESSING_STEP_1_MS),
    );
    // Step 2 done at 3 s.
    timers.push(
      setTimeout(() => {
        if (!cancelled) setProcessingStep(2);
      }, PROCESSING_STEP_2_MS),
    );
    // Step 3 fallback at 8 s — only fires if the backend
    // hasn't already responded by then. Once the backend does
    // respond we jump straight past this step.
    timers.push(
      setTimeout(() => {
        if (!cancelled) {
          setProcessingStep((curr) => (curr < 3 ? 3 : curr));
        }
      }, PROCESSING_STEP_3_TIMEOUT_MS),
    );

    // ── helper: jump the renderer past step 5 and into VIEW 4 ─
    // Wrapped so the success path AND the mock-paper short-
    // circuit can call it without duplicating the transition.
    const finishWithSolution = (finalSolution, topics, notesPromised) => {
      if (cancelled) return;
      const finalised = {
        ...processingPaper,
        status: "solved",
        solution: finalSolution,
        high_frequency_topics: topics || null,
      };
      // Step 5 done (final formatting beat).
      setProcessingStep(PROCESSING_STEPS.length);
      // Update the library card so it shows the "Solved" tick.
      setPapers((prev) =>
        prev.map((p) => (p.id === finalised.id ? finalised : p)),
      );
      // Brief "Solution ready!" beat before VIEW 4.
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          setSelectedPaper(finalised);
          // Trigger the "notes generating" banner timer when
          // the backend told us notes are on their way.
          setNotesGeneratingPaperId(notesPromised ? finalised.id : null);
          setProcessingStep(0);
          setProcessingPaper(null);
          setCurrentView(VIEW.SPLIT);
        }, PROCESSING_FINAL_PAUSE_MS),
      );
    };

    // ── (b) call the backend ────────────────────────────────
    // Mock papers (from buildMockPapers) keep their stock
    // solutions — no need to fire a real Groq call for them.
    const isMock =
      !!processingPaper.is_mock ||
      String(processingPaper.id).startsWith("mock-");

    if (isMock) {
      // Use the bundled stock solution after the same beats
      // a real call would have taken (~step 3 timer hits).
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          const subjectMeta =
            subjectIndex.byId[processingPaper.subject_id];
          const subjectKey = subjectMeta?.key;
          const stockSolution =
            subjectKey && SOLUTION_BY_SUBJECT_KEY[subjectKey]
              ? SOLUTION_BY_SUBJECT_KEY[subjectKey]
              : null;
          finishWithSolution(stockSolution, null, false);
        }, PROCESSING_STEP_3_TIMEOUT_MS + 500),
      );
    } else {
      // Real Cambridge paper → call the backend.
      (async () => {
        try {
          // Pull the current bearer token. If we somehow
          // lost the session mid-flow, bounce back to /login
          // (the proxy would do this on the next protected
          // request anyway).
          const { data: sessionData } = await supabase.auth.getSession();
          const token = sessionData?.session?.access_token;
          if (!token) {
            throw new Error("No session — please log in again.");
          }

          const res = await fetch(`${API_URL}/past-papers/solve`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            // Body matches PastPaperSolveRequest in the
            // backend exactly — every value here was either
            // set by the upload form or derived from the
            // row we just inserted.
            body: JSON.stringify({
              paper_id: processingPaper.id,
              user_id: userIdRef.current,
              file_url: processingPaper.file_url,
              // Lets the backend download via service role when the
              // bucket is private (getPublicUrl still 403 for anon).
              storage_path: processingPaper.storage_path || null,
              subject_id: processingPaper.subject_id,
              paper_year: String(processingPaper.year || ""),
              paper_variant: String(processingPaper.session || ""),
            }),
          });

          if (cancelled) return;

          if (!res.ok) {
            // Parse any JSON error body the backend sent so
            // we can surface its `detail.error` field on the
            // toast — falls back to a generic message.
            let detailMsg = "Could not solve this paper. Please try again.";
            try {
              const errBody = await res.json();
              if (errBody?.detail?.error) {
                detailMsg = errBody.detail.error;
              } else if (typeof errBody?.detail === "string") {
                detailMsg = errBody.detail;
              }
            } catch (_) {
              // ignore parse errors — keep the generic message.
            }
            throw new Error(detailMsg);
          }

          const data = await res.json();
          if (cancelled) return;

          // Step 4 done — the backend just returned. We do
          // this BEFORE finishing so the user sees the four
          // earlier steps light up before the final transition.
          setProcessingStep((curr) => (curr < 4 ? 4 : curr));

          // Convert the backend solution into the renderer's
          // expected shape, then call finishWithSolution to
          // transition to VIEW 4.
          const normalised = normalizeBackendSolution(data?.solution);
          finishWithSolution(
            normalised,
            Array.isArray(data?.high_frequency_topics)
              ? data.high_frequency_topics
              : null,
            !!data?.notes_generating,
          );
        } catch (err) {
          if (cancelled) return;
          console.error("[PastPapers] /past-papers/solve failed:", err);
          // Bounce back to VIEW 1 with a red toast. The paper
          // row itself was already inserted — the user can
          // delete it or retry by re-uploading.
          setToast({
            tone: "error",
            message:
              err?.message ||
              "Could not solve this paper. Please try again.",
          });
          setProcessingPaper(null);
          setProcessingStep(0);
          setCurrentView(VIEW.LIBRARY);
        }
      })();
    }

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [currentView, processingPaper, subjectIndex.byId]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 4 — Toast auto-dismiss.
  // ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), TOAST_DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 5 — Notes-generating banner auto-clear.
  // ───────────────────────────────────────────────────────────
  // Whenever `notesGeneratingPaperId` becomes non-null we start
  // a NOTES_BANNER_MS-long countdown after which the banner
  // disappears regardless of what the backend's loop is doing.
  // The backend prints "[PastPapers] Generated note for topic:
  // X" lines while it works, but the user has no need to watch
  // them — 30 s is enough time for the loop to finish ~3 topics
  // and is the cleanest UX signal that things are wrapping up.
  useEffect(() => {
    if (!notesGeneratingPaperId) return;
    const id = setTimeout(
      () => setNotesGeneratingPaperId(null),
      NOTES_BANNER_MS,
    );
    return () => clearTimeout(id);
  }, [notesGeneratingPaperId]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 6 — Lazy solution fetch when VIEW 4 opens a paper
  // without an attached solution.
  // ───────────────────────────────────────────────────────────
  // When the user re-opens a previously-solved paper from the
  // library, `selectedPaper.solution` is null (we only get
  // the body filled in after a /past-papers/solve call). The
  // dedicated GET /past-papers/{paper_id}/solution endpoint
  // serves the stored questions_json so we can attach it on
  // the fly without re-running Groq.
  //
  // Skips when:
  //   • The paper already has a solution attached, OR
  //   • It's a mock paper (the stock SOLUTION_BY_SUBJECT_KEY
  //     is the canonical source for those), OR
  //   • We're not actually in the split view.
  useEffect(() => {
    if (currentView !== VIEW.SPLIT) return;
    if (!selectedPaper) return;
    if (selectedPaper.solution) return;
    if (selectedPaper.is_mock) return;
    if (String(selectedPaper.id || "").startsWith("mock-")) return;

    let cancelled = false;

    (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        if (!token) return; // proxy will handle login redirect.

        const url =
          `${API_URL}/past-papers/${encodeURIComponent(selectedPaper.id)}` +
          `/solution?user_id=${encodeURIComponent(userIdRef.current)}`;
        const res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          console.warn(
            "[PastPapers] solution fetch non-2xx:",
            res.status,
          );
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        // Backend returned no solution yet — leave the paper
        // as-is so VIEW 4 keeps showing its empty state.
        if (!data?.has_solution || !data?.solution) return;
        const normalised = normalizeBackendSolution(data.solution);
        // Attach the solution to BOTH the selectedPaper and the
        // matching library row so the user doesn't pay the
        // fetch cost twice on a quick back-and-forward.
        setSelectedPaper((prev) =>
          prev && prev.id === selectedPaper.id
            ? {
                ...prev,
                solution: normalised,
                high_frequency_topics:
                  data.high_frequency_topics ?? prev.high_frequency_topics,
              }
            : prev,
        );
        setPapers((prev) =>
          prev.map((p) =>
            p.id === selectedPaper.id
              ? {
                  ...p,
                  solution: normalised,
                  high_frequency_topics:
                    data.high_frequency_topics ?? p.high_frequency_topics,
                }
              : p,
          ),
        );
      } catch (err) {
        if (!cancelled) {
          console.warn("[PastPapers] solution fetch threw:", err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // selectedPaper.id is the only meaningful identity here;
    // selectedPaper itself changes on every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, selectedPaper?.id]);


  // ───────────────────────────────────────────────────────────
  // DERIVED VALUES
  // ───────────────────────────────────────────────────────────

  // Stat values shown at the top of VIEW 1.
  const stats = useMemo(() => {
    const total = papers.length;
    const thisMonth = papers.filter((p) => isThisMonth(p.uploaded_at)).length;
    const distinctSubjects = new Set(
      papers.map((p) => p.subject_id).filter(Boolean),
    ).size;
    return { total, thisMonth, distinctSubjects };
  }, [papers]);

  // Filter logic — narrows the flat papers list by subject key.
  const filteredPapers = useMemo(() => {
    if (activeFilter === FILTER_ALL) return papers;
    return papers.filter((paper) => {
      const meta = subjectIndex.byId[paper.subject_id];
      return meta?.key === activeFilter;
    });
  }, [papers, activeFilter, subjectIndex]);

  // Papers grouped by subject_id so VIEW 1 can render one
  // section per subject. Returns an array preserving the
  // subjectIndex.ordered order so Economics shows first, etc.
  const papersBySubject = useMemo(() => {
    const buckets = {};
    for (const p of papers) {
      const sid = p.subject_id || "_unknown";
      if (!buckets[sid]) buckets[sid] = [];
      buckets[sid].push(p);
    }
    // Sort each bucket newest-first.
    for (const sid of Object.keys(buckets)) {
      buckets[sid].sort((a, b) => {
        const ta = new Date(a.uploaded_at || 0).getTime();
        const tb = new Date(b.uploaded_at || 0).getTime();
        return tb - ta;
      });
    }
    // Emit in the canonical subject order.
    const out = [];
    for (const subjectRow of subjectIndex.ordered) {
      if (buckets[subjectRow.id]) {
        out.push({
          subject: subjectRow,
          papers: buckets[subjectRow.id],
        });
      }
    }
    // Any orphan papers (subject_id not in our subjects list).
    for (const sid of Object.keys(buckets)) {
      if (!subjectIndex.byId[sid] && sid !== "_unknown") {
        out.push({
          subject: { id: sid, name: "Other", code: "", key: null },
          papers: buckets[sid],
        });
      }
    }
    return out;
  }, [papers, subjectIndex]);


  // ───────────────────────────────────────────────────────────
  // HANDLERS — upload flow
  // ───────────────────────────────────────────────────────────
  //
  // STEP-BY-STEP for handleUpload:
  //   1. Generate a stable paper UUID client-side. We need it
  //      for the storage path BEFORE the DB insert.
  //   2. Start a fake-progress ticker so the button bar fills
  //      smoothly even though Supabase JS doesn't expose real
  //      upload progress events.
  //   3. Upload the PDF to Supabase Storage at
  //      `<user_id>/<paper_id>.pdf` in the past_papers bucket.
  //   4. Get the public URL so we can persist a viewable link.
  //   5. Insert a row in past_papers with the columns the table
  //      really has: user_id, subject_id, mode, file_url.
  //      (id is explicit so DB row and file path agree.)
  //   6. Stop the ticker, jump progress to 100, close the modal
  //      and transition to VIEW 3.
  //   7. EFFECT 3 then animates the steps and finally flips to
  //      VIEW 4 with the mock solution attached.
  //
  // On any failure between steps 3-5, we surface a red toast,
  // leave the modal open so the user can retry, and DO NOT
  // optimistically add a half-saved paper to the library.

  const handleUpload = async (form) => {
    if (uploading) return;
    setUploading(true);
    setUploadProgress(0);

    // ── Fake upload progress ──────────────────────────────
    // Stops at 90% so the real call has somewhere to "complete"
    // to. When the real call returns we jump to 100.
    const ticker = setInterval(() => {
      setUploadProgress((p) => Math.min(90, p + 5));
    }, 200);

    try {
      // 1. Generate paper UUID.
      const paperId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `temp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      // 3. Storage upload.
      //
      // Path shape: `<user_id>/<timestamp>_<safe_filename>`.
      // The leading user_id folder is critical — the Supabase
      // Storage RLS policy on this bucket gates writes via
      // `auth.uid()::text = (storage.foldername(name))[1]`, so
      // anything that doesn't nest the file inside the
      // authenticated user's UUID folder is rejected with an
      // opaque empty-`{}` error.
      //
      // We sanitise the original filename to strip any
      // characters that would either confuse the Supabase URL
      // parser (`?`, `#`, `&`) OR create a nested path that
      // RLS no longer sees as a single user folder (`/`, `\`).
      // The replacement keeps letters / digits / `.` / `-` /
      // `_` — everything else collapses to a single `_`.
      const rawName = form.file?.name || "paper.pdf";
      const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const storagePath = `${userIdRef.current}/${Date.now()}_${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, form.file, {
          // Cache-Control hint sent to the Storage CDN. One hour
          // is plenty — the iframe re-fetches every page load.
          cacheControl: "3600",
          // `upsert: true` so a retry after a half-failed write
          // never fails with "object already exists" (the path
          // contains Date.now() so a clean retry produces a
          // brand-new key anyway, but upsert costs nothing).
          upsert: true,
          // Tells Storage to serve the file back with the right
          // MIME type so the iframe renders the PDF inline
          // instead of triggering a download.
          contentType: "application/pdf",
        });

      if (uploadErr) {
        // Surface the real error — StorageError instances
        // expose `message`, `statusCode`, `error`, `name` as
        // NON-ENUMERABLE properties so `console.error("…", err)`
        // and JSON.stringify both render as `{}`. Reading the
        // fields directly is the only way to see them.
        console.error("[PastPapers] Storage upload error:", {
          message: uploadErr.message,
          statusCode: uploadErr.statusCode,
          error: uploadErr.error,
          name: uploadErr.name,
        });
        // Re-throw with the real message so the outer catch
        // block also logs something useful AND the toast can
        // show the underlying reason where it's safe to.
        throw new Error(uploadErr.message || "Upload failed");
      }

      // 4. Resolve public URL for the iframe + downloads.
      const { data: publicData } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(storagePath);
      const publicUrl = publicData?.publicUrl || "";

      // 5. DB insert with the REAL columns only. The live
      // schema carries: id, user_id, subject_id, file_url,
      // paper_year, paper_variant, questions_json (JSONB),
      // high_frequency_topics (JSONB), uploaded_at, created_at.
      //
      // ⚠ `mode` is NOT a column on this table — the previous
      // schema probe was fooled by a name collision with the
      // Postgres built-in aggregate `mode()` (it returned an
      // "ordered-set aggregate" error rather than the usual
      // "column does not exist", which we misread as success).
      // The `mode` field is purely a UX choice (Full Paper vs
      // Selected Questions) and is never read from the DB by
      // the backend, so we keep it in client state via
      // `extras` and skip persistence entirely.
      //
      // `solution` + `status` similarly live in client state
      // until the backend updates `questions_json` later.
      const { data: insertData, error: insertErr } = await supabase
        .from("past_papers")
        .insert({
          id: paperId,
          user_id: userIdRef.current,
          subject_id: form.subjectId,
          file_url: publicUrl,
          // Store the year as a string — Postgres' text column
          // accepts it and the backend's Pydantic field is str.
          paper_year: String(form.year),
          paper_variant: form.session,
        })
        .select()
        .single();

      if (insertErr || !insertData) {
        // Best-effort: try to delete the orphaned storage file
        // so we don't waste bucket space. Failure here is
        // logged but not surfaced to the user.
        await supabase.storage
          .from(STORAGE_BUCKET)
          .remove([storagePath])
          .catch((e) =>
            console.warn(
              "[PastPapers] could not clean orphaned upload:",
              e,
            ),
          );
        throw insertErr || new Error("Insert returned no row.");
      }

      // 6. Build the rich client-side paper object. Year /
      // session / mock solution live only in state — they'll be
      // lost on refresh until the DB schema is upgraded.
      // `storage_path` is threaded through so the delete
      // handler can clean up the correct Storage object
      // (the path now embeds a timestamp + original filename
      // rather than the predictable `<user_id>/<paper_id>.pdf`).
      const enrichedPaper = normalizePaper(insertData, {
        year: form.year,
        session: form.session,
        // `mode` is client-only (no DB column) — pass it
        // through so VIEW 4 still distinguishes Full Paper
        // from Selected Questions for this upload.
        mode: form.mode,
        selected_questions: form.selectedQuestions,
        status: "processing",
        filename: form.file?.name || null,
        storage_path: storagePath,
      });

      // Push the optimistic paper to the top of the library so
      // it's already there when the user returns from VIEW 4.
      setPapers((prev) => [enrichedPaper, ...prev]);
      // If the library was previously showing mock data, drop
      // it now — the user has at least one real paper.
      setUsingMock(false);

      // Visual: jump progress to 100, then close modal.
      setUploadProgress(100);
      clearInterval(ticker);
      // Tiny delay so the user sees the 100% state.
      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
        setUploadOpen(false);
        // 7. Transition into VIEW 3.
        setProcessingPaper(enrichedPaper);
        setProcessingStep(0);
        setCurrentView(VIEW.PROCESSING);
      }, 250);
    } catch (err) {
      // Surface every property the Supabase StorageError
      // hides behind non-enumerable descriptors. Without this
      // an upload failure logs as `{}` and we can't tell RLS
      // rejection apart from a network error.
      console.error("[PastPapers] upload failed:", {
        message: err?.message,
        statusCode: err?.statusCode,
        error: err?.error,
        name: err?.name,
        // JSON.stringify ignores non-enumerable props but it's
        // still useful when err is a plain object (e.g. an
        // insertErr from PostgREST which DOES enumerate).
        details: JSON.stringify(err),
      });
      clearInterval(ticker);
      setUploading(false);
      setUploadProgress(0);
      setToast({
        tone: "error",
        message:
          err?.message ||
          "Could not upload your paper. Please check your connection and try again.",
      });
      // Modal stays open so the user can retry without
      // re-entering the form.
    }
  };


  // ───────────────────────────────────────────────────────────
  // HANDLERS — view transitions
  // ───────────────────────────────────────────────────────────

  const handleOpenPaper = (paper) => {
    setSelectedPaper(paper);
    setCurrentView(VIEW.SPLIT);
  };

  const handleBackToLibrary = () => {
    setSelectedPaper(null);
    setCurrentView(VIEW.LIBRARY);
  };

  const handleCancelProcessing = () => {
    // Stop the simulation and return to the library. We leave
    // the placeholder paper sitting in the library at status
    // "processing" — the user can delete it manually. This
    // mirrors what'd happen if a real backend job was aborted.
    setProcessingPaper(null);
    setProcessingStep(0);
    setCurrentView(VIEW.LIBRARY);
  };


  // ───────────────────────────────────────────────────────────
  // HANDLERS — delete (optimistic)
  // ───────────────────────────────────────────────────────────
  //
  // Same optimistic pattern used by the timetable page:
  //   • Remove from React state immediately.
  //   • DELETE the row from past_papers in the background.
  //   • Best-effort: also delete the underlying storage file.
  //   • On failure, restore the snapshot and surface a red toast.

  const handleConfirmDelete = async () => {
    if (!deleteConfirm) return;
    const paper = deleteConfirm.paper;
    const id = paper.id;
    setSubmittingDelete(true);

    const snapshot = papers;
    setPapers((prev) => prev.filter((p) => p.id !== id));
    setDeleteConfirm(null);
    setSubmittingDelete(false);

    // Mock rows are state-only — nothing to delete in Supabase.
    if (paper.is_mock || String(id).startsWith("mock-")) {
      setToast({ tone: "success", message: "Paper removed." });
      return;
    }

    // 1. DB row delete.
    const { error: dbErr } = await supabase
      .from("past_papers")
      .delete()
      .eq("id", id);

    if (dbErr) {
      console.error("[PastPapers] delete row failed:", dbErr);
      setPapers(snapshot);
      setToast({
        tone: "error",
        message: "Could not delete paper. Please try again.",
      });
      return;
    }

    // 2. Storage file delete (best-effort). We prefer the
    // exact `storage_path` we captured at upload time (the
    // path now embeds a timestamp + sanitised filename so it
    // can't be reconstructed from the paper id alone). Older
    // rows uploaded under the legacy `<user_id>/<paper_id>.pdf`
    // shape are still cleaned up via the fallback below.
    // Failure here is logged but doesn't surface to the user —
    // the row is gone, which is the canonical source of truth.
    const storagePath =
      paper.storage_path ||
      (paper.user_id && paper.id
        ? `${paper.user_id}/${paper.id}.pdf`
        : null);
    if (storagePath) {
      const { error: storageErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove([storagePath]);
      if (storageErr) {
        console.warn(
          "[PastPapers] storage cleanup failed:",
          storageErr,
        );
      }
    }

    setToast({ tone: "success", message: "Paper deleted." });
  };


  // ───────────────────────────────────────────────────────────
  // HANDLERS — download + share (VIEW 4 header buttons)
  // ───────────────────────────────────────────────────────────

  const handleDownload = (paper) => {
    if (!paper?.file_url || paper.file_url.startsWith("mock://")) {
      setToast({
        tone: "error",
        message: "No downloadable PDF for this paper.",
      });
      return;
    }
    // Use a programmatic anchor click — no new tab so the
    // browser triggers its native download dialog. We append
    // and remove the anchor in the same tick so it never
    // appears in the DOM tree visually.
    const a = document.createElement("a");
    a.href = paper.file_url;
    a.download = paper.filename || `past-paper-${paper.id}.pdf`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleShare = async (paper) => {
    if (!paper?.file_url || paper.file_url.startsWith("mock://")) {
      setToast({
        tone: "error",
        message: "Sample papers can't be shared.",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(paper.file_url);
      setToast({ tone: "success", message: "Link copied" });
    } catch (err) {
      console.warn("[PastPapers] clipboard write failed:", err);
      setToast({
        tone: "error",
        message: "Couldn't copy link. Long-press the URL bar instead.",
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
          Loading past papers…
        </div>
      </main>
    );
  }


  // ───────────────────────────────────────────────────────────
  // RENDER — VIEW 3 (processing) takes over the whole page.
  // ───────────────────────────────────────────────────────────
  if (currentView === VIEW.PROCESSING && processingPaper) {
    const subjectMeta = subjectIndex.byId[processingPaper.subject_id];
    return (
      <>
        <ProcessingView
          paper={processingPaper}
          currentStep={processingStep}
          subjectMeta={subjectMeta}
          onCancel={handleCancelProcessing}
        />
        {toast && (
          <Toast
            tone={toast.tone}
            message={toast.message}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }


  // ───────────────────────────────────────────────────────────
  // RENDER — VIEW 4 (solution view) takes over the whole page.
  // ───────────────────────────────────────────────────────────
  if (currentView === VIEW.SPLIT && selectedPaper) {
    const subjectMeta = subjectIndex.byId[selectedPaper.subject_id];
    // Show the "Study notes are being generated…" banner ONLY
    // for the paper that just kicked off a backend solve —
    // EFFECT 5 hides it after NOTES_BANNER_MS.
    const showNotesBanner =
      notesGeneratingPaperId === selectedPaper.id;
    return (
      <>
        <SolutionView
          paper={selectedPaper}
          subjectMeta={subjectMeta}
          showNotesBanner={showNotesBanner}
          onBack={handleBackToLibrary}
        />
        {toast && (
          <Toast
            tone={toast.tone}
            message={toast.message}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }


  // ───────────────────────────────────────────────────────────
  // RENDER — VIEW 1 (library) — mockup layout
  const hasPapers = papers.length > 0;
  const listPapers = filteredPapers;

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <style>{`
        .past-papers-stats { margin: 20px var(--page-padding) 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .past-papers-card:hover { background: var(--card-hover) !important; border-color: var(--gold-border-active) !important; }
        .past-papers-view-btn:hover { background: var(--chat-bubble-bg) !important; }
        @media (max-width: 767px) {
          .past-papers-stats { grid-template-columns: 1fr; }
          .past-papers-card-left { display: none !important; }
        }
      `}</style>

      <PastPapersBreadcrumb />

      <header style={{ padding: "20px var(--page-padding) 0", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: "28px", color: "var(--text)", fontWeight: 700, margin: 0 }}>Past Papers</h1>
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", marginTop: "4px", marginBottom: 0 }}>
            Upload and solve Cambridge past papers with AI
          </p>
        </div>
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          style={{
            background: "var(--gold)",
            border: "none",
            borderRadius: "8px",
            padding: "10px 18px",
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            fontWeight: 500,
            color: "var(--bg)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Upload Paper
        </button>
      </header>

      <section aria-label="Past paper statistics" className="past-papers-stats">
        <StatCard value={stats.total} label="TOTAL PAPERS SOLVED" />
        <StatCard value={stats.thisMonth} label="THIS MONTH" />
        <StatCard value={stats.distinctSubjects} label="SUBJECTS COVERED" />
      </section>

      <nav
        aria-label="Filter papers by subject"
        style={{ margin: "20px var(--page-padding) 0", borderBottom: "1px solid var(--border-light)", display: "flex", gap: "24px", flexWrap: "wrap" }}
      >
        {FILTER_OPTIONS.map((opt) => (
          <FilterTabButton key={opt.value} active={activeFilter === opt.value} onClick={() => setActiveFilter(opt.value)}>
            {opt.label}
          </FilterTabButton>
        ))}
      </nav>

      {papersLoading ? (
        <section aria-label="Loading papers" style={{ margin: "16px var(--page-padding) 32px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <PaperCardSkeleton />
          <PaperCardSkeleton />
          <PaperCardSkeleton />
        </section>
      ) : !hasPapers ? (
        <div
          aria-label="No past papers yet"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "48px 24px",
            margin: "20px var(--page-padding)",
            background: "var(--card)",
            border: "0.5px solid var(--gold-border)",
            borderRadius: "10px",
            textAlign: "center",
          }}
        >
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--gold-icon)"
            strokeWidth="1.5"
            aria-hidden
          >
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          <h3
            style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: "18px",
              color: "var(--text)",
              fontWeight: 700,
              marginTop: "14px",
              marginBottom: "8px",
            }}
          >
            No past papers yet
          </h3>
          <p
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "13px",
              color: "var(--text-muted)",
              maxWidth: "320px",
              lineHeight: 1.6,
              marginBottom: "20px",
            }}
          >
            Upload a Cambridge past paper and get a complete
            AI-generated model answer in minutes
          </p>
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            style={{
              background: "var(--gold)",
              border: "none",
              borderRadius: "8px",
              padding: "10px 24px",
              fontFamily: "Inter, sans-serif",
              fontSize: "13px",
              fontWeight: 500,
              color: "var(--bg)",
              cursor: "pointer",
            }}
          >
            Upload Your First Paper
          </button>
        </div>
      ) : (
        <section aria-label="Papers list" style={{ margin: "16px var(--page-padding) 32px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {listPapers.length === 0 ? (
            <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", textAlign: "center", padding: "24px" }}>
              No papers for this subject yet.
            </p>
          ) : (
            listPapers.map((paper) => (
              <PaperCard
                key={paper.id}
                paper={paper}
                subjectMeta={subjectIndex.byId[paper.subject_id]}
                onOpen={handleOpenPaper}
                onDelete={(pap) => setDeleteConfirm({ paper: pap })}
              />
            ))
          )}
          {usingMock && (
            <p style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--text-muted)", textAlign: "center", marginTop: "8px" }}>
              Showing sample papers while your library is being set up.
            </p>
          )}
        </section>
      )}


      {/* ── Overlays ───────────────────────────────────── */}
      {uploadOpen && (
        <UploadModal
          subjectIndex={subjectIndex}
          onCancel={() => setUploadOpen(false)}
          onSubmit={handleUpload}
          uploading={uploading}
          uploadProgress={uploadProgress}
        />
      )}
      {deleteConfirm && (
        <DeleteConfirmModal
          paper={deleteConfirm.paper}
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
