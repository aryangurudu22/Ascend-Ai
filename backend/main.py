# ============================================================
# ASCENDAI BACKEND — main.py
# This is the brain of the app. Every request from the 
# frontend comes here first.
# ============================================================

# FastAPI is the framework that runs our backend server.
# HTTPException lets us return a clean error response with a status code
# when something goes wrong (e.g. invalid subject, AI provider down).
from fastapi import FastAPI, HTTPException

# CORSMiddleware allows our frontend (localhost:3001) to talk
# to our backend (localhost:8001) without being blocked
from fastapi.middleware.cors import CORSMiddleware

# Pydantic gives us BaseModel — a Python class that auto-validates
# the JSON body of an incoming request. If a required field is missing
# FastAPI returns a clear 422 error without us writing any if-checks.
from pydantic import BaseModel, Field

# Optional is used to mark fields that may be absent on the request.
from typing import Optional

# This reads our secret keys from the .env file
from dotenv import load_dotenv

# This lets us access those secret keys inside the code
import os

# This connects us to the Groq AI brain
from groq import Groq

# This imports our Supabase database client from database.py
# We created it in a separate file so every feature can import it cleanly
from database import supabase

# asynccontextmanager lets us run code on startup and shutdown
from contextlib import asynccontextmanager

# Each feature lives in its own router file under routers/.
# Importing the module here gives us `homework.router`, which we
# then bolt onto the FastAPI app below via include_router(...).
from routers import homework, flashcards, quiz, timetable, onboarding, past_papers  # noqa: F401 — registered below

# ============================================================
# LOAD SECRET KEYS
# This must happen before anything else — like unlocking 
# the door before you can enter the building
# ============================================================

# Go and read the .env file right now
load_dotenv()

# Pick up each secret key and store it in a variable
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")

# ============================================================
# CONNECT TO GROQ AI
# We create one connection when the app starts and reuse 
# it for every AI request — like keeping a phone line open
# instead of calling and hanging up every time
# ============================================================

# Create the Groq client using our API key from the .env file
# This is the object we use every time we want to ask the AI something
groq_client = Groq(
    api_key=GROQ_API_KEY  # The secret key that proves we are allowed to use Groq
)

# ============================================================
# STARTUP AND SHUTDOWN EVENTS
# Everything before "yield" runs when the app starts
# Everything after "yield" runs when the app shuts down
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):

    # --- STARTUP --- runs once when the server starts.
    # ASCII tags ([OK] / [ERR] / [START]) are used instead of emojis
    # because the Windows default console codec (cp1252) cannot encode
    # most Unicode glyphs and would crash uvicorn on startup.
    if GROQ_API_KEY:
        print("[OK] Groq AI connected successfully")
    else:
        print("[ERR] Groq API key missing — check your .env file")

    # Print a clear confirmation that the server is running
    print("[START] AscendAI backend is starting up...")
    print("        Health check at: http://localhost:8001/")
    print("        API docs at:     http://localhost:8001/docs")

    yield  # The app runs here — everything above is startup, below is shutdown

    # --- SHUTDOWN --- runs once when the server stops
    print("[STOP] AscendAI backend is shutting down...")

# ============================================================
# CREATE THE FASTAPI APP
# This is like opening the hotel for business — 
# everything runs through this one object
# We attach the lifespan so startup/shutdown events work
# ============================================================

app = FastAPI(
    title="AscendAI API",
    description="Cambridge AS Level AI Study Assistant Backend",
    version="1.0.0",
    lifespan=lifespan   # Attach startup and shutdown events
)

# ============================================================
# CORS SETTINGS
# This tells the browser: "it's okay for the frontend 
# and backend to talk to each other even though they 
# run on different port numbers"
# ============================================================

