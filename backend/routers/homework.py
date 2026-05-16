# ============================================================
# ASCENDAI BACKEND — routers/homework.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# Every HTTP request that has to do with the Homework Assistant
# feature. Two endpoints live here:
#
#   POST /homework/ask
#     • Verifies the caller's Supabase JWT.
#     • Calls Groq (LLaMA-3) with a strict Cambridge AS Level
#       system prompt.
#     • Extracts the TOPIC_TAG line the model emits at the very
#       end of its answer.
#     • Saves the question, the cleaned answer, and the topic tag
#       to the `homework_questions` table in Supabase.
#     • Returns the cleaned answer + topic tag + saved flag back
#       to the frontend.
#
#   GET /homework/history
#     • Verifies the caller's Supabase JWT.
#     • Returns the user's past Q&A entries, ordered newest first.
#     • Supports `limit` (max 100) and `offset` pagination params.
#
# WHAT TABLE WE WRITE TO
# ------------------------------------------------------------
# `homework_questions` — one row per question + answer.
# Columns we touch:  user_id, subject_id, question, answer,
# topic_tag. (created_at is auto-populated by Postgres.)
#
# NOTE on the request body's `subject` / `subject_code` fields:
# The frontend currently sends both for convenience, but the
# `homework_questions` table itself stores a `subject_id` foreign
# key — not flat strings — so on the way IN we resolve those
# fields to a UUID via a lookup against the `subjects` table, and
# on the way OUT (the history endpoint) we JOIN `subjects` so the
# response still contains flat `subject` + `subject_code` strings
# the frontend expects.
#
# WHAT EXTERNAL SERVICES WE USE
# ------------------------------------------------------------
#   • Groq (chat completions API) — for the AI answer.
#   • Supabase Auth (admin) — for JWT verification via the
#     service-role client.
#   • Supabase Postgres — for reading subjects + reading/writing
#     homework_questions.
#
# PROJECT RULES THIS FILE OBEYS
# ------------------------------------------------------------
#   • Never expose API keys, internal errors, or stack traces in
#     a response body.
#   • Use the service-role Supabase client for ALL database work
#     on the backend (NEVER the anon key).
#   • A failed Supabase save NEVER blocks the user from seeing
#     their answer — the answer is shown either way and the
#     `saved` flag in the response tells the frontend the truth.
#   • No new packages — everything here uses libraries already
#     installed for the existing /api/homework endpoint.
# ============================================================

# ── Standard library imports ─────────────────────────────────
# `os.getenv(...)` is how we read the optional GROQ_MODEL override
# from the backend .env file. `Optional[X]` lets a Pydantic field
# be either an X or None.
import os
import re
from typing import List, Optional, Tuple

# ── FastAPI imports ──────────────────────────────────────────
# APIRouter is the mini-FastAPI we attach to the main app via
# include_router(...).  Depends + Header power our bearer-token
# verification dependency. HTTPException is how we return any
# non-2xx response with a clean JSON body.  Query lets us add
# validation to ?limit= and ?offset= query parameters.
from fastapi import APIRouter, Depends, Header, HTTPException, Query

# ── Pydantic imports ─────────────────────────────────────────
# BaseModel + Field are how we describe and auto-validate the
# JSON bodies the frontend sends / we return.
from pydantic import BaseModel, Field

# ── Supabase client — service role ───────────────────────────
# This is the SAME client object database.py creates with the
# service-role key. We import it ONCE here so every route in
# this file can talk to Postgres without re-creating the client.
# Service-role is required because:
#   1. We bypass RLS to insert on behalf of an authenticated user.
#   2. We use supabase.auth.get_user(jwt) to verify any user's
#      access token (the anon client cannot do this).
from database import supabase


# ============================================================
# CONFIGURATION CONSTANTS — single source of truth.
# ============================================================
# Everything in this block is configuration. Keeping the values
# at module level (rather than inside the endpoint) means each
# value is loaded ONCE when uvicorn starts, not on every request.
# ============================================================

# Which Groq model to use. Read from the backend .env (same
# variable the legacy /api/homework endpoint uses) so a model
# upgrade is a one-line config change. The fallback is the
# official Groq-recommended replacement for the old LLaMA-3 70B
# model the original spec asked for:
#
#   • The spec named `llama3-70b-8192`.
#   • Groq decommissioned that model on 2025-08-30 and now
#     returns HTTP 400 `model_decommissioned` for it.
#   • Groq's recommended successor is `llama-3.3-70b-versatile`
#     (see https://console.groq.com/docs/deprecations).
#
# So we default to the successor, and let GROQ_MODEL in .env
# override it if the team ever wants to test a different model.
GROQ_MODEL = "llama-3.3-70b-versatile"

# Max tokens the model is allowed to spend on a single answer.
# Cambridge AS Level answers are long; 2048 comfortably fits a
# DEFINITION + full CAMBRIDGE ANSWER + EXAMINER TIP + two
# COMMON MISTAKES + the TOPIC_TAG trailer.
GROQ_MAX_TOKENS = 2048

# Temperature controls randomness. Lower → more deterministic
# and consistent Cambridge-style answers. 0.3 was chosen because
# it keeps the four-section structure rock-solid while still
# allowing slight variation in example choice (which keeps the
# answers feeling fresh, not robotic).
GROQ_TEMPERATURE = 0.3

# Tables we read from / write to — declared once so a future
# rename is a single-line change.
HOMEWORK_TABLE = "homework_questions"
SUBJECTS_TABLE = "subjects"
# Essay Checker persistence — one row per check-essay call.
ESSAY_CHECKS_TABLE = "essay_checks"
# How many past essay checks the history endpoint returns.
ESSAY_HISTORY_LIMIT = 20


# ============================================================
# SYSTEM PROMPT — the Cambridge tutor persona.
# ============================================================
# This is the verbatim prompt the spec dictates. Any change to
# the answer style (tone, structure, formatting) goes HERE.
# The prompt asks for PLAIN TEXT (no markdown) in four named
# sections plus a trailing TOPIC_TAG line that extract_topic_tag
# slices off before saving / returning to the frontend.
# ============================================================
SYSTEM_PROMPT = (
    "You are an expert Cambridge AS Level examiner and tutor with deep "
    "knowledge of all Cambridge International AS Level syllabuses including "
    "Business Studies (9609), Economics (9708), English Language (9093), "
    "and Information Technology (9626).\n"
    "\n"
    "You are helping a Cambridge AS Level student in Zambia, Southern Africa.\n"
    "\n"
    "Answer every question using this exact structure:\n"
    "\n"
    "DEFINITION\n"
    "Write a precise Cambridge-standard definition of the key concept.\n"
    "Reference the Cambridge AS Level syllabus where relevant.\n"
    "Write in complete sentences. No bullet points.\n"
    "\n"
    "CAMBRIDGE ANSWER\n"
    "Use Cambridge mark scheme format:\n"
    "Definition: Define the concept precisely\n"
    "Application: Apply to a real business context\n"
    "Analysis: Analyse impact, cause, or effect with clear reasoning\n"
    "Use a mix of global companies (Apple, Tesla, Amazon, Unilever, Toyota) "
    "and African context (MTN Zambia, Airtel Africa, Shoprite Zambia, "
    "Dangote Group, Safaricom) where relevant.\n"
    "Write in clean paragraphs. No markdown symbols. No hashtags. No asterisks.\n"
    "\n"
    "EXAMINER TIP\n"
    "One paragraph starting with \"Examiner Tip:\" telling the student exactly "
    "what Cambridge examiners look for and how to maximise marks.\n"
    "\n"
    "COMMON MISTAKES\n"
    "Two to three mistakes starting with \"Mistake:\" explaining why it loses "
    "marks and what to write instead.\n"
    "\n"
    "After your complete answer add exactly one line at the very end:\n"
    "TOPIC_TAG: [2-5 word topic name]\n"
    "Example: TOPIC_TAG: Mintzberg Management Roles\n"
    "Example: TOPIC_TAG: Price Elasticity of Demand\n"
    "The topic tag must identify the exact Cambridge topic being tested."
)


