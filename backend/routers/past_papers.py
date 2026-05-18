# ============================================================
# ASCENDAI BACKEND — routers/past_papers.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# Every HTTP request that has to do with the Past Paper Solver
# feature. Three endpoints live here:
#
#   POST /past-papers/solve
#     • Downloads the uploaded PDF via the service-role
#       Supabase Storage API (private buckets) with httpx
#       fallback on the public URL when needed.
#     • Extracts every page's text with PyMuPDF (`fitz`).
#     • Sends the text to Groq with a strict "return JSON only"
#       prompt that asks for the full Cambridge solution.
#     • Saves `questions_json` + `high_frequency_topics` back
#       onto the matching `past_papers` row.
#     • Returns the solution to the frontend IMMEDIATELY.
#     • In the background, calls Groq AGAIN once per high-
#       frequency topic that the student doesn't already have
#       a note for — generating fresh `notes` rows for revision.
#
#   GET /past-papers/list
#     • Returns every paper the caller owns (optionally
#       filtered by subject_id) with a flat subject_name + code.
#     • `has_solution` boolean lets the frontend show a "Solved"
#       chip in the library grid without having to fetch the
#       full questions_json upfront.
#
#   GET /past-papers/{paper_id}/solution
#     • Returns the saved questions_json + high_frequency_topics
#       for a single paper. Used by VIEW 4 when the user re-
#       opens a previously-solved paper.
#
# WHAT TABLES WE READ AND WRITE
# ------------------------------------------------------------
# READ:
#   • `past_papers` — every column on the row we're solving.
#   • `subjects`    — name + code for the Groq prompt + response.
#   • `notes`       — existence check before generating a new
#                     note in the background.
#
# WRITE:
#   • `past_papers`.questions_json + .high_frequency_topics
#                   (UPDATE on solve).
#   • `notes`       (INSERT one row per generated background
#                    note).
#
# ⚠ LIVE-SCHEMA NOTES — re-confirmed by probe on 2026-05-14
# ------------------------------------------------------------
# `past_papers` actually has:
#   id, user_id, subject_id, file_url, paper_year,
#   paper_variant, questions_json (JSONB),
#   high_frequency_topics (JSONB), uploaded_at, created_at.
# There is NO `mode` column — the earlier probe was misled by
# Postgres's built-in aggregate `mode()` returning an
# "ordered-set aggregate required" error rather than the usual
# "column does not exist", which had been misread as success.
# The solve-mode value (Full Paper vs Selected Questions) is
# UX-only and never flows back to this router.
# There is also NO `updated_at` column — DO NOT write to it
# (the spec's optional `updated_at` field is gracefully skipped).
#
# `notes` actually has:
#   id, user_id, subject_id, google_post_id (nullable),
#   title, summary, key_points (text[]),
#   created_at, updated_at.
# So background-generated notes write the spec's exact columns;
# `updated_at` IS present on `notes` (unlike `past_papers`).
#
# WHAT EXTERNAL SERVICES WE USE
# ------------------------------------------------------------
#   • Supabase Storage  — to download the uploaded PDF.
#   • Supabase Auth     — to verify the caller's JWT.
#   • Supabase Postgres — to read/update past_papers, read
#                         subjects, read/insert notes.
#   • Groq              — LLaMA chat completions for the
#                         solution + background notes.
#   • PyMuPDF (`fitz`)  — to extract text from the PDF bytes.
#
# PROJECT RULES THIS FILE OBEYS
# ------------------------------------------------------------
#   • No hardcoded keys, URLs, colours, or messages that
#     belong in .env.
#   • Service-role Supabase client only (never the anon key).
#   • Internal errors are logged server-side and translated
#     into a generic, friendly response body — never leaked.
#   • The response to /solve is returned BEFORE background
#     note generation starts, so the user is never blocked
#     waiting on the second batch of Groq calls.
#   • A failure inside background note generation NEVER
#     propagates — it's logged and the loop continues.
#   • No new packages — only libraries already pinned in
#     requirements.txt (PyMuPDF was added as part of this
#     feature).
# ============================================================

# ── Standard library imports ─────────────────────────────────
# `asyncio` — schedules the background note-generation task so
#             the HTTP response returns BEFORE generation runs.
# `os` — read optional env overrides (e.g. storage bucket name).
# `json` / `re` — robust Groq JSON parsing (same three-attempt
#             pattern routers/timetable.py uses).
# `datetime` / `timezone` — for the ISO `created_at` stamps we
#             write into the notes table.
# `Any` / `Dict` / `List` / `Optional` / `Tuple` — Pydantic
#             field typing + helper return-type signatures.
import asyncio
import os
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# ── Third-party imports ──────────────────────────────────────
# `fitz` is the import name for PyMuPDF. We open a PDF from
# raw bytes with `fitz.open(stream=..., filetype="pdf")` and
# iterate pages to pull plain text via `page.get_text()`.
import fitz  # PyMuPDF — pure-Python PDF text extraction.

# `httpx` is the async HTTP client. Used only as a FALLBACK
# when the Storage object path cannot be resolved — primary
# download uses the service-role Supabase client so private
# buckets work (anonymous GET on getPublicUrl returns 403).
import httpx

# ── FastAPI imports ──────────────────────────────────────────
# APIRouter — the mini-FastAPI we mount in main.py via
# include_router(...). Depends + Header power the bearer-token
# verification dependency. HTTPException returns a clean JSON
# error body with the right status code. Path + Query add
# validation/documentation to URL parameters.
from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query

# ── Pydantic imports ─────────────────────────────────────────
# BaseModel + Field describe and validate every request and
# response shape this router exposes; description=... text
# shows up in /docs.
from pydantic import BaseModel, Field

# ── Supabase service-role client ─────────────────────────────
# Same shared instance every other router uses. We need
# service-role because:
#   1. supabase.auth.get_user(jwt) verifies any user's token.
#   2. We bypass RLS on the past_papers UPDATE + the notes
#      INSERT (auth is already proven by the verified user_id
#      we get back from the bearer-token dependency).
from database import supabase
from routers.notifications import create_notification


# ============================================================
# CONFIGURATION CONSTANTS — single source of truth.
# ============================================================
# Loaded ONCE at module import so request handlers stay fast.
# Any value that might change in the future (model name, token
# limits, table names, prompt thresholds) lives in this block.
# ============================================================

# Table names — declared once so a future rename is a single
# search-and-replace inside this file.
PAST_PAPERS_TABLE = "past_papers"
SUBJECTS_TABLE = "subjects"
NOTES_TABLE = "notes"

