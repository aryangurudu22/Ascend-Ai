// ============================================================
// FILE: app/onboarding/features/page.js
// PURPOSE: Onboarding Step 5 — Feature tour; marks onboarding complete.
// URL: /onboarding/features
// ============================================================

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Pencil, FileText, Layers, Calendar, BookOpen } from "lucide-react";
import {
  OnboardingShell,
  OnboardingHeading,
  OnboardingSubheading,
  ContinueButton,
} from "../onboarding-ui";

const ONBOARDING_KEY = "ascendai_onboarding_completed";

const FEATURES = [
  {
    Icon: Pencil,
    title: "Homework Assistant",
    desc: "Get Cambridge-format model answers instantly",
  },
  {
    Icon: FileText,
    title: "Smart Notes",
    desc: "Auto-generated from your Google Classroom",
  },
  {
    Icon: Layers,
    title: "Adaptive Flashcards",
    desc: "AI cards with spaced repetition",
  },
  {
    Icon: Calendar,
    title: "Intelligent Timetable",
    desc: "2-week schedule built around your exams",
  },
  {
    Icon: BookOpen,
    title: "Past Paper Solver",
    desc: "Upload any Cambridge paper and get solutions",
  },
];

export default function OnboardingFeatures() {
  const router = useRouter();

  useEffect(() => {
    const alreadyCompleted = localStorage.getItem(ONBOARDING_KEY) === "true";
    if (alreadyCompleted) {
      console.log("[OnboardingFeatures] Onboarding already done – redirecting to /dashboard");
      router.replace("/dashboard");
    }
  }, [router]);

  const completeOnboarding = () => {
    localStorage.setItem(ONBOARDING_KEY, "true");
    console.log("[OnboardingFeatures] Flag set – navigating to /dashboard via router.push");
    router.push("/dashboard");
  };

  const iconCircleStyle = {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: "var(--toggle-bg)",
    border: "0.5px solid var(--gold-border-hover)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };

  return (
    <OnboardingShell step={5} backHref="/onboarding/connect-google">
      <OnboardingHeading>You&apos;re all set!</OnboardingHeading>
      <OnboardingSubheading>Here&apos;s what AscendAI can do for you</OnboardingSubheading>

      {/* ── STEP 5 — Feature tour list ────────────────────────── */}
      <div>
        {FEATURES.map(({ Icon, title, desc }, idx) => (
          <div
            key={title}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "14px",
              padding: "14px 0",
              borderBottom: idx < FEATURES.length - 1 ? "0.5px solid var(--border)" : "none",
            }}
          >
            <span style={iconCircleStyle}>
              <Icon size={18} color="var(--gold)" aria-hidden />
            </span>
            <div>
              <p style={{ fontFamily: "Inter, sans-serif", fontSize: "14px", fontWeight: 500, color: "var(--text)", margin: 0 }}>
                {title}
              </p>
              <p
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "12px",
                  color: "var(--text-muted)",
                  marginTop: "3px",
                  marginBottom: 0,
                  lineHeight: 1.5,
                }}
              >
                {desc}
              </p>
            </div>
          </div>
        ))}
      </div>

      <ContinueButton onClick={completeOnboarding}>Go to Dashboard →</ContinueButton>
    </OnboardingShell>
  );
}
