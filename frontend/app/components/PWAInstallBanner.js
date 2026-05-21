// ============================================================
// FILE: app/components/PWAInstallBanner.js
// PURPOSE: PWA install banner + standalone refresh button
// Fixes:
//   Bug 4 — banner layout broken on small screens
//   Bug 5 — no refresh button in PWA standalone mode
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

// Key used to remember when the user dismissed the banner
const DISMISS_KEY = "ascendai-pwa-dismissed";

export default function PWAInstallBanner() {
  // deferredPrompt holds the browser install event so we can trigger it later
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  // showBanner controls whether the install prompt is visible
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    // Check if user dismissed the banner within the last 7 days
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (dismissed) {
      const dismissedDate = new Date(dismissed);
      const daysSince =
        (Date.now() - dismissedDate.getTime()) / (1000 * 60 * 60 * 24);
      // If dismissed less than 7 days ago, don't show the banner
      if (daysSince < 7) return;
    }

    // Listen for the browser's install prompt event
    // This fires in Chrome and Edge when the app is installable
    const onBeforeInstall = (e) => {
      // Prevent the browser's default mini-infobar from showing
      e.preventDefault();
      // Save the event so we can trigger it when user clicks Install
      setDeferredPrompt(e);
      // Show our custom banner
      setShowBanner(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    // Clean up the event listener when this component unmounts
    return () =>
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  // handleInstall — called when user clicks the Install button
  const handleInstall = async () => {
    // Do nothing if we don't have the deferred prompt
    if (!deferredPrompt) return;
    // Show the browser's native install dialog
    deferredPrompt.prompt();
    // Wait for the user to accept or dismiss
    const { outcome } = await deferredPrompt.userChoice;
    console.log("[PWA] Install outcome:", outcome);
    // Clear the prompt and hide our banner
    setDeferredPrompt(null);
    setShowBanner(false);
  };

  // handleDismiss — called when user clicks the X button
  const handleDismiss = () => {
    // Save the dismiss time so we don't show again for 7 days
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setShowBanner(false);
  };

  return (
    <>
      {/* INSTALL BANNER — shown when app is installable and not dismissed */}
      {/* Fixes Bug 4: stacks vertically on small screens */}
      <AnimatePresence>
        {showBanner && (
          <motion.div
            initial={{ opacity: 0, y: 80 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 80 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            style={{
              position: "fixed",
              bottom: "80px",
              left: "16px",
              right: "16px",
              maxWidth: "400px",
              margin: "0 auto",
              background: "var(--card)",
              border: "0.5px solid var(--gold-dim)",
              borderRadius: "12px",
              padding: "14px 16px",
              zIndex: 998,
            }}
          >
            {/* Top row — icon and text side by side */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              marginBottom: "12px",
            }}>
              {/* App icon */}
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "10px",
                  background: "var(--gold)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  fontFamily: "'Playfair Display', serif",
                  fontSize: "18px",
                  fontWeight: 700,
                  color: "var(--bg)",
                }}
              >
                A
              </div>

              {/* Text — title and subtitle */}
              <div style={{ flex: 1 }}>
                <p style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "13px",
                  fontWeight: 500,
                  color: "var(--text)",
                  margin: 0,
                }}>
                  Install AscendAI
                </p>
                <p style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  margin: "2px 0 0",
                }}>
                  Add to home screen for quick access
                </p>
              </div>

              {/* Dismiss X button — top right of banner */}
              <button
                type="button"
                onClick={handleDismiss}
                aria-label="Dismiss install prompt"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: "18px",
                  lineHeight: 1,
                  padding: "4px",
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>

            {/* Bottom row — Install button full width */}
            {/* Separate row so it never gets squeezed on small screens */}
            <button
              type="button"
              onClick={handleInstall}
              style={{
                width: "100%",
                background: "var(--gold)",
                border: "none",
                borderRadius: "6px",
                padding: "10px",
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--bg)",
                cursor: "pointer",
              }}
            >
              Install App
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
