// ============================================================
// FILE: app/components/Navbar.js
// PURPOSE: Global sticky navigation — logo, search palette,
//          live notifications dropdown, theme toggle, profile.
// ============================================================

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useTheme } from "@/app/context/ThemeContext";
import { supabase } from "@/lib/supabaseClient";
import SearchPalette from "./SearchPalette";

// Backend base URL — same pattern as dashboard and feature pages.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

// Shared icon button chrome for search, bell, theme, profile.
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

// Circular nav control with hover lift.
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

// Map notification type → feature route when a row is clicked.
function routeForNotificationType(type) {
  switch (type) {
    case "timetable":
      return "/features/timetable";
    case "flashcards":
      return "/features/flashcards";
    case "paper":
      return "/features/past-papers";
    case "notes":
      return "/features/notes";
    case "exam_alert":
      return "/syllabus";
    case "essay":
      return "/features/homework";
    default:
      return "/dashboard";
  }
}

// 16px SVG icons — stroke uses currentColor (gold or urgent via parent).
function NotifIconCalendar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function NotifIconLayers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function NotifIconBookOpen() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function NotifIconFile() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function NotifIconAlertCircle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function NotifIconEssay() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

// Pick the icon component for each backend notification type.
function NotificationTypeIcon({ type }) {
  const isAlert = type === "exam_alert";
  const color = isAlert ? "var(--exam-urgent)" : "var(--gold)";
  switch (type) {
    case "timetable":
      return <span style={{ color }}><NotifIconCalendar /></span>;
    case "flashcards":
      return <span style={{ color }}><NotifIconLayers /></span>;
    case "paper":
      return <span style={{ color }}><NotifIconBookOpen /></span>;
    case "notes":
      return <span style={{ color }}><NotifIconFile /></span>;
    case "exam_alert":
      return <span style={{ color }}><NotifIconAlertCircle /></span>;
    case "essay":
      return <span style={{ color }}><NotifIconEssay /></span>;
    default:
      return <span style={{ color: "var(--gold)" }}><NotifIconFile /></span>;
  }
}