app.add_middleware(
    CORSMiddleware,

    # Which addresses are allowed to talk to our backend.
    # During development we allow localhost:3001 (our Next.js frontend).
    allow_origins=["http://localhost:3001"],

    # Allow the browser to send login credentials (cookies, auth headers)
    allow_credentials=True,

    # Allow all types of requests (GET, POST, PUT, DELETE etc.)
    allow_methods=["*"],

    # Allow all headers to be sent with requests
    allow_headers=["*"],
)

# ============================================================
# FEATURE ROUTERS
# ----------------------------------------------------------------
# Each feature owns a router file under backend/routers/. We
# attach them to the app here so every route in those files
# becomes reachable at runtime. The `prefix` is prepended to
# every path the router declares — e.g. the router below
# declares "/ask" and "/history", which become "/homework/ask"
# and "/homework/history" once attached. The `tags` list groups
# the routes together in the OpenAPI docs at /docs.
# ============================================================

# Homework Assistant — Cambridge AS Level Q&A endpoint suite.
# All authentication, Groq calls and Supabase writes happen
# inside this router. main.py just mounts it.
app.include_router(homework.router, prefix="/homework", tags=["Homework"])

# Flashcards — generates Cambridge-style revision cards from a
# note via Groq, plus two read endpoints for the study UI to
# fetch saved cards by subject or by source note.
app.include_router(flashcards.router, prefix="/flashcards", tags=["Flashcards"])

# Quiz — records each quiz attempt + every per-card answer,
# applies the +1/-1 mastery clamp, and returns history.
app.include_router(quiz.router, prefix="/quiz", tags=["Quiz"])

# Timetable — generates a 2-week Cambridge revision schedule
# via Groq, plus list + toggle-complete endpoints for the
# weekly grid + daily detail views. Three endpoints:
# POST /timetable/generate, GET /timetable/entries,
# PATCH /timetable/entry/{entry_id}/complete.
app.include_router(timetable.router, prefix="/timetable", tags=["Timetable"])

# Onboarding — writes the five-step wizard's data through to
# Supabase so the Timetable feature (and any future feature
# that needs profile.study_*_time or subjects.exam_date) can
# find it. Three endpoints:
# POST /onboarding/profile         (called from Step 3),
# POST /onboarding/exam-dates      (called from Step 2),
# GET  /onboarding/profile/check   (called from the dashboard
#                                   as a safety net to repair
#                                   a missing profile row).
app.include_router(onboarding.router, prefix="/onboarding", tags=["Onboarding"])

# Past Papers — downloads an uploaded Cambridge AS Level past
# paper PDF from Supabase Storage, extracts text with PyMuPDF,
# asks Groq for a structured Cambridge solution, saves the
# solution onto the past_papers row, and (in the background)
# generates per-topic study notes the student doesn't already
# have. Three endpoints:
# POST /past-papers/solve              (called by the UPLOAD
#                                       handler in the frontend
#                                       once the PDF is in
#                                       Supabase Storage),
# GET  /past-papers/list               (drives VIEW 1's library
#                                       grid),
# GET  /past-papers/{paper_id}/solution(drives VIEW 4 when the
#                                       user re-opens a paper).
app.include_router(past_papers.router, prefix="/past-papers", tags=["Past Papers"])

# ============================================================
# HOMEWORK ASSISTANT — configuration
# ----------------------------------------------------------------
# Everything in this block is configuration data for the homework
# endpoint. Keeping it at the module level (above the route) means
# the values are loaded ONCE when uvicorn starts, not on every request.
# ============================================================

# Which Groq model to use. We read it from the .env so we can switch
# models (e.g. llama-3.1-8b-instant for cheaper testing) without
# touching the code. Defaults to LLaMA 3.3 70B (the PRD's "LLaMA 3 70B").
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

