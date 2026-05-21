// ============================================================
// FILE: app/profile/page.js
// PURPOSE: My Profile — avatar, account info, academic stats,
//          subjects with exam dates, and study schedule summary.
// ============================================================
//
// Run in Supabase SQL Editor before using photo upload:
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url text;
//
// Before photo upload works create the avatars bucket:
// Go to Supabase → Storage → New bucket
// Name: avatars
// Public: true
// Then add policies in SQL Editor:
// CREATE POLICY "Avatar images are publicly accessible"
// ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
// CREATE POLICY "Users can upload their own avatar"
// ON storage.objects FOR INSERT WITH CHECK (
//   bucket_id = 'avatars' AND
//   auth.uid()::text = (storage.foldername(name))[1]
// );

"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { SUBJECTS } from "@/lib/subjects";
import SubjectBadge from "@/app/components/SubjectBadge";

// Backend base URL — same env var as dashboard and analytics.
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

/** Normalise DB time (HH:MM:SS) to display HH:MM. */
function formatStudyTime(raw) {
  if (!raw) return "";
  const s = String(raw);
  return s.length >= 5 ? s.slice(0, 5) : s;
}

/** Two-letter initials from a display name. */
function getInitials(name) {
  const parts = (name || "A").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** "Jan 2026" from ISO created_at. */
function formatMemberSince(iso) {
  if (!iso) return "Recently";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Recently";
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

/** "15 Jul 2026" for exam date chips. */
function formatExamDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Whole days until an exam date (null if no date). */
function daysUntilExam(dateStr) {
  if (!dateStr) return null;
  const exam = new Date(dateStr);
  const today = new Date();
  exam.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.ceil((exam - today) / 86400000);
}

/** Urgency colour for days-remaining chip (CSS vars only). */
function daysChipColor(days) {
  if (days == null) return "var(--text-muted)";
  if (days < 30) return "var(--exam-urgent)";
  if (days <= 60) return "var(--gold)";
  return "var(--text-muted)";
}

/** Monday–Sunday ISO dates for the current calendar week. */
function getWeekDates() {
  const today = new Date();
  const day = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d) => d.toISOString().split("T")[0];
  return { weekStart: fmt(monday), weekEnd: fmt(sunday) };
}

/** Merge Supabase subject rows with local SUBJECTS metadata. */
function buildSubjectRows(dbRows) {
  return SUBJECTS.map((meta) => {
    const row =
      (dbRows || []).find(
        (r) =>
          String(r.code || "") === meta.code ||
          String(r.name || "").toLowerCase().includes(meta.key),
      ) || null;
    return {
      key: meta.key,
      fullName: meta.fullName,
      code: meta.code,
      examDate: row?.exam_date || null,
    };
  });
}

/** Section label — uppercase Inter caption. */
function SectionLabel({ children }) {
  return (
    <h2
      style={{
        fontFamily: "Inter, sans-serif",
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--date-color)",
        marginBottom: 12,
        marginTop: 0,
      }}
    >
      {children}
    </h2>
  );
}