# Groq model — hardcoded literal to match the other routers,
# so a stale `.env` value can't silently switch us to a
# decommissioned model. Keep in sync with the other routers.
GROQ_MODEL = "llama-3.3-70b-versatile"

# Max output tokens for the MAIN solution call. Cambridge
# papers can have 8–12 questions with full mark schemes; 8000
# sits inside Groq's 8192 ceiling for llama-3.3-70b and
# comfortably fits the JSON envelope the prompt requires.
GROQ_SOLVE_MAX_TOKENS = 8000

# Max output tokens for the BACKGROUND note generator. Each
# note is short (one summary + 3-5 bullets) so a much smaller
# budget keeps the per-note call snappy.
GROQ_NOTE_MAX_TOKENS = 1500

# Temperature for both Groq calls. Low values keep Cambridge-
# style answers consistent and on-spec. 0.3 is the same value
# the other routers use for structured-output prompts.
GROQ_TEMPERATURE = 0.3

# We trim the extracted PDF text to the FIRST N words so a
# huge paper never blows past Groq's input token budget. The
# spec asks for 6000 words; that comfortably fits inside the
# 128k context window AND leaves room for the system prompt.
MAX_PROMPT_WORDS = 6000

# HTTPX timeout (seconds) for the Supabase Storage download.
# Default httpx timeout is 5s which is too tight on Render's
# free tier — bumped to 30s.
PDF_DOWNLOAD_TIMEOUT_SEC = 30.0


def _past_papers_storage_bucket() -> str:
    """Resolve the Storage bucket name from env (no hardcoded project names)."""
    raw = os.getenv("ASCENDAI_PAST_PAPERS_BUCKET", "past_papers")
    return raw.strip() or "past_papers"


def _parse_bucket_and_path_from_storage_url(file_url: str) -> Optional[Tuple[str, str]]:
    """
    Extract (bucket, object_path) from a Supabase Storage URL.

    getPublicUrl and createSignedUrl both embed the bucket and
    object key after a stable path prefix. The backend needs
    this pair to call storage.from_(bucket).download(path) with
    the service role — that succeeds even when the bucket is not
    public, whereas a bare httpx GET returns 403.
    """
    if not file_url or not isinstance(file_url, str):
        return None
    for marker in (
        "/storage/v1/object/public/",
        "/storage/v1/object/sign/",
    ):
        if marker not in file_url:
            continue
        tail = file_url.split(marker, 1)[1].split("?", 1)[0].strip()
        slash = tail.find("/")
        if slash <= 0:
            return None
        bucket, obj_path = tail[:slash], tail[slash + 1 :]
        if bucket and obj_path:
            return bucket, obj_path
    return None


async def _download_pdf_bytes(
    file_url: str,
    storage_path: Optional[str],
) -> bytes:
    """
    Load PDF bytes: prefer Storage API + service role, then httpx.

    Order:
      1. If `storage_path` is set, pair it with the bucket from
         `file_url` when parseable, else ASCENDAI_PAST_PAPERS_BUCKET.
      2. Else parse bucket + path entirely from `file_url`.
      3. If (1) or (2) yields a pair, download in a thread pool
         (sync Supabase client) and return bytes on success.
      4. Fall back to httpx GET `file_url` for non-Supabase URLs
         or if Storage download fails / returns empty bytes.
    """
    bucket_and_path: Optional[Tuple[str, str]] = None
    parsed = _parse_bucket_and_path_from_storage_url(file_url)
    trimmed_path = (storage_path or "").strip()
    if trimmed_path:
        if parsed:
            bucket_and_path = (parsed[0], trimmed_path)
        else:
            bucket_and_path = (_past_papers_storage_bucket(), trimmed_path)
    else:
        bucket_and_path = parsed

    if bucket_and_path:
        bucket, obj_path = bucket_and_path
        try:

            def _sync_storage_download() -> bytes:
                return supabase.storage.from_(bucket).download(obj_path)

            pdf_bytes = await asyncio.to_thread(_sync_storage_download)
            if pdf_bytes and len(pdf_bytes) > 0:
                return pdf_bytes
        except Exception as e:
            print(
                f"[PastPapers] Storage API download failed "
                f"bucket={bucket} path_prefix={obj_path[:64]}: "
                f"{type(e).__name__}: {e}"
            )

    async with httpx.AsyncClient(
        timeout=PDF_DOWNLOAD_TIMEOUT_SEC,
        follow_redirects=True,
    ) as client:
        download_res = await client.get(file_url)
    if download_res.status_code != 200:
        print(
            f"[PastPapers] PDF download non-200 status="
            f"{download_res.status_code} url={file_url}"
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "Could not download PDF. Please try again."},
        )
    return download_res.content


# ============================================================
# REQUEST / RESPONSE PYDANTIC MODELS
# ============================================================
# FastAPI uses these to:
#   1. Validate the JSON body the frontend sends. Anything
#      missing or out-of-range gets an automatic 422 with a
#      helpful body.
#   2. Auto-generate the schema docs at /docs.
#   3. Coerce return values into JSON.
# ============================================================

class PastPaperSolveRequest(BaseModel):
    """JSON body the frontend POSTs to /past-papers/solve."""

    # UUID of the row we INSERTed into past_papers a moment ago
    # (the frontend creates the row first, then asks the
    # backend to solve it). The UPDATE writes back onto this id.
    paper_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the past_papers row we're solving.",
    )

    # UUID of the signed-in student. Must equal the user_id
    # decoded from the bearer token; otherwise we return 401.
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match the token).",
    )

    # Public URL of the uploaded PDF inside Supabase Storage.
    # The iframe still uses this URL; the backend does NOT rely
    # on anonymous HTTP GET being allowed — see _download_pdf_bytes
    # which pulls bytes via the service-role Storage API whenever
    # the URL matches Supabase's object URL shape (private buckets
    # return 403 to httpx; the Storage API succeeds).
    file_url: str = Field(
        ...,
        min_length=1,
        description="Supabase Storage URL of the uploaded PDF.",
    )

    # Object key inside the bucket, e.g. "<user_uuid>/<ts>_file.pdf".
    # When set, download uses this path (plus bucket from file_url
    # or ASCENDAI_PAST_PAPERS_BUCKET). Lets the backend fetch the
    # exact object even if the public URL is not directly fetchable.
    storage_path: Optional[str] = Field(
        default=None,
        description="Storage object path for service-role download.",
    )

    # UUID of the subject the paper belongs to. We use it to
    # look up the friendly subject name + Cambridge syllabus
    # code so the prompt knows which mark scheme to follow.
    subject_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the subject (FK to subjects.id).",
    )

    # Year the paper was sat, e.g. "2023". Plain string so we
    # don't have to think about int → str coercion in the
    # response or the prompt.
    paper_year: str = Field(
        ...,
        min_length=4,
        max_length=4,
        description="Year of the paper (e.g. 2023).",
    )

    # Cambridge runs two sessions a year ("May/June" or
    # "October/November"). Either string works — Groq only
    # uses it in the prompt header.
    paper_variant: str = Field(
        ...,
        min_length=1,
        max_length=50,
        description="Session of the paper (e.g. 'May/June').",
    )


