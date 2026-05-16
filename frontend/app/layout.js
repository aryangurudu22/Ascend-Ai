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

export const metadata = {
  title: "AscendAI",
  description: "Cambridge AS Level AI Study Assistant by Shivora",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${playfair.variable} ${inter.variable}`}
    >
      <body className={`${inter.className} antialiased`}>
        <ThemeProvider>
          {/* Film grain — sits above page content, non-interactive */}
          <GrainOverlay />
          {/* Global nav — hidden on /login and /onboarding/* */}
          <ConditionalNavbar />
          <FloatingChat />
          <main>{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}
