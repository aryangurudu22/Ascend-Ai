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
from typing import Optional, Tuple

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
