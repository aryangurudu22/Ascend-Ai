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
import Link from "next/link";
import { motion } from "framer-motion";
import { MessageSquare, ChevronDown } from "lucide-react";
import {
  SUBJECTS,
  getSubjectByName,
  getSubjectByKey,
} from "../../../lib/subjects";
import { supabase } from "../../../lib/supabaseClient";
import SubjectBadge from "../../components/SubjectBadge";
import { fadeUp } from "../../lib/animations";

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
// Subject-key → left-border accent (CSS variables only — matches dashboard notes)
const HISTORY_LEFT_BORDER_VAR = {
  economics: "var(--econ-accent)",
  business: "var(--biz-accent)",
  english: "var(--eng-accent)",
  ict: "var(--ict-accent)",
};

// ────────────────────────────────────────────────────────────────
// HELPER: stripAnswerMarkdown
// ----------------------------------------------------------------
// Removes stray Markdown symbols from model answers so students
// never see raw ** or ## even if the LLM slips.
// ────────────────────────────────────────────────────────────────
function stripAnswerMarkdown(text) {
  return String(text ?? "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/`/g, "")
    .replace(/^\*\s+/gm, "");
}

// ────────────────────────────────────────────────────────────────
// HELPER: parseAnswerSections
// ----------------------------------------------------------------
// Splits a Cambridge answer string on the four canonical headers:
// DEFINITION, CAMBRIDGE ANSWER, EXAMINER TIP, COMMON MISTAKES.
// Returns an object with optional string values per section.
// ────────────────────────────────────────────────────────────────
function parseAnswerSections(text) {
  if (!text?.trim()) return {};
  const cleaned = stripAnswerMarkdown(text);
  const pattern =
    /(?:^|\n)\s*(DEFINITION|CAMBRIDGE ANSWER|EXAMINER TIP|COMMON MISTAKES)\s*\n?/gi;
  const parts = cleaned.split(pattern);
  const sections = {};

  const cleanSectionContent = (content) => {
    let c = String(content || "");
    c = c.replace(/^:\s*/, "");
    c = c.replace(/^Examiner Tip:\s*/i, "");
    c = c.replace(/Mistake:\s*:/gi, "Mistake:");
    return c.trim();
  };

  for (let i = 1; i < parts.length; i += 2) {
    const header = String(parts[i] || "").toUpperCase().trim();
    const body = cleanSectionContent(parts[i + 1]);
    if (header === "DEFINITION") sections.definition = body;
    else if (header === "CAMBRIDGE ANSWER") sections.cambridge = body;
    else if (header === "EXAMINER TIP") sections.examinerTip = body;
    else if (header === "COMMON MISTAKES") sections.commonMistakes = body;
  }
  if (
    !sections.definition &&
    !sections.cambridge &&
    !sections.examinerTip &&
    !sections.commonMistakes
  ) {
    sections.cambridge = cleanSectionContent(cleaned);
  }
  return sections;
}

// ────────────────────────────────────────────────────────────────
// SHARED LABEL STYLE — uppercase section headings in answer cards
// ────────────────────────────────────────────────────────────────
const sectionLabelStyle = {
  fontFamily: "Inter, sans-serif",
  fontSize: "10px",
  fontWeight: 500,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--date-color)",
  marginBottom: "8px",
};

// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: AnswerSectionsDisplay
// ----------------------------------------------------------------
// Renders the four mockup answer blocks (definition, Cambridge body,
// examiner tip, common mistakes). Used on the Ask tab and in History.
// ────────────────────────────────────────────────────────────────
function AnswerSectionsDisplay({ text }) {
  const sections = parseAnswerSections(text);
  if (!text?.trim()) return null;

  const mistakeBlocks = sections.commonMistakes
    ? sections.commonMistakes
        .split(/(?=Mistake:)/i)
        .map((b) => b.trim())
        .filter(Boolean)
    : [];

  return (
    <motion.div
      style={{
        opacity: 1,
        transition: "opacity 300ms ease",
      }}
    >
      {sections.definition && (
        <div style={{ marginBottom: "20px" }}>
          <p style={sectionLabelStyle}>DEFINITION</p>
          <motion.div
            style={{
              background: "var(--nav-icon-bg)",
              border: "0.5px solid var(--nav-icon-border)",
              borderLeft: "2px solid var(--gold)",
              borderRadius: "6px",
              padding: "14px 16px",
              fontFamily: "Inter, sans-serif",
              fontSize: "13px",
              color: "var(--text)",
              lineHeight: 1.7,
            }}
          >
            {sections.definition}
          </motion.div>
        </div>
      )}

      {sections.cambridge && (
        <motion.div style={{ marginBottom: "20px" }}>
          <p style={sectionLabelStyle}>CAMBRIDGE ANSWER</p>
          {sections.cambridge.split(/\n\s*\n/).map((para, idx) => (
            <p
              key={idx}
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                color: "var(--text)",
                lineHeight: 1.8,
                margin: idx > 0 ? "12px 0 0" : 0,
              }}
            >
              {para.trim()}
            </p>
          ))}
        </motion.div>
      )}

      {sections.examinerTip && (
        <motion.div style={{ marginBottom: "20px" }}>
          <p style={sectionLabelStyle}>EXAMINER TIP</p>
          <motion.div
            style={{
              background: "var(--nav-icon-bg)",
              border: "0.5px solid var(--nav-icon-border)",
              borderRadius: "6px",
              padding: "14px 16px",
            }}
          >
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--gold)",
                margin: 0,
              }}
            >
              Examiner Tip:
            </p>
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                color: "var(--text-dim)",
                lineHeight: 1.7,
                margin: "6px 0 0",
              }}
            >
              {sections.examinerTip.replace(/^Examiner Tip:\s*/i, "")}
            </p>
          </motion.div>
        </motion.div>
      )}

      {mistakeBlocks.length > 0 && (
        <motion.div>
          <p style={sectionLabelStyle}>COMMON MISTAKES</p>
          {mistakeBlocks.map((block, idx) => {
            const body = block.replace(/^Mistake:\s*/i, "");
            const colonIdx = body.indexOf(":");
            const hasInlineSplit =
              block.toLowerCase().startsWith("mistake:") && colonIdx > -1;
            const mistakeText = hasInlineSplit
              ? body.slice(0, colonIdx).trim() || body
              : body.split("\n")[0]?.trim() || body;
            const explanation = hasInlineSplit
              ? body.slice(colonIdx + 1).trim()
              : body.includes("\n")
                ? body.split("\n").slice(1).join("\n").trim()
                : "";

            return (
              <motion.div key={idx} style={{ marginBottom: "10px" }}>
                <p
                  style={{
                    fontFamily: "Inter, sans-serif",
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "var(--text)",
                    margin: 0,
                  }}
                >
                  Mistake:{" "}
                  <span style={{ fontWeight: 400 }}>{mistakeText}</span>
                </p>
                {explanation && (
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "13px",
                      color: "var(--text-muted)",
                      margin: "4px 0 0",
                      lineHeight: 1.6,
                    }}
                  >
                    {explanation}
                  </p>
                )}
                {idx < mistakeBlocks.length - 1 && (
                  <div
                    aria-hidden="true"
                    style={{
                      marginTop: "10px",
                      borderBottom: "0.5px solid var(--border)",
                    }}
                  />
                )}
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </motion.div>
  );
}


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


// Essay checker — marks pill options (must match backend ALLOWED_ESSAY_MARKS).
const ESSAY_MARKS_OPTIONS = [8, 10, 12];

// Prefix the model may repeat in MODEL_PARAGRAPH — shown as a muted lead-in.
const ESSAY_MODEL_PREFIX =
  "Here is how this paragraph could be written for full marks:";

// ────────────────────────────────────────────────────────────────
// ESSAY CHECKER — inline SVG icons (14–16px, stroke currentColor)
// ────────────────────────────────────────────────────────────────
function IconCheckSquare({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function IconAlertCircle({ size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconCheckmark({ size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * Split the API `grade_band` string into a short title ("Band 3")
 * and a mark-range subtitle for the results header.
 */
function parseEssayGradeBandDisplay(gradeBand, totalMarks) {
  const raw = (gradeBand || "").trim();
  const bandMatch = raw.match(/Band\s*(\d+)/i);
  const shortBand = bandMatch ? `Band ${bandMatch[1]}` : raw.split("—")[0]?.trim() || "—";

  let markRange = raw;
  const dashParts = raw.split("—").map((s) => s.trim()).filter(Boolean);
  if (dashParts.length > 1) {
    markRange = dashParts.slice(1).join(" — ");
    if (!/mark/i.test(markRange)) {
      markRange = `${markRange} marks out of ${totalMarks}`;
    }
  } else if (raw) {
    markRange = `out of ${totalMarks} marks`;
  } else {
    markRange = `out of ${totalMarks} marks`;
  }

  return { shortBand, markRange };
}

/**
 * Strip the model-paragraph lead-in so the green card can show
 * the intro line separately from the rewritten paragraph body.
 */
function splitEssayModelParagraph(text) {
  const body = (text || "").trim();
  if (body.toLowerCase().startsWith(ESSAY_MODEL_PREFIX.toLowerCase())) {
    return {
      intro: ESSAY_MODEL_PREFIX,
      body: body.slice(ESSAY_MODEL_PREFIX.length).trim(),
    };
  }
  return { intro: ESSAY_MODEL_PREFIX, body };
}

/**
 * Map a stored subject label ("Economics 9708") to a subject key
 * for SubjectBadge and left-border accent colours.
 */
function subjectKeyFromEssayLabel(label) {
  const lower = (label || "").toLowerCase();
  for (const sub of SUBJECTS) {
    if (lower.includes(sub.code) || lower.includes(sub.key)) return sub.key;
    if (lower.includes(sub.fullName.toLowerCase())) return sub.key;
    if (lower.includes(sub.name.toLowerCase())) return sub.key;
  }
  return "economics";
}

/**
 * Compact grade chip for history cards, e.g. "Band 3 · 5-6/8".
 */
function formatEssayBandChip(gradeBand, marksAvailable) {
  const raw = (gradeBand || "").trim();
  const bandMatch = raw.match(/Band\s*(\d+)/i);
  const bandShort = bandMatch ? `Band ${bandMatch[1]}` : raw.split("—")[0]?.trim() || "—";
  const dashParts = raw.split("—").map((s) => s.trim()).filter(Boolean);
  let rangePart = "";
  if (dashParts.length > 1) {
    rangePart = dashParts[1]
      .replace(/\s*out of\s*/i, "/")
      .replace(/\s*marks?\s*/gi, "")
      .trim();
    if (!rangePart.includes("/")) {
      rangePart = `${rangePart}/${marksAvailable}`;
    }
  } else {
    rangePart = `?/${marksAvailable}`;
  }
  return `${bandShort} · ${rangePart}`;
}

// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: EssaySubTabButton
// ----------------------------------------------------------------
// Smaller sub-tabs inside the Essay Checker ("Check Answer" /
// "My History"). Gold underline when active — mirrors main tabs.
// ────────────────────────────────────────────────────────────────
function EssaySubTabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontFamily: "Inter, sans-serif",
        fontSize: "12px",
        fontWeight: 500,
        color: active ? "var(--gold)" : "var(--text-muted)",
        borderBottom: active ? "1.5px solid var(--gold)" : "1.5px solid transparent",
        paddingBottom: "6px",
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

// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: EssayHistoryExpandedBody
// ----------------------------------------------------------------
// The five feedback sections shown when a history card expands.
// Same layout as the live Essay Checker results panel.
// ────────────────────────────────────────────────────────────────
function EssayHistoryExpandedBody({ entry }) {
  const marks = entry.marks_available ?? 8;
  const modelParts = splitEssayModelParagraph(entry.model_paragraph || "");
  const fullModelParagraphs = entry.model_answer
    ? entry.model_answer
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  return (
    <motion.div style={{ marginTop: "16px", paddingTop: "16px", borderTop: "0.5px solid var(--border-light)" }}>
      <span style={sectionLabelStyle}>WHAT YOU DID WELL</span>
      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 16px" }}>
        {(entry.what_did_well || []).map((point, idx) => (
          <li
            key={`hist-well-${idx}`}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
              marginBottom: "8px",
            }}
          >
            <span style={{ color: "var(--biz-text)", flexShrink: 0, marginTop: "2px" }}>
              <IconCheckmark size={14} />
            </span>
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                color: "var(--text)",
                lineHeight: 1.5,
              }}
            >
              {point}
            </span>
          </li>
        ))}
      </ul>

      <span style={sectionLabelStyle}>WHAT IS MISSING</span>
      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 16px" }}>
        {(entry.what_is_missing || []).map((point, idx) => (
          <li
            key={`hist-miss-${idx}`}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
              marginBottom: "8px",
            }}
          >
            <span style={{ color: "var(--exam-urgent)", flexShrink: 0, marginTop: "2px" }}>
              <IconAlertCircle size={14} />
            </span>
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                color: "var(--text)",
                lineHeight: 1.5,
              }}
            >
              {point}
            </span>
          </li>
        ))}
      </ul>

      <span style={sectionLabelStyle}>EXAMINER FEEDBACK</span>
      <div
        style={{
          background: "var(--accordion-gap-bg)",
          borderLeft: "2px solid var(--gold)",
          borderTop: "0.5px solid var(--gold-border-hover)",
          borderRight: "0.5px solid var(--gold-border-hover)",
          borderBottom: "0.5px solid var(--gold-border-hover)",
          borderRadius: "6px",
          padding: "14px 16px",
          marginBottom: "16px",
        }}
      >
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            color: "var(--text-dim)",
            lineHeight: 1.8,
            fontStyle: "italic",
            margin: 0,
          }}
        >
          {entry.examiner_feedback}
        </p>
      </div>

      {entry.model_paragraph && (
        <>
          <span style={sectionLabelStyle}>MODEL PARAGRAPH</span>
          <motion.div
            style={{
              background: "color-mix(in srgb, var(--biz-text) 5%, transparent)",
              border: "0.5px solid color-mix(in srgb, var(--biz-text) 20%, transparent)",
              borderLeft: "2px solid var(--biz-text)",
              borderRadius: "6px",
              padding: "14px 16px",
              marginBottom: entry.model_answer ? "16px" : 0,
            }}
          >
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "11px",
                color: "var(--text-muted)",
                marginBottom: "8px",
                marginTop: 0,
              }}
            >
              {modelParts.intro}
            </p>
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                color: "var(--text)",
                lineHeight: 1.8,
                margin: 0,
              }}
            >
              {modelParts.body}
            </p>
          </motion.div>
        </>
      )}

      {entry.model_answer && (
        <>
          <span style={sectionLabelStyle}>FULL MODEL ANSWER</span>
          <motion.div
            style={{
              background: "var(--accordion-gap-bg)",
              border: "0.5px solid var(--gold-border)",
              borderLeft: "3px solid var(--gold)",
              borderRadius: "8px",
              padding: "16px",
            }}
          >
            {fullModelParagraphs.map((para, idx) => (
              <p
                key={`hist-model-${idx}`}
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "14px",
                  color: "var(--text)",
                  lineHeight: 1.9,
                  marginBottom: idx < fullModelParagraphs.length - 1 ? "14px" : 0,
                  marginTop: 0,
                }}
              >
                {para}
              </p>
            ))}
          </motion.div>
        </>
      )}
    </motion.div>
  );
}

// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: EssayHistoryCard
// ----------------------------------------------------------------
// One row in the Essay Checker history list. Click to expand
// and show the saved feedback sections (one open at a time).
// ────────────────────────────────────────────────────────────────
function EssayHistoryCard({ entry, expanded, onToggle }) {
  const subjectKey = subjectKeyFromEssayLabel(entry.subject);
  const leftAccent = HISTORY_LEFT_BORDER_VAR[subjectKey] || "var(--border)";
  const subjectMeta = getSubjectByKey(subjectKey);
  const bandChip = formatEssayBandChip(entry.grade_band, entry.marks_available);

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onToggle(entry.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(entry.id);
        }
      }}
      style={{
        background: "var(--card)",
        border: "0.5px solid var(--gold-border)",
        borderRadius: "10px",
        padding: "18px 20px",
        marginBottom: "8px",
        borderLeft: `3px solid ${leftAccent}`,
        cursor: "pointer",
        transition: "background 200ms",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--card-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--card)";
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", flex: 1, minWidth: 0 }}>
          <SubjectBadge
            subject={subjectKey}
            label={subjectMeta?.fullName ?? entry.subject}
          />
          <span
            style={{
              background: "var(--gold-dim)",
              border: "0.5px solid var(--gold-border-hover)",
              borderRadius: "3px",
              padding: "2px 8px",
              fontFamily: "Inter, sans-serif",
              fontSize: "10px",
              color: "var(--gold)",
              marginLeft: "8px",
            }}
          >
            {bandChip}
          </span>
        </div>
        <motion.div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <span
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "11px",
              color: "var(--text-muted)",
            }}
          >
            {formatHistoryDate(entry.created_at)}
          </span>
          <ChevronDown
            size={16}
            strokeWidth={2}
            aria-hidden
            style={{
              color: "var(--text-muted)",
              transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 200ms ease",
            }}
          />
        </motion.div>
      </div>

      <p
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: "13px",
          fontWeight: 500,
          color: "var(--text)",
          marginTop: "8px",
          marginBottom: 0,
          lineHeight: 1.4,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {entry.question}
      </p>

      {expanded && <EssayHistoryExpandedBody entry={entry} />}
    </article>
  );
}

