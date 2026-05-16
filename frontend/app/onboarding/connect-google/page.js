// ============================================================
// FILE: app/onboarding/connect-google/page.js
// PURPOSE: Onboarding Step 4 – Connect Google Classroom account
// URL: /onboarding/connect-google
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function OnboardingConnectGoogle() {
  const router = useRouter();
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Load existing connection status from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("ascendai_onboarding_data");
    if (stored) {
      try {
        const data = JSON.parse(stored);
        if (data.googleConnected) {
          setIsConnected(true);
        }
      } catch (e) {}
    }
  }, []);

  // Redirect if onboarding already completed
  useEffect(() => {
    const completed = localStorage.getItem("ascendai_onboarding_completed");
    if (completed === "true") {
      router.push("/dashboard");
    }
  }, [router]);

  // Simulate Google OAuth connection (will be replaced with real Supabase OAuth later)
  const handleConnectGoogle = () => {
    setIsLoading(true);
    // Simulate an async OAuth flow
    setTimeout(() => {
      setIsConnected(true);
      setIsLoading(false);
      
      // Save connection status to localStorage
      const stored = localStorage.getItem("ascendai_onboarding_data");
      let onboardingData = stored ? JSON.parse(stored) : {};
      onboardingData.googleConnected = true;
      localStorage.setItem("ascendai_onboarding_data", JSON.stringify(onboardingData));
    }, 1000);
  };

  // Proceed to next step (features walkthrough)
  const handleNext = () => {
    router.push("/onboarding/features");
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-2xl w-full bg-white rounded-4px shadow-lg border border-hover overflow-hidden">
        {/* Progress bar – 80% (step 4 of 5) */}
        <div className="h-1 bg-hover">
          <div className="h-full w-4/5 bg-gold"></div>
        </div>

        <div className="p-8 md:p-10">
          <div className="text-gold text-xs font-semibold uppercase tracking-wider mb-2">
            Step 4 of 5
          </div>
          <h1 className="font-heading text-3xl md:text-4xl font-bold text-text-primary mb-3">
            Connect Google Classroom
          </h1>
          <p className="text-text-muted text-base mb-6 border-l-3 border-gold pl-3">
            We'll automatically summarise teacher posts and attachments
          </p>

          <div className="mt-6">
            {!isConnected ? (
              <button
                onClick={handleConnectGoogle}
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-3 bg-white border border-hover rounded-4px py-3 px-4 font-medium text-text-primary hover:bg-background transition disabled:opacity-50"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                {isLoading ? "Connecting..." : "Connect with Google"}
              </button>
            ) : (
              <div className="text-center p-4 bg-green-50 border border-green-200 rounded-4px text-green-700">
                ✓ Google Classroom connected successfully
              </div>
            )}
            <p className="text-text-hint text-xs text-center mt-3">
              You can disconnect anytime in settings
            </p>
          </div>

          <div className="mt-8 flex justify-between">
            <Link
              href="/onboarding/study-hours"
              className="border border-gold text-gold px-6 py-2 rounded-4px font-semibold hover:bg-gold/10 transition"
            >
              ← Back
            </Link>
            <button
              onClick={handleNext}
              disabled={!isConnected}
              className={`px-6 py-2 rounded-4px font-semibold transition ${
                isConnected
                  ? "bg-gold text-white hover:bg-gold/90"
                  : "bg-gray-300 text-gray-500 cursor-not-allowed"
              }`}
            >
              Next →
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}