# ──────────────────────────────────────────────────────────────────────
# SUBJECT CONTEXT LOOKUP
# ──────────────────────────────────────────────────────────────────────
# Maps the lowercase subject key (from the frontend, see lib/subjects.js)
# to the full Cambridge syllabus title. The title is injected into the
# user prompt so the model knows which syllabus's mark scheme to use.
# This dict is ALSO the source of truth for which subjects are valid –
# the endpoint rejects anything not in this dict with a 400.
# ──────────────────────────────────────────────────────────────────────
SUBJECT_CONTEXTS = {
    "economics": "Cambridge AS Level Economics (9708)",
    "business":  "Cambridge AS Level Business Studies (9609)",
    "english":   "Cambridge AS Level English Language (9093)",
    "ict":       "Cambridge AS Level Information Technology (9626)",
}

# ──────────────────────────────────────────────────────────────────────
# SYSTEM PROMPT — shared across all four subjects.
# ──────────────────────────────────────────────────────────────────────
# Previous versions of this prompt asked the model to produce Markdown
# (## headings, **bold**, hyphen bullets). The frontend has no Markdown
# renderer yet, so those symbols showed up as literal text in the UI.
#
# The new prompt asks for PLAIN TEXT with four named sections, separated
# by blank lines. The frontend then detects the section names and the
# inline "Mistake:" / "Examiner Tip:" / "Definition:" / "Application:" /
# "Analysis:" prefixes and styles them with Tailwind tokens.
#
# This is the single source of truth for AscendAI's exam-answer style.
# Any tweak to tone, structure or formatting goes HERE.
# ──────────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = (
    "You are an expert Cambridge AS Level examiner and tutor with deep "
    "knowledge of all Cambridge International AS Level syllabuses including:\n"
    "- Business Studies (9609)\n"
    "- Economics (9708)\n"
    "- English Language (9093)\n"
    "- Information Technology (9626)\n"
    "\n"
    "You are helping a Cambridge AS Level student in Zambia, Southern Africa.\n"
    "\n"
    "ANSWER FORMAT — follow this exact structure for every answer:\n"
    "\n"
    "1. DEFINITION\n"
    "Write a precise Cambridge-standard definition of the key concept(s) in "
    "the question. Reference the specific Cambridge AS Level syllabus where "
    "relevant (e.g. Cambridge AS Level Business Studies 9609, Cambridge AS "
    "Level Economics 9708). Use clear, formal academic language. No bullet "
    "points here — write in complete sentences.\n"
    "\n"
    "2. CAMBRIDGE ANSWER\n"
    "Write the full exam-ready answer using Cambridge mark scheme format:\n"
    "- Definition: Define the concept precisely as Cambridge examiners "
    "expect\n"
    "- Application: Apply the concept to a real business context\n"
    "- Analysis: Analyse the impact, cause, or effect with clear logical "
    "reasoning\n"
    "\n"
    "For every answer use a mix of well-known global companies (Apple, "
    "Tesla, Amazon, Unilever, Toyota, Coca-Cola) AND where relevant include "
    "African or Zambian business context (Zambia National Commercial Bank, "
    "Shoprite Zambia, MTN Zambia, Airtel Africa, Dangote Group, Safaricom).\n"
    "\n"
    "Write in clean, flowing paragraphs. No markdown symbols. No hashtags. "
    "No asterisks. Use proper sentence structure throughout.\n"
    "\n"
    "3. EXAMINER TIP\n"
    "Write one short paragraph starting with \"Examiner Tip:\" that tells "
    "the student exactly what Cambridge examiners are looking for in this "
    "type of question and how to maximise marks. Be specific — mention "
    "mark allocations where relevant (e.g. for a 4-mark question, expect "
    "two developed points).\n"
    "\n"
    "4. COMMON MISTAKES\n"
    "Write two to three specific mistakes students commonly make on this "
    "exact type of question. Start each with \"Mistake:\" and explain "
    "clearly why it loses marks and what to write instead.\n"
    "\n"
    "FORMATTING RULES — strictly follow these:\n"
    "- Never use markdown symbols: no ##, no **, no __, no --, no ```\n"
    "- Section headings are plain text followed by a line break — nothing "
    "else\n"
    "- Bold words are rendered by the frontend — do not use asterisks\n"
    "- Write in formal academic English throughout\n"
    "- Paragraphs are separated by a single blank line\n"
    "- Never use bullet points in the Cambridge Answer section\n"
    "- Keep the total response focused and exam-relevant — no waffle\n"
    "- Never mention that you are an AI\n"
)

