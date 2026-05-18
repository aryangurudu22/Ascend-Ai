// ============================================================
// FILE: app/components/Navbar.js
// PURPOSE: Global sticky navigation — logo, search palette,
//          notifications dropdown, theme toggle, profile.
// ============================================================

"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Calendar, Zap, FileText } from "lucide-react";
import { useTheme } from "@/app/context/ThemeContext";
import { supabase } from "@/lib/supabaseClient";
import SearchPalette from "./SearchPalette";

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

const INITIAL_NOTIFICATIONS = [
  {
    id: "1",
    type: "info",
    Icon: Calendar,
    title: "Timetable generated",
    desc: "Your 2-week study plan is ready",
    time: "2 hours ago",
    unread: true,
  },
  {
    id: "2",
    type: "success",
    Icon: Zap,
    title: "8 flashcards created",
    desc: "From Price Elasticity of Demand note",
    time: "Yesterday",
    unread: true,
  },
  {
    id: "3",
    type: "info",
    Icon: FileText,
    title: "Past paper solved",
    desc: "Economics 9708 · 2023 May/June",
    time: "3 days ago",
    unread: false,
  },
];

export default function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();

  const [searchOpen, setSearchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifications, setNotifications] = useState(INITIAL_NOTIFICATIONS);
  const [user, setUser] = useState(null);
  const notifWrapRef = useRef(null);
  const profileRef = useRef(null);

  const hasUnread = notifications.some((n) => n.unread);

  const handleProfileClick = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user || null);
    });
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Ctrl+K / Cmd+K opens search palette.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
        setNotifOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click outside closes notifications dropdown.
  useEffect(() => {
    if (!notifOpen) return;
    const onPointer = (e) => {
      if (notifWrapRef.current && !notifWrapRef.current.contains(e.target)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [notifOpen]);

  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));
  };

  return (
    <>
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
          padding: "0 var(--page-padding)",
          height: 60,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          transition: "background 300ms ease, border-color 300ms ease",
        }}
      >
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
            }}
          >
            by Shivora
          </span>
        </Link>

        <div className="flex items-center gap-1.5 md:gap-2">
          <NavIconButton
            ariaLabel="Search"
            className="hidden md:flex"
            onClick={() => {
              setSearchOpen(true);
              setNotifOpen(false);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </NavIconButton>

          <div ref={notifWrapRef} style={{ position: "relative" }}>
            <NavIconButton
              ariaLabel="Notifications"
              onClick={() => {
                setNotifOpen((v) => !v);
                setSearchOpen(false);
              }}
              style={{ position: "relative" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {hasUnread ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--exam-urgent)",
                  }}
                />
              ) : null}
            </NavIconButton>

            <AnimatePresence>
              {notifOpen ? (
                <motion.div
                  initial={{ opacity: 0, y: -8, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.97 }}
                  transition={{ duration: 0.15 }}
                  style={{
                    position: "absolute",
                    top: "48px",
                    right: 0,
                    width: "320px",
                    background: "var(--card)",
                    border: "0.5px solid var(--gold-border-hover)",
                    borderRadius: "10px",
                    boxShadow: "0 8px 32px var(--chat-panel-shadow)",
                    zIndex: 150,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: "14px 16px",
                      borderBottom: "0.5px solid var(--border-light)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "14px", color: "var(--text)", fontWeight: 700 }}>
                      Notifications
                    </span>
                    <button
                      type="button"
                      onClick={markAllRead}
                      style={{
                        background: "none",
                        border: "none",
                        fontFamily: "Inter, sans-serif",
                        fontSize: "11px",
                        color: "var(--gold)",
                        cursor: "pointer",
                      }}
                    >
                      Mark all read
                    </button>
                  </div>

                  {notifications.map((n, idx) => {
                    const Icon = n.Icon;
                    return (
                      <button
                        key={n.id}
                        type="button"
                        style={{
                          width: "100%",
                          padding: "12px 16px",
                          borderBottom: idx < notifications.length - 1 ? "0.5px solid var(--border)" : "none",
                          display: "flex",
                          gap: "12px",
                          alignItems: "flex-start",
                          cursor: "pointer",
                          background: n.unread ? "var(--nav-icon-bg)" : "transparent",
                          border: "none",
                          textAlign: "left",
                          transition: "background 150ms",
                        }}
                        className="notif-row"
                        onClick={() => setNotifOpen(false)}
                      >
                        <span
                          style={{
                            width: "32px",
                            height: "32px",
                            borderRadius: "50%",
                            background: n.unread ? "var(--nav-icon-hover-bg)" : "var(--card-hover)",
                            border: n.unread ? "0.5px solid var(--gold-border)" : "0.5px solid var(--border)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <Icon size={16} color={n.unread ? "var(--gold)" : "var(--text-muted)"} aria-hidden />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span
                            style={{
                              fontFamily: "Inter, sans-serif",
                              fontSize: "13px",
                              fontWeight: 500,
                              color: n.unread ? "var(--text)" : "var(--text-dim)",
                              display: "block",
                            }}
                          >
                            {n.title}
                          </span>
                          <span style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--text-muted)", marginTop: "2px", display: "block" }}>
                            {n.desc}
                          </span>
                          <span style={{ fontFamily: "Inter, sans-serif", fontSize: "10px", color: "var(--text-extra-dim)", marginTop: "4px", display: "block" }}>
                            {n.time}
                          </span>
                        </span>
                        {n.unread ? (
                          <span
                            aria-hidden
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: "var(--gold)",
                              flexShrink: 0,
                              marginTop: 6,
                            }}
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          <NavIconButton
            ariaLabel={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
            style={{
              background: "var(--toggle-bg)",
              border: "0.5px solid var(--toggle-border)",
              color: "var(--toggle-color)",
              fontSize: 16,
            }}
          >
            {theme === "dark" ? <span aria-hidden>☀</span> : <span aria-hidden>☾</span>}
          </NavIconButton>

          <div ref={profileRef} style={{ position: "relative", display: "inline-flex" }}>
            <NavIconButton
              ariaLabel="Profile menu"
              onClick={() => setProfileOpen((prev) => !prev)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </NavIconButton>

            <AnimatePresence>
              {profileOpen ? (
                <motion.div
                  initial={{ opacity: 0, y: -8, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.97 }}
                  transition={{ duration: 0.15 }}
                  style={{
                    position: "absolute",
                    top: 42,
                    right: 0,
                    width: 220,
                    background: "var(--card)",
                    border: "0.5px solid var(--gold-border-hover)",
                    borderRadius: 10,
                    boxShadow: "0 8px 32px var(--chat-panel-shadow)",
                    zIndex: 150,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: "14px 16px",
                      borderBottom: "0.5px solid var(--border-light)",
                    }}
                  >
                    <p
                      style={{
                        fontFamily: "Inter, sans-serif",
                        fontSize: 14,
                        fontWeight: 500,
                        color: "var(--text)",
                        margin: 0,
                      }}
                    >
                      {user?.user_metadata?.full_name || "My Account"}
                    </p>
                    <p
                      style={{
                        fontFamily: "Inter, sans-serif",
                        fontSize: 11,
                        color: "var(--text-muted)",
                        margin: "2px 0 0",
                      }}
                    >
                      {user?.email || ""}
                    </p>
                  </div>

                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      router.push("/dashboard");
                      setProfileOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        router.push("/dashboard");
                        setProfileOpen(false);
                      }
                    }}
                    className="profile-menu-row"
                    style={{
                      padding: "10px 16px",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      cursor: "pointer",
                      transition: "background 150ms",
                      fontFamily: "Inter, sans-serif",
                      fontSize: 13,
                      color: "var(--text)",
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                    My Profile
                  </div>

                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      router.push("/settings");
                      setProfileOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        router.push("/settings");
                        setProfileOpen(false);
                      }
                    }}
                    className="profile-menu-row"
                    style={{
                      padding: "10px 16px",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      cursor: "pointer",
                      transition: "background 150ms",
                      fontFamily: "Inter, sans-serif",
                      fontSize: 13,
                      color: "var(--text)",
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    Settings
                  </div>

                  <div style={{ height: "0.5px", background: "var(--border)", margin: "4px 0" }} />

                  <div
                    role="button"
                    tabIndex={0}
                    onClick={handleProfileClick}
                    className="profile-menu-row profile-menu-signout"
                    style={{
                      padding: "10px 16px",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      cursor: "pointer",
                      transition: "background 150ms",
                      fontFamily: "Inter, sans-serif",
                      fontSize: 13,
                      color: "var(--exam-urgent)",
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--exam-urgent)" strokeWidth="2" aria-hidden>
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    Sign Out
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </motion.nav>

      <style>{`
        .notif-row:hover { background: var(--card-hover) !important; }
        .profile-menu-row:hover { background: var(--card-hover) !important; }
        .profile-menu-signout:hover { background: var(--nav-icon-bg) !important; }
      `}</style>

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
