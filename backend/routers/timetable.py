# ============================================================
# ASCENDAI BACKEND — routers/timetable.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# Every HTTP request to do with the Intelligent Timetable
# feature. Three endpoints live here:
#
#   POST /timetable/generate
#     • Reads the caller's profile (study hours) + every active
#       Cambridge subject (with its exam_date).
#     • Computes the urgency of each subject (critical / high /
#       medium / low) from today vs the exam_date.
#     • Sends everything to Groq with a strict "return JSON only"
#       prompt. Groq drafts a 14-day study schedule.
#     • Saves each entry as one `timetable_entries` row.
#     • Honours an optional `force_regenerate` flag — when False
#       and entries already exist for the next 2 weeks we
#       short-circuit and tell the caller to retry with
#       force_regenerate=True.
#
#   GET /timetable/entries
#     • Returns every entry inside an inclusive Mon-Sun window
#       for the calling user, ordered by date then start_time.
#     • Each row is joined back to `subjects` so the response
#       carries the subject name + code without the frontend
#       having to look them up.
#
#   PATCH /timetable/entry/{entry_id}/complete
#     • Toggles the row's `completed` flag.
#     • Verifies ownership server-side so a logged-in user
#       cannot mark someone else's session done.
#
#   POST /timetable/trigger-generate
#     • Internal n8n cron — loops all profiles and regenerates
#       each student's 2-week timetable (force_regenerate=True).
#     • No auth — uses service-role Supabase client from database.py.
#
# ⚠ LIVE-SCHEMA NOTES — the column names differ from the spec
# ------------------------------------------------------------
# `timetable_entries` actually has:
#   id, user_id, subject_id, topic, scheduled_date, start_time,
#   end_time, completed, week_start (NOT NULL), created_at,
#   updated_at.
#
# We map the spec-style field names onto these live names in
# both directions (insert payload below, response normaliser at
# read time). `notes` has NO matching DB column today — we
# accept it from Groq but DROP it on insert. The same pragmatic
# decision the frontend page already made (see
# `denormalizeForWrite` in app/features/timetable/page.js).
#
# `profiles` actually has:
#   id, user_id, full_name, email, google_classroom_connected,
#   study_start_time, study_end_time, ai_response_style,
#   created_at, updated_at.
# So the spec's `study_hours_start` / `study_hours_end` map to
# `study_start_time` / `study_end_time` on the live DB.
#
# `subjects` is SHARED across the (single) tenant — no `user_id`
# column today. We just read every `is_active = true` row.
#
# WHAT EXTERNAL SERVICES WE USE
# ------------------------------------------------------------
#   • Groq (chat completions API) — for schedule generation.
#   • Supabase Auth (admin)       — for JWT verification.
#   • Supabase Postgres           — profiles read, subjects read,
#                                   timetable_entries read/write.
#
# PROJECT RULES THIS FILE OBEYS
# ------------------------------------------------------------
#   • No hardcoded keys / URLs / colours / messages.
#   • Service-role Supabase client only (never the anon key).
#   • Errors never leak internal trace text to the caller; they
#     are logged on the server and translated to a generic
#     human-friendly response.
#   • A failed entry insert NEVER blocks the rest of the batch;
#     we log and continue so the student still gets a partial
#     schedule rather than nothing.
#   • No new packages — only stdlib + libraries already used by
#     routers/homework.py, routers/flashcards.py, routers/quiz.py.
# ============================================================

# ── Standard library imports ─────────────────────────────────
# `datetime` / `date` / `time` / `timedelta` — date arithmetic
# for the 14-day window, weekday detection, ISO formatting.
# `json` / `re` — robust Groq JSON parsing (same pattern as
# routers/flashcards.py).
# `Optional` / `List` / `Dict` / `Any` — Pydantic + helper typing.
from datetime import date, datetime, time, timedelta, timezone
import json
import re
from typing import Any, Dict, List, Optional

# ── FastAPI imports ──────────────────────────────────────────
# APIRouter — the mini-FastAPI we attach to main.py.
# Depends + Header — power the bearer-token dependency.
# HTTPException — clean JSON error bodies with status codes.
# Path + Query — typed and validated path/query parameters.
from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query

# ── Pydantic imports ─────────────────────────────────────────
# BaseModel + Field describe and validate every request /
# response shape this router exposes.
from pydantic import BaseModel, Field

# ── Supabase service-role client ─────────────────────────────
# Same instance the other routers use. Required because:
#   1. We bypass RLS to read profile + write timetable rows on
#      behalf of the verified user.
#   2. supabase.auth.get_user(jwt) (inside verify_bearer_token)
#      needs the admin client.
from database import supabase


# ============================================================
# CONFIGURATION CONSTANTS — single source of truth.
# ============================================================
# Loaded ONCE at import time so request handlers stay snappy.
# ============================================================

# Table names — declared once so a future rename is a one-line edit.
PROFILES_TABLE = "profiles"
SUBJECTS_TABLE = "subjects"
ENTRIES_TABLE = "timetable_entries"

# How many days of schedule we generate per run. "2 weeks" in the
# spec; making it a constant keeps the maths centralised.
PLAN_WINDOW_DAYS = 14

# Every study session is exactly this many minutes. Used to slice
# the daily study window into discrete sessions.
SESSION_DURATION_MIN = 90

# Minimum and maximum sessions per day. We clamp the
# `floor(hours / 1.5)` calculation so a 30-minute study window
# still yields one session and a 12-hour window doesn't grind
# the student into the ground.
MIN_SESSIONS_PER_DAY = 1
MAX_SESSIONS_PER_DAY = 4

# Default study window when the student's profile is missing
# either side. Mirrors the same fallback the onboarding page +
# the frontend timetable use, so a brand-new account still gets
# a usable schedule on the very first run.
DEFAULT_STUDY_START = "15:00"
DEFAULT_STUDY_END = "23:00"

# Urgency thresholds — days from today to exam. Tweak here only.
URGENCY_THRESHOLDS = (
    # (max_days_inclusive, label) — first match wins, ordered by
    # increasing days. A subject with no exam_date is treated as
    # the lowest urgency (handled with FAR_FUTURE_DAYS below).
    (7,  "critical"),
    (14, "high"),
    (30, "medium"),
)
# Anything beyond the last threshold becomes "low".
URGENCY_DEFAULT = "low"
# Sentinel days-value for "exam_date not set". Pushes the subject
# into the "low" bucket without raising in the maths.
FAR_FUTURE_DAYS = 365

