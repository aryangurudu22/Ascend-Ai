// ============================================================
// FILE: app/components/SearchPalette.js
// PURPOSE: Command palette — search notes, homework, flashcards
//          client-side. Opens from navbar or Ctrl/Cmd+K.
// ============================================================

"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Pencil, FileText, Layers } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import SubjectBadge from "./SubjectBadge";
import { getSubjectByKey, getSubjectByName } from "@/lib/subjects";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";
const HOMEWORK_HISTORY_KEY = "ascendai_homework_history";

/** Normalise subject key for SubjectBadge from assorted row shapes. */
function resolveSubjectKey(raw) {
  if (!raw) return "economics";
  const byKey = getSubjectByKey(String(raw).toLowerCase());
  if (byKey) return byKey.key;
  const byName = getSubjectByName(raw);
  return byName?.key || "economics";
}

/**
 * SearchPalette — modal search UI; filters loaded index as user types.
 */
export default function SearchPalette({ open, onClose }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [homeworkItems, setHomeworkItems] = useState([]);
  const [noteItems, setNoteItems] = useState([]);
  const [flashcardItems, setFlashcardItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  // Load searchable data when palette opens (existing APIs + localStorage).
  const loadSearchIndex = useCallback(async () => {
    setLoading(true);

    try {
      const stored = localStorage.getItem(HOMEWORK_HISTORY_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setHomeworkItems(
            parsed.slice(0, 20).map((h, i) => ({
              id: `hw-${h.id ?? i}`,
              type: "homework",
              title: (h.question || "Homework question").slice(0, 80),
              subtitle: "Homework Assistant",
              subjectKey: resolveSubjectKey(h.subject),
              href: "/features/homework",
              searchText: (h.question || "").toLowerCase(),
            })),
          );
        }
      }
    } catch (e) {
      console.warn("[SearchPalette] Could not read homework history", e);
    }

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      const userId = sessionData?.session?.user?.id;
      if (token && userId) {
        const params = new URLSearchParams({ user_id: userId, limit: "50", offset: "0" });
        const res = await fetch(`${API_URL}/notes/list?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          const rows = Array.isArray(body?.data) ? body.data : [];
          setNoteItems(
            rows.map((n) => ({
              id: `note-${n.id}`,
              type: "notes",
              title: n.title || "Untitled note",
              subtitle: (n.summary || "").slice(0, 60),
              subjectKey: resolveSubjectKey(n.subject_key || n.subject),
              href: "/features/notes",
              searchText: `${n.title || ""} ${n.summary || ""}`.toLowerCase(),
            })),
          );
        }

        const { data: cardRows } = await supabase
          .from("flashcards")
          .select("id, front, topic, subject_id")
          .eq("user_id", userId)
          .limit(80);
        if (cardRows?.length) {
          setFlashcardItems(
            cardRows.map((c) => ({
              id: `fc-${c.id}`,
              type: "flashcards",
              title: (c.front || c.topic || "Flashcard").slice(0, 80),
              subtitle: c.topic || "Flashcards",
              subjectKey: "economics",
              href: "/features/flashcards",
              searchText: `${c.front || ""} ${c.topic || ""}`.toLowerCase(),
            })),
          );
        }
      }
    } catch (e) {
      console.warn("[SearchPalette] Index load failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    loadSearchIndex();
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open, loadSearchIndex]);

  // Escape closes palette.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const q = query.trim().toLowerCase();

  // Client-side filter across all loaded categories.
  const filtered = useMemo(() => {
    const match = (item) => {
      if (!q) return true;
      const hay = `${item.title} ${item.subtitle} ${item.searchText || ""}`.toLowerCase();
      return hay.includes(q);
    };
    return [
      ...noteItems.filter(match),
      ...homeworkItems.filter(match),
      ...flashcardItems.filter(match),
    ];
  }, [q, noteItems, homeworkItems, flashcardItems]);

  const recentHomework = homeworkItems.slice(0, 3);

  const handleSelect = (item) => {
    router.push(item.href);
    onClose();
  };

  const iconForType = (type) => {
    if (type === "homework") return Pencil;
    if (type === "flashcards") return Layers;
    return FileText;
  };

  const ResultRow = ({ item }) => {
    const Icon = iconForType(item.type);
    return (
      <button
        type="button"
        onClick={() => handleSelect(item)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "10px 12px",
          borderRadius: "6px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          transition: "background 150ms",
        }}
        className="search-palette-row"
      >
        <span
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "50%",
            background: "var(--card-hover)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon size={14} color="var(--gold)" aria-hidden />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontFamily: "Inter, sans-serif",
              fontSize: "13px",
              color: "var(--text)",
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.title}
          </span>
          <span
            style={{
              display: "block",
              fontFamily: "Inter, sans-serif",
              fontSize: "11px",
              color: "var(--text-muted)",
              marginTop: "2px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.subtitle}
          </span>
        </span>
        <SubjectBadge subject={item.subjectKey} label={getSubjectByKey(item.subjectKey)?.name} />
      </button>
    );
  };

  return (
    <AnimatePresence>
      {open ? (
        <>
          <style>{`
            .search-palette-row:hover { background: var(--card-hover) !important; }
          `}</style>
          <motion.div
            role="presentation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            style={{
              position: "fixed",
              inset: 0,
              background: "var(--chat-panel-shadow)",
              backdropFilter: "blur(4px)",
              WebkitBackdropFilter: "blur(4px)",
              zIndex: 200,
            }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ duration: 0.15 }}
            style={{
              position: "fixed",
              top: "20%",
              left: "50%",
              transform: "translateX(-50%)",
              width: "min(600px, 90vw)",
              background: "var(--card)",
              border: "0.5px solid var(--gold-border-active)",
              borderRadius: "12px",
              overflow: "hidden",
              zIndex: 201,
              boxShadow: "0 8px 48px var(--chat-panel-shadow)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: "16px 20px",
                borderBottom: "0.5px solid var(--border-light)",
                display: "flex",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <Search size={18} color="var(--text-muted)" aria-hidden />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes, questions, flashcards..."
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  fontFamily: "Inter, sans-serif",
                  fontSize: "15px",
                  color: "var(--text)",
                }}
              />
              <kbd
                style={{
                  background: "var(--card-hover)",
                  border: "0.5px solid var(--border)",
                  borderRadius: "4px",
                  padding: "2px 6px",
                  fontFamily: "Inter, sans-serif",
                  fontSize: "11px",
                  color: "var(--text-muted)",
                }}
              >
                ESC
              </kbd>
            </div>

            <div style={{ maxHeight: "400px", overflowY: "auto", padding: "8px" }}>
              {loading ? (
                <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", padding: "16px", textAlign: "center" }}>
                  Loading…
                </p>
              ) : !q && recentHomework.length > 0 ? (
                <>
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: "10px",
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "var(--date-color)",
                      padding: "8px 12px",
                      margin: 0,
                    }}
                  >
                    RECENT
                  </p>
                  {recentHomework.map((item) => (
                    <ResultRow key={item.id} item={item} />
                  ))}
                </>
              ) : null}

              {q && filtered.length === 0 ? (
                <div style={{ padding: "32px 16px", textAlign: "center" }}>
                  <Search size={24} color="var(--gold-icon)" style={{ margin: "0 auto 12px", display: "block" }} aria-hidden />
                  <p style={{ fontFamily: "'Playfair Display', serif", fontSize: "14px", color: "var(--text)", margin: "0 0 8px" }}>
                    No results for &apos;{query}&apos;
                  </p>
                  <p style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--text-muted)", margin: 0 }}>
                    Try searching for a topic or subject
                  </p>
                </div>
              ) : null}

              {q && filtered.length > 0 ? filtered.map((item) => <ResultRow key={item.id} item={item} />) : null}

              {q && filtered.length > 0 ? null : !loading && !q && recentHomework.length === 0 ? (
                <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", padding: "16px", textAlign: "center" }}>
                  Type to search notes, homework, and flashcards
                </p>
              ) : null}
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}