# ============================================================
# REQUEST / RESPONSE PYDANTIC MODELS
# ============================================================
# FastAPI uses these to:
#   1. Validate the JSON the frontend sends (returns 422 on
#      anything malformed — empty question, missing user_id, etc).
#   2. Auto-generate the schema documentation at /docs.
#   3. Coerce the Python return value into JSON.
# ============================================================

class HomeworkRequest(BaseModel):
    """JSON body the frontend POSTs to /homework/ask."""

    # The actual question the student typed. Cambridge questions
    # are rarely shorter than 10 chars ("Define X" is 8 chars, but
    # "Define PED" is 10), and 2000 chars is a generous upper
    # bound on a single student question.
    question: str = Field(
        ...,
        min_length=10,
        max_length=2000,
        description="The student's homework question (10-2000 chars).",
    )

    # The lowercase canonical subject key from the frontend's
    # lib/subjects.js (e.g. "economics", "business", "english",
    # "ict"). Used to resolve subject_id when writing the row.
    subject: str = Field(
        ...,
        min_length=1,
        description="Lowercase subject key (economics|business|english|ict).",
    )

    # The Cambridge syllabus code, e.g. "9708" for Economics.
    # We accept it as a string (not int) because codes are
    # treated as identifiers, not numbers.
    subject_code: str = Field(
        ...,
        min_length=1,
        description="Cambridge syllabus code (e.g. 9708, 9609, 9093, 9626).",
    )

    # The UUID of the logged-in user. The backend verifies that
    # this matches the user_id encoded in the bearer token, so a
    # malicious client cannot insert rows for somebody else.
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match token).",
    )


class HomeworkResponse(BaseModel):
    """JSON body returned by /homework/ask."""

    # The Cambridge-style answer with the TOPIC_TAG line stripped.
    answer: str

    # The extracted topic tag (e.g. "Price Elasticity of Demand")
    # or None if the model forgot to emit a TOPIC_TAG line.
    topic_tag: Optional[str] = None

    # True only if the Supabase insert succeeded. The answer is
    # still returned even when this is False — the frontend
    # surfaces a small toast in that case.
    saved: bool

    # The UUID of the newly inserted row, or None when saved=False.
    question_id: Optional[str] = None


class HistoryItem(BaseModel):
    """One row in the GET /homework/history response."""

    # All seven fields the spec asks for, in declaration order.
    id: str
    subject: Optional[str] = None
    subject_code: Optional[str] = None
    question: str
    answer: str
    topic_tag: Optional[str] = None
    created_at: str


class HistoryResponse(BaseModel):
    """JSON envelope returned by GET /homework/history."""

    # The slice of rows the caller actually asked for.
    data: list[HistoryItem]

    # Total rows that match this user (regardless of pagination).
    # The frontend uses this to render its "Showing X questions"
    # count and to compute totalPages when client-side filtering
    # is applied.
    total: int

    # Echo the limit/offset back so the client can verify the
    # server interpreted the query parameters the way it meant.
    limit: int
    offset: int


# ============================================================
# ADJUSTMENT ENDPOINT — request / response models
# ============================================================

ALLOWED_ADJUSTMENT_TYPES: List[str] = [
    "simplify",
    "more_detail",
    "shorten",
    "add_examples",
]


class HomeworkAdjustRequest(BaseModel):
    """JSON body the frontend POSTs to /homework/adjust."""

    # UUID of the saved row — when set we UPDATE homework_questions
    # so History shows the refined answer.
    question_id: Optional[str] = Field(
        default=None,
        description="Optional UUID of the saved homework_questions row.",
    )
    # Original question text — keeps Groq on-topic.
    question: str = Field(
        ...,
        min_length=10,
        max_length=2000,
        description="Original homework question (10-2000 chars).",
    )
    # Full answer currently on screen — Groq rewrites this text.
    current_answer: str = Field(
        ...,
        min_length=1,
        max_length=12000,
        description="The answer text to refine (plain text).",
    )
    # Which refinement button was tapped (validated against ALLOWED_*).
    adjustment_type: str = Field(
        ...,
        min_length=1,
        max_length=32,
        description="simplify | more_detail | shorten | add_examples",
    )
    # Display name for the prompt header (e.g. Economics).
    subject: str = Field(
        ...,
        min_length=1,
        description="Display name of the subject.",
    )
    # Cambridge syllabus code (e.g. 9708).
    subject_code: str = Field(
        ...,
        min_length=1,
        description="Cambridge syllabus code.",
    )
    # Must match the bearer token user_id.
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match token).",
    )


class HomeworkAdjustResponse(BaseModel):
    """JSON body returned by POST /homework/adjust on success."""

    adjusted_answer: str
    adjustment_type: str
    topic_tag: Optional[str] = None
    saved: bool


# ============================================================
# HELPER: extract_topic_tag
# ============================================================
# The system prompt asks the model to append exactly one line at
# the very end of its reply in the form `TOPIC_TAG: <2-5 words>`.
# This function does two things in one pass:
#   1. Strips that line out of the answer text so the student
#      never sees the literal "TOPIC_TAG:" string in their
#      Model Answer card.
#   2. Returns the topic value as a separate string we can
#      persist into the homework_questions.topic_tag column.
#
# Returns a tuple (cleaned_text, topic_tag_or_None).
# Robust against:
#   • The model emitting the marker mid-text rather than at the
#     end (we still extract it and remove that one line).
#   • Casing wobble — we compare the marker case-insensitively.
#   • Leading / trailing whitespace on the marker line.
#   • The model omitting the marker entirely — we return None
#     for the tag rather than raising.
# ============================================================
def extract_topic_tag(text: str) -> Tuple[str, Optional[str]]:
    # Defensive: if the model returned an empty string the rest
    # of the function has nothing to do.
    if not text:
        return ("", None)

    # Split the response into individual lines so we can scan
    # one by one. splitlines() preserves blank lines as empty
    # strings, which is what we want for paragraph spacing.
    lines = text.splitlines()

    # Accumulator for every line that is NOT the topic-tag line.
    # We rebuild the cleaned answer from these at the end.
    kept_lines = []

    # Default tag value — only overwritten when we find a marker.
    topic_tag: Optional[str] = None

    # Walk every line in order so the cleaned answer keeps the
    # original paragraph structure (blank lines between sections).
    for line in lines:
        # Strip leading/trailing whitespace before testing. The
        # model occasionally pads the marker line with spaces.
        stripped = line.strip()

        # Compare case-insensitively so "TOPIC_TAG:" / "Topic_Tag:"
        # / "topic_tag:" all match.
        if stripped.upper().startswith("TOPIC_TAG:"):
            # Found the marker. Take everything after the FIRST
            # colon — split(":", 1) caps the split at one so a
            # tag like "Topic: Inflation" survives intact.
            raw_value = stripped.split(":", 1)[1].strip()

            # Only store the tag if it has actual content. An
            # empty value (just "TOPIC_TAG:") becomes None.
            if raw_value:
                topic_tag = raw_value

            # Do NOT append this line to kept_lines — that's how
            # we strip it out of the cleaned answer.
            continue

        # Every other line — including blank lines — is preserved
        # so paragraph spacing in the answer stays correct.
        kept_lines.append(line)

    # Re-join with newlines and trim any trailing whitespace /
    # blank lines that may now exist because we removed the
    # marker line from the very end of the answer.
    cleaned = "\n".join(kept_lines).rstrip()

    return (cleaned, topic_tag)


