// ============================================================
// FILE: app/components/PageTransition.js
// PURPOSE: Route-change feedback — gold top progress bar plus
//          branded full-screen loader when navigation is slow.
// ============================================================

"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export default function PageTransition() {
  // Track progress bar width from 0 through 100 (percentage).
  const [progress, setProgress] = useState(0);

  // Whether the thin gold bar is mounted at the top of the viewport.
  const [visible, setVisible] = useState(false);

  // Full-screen AscendAI loader — only after 500ms on the same navigation.
  const [showLoader, setShowLoader] = useState(false);

  // Current URL path — effect re-runs on every client-side navigation.
  const pathname = usePathname();

  useEffect(() => {
    // Show bar and reset progress when the route changes.
    setVisible(true);
    setProgress(0);
    setShowLoader(false);

    // Quick jump to 30% so motion feels immediate.
    const t1 = setTimeout(() => setProgress(30), 50);

    // Ease toward halfway while RSC may still be loading.
    const t2 = setTimeout(() => setProgress(60), 200);

    // Reveal branded overlay only if this transition feels slow.
    const t3 = setTimeout(() => setShowLoader(true), 500);

    // Nearly complete before we snap to 100%.
    const t4 = setTimeout(() => setProgress(90), 400);

    // Finish bar and hide loader together.
    const t5 = setTimeout(() => {
      setProgress(100);
      setShowLoader(false);
    }, 600);

    // Tear down bar after a short settle so the sweep reads clearly.
    const t6 = setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 900);

    // Cancel pending timers if user navigates again mid-sequence.
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
      clearTimeout(t6);
    };
  }, [pathname]);

  return (
    <>
      {/* Gold progress bar — fixed strip at the very top of the viewport */}
      {visible ? (
        <div
          aria-hidden
          style={{
            position: "fixed", // Pin to viewport so scroll does not move the bar
            top: 0, // Flush with top edge
            left: 0, // Start sweep from the left
            height: "2.5px", // Thin line as specified
            width: `${progress}%`, // Grows with simulated load progress
            background: "linear-gradient(90deg, var(--gold), var(--gold-icon))", // Tokens only — no raw rgba
            transition: "width 200ms ease", // Smooth width changes between steps
            zIndex: 9999, // Above page chrome and loader overlay
            borderRadius: "0 2px 2px 0", // Soft cap on the leading edge
          }}
        />
      ) : null}

      {/* Branded loader — navy background matches app shell */}
      {showLoader ? (
        <div
          aria-busy="true"
          aria-live="polite"
          style={{
            position: "fixed", // Cover entire viewport
            inset: 0, // Top/right/bottom/left all zero
            background: "var(--bg)", // App background token
            zIndex: 9998, // Below progress bar but above routed content
            display: "flex", // Flexbox for vertical stacking
            flexDirection: "column", // Logo above spinner
            alignItems: "center", // Centre horizontally
            justifyContent: "center", // Centre vertically
            gap: "16px", // Space between logo and spinner
          }}
        >
          {/* Wordmark — same serif + gold token as marketing */}
          <div
            style={{
              fontFamily: "'Playfair Display', serif", // Heading font family
              fontSize: "28px", // Prominent lockup size
              color: "var(--gold)", // Brand gold from design system
              letterSpacing: "0.02em", // Slight air between letters
            }}
          >
            AscendAI
          </div>

          {/* Spinner uses shared @keyframes spin from globals.css */}
          <div
            style={{
              width: "28px", // Spinner diameter
              height: "28px", // Keep circle square
              border: "2px solid var(--gold-border-hover)", // Dim ring (token)
              borderTop: "2px solid var(--gold)", // Active arc colour
              borderRadius: "50%", // Circular spinner
              animation: "spin 0.8s linear infinite", // Continuous rotation
            }}
          />
        </div>
      ) : null}
    </>
  );
}
