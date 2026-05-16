// ============================================================
// FILE: app/components/SubjectBadge.js
// PURPOSE: Coloured subject chip using CSS variables (dark/light).
// Backward-compatible with existing pages that pass subject
// objects or a custom label prop until pages are migrated.
// ============================================================

"use client";

/*
  SubjectBadge — coloured chip showing subject name
  Uses CSS variables for colours so it works in both
  dark and light mode automatically

  Props:
  - subject: 'economics' | 'business' | 'english' | 'ict' | object | string
  - showCode: boolean — show syllabus code after name
  - size: 'sm' (default) | 'md'
  - label: optional override for display text (legacy pages)
*/

const SUBJECT_CONFIG = {
  economics: {
    label: "Economics",
    code: "9708",
    bgVar: "var(--econ-bg)",
    textVar: "var(--econ-text)",
    accentVar: "var(--econ-accent)",
  },
  business: {
    label: "Business",
    code: "9609",
    bgVar: "var(--biz-bg)",
    textVar: "var(--biz-text)",
    accentVar: "var(--biz-accent)",
  },
  english: {
    label: "English",
    code: "9093",
    bgVar: "var(--eng-bg)",
    textVar: "var(--eng-text)",
    accentVar: "var(--eng-accent)",
  },
  ict: {
    label: "ICT",
    code: "9626",
    bgVar: "var(--ict-bg)",
    textVar: "var(--ict-text)",
    accentVar: "var(--ict-accent)",
  },
};

const NAME_TO_KEY = {
  economics: "economics",
  "business studies": "business",
  business: "business",
  "english language": "english",
  english: "english",
  ict: "ict",
};

// Normalise legacy subject props (string key, display name, or DB row).
function resolveSubjectKey(subject) {
  if (!subject) return "economics";
  if (typeof subject === "string") {
    const lower = subject.toLowerCase().trim();
    if (SUBJECT_CONFIG[lower]) return lower;
    return NAME_TO_KEY[lower] || "economics";
  }
  if (subject.key && SUBJECT_CONFIG[subject.key]) return subject.key;
  if (subject.name) {
    const fromName = NAME_TO_KEY[String(subject.name).toLowerCase().trim()];
    if (fromName) return fromName;
  }
  return "economics";
}

export default function SubjectBadge({
  subject,
  showCode = false,
  size = "sm",
  label,
}) {
  const key = resolveSubjectKey(subject);
  const config = SUBJECT_CONFIG[key] || SUBJECT_CONFIG.economics;

  const padding = size === "md" ? "4px 12px" : "2px 9px";
  const fontSize = size === "md" ? "11px" : "10px";

  const displayLabel = label || config.label;
  const text = showCode ? `${displayLabel} ${config.code}` : displayLabel;

  return (
    <span
      style={{
        backgroundColor: config.bgVar,
        color: config.textVar,
        padding,
        fontSize,
        fontWeight: 500,
        fontFamily: "Inter, sans-serif",
        borderRadius: "3px",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        display: "inline-block",
        flexShrink: 0,
        transition: "background-color 300ms ease, color 300ms ease",
      }}
    >
      {text}
    </span>
  );
}

export { SUBJECT_CONFIG };