# Groq model — hardcoded literal to match the other routers, so a
# stale `.env` value cannot silently switch us to a decommissioned
# model. Keep in sync with routers/homework.py + flashcards.py.
GROQ_MODEL = "llama-3.3-70b-versatile"

# Max tokens — a 14-day plan can grow to 50+ rows once the model
# is being careful about Cambridge topic phrasing. 4096 (the
# spec's original value) was hitting Groq's truncation just past
# the first entry, leaving an open `[` and zero parseable rows.
# 8000 sits inside Groq's 8192 ceiling for llama-3.3-70b and
# comfortably fits the full schedule. The salvage path in
# _parse_groq_entries still picks up partial output if Groq ever
# truncates again in the future.
GROQ_MAX_TOKENS = 8000

# Temperature — 0.4 lets the model vary topic phrasing day-to-day
# (less robotic) while still respecting our scheduling rules.
GROQ_TEMPERATURE = 0.4

# Friendly format strings for the prompt. Centralised so the
# Sunday-start / Sunday-end wording stays consistent.
PROMPT_DATE_FORMAT = "%A %d %B %Y"

# The four standard performance buckets we map urgency labels to
# in the human-friendly summary message.
URGENCY_ORDER = ("critical", "high", "medium", "low")

# Slug → Cambridge syllabus code — used when profiles.exam_dates JSON
# stores keys like "economics" instead of "9708".
SUBJECT_SLUG_TO_CODE: Dict[str, str] = {
    "economics": "9708",
    "business": "9609",
    "english": "9093",
    "ict": "9626",
}


# ============================================================
# REQUEST / RESPONSE MODELS
# ============================================================
# Pydantic models describe every body / response on this router.
# `Field(... description=...)` text appears in the auto-docs at
# /docs so the API page documents itself.
# ============================================================

class TimetableGenerateRequest(BaseModel):
    """JSON body the frontend POSTs to /timetable/generate."""

    # UUID of the signed-in student. Must equal the user_id
    # decoded from the bearer token; otherwise we return 401.
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match token).",
    )

    # When True, any existing future entries are deleted before
    # we ask Groq for a new schedule. When False (the default),
    # we short-circuit if entries already exist for the window
    # and the frontend prompts the user to retry with True.
    force_regenerate: bool = Field(
        default=False,
        description=(
            "If True, delete existing future entries and regenerate; "
            "if False, only generate when none exist for the window."
        ),
    )


class TimetableTriggerGenerateResponse(BaseModel):
    """JSON envelope returned by POST /timetable/trigger-generate (n8n cron)."""

    # Number of students whose timetable generation succeeded.
    triggered: int
    # Number of students skipped or failed (missing profile, Groq error, etc.).
    errors: int
    # Total profile rows considered in the batch loop.
    total_users: int


class TimetableGenerateResponse(BaseModel):
    """JSON envelope returned by /timetable/generate."""

    # Human-readable status the frontend can drop straight into a
    # toast (e.g. "Timetable generated successfully").
    message: str
    # How many `timetable_entries` rows we actually wrote. Zero
    # is a valid no-error outcome (Groq returned []).
    entries_saved: int = 0
    # Total weeks the schedule spans. Always 2 today; surfaced as
    # a field so a future "monthly plan" feature can grow without
    # breaking the response contract.
    weeks_covered: int = 0
    # Optional pre-existing-entry count. Populated when we hit the
    # "timetable already exists" short-circuit so the frontend can
    # tell the student exactly how many rows are already on file.
    entries_count: Optional[int] = None
    # Tip surfaced when entries_count > 0 — explains how to retry.
    regenerate_hint: Optional[str] = None
    # The inclusive date window the schedule covers, as ISO dates.
    # The frontend doesn't strictly need this — but it makes the
    # response self-describing for n8n logs.
    date_range: Optional[Dict[str, str]] = None


class TimetableEntryItem(BaseModel):
    """One row returned by GET /timetable/entries."""

    # UUID of the entry row.
    id: str
    # Subject UUID (foreign key into subjects). Optional purely
    # for defensive parsing — every row in the DB has one.
    subject_id: Optional[str] = None
    # Subject name (e.g. "Economics"). Resolved by the join we do
    # in the read endpoint.
    subject_name: Optional[str] = None
    # Cambridge subject code (e.g. "9708").
    subject_code: Optional[str] = None
    # The session title (DB column: `topic`). Renamed on output so
    # the frontend keeps using the spec-style `title` field.
    title: str = ""
    # Optional revision notes. The DB doesn't store this today —
    # we surface an empty string so the frontend's TypeScript
    # contract remains stable.
    notes: Optional[str] = ""
    # ISO date "YYYY-MM-DD". Renamed from the DB column
    # `scheduled_date` for spec compatibility.
    date: str = ""
    # ISO time "HH:MM:SS" — Postgres `time` columns serialise to
    # this shape.
    start_time: str = ""
    end_time: str = ""
    # The DB column is `completed`; we surface as `is_completed`
    # so the frontend keeps its current field name.
    is_completed: bool = False


class TimetableEntriesResponse(BaseModel):
    """Envelope for GET /timetable/entries."""

    data: List[TimetableEntryItem]
    total: int


class CompleteToggleRequest(BaseModel):
    """JSON body for PATCH /timetable/entry/{entry_id}/complete."""

    # UUID of the caller. Verified against the bearer token below.
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match token).",
    )

    # New value for the `completed` column. The frontend sends the
    # OPPOSITE of what the entry currently shows for the toggle.
    is_completed: bool = Field(
        ...,
        description="New completion state for the entry.",
    )


class CompleteToggleResponse(BaseModel):
    """Envelope for PATCH /timetable/entry/{entry_id}/complete."""

    # Always True on a successful update — the frontend uses this
    # as a simple flag rather than inspecting status codes.
    updated: bool
    # Echoed back so the frontend can confirm it patched the
    # right row (defensive against optimistic-update bugs).
    entry_id: str
    # Echoed back so the frontend can sync its local state from
    # the canonical server-side value.
    is_completed: bool