# ──────────────────────────────────────────────────────────────────────
# ADJUSTMENT INSTRUCTIONS
# ──────────────────────────────────────────────────────────────────────
# Map the optional `adjustment` flag from the frontend to a short
# rewrite instruction we append to the user message. Each one tells the
# model to PRESERVE the four-section structure so adjustments never
# collapse into wall-of-text or lose the visual hierarchy.
# ──────────────────────────────────────────────────────────────────────
ADJUSTMENT_INSTRUCTIONS = {
    "simplify": (
        "Rewrite your answer using simpler language a Cambridge AS Level "
        "student new to this topic could follow. Define every technical "
        "term in plain English the first time you use it. Keep the same "
        "four-section structure: DEFINITION, CAMBRIDGE ANSWER, EXAMINER "
        "TIP, COMMON MISTAKES."
    ),
    "detail": (
        "Expand your answer with more depth, more developed examples "
        "(both global brands and African / Zambian context), and more "
        "nuanced analysis. Keep the same four-section structure: "
        "DEFINITION, CAMBRIDGE ANSWER, EXAMINER TIP, COMMON MISTAKES."
    ),
    "shorten": (
        "Shorten your answer significantly while preserving all four "
        "sections (DEFINITION, CAMBRIDGE ANSWER, EXAMINER TIP, COMMON "
        "MISTAKES). Aim for the shortest answer that would still earn "
        "full marks."
    ),
    "examples": (
        "Add at least three more real business examples. Mix major "
        "global brands (Apple, Tesla, Amazon, Unilever, Toyota, "
        "Coca-Cola) with African / Zambian companies (Zambia National "
        "Commercial Bank, Shoprite Zambia, MTN Zambia, Airtel Africa, "
        "Dangote Group, Safaricom). Keep the same four-section structure."
    ),
}

# ──────────────────────────────────────────────────────────────────────
# RESPONSE ENVELOPE — strict two-section delimiter
# ──────────────────────────────────────────────────────────────────────
# We need to split the model's single text reply into two payload fields
# (`answer` and `breakdown`). The cleanest way is to demand the model use
# `ANSWER:` and `BREAKDOWN:` as section markers.
#
# Both sections are PLAIN TEXT (no Markdown). The ANSWER section follows
# the four-section format described above. The BREAKDOWN section is a
# short numbered list summarising what each section covered.
# ──────────────────────────────────────────────────────────────────────
RESPONSE_FORMAT_INSTRUCTION = (
    "REPLY ENVELOPE\n"
    "You MUST reply in EXACTLY this envelope, with no preamble before the "
    "first marker line. Both sections are PLAIN TEXT — no markdown, no "
    "asterisks, no hashtags, no backticks.\n"
    "\n"
    "ANSWER:\n"
    "DEFINITION\n"
    "<your precise Cambridge definition in complete sentences>\n"
    "\n"
    "CAMBRIDGE ANSWER\n"
    "<the full exam-ready response written as flowing paragraphs, "
    "covering Definition, Application and Analysis. Use inline labels "
    "\"Definition:\", \"Application:\", \"Analysis:\" at the start of "
    "the relevant paragraphs so the structure is clear>\n"
    "\n"
    "EXAMINER TIP\n"
    "Examiner Tip: <one short paragraph on what examiners look for and "
    "how to maximise marks for this style of question>\n"
    "\n"
    "COMMON MISTAKES\n"
    "Mistake: <first common mistake — why it loses marks — what to write "
    "instead>\n"
    "Mistake: <second common mistake>\n"
    "Mistake: <optional third common mistake>\n"
    "\n"
    "BREAKDOWN:\n"
    "1. Definition — <one line on what concept was defined>\n"
    "2. Cambridge Answer — <one line on what was applied and analysed>\n"
    "3. Examiner Tip — <one line on the marks strategy>\n"
    "4. Common Mistakes — <one line on the pitfalls covered>\n"
)


