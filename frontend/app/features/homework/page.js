// ============================================================
// FILE: app/features/homework/page.js
// PURPOSE: Homework Assistant – Premium UI backed by the FastAPI
//          /homework/ask + /homework/history endpoints. Every
//          Groq call AND every Supabase write happens on the
//          backend now; the frontend only renders what comes back.
// URL: /features/homework
//
// CHANGE LOG
// ----------------------------------------------------------------
// 1. Mock setTimeout + MOCK_RESPONSES dictionary removed.
// 2. "Generate Answer" now calls the new POST /homework/ask backend
//    endpoint with a Supabase bearer token. The backend handles
//    Groq, topic-tag extraction, AND the homework_questions insert.
// 3. The direct browser-side Groq call has been removed entirely.
// 4. The direct browser-side Supabase write has been removed —
//    the backend writes the row using the service role key.
// 5. History fetch now calls GET /homework/history first; the
//    direct Supabase read fallback is gone. Mock data still renders
//    when both the backend AND the user's history are empty.
// 6. Adjustment buttons restored — POST /homework/adjust refines
//    answers (Simplify, More detail, Shorten, Add examples).
// 7. The "Structural breakdown" card now only renders when the
//    backend actually returned a `breakdown` value, which it does
//    not today — kept the data plumbing in case a future endpoint
//    re-introduces the field.
// ============================================================

"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Globe,
  MessageSquare,
  Scissors,
  Zap,
} from "lucide-react";
import {
  SUBJECTS,
  getSubjectByName,
  getSubjectByKey,
} from "../../../lib/subjects";
import { supabase } from "../../../lib/supabaseClient";
import PageHeader from "../../components/PageHeader";
import SubjectBadge from "../../components/SubjectBadge";

// Backend base URL. Pulled from the public env var defined in
// frontend/.env.local so we never hardcode the host. Falling back to
// localhost is safe because NEXT_PUBLIC_ vars are inlined at build time
// and a missing var simply means "we're running on localhost".
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";

// localStorage key for the legacy "Previous questions" strip that
// shows under the answer card. It survives a page reload so the
// student can re-load their last few questions instantly. The new
// History tab uses Supabase (via the backend) — this key is kept
// purely as a UX safety net while the History tab is the source
// of truth for cross-device persistence.
const HISTORY_KEY = "ascendai_homework_history";

// How long the bottom-right toast stays visible before auto-dismissing.
const TOAST_AUTO_DISMISS_MS = 5000;

// Allowed refinement modes — must match backend ALLOWED_ADJUSTMENT_TYPES.
const ADJUST_SIMPLIFY = "simplify";
const ADJUST_MORE_DETAIL = "more_detail";
const ADJUST_SHORTEN = "shorten";
const ADJUST_ADD_EXAMPLES = "add_examples";

// Human-readable toast after each adjustment succeeds.
const ADJUST_TOAST_MESSAGES = {
  [ADJUST_SIMPLIFY]: "Answer simplified",
  [ADJUST_MORE_DETAIL]: "Answer expanded",
  [ADJUST_SHORTEN]: "Answer shortened",
  [ADJUST_ADD_EXAMPLES]: "Examples added",
};


// ════════════════════════════════════════════════════════════════
// HISTORY TAB — constants, helpers, and small sub-components
// ----------------------------------------------------------------
// Everything in this block powers the second tab on the Homework
// Assistant page. The Ask tab (existing) is untouched. We keep the
// History UI components at module level (rather than nested inside
// HomeworkPage) so React doesn't re-create them on every render.
// ════════════════════════════════════════════════════════════════

// How many history cards we show on each page of the paginator.
const PAGE_SIZE = 10;

// Sentinel for the "no filter applied — show every subject" option.
// Kept as a constant so we can never accidentally typo it elsewhere.
const FILTER_ALL = "all";

// Filter chip definitions. The `value` is what we store in state and
// compare against the entry's `subject` field; the `label` is what
// the user sees. Order matches the rest of the app (lib/subjects.js).
const HISTORY_FILTER_OPTIONS = [
  { value: FILTER_ALL,  label: "All" },
  { value: "economics", label: "Economics" },
  { value: "business",  label: "Business" },
  { value: "english",   label: "English" },
  { value: "ict",       label: "ICT" },
];

// Subject-key → Tailwind border-l-* class. We keep these as literal
// strings (NOT a template) so Tailwind's JIT keeps the CSS in the
// final bundle. Same pattern used by the Notes and Flashcards pages.
const HISTORY_LEFT_BORDER_CLASS = {
  economics: "border-l-economics-text",
  business:  "border-l-business-text",
  english:   "border-l-english-text",
  ict:       "border-l-ict-text",
};


// ────────────────────────────────────────────────────────────────
// HELPER: formatHistoryDate
// ----------------------------------------------------------------
// Turns an ISO timestamp like "2026-05-14T15:32:00Z" into the exact
// display format the spec requires: "14 May 2026 · 15:32".
// Uses Intl APIs (built into the browser) so we don't need a date
// library and there is zero new dependency.
// ────────────────────────────────────────────────────────────────
function formatHistoryDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const datePart = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const timePart = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `${datePart} · ${timePart}`;
}


// ────────────────────────────────────────────────────────────────
// HELPER: truncate
// ----------------------------------------------------------------
// Cuts a long string at `n` characters and appends an ellipsis if
// it actually had to be cut. Used by the "Ask follow-up" pre-fill
// to keep the textarea contents readable (60-char cap per spec).
// ────────────────────────────────────────────────────────────────
function truncate(str, n) {
  const s = String(str ?? "").trim();
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}