# ============================================================
# AUTH DEPENDENCY: verify_bearer_token
# ============================================================
# Identical pattern to routers/homework.py / flashcards.py /
# quiz.py. Reads the Authorization header, splits "Bearer <jwt>",
# verifies the JWT with Supabase, returns the decoded user_id.
# Every failure returns the same generic 401 — token-probing
# attackers can't differentiate "no token" / "expired" / "unknown".
# ============================================================
def verify_bearer_token(
    # Populated from the Authorization header by name.
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:

    # STEP 1 — header must exist.
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # STEP 2 — header must be "Bearer <jwt>".
    parts = authorization.split(maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # STEP 3 — extract the JWT.
    token = parts[1].strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # STEP 4 — hand the JWT to Supabase for verification.
    try:
        response = supabase.auth.get_user(token)
    except Exception as e:
        # Log type only — `e` may contain user data we don't want
        # to print to stdout.
        print(f"[Timetable] Bearer token verify raised: {type(e).__name__}")
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # Tolerate both object-shaped and dict-shaped responses so a
    # supabase-py upgrade can't silently break auth.
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

    # STEP 5 — pull the UUID out and return it as a string.
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
    return str(user_id)


# ============================================================
# THE ROUTER
# ============================================================
# Every route below is registered against this object. main.py
# attaches it with:
#   app.include_router(timetable.router, prefix="/timetable",
#                      tags=["Timetable"])
# Final paths: /timetable/generate, /timetable/entries,
#              /timetable/entry/{entry_id}/complete.
# ============================================================
router = APIRouter()


# ============================================================
# HELPER: _enforce_same_user
# ============================================================
# Anti-spoofing: the user_id in the request body / query string
# MUST match the user_id encoded in the bearer token. Returns
# silently on a match, raises 401 on mismatch.
# ============================================================
def _enforce_same_user(token_user_id: str, body_user_id: str) -> None:
    if token_user_id.strip() != body_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )


# ============================================================
# HELPER: _parse_hh_mm
# ============================================================
# Turn a "HH:MM" or "HH:MM:SS" string into a datetime.time so we
# can do clean hour arithmetic. Tolerant of stray whitespace and
# of seconds being present or absent.
# ============================================================
def _parse_hh_mm(raw: Optional[str], fallback: str) -> time:
    text = (raw or "").strip() or fallback
    # Postgres `time` may serialise to "HH:MM:SS"; the form sends
    # "HH:MM". Both parse via strptime when we try in that order.
    for pattern in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(text, pattern).time()
        except ValueError:
            continue
    # Last-chance fallback — keeps the request from 500-ing if a
    # malformed value sneaks in from the profile.
    return datetime.strptime(fallback, "%H:%M").time()


# ============================================================
# HELPER: _sessions_per_day
# ============================================================
# Compute how many 90-minute sessions fit between `start` and
# `end`. Clamped to [MIN, MAX] so a freakishly small/large window
# never produces zero or seven sessions a day.
# ============================================================
def _sessions_per_day(start: time, end: time) -> int:
    # Convert each time to minutes-from-midnight so the subtraction
    # is a simple integer operation.
    minutes_total = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute)
    # Clamp the raw count: too few cards = no schedule; too many
    # = unsustainable. MIN_SESSIONS_PER_DAY / MAX_SESSIONS_PER_DAY
    # are the configured guardrails.
    raw = minutes_total // SESSION_DURATION_MIN
    return max(MIN_SESSIONS_PER_DAY, min(MAX_SESSIONS_PER_DAY, raw))


# ============================================================
# HELPER: _urgency_for_days
# ============================================================
# Map "days until exam" to one of four urgency labels using the
# table at the top of the file. Subjects with closer exams get
# more sessions per week — that's the spec's whole point.
# ============================================================
def _urgency_for_days(days_until_exam: int) -> str:
    # Iterate the configured thresholds in increasing-days order;
    # first match wins.
    for max_days, label in URGENCY_THRESHOLDS:
        if days_until_exam <= max_days:
            return label
    return URGENCY_DEFAULT


# ============================================================
# HELPER: _monday_of
# ============================================================
# Return the ISO Monday on/before the given date as "YYYY-MM-DD".
# We use this for the NOT-NULL `week_start` column on every
# inserted timetable_entries row.
# ============================================================
def _monday_of(d: date) -> str:
    # date.weekday() is 0=Mon..6=Sun, so subtracting weekday() days
    # always lands on the Monday of the same week.
    monday = d - timedelta(days=d.weekday())
    return monday.isoformat()


# ============================================================
# HELPER: _today_utc_date
# ============================================================
# `date.today()` reads the system local clock which is fine on
# Render but would be Aryan's local clock on his Windows machine.
# We force UTC here for consistency between dev + prod.
# ============================================================
def _today_utc_date() -> date:
    return datetime.now(timezone.utc).date()


# ============================================================
# HELPER: _salvage_objects
# ============================================================
# Walk a (possibly truncated) text and return every TOP-LEVEL
# balanced JSON object inside it. Tolerant of:
#   • output that never closed its array (no trailing `]`)
#   • a half-finished final object (silently dropped)
#   • braces inside string literals (we track string mode)
#
# This is the last-resort fallback used by _parse_groq_entries
# when Groq's response is truncated by max_tokens. Without it
# a 49-of-50 entry response would surface as "no schedule" to
# the user — which is much worse than partial progress.
# ============================================================
def _salvage_objects(text: str) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    depth = 0
    start: Optional[int] = None
    in_string = False
    escape = False

    for i, ch in enumerate(text):
        # Inside a string literal we ignore brace characters
        # entirely — they can't open or close a JSON object.
        if escape:
            escape = False
            continue
        if in_string:
            if ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            # Mark the start of a new top-level object on the
            # outermost `{`. Nested `{` only bumps the depth.
            if depth == 0:
                start = i
            depth += 1
            continue
        if ch == "}":
            depth -= 1
            # Matching `}` at depth 0 closes the top-level object.
            if depth == 0 and start is not None:
                snippet = text[start:i + 1]
                try:
                    obj = json.loads(snippet)
                    if isinstance(obj, dict):
                        results.append(obj)
                except json.JSONDecodeError:
                    # A genuinely malformed object inside the
                    # array is logged + skipped, not fatal.
                    pass
                start = None
            elif depth < 0:
                # Stray closing brace — reset so we don't trip
                # on the rest of the text.
                depth = 0
                start = None
    return results


