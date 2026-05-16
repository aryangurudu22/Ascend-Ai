// ============================================================
// FILE: app/lib/animations.js
// PURPOSE: Shared Framer Motion variants for every page.
// Import from here instead of defining animations inline.
// Use with: import { motion } from 'framer-motion'
// ============================================================

/*
  Animation variants for Framer Motion
  Used consistently across all pages
  Import these instead of defining animations inline
*/

// Word pull-up — used for page headings
// Each word slides up from below on load
export const wordPullUp = {
  hidden: {
    y: 24,
    opacity: 0,
  },
  visible: (i) => ({
    y: 0,
    opacity: 1,
    transition: {
      delay: i * 0.1, // stagger per word
      duration: 0.7,
      ease: [0.16, 1, 0.3, 1], // custom spring ease
    },
  }),
};

// Fade up — used for subtitles and supporting text
export const fadeUp = {
  hidden: { y: 16, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1],
    },
  },
};

// Fade in — used for content that appears without movement
export const fadeIn = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.5, ease: "easeOut" },
  },
};

// Stagger container — parent that staggers children
export const staggerContainer = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2,
    },
  },
};

// Stagger item — child of staggerContainer
// Used for card grids — note cards, subject cards etc
export const staggerItem = {
  hidden: {
    scale: 0.97,
    y: 10,
    opacity: 0,
  },
  visible: {
    scale: 1,
    y: 0,
    opacity: 1,
    transition: {
      duration: 0.6,
      ease: [0.22, 1, 0.36, 1],
    },
  },
};

// Card hover — subtle lift on hover
// Use as whileHover prop on motion.div
export const cardHover = {
  scale: 1.01,
  transition: { duration: 0.2, ease: "easeOut" },
};

// Button press — subtle press feedback
export const buttonPress = {
  scale: 0.97,
  transition: { duration: 0.1 },
};