// ────────────────────────────────────────────────────────────────
// HELPER: buildMockHistory
// ----------------------------------------------------------------
// Used ONLY when both (a) the GET /homework/history backend endpoint
// is missing AND (b) direct Supabase read returns zero rows for this
// user. Returns three realistic Cambridge AS Level entries per
// subject (12 in total) so the History UI is fully populated for
// development and screenshots. Real data replaces these the moment
// the user asks a real question — the backend's POST /homework/ask
// persists every Q&A into homework_questions and the next call to
// GET /homework/history reads them back.
// ────────────────────────────────────────────────────────────────
function buildMockHistory() {
  // Subject metadata lookups — keeps the mock content honest about
  // which Cambridge syllabus each question targets without ever
  // hardcoding a name or code in this function.
  const econ = getSubjectByKey("economics");
  const biz  = getSubjectByKey("business");
  const eng  = getSubjectByKey("english");
  const ict  = getSubjectByKey("ict");

  // Each timestamp is a real ISO string, spaced a day or two apart
  // so the cards render in a believable chronological order. We use
  // `Date.now()` minus an offset rather than a fixed date so the
  // mock data always "looks recent" no matter when the demo runs.
  const now = Date.now();
  const daysAgo = (n, hour = 14, minute = 30) => {
    const d = new Date(now - n * 86_400_000);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };

  // One row builder so every mock entry has the same shape the
  // backend endpoint is contracted to return. Note `id` is a string
  // prefixed with "mock-" so we can identify these rows in dev tools
  // and never confuse them with real Supabase UUIDs.
  let counter = 0;
  const make = (subjectKey, subjectCode, question, answer, topicTag, iso) => {
    counter += 1;
    return {
      id: `mock-${counter}`,
      subject: subjectKey,
      subject_code: subjectCode ?? "",
      question,
      answer,
      topic_tag: topicTag,
      created_at: iso,
    };
  };

  return [
    // ── Economics ────────────────────────────────────────────
    make(
      "economics", econ?.code,
      "Explain the concept of price elasticity of demand and its determinants.",
      "DEFINITION\nPrice elasticity of demand (PED) measures the responsiveness of quantity demanded to a change in price, calculated as %ΔQd ÷ %ΔP.\n\nCAMBRIDGE ANSWER\nDemand is described as elastic when the absolute value of PED is greater than 1, meaning consumers reduce their purchases by a larger percentage than the rise in price. The four main determinants are: availability of substitutes (more substitutes → more elastic), the proportion of income spent on the good, whether the good is a necessity or luxury, and the time horizon under consideration.\n\nEXAMINER TIP\nAlways calculate PED as a positive value in your written response and explicitly compare it to 1 before drawing a conclusion.",
      "Elasticity",
      daysAgo(1, 15, 32),
    ),
    make(
      "economics", econ?.code,
      "Discuss the impact of an indirect tax on consumer surplus.",
      "DEFINITION\nConsumer surplus is the difference between the maximum price a consumer is willing to pay and the price they actually pay.\n\nCAMBRIDGE ANSWER\nAn indirect tax (e.g. VAT) shifts the supply curve vertically upwards by the per-unit tax. The new equilibrium price rises and the equilibrium quantity falls. Consumer surplus shrinks because consumers pay a higher price for fewer units. The size of the consumer surplus loss depends on PED — the more elastic demand is, the smaller the share of the tax burden falling on consumers.\n\nCOMMON MISTAKES\nMistake: Claiming the entire tax is paid by consumers. Only when demand is perfectly inelastic is that true.",
      "Market Failure",
      daysAgo(3, 11, 14),
    ),
    make(
      "economics", econ?.code,
      "Define opportunity cost and give a business example.",
      "DEFINITION\nOpportunity cost is the value of the next best alternative forgone when a choice is made.\n\nCAMBRIDGE ANSWER\nWhen a firm spends £100 000 building a new warehouse, the opportunity cost is whatever the firm could have done with the same money instead — for example, investing in upgraded machinery that would have raised productivity by 8%. Recognising opportunity cost is central to rational decision making because it forces the comparison of alternatives rather than evaluating each choice in isolation.",
      "Scarcity & Choice",
      daysAgo(6, 9, 45),
    ),

    // ── Business ─────────────────────────────────────────────
    make(
      "business", biz?.code,
      "Explain the marketing mix using the 4 Ps framework.",
      "DEFINITION\nThe marketing mix is the set of controllable variables a firm combines to satisfy its target market — traditionally Product, Price, Place, and Promotion.\n\nCAMBRIDGE ANSWER\nProduct refers to the design, features and quality of the offering. Price covers the pricing strategy (penetration, skimming, competitive). Place describes the distribution channels through which the product reaches the customer. Promotion covers advertising, sales promotion, public relations and personal selling. The 4 Ps are most effective when they are internally consistent — for example, a premium price must be supported by a premium product, exclusive distribution, and aspirational promotion.",
      "Marketing Mix",
      daysAgo(2, 10, 5),
    ),
    make(
      "business", biz?.code,
      "Evaluate the use of SWOT analysis for strategic planning.",
      "DEFINITION\nSWOT is a strategic-planning tool that classifies internal Strengths and Weaknesses alongside external Opportunities and Threats.\n\nCAMBRIDGE ANSWER\nSWOT is useful because it forces managers to look outward (opportunities, threats) as well as inward (strengths, weaknesses), and it produces a single-page summary that is easy to communicate. However, SWOT does not weight or prioritise the factors it identifies, which can lead to a 'flat' list that hides which issues are critical. Combining SWOT with a quantitative tool such as a Boston Matrix or PESTLE analysis usually produces a more actionable strategy.",
      "Strategic Analysis",
      daysAgo(4, 16, 20),
    ),
    make(
      "business", biz?.code,
      "Describe two non-financial methods of motivation.",
      "CAMBRIDGE ANSWER\nJob enrichment increases the depth of a role — for example, allowing a production-line worker to schedule their own work or perform quality checks. This addresses Herzberg's motivators (recognition, responsibility) and tends to raise intrinsic satisfaction.\n\nEmpowerment delegates real decision-making authority to lower levels of the hierarchy. This can speed up customer service (e.g. a hotel receptionist being authorised to upgrade a guest) and tends to increase commitment, though it requires investment in training and clear boundaries.",
      "Motivation",
      daysAgo(7, 13, 50),
    ),

    // ── English ──────────────────────────────────────────────
    make(
      "english", eng?.code,
      "Analyse how the writer uses imagery to convey loneliness in the extract.",
      "CAMBRIDGE ANSWER\nThe writer constructs loneliness through accumulated visual imagery of emptiness. The 'unlit windows' and 'streets without shadows' both deny the presence of others; the negation embedded in each phrase forces the reader to notice the absence. The extended metaphor of the protagonist as 'a single coin spinning on a long table' positions him as both small in scale and constantly in motion without arrival — reinforcing the isolation. Together these images move the reader from a literal description of an empty street to a psychological portrait of estrangement.",
      "Imagery & Tone",
      daysAgo(1, 18, 12),
    ),
    make(
      "english", eng?.code,
      "Comment on the effect of the writer's use of short sentences in paragraph 3.",
      "CAMBRIDGE ANSWER\nThe short sentences in paragraph 3 (\"He waited. He listened. Nothing.\") create a staccato rhythm that mimics the protagonist's held breath. The deliberate fragmentation slows the reader's pace and forces them to dwell on each beat, intensifying the suspense. Crucially, the final one-word sentence 'Nothing.' inverts the expectation built by the preceding listing — the reader has been primed for revelation and is instead handed an absence, which produces the sense of anti-climax the writer needs.",
      "Sentence Structure",
      daysAgo(5, 12, 0),
    ),
    make(
      "english", eng?.code,
      "How is the theme of identity developed in the first chapter?",
      "CAMBRIDGE ANSWER\nIdentity is established through three converging techniques. First, the narrator refuses to name herself for six full paragraphs — the reader knows her by what she does, not what she is called. Second, the recurring motif of mirrors and photographs (each appearing with a slight distortion) suggests that identity is constructed rather than fixed. Third, the dialogue with her grandmother contains an unresolved tension between the inherited name and the chosen self, foreshadowing the central conflict of the novel.",
      "Theme: Identity",
      daysAgo(8, 17, 25),
    ),

    // ── ICT ─────────────────────────────────────────────────
    make(
      "ict", ict?.code,
      "Compare star and bus network topologies.",
      "DEFINITION\nA topology is the arrangement of nodes and the connections between them in a network.\n\nCAMBRIDGE ANSWER\nIn a star topology every node connects to a central switch. This means a single cable failure isolates only one device, central management is straightforward, and performance degrades gracefully under load. The trade-off is dependence on the switch — if the switch fails the whole network fails.\n\nIn a bus topology all nodes share one backbone cable. Bus networks are cheap to install but every transmission contends for the same medium, so collisions and bandwidth saturation rise sharply with the number of nodes. A single break in the backbone disables the entire segment.",
      "Networks",
      daysAgo(2, 8, 40),
    ),
    make(
      "ict", ict?.code,
      "Explain three benefits and one risk of cloud storage for a business.",
      "CAMBRIDGE ANSWER\nBenefits: (1) Scalability — capacity can be added on demand without buying physical hardware. (2) Off-site disaster recovery — data is replicated across multiple data-centres, so a fire or theft at the business premises does not lose the data. (3) Remote access — staff can collaborate on the same files from any location with internet access.\n\nRisk: Vendor lock-in. Moving terabytes of data and re-training staff between cloud providers is costly, so a price rise or service degradation by the original provider can be difficult to escape.",
      "Cloud Computing",
      daysAgo(5, 14, 18),
    ),
    make(
      "ict", ict?.code,
      "Define a relational database and give a real-world example.",
      "DEFINITION\nA relational database stores data in tables (relations) made of rows (records) and columns (fields), with relationships between tables expressed through primary and foreign keys.\n\nCAMBRIDGE ANSWER\nA school management system is a typical example. A 'Students' table contains one row per pupil with a primary key student_id. A 'Grades' table records assessment results and includes student_id as a foreign key linking back to the 'Students' table. This separation removes data duplication (a student's name is stored once) and allows the school to query attendance, grades and timetable data through a single SQL JOIN.",
      "Databases",
      daysAgo(9, 11, 5),
    ),
  ];
}


// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: HwTabButton
// ----------------------------------------------------------------
// The two buttons that switch between "Ask a Question" and
// "History" tabs. Sits directly under the PageHeader on a row
// whose own bottom border is the 1 px input-border rule line.
//
//   • Active tab — gold text + 2 px gold bottom border + Inter
//     weight 500.
//   • Inactive tab — text-muted with no bottom border and Inter
//     weight 400; on hover the colour shifts to text-primary.
//
// We use `-mb-px` on the button so the active 2 px gold border
// overlaps the 1 px row border underneath and the visual sits
// flush instead of looking like two stacked lines.
// ────────────────────────────────────────────────────────────────
function HwTabButton({ active, onClick, children }) {
  const base =
    "px-4 py-2 text-sm font-body transition-colors " +
    "border-b-2 -mb-px focus:outline-none " +
    "focus-visible:ring-2 focus-visible:ring-gold " +
    "focus-visible:ring-offset-2 focus-visible:ring-offset-background";
  const activeCls   = "text-gold border-gold font-body-medium";
  const inactiveCls =
    "text-text-muted border-transparent font-body-normal " +
    "hover:text-text-primary";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={base + " " + (active ? activeCls : inactiveCls)}
    >
      {children}
    </button>
  );
}


// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: HistoryFilterChip
// ----------------------------------------------------------------
// One of the five filter chips at the top of the History tab.
//
//   • Active   — bg-gold + text-background (the cream) + 4 px radius.
//   • Inactive — bg-card + text-muted + input-border + 4 px radius;
//                hover lightens to the hover token.
// ────────────────────────────────────────────────────────────────
function HistoryFilterChip({ active, onClick, children }) {
  const base =
    "inline-flex items-center px-3 py-1.5 rounded-4px text-sm " +
    "font-body font-body-medium whitespace-nowrap transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-gold focus-visible:ring-offset-2 " +
    "focus-visible:ring-offset-background";
  const activeCls   = "bg-gold text-background border border-transparent";
  const inactiveCls =
    "bg-card text-text-muted border border-input-border hover:bg-hover";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={base + " " + (active ? activeCls : inactiveCls)}
    >
      {children}
    </button>
  );
}


// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: HistorySkeleton
// ----------------------------------------------------------------
// The pulsing grey card shown while the fetch is in flight. We
// render 3 of these so the grid has the same visual weight as
// the real result list and the page doesn't jump when data lands.
// ────────────────────────────────────────────────────────────────
function HistorySkeleton() {
  return (
    <div
      aria-hidden="true"
      className={
        "bg-card border border-input-border border-l-[3px] " +
        "border-l-input-border rounded-4px p-4 shadow-sm"
      }
    >
      <div className="animate-pulse space-y-3">
        {/* Top row: badge + date */}
        <div className="flex items-center justify-between">
          <div className="h-4 w-20 bg-hover rounded-4px" />
          <div className="h-3 w-32 bg-hover rounded-4px" />
        </div>
        {/* Question line (long) */}
        <div className="h-4 w-11/12 bg-hover rounded-4px" />
        {/* Footer row */}
        <div className="flex items-center justify-end">
          <div className="h-3 w-24 bg-hover rounded-4px" />
        </div>
      </div>
    </div>
  );
}


// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: HistoryCard
// ----------------------------------------------------------------
// One row in the History list. Renders the COLLAPSED state by
// default and reveals the expanded body (full answer + follow-up
// CTA) when `expanded` is true.
//
// PROPS:
//   • entry        — { id, subject, subject_code, question, answer,
//                      topic_tag, created_at }
//   • expanded     — boolean. Only ONE card can be expanded at a
//                    time — the parent enforces that via state.
//   • onToggle     — fires when the user clicks "View answer" /
//                    "Hide answer".
//   • onFollowUp   — fires when the user clicks "Ask follow-up";
//                    the parent switches to the Ask tab and
//                    pre-fills the textarea.
//   • renderAnswer — function that renders structured answer text.
//                    Passed in from HomeworkPage so the same renderer
//                    is used in BOTH the Ask card and the History
//                    card — guaranteed visual consistency.
//
// EXPAND / COLLAPSE MECHANISM:
//   • The body is wrapped in a div whose `max-height` toggles
//     between 0 (collapsed) and 2000 px (expanded). The CSS
//     transition (`transition-[max-height] duration-300 ease-in-out`)
//     animates the height smoothly. We do NOT use display:none
//     because that snaps instantly with no animation.
//   • The 2000 px ceiling is intentionally generous — Cambridge
//     answers are long and we'd rather over-allocate than have
//     the panel clip the bottom of the answer.
//   • `overflow-hidden` keeps the in-progress animation tidy.
// ────────────────────────────────────────────────────────────────
function HistoryCard({ entry, expanded, onToggle, onFollowUp, renderAnswer }) {
  // Subject-coloured 3 px left edge. Falls back to a neutral
  // input-border token if for any reason the entry's subject
  // doesn't match one of the four canonical keys.
  const leftBorderClass =
    HISTORY_LEFT_BORDER_CLASS[entry.subject] || "border-l-input-border";

  // Compose the subject pill once so we don't repeat the lookup
  // twice (collapsed badge AND expanded badge are the SAME node).
  const subjectMeta = getSubjectByKey(entry.subject);
  const subjectName = subjectMeta?.name ?? entry.subject;

  // Truncate the question to 60 chars BEFORE we send it to the
  // follow-up handler so the textarea pre-fill stays readable.
  // The full question is still visible in the expanded card body.
  const followUpLabel = "Follow-up on: " + truncate(entry.question, 60);

  return (
    <article
      className={
        "bg-card border border-input-border border-l-[3px] " +
        leftBorderClass +
        " rounded-4px p-4 shadow-sm " +
        "transition duration-200 ease-in-out hover:shadow-md"
      }
    >
      {/* ── ROW 1: subject badge + timestamp ─────────────── */}
      <div className="flex items-center justify-between gap-3 mb-2">
        <SubjectBadge subject={entry.subject} label={subjectName} />
        <span className="font-body text-text-muted text-xs">
          {formatHistoryDate(entry.created_at)}
        </span>
      </div>

      {/* ── ROW 2 (collapsed-only): topic-tag chip ────────
            Visible whenever there's a tag. Removed completely
            when topic_tag is null so the design stays tidy. */}
      {entry.topic_tag && (
        <div className="flex items-center gap-2 mb-2">
          <span className="font-body text-text-muted text-[11px]">
            Topic:
          </span>
          <span
            className={
              "inline-block px-2 py-[2px] rounded-4px text-[11px] " +
              "font-body uppercase tracking-wide text-text-muted " +
              "bg-hover border border-input-border"
            }
          >
            {entry.topic_tag}
          </span>
        </div>
      )}

      {/* ── ROW 3: the question text, truncated to 2 lines.
            line-clamp-2 keeps every collapsed card the same
            visual height, regardless of question length. */}
      <p
        className={
          "font-body font-body-semibold text-text-primary text-sm " +
          "leading-snug line-clamp-2"
        }
      >
        {entry.question}
      </p>

      {/* ── ROW 4: "View answer" / "Hide answer" toggle ── */}
      <div className="flex items-center justify-end mt-3">
        <button
          type="button"
          onClick={() => onToggle(entry.id)}
          aria-expanded={expanded}
          aria-controls={`history-body-${entry.id}`}
          className={
            "inline-flex items-center gap-1 text-gold text-[13px] " +
            "font-body font-body-medium transition hover:brightness-90 " +
            "focus:outline-none focus-visible:underline"
          }
        >
          {expanded ? "Hide answer" : "View answer"}
          {expanded ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
        </button>
      </div>

      {/* ── EXPANDED BODY ────────────────────────────────────
            Wrapped in an overflow-hidden div whose max-height
            animates between 0 and 2000 px. See block comment
            above for why we use this technique. */}
      <div
        id={`history-body-${entry.id}`}
        className={
          "overflow-hidden transition-[max-height] duration-300 ease-in-out " +
          (expanded ? "max-h-[2000px]" : "max-h-0")
        }
      >
        {/* Thin divider rule between the collapsed summary and the
            full answer — gives the eye a clear hand-off point. */}
        <div
          aria-hidden="true"
          className="my-3 h-px w-full bg-input-border"
        />

        {/* Topic-tag row (expanded form — same data as the
            collapsed chip, but in a slightly bigger text size so
            it reads cleanly inside the answer area). Hidden when
            the entry has no tag. */}
        {entry.topic_tag && (
          <p className="font-body text-text-muted text-[13px] mb-3">
            <span className="font-body-medium">Topic:</span>{" "}
            {entry.topic_tag}
          </p>
        )}

        {/* Section label for the model answer block. Uses the
            same 11 px uppercase tracking-widest treatment seen
            on the rest of the site (Notes Key Points, etc.). */}
        <p
          className={
            "font-body font-body-medium uppercase tracking-widest " +
            "text-text-muted text-[11px] mb-2"
          }
        >
          Model Answer
        </p>

        {/* The structured answer — rendered through the same
            renderStructuredText function used for fresh answers
            in the Ask tab, so the formatting (bold gold headings,
            inline-label bolding, paragraph spacing) is identical. */}
        <div
          className={
            "text-text-primary text-sm leading-[1.8] whitespace-pre-line"
          }
        >
          {renderAnswer(entry.answer)}
        </div>

        {/* ── BOTTOM ACTIONS: follow-up button + hide link ── */}
        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => onFollowUp(entry, followUpLabel)}
            className={
              "inline-flex items-center gap-1.5 text-xs " +
              "font-body font-body-semibold border border-gold " +
              "text-gold rounded-4px px-3 py-1.5 transition " +
              "hover:bg-card focus-visible:outline-none " +
              "focus-visible:ring-2 focus-visible:ring-gold " +
              "focus-visible:ring-offset-2 " +
              "focus-visible:ring-offset-background"
            }
          >
            Ask follow-up
          </button>

          <button
            type="button"
            onClick={() => onToggle(entry.id)}
            aria-expanded={expanded}
            className={
              "inline-flex items-center gap-1 text-gold text-[13px] " +
              "font-body font-body-medium transition hover:brightness-90 " +
              "focus:outline-none focus-visible:underline"
            }
          >
            Hide answer
            <ChevronUp size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  );
}


// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: HistoryPagination
// ----------------------------------------------------------------
// Bottom-of-list paginator. Layout:
//
//   [← Previous]   [1]  [2]  [3]  [4]  [5]   Page X of Y   [Next →]
//
// PAGINATION LOGIC (window-of-5):
//   • We always show at most 5 page-number chips at a time.
//   • The window is centred on the current page where possible:
//       - If currentPage is near the start, the window is [1..5].
//       - If it's near the end, the window is [N-4..N].
//       - Otherwise, it's [current-2 .. current+2].
//   • This keeps the paginator narrow regardless of how many pages
//     of history a heavy user has accumulated.
//
// DISABLED STATES:
//   • Previous on page 1 → disabled, faded, pointer-events stripped.
//   • Next on last page  → same.
//
// SCROLL BEHAVIOUR:
//   • Page changes call back to the parent's `onPageChange` which
//     ALSO smoothly scrolls the history-section ref into view —
//     scroll logic lives in the parent (HomeworkPage) because that's
//     where the ref is owned.
// ────────────────────────────────────────────────────────────────
function HistoryPagination({ page, totalPages, onPageChange }) {
  // Nothing to paginate — render nothing rather than an empty bar.
  if (totalPages <= 1) return null;

  // Build the 5-page window described in the block comment above.
  const visibleCount = Math.min(5, totalPages);
  let windowStart = Math.max(1, page - 2);
  let windowEnd = windowStart + visibleCount - 1;
  if (windowEnd > totalPages) {
    windowEnd = totalPages;
    windowStart = Math.max(1, windowEnd - visibleCount + 1);
  }

  // Materialise the chip numbers as an array so React can map them.
  const pageNumbers = [];
  for (let n = windowStart; n <= windowEnd; n++) pageNumbers.push(n);

  // Shared button classes for Prev / Next. We re-use them rather
  // than re-typing the gold-outline recipe twice.
  const navButton =
    "inline-flex items-center gap-1 text-[13px] font-body " +
    "font-body-medium border border-gold text-gold rounded-4px " +
    "px-3 py-1.5 transition hover:bg-card " +
    "disabled:opacity-40 disabled:cursor-not-allowed " +
    "disabled:hover:bg-transparent " +
    "focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-gold focus-visible:ring-offset-2 " +
    "focus-visible:ring-offset-background";

  // Page-chip classes change based on whether the chip is current.
  const chipBase =
    "inline-flex items-center justify-center w-8 h-8 " +
    "rounded-4px text-[13px] font-body font-body-medium transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-gold focus-visible:ring-offset-2 " +
    "focus-visible:ring-offset-background";
  const chipCurrent = "bg-gold text-background border border-transparent";
  const chipOther =
    "bg-card text-text-muted border border-input-border " +
    "hover:bg-hover hover:text-text-primary";

  return (
    <nav
      aria-label="History pagination"
      className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      {/* Previous */}
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className={navButton}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        Previous
      </button>

      {/* Centre: page-number chips + textual indicator */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          {pageNumbers.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onPageChange(n)}
              aria-current={n === page ? "page" : undefined}
              className={chipBase + " " + (n === page ? chipCurrent : chipOther)}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="font-body text-text-muted text-[13px] whitespace-nowrap">
          Page {page} of {totalPages}
        </span>
      </div>

      {/* Next */}
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className={navButton}
      >
        Next
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </nav>
  );
}


export default function HomeworkPage() {
  // Form state. Default to the first subject in the shared list so we
  // never hardcode "Economics" — if the order changes in lib/subjects.js,
  // the default updates automatically.
  const [selectedSubject, setSelectedSubject] = useState(SUBJECTS[0].key);
  const [question, setQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Answer state – populated from the backend response.
  const [answer, setAnswer] = useState("");
  const [breakdown, setBreakdown] = useState("");

  // UUID of the row saved by /homework/ask — sent to /homework/adjust
  // so Supabase stores the latest refined answer.
  const [currentQuestionId, setCurrentQuestionId] = useState(null);

  // One-level undo: before each adjustment we push the previous
  // answer here so "← Undo" can restore it.
  const [answerHistory, setAnswerHistory] = useState([]);

  // Which adjustment button is loading (null = none). Only that
  // button shows a spinner; all four are disabled while non-null.
  const [adjustingType, setAdjustingType] = useState(null);

  // Drives the fade-out / fade-in when swapping answer text.
  const [answerFading, setAnswerFading] = useState(false);

  // Error state – non-null when the API call fails. Shown inline above
  // the Generate button so the user always sees the failure reason.
  const [error, setError] = useState(null);

  // History state (stored in localStorage – kept for backward compatibility
  // until the Supabase-backed history viewer is wired up).
  const [history, setHistory] = useState([]);

  // ────────────────────────────────────────────────────────────
  // HISTORY-TAB STATE
  // ────────────────────────────────────────────────────────────
  // `activeTab` toggles which view is on screen ("ask" or
  //    "history"). Defaults to "ask" so existing behaviour is
  //    preserved on page load.
  // `activeFilter` is the lowercase subject key currently filtering
  //    the History list, or FILTER_ALL when nothing is filtered.
  // `currentPage` is the 1-based page index inside the paginator.
  //    Always resets to 1 when the filter changes.
  // `expandedId` is the entry-id whose body is currently open.
  //    Only ONE card can be expanded at a time per the spec.
  // `allQuestions` holds EVERY history entry returned by the fetch
  //    (or by the mock fallback). All filtering and pagination is
  //    derived from this single array — we never re-fetch.
  // `historyLoading` controls the skeleton state.
  // `historyError` carries a user-facing error message when both
  //    the backend AND the Supabase fallback fail. Null on the
  //    happy path.
  // `historyFetched` is a latch — once true we don't re-fetch when
  //    the user flips between the two tabs.
  // `historyUsedMock` flips to true when the mock-data fallback
  //    was used; surfaced as a small notice so the developer
  //    (and you, in screenshots) knows the data isn't real.
  // ────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState("ask");
  const [activeFilter, setActiveFilter] = useState(FILTER_ALL);
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedId, setExpandedId] = useState(null);
  const [allQuestions, setAllQuestions] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [historyFetched, setHistoryFetched] = useState(false);
  const [historyUsedMock, setHistoryUsedMock] = useState(false);

  // Ref pointing at the top of the History section. Used to scroll
  // smoothly back to the top when the user changes pages — it
  // lives on the parent (not Pagination) because the parent owns
  // the layout the user wants to scroll inside.
  const historyTopRef = useRef(null);

  // ────────────────────────────────────────────────────────────
  // BACKEND-CALL SUPPORT STATE
  // ────────────────────────────────────────────────────────────
  // `currentUserId` is cached so generateAnswer() can include the
  // signed-in user's UUID in the POST body the backend expects.
  // It's filled by Effect 1 below from supabase.auth.getUser().
  //
  // `saveNotice` powers the small toast in the bottom-right corner.
  // We only flash it when the backend tells us `saved: false`, so
  // the student knows their answer was shown but not saved to their
  // history (rare — usually only when their session has just expired).
  // ────────────────────────────────────────────────────────────
  const [currentUserId, setCurrentUserId] = useState(null);
  const [saveNotice, setSaveNotice] = useState(null);

  // useRef mirror for the freshest user-id inside async closures.
  // generateAnswer() reads this when constructing the POST body so
  // a stale closure (e.g. captured before sign-in completed) can't
  // send the wrong user_id to the backend.
  const currentUserIdRef = useRef(currentUserId);
  useEffect(() => { currentUserIdRef.current = currentUserId; }, [currentUserId]);

  // Load history from localStorage on component mount.
  useEffect(() => {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (stored) {
      try {
        setHistory(JSON.parse(stored));
      } catch (e) {
        // Corrupt JSON – wipe it so it never crashes the page again.
        console.warn("[Homework] Could not parse stored history – resetting.");
        localStorage.removeItem(HISTORY_KEY);
      }
    }
  }, []);

  // ────────────────────────────────────────────────────────────
  // EFFECT 1 — fetch + watch the current Supabase user.
  // ────────────────────────────────────────────────────────────
  // We call supabase.auth.getUser() once on mount (verifies the JWT
  // with Supabase so we know the session is real, not just cached
  // locally) and ALSO subscribe to onAuthStateChange so that if the
  // user signs out in another tab – or their session expires – we
  // immediately stop trying to save Q&A pairs against a dead session.
  // The cleanup function unsubscribes when the component unmounts.
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { data, error } = await supabase.auth.getUser();
        if (cancelled) return;
        if (error) {
          // Not necessarily fatal – the page is protected by middleware
          // so this branch is mostly defensive (e.g. JWT just expired).
          console.warn("[Homework] supabase.auth.getUser() failed:", error.message);
          setCurrentUserId(null);
          return;
        }
        setCurrentUserId(data?.user?.id ?? null);
      } catch (err) {
        // Network failure or library throw – degrade gracefully.
        if (!cancelled) {
          console.warn("[Homework] Could not resolve current user:", err);
          setCurrentUserId(null);
        }
      }
    })();

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        // Keep our cached userId in sync with any session change
        // (sign-in, sign-out, token refresh, sign-in in another tab).
        setCurrentUserId(session?.user?.id ?? null);
      }
    );

    return () => {
      cancelled = true;
      // Older supabase-js versions returned { subscription }, newer
      // ones return the subscription on `data` directly. Handle both.
      subscription?.subscription?.unsubscribe?.();
      subscription?.unsubscribe?.();
    };
  }, []);

  // ────────────────────────────────────────────────────────────
  // EFFECT 2 — auto-dismiss the bottom-right save-toast.
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!saveNotice) return;
    const handle = setTimeout(
      () => setSaveNotice(null),
      TOAST_AUTO_DISMISS_MS
    );
    return () => clearTimeout(handle);
  }, [saveNotice]);

  // ────────────────────────────────────────────────────────────
  // EFFECT 3 — fetch History entries the first time the user
  //            opens the History tab.
  // ────────────────────────────────────────────────────────────
  // TRIGGER:  whenever `activeTab` becomes "history" AND we have
  //           not already fetched once in this session.
  // PURPOSE:  populate `allQuestions` so the History list, the
  //           filter chips, and the paginator have data to work
  //           with. The fetch happens at most once per page-load —
  //           further re-fetches happen optimistically when the
  //           user asks a NEW question (see generateAnswer below).
  //
  // STRATEGY (the backend is the sole source of truth now):
  //   1. GET ${API_URL}/homework/history with the Supabase session
  //      bearer token in the Authorization header. The server
  //      verifies the JWT, queries homework_questions for that
  //      user, joins subjects, and returns a flat list.
  //   2. If the backend returns ZERO rows (or fails with a network
  //      / 5xx error), we fall back to `buildMockHistory()` so the
  //      UI is always populated for development screenshots and
  //      first-time users who haven't asked any question yet.
  //
  // We deliberately do NOT do a direct Supabase read here any
  // more — the backend owns every write, so it is the single
  // source of truth for reads too. A failure-mode test:
  //   • Backend up + user has rows ............ render real data.
  //   • Backend up + user has zero rows ....... render mock.
  //   • Backend down (network/5xx) ............ render mock + warn.
  //
  // SAFETY: the `cancelled` latch prevents a stale fetch from
  // overwriting newer state if the user flips tabs quickly.
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab !== "history" || historyFetched) return;

    let cancelled = false;

    (async () => {
      setHistoryLoading(true);
      setHistoryError(null);
      setHistoryUsedMock(false);

      // Resolve the JWT once. Without it the backend will return
      // 401 (intended) so there's no point even firing the request.
      let token = null;
      try {
        const { data: sess } = await supabase.auth.getSession();
        token = sess?.session?.access_token ?? null;
      } catch (err) {
        console.warn("[Homework] Could not read Supabase session:", err);
      }

      if (token) {
        try {
          // ── REQUEST: GET /homework/history ───────────────
          // What this sends:
          //   • Authorization: Bearer <Supabase JWT>
          // What we expect back (HTTP 200):
          //   • { data: HistoryItem[], total: number,
          //       limit: number, offset: number }
          //   • Each HistoryItem has: id, subject (lowercase
          //     key OR null), subject_code, question, answer,
          //     topic_tag, created_at.
          const res = await fetch(`${API_URL}/homework/history`, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          });

          if (res.ok) {
            const body = await res.json();
            // The contract is `body.data`, but tolerate a bare
            // array in case a future version of the endpoint
            // changes the envelope.
            const rows = Array.isArray(body) ? body : body?.data;
            if (Array.isArray(rows) && rows.length > 0) {
              if (cancelled) return;
              setAllQuestions(rows);
              setHistoryFetched(true);
              setHistoryLoading(false);
              return;
            }
            // 200 OK but zero rows → user hasn't asked any
            // question yet. We fall through to the mock-data
            // fallback so the UI stays populated for the demo.
          } else {
            // Non-2xx (401, 5xx, etc.) — log and fall through.
            console.warn(
              `[Homework] /homework/history returned HTTP ${res.status}; ` +
                "falling back to mock data."
            );
          }
        } catch (err) {
          // Network failure → log and fall through to mock.
          console.warn(
            "[Homework] Backend history fetch failed; falling back to mock.",
            err
          );
        }
      }

      // ── FALLBACK: mock data. ─────────────────────────────
      // Reached when EITHER the backend was unreachable, OR the
      // user genuinely has zero rows in homework_questions.
      // Mock data is clearly flagged in the UI by historyUsedMock.
      if (cancelled) return;
      setAllQuestions(buildMockHistory());
      setHistoryUsedMock(true);
      setHistoryFetched(true);
      setHistoryLoading(false);
    })();

    return () => { cancelled = true; };
  }, [activeTab, historyFetched]);

  // ────────────────────────────────────────────────────────────
  // EFFECT 4 — reset to page 1 whenever the active filter changes.
  // ────────────────────────────────────────────────────────────
  // Without this, switching from "All" → "Economics" while on
  // page 3 would land on a page-3 view that no longer exists for
  // the smaller filtered list. Resetting to page 1 also matches
  // user expectation ("show me Economics from the top").
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    setCurrentPage(1);
    setExpandedId(null);
  }, [activeFilter]);

  // Save the most recent question + answer to localStorage so the
  // legacy "Previous questions" strip below the answer card survives
  // a reload. This is intentionally separate from the History tab —
  // the History tab is sourced from Supabase via the backend, while
  // this strip is a frontend-only convenience for the current device.
  const saveToHistory = (subject, question, answer, breakdown) => {
    const newEntry = {
      id: Date.now(),
      subject,
      question,
      answer,
      breakdown,
      createdAt: new Date().toISOString(),
    };
    // Keep at most 10 entries, newest first.
    const updatedHistory = [newEntry, ...history].slice(0, 10);
    setHistory(updatedHistory);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
  };

  // ────────────────────────────────────────────────────────────
  // generateAnswer — call POST /homework/ask on the FastAPI
  // backend and render the response. The backend is now the
  // SOLE owner of:
  //   • the Groq API call (the browser never talks to Groq),
  //   • the Supabase insert into homework_questions,
  //   • the TOPIC_TAG extraction.
  // The frontend's only job here is to:
  //   1. Build the request body the backend's Pydantic model
  //      expects (HomeworkRequest).
  //   2. Attach the user's Supabase JWT as a bearer token so
  //      the backend can verify identity.
  //   3. Render the cleaned answer and surface a toast if the
  //      backend reports `saved: false`.
  //   4. Optimistically prepend the new entry to allQuestions
  //      so the History tab stays in sync without re-fetching.
  // ────────────────────────────────────────────────────────────
  const generateAnswer = async () => {
    // Guard against empty submissions — render error inline.
    // The backend ALSO validates this (min 10 chars), but checking
    // here avoids a wasted round-trip and shows the error instantly.
    if (!question.trim()) {
      setError("Please enter a question before generating an answer.");
      return;
    }

    // Reset UI state at the start of every request.
    setIsLoading(true);
    setError(null);
    setAnswer("");
    setBreakdown("");
    setCurrentQuestionId(null);
    setAnswerHistory([]);
    setAdjustingType(null);

    try {
      // ── STEP 1: resolve the bearer token ─────────────────
      // We can't ask the backend to do anything until we know
      // the user is signed in. supabase.auth.getSession() reads
      // the session cookie set by @supabase/ssr, so it works
      // both for the very first call AND after a token refresh.
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token ?? null;
      const userId = sess?.session?.user?.id ?? currentUserIdRef.current;

      if (!token || !userId) {
        // No session → don't even fire the request; surface
        // the same UX the backend would (401) without the
        // network round-trip.
        throw new Error(
          "Your session has expired. Please sign in again to ask a question."
        );
      }

      // ── STEP 2: resolve the syllabus code for the body ───
      // The backend wants `subject_code` as a string (e.g.
      // "9708"). We pull it from lib/subjects.js so the value
      // is always in sync with the subject metadata.
      const meta = getSubjectByKey(selectedSubject);
      const subjectCode = meta?.code ?? "";

      // ── STEP 3: POST /homework/ask ───────────────────────
      // What this REQUEST contains:
      //   • Authorization: Bearer <Supabase JWT> — proves who
      //     we are. The backend verifies via supabase.auth.get_user.
      //   • body.question     — the typed question (10-2000 chars).
      //   • body.subject      — lowercase key (economics|business|english|ict).
      //   • body.subject_code — Cambridge syllabus code (9708, etc.).
      //   • body.user_id      — UUID of the signed-in user.
      //     The backend rejects with 401 if this doesn't match
      //     the user_id encoded in the JWT.
      // What we EXPECT BACK on success (HTTP 200):
      //   { answer: string,
      //     topic_tag: string | null,
      //     saved: boolean,
      //     question_id: string | null }
      console.log(
        `[Homework] POST ${API_URL}/homework/ask  subject=${selectedSubject}`
      );

      const response = await fetch(`${API_URL}/homework/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          question: question.trim(),
          subject: selectedSubject,
          subject_code: subjectCode,
          user_id: userId,
        }),
      });

      // ── STEP 4: handle non-2xx ───────────────────────────
      // The backend wraps every error in `{ detail: { error: msg } }`
      // (FastAPI's HTTPException convention). 422 from Pydantic
      // wraps an array under `detail` instead — handle both.
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const detail = errorBody?.detail;
        const message =
          (detail && typeof detail === "object" && detail.error)
            ? detail.error
            : typeof detail === "string"
              ? detail
              : `Backend returned HTTP ${response.status}.`;
        throw new Error(message);
      }

      // ── STEP 5: render the answer ────────────────────────
      const data = await response.json();
      setAnswer(data.answer ?? "");
      setCurrentQuestionId(data.question_id ?? null);
      setAnswerHistory([]);
      // The new endpoint does not emit a `breakdown` field. We
      // explicitly clear it so a previously rendered breakdown
      // card disappears on the next question.
      setBreakdown("");

      // ── STEP 6: surface save failures (rare) ─────────────
      // The backend NEVER blocks the user from seeing their
      // answer — even when the Supabase save fails. We tell
      // the user with a quiet toast so they know their History
      // tab won't contain this row.
      if (data.saved === false) {
        setSaveNotice({
          tone: "error",
          message:
            "Answer shown, but could not be saved to your cloud history. " +
              "It will still appear on this device.",
        });
      }

      // ── STEP 7: keep state in sync with what just happened ──
      if (data.answer) {
        // localStorage strip — still useful as a same-device
        // convenience under the answer card.
        saveToHistory(
          selectedSubject,
          question.trim(),
          data.answer,
          ""
        );

        // Optimistic prepend so the History tab shows this Q&A
        // instantly. We use the REAL question_id from the
        // backend when available (so a refresh maps to the
        // same row), and a temp-id prefix only when the save
        // failed (so the row is still browsable locally).
        const optimisticId = data.question_id ?? `temp-${Date.now()}`;
        const newEntry = {
          id: optimisticId,
          subject: selectedSubject,
          subject_code: subjectCode,
          question: question.trim(),
          answer: data.answer,
          topic_tag: data.topic_tag ?? null,
          created_at: new Date().toISOString(),
        };
        setAllQuestions((prev) => [newEntry, ...prev]);
      }
    } catch (err) {
      console.error("[Homework] Request failed:", err);
      setError(
        err.message ||
          "Could not reach the AscendAI backend. Is the FastAPI server running on port 8001?"
      );
    } finally {
      setIsLoading(false);
    }
  };

  // ────────────────────────────────────────────────────────────
  // adjustAnswer — POST /homework/adjust to refine the current
  // model answer (Simplify / More detail / Shorten / Add examples).
  // ────────────────────────────────────────────────────────────
  const adjustAnswer = async (adjustmentType) => {
    if (!answer?.trim() || !question.trim()) return;
    if (adjustingType) return;

    const meta = getSubjectByKey(selectedSubject);
    const subjectLabel = meta?.fullName ?? meta?.name ?? selectedSubject;
    const subjectCode = meta?.code ?? "";

    setAdjustingType(adjustmentType);
    setError(null);

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token ?? null;
      const userId = sess?.session?.user?.id ?? currentUserIdRef.current;

      if (!token || !userId) {
        throw new Error(
          "Your session has expired. Please sign in again to adjust your answer."
        );
      }

      const response = await fetch(`${API_URL}/homework/adjust`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          question_id: currentQuestionId,
          question: question.trim(),
          current_answer: answer,
          adjustment_type: adjustmentType,
          subject: subjectLabel,
          subject_code: subjectCode,
          user_id: userId,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const detail = errorBody?.detail;
        const message =
          detail && typeof detail === "object" && detail.error
            ? detail.error
            : typeof detail === "string"
              ? detail
              : `Backend returned HTTP ${response.status}.`;
        throw new Error(message);
      }

      const data = await response.json();
      const adjusted = data.adjusted_answer ?? "";

      // Push current answer onto history stack for one-level undo.
      setAnswerHistory((prev) => [...prev, answer]);

      // Fade out → swap text → fade in.
      setAnswerFading(true);
      await new Promise((resolve) => setTimeout(resolve, 180));
      setAnswer(adjusted);
      setAnswerFading(false);

      if (currentQuestionId && adjusted) {
        setAllQuestions((prev) =>
          prev.map((row) =>
            row.id === currentQuestionId
              ? {
                  ...row,
                  answer: adjusted,
                  topic_tag: data.topic_tag ?? row.topic_tag,
                }
              : row
          )
        );
      }

      saveToHistory(selectedSubject, question.trim(), adjusted, "");

      setSaveNotice({
        tone: "info",
        message:
          ADJUST_TOAST_MESSAGES[adjustmentType] ?? "Answer updated",
      });

      if (data.saved === false && currentQuestionId) {
        setSaveNotice({
          tone: "error",
          message:
            "Answer updated on screen, but could not save the refinement to your cloud history.",
        });
      }
    } catch (err) {
      console.error("[Homework] adjust failed:", err);
      setSaveNotice({
        tone: "error",
        message:
          err.message ||
          "Could not adjust your answer. Please try again.",
      });
    } finally {
      setAdjustingType(null);
    }
  };

  // undoAdjustment — restore the answer from before the last
  // refinement (single level only).
  const undoAdjustment = () => {
    if (answerHistory.length === 0) return;
    const previous = answerHistory[answerHistory.length - 1];
    setAnswerFading(true);
    setTimeout(() => {
      setAnswer(previous);
      setAnswerHistory([]);
      setAnswerFading(false);
    }, 180);
  };

  // Load a previous question from history. We coerce the saved subject
  // into a valid key via the lookup helper so legacy entries that stored
  // a display name ("Economics") still select the correct dropdown option.
  const loadFromHistory = (entry) => {
    const subjectMeta = getSubjectByName(entry.subject);
    setSelectedSubject(subjectMeta?.key ?? SUBJECTS[0].key);
    setQuestion(entry.question);
    setAnswer(entry.answer);
    setBreakdown(entry.breakdown);
  };

  // Copy answer to clipboard
  const copyAnswer = () => {
    if (answer) {
      navigator.clipboard.writeText(answer.replace(/<br>/g, "\n"));
      alert("Answer copied to clipboard.");
    } else {
      alert("No answer to copy yet.");
    }
  };

  // ════════════════════════════════════════════════════════════
  // HISTORY-TAB DERIVED STATE
  // ────────────────────────────────────────────────────────────
  // We compute the filtered + paginated lists via useMemo so they
  // only recompute when their inputs change (allQuestions, the
  // active filter, or the current page). This avoids unnecessary
  // re-renders of every HistoryCard on unrelated state changes
  // (e.g. typing into the question textarea).
  // ────────────────────────────────────────────────────────────

  // FILTER LOGIC (step by step):
  //   1. When activeFilter === FILTER_ALL ("all") we keep every entry.
  //   2. Otherwise we keep only entries whose `subject` field
  //      matches the filter key exactly. Subject keys are stored
  //      lowercase ("economics", "business", "english", "ict")
  //      both in the mock generator and in the normalised rows
  //      that come back from Supabase / the backend.
  //   3. Filtering happens entirely in memory — no new API call
  //      is made when the user clicks a filter chip.
  const filteredQuestions = useMemo(() => {
    if (activeFilter === FILTER_ALL) return allQuestions;
    return allQuestions.filter((q) => q.subject === activeFilter);
  }, [allQuestions, activeFilter]);

  // Total pages — at least 1 even when there are no results, so
  // the paginator doesn't render "Page 1 of 0" in the empty state.
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredQuestions.length / PAGE_SIZE)),
    [filteredQuestions.length]
  );

  // PAGINATION LOGIC (step by step):
  //   1. The paginator stores a 1-based page index in `currentPage`.
  //   2. We slice the filtered array using
  //        start = (currentPage - 1) * PAGE_SIZE
  //        end   = start + PAGE_SIZE
  //      so each page contains AT MOST `PAGE_SIZE` items.
  //   3. The slice is taken AFTER filtering, so the page count
  //      tracks the filtered list (not the full one).
  //   4. If the user lands on a page that no longer exists (e.g.
  //      because they filtered to a smaller subset), we clamp
  //      currentPage back down inside Effect 5 above.
  const paginatedQuestions = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredQuestions.slice(start, start + PAGE_SIZE);
  }, [filteredQuestions, currentPage]);

  // ────────────────────────────────────────────────────────────
  // HISTORY-TAB HANDLERS
  // ────────────────────────────────────────────────────────────

  // toggleExpand — fired by HistoryCard's "View answer" / "Hide
  // answer" buttons. Per the spec, only ONE card can be open at
  // a time, so clicking a different card collapses the previous
  // one automatically. Clicking the SAME card collapses it.
  const toggleExpand = (id) => {
    setExpandedId((current) => (current === id ? null : id));
  };

  // goToPage — fires when the user clicks Previous / Next / a
  // page number chip. We clamp the requested page into [1..totalPages]
  // so the paginator can never end up at, say, page 0 or page 99.
  // After updating state we smoothly scroll the top of the History
  // section back into view — the user expects "Next" to scroll
  // them up to the new first card, not leave them at the foot
  // of the previous one.
  const goToPage = (n) => {
    const next = Math.max(1, Math.min(totalPages, n));
    setCurrentPage(next);
    setExpandedId(null); // collapse any open card on page change
    // requestAnimationFrame so the new layout is committed before
    // the smooth scroll starts — otherwise we scroll to the
    // pre-update position and miss the target.
    requestAnimationFrame(() => {
      historyTopRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  // FOLLOW-UP PRE-FILL — fires when the user clicks "Ask follow-up"
  // on an expanded card. It:
  //   1. Switches the Subject dropdown to the original entry's
  //      subject so the new question is asked against the right
  //      Cambridge syllabus.
  //   2. Drops the truncated question into the textarea, prefixed
  //      with "Follow-up on: " so Aisha can extend or rephrase it.
  //   3. Flips the active tab back to "ask" so she sees the form.
  //   4. Collapses any expanded history card (we're leaving the
  //      tab — no need to keep one open in the background).
  //   5. Scrolls the page to the top so the textarea is in view.
  const handleAskFollowUp = (entry, prefillLabel) => {
    setSelectedSubject(entry.subject);
    setQuestion(prefillLabel);
    setActiveTab("ask");
    setExpandedId(null);
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  // EMPTY-STATE CTA — clicked from "No questions yet" inside the
  // History tab. Pure tab switch (no pre-fill).
  const switchToAskTab = () => {
    setActiveTab("ask");
  };

  // ============================================================
  // STRUCTURED ANSWER RENDERER
  // ============================================================
  // Groq returns plain text (no Markdown) organised into named
  // sections. We need to:
  //   1. Strip any stray Markdown symbols defensively (so even if the
  //      model slips in `**` the student never sees raw symbols).
  //   2. Detect the four canonical section headings — DEFINITION,
  //      CAMBRIDGE ANSWER, EXAMINER TIP, COMMON MISTAKES — and any
  //      heading the BREAKDOWN section uses, then render them as bold
  //      uppercase gold using the `text-gold` Tailwind token.
  //   3. Detect inline labels at the start of a line (Mistake:,
  //      Examiner Tip:, Definition:, Application:, Analysis:) and
  //      bold the label so the student can scan the answer.
  //   4. Treat blank lines as paragraph breaks (visible spacing
  //      between blocks) instead of literal whitespace.
  // ------------------------------------------------------------
  // Implementation note: section headings live in `SECTION_HEADERS`
  // and inline labels live in `INLINE_PREFIXES`. Both are scoped to
  // this component so they can't drift from the backend's prompt.
  // ============================================================
  const renderStructuredText = (text) => {
    if (!text) return null;

    // Section names (UPPERCASE, exact match) the renderer treats as
    // bold gold headings. Must mirror the section names produced by
    // the Cambridge tutor prompt in backend/main.py.
    const SECTION_HEADERS = new Set([
      "DEFINITION",
      "CAMBRIDGE ANSWER",
      "EXAMINER TIP",
      "COMMON MISTAKES",
    ]);

    // Inline prefixes — when a line starts with one of these, the
    // label is rendered in semibold so the structure is scannable.
    const INLINE_PREFIXES = [
      "Mistake:",
      "Examiner Tip:",
      "Definition:",
      "Application:",
      "Analysis:",
    ];

    // Defensive strip of Markdown symbols that should never appear
    // (the system prompt forbids them, but LLMs occasionally slip up).
    const cleaned = text
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s+/gm, "")
      .replace(/`/g, "");

    // Group consecutive non-empty lines into "blocks" separated by
    // blank lines. Each block renders as either a heading-with-body
    // or a regular paragraph.
    const blocks = [];
    let current = [];
    for (const rawLine of cleaned.split("\n")) {
      const line = rawLine.trimEnd();
      if (line.trim() === "") {
        if (current.length > 0) {
          blocks.push(current);
          current = [];
        }
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) blocks.push(current);

    return blocks.map((block, blockIdx) => {
      const firstLine = block[0].trim();
      const isHeader = SECTION_HEADERS.has(firstLine.toUpperCase());

      if (isHeader) {
        // Render the heading in bold gold (with a thin gold underline)
        // and stack the body lines below it as paragraphs.
        const bodyLines = block.slice(1);
        return (
          <div key={blockIdx} className="mb-5">
            <h3 className="text-gold font-bold text-sm uppercase tracking-widest mb-2 pb-1 border-b border-hover">
              {firstLine}
            </h3>
            <div className="space-y-2">
              {bodyLines.map((line, lineIdx) =>
                renderInlineLine(line, INLINE_PREFIXES, `${blockIdx}-${lineIdx}`)
              )}
            </div>
          </div>
        );
      }

      // Numbered breakdown lines (e.g. "1. Definition — ...") render
      // as their own paragraph block so the structural overview reads
      // like a clean list.
      return (
        <div key={blockIdx} className="mb-3 space-y-1">
          {block.map((line, lineIdx) =>
            renderInlineLine(line, INLINE_PREFIXES, `${blockIdx}-${lineIdx}`)
          )}
        </div>
      );
    });
  };

  // Render ONE line. If it starts with a recognised inline prefix
  // (Mistake:, Examiner Tip:, etc.) the label is bolded and the rest
  // flows as normal body text. Otherwise the line renders as a plain
  // paragraph using the standard text-primary token.
  const renderInlineLine = (line, prefixes, key) => {
    for (const prefix of prefixes) {
      if (line.startsWith(prefix)) {
        const rest = line.slice(prefix.length).trim();
        return (
          <p key={key} className="text-text-primary leading-relaxed">
            <span className="font-semibold text-text-primary">{prefix}</span>{" "}
            {rest}
          </p>
        );
      }
    }
    return (
      <p key={key} className="text-text-primary leading-relaxed">
        {line}
      </p>
    );
  };

  return (
    <main className="min-h-screen bg-background py-6 px-4 sm:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Unified shared page header (replaces the old gradient
            H1 — every feature page now uses PageHeader). */}
        <PageHeader
          title="Homework Assistant"
          subtitle="Cambridge AS Level — Model answers with structural breakdown"
        />

        {/* ────────────────────────────────────────────────────
            TAB NAVIGATION
            ────────────────────────────────────────────────────
            Two buttons in a row that switch between the existing
            "Ask a Question" view and the new "History" view.
            The row itself owns the 1 px input-border bottom rule
            and the buttons use a -1px negative margin so their
            own 2 px active border sits flush on top of that rule
            instead of below it.

            Switching tabs is a PURE state update — no fetch fires
            and no URL changes. The History fetch only runs the
            FIRST time the user opens that tab (see EFFECT 4). */}
        <nav
          aria-label="Homework tabs"
          className="flex items-center gap-2 border-b border-input-border mb-6"
        >
          <HwTabButton
            active={activeTab === "ask"}
            onClick={() => setActiveTab("ask")}
          >
            Ask a Question
          </HwTabButton>
          <HwTabButton
            active={activeTab === "history"}
            onClick={() => setActiveTab("history")}
          >
            History
          </HwTabButton>
        </nav>

        {/* ────────────────────────────────────────────────────
            ASK TAB — wraps the entire pre-existing layout
            ────────────────────────────────────────────────────
            Nothing inside this conditional was changed by the
            History feature. It's the exact two-column form +
            answer + breakdown + adjustment-buttons view that
            shipped before, just gated by `activeTab === "ask"`
            so the History view can swap in beneath the same
            <main> container.  */}
        {activeTab === "ask" && (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left column: Form and adjustments */}
          <div className="flex-1 space-y-6">
            {/* Question form card */}
            <div className="bg-white rounded-4px shadow-md border border-hover p-6">
              <h2 className="font-heading text-xl font-semibold text-text-primary mb-4 pb-2 border-b border-hover relative after:content-[''] after:absolute after:bottom-0 after:left-0 after:w-16 after:h-0.5 after:bg-gold">
                ✍️ Ask a question
              </h2>
              <div className="mb-4">
                <label className="block font-semibold text-text-primary mb-2">
                  Subject
                </label>
                <select
                  value={selectedSubject}
                  onChange={(e) => setSelectedSubject(e.target.value)}
                  className="w-full border border-hover rounded-4px px-3 py-2 focus:border-gold focus:ring-1 focus:ring-gold outline-none"
                >
                  {/* Build options from the shared subject list. The
                      <option> value is the subject `key` (used internally),
                      and the visible label combines fullName + syllabus code. */}
                  {SUBJECTS.map((sub) => (
                    <option key={sub.key} value={sub.key}>
                      {sub.fullName} ({sub.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="mb-4">
                <label className="block font-semibold text-text-primary mb-2">
                  Your question
                </label>
                <textarea
                  rows={5}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="e.g., Explain the concept of price elasticity of demand and its determinants."
                  className="w-full border border-hover rounded-4px px-3 py-2 focus:border-gold focus:ring-1 focus:ring-gold outline-none resize-y"
                />
              </div>
              {/* Inline error banner – only renders when `error` is non-null.
                  Sits directly above the Generate button so the user can
                  read the message and immediately try again. */}
              {error && (
                <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-4px text-red-700 text-sm">
                  {error}
                </div>
              )}

              {/* Primary button — unified gold-filled style
                  matching every other page's primary CTA
                  (audit Task 10). text-background is the cream
                  token used for text on gold surfaces. */}
              <button
                type="button"
                onClick={() => generateAnswer()}
                disabled={isLoading}
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
                {isLoading ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="inline-block w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin"
                    />
                    Generating…
                  </>
                ) : (
                  "Generate Answer"
                )}
              </button>
            </div>

            {/* Need adjustments? — shown after an answer exists. */}
            {answer && !isLoading && (
              <div
                className={
                  "bg-white rounded-4px shadow-md border border-hover p-6 " +
                  "transition-opacity duration-300 opacity-100"
                }
              >
                <h2
                  className={
                    "font-heading text-lg font-heading-medium text-text-primary " +
                    "mb-1 pb-2 border-b-2 border-gold inline-block"
                  }
                >
                  Need adjustments?
                </h2>

                <div className="flex flex-wrap gap-2 mt-4">
                  {[
                    { type: ADJUST_SIMPLIFY, label: "Simplify", Icon: Zap },
                    {
                      type: ADJUST_MORE_DETAIL,
                      label: "More detail",
                      Icon: BookOpen,
                    },
                    { type: ADJUST_SHORTEN, label: "Shorten", Icon: Scissors },
                    {
                      type: ADJUST_ADD_EXAMPLES,
                      label: "Add examples",
                      Icon: Globe,
                    },
                  ].map(({ type, label, Icon }) => {
                    const isThisLoading = adjustingType === type;
                    const disabled = adjustingType !== null;
                    return (
                      <button
                        key={type}
                        type="button"
                        disabled={disabled}
                        onClick={() => adjustAnswer(type)}
                        className={
                          "inline-flex items-center gap-2 px-4 py-2 rounded-4px " +
                          "border border-input-border font-body text-[13px] " +
                          "text-text-primary bg-white transition " +
                          "hover:border-gold hover:text-gold " +
                          "disabled:opacity-60 disabled:cursor-not-allowed " +
                          "focus-visible:outline-none focus-visible:ring-2 " +
                          "focus-visible:ring-gold/30"
                        }
                      >
                        {isThisLoading ? (
                          <span
                            aria-hidden="true"
                            className={
                              "inline-block w-3.5 h-3.5 border-2 border-gold " +
                              "border-t-transparent rounded-full animate-spin"
                            }
                          />
                        ) : (
                          <Icon size={14} aria-hidden="true" />
                        )}
                        {label}
                      </button>
                    );
                  })}
                </div>

                {answerHistory.length > 0 && (
                  <button
                    type="button"
                    onClick={undoAdjustment}
                    disabled={adjustingType !== null}
                    className={
                      "mt-4 font-body text-[13px] text-text-muted " +
                      "hover:text-gold transition disabled:opacity-50"
                    }
                  >
                    ← Undo
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Right column: Answer and breakdown */}
          <div className="flex-1 space-y-6">
            {/* Answer card */}
            <div className="bg-white rounded-4px shadow-md border border-hover p-6">
              <div className="flex justify-between items-center mb-4 pb-2 border-b border-hover">
                <h2 className="font-heading text-xl font-semibold text-text-primary">
                  📝 Model Answer
                </h2>
                {answer && (
                  <button
                    onClick={copyAnswer}
                    className="text-text-hint text-sm hover:text-gold transition"
                  >
                    📋 Copy
                  </button>
                )}
              </div>
              <div
                className={
                  "bg-background p-4 rounded-4px border-l-3 border-gold " +
                  "text-text-primary leading-relaxed transition-opacity duration-300 " +
                  (answerFading ? "opacity-0" : "opacity-100")
                }
              >
                {isLoading && !answer ? (
                  <div className="flex items-center gap-2 text-text-muted">
                    <span className="inline-block w-4 h-4 border-2 border-gold border-t-transparent rounded-full animate-spin"></span>
                    Generating answer...
                  </div>
                ) : answer ? (
                  renderStructuredText(answer)
                ) : (
                  <em className="text-text-muted">Your answer will appear here after you submit a question.</em>
                )}
              </div>
            </div>

            {/* Breakdown card — only rendered when the backend
                actually returned a structural breakdown. The new
                /homework/ask endpoint folds the four-section
                structure (DEFINITION / CAMBRIDGE ANSWER / EXAMINER
                TIP / COMMON MISTAKES) directly into the answer
                itself, so `breakdown` stays empty and this whole
                block is skipped. If a future endpoint re-introduces
                a dedicated breakdown payload, this card will
                automatically appear again. */}
            {breakdown && (
              <div className="bg-white rounded-4px shadow-md border border-hover p-6">
                <h2 className="font-heading text-xl font-semibold text-text-primary mb-4 pb-2 border-b border-hover relative after:content-[''] after:absolute after:bottom-0 after:left-0 after:w-16 after:h-0.5 after:bg-gold">
                  Structural Breakdown
                </h2>
                <div className="space-y-3">
                  {renderStructuredText(breakdown)}
                </div>
              </div>
            )}
          </div>
        </div>
        )}
        {/* ▲▲▲ END OF ASK TAB ▲▲▲ */}


        {/* ════════════════════════════════════════════════════
            HISTORY TAB
            ════════════════════════════════════════════════════
            Visible only when activeTab === "history". Renders:
              1. Filter chip row (All + four subjects).
              2. "Showing X questions" results count.
              3. Either: 3 skeletons / empty state / card list
                 + paginator, depending on loading / data.
              4. Dev-only "mock data" notice when the mock
                 fallback is in use.
            All data lives in `allQuestions` — every chip click
            and every page click is a pure in-memory operation. */}
        {activeTab === "history" && (
        <section
          aria-label="Homework history"
          // Anchor for the smooth-scroll-to-top behaviour when
          // the user pages forward / backward inside the
          // paginator. Owned by the parent so child components
          // don't need to know about layout positioning.
          ref={historyTopRef}
        >
          {/* ── Filter chip row ────────────────────────────── */}
          <div className="-mx-1 overflow-x-auto">
            <ul className="flex items-center gap-2 px-1 min-w-max">
              {HISTORY_FILTER_OPTIONS.map((opt) => (
                <li key={opt.value}>
                  <HistoryFilterChip
                    active={activeFilter === opt.value}
                    onClick={() => setActiveFilter(opt.value)}
                  >
                    {opt.label}
                  </HistoryFilterChip>
                </li>
              ))}
            </ul>
          </div>

          {/* ── Results count line ─────────────────────────── */}
          <p className="mt-4 mb-3 font-body text-text-muted text-[13px]">
            Showing {filteredQuestions.length}{" "}
            {filteredQuestions.length === 1 ? "question" : "questions"}
          </p>

          {/* ── BODY: loading / error / empty / list ──────── */}
          {historyLoading ? (
            /* LOADING — 3 pulsing skeleton cards in a vertical stack. */
            <div className="space-y-3">
              <HistorySkeleton />
              <HistorySkeleton />
              <HistorySkeleton />
            </div>
          ) : historyError ? (
            /* ERROR — surfaced when every fetch path failed.
               Today we never hit this because the mock fallback
               always succeeds, but it's wired up so a future
               "no mock data" mode can use it without a refactor. */
            <div
              className={
                "bg-card border border-input-border rounded-4px " +
                "p-6 text-center font-body text-text-muted"
              }
            >
              {historyError}
            </div>
          ) : filteredQuestions.length === 0 ? (
            /* EMPTY — message changes based on whether the user
               has filtered to a specific subject or not. */
            <div
              className={
                "bg-card border border-input-border rounded-4px " +
                "p-10 shadow-sm text-center max-w-xl mx-auto"
              }
            >
              <div className="flex justify-center mb-4">
                <MessageSquare
                  size={48}
                  strokeWidth={1.5}
                  className="text-gold"
                  aria-hidden="true"
                />
              </div>
              <h2 className="font-heading text-2xl font-heading-bold text-text-primary mb-2">
                No questions yet
              </h2>
              <p className="font-body text-text-muted text-[13px] mb-5 leading-relaxed">
                {activeFilter === FILTER_ALL
                  ? "Ask your first Cambridge question in the Ask tab."
                  : (() => {
                      // Show a friendly subject-specific message.
                      const meta = getSubjectByKey(activeFilter);
                      const name = meta?.name ?? "this subject";
                      return (
                        `No ${name} questions yet. ` +
                        `Switch to Ask tab to ask your first ${name} question.`
                      );
                    })()}
              </p>
              <button
                type="button"
                onClick={switchToAskTab}
                // Secondary button — outline gold (Task 10 of the
                // UI audit). Same recipe used for "Ask follow-up".
                className={
                  "inline-flex items-center gap-1.5 text-sm " +
                  "font-body font-body-semibold border border-gold " +
                  "text-gold rounded-4px px-4 py-2 transition " +
                  "hover:bg-card focus-visible:outline-none " +
                  "focus-visible:ring-2 focus-visible:ring-gold " +
                  "focus-visible:ring-offset-2 " +
                  "focus-visible:ring-offset-background"
                }
              >
                Ask a question
              </button>
            </div>
          ) : (
            /* HAPPY PATH — show the paginated card list. */
            <>
              <div className="space-y-3">
                {paginatedQuestions.map((entry) => (
                  <HistoryCard
                    key={entry.id}
                    entry={entry}
                    expanded={expandedId === entry.id}
                    onToggle={toggleExpand}
                    onFollowUp={handleAskFollowUp}
                    renderAnswer={renderStructuredText}
                  />
                ))}
              </div>

              <HistoryPagination
                page={currentPage}
                totalPages={totalPages}
                onPageChange={goToPage}
              />
            </>
          )}

          {/* Dev-only notice that we're showing mock data. Hidden
              the moment any real row arrives via the backend or
              the direct-Supabase fallback. */}
          {historyUsedMock && !historyLoading && (
            <p className="mt-6 text-center font-body text-text-hint text-xs">
              Showing sample history while your real Q&amp;A library
              loads. The Ask tab is still writing every new answer
              into Supabase — refresh the page once you've asked a
              question to see real data here.
            </p>
          )}
        </section>
        )}
        {/* ▲▲▲ END OF HISTORY TAB ▲▲▲ */}

        {/* ────────────────────────────────────────────────────
            SAVE-STATUS TOAST
            ────────────────────────────────────────────────────
            Fixed-position card in the bottom-right. Only renders
            when `saveNotice` is non-null. Auto-dismisses after
            TOAST_AUTO_DISMISS_MS (see effect above). Used solely
            for SAVE failures – successful saves are silent.
            "tone === 'error'" uses the same red palette as the
            inline error banner above the Generate button.
            "tone === 'info'" uses the gold accent so it visually
            matches the rest of the premium UI. */}
        {saveNotice && (
          <div
            role="status"
            aria-live="polite"
            className={
              "fixed bottom-6 right-6 z-50 max-w-sm rounded-4px shadow-md " +
              "border p-4 pr-10 text-sm bg-white " +
              (saveNotice.tone === "error"
                ? "border-red-200 text-red-700"
                : "border-gold text-text-primary")
            }
          >
            <p className="leading-relaxed">{saveNotice.message}</p>
            <button
              type="button"
              onClick={() => setSaveNotice(null)}
              aria-label="Dismiss"
              className="absolute top-2 right-2 text-text-hint hover:text-text-primary transition leading-none text-lg"
            >
              ×
            </button>
          </div>
        )}

        {/* LEGACY localStorage history strip — only shown on the
            ASK tab. The new History tab (above) is the canonical
            "previous questions" surface; this strip is kept for
            backward compatibility with users who already have
            localStorage rows from before the History tab shipped. */}
        {activeTab === "ask" && history.length > 0 && (
          <div className="mt-8 bg-white rounded-4px shadow-md border border-hover overflow-hidden">
            <div className="px-6 py-3 border-b border-hover font-semibold text-text-primary">
              🕘 Previous questions
            </div>
            <div className="divide-y divide-hover">
              {history.map((item) => {
                // History entries may have been saved with either an
                // old-style display name ("Economics") or the new key
                // ("economics") — the lookup helper handles both safely.
                const subjectMeta = getSubjectByName(item.subject);
                const subjectLabel = subjectMeta?.name ?? item.subject;
                return (
                  <div
                    key={item.id}
                    onClick={() => loadFromHistory(item)}
                    className="px-6 py-3 hover:bg-background cursor-pointer transition flex items-center gap-3"
                  >
                    <span className="text-gold text-lg">📌</span>
                    <span className="text-text-primary truncate">{item.question}</span>
                    <span className="text-text-hint text-xs ml-auto">{subjectLabel}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}