# ============================================================
# HELPER: _parse_groq_entries
# ============================================================
# Convert Groq's raw text reply into a clean list of dicts of
# shape {subject_name, subject_code, date, start_time, end_time,
# title, notes}. The prompt asks for a bare JSON array, but real
# LLM output sometimes includes markdown fences, a one-line
# preamble, trailing commentary, OR truncation when the response
# runs past max_tokens. Strategy:
#
#   1. json.loads on the raw string.
#   2. Strip a leading/trailing markdown fence and retry.
#   3. Regex out the first balanced [...] block and retry.
#   4. SALVAGE: extract every complete top-level {...} object
#      from the (possibly unterminated) text. This is what saves
#      us when Groq truncates mid-array — we still return the
#      first N complete entries rather than a 503.
#
# Returns (entries, ok). `ok=False` → the caller surfaces a 503.
# `entries == []` with `ok=True` means Groq explicitly returned
# the empty array (no schedule possible) — the caller turns that
# into a friendly 200 message.
# ============================================================
def _parse_groq_entries(raw: str) -> "tuple[List[Dict[str, Any]], bool]":
    # Defensive: empty / falsy reply → "model had no useful output".
    if not raw or not raw.strip():
        return ([], True)

    candidates = [raw]

    # Strip a leading/trailing markdown fence in a forgiving way.
    fence_stripped = re.sub(r"^\s*```[a-zA-Z]*\s*", "", raw.strip())
    fence_stripped = re.sub(r"```\s*$", "", fence_stripped).strip()
    if fence_stripped and fence_stripped != raw:
        candidates.append(fence_stripped)

    # First `[` to last `]`, with DOTALL so newlines are matched.
    array_match = re.search(r"\[.*\]", raw, flags=re.DOTALL)
    if array_match:
        candidates.append(array_match.group(0))

    # Try each candidate; first one that yields a list wins.
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue

        # Accept either a bare list OR an object whose only
        # interesting key is "entries" (some models like to wrap).
        if isinstance(parsed, dict):
            for key in ("entries", "schedule", "data"):
                if isinstance(parsed.get(key), list):
                    parsed = parsed[key]
                    break

        if isinstance(parsed, list):
            # Light-touch validation — keep dicts that have every
            # field the insert needs. The caller is robust to bad
            # subject_code (it logs + skips that row).
            cleaned: List[Dict[str, Any]] = []
            for item in parsed:
                if not isinstance(item, dict):
                    continue
                # Coerce known fields to plain strings so a
                # numeric subject_code (e.g. 9708 as int) is still
                # matched by our lookup.
                cleaned.append({
                    "subject_name": str(item.get("subject_name") or "").strip(),
                    "subject_code": str(item.get("subject_code") or "").strip(),
                    "date":         str(item.get("date") or "").strip(),
                    "start_time":   str(item.get("start_time") or "").strip(),
                    "end_time":     str(item.get("end_time") or "").strip(),
                    "title":        str(item.get("title") or "").strip(),
                    "notes":        str(item.get("notes") or "").strip(),
                })
            return (cleaned, True)

    # ── ATTEMPT 4 (salvage): partial / truncated output. ───
    # All three structured attempts failed — most likely the
    # response was cut off by max_tokens and never closed the
    # outer `]`. Walk what we have and pick out every COMPLETE
    # top-level object. If we find at least one we treat it as
    # a usable (partial) schedule rather than crashing.
    salvaged_dicts = _salvage_objects(raw)
    if salvaged_dicts:
        cleaned = []
        for item in salvaged_dicts:
            cleaned.append({
                "subject_name": str(item.get("subject_name") or "").strip(),
                "subject_code": str(item.get("subject_code") or "").strip(),
                "date":         str(item.get("date") or "").strip(),
                "start_time":   str(item.get("start_time") or "").strip(),
                "end_time":     str(item.get("end_time") or "").strip(),
                "title":        str(item.get("title") or "").strip(),
                "notes":        str(item.get("notes") or "").strip(),
            })
        # Log so we know truncation is happening — useful signal
        # that max_tokens may need bumping again later.
        print(
            f"[Timetable] Salvaged {len(cleaned)} entries from a "
            "truncated Groq response (raw response did not parse "
            "as a complete JSON array)."
        )
        return (cleaned, True)

    # Nothing parsed — caller returns 503.
    return ([], False)


# ============================================================
# HELPER: _apply_exam_date_overrides — merge profile dates onto subjects
# ============================================================
def _apply_exam_date_overrides(
    subjects: List[Dict[str, Any]],
    exam_dates: Dict[str, str],
) -> None:
    # Override shared subjects.exam_date when the student saved dates on their profile.
    if not exam_dates:
        return
    for subject_row in subjects:
        # Match trigger path dict built as name.lower() -> exam_date from subjects per user.
        name_key = str(subject_row.get("name") or "").strip().lower()
        if name_key and name_key in exam_dates:
            subject_row["exam_date"] = exam_dates[name_key]
            continue
        code = str(subject_row.get("code") or "").strip()
        if not code:
            continue
        for map_key, date_str in exam_dates.items():
            mapped_code = SUBJECT_SLUG_TO_CODE.get(map_key.strip().lower(), map_key.strip())
            if mapped_code == code:
                subject_row["exam_date"] = date_str
                break


