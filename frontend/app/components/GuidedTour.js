// ============================================================
// FILE: app/components/GuidedTour.js
// PURPOSE: Full-screen guided tour overlay — spotlights UI
//          targets one-by-one with tooltips for new users.
// ============================================================

"use client";

import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";

// Tooltip width in pixels — used for horizontal centering and clamping.
const TOOLTIP_WIDTH = 280;

// Estimated tooltip height for positioning above targets (position: top).
const TOOLTIP_EST_HEIGHT = 200;

// Padding around each spotlight cutout beyond the target element bounds.
const SPOTLIGHT_PAD = 8;

// Eight stops — each maps a DOM id to title, copy, and tooltip placement.
const TOUR_STEPS = [
  {
    targetId: "tour-greeting",
    title: "Your Dashboard",
    desc: "This is your command centre. Your daily sessions, exam countdown and latest notes — all in one place.",
    position: "bottom",
  },
  {
    targetId: "tour-accordion",
    title: "Explore All Features",
    desc: "Hover over these cards to expand them. Each one takes you to a key study tool — homework, notes, flashcards, timetable and more.",
    position: "bottom",
  },
  {
    targetId: "tour-stats",
    title: "Your Weekly Progress",
    desc: "Track sessions completed, hours studied and questions asked. These update in real time as you study.",
    position: "bottom",
  },
  {
    targetId: "tour-sessions",
    title: "Today's Study Sessions",
    desc: "Your AI-generated timetable shows exactly what to study today. Tick sessions as you complete them.",
    position: "top",
  },
  {
    targetId: "tour-search",
    title: "Quick Search",
    desc: "Press Ctrl+K anywhere to instantly search across your notes, homework history and flashcards.",
    position: "bottom",
  },
  {
    targetId: "tour-bell",
    title: "Notifications",
    desc: "Get notified when your timetable is ready, flashcards are created or your exam is approaching.",
    position: "bottom",
  },
  {
    targetId: "tour-profile",
    title: "Profile and Settings",
    desc: "Access your profile, manage study preferences and set up email reminders from here.",
    position: "bottom",
  },
  {
    targetId: "tour-chat",
    title: "Your Study Companion",
    desc: "Click this anytime to chat with Ace — your AI study companion. Ask anything about Cambridge AS Level.",
    position: "top",
  },
];

/**
 * GuidedTour — renders spotlight overlay + tooltip for onboarding.
 * @param {{ onClose: () => void }} props — called when user skips or finishes.
 */