// ────────────────────────────────────────────────────────────────
// SUB-COMPONENT: HwTabButton
// ----------------------------------------------------------------
// Tab buttons for Ask / History / Essay Checker. Sits directly under the PageHeader on a row
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontFamily: "Inter, sans-serif",
        fontSize: "14px",
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "6px 12px",
        borderRadius: "4px",
        fontFamily: "Inter, sans-serif",
        fontSize: "13px",
        fontWeight: 500,
        whiteSpace: "nowrap",
        cursor: "pointer",
        transition: "background 200ms ease, color 200ms ease",
        background: active ? "var(--gold)" : "var(--card)",
        color: active ? "var(--bg)" : "var(--text-muted)",
        border: active
          ? "0.5px solid transparent"
          : "0.5px solid var(--gold-border)",
      }}
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
    <motion.div
      aria-hidden="true"
      style={{
        background: "var(--card)",
        border: "0.5px solid var(--gold-border)",
        borderLeft: "3px solid var(--border)",
        borderRadius: "8px",
        padding: "16px 20px",
        marginBottom: "8px",
      }}
    >
      <motion.div
        animate={{ opacity: [0.4, 0.7, 0.4] }}
        transition={{ duration: 1.4, repeat: Infinity }}
        style={{ display: "flex", flexDirection: "column", gap: "12px" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <motion.div
            style={{
              height: 16,
              width: 80,
              background: "var(--card-hover)",
              borderRadius: "4px",
            }}
          />
          <div
            style={{
              height: 12,
              width: 120,
              background: "var(--card-hover)",
              borderRadius: "4px",
            }}
          />
        </div>
        <div
          style={{
            height: 16,
            width: "90%",
            background: "var(--card-hover)",
            borderRadius: "4px",
          }}
        />
        <motion.div
          style={{
            height: 12,
            width: 96,
            alignSelf: "flex-end",
            background: "var(--card-hover)",
            borderRadius: "4px",
          }}
        />
      </motion.div>
    </motion.div>
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
function HistoryCard({ entry, expanded, onToggle, onFollowUp }) {
  // Subject-coloured 3 px left edge via CSS variable
  const leftAccent =
    HISTORY_LEFT_BORDER_VAR[entry.subject] || "var(--border)";

  const subjectMeta = getSubjectByKey(entry.subject);
  const subjectName = subjectMeta?.name ?? entry.subject;

  const followUpLabel = "Follow-up on: " + truncate(entry.question, 60);

  const topicChipStyle = {
    background: "var(--gold-dim)",
    border: "0.5px solid var(--gold-border)",
    borderRadius: "3px",
    padding: "2px 10px",
    fontFamily: "Inter, sans-serif",
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--gold)",
    display: "inline-block",
  };

  return (
    <article
      style={{
        background: "var(--card)",
        border: "0.5px solid var(--gold-border)",
        borderRadius: "8px",
        padding: "16px 20px",
        marginBottom: "8px",
        borderLeft: `3px solid ${leftAccent}`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "8px",
        }}
      >
        <SubjectBadge subject={entry.subject} label={subjectName} />
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "11px",
            color: "var(--text-muted)",
          }}
        >
          {formatHistoryDate(entry.created_at)}
        </span>
      </div>

      {entry.topic_tag && (
        <div style={{ marginBottom: "8px" }}>
          <span style={topicChipStyle}>{entry.topic_tag}</span>
        </div>
      )}

      <p
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: "14px",
          fontWeight: 500,
          color: "var(--text)",
          lineHeight: 1.4,
          margin: 0,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {entry.question}
      </p>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
        <button
          type="button"
          onClick={() => onToggle(entry.id)}
          aria-expanded={expanded}
          aria-controls={`history-body-${entry.id}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            fontFamily: "Inter, sans-serif",
            fontSize: "12px",
            color: "var(--gold)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          {expanded ? "Hide answer" : "View answer"}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
            style={{
              transform: expanded ? "rotate(180deg)" : "none",
              transition: "transform 200ms ease",
            }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {/* ── EXPANDED BODY ────────────────────────────────────
            Wrapped in an overflow-hidden div whose max-height
            animates between 0 and 2000 px. See block comment
            above for why we use this technique. */}
      <div
        id={`history-body-${entry.id}`}
        style={{
          overflow: "hidden",
          transition: "max-height 300ms ease-in-out",
          maxHeight: expanded ? "2000px" : 0,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            margin: "12px 0",
            height: "0.5px",
            width: "100%",
            background: "var(--border)",
          }}
        />

        <AnswerSectionsDisplay text={entry.answer} />

        <div style={{ marginTop: "16px" }}>
          <button
            type="button"
            onClick={() => onFollowUp(entry, followUpLabel)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontFamily: "Inter, sans-serif",
              fontSize: "12px",
              fontWeight: 600,
              border: "0.5px solid var(--gold)",
              color: "var(--gold)",
              background: "transparent",
              borderRadius: "6px",
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            Ask follow-up
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
  if (totalPages <= 1) return null;

  const navBtnStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    fontFamily: "Inter, sans-serif",
    fontSize: "13px",
    fontWeight: 500,
    border: "0.5px solid var(--gold)",
    color: "var(--gold)",
    background: "transparent",
    borderRadius: "6px",
    padding: "8px 14px",
    cursor: "pointer",
  };

  return (
    <nav
      aria-label="History pagination"
      style={{
        marginTop: "24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        flexWrap: "wrap",
      }}
    >
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        style={{
          ...navBtnStyle,
          opacity: page <= 1 ? 0.4 : 1,
          cursor: page <= 1 ? "not-allowed" : "pointer",
        }}
      >
        Previous
      </button>
      <span
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: "13px",
          color: "var(--text-muted)",
        }}
      >
        Page {page} of {totalPages}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        style={{
          ...navBtnStyle,
          opacity: page >= totalPages ? 0.4 : 1,
          cursor: page >= totalPages ? "not-allowed" : "pointer",
        }}
      >
        Next
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
  // `activeTab` toggles which view is on screen ("ask", "history",
  //    or "essay"). Defaults to "ask" so existing behaviour is
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

  // ────────────────────────────────────────────────────────────
  // ESSAY CHECKER TAB STATE
  // ────────────────────────────────────────────────────────────
  // `essaySubject` — display label sent to the API (e.g. "Economics 9708").
  // `essayQuestion` — pasted Cambridge exam question text.
  // `essayAnswer` — student's long answer to be marked.
  // `essayMarks` — total marks available (8, 10, or 12); drives pill UI.
  // `essayResult` — parsed JSON from POST /homework/check-essay when set.
  // `essayLoading` — true while the examiner API call is in flight.
  // `essayError` — user-facing message when the check-essay call fails.
  // `modelAnswer` — full Band 4 answer from POST /homework/model-answer.
  // `modelAnswerLoading` — true while the model-answer API call runs.
  // `modelAnswerCopied` — brief "Copied!" state for the copy button.
  // ────────────────────────────────────────────────────────────
  const [essaySubject, setEssaySubject] = useState(
    `${SUBJECTS[0].fullName} ${SUBJECTS[0].code}`
  );
  const [essayQuestion, setEssayQuestion] = useState("");
  const [essayAnswer, setEssayAnswer] = useState("");
  const [essayMarks, setEssayMarks] = useState(8);
  const [essayResult, setEssayResult] = useState(null);
  const [essayLoading, setEssayLoading] = useState(false);
  const [essayError, setEssayError] = useState(null);
  const [modelAnswer, setModelAnswer] = useState(null);
  const [modelAnswerLoading, setModelAnswerLoading] = useState(false);
  const [modelAnswerCopied, setModelAnswerCopied] = useState(false);
  // `essayView` — sub-tab inside Essay Checker: "check" (form) or "history".
  const [essayView, setEssayView] = useState("check");
  // `essayHistory` — rows from GET /homework/essay-history.
  const [essayHistory, setEssayHistory] = useState([]);
  // `essayHistoryLoading` — true while essay history is being fetched.
  const [essayHistoryLoading, setEssayHistoryLoading] = useState(false);
  // `expandedEssayHistoryId` — only one history card expanded at a time.
  const [expandedEssayHistoryId, setExpandedEssayHistoryId] = useState(null);

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
  // Supabase session — used by essay history fetch (access_token for Bearer auth).
  const [session, setSession] = useState(null);
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
        const { data: sessionData } = await supabase.auth.getSession();
        if (!cancelled) {
          setSession(sessionData?.session ?? null);
        }
      } catch (err) {
        // Network failure or library throw – degrade gracefully.
        if (!cancelled) {
          console.warn("[Homework] Could not resolve current user:", err);
          setCurrentUserId(null);
          setSession(null);
        }
      }
    })();

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        // Keep our cached userId in sync with any session change
        // (sign-in, sign-out, token refresh, sign-in in another tab).
        setCurrentUserId(nextSession?.user?.id ?? null);
        setSession(nextSession ?? null);
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
  // checkEssay — POST /homework/check-essay for Cambridge marking.
  // ────────────────────────────────────────────────────────────
  const checkEssay = async () => {
    if (!essayQuestion.trim() || !essayAnswer.trim()) return;

    setEssayLoading(true);
    setEssayError(null);
    setEssayResult(null);
    setModelAnswer(null);
    setModelAnswerCopied(false);

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token ?? null;

      if (!token) {
        throw new Error(
          "Your session has expired. Please sign in again to check your answer."
        );
      }

      const response = await fetch(`${API_URL}/homework/check-essay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          subject: essaySubject,
          question: essayQuestion.trim(),
          answer: essayAnswer.trim(),
          marks: essayMarks,
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
      setEssayResult(data);
    } catch (err) {
      setEssayError(
        err.message ||
          "Could not reach the AscendAI backend. Is the FastAPI server running on port 8001?"
      );
    } finally {
      setEssayLoading(false);
    }
  };

  // Parsed grade header lines for the results panel (when essayResult is set).
  const essayGradeDisplay = essayResult
    ? parseEssayGradeBandDisplay(essayResult.grade_band, essayMarks)
    : null;
  const essayModelParts = essayResult
    ? splitEssayModelParagraph(essayResult.model_paragraph)
    : null;

  // Split full model answer on blank lines for paragraph rendering.
  const modelAnswerParagraphs = modelAnswer
    ? modelAnswer
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  // ────────────────────────────────────────────────────────────
  // fetchEssayHistory — GET /homework/essay-history for My History.
  // ────────────────────────────────────────────────────────────
  const fetchEssayHistory = async () => {
    console.log("[Essay History] starting fetch...");
    if (!session) {
      console.log("[Essay History] no session — aborting");
      return;
    }
    setEssayHistoryLoading(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/homework/essay-history`,
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      );
      console.log("[Essay History] status:", res.status);
      const data = await res.json();
      console.log("[Essay History] data:", data);
      const history = data.history || [];
      console.log("[Essay History] count:", history.length);
      setEssayHistory(history);
    } catch (err) {
      console.error("[Essay History] error:", err);
    } finally {
      setEssayHistoryLoading(false);
    }
  };

  // Load essay history when the user opens the My History sub-tab.
  useEffect(() => {
    if (essayView === "history" && session) {
      fetchEssayHistory();
    }
  }, [essayView, session]);

  // Expand/collapse — only one essay history card open at a time.
  const toggleEssayHistoryCard = (id) => {
    setExpandedEssayHistoryId((prev) => (prev === id ? null : id));
  };

  // ────────────────────────────────────────────────────────────
  // generateModelAnswer — POST /homework/model-answer after essay check.
  // ────────────────────────────────────────────────────────────
  const generateModelAnswer = async () => {
    if (!essayResult || modelAnswerLoading) return;

    setModelAnswerLoading(true);
    setModelAnswer(null);
    setModelAnswerCopied(false);

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token ?? null;

      if (!token) {
        throw new Error(
          "Your session has expired. Please sign in again to generate a model answer."
        );
      }

      const response = await fetch(`${API_URL}/homework/model-answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          subject: essaySubject,
          question: essayQuestion.trim(),
          marks: essayMarks,
          original_answer: essayAnswer.trim(),
          what_did_well: essayResult.what_did_well || [],
          what_is_missing: essayResult.what_is_missing || [],
          examiner_feedback: essayResult.examiner_feedback || "",
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
      setModelAnswer(data.model_answer ?? "");
      // Refresh history list if user has My History open (model_answer saved server-side).
      if (essayView === "history") {
        fetchEssayHistory();
      }
    } catch (err) {
      setEssayError(
        err.message ||
          "Could not generate a model answer. Is the backend running on port 8001?"
      );
    } finally {
      setModelAnswerLoading(false);
    }
  };

  // Copy the full model answer to the clipboard; flash "Copied!" for 2s.
  const copyModelAnswer = async () => {
    if (!modelAnswer) return;
    try {
      await navigator.clipboard.writeText(modelAnswer);
      setModelAnswerCopied(true);
      setTimeout(() => setModelAnswerCopied(false), 2000);
    } catch {
      setEssayError("Could not copy to clipboard. Please select and copy manually.");
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

  // Topic tag for the current answer — read from optimistic history row
  const displayedTopicTag =
    allQuestions.find((q) => q.id === currentQuestionId)?.topic_tag ?? null;

  // Shared form label style (SUBJECT / YOUR QUESTION)
  const formLabelStyle = {
    fontFamily: "Inter, sans-serif",
    fontSize: "10px",
    fontWeight: 500,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--date-color)",
    marginBottom: "6px",
    display: "block",
  };

  // Card shell used for form and answer panels
  const panelCardStyle = {
    background: "var(--card)",
    border: "0.5px solid var(--gold-border)",
    borderRadius: "10px",
    padding: "24px",
  };

  // Input / select / textarea field base
  const fieldStyle = {
    width: "100%",
    background: "var(--card-hover)",
    border: "0.5px solid var(--gold-border-hover)",
    borderRadius: "8px",
    fontFamily: "Inter, sans-serif",
    fontSize: "13px",
    color: "var(--text)",
    outline: "none",
  };

  // Topic chip in answer header
  const topicChipStyle = {
    background: "var(--gold-dim)",
    border: "0.5px solid var(--gold-border)",
    borderRadius: "3px",
    padding: "2px 10px",
    fontFamily: "Inter, sans-serif",
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--gold)",
    flexShrink: 0,
    marginLeft: "auto",
  };

  // Small loading spinner for buttons
  const BtnSpinner = ({ color = "var(--bg)" }) => (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 16,
        height: 16,
        border: `2px solid ${color}`,
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "hw-spin 0.7s linear infinite",
      }}
    />
  );

  return (
    <motion.main
      className="homework-page"
      style={{ minHeight: "100vh", background: "var(--bg)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
    >
      <style jsx global>{`
        @keyframes hw-spin {
          to {
            transform: rotate(360deg);
          }
        }
        .homework-two-col {
          margin: 20px var(--page-padding);
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          align-items: start;
        }
        @media (max-width: 1023px) {
          .homework-two-col {
            grid-template-columns: 1fr;
          }
        }
        .homework-field::placeholder {
          color: var(--text-muted);
        }
        .homework-field:focus {
          border-color: var(--gold) !important;
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
          Homework Assistant
        </span>
      </div>

      {/* PAGE HEADER */}
      <header style={{ padding: "32px var(--page-padding) 0" }}>
        <motion.h1
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: "28px",
            color: "var(--text)",
            fontWeight: 700,
            margin: 0,
          }}
        >
          Homework Assistant
        </motion.h1>
        <motion.p
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            color: "var(--text-muted)",
            marginTop: "4px",
            marginBottom: 0,
          }}
        >
          Cambridge AS Level — Model answers with structural breakdown
        </motion.p>
      </header>

      {/* TABS */}
      <nav
        aria-label="Homework tabs"
        style={{
          margin: "20px var(--page-padding) 0",
          borderBottom: "1px solid var(--border-light)",
          display: "flex",
          gap: "24px",
        }}
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
        <HwTabButton
          active={activeTab === "essay"}
          onClick={() => setActiveTab("essay")}
        >
          Essay Checker
        </HwTabButton>
      </nav>

      {/* ASK TAB */}
      {activeTab === "ask" && (
        <motion.div
          className="homework-two-col"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          {/* LEFT — question form */}
          <div>
            <motion.div style={panelCardStyle}>
              <label htmlFor="hw-subject" style={formLabelStyle}>
                SUBJECT
              </label>
              <select
                id="hw-subject"
                className="homework-field"
                value={selectedSubject}
                onChange={(e) => setSelectedSubject(e.target.value)}
                style={{
                  ...fieldStyle,
                  padding: "10px 14px",
                  cursor: "pointer",
                  marginBottom: "16px",
                  appearance: "none",
                }}
              >
                {SUBJECTS.map((sub) => (
                  <option key={sub.key} value={sub.key}>
                    {sub.fullName} {sub.code}
                  </option>
                ))}
              </select>

              <label htmlFor="hw-question" style={formLabelStyle}>
                YOUR QUESTION
              </label>
              <textarea
                id="hw-question"
                className="homework-field"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g., Explain the concept of price elasticity of demand and its determinants."
                style={{
                  ...fieldStyle,
                  minHeight: "120px",
                  padding: "12px 14px",
                  resize: "vertical",
                  lineHeight: 1.6,
                  marginBottom: "16px",
                }}
              />

              <button
                type="button"
                onClick={() => generateAnswer()}
                disabled={isLoading}
                style={{
                  width: "100%",
                  height: "44px",
                  background: "var(--gold)",
                  borderRadius: "8px",
                  border: "none",
                  fontFamily: "Inter, sans-serif",
                  fontSize: "14px",
                  fontWeight: 500,
                  color: "var(--bg)",
                  cursor: isLoading ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  opacity: isLoading ? 0.85 : 1,
                }}
              >
                {isLoading ? (
                  <>
                    <BtnSpinner />
                    Generating...
                  </>
                ) : (
                  <>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden
                    >
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    Generate Answer
                  </>
                )}
              </button>

              {error && (
                <div
                  role="alert"
                  style={{
                    marginTop: "12px",
                    background:
                      "color-mix(in srgb, var(--exam-urgent) 8%, transparent)",
                    border:
                      "0.5px solid color-mix(in srgb, var(--exam-urgent) 30%, transparent)",
                    borderRadius: "6px",
                    padding: "12px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: "13px",
                    color: "var(--exam-urgent)",
                  }}
                >
                  {error}
                </div>
              )}

              {answer && !isLoading && (
                <div style={{ marginTop: "20px" }}>
                  <h3
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: "14px",
                      color: "var(--text)",
                      margin: "0 0 12px",
                      fontWeight: 700,
                    }}
                  >
                    Need adjustments?
                  </h3>
                  <motion.div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "8px",
                    }}
                  >
                    {[
                      {
                        type: ADJUST_SIMPLIFY,
                        label: "Simplify",
                        icon: (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                          </svg>
                        ),
                      },
                      {
                        type: ADJUST_MORE_DETAIL,
                        label: "More detail",
                        icon: (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                          </svg>
                        ),
                      },
                      {
                        type: ADJUST_SHORTEN,
                        label: "Shorten",
                        icon: (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                            <circle cx="6" cy="6" r="3" />
                            <circle cx="6" cy="18" r="3" />
                            <line x1="20" y1="4" x2="8.12" y2="15.88" />
                            <line x1="14.47" y1="14.48" x2="20" y2="20" />
                            <line x1="8.12" y1="8.12" x2="12" y2="12" />
                          </svg>
                        ),
                      },
                      {
                        type: ADJUST_ADD_EXAMPLES,
                        label: "Add examples",
                        icon: (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                            <circle cx="12" cy="12" r="10" />
                            <line x1="2" y1="12" x2="22" y2="12" />
                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                          </svg>
                        ),
                      },
                    ].map(({ type, label, icon }) => {
                      const isThisLoading = adjustingType === type;
                      const disabled = adjustingType !== null;
                      return (
                        <button
                          key={type}
                          type="button"
                          disabled={disabled}
                          onClick={() => adjustAnswer(type)}
                          style={{
                            background: "var(--card-hover)",
                            border: "0.5px solid var(--gold-border-hover)",
                            borderRadius: "6px",
                            padding: "8px 12px",
                            fontFamily: "Inter, sans-serif",
                            fontSize: "12px",
                            color: "var(--text-muted)",
                            cursor: disabled ? "not-allowed" : "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            transition: "border-color 200ms, color 200ms",
                            opacity: disabled && !isThisLoading ? 0.6 : 1,
                          }}
                        >
                          {isThisLoading ? (
                            <BtnSpinner color="var(--gold)" />
                          ) : (
                            icon
                          )}
                          {label}
                        </button>
                      );
                    })}
                  </motion.div>

                  {answerHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={undoAdjustment}
                      disabled={adjustingType !== null}
                      style={{
                        marginTop: "12px",
                        fontFamily: "Inter, sans-serif",
                        fontSize: "12px",
                        color: "var(--text-muted)",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      ← Undo
                    </button>
                  )}
                </div>
              )}
            </motion.div>
          </div>

          {/* RIGHT — answer display */}
          <motion.div
            style={{
              ...panelCardStyle,
              minHeight: "400px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {!answer && !isLoading ? (
              <motion.div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
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
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                <p
                  style={{
                    fontFamily: "'Playfair Display', serif",
                    fontSize: "16px",
                    color: "var(--text)",
                    margin: "12px 0 0",
                    fontWeight: 700,
                  }}
                >
                  Ask a Cambridge question
                </p>
                <p
                  style={{
                    fontFamily: "Inter, sans-serif",
                    fontSize: "13px",
                    color: "var(--text-muted)",
                    marginTop: "8px",
                  }}
                >
                  Your model answer will appear here
                </p>
              </motion.div>
            ) : (
              <motion.div
                style={{
                  opacity: answerFading ? 0 : 1,
                  transition: "opacity 300ms ease",
                }}
              >
                {answer && (
                  <motion.div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "12px",
                      marginBottom: "20px",
                    }}
                  >
                    <p
                      style={{
                        fontFamily: "'Playfair Display', serif",
                        fontSize: "15px",
                        color: "var(--text)",
                        fontWeight: 700,
                        margin: 0,
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {question}
                    </p>
                    {displayedTopicTag && (
                      <span style={topicChipStyle}>{displayedTopicTag}</span>
                    )}
                  </motion.div>
                )}

                {isLoading && !answer ? (
                  <motion.div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      color: "var(--text-muted)",
                      fontFamily: "Inter, sans-serif",
                      fontSize: "13px",
                    }}
                  >
                    <BtnSpinner color="var(--gold)" />
                    Generating answer...
                  </motion.div>
                ) : (
                  <AnswerSectionsDisplay text={answer} />
                )}
              </motion.div>
            )}
          </motion.div>
        </motion.div>
      )}

      {/* ESSAY CHECKER TAB */}
      {activeTab === "essay" && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          {/* Essay Checker sub-tabs: Check Answer vs My History */}
          <nav
            aria-label="Essay checker views"
            style={{
              margin: "16px var(--page-padding) 0",
              display: "flex",
              gap: "20px",
              marginBottom: "16px",
            }}
          >
            <EssaySubTabButton
              active={essayView === "check"}
              onClick={() => {
                setEssayView("check");
                setExpandedEssayHistoryId(null);
              }}
            >
              Check Answer
            </EssaySubTabButton>
            <EssaySubTabButton
              active={essayView === "history"}
              onClick={() => {
                setEssayView("history");
                fetchEssayHistory();
              }}
            >
              My History
            </EssaySubTabButton>
          </nav>

          {essayView === "check" && (
        <motion.div
          className="homework-two-col"
        >
          {/* LEFT — essay input form */}
          <motion.div>
            <motion.div style={panelCardStyle}>
              <label htmlFor="essay-subject" style={formLabelStyle}>
                SUBJECT
              </label>
              <select
                id="essay-subject"
                className="homework-field"
                value={essaySubject}
                onChange={(e) => setEssaySubject(e.target.value)}
                style={{
                  ...fieldStyle,
                  padding: "10px 14px",
                  cursor: "pointer",
                  marginBottom: "16px",
                  appearance: "none",
                }}
              >
                {SUBJECTS.map((sub) => (
                  <option
                    key={sub.key}
                    value={`${sub.fullName} ${sub.code}`}
                  >
                    {sub.fullName} {sub.code}
                  </option>
                ))}
              </select>

              <span style={formLabelStyle}>MARKS AVAILABLE</span>
              <motion.div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "8px",
                  marginBottom: "16px",
                }}
              >
                {ESSAY_MARKS_OPTIONS.map((m) => {
                  const isActive = essayMarks === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setEssayMarks(m)}
                      style={{
                        padding: "8px 20px",
                        borderRadius: "6px",
                        fontFamily: "Inter, sans-serif",
                        fontSize: "13px",
                        fontWeight: 500,
                        cursor: "pointer",
                        transition: "all 150ms",
                        background: isActive ? "var(--gold)" : "transparent",
                        color: isActive ? "var(--bg)" : "var(--text-muted)",
                        border: isActive
                          ? "none"
                          : "0.5px solid var(--gold-border-hover)",
                      }}
                    >
                      {m} marks
                    </button>
                  );
                })}
              </motion.div>

              <label htmlFor="essay-question" style={formLabelStyle}>
                THE QUESTION
              </label>
              <textarea
                id="essay-question"
                className="homework-field"
                value={essayQuestion}
                onChange={(e) => setEssayQuestion(e.target.value)}
                placeholder="Paste the Cambridge exam question here..."
                style={{
                  ...fieldStyle,
                  minHeight: "80px",
                  padding: "12px 14px",
                  resize: "vertical",
                  lineHeight: 1.6,
                  marginBottom: "16px",
                }}
              />

              <label htmlFor="essay-answer" style={formLabelStyle}>
                YOUR ANSWER
              </label>
              <textarea
                id="essay-answer"
                className="homework-field"
                value={essayAnswer}
                onChange={(e) => setEssayAnswer(e.target.value)}
                placeholder={
                  "Type or paste your answer here...\nWrite as much as you would in the exam."
                }
                style={{
                  ...fieldStyle,
                  minHeight: "200px",
                  padding: "12px 14px",
                  resize: "vertical",
                  lineHeight: 1.6,
                  marginBottom: "16px",
                }}
              />

              <button
                type="button"
                onClick={() => checkEssay()}
                disabled={
                  essayLoading ||
                  !essayQuestion.trim() ||
                  !essayAnswer.trim()
                }
                style={{
                  width: "100%",
                  height: "44px",
                  background: "var(--gold)",
                  borderRadius: "8px",
                  border: "none",
                  fontFamily: "Inter, sans-serif",
                  fontSize: "14px",
                  fontWeight: 500,
                  color: "var(--bg)",
                  cursor:
                    essayLoading ||
                    !essayQuestion.trim() ||
                    !essayAnswer.trim()
                      ? "not-allowed"
                      : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  opacity: essayLoading ? 0.85 : 1,
                }}
              >
                {essayLoading ? (
                  <>
                    <BtnSpinner />
                    Checking...
                  </>
                ) : (
                  <>
                    <IconCheckSquare size={16} />
                    Check My Answer
                  </>
                )}
              </button>

              {essayError && (
                <motion.div
                  role="alert"
                  style={{
                    marginTop: "12px",
                    background:
                      "color-mix(in srgb, var(--exam-urgent) 8%, transparent)",
                    border:
                      "0.5px solid color-mix(in srgb, var(--exam-urgent) 30%, transparent)",
                    borderRadius: "6px",
                    padding: "12px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: "13px",
                    color: "var(--exam-urgent)",
                  }}
                >
                  {essayError}
                </motion.div>
              )}
            </motion.div>
          </motion.div>

          {/* RIGHT — examiner results */}
          <motion.div
            style={{
              ...panelCardStyle,
              minHeight: "400px",
            }}
          >
            {!essayResult ? (
              <motion.div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: "352px",
                  textAlign: "center",
                }}
              >
                <span style={{ color: "var(--gold-icon)" }}>
                  <IconCheckSquare size={32} />
                </span>
                <p
                  style={{
                    fontFamily: "'Playfair Display', serif",
                    fontSize: "16px",
                    color: "var(--text)",
                    marginTop: "12px",
                    marginBottom: 0,
                  }}
                >
                  Check your essay
                </p>
                <p
                  style={{
                    fontFamily: "Inter, sans-serif",
                    fontSize: "13px",
                    color: "var(--text-muted)",
                    marginTop: "8px",
                    marginBottom: 0,
                    maxWidth: "280px",
                  }}
                >
                  Paste your answer and get instant Cambridge examiner feedback
                </p>
              </motion.div>
            ) : (
              <motion.div>
                {/* Grade band header */}
                <motion.div
                  style={{
                    background: "var(--accordion-gap-bg)",
                    border: "0.5px solid var(--gold-border)",
                    borderRadius: "10px",
                    padding: "20px",
                    textAlign: "center",
                    marginBottom: "20px",
                  }}
                >
                  <p
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: "32px",
                      color: "var(--gold)",
                      fontWeight: 700,
                      margin: 0,
                    }}
                  >
                    {essayGradeDisplay?.shortBand}
                  </p>
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "16px",
                      color: "var(--text)",
                      marginTop: "4px",
                      marginBottom: 0,
                    }}
                  >
                    {essayGradeDisplay?.markRange}
                  </p>
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "13px",
                      color: "var(--text-muted)",
                      marginTop: "6px",
                      marginBottom: 0,
                    }}
                  >
                    {essayResult.band_label}
                  </p>
                  <span
                    style={{
                      display: "inline-block",
                      marginTop: "12px",
                      background: "var(--gold-dim)",
                      border: "0.5px solid var(--gold-border-hover)",
                      borderRadius: "20px",
                      padding: "4px 16px",
                      fontFamily: "Inter, sans-serif",
                      fontSize: "13px",
                      fontWeight: 500,
                      color: "var(--gold)",
                    }}
                  >
                    Estimated: {essayResult.estimated_marks} / {essayMarks}{" "}
                    marks
                  </span>
                </motion.div>

                {/* What you did well */}
                <span style={formLabelStyle}>WHAT YOU DID WELL</span>
                <motion.ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "0 0 16px",
                  }}
                >
                  {(essayResult.what_did_well || []).map((point, idx) => (
                    <li
                      key={`well-${idx}`}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "10px",
                        marginBottom: "8px",
                      }}
                    >
                      <span
                        style={{
                          color: "var(--biz-text)",
                          flexShrink: 0,
                          marginTop: "2px",
                        }}
                      >
                        <IconCheckmark size={14} />
                      </span>
                      <span
                        style={{
                          fontFamily: "Inter, sans-serif",
                          fontSize: "13px",
                          color: "var(--text)",
                          lineHeight: 1.5,
                        }}
                      >
                        {point}
                      </span>
                    </li>
                  ))}
                </motion.ul>

                {/* What is missing */}
                <span style={formLabelStyle}>WHAT IS MISSING</span>
                <motion.ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "0 0 16px",
                  }}
                >
                  {(essayResult.what_is_missing || []).map((point, idx) => (
                    <li
                      key={`missing-${idx}`}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "10px",
                        marginBottom: "8px",
                      }}
                    >
                      <span
                        style={{
                          color: "var(--exam-urgent)",
                          flexShrink: 0,
                          marginTop: "2px",
                        }}
                      >
                        <IconAlertCircle size={14} />
                      </span>
                      <span
                        style={{
                          fontFamily: "Inter, sans-serif",
                          fontSize: "13px",
                          color: "var(--text)",
                          lineHeight: 1.5,
                        }}
                      >
                        {point}
                      </span>
                    </li>
                  ))}
                </motion.ul>

                {/* Examiner feedback */}
                <span style={formLabelStyle}>EXAMINER FEEDBACK</span>
                <motion.div
                  style={{
                    background: "var(--accordion-gap-bg)",
                    borderLeft: "2px solid var(--gold)",
                    borderTop: "0.5px solid var(--gold-border-hover)",
                    borderRight: "0.5px solid var(--gold-border-hover)",
                    borderBottom: "0.5px solid var(--gold-border-hover)",
                    borderRadius: "6px",
                    padding: "14px 16px",
                    marginBottom: "16px",
                  }}
                >
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "13px",
                      color: "var(--text-dim)",
                      lineHeight: 1.8,
                      fontStyle: "italic",
                      margin: 0,
                    }}
                  >
                    {essayResult.examiner_feedback}
                  </p>
                </motion.div>

                {/* Model paragraph */}
                <span style={formLabelStyle}>MODEL PARAGRAPH</span>
                <motion.div
                  style={{
                    background:
                      "color-mix(in srgb, var(--biz-text) 5%, transparent)",
                    border:
                      "0.5px solid color-mix(in srgb, var(--biz-text) 20%, transparent)",
                    borderLeft: "2px solid var(--biz-text)",
                    borderRadius: "6px",
                    padding: "14px 16px",
                  }}
                >
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      marginBottom: "8px",
                      marginTop: 0,
                    }}
                  >
                    {essayModelParts?.intro}
                  </p>
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "13px",
                      color: "var(--text)",
                      lineHeight: 1.8,
                      margin: 0,
                    }}
                  >
                    {essayModelParts?.body}
                  </p>
                </motion.div>

                {/* Generate full model answer — only after essay check results */}
                <div
                  style={{
                    marginTop: "20px",
                    paddingTop: "16px",
                    borderTop: "0.5px solid var(--border-light)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => generateModelAnswer()}
                    disabled={modelAnswerLoading}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                      background: "transparent",
                      border: "0.5px solid var(--gold-border-active)",
                      borderRadius: "8px",
                      padding: "12px",
                      fontFamily: "Inter, sans-serif",
                      fontSize: "13px",
                      fontWeight: 500,
                      color: "var(--gold)",
                      cursor: modelAnswerLoading ? "not-allowed" : "pointer",
                      transition: "background 200ms, border-color 200ms",
                      opacity: modelAnswerLoading ? 0.85 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (modelAnswerLoading) return;
                      e.currentTarget.style.background = "var(--accordion-gap-bg)";
                      e.currentTarget.style.borderColor = "var(--gold)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.borderColor = "var(--gold-border-active)";
                    }}
                  >
                    {modelAnswerLoading ? (
                      <>
                        <BtnSpinner color="var(--gold)" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden
                        >
                          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                        Generate Full Model Answer
                      </>
                    )}
                  </button>
                </div>

                {/* Full model answer display */}
                {modelAnswer && (
                  <motion.div style={{ marginTop: "20px" }}>
                    <span
                      style={{
                        ...formLabelStyle,
                        marginTop: "20px",
                        marginBottom: "10px",
                      }}
                    >
                      FULL MODEL ANSWER
                    </span>
                    <motion.div
                      style={{
                        position: "relative",
                        background: "var(--accordion-gap-bg)",
                        border: "0.5px solid var(--gold-border)",
                        borderLeft: "3px solid var(--gold)",
                        borderRadius: "8px",
                        padding: "20px",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => copyModelAnswer()}
                        style={{
                          position: "absolute",
                          top: "12px",
                          right: "12px",
                          background: "transparent",
                          border: "0.5px solid var(--gold-border-hover)",
                          borderRadius: "6px",
                          padding: "4px 10px",
                          fontFamily: "Inter, sans-serif",
                          fontSize: "11px",
                          fontWeight: 500,
                          color: "var(--gold)",
                          cursor: "pointer",
                        }}
                      >
                        {modelAnswerCopied ? "Copied!" : "Copy Answer"}
                      </button>
                      {modelAnswerParagraphs.map((para, idx) => (
                        <p
                          key={`model-para-${idx}`}
                          style={{
                            fontFamily: "Inter, sans-serif",
                            fontSize: "14px",
                            color: "var(--text)",
                            lineHeight: 1.9,
                            marginBottom:
                              idx < modelAnswerParagraphs.length - 1
                                ? "14px"
                                : 0,
                            marginTop: idx === 0 ? "28px" : 0,
                          }}
                        >
                          {para}
                        </p>
                      ))}
                    </motion.div>
                  </motion.div>
                )}
              </motion.div>
            )}
          </motion.div>
        </motion.div>
          )}

          {essayView === "history" && (
            <motion.section
              aria-label="Essay check history"
              style={{ margin: "0 var(--page-padding) 20px" }}
            >
              {essayHistoryLoading ? (
                <motion.div>
                  <HistorySkeleton />
                  <HistorySkeleton />
                  <HistorySkeleton />
                </motion.div>
              ) : (
                <motion.div>
                  {console.log(
                    "[Essay History] rendering:",
                    essayHistory.length
                  )}
                  {essayHistory.map((entry) => (
                    <EssayHistoryCard
                      key={entry.id}
                      entry={entry}
                      expanded={expandedEssayHistoryId === entry.id}
                      onToggle={toggleEssayHistoryCard}
                    />
                  ))}
                </motion.div>
              )}
            </motion.section>
          )}
        </motion.div>
      )}

      {/* HISTORY TAB */}
      {activeTab === "history" && (
        <motion.section
          ref={historyTopRef}
          aria-label="Homework history"
          style={{ margin: "20px var(--page-padding)" }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <motion.div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "8px",
              marginBottom: "16px",
            }}
          >
            {HISTORY_FILTER_OPTIONS.map((opt) => (
              <HistoryFilterChip
                key={opt.value}
                active={activeFilter === opt.value}
                onClick={() => setActiveFilter(opt.value)}
              >
                {opt.label}
              </HistoryFilterChip>
            ))}
          </motion.div>

          <p
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "12px",
              color: "var(--text-muted)",
              marginBottom: "12px",
            }}
          >
            Showing {filteredQuestions.length}{" "}
            {filteredQuestions.length === 1 ? "question" : "questions"}
          </p>

          {historyLoading ? (
            <motion.div>
              <HistorySkeleton />
              <HistorySkeleton />
              <HistorySkeleton />
            </motion.div>
          ) : historyError ? (
            <motion.div
              style={{
                ...panelCardStyle,
                textAlign: "center",
                color: "var(--text-muted)",
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
              }}
            >
              {historyError}
            </motion.div>
          ) : filteredQuestions.length === 0 ? (
            <motion.div
              style={{
                ...panelCardStyle,
                textAlign: "center",
                maxWidth: "480px",
                margin: "0 auto",
              }}
            >
              <MessageSquare
                size={48}
                strokeWidth={1.5}
                style={{ color: "var(--gold-icon)", margin: "0 auto 16px" }}
                aria-hidden
              />
              <h2
                style={{
                  fontFamily: "'Playfair Display', serif",
                  fontSize: "22px",
                  color: "var(--text)",
                  margin: "0 0 8px",
                }}
              >
                No questions yet
              </h2>
              <p
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "13px",
                  color: "var(--text-muted)",
                  marginBottom: "16px",
                }}
              >
                {activeFilter === FILTER_ALL
                  ? "Ask your first Cambridge question in the Ask tab."
                  : `No ${getSubjectByKey(activeFilter)?.name ?? "this subject"} questions yet.`}
              </p>
              <button
                type="button"
                onClick={switchToAskTab}
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "13px",
                  fontWeight: 600,
                  border: "0.5px solid var(--gold)",
                  color: "var(--gold)",
                  background: "transparent",
                  borderRadius: "6px",
                  padding: "8px 16px",
                  cursor: "pointer",
                }}
              >
                Ask a question
              </button>
            </motion.div>
          ) : (
            <>
              <motion.div>
                {paginatedQuestions.map((entry) => (
                  <HistoryCard
                    key={entry.id}
                    entry={entry}
                    expanded={expandedId === entry.id}
                    onToggle={toggleExpand}
                    onFollowUp={handleAskFollowUp}
                  />
                ))}
              </motion.div>
              <HistoryPagination
                page={currentPage}
                totalPages={totalPages}
                onPageChange={goToPage}
              />
            </>
          )}

          {historyUsedMock && !historyLoading && (
            <p
              style={{
                marginTop: "24px",
                textAlign: "center",
                fontFamily: "Inter, sans-serif",
                fontSize: "11px",
                color: "var(--text-extra-dim)",
              }}
            >
              Showing sample history while your real Q&amp;A library loads.
            </p>
          )}
        </motion.section>
      )}

      {/* SAVE TOAST */}
      {saveNotice && (
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
              saveNotice.tone === "error"
                ? "0.5px solid color-mix(in srgb, var(--exam-urgent) 30%, transparent)"
                : "0.5px solid var(--gold-border)",
            color:
              saveNotice.tone === "error"
                ? "var(--exam-urgent)"
                : "var(--text)",
            boxShadow: "var(--chat-panel-shadow)",
          }}
        >
          <p style={{ margin: 0, lineHeight: 1.5 }}>{saveNotice.message}</p>
          <button
            type="button"
            onClick={() => setSaveNotice(null)}
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
