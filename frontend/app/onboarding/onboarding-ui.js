// ============================================================
// FILE: app/onboarding/onboarding-ui.js
// PURPOSE: Shared layout pieces for all 5 onboarding steps —
//          progress dots, back button, headings, continue CTA.
//          Colours use globals.css CSS variables only.
// ============================================================

"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";

// Total steps in the onboarding funnel (used by progress dots).
const TOTAL_STEPS = 5;

// Outer page wrapper — full viewport centred card layout.
export const onboardingOuterStyle = {
  minHeight: "100vh",
  background: "var(--bg)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

// Inner card column — max 480px centred content.
export const onboardingInnerStyle = {
  maxWidth: "480px",
  width: "100%",
  position: "relative",
};

/**
 * ProgressDots — shows which step the user is on (1–5).
 * Dots 1..currentStep are filled gold; the rest are inactive.
 */
export function ProgressDots({ step }) {
  return (
    <div
      style={{ display: "flex", gap: "8px", justifyContent: "center", marginBottom: "20px" }}
      aria-label={`Step ${step} of ${TOTAL_STEPS}`}
    >
      {Array.from({ length: TOTAL_STEPS }, (_, i) => {
        const index = i + 1;
        const active = index <= step;
        return (
          <span
            key={index}
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: active ? "var(--gold)" : "var(--card-hover)",
              border: active ? "none" : "0.5px solid var(--gold-border-hover)",
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * BackButton — 32px circle; steps 2–5 only (step 1 has no back).
 */
export function BackButton({ href }) {
  return (
    <Link
      href={href}
      aria-label="Go to previous step"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "32px",
        height: "32px",
        borderRadius: "50%",
        background: "var(--card)",
        border: "0.5px solid var(--gold-border-hover)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        textDecoration: "none",
        color: "var(--text-muted)",
        transition: "border-color 200ms, color 200ms",
      }}
      className="onboarding-back-btn"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
    </Link>
  );
}

/** StepLabel — "STEP X OF 5" uppercase line above the heading. */
export function StepLabel({ step }) {
  return (
    <p
      style={{
        fontFamily: "Inter, sans-serif",
        fontSize: "11px",
        fontWeight: 500,
        letterSpacing: "0.1em",
        color: "var(--date-color)",
        textTransform: "uppercase",
        textAlign: "center",
        marginBottom: "16px",
        marginTop: 0,
      }}
    >
      Step {step} of {TOTAL_STEPS}
    </p>
  );
}

/** OnboardingHeading — Playfair 32px centred title. */
export function OnboardingHeading({ children }) {
  return (
    <h1
      style={{
        fontFamily: "'Playfair Display', serif",
        fontSize: "32px",
        color: "var(--text)",
        fontWeight: 700,
        textAlign: "center",
        marginBottom: "8px",
        lineHeight: 1.2,
        marginTop: 0,
      }}
    >
      {children}
    </h1>
  );
}

/** OnboardingSubheading — Inter 14px muted centred subtitle. */
export function OnboardingSubheading({ children }) {
  return (
    <p
      style={{
        fontFamily: "Inter, sans-serif",
        fontSize: "14px",
        color: "var(--text-muted)",
        textAlign: "center",
        marginBottom: "32px",
        lineHeight: 1.5,
        marginTop: 0,
      }}
    >
      {children}
    </p>
  );
}

/**
 * OnboardingShell — wraps every step with outer layout + optional back.
 * Includes hover styles for the back button via injected <style>.
 */
export function OnboardingShell({ step, backHref, children }) {
  return (
    <main style={onboardingOuterStyle}>
      <style>{`
        .onboarding-back-btn:hover {
          border-color: var(--gold) !important;
          color: var(--gold) !important;
        }
        @media (max-width: 480px) {
          main { padding: 16px !important; }
        }
      `}</style>
      <div style={{ ...onboardingInnerStyle, paddingTop: backHref ? "44px" : 0 }}>
        {backHref ? <BackButton href={backHref} /> : null}
        <ProgressDots step={step} />
        <StepLabel step={step} />
        {children}
      </div>
    </main>
  );
}

/**
 * ContinueButton — full-width gold CTA; shows spinner when loading.
 */
export function ContinueButton({ onClick, href, disabled, loading, children }) {
  const sharedStyle = {
    width: "100%",
    height: "52px",
    background: "var(--gold)",
    border: "none",
    borderRadius: "8px",
    fontFamily: "Inter, sans-serif",
    fontSize: "15px",
    fontWeight: 500,
    color: "var(--bg)",
    cursor: disabled || loading ? "not-allowed" : "pointer",
    marginTop: "24px",
    transition: "opacity 200ms",
    opacity: disabled || loading ? 0.6 : 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    textDecoration: "none",
  };

  if (href) {
    return (
      <Link href={href} style={sharedStyle} className="onboarding-continue-btn">
        {children}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      style={sharedStyle}
      className="onboarding-continue-btn"
      onMouseEnter={(e) => {
        if (!disabled && !loading) e.currentTarget.style.opacity = "0.9";
      }}
      onMouseLeave={(e) => {
        if (!disabled && !loading) e.currentTarget.style.opacity = "1";
      }}
    >
      {loading ? <Loader2 size={18} className="animate-spin" aria-hidden /> : null}
      {loading ? "Saving…" : children}
    </button>
  );
}
