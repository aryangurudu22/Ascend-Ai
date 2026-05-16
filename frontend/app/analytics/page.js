// ============================================================
// FILE: app/analytics/page.js
// PURPOSE: Study Analytics — summary stats, subject breakdown,
//          and recent activity feed from backend /analytics/*.
// ============================================================

"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { motion, useInView } from "framer-motion";
import { supabase } from "@/lib/supabaseClient";
import { SUBJECTS, getSubjectByKey } from "@/lib/subjects";
import SubjectBadge from "@/app/components/SubjectBadge";
import { staggerContainer, staggerItem, fadeUp } from "@/app/lib/animations";

// Backend base URL — same env var as dashboard and homework pages.
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

// Period tabs map UI labels → API query values.
const PERIOD_TABS = [
  { label: "This Week", value: "week" },
  { label: "This Month", value: "month" },
  { label: "All Time", value: "all" },
];

// Progress bar fill colour per subject (CSS variables only).
const SUBJECT_BAR_COLOR = {
  economics: "var(--econ-text)",
  business: "var(--biz-text)",
  english: "var(--eng-text)",
  ict: "var(--ict-text)",
};

// Activity row icon SVGs by event type (16px, stroke currentColor).
function ActivityIcon({ type }) {
  const props = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    "aria-hidden": true,
  };

  if (type === "homework") {
    return (
      <svg {...props}>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    );
  }
  if (type === "note") {
    return (
      <svg {...props}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    );
  }
  if (type === "quiz") {
    return (
      <svg {...props}>
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    );
  }
  if (type === "paper") {
    return (
      <svg {...props}>
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

export default function AnalyticsPage() {
  // period — API window: week | month | all (driven by period tabs).
  const [period, setPeriod] = useState("week");

  // summary — headline counts from GET /analytics/summary.
  const [summary, setSummary] = useState(null);

  // breakdown — per-subject percentages from GET /analytics/subject-breakdown.
  const [breakdown, setBreakdown] = useState([]);

  // activities — recent feed from GET /analytics/activity-feed.
  const [activities, setActivities] = useState([]);

  // loading — true while any analytics request is in flight.
  const [loading, setLoading] = useState(true);

  // session — Supabase session for Bearer token on API calls.
  const [session, setSession] = useState(null);

  // statsRef — triggers stagger animation when stats scroll into view.
  const statsRef = useRef(null);
  const statsInView = useInView(statsRef, { once: true, margin: "-40px" });

  // isMobile — stats grid uses 2 columns below 768px.
  const [isMobile, setIsMobile] = useState(false);

  // Load Supabase session on mount.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s || null);
    });
  }, []);

  // Track viewport for responsive stat grid.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Fetch all three analytics endpoints when period or session changes.
  useEffect(() => {
    const token = session?.access_token;
    if (!token) {
      setLoading(false);
      return;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
    };

    const fetchAll = async () => {
      setLoading(true);
      try {
        const [summaryRes, breakdownRes, feedRes] = await Promise.all([
          fetch(`${API_URL}/analytics/summary?period=${period}`, { headers }),
          fetch(`${API_URL}/analytics/subject-breakdown?period=${period}`, {
            headers,
          }),
          fetch(`${API_URL}/analytics/activity-feed`, { headers }),
        ]);

        if (summaryRes.ok) {
          setSummary(await summaryRes.json());
        } else {
          setSummary(null);
        }

        if (breakdownRes.ok) {
          const data = await breakdownRes.json();
          setBreakdown(data.breakdown || []);
        } else {
          setBreakdown([]);
        }

        if (feedRes.ok) {
          const data = await feedRes.json();
          setActivities(data.activities || []);
        } else {
          setActivities([]);
        }
      } catch {
        setSummary(null);
        setBreakdown([]);
        setActivities([]);
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
  }, [period, session]);

  // Full-page empty when every metric is zero and the feed is empty.
  const showEmpty =
    !loading &&
    activities.length === 0 &&
    summary &&
    summary.questions_asked === 0 &&
    summary.flashcard_sessions === 0 &&
    summary.papers_solved === 0;

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
      label: "PAST PAPERS SOLVED",
    },
    {
      value:
        summary?.avg_quiz_score != null
          ? `${summary.avg_quiz_score}%`
          : "0%",
      label: "AVERAGE QUIZ SCORE",
    },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
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
          ← Dashboard / <span style={{ color: "var(--text)" }}>Study Analytics</span>
        </Link>
      </div>

      {/* Page header */}
      <motion.header
        style={{ padding: "20px var(--page-padding) 0" }}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
      >
        <h1
          style={{
            fontFamily: "var(--font-playfair), 'Playfair Display', serif",
            fontSize: 28,
            color: "var(--text)",
            fontWeight: 700,
            margin: 0,
          }}
        >
          Study Analytics
        </h1>
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 13,
            color: "var(--text-muted)",
            marginTop: 4,
          }}
        >
          Track your progress across all subjects
        </p>
      </motion.header>

      {/* Period tabs — map label to API period value on click */}
      <motion.div
        style={{
          margin: "20px var(--page-padding) 0",
          borderBottom: "1px solid var(--border-light)",
          display: "flex",
          gap: 24,
        }}
      >
        {PERIOD_TABS.map((tab) => {
          const active = period === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => setPeriod(tab.value)}
              style={{
                background: "none",
                border: "none",
                borderBottom: active ? "2px solid var(--gold)" : "2px solid transparent",
                paddingBottom: 10,
                marginBottom: -1,
                fontFamily: "Inter, sans-serif",
                fontSize: 13,
                fontWeight: active ? 500 : 400,
                color: active ? "var(--gold)" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </motion.div>

      {/* STATS ROW — 4 cards from summary API */}
      <div style={{
        margin: '20px var(--page-padding) 0',
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '12px',
      }}>
        {[
          {
            value: summary?.questions_asked ?? 0,
            label: 'QUESTIONS ASKED'
          },
          {
            value: summary?.flashcard_sessions ?? 0,
            label: 'FLASHCARD SESSIONS'
          },
          {
            value: summary?.papers_solved ?? 0,
            label: 'PAST PAPERS SOLVED'
          },
          {
            value: summary?.avg_quiz_score
              ? `${summary.avg_quiz_score}%`
              : '0%',
            label: 'AVERAGE QUIZ SCORE'
          },
        ].map((stat, index) => (
          <div key={index} style={{
            background: 'var(--card)',
            border: '0.5px solid rgba(212,178,55,0.25)',
            borderRadius: '10px',
            padding: '16px 20px',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <span style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: '32px',
              fontWeight: 700,
              color: 'var(--gold)',
              lineHeight: 1,
            }}>
              {stat.value}
            </span>
            <span style={{
              fontFamily: 'Inter, sans-serif',
              fontSize: '10px',
              fontWeight: 500,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--date-color)',
              marginTop: '6px',
            }}>
              {stat.label}
            </span>
          </div>
        ))}
      </div>

      {showEmpty ? (
        <motion.div
          style={{
            margin: "40px var(--page-padding)",
            padding: "48px 24px",
            textAlign: "center",
            background: "var(--card)",
            border: "0.5px solid var(--gold-border-hover)",
            borderRadius: 10,
          }}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <svg
            width={32}
            height={32}
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--gold-icon)"
            strokeWidth={2}
            aria-hidden
          >
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          <p
            style={{
              fontFamily: "var(--font-playfair), 'Playfair Display', serif",
              fontSize: 16,
              color: "var(--text)",
              marginTop: 16,
              marginBottom: 0,
            }}
          >
            No activity yet
          </p>
          <p
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: 13,
              color: "var(--text-muted)",
              marginTop: 8,
            }}
          >
            Start studying to see your analytics here
          </p>
        </motion.div>
      ) : (
        <>

          {/* Subject breakdown */}
          <section style={{ margin: "24px var(--page-padding) 0" }}>
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 11,
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "var(--date-color)",
                marginBottom: 16,
              }}
            >
              SUBJECT BREAKDOWN
            </p>

            <div
              style={{
                background: "var(--card)",
                border: "0.5px solid var(--gold-border-hover)",
                borderRadius: 10,
                padding: "20px 24px",
              }}
            >
              {loading ? (
                <>
                  {[0, 1, 2, 3].map((i) => (
                    <motion.div
                      key={i}
                      className="analytics-skeleton"
                      style={{ height: 40, marginBottom: 12, borderRadius: 6 }}
                    />
                  ))}
                </>
              ) : (
                (breakdown.length ? breakdown : SUBJECTS.map((s) => ({ subject: s.key, percentage: 25 }))).map(
                  (row, idx, arr) => {
                    const meta = getSubjectByKey(row.subject);
                    const name = meta?.name || row.subject;
                    const pct = row.percentage ?? 0;
                    const isLast = idx === arr.length - 1;
                    return (
                      <div
                        key={row.subject}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          padding: "12px 0",
                          borderBottom: isLast ? "none" : "0.5px solid var(--border)",
                        }}
                      >
                        <SubjectBadge subject={row.subject} size="sm" />
                        <span
                          style={{
                            fontFamily: "Inter, sans-serif",
                            fontSize: 13,
                            color: "var(--text)",
                            width: 80,
                            flexShrink: 0,
                          }}
                        >
                          {name}
                        </span>
                        <motion.div
                          style={{
                            flex: 1,
                            height: 6,
                            background: "var(--border)",
                            borderRadius: 3,
                            overflow: "hidden",
                          }}
                        >
                          {/* Progress fill — width animates via CSS transition */}
                          <motion.div
                            className="analytics-bar-fill"
                            style={{
                              height: 6,
                              borderRadius: 3,
                              width: `${pct}%`,
                              background: SUBJECT_BAR_COLOR[row.subject] || "var(--gold)",
                            }}
                            initial={{ width: 0 }}
                            animate={{ width: `${pct}%` }}
                            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                          />
                        </motion.div>
                        <span
                          style={{
                            fontFamily: "Inter, sans-serif",
                            fontSize: 13,
                            fontWeight: 600,
                            color: "var(--text)",
                            width: 40,
                            textAlign: "right",
                            flexShrink: 0,
                          }}
                        >
                          {pct}%
                        </span>
                      </div>
                    );
                  }
                )
              )}
            </div>
          </section>

          {/* Recent activity */}
          <section style={{ margin: "24px var(--page-padding) 32px" }}>
            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 11,
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "var(--date-color)",
                marginBottom: 16,
              }}
            >
              RECENT ACTIVITY
            </p>

            <motion.div
              style={{
                background: "var(--card)",
                border: "0.5px solid var(--gold-border-hover)",
                borderRadius: 10,
                padding: "12px 24px",
              }}
            >
              {loading ? (
                <>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <motion.div
                      key={i}
                      className="analytics-skeleton"
                      style={{ height: 48, marginBottom: 8, borderRadius: 6 }}
                    />
                  ))}
                </>
              ) : activities.length === 0 ? (
                <p
                  style={{
                    fontFamily: "Inter, sans-serif",
                    fontSize: 13,
                    color: "var(--text-muted)",
                    textAlign: "center",
                    padding: "24px 0",
                  }}
                >
                  No recent activity for this period.
                </p>
              ) : (
                activities.map((act, idx) => {
                  const isLast = idx === activities.length - 1;
                  return (
                    <div
                      key={`${act.type}-${idx}-${act.time}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "12px 0",
                        borderBottom: isLast ? "none" : "0.5px solid var(--border)",
                      }}
                    >
                      <span
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: "50%",
                          background: "var(--card-hover)",
                          border: "0.5px solid var(--chat-bubble-border)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "var(--gold)",
                          flexShrink: 0,
                        }}
                      >
                        <ActivityIcon type={act.type} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p
                          style={{
                            fontFamily: "Inter, sans-serif",
                            fontSize: 13,
                            color: "var(--text)",
                            margin: 0,
                          }}
                        >
                          {act.description}
                        </p>
                        {act.subject ? (
                          <motion.div style={{ marginTop: 4 }}>
                            <SubjectBadge subject={act.subject} size="sm" />
                          </motion.div>
                        ) : null}
                      </div>
                      <span
                        style={{
                          fontFamily: "Inter, sans-serif",
                          fontSize: 11,
                          color: "var(--text-muted)",
                          flexShrink: 0,
                        }}
                      >
                        {act.time}
                      </span>
                    </div>
                  );
                })
              )}
            </motion.div>
          </section>
        </>
      )}

      <style>{`
        .analytics-skeleton {
          background: var(--card-hover);
          animation: analytics-pulse 1.5s ease-in-out infinite;
        }
        @keyframes analytics-pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        .analytics-bar-fill {
          transition: width 800ms cubic-bezier(0.16, 1, 0.3, 1);
        }
      `}</style>
    </div>
  );
}