# ============================================================
# HOMEWORK ASSISTANT — request and response shapes
# ----------------------------------------------------------------
# Pydantic models. FastAPI uses these to:
#   1. Validate the JSON body of the incoming request.
#   2. Auto-generate the OpenAPI docs at /docs.
#   3. Coerce the return value of the endpoint into JSON.
# ============================================================

class HomeworkRequest(BaseModel):
    """JSON body the frontend POSTs to /api/homework."""

    # Lowercase subject key like "economics" or "ict". Must be one of
    # the keys in SYSTEM_PROMPTS above; otherwise we return 400.
    subject: str = Field(..., description="Lowercase subject key (economics|business|english|ict)")

    # The actual question the student typed in the text area. Trimmed
    # before use; must be at least one character of real content.
    question: str = Field(..., min_length=1, description="The student's question text")

    # Optional flag set when the user clicks one of the "Simplify / More
    # detail / Shorten / Examples" buttons. None on the first request.
    adjustment: Optional[str] = Field(default=None, description="simplify|detail|shorten|examples")


class HomeworkResponse(BaseModel):
    """JSON body returned by /api/homework on success."""

    # The Cambridge-format model answer the student should study.
    answer: str

    # Short bullet list explaining the structure (PEEL / CLS) of the answer.
    breakdown: str


# ============================================================
# HOMEWORK ASSISTANT — helper to split Groq's reply
# ----------------------------------------------------------------
# Groq returns ONE string for the whole completion. We asked it to use
# "ANSWER:" and "BREAKDOWN:" as section markers, so we split the string
# on those markers and return the two halves.
# ============================================================

def _parse_homework_reply(raw: str) -> tuple[str, str]:
    """Split a Groq reply into (answer, breakdown). Robust to formatting wobble."""

    # Strip leading/trailing whitespace so marker indices are accurate.
    text = raw.strip()

    # Use uppercase for the SEARCH but slice out of the ORIGINAL so
    # any case in the body (e.g. inline "Answer:" in prose) is preserved.
    upper = text.upper()

    ans_marker = "ANSWER:"
    brk_marker = "BREAKDOWN:"

    ans_idx = upper.find(ans_marker)
    brk_idx = upper.find(brk_marker)

    # Happy path: both markers found in the correct order.
    if ans_idx != -1 and brk_idx != -1 and brk_idx > ans_idx:
        answer = text[ans_idx + len(ans_marker) : brk_idx].strip()
        breakdown = text[brk_idx + len(brk_marker) :].strip()
        return answer, breakdown

    # Only the BREAKDOWN marker is present – everything before it is the answer.
    if brk_idx != -1:
        return (
            text[:brk_idx].strip(),
            text[brk_idx + len(brk_marker) :].strip(),
        )

    # Fallback: the model ignored our format instruction. Show the entire
    # text as the answer and an apology in the breakdown slot so the UI
    # never renders an empty card.
    return (
        text,
        "_The AI did not return a structural breakdown on this attempt. Try clicking "
        "an adjustment button (e.g. Simplify) to regenerate._",
    )


# ============================================================
# HOMEWORK ASSISTANT — POST /api/homework
# ----------------------------------------------------------------
# This is the endpoint the frontend calls every time the student
# clicks "Generate Answer" or any adjustment button.
# ============================================================

