// ============================================================
// FILE: app/components/PWAInstallBanner.js
// PURPOSE: Bottom install prompt when the browser supports PWA install.
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

/*
  PWAInstallBanner — shows an install prompt when the app
  can be installed as a PWA on the user's device.
  Appears at the bottom of the screen.
  Can be dismissed and won't show again for 7 days.
*/

const DISMISS_KEY = "ascendai-pwa-dismissed";

export default function PWAInstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    // Check if dismissed recently (7-day cooldown)
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (dismissed) {
      const dismissedDate = new Date(dismissed);
      const daysSince =
        (Date.now() - dismissedDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 7) return;
    }

    // Listen for browser install prompt (Chrome, Edge, etc.)
    const onBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowBanner(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () =>
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log("[PWA] Install outcome:", outcome);
    setDeferredPrompt(null);
    setShowBanner(false);
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setShowBanner(false);
  };

  return (
    <AnimatePresence>
      {showBanner && (
        <motion.div
          initial={{ opacity: 0, y: 80 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 80 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="pwa-install-banner"
          style={{
            position: "fixed",
            bottom: 80,
            left: "50%",
            transform: "translateX(-50%)",
            width: "min(400px, calc(100vw - 32px))",
            background: "var(--card)",
            border: "0.5px solid var(--gold-dim)",
            borderRadius: 12,
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            zIndex: 998,
          }}
        >
          {/* App icon placeholder */}
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: "var(--gold)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              fontFamily: "var(--font-playfair), 'Playfair Display', serif",
              fontSize: 18,
              fontWeight: 700,
              color: "var(--bg)",
            }}
          >
            A
          </div>

          {/* Text */}
          <div style={{ flex: 1 }}>
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 13,
                fontWeight: 500,
                color: "var(--text)",
                margin: 0,
              }}
            >
              Install AscendAI
            </p>
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 11,
                color: "var(--text-muted)",
                margin: "2px 0 0",
              }}
            >
              Add to home screen for quick access
            </p>
          </div>

          {/* Install button */}
          <button
            type="button"
            onClick={handleInstall}
            style={{
              background: "var(--gold)",
              border: "none",
              borderRadius: 6,
              padding: "7px 14px",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              fontWeight: 500,
              color: "var(--bg)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            Install
          </button>

          {/* Dismiss */}
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss install prompt"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              padding: 4,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

