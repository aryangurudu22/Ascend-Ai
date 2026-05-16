// ============================================================
// FILE: app/features/flashcards/page.js
// PURPOSE: Adaptive Flashcards — five-view study + quiz flow.
//
// HOW THE PAGE WORKS AT A GLANCE
// ----------------------------------------------------------------
// 1. SUBJECT SELECTION — 4 subject cards with mastery overview.
// 2. TOPIC SELECTION  — every topic for the chosen subject.
// 3. STUDY MODE       — flip through cards for the chosen topic.
// 4. QUIZ MODE        — multiple-choice quiz on the same cards.
// 5. RESULTS SCREEN   — score, mastery deltas, weak topics.
//
// The student moves through these views one at a time. She can
// either "Study first" then quiz, OR "Jump to quiz" straight
// from the topic card. After finishing she returns to the topic
// view to pick another topic.
//
// THIS FILE OBEYS EVERY PROJECT RULE:
//   • Subject names + UUIDs come from Supabase — none are hardcoded.
//   • All colours come from Tailwind tokens in tailwind.config.js.
//   • All icons come from lucide-react (no SVG hardcoding).
//   • The Supabase client is imported from lib/supabaseClient.js.
//   • Mock flashcards are GENERATED at runtime against the real
//     subject UUIDs we just fetched — so still zero hardcoded UUIDs.
//   • Card-flip animation uses pure CSS via Tailwind arbitrary-
//     property classes — no animation library, no inline styles,
//     no modification to globals.css.
//   • Mastery deltas live in React state only — no Supabase write
//     and no localStorage write (per spec). Backend persistence
//     comes in a follow-up task.
// ============================================================

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
  XCircle,
} from "lucide-react";
import { supabase } from "../../../lib/supabaseClient";
import { SUBJECTS } from "../../../lib/subjects";
import PageHeader from "../../components/PageHeader";
import SubjectBadge from "../../components/SubjectBadge";


// ─────────────────────────────────────────────────────────────
// CONSTANTS — every "magic string" lives here so we never
// re-type them. Nothing here is real data — that comes from DB.
// ─────────────────────────────────────────────────────────────

// localStorage flag the onboarding sets to "true" on completion.
// Same key the dashboard + notes pages read — defined once.
const ONBOARDING_KEY = "ascendai_onboarding_completed";

// FastAPI base URL — pulled from .env.local, with a sane default
// so the page still works during local dev if the var is missing.
// Same fallback the homework + notes pages use.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";

// Supabase tables we read from when populating the Generate
// Cards modal. Declared once so a future rename is a single
// edit. (We never write to these directly — every write goes
// through the backend's POST /flashcards/generate.)
const NOTES_TABLE = "notes";
const FLASHCARDS_TABLE = "flashcards";

// How long the bottom-right toast stays on screen before
// fading away — matches the value used on the notes page.
const TOAST_DISMISS_MS = 4000;

// How many cards Aisha sees in a single quiz attempt. The deck
// is sorted by mastery (lowest first) BEFORE being sliced to
// this size, so the cards she's weakest on are always included
// and stronger cards only appear if the topic doesn't have
// enough low-mastery ones to fill a session. This is the
// classic spaced-repetition rule applied at session-prep time.
const QUIZ_SESSION_SIZE = 8;

// Five-view machine — using named constants instead of bare
// numbers makes the render switch readable at a glance.
const VIEW = {
  SUBJECTS: 1,  // Pick a subject
  TOPICS:   2,  // Pick a topic inside that subject
  STUDY:    3,  // Flip through cards
  QUIZ:     4,  // Answer multiple-choice on those same cards
  RESULTS:  5,  // Score + mastery + recommendations
};

// Mastery is clamped between 0 (brand new) and 5 (mastered).
// A correct quiz answer adds +1, a wrong answer subtracts -1.
const MASTERY_MIN = 0;
const MASTERY_MAX = 5;


// ─────────────────────────────────────────────────────────────
// MOCK CONTENT — 8 topics × 5 cards = 40 realistic AS-Level cards.
// ─────────────────────────────────────────────────────────────
// We DO NOT hardcode subject UUIDs here. Each entry references
// a subject by its local `key` (matching lib/subjects.js); the
// real UUID is patched in at runtime once Supabase responds.
//
// Each mock card carries a `mastery_level` between 0 and 5 to
// give the progress bars visible variation during development.
const MOCK_TOPICS = [
  // ── Economics 9708 ────────────────────────────────────────
  {
    subjectKey: "economics",
    noteSlug: "mock-note-eco-elasticity",
    title: "Price Elasticity of Demand",
    cards: [
      {
        front: "What does price elasticity of demand measure?",
        back:
          "The responsiveness of quantity demanded to a change in price, calculated as the percentage change in quantity demanded divided by the percentage change in price.",
        mastery_level: 3,
      },
      {
        front: "Define elastic demand.",
        back:
          "Demand is elastic when the absolute value of price elasticity is greater than one — a small change in price causes a larger percentage change in quantity demanded.",
        mastery_level: 2,
      },
      {
        front:
          "Give one main determinant of price elasticity of demand.",
        back:
          "The availability of close substitutes — goods with many substitutes are more elastic because consumers can switch easily when the price rises.",
        mastery_level: 4,
      },
      {
        front: "Why do necessities tend to be inelastic?",
        back:
          "Consumers must buy them regardless of price, so quantity demanded changes very little when price increases.",
        mastery_level: 2,
      },
      {
        front: "Why is iPhone demand relatively inelastic?",
        back:
          "Strong brand loyalty and limited close substitutes mean Apple can raise prices without losing many customers.",
        mastery_level: 1,
      },
    ],
  },
  {
    subjectKey: "economics",
    noteSlug: "mock-note-eco-market-failure",
    title: "Market Failure",
    cards: [
      {
        front: "Define market failure.",
        back:
          "A situation where the free market fails to allocate resources efficiently from society's perspective, leading to a loss of social welfare.",
        mastery_level: 2,
      },
      {
        front: "Name two main causes of market failure.",
        back:
          "Externalities and the under-provision of public goods are two key causes of market failure.",
        mastery_level: 3,
      },
      {
        front: "What is a negative externality?",
        back:
          "A cost imposed on third parties not involved in the transaction, such as air pollution from a factory affecting nearby residents.",
        mastery_level: 3,
      },
      {
        front:
          "How can government correct a negative externality?",
        back:
          "By imposing an indirect tax equal to the external cost so that the polluter pays the full social cost of production.",
        mastery_level: 1,
      },
      {
        front: "Why do public goods cause market failure?",
        back:
          "Public goods are non-excludable and non-rival, so private firms cannot profitably supply them, leading to under-provision.",
        mastery_level: 2,
      },
    ],
  },

  // ── Business Studies 9609 ─────────────────────────────────
  {
    subjectKey: "business",
    noteSlug: "mock-note-biz-marketing-mix",
    title: "The Marketing Mix",
    cards: [
      {
        front:
          "Name the four elements of the marketing mix.",
        back:
          "Product, Price, Place and Promotion — the four classical elements that together influence buyer response.",
        mastery_level: 4,
      },
      {
        front: "What is penetration pricing?",
        back:
          "Setting a low initial price to build market share quickly, accepting lower short-run profit in exchange for long-run market position.",
        mastery_level: 2,
      },
      {
        front: "What is price skimming?",
        back:
          "Setting a high initial price to extract maximum profit from early adopters before gradually lowering the price to attract more buyers.",
        mastery_level: 2,
      },
      {
        front: "Give one example of a Place decision.",
        back:
          "Choosing whether to sell directly to customers, through wholesalers, or via online channels — each affects reach and cost.",
        mastery_level: 3,
      },
      {
        front:
          "Why must the marketing mix be internally consistent?",
        back:
          "Inconsistent elements confuse customers — a premium product with a low price and discount promotion would damage the brand.",
        mastery_level: 1,
      },
    ],
  },
  {
    subjectKey: "business",
    noteSlug: "mock-note-biz-trade-unions",
    title: "Trade Unions and Wage Determination",
    cards: [
      {
        front: "What is a trade union?",
        back:
          "A worker-led organisation that negotiates pay and working conditions on behalf of its members.",
        mastery_level: 3,
      },
      {
        front: "Define collective bargaining.",
        back:
          "A negotiation process where a trade union represents workers in discussions with employers about wages and conditions.",
        mastery_level: 2,
      },
      {
        front: "How can trade unions raise wages?",
        back:
          "By restricting labour supply, by negotiating collectively to increase wage demands above the equilibrium, or through strike action.",
        mastery_level: 2,
      },
      {
        front:
          "What is a potential cost to firms of strong trade unions?",
        back:
          "Higher wage costs may force firms to raise prices, cut jobs, or relocate production to lower-wage regions.",
        mastery_level: 1,
      },
      {
        front: "Name one limit on union power.",
        back:
          "Legal restrictions on industrial action and the existence of alternative non-unionised labour both constrain union bargaining power.",
        mastery_level: 2,
      },
    ],
  },

  // ── English Language 9093 ─────────────────────────────────
  {
    subjectKey: "english",
    noteSlug: "mock-note-eng-tone",
    title: "Tone and Voice",
    cards: [
      {
        front: "Define tone in textual analysis.",
        back:
          "The writer's attitude towards the subject and audience, conveyed through diction, syntax and imagery.",
        mastery_level: 3,
      },
      {
        front: "Define voice in textual analysis.",
        back:
          "The distinctive personality of a writer, expressed through consistent choices in vocabulary, sentence structure and rhythm.",
        mastery_level: 2,
      },
      {
        front: "What does the CLS framework stand for?",
        back:
          "Context, Language and Structure — a three-part framework for organising analytical responses.",
        mastery_level: 4,
      },
      {
        front: "How does sentence length affect tone?",
        back:
          "Short sentences create urgency or impact, while longer sentences invite reflection and develop nuance.",
        mastery_level: 2,
      },
      {
        front: "Give one technique that signals a formal tone.",
        back:
          "Latinate vocabulary, complex syntax, and the absence of contractions all signal a formal tone.",
        mastery_level: 1,
      },
    ],
  },
  {
    subjectKey: "english",
    noteSlug: "mock-note-eng-devices",
    title: "Literary Devices",
    cards: [
      {
        front: "Define metaphor.",
        back:
          "A direct comparison between two unlike things that share an underlying quality, without using 'like' or 'as'.",
        mastery_level: 4,
      },
      {
        front: "Define anaphora.",
        back:
          "The repetition of the same word or phrase at the start of consecutive clauses or sentences for rhetorical effect.",
        mastery_level: 2,
      },
      {
        front: "What is sibilance?",
        back:
          "The repetition of soft 's' or 'sh' sounds in close succession, often producing a hissing or hushed effect.",
        mastery_level: 1,
      },
      {
        front: "Define enjambment.",
        back:
          "When a line of poetry runs onto the next without a punctuated pause, creating momentum or suspense.",
        mastery_level: 2,
      },
      {
        front: "Define polysyndeton.",
        back:
          "The deliberate use of multiple conjunctions in close succession to slow rhythm and emphasise each item.",
        mastery_level: 1,
      },
    ],
  },

  // ── ICT 9626 ──────────────────────────────────────────────
  {
    subjectKey: "ict",
    noteSlug: "mock-note-ict-normalisation",
    title: "Database Normalisation",
    cards: [
      {
        front: "What is the goal of normalisation?",
        back:
          "To organise database tables so that redundancy is reduced and data integrity is preserved across updates.",
        mastery_level: 3,
      },
      {
        front: "Define first normal form (1NF).",
        back:
          "A table is in 1NF when every cell holds a single atomic value and there are no repeating groups.",
        mastery_level: 3,
      },
      {
        front: "Define second normal form (2NF).",
        back:
          "A table is in 2NF when it is in 1NF and every non-key attribute depends on the whole primary key.",
        mastery_level: 2,
      },
      {
        front: "Define third normal form (3NF).",
        back:
          "A table is in 3NF when it is in 2NF and there are no transitive dependencies between non-key attributes.",
        mastery_level: 2,
      },
      {
        front: "What is the role of a foreign key?",
        back:
          "A foreign key links one table to another by referencing the primary key of the related table, maintaining referential integrity.",
        mastery_level: 4,
      },
    ],
  },
  {
    subjectKey: "ict",
    noteSlug: "mock-note-ict-protocols",
    title: "Network Protocols",
    cards: [
      {
        front: "What does TCP stand for?",
        back:
          "Transmission Control Protocol — a connection-oriented protocol that guarantees reliable, ordered delivery of data packets.",
        mastery_level: 3,
      },
      {
        front: "What is the OSI model?",
        back:
          "A conceptual seven-layer framework that standardises how networked systems communicate, from physical hardware up to application data.",
        mastery_level: 2,
      },
      {
        front: "Define IP address.",
        back:
          "A unique numeric identifier assigned to a device on a network, allowing data to be routed to the correct destination.",
        mastery_level: 3,
      },
      {
        front: "What is the purpose of DNS?",
        back:
          "The Domain Name System translates human-readable domain names like example.com into machine-readable IP addresses.",
        mastery_level: 1,
      },
      {
        front: "Compare HTTP and HTTPS.",
        back:
          "HTTPS adds Transport Layer Security on top of HTTP, encrypting all data exchanged between client and server to prevent eavesdropping.",
        mastery_level: 2,
      },
    ],
  },
];


// ─────────────────────────────────────────────────────────────
// HELPERS — pure utility functions used by the page.
// ─────────────────────────────────────────────────────────────