# ============================================================
# HELPER: get_adjustment_prompt
# ============================================================
def get_adjustment_prompt(
    adjustment_type: str,
    current_answer: str,
    question: str,
    subject_name: str,
    subject_code: str,
) -> str:
    q = (question or "").strip()
    ans = (current_answer or "").strip()
    subj = (subject_name or "the subject").strip()
    code = (subject_code or "").strip()

    if adjustment_type == "simplify":
        return (
            "You are a Cambridge AS Level tutor simplifying an answer for "
            "a student in Zambia who found the original too complex.\n\n"
            f"Original question: {q}\n"
            f"Subject: {subj} ({code})\n\n"
            "Rewrite the answer below in simpler, clearer language.\n"
            "Use shorter sentences. Define any technical terms when first used.\n"
            "Keep all the key Cambridge concepts but make them more accessible.\n"
            "Maintain the same structure: DEFINITION, CAMBRIDGE ANSWER, "
            "EXAMINER TIP, COMMON MISTAKES.\n"
            "Do not use markdown symbols. Write in plain paragraphs only.\n"
            "The simplified answer must still be Cambridge-standard quality.\n\n"
            "Original answer to simplify:\n"
            f"{ans}"
        )

    if adjustment_type == "more_detail":
        return (
            "You are a Cambridge AS Level examiner expanding an answer for "
            "a student in Zambia who wants deeper understanding.\n\n"
            f"Original question: {q}\n"
            f"Subject: {subj} ({code})\n\n"
            "Expand the answer below with significantly more depth and detail.\n"
            "Add more economic/business theory where relevant.\n"
            "Include additional real-world examples from Zambia and Africa "
            "(MTN, Airtel, Shoprite, Zambia national economy).\n"
            "Strengthen the analysis and evaluation sections.\n"
            "For every point made — add a further developed explanation.\n"
            "Maintain the same structure: DEFINITION, CAMBRIDGE ANSWER, "
            "EXAMINER TIP, COMMON MISTAKES.\n"
            "Do not use markdown symbols. Write in plain paragraphs only.\n\n"
            "Original answer to expand:\n"
            f"{ans}"
        )

    if adjustment_type == "shorten":
        return (
            "You are a Cambridge AS Level examiner condensing an answer "
            "for a student in Zambia who needs a more concise version.\n\n"
            f"Original question: {q}\n"
            f"Subject: {subj} ({code})\n\n"
            "Shorten the answer below to its most essential points only.\n"
            "Keep the core Cambridge definition and key analysis points.\n"
            "Remove any repetition or over-explanation.\n"
            "Target: approximately half the current length.\n"
            "Maintain the same structure: DEFINITION, CAMBRIDGE ANSWER, "
            "EXAMINER TIP, COMMON MISTAKES — but each section shorter.\n"
            "Do not use markdown symbols. Write in plain paragraphs only.\n"
            "The shortened answer must still score well in Cambridge exams.\n\n"
            "Original answer to shorten:\n"
            f"{ans}"
        )

    if adjustment_type == "add_examples":
        return (
            "You are a Cambridge AS Level tutor enriching an answer for "
            "a student in Zambia with more real-world examples.\n\n"
            f"Original question: {q}\n"
            f"Subject: {subj} ({code})\n\n"
            "Rewrite the answer below adding significantly more real-world "
            "examples throughout.\n\n"
            "Prioritise examples from:\n"
            "- Zambia: Zambia National Commercial Bank, Shoprite Zambia, "
            "Airtel Zambia, MTN Zambia, Zambia Revenue Authority, "
            "Zambia's copper mining industry, Bank of Zambia\n"
            "- Africa: Safaricom Kenya, Dangote Group Nigeria, MTN Group, "
            "Equity Bank, African Development Bank\n"
            "- Global: Apple, Amazon, Tesla, Toyota, Unilever, Coca-Cola, "
            "McDonald's\n\n"
            "For every theoretical point — add a specific named example.\n"
            "Maintain the same structure: DEFINITION, CAMBRIDGE ANSWER, "
            "EXAMINER TIP, COMMON MISTAKES.\n"
            "Do not use markdown symbols. Write in plain paragraphs only.\n\n"
            "Original answer to enrich with examples:\n"
            f"{ans}"
        )

    return ""