# ============================================================
# HELPER: _fetch_all_profile_user_ids — every student for n8n Sunday cron
# ============================================================
def _fetch_all_profile_user_ids() -> List[str]:
    # Read all user_id values from profiles via service-role client (database.py).
    try:
        result = (
            supabase.from_(PROFILES_TABLE)
            .select("user_id")
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception as e:
        print(f"[Timetable] profiles list failed: {type(e).__name__}: {e}")
        return []
    user_ids: List[str] = []
    for row in rows:
        uid = str(row.get("user_id") or "").strip()
        if uid:
            user_ids.append(uid)
    return user_ids


# ============================================================
# HELPER: _fetch_profile_generation_fields — study window (profiles only)
# ============================================================
def _fetch_profile_generation_fields(
    user_id: str,
) -> Optional[Dict[str, Any]]:
    # Load study_start_time and study_end_time for one student (profiles row).
    try:
        result = (
            supabase.table(PROFILES_TABLE)
            .select("study_start_time, study_end_time")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        rows = getattr(result, "data", None) or []
        return rows[0] if rows else None
    except Exception as e:
        print(
            f"[Timetable] profile generation fields failed for {user_id!r}: "
            f"{type(e).__name__}: {e}"
        )
        return None


# ============================================================
# HELPER: _fetch_user_subject_exam_dates — per-user exam dates from subjects
# ============================================================
def _fetch_user_subject_exam_dates(user_id: str) -> Dict[str, str]:
    # Query subjects for this user: active rows with a non-null exam_date.
    try:
        result = (
            supabase.from_("subjects")
            .select("name, code, exam_date")
            .eq("user_id", user_id)
            .eq("is_active", True)
            .not_.is_("exam_date", "null")
            .execute()
        )
        subjects_data = getattr(result, "data", None) or []  # List of dicts or empty on failure shape
    except Exception as e:
        print(
            f"[Timetable] user subject exam_dates query failed for {user_id!r}: "
            f"{type(e).__name__}: {e}"
        )
        return {}
    exam_dates: Dict[str, str] = {}
    for row in subjects_data:
        exam_dates[str(row["name"]).lower()] = row["exam_date"]
    return exam_dates


# ============================================================
# HELPER: _generate_timetable_for_user — core POST /timetable/generate logic
# ============================================================
# FLOW
#   1. Profile read — `study_start_time` + `study_end_time`.
#      Missing → 404 "Please complete onboarding first."
#   2. Subjects read — every active row (+ optional profile exam_dates).
#      Missing → 404 "No subjects found".
#   3. Window check — if force_regenerate=False and entries
#      already exist in the next 14 days, short-circuit 200.
#      If force_regenerate=True, delete existing future entries.
#   4. Compute urgency + sessions_per_day.
#   5. Build the Groq prompt and call the model.
#   6. Parse the JSON array.
#   7. Resolve each row's subject_code → subject_id, insert. A
#      failing row is logged and skipped; the batch survives.
#   8. Respond with how many we wrote.
# ============================================================
def _generate_timetable_for_user(
    user_id: str,
    force_regenerate: bool,
    exam_dates_override: Optional[Dict[str, str]] = None,
) -> TimetableGenerateResponse:
    # ── STEP 2: fetch the profile (study window) ────────────
    # `study_start_time` and `study_end_time` are the live column
    # names (NOT `study_hours_start` / `study_hours_end` — see
    # the live-schema note at the top of the file).
    try:
        profile_result = (
            supabase
            .table(PROFILES_TABLE)
            .select("study_start_time, study_end_time")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        profile_rows = getattr(profile_result, "data", None) or []
    except Exception as e:
        # Service-role queries shouldn't really fail. If they do
        # we surface a generic 500 — the user can retry.
        print(f"[Timetable] Profile read failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Database error. Please try again."},
        )

    if not profile_rows:
        # No profile row → the user hasn't completed onboarding.
        # 404 is appropriate ("the prerequisite resource is
        # missing") and the message tells the frontend what to do.
        raise HTTPException(
            status_code=404,
            detail={
                "error": "Profile not found. Please complete onboarding first.",
            },
        )

    profile = profile_rows[0]
    # Fall back to the configured defaults if the profile row was
    # created without these values (e.g. onboarding incomplete).
    study_start = _parse_hh_mm(profile.get("study_start_time"), DEFAULT_STUDY_START)
    study_end = _parse_hh_mm(profile.get("study_end_time"), DEFAULT_STUDY_END)

    # ── STEP 3: fetch all active subjects ───────────────────
    # `subjects` is shared across the (single) tenant today —
    # there is no user_id column to filter on. We just read every
    # active row (is_active = true) so a hidden subject (e.g.
    # one we paused mid-term) is left out.
    try:
        subjects_result = (
            supabase
            .table(SUBJECTS_TABLE)
            .select("id, name, code, exam_date")
            .eq("is_active", True)
            # Most urgent (soonest exam) first. Rows with a NULL
            # exam_date sort LAST under PostgREST's default
            # NULLS LAST behaviour, which is exactly what we want.
            .order("exam_date", desc=False)
            .execute()
        )
        subjects = getattr(subjects_result, "data", None) or []
    except Exception as e:
        print(f"[Timetable] Subjects read failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Database error. Please try again."},
        )

    if not subjects:
        # 404 — the prerequisite is missing.
        raise HTTPException(
            status_code=404,
            detail={
                "error": "No subjects found. Please complete onboarding first.",
            },
        )

    # Merge per-student exam_dates from profiles when provided (n8n trigger path).
    _apply_exam_date_overrides(subjects, exam_dates_override or {})

    # ── STEP 4: today + window math ─────────────────────────
    today = _today_utc_date()
    # `today + 14 days` is the LAST day we plan for (inclusive).
    # The spec says "today + 14 days"; we count today as day 1.
    window_end = today + timedelta(days=PLAN_WINDOW_DAYS)
    today_iso = today.isoformat()
    window_end_iso = window_end.isoformat()
    today_str = today.strftime(PROMPT_DATE_FORMAT)
    end_date_str = window_end.strftime(PROMPT_DATE_FORMAT)

    # ── STEP 5: check / clear existing entries ──────────────
    if force_regenerate:
        # Force-regenerate: delete every entry the caller owns
        # with `scheduled_date >= today`. We keep the past so old
        # records stay intact; only the future gets wiped.
        try:
            supabase.table(ENTRIES_TABLE).delete().eq(
                "user_id", user_id
            ).gte("scheduled_date", today_iso).execute()
        except Exception as e:
            # Failure here is logged but NOT fatal — Groq can
            # still try and we'll insert alongside the existing
            # rows. The frontend can re-run if duplicates appear.
            print(f"[Timetable] Pre-regenerate delete failed: {type(e).__name__}: {e}")
    else:
        # Soft path — if entries already exist in the next 14
        # days we return 200 with a "use force_regenerate" hint.
        try:
            existing_result = (
                supabase
                .table(ENTRIES_TABLE)
                .select("id", count="exact")
                .eq("user_id", user_id)
                .gte("scheduled_date", today_iso)
                .lte("scheduled_date", window_end_iso)
                .execute()
            )
            existing_count = getattr(existing_result, "count", None) or 0
        except Exception as e:
            # Be conservative: on a count failure we proceed
            # rather than block the user — worst case is a few
            # duplicate rows.
            print(f"[Timetable] Existing-count query failed: {type(e).__name__}: {e}")
            existing_count = 0

        if existing_count > 0:
            # Short-circuit: tell the caller. The frontend
            # changes its CTA copy and re-sends with
            # force_regenerate=True on the next click.
            return TimetableGenerateResponse(
                message="Timetable already exists for the next 2 weeks",
                entries_saved=0,
                weeks_covered=PLAN_WINDOW_DAYS // 7,
                entries_count=existing_count,
                regenerate_hint=(
                    "Pass force_regenerate: true to regenerate"
                ),
                date_range={"start": today_iso, "end": window_end_iso},
            )

    # ── STEP 6: per-subject urgency lines for the prompt ────
    # Subjects with closer exams get more sessions per week.
    # We compute days_until_exam, map it to one of four urgency
    # buckets, and feed the result straight into the prompt.
    subject_lines: List[str] = []
    for s in subjects:
        # Parse exam_date — Supabase returns either an ISO date
        # string ("YYYY-MM-DD") or None.
        exam_date_raw = s.get("exam_date")
        days_until_exam: int
        if exam_date_raw:
            try:
                exam_d = date.fromisoformat(str(exam_date_raw)[:10])
                # If the exam is already in the past we treat that
                # as 0 days (still revise — the spec asks for this
                # exact behaviour).
                days_until_exam = max(0, (exam_d - today).days)
            except ValueError:
                # Bad date stored — fall back to "far future" so
                # the subject still appears (just at low urgency).
                days_until_exam = FAR_FUTURE_DAYS
        else:
            days_until_exam = FAR_FUTURE_DAYS

        urgency = _urgency_for_days(days_until_exam)
        # The prompt line is plain ASCII so Windows consoles never
        # blow up on logging.
        subject_lines.append(
            f"- {s.get('name')} ({s.get('code')}): "
            f"exam in {days_until_exam} days -- urgency: {urgency}"
        )

    # ── STEP 7: sessions-per-day from the study window ──────
    sessions_per_day = _sessions_per_day(study_start, study_end)

    # ── STEP 8: build the Groq prompt ──────────────────────
    # The system prompt enforces the Cambridge tone + the exact
    # JSON output we expect. Any deviation is tolerated by the
    # parser (markdown fences, preamble), but we strongly steer
    # the model to "JSON only, no preamble".
    system_prompt = (
        "You are an expert Cambridge AS Level study planner creating a "
        "2-week revision timetable for a student in Zambia.\n"
        f"\n"
        f"Generate a study timetable from {today_str} to {end_date_str}.\n"
        "\n"
        f"Student's study window: {study_start.strftime('%H:%M')} to "
        f"{study_end.strftime('%H:%M')}\n"
        f"Sessions per day available: {sessions_per_day}\n"
        f"Each session is exactly {SESSION_DURATION_MIN} minutes long.\n"
        "\n"
        "Subjects and urgency:\n"
        + "\n".join(subject_lines)
        + "\n\n"
        "Rules for generating the timetable:\n"
        "1. Critical urgency subjects (<=7 days): include every day\n"
        "2. High urgency subjects (<=14 days): include 5-6 days per week\n"
        "3. Medium urgency subjects (<=30 days): include 3-4 days per week\n"
        "4. Low urgency subjects (>30 days): include 2-3 days per week\n"
        "5. Never schedule more than 2 consecutive sessions of the same subject\n"
        "6. Always leave at least one rest day per week (Sunday preferred)\n"
        "7. Space sessions throughout the study window evenly\n"
        "8. Each session must have a specific Cambridge topic as its title\n"
        "   Use real Cambridge AS Level topics for each subject\n"
        "\n"
        "Return ONLY a JSON array. No introduction. No explanation.\n"
        "Each entry must follow this exact format:\n"
        "[\n"
        "  {\n"
        '    "subject_name": "Economics",\n'
        '    "subject_code": "9708",\n'
        '    "date": "2026-05-14",\n'
        '    "start_time": "15:00",\n'
        '    "end_time": "16:30",\n'
        '    "title": "Market Structures -- Perfect Competition",\n'
        '    "notes": "Focus on diagrams and long-run equilibrium"\n'
        "  }\n"
        "]\n"
        "Date format: YYYY-MM-DD\n"
        "Time format: HH:MM (24 hour)\n"
        "Return empty array [] if you cannot generate a valid timetable."
    )

    # ── STEP 9: lazy-import groq_client and call the model ──
    # Same lazy-import dance as the other routers — avoids the
    # circular import between main.py and this module.
    try:
        from main import groq_client  # noqa: WPS433 (intentional)
    except Exception as e:
        print(f"[Timetable] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    try:
        completion = groq_client.chat.completions.create(
            # MODEL — locked to llama-3.3-70b-versatile.
            model=GROQ_MODEL,
            # MESSAGES — the system block carries every rule + the
            # exact JSON shape we want; the user block is a single
            # short cue so the model knows to ACT on the system.
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": "Generate the timetable now."},
            ],
            # MAX TOKENS — 4096 fits ~30-40 entries comfortably.
            max_tokens=GROQ_MAX_TOKENS,
            # TEMPERATURE — 0.4 lets phrasing vary day-to-day while
            # respecting the scheduling rules above.
            temperature=GROQ_TEMPERATURE,
        )
    except Exception as e:
        # Every Groq failure mode maps to the same 503 — the user
        # only needs to know to retry. Internal cause is logged.
        print(f"[Timetable] Groq call failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate timetable. Please try again."},
        )

    try:
        raw_answer = completion.choices[0].message.content or ""
    except (AttributeError, IndexError) as e:
        print(f"[Timetable] Groq response shape unexpected: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate timetable. Please try again."},
        )

    # ── STEP 10: parse the JSON array ──────────────────────
    entries_raw, parse_ok = _parse_groq_entries(raw_answer)
    if not parse_ok:
        # We couldn't extract any valid JSON. Log the raw text so
        # an engineer can inspect, but never return it to the
        # caller — it may contain prompt fragments.
        print(
            "[Timetable] Could not parse Groq response. "
            f"First 200 chars: {raw_answer[:200]!r}"
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate timetable. Please try again."},
        )

    if len(entries_raw) == 0:
        # Model decided the inputs don't permit a schedule. Not
        # an error — surface a calm "no entries" message.
        return TimetableGenerateResponse(
            message="Could not generate timetable",
            entries_saved=0,
            weeks_covered=PLAN_WINDOW_DAYS // 7,
            date_range={"start": today_iso, "end": window_end_iso},
        )

    # ── STEP 11: resolve subject_code → subject_id ──────────
    # subject_code is the most reliable join key (Cambridge codes
    # don't change). We build a lookup once and re-use it across
    # the batch.
    subject_by_code = {
        str(s.get("code") or "").strip(): s
        for s in subjects
        if s.get("code")
    }

    # ── STEP 12: insert each entry. A failure on ONE row is
    # logged + skipped; the rest still save (graceful batch). ──
    saved_count = 0
    for entry in entries_raw:
        code = entry.get("subject_code", "")
        subject_row = subject_by_code.get(code)
        if not subject_row:
            # Groq invented a subject code we don't recognise.
            # Log enough context to debug without leaking secrets.
            print(
                f"[Timetable] Skipping row — unknown subject_code "
                f"{code!r} (title={entry.get('title')!r})"
            )
            continue

        # `scheduled_date` is a date string — Supabase accepts
        # "YYYY-MM-DD" directly. We compute the `week_start` from
        # it so the NOT-NULL constraint never trips.
        scheduled_date = entry.get("date", "")
        try:
            entry_date = date.fromisoformat(scheduled_date[:10])
        except ValueError:
            print(
                f"[Timetable] Skipping row — bad date "
                f"{scheduled_date!r} (title={entry.get('title')!r})"
            )
            continue

        payload = {
            # The authenticated student — never trust the body.
            "user_id": user_id,
            # Resolved by subject_code lookup above.
            "subject_id": subject_row["id"],
            # `topic` is the live DB column name (the spec calls
            # this `title` — see the live-schema note up top).
            "topic": entry.get("title") or "Untitled session",
            # ISO date for the session.
            "scheduled_date": entry_date.isoformat(),
            # 24-hour times. Groq is asked for HH:MM; Postgres
            # `time` accepts that directly.
            "start_time": entry.get("start_time") or "",
            "end_time": entry.get("end_time") or "",
            # `completed` is the live DB column name (`is_completed`
            # in the spec). Fresh entries start uncompleted.
            "completed": False,
            # NOT-NULL grouping column — Monday of this entry's week.
            "week_start": _monday_of(entry_date),
            # `notes` is intentionally NOT included — the live
            # `timetable_entries` table has no matching column.
            # When that column is added later this is the single
            # line to update.
        }
        try:
            insert_result = supabase.table(ENTRIES_TABLE).insert(payload).execute()
            rows = (
                getattr(insert_result, "data", None)
                or (insert_result.get("data") if isinstance(insert_result, dict) else [])
            )
            if rows:
                saved_count += 1
            else:
                # Insert ran but returned no row — rare but log
                # and keep going so the rest still save.
                print(
                    f"[Timetable] Insert returned no rows for "
                    f"title={entry.get('title')!r}; skipping."
                )
        except Exception as e:
            # Log type + short message, continue with the batch.
            print(
                f"[Timetable] Insert failed for "
                f"({entry.get('title','')[:60]!r}): "
                f"{type(e).__name__}: {e}"
            )
            continue

    # ── STEP 13: respond. ───────────────────────────────────
    return TimetableGenerateResponse(
        message=(
            "Timetable generated successfully"
            if saved_count > 0
            else "Could not save any timetable entries. Please try again."
        ),
        entries_saved=saved_count,
        weeks_covered=PLAN_WINDOW_DAYS // 7,
        date_range={"start": today_iso, "end": window_end_iso},
    )