// shuffle: returns a new array with the same elements in
// **random** order using the Fisher-Yates algorithm. Every
// possible permutation is equally likely, which is exactly
// what we want for quiz randomness.
//
// HOW FISHER-YATES WORKS
// ----------------------
// Starting from the LAST index and walking down to 1, we swap
// the current element with a random earlier element (index 0..i
// inclusive). After one full pass every position has been
// considered, the original order is gone, and the bias-free
// distribution is preserved. A naïve `arr.sort(() => Math.random() - 0.5)`
// does NOT have these properties — it leans heavily on the
// sort implementation and produces noticeably non-uniform
// orderings, so we never use it.
//
// We always copy first (`[...arr]`) so the caller's array is
// never mutated. Used for:
//   • randomising the order of quiz options
//   • picking random distractors from the subject pool
//   • shuffling the per-session quiz deck (see prepareQuizCards)
function shuffle(arr) {
  // Copy so the caller's array is never mutated.
  const copy = [...arr];
  // Fisher-Yates: walk from the last index down to 1, swapping
  // each element with a random earlier one.
  for (let i = copy.length - 1; i > 0; i--) {
    // Pick a random index from 0 to i (inclusive).
    const j = Math.floor(Math.random() * (i + 1));
    // Swap elements at positions i and j.
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// prepareQuizCards: builds the per-attempt quiz deck.
//
// SPACED-REPETITION RULE
// ----------------------
// 1. Sort the input cards by `mastery_level` ASCENDING. The
//    cards Aisha is weakest on float to the top of the list.
// 2. Take only the first `QUIZ_SESSION_SIZE` cards. Mastery 0/1
//    cards are therefore ALWAYS included; mastery 4/5 cards
//    only appear if the topic doesn't have enough low-mastery
//    cards to fill the session. This is the spaced-repetition
//    principle: cards she struggles with appear more often
//    than mastered ones.
// 3. Shuffle the slice with Fisher-Yates so within the chosen
//    set the order is unpredictable — every attempt feels
//    fresh, even when the same eight cards are reused.
//
// Returns a brand-new array (caller's input is never mutated).
function prepareQuizCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return [];

  // Step 1 — sort ascending by mastery so the weakest cards
  // bubble to the front. Stable copy via spread so we don't
  // touch the caller's array.
  const sortedByMastery = [...cards].sort(
    (a, b) =>
      (Number(a.mastery_level) || 0) - (Number(b.mastery_level) || 0)
  );

  // Step 2 — take only what we need for one attempt. If the
  // topic has fewer cards than QUIZ_SESSION_SIZE we just keep
  // them all (slice handles that case naturally).
  const sessionSlice = sortedByMastery.slice(0, QUIZ_SESSION_SIZE);

  // Step 3 — shuffle so the order changes every attempt. Same
  // Fisher-Yates implementation used elsewhere on the page.
  return shuffle(sessionSlice);
}

// avgMastery: returns the average mastery_level across the given
// flashcard list, on the 0-to-5 scale. Returns 0 when the list
// is empty so the progress bar simply shows no fill.
function avgMastery(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return 0;
  const sum = cards.reduce(
    (acc, c) => acc + (Number(c.mastery_level) || 0),
    0
  );
  return sum / cards.length;
}

// formatDuration: turns a millisecond duration into a friendly
// "Xm YYs" or "Zs" string for the time-taken stat on VIEW 5.
function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// generateDistractor: a frontend stand-in for the backend's
// POST /flashcards/distractor endpoint (which doesn't exist yet).
//
// It takes the CORRECT answer text and produces a plausibly
// WRONG version by swapping high-impact words with their
// opposites — for example "elastic" becomes "inelastic" and
// "increase" becomes "decrease". Cambridge students often pick
// these "subtly inverted" answers on autopilot, so they make
// great distractors.
//
// If no substitution applies, fall back to a generic "common
// misconception" prefix so the option still reads coherently.
function generateDistractor(correctAnswer) {
  if (!correctAnswer) return "This is not the standard interpretation.";

  // Each pair is a regex matching one "polarity word" plus its
  // opposite. /gi means case-insensitive, all-occurrences.
  const swaps = [
    [/\bincreases?\b/gi,    "decreases"],
    [/\bdecreases?\b/gi,    "increases"],
    [/\bmore\b/gi,          "less"],
    [/\bless\b/gi,          "more"],
    [/\bhigher?\b/gi,       "lower"],
    [/\blower?\b/gi,        "higher"],
    [/\bpositive\b/gi,      "negative"],
    [/\bnegative\b/gi,      "positive"],
    [/\belastic\b/gi,       "inelastic"],
    [/\binelastic\b/gi,     "elastic"],
    [/\bformal\b/gi,        "informal"],
    [/\binformal\b/gi,      "formal"],
    [/\bdirect\b/gi,        "indirect"],
    [/\bindirect\b/gi,      "direct"],
    [/\bprimary\b/gi,       "secondary"],
    [/\bsecondary\b/gi,     "primary"],
    [/\babove\b/gi,         "below"],
    [/\bbelow\b/gi,         "above"],
    [/\bmaximum\b/gi,       "minimum"],
    [/\bminimum\b/gi,       "maximum"],
    [/\bguaranteed?\b/gi,   "does not guarantee"],
    [/\bensure(?:s)?\b/gi,  "cannot ensure"],
  ];

  for (const [pattern, replacement] of swaps) {
    if (pattern.test(correctAnswer)) {
      return correctAnswer.replace(pattern, replacement);
    }
  }

  // Fallback when nothing swaps cleanly. A short capitalised
  // "common misconception" sentence reads naturally beside the
  // real answer choices.
  return "This is a common misconception — the relationship is actually inverted.";
}

// buildOptions: assembles the four answer choices for ONE quiz
// question. Returns { options, correctIndex }.
//
// Step 1: the correct answer is just the current card's back.
// Step 2: one frontend-generated distractor (see above).
// Step 3: up to two random backs from OTHER cards in the same
//         subject (NEVER reuse the correct answer as a wrong
//         option — we filter it out explicitly).
// Step 4: shuffle all four so the correct answer's position
//         is not predictable.
//
// The `correctIndex` is kept ONLY in component state — it is
// never rendered into the HTML so a curious student cannot
// "view source" to cheat.
function buildOptions(currentCard, allCardsInSubject) {
  const correct = currentCard.back;

  // Step 1 — distractor by word-swap.
  const swappedDistractor = generateDistractor(correct);

  // Step 2 — gather candidate "random wrong" answers from the
  // SAME subject (not the same topic — wider pool is more varied).
  // Dedupe with Set so two cards with identical backs only
  // appear once.
  const otherBacks = [...new Set(
    allCardsInSubject
      .filter((c) => c.id !== currentCard.id && c.back !== correct)
      .map((c) => c.back)
  )];

  // Pick up to two random ones.
  const twoRandomWrong = shuffle(otherBacks).slice(0, 2);

  // Step 3 — assemble the wrong set. The swapped distractor
  // could accidentally equal one of the random wrongs OR the
  // correct answer; filter both cases out, then top up with a
  // generic fallback so we always end with exactly 3 wrongs.
  let wrongs = [swappedDistractor, ...twoRandomWrong].filter(
    (w) => w && w !== correct
  );
  wrongs = [...new Set(wrongs)];
  while (wrongs.length < 3) {
    wrongs.push(
      "This is not the standard Cambridge interpretation of the concept."
    );
  }
  wrongs = wrongs.slice(0, 3);

  // Step 4 — shuffle the full 4-option list and record where
  // the correct answer landed.
  //
  // Shuffled so the correct answer appears in a different
  // position each time — prevents Aisha from memorising
  // answer positions (e.g. "always B") instead of the actual
  // material. `buildOptions` is called fresh every time the
  // quiz index advances, so the four choices reshuffle on
  // every question, not just once per quiz.
  const all = shuffle([correct, ...wrongs]);

  // `correctIndex` lives ONLY in React state — never rendered
  // into the DOM — so the new position is invisible to the UI
  // but still trusted by the answer-checking logic below.
  const correctIndex = all.indexOf(correct);

  return { options: all, correctIndex };
}

// buildSubjectIndex: takes the raw rows from `SELECT * FROM
// subjects` and returns three views of the same data — one
// ordered list (for tab/grid rendering) plus two lookups
// (by UUID and by local key). Mirrors the same helper used by
// the Notes page so the matcher behaves identically across the
// app.
function buildSubjectIndex(dbRows) {
  const ordered = [];
  const byId = {};
  const byKey = {};

  if (!Array.isArray(dbRows)) return { ordered, byId, byKey };

  for (const local of SUBJECTS) {
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
      const entry = {
        id: row.id,
        name: row.name,
        code: row.code,
        key: local.key,
      };
      ordered.push(entry);
      byId[row.id] = entry;
      byKey[local.key] = entry;
    }
  }

  return { ordered, byId, byKey };
}

// buildMockData: when the real `flashcards` table is empty
// (or fails to load), we generate the 40 mock cards listed
// above and pair them with the REAL subject UUIDs we just
// fetched. The result is a `{ flashcards, notes }` pair that
// looks identical to a real Supabase response.
function buildMockData(subjectByKey) {
  const flashcards = [];
  const notes = {};

  for (const topic of MOCK_TOPICS) {
    const subjectMeta = subjectByKey[topic.subjectKey];
    if (!subjectMeta) continue;

    notes[topic.noteSlug] = topic.title;

    topic.cards.forEach((c, idx) => {
      flashcards.push({
        id: `${topic.noteSlug}-${idx}`,
        front: c.front,
        back: c.back,
        subject_id: subjectMeta.id, // REAL UUID, fetched at runtime
        note_id: topic.noteSlug,    // mock note slug
        mastery_level: c.mastery_level,
      });
    });
  }

  return { flashcards, notes };
}

// formatModalDate: turn a Supabase ISO timestamp like
// "2026-05-14T10:00:00+00:00" into the friendly UK string
// "14 May 2026". Returns "—" on any unparseable input so the
// dialog never crashes on a malformed row. Same shape the
// notes page uses — kept here as a tiny private helper rather
// than promoting it to a shared module (it's used in exactly
// one place).
function formatModalDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}


// buildTopicsForSubject: given a subject UUID, returns the
// list of topics that have at least one flashcard, where each
// topic carries its title and the cards belonging to it.
function buildTopicsForSubject(subjectId, flashcards, notes) {
  const subjectCards = flashcards.filter(
    (c) => c.subject_id === subjectId
  );

  const grouped = new Map();
  for (const card of subjectCards) {
    const noteId = card.note_id;
    if (!grouped.has(noteId)) {
      grouped.set(noteId, {
        // The grouping key — may be a real UUID or a
        // `title:<text>` synthetic for legacy rows. NEVER send
        // this to the backend directly — use `note_uuid` below.
        note_id: noteId,
        // Real source-note UUID (or null when unknown). This is
        // what /quiz/session reads to tag a quiz as "topic".
        note_uuid: card.note_uuid ?? null,
        title: notes[noteId] ?? "Untitled topic",
        cards: [],
      });
    }
    grouped.get(noteId).cards.push(card);
  }

  return Array.from(grouped.values());
}


// ─────────────────────────────────────────────────────────────
// SMALL VISUAL COMPONENTS
// ─────────────────────────────────────────────────────────────

// (The per-page SubjectBadge function used to live here. It was
// removed during the UI unification pass — every page now imports
// the shared SubjectBadge from app/components/SubjectBadge.js.)


// Lookup of subject key → Tailwind border-l class. Kept as
// literal strings so the JIT keeps the CSS in the final bundle.
// Used to paint the 3 px subject-coloured left edge on the
// flashcard subject cards (audit Task 4 + Task 6).
const SUBJECT_LEFT_BORDER_CLASS = {
  economics: "border-l-economics-text",
  business:  "border-l-business-text",
  english:   "border-l-english-text",
  ict:       "border-l-ict-text",
};

