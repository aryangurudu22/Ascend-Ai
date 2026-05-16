// ============================================================
// FILE: app/context/ThemeContext.js
// PURPOSE: Global dark/light theme for AscendAI.
// Persists preference in localStorage and toggles the `light`
// class on <html> so CSS variables in globals.css switch.
// ============================================================

"use client";

import { createContext, useContext, useEffect, useState } from "react";

/*
  ThemeContext — manages dark/light mode globally
  Persists user preference in localStorage
  Applies 'light' class to html element for CSS variable switching
*/
const ThemeContext = createContext({
  theme: "dark",
  toggleTheme: () => {},
});

function readStoredTheme() {
  if (typeof window === "undefined") return "dark";
  return localStorage.getItem("ascendai-theme") === "light" ? "light" : "dark";
}

export function ThemeProvider({ children }) {
  // Always start as dark on server + first client paint so hydration matches.
  // localStorage is read only after mount (avoids SSR/client text mismatch).
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  // Keep <html> class in sync with theme (drives CSS variables)
  useEffect(() => {
    if (theme === "light") {
      document.documentElement.classList.add("light");
    } else {
      document.documentElement.classList.remove("light");
    }
  }, [theme]);

  // Toggle between dark and light
  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);

    // Apply or remove 'light' class on html element
    // CSS variables switch automatically via html.light selector
    if (newTheme === "light") {
      document.documentElement.classList.add("light");
    } else {
      document.documentElement.classList.remove("light");
    }

    // Save preference so it persists across sessions
    localStorage.setItem("ascendai-theme", newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// Custom hook — use this in any component to access theme
export const useTheme = () => useContext(ThemeContext);
