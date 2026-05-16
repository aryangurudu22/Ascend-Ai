// ============================================================
// FILE: app/components/PageHeader.js
// PURPOSE: One canonical header used at the top of EVERY feature
//          page (Homework, Notes, Flashcards, Timetable, Past
//          Papers). Replaces the five different header styles
//          that drifted across the codebase.
//
// WHY A SHARED COMPONENT?
// Before this, each page invented its own H1 + subtitle + action
// layout — sizes, margins, fonts, even gold underlines, all
// slightly different. That made the product feel like it was
// stitched together from multiple drafts. Centralising the
// header into one file guarantees pixel-perfect consistency and
// makes future tweaks (e.g. adding a global "Help" link) a
// one-line change.
//
// PROJECT RULES THIS FILE OBEYS
//   • No hardcoded colours — every colour comes from a Tailwind
//     token in tailwind.config.js.
//   • No inline styles.
//   • Only Lucide React icons.
//   • No new npm packages.
// ============================================================

"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/**
 * PageHeader — the shared title bar for every feature page.
 *
 * Props:
 *   title     — string. Page title (rendered in Playfair Display
 *               at 32 px). Required.
 *   subtitle  — string. Page subtitle (Inter, text-muted). Optional;
 *               omitted entirely if not supplied.
 *   backLabel — string. Text shown next to the back chevron.
 *               Defaults to "Dashboard".
 *   backHref  — string. URL the back chevron navigates to.
 *               Defaults to "/dashboard". Uses Next.js Link so
 *               navigation stays client-side (no full reload).
 *   action    — ReactNode. Optional right-side slot. Each feature
 *               page passes its primary CTA here (Sync Now,
 *               Upload Paper, Generate Now, etc.). When null /
 *               undefined, the slot collapses gracefully and the
 *               title sits alone.
 */
export default function PageHeader({
  title,
  subtitle,
  backLabel = "Dashboard",
  backHref = "/dashboard",
  action = null,
}) {
  return (
    <header
      // 1 px bottom border + 24 px bottom padding form the
      // subtle horizontal rule below every page header. The
      // 32 px margin-bottom separates it from the page body.
      className="border-b border-input-border pb-6 mb-8"
    >
      {/* ── Breadcrumb row ────────────────────────────────────
          Two stacked lines:
            1. clickable "‹ Dashboard" back link
            2. plain text trail: "Dashboard › <Page Name>"
          Padding-bottom 12 px keeps it visually grouped with
          the title that sits underneath. */}
      <div className="pb-3">
        <Link
          href={backHref}
          className={
            "inline-flex items-center gap-1 text-text-muted font-body " +
            "text-sm hover:text-gold transition-colors focus:outline-none " +
            "focus:underline"
          }
        >
          <ChevronLeft size={16} aria-hidden="true" className="text-gold" />
          {backLabel}
        </Link>
        <p className="font-body text-text-muted text-xs mt-1">
          {backLabel} › {title}
        </p>
      </div>

      {/* ── Title + action row ───────────────────────────────
          On mobile this stacks (action below subtitle) so a
          long title never pushes the CTA off-screen. From the
          sm breakpoint up it sits as a single row. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1
            // 32 px desktop, 30 px mobile — sm:text-[32px] hits
            // the spec's exact pixel value without leaving the
            // Tailwind utility system.
            className={
              "font-heading text-text-primary text-3xl sm:text-[32px] " +
              "font-heading-bold leading-tight"
            }
          >
            {title}
          </h1>

          {/* Gold underline — 2 px tall, 48 px wide. Always
              renders so the header has a consistent visual
              anchor between title and subtitle. */}
          <div
            aria-hidden="true"
            className="h-[2px] w-12 bg-gold mt-2 mb-1.5"
          />

          {subtitle && (
            <p className="font-body text-text-muted text-sm leading-relaxed">
              {subtitle}
            </p>
          )}
        </div>

        {/* Right-side action slot. Rendered inside a flex item
            so the parent's `sm:items-start` keeps it pinned to
            the top of the row regardless of subtitle length. */}
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
    </header>
  );
}
