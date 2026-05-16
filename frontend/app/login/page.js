// ============================================================
// FILE: app/login/page.js
// PURPOSE: Login page — split hero + Google OAuth sign-in.
//          Supabase OAuth logic unchanged; JSX only redesigned.
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { useTheme } from "../context/ThemeContext";
import GrainOverlay from "../components/GrainOverlay";
import { SUBJECTS } from "../../lib/subjects";

const FEATURE_PILLS = [
  "✓ Model Answers",
  "✓ Smart Notes",
  "✓ Spaced Repetition",
  "✓ Past Papers",
];

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlError = params.get("error");
    if (urlError === "auth_cancelled") {
      setError("Sign-in was cancelled. Please try again.");
    } else if (urlError === "auth_failed") {
      const msg = params.get("message") ?? "Authentication failed.";
      setError(msg);
    }
  }, []);

  useEffect(() => {
    const checkExistingSession = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        router.replace("/dashboard");
      }
    };
    checkExistingSession();
  }, [router]);

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError(null);

    try {
      const callbackUrl = `${window.location.origin}/auth/callback`;
      const googleScopes = [
        "email",
        "profile",
        "https://www.googleapis.com/auth/classroom.courses.readonly",
        "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
        "https://www.googleapis.com/auth/classroom.announcements.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/youtube.readonly",
      ].join(" ");

      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: callbackUrl,
          scopes: googleScopes,
          queryParams: {
            access_type: "offline",
            prompt: "consent",
          },
        },
      });

      if (oauthError) throw oauthError;
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const themeToggleStyle = {
    position: "absolute",
    top: "24px",
    right: "24px",
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: "var(--toggle-bg)",
    border: "0.5px solid var(--toggle-border)",
    color: "var(--toggle-color)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 16,
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        width: "100%",
        display: "flex",
        flexDirection: "row",
        background: "var(--bg)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes login-float {
          0% { transform: translate(0, 0); }
          50% { transform: translate(30px, 20px); }
          100% { transform: translate(0, 0); }
        }
        .login-hero-col { width: 60%; }
        .login-form-col { width: 40%; }
        .login-google-btn:hover {
          background: var(--nav-icon-bg) !important;
          border-color: var(--gold-border-active) !important;
        }
        @media (max-width: 767px) {
          .login-hero-col { display: none !important; }
          .login-form-col { width: 100% !important; }
        }
      `}</style>

      <GrainOverlay />

      {/* ── LEFT — Hero column (hidden on mobile) ─────────────── */}
      <section
        className="login-hero-col"
        style={{
          position: "relative",
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "60px 80px",
          overflow: "hidden",
        }}
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            width: "600px",
            height: "600px",
            borderRadius: "50%",
            background: "radial-gradient(circle, var(--nav-icon-bg) 0%, transparent 70%)",
            top: "-100px",
            left: "-100px",
            animation: "login-float 8s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />

        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={{ marginBottom: "48px" }}>
            <p style={{ fontFamily: "'Playfair Display', serif", fontSize: "28px", color: "var(--gold)", fontWeight: 700, margin: 0 }}>
              AscendAI
            </p>
            <p style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--gold-text-dim)", marginTop: "4px", marginBottom: 0 }}>
              by Shivora
            </p>
          </div>

          <div style={{ textAlign: "center", maxWidth: "520px", margin: "0 auto" }}>
            <span
              style={{
                display: "inline-block",
                background: "var(--toggle-bg)",
                border: "0.5px solid var(--toggle-border)",
                borderRadius: "20px",
                padding: "4px 14px",
                fontFamily: "Inter, sans-serif",
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "var(--gold)",
                marginBottom: "24px",
              }}
            >
              CAMBRIDGE AS LEVEL
            </span>

            <h1
              style={{
                fontFamily: "'Playfair Display', serif",
                fontSize: "clamp(36px, 5vw, 64px)",
                color: "var(--text)",
                fontWeight: 700,
                lineHeight: 1.1,
                letterSpacing: "-0.03em",
                margin: 0,
              }}
            >
              Study smarter.
            </h1>
            <h1
              style={{
                fontFamily: "'Playfair Display', serif",
                fontSize: "clamp(36px, 5vw, 64px)",
                color: "var(--gold)",
                fontWeight: 700,
                lineHeight: 1.1,
                letterSpacing: "-0.03em",
                margin: "0 0 16px",
              }}
            >
              Achieve more.
            </h1>

            <p
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "15px",
                color: "var(--text-muted)",
                lineHeight: 1.6,
                maxWidth: "400px",
                margin: "16px auto 0",
              }}
            >
              AI-powered Cambridge AS Level study assistant for{" "}
              {SUBJECTS.map((s) => s.name).join(", ")}
            </p>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", marginTop: "24px" }}>
              {FEATURE_PILLS.map((pill) => (
                <span
                  key={pill}
                  style={{
                    background: "var(--nav-icon-bg)",
                    border: "0.5px solid var(--gold-border-hover)",
                    borderRadius: "20px",
                    padding: "4px 12px",
                    fontFamily: "Inter, sans-serif",
                    fontSize: "12px",
                    color: "var(--text-dim)",
                  }}
                >
                  {pill}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── RIGHT — Sign-in column ───────────────────────────── */}
      <section
        className="login-form-col"
        style={{
          background: "var(--card)",
          borderLeft: "0.5px solid var(--chat-bubble-border)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "60px 48px",
          position: "relative",
          minHeight: "100vh",
        }}
      >
        <button type="button" onClick={toggleTheme} aria-label="Toggle theme" style={themeToggleStyle}>
          {theme === "dark" ? "☀" : "☾"}
        </button>

        <div className="login-mobile-logo" style={{ display: "none", textAlign: "center", marginBottom: "32px" }}>
          <p style={{ fontFamily: "'Playfair Display', serif", fontSize: "28px", color: "var(--gold)", fontWeight: 700, margin: 0 }}>
            AscendAI
          </p>
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "11px", color: "var(--gold-text-dim)", marginTop: "4px" }}>
            by Shivora
          </p>
        </div>

        <style>{`
          @media (max-width: 767px) {
            .login-mobile-logo { display: block !important; }
          }
        `}</style>

        <div style={{ width: "100%", maxWidth: "360px" }}>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: "28px", color: "var(--text)", fontWeight: 700, textAlign: "center", marginBottom: "8px", marginTop: 0 }}>
            Welcome back
          </h2>
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text-muted)", textAlign: "center", marginBottom: "40px", marginTop: 0 }}>
            Sign in to continue your Cambridge journey
          </p>

          {error ? (
            <div
              style={{
                marginBottom: "16px",
                padding: "12px",
                borderRadius: "8px",
                border: "0.5px solid var(--exam-urgent)",
                background: "var(--nav-icon-bg)",
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                color: "var(--exam-urgent)",
              }}
            >
              {error}
            </div>
          ) : null}

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="login-google-btn"
            style={{
              width: "100%",
              height: "52px",
              background: "var(--card-hover)",
              border: "0.5px solid var(--gold-border-active)",
              borderRadius: "10px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              cursor: loading ? "wait" : "pointer",
              transition: "background 200ms, border-color 200ms",
              opacity: loading ? 0.7 : 1,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: "15px", fontWeight: 500, color: "var(--text)" }}>
              {loading ? "Redirecting…" : "Continue with Google"}
            </span>
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: "12px", margin: "24px 0" }}>
            <span style={{ flex: 1, height: "1px", background: "var(--border)" }} />
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--text-muted)" }}>or</span>
            <span style={{ flex: 1, height: "1px", background: "var(--border)" }} />
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
            <Lock size={12} color="var(--text-muted)" aria-hidden />
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: "12px", color: "var(--text-muted)", textAlign: "center" }}>
              Secure & private · No password required
            </span>
          </div>
        </div>

        <p
          style={{
            position: "absolute",
            bottom: "24px",
            left: 0,
            right: 0,
            fontFamily: "Inter, sans-serif",
            fontSize: "11px",
            color: "var(--text-muted)",
            textAlign: "center",
            margin: 0,
          }}
        >
          Premium Cambridge-focused AI study assistant
        </p>
      </section>
    </main>
  );
}