/** Gold text link below a card. */
function CardLink({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        marginTop: 10,
        background: "none",
        border: "none",
        padding: 0,
        fontFamily: "Inter, sans-serif",
        fontSize: 12,
        color: "var(--gold)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const fileInputRef = useRef(null);

  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [summary, setSummary] = useState(null);
  const [subjects, setSubjects] = useState([]);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoToast, setPhotoToast] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [weekCompleted, setWeekCompleted] = useState(0);
  const [weekTotal, setWeekTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [avatarHover, setAvatarHover] = useState(false);

  const userId = session?.user?.id;
  const token = session?.access_token;
  const email = session?.user?.email || "";
  const displayName =
    profile?.full_name ||
    session?.user?.user_metadata?.full_name ||
    email.split("@")[0] ||
    "Student";

  const studyStart = formatStudyTime(profile?.study_start_time) || "15:00";
  const studyEnd = formatStudyTime(profile?.study_end_time) || "23:00";

  // Responsive grid — 2 columns below 768px.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Load session, profile, analytics, subjects, and week timetable on mount.
  useEffect(() => {
    const init = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const s = sessionData?.session;
      if (!s) {
        router.replace("/login");
        return;
      }
      setSession(s);

      const uid = s.user.id;
      const t = s.access_token;

      // Profile check — confirms row exists (dashboard safety-net parity).
      try {
        await fetch(
          `${API_URL}/onboarding/profile/check?user_id=${encodeURIComponent(uid)}`,
          { headers: { Authorization: `Bearer ${t}` } },
        );
      } catch {
        /* non-blocking */
      }

      // Profiles row — full_name, avatar, study window, member since.
      const { data: profileRow } = await supabase
        .from("profiles")
        .select(
          "full_name, email, created_at, study_start_time, study_end_time, avatar_url",
        )
        .eq("user_id", uid)
        .maybeSingle();

      setProfile(profileRow || null);
      setAvatarUrl(profileRow?.avatar_url || null);
      setEditName(
        profileRow?.full_name ||
          s.user.user_metadata?.full_name ||
          "",
      );

      // Analytics summary — all-time stats for academic overview cards.
      try {
        const summaryRes = await fetch(
          `${API_URL}/analytics/summary?period=all`,
          { headers: { Authorization: `Bearer ${t}` } },
        );
        if (summaryRes.ok) {
          setSummary(await summaryRes.json());
        }
      } catch {
        setSummary(null);
      }

      // Subjects table — exam dates per Cambridge subject.
      const { data: subjectRows } = await supabase.from("subjects").select("*");
      setSubjects(buildSubjectRows(subjectRows || []));

      // Timetable entries — sessions completed this week.
      const { weekStart, weekEnd } = getWeekDates();
      try {
        const entriesRes = await fetch(
          `${API_URL}/timetable/entries?user_id=${encodeURIComponent(uid)}` +
            `&week_start=${weekStart}&week_end=${weekEnd}`,
          { headers: { Authorization: `Bearer ${t}` } },
        );
        if (entriesRes.ok) {
          const body = await entriesRes.json();
          const rows = Array.isArray(body?.data) ? body.data : [];
          setWeekTotal(rows.length);
          setWeekCompleted(
            rows.filter((r) => r.completed || r.is_completed).length,
          );
        }
      } catch {
        setWeekTotal(0);
        setWeekCompleted(0);
      }

      setLoading(false);
    };

    init();
  }, [router]);

  // Upload avatar to Supabase Storage and save public URL on profiles.
  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !session?.user?.id) return;
    setUploadingPhoto(true);
    try {
      const fileExt = file.name.split(".").pop() || "jpg";
      const filePath = `${session.user.id}/avatar.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data } = supabase.storage.from("avatars").getPublicUrl(filePath);

      await supabase
        .from("profiles")
        .update({ avatar_url: data.publicUrl })
        .eq("user_id", session.user.id);

      setAvatarUrl(data.publicUrl);
      setPhotoToast(true);
      setTimeout(() => setPhotoToast(false), 2000);
    } catch (err) {
      console.error("[Profile] Photo upload failed:", err);
    } finally {
      setUploadingPhoto(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Remove avatar from Storage and clear avatar_url on profiles.
  const handleRemovePhoto = async () => {
    const confirmed = window.confirm(
      "Remove your profile photo? This cannot be undone.",
    );
    if (!confirmed) return;

    try {
      const fileExt = avatarUrl.split(".").pop().split("?")[0];
      const filePath = `${session.user.id}/avatar.${fileExt}`;

      await supabase.storage.from("avatars").remove([filePath]);

      await supabase
        .from("profiles")
        .update({ avatar_url: null })
        .eq("user_id", session.user.id);

      setAvatarUrl(null);
    } catch (err) {
      console.error("[Profile] Remove photo failed:", err);
      alert("Could not remove photo. Please try again.");
    }
  };

  // Save edited display name to profiles table.
  const handleSaveName = async () => {
    if (!userId || !editName.trim()) return;
    setSaving(true);
    try {
      await supabase
        .from("profiles")
        .update({ full_name: editName.trim() })
        .eq("user_id", userId);
      setProfile((prev) => ({ ...prev, full_name: editName.trim() }));
      setEditing(false);
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 2000);
    } catch (err) {
      console.error("[Profile] Name save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    width: "100%",
    maxWidth: 280,
    background: "var(--card-hover)",
    border: "0.5px solid var(--gold-border-hover)",
    borderRadius: 6,
    padding: "8px 12px",
    fontFamily: "Inter, sans-serif",
    fontSize: 14,
    color: "var(--text)",
    outline: "none",
    boxSizing: "border-box",
  };

  const statCards = [
    {
      value: summary?.questions_asked ?? 0,
      label: "QUESTIONS ASKED",
    },
    {
      value: summary?.flashcard_sessions ?? 0,
      label: "FLASHCARD SESSIONS",
    },
    {
      value: summary?.papers_solved ?? 0,
      label: "PAPERS SOLVED",
    },
    {
      value:
        summary?.avg_quiz_score != null
          ? `${summary.avg_quiz_score}%`
          : "0%",
      label: "AVG QUIZ SCORE",
    },
  ];

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Inter, sans-serif",
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        Loading profile…
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", paddingBottom: 48 }}>
      <style jsx global>{`
        .profile-edit-btn:hover {
          background: color-mix(in srgb, var(--gold) 8%, transparent) !important;
        }
        .profile-avatar-wrap:hover .profile-avatar-overlay {
          opacity: 1 !important;
        }
      `}</style>

      {/* Toast — photo updated */}
      {photoToast ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--card)",
            border: "0.5px solid var(--gold-border)",
            borderRadius: 8,
            padding: "10px 20px",
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--gold)",
            zIndex: 200,
          }}
        >
          Photo updated!
        </div>
      ) : null}

      {/* Toast — name saved */}
      {savedToast ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--card)",
            border: "0.5px solid var(--gold-border)",
            borderRadius: 8,
            padding: "10px 20px",
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--gold)",
            zIndex: 200,
          }}
        >
          Saved!
        </div>
      ) : null}

      {/* Back navigation */}
      <div style={{ padding: "16px var(--page-padding) 0" }}>
        <Link
          href="/dashboard"
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--text-muted)",
            textDecoration: "none",
          }}
        >
          ← Dashboard / <span style={{ color: "var(--text)" }}>My Profile</span>
        </Link>
      </div>

      {/* Page header */}
      <header style={{ padding: "20px var(--page-padding) 0" }}>
        <h1
          style={{
            fontFamily: "var(--font-playfair), 'Playfair Display', serif",
            fontSize: 28,
            color: "var(--text)",
            fontWeight: 700,
            margin: 0,
          }}
        >
          My Profile
        </h1>
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--text-muted)",
            marginTop: 4,
            marginBottom: 0,
          }}
        >
          Your account and academic overview
        </p>
      </header>

      {/* SECTION 1 — Profile card */}
      <section
        style={{
          margin: "20px var(--page-padding) 0",
          background: "var(--card)",
          border: "0.5px solid var(--gold-border)",
          borderRadius: 10,
          padding: isMobile ? "24px 20px" : "28px 32px",
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "center" : "center",
          gap: 24,
        }}
      >
        {/* Avatar + upload */}
        <div
          className="profile-avatar-wrap"
          style={{ position: "relative", width: 96, height: 96, flexShrink: 0 }}
          onMouseEnter={() => setAvatarHover(true)}
          onMouseLeave={() => setAvatarHover(false)}
        >
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: "50%",
              background: "var(--gold-dim)",
              border: "2px solid var(--gold-border-active)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              position: "relative",
            }}
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                style={{ objectFit: "cover", width: "100%", height: "100%" }}
              />
            ) : (
              <span
                style={{
                  fontFamily: "var(--font-playfair), 'Playfair Display', serif",
                  fontSize: 32,
                  fontWeight: 700,
                  color: "var(--gold)",
                }}
              >
                {getInitials(displayName)}
              </span>
            )}
            <div
              className="profile-avatar-overlay"
              style={{
                position: "absolute",
                inset: 0,
                background: "color-mix(in srgb, var(--bg) 45%, transparent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: avatarHover ? 1 : 0,
                transition: "opacity 150ms",
                pointerEvents: "none",
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--gold)"
                strokeWidth="2"
                aria-hidden
              >
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </div>
          </div>

          <button
            type="button"
            aria-label="Upload profile photo"
            disabled={uploadingPhoto}
            onClick={() => fileInputRef.current?.click()}
            style={{
              position: "absolute",
              bottom: 0,
              right: 0,
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "var(--gold)",
              border: "2px solid var(--bg)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: uploadingPhoto ? "wait" : "pointer",
              padding: 0,
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--bg)"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handlePhotoUpload}
          />

          {avatarUrl && (
            <button
              type="button"
              onClick={handleRemovePhoto}
              style={{
                background: "transparent",
                border: "none",
                fontFamily: "Inter, sans-serif",
                fontSize: "11px",
                color: "var(--exam-urgent)",
                cursor: "pointer",
                marginTop: "6px",
                display: "block",
                textAlign: "center",
                width: "100%",
              }}
            >
              Remove photo
            </button>
          )}
        </div>

        {/* User info */}
        <div style={{ flex: 1, minWidth: 0, textAlign: isMobile ? "center" : "left" }}>
          {editing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input
                type="text"
                value={editName}
                onChange={(ev) => setEditName(ev.target.value)}
                style={inputStyle}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleSaveName}
                  style={{
                    background: "var(--gold)",
                    border: "none",
                    borderRadius: 8,
                    padding: "8px 18px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--bg)",
                    cursor: saving ? "wait" : "pointer",
                  }}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="profile-edit-btn"
                  onClick={() => {
                    setEditing(false);
                    setEditName(profile?.full_name || displayName);
                  }}
                  style={{
                    background: "transparent",
                    border: "0.5px solid var(--gold-border-active)",
                    borderRadius: 8,
                    padding: "8px 18px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 13,
                    color: "var(--gold)",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2
                style={{
                  fontFamily: "var(--font-playfair), 'Playfair Display', serif",
                  fontSize: 24,
                  color: "var(--text)",
                  fontWeight: 700,
                  margin: 0,
                }}
              >
                {displayName}
              </h2>
              <p
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: 13,
                  color: "var(--text-muted)",
                  marginTop: 4,
                  marginBottom: 0,
                }}
              >
                {email}
              </p>
              <p
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: 11,
                  color: "var(--text-extra-dim)",
                  marginTop: 6,
                  marginBottom: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: isMobile ? "center" : "flex-start",
                  gap: 6,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
                  <path
                    fill="var(--text-extra-dim)"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  />
                  <path
                    fill="var(--text-extra-dim)"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="var(--text-extra-dim)"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                  />
                  <path
                    fill="var(--text-extra-dim)"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                Connected with Google
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  marginTop: 8,
                  justifyContent: isMobile ? "center" : "flex-start",
                }}
              >
                <span
                  style={{
                    background: "var(--gold-dim)",
                    border: "0.5px solid var(--gold-border)",
                    borderRadius: 20,
                    padding: "3px 12px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 11,
                    color: "var(--gold)",
                  }}
                >
                  Free Plan
                </span>
                <span
                  style={{
                    background: "var(--card-hover)",
                    border: "0.5px solid var(--border)",
                    borderRadius: 20,
                    padding: "3px 12px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 11,
                    color: "var(--text-muted)",
                  }}
                >
                  Member since {formatMemberSince(profile?.created_at)}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Edit button */}
        {!editing ? (
          <button
            type="button"
            className="profile-edit-btn"
            onClick={() => {
              setEditName(displayName);
              setEditing(true);
            }}
            style={{
              alignSelf: isMobile ? "center" : "flex-start",
              background: "transparent",
              border: "0.5px solid var(--gold-border-active)",
              borderRadius: 8,
              padding: "8px 18px",
              fontFamily: "Inter, sans-serif",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--gold)",
              cursor: "pointer",
            }}
          >
            Edit
          </button>
        ) : null}
      </section>

      {/* SECTION 2 — Academic overview stats */}
      <section style={{ margin: "16px var(--page-padding) 0" }}>
        <SectionLabel>Academic Overview</SectionLabel>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)",
            gap: 12,
          }}
        >
          {statCards.map((stat) => (
            <div
              key={stat.label}
              style={{
                background: "var(--card)",
                border: "0.5px solid var(--gold-border)",
                borderRadius: 10,
                padding: "16px 20px",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-playfair), 'Playfair Display', serif",
                  fontSize: 28,
                  fontWeight: 700,
                  color: "var(--gold)",
                  lineHeight: 1,
                  display: "block",
                }}
              >
                {stat.value}
              </span>
              <span
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "var(--date-color)",
                  marginTop: 6,
                  display: "block",
                }}
              >
                {stat.label}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* SECTION 3 — My subjects */}
      <section style={{ margin: "16px var(--page-padding) 0" }}>
        <SectionLabel>My Subjects</SectionLabel>
        <div
          style={{
            background: "var(--card)",
            border: "0.5px solid var(--gold-border)",
            borderRadius: 10,
            padding: "20px 24px",
          }}
        >
          {subjects.map((sub, idx) => {
            const formatted = formatExamDate(sub.examDate);
            const days = daysUntilExam(sub.examDate);
            const isLast = idx === subjects.length - 1;
            return (
              <div
                key={sub.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: "12px 0",
                  borderBottom: isLast ? "none" : "0.5px solid var(--border)",
                }}
              >
                <SubjectBadge subject={sub.key} showCode />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: 14,
                      fontWeight: 500,
                      color: "var(--text)",
                      margin: 0,
                    }}
                  >
                    {sub.fullName}
                  </p>
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 2,
                      marginBottom: 0,
                    }}
                  >
                    {formatted ? `Exam: ${formatted}` : "No date set"}
                  </p>
                </div>
                {days != null ? (
                  <span
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: 12,
                      fontWeight: 600,
                      color: daysChipColor(days),
                      flexShrink: 0,
                    }}
                  >
                    {days} days
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        <CardLink onClick={() => router.push("/onboarding/exam-dates?from=edit")}>
          Update Exam Dates →
        </CardLink>
      </section>

      {/* SECTION 4 — Study schedule summary */}
      <section style={{ margin: "16px var(--page-padding) 32px" }}>
        <SectionLabel>Study Schedule</SectionLabel>
        <div
          style={{
            background: "var(--card)",
            border: "0.5px solid var(--gold-border)",
            borderRadius: 10,
            padding: "20px 24px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <p
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--text)",
                  margin: 0,
                }}
              >
                Study Hours
              </p>
              <p
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 2,
                  marginBottom: 0,
                }}
              >
                When you study each day
              </p>
            </div>
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--gold)",
              }}
            >
              {studyStart} — {studyEnd}
            </span>
          </div>

          <div
            style={{
              height: "0.5px",
              background: "var(--border)",
              margin: "16px 0",
            }}
          />

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <p
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--text)",
                  margin: 0,
                }}
              >
                This Week
              </p>
              <p
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 2,
                  marginBottom: 0,
                }}
              >
                Sessions completed
              </p>
            </div>
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text)",
              }}
            >
              {weekCompleted} / {weekTotal} sessions
            </span>
          </div>
        </div>
        <CardLink onClick={() => router.push("/settings")}>
          Manage Study Preferences →
        </CardLink>
      </section>
    </div>
  );
}

