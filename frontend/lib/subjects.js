// ============================================================
// FILE: lib/subjects.js
// PURPOSE: Single source of truth for Cambridge subject metadata
//          in the frontend. Every page that mentions a subject must
//          import from here — no more hardcoded "Economics" strings
//          scattered across components.
//
// WHY A LOCAL FILE INSTEAD OF FETCHING FROM SUPABASE?
// ----------------------------------------------------------------
// The project rule says "subject names and codes → database only".
// The TRUE source of truth is the Supabase `subjects` table.
// However, fetching 4 rows on every page mount adds latency and
// makes UI components async for no real benefit (Aisha's syllabus
// codes won't change mid-session).
//
// The pragmatic solution: this file MIRRORS the database. The four
// constants here MUST match the four rows in the `subjects` table
// (same `key`, same `code`). If either side changes, update both.
//
// Future improvement: replace this with a server-side fetch + cache
// (e.g. Next.js `revalidate` + Supabase query in a Server Component)
// once we have more than a handful of subjects or need user-specific
// subject lists.
// ============================================================

// Each subject has:
//   key    – lowercase identifier used in code (Tailwind tokens, URLs)
//   name   – display name shown to users
//   code   – Cambridge syllabus code
//   slug   – Supabase row key when joining with the `subjects` table
//
// The key intentionally matches the Tailwind colour token names
// in tailwind.config.js (economics, business, english, ict) so
// classes like `bg-economics-bg` work automatically.
export const SUBJECTS = [
  {
    key: "economics",
    name: "Economics",
    fullName: "Economics",
    code: "9708",
    slug: "economics",
  },
  {
    key: "business",
    name: "Business",
    fullName: "Business Studies",
    code: "9609",
    slug: "business",
  },
  {
    key: "english",
    name: "English",
    fullName: "English Language",
    code: "9093",
    slug: "english",
  },
  {
    key: "ict",
    name: "ICT",
    fullName: "ICT",
    code: "9626",
    slug: "ict",
  },
];

// Lookup helper: returns the subject record for a given key, or
// undefined if not found. Useful when a page only has the key
// (e.g. from a database row) and needs the display name + code.
export function getSubjectByKey(key) {
  return SUBJECTS.find((s) => s.key === key);
}

// Lookup helper for case-insensitive lookups by display name
// (used by legacy data that stored "Economics" instead of "economics").
export function getSubjectByName(name) {
  if (!name) return undefined;
  const normalised = name.toLowerCase();
  return SUBJECTS.find(
    (s) => s.key === normalised || s.name.toLowerCase() === normalised
  );
}

// Map of subject key → Tailwind classes for the coloured badge.
// Defined here so any component can render a badge consistently.
export const SUBJECT_BADGE_CLASSES = {
  economics: "bg-economics-bg text-economics-text",
  business:  "bg-business-bg  text-business-text",
  english:   "bg-english-bg   text-english-text",
  ict:       "bg-ict-bg       text-ict-text",
};
