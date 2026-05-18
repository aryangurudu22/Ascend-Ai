// ============================================================
// FILE: app/layout.js
// PURPOSE: Root layout — fonts, theme, grain, global navbar.
// ============================================================

import { Playfair_Display, Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "./context/ThemeContext";
import GrainOverlay from "./components/GrainOverlay";
import ConditionalNavbar from "./components/ConditionalNavbar";
import FloatingChat from "./components/FloatingChat";
import PWARegister from "./components/PWARegister";
import PWAInstallBanner from "./components/PWAInstallBanner";

// Playfair Display — headings (Cambridge prestige feel)
const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["700"],
  variable: "--font-playfair",
  display: "swap",
});

// Inter — body copy and UI labels
const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

// PWA + SEO metadata — manifest and Apple web app tags for installability
export const metadata = {
  title: "AscendAI",
  description: "Cambridge AS Level AI Study Assistant",
  manifest: "/manifest.json",
  applicationName: "AscendAI",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AscendAI",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

// Viewport + theme colour for browser chrome (Next.js App Router)
export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#D4AF37",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${playfair.variable} ${inter.variable}`}
    >
      <body className={`${inter.className} antialiased`}>
        <ThemeProvider>
          {/* Service worker — offline app-shell caching */}
          <PWARegister />
          {/* Film grain — sits above page content, non-interactive */}
          <GrainOverlay />
          {/* Global nav — hidden on /login and /onboarding/* */}
          <ConditionalNavbar />
          <FloatingChat />
          {/* Install prompt when browser supports Add to Home Screen */}
          <PWAInstallBanner />
          <main>{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}
