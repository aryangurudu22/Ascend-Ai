// ============================================================
// FILE: app/components/GrainOverlay.js
// PURPOSE: Reusable film-grain overlay (optional alternative to
//          the .grain-overlay class in layout.js).
// ============================================================

"use client";

/*
  GrainOverlay — subtle film grain texture applied to all pages
  Fixed position, covers entire screen, pointer-events none
  Opacity controlled by CSS variable --grain-opacity
  Automatically adjusts between dark (0.04) and light (0.025) modes
*/

export default function GrainOverlay() {
  return (
    <div
      aria-hidden="true"
      className="grain-overlay"
    />
  );
}