export default function Navbar() {
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();

  const [searchOpen, setSearchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifLoading, setNotifLoading] = useState(false);
  const [user, setUser] = useState(null);
  const notifWrapRef = useRef(null);
  const profileRef = useRef(null);

  // Sign out and return to login.
  const handleProfileClick = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  // Load Supabase session for profile menu display name / email.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user || null);
    });
  }, []);

  // Fetch notifications from GET /notifications with Bearer token.
  const fetchNotifications = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    setNotifLoading(true);
    try {
      const res = await fetch(`${API_URL}/notifications`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      setNotifications(data.notifications || []);
      setUnreadCount(typeof data.unread_count === "number" ? data.unread_count : 0);
    } catch {
      // Silent — bell keeps last known state on network blips.
    } finally {
      setNotifLoading(false);
    }
  }, []);

  // Initial fetch on mount + poll every 60 seconds.
  useEffect(() => {
    fetchNotifications();
    const intervalId = setInterval(fetchNotifications, 60000);
    return () => clearInterval(intervalId);
  }, [fetchNotifications]);

  // Close profile menu when clicking outside.
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

  // PATCH /notifications/read-all then refresh list.
  const markAllRead = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    try {
      await fetch(`${API_URL}/notifications/read-all`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      await fetchNotifications();
    } catch {
      // Ignore — user can retry from the dropdown.
    }
  };

  // PATCH one notification read, update local state, navigate to feature.
  const handleNotificationClick = async (notif) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token && notif.id) {
      try {
        await fetch(`${API_URL}/notifications/${notif.id}/read`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });
      } catch {
        // Still navigate even if mark-read fails.
      }
    }

    setNotifications((prev) =>
      prev.map((n) =>
        n.id === notif.id ? { ...n, is_read: true } : n
      )
    );
    setUnreadCount((prev) => Math.max(0, prev - (notif.is_read ? 0 : 1)));

    setNotifOpen(false);
    router.push(routeForNotificationType(notif.type));
  };

  // Badge label on the bell — count or 9+ cap.
  const badgeLabel =
    unreadCount >= 10 ? "9+" : unreadCount > 0 ? String(unreadCount) : null;

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

        <motion.div className="flex items-center gap-1.5 md:gap-2">
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

          {/* Notifications bell + dropdown */}
          <motion.div ref={notifWrapRef} style={{ position: "relative" }}>
            <NavIconButton
              ariaLabel="Notifications"
              onClick={() => {
                setNotifOpen((v) => !v);
                setSearchOpen(false);
                if (!notifOpen) fetchNotifications();
              }}
              style={{ position: "relative" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {unreadCount > 0 ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    minWidth: badgeLabel ? 14 : 8,
                    height: badgeLabel ? 14 : 8,
                    padding: badgeLabel ? "0 3px" : 0,
                    borderRadius: badgeLabel ? 8 : "50%",
                    background: "var(--exam-urgent)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "Inter, sans-serif",
                    fontSize: badgeLabel ? 9 : 0,
                    fontWeight: 600,
                    color: "var(--text-emphasis)",
                    lineHeight: 1,
                  }}
                >
                  {badgeLabel || ""}
                </span>
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
                    maxHeight: "400px",
                    overflowY: "auto",
                  }}
                >
                  {/* Dropdown header */}
                  <motion.div
                    style={{
                      padding: "14px 16px",
                      borderBottom: "0.5px solid var(--border-light)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <motion.span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          fontFamily: "'Playfair Display', serif",
                          fontSize: "14px",
                          color: "var(--text)",
                          fontWeight: 700,
                        }}
                      >
                        Notifications
                      </span>
                      {unreadCount > 0 ? (
                        <span
                          style={{
                            background: "var(--gold-dim)",
                            border: "0.5px solid var(--gold-border)",
                            borderRadius: "10px",
                            padding: "2px 8px",
                            fontFamily: "Inter, sans-serif",
                            fontSize: "10px",
                            color: "var(--gold)",
                          }}
                        >
                          {unreadCount} unread
                        </span>
                      ) : null}
                    </motion.span>
                    {unreadCount > 0 ? (
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
                          flexShrink: 0,
                        }}
                      >
                        Mark all read
                      </button>
                    ) : null}
                  </motion.div>

                  {/* Loading skeleton rows */}
                  {notifLoading && notifications.length === 0 ? (
                    <>
                      {[0, 1, 2].map((i) => (
                        <motion.div
                          key={`skel-${i}`}
                          className="animate-pulse"
                          style={{
                            margin: "8px 16px",
                            background: "var(--card-hover)",
                            height: 48,
                            borderRadius: 6,
                          }}
                        />
                      ))}
                    </>
                  ) : null}

                  {/* Empty state */}
                  {!notifLoading && notifications.length === 0 ? (
                    <motion.div
                      style={{
                        padding: "32px 16px",
                        textAlign: "center",
                      }}
                    >
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--gold-icon)"
                        strokeWidth="2"
                        style={{ margin: "0 auto 12px", display: "block" }}
                        aria-hidden
                      >
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                      <p
                        style={{
                          fontFamily: "Inter, sans-serif",
                          fontSize: "13px",
                          color: "var(--text-muted)",
                          margin: 0,
                        }}
                      >
                        No notifications yet
                      </p>
                      <p
                        style={{
                          fontFamily: "Inter, sans-serif",
                          fontSize: "11px",
                          color: "var(--text-extra-dim)",
                          marginTop: "4px",
                          marginBottom: 0,
                        }}
                      >
                        They will appear here when something happens
                      </p>
                    </motion.div>
                  ) : null}

                  {/* Notification rows */}
                  {notifications.map((n, idx) => {
                    const unread = !n.is_read;
                    return (
                      <button
                        key={n.id}
                        type="button"
                        style={{
                          width: "100%",
                          padding: "12px 16px",
                          borderBottom:
                            idx < notifications.length - 1
                              ? "0.5px solid var(--border)"
                              : "none",
                          display: "flex",
                          gap: "12px",
                          alignItems: "flex-start",
                          cursor: "pointer",
                          background: unread ? "var(--nav-icon-bg)" : "transparent",
                          border: "none",
                          textAlign: "left",
                          transition: "background 150ms",
                        }}
                        className="notif-row"
                        onClick={() => handleNotificationClick(n)}
                      >
                        <span
                          style={{
                            width: "32px",
                            height: "32px",
                            borderRadius: "50%",
                            background: unread
                              ? "var(--nav-icon-hover-bg)"
                              : "var(--card-hover)",
                            border: unread
                              ? "0.5px solid var(--gold-border)"
                              : "0.5px solid var(--border)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <NotificationTypeIcon type={n.type} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span
                            style={{
                              fontFamily: "Inter, sans-serif",
                              fontSize: "13px",
                              fontWeight: 500,
                              color: unread ? "var(--text)" : "var(--text-dim)",
                              display: "block",
                            }}
                          >
                            {n.title}
                          </span>
                          <span
                            style={{
                              fontFamily: "Inter, sans-serif",
                              fontSize: "12px",
                              color: "var(--text-muted)",
                              marginTop: "2px",
                              display: "block",
                            }}
                          >
                            {n.message}
                          </span>
                          <span
                            style={{
                              fontFamily: "Inter, sans-serif",
                              fontSize: "10px",
                              color: "var(--text-extra-dim)",
                              marginTop: "4px",
                              display: "block",
                            }}
                          >
                            {n.created_at}
                          </span>
                        </span>
                        {unread ? (
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
          </motion.div>

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

          <motion.div ref={profileRef} style={{ position: "relative", display: "inline-flex" }}>
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
                  <motion.div
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
                  </motion.div>

                  <motion.div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      router.push("/profile");
                      setProfileOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        router.push("/profile");
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
                  </motion.div>

                  <motion.div
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
                  </motion.div>

                  <motion.div style={{ height: "0.5px", background: "var(--border)", margin: "4px 0" }} />

                  <motion.div
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
                  </motion.div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.div>
        </motion.div>
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