# ============================================================
# ENDPOINT: POST /timetable/generate
# ============================================================
# FLOW
#   1. Pydantic validates the body. Auth dep verifies the JWT.
#   2. We enforce token.user_id == body.user_id (anti-spoof).
#   3. Delegate to _generate_timetable_for_user (shared with n8n trigger).
# ============================================================
@router.post(
    "/generate",
    response_model=TimetableGenerateResponse,
    summary="Generate a 2-week study timetable",
)
def generate_timetable(
    body: TimetableGenerateRequest,
    # Auth runs first — bad tokens never reach the body.
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: identity check ──────────────────────────────
    # Token says caller is user X; body claims to act as user Y.
    # We require X == Y or this would be an account-takeover.
    _enforce_same_user(verified_user_id, body.user_id)

    # ── STEP 2+: shared generation logic (no profile exam_dates override). ──
    return _generate_timetable_for_user(
        verified_user_id,
        body.force_regenerate,
        exam_dates_override=None,
    )


# ================================================
# INTERNAL TRIGGER — called by n8n every Sunday 8am
# No auth required — uses service role key
# n8n URL: POST /timetable/trigger-generate
# No Authorization header needed
# ================================================
@router.post(
    "/trigger-generate",
    response_model=TimetableTriggerGenerateResponse,
    summary="Batch-generate timetables for all students (n8n Sunday cron)",
)
async def trigger_generate_timetable() -> TimetableTriggerGenerateResponse:
    # STEP 1 — load every student UUID from profiles (service role).
    user_ids = _fetch_all_profile_user_ids()
    total_users = len(user_ids)
    triggered_count = 0
    error_count = 0

    # STEP 2 — process each user; one failure must not stop the batch.
    for uid in user_ids:
        try:
            # STEP 2a — study window from profiles (study_start_time, study_end_time).
            profile_row = _fetch_profile_generation_fields(uid)
            if not profile_row:
                error_count += 1
                continue

            # STEP 2b — exam dates from subjects table (per user_id), not profiles.
            exam_dates_map = _fetch_user_subject_exam_dates(uid)

            # STEP 2c — regenerate timetable (force=True wipes future entries).
            result = _generate_timetable_for_user(
                uid,
                force_regenerate=True,
                exam_dates_override=exam_dates_map,
            )

            # STEP 2d — count success when rows were saved or message confirms OK.
            if result.entries_saved and result.entries_saved > 0:
                triggered_count += 1
            elif "successfully" in (result.message or "").lower():
                triggered_count += 1
            else:
                error_count += 1
        except HTTPException as exc:
            print(
                f"[Timetable] trigger-generate HTTP {exc.status_code} "
                f"for user {uid!r}"
            )
            error_count += 1
        except Exception as e:
            print(
                f"[Timetable] trigger-generate unexpected error for {uid!r}: "
                f"{type(e).__name__}: {e}"
            )
            error_count += 1

    # STEP 3 — summary JSON for n8n monitoring.
    return TimetableTriggerGenerateResponse(
        triggered=triggered_count,
        errors=error_count,
        total_users=total_users,
    )


# ============================================================
# ENDPOINT: GET /timetable/entries
# ============================================================
# Returns every timetable_entries row for the caller inside an
# inclusive Mon-Sun window, with the joined subject name + code.
# Used by the frontend to render the weekly grid and the daily
# detail view.
# ============================================================
@router.get(
    "/entries",
    response_model=TimetableEntriesResponse,
    summary="List timetable entries for one week",
)
def list_entries(
    # Query parameters — `Query(...)` carries the OpenAPI docs
    # AND the validation rules. FastAPI returns 422 automatically
    # if any are missing.
    user_id: str = Query(..., min_length=1, description="Caller's UUID (must match token)"),
    week_start: str = Query(
        ...,
        min_length=10,
        max_length=10,
        description="ISO date of the week's Monday (YYYY-MM-DD).",
    ),
    week_end: str = Query(
        ...,
        min_length=10,
        max_length=10,
        description="ISO date of the week's Sunday (YYYY-MM-DD).",
    ),
    verified_user_id: str = Depends(verify_bearer_token),
):
    # Anti-spoof: the user_id query param must match the JWT.
    _enforce_same_user(verified_user_id, user_id)

    # Validate the date strings — we don't trust query params.
    try:
        date.fromisoformat(week_start)
        date.fromisoformat(week_end)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={"error": "week_start and week_end must be ISO dates (YYYY-MM-DD)."},
        )

    # Single round-trip — PostgREST resolves the nested select on
    # the foreign key automatically. We pull the joined subject
    # name + code so the frontend doesn't need a second fetch.
    try:
        result = (
            supabase
            .table(ENTRIES_TABLE)
            # The bracket syntax tells PostgREST to embed the
            # parent subjects row's selected columns inline.
            .select("id, subject_id, topic, scheduled_date, start_time, end_time, completed, subjects(name, code)")
            .eq("user_id", verified_user_id)
            .gte("scheduled_date", week_start)
            .lte("scheduled_date", week_end)
            .order("scheduled_date", desc=False)
            .order("start_time", desc=False)
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception as e:
        # Failure here is logged and surfaced as an empty list so
        # the page can still render the empty state.
        print(f"[Timetable] entries read failed: {type(e).__name__}: {e}")
        rows = []

    # Normalise live-schema names back to the spec-style fields
    # the frontend expects (`title`, `date`, `is_completed`).
    items: List[TimetableEntryItem] = []
    for r in rows:
        # PostgREST returns the embedded subject as either a dict
        # or a list depending on the cardinality; tolerate both.
        subj = r.get("subjects")
        if isinstance(subj, list):
            subj = subj[0] if subj else None
        items.append(
            TimetableEntryItem(
                id=str(r.get("id", "")),
                subject_id=(str(r["subject_id"]) if r.get("subject_id") else None),
                subject_name=(subj.get("name") if isinstance(subj, dict) else None),
                subject_code=(subj.get("code") if isinstance(subj, dict) else None),
                # `topic` -> `title` for the frontend.
                title=r.get("topic") or "",
                # No `notes` column today — surface "" so the
                # response shape is still complete.
                notes="",
                # `scheduled_date` -> `date`.
                date=str(r.get("scheduled_date") or ""),
                start_time=str(r.get("start_time") or ""),
                end_time=str(r.get("end_time") or ""),
                # `completed` -> `is_completed`.
                is_completed=bool(r.get("completed", False)),
            )
        )

    return TimetableEntriesResponse(data=items, total=len(items))


# ============================================================
# ENDPOINT: PATCH /timetable/entry/{entry_id}/complete
# ============================================================
# Toggle the `completed` flag on one entry. The frontend already
# does an optimistic UI flip — this endpoint persists the change
# so the next page load reflects it.
# ============================================================
@router.patch(
    "/entry/{entry_id}/complete",
    response_model=CompleteToggleResponse,
    summary="Mark a timetable entry complete / not complete",
)
def toggle_complete(
    # Path param — typed and validated; FastAPI gives a 422
    # automatically if the caller omits it.
    entry_id: str = Path(..., min_length=1, description="UUID of the entry row."),
    body: CompleteToggleRequest = ...,
    verified_user_id: str = Depends(verify_bearer_token),
):
    # Anti-spoof check.
    _enforce_same_user(verified_user_id, body.user_id)

    # ── STEP 1: confirm the row exists AND belongs to us. ───
    # Without this defence-in-depth check, a malicious caller
    # could PATCH any UUID they could guess. We use the service
    # role so we always get an authoritative ownership view.
    try:
        owner_result = (
            supabase
            .table(ENTRIES_TABLE)
            .select("id, user_id")
            .eq("id", entry_id)
            .limit(1)
            .execute()
        )
        owner_rows = getattr(owner_result, "data", None) or []
    except Exception as e:
        print(f"[Timetable] Ownership probe failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Database error. Please try again."},
        )

    if not owner_rows:
        # No such row — 403 because the spec wants 403 for
        # "not found OR not yours" so the response is identical
        # in both cases (no enumeration of foreign UUIDs).
        raise HTTPException(
            status_code=403,
            detail={"error": "Forbidden — entry not found or not yours."},
        )

    if str(owner_rows[0].get("user_id")) != verified_user_id:
        raise HTTPException(
            status_code=403,
            detail={"error": "Forbidden — entry not found or not yours."},
        )

    # ── STEP 2: persist the new value. ─────────────────────
    # We update by id AND user_id as a belt-and-braces filter
    # (extra defence in case the service-role bypass surprises us).
    try:
        update_result = (
            supabase
            .table(ENTRIES_TABLE)
            # `completed` is the live column name; the spec calls
            # this `is_completed`.
            .update({"completed": bool(body.is_completed)})
            .eq("id", entry_id)
            .eq("user_id", verified_user_id)
            .execute()
        )
        updated_rows = getattr(update_result, "data", None) or []
    except Exception as e:
        print(f"[Timetable] Update failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not update entry. Please try again."},
        )

    if not updated_rows:
        # The row vanished between our ownership probe and the
        # update — extremely unlikely but surface a 403 anyway.
        raise HTTPException(
            status_code=403,
            detail={"error": "Forbidden — entry not found or not yours."},
        )

    return CompleteToggleResponse(
        updated=True,
        entry_id=str(entry_id),
        is_completed=bool(body.is_completed),
    )
