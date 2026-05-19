// ============================================================
// FILE: app/components/PageWrapper.js
// PURPOSE: Client-only route segment wrapper — fades page body
//          in/out on pathname change (App Router layout stays mounted).
// ============================================================

"use client";

import { motion, AnimatePresence } from "framer-motion";
import { usePathname } from "next/navigation";

export default function PageWrapper({ children }) {
  // Key drives exit/enter when Next swaps the active page segment.
  const pathname = usePathname();

  // Wait for outgoing page to finish exit before entering the next.
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={pathname} // New key on each route → replay enter/exit
        initial={{ opacity: 0, y: 6 }} // Slight rise-in from below
        animate={{ opacity: 1, y: 0 }} // Rest at natural position
        exit={{ opacity: 0, y: -6 }} // Subtle lift-out on leave
        transition={{ duration: 0.2, ease: "easeOut" }} // Short, calm easing
        style={{ minHeight: "100vh" }} // Prevent layout jump on short pages
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