export default function GuidedTour({ onClose }) {
  // step — index into TOUR_STEPS (0-based).
  const [step, setStep] = useState(0);

  // spotlightRect — pixel box around the highlighted element (with padding).
  const [spotlightRect, setSpotlightRect] = useState(null);

  // tooltipStyle — fixed position for the tooltip card (top/left).
  const [tooltipStyle, setTooltipStyle] = useState({});

  // currentStep — active tour stop config for this step index.
  const currentStep = TOUR_STEPS[step];

  // isLastStep — true on the final stop (shows Finish instead of Next).
  const isLastStep = step === TOUR_STEPS.length - 1;

  // measureTarget — finds the DOM node and updates spotlight + tooltip position.
  const measureTarget = useCallback(() => {
    // Guard when step index is out of range.
    if (!currentStep) return;

    // Look up the element by the id on the page (dashboard / navbar / chat).
    const el = document.getElementById(currentStep.targetId);

    // If missing, clear spotlight so full dim overlay shows until user advances.
    if (!el) {
      setSpotlightRect(null);
      setTooltipStyle({
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      });
      return;
    }

    // Read viewport-relative bounding box of the target.
    const rect = el.getBoundingClientRect();

    // Spotlight box with 8px padding on every side.
    const spot = {
      top: rect.top - SPOTLIGHT_PAD,
      left: rect.left - SPOTLIGHT_PAD,
      width: rect.width + SPOTLIGHT_PAD * 2,
      height: rect.height + SPOTLIGHT_PAD * 2,
    };

    setSpotlightRect(spot);

    // Viewport dimensions for clamping tooltip horizontally.
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Default: place tooltip below the spotlight.
    let tooltipTop = rect.bottom + 16;

    // If position is top, place tooltip above the spotlight.
    if (currentStep.position === "top") {
      tooltipTop = rect.top - TOOLTIP_EST_HEIGHT - 16;
    }

    // Center tooltip on spotlight horizontally.
    let tooltipLeft = spot.left + spot.width / 2 - TOOLTIP_WIDTH / 2;

    // Clamp left so tooltip stays inside viewport with 12px margin.
    tooltipLeft = Math.max(12, Math.min(tooltipLeft, vw - TOOLTIP_WIDTH - 12));

    // Clamp top so tooltip does not go off-screen.
    tooltipTop = Math.max(12, Math.min(tooltipTop, vh - TOOLTIP_EST_HEIGHT - 12));

    setTooltipStyle({
      top: tooltipTop,
      left: tooltipLeft,
    });
  }, [currentStep]);

  // Re-measure when step changes and on scroll/resize while tour is open.
  useEffect(() => {
    measureTarget();

    const onLayoutChange = () => measureTarget();

    window.addEventListener("resize", onLayoutChange);
    window.addEventListener("scroll", onLayoutChange, true);

    return () => {
      window.removeEventListener("resize", onLayoutChange);
      window.removeEventListener("scroll", onLayoutChange, true);
    };
  }, [step, measureTarget]);

  // handleNext — advance step or close on the last stop.
  const handleNext = () => {
    if (isLastStep) {
      onClose();
    } else {
      setStep((s) => s + 1);
    }
  };

  // handleSkip — close immediately without finishing all steps.
  const handleSkip = () => {
    onClose();
  };

  // Spotlight right/bottom edges for the four dimming rectangles.
  const spotRight = spotlightRect
    ? spotlightRect.left + spotlightRect.width
    : 0;
  const spotBottom = spotlightRect
    ? spotlightRect.top + spotlightRect.height
    : 0;

  return (
    // Outer shell — fixed full viewport; pointer-events none except on tooltip.
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9990,
        pointerEvents: "none",
      }}
      aria-live="polite"
      role="dialog"
      aria-label="Guided tour"
    >
      {/* Four dim panels — darken everything except the spotlight hole. */}
      {spotlightRect ? (
        <>
          {/* Top band — from viewport top down to spotlight top. */}
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              height: spotlightRect.top,
              background: "var(--chat-panel-shadow)",
              pointerEvents: "auto",
            }}
          />
          {/* Bottom band — from spotlight bottom to viewport bottom. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{
              position: "fixed",
              top: spotBottom,
              left: 0,
              right: 0,
              bottom: 0,
              background: "var(--chat-panel-shadow)",
              pointerEvents: "auto",
            }}
          />
          {/* Left band — left of spotlight between top and bottom of hole. */}
          <div
            style={{
              position: "fixed",
              top: spotlightRect.top,
              left: 0,
              width: spotlightRect.left,
              height: spotlightRect.height,
              background: "var(--chat-panel-shadow)",
              pointerEvents: "auto",
            }}
          />
          {/* Right band — right of spotlight between top and bottom of hole. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{
              position: "fixed",
              top: spotlightRect.top,
              left: spotRight,
              right: 0,
              height: spotlightRect.height,
              background: "var(--chat-panel-shadow)",
              pointerEvents: "auto",
            }}
          />
        </>
      ) : (
        // Full-screen dim when target element is not found.
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--chat-panel-shadow)",
            pointerEvents: "auto",
          }}
        />
      )}

      {/* Gold border ring around the spotlight cutout. */}
      {spotlightRect ? (
        <motion.div
          layout
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          style={{
            position: "fixed",
            top: spotlightRect.top,
            left: spotlightRect.left,
            width: spotlightRect.width,
            height: spotlightRect.height,
            border: "2px solid var(--gold)",
            borderRadius: 10,
            pointerEvents: "none",
            zIndex: 9991,
            boxShadow: "0 0 0 4px var(--gold-dim)",
          }}
        />
      ) : null}

      {/* Tooltip card — title, description, progress dots, actions. */}
      <motion.div
        key={step}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        style={{
          position: "fixed",
          width: TOOLTIP_WIDTH,
          background: "var(--card)",
          border: "0.5px solid var(--gold-border)",
          borderRadius: 12,
          padding: 20,
          zIndex: 9995,
          pointerEvents: "all",
          boxShadow: "0 8px 32px var(--chat-panel-shadow)",
          ...tooltipStyle,
        }}
      >
        {/* Step counter — e.g. Step 1 of 8 */}
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--date-color)",
            marginBottom: 6,
            marginTop: 0,
          }}
        >
          Step {step + 1} of {TOUR_STEPS.length}
        </p>

        {/* Stop title */}
        <h3
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 16,
            color: "var(--text)",
            fontWeight: 700,
            marginBottom: 6,
            marginTop: 0,
          }}
        >
          {currentStep?.title}
        </h3>

        {/* Stop description */}
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--text-muted)",
            lineHeight: 1.6,
            marginBottom: 16,
            marginTop: 0,
          }}
        >
          {currentStep?.desc}
        </p>

        {/* Footer — progress dots on the left, Skip + Next on the right */}
        <motion.div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          {/* Progress dots */}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                aria-hidden
                style={{
                  width: i === step ? 8 : 6,
                  height: i === step ? 8 : 6,
                  borderRadius: "50%",
                  background:
                    i === step ? "var(--gold)" : "var(--gold-border-hover)",
                  display: "inline-block",
                  transition: "all 200ms ease",
                }}
              />
            ))}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              onClick={handleSkip}
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 12,
                color: "var(--text-muted)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Skip tour
            </button>
            <button
              type="button"
              onClick={handleNext}
              style={{
                background: "var(--gold)",
                border: "none",
                borderRadius: 6,
                padding: "7px 16px",
                fontFamily: "Inter, sans-serif",
                fontSize: 12,
                fontWeight: 500,
                color: "var(--bg)",
                cursor: "pointer",
              }}
            >
              {isLastStep ? "Finish ✓" : "Next →"}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
