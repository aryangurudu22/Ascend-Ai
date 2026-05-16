// ============================================================
// FILE: app/syllabus/page.js
// PURPOSE: Syllabus Coverage Tracker — view and tick off Cambridge topics.
// URL: /syllabus
// ============================================================

"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { SUBJECTS } from "../../lib/subjects";
import { supabase } from "../../lib/supabaseClient";
import SubjectBadge from "../components/SubjectBadge";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

const FILTER_ALL = "all";

const INITIAL_UPLOAD_STATUS = {
  economics: "idle",
  business: "idle",
  english: "idle",
  ict: "idle",
};

const INITIAL_TOPIC_COUNTS = {
  economics: 0,
  business: 0,
  english: 0,
  ict: 0,
};

const uploadSlotStyle = {
  background: "var(--card)",
  border: "0.5px solid var(--gold-border-hover)",
  borderRadius: "10px",
  padding: "16px",
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: "10px",
  minWidth: 0,
  transition: "border-color 200ms, background 200ms",
};

const SYLLABUS_FILTER_OPTIONS = [
  { value: FILTER_ALL, label: "All" },
  { value: "economics", label: "Economics" },
  { value: "business", label: "Business" },
  { value: "english", label: "English" },
  { value: "ict", label: "ICT" },
];

/** Coverage bar / percentage colour from percentage band. */
function coverageColor(percentage) {
  if (percentage >= 70) return "var(--biz-text)";
  if (percentage >= 40) return "var(--gold)";
  return "var(--exam-urgent)";
}

/** Group topic rows by chapter field for collapsible sections. */
function groupTopicsByChapter(items) {
  const chapters = {};
  for (const t of items || []) {
    const ch = (t.chapter && String(t.chapter).trim()) || "General Topics";
    if (!chapters[ch]) chapters[ch] = [];
    chapters[ch].push(t);
  }
  return chapters;
}

/** Format covered_at ISO string for display. */
function formatCoveredDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
    });
  } catch {
    return "";
  }
}

/** Days until nearest exam from onboarding localStorage data. */
function minDaysToExam() {
  try {
    const raw = localStorage.getItem("ascendai_onboarding_data");
    if (!raw) return null;
    const data = JSON.parse(raw);
    const dates = data.examDates || {};
    let min = null;
    const now = Date.now();
    for (const key of Object.keys(dates)) {
      const d = new Date(dates[key]);
      if (!Number.isNaN(d.getTime())) {
        const diff = Math.ceil((d.getTime() - now) / 86400000);
        if (min === null || diff < min) min = diff;
      }
    }
    return min;
  } catch {
    return null;
  }
}

function SyllabusTabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontFamily: "Inter, sans-serif",
        fontSize: "13px",
        fontWeight: active ? 500 : 400,
        color: active ? "var(--gold)" : "var(--text-muted)",
        borderBottom: active ? "2px solid var(--gold)" : "2px solid transparent",
        paddingBottom: "10px",
        paddingLeft: "4px",
        paddingRight: "4px",
        marginBottom: "-1px",
        background: "none",
        borderTop: "none",
        borderLeft: "none",
        borderRight: "none",
        cursor: "pointer",
        transition: "color 200ms ease",
      }}
    >
      {children}
    </button>
  );
}

function CoverageSkeletonCard() {
  return (
    <div
      style={{
        background: "var(--card)",
        border: "0.5px solid var(--gold-border)",
        borderRadius: "10px",
        padding: "16px 20px",
      }}
    >
      <motion.div
        animate={{ opacity: [0.4, 0.7, 0.4] }}
        transition={{ duration: 1.4, repeat: Infinity }}
      >
        <div
          style={{
            height: 14,
            width: 72,
            background: "var(--card-hover)",
            borderRadius: 4,
            marginBottom: 12,
          }}
        />
        <div
          style={{
            height: 28,
            width: "50%",
            background: "var(--card-hover)",
            borderRadius: 4,
          }}
        />
        <div
          style={{
            height: 6,
            background: "var(--border)",
            borderRadius: 3,
          }}
        />
      </motion.div>
    </div>
  );
}

function ChapterSkeletonRow() {
  return (
    <div
      style={{
        background: "var(--card)",
        border: "0.5px solid var(--gold-border)",
        borderRadius: "8px",
        padding: "14px 16px",
        marginBottom: 8,
      }}
    >
      <motion.div
        animate={{ opacity: [0.4, 0.7, 0.4] }}
        transition={{ duration: 1.4, repeat: Infinity }}
        style={{
          height: 14,
          width: "60%",
          background: "var(--card-hover)",
          borderRadius: 4,
        }}
      />
    </div>
  );
}