class PastPaperSolveResponse(BaseModel):
    """JSON body returned by /past-papers/solve on success."""

    # True whenever the row was successfully updated with a
    # parsed solution. Sticks with `True` for the success path
    # because we 503 on any earlier failure.
    solved: bool

    # Echo the paper_id back so the frontend can store the
    # response keyed by paper without doing extra parsing.
    paper_id: str

    # How many questions Groq's solution contains. Lets the
    # client decide whether to render an "Empty solution"
    # fallback when the model couldn't identify a question.
    questions_count: int

    # The full solution payload: { questions: [...],
    # paper_summary: {...} }. Stored verbatim in
    # past_papers.questions_json so a future re-render is just
    # a SELECT instead of another Groq call.
    solution: Dict[str, Any]

    # Distinct topics Groq identified across the paper, sorted
    # by frequency descending. Used (a) by the background
    # note generator below, (b) by the frontend if it ever
    # wants to render a "Topics in this paper" chip row.
    high_frequency_topics: List[Dict[str, Any]]

    # True if the background note generation was scheduled
    # (i.e. there's at least one topic to potentially create
    # a note for). The frontend shows a subtle banner while
    # this is true.
    notes_generating: bool

    # Friendly message the frontend can surface in a toast
    # banner. Centralised here so the wording stays consistent.
    message: str


class PastPaperListItem(BaseModel):
    """One row in the GET /past-papers/list response."""

    # Every field the spec's list response asks for. Fields
    # that don't exist on the row (e.g. subject_name on a paper
    # whose subject_id has been deleted) come back as None so
    # the frontend never has to guard for it.
    id: str
    subject_id: Optional[str] = None
    subject_name: Optional[str] = None
    subject_code: Optional[str] = None
    paper_year: Optional[str] = None
    paper_variant: Optional[str] = None
    file_url: Optional[str] = None
    has_solution: bool
    high_frequency_topics: Optional[List[Dict[str, Any]]] = None
    uploaded_at: Optional[str] = None
    created_at: Optional[str] = None


class PastPaperListResponse(BaseModel):
    """JSON envelope returned by GET /past-papers/list."""

    data: List[PastPaperListItem]
    total: int


class PastPaperSolutionResponse(BaseModel):
    """JSON body returned by GET /past-papers/{paper_id}/solution."""

    paper_id: str
    subject_name: Optional[str] = None
    paper_year: Optional[str] = None
    paper_variant: Optional[str] = None
    solution: Optional[Dict[str, Any]] = None
    high_frequency_topics: Optional[List[Dict[str, Any]]] = None
    has_solution: bool