@app.post("/api/homework", response_model=HomeworkResponse)
def ask_homework(body: HomeworkRequest):
    """Build a Cambridge-style prompt, call Groq, return answer + breakdown."""

    # ---- 1. Validate the subject -------------------------------------
    # Lowercase + strip so "  Economics  " or "ECONOMICS" still works.
    subject_key = body.subject.strip().lower()
    if subject_key not in SUBJECT_CONTEXTS:
        # 400 = client error, the request itself was wrong.
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported subject '{body.subject}'. "
                f"Expected one of: {', '.join(sorted(SUBJECT_CONTEXTS.keys()))}."
            ),
        )

    # Friendly syllabus name to inject into the user prompt, e.g.
    # "Cambridge AS Level Economics (9708)".
    subject_context = SUBJECT_CONTEXTS[subject_key]

    # ---- 2. Make sure we actually have a Groq API key ----------------
    if not GROQ_API_KEY:
        # 503 = the SERVER is misconfigured (no fault of the user).
        raise HTTPException(
            status_code=503,
            detail="Groq API key missing on the server. Set GROQ_API_KEY in backend/.env.",
        )

    # ---- 3. Build the two prompts (system + user) --------------------
    # The system prompt is the SHARED Cambridge tutor persona plus the
    # strict reply envelope. Both are static module-level strings so
    # this concatenation is cheap.
    system_prompt = SYSTEM_PROMPT + "\n" + RESPONSE_FORMAT_INSTRUCTION

    # Build the user message. We tell the model the subject context up
    # front so it knows which syllabus mark scheme to follow, then we
    # include the student's question verbatim, then any adjustment
    # rewrite instruction.
    user_prompt_parts = [
        f"Subject: {subject_context}",
        f"Question:\n{body.question.strip()}",
    ]

    # If the user clicked an adjustment button, append the matching
    # rewrite instruction. Unknown values are silently ignored — they're
    # not fatal because the answer is still valuable without the tweak.
    if body.adjustment:
        adjustment_key = body.adjustment.strip().lower()
        extra = ADJUSTMENT_INSTRUCTIONS.get(adjustment_key)
        if extra:
            user_prompt_parts.append(f"Adjustment requested:\n{extra}")

    user_prompt = "\n\n".join(user_prompt_parts)

    # ---- 4. Call Groq ------------------------------------------------
    try:
        completion = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            # Low-ish temperature so the answer is more deterministic
            # and stays factually correct for academic content.
            temperature=0.4,
            # Cap output length. Bumped from 1500 → 2500 after we moved to
            # the full Markdown house style — multi-section answers with
            # bullets and headings take more tokens than plain paragraphs.
            max_tokens=2500,
        )
    except Exception as e:
        # Anything raised by the Groq client (auth, rate limit, network)
        # gets logged and surfaced to the frontend as a 502 Bad Gateway.
        print(f"[Homework] Groq call failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=502,
            detail=f"AI provider error: {type(e).__name__}: {e}",
        ) from e

    # ---- 5. Extract the assistant message text -----------------------
    # Groq's response shape mirrors OpenAI's: choices[0].message.content.
    try:
        raw_text = completion.choices[0].message.content or ""
    except (AttributeError, IndexError) as e:
        raise HTTPException(
            status_code=502,
            detail=f"AI provider returned an unexpected shape: {e}",
        ) from e

    # ---- 6. Split into answer + breakdown ----------------------------
    answer, breakdown = _parse_homework_reply(raw_text)

    # FastAPI will turn the dict into JSON automatically.
    return HomeworkResponse(answer=answer, breakdown=breakdown)


# ============================================================
# HEALTH CHECK ROUTE
# Address: GET http://localhost:8000/
# Purpose: Confirms the backend is alive and running
# Render uses this to monitor the app 24/7
# ============================================================

@app.get("/")
def health_check():
    # This function runs every time someone visits the root address
    # It simply returns a message confirming everything is working
    return {
        "status": "online",           # Backend is running
        "app": "AscendAI API",        # Name of our app
        "version": "1.0.0",           # Current version
        "message": "Backend is alive and ready to receive requests"
    }