export default function SyllabusTrackerPage() {
  const router = useRouter();
  const [topics, setTopics] = useState({});
  const [coverage, setCoverage] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeSubject, setActiveSubject] = useState("all");
  const [expandedChapters, setExpandedChapters] = useState({});
  const [session, setSession] = useState(null);
  const [uploadStatus, setUploadStatus] = useState(INITIAL_UPLOAD_STATUS);
  const [topicCounts, setTopicCounts] = useState(INITIAL_TOPIC_COUNTS);
  const fileRefs = {
    economics: useRef(null),
    business: useRef(null),
    english: useRef(null),
    ict: useRef(null),
  };

  const daysToExam = useMemo(() => minDaysToExam(), []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data?.session ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s ?? null);
    });
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  const fetchTopics = useCallback(
    async (withLoading = true) => {
      if (!session?.access_token) {
        if (withLoading) setLoading(false);
        return;
      }
      if (withLoading) setLoading(true);
      try {
        const res = await fetch(`${API_URL}/syllabus/topics`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail?.error || "Failed to load topics");
        setTopics(data.topics || {});
        setCoverage(data.coverage || {});
      } catch (err) {
        console.error("[Syllabus]", err);
        setTopics({});
        setCoverage({});
      } finally {
        if (withLoading) setLoading(false);
      }
    },
    [session]
  );

  const handleFileChange = async (subjectKey, file) => {
    if (!file) return;

    setUploadStatus((prev) => ({ ...prev, [subjectKey]: "uploading" }));

    try {
      let activeToken = session?.access_token;
      let activeUid = session?.user?.id;
      if (!activeToken || !activeUid) {
        const { data: sessionData } = await supabase.auth.getSession();
        activeToken = sessionData?.session?.access_token;
        activeUid = sessionData?.session?.user?.id;
      }
      if (!activeToken || !activeUid) {
        throw new Error("Please sign in to upload a syllabus.");
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("subject", subjectKey);
      formData.append("user_id", activeUid);

      const extractRes = await fetch(`${API_URL}/syllabus/extract`, {
        method: "POST",
        headers: { Authorization: `Bearer ${activeToken}` },
        body: formData,
      });

      const extractData = await extractRes.json().catch(() => ({}));

      if (!extractRes.ok || extractData.error) {
        throw new Error(
          extractData?.detail?.error ||
            extractData?.error ||
            `Extract failed (${extractRes.status})`
        );
      }

      const extractedTopics = extractData.topics || [];
      if (!extractedTopics.length) {
        throw new Error("No topics found in this PDF.");
      }

      const saveRes = await fetch(`${API_URL}/syllabus/save-topics`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeToken}`,
        },
        body: JSON.stringify({
          subject: subjectKey,
          topics: extractedTopics,
          user_id: activeUid,
        }),
      });

      const saveData = await saveRes.json().catch(() => ({}));

      if (!saveRes.ok || saveData.error) {
        throw new Error(
          saveData?.detail?.error ||
            saveData?.error ||
            `Save failed (${saveRes.status})`
        );
      }

      const count = saveData.saved ?? extractedTopics.length;
      setTopicCounts((prev) => ({ ...prev, [subjectKey]: count }));
      setUploadStatus((prev) => ({ ...prev, [subjectKey]: "done" }));

      await fetchTopics(false);
    } catch (err) {
      console.error("[Syllabus] upload", subjectKey, err);
      setUploadStatus((prev) => ({ ...prev, [subjectKey]: "error" }));
    }
  };

  useEffect(() => {
    if (session) fetchTopics();
  }, [session, fetchTopics]);

  const hasAnyTopics = useMemo(() => {
    return SUBJECTS.some((s) => (topics[s.key] || []).length > 0);
  }, [topics]);

  const subjectsToShow =
    activeSubject === FILTER_ALL
      ? SUBJECTS.map((s) => s.key)
      : [activeSubject];

  const displayTopicsList = useMemo(() => {
    if (activeSubject === FILTER_ALL) {
      const merged = [];
      for (const key of subjectsToShow) {
        for (const t of topics[key] || []) {
          merged.push({ ...t, _subject: key });
        }
      }
      return merged;
    }
    return (topics[activeSubject] || []).map((t) => ({
      ...t,
      _subject: activeSubject,
    }));
  }, [topics, activeSubject, subjectsToShow]);

  const chaptersGrouped = useMemo(
    () => groupTopicsByChapter(displayTopicsList),
    [displayTopicsList]
  );

  const toggleChapter = (chapterName) => {
    setExpandedChapters((prev) => ({
      ...prev,
      [chapterName]: !prev[chapterName],
    }));
  };

  /** Optimistic PATCH toggle for a topic row. */
  const handleToggleTopic = async (topic) => {
    if (topic.is_global || !session?.access_token) return;

    const prevCovered = topic.is_covered;
    const prevCoveredAt = topic.covered_at;
    const nextCovered = !prevCovered;
    const nextCoveredAt = nextCovered ? new Date().toISOString() : null;

    const patchLocal = (list) =>
      list.map((t) =>
        t.id === topic.id
          ? { ...t, is_covered: nextCovered, covered_at: nextCoveredAt }
          : t
      );

    setTopics((prev) => {
      const next = { ...prev };
      const subKey = topic._subject || activeSubject;
      if (subKey && subKey !== FILTER_ALL) {
        next[subKey] = patchLocal(next[subKey] || []);
      } else {
        for (const k of Object.keys(next)) {
          next[k] = patchLocal(next[k] || []);
        }
      }
      return next;
    });

    try {
      const res = await fetch(
        `${API_URL}/syllabus/topics/${topic.id}/toggle`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );
      if (!res.ok) throw new Error("Toggle failed");
      const data = await res.json();
      setTopics((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          next[k] = (next[k] || []).map((t) =>
            t.id === topic.id
              ? {
                  ...t,
                  is_covered: data.is_covered,
                  covered_at: data.covered_at,
                }
              : t
          );
        }
        return next;
      });
      fetchTopics();
    } catch (err) {
      console.error("[Syllabus] toggle", err);
      setTopics((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          next[k] = (next[k] || []).map((t) =>
            t.id === topic.id
              ? {
                  ...t,
                  is_covered: prevCovered,
                  covered_at: prevCoveredAt,
                }
              : t
          );
        }
        return next;
      });
    }
  };

  return (
    <motion.main
      style={{ minHeight: "100vh", background: "var(--bg)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <style jsx global>{`
        .syllabus-coverage-grid {
          margin: 20px var(--page-padding) 0;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px;
        }
        @media (max-width: 767px) {
          .syllabus-coverage-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
      `}</style>

      <div
        style={{
          padding: "16px var(--page-padding) 0",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Link
          href="/dashboard"
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            color: "var(--text-muted)",
            textDecoration: "none",
          }}
        >
          ← Dashboard
        </Link>
        <span style={{ color: "var(--text-muted)" }}>/</span>
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            color: "var(--text-dim)",
          }}
        >
          Syllabus Tracker
        </span>
      </div>

      <header style={{ padding: "32px var(--page-padding) 0" }}>
        <h1
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: "28px",
            color: "var(--text)",
            fontWeight: 700,
            margin: 0,
          }}
        >
          Syllabus Tracker
        </h1>
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            color: "var(--text-muted)",
            marginTop: 4,
            marginBottom: 0,
          }}
        >
          Track your Cambridge AS Level coverage
        </p>
      </header>

      <nav
        aria-label="Subject filters"
        style={{
          margin: "20px var(--page-padding) 0",
          borderBottom: "1px solid var(--border-light)",
          display: "flex",
          gap: 24,
          flexWrap: "wrap",
        }}
      >
        {SYLLABUS_FILTER_OPTIONS.map((opt) => (
          <SyllabusTabButton
            key={opt.value}
            active={activeSubject === opt.value}
            onClick={() => setActiveSubject(opt.value)}
          >
            {opt.label}
          </SyllabusTabButton>
        ))}
      </nav>

      {loading ? (
        <>
          <div className="syllabus-coverage-grid">
            <CoverageSkeletonCard />
            <CoverageSkeletonCard />
            <CoverageSkeletonCard />
            <CoverageSkeletonCard />
          </div>
          <div style={{ margin: "20px var(--page-padding)" }}>
            <ChapterSkeletonRow />
            <ChapterSkeletonRow />
            <ChapterSkeletonRow />
          </div>
        </>
      ) : !hasAnyTopics ? (
        <div
          style={{
            margin: "40px var(--page-padding)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div
            style={{
              textAlign: "center",
              background: "var(--card)",
              border: "0.5px solid var(--gold-border)",
              borderRadius: 10,
              padding: "40px 24px",
              width: "100%",
              maxWidth: 480,
            }}
          >
            <p
              style={{
                fontFamily: "'Playfair Display', serif",
                fontSize: 16,
                color: "var(--text)",
                margin: 0,
              }}
            >
              No syllabus uploaded yet
            </p>
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 13,
                color: "var(--text-muted)",
                marginTop: 8,
                marginBottom: 20,
              }}
            >
              Upload your Cambridge syllabus PDFs during onboarding or use the
              default topic set
            </p>
            <button
              type="button"
              onClick={() => router.push("/onboarding/connect-google")}
              style={{
                background: "var(--gold)",
                color: "var(--bg)",
                border: "none",
                borderRadius: 8,
                padding: "10px 20px",
                fontFamily: "Inter, sans-serif",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Upload Syllabus
            </button>
          </div>

          <div
            style={{
              marginTop: "24px",
              maxWidth: "480px",
              width: "100%",
            }}
          >
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "12px",
                color: "var(--text-muted)",
                textAlign: "center",
                marginBottom: "16px",
              }}
            >
              Or upload directly here:
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
              }}
            >
              {SUBJECTS.map((sub) => {
                const status = uploadStatus[sub.key];
                const count = topicCounts[sub.key];

                let statusText = "Not uploaded yet";
                let statusColor = "var(--text-muted)";
                if (status === "uploading") {
                  statusText = "Extracting topics...";
                  statusColor = "var(--gold)";
                } else if (status === "done") {
                  statusText = `${count} topics extracted`;
                  statusColor = "var(--biz-text)";
                } else if (status === "error") {
                  statusText = "Upload failed — try again";
                  statusColor = "var(--exam-urgent)";
                }

                return (
                  <div key={sub.key} style={uploadSlotStyle}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "10px",
                        minWidth: 0,
                      }}
                    >
                      <SubjectBadge subject={sub.key} showCode />
                      <p
                        style={{
                          fontFamily: "Inter, sans-serif",
                          fontSize: "13px",
                          fontWeight: 500,
                          color: "var(--text)",
                          margin: 0,
                          lineHeight: 1.35,
                          flex: 1,
                          minWidth: 0,
                          wordBreak: "break-word",
                        }}
                      >
                        {sub.fullName}
                      </p>
                    </div>

                    <p
                      style={{
                        fontFamily: "Inter, sans-serif",
                        fontSize: "11px",
                        color: statusColor,
                        margin: 0,
                        lineHeight: 1.4,
                      }}
                    >
                      {statusText}
                    </p>

                    <input
                      ref={fileRefs[sub.key]}
                      type="file"
                      accept=".pdf"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFileChange(sub.key, f);
                        e.target.value = "";
                      }}
                    />

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        alignItems: "center",
                        minHeight: "32px",
                      }}
                    >
                      {status === "done" ? (
                        <span
                        style={{
                          width: "24px",
                          height: "24px",
                          borderRadius: "50%",
                          background: "var(--gold)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                        aria-hidden
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="var(--bg)"
                          strokeWidth="2.5"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </span>
                    ) : status === "error" ? (
                      <button
                        type="button"
                        onClick={() => fileRefs[sub.key].current?.click()}
                        style={{
                          background: "transparent",
                          border:
                            "0.5px solid color-mix(in srgb, var(--exam-urgent) 40%, transparent)",
                          borderRadius: "6px",
                          padding: "6px 14px",
                          fontFamily: "Inter, sans-serif",
                          fontSize: "11px",
                          color: "var(--exam-urgent)",
                          cursor: "pointer",
                          flexShrink: 0,
                        }}
                      >
                        Retry
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={status === "uploading"}
                        onClick={() => fileRefs[sub.key].current?.click()}
                        style={{
                          background: "transparent",
                          border: "0.5px solid var(--gold-border-hover)",
                          borderRadius: "6px",
                          padding: "6px 14px",
                          fontFamily: "Inter, sans-serif",
                          fontSize: "11px",
                          color: "var(--gold)",
                          cursor: status === "uploading" ? "wait" : "pointer",
                          flexShrink: 0,
                        }}
                      >
                        {status === "uploading" ? "…" : "Upload PDF"}
                      </button>
                    )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="syllabus-coverage-grid">
            {SUBJECTS.map((sub) => {
              const cov = coverage[sub.key] || {
                covered: 0,
                total: 0,
                percentage: 0,
              };
              const pct = cov.percentage ?? 0;
              const fillColor = coverageColor(pct);
              const showUrgent =
                daysToExam !== null &&
                daysToExam < 30 &&
                pct < 70 &&
                cov.total > 0;

              return (
                <div
                  key={sub.key}
                  style={{
                    background: "var(--card)",
                    border: "0.5px solid var(--gold-border)",
                    borderRadius: 10,
                    padding: "16px 20px",
                  }}
                >
                  <SubjectBadge subject={sub.key} />
                  <p
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: 28,
                      fontWeight: 700,
                      color: fillColor,
                      margin: "12px 0 4px",
                    }}
                  >
                    {pct}%
                  </p>
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: 11,
                      color: "var(--text-muted)",
                      margin: "0 0 10px",
                    }}
                  >
                    {cov.covered} of {cov.total} topics
                  </p>
                  <div
                    style={{
                      height: 6,
                      background: "var(--border)",
                      borderRadius: 3,
                      overflow: "hidden",
                    }}
                  >
                    <motion.div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: fillColor,
                        borderRadius: 3,
                        transition: "width 600ms ease",
                      }}
                    />
                  </div>
                  {showUrgent && (
                    <p
                      style={{
                        fontFamily: "Inter, sans-serif",
                        fontSize: 10,
                        color: "var(--exam-urgent)",
                        marginTop: 6,
                        marginBottom: 0,
                      }}
                    >
                      ⚠ Exam soon
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <section style={{ margin: "20px var(--page-padding) 40px" }}>
            {Object.keys(chaptersGrouped).map((chapterName) => {
              const chapterTopics = chaptersGrouped[chapterName];
              const coveredInChapter = chapterTopics.filter(
                (t) => t.is_covered
              ).length;
              const expanded = expandedChapters[chapterName];

              return (
                <div key={chapterName} style={{ marginBottom: 12 }}>
                  <button
                    type="button"
                    onClick={() => toggleChapter(chapterName)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: "var(--card)",
                      border: "0.5px solid var(--gold-border)",
                      borderRadius: 8,
                      padding: "12px 16px",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "Inter, sans-serif",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text)",
                      }}
                    >
                      {chapterName}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          fontFamily: "Inter, sans-serif",
                          fontSize: 11,
                          color: "var(--text-muted)",
                        }}
                      >
                        {coveredInChapter}/{chapterTopics.length} topics
                      </span>
                      <ChevronDown
                        size={16}
                        style={{
                          color: "var(--text-muted)",
                          transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                          transition: "transform 200ms",
                        }}
                      />
                    </span>
                  </button>
                  <div
                    style={{
                      height: 4,
                      background: "var(--border)",
                      borderRadius: 2,
                      marginTop: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${
                          chapterTopics.length
                            ? (coveredInChapter / chapterTopics.length) * 100
                            : 0
                        }%`,
                        background: "var(--gold)",
                        transition: "width 400ms ease",
                      }}
                    />
                  </div>

                  {expanded && (
                    <div style={{ margin: "8px 0 16px" }}>
                      {chapterTopics.map((topic) => (
                        <div
                          key={topic.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => handleToggleTopic(topic)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleToggleTopic(topic);
                            }
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            padding: "10px 12px",
                            borderRadius: 6,
                            cursor: topic.is_global ? "default" : "pointer",
                            opacity: topic.is_global ? 0.85 : 1,
                          }}
                          onMouseEnter={(e) => {
                            if (!topic.is_global) {
                              e.currentTarget.style.background =
                                "var(--card-hover)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          <span
                            style={{
                              width: 20,
                              height: 20,
                              flexShrink: 0,
                              border: topic.is_covered
                                ? "none"
                                : "0.5px solid var(--checkbox-border)",
                              borderRadius: 4,
                              background: topic.is_covered
                                ? "var(--gold)"
                                : "transparent",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {topic.is_covered && (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="var(--bg)"
                                strokeWidth="2.5"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </span>
                          <span
                            style={{
                              flex: 1,
                              fontFamily: "Inter, sans-serif",
                              fontSize: 13,
                              color: topic.is_covered
                                ? "var(--text-dim)"
                                : "var(--text)",
                              textDecoration: topic.is_covered
                                ? "line-through"
                                : "none",
                              lineHeight: 1.5,
                            }}
                          >
                            {topic.topic_name}
                          </span>
                          {topic.is_covered && topic.covered_at && (
                            <span
                              style={{
                                fontFamily: "Inter, sans-serif",
                                fontSize: 10,
                                color: "var(--text-extra-dim)",
                                flexShrink: 0,
                              }}
                            >
                              Covered {formatCoveredDate(topic.covered_at)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </>
      )}
    </motion.main>
  );
}
