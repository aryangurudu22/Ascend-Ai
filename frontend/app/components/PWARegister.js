// ============================================================
// FILE: app/components/PWARegister.js
// PURPOSE: Registers the AscendAI service worker on app load.
// ============================================================

"use client";

import { useEffect } from "react";

/*
  PWARegister — registers the service worker on app load.
  Only runs when the browser supports service workers.
  Service worker handles offline caching of app shell routes.
*/

export default function PWARegister() {
  useEffect(() => {
    // Only register if browser supports service workers
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          console.log("[PWA] Service worker registered:", registration.scope);
        })
        .catch((error) => {
          console.log("[PWA] Service worker registration failed:", error);
        });
    };

    // Register after full page load so /sw.js is available
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  // This component renders nothing — side effect only
  return null;
}
