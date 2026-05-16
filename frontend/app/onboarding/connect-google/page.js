// ============================================================
// FILE: app/onboarding/connect-google/page.js
// PURPOSE: Onboarding Step 4 — Upload Cambridge syllabus PDFs
//          per subject for personalised coverage tracking.
// URL: /onboarding/connect-google
// ============================================================

"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { SUBJECTS } from "../../../lib/subjects";
import { supabase } from "../../../lib/supabaseClient";
import SubjectBadge from "../../components/SubjectBadge";
import {
  OnboardingShell,
  OnboardingHeading,
  OnboardingSubheading,
  ContinueButton,
} from "../onboarding-ui";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

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

export default function OnboardingSyllabusUpload() {
  const router = useRouter();
  const [uploadStatus, setUploadStatus] = useState(INITIAL_UPLOAD_STATUS);
  const [topicCounts, setTopicCounts] = useState(INITIAL_TOPIC_COUNTS);
  const fileRefs = {
    economics: useRef(null),
    business: useRef(null),
    english: useRef(null),
    ict: useRef(null),
  };

  useEffect(() => {
    const completed = localStorage.getItem("ascendai_onboarding_completed");
    if (completed === "true") {
      router.push("/dashboard");
    }
  }, [router]);

  const handleNext = () => {
    router.push("/onboarding/features");
  };

  const handleSkip = () => {
    router.push("/onboarding/features");
  };

  const handleFileChange = async (subjectKey, file) => {
    if (!file) return;

    setUploadStatus((prev) => ({ ...prev, [subjectKey]: "uploading" }));

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData?.session;
      const token = session?.access_token;
      const uid = session?.user?.id;

      if (!token || !uid) {
        throw new Error("Please sign in to upload a syllabus.");
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("subject", subjectKey);
      formData.append("user_id", uid);

      const extractRes = await fetch(`${API_URL}/syllabus/extract`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
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

      const topics = extractData.topics || [];
      if (!topics.length) {
        throw new Error("No topics found in this PDF.");
      }

      const saveRes = await fetch(`${API_URL}/syllabus/save-topics`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          subject: subjectKey,
          topics,
          user_id: uid,
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

      const count = saveData.saved ?? topics.length;
      setTopicCounts((prev) => ({ ...prev, [subjectKey]: count }));
      setUploadStatus((prev) => ({ ...prev, [subjectKey]: "done" }));

      const stored = localStorage.getItem("ascendai_onboarding_data");
      const onboardingData = stored ? JSON.parse(stored) : {};
      onboardingData.syllabusUploaded = onboardingData.syllabusUploaded || {};
      onboardingData.syllabusUploaded[subjectKey] = true;
      localStorage.setItem(
        "ascendai_onboarding_data",
        JSON.stringify(onboardingData)
      );
    } catch (err) {
      console.error("[SyllabusUpload]", subjectKey, err);
      setUploadStatus((prev) => ({ ...prev, [subjectKey]: "error" }));
    }
  };

  const slotStyle = {
    background: "var(--card)",
    border: "0.5px solid var(--gold-border-hover)",
    borderRadius: "10px",
    padding: "16px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    transition: "border-color 200ms, background 200ms",
  };

  return (
    <OnboardingShell step={4} backHref="/onboarding/study-hours">
      <OnboardingHeading>Upload Your Syllabus</OnboardingHeading>
      <OnboardingSubheading>
        We&apos;ll extract your exact Cambridge topics for personalised tracking
      </OnboardingSubheading>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "12px",
          marginBottom: "24px",
        }}
      >
        {SUBJECTS.map((sub) => {
          const status = uploadStatus[sub.key];
          const count = topicCounts[sub.key];

          let statusText = "Upload PDF";
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
            <div key={sub.key} style={slotStyle}>
              <SubjectBadge subject={sub.key} showCode />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    fontFamily: "Inter, sans-serif",
                    fontSize: "13px",
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
                    fontSize: "11px",
                    color: statusColor,
                    marginTop: "2px",
                    marginBottom: 0,
                  }}
                >
                  {statusText}
                </p>
              </div>

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
          );
        })}
      </div>

      <div
        style={{
          background: "var(--accordion-gap-bg)",
          border: "0.5px solid var(--gold-border-hover)",
          borderLeft: "2px solid var(--gold)",
          borderRadius: "6px",
          padding: "14px 16px",
          marginBottom: "20px",
        }}
      >
        <p
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: "12px",
            color: "var(--text-dim)",
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          Upload the official Cambridge AS Level syllabus PDF for each subject.
          Download them free from cambridgeinternational.org
        </p>
      </div>

      <ContinueButton onClick={handleNext}>Continue →</ContinueButton>

      <button
        type="button"
        onClick={handleSkip}
        style={{
          display: "block",
          width: "100%",
          marginTop: "8px",
          background: "none",
          border: "none",
          fontFamily: "Inter, sans-serif",
          fontSize: "12px",
          color: "var(--text-muted)",
          cursor: "pointer",
          textAlign: "center",
        }}
      >
        Skip — use default topics
      </button>
    </OnboardingShell>
  );
}