// MasteryBar: 4-pixel-tall progress bar showing average mastery
// as a percentage of the 0-to-5 scale. Background = hover token,
// fill = gold token, both from tailwind.config.js.
function MasteryBar({ value }) {
  // Clamp safely so a malformed mastery value can't blow out
  // the layout (e.g. width: -50%).
  const pct = Math.max(0, Math.min(100, (value / MASTERY_MAX) * 100));
  return (
    <div className="h-1 w-full bg-hover rounded-full overflow-hidden">
      <div
        className="h-full bg-gold transition-[width] duration-300 ease-out"
        // Tailwind cannot express dynamic numeric widths, so we
        // use an arbitrary-value class via the style prop. Note
        // this is NOT a hex/colour inline style — it is a single
        // numeric width that drives the % fill. Colours stay in
        // tokens.
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// SkeletonCard: pulsing placeholder used while the subjects /
// flashcards / notes queries are in flight on VIEW 1. We render
// four of these so the layout is stable when real data arrives.
function SkeletonSubjectCard() {
  return (
    <div className="bg-card border border-input-border rounded-4px p-5 shadow-sm animate-pulse">
      <div className="h-4 w-16 bg-hover rounded-4px mb-3" />
      <div className="h-6 w-3/4 bg-hover rounded-4px mb-2" />
      <div className="h-3 w-1/3 bg-hover rounded-4px mb-4" />
      <div className="h-3 w-full bg-hover rounded-4px mb-2" />
      <div className="h-1 w-full bg-hover rounded-full" />
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// MAIN PAGE COMPONENT
// ─────────────────────────────────────────────────────────────
export default function FlashcardsPage() {
  const router = useRouter();

  // ── Auth gate ─────────────────────────────────────────────
  // Set to true only after Effect 1 confirms an active session
  // AND that onboarding has been completed. While false, the
  // page renders a tiny "Loading…" placeholder.
  const [authReady, setAuthReady] = useState(false);

  // ── Data state ───────────────────────────────────────────
  // subjectIndex: { ordered, byId, byKey } — see buildSubjectIndex.
  // flashcards:   array of every card belonging to the user.
  // noteTitles:   { note_id: title } map — used to label topics.
  // dataLoading:  drives the skeleton view on VIEW 1.
  // usingMock:    true when the DB returned empty + we swapped
  //               in MOCK_TOPICS data. Used purely for a small
  //               "showing sample cards" notice in development.
  const [subjectIndex, setSubjectIndex] = useState({
    ordered: [],
    byId: {},
    byKey: {},
  });
  const [flashcards, setFlashcards] = useState([]);
  const [noteTitles, setNoteTitles] = useState({});
  const [dataLoading, setDataLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);

  // ── Navigation state ─────────────────────────────────────
  // currentView: one of the VIEW.* constants.
  // selectedSubject: the subject metadata object the student
  // picked on VIEW 1 ({ id, name, code, key }).
  // selectedTopic: { note_id, title, cards[] } the student
  // picked on VIEW 2. The `cards` array is what STUDY and
  // QUIZ iterate over.
  const [currentView, setCurrentView] = useState(VIEW.SUBJECTS);
  const [selectedSubject, setSelectedSubject] = useState(null);
  const [selectedTopic, setSelectedTopic] = useState(null);

  // ── Study mode state (VIEW 3) ────────────────────────────
  // studyIndex: which card in selectedTopic.cards is showing.
  // studyFlipped: true once the user has revealed the answer.
  //               One-way only — cannot flip back to front
  //               (per spec). Resets when studyIndex changes.
  const [studyIndex, setStudyIndex] = useState(0);
  const [studyFlipped, setStudyFlipped] = useState(false);

  // ── Quiz mode state (VIEW 4) ─────────────────────────────
  // quizCards: the deck for THIS quiz attempt — kept separate
  //            from `selectedTopic.cards` so study mode keeps
  //            its mastery-ascending order while the quiz uses
  //            a freshly shuffled, mastery-prioritised slice
  //            (see prepareQuizCards). Rebuilt on every entry
  //            into VIEW 4 (jump-to-quiz, study→quiz, retake)
  //            and cleared by resetQuizState.
  // quizIndex: which card in `quizCards` we're testing right now.
  // quizOptions: { options[], correctIndex } generated by
  //              buildOptions(). correctIndex is NEVER rendered.
  // selectedOption: the index the user has clicked (null
  //                 until they answer); also used to trigger
  //                 the "Next question" button.
  // quizAnswers: array of recorded answers — one per card.
  //              See the recordAnswer() handler for the shape.
  // quizStartTime: ms timestamp set when VIEW 4 first opens —
  //                used to compute the time-taken stat in V5.
  const [quizCards, setQuizCards] = useState([]);
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizOptions, setQuizOptions] = useState(null);
  const [selectedOption, setSelectedOption] = useState(null);
  const [quizAnswers, setQuizAnswers] = useState([]);
  const [quizStartTime, setQuizStartTime] = useState(null);
  const [quizEndTime, setQuizEndTime] = useState(null);

  // Ref mirror of state so the keyboard handler (mounted once
  // and never re-bound) can read the freshest values without
  // forcing the listener to re-attach on every render.
  const liveStateRef = useRef({});
  liveStateRef.current = {
    currentView,
    selectedTopic,
    studyIndex,
    studyFlipped,
    selectedOption,
  };

  // ── Quiz-backend state ────────────────────────────────────
  // `quizSessionId` is the UUID returned by POST /quiz/session
  // when a quiz begins. While it is null, every per-answer and
  // completion fetch short-circuits — i.e. the quiz runs in
  // pure-local mode (e.g. when the student is browsing mock
  // data, or when the backend is unreachable).
  //
  // `serverMasteryByCard` maps card_id → { new_mastery_level,
  // mastery_changed } as soon as POST /quiz/answer responds.
  // VIEW 5 prefers these server-confirmed numbers over the
  // local +1/-1 preview when they're present.
  //
  // `serverScore` is the running score as last confirmed by the
  // backend. It overrides the local count in VIEW 4's header
  // counter the moment it arrives.
  //
  // `serverFinalResult` carries the envelope returned by
  // POST /quiz/complete (percentage, performance_label, time
  // taken). VIEW 5 falls back to client-computed values if it
  // is still null — that's the graceful-degradation pattern.
  const [quizSessionId, setQuizSessionId] = useState(null);
  const [serverMasteryByCard, setServerMasteryByCard] = useState({});
  const [serverScore, setServerScore] = useState(null);
  const [serverFinalResult, setServerFinalResult] = useState(null);

  // Mirror refs so the per-answer fire-and-forget fetch always
  // reads the freshest values (closures captured at click time
  // would otherwise lag a tick behind setState).
  const quizSessionIdRef = useRef(null);
  useEffect(() => {
    quizSessionIdRef.current = quizSessionId;
  }, [quizSessionId]);

  // When a new question becomes visible (Effect 4 below) we
  // record the wall-clock time here. POST /quiz/answer reads it
  // to compute time_taken_seconds without forcing a re-render
  // on every state change.
  const cardStartTimeRef = useRef(0);


  // ── Generate-Cards modal state ────────────────────────────
  // `currentUserId` is the verified UUID of the signed-in user —
  // cached once during Effect 1 so handlers don't have to call
  // supabase.auth.getUser() on every click.
  //
  // `showGenerateModal` toggles the note-picker dialog.
  // `modalNotes` is the list of notes shown in that dialog,
  //   each augmented with { cardsExistCount, subjectMeta }.
  // `modalLoading` drives the spinner inside the modal.
  // `modalError` shows a friendly inline error if the load fails.
  // `generatingNoteId` is the id of the note whose Generate
  //   button is currently in flight — we use this to put the
  //   spinner on JUST that one row.
  // `reloadKey` is a monotonic counter; bumping it re-runs the
  //   main data fetch (used to refresh subject card counts after
  //   a successful generate without a full navigation).
  // `toast` is the standard bottom-right notification.
  const [currentUserId, setCurrentUserId] = useState(null);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [modalNotes, setModalNotes] = useState([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState(null);
  const [generatingNoteId, setGeneratingNoteId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [toast, setToast] = useState(null);

  // Ref of `currentUserId` so async callbacks see the freshest
  // value without dependency-array juggling.
  const currentUserIdRef = useRef(currentUserId);
  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 1 — Auth + onboarding guard.
  // ───────────────────────────────────────────────────────────
  // Runs once on mount. Mirrors the dashboard pattern exactly:
  // missing session → /login, missing onboarding flag →
  // /onboarding/welcome. Otherwise marks the page ready.
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (cancelled) return;

      if (error || !user) {
        console.warn("[Flashcards] No session – redirecting to /login");
        router.replace("/login");
        return;
      }

      if (localStorage.getItem(ONBOARDING_KEY) !== "true") {
        console.log("[Flashcards] Onboarding incomplete – redirecting");
        router.replace("/onboarding/welcome");
        return;
      }

      // Cache the verified user id so the modal + generate
      // handlers don't have to re-query supabase on every click.
      setCurrentUserId(user.id);
      setAuthReady(true);
    };

    init();
    return () => { cancelled = true; };
  }, [router]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 2 — Fetch subjects from Supabase and flashcards from
  //            the backend (one /flashcards/by-subject call per
  //            subject), once authentication has been verified.
  // ───────────────────────────────────────────────────────────
  // Flow:
  //   QUERY 1: SELECT * FROM subjects (direct Supabase — shared
  //            global data, RLS allows read for all signed-in
  //            users).
  //   QUERY 2..N: GET /flashcards/by-subject?subject_id=…&user_id=…
  //            Fired in parallel, one per subject. Each call
  //            carries the bearer token so the backend can
  //            re-verify ownership before returning rows.
  //
  // The backend already orders rows by mastery_level ASC and
  // joins the source-note title back in via the `topic` column
  // (see backend/routers/flashcards.py SCHEMA-NOTE). We re-key
  // those rows onto the local card shape the rest of the page
  // already understands: `note_id` becomes the note title (so
  // `buildTopicsForSubject` groups cards by topic correctly).
  //
  // If the merged backend result is empty we transparently
  // fall back to mock data so the page is still browseable in
  // development before any real cards have been generated.
  //
  // `reloadKey` is a dependency: bumping it (e.g. after the
  // generate modal succeeds) makes this effect re-run and the
  // subject card counts refresh without a full page nav.
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;

    const fetchAll = async () => {
      // Only show the full skeleton on the FIRST load. Reloads
      // triggered by the generate modal happen silently so the
      // grid doesn't flicker back to skeletons mid-flow.
      if (reloadKey === 0) setDataLoading(true);

      // ── QUERY 1: subjects (direct Supabase) ────────────────
      const { data: subjectRows, error: subjectErr } = await supabase
        .from("subjects")
        .select("*");
      if (cancelled) return;

      const nextIndex = subjectErr
        ? { ordered: [], byId: {}, byKey: {} }
        : buildSubjectIndex(subjectRows ?? []);
      if (subjectErr) {
        console.warn("[Flashcards] Could not load subjects:", subjectErr);
      }
      setSubjectIndex(nextIndex);

      // ── Resolve auth token + verified user id once. ───────
      // Used by every /flashcards/by-subject call. We pull from
      // the session (not getUser) to avoid a network round-trip.
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token ?? null;
      const userId = sessionData?.session?.user?.id ?? null;

      let usableCards = [];
      const usableNotes = {};
      let isMock = false;

      if (token && userId && nextIndex.ordered.length > 0) {
        // ── QUERY 2: fire one /by-subject call per subject. ──
        // Parallel fetches keep total latency at one round-trip
        // even with four subjects.
        const responses = await Promise.all(
          nextIndex.ordered.map(async (s) => {
            try {
              // Comment per spec: every backend fetch documents
              // its query parameters AND its Authorization header.
              //
              //   query → subject_id = this subject's UUID
              //   query → user_id    = signed-in user (re-verified
              //                        server-side from the token)
              //   header → Bearer JWT
              const url =
                `${API_URL}/flashcards/by-subject` +
                `?subject_id=${encodeURIComponent(s.id)}` +
                `&user_id=${encodeURIComponent(userId)}`;
              const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!res.ok) {
                console.warn(
                  `[Flashcards] /by-subject ${s.name} returned HTTP ${res.status}`
                );
                return { subjectId: s.id, data: [] };
              }
              const body = await res.json();
              return {
                subjectId: s.id,
                data: Array.isArray(body?.data) ? body.data : [],
              };
            } catch (e) {
              console.warn(
                `[Flashcards] /by-subject ${s.name} threw:`,
                e
              );
              return { subjectId: s.id, data: [] };
            }
          })
        );

        if (cancelled) return;

        // Flatten the per-subject results into the single shape
        // the rest of the page already understands.
        //
        // Grouping rules:
        //   • If the row carries a real `note_id` UUID, we use
        //     that as both `card.note_id` AND as the lookup key
        //     into `usableNotes`. This is the canonical case —
        //     it lets /quiz/session forward a real UUID to the
        //     backend without any further translation.
        //   • If `note_id` is missing (legacy rows from before
        //     the migration), we fall back to a `title:<text>`
        //     synthetic key so cards from different notes don't
        //     all collapse onto a single `null` group. These
        //     legacy cards intentionally end up with `note_id =
        //     null` on the card object so quiz code can detect
        //     them and drop the field instead of sending a non-
        //     UUID string into a UUID column.
        for (const { subjectId, data } of responses) {
          for (const row of data) {
            const realUuid =
              row?.note_id && String(row.note_id).trim()
                ? String(row.note_id).trim()
                : null;
            const titleText =
              (row?.note_title && String(row.note_title).trim()) ||
              "Untitled note";
            const groupKey = realUuid || `title:${titleText}`;
            usableNotes[groupKey] = titleText;
            usableCards.push({
              id: row.id,
              front: row.front,
              back: row.back,
              subject_id: subjectId,
              // The grouping key buildTopicsForSubject reads —
              // either a real UUID or a `title:<text>` synthetic.
              note_id: groupKey,
              // Real UUID we can safely send to the backend, or
              // null when we don't have one.
              note_uuid: realUuid,
              mastery_level: Number(row.mastery_level) || 0,
            });
          }
        }
      } else if (!token || !userId) {
        // No token = the proxy will redirect us in a moment.
        // Render an empty state for the brief window before then.
        console.warn(
          "[Flashcards] No active session token – skipping backend fetch."
        );
      }

      // ── Fallback to mock data ─────────────────────────────
      // The student has no cards yet AND we want the page to look
      // alive in development. Mock cards reuse the real subject
      // UUIDs we just fetched so badge colours resolve correctly.
      if (usableCards.length === 0 && nextIndex.ordered.length > 0) {
        const mock = buildMockData(nextIndex.byKey);
        usableCards = mock.flashcards;
        for (const k of Object.keys(mock.notes)) {
          usableNotes[k] = mock.notes[k];
        }
        isMock = true;
        console.log(
          "[Flashcards] No real cards – showing mock data for development."
        );
      }

      if (cancelled) return;

      setFlashcards(usableCards);
      setNoteTitles(usableNotes);
      setUsingMock(isMock);
      setDataLoading(false);
    };

    fetchAll();
    return () => {
      cancelled = true;
    };
    // `reloadKey` is intentionally in the deps: incrementing it
    // re-runs this effect so the subject card counts refresh
    // after the generate modal succeeds.
  }, [authReady, reloadKey]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 3 — Global keyboard handler.
  // ───────────────────────────────────────────────────────────
  // Listens on `window` once. Reads the latest state values
  // out of liveStateRef instead of closure-captured variables,
  // so it doesn't need to re-attach when state changes.
  //
  // VIEW 3 (study):
  //   • Space     — flip the current card (one-way)
  //   • ArrowLeft — previous card (does nothing on first card)
  //   • ArrowRight — next card (or "Start Quiz" on last card)
  //
  // VIEW 4 (quiz):
  //   • ArrowRight — advance to the next question, but only
  //                  AFTER the student has chosen an option.
  useEffect(() => {
    const onKey = (e) => {
      const {
        currentView: v,
        selectedTopic: topic,
        studyIndex: sIdx,
        studyFlipped: flipped,
        selectedOption: opt,
      } = liveStateRef.current;

      if (v === VIEW.STUDY && topic) {
        const last = topic.cards.length - 1;
        if (e.key === " ") {
          // Stop the page from scrolling on Space.
          e.preventDefault();
          if (!flipped) setStudyFlipped(true);
        } else if (e.key === "ArrowLeft") {
          if (sIdx > 0) {
            setStudyIndex(sIdx - 1);
            setStudyFlipped(false);
          }
        } else if (e.key === "ArrowRight") {
          if (sIdx < last) {
            setStudyIndex(sIdx + 1);
            setStudyFlipped(false);
          } else {
            // On the LAST card, ArrowRight starts the quiz.
            handleStartQuizFromStudy();
          }
        }
      } else if (v === VIEW.QUIZ) {
        if (e.key === "ArrowRight" && opt !== null) {
          handleNextQuestion();
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // The empty deps array is intentional — see liveStateRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ───────────────────────────────────────────────────────────
  // EFFECT 4 — Generate fresh quiz options whenever the
  //            quiz index changes (= a new question is being
  //            shown). Also resets `selectedOption` so the new
  //            question starts unanswered.
  // ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (currentView !== VIEW.QUIZ || !selectedTopic || !selectedSubject) return;
    // Read from the per-attempt deck (`quizCards`), NOT the
    // topic's full card list. The deck was prepared once when
    // the quiz started and may differ from `selectedTopic.cards`
    // in both length (capped at QUIZ_SESSION_SIZE) and order
    // (Fisher-Yates shuffled after mastery-asc slicing).
    const card = quizCards[quizIndex];
    if (!card) return;
    const allCardsInSubject = flashcards.filter(
      (c) => c.subject_id === selectedSubject.id
    );
    // `buildOptions` internally shuffles its four options on
    // every call, so the correct-answer position changes per
    // question — prevents Aisha from memorising answer
    // positions instead of the material.
    setQuizOptions(buildOptions(card, allCardsInSubject));
    setSelectedOption(null);
    // Stamp the moment this card became visible so POST
    // /quiz/answer can report a real `time_taken_seconds`
    // value. Using a ref (not state) avoids an extra render.
    cardStartTimeRef.current = Date.now();
  }, [
    currentView,
    quizIndex,
    quizCards,
    selectedTopic,
    selectedSubject,
    flashcards,
  ]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 5 — Populate the Generate Cards modal whenever it
  //            opens. Fetches all of Aisha's notes plus the
  //            set of note-titles that ALREADY have cards (so
  //            we can render "X cards exist" + a disabled
  //            "Regenerate" button on those rows).
  // ───────────────────────────────────────────────────────────
  // Two parallel SELECTs (RLS scopes both to the signed-in user):
  //   • notes      → id, title, subject_id, created_at
  //   • flashcards → topic (counted into a Map by title)
  //
  // Both are direct Supabase reads — not a backend call —
  // because they're cheap, RLS-safe, and we want the modal to
  // show fresh data even if the backend is briefly unreachable.
  useEffect(() => {
    if (!showGenerateModal) return;
    let cancelled = false;

    const loadModalData = async () => {
      setModalLoading(true);
      setModalError(null);

      try {
        const [{ data: noteRows, error: noteErr }, { data: cardRows, error: cardErr }] =
          await Promise.all([
            supabase
              .from(NOTES_TABLE)
              .select("id, title, subject_id, created_at")
              .order("created_at", { ascending: false }),
            supabase.from(FLASHCARDS_TABLE).select("topic"),
          ]);

        if (cancelled) return;

        if (noteErr) {
          console.warn("[Flashcards] Modal notes fetch failed:", noteErr);
          setModalError(
            "Could not load your notes. Please close this dialog and try again."
          );
          setModalNotes([]);
          setModalLoading(false);
          return;
        }

        // Count how many flashcards already exist per note
        // title. RLS scopes to the signed-in user, and the
        // `topic` column stores the source-note title (see the
        // SCHEMA-NOTE block in backend/routers/flashcards.py).
        const countsByTitle = new Map();
        if (!cardErr && Array.isArray(cardRows)) {
          for (const row of cardRows) {
            const t = (row?.topic ?? "").toString().trim();
            if (!t) continue;
            countsByTitle.set(t, (countsByTitle.get(t) || 0) + 1);
          }
        } else if (cardErr) {
          console.warn(
            "[Flashcards] Modal flashcards probe failed " +
              "(buttons will default to Generate):",
            cardErr
          );
        }

        // Hydrate each note row with subject metadata + the
        // existing-cards count. We compute subject metadata up
        // front so the row can render its badge without doing
        // any work during paint.
        const hydrated = (noteRows ?? []).map((n) => {
          const subjMeta = subjectIndex.byId[n.subject_id] || null;
          return {
            id: n.id,
            title: n.title,
            subject_id: n.subject_id,
            created_at: n.created_at,
            subjectMeta: subjMeta,
            cardsExistCount: countsByTitle.get(
              (n.title ?? "").toString().trim()
            ) || 0,
          };
        });

        setModalNotes(hydrated);
        setModalLoading(false);
      } catch (e) {
        if (cancelled) return;
        console.error("[Flashcards] Modal load threw:", e);
        setModalError(
          "Something went wrong loading your notes. Please try again."
        );
        setModalNotes([]);
        setModalLoading(false);
      }
    };

    loadModalData();
    return () => {
      cancelled = true;
    };
    // subjectIndex.byId is part of the deps so a late subjects
    // load while the modal is open still hydrates the rows.
  }, [showGenerateModal, subjectIndex.byId]);


  // ───────────────────────────────────────────────────────────
  // EFFECT 6 — Auto-dismiss toast after a short delay.
  // ───────────────────────────────────────────────────────────
  // Same simple timer the notes page uses.
  useEffect(() => {
    if (!toast) return;
    const handle = window.setTimeout(
      () => setToast(null),
      TOAST_DISMISS_MS
    );
    return () => window.clearTimeout(handle);
  }, [toast]);


  // ───────────────────────────────────────────────────────────
  // HANDLERS — small named functions that mutate state.
  // ───────────────────────────────────────────────────────────

  // handleSelectSubject: VIEW 1 → VIEW 2. Stores the chosen
  // subject and switches to the topic-picker view.
  const handleSelectSubject = (subject) => {
    setSelectedSubject(subject);
    setSelectedTopic(null);
    setCurrentView(VIEW.TOPICS);
  };

  // handleBackToSubjects: VIEW 2 / 3 / 4 / 5 → VIEW 1.
  // Clears every quiz / study state value so nothing leaks
  // across topics.
  const handleBackToSubjects = () => {
    setSelectedSubject(null);
    setSelectedTopic(null);
    resetStudyState();
    resetQuizState();
    setCurrentView(VIEW.SUBJECTS);
  };

  // handleBackToTopics: VIEW 3 / 4 / 5 → VIEW 2. Keeps the
  // current subject but clears every per-topic state.
  const handleBackToTopics = () => {
    setSelectedTopic(null);
    resetStudyState();
    resetQuizState();
    setCurrentView(VIEW.TOPICS);
  };

  // handleStudyTopic: VIEW 2 → VIEW 3. The student wants to
  // study first before being quizzed.
  const handleStudyTopic = (topic) => {
    setSelectedTopic(topic);
    resetStudyState();
    setCurrentView(VIEW.STUDY);
  };

  // handleJumpToQuiz: VIEW 2 → VIEW 4. Skips the study phase.
  const handleJumpToQuiz = (topic) => {
    if (!topic) return;
    // Build the per-attempt deck right here so we can both
    // seed `quizCards` AND tell the backend the correct
    // `total_cards` in the same tick. Without this, the
    // /quiz/session POST would race React's state setter.
    const prepared = prepareQuizCards(topic.cards);
    setSelectedTopic(topic);
    resetQuizState();
    setQuizCards(prepared);
    setQuizStartTime(Date.now());
    setCurrentView(VIEW.QUIZ);
    // Fire the backend session create asynchronously — VIEW 4
    // renders immediately, the session id arrives a moment later.
    startQuizSession(topic, prepared.length);
  };

  // handleStartQuizFromStudy: VIEW 3 → VIEW 4 once the student
  // has reviewed every card and clicked "Start Quiz →".
  const handleStartQuizFromStudy = () => {
    if (!selectedTopic) return;
    // Same mastery-prioritised, shuffled slice the
    // jump-to-quiz path uses. Study mode kept its mastery-asc
    // ordering above; the quiz now gets its own randomised
    // session deck.
    const prepared = prepareQuizCards(selectedTopic.cards);
    resetQuizState();
    setQuizCards(prepared);
    setQuizStartTime(Date.now());
    setCurrentView(VIEW.QUIZ);
    // Same async session create — graceful if it fails.
    startQuizSession(selectedTopic, prepared.length);
  };

  // resetStudyState / resetQuizState — small bookkeeping
  // helpers so we never forget to clear a field when switching
  // views.
  const resetStudyState = () => {
    setStudyIndex(0);
    setStudyFlipped(false);
  };
  const resetQuizState = () => {
    // Wipe the per-attempt deck. The entry handlers
    // (handleJumpToQuiz / handleStartQuizFromStudy /
    // handleRetakeQuiz) call this BEFORE preparing the new
    // deck, so clearing here is safe — the fresh
    // setQuizCards(...) immediately after wins.
    setQuizCards([]);
    setQuizIndex(0);
    setQuizOptions(null);
    setSelectedOption(null);
    setQuizAnswers([]);
    setQuizStartTime(null);
    setQuizEndTime(null);
    // Also wipe the backend-session footprint so a retake gets
    // a fresh /quiz/session, fresh per-card masteries and a
    // fresh final result envelope.
    setQuizSessionId(null);
    setServerMasteryByCard({});
    setServerScore(null);
    setServerFinalResult(null);
  };

  // ───────────────────────────────────────────────────────────
  // QUIZ ↔ BACKEND HELPERS — graceful-degradation pattern
  // ───────────────────────────────────────────────────────────
  // Each helper below is FIRE-AND-FORGET from the UI's point of
  // view: success updates a piece of state (session id, server
  // mastery, final result), failure logs the error and shows a
  // small toast but NEVER blocks the quiz. The student must
  // always be able to finish answering even if /quiz/* is down.
  //
  // The local quiz state (quizAnswers, masteryByCard memo,
  // sessionScore memo) keeps the page fully usable on its own;
  // backend values are surfaced as overrides whenever they
  // arrive.

  // Resolve the bearer token and verified user id from the
  // active session. Returns `null, null` (and logs a warning)
  // if no session is available — the caller should treat that
  // as "backend persistence disabled for this attempt".
  const _resolveAuth = async () => {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      const tok = data?.session?.access_token ?? null;
      const uid = data?.session?.user?.id ?? currentUserIdRef.current ?? null;
      return { token: tok, userId: uid };
    } catch (e) {
      console.warn("[Quiz] Could not read Supabase session:", e);
      return { token: null, userId: null };
    }
  };

  // startQuizSession — POST /quiz/session.
  // Creates a quiz session record when the quiz begins so every
  // later /quiz/answer + /quiz/complete call has a session id
  // to attach to.
  //
  // Sends: { user_id, subject_id, note_id, total_cards, quiz_mode }
  // Expects back: { session_id, message, started_at }
  // Sets `quizSessionId` on success; leaves it null (= quiz
  // runs locally only) on failure.
  //
  // `totalCards` is passed in from the caller (the freshly
  // prepared deck length) instead of read from React state —
  // React's batched state updates mean `quizCards.length` is
  // not yet visible here when this fires in the same tick as
  // setQuizCards(). Passing it explicitly avoids the race.
  const startQuizSession = async (topic, totalCards) => {
    // When the page is showing mock data the card IDs are not
    // real UUIDs, so every per-answer call would 404 anyway.
    // Skip backend wiring entirely in that mode so we don't
    // pollute the sessions table with orphan rows.
    if (usingMock) {
      console.log("[Quiz] Mock data — skipping backend session start.");
      return;
    }
    if (!topic || !selectedSubject) return;

    const { token, userId } = await _resolveAuth();
    if (!token || !userId) {
      setToast({
        tone: "error",
        message:
          "Quiz progress won't be saved this round " +
          "(session expired). Please sign in again to resume saving.",
      });
      return;
    }

    try {
      // Body comments per spec:
      //   user_id     — signed-in student (must match token).
      //   subject_id  — the subject being quizzed.
      //   note_id     — UUID of the source note if this is a
      //                 "topic" quiz; null for "subject" quizzes.
      //   total_cards — fixed up front so /complete can compute
      //                 the percentage without a COUNT(*).
      //   quiz_mode   — "topic" when a single note's cards drive
      //                 the quiz, "subject" when it's a mix.
      //
      // We forward `topic.note_uuid` (a real UUID or null) NOT
      // `topic.note_id` — the latter may be a `title:<text>`
      // synthetic grouping key on legacy rows, which would crash
      // the insert with a 22P02 invalid-uuid error.
      const noteId =
        topic.note_uuid && !String(topic.note_uuid).startsWith("mock-")
          ? topic.note_uuid
          : null;
      // `total_cards` reflects the per-attempt deck size (the
      // mastery-prioritised, shuffled slice), NOT the full
      // topic size. The backend uses it to compute percentage
      // on /quiz/complete without a COUNT(*).
      const safeTotal =
        typeof totalCards === "number" && totalCards > 0
          ? totalCards
          : topic.cards.length;
      const body = {
        user_id: userId,
        subject_id: selectedSubject.id,
        note_id: noteId,
        total_cards: safeTotal,
        quiz_mode: noteId ? "topic" : "subject",
      };

      const res = await fetch(`${API_URL}/quiz/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data?.detail && (data.detail.error || data.detail)) ||
            `HTTP ${res.status}`
        );
      }

      const data = await res.json();
      if (data?.session_id) {
        setQuizSessionId(data.session_id);
      }
    } catch (e) {
      // Graceful degradation: log, surface a subtle warning,
      // continue. The quiz still works without persistence.
      console.warn("[Quiz] /quiz/session failed:", e);
      setToast({
        tone: "error",
        message:
          "Quiz progress won't be saved this round. " +
          "You can still complete the quiz.",
      });
    }
  };

  // recordAnswerOnBackend — POST /quiz/answer.
  // Records each answer and updates mastery in Supabase.
  //
  // Sends: { session_id, card_id, user_id, is_correct,
  //          time_taken_seconds }
  // Expects back: { answer_saved, new_mastery_level,
  //                 mastery_changed, current_session_score }
  // Fire-and-forget — the page does not await this; a failure
  // is logged but never blocks the quiz.
  const recordAnswerOnBackend = ({ card, isCorrect, timeTakenSeconds }) => {
    // No session = no backend persistence = nothing to do.
    if (!quizSessionIdRef.current) return;
    if (!card?.id) return;

    (async () => {
      const { token, userId } = await _resolveAuth();
      if (!token || !userId) return;

      try {
        const res = await fetch(`${API_URL}/quiz/answer`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          // Body comments:
          //   session_id          — quiz session this answer belongs to.
          //   card_id             — flashcard UUID just answered.
          //   user_id             — caller (must match token).
          //   is_correct          — true on "Got it", false on
          //                         "Still learning".
          //   time_taken_seconds  — how long the card was on
          //                         screen (whole seconds).
          body: JSON.stringify({
            session_id: quizSessionIdRef.current,
            card_id: card.id,
            user_id: userId,
            is_correct: !!isCorrect,
            time_taken_seconds:
              Number.isFinite(timeTakenSeconds) && timeTakenSeconds >= 0
                ? Math.round(timeTakenSeconds)
                : null,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            (data?.detail && (data.detail.error || data.detail)) ||
              `HTTP ${res.status}`
          );
        }

        const data = await res.json();
        // Store the server-confirmed mastery so VIEW 5 can show
        // the real numbers instead of the local +1/-1 preview.
        setServerMasteryByCard((prev) => ({
          ...prev,
          [card.id]: {
            new_mastery_level: Number(data?.new_mastery_level) || 0,
            mastery_changed: Number(data?.mastery_changed) || 0,
          },
        }));
        // Update the running server score (the local UI overlays
        // it onto the live counter in VIEW 4).
        if (Number.isFinite(Number(data?.current_session_score))) {
          setServerScore(Number(data.current_session_score));
        }
      } catch (e) {
        // Logged but never surfaced to the student — losing one
        // answer's persistence shouldn't interrupt the quiz.
        console.warn("[Quiz] /quiz/answer failed:", e);
      }
    })();
  };

  // completeQuizOnBackend — POST /quiz/complete.
  // Marks quiz as complete and gets final performance data.
  //
  // Sends: { session_id, user_id }
  // Expects back: { session_completed, final_score, total_cards,
  //                 percentage, time_taken_seconds,
  //                 performance_label }
  // Fire-and-forget — VIEW 5 falls back to client-computed
  // values until the response arrives (and continues to fall
  // back forever if the call fails).
  const completeQuizOnBackend = () => {
    if (!quizSessionIdRef.current) return;

    (async () => {
      const { token, userId } = await _resolveAuth();
      if (!token || !userId) return;

      try {
        const res = await fetch(`${API_URL}/quiz/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            session_id: quizSessionIdRef.current,
            user_id: userId,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            (data?.detail && (data.detail.error || data.detail)) ||
              `HTTP ${res.status}`
          );
        }

        const data = await res.json();
        // Save the full envelope so VIEW 5 can replace its
        // client-computed percentage + label.
        setServerFinalResult({
          final_score: Number(data?.final_score) || 0,
          total_cards: Number(data?.total_cards) || 0,
          percentage: Number(data?.percentage) || 0,
          time_taken_seconds:
            Number(data?.time_taken_seconds) || 0,
          performance_label: String(data?.performance_label || ""),
        });
      } catch (e) {
        console.warn("[Quiz] /quiz/complete failed:", e);
        // No toast on completion failure either — VIEW 5
        // gracefully shows the client-computed numbers.
      }
    })();
  };


  // recordAnswer: called when the user clicks an answer option
  // in VIEW 4. Appends one entry to quizAnswers. The shape is
  // exactly as the spec requires:
  //   { card_id, question, correct_answer, selected_answer,
  //     is_correct, timestamp }
  const recordAnswer = (optionIndex) => {
    if (selectedOption !== null) return; // already answered
    if (!quizOptions || !selectedTopic) return;

    // Read from the per-attempt deck. `selectedTopic.cards`
    // would point at the WHOLE topic in its mastery order;
    // here we need the same card that Effect 4 is rendering.
    const card = quizCards[quizIndex];
    if (!card) return;
    const selectedText = quizOptions.options[optionIndex];
    const correctText = quizOptions.options[quizOptions.correctIndex];
    const isCorrect = optionIndex === quizOptions.correctIndex;

    setSelectedOption(optionIndex);
    setQuizAnswers((prev) => [
      ...prev,
      {
        card_id: card.id,
        question: card.front,
        correct_answer: correctText,
        selected_answer: selectedText,
        is_correct: isCorrect,
        timestamp: Date.now(),
      },
    ]);

    // Compute how long this card was on screen. We use a ref
    // (stamped by Effect 4) so we don't pay the cost of a
    // re-render on every card change.
    const startedMs = cardStartTimeRef.current || Date.now();
    const timeTakenSeconds = Math.max(0, (Date.now() - startedMs) / 1000);

    // Fire-and-forget the backend save. The function itself
    // bails out cleanly if there's no quiz session id (e.g.
    // mock mode, or session create failed).
    recordAnswerOnBackend({
      card,
      isCorrect,
      timeTakenSeconds,
    });
  };

  // handleNextQuestion: VIEW 4 "Next question →" button.
  // Either moves to the next card or — if this was the last
  // one — finalises the quiz and transitions to VIEW 5.
  const handleNextQuestion = () => {
    if (!selectedTopic) return;
    // Length comes from the per-attempt deck so the quiz ends
    // after exactly QUIZ_SESSION_SIZE cards (or fewer if the
    // topic has less than that), not after every card in the
    // topic.
    const last = quizCards.length - 1;
    if (quizIndex < last) {
      setQuizIndex(quizIndex + 1);
    } else {
      setQuizEndTime(Date.now());
      setCurrentView(VIEW.RESULTS);
      // Finalise the session in the background. VIEW 5 will
      // surface the backend percentage + label as soon as the
      // response arrives, or fall back to the local computation
      // forever if the call fails.
      completeQuizOnBackend();
    }
  };

  // handleRetakeQuiz: VIEW 5 "Retake quiz" button.
  //
  // Two principles combine here:
  //   1. SPACED REPETITION — the cards Aisha just got WRONG
  //      should appear first on the retry. We capture them
  //      explicitly via `wrongIds` so the wrong/right split
  //      survives even before the server mastery values get a
  //      chance to flow back into local state.
  //   2. RANDOMISATION — within each group we still want the
  //      order to feel fresh, so prepareQuizCards (mastery-asc
  //      sort → slice → Fisher-Yates shuffle) runs over the
  //      combined deck and produces the final per-attempt
  //      order.
  //
  // Net effect: low-mastery + just-wrong cards dominate the
  // session, but no two retakes feel identical.
  const handleRetakeQuiz = () => {
    if (!selectedTopic) return;
    const wrongIds = new Set(
      quizAnswers.filter((a) => !a.is_correct).map((a) => a.card_id)
    );
    const wrong = selectedTopic.cards.filter((c) => wrongIds.has(c.id));
    const right = selectedTopic.cards.filter((c) => !wrongIds.has(c.id));
    const reordered = [...wrong, ...right];
    // Build the new deck BEFORE clearing state so the prepared
    // length is available for /quiz/session in the same tick.
    const prepared = prepareQuizCards(reordered);
    // resetQuizState() also nulls out quizSessionId + the server-
    // mastery map, so the new attempt starts as a clean session.
    resetQuizState();
    setQuizCards(prepared);
    setQuizStartTime(Date.now());
    setCurrentView(VIEW.QUIZ);
    // Create a fresh backend session for this retake — the spec
    // explicitly says each attempt becomes its own session row.
    startQuizSession(selectedTopic, prepared.length);
  };

  // ───────────────────────────────────────────────────────────
  // HANDLER: handleGenerateCards
  // ───────────────────────────────────────────────────────────
  // Opens the note-picker modal. We DON'T pre-fetch notes here —
  // a separate effect watches `showGenerateModal` and runs the
  // fetch only when the dialog actually opens. That way the
  // notes + cards-exist set are always fresh when the modal
  // appears (e.g. if Aisha generated cards via the notes page
  // first, the modal still shows the correct "X cards exist"
  // chip without a hard refresh).
  const handleGenerateCards = () => {
    setModalError(null);
    setShowGenerateModal(true);
  };

  // ───────────────────────────────────────────────────────────
  // HANDLER: closeGenerateModal
  // ───────────────────────────────────────────────────────────
  // Closes the dialog and clears every transient piece of
  // modal state. We do NOT clear `generatingNoteId` while a
  // call is mid-flight — the user can dismiss the dialog and
  // the loading state still resolves cleanly into a toast.
  const closeGenerateModal = () => {
    setShowGenerateModal(false);
    setModalError(null);
  };


  // ───────────────────────────────────────────────────────────
  // HANDLER: handleGenerateForNoteFromModal
  // ───────────────────────────────────────────────────────────
  // Fires when Aisha clicks Generate on a specific note inside
  // the modal. Mirrors the notes-page handler but lives in this
  // page so the modal can lock the right row's spinner and
  // refresh the subject card counts on success.
  //
  //   1. If we already know cards exist for this note we treat
  //      this as a duplicate-prevention short-circuit — show a
  //      toast, do NOT call the backend.
  //   2. Otherwise: POST /flashcards/generate with a Bearer JWT.
  //   3. On success: bump `reloadKey` so Effect 2 re-runs and the
  //      subject card counts update, close the modal, show a
  //      success toast.
  //   4. On error: toast + keep modal open (per spec).
  const handleGenerateForNoteFromModal = async (note) => {
    if (!note || !note.id || !note.title) return;
    if (generatingNoteId) return; // a request is already in flight

    // Short-circuit when cards already exist.
    if (note.cardsExistCount && note.cardsExistCount > 0) {
      setToast({
        tone: "success",
        message:
          "Cards already exist for this note. " +
          "Close this dialog to study them.",
      });
      return;
    }

    // Pull the JWT + user id out of the session.
    let token = null;
    let userId = currentUserIdRef.current;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      token = data?.session?.access_token ?? null;
      userId = data?.session?.user?.id ?? userId;
    } catch (e) {
      console.warn("[Flashcards] Could not read session:", e);
    }
    if (!token || !userId) {
      setToast({
        tone: "error",
        message: "Your session has expired. Please sign in again.",
      });
      return;
    }

    // Lock the per-row spinner.
    setGeneratingNoteId(note.id);

    try {
      // Fire the generate request. Authorization header is the
      // bearer JWT the backend will re-verify before doing any
      // work. The body identifies the note + asserts the caller.
      const response = await fetch(`${API_URL}/flashcards/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ note_id: note.id, user_id: userId }),
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Surface the friendly backend error string rather than
        // an internal trace.
        const detail = body?.detail;
        const friendly =
          (detail && typeof detail === "object" && detail.error) ||
          (typeof detail === "string" ? detail : null) ||
          body?.error ||
          `HTTP ${response.status}`;
        throw new Error(friendly);
      }

      // Backend either generated cards, refused to regenerate,
      // or told us the note wasn't usable. Toast accordingly.
      const savedCount = Number(body?.cards_saved) || 0;
      const noteTitle = body?.note_title || note.title;

      if (body?.already_existed) {
        setToast({
          tone: "success",
          message:
            `Cards already existed for "${noteTitle}" ` +
            `(${savedCount} cards).`,
        });
      } else if (savedCount === 0) {
        setToast({
          tone: "error",
          message:
            `Could not generate cards from "${noteTitle}". ` +
            "The note may be too short.",
        });
      } else {
        setToast({
          tone: "success",
          message:
            `${savedCount} cards generated for "${noteTitle}".`,
        });
      }

      // Mark this note as having cards in the local modal state
      // so the row's button switches to "Regenerate" + disabled.
      setModalNotes((prev) =>
        prev.map((n) =>
          n.id === note.id
            ? { ...n, cardsExistCount: savedCount || n.cardsExistCount || 1 }
            : n
        )
      );

      // Refresh the subject card counts in the background.
      setReloadKey((k) => k + 1);

      // Close the dialog (per spec) once the success toast fires.
      // We don't close on error/duplicate so the student can pick
      // a different note straight away.
      if (!body?.already_existed && savedCount > 0) {
        setShowGenerateModal(false);
      }
    } catch (err) {
      console.error("[Flashcards] generate failed:", err);
      setToast({
        tone: "error",
        message:
          `Could not generate cards for "${note.title}". ` +
          "Please try again.",
      });
    } finally {
      // Release the spinner regardless of outcome.
      setGeneratingNoteId(null);
    }
  };


  // ───────────────────────────────────────────────────────────
  // DERIVED VALUES — computed memos used by the renderer.
  // ───────────────────────────────────────────────────────────

  // topicsForSubject: list of topics for the currently selected
  // subject, computed only when relevant inputs change.
  const topicsForSubject = useMemo(() => {
    if (!selectedSubject) return [];
    return buildTopicsForSubject(
      selectedSubject.id,
      flashcards,
      noteTitles
    );
  }, [selectedSubject, flashcards, noteTitles]);

  // sessionScore: snapshot of how many of the recorded answers
  // were correct + total + percent. Used by VIEW 4 (live score)
  // and VIEW 5 (final stats).
  const sessionScore = useMemo(() => {
    const correct = quizAnswers.filter((a) => a.is_correct).length;
    const total = selectedTopic?.cards?.length ?? 0;
    const answered = quizAnswers.length;
    const percent = total > 0 ? Math.round((correct / total) * 100) : 0;
    return { correct, total, answered, percent };
  }, [quizAnswers, selectedTopic]);

  // masteryByCard: { card_id: { before, after, delta } }
  // Used by VIEW 5's per-card table.
  //
  // PRIORITY ORDER:
  //   1. If POST /quiz/answer has confirmed a new mastery for
  //      this card (`serverMasteryByCard[card_id]`), use the
  //      authoritative server values. This way the on-screen
  //      mastery never drifts away from what the database
  //      actually holds.
  //   2. Otherwise fall back to a local +1/-1 preview computed
  //      from quizAnswers — same +1 right / -1 wrong / clamp
  //      0..5 rule the backend uses. This covers mock mode AND
  //      the brief window between recording an answer locally
  //      and the backend response arriving.
  const masteryByCard = useMemo(() => {
    const map = {};
    if (!selectedTopic) return map;
    // Iterate over the per-attempt deck so VIEW 5's per-card
    // table only lists the cards Aisha actually answered, not
    // every card in the topic. (Quiz capped at QUIZ_SESSION_SIZE.)
    for (const card of quizCards) {
      const before = Number(card.mastery_level) || 0;
      const serverInfo = serverMasteryByCard[card.id];

      if (serverInfo) {
        // Server-confirmed values win.
        const after = Math.max(
          MASTERY_MIN,
          Math.min(MASTERY_MAX, Number(serverInfo.new_mastery_level) || 0)
        );
        const delta = Number(serverInfo.mastery_changed) || (after - before);
        map[card.id] = { before, after, delta };
      } else {
        // Local preview — same rule the backend would have applied.
        const ans = quizAnswers.find((a) => a.card_id === card.id);
        const delta = ans ? (ans.is_correct ? 1 : -1) : 0;
        const after = Math.max(
          MASTERY_MIN,
          Math.min(MASTERY_MAX, before + delta)
        );
        map[card.id] = { before, after, delta };
      }
    }
    return map;
  }, [selectedTopic, quizCards, quizAnswers, serverMasteryByCard]);

  // totalMasteryDelta: sum of all per-card deltas. Shown in
  // the V5 stats grid.
  const totalMasteryDelta = useMemo(
    () =>
      Object.values(masteryByCard).reduce(
        (acc, m) => acc + (m?.delta ?? 0),
        0
      ),
    [masteryByCard]
  );


  // ───────────────────────────────────────────────────────────
  // EARLY RENDER GATE — show nothing meaningful until auth
  // has been verified. The proxy redirect arrives a few ms
  // earlier; this is the client-side fallback.
  // ───────────────────────────────────────────────────────────
  if (!authReady) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-text-muted text-sm">Loading…</div>
      </main>
    );
  }


  // ───────────────────────────────────────────────────────────
  // RENDER — pick the right view based on currentView. Wrapping
  // every view in the same <main> shell keeps the page-level
  // background + padding consistent across all five screens.
  // ───────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-background py-6 px-4 sm:px-8">
      <div className="max-w-7xl mx-auto">
        {currentView === VIEW.SUBJECTS && renderSubjectsView()}
        {currentView === VIEW.TOPICS && renderTopicsView()}
        {currentView === VIEW.STUDY && renderStudyView()}
        {currentView === VIEW.QUIZ && renderQuizView()}
        {currentView === VIEW.RESULTS && renderResultsView()}

        {/* The sample-data notice that used to render here was
            moved INTO renderSubjectsView() during the audit so
            it lives directly below the subject grid (with a
            divider line) — see Task 6 in the audit spec. */}
      </div>

      {/* ────────────────────────────────────────────────────
          GENERATE CARDS MODAL
          ────────────────────────────────────────────────────
          Rendered at the page root (not inside the grid) so it
          can overlay the entire viewport. `renderGenerateModal`
          short-circuits when `showGenerateModal` is false. */}
      {renderGenerateModal()}

      {/* ────────────────────────────────────────────────────
          BOTTOM-RIGHT TOAST
          ────────────────────────────────────────────────────
          Used for generate-success / error notifications.
          Auto-dismisses after TOAST_DISMISS_MS via Effect 6. */}
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
            className={
              "absolute top-2 right-2 text-text-hint " +
              "hover:text-text-primary transition leading-none text-lg"
            }
          >
            ×
          </button>
        </div>
      )}
    </main>
  );


  // ─────────────────────────────────────────────────────────
  // ████████████  GENERATE CARDS MODAL  ████████████████████
  // Renders the note-picker overlay opened by the VIEW 1
  // "Generate Cards" button. Style notes:
  //   • White background (per spec) — NOT bg-card.
  //   • inputBorder border + 4 px radius (rounded-4px).
  //   • Close button uses Lucide X in text-gold.
  //   • Notes are grouped by subject for quick scanning.
  //   • Each row has a Generate / Regenerate (disabled) button.
  //   • Rows with cards already get a small "X cards exist" chip.
  // The whole component short-circuits early when the modal is
  // closed, so it costs nothing while the page is just being
  // browsed.
  // ─────────────────────────────────────────────────────────
  function renderGenerateModal() {
    if (!showGenerateModal) return null;

    // Group the notes by subject_id so we can render one
    // section per subject. We use the subject ordering from
    // subjectIndex so the dialog matches the look of VIEW 1.
    const grouped = new Map();
    for (const n of modalNotes) {
      const key = n.subject_id || "_unknown";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(n);
    }
    // We render subjects in the canonical order, falling back
    // to "_unknown" at the end (rare — a note row missing its
    // subject_id would otherwise be invisible).
    const orderedSubjectIds = [
      ...subjectIndex.ordered.map((s) => s.id),
      "_unknown",
    ].filter((id) => grouped.has(id));

    return (
      <div
        // Fixed full-screen overlay. The semi-transparent backdrop
        // uses Tailwind's built-in black opacity utility — not a
        // hex literal — so we stay design-system clean.
        className={
          "fixed inset-0 z-50 flex items-start sm:items-center " +
          "justify-center bg-black/40 p-4 overflow-y-auto"
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-modal-title"
        onClick={(e) => {
          // Close when the student clicks the backdrop. We check
          // currentTarget === target so a click on the modal
          // contents doesn't bubble up and close the dialog.
          if (e.target === e.currentTarget) closeGenerateModal();
        }}
      >
        <div
          className={
            "relative w-full max-w-2xl bg-white border border-input-border " +
            "rounded-4px shadow-xl my-8"
          }
        >
          {/* ── Sticky header ────────────────────────────── */}
          <div
            className={
              "sticky top-0 z-10 flex items-center justify-between " +
              "gap-4 bg-white border-b border-input-border px-6 py-4 " +
              "rounded-t-4px"
            }
          >
            <h2
              id="generate-modal-title"
              className="font-heading text-lg sm:text-xl font-bold text-text-primary"
            >
              Select a note to generate flashcards from
            </h2>
            <button
              type="button"
              onClick={closeGenerateModal}
              aria-label="Close"
              className={
                "inline-flex items-center justify-center w-8 h-8 " +
                "rounded-4px text-gold hover:bg-hover transition " +
                "focus-visible:outline-none focus-visible:ring-2 " +
                "focus-visible:ring-gold focus-visible:ring-offset-2 " +
                "focus-visible:ring-offset-white"
              }
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          {/* ── Body ────────────────────────────────────── */}
          <div className="px-6 py-5">
            {modalLoading ? (
              // Loading state — small spinner + label, no
              // skeletons because notes lists tend to be short.
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-text-muted text-sm">
                <Loader2
                  size={28}
                  className="animate-spin"
                  aria-hidden="true"
                />
                Loading your notes…
              </div>
            ) : modalError ? (
              // Inline error — not a toast, so the student can
              // read it without dismissing the dialog.
              <p className="text-sm text-red-700 leading-relaxed">
                {modalError}
              </p>
            ) : modalNotes.length === 0 ? (
              // Empty state — no notes at all yet.
              <div className="text-center py-10">
                <p className="text-sm text-text-muted leading-relaxed">
                  You don&apos;t have any notes yet. Generate Cards
                  becomes available as soon as your first note arrives
                  from Google Classroom.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {orderedSubjectIds.map((sid) => {
                  const rows = grouped.get(sid) || [];
                  if (rows.length === 0) return null;
                  // Resolve a friendly subject name for the
                  // section heading — falls back to "Other"
                  // when subject metadata is missing.
                  const subjMeta =
                    sid !== "_unknown"
                      ? subjectIndex.byId[sid] || null
                      : null;
                  const subjectName =
                    subjMeta?.name || (sid === "_unknown" ? "Other" : "");

                  return (
                    <section key={sid} aria-label={subjectName}>
                      {/* Subject heading row — badge + name. */}
                      <header className="flex items-center gap-2 mb-3">
                        {subjMeta && (
                          <SubjectBadge subject={subjMeta} size="sm" />
                        )}
                        <h3 className="font-heading text-sm font-bold text-text-primary">
                          {subjectName}
                        </h3>
                      </header>

                      {/* Note rows for this subject. */}
                      <ul className="space-y-2">
                        {rows.map((note) => {
                          const hasCards = note.cardsExistCount > 0;
                          const isThisRowLoading =
                            generatingNoteId === note.id;
                          return (
                            <li
                              key={note.id}
                              className={
                                "flex flex-col sm:flex-row sm:items-center " +
                                "gap-3 border border-input-border " +
                                "rounded-4px px-4 py-3"
                              }
                            >
                              {/* Title + date column. */}
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-body font-body-semibold text-text-primary truncate">
                                  {note.title}
                                </p>
                                <p className="text-xs text-text-muted mt-0.5">
                                  {formatModalDate(note.created_at)}
                                </p>
                              </div>

                              {/* "X cards exist" chip — only when
                                  this note has already been
                                  generated. */}
                              {hasCards && (
                                <span
                                  className={
                                    "inline-flex items-center gap-1 " +
                                    "rounded-4px border border-input-border " +
                                    "bg-hover text-text-muted text-[11px] " +
                                    "font-body font-body-medium px-2 py-0.5"
                                  }
                                >
                                  <CheckCircle
                                    size={12}
                                    aria-hidden="true"
                                  />
                                  {note.cardsExistCount} card
                                  {note.cardsExistCount === 1 ? "" : "s"} exist
                                </span>
                              )}

                              {/* Action button — Generate when
                                  no cards, otherwise a disabled
                                  Regenerate (we never regenerate
                                  to prevent duplicates). */}
                              <button
                                type="button"
                                onClick={() =>
                                  handleGenerateForNoteFromModal(note)
                                }
                                disabled={hasCards || isThisRowLoading}
                                aria-label={
                                  hasCards
                                    ? `Regenerate disabled — cards exist for ${note.title}`
                                    : `Generate cards for ${note.title}`
                                }
                                className={
                                  "inline-flex items-center gap-1.5 " +
                                  "text-[12px] font-body font-body-medium " +
                                  "rounded-4px px-3 py-1.5 border transition " +
                                  "focus-visible:outline-none " +
                                  "focus-visible:ring-2 " +
                                  "focus-visible:ring-gold " +
                                  "focus-visible:ring-offset-2 " +
                                  "focus-visible:ring-offset-white " +
                                  (hasCards
                                    ? "border-input-border text-text-hint " +
                                      "bg-transparent cursor-not-allowed " +
                                      "opacity-70"
                                    : isThisRowLoading
                                    ? "border-gold text-gold bg-transparent " +
                                      "cursor-wait opacity-80"
                                    : "border-gold text-gold bg-transparent " +
                                      "hover:bg-gold hover:text-background")
                                }
                              >
                                {isThisRowLoading ? (
                                  <Loader2
                                    size={14}
                                    className="animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : hasCards ? (
                                  <CheckCircle
                                    size={14}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Sparkles
                                    size={14}
                                    aria-hidden="true"
                                  />
                                )}
                                {hasCards
                                  ? "Regenerate"
                                  : isThisRowLoading
                                  ? "Generating…"
                                  : "Generate"}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }


  // ─────────────────────────────────────────────────────────
  // ███████████████████████  VIEW 1  ████████████████████████
  // SUBJECT SELECTION
  // ─────────────────────────────────────────────────────────
  // Renders one card per subject in the SUBJECTS list. Each
  // card shows the badge, name, code, total cards, average
  // mastery, and a progress bar. Subjects with zero cards are
  // visibly disabled so the student knows nothing's there yet.
  function renderSubjectsView() {
    return (
      <>
        {/* ── Unified shared page header ─────────────────────
            Generate Cards lives in the action slot so its
            visual treatment (size, padding, focus ring) is
            identical to every other page's primary CTA. */}
        <PageHeader
          title="Flashcards"
          subtitle="Study smarter with AI-generated revision cards"
          action={
            <button
              type="button"
              onClick={handleGenerateCards}
              // Primary button — gold filled, matches unified
              // style (Task 10).
              className={
                "bg-gold text-background font-body font-body-semibold " +
                "text-sm px-5 py-2.5 rounded-4px inline-flex items-center " +
                "gap-2 transition hover:brightness-90 " +
                "focus-visible:outline-none focus-visible:ring-2 " +
                "focus-visible:ring-gold focus-visible:ring-offset-2 " +
                "focus-visible:ring-offset-background"
              }
            >
              <Sparkles size={16} strokeWidth={2.25} aria-hidden="true" />
              Generate Cards
            </button>
          }
        />

        {/* ── Body: 4 skeletons OR 4 subject cards ─────── */}
        {dataLoading ? (
          <section
            aria-label="Loading subjects"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonSubjectCard key={i} />
            ))}
          </section>
        ) : (
          <section
            aria-label="Subjects"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
          >
            {subjectIndex.ordered.map((s) => {
              const subjectCards = flashcards.filter(
                (c) => c.subject_id === s.id
              );
              const count = subjectCards.length;
              const avg = avgMastery(subjectCards);
              const empty = count === 0;

              // Subject-coloured 3 px left edge. Falls back to
              // the neutral input-border token when the key
              // doesn't match (shouldn't normally happen — every
              // SUBJECTS entry maps to one of the four keys).
              const leftBorderClass =
                SUBJECT_LEFT_BORDER_CLASS[s.key] || "border-l-input-border";

              return (
                <article
                  key={s.id}
                  // Outer is a div (not a button) because the
                  // card now contains two child buttons. Nesting
                  // <button> inside <button> is invalid HTML and
                  // triggers a Next.js hydration warning — see
                  // the earlier Past Papers fix for context.
                  aria-disabled={empty}
                  className={
                    "bg-card border border-input-border border-l-[3px] " +
                    leftBorderClass +
                    " rounded-4px p-5 shadow-sm flex flex-col gap-3 " +
                    "min-h-[180px] transition duration-200 ease-in-out " +
                    (empty
                      ? "opacity-60"
                      : "hover:bg-hover hover:shadow-md")
                  }
                >
                  {/* Subject badge — top-left, shared component. */}
                  <SubjectBadge subject={s} />

                  <div>
                    <h2 className="font-heading text-[22px] font-bold text-text-primary leading-tight">
                      {s.name}
                    </h2>
                    <p className="text-[13px] text-text-muted mt-0.5">
                      {s.code}
                    </p>
                  </div>

                  {empty ? (
                    <p className="text-sm text-text-muted italic mt-auto">
                      No cards yet
                    </p>
                  ) : (
                    <>
                      <p className="text-[13px] text-text-muted">
                        {count} {count === 1 ? "card" : "cards"} ·{" "}
                        {avg.toFixed(1)}/{MASTERY_MAX} mastery
                      </p>
                      <MasteryBar value={avg} />

                      {/* Action chip row — Study (outline) +
                          Quiz (filled gold). Each chip is a real
                          button so keyboard / screen-reader users
                          land directly on the action. Both still
                          route via handleSelectSubject so the
                          existing topic-selection flow continues
                          to work — the chips replace the single-
                          click affordance with clearer intent
                          per Task 6. */}
                      <div className="flex items-center gap-2 mt-auto pt-2">
                        <button
                          type="button"
                          onClick={() => handleSelectSubject(s)}
                          className={
                            "flex-1 inline-flex items-center justify-center " +
                            "gap-1.5 text-xs font-body font-body-semibold " +
                            "border border-gold text-gold rounded-4px " +
                            "px-3 py-1.5 transition hover:bg-card " +
                            "focus-visible:outline-none focus-visible:ring-2 " +
                            "focus-visible:ring-gold focus-visible:ring-offset-2 " +
                            "focus-visible:ring-offset-background"
                          }
                          aria-label={`Study ${s.name}`}
                        >
                          <BookOpen size={14} strokeWidth={2} aria-hidden="true" />
                          Study
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSelectSubject(s)}
                          className={
                            "flex-1 inline-flex items-center justify-center " +
                            "gap-1.5 text-xs font-body font-body-semibold " +
                            "bg-gold text-background rounded-4px " +
                            "px-3 py-1.5 transition hover:brightness-90 " +
                            "focus-visible:outline-none focus-visible:ring-2 " +
                            "focus-visible:ring-gold focus-visible:ring-offset-2 " +
                            "focus-visible:ring-offset-background"
                          }
                          aria-label={`Quiz ${s.name}`}
                        >
                          <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
                          Quiz
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </section>
        )}

        {/* Sample-data notice — sits below the 4 cards with a
            divider so there's no empty void between the grid
            and this status line. */}
        {usingMock && !dataLoading && (
          <div className="mt-8 pt-6 border-t border-input-border">
            <p className="text-xs text-text-hint text-center">
              Showing sample cards while your flashcard library is being
              generated. Real cards will appear here once the backend pipeline
              populates the database.
            </p>
          </div>
        )}
      </>
    );
  }


  // ─────────────────────────────────────────────────────────
  // ███████████████████████  VIEW 2  ████████████████████████
  // TOPIC SELECTION
  // ─────────────────────────────────────────────────────────
  // Renders one card per topic for the chosen subject. Each
  // topic card has two CTAs: "Study first" (outline) and
  // "Jump to quiz" (filled). Falls back to a friendly empty
  // state if no topics exist (shouldn't happen with mock data
  // but is needed once real data starts arriving).
  function renderTopicsView() {
    if (!selectedSubject) return null;

    return (
      <>
        <header className="mb-8 flex flex-col gap-3">
          <button
            type="button"
            onClick={handleBackToSubjects}
            className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary transition-colors self-start
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-4px"
          >
            <ArrowLeft size={16} strokeWidth={2} />
            All subjects
          </button>

          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-heading text-3xl md:text-4xl font-bold text-text-primary">
              {selectedSubject.name}
            </h1>
            <SubjectBadge subject={selectedSubject} label={selectedSubject.code} />
          </div>
        </header>

        {topicsForSubject.length === 0 ? (
          <section className="bg-card border border-input-border rounded-4px p-10 shadow-sm text-center max-w-xl mx-auto">
            <div className="flex justify-center mb-4">
              <BookOpen size={48} strokeWidth={1.5} className="text-gold" />
            </div>
            <h2 className="font-heading text-2xl font-bold text-text-primary mb-2">
              No cards yet for this subject
            </h2>
            <p className="text-text-muted leading-relaxed">
              Your flashcards will appear here automatically once your notes
              have been processed.
            </p>
          </section>
        ) : (
          <section
            aria-label="Topics"
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            {topicsForSubject.map((topic) => {
              const avg = avgMastery(topic.cards);
              return (
                <article
                  key={topic.note_id}
                  className="bg-card border border-input-border rounded-4px p-5 shadow-sm flex flex-col gap-4"
                >
                  <div>
                    <h3 className="font-heading text-lg font-bold text-text-primary leading-snug">
                      {topic.title}
                    </h3>
                    <p className="text-xs text-text-muted mt-1">
                      {topic.cards.length}{" "}
                      {topic.cards.length === 1 ? "card" : "cards"} ·{" "}
                      {avg.toFixed(1)}/{MASTERY_MAX}
                    </p>
                  </div>
                  <MasteryBar value={avg} />

                  <div className="flex gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => handleStudyTopic(topic)}
                      className="flex-1 border border-gold text-gold rounded-4px text-sm font-semibold py-2 hover:bg-gold hover:text-background transition-colors
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      Study first
                    </button>
                    <button
                      type="button"
                      onClick={() => handleJumpToQuiz(topic)}
                      className="flex-1 bg-gold text-background rounded-4px text-sm font-semibold py-2 hover:bg-gold-light transition-colors
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      Jump to quiz
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </>
    );
  }


  // ─────────────────────────────────────────────────────────
  // ███████████████████████  VIEW 3  ████████████████████████
  // STUDY MODE — pure CSS flip card
  // ─────────────────────────────────────────────────────────
  // HOW THE FLIP ANIMATION WORKS
  // ----------------------------------------------------------
  // The OUTER div sets a perspective via [perspective:1000px]
  // so child 3D transforms have depth instead of being
  // collapsed flat.
  //
  // The MIDDLE div is the actual flipper. It uses
  // [transform-style:preserve-3d] so its children retain
  // their own 3D positions, and a CSS transition on transform
  // for the 0.4s ease-in-out flip.
  //
  // The FRONT face is naturally positioned (rotateY 0deg).
  // The BACK face is rotated 180deg around the Y axis up-front
  // ([transform:rotateY(180deg)]) so it sits behind the front.
  // Both faces use [backface-visibility:hidden] which makes
  // the back of each face invisible — so the front disappears
  // as we rotate, and the back appears.
  //
  // When `studyFlipped` is true we apply
  // [transform:rotateY(180deg)] to the flipper, which spins
  // the whole thing around to reveal the back.
  function renderStudyView() {
    if (!selectedTopic) return null;
    const card = selectedTopic.cards[studyIndex];
    if (!card) return null;
    const isLast = studyIndex === selectedTopic.cards.length - 1;
    const progressPct =
      ((studyIndex + 1) / selectedTopic.cards.length) * 100;
    const subjectMeta = subjectIndex.byId[card.subject_id];

    return (
      <>
        <header className="mb-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={handleBackToTopics}
            className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary transition-colors self-start
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-4px"
          >
            <ArrowLeft size={16} strokeWidth={2} />
            All topics
          </button>

          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="font-heading text-2xl md:text-3xl font-bold text-text-primary">
              {selectedTopic.title}
            </h1>
            <p className="text-sm text-text-muted">
              Card {studyIndex + 1} of {selectedTopic.cards.length}
            </p>
          </div>

          {/* Thin progress bar — 3px tall as spec'd */}
          <div className="h-[3px] w-full bg-hover rounded-full overflow-hidden">
            <div
              className="h-full bg-gold transition-[width] duration-300 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </header>

        {/* ── Flip card ────────────────────────────────── */}
        <div className="mx-auto max-w-2xl w-full [perspective:1000px]">
          <div
            role="button"
            tabIndex={0}
            aria-label={
              studyFlipped
                ? "Showing answer"
                : "Showing question — click to reveal the answer"
            }
            onClick={() => !studyFlipped && setStudyFlipped(true)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !studyFlipped) {
                e.preventDefault();
                setStudyFlipped(true);
              }
            }}
            className={`relative w-full min-h-[200px] md:min-h-[280px] cursor-pointer
                        transition-transform duration-[400ms] ease-in-out
                        [transform-style:preserve-3d]
                        ${
                          studyFlipped
                            ? "[transform:rotateY(180deg)]"
                            : ""
                        }
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-4px`}
          >
            {/* ── FRONT face ───────────────────────────── */}
            <div className="absolute inset-0 [backface-visibility:hidden]
                            bg-white border border-input-border rounded-4px shadow-md
                            p-6 md:p-12 flex flex-col">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">
                Question
              </p>

              <div className="flex-1 flex items-center justify-center my-4">
                <p className="font-heading text-xl md:text-2xl font-bold text-text-primary text-center leading-snug">
                  {card.front}
                </p>
              </div>

              <div className="flex items-end justify-between gap-3">
                <p className="text-xs italic text-text-muted">
                  Tap to reveal answer
                </p>
                {subjectMeta && <SubjectBadge subject={subjectMeta} />}
              </div>
            </div>

            {/* ── BACK face ────────────────────────────── */}
            <div className="absolute inset-0 [backface-visibility:hidden]
                            [transform:rotateY(180deg)]
                            bg-white border border-input-border rounded-4px shadow-md
                            p-6 md:p-12 flex flex-col">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">
                Answer
              </p>

              <div className="flex-1 flex items-center justify-center my-4">
                <p className="text-sm md:text-base text-text-primary text-center leading-relaxed whitespace-pre-line">
                  {card.back}
                </p>
              </div>

              <div className="flex justify-end">
                {subjectMeta && <SubjectBadge subject={subjectMeta} />}
              </div>
            </div>
          </div>
        </div>

        {/* ── Navigation buttons ──────────────────────── */}
        <div className="mt-6 flex flex-col items-center gap-3">
          <div className="flex gap-3">
            <button
              type="button"
              disabled={studyIndex === 0}
              onClick={() => {
                setStudyIndex(studyIndex - 1);
                setStudyFlipped(false);
              }}
              className="border border-gold text-gold rounded-4px text-sm font-semibold py-2 px-4
                         flex items-center gap-1 hover:bg-gold hover:text-background transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gold
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <ChevronLeft size={16} strokeWidth={2} />
              Previous
            </button>

            {isLast ? (
              <button
                type="button"
                onClick={handleStartQuizFromStudy}
                className="bg-gold text-background rounded-4px text-sm font-semibold py-2 px-4
                           flex items-center gap-1 hover:bg-gold-light transition-colors
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Start Quiz
                <ChevronRight size={16} strokeWidth={2} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setStudyIndex(studyIndex + 1);
                  setStudyFlipped(false);
                }}
                className="border border-gold text-gold rounded-4px text-sm font-semibold py-2 px-4
                           flex items-center gap-1 hover:bg-gold hover:text-background transition-colors
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Next
                <ChevronRight size={16} strokeWidth={2} />
              </button>
            )}
          </div>

          {isLast && (
            <p className="text-xs text-text-muted text-center">
              Reviewed all {selectedTopic.cards.length} cards. Ready to test
              yourself?
            </p>
          )}
        </div>
      </>
    );
  }


  // ─────────────────────────────────────────────────────────
  // ███████████████████████  VIEW 4  ████████████████████████
  // QUIZ MODE
  // ─────────────────────────────────────────────────────────
  // Renders the current quiz question + four shuffled options.
  // After the user clicks one option, the buttons lock and a
  // "Next question" CTA appears. When the last question is
  // answered the page transitions to VIEW 5.
  //
  // The correct option index is held ONLY in quizOptions state.
  // We never render it as a data attribute, aria attribute, or
  // hidden span — so "view source" gives no hint of the answer.
  function renderQuizView() {
    // Render gates here cover three cases:
    //   • topic not picked yet
    //   • deck still being prepared (quizCards is briefly [])
    //   • Effect 4 hasn't generated this question's options yet
    if (!selectedTopic || quizCards.length === 0 || !quizOptions) {
      return (
        <div className="text-text-muted text-sm py-12 text-center">
          Preparing quiz…
        </div>
      );
    }

    // All counts come from `quizCards` so they reflect the
    // per-attempt deck (mastery-prioritised, shuffled, capped
    // at QUIZ_SESSION_SIZE), not the full topic.
    const total = quizCards.length;
    const card = quizCards[quizIndex];
    if (!card) {
      return (
        <div className="text-text-muted text-sm py-12 text-center">
          Preparing quiz…
        </div>
      );
    }
    const subjectMeta = subjectIndex.byId[card.subject_id];
    const progressPct = ((quizIndex + 1) / total) * 100;
    const hasAnswered = selectedOption !== null;
    const isCorrectChoice =
      hasAnswered && selectedOption === quizOptions.correctIndex;
    const isLast = quizIndex === total - 1;

    return (
      <>
        {/* ── Header ───────────────────────────────────── */}
        <header className="mb-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={handleBackToTopics}
            className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary transition-colors self-start
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-4px"
          >
            <ArrowLeft size={16} strokeWidth={2} />
            All topics
          </button>

          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="font-heading text-2xl md:text-3xl font-bold text-text-primary">
              {selectedTopic.title} <span className="text-text-muted font-medium">· Quiz</span>
            </h1>
            <p className="text-sm text-text-muted">
              {sessionScore.correct} / {total} correct
            </p>
          </div>

          <div className="h-[3px] w-full bg-hover rounded-full overflow-hidden">
            <div
              className="h-full bg-gold transition-[width] duration-300 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </header>

        {/* ── Question card ────────────────────────────── */}
        <section className="bg-card border border-input-border rounded-4px shadow-sm p-6 md:p-8 mb-5 max-w-3xl mx-auto">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-text-muted mb-3">
            Question {quizIndex + 1} of {total}
          </p>
          <h2 className="font-heading text-xl md:text-2xl font-bold text-text-primary leading-snug">
            {card.front}
          </h2>
          {subjectMeta && (
            <div className="mt-4">
              <SubjectBadge subject={subjectMeta} />
            </div>
          )}
        </section>

        {/* ── Options list ─────────────────────────────── */}
        <ul
          aria-label="Answer options"
          className="space-y-3 max-w-3xl mx-auto"
        >
          {quizOptions.options.map((opt, idx) => {
            const letter = ["A", "B", "C", "D"][idx];

            // Compute the option's visual state. Before answering
            // all options are neutral. After answering:
            //   • the user's pick → green if correct, red if wrong
            //   • the actual correct answer → always green
            //   • every other option → faded + disabled
            let stateClasses =
              "bg-card border border-input-border hover:bg-hover text-text-primary";
            if (hasAnswered) {
              const isThisCorrect = idx === quizOptions.correctIndex;
              const isThisPicked = idx === selectedOption;
              if (isThisCorrect) {
                stateClasses = "bg-green-600 border-green-700 text-white";
              } else if (isThisPicked) {
                stateClasses = "bg-red-600 border-red-700 text-white";
              } else {
                stateClasses =
                  "bg-card border-input-border text-text-muted opacity-60";
              }
            }

            return (
              <li key={idx}>
                <button
                  type="button"
                  disabled={hasAnswered}
                  onClick={() => recordAnswer(idx)}
                  className={`w-full text-left rounded-4px px-5 py-4 flex items-start gap-4 transition-colors
                              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background
                              ${stateClasses}
                              ${
                                hasAnswered
                                  ? "cursor-default"
                                  : "cursor-pointer"
                              }`}
                >
                  <span
                    className={`font-bold w-6 flex-shrink-0 ${
                      hasAnswered ? "" : "text-gold"
                    }`}
                  >
                    {letter}
                  </span>
                  <span className="flex-1 leading-relaxed">{opt}</span>
                  {hasAnswered && idx === quizOptions.correctIndex && (
                    <CheckCircle
                      size={20}
                      strokeWidth={2}
                      className="flex-shrink-0 mt-0.5"
                    />
                  )}
                  {hasAnswered &&
                    idx === selectedOption &&
                    idx !== quizOptions.correctIndex && (
                      <XCircle
                        size={20}
                        strokeWidth={2}
                        className="flex-shrink-0 mt-0.5"
                      />
                    )}
                </button>
              </li>
            );
          })}
        </ul>

        {/* ── Feedback + next button ──────────────────── */}
        {hasAnswered && (
          <div className="max-w-3xl mx-auto mt-5 flex flex-col gap-4">
            <div
              className={`rounded-4px p-4 border-l-4 ${
                isCorrectChoice
                  ? "bg-card border-green-600 text-text-primary"
                  : "bg-card border-red-600 text-text-primary"
              }`}
            >
              <p className="text-[11px] font-semibold uppercase tracking-widest text-text-muted mb-1">
                {isCorrectChoice ? "Correct" : "Not quite"}
              </p>
              <p className="text-sm leading-relaxed">
                The correct answer is:{" "}
                <span className="font-semibold">
                  {quizOptions.options[quizOptions.correctIndex]}
                </span>
              </p>
            </div>

            <button
              type="button"
              onClick={handleNextQuestion}
              className="self-end bg-gold text-background rounded-4px text-sm font-semibold py-2.5 px-5
                         flex items-center gap-2 hover:bg-gold-light transition-colors
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {isLast ? "See results" : "Next question"}
              <ChevronRight size={16} strokeWidth={2} />
            </button>
          </div>
        )}
      </>
    );
  }


  // ─────────────────────────────────────────────────────────
  // ███████████████████████  VIEW 5  ████████████████████████
  // RESULTS SCREEN
  // ─────────────────────────────────────────────────────────
  // Big score → stats grid → per-card breakdown → weak topics
  // → recommendation card → action buttons.
  function renderResultsView() {
    if (!selectedTopic || !selectedSubject) return null;

    // ── Numbers — backend wins, local fallback otherwise ──
    // If POST /quiz/complete has responded we use its envelope.
    // Otherwise we compute the same figures locally so VIEW 5
    // is fully usable even when /quiz/complete is unreachable.
    //
    // Local total comes from `quizCards` so it reflects what
    // Aisha actually answered (capped at QUIZ_SESSION_SIZE)
    // rather than every card in the topic.
    const total = serverFinalResult?.total_cards || quizCards.length;
    const correct =
      typeof serverFinalResult?.final_score === "number"
        ? serverFinalResult.final_score
        : quizAnswers.filter((a) => a.is_correct).length;
    const wrong = Math.max(0, total - correct);
    const percent =
      typeof serverFinalResult?.percentage === "number"
        ? serverFinalResult.percentage
        : total > 0
        ? Math.round((correct / total) * 100)
        : 0;

    // ── Performance label ──
    // The backend's label is the canonical one (Excellent / Good
    // / Developing / Needs Work). We map it to a colour class
    // the rest of the page already uses. If the backend hasn't
    // responded we fall back to the same four-tier client logic
    // the page shipped with — same thresholds either way.
    const serverLabel = serverFinalResult?.performance_label;
    let perfLabel;
    let perfClass;
    if (serverLabel === "Excellent") {
      perfLabel = "Excellent — Cambridge ready";
      perfClass = "text-green-600";
    } else if (serverLabel === "Good") {
      perfLabel = "Good — review weak areas";
      perfClass = "text-gold";
    } else if (serverLabel === "Developing") {
      perfLabel = "Developing — more practice needed";
      perfClass = "text-amber-600";
    } else if (serverLabel === "Needs Work") {
      perfLabel = "Needs work — revisit this topic";
      perfClass = "text-red-600";
    } else if (percent >= 90) {
      perfLabel = "Excellent — Cambridge ready";
      perfClass = "text-green-600";
    } else if (percent >= 70) {
      perfLabel = "Good — review weak areas";
      perfClass = "text-gold";
    } else if (percent >= 50) {
      perfLabel = "Developing — more practice needed";
      perfClass = "text-amber-600";
    } else {
      perfLabel = "Needs work — revisit this topic";
      perfClass = "text-red-600";
    }

    // Wrong-answer list for the "Needs More Revision" section.
    const wrongAnswers = quizAnswers.filter((a) => !a.is_correct);

    // ── Time taken ──
    // Backend value (whole seconds) overrides the client clock
    // when present. The client clock is still computed below as
    // a fallback that works in mock mode + offline situations.
    const elapsedLocalMs =
      quizEndTime && quizStartTime ? quizEndTime - quizStartTime : 0;
    const elapsed =
      typeof serverFinalResult?.time_taken_seconds === "number" &&
      serverFinalResult.time_taken_seconds > 0
        ? serverFinalResult.time_taken_seconds * 1000
        : elapsedLocalMs;

    // Recommendation message per the spec thresholds.
    let recommendation;
    if (percent >= 80) {
      recommendation =
        "Strong performance. Move to the next topic or try a full subject quiz.";
    } else if (percent >= 50) {
      recommendation = `Review the ${wrong} ${
        wrong === 1 ? "card" : "cards"
      } you missed, then retake this quiz.`;
    } else {
      recommendation =
        "Revisit the study cards for this topic before retaking the quiz.";
    }

    return (
      <>
        {/* ── Title ────────────────────────────────────── */}
        <header className="text-center mb-8">
          <h1 className="font-heading text-3xl md:text-4xl font-bold text-text-primary">
            Quiz Complete
          </h1>
          <p className="text-text-muted mt-2">
            {selectedTopic.title} · {selectedSubject.name}
          </p>
        </header>

        {/* ── Hero score ───────────────────────────────── */}
        <section className="text-center mb-8">
          <p className="font-heading text-6xl md:text-7xl font-bold text-gold leading-none">
            {correct}/{total}
          </p>
          <p className="text-text-muted mt-2 text-lg">{percent}%</p>
          <p className={`mt-2 font-semibold ${perfClass}`}>{perfLabel}</p>
        </section>

        {/* ── Stats grid ────────────────────────────────── */}
        <section className="grid grid-cols-2 gap-3 max-w-2xl mx-auto mb-10">
          <div className="bg-card border border-input-border rounded-4px p-4 text-center">
            <p className="font-heading text-3xl font-bold text-gold">{correct}</p>
            <p className="text-xs text-text-muted uppercase tracking-wide mt-1">
              Got it
            </p>
          </div>
          <div className="bg-card border border-input-border rounded-4px p-4 text-center">
            <p className="font-heading text-3xl font-bold text-red-600">
              {wrong}
            </p>
            <p className="text-xs text-text-muted uppercase tracking-wide mt-1">
              Review needed
            </p>
          </div>
          <div className="bg-card border border-input-border rounded-4px p-4 text-center">
            <p
              className={`font-heading text-3xl font-bold flex items-center justify-center gap-1
                ${
                  totalMasteryDelta > 0
                    ? "text-green-600"
                    : totalMasteryDelta < 0
                    ? "text-red-600"
                    : "text-text-muted"
                }`}
            >
              {totalMasteryDelta > 0 && (
                <TrendingUp size={22} strokeWidth={2.25} />
              )}
              {totalMasteryDelta < 0 && (
                <TrendingDown size={22} strokeWidth={2.25} />
              )}
              {totalMasteryDelta > 0 ? "+" : ""}
              {totalMasteryDelta}
            </p>
            <p className="text-xs text-text-muted uppercase tracking-wide mt-1">
              Mastery change
            </p>
          </div>
          <div className="bg-card border border-input-border rounded-4px p-4 text-center">
            <p className="font-heading text-3xl font-bold text-text-primary">
              {formatDuration(elapsed)}
            </p>
            <p className="text-xs text-text-muted uppercase tracking-wide mt-1">
              Time taken
            </p>
          </div>
        </section>

        {/* ── Per-card performance table ───────────────── */}
        <section className="max-w-3xl mx-auto mb-10">
          <h3 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted mb-3">
            Card Performance
          </h3>
          <ul className="space-y-2">
            {/* Per-card list shows only the deck Aisha actually
                saw this attempt (`quizCards`) — never the full
                topic. Without this, mastery-4 cards she didn't
                see would appear with neutral deltas and dilute
                the "what to review next" signal. */}
            {quizCards.map((card) => {
              const ans = quizAnswers.find((a) => a.card_id === card.id);
              const m = masteryByCard[card.id];
              const correctly = ans?.is_correct;
              return (
                <li
                  key={card.id}
                  className="bg-card border border-input-border rounded-4px px-4 py-3 flex items-center gap-3"
                >
                  <p className="flex-1 text-sm text-text-primary truncate">
                    {card.front}
                  </p>
                  <span
                    className={`text-[11px] font-bold px-2 py-0.5 rounded-4px
                      ${
                        m.delta > 0
                          ? "bg-green-100 text-green-700"
                          : m.delta < 0
                          ? "bg-red-100 text-red-700"
                          : "bg-hover text-text-muted"
                      }`}
                  >
                    {m.delta > 0 ? "+" : ""}
                    {m.delta}
                  </span>
                  {correctly === true && (
                    <CheckCircle
                      size={20}
                      strokeWidth={2}
                      className="text-green-600 flex-shrink-0"
                    />
                  )}
                  {correctly === false && (
                    <XCircle
                      size={20}
                      strokeWidth={2}
                      className="text-red-600 flex-shrink-0"
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {/* ── Weak topics ──────────────────────────────── */}
        {wrongAnswers.length > 0 && (
          <section className="max-w-3xl mx-auto mb-10">
            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted mb-3">
              Needs More Revision
            </h3>
            <ul className="space-y-2">
              {wrongAnswers.map((a) => (
                <li
                  key={a.card_id}
                  className="bg-card border border-input-border rounded-4px px-4 py-3"
                >
                  <p className="text-sm text-text-primary leading-relaxed">
                    {a.question}
                  </p>
                  <p className="text-xs text-text-muted mt-1 leading-relaxed">
                    Correct answer: {a.correct_answer}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Recommendation card ──────────────────────── */}
        <section className="max-w-3xl mx-auto mb-10">
          <h3 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted mb-3">
            Recommended Next Steps
          </h3>
          <div className="bg-card border border-input-border border-l-[3px] border-l-gold rounded-4px px-4 py-3">
            <p className="text-sm text-text-primary leading-relaxed">
              {recommendation}
            </p>
          </div>
        </section>

        {/* ── Action buttons ───────────────────────────── */}
        <div className="max-w-3xl mx-auto flex flex-col sm:flex-row gap-3 justify-end">
          <button
            type="button"
            onClick={handleRetakeQuiz}
            className="border border-gold text-gold rounded-4px text-sm font-semibold py-2.5 px-5
                       hover:bg-gold hover:text-background transition-colors
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Retake quiz
          </button>
          <button
            type="button"
            onClick={handleBackToTopics}
            className="bg-gold text-background rounded-4px text-sm font-semibold py-2.5 px-5
                       hover:bg-gold-light transition-colors
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Back to topics
          </button>
        </div>
      </>
    );
  }
}