# ============================================================
# AUTH DEPENDENCY: verify_bearer_token
# ============================================================
# Identical contract to every other router. Five steps:
#   1. Reads the Authorization header.
#   2. Confirms the scheme is "Bearer ".
#   3. Extracts the raw JWT.
#   4. Calls supabase.auth.get_user(jwt) to verify + decode.
#   5. Returns the verified user_id (UUID as a string).
#
# Every failure mode returns the SAME generic 401 body
# so probing can't distinguish "expired" from "malformed".
# ============================================================
def verify_bearer_token(
    # `Header(...)` pulls the value from the named HTTP header.
    # alias="Authorization" lets us keep the canonical title
    # case spelling in OpenAPI docs.
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:

    # --- STEP 1: the header has to exist. ------------------
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 2: the scheme has to be "Bearer". ------------
    parts = authorization.split(maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 3: pull the actual JWT out. ------------------
    token = parts[1].strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 4: ask Supabase to verify the JWT. -----------
    # We catch broadly because the supabase-py client can
    # raise several exception types for invalid / expired
    # tokens — we don't care WHY it failed, only that it did.
    try:
        response = supabase.auth.get_user(token)
    except Exception as e:
        print(f"[PastPapers] Bearer token verify raised: {type(e).__name__}")
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

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

    # Always return str so handlers never have to think about
    # the difference between a UUID object and a string.
    return str(user_id)


# ============================================================
# THE ROUTER
# ============================================================
# main.py mounts this at prefix "/past-papers" via:
#   app.include_router(past_papers.router,
#                      prefix="/past-papers",
#                      tags=["Past Papers"])
# So the final paths become /past-papers/solve, /past-papers/list,
# and /past-papers/{paper_id}/solution.
# ============================================================
router = APIRouter()


# ============================================================
# HELPER: _resolve_subject_meta
# ============================================================
# Given a subject_id, returns (name, code, error_or_None).
# Centralised so the solve + list endpoints share the same
# lookup. Returns name=None code=None when the subject row
# can't be found (Groq is still given the friendly fallback
# "the relevant Cambridge subject" so the prompt never breaks).
# ============================================================
def _resolve_subject_meta(subject_id: str) -> Tuple[Optional[str], Optional[str]]:
    if not subject_id:
        return (None, None)
    try:
        result = (
            supabase
            .table(SUBJECTS_TABLE)
            .select("name, code")
            .eq("id", subject_id)
            .limit(1)
            .execute()
        )
        rows = getattr(result, "data", None) or []
        if not rows:
            return (None, None)
        row = rows[0]
        return (row.get("name"), str(row.get("code") or ""))
    except Exception as e:
        # Logged + swallowed — the caller can fall back to the
        # generic phrasing in the prompt.
        print(
            f"[PastPapers] subject lookup failed for id={subject_id}: "
            f"{type(e).__name__}: {e}"
        )
        return (None, None)


# ============================================================
# HELPER: _parse_groq_json
# ============================================================
# Convert Groq's raw text reply into a Python dict. The prompt
# asks for a bare JSON object, but real LLM output sometimes
# includes markdown fences, a one-line preamble, or trailing
# commentary. We try three strategies in order — same robust
# pattern routers/timetable.py uses for its array response.
#
# Returns (parsed_or_None, error_message_or_None).
# `parsed=None` → caller surfaces a 503; an empty dict here
# means the model returned `{}` which is still "ok-shaped"
# but useless for our purposes.
# ============================================================
def _parse_groq_json(raw: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not raw:
        return (None, "Empty response from Groq.")

    text = raw.strip()

    # ── ATTEMPT 1: parse the raw text verbatim. ────────────
    # The system prompt demands "no markdown, no preamble" so
    # the happy path is a single json.loads call.
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return (parsed, None)
    except json.JSONDecodeError:
        pass

    # ── ATTEMPT 2: strip markdown fences and retry. ────────
    # Some Groq prompts return ```json\n{...}\n``` despite the
    # explicit "no fences" rule. Cleanly stripping the opening
    # / closing fences usually fixes the parse.
    fenced = text
    if fenced.startswith("```"):
        # Drop the first line entirely (handles ```json, ```JSON,
        # ``` etc. uniformly) and trim a trailing fence.
        fenced = fenced.split("\n", 1)[1] if "\n" in fenced else fenced[3:]
    if fenced.endswith("```"):
        fenced = fenced[: -3]
    fenced = fenced.strip()
    if fenced and fenced is not text:
        try:
            parsed = json.loads(fenced)
            if isinstance(parsed, dict):
                return (parsed, None)
        except json.JSONDecodeError:
            pass

    # ── ATTEMPT 3: regex out the first {...} block. ────────
    # `re.DOTALL` makes `.` match newlines so a multi-line JSON
    # object inside a longer string still gets picked up.
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return (parsed, None)
        except json.JSONDecodeError:
            pass

    # All three strategies failed — caller turns this into a 503.
    return (None, "Could not parse Groq response as JSON.")


# ============================================================
# HELPER: _now_iso
# ============================================================
# UTC ISO-8601 timestamp string Postgres accepts for `timestamptz`
# columns. Kept tiny + dependency-light so background loops
# don't pay an import penalty on every iteration.
# ============================================================
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ============================================================
# HELPER: _build_solve_system_prompt
# ============================================================
# The exact prompt text the spec dictates, with subject /
# year / variant placeholders filled in. Kept as a function
# (rather than a module-level f-string) so subject_name etc.
# can be passed at call time without polluting module state.
# ============================================================
def _build_solve_system_prompt(
    subject_name: str,
    subject_code: str,
    paper_year: str,
    paper_variant: str,
) -> str:
    # Friendly fallback when the subject lookup couldn't find
    # the row — Groq is still given enough context to answer.
    subj_display = subject_name or "the relevant Cambridge AS Level subject"
    code_display = subject_code or "—"

    # Triple-quoted string for readability. Newlines and
    # leading whitespace inside the JSON example are
    # preserved deliberately — Groq mirrors the structure.
    return f"""You are a Cambridge AS Level Chief Examiner writing
official model answers and mark schemes.

THE STUDENT: Aisha, Cambridge AS Level, Lusaka Zambia.

Subject: {subj_display} ({code_display})
Paper: {paper_year} {paper_variant}

MODEL ANSWER RULES:
- Write at Band 4 level — full marks quality
- Use exact Cambridge mark scheme language
- Structure: Definition → Application → Analysis →
  Evaluation (for 10+ marks)
- Chain reasoning minimum 3 links for any 4+ mark question
- Include diagram references where relevant
- Use ceteris paribus where relevant
- Include a real Zambian/African example where natural
  (maize, copper, Kwacha, informal markets, MTN Zambia,
  Shoprite, ZESCO, Bank of Zambia, University of Zambia)

MARK SCHEME BREAKDOWN RULES:
- Show exactly what each mark is awarded for
- Use Cambridge mark scheme language: "Award 1 mark for..."
- Be specific — never vague
- Show the examiner's thinking

EXAMINER INSIGHTS RULES:
- Give 2-3 specific insights about this question
- What do most students miss?
- What earns the final Band 4 marks?
- What would a Chief Examiner highlight to markers?

QUALITY STANDARD:
Every model answer must be good enough to be published
as an official Cambridge mark scheme.

Read the past paper text carefully. For every question you
can identify, write a complete Cambridge-standard model answer.

Your model answers must:
- Be written in the first person as if you are the student
  writing the answer in an exam — not as instructions
- Match the exact marks available — an 8-mark question needs
  significantly more depth than a 4-mark question
- Never use markdown symbols — no asterisks, no hashtags,
  no bullet dashes
- Write in flowing academic paragraphs

Return ONLY a valid JSON object. No introduction.
No explanation. No markdown. Just the JSON.

Format:
{{
  "questions": [
    {{
      "question_number": "1",
      "question_text": "Copy the full question text exactly as
        it appears in the paper",
      "marks_available": 8,
      "model_answer": "Write the complete model answer here as
        flowing paragraphs. This should read exactly like a
        top-band Cambridge answer script. For an 8-mark question
        write at least 3-4 substantial paragraphs. Define key
        terms precisely. Apply theory to real-world context.
        Analyse cause and effect. Evaluate where the question
        requires it. Never use bullet points or numbered lists
        within this field.",
      "mark_scheme": [
        {{
          "criteria": "Precise definition of the key concept
            with correct terminology",
          "marks": 2
        }}
      ],
      "examiner_tip": "Write one paragraph of specific advice
        for this exact question type. Mention what the highest
        band answers include that lower band answers miss.
        Reference the mark allocation specifically.",
      "common_mistakes": [
        "Mistake: Students often define the concept incorrectly
          by confusing it with a related term. This loses the
          definition mark immediately.",
        "Mistake: Many students forget to use a real-world
          example when the question asks to analyse. Always
          apply theory to context."
      ]
    }}
  ],
  "paper_summary": {{
    "total_marks": 40,
    "key_topics": ["Topic 1", "Topic 2", "Topic 3", "Topic 4"],
    "difficulty": "Medium",
    "revision_areas": ["Specific area 1", "Specific area 2"]
  }},
  "high_frequency_topics": [
    {{
      "topic": "Price Elasticity of Demand",
      "frequency": 3,
      "subject_relevance": "Core Cambridge 9708 topic tested
        in almost every paper"
    }}
  ]
}}

Critical rules:
- model_answer must be written as the actual answer — not
  as instructions for how to answer
- Never say "you should" or "students should" in model_answer
- Never use bullet points or lists inside model_answer
- question_text must be the actual question copied from the paper
- Every question must have a model_answer — never leave it empty
- Return [] for arrays you cannot populate — never null

WRITING STYLE RULES:
Sound like a real person wrote this:
- Vary sentence length — mix short punchy sentences
  with longer explanatory ones
- Use natural transitions: "Here's the thing...",
  "Think of it this way...", "The key point is...",
  "What Cambridge really wants to see is..."
- Occasional light emphasis words: "actually", "really",
  "in fact", "the truth is"
- Never start two consecutive sentences the same way
- Never use lists unless absolutely necessary
- Flow like spoken explanation, not bullet points

AVOID THESE AI GIVEAWAYS — never use:
- "Certainly!" — never use
- "Of course!" — never use
- "Great question!" — never use
- "It is important to note that" — never use
- "In conclusion" — never use
- "Furthermore" — never use
- "Moreover" — never use
- "It is worth noting" — never use
- "As mentioned above" — never use
- "In summary" — never use
- Numbered lists for explanations — never use
- Bullet points in flowing text — never use
- Starting every paragraph with the topic word
- Repeating the question back before answering
- Overly formal academic language when simpler works

WHAT TO USE INSTEAD:
- "Here's what this means in practice..."
- "The way to think about this is..."
- "What actually happens is..."
- "Cambridge examiners look for exactly this..."
- "The reason this matters is..."
- "Most students miss this, but..."
- "Think about it from the examiner's perspective..."

HUMANISATION RULES:
Model answers should read like a top student wrote them
in an exam — natural, confident, well-structured.
Not like an AI generating text.
The flow should feel like thinking on paper —
one idea leading naturally to the next.
Mark scheme breakdowns should feel like an examiner
explaining their thinking — "I gave this mark because..."
Examiner insights should feel like genuine insider
knowledge — the kind of thing only someone who has
marked hundreds of scripts would know.
Never sound robotic. Never sound generated.
If the answer sounds like it came from an AI — rewrite it.
"""


# ============================================================
# ENDPOINT: POST /past-papers/solve
# ============================================================
# END-TO-END FLOW (what happens between request and response):
#   1. Validate body shape + bearer token (auto via Pydantic +
#      verify_bearer_token).
#   2. Identity check: body.user_id == verified token user_id.
#   3. Download the PDF: service-role Supabase Storage API first
#      (private buckets), then httpx GET on file_url as fallback.
#      Failure after both → 503.
#   4. Extract every page's text with PyMuPDF (fitz).
#      Empty extraction → 422 (scanned image / locked PDF).
#   5. Trim to MAX_PROMPT_WORDS so we never exceed Groq's
#      input budget.
#   6. Resolve subject name + code for the prompt header.
#   7. Build the prompt + call Groq with JSON-only instructions.
#   8. Parse Groq's reply with the three-attempt strategy.
#      All three failing → 503.
#   9. UPDATE past_papers WHERE id = paper_id AND user_id =
#      verified_user_id SET questions_json + high_frequency_topics.
#  10. Schedule the background note generation with
#      asyncio.create_task() — this does NOT block the response.
#  11. Return the response IMMEDIATELY.
# ============================================================
@router.post(
    "/solve",
    response_model=PastPaperSolveResponse,
    summary="Solve a Cambridge AS Level past paper PDF with AI.",
)
async def solve_paper(
    body: PastPaperSolveRequest,
    # Dependency runs BEFORE the route body — any 401 short-
    # circuits the route without touching Groq or Storage.
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: identity check. ──────────────────────────────
    # The token says caller is user X; the body says we should
    # solve for user Y. Require X == Y so a logged-in user
    # can't write to someone else's paper row.
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # ── STEP 2: download the PDF from Supabase Storage. ─────
    # Primary path: service-role Storage API (works when the
    # bucket is private — anonymous GET on getPublicUrl returns
    # 403). Fallback: httpx GET on file_url for odd URL shapes.
    try:
        pdf_bytes = await _download_pdf_bytes(
            body.file_url,
            body.storage_path,
        )
    except HTTPException:
        raise
    except Exception as e:
        print(
            f"[PastPapers] PDF download threw: {type(e).__name__}: {e}"
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "Could not download PDF. Please try again."},
        )

    # ── STEP 3: extract text with PyMuPDF. ──────────────────
    try:
        # Open the PDF from raw bytes (no temp file on disk).
        pdf_document = fitz.open(stream=pdf_bytes, filetype="pdf")
        # Accumulator for the entire paper's text.
        full_text = ""
        # Iterate every page in document order.
        for page_num in range(len(pdf_document)):
            page = pdf_document[page_num]
            # `get_text()` returns the page's plain text with
            # newlines preserved between paragraphs.
            full_text += page.get_text()
        # Always close to release the file handle / memory.
        pdf_document.close()
    except Exception as e:
        print(
            f"[PastPapers] PyMuPDF extract failed: {type(e).__name__}: {e}"
        )
        raise HTTPException(
            status_code=422,
            detail={
                "error": (
                    "Could not extract text from PDF. Please ensure the "
                    "PDF contains selectable text."
                )
            },
        )

    # ── STEP 3b: refuse empty extractions early. ────────────
    # Scanned (image-only) PDFs come back as empty strings or
    # nothing but whitespace. We surface a 422 so the user
    # knows to re-upload a text-based PDF rather than getting
    # a confusing 503 a few seconds later from Groq.
    if not full_text or not full_text.strip():
        raise HTTPException(
            status_code=422,
            detail={
                "error": (
                    "Could not extract text from PDF. Please ensure the "
                    "PDF contains selectable text."
                )
            },
        )

    # ── STEP 4: trim to MAX_PROMPT_WORDS. ───────────────────
    # Long Cambridge papers can exceed Groq's input window
    # if we don't trim — and tail-end pages are usually
    # blank answer space rather than new questions.
    words = full_text.split()
    if len(words) > MAX_PROMPT_WORDS:
        full_text = " ".join(words[:MAX_PROMPT_WORDS])

    # ── STEP 5: subject lookup for the prompt header. ───────
    subject_name, subject_code = _resolve_subject_meta(body.subject_id)

    # ── STEP 6: build the system prompt. ────────────────────
    system_prompt = _build_solve_system_prompt(
        subject_name=subject_name or "",
        subject_code=subject_code or "",
        paper_year=body.paper_year,
        paper_variant=body.paper_variant,
    )

    # ── STEP 7: call Groq. ──────────────────────────────────
    # Lazy-import the Groq client to avoid the circular import
    # we'd otherwise hit (routers/past_papers.py is imported
    # by main.py, which is where groq_client lives).
    try:
        from main import groq_client  # noqa: WPS433
    except Exception as e:
        print(f"[PastPapers] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    # The "user" half of the conversation is just the
    # extracted paper text — every formatting rule lives in
    # the system prompt.
    user_prompt = (
        "Paper text begins below. Solve every question you can identify.\n\n"
        f"{full_text}"
    )

    try:
        completion = groq_client.chat.completions.create(
            # MODEL — locked literal so a stale .env can't swap
            # us to a decommissioned model.
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            # MAX TOKENS — generous so the full solution JSON
            # plus the high_frequency_topics list never
            # truncates mid-question.
            max_tokens=GROQ_SOLVE_MAX_TOKENS,
            # TEMPERATURE — low for deterministic structured
            # output. Cambridge answers should be repeatable.
            temperature=GROQ_TEMPERATURE,
        )
    except Exception as e:
        print(f"[PastPapers] Groq solve call failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate solution. Please try again."},
        )

    # ── STEP 8: pull the raw text + parse. ──────────────────
    try:
        raw_answer = completion.choices[0].message.content or ""
    except (AttributeError, IndexError) as e:
        print(f"[PastPapers] Groq response shape unexpected: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate solution. Please try again."},
        )

    parsed, parse_err = _parse_groq_json(raw_answer)
    if parsed is None:
        # Log the first 200 chars of the raw response — never
        # the whole thing (it can be huge) and never visible
        # to the caller.
        print(
            f"[PastPapers] {parse_err} "
            f"First 200 chars: {raw_answer[:200]!r}"
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate solution. Please try again."},
        )

    # ── STEP 8b: normalise the parsed JSON. ────────────────
    # Groq sometimes omits keys (rules said "return [] not null"
    # but the model isn't perfect). Defensive defaults here so
    # the response body always has the right shape regardless.
    questions = parsed.get("questions") if isinstance(parsed.get("questions"), list) else []
    paper_summary = parsed.get("paper_summary") if isinstance(parsed.get("paper_summary"), dict) else {}
    hf_topics = (
        parsed.get("high_frequency_topics")
        if isinstance(parsed.get("high_frequency_topics"), list)
        else []
    )

    # ── STEP 9: persist the solution to Supabase. ──────────
    # We UPDATE the row the frontend pre-inserted. Restricting
    # the UPDATE to (id, user_id) is a second line of defence
    # against cross-user writes.
    # IMPORTANT: `past_papers` has NO `updated_at` column on the
    # live schema — we intentionally do NOT include it in the
    # payload (the spec said "skip if not"). Adding it would
    # cause the UPDATE to fail with a 400.
    update_payload: Dict[str, Any] = {
        # questions_json — the complete solution envelope so a
        # future "re-open" doesn't re-call Groq.
        "questions_json": {
            "questions": questions,
            "paper_summary": paper_summary,
        },
        # high_frequency_topics — Groq's distinct topic list,
        # sorted high → low. Background note generation reads
        # from this same payload.
        "high_frequency_topics": hf_topics,
    }

    try:
        update_result = (
            supabase
            .table(PAST_PAPERS_TABLE)
            .update(update_payload)
            # Restrict to the caller's own paper row.
            .eq("id", body.paper_id)
            .eq("user_id", verified_user_id)
            .execute()
        )
        affected = getattr(update_result, "data", None) or []
        if not affected:
            # Row didn't exist OR didn't belong to this user.
            # Log + surface a generic message — we don't want
            # to confirm/deny which one to a client.
            print(
                "[PastPapers] solve UPDATE matched 0 rows for "
                f"paper_id={body.paper_id} user_id={verified_user_id}"
            )
            raise HTTPException(
                status_code=404,
                detail={"error": "Paper not found."},
            )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[PastPapers] solve UPDATE failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not save the solution. Please try again."},
        )

    # ── STEP 10: schedule background note generation. ──────
    # asyncio.create_task() schedules `generate_topic_notes`
    # to run on the event loop AFTER this handler returns its
    # response. The client gets the solution immediately; the
    # note generation happens in the background and writes to
    # `notes` over the next ~30 seconds.
    #
    # We only schedule it when there's at least one topic to
    # work through — otherwise the task fires once and exits
    # which is pointless overhead.
    notes_generating = False
    if hf_topics:
        # Capture every value the background task needs so it
        # never has to touch `body` (which goes out of scope
        # as soon as we return).
        asyncio.create_task(
            generate_topic_notes(
                user_id=verified_user_id,
                subject_id=body.subject_id,
                subject_name=subject_name,
                subject_code=subject_code,
                topics=hf_topics,
            )
        )
        notes_generating = True

    # ── STEP 11: notify student that the paper is solved. ────
    subject_label = subject_name or "Your"
    create_notification(
        user_id=verified_user_id,
        type="paper",
        title="Past Paper Solved",
        message=(
            f"{subject_label} past paper solution is ready. "
            "View your detailed model answers."
        ),
    )

    # ── STEP 12: respond IMMEDIATELY. ──────────────────────
    # The background task above continues running on its own;
    # this `return` completes the HTTP response right now.
    return PastPaperSolveResponse(
        solved=True,
        paper_id=body.paper_id,
        questions_count=len(questions),
        solution={
            "questions": questions,
            "paper_summary": paper_summary,
        },
        high_frequency_topics=hf_topics,
        notes_generating=notes_generating,
        message=(
            "Paper solved successfully. Study notes are being "
            "generated in the background."
        ),
    )


# ============================================================
# BACKGROUND TASK: generate_topic_notes
# ============================================================
# Runs AFTER /past-papers/solve has already returned its
# response. For each high-frequency topic the paper covered:
#   A. Check `notes` for an existing row (case-insensitive
#      title ILIKE match) so we don't generate duplicates.
#   B. If no existing note → call Groq for a Cambridge AS
#      Level study note in strict JSON shape.
#   C. INSERT the parsed note into the `notes` table.
#
# WHY asyncio.create_task INSTEAD OF JUST AWAITING?
# ------------------------------------------------------------
# `await` here would block /solve's HTTP response from
# returning until every Groq call finished — potentially
# 30+ seconds. The user expects the solution to appear in
# seconds, not after a long bar of "Generating notes…".
# Scheduling with create_task() releases the request handler
# the moment it returns and lets the loop run this in
# parallel with the next incoming request.
#
# EVERY FAILURE PATH IS SWALLOWED.
# ------------------------------------------------------------
# A blown Groq call, a parse failure, an RLS rejection — none
# of them should crash the worker. We log + continue to the
# next topic. The user is never told a background note
# generation went wrong (the frontend's "notes_generating"
# banner just disappears on its 30s timer regardless).
# ============================================================
async def generate_topic_notes(
    user_id: str,
    subject_id: str,
    subject_name: Optional[str],
    subject_code: Optional[str],
    topics: List[Dict[str, Any]],
) -> None:

    # Defensive — nothing to do without a topic list.
    if not topics:
        return

    # Lazy-import the Groq client so a circular import is
    # impossible even when this function is invoked from a
    # task scheduler outside the route flow.
    try:
        from main import groq_client  # noqa: WPS433
    except Exception as e:
        print(
            f"[PastPapers] background: groq_client import failed: "
            f"{type(e).__name__}: {e}"
        )
        return

    # Friendly subject phrases for the prompt + the row.
    subj_display = subject_name or "Cambridge AS Level"
    code_display = subject_code or ""

    for topic_entry in topics:
        # ── Step A: extract the topic name. ─────────────────
        # The spec's schema uses `topic` but we accept a few
        # historical variants for safety.
        if not isinstance(topic_entry, dict):
            continue
        topic_name = (
            topic_entry.get("topic")
            or topic_entry.get("name")
            or ""
        )
        topic_name = (topic_name or "").strip()
        if not topic_name:
            continue

        # ── Step B: existence check (only generate when missing). ─
        # `ILIKE '%{topic}%'` lets us match "Price Elasticity"
        # against an existing note titled "Price Elasticity of
        # Demand" so we don't generate near-duplicates.
        try:
            check_result = (
                supabase
                .table(NOTES_TABLE)
                .select("id")
                .eq("user_id", user_id)
                .eq("subject_id", subject_id)
                # PostgREST's `ilike` filter — wraps the value
                # in %s automatically when we use the operator,
                # but we add explicit ones for the wildcard
                # boundaries so substring matches succeed.
                .ilike("title", f"%{topic_name}%")
                .limit(1)
                .execute()
            )
            existing = getattr(check_result, "data", None) or []
            if existing:
                # Only generate notes for topics not already
                # covered. Logged so we can confirm the dedupe
                # path is firing.
                print(
                    f"[PastPapers] background: note already exists "
                    f"for topic: {topic_name}"
                )
                continue
        except Exception as e:
            print(
                f"[PastPapers] background: note existence check failed "
                f"for {topic_name!r}: {type(e).__name__}: {e}"
            )
            # Fall through to generation rather than skipping
            # — worst case we end up with a duplicate the user
            # can manually delete.

        # ── Step C: build the per-topic prompt. ─────────────
        # Strict JSON-only output so the parser can pick out
        # the title / summary / key_points without ceremony.
        topic_system_prompt = (
            "Return ONLY a valid JSON object with no preamble, "
            "no markdown fences, no explanation. Plain JSON."
        )
        topic_user_prompt = (
            f"Generate a comprehensive Cambridge AS Level study note on:\n"
            f"{topic_name} for {subj_display}"
            f"{f' ({code_display})' if code_display else ''}\n\n"
            "Return as JSON only:\n"
            "{\n"
            '  "title": "topic name",\n'
            '  "summary": "comprehensive 3-4 paragraph summary in plain text",\n'
            '  "key_points": ["point 1", "point 2", "point 3", "point 4", "point 5"]\n'
            "}"
        )

        # ── Step D: call Groq for this topic. ───────────────
        try:
            completion = groq_client.chat.completions.create(
                model=GROQ_MODEL,
                messages=[
                    {"role": "system", "content": topic_system_prompt},
                    {"role": "user",   "content": topic_user_prompt},
                ],
                # Tight budget — one short note fits easily
                # in 1500 tokens.
                max_tokens=GROQ_NOTE_MAX_TOKENS,
                # Same low temperature as the solve call —
                # consistent academic tone is preferred over
                # creative variation here.
                temperature=GROQ_TEMPERATURE,
            )
            raw_note = completion.choices[0].message.content or ""
        except Exception as e:
            print(
                f"[PastPapers] background: Groq call failed for "
                f"{topic_name!r}: {type(e).__name__}: {e}"
            )
            continue

        # ── Step E: parse the note JSON. ────────────────────
        parsed_note, parse_err = _parse_groq_json(raw_note)
        if parsed_note is None:
            print(
                f"[PastPapers] background: could not parse note JSON "
                f"for {topic_name!r}: {parse_err}"
            )
            continue

        # Pull each field with a defensive default so a
        # missing key never raises on the INSERT.
        title = (parsed_note.get("title") or topic_name).strip()
        summary = (parsed_note.get("summary") or "").strip()
        key_points = parsed_note.get("key_points")
        if not isinstance(key_points, list):
            key_points = []
        # Coerce each point to str so the text[] column
        # doesn't choke on accidental int / null entries.
        key_points = [
            str(p).strip() for p in key_points if str(p or "").strip()
        ]

        # Skip notes with no real body — saving a row with an
        # empty summary is worse than skipping silently.
        if not summary:
            print(
                f"[PastPapers] background: empty summary for "
                f"{topic_name!r} — skipping insert."
            )
            continue

        # ── Step F: insert the note. ────────────────────────
        try:
            insert_payload = {
                # user_id      — owns this note.
                "user_id": user_id,
                # subject_id   — joins the note back to its
                # syllabus row.
                "subject_id": subject_id,
                # title        — generated title (or the topic
                # name if Groq forgot to echo it).
                "title": title,
                # summary      — 3-4 paragraph plain-text body.
                "summary": summary,
                # key_points   — text[] column on the live
                # schema; Postgres handles list → array.
                "key_points": key_points,
                # created_at   — explicit timestamp keeps
                # behaviour identical regardless of driver
                # default-handling.
                "created_at": _now_iso(),
            }
            insert_result = (
                supabase
                .table(NOTES_TABLE)
                .insert(insert_payload)
                .execute()
            )
            inserted = getattr(insert_result, "data", None) or []
            if inserted:
                # Logged so we can confirm the background loop
                # is producing notes in dev. NEVER raised.
                print(
                    f"[PastPapers] Generated note for topic: {topic_name}"
                )
            else:
                print(
                    f"[PastPapers] background: insert returned no rows "
                    f"for {topic_name!r}"
                )
        except Exception as e:
            print(
                f"[PastPapers] background: insert failed for "
                f"{topic_name!r}: {type(e).__name__}: {e}"
            )
            # NEVER raise — keep iterating.
            continue


# ============================================================
# ENDPOINT: GET /past-papers/list
# ============================================================
# END-TO-END FLOW:
#   1. Verify token + user identity (?user_id must match).
#   2. SELECT past_papers rows for this user (optionally
#      filtered by subject_id), JOINing subjects so each row
#      carries the friendly name + code without an extra
#      lookup on the frontend.
#   3. For each row, compute `has_solution = questions_json
#      IS NOT NULL`.
#   4. Return the envelope shape the spec dictates.
# ============================================================
@router.get(
    "/list",
    response_model=PastPaperListResponse,
    summary="List the caller's past papers (with solution flag).",
)
def list_papers(
    # Required: which user we're listing for. Identity-checked
    # against the verified token below.
    user_id: str = Query(
        ...,
        min_length=1,
        description="UUID of the authenticated user.",
    ),
    # Optional: narrow the list to a single subject.
    subject_id: Optional[str] = Query(
        default=None,
        description="Optional subject UUID to filter by.",
    ),
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: identity check. ──────────────────────────────
    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # ── STEP 2: build + run the SELECT. ─────────────────────
    # PostgREST's `subjects(name, code)` suffix asks Supabase
    # to embed the joined subject row under a "subjects" key
    # on every result. We pull `questions_json` so we can
    # derive has_solution; we DON'T return its body in this
    # endpoint (it's heavy — the /solution endpoint serves it).
    try:
        query = (
            supabase
            .table(PAST_PAPERS_TABLE)
            .select(
                "id, subject_id, paper_year, paper_variant, file_url, "
                "high_frequency_topics, questions_json, uploaded_at, "
                "created_at, subjects(name, code)"
            )
            .eq("user_id", verified_user_id)
            .order("created_at", desc=True)
        )
        if subject_id:
            query = query.eq("subject_id", subject_id)
        result = query.execute()
        rows = getattr(result, "data", None) or []
    except Exception as e:
        print(f"[PastPapers] list failed: {type(e).__name__}: {e}")
        # Return an empty list rather than 500 so the library
        # view can still render an empty state.
        rows = []

    # ── STEP 3: shape each row for the response. ───────────
    items: List[PastPaperListItem] = []
    for r in rows:
        # Pull the joined subject sub-object out and flatten
        # to (name, code). Either may be missing if the FK
        # points at a deleted row.
        joined = r.get("subjects") if isinstance(r, dict) else None
        subj_name = None
        subj_code = None
        if isinstance(joined, dict):
            subj_name = joined.get("name")
            raw_code = joined.get("code")
            subj_code = str(raw_code) if raw_code is not None else None

        # has_solution — derived from whether questions_json
        # is present + non-empty. We don't return the body
        # here; the dedicated /solution endpoint serves it.
        qjson = r.get("questions_json")
        has_solution = bool(qjson) and qjson != {} and qjson != []

        items.append(
            PastPaperListItem(
                id=str(r.get("id", "")),
                subject_id=r.get("subject_id"),
                subject_name=subj_name,
                subject_code=subj_code,
                # paper_year + paper_variant are nullable on
                # the live schema (older rows had no columns).
                paper_year=r.get("paper_year"),
                paper_variant=r.get("paper_variant"),
                file_url=r.get("file_url"),
                has_solution=has_solution,
                high_frequency_topics=r.get("high_frequency_topics")
                    if isinstance(r.get("high_frequency_topics"), list)
                    else None,
                # Coerce timestamps to str so JSON serialisation
                # never has to think about datetime objects.
                uploaded_at=str(r.get("uploaded_at") or "") or None,
                created_at=str(r.get("created_at") or "") or None,
            )
        )

    # ── STEP 4: envelope it up. ──────────────────────────────
    return PastPaperListResponse(data=items, total=len(items))


# ============================================================
# ENDPOINT: GET /past-papers/{paper_id}/solution
# ============================================================
# END-TO-END FLOW:
#   1. Verify token + user identity (?user_id must match).
#   2. SELECT the single row by (paper_id, user_id) so a
#      logged-in user can't ask for someone else's solution.
#   3. Return the full questions_json + high_frequency_topics
#      + the subject name / paper_year / paper_variant header.
# ============================================================
@router.get(
    "/{paper_id}/solution",
    response_model=PastPaperSolutionResponse,
    summary="Fetch the saved solution for a past paper.",
)
def get_solution(
    paper_id: str = Path(
        ...,
        min_length=1,
        description="UUID of the past_papers row.",
    ),
    user_id: str = Query(
        ...,
        min_length=1,
        description="UUID of the authenticated user.",
    ),
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: identity check. ──────────────────────────────
    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # ── STEP 2: pull the row. ───────────────────────────────
    try:
        result = (
            supabase
            .table(PAST_PAPERS_TABLE)
            # Same join trick the list endpoint uses — the
            # frontend wants subject_name to render in the
            # solution header.
            .select(
                "id, paper_year, paper_variant, questions_json, "
                "high_frequency_topics, subjects(name, code)"
            )
            .eq("id", paper_id)
            .eq("user_id", verified_user_id)
            .limit(1)
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception as e:
        print(f"[PastPapers] solution fetch failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not load the solution. Please try again."},
        )

    if not rows:
        # Either the paper doesn't exist or it doesn't belong
        # to this user. Surface the same 404 in both cases so
        # we don't leak existence to unauthorised callers.
        raise HTTPException(
            status_code=404,
            detail={"error": "Paper not found."},
        )

    row = rows[0]
    joined = row.get("subjects") if isinstance(row, dict) else None
    subj_name = joined.get("name") if isinstance(joined, dict) else None

    # ── STEP 3: derive has_solution from questions_json. ────
    qjson = row.get("questions_json")
    has_solution = bool(qjson) and qjson != {} and qjson != []

    return PastPaperSolutionResponse(
        paper_id=str(row.get("id", paper_id)),
        subject_name=subj_name,
        paper_year=row.get("paper_year"),
        paper_variant=row.get("paper_variant"),
        # `solution` is the JSON-body envelope written by /solve;
        # it already contains { questions, paper_summary }.
        solution=qjson if isinstance(qjson, dict) else None,
        high_frequency_topics=row.get("high_frequency_topics")
            if isinstance(row.get("high_frequency_topics"), list)
            else None,
        has_solution=has_solution,
    )
