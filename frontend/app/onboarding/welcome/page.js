// ============================================================
// FILE: app/onboarding/welcome/page.js
// PURPOSE: Onboarding Step 1 — Welcome screen with subject preview.
// URL: /onboarding/welcome
// ============================================================

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../../lib/supabaseClient";
import { SUBJECTS } from "../../../lib/subjects";
import SubjectBadge from "../../components/SubjectBadge";
import {
  OnboardingShell,
  OnboardingHeading,
  OnboardingSubheading,
  ContinueButton,
} from "../onboarding-ui";

export default function OnboardingWelcome() {
  const router = useRouter();

  // Skip onboarding when profiles row already has full_name (works on every device).
  useEffect(() => {
    let cancelled = false;

    const checkProfile = async () => {
      // Read the signed-in session from Supabase auth.
      const { data: { session } } = await supabase.auth.getSession();

      if (cancelled) return;

      // Only query profiles when we have a logged-in user.
      if (session) {
        // Load this user's profile to see if onboarding is already done.
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("user_id", session.user.id)
          .single();

        if (cancelled) return;

        // If profile exists with full_name — onboarding is done.
        if (profile && profile.full_name) {
          router.replace("/dashboard");
          return;
        }
      }
    };

    checkProfile();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <OnboardingShell step={1}>
      {/* ── STEP 1 — Logo block ─────────────────────────────── */}
      <div style={{ textAlign: "center", marginBottom: "32px" }}>
        <p
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: "28px",
            color: "var(--gold)",
            margin: 0,
            fontWeight: 700,
          }}
        >
          AscendAI
        </p>
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "12px",
            color: "var(--gold-text-dim)",
            marginTop: "4px",
            marginBottom: 0,
          }}
        >
          by Shivora
        </p>
      </div>

      <OnboardingHeading>Welcome to AscendAI</OnboardingHeading>
      <OnboardingSubheading>Your Cambridge AS Level AI study assistant</OnboardingSubheading>

      {/* ── STEP 1 — 2×2 subject badge grid ─────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "12px",
          marginBottom: "24px",
        }}
      >
        {SUBJECTS.map((subject) => (
          <div
            key={subject.key}
            style={{
              background: "var(--card)",
              border: "0.5px solid var(--gold-border-hover)",
              borderRadius: "8px",
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <SubjectBadge subject={subject.key} label={subject.name} />
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: "13px", color: "var(--text)" }}>
              {subject.fullName}
            </span>
          </div>
        ))}
      </div>

      {/* ── STEP 1 — Welcome message card ───────────────────── */}
      <div
        style={{
          background: "var(--nav-icon-bg)",
          border: "0.5px solid var(--chat-bubble-border)",
          borderLeft: "2px solid var(--gold)",
          borderRadius: "6px",
          padding: "14px 16px",
          marginBottom: "8px",
        }}
      >
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
            color: "var(--text-dim)",
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          Let&apos;s set up your personalised study experience. This takes less than 2 minutes.
        </p>
      </div>

      {/* ── STEP 1 — Continue to exam dates ─────────────────── */}
      <ContinueButton href="/onboarding/exam-dates">Get Started →</ContinueButton>
    </OnboardingShell>
  );
}
