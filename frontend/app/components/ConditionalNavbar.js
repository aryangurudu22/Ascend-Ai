// ============================================================
// FILE: app/components/ConditionalNavbar.js
// PURPOSE: Renders the global Navbar except on login/onboarding.
// ============================================================

"use client";

import { usePathname } from "next/navigation";
import Navbar from "./Navbar";

/*
  ConditionalNavbar — shows navbar on all pages except
  login and onboarding flows where it would be distracting
*/
const HIDDEN_PATHS = ["/login", "/onboarding"];

export default function ConditionalNavbar() {
  const pathname = usePathname();

  // Hide navbar on login and all onboarding pages
  const shouldHide = HIDDEN_PATHS.some((path) => pathname?.startsWith(path));

  if (shouldHide) return null;

  return <Navbar />;
}
