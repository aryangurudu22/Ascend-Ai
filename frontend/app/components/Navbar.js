// ============================================================
// FILE: app/components/Navbar.js
// PURPOSE: Global sticky navigation — logo, actions, theme toggle.
// Uses CSS variables from globals.css (no hardcoded colours).
// ============================================================

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useTheme } from "@/app/context/ThemeContext";
import { supabase } from "@/lib/supabaseClient";

const iconButtonBase = {
  width: 34,
  height: 34,
  borderRadius: "50%",
  background: "var(--nav-icon-bg)",
  border: "0.5px solid var(--nav-icon-border)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--nav-icon-color)",
};

// Shared circular icon button — search, bell, theme, profile
function NavIconButton({ ariaLabel, onClick, children, style = {}, className = "" }) {
  return (
    <motion.button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={className}
      style={{ ...iconButtonBase, ...style }}
      whileHover={{
        backgroundColor: "var(--nav-icon-hover-bg)",
        scale: 1.05,
      }}
      transition={{ duration: 0.2 }}
    >
      {children}
    </motion.button>
  );
}

export default function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();

  const handleProfileClick = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  return (
    <motion.nav
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: "var(--navbar-bg)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--navbar-border-bottom)",
        padding: `0 var(--page-padding)`,
        height: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        transition: "background 300ms ease, border-color 300ms ease",
      }}
    >
      {/* LEFT — AscendAI logo + tagline (links to dashboard) */}
      <Link
        href="/dashboard"
        style={{ textDecoration: "none", display: "flex", flexDirection: "column" }}
      >
        <span
          style={{
            fontFamily: "var(--font-playfair), 'Playfair Display', serif",
            fontSize: 26,
            color: "var(--gold)",
            letterSpacing: "-0.01em",
            fontWeight: 700,
            lineHeight: 1,
            marginBottom: 2,
            transition: "color 300ms ease",
          }}
        >
          AscendAI
        </span>
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 12,
            color: "var(--gold-text-dim)",
            display: "block",
            marginTop: 1,
            transition: "color 300ms ease",
          }}
        >
          by Shivora
        </span>
      </Link>

      {/* RIGHT — icon actions; 6px gap on mobile, 8px from md up */}
      <div className="flex items-center gap-1.5 md:gap-2">
        {/* Search — hidden below 768px */}
        <NavIconButton
          ariaLabel="Search"
          className="hidden md:flex"
          onClick={() => {}}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </NavIconButton>

        {/* Notifications bell */}
        <NavIconButton ariaLabel="Notifications" onClick={() => {}}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        </NavIconButton>

        {/* Theme toggle — Toggles between dark and light mode globally */}
        <NavIconButton
          ariaLabel={
            theme === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"
          }
          onClick={toggleTheme}
          style={{
            background: "var(--toggle-bg)",
            border: "0.5px solid var(--toggle-border)",
            color: "var(--toggle-color)",
            fontSize: 16,
          }}
        >
          {theme === "dark" ? (
            <span aria-hidden="true">☀</span>
          ) : (
            <span aria-hidden="true">☾</span>
          )}
        </NavIconButton>

        {/* Profile — sign out until /settings exists */}
        <NavIconButton ariaLabel="Profile and sign out" onClick={handleProfileClick}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </NavIconButton>
      </div>
    </motion.nav>
  );
}