# ============================================================
# AUTH DEPENDENCY: verify_bearer_token
# ============================================================
# FastAPI calls this for every endpoint that lists it as a
# `Depends(...)`. It does five things, in order:
#   1. Reads the `Authorization` request header.
#   2. Confirms the header starts with "Bearer " — anything
#      else is malformed.
#   3. Extracts the raw JWT after the space.
#   4. Asks Supabase to verify the JWT and decode the user.
#      Supabase signs the JWT itself, so the service-role
#      client can verify ANY user's token here.
#   5. Returns the verified user_id (a UUID string).
#
# Any failure along the way returns HTTP 401 with the exact
# body the spec requires: {"error": "Unauthorised — please log in"}.
# We deliberately use the same generic message for every failure
# mode so probing the endpoint can't reveal whether a token is
# malformed vs expired vs unknown vs revoked.
# ============================================================
def verify_bearer_token(
    # `Header(...)` tells FastAPI to populate this parameter from
    # the named HTTP header. `alias="Authorization"` is needed
    # because Python disallows dashes in variable names, and
    # using `authorization: str` would auto-convert to lowercase
    # which is fine for HTTP/2 but uglier for OpenAPI docs.
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:

    # --- STEP 1: ensure the header is present at all. -------
    if not authorization:
        # 401 Unauthorised — caller didn't supply a token.
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 2: ensure the scheme is "Bearer". -------------
    # We split on whitespace once so we get at most two pieces.
    parts = authorization.split(maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 3: extract the actual JWT. --------------------
    token = parts[1].strip()
    if not token:
        # Header was "Bearer " with no token after.
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 4: ask Supabase to verify the JWT. ------------
    # supabase.auth.get_user(jwt) returns a UserResponse on
    # success and raises on failure (expired/invalid/unknown).
    # We catch every exception type — we don't care WHY it
    # failed, only that it did.
    try:
        response = supabase.auth.get_user(token)
    except Exception as e:
        # Log server-side so we can debug auth issues without
        # leaking detail to the caller.
        print(f"[Homework] Bearer token verify raised: {type(e).__name__}")
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # Different supabase-py versions return slightly different
    # response shapes (object with .user vs dict with "user"
    # key). Handle both so a library bump doesn't break auth.
    user_obj = None
    if hasattr(response, "user"):
        user_obj = response.user
    elif isinstance(response, dict):
        user_obj = response.get("user")

    if not user_obj:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 5: pull the UUID out of the user object. -----
    user_id = (
        getattr(user_obj, "id", None)
        if not isinstance(user_obj, dict)
        else user_obj.get("id")
    )
    if not user_id:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # Coerce to str so endpoints get a predictable type back.
    return str(user_id)


# ============================================================
# THE ROUTER
# ============================================================
# Every route below is registered against this object. main.py
# attaches it to the app with:
#   app.include_router(homework.router, prefix="/homework",
#                      tags=["Homework"])
# So the final paths become /homework/ask and /homework/history.
# ============================================================
router = APIRouter()


# ============================================================
# HELPER: _resolve_subject_id
# ============================================================
# The frontend sends the subject as both a lowercase key
# ("economics") and a syllabus code ("9708"), but the
# `homework_questions` table stores subject as a UUID foreign
# key (subject_id → subjects.id). This helper bridges the two.
#
# Why a separate helper?
#   • Keeps the main endpoint readable — no inline lookup loop.
#   • Reused by anywhere else in the file that needs to write
#     a subject_id later (e.g. future bulk-import endpoint).
#
# Strategy:
#   1. Pull every subject row from Supabase.
#   2. Compare each candidate row's `name`, `code`, `key`, and
#      `slug` columns (only the ones that exist on the row)
#      against the supplied key + code values.
#   3. Return the first row whose UUID matches, or None.
#
# Returns the UUID string or None.
# ============================================================
def _resolve_subject_id(subject_key: str, subject_code: str) -> Optional[str]:
    # Defensive guard — empty inputs can't resolve to anything.
    key = (subject_key or "").strip().lower()
    code = (subject_code or "").strip()
    if not key and not code:
        return None

    try:
        # `select("*")` so we don't crash if the table happens
        # to have an extra column we didn't anticipate (e.g.
        # the audit identified `key` vs `slug` drift earlier in
        # the project). We only READ the columns we trust below.
        result = supabase.table(SUBJECTS_TABLE).select("*").execute()
    except Exception as e:
        # Log and gracefully degrade — the caller will fall back
        # to inserting without subject_id, which the table will
        # reject (NOT NULL), which the caller treats as a
        # "saved=False" and still returns the answer.
        print(f"[Homework] Could not load subjects table: {type(e).__name__}: {e}")
        return None

    rows = getattr(result, "data", None) or []
    for row in rows:
        # Build a comparison set of every plausible identifier
        # value present on the row. Lower-case each non-code
        # value so casing differences ("Economics" vs "economics")
        # don't cause a miss.
        candidate_values = []
        for col in ("name", "key", "slug"):
            value = row.get(col)
            if value:
                candidate_values.append(str(value).lower())

        # `code` is compared as-is — codes are short identifiers
        # ("9708") and case is irrelevant.
        row_code = row.get("code")
        row_code_str = str(row_code) if row_code else ""

        # Match if EITHER:
        #   • any of name/key/slug matches the lowercase key, OR
        #   • the row's code matches the supplied code.
        if key and key in candidate_values:
            return row.get("id")
        if code and code == row_code_str:
            return row.get("id")

    # Nothing matched — let the caller decide what to do.
    return None


# ============================================================
# HELPER: _normalise_subject_for_response
# ============================================================
# Given a joined subjects sub-object (the {name, code} dict that
# PostgREST returns when we ask for subjects(name, code)), produce
# the (subject, subject_code) pair the History response promises.
#
# We don't want to ship raw display names like "Information
# Technology" because the FRONTEND filter list compares against
# lowercase keys ("ict"). So we derive a "key" from the display
# name with one small alias table for the case where the first
# word doesn't match the key (Information Technology → ict).
# ============================================================
def _normalise_subject_for_response(joined_subject: Optional[dict]) -> Tuple[Optional[str], Optional[str]]:
    # Defensive: missing join → both fields are None.
    if not joined_subject or not isinstance(joined_subject, dict):
        return (None, None)

    raw_name = joined_subject.get("name") or ""
    raw_code = joined_subject.get("code")

    # First word of the lowercase name is the key for THREE of
    # the four subjects (Economics → "economics", Business
    # Studies → "business", English Language → "english").
    first_word = raw_name.strip().lower().split()[0] if raw_name else ""

    # The one exception — "Information Technology" → "ict". Kept
    # as a single-entry alias map so it can grow if new subjects
    # are added that don't follow the first-word rule.
    aliases = {"information": "ict"}
    subject_key = aliases.get(first_word, first_word) or None

    # Cast the code to str so the JSON serialiser doesn't crash
    # if a row ever has it stored as an int.
    code_str = str(raw_code) if raw_code is not None else None

    return (subject_key, code_str)


# ============================================================
# ENDPOINT: POST /homework/ask
# ============================================================
# END-TO-END FLOW (what happens between request and response):
#   1. FastAPI validates the JSON body against HomeworkRequest.
#      Missing / out-of-range fields → 422 automatically.
#   2. The verify_bearer_token dependency runs FIRST so any
#      unauthenticated request never reaches our route logic.
#   3. We compare the verified user_id against body.user_id and
#      reject mismatches with 401 (defence against a malicious
#      client trying to insert rows on someone else's behalf).
#   4. We resolve the subject_key + subject_code to the UUID
#      foreign key that homework_questions expects.
#   5. We call Groq with the strict Cambridge tutor system
#      prompt and the student's question.
#   6. We extract and strip the TOPIC_TAG line from the reply.
#   7. We INSERT the row into homework_questions. A failure
#      here is logged but NEVER blocks the response — the
#      student always sees their answer.
#   8. We respond with { answer, topic_tag, saved, question_id }.
# ============================================================
@router.post(
    "/ask",
    response_model=HomeworkResponse,
    summary="Ask a Cambridge AS Level homework question",
)
def ask_homework(
    body: HomeworkRequest,
    # Dependency runs BEFORE the route body — if the token is
    # bad the caller never reaches the Groq call.
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: identity check ───────────────────────────────
    # The token says the caller is user X. The body says the
    # caller wants to write a row for user Y. We REQUIRE X == Y.
    # Without this check, a logged-in user could spoof another
    # user's history by sending their UUID in the body.
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # ── STEP 2: resolve the subject → UUID ───────────────────
    # The homework_questions table's subject_id column is a FK
    # to subjects.id. The frontend sent us a lowercase key + a
    # syllabus code; we look up the matching subjects row.
    # If we can't find one (e.g. seed migration didn't run in
    # this environment) we'll still call Groq and surface the
    # answer — only the Supabase save will fail.
    subject_id = _resolve_subject_id(body.subject, body.subject_code)

    # ── STEP 3: build the prompt + call Groq ─────────────────
    # We import the Groq client lazily here (inside the function
    # body, not at module top) because routers/homework.py is
    # itself imported by main.py — a top-level `from main import
    # groq_client` would create a circular import. Lazy import
    # is safe because by the time this function RUNS, main.py
    # has fully loaded and groq_client exists.
    try:
        from main import groq_client  # noqa: WPS433 (intentional lazy import)
    except Exception as e:
        # Logging this so a missing client is loud in dev.
        print(f"[Homework] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    # The user-side prompt is small: just the subject context
    # and the student's question. The full Cambridge tutor
    # persona lives in the system prompt above.
    user_prompt = (
        f"Subject: Cambridge AS Level {body.subject.title()} "
        f"({body.subject_code})\n\n"
        f"Question:\n{body.question.strip()}"
    )

    try:
        # Send the prompt to Groq. We catch broadly because the
        # Groq SDK can raise auth errors, rate-limit errors,
        # timeouts, and arbitrary network exceptions — every
        # one of them should surface to the user as the same
        # generic 503 ("AI service unavailable").
        completion = groq_client.chat.completions.create(
            # MODEL — the exact LLaMA 3 70B variant the spec
            # locks in for this endpoint.
            model=GROQ_MODEL,
            # MESSAGES — two-message conversation: persona
            # (system) + the student's question (user).
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt},
            ],
            # MAX TOKENS — generous cap so long Cambridge
            # answers (DEFINITION + full CAMBRIDGE ANSWER + tip
            # + mistakes) fit without being truncated mid-mark.
            max_tokens=GROQ_MAX_TOKENS,
            # TEMPERATURE — 0.3 keeps answers consistent and
            # exam-style; higher values introduced markdown
            # symbols and creative tangents during testing.
            temperature=GROQ_TEMPERATURE,
        )
    except Exception as e:
        # Log the internal cause so we can debug without
        # exposing it to the caller. ALL Groq failure modes
        # map to the same 503 response per the spec.
        print(f"[Homework] Groq call failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    # ── STEP 4: pull the raw text out of Groq's response. ───
    # Groq mirrors OpenAI's response shape: a list of choices,
    # each with .message.content holding the assistant's text.
    try:
        raw_answer = completion.choices[0].message.content or ""
    except (AttributeError, IndexError) as e:
        print(f"[Homework] Groq response shape unexpected: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    # ── STEP 5: extract + strip the topic tag. ───────────────
    cleaned_answer, topic_tag = extract_topic_tag(raw_answer)

    # ── STEP 6: save to Supabase (fire-and-forget semantics). ─
    # We DELIBERATELY do not let a save failure block the
    # response — the student should never lose their answer
    # because the database round-trip went wrong. We track
    # `saved` and `question_id` so the frontend can surface a
    # quiet "couldn't save to your history" toast if needed.
    saved = False
    question_id: Optional[str] = None

    try:
        # Build the insert payload. Every key here is a column
        # in the homework_questions table. created_at is auto-
        # populated by the table's default value (now()).
        insert_payload = {
            # user_id   — the verified UUID from the token.
            "user_id": verified_user_id,
            # subject_id — the UUID resolved in STEP 2.
            "subject_id": subject_id,
            # question  — the student's prompt, trimmed.
            "question": body.question.strip(),
            # answer    — the cleaned answer (no TOPIC_TAG line).
            "answer": cleaned_answer,
            # topic_tag — short tag from the model, or NULL.
            "topic_tag": topic_tag,
        }

        # Execute the insert. We pass returning="*" implicitly
        # (the default for supabase-py) so result.data contains
        # the newly inserted row, including its UUID.
        result = supabase.table(HOMEWORK_TABLE).insert(insert_payload).execute()

        # supabase-py returns either an object with .data or
        # a dict with "data" — guard against both shapes so
        # a library upgrade doesn't silently break this.
        rows = getattr(result, "data", None)
        if isinstance(rows, list) and rows:
            question_id = rows[0].get("id")
            saved = True
        elif isinstance(result, dict):
            inner = result.get("data") or []
            if inner:
                question_id = inner[0].get("id")
                saved = True

        if not saved:
            # Insert ran but returned no row — log so we can
            # find the cause (usually an RLS rejection on
            # subject_id=null).
            print(
                "[Homework] Supabase insert returned no rows; "
                "subject_id may be NULL because the subject "
                "lookup did not match."
            )

    except Exception as e:
        # Any DB-side failure (RLS, FK violation, network) lands
        # here. Logged, never raised — the student still gets
        # their answer.
        print(f"[Homework] Supabase insert failed: {type(e).__name__}: {e}")
        saved = False
        question_id = None

    # ── STEP 7: respond. ─────────────────────────────────────
    return HomeworkResponse(
        answer=cleaned_answer,
        topic_tag=topic_tag,
        saved=saved,
        question_id=question_id,
    )


# ============================================================
# ENDPOINT: GET /homework/history
# ============================================================
# END-TO-END FLOW:
#   1. Verify the bearer token (same dependency as /ask).
#   2. Clamp the limit / offset query parameters.
#   3. Run TWO Supabase queries:
#        a. A `count="exact"` query for `total`.
#        b. The actual paginated select with a JOIN on subjects
#           so the response carries subject + subject_code as
#           flat strings the frontend can render directly.
#   4. Normalise each row and return the envelope shape the
#      spec requires.
# ============================================================
@router.get(
    "/history",
    response_model=HistoryResponse,
    summary="Get the caller's homework history",
)
def homework_history(
    # Query parameters — `Query(...)` adds OpenAPI doc info AND
    # the validation rules (ge=0, le=100). FastAPI returns 422
    # automatically if a client passes limit=999 or offset=-5.
    limit: int = Query(
        default=50,
        ge=1,
        le=100,
        description="Maximum rows to return (1-100, default 50).",
    ),
    offset: int = Query(
        default=0,
        ge=0,
        description="Number of rows to skip for pagination (default 0).",
    ),
    # Same auth dependency as the POST endpoint. Any non-2xx
    # response from the dependency short-circuits the route.
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: ask Supabase for the total row count. ────────
    # `count="exact"` makes PostgREST return the total number
    # of matching rows in the response header — we read it via
    # result.count. We DO NOT trust .data here; this query
    # exists purely for the count.
    try:
        count_result = (
            supabase
            .table(HOMEWORK_TABLE)
            .select("id", count="exact")
            .eq("user_id", verified_user_id)
            .execute()
        )
        total = getattr(count_result, "count", None) or 0
    except Exception as e:
        # Logged + replaced with 0 so the endpoint still
        # returns a usable envelope on partial DB failure.
        print(f"[Homework] History count failed: {type(e).__name__}: {e}")
        total = 0

    # ── STEP 2: run the actual paginated select. ─────────────
    # The string after select() lists the columns we want PLUS
    # the relationship to subjects. PostgREST returns the
    # subjects row as a nested object under "subjects" — we
    # flatten it via _normalise_subject_for_response below.
    try:
        list_result = (
            supabase
            .table(HOMEWORK_TABLE)
            # The "subjects(name, code)" suffix asks PostgREST
            # to JOIN the subjects table and embed those two
            # fields under the key "subjects" on every row.
            .select(
                "id, question, answer, topic_tag, created_at, "
                "subjects(name, code)"
            )
            # Filter to the verified user — RLS would do this
            # for us with the anon key, but explicit is safer
            # here so the service role doesn't accidentally
            # leak someone else's rows.
            .eq("user_id", verified_user_id)
            # Newest first — what every "history" UI expects.
            .order("created_at", desc=True)
            # Translate (offset, limit) into the inclusive
            # range PostgREST uses on its Range header.
            .range(offset, offset + limit - 1)
            .execute()
        )
        rows = getattr(list_result, "data", None) or []
    except Exception as e:
        # Any DB error during the list query → empty data set
        # with whatever total we resolved above. Logged for
        # debugging, never raised to the caller.
        print(f"[Homework] History list failed: {type(e).__name__}: {e}")
        rows = []

    # ── STEP 3: normalise each row to the spec shape. ────────
    items: list[HistoryItem] = []
    for r in rows:
        # Flatten the joined subject into two flat strings.
        subject_key, subject_code = _normalise_subject_for_response(
            r.get("subjects")
        )

        # Wrap every value in HistoryItem so Pydantic validates
        # the shape one more time before serialisation. This is
        # cheap and catches accidental schema drift early.
        items.append(
            HistoryItem(
                id=str(r.get("id", "")),
                subject=subject_key,
                subject_code=subject_code,
                question=r.get("question") or "",
                answer=r.get("answer") or "",
                topic_tag=r.get("topic_tag"),
                # Coerce timestamp to str — Pydantic accepts
                # both datetime and str on the way in but we
                # want a stable JSON string on the way out.
                created_at=str(r.get("created_at") or ""),
            )
        )

    # ── STEP 4: envelope it up. ──────────────────────────────
    return HistoryResponse(
        data=items,
        total=total,
        limit=limit,
        offset=offset,
    )


# ============================================================
# ENDPOINT: POST /homework/adjust
# ============================================================
# END-TO-END FLOW:
#   1. Validate body (Pydantic) + bearer token (dependency).
#   2. Reject invalid adjustment_type with 422 listing valid values.
#   3. Identity check: body.user_id must match verified token.
#   4. Build the adjustment-specific Groq prompt via
#      get_adjustment_prompt(...).
#   5. Call Groq (llama-3.3-70b-versatile, 2048 tokens, 0.3 temp).
#   6. extract_topic_tag on the reply.
#   7. If question_id provided → UPDATE homework_questions row.
#   8. Return { adjusted_answer, adjustment_type, topic_tag, saved }.
# ============================================================
@router.post(
    "/adjust",
    response_model=HomeworkAdjustResponse,
    summary="Refine an existing homework answer (simplify, expand, etc.).",
)
def adjust_homework(
    body: HomeworkAdjustRequest,
    # Same bearer-token gate as /homework/ask — unauthenticated
    # callers never reach Groq or Supabase.
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: validate adjustment_type. ──────────────────
    # Pydantic only checks that the field is a non-empty string;
    # we enforce the allowed enum here so the client gets a
    # helpful 422 that lists every valid option.
    adj_type = (body.adjustment_type or "").strip().lower()
    if adj_type not in ALLOWED_ADJUSTMENT_TYPES:
        allowed = ", ".join(ALLOWED_ADJUSTMENT_TYPES)
        raise HTTPException(
            status_code=422,
            detail={
                "error": (
                    f"Invalid adjustment_type '{body.adjustment_type}'. "
                    f"Must be one of: {allowed}"
                )
            },
        )

    # ── STEP 2: identity check (same as /ask). ───────────────
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # ── STEP 3: build the Groq prompt for this button. ───────
    system_style_prompt = get_adjustment_prompt(
        adjustment_type=adj_type,
        current_answer=body.current_answer,
        question=body.question,
        subject_name=body.subject,
        subject_code=body.subject_code,
    )
    if not system_style_prompt:
        # Defensive — validation should have caught unknown types.
        raise HTTPException(
            status_code=422,
            detail={"error": "Could not build adjustment prompt."},
        )

    # ── STEP 4: call Groq. ───────────────────────────────────
    try:
        from main import groq_client  # noqa: WPS433
    except Exception as e:
        print(f"[Homework] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    try:
        completion = groq_client.chat.completions.create(
            # MODEL — same llama-3.3-70b-versatile as /homework/ask so
            # refinement quality matches the original answer style.
            model=GROQ_MODEL,
            messages=[
                # Single user message — the adjustment template
                # already embeds persona + rules + the answer to edit.
                {"role": "user", "content": system_style_prompt},
            ],
            # MAX TOKENS — 2048 matches the spec; enough for a full
            # four-section rewrite without truncating mid-answer.
            max_tokens=GROQ_MAX_TOKENS,
            # TEMPERATURE — 0.3 keeps refinements consistent and
            # exam-appropriate (same value as /homework/ask).
            temperature=GROQ_TEMPERATURE,
        )
    except Exception as e:
        print(f"[Homework] Groq adjust call failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    # ── STEP 5: parse Groq output. ───────────────────────────
    try:
        raw_answer = completion.choices[0].message.content or ""
    except (AttributeError, IndexError) as e:
        print(f"[Homework] Groq adjust response shape unexpected: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    cleaned_answer, topic_tag = extract_topic_tag(raw_answer)

    # ── STEP 6: optionally UPDATE the saved row. ─────────────
    saved = False
    qid = (body.question_id or "").strip()
    if qid:
        try:
            # Update the saved record so History shows the latest
            # adjusted version (answer + re-extracted topic_tag).
            update_payload = {
                "answer": cleaned_answer,
                "topic_tag": topic_tag,
            }
            result = (
                supabase.table(HOMEWORK_TABLE)
                .update(update_payload)
                .eq("id", qid)
                .eq("user_id", verified_user_id)
                .execute()
            )
            rows = getattr(result, "data", None)
            if isinstance(rows, list) and len(rows) > 0:
                saved = True
            elif isinstance(result, dict):
                inner = result.get("data") or []
                if inner:
                    saved = True
            if not saved:
                print(
                    f"[Homework] adjust UPDATE returned no rows for "
                    f"question_id={qid}"
                )
        except Exception as e:
            # Log but still return the adjusted answer — the student
            # should see the refinement even if the DB write fails.
            print(
                f"[Homework] adjust Supabase UPDATE failed: "
                f"{type(e).__name__}: {e}"
            )
            saved = False
    # If question_id is null we skip the save silently — the
    # frontend may not have a saved row yet (saved=false on /ask).

    # ── STEP 7: respond. ─────────────────────────────────────
    return HomeworkAdjustResponse(
        adjusted_answer=cleaned_answer,
        adjustment_type=adj_type,
        topic_tag=topic_tag,
        saved=saved,
    )


# ============================================================
# ESSAY CHECKER — request / response models
# ============================================================

ALLOWED_ESSAY_MARKS = (8, 10, 12)

# Groq settings for essay marking — lower temperature for consistency.
ESSAY_CHECK_MAX_TOKENS = 1200
ESSAY_CHECK_TEMPERATURE = 0.3

# Cambridge senior examiner persona for long-answer marking.
ESSAY_CHECK_SYSTEM_PROMPT = """
You are a Senior Cambridge International AS Level Examiner
with 20 years of experience marking Economics, Business
Studies, English Language, and ICT papers.

You have marked thousands of scripts and know exactly what
separates a Band 1 answer from a Band 4 answer.

Your job is to evaluate the student's answer with brutal
honesty but genuine care — like the best teacher they
have ever had.

You understand that this student is in Zambia, studying
hard, and needs specific actionable feedback — not vague
encouragement.

CAMBRIDGE MARKING PRINCIPLES YOU ALWAYS APPLY:
- Definition: Is the key term defined precisely?
- Knowledge: Are facts, concepts, and theories accurate?
- Application: Is the answer applied to the context given?
- Analysis: Are chains of reasoning developed fully?
  (cause → effect → further effect → so what?)
- Evaluation: Are judgements made with justification?
  (For 10+ mark questions only)
- Structure: Is the answer logically organised?
- Examples: Are relevant real-world examples used?

BAND DESCRIPTORS YOU USE:
For 8 mark questions:
- Band 4 (7-8): Precise definition, thorough analysis,
  excellent application, well-structured
- Band 3 (5-6): Good knowledge, some analysis,
  limited evaluation
- Band 2 (3-4): Basic knowledge, limited analysis,
  weak application
- Band 1 (1-2): Minimal relevant content

For 10 mark questions:
- Band 4 (9-10): All of above plus strong evaluation
- Band 3 (7-8): Good analysis, some evaluation
- Band 2 (4-6): Basic knowledge and analysis
- Band 1 (1-3): Minimal relevant content

For 12 mark questions:
- Band 4 (10-12): Exceptional — definition, analysis,
  evaluation, structured argument, real examples
- Band 3 (7-9): Good but missing evaluation depth
- Band 2 (4-6): Some knowledge, weak analysis
- Band 1 (1-3): Minimal relevant content

OUTPUT FORMAT — respond in this EXACT structure
with these EXACT headers, nothing else:

GRADE_BAND: [Band number] — [mark range] out of [total]
BAND_LABEL: [one phrase — e.g. "Strong answer with good analysis"]
ESTIMATED_MARKS: [single number — your best estimate]

WHAT_YOU_DID_WELL:
[Point 1 — specific and referenced to their actual answer]
[Point 2 — specific and referenced to their actual answer]
[Point 3 — specific and referenced to their actual answer]

WHAT_IS_MISSING:
[Point 1 — specific gap with explanation of why it matters]
[Point 2 — specific gap with explanation of why it matters]
[Point 3 — specific gap with explanation of why it matters]

EXAMINER_FEEDBACK:
[Write exactly what a Cambridge examiner would write
on this script — 3-4 sentences, honest and specific.
Reference the student's actual content.
Use phrases like "The candidate demonstrates...",
"However, the response lacks...",
"To achieve full marks..."]

MODEL_PARAGRAPH:
[Rewrite ONE paragraph from their answer showing exactly
how it should look at full marks. Use the student's own
topic but elevate the language, structure, and depth.
Show what a Band 4 paragraph looks like.
Begin with: "Here is how this paragraph could be written
for full marks:"]

Be specific. Be honest. Be helpful.
Never be vague. Never just say "good job".
Always reference what the student actually wrote.
"""


class EssayCheckRequest(BaseModel):
    """JSON body the frontend POSTs to /homework/check-essay."""

    subject: str = Field(..., min_length=1, description="Subject label, e.g. Economics 9708.")
    question: str = Field(..., min_length=1, description="The exam question text.")
    answer: str = Field(..., min_length=1, description="The student's essay answer.")
    marks: int = Field(..., description="Total marks available (8, 10, or 12).")


class EssayCheckResponse(BaseModel):
    """Structured Cambridge marking feedback for an essay answer."""

    grade_band: str
    band_label: str
    estimated_marks: int
    what_did_well: List[str]
    what_is_missing: List[str]
    examiner_feedback: str
    model_paragraph: str
    error: Optional[str] = None


def _parse_essay_section_lines(block: str) -> List[str]:
    """
    Turn a multi-line feedback block into a list of bullet strings.

    Strips leading brackets like "[Point 1 — ...]" so the frontend
  can render clean list items.
    """

    items: List[str] = []
    for line in (block or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        # Remove common list prefixes the model might emit.
        stripped = re.sub(r"^\[[^\]]+\]\s*", "", stripped)
        stripped = re.sub(r"^[-•*]\s*", "", stripped)
        stripped = re.sub(r"^\d+[\.)]\s*", "", stripped)
        if stripped:
            items.append(stripped)
    return items


def _parse_essay_check_response(raw: str) -> dict:
    """
    Split the Groq plain-text reply on the required headers and
    map each section into the EssayCheckResponse fields.
    """

    text = (raw or "").strip()
    headers = [
        "GRADE_BAND",
        "BAND_LABEL",
        "ESTIMATED_MARKS",
        "WHAT_YOU_DID_WELL",
        "WHAT_IS_MISSING",
        "EXAMINER_FEEDBACK",
        "MODEL_PARAGRAPH",
    ]

    # Build a regex that captures header positions in order.
    pattern = r"(?m)^(" + "|".join(re.escape(h) for h in headers) + r")\s*:?\s*"
    parts = re.split(pattern, text)

    sections: dict = {}
    i = 1
    while i < len(parts) - 1:
        key = parts[i].strip().upper()
        body = parts[i + 1].strip() if i + 1 < len(parts) else ""
        sections[key] = body
        i += 2

    grade_band = sections.get("GRADE_BAND", "").strip()
    band_label = sections.get("BAND_LABEL", "").strip()

    # Parse the single-number mark estimate; default to 0 on failure.
    marks_raw = sections.get("ESTIMATED_MARKS", "0").strip()
    marks_match = re.search(r"\d+", marks_raw)
    estimated_marks = int(marks_match.group(0)) if marks_match else 0

    return {
        "grade_band": grade_band,
        "band_label": band_label,
        "estimated_marks": estimated_marks,
        "what_did_well": _parse_essay_section_lines(
            sections.get("WHAT_YOU_DID_WELL", "")
        ),
        "what_is_missing": _parse_essay_section_lines(
            sections.get("WHAT_IS_MISSING", "")
        ),
        "examiner_feedback": sections.get("EXAMINER_FEEDBACK", "").strip(),
        "model_paragraph": sections.get("MODEL_PARAGRAPH", "").strip(),
    }


@router.post(
    "/check-essay",
    response_model=EssayCheckResponse,
    summary="Mark a Cambridge AS Level long answer or essay",
)
def check_essay(
    body: EssayCheckRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Mark a student's long answer using a senior-examiner Groq prompt.

    Flow:
      1. Validate marks (8, 10, or 12 only).
      2. Build system + user prompts with subject, question, marks.
      3. Call Groq (llama-3.3-70b-versatile, 1200 tokens, temp 0.3).
      4. Parse the structured header response into JSON fields.
    """

    # Bearer auth only — verified_user_id ensures the caller is signed in.
    _ = verified_user_id

    if body.marks not in ALLOWED_ESSAY_MARKS:
        raise HTTPException(
            status_code=422,
            detail={
                "error": f"marks must be one of: {', '.join(str(m) for m in ALLOWED_ESSAY_MARKS)}",
            },
        )

    subject = body.subject.strip()
    question = body.question.strip()
    answer = body.answer.strip()
    marks = int(body.marks)

    user_prompt = (
        f"Subject: {subject}\n"
        f"Question: {question}\n"
        f"Marks Available: {marks}\n\n"
        f"Student's Answer:\n{answer}\n\n"
        "Evaluate this answer using the Cambridge marking criteria."
    )

    try:
        from main import groq_client  # noqa: WPS433
    except Exception as e:
        print(f"[Homework] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    try:
        completion = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": ESSAY_CHECK_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=ESSAY_CHECK_MAX_TOKENS,
            temperature=ESSAY_CHECK_TEMPERATURE,
        )
    except Exception as e:
        print(f"[Homework] essay check Groq failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    try:
        raw_text = completion.choices[0].message.content or ""
    except (AttributeError, IndexError) as e:
        print(f"[Homework] essay check response shape unexpected: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    parsed = _parse_essay_check_response(raw_text)

    # ── Save essay check to Supabase (non-blocking). ─────────
    # Same fire-and-forget pattern as POST /homework/ask — the
    # student always receives feedback even if the insert fails.
    try:
        essay_insert_payload = {
            "user_id": verified_user_id,
            "subject": subject,
            "question": question,
            "original_answer": answer,
            "marks_available": marks,
            "grade_band": parsed["grade_band"],
            "band_label": parsed["band_label"],
            "estimated_marks": parsed["estimated_marks"],
            "what_did_well": parsed["what_did_well"],
            "what_is_missing": parsed["what_is_missing"],
            "examiner_feedback": parsed["examiner_feedback"],
            "model_paragraph": parsed["model_paragraph"],
            "model_answer": None,
        }
        supabase.table(ESSAY_CHECKS_TABLE).insert(essay_insert_payload).execute()
    except Exception as e:
        print(
            f"[Homework] essay_checks insert failed: {type(e).__name__}: {e}. "
            "Run backend/migrations/essay_checks.sql in Supabase if the table is missing."
        )

    return EssayCheckResponse(
        grade_band=parsed["grade_band"],
        band_label=parsed["band_label"],
        estimated_marks=parsed["estimated_marks"],
        what_did_well=parsed["what_did_well"],
        what_is_missing=parsed["what_is_missing"],
        examiner_feedback=parsed["examiner_feedback"],
        model_paragraph=parsed["model_paragraph"],
        error=None,
    )


# ============================================================
# MODEL ANSWER GENERATOR — request / response models
# ============================================================

# Groq settings for full Band 4 model answers — longer output cap.
MODEL_ANSWER_MAX_TOKENS = 1500
MODEL_ANSWER_TEMPERATURE = 0.3

# Tutor persona that rewrites the student's work at full-marks quality.
MODEL_ANSWER_SYSTEM_PROMPT = """
You are a Senior Cambridge International AS Level Examiner
and expert tutor. A student has just received feedback on
their essay answer. Your job is to write a complete model
answer that incorporates all the improvements identified
in the feedback.

This model answer should:
- Be written at Band 4 level — full marks quality
- Use the student's original ideas and topic as the base
- Fix every weakness identified in the feedback
- Show exactly what a perfect Cambridge answer looks like
- Include: precise definition, full analysis chains,
  real-world examples, ceteris paribus where relevant,
  evaluation points for 10+ mark questions
- Be structured with clear logical flow
- Use Cambridge examiner language and terminology
- Be the length appropriate for the marks available:
  8 marks: 3-4 well developed paragraphs
  10 marks: 4-5 paragraphs with evaluation
  12 marks: 5-6 paragraphs with strong evaluation

Write ONLY the model answer — no preamble, no explanation.
Start directly with the answer content.
Write as if you are the student writing their best possible
answer in an exam.
"""


class ModelAnswerRequest(BaseModel):
    """JSON body the frontend POSTs to /homework/model-answer."""

    subject: str = Field(..., min_length=1, description="Subject label, e.g. Economics 9708.")
    question: str = Field(..., min_length=1, description="The exam question text.")
    marks: int = Field(..., description="Total marks available (8, 10, or 12).")
    original_answer: str = Field(..., min_length=1, description="Student's submitted answer.")
    what_did_well: List[str] = Field(default_factory=list, description="Strengths from essay check.")
    what_is_missing: List[str] = Field(default_factory=list, description="Gaps from essay check.")
    examiner_feedback: str = Field(default="", description="Examiner summary from essay check.")


class ModelAnswerResponse(BaseModel):
    """Full Band 4 model answer generated from essay-check feedback."""

    model_answer: str
    error: Optional[str] = None


@router.post(
    "/model-answer",
    response_model=ModelAnswerResponse,
    summary="Generate a full Band 4 model answer from essay feedback",
)
def generate_model_answer(
    body: ModelAnswerRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Write a complete Cambridge model answer using essay-check feedback.

    Flow:
      1. Validate marks (8, 10, or 12 only).
      2. Build user prompt from question, feedback lists, and original answer.
      3. Call Groq (llama-3.3-70b-versatile, 1500 tokens, temp 0.3).
      4. Return the plain-text model answer for the frontend to render.
    """

    # Bearer auth only — verified_user_id ensures the caller is signed in.
    _ = verified_user_id

    if body.marks not in ALLOWED_ESSAY_MARKS:
        raise HTTPException(
            status_code=422,
            detail={
                "error": f"marks must be one of: {', '.join(str(m) for m in ALLOWED_ESSAY_MARKS)}",
            },
        )

    subject = body.subject.strip()
    question = body.question.strip()
    marks = int(body.marks)
    original_answer = body.original_answer.strip()
    what_did_well = body.what_did_well or []
    what_is_missing = body.what_is_missing or []
    examiner_feedback = (body.examiner_feedback or "").strip()

    # Join bullet lists for the user prompt — one strength/gap per line.
    strengths_block = "\n".join(what_did_well) if what_did_well else "(none listed)"
    gaps_block = "\n".join(what_is_missing) if what_is_missing else "(none listed)"

    user_prompt = (
        f"Subject: {subject}\n"
        f"Question: {question}\n"
        f"Marks Available: {marks}\n\n"
        f"The student's original answer had these strengths:\n{strengths_block}\n\n"
        f"The student's original answer was missing:\n{gaps_block}\n\n"
        f"Examiner feedback:\n{examiner_feedback}\n\n"
        f"Original answer for reference:\n{original_answer}\n\n"
        "Now write a complete Band 4 model answer that incorporates\n"
        "all the improvements and fixes all the weaknesses."
    )

    try:
        from main import groq_client  # noqa: WPS433
    except Exception as e:
        print(f"[Homework] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    try:
        completion = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": MODEL_ANSWER_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=MODEL_ANSWER_MAX_TOKENS,
            temperature=MODEL_ANSWER_TEMPERATURE,
        )
    except Exception as e:
        print(f"[Homework] model answer Groq failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    try:
        raw_text = (completion.choices[0].message.content or "").strip()
    except (AttributeError, IndexError) as e:
        print(f"[Homework] model answer response shape unexpected: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    # ── Update the latest matching essay_checks row. ───────────
    # Find the most recent check for this user with the same
    # question text, then store the generated model answer.
    try:
        match_result = (
            supabase.table(ESSAY_CHECKS_TABLE)
            .select("id")
            .eq("user_id", verified_user_id)
            .eq("question", question)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        match_rows = getattr(match_result, "data", None) or []
        if match_rows:
            row_id = match_rows[0].get("id")
            if row_id:
                supabase.table(ESSAY_CHECKS_TABLE).update(
                    {"model_answer": raw_text}
                ).eq("id", row_id).execute()
    except Exception as e:
        print(
            f"[Homework] essay_checks model_answer update failed: "
            f"{type(e).__name__}: {e}"
        )

    return ModelAnswerResponse(model_answer=raw_text, error=None)


# ============================================================
# ESSAY HISTORY — response models + GET endpoint
# ============================================================


class EssayHistoryItem(BaseModel):
    """One saved essay check row returned to the frontend."""

    id: str
    subject: str
    question: str
    original_answer: str
    marks_available: int
    grade_band: Optional[str] = None
    band_label: Optional[str] = None
    estimated_marks: Optional[int] = None
    what_did_well: List[str] = Field(default_factory=list)
    what_is_missing: List[str] = Field(default_factory=list)
    examiner_feedback: Optional[str] = None
    model_paragraph: Optional[str] = None
    model_answer: Optional[str] = None
    created_at: str


class EssayHistoryResponse(BaseModel):
    """Envelope for GET /homework/essay-history."""

    history: List[EssayHistoryItem]


def _coerce_jsonb_string_list(value) -> List[str]:
    """
    Normalise a jsonb column from Supabase into a list of strings.

    PostgREST may return a Python list already, or null when empty.
    """

    if not value:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if item is not None]
    return []


@router.get(
    "/essay-history",
    response_model=EssayHistoryResponse,
    summary="Get the caller's recent essay check history",
)
def essay_history(
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Return the last 20 essay checks for the signed-in user.

    Flow:
      1. Verify bearer token (user_id from JWT).
      2. SELECT from essay_checks ordered by created_at DESC.
      3. Map each row into EssayHistoryItem for the frontend.
    """

    try:
        list_result = (
            supabase.table(ESSAY_CHECKS_TABLE)
            .select(
                "id, subject, question, original_answer, marks_available, "
                "grade_band, band_label, estimated_marks, what_did_well, "
                "what_is_missing, examiner_feedback, model_paragraph, "
                "model_answer, created_at"
            )
            .eq("user_id", verified_user_id)
            .order("created_at", desc=True)
            .limit(ESSAY_HISTORY_LIMIT)
            .execute()
        )
        rows = getattr(list_result, "data", None) or []
    except Exception as e:
        print(f"[Homework] essay history list failed: {type(e).__name__}: {e}")
        rows = []

    history: List[EssayHistoryItem] = []
    for row in rows:
        created = row.get("created_at")
        history.append(
            EssayHistoryItem(
                id=str(row.get("id") or ""),
                subject=str(row.get("subject") or ""),
                question=str(row.get("question") or ""),
                original_answer=str(row.get("original_answer") or ""),
                marks_available=int(row.get("marks_available") or 0),
                grade_band=row.get("grade_band"),
                band_label=row.get("band_label"),
                estimated_marks=row.get("estimated_marks"),
                what_did_well=_coerce_jsonb_string_list(row.get("what_did_well")),
                what_is_missing=_coerce_jsonb_string_list(
                    row.get("what_is_missing")
                ),
                examiner_feedback=row.get("examiner_feedback"),
                model_paragraph=row.get("model_paragraph"),
                model_answer=row.get("model_answer"),
                created_at=str(created) if created is not None else "",
            )
        )

    return EssayHistoryResponse(history=history)
