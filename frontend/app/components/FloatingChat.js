// ============================================================
// FILE: app/components/FloatingChat.js
// PURPOSE: Global floating chat bubble + panel — Groq-powered
//          assistant on every page; history from Supabase via API.
// ============================================================

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/lib/supabaseClient";

// Backend base URL from env (same pattern as homework page).
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";

// localStorage key — fallback only when GET /chat/history fails.
const STORAGE_KEY = "ascendai-chat-history";

// Map API / localStorage rows into UI message objects (content + optional time).
function toUiMessage(row, index) {
  const created = row.created_at || row.time;
  return {
    id: row.id || `msg-${created || Date.now()}-${index}`,
    role: row.role,
    content: row.content ?? row.text ?? "",
    time: created ? new Date(created) : undefined,
  };
}

// Write the last 20 messages to localStorage (offline backup cache).
function backupToLocalStorage(messages) {
  if (!messages?.length) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-20)));
  } catch {
    // Storage full or unavailable — ignore.
  }
}

// Read fallback history from localStorage when the API is unavailable.
function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m) => !(m.role === "assistant" && m.content === "Not Found"))
      .map((m, i) => toUiMessage(m, i));
  } catch {
    return [];
  }
}

// Welcome text shown the first time the panel opens with no saved history.
const WELCOME_TEXT =
  "Hello! I'm your AscendAI assistant. I can see you're studying Cambridge AS Level. Ask me anything about Economics, Business, English, or ICT — or anything else!";

// Quick suggestion chips — tapping one sends immediately.
const QUICK_CHIPS = [
  "How do I use Past Papers?",
  "Explain price elasticity",
  "What should I study today?",
];

// Panel entrance/exit animation (matches animations.js ease curve).
const panelMotion = {
  initial: { opacity: 0, scale: 0.95, y: 12 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, y: 12 },
  transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
};

export default function FloatingChat() {
  // isOpen — whether the chat panel is visible (bubble toggles this).
  const [isOpen, setIsOpen] = useState(false);

  // messages — array of { id, role: 'user'|'assistant', content }.
  const [messages, setMessages] = useState([]);

  // inputText — current textarea value before send.
  const [inputText, setInputText] = useState("");

  // isLoading — true while waiting for Groq via POST /chat/message.
  const [isLoading, setIsLoading] = useState(false);

  // hasOpened — tracks whether we already injected the welcome message.
  const [hasOpened, setHasOpened] = useState(false);

  // session — Supabase session for user id + bearer token.
  const [session, setSession] = useState(null);

  // isMobile — panel uses full-width layout below 768px.
  const [isMobile, setIsMobile] = useState(false);

  // suggestions — contextual chips shown after each assistant reply.
  const [suggestions, setSuggestions] = useState([
    "How do I use Past Papers?",
    "Explain price elasticity",
    "What should I study today?",
  ]);

  // pathname — current route sent to backend as current_page context.
  const pathname = usePathname();

  // messagesEndRef — anchor at bottom of scroll area for auto-scroll.
  const messagesEndRef = useRef(null);

  // textareaRef — focus target when panel opens.
  const textareaRef = useRef(null);

  // Fetch Supabase session on mount (user id + JWT for API calls).
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s || null);
    });
  }, []);

  // Load chat history: Supabase (GET /chat/history) first, localStorage fallback.
  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;

    let cancelled = false;

    const loadHistory = async () => {
      try {
        const res = await fetch(`${API_URL}/chat/history`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const data = await res.json();
          const rows = data.messages || [];
          if (rows.length > 0 && !cancelled) {
            const uiMessages = rows.map((m, i) => toUiMessage(m, i));
            setMessages(uiMessages);
            setHasOpened(true);
            backupToLocalStorage(uiMessages);
            return;
          }
        }
      } catch {
        // API unreachable — fall through to localStorage below.
      }

      if (cancelled) return;

      const fallback = loadFromLocalStorage();
      if (fallback.length > 0) {
        setMessages(fallback);
        setHasOpened(true);
      }
    };

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [session]);

  // Mobile breakpoint listener for responsive panel dimensions.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Auto-scroll to bottom whenever messages or loading state changes.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // On first panel open with no history, inject the welcome assistant message.
  useEffect(() => {
    if (!isOpen || hasOpened) return;
    if (messages.length > 0) {
      setHasOpened(true);
      return;
    }
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        content: WELCOME_TEXT,
      },
    ]);
    setHasOpened(true);
  }, [isOpen, hasOpened, messages.length]);

  // Focus textarea when panel opens.
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => textareaRef.current?.focus(), 200);
    }
  }, [isOpen]);

  // sendMessage — POST /chat/message with history + page context.
  const sendMessage = useCallback(
    async (textOverride) => {
      const trimmed = (textOverride ?? inputText).trim();
      if (!trimmed || isLoading) return;

      if (!session?.user?.id || !session?.access_token) {
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: "assistant",
            content: "Please sign in to chat with AscendAI.",
          },
        ]);
        return;
      }

      // Step 1: append user message immediately (optimistic UI).
      const userMsg = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
      };
      setMessages((prev) => [...prev, userMsg]);

      // Step 2: clear input.
      setInputText("");

      // Step 3: show typing indicator.
      setIsLoading(true);

      // Step 4: build conversation_history — last 10 turns for Groq context.
      const historyForApi = [...messages, userMsg]
        .slice(-10)
        .map((m) => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
        }));

      try {
        // Step 5: call backend POST /chat/message.
        const res = await fetch(`${API_URL}/chat/message`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            message: trimmed,
            user_id: session.user.id,
            current_page: pathname,
            conversation_history: historyForApi,
          }),
        });

        if (!res.ok) {
          const errorBody = await res.json().catch(() => ({}));
          const detail = errorBody?.detail;
          let message =
            detail && typeof detail === "object" && detail.error
              ? detail.error
              : typeof detail === "string"
                ? detail
                : `Something went wrong (${res.status}).`;
          // FastAPI 404 — backend running but /chat/message not registered (stale server).
          if (res.status === 404) {
            message =
              "Chat API not available. Restart the backend (uvicorn on port 8001) and try again.";
          }
          throw new Error(message);
        }

        // Step 6: append AI response and backend follow-up chips.
        const data = await res.json();
        const replyText =
          data.reply || "I could not generate a reply. Please try again.";
        const newSuggestions = data.suggestions || [];
        setSuggestions(newSuggestions);
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: replyText,
          },
        ]);
      } catch (err) {
        const errorAssistantText =
          err instanceof Error
            ? err.message
            : "Could not reach AscendAI. Is the backend running?";
        setMessages((prev) => {
          const updatedMessages = [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              content: errorAssistantText,
            },
          ];
          // POST failed — persist locally so the thread is not lost offline.
          backupToLocalStorage(updatedMessages);
          return updatedMessages;
        });
      } finally {
        // Step 7: hide typing indicator.
        setIsLoading(false);
      }
    },
    [inputText, isLoading, session, messages, pathname]
  );

  // Whether any user message exists (controls quick chips visibility).
  const showChips = !messages.some((m) => m.role === "user");

  // Send button disabled when empty input or loading.
  const sendDisabled = !inputText.trim() || isLoading;

  return (
    <>
      {/* Chat panel — fixed above the bubble */}
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            key="chat-panel"
            {...panelMotion}
            className="floating-chat-panel"
            style={{
              position: "fixed",
              bottom: isMobile ? 80 : 88,
              right: isMobile ? 16 : 24,
              width: isMobile ? "calc(100vw - 32px)" : 360,
              height: isMobile ? "70vh" : 520,
              background: "var(--card)",
              border: "0.5px solid var(--chat-panel-border)",
              borderRadius: 16,
              boxShadow: "0 8px 48px var(--chat-panel-shadow)",
              display: "flex",
              flexDirection: "column",
              zIndex: 999,
              overflow: "hidden",
            }}
          >
            {/* Panel header */}
            <motion.div
              style={{
                padding: "16px 18px",
                borderBottom: "0.5px solid var(--border-light)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span
                  aria-hidden
                  style={{ fontSize: 16, color: "var(--gold)", lineHeight: 1, marginTop: 2 }}
                >
                  ✦
                </span>
                <motion.div>
                  <p
                    style={{
                      fontFamily: "var(--font-playfair), 'Playfair Display', serif",
                      fontSize: 15,
                      color: "var(--gold)",
                      fontWeight: 700,
                      margin: 0,
                      lineHeight: 1.2,
                    }}
                  >
                    AscendAI
                  </p>
                  <p
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontSize: 11,
                      color: "var(--text-muted)",
                      margin: "2px 0 0",
                    }}
                  >
                    Ask me anything
                  </p>
                </motion.div>
              </div>
              <motion.button
                type="button"
                aria-label="Close chat"
                className="floating-chat-close-btn"
                onClick={() => setIsOpen(false)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: "var(--card-hover)",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </motion.button>
            </motion.div>

            {/* Messages scroll area */}
            <motion.div
              className="floating-chat-messages"
              style={{
                flex: 1,
                padding: 14,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  style={
                    msg.role === "user"
                      ? {
                          alignSelf: "flex-end",
                          maxWidth: "85%",
                          background: "var(--gold)",
                          borderRadius: 12,
                          borderTopRightRadius: 4,
                          padding: "10px 14px",
                          fontFamily: "Inter, sans-serif",
                          fontSize: 13,
                          lineHeight: 1.6,
                        }
                      : {
                          alignSelf: "flex-start",
                          maxWidth: "85%",
                          background: "var(--chat-bubble-bg)",
                          border: "0.5px solid var(--chat-bubble-border)",
                          borderRadius: 12,
                          borderTopLeftRadius: 4,
                          padding: "10px 14px",
                          fontFamily: "Inter, sans-serif",
                          fontSize: 13,
                          color: "var(--text)",
                          lineHeight: 1.6,
                        }
                  }
                  className={msg.role === "user" ? "floating-chat-user-msg" : undefined}
                >
                  {msg.content}
                </motion.div>
              ))}

              {/* Quick suggestion chips — only before first user message */}
              {showChips ? (
                <motion.div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginTop: 4,
                  }}
                >
                  {QUICK_CHIPS.map((chip) => (
                    <motion.button
                      key={chip}
                      type="button"
                      className="floating-chat-chip"
                      onClick={() => sendMessage(chip)}
                      disabled={isLoading}
                      style={{
                        background: "var(--card-hover)",
                        border: "0.5px solid var(--chat-input-border)",
                        borderRadius: 20,
                        padding: "6px 14px",
                        fontFamily: "Inter, sans-serif",
                        fontSize: 12,
                        color: "var(--text-dim)",
                        cursor: "pointer",
                      }}
                    >
                      {chip}
                    </motion.button>
                  ))}
                </motion.div>
              ) : null}

              {/* Contextual chips — after first user message, below last assistant reply */}
              {messages.length > 0 &&
                messages[messages.length - 1].role === "assistant" &&
                !showChips && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "6px",
                      padding: "4px 0 8px",
                    }}
                  >
                    {suggestions.map((chip, i) => (
                      <button
                        key={i}
                        type="button"
                        className="floating-chat-context-chip"
                        disabled={isLoading}
                        onClick={() => {
                          setInputText(chip);
                          setTimeout(() => sendMessage(chip), 100);
                        }}
                        style={{
                          background: "var(--chat-bubble-bg)",
                          border: "0.5px solid var(--chat-bubble-border)",
                          borderRadius: "20px",
                          padding: "5px 12px",
                          fontFamily: "Inter, sans-serif",
                          fontSize: "11px",
                          color: "var(--text-dim)",
                          cursor: "pointer",
                          transition: "border-color 150ms",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                )}

              {/* Typing indicator while Groq responds */}
              {isLoading ? (
                <motion.div
                  style={{
                    alignSelf: "flex-start",
                    background: "var(--chat-bubble-bg)",
                    border: "0.5px solid var(--chat-bubble-border)",
                    borderRadius: 12,
                    borderTopLeftRadius: 4,
                    padding: "12px 16px",
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  <span className="floating-chat-dot" style={{ animationDelay: "0s" }} />
                  <span className="floating-chat-dot" style={{ animationDelay: "0.2s" }} />
                  <span className="floating-chat-dot" style={{ animationDelay: "0.4s" }} />
                </motion.div>
              ) : null}

              {/* Auto-scroll anchor */}
              <motion.div ref={messagesEndRef} />
            </motion.div>

            {/* Input area */}
            <motion.div
              style={{
                padding: "12px 14px",
                borderTop: "0.5px solid var(--border-light)",
                display: "flex",
                gap: 8,
                alignItems: "flex-end",
                flexShrink: 0,
              }}
            >
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Ask anything..."
                rows={1}
                className="floating-chat-textarea"
                style={{
                  flex: 1,
                  background: "var(--card-hover)",
                  border: "0.5px solid var(--chat-input-border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  fontFamily: "Inter, sans-serif",
                  fontSize: 13,
                  color: "var(--text)",
                  resize: "none",
                  minHeight: 40,
                  maxHeight: 120,
                  lineHeight: 1.5,
                }}
              />
              <motion.button
                type="button"
                aria-label="Send message"
                onClick={() => sendMessage()}
                disabled={sendDisabled}
                className="floating-chat-send-btn"
                style={{
                  width: 36,
                  height: 36,
                  background: "var(--gold)",
                  borderRadius: 8,
                  border: "none",
                  cursor: sendDisabled ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: sendDisabled ? 0.4 : 1,
                  transition: "opacity 200ms",
                  flexShrink: 0,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="floating-chat-send-icon">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </motion.button>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Floating bubble — toggles panel */}
      <motion.button
        type="button"
        id="tour-chat"
        aria-label={isOpen ? "Close chat" : "Open chat"}
        className="floating-chat-bubble"
        onClick={() => setIsOpen((prev) => !prev)}
        whileHover={{ scale: 1.08 }}
        transition={{ duration: 0.2 }}
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          zIndex: 1000,
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "linear-gradient(135deg, var(--toggle-color) 0%, var(--gold-hover) 100%)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          boxShadow: "0 4px 20px var(--gold-dim), 0 0 0 1px var(--gold-border-hover)",
        }}
      >
        <motion.span
          aria-hidden
          animate={{ rotate: isOpen ? 45 : 0 }}
          transition={{ duration: 0.2 }}
          style={{
            fontSize: 20,
            color: "var(--bg)",
            lineHeight: 1,
            fontWeight: 600,
          }}
        >
          {isOpen ? "×" : "✦"}
        </motion.span>
      </motion.button>

      <style>{`
        .floating-chat-bubble:hover {
          box-shadow: 0 6px 28px var(--gold-dim), 0 0 0 1px var(--gold-border-active);
        }
        .floating-chat-close-btn:hover {
          background: var(--nav-icon-hover-bg) !important;
        }
        .floating-chat-messages {
          scrollbar-width: thin;
          scrollbar-color: var(--gold-border-hover) transparent;
        }
        .floating-chat-textarea::placeholder {
          color: var(--text-muted);
        }
        .floating-chat-textarea:focus {
          border-color: var(--gold);
          outline: none;
        }
        .floating-chat-chip:hover {
          border-color: var(--gold) !important;
          color: var(--text) !important;
        }
        .floating-chat-context-chip:hover:not(:disabled) {
          border-color: var(--gold) !important;
        }
        .floating-chat-user-msg {
          color: var(--bg);
        }
        html.light .floating-chat-user-msg {
          color: var(--text-emphasis);
        }
        .floating-chat-send-icon {
          color: var(--bg);
        }
        html.light .floating-chat-send-icon {
          color: var(--text-emphasis);
        }
        .floating-chat-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--gold);
          animation: floating-chat-bounce 1.2s ease-in-out infinite;
        }
        @keyframes floating-chat-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
          30% { transform: translateY(-6px); opacity: 1; }
        }
      `}</style>
    </>
  );
}
