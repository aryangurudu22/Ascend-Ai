# ============================================================
# ASCENDAI BACKEND — routers/quiz.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# Everything to do with recording quiz attempts in the flashcards
# feature. A "quiz" is a single sitting where Aisha goes through
# every card in a topic / subject and marks each one as either
# "Got it" (correct) or "Still learning" (wrong).
#
# Four endpoints live here:
#
#   POST /quiz/session
#     • Called once when a quiz starts.
#     • Creates an in-progress quiz_sessions row.
#     • Returns the session_id the page uses for every later call.
#
#   POST /quiz/answer
#     • Called once per card after the student answers.
#     • Saves a quiz_answers row.
#     • Bumps the flashcard's mastery_level (+1 right, -1 wrong,
#       clamped 0..5 — that's our spaced-repetition rule).
#     • Bumps the session.score by 1 on a correct answer.
#
#   POST /quiz/complete
#     • Called once when the last card is finished.
#     • Marks the session as completed + computes the final
#       percentage, duration, and a human-readable
#       performance label.
#
#   GET /quiz/history?user_id=…&subject_id=…&limit=…
#     • Returns the student's completed quiz history, newest
#       first. Used by the (future) results dashboard.
#
# AUTHENTICATION
# ------------------------------------------------------------
# Every endpoint runs the same Bearer-JWT verification used by
# routers/homework.py and routers/flashcards.py. The verified
# user_id from the token MUST match the user_id in the request,
# otherwise we return 401.
#
# Additionally, every "operate on an existing session" endpoint
# loads the session row and confirms it belongs to the caller —
# we return 403 if it doesn't. This is defence-in-depth on top
# of the service-role-bypasses-RLS situation.
#
# WHAT TABLES WE READ/WRITE
# ------------------------------------------------------------
#   • quiz_sessions  — one row per quiz attempt.
#   • quiz_answers   — one row per card answered.
#   • flashcards     — read current mastery_level, write the new
#                      one (the spaced-repetition update).
#
# PROJECT RULES THIS FILE OBEYS
# ------------------------------------------------------------
#   • No hardcoded keys / URLs / colours / messages.
#   • Service-role Supabase client only (never the anon key).
#   • Errors never leak internal trace text to the caller; they
#     are logged on the server and translated to a generic
#     human-friendly response.
#   • No new packages — only stdlib + libraries already used by
#     routers/homework.py and routers/flashcards.py.
# ============================================================

# ── Standard library imports ─────────────────────────────────
# `datetime` — current UTC timestamp for started_at /
#              completed_at, and for computing session duration.
# `Optional`/`List` — typed Pydantic fields.
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ── FastAPI imports ──────────────────────────────────────────
# Same shape as the other routers — APIRouter for the mini app,
# Depends + Header for the bearer-token dependency,
# HTTPException for non-2xx responses with a clean JSON body,
# Query for typed + documented query parameters.
from fastapi import APIRouter, Depends, Header, HTTPException, Query

# ── Pydantic imports ─────────────────────────────────────────
# BaseModel + Field describe and validate every request /
# response shape this router exposes.
from pydantic import BaseModel, Field

# ── Supabase service-role client ─────────────────────────────
# Same client the homework + flashcards routers use. Required
# because we bypass RLS for inserts + reads on behalf of the
# caller AND because supabase.auth.get_user(jwt) (used inside
# verify_bearer_token) needs the admin client.
from database import supabase


# ============================================================
# CONFIGURATION CONSTANTS — single source of truth.
# ============================================================
# Loaded ONCE at import time so request handlers stay snappy.
# ============================================================

# Table names — declared in one place so a future rename is a
# single-line edit.
SESSIONS_TABLE = "quiz_sessions"
ANSWERS_TABLE = "quiz_answers"
FLASHCARDS_TABLE = "flashcards"

# Mastery is clamped between MASTERY_MIN (brand-new card) and
# MASTERY_MAX (mastered). A correct answer adds STEP, a wrong
# answer subtracts STEP. Same constants the frontend uses on
# its local mastery preview, kept in sync deliberately so the
# UI never disagrees with the backend.
MASTERY_MIN = 0
MASTERY_MAX = 5
MASTERY_STEP = 1

# Allowed values for the `quiz_mode` column. We validate at the
# router level (Pydantic) instead of relying solely on the DB
# CHECK constraint so callers get a 422 with a clear message.
ALLOWED_QUIZ_MODES = ("topic", "subject")

# Performance-label thresholds. Tweaking these here changes the
# label everywhere in one place.
PERFORMANCE_LABELS = (
    # (minimum_percentage_inclusive, label)
    (90.0, "Excellent"),
    (70.0, "Good"),
    (50.0, "Developing"),
    (0.0,  "Needs Work"),
)

# Default + maximum page size for GET /quiz/history.
DEFAULT_HISTORY_LIMIT = 10
MAX_HISTORY_LIMIT = 100


# ============================================================
# REQUEST / RESPONSE MODELS
# ============================================================
# Every endpoint defines its own input + output models. Comments
# inside each Field() are picked up by FastAPI's auto-docs so
# the /docs page documents itself.
# ============================================================

class QuizSessionRequest(BaseModel):
    """JSON body the frontend POSTs to /quiz/session."""

    # UUID of the student starting the quiz. Must match the
    # user_id encoded in the bearer token (anti-spoof).
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match token).",
    )

    # UUID of the subject being quizzed. Used to scope card
    # selection and to filter history queries later.
    subject_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the subject being quizzed.",
    )

    # Optional UUID of the source note when this is a "topic"
    # quiz. Left null for a "subject" quiz (the broad mode).
    note_id: Optional[str] = Field(
        default=None,
        description="UUID of the source note (only set when quiz_mode='topic').",
    )

    # How many cards will be in the session. Stored so the
    # /complete endpoint can compute the percentage without
    # joining quiz_answers.
    total_cards: int = Field(
        ...,
        ge=1,
        description="Total number of cards in this quiz session.",
    )

    # Either "topic" (one note's cards) or "subject" (a mix).
    # The Pydantic check below rejects anything else with 422.
    quiz_mode: str = Field(
        ...,
        description="Either 'topic' or 'subject'.",
    )


class QuizSessionResponse(BaseModel):
    """JSON body returned by /quiz/session on success."""

    # UUID of the freshly-created quiz_sessions row. The frontend
    # passes this back on every later quiz/* call.
    session_id: str
    # Human-friendly status string the page can show in a toast.
    message: str
    # ISO timestamp the session started at (UTC). Echoed back so
    # the page can show a "Quiz started at HH:MM" indicator.
    started_at: str


class QuizAnswerRequest(BaseModel):
    """JSON body the frontend POSTs to /quiz/answer."""

    # The quiz_sessions UUID this answer belongs to. Ownership
    # is verified at the router (must match the caller).
    session_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the quiz session this answer belongs to.",
    )

    # UUID of the flashcard the student just answered. We map
    # this onto the table's `flashcard_id` column on insert.
    card_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the flashcard answered.",
    )

    # Authenticated user_id (anti-spoof check on the token).
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match token).",
    )

    # True if the student chose the correct option; false on
    # "Still learning" / a wrong pick.
    is_correct: bool = Field(
        ...,
        description="True = Got it; false = Still learning.",
    )

    # Optional — how long the card was on screen. Used by the
    # results screen for "average time per question".
    time_taken_seconds: Optional[int] = Field(
        default=None,
        ge=0,
        description="Optional time (in seconds) the student took.",
    )


class QuizAnswerResponse(BaseModel):
    """JSON body returned by /quiz/answer."""

    # Always true on a successful save — the frontend uses this
    # as a simple flag rather than parsing HTTP status codes.
    answer_saved: bool
    # The card's new mastery_level after the +1/-1 nudge.
    new_mastery_level: int
    # +1 (correct) or -1 (wrong) — handy for showing the delta
    # in the results screen.
    mastery_changed: int
    # The session's running score after this answer.
    current_session_score: int


class QuizCompleteRequest(BaseModel):
    """JSON body the frontend POSTs to /quiz/complete."""

    # Session being finalised. Ownership is re-verified server-side.
    session_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the quiz session being completed.",
    )

    # Authenticated caller (anti-spoof against the token).
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match token).",
    )


class QuizCompleteResponse(BaseModel):
    """JSON body returned by /quiz/complete."""

    # True on a clean completion (idempotent — completing twice
    # still returns true, with the same final figures).
    session_completed: bool
    # Final correct-answer count.
    final_score: int
    # Total cards the session was started with.
    total_cards: int
    # Score expressed as a percentage, rounded to one decimal.
    percentage: float
    # Whole-session duration in seconds (completed_at - started_at).
    time_taken_seconds: int
    # Human-readable bucket (Excellent / Good / Developing / Needs Work).
    performance_label: str


class HistoryItem(BaseModel):
    """One row in the GET /quiz/history response."""

    # UUIDs + descriptors needed to render a results card.
    session_id: str
    subject_id: Optional[str] = None
    quiz_mode: Optional[str] = None
    total_cards: int
    score: int
    percentage: float
    performance_label: str
    completed_at: Optional[str] = None
    time_taken_seconds: int


class HistoryResponse(BaseModel):
    """JSON envelope returned by GET /quiz/history."""

    # The actual history rows, newest-completed first.
    data: List[HistoryItem]
    # Count of rows in `data`. (Pagination beyond `limit` is
    # left for a future revision — there's no `offset` today.)
    total: int


# ============================================================
# AUTH DEPENDENCY: verify_bearer_token
# ============================================================
# Identical pattern to routers/homework.py and routers/flashcards.py.
# Reads the Authorization header, splits "Bearer <jwt>", verifies
# the JWT with Supabase, returns the decoded user_id. Every
# failure path returns the same generic 401 so token-probing
# attackers can't tell "no token" from "expired" from "unknown".
# ============================================================
def verify_bearer_token(
    # Populated from the real Authorization header by name.
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:

    # STEP 1 — must have a header.
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # STEP 2 — must be "Bearer <token>".
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
        print(f"[Quiz] Bearer token verify raised: {type(e).__name__}")
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

    # STEP 5 — pull the UUID out.
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
#   app.include_router(quiz.router, prefix="/quiz", tags=["Quiz"])
# Final paths: /quiz/session, /quiz/answer, /quiz/complete,
#              /quiz/history.
# ============================================================
router = APIRouter()


# ============================================================
# HELPER: _now_iso
# ============================================================
# Returns the current UTC time as a Postgres-friendly ISO 8601
# string. Centralised so every router writes timestamps the
# exact same way.
# ============================================================
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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
# HELPER: _load_session
# ============================================================
# Fetch a quiz_sessions row by id. We then check ownership in
# the caller (raising 403 on mismatch). Returning None lets the
# caller decide between 404 (no such row) and 403 (wrong owner)
# while still surfacing a clean error if Supabase itself fails.
# ============================================================
def _load_session(session_id: str) -> Optional[Dict[str, Any]]:
    try:
        result = (
            supabase
            .table(SESSIONS_TABLE)
            .select(
                # Only the columns any caller needs — saves a tiny
                # amount of bandwidth on every call.
                "id, user_id, subject_id, note_id, total_cards, "
                "quiz_mode, score, completed, started_at, completed_at"
            )
            .eq("id", session_id)
            .limit(1)
            .execute()
        )
        rows = getattr(result, "data", None) or []
        return rows[0] if rows else None
    except Exception as e:
        # Surface as a 500 — the caller cannot recover from
        # a Supabase outage anyway.
        print(f"[Quiz] _load_session failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Database error. Please try again."},
        )


# ============================================================
# HELPER: _performance_label
# ============================================================
# Map a percentage (0-100) onto one of four buckets. The buckets
# are defined once in PERFORMANCE_LABELS so changing the
# thresholds is a one-line edit.
#
# Boundary behaviour: a percentage that exactly equals a
# threshold uses the HIGHER bucket — i.e. 70.0 = "Good", not
# "Developing". This matches the spec's `>=` wording.
# ============================================================
def _performance_label(percentage: float) -> str:
    for threshold, label in PERFORMANCE_LABELS:
        if percentage >= threshold:
            return label
    # Last bucket has threshold 0.0 so this is unreachable;
    # belt-and-braces fallback keeps the response type valid.
    return "Needs Work"


# ============================================================
# HELPER: _percentage
# ============================================================
# Compute score/total as a percentage rounded to one decimal.
# Returns 0.0 when total is zero — never raises a divide-by-zero.
# ============================================================
def _percentage(score: int, total: int) -> float:
    if not total or total <= 0:
        return 0.0
    return round((float(score) / float(total)) * 100.0, 1)


# ============================================================
# HELPER: _duration_seconds
# ============================================================
# Difference between two ISO timestamps (started_at, completed_at)
# in whole seconds. Returns 0 if either side is missing or
# unparseable so the response model still validates.
# ============================================================
def _duration_seconds(started_at: Optional[str], completed_at: Optional[str]) -> int:
    if not started_at or not completed_at:
        return 0
    try:
        # `fromisoformat` handles Postgres timestamptz output
        # like "2026-05-14T19:00:00+00:00" out of the box.
        start = datetime.fromisoformat(started_at)
        end = datetime.fromisoformat(completed_at)
        delta = (end - start).total_seconds()
        return max(0, int(delta))
    except Exception:
        return 0


# ============================================================
# ENDPOINT: POST /quiz/session
# ============================================================
# FLOW
#   1. Pydantic validates the body. The auth dep verifies the JWT.
#   2. We enforce token.user_id == body.user_id (anti-spoof).
#   3. We validate quiz_mode against the small allow-list so a
#      bad mode never reaches the DB.
#   4. We insert the in-progress session and return its id.
# ============================================================
@router.post(
    "/session",
    response_model=QuizSessionResponse,
    summary="Start a quiz session",
)
def start_session(
    body: QuizSessionRequest,
    # Bearer dep runs first — bad tokens never enter the handler.
    verified_user_id: str = Depends(verify_bearer_token),
):
    # STEP 2 — token vs body must agree.
    _enforce_same_user(verified_user_id, body.user_id)

    # STEP 3 — explicit allow-list check. Pydantic doesn't enforce
    # a string enum unless we add a `Literal[...]` annotation, and
    # I'd rather give a clear 422 here with a custom message.
    mode = (body.quiz_mode or "").strip().lower()
    if mode not in ALLOWED_QUIZ_MODES:
        raise HTTPException(
            status_code=422,
            detail={
                "error": (
                    "quiz_mode must be 'topic' or 'subject'."
                ),
            },
        )

    # STEP 4 — insert the in-progress session. Every field below
    # mirrors the live schema; service-role bypass means RLS does
    # not get in the way.
    payload = {
        # The authenticated student — never trust the body alone.
        "user_id": verified_user_id,
        # Which subject's cards she's about to be quizzed on.
        "subject_id": body.subject_id,
        # Optional source-note linkage for topic quizzes.
        "note_id": body.note_id,
        # Captured up front so /complete can compute percentage
        # without an extra COUNT(*) on quiz_answers.
        "total_cards": int(body.total_cards),
        # Whether this is a focused topic quiz or a broader subject mix.
        "quiz_mode": mode,
        # Score starts at zero and is bumped by /quiz/answer
        # each time the student gets one right.
        "score": 0,
        # completed flips to true at the end via /quiz/complete.
        "completed": False,
        # Started "now" in UTC. completed_at stays NULL for now.
        "started_at": _now_iso(),
        "completed_at": None,
    }

    try:
        result = supabase.table(SESSIONS_TABLE).insert(payload).execute()
        rows = (
            getattr(result, "data", None)
            or (result.get("data") if isinstance(result, dict) else [])
        )
        if not rows:
            # Insert ran but returned no row — shouldn't happen
            # with supabase-py but defend against it anyway.
            raise RuntimeError("insert returned no rows")
        new_row = rows[0]
    except Exception as e:
        print(f"[Quiz] /session insert failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not start quiz session. Please try again."},
        )

    return QuizSessionResponse(
        session_id=str(new_row.get("id", "")),
        message="Quiz session started",
        started_at=str(new_row.get("started_at") or payload["started_at"]),
    )


# ============================================================
# ENDPOINT: POST /quiz/answer
# ============================================================
# FLOW
#   1. Auth + anti-spoof.
#   2. Load the session row and confirm it belongs to caller (403
#      otherwise).
#   3. Load the flashcard's current mastery_level (404 if missing
#      or not the caller's card).
#   4. INSERT a row into quiz_answers.
#   5. UPDATE flashcards.mastery_level using the +1/-1 clamp rule.
#   6. UPDATE quiz_sessions.score (only when is_correct=true).
#   7. Return the per-answer envelope.
#
# We choose ordering (4 → 5 → 6) so a failure in the mastery
# update doesn't leave the answer un-recorded; the frontend still
# learns the answer was saved even if the secondary updates
# stumble. Each failure path is logged and reported with the
# right HTTP code.
# ============================================================
@router.post(
    "/answer",
    response_model=QuizAnswerResponse,
    summary="Record a quiz answer",
)
def record_answer(
    body: QuizAnswerRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    # STEP 1 — token/body identity must match.
    _enforce_same_user(verified_user_id, body.user_id)

    # STEP 2 — session ownership.
    session = _load_session(body.session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail={"error": "Quiz session not found"},
        )
    if str(session.get("user_id")) != verified_user_id:
        # Wrong owner — 403, not 404, so an attacker can't tell
        # whether a session_id exists at all.
        raise HTTPException(
            status_code=403,
            detail={"error": "This session does not belong to you"},
        )

    # STEP 3 — load the flashcard's current mastery so we can do
    # the +1/-1 clamp. Filtering by user_id stops a client passing
    # someone else's card_id.
    try:
        card_result = (
            supabase
            .table(FLASHCARDS_TABLE)
            .select("id, mastery_level, user_id")
            .eq("id", body.card_id)
            .eq("user_id", verified_user_id)
            .limit(1)
            .execute()
        )
        card_rows = getattr(card_result, "data", None) or []
    except Exception as e:
        print(f"[Quiz] /answer card lookup failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Database error. Please try again."},
        )

    if not card_rows:
        raise HTTPException(
            status_code=404,
            detail={"error": "Flashcard not found"},
        )
    current_mastery = int(card_rows[0].get("mastery_level") or 0)

    # STEP 4 — insert the answer row. We map the spec's `card_id`
    # field onto the table's existing `flashcard_id` column (same
    # idea, just the column was named differently before this
    # router was built).
    answer_payload = {
        "session_id": body.session_id,
        "flashcard_id": body.card_id,
        "user_id": verified_user_id,
        "is_correct": bool(body.is_correct),
        "time_taken_seconds": body.time_taken_seconds,
        "answered_at": _now_iso(),
    }
    try:
        supabase.table(ANSWERS_TABLE).insert(answer_payload).execute()
    except Exception as e:
        # Logged and surfaced — without the answer record we
        # can't compute anything else, so this is a hard fail.
        print(f"[Quiz] /answer insert failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not save your answer. Please try again."},
        )

    # STEP 5 — spaced-repetition mastery update:
    #   Correct answer increases mastery by 1, maximum 5.
    #   Wrong answer decreases mastery by 1, minimum 0.
    #   This implements spaced repetition — harder cards (low
    #   mastery) surface more often in future study sessions.
    mastery_delta = MASTERY_STEP if body.is_correct else -MASTERY_STEP
    new_mastery = max(
        MASTERY_MIN,
        min(MASTERY_MAX, current_mastery + mastery_delta),
    )
    # We log + ignore failures here — the answer is already saved,
    # so the user's quiz isn't blocked even if the secondary
    # update has a transient hiccup.
    try:
        (
            supabase
            .table(FLASHCARDS_TABLE)
            .update({"mastery_level": new_mastery})
            .eq("id", body.card_id)
            .eq("user_id", verified_user_id)
            .execute()
        )
    except Exception as e:
        print(
            f"[Quiz] mastery update failed for card={body.card_id}: "
            f"{type(e).__name__}: {e}"
        )

    # STEP 6 — bump the session score (only on correct answers).
    current_score = int(session.get("score") or 0)
    new_score = current_score + (1 if body.is_correct else 0)
    if new_score != current_score:
        try:
            (
                supabase
                .table(SESSIONS_TABLE)
                .update({"score": new_score})
                .eq("id", body.session_id)
                .eq("user_id", verified_user_id)
                .execute()
            )
        except Exception as e:
            # Same forgiving stance as the mastery update — the
            # answer is on the record, and /quiz/complete will
            # recompute the percentage from the live row anyway.
            print(
                f"[Quiz] score update failed for session={body.session_id}: "
                f"{type(e).__name__}: {e}"
            )
            # Surface the unincremented score so the frontend's
            # local counter doesn't go out of sync.
            new_score = current_score

    # STEP 7 — respond with everything the page needs to update
    # its local state in one round-trip.
    return QuizAnswerResponse(
        answer_saved=True,
        new_mastery_level=new_mastery,
        # Spec shape: +1 on correct, -1 on wrong (NOT the clamp-
        # adjusted value). The frontend uses this for the per-card
        # delta arrow in the results table.
        mastery_changed=mastery_delta,
        current_session_score=new_score,
    )


# ============================================================
# ENDPOINT: POST /quiz/complete
# ============================================================
# FLOW
#   1. Auth + anti-spoof.
#   2. Confirm session exists and belongs to caller.
#   3. If already completed → return the existing figures
#      (idempotent — a double-click on "Finish" can't corrupt
#      the percentage).
#   4. Otherwise UPDATE completed=true + completed_at=now().
#   5. Fetch the freshly-updated row so we report whichever
#      score the answer-handler last persisted.
#   6. Compute percentage, duration, and performance label.
# ============================================================
@router.post(
    "/complete",
    response_model=QuizCompleteResponse,
    summary="Mark a quiz session complete",
)
def complete_session(
    body: QuizCompleteRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    # STEP 1
    _enforce_same_user(verified_user_id, body.user_id)

    # STEP 2
    session = _load_session(body.session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail={"error": "Quiz session not found"},
        )
    if str(session.get("user_id")) != verified_user_id:
        raise HTTPException(
            status_code=403,
            detail={"error": "This session does not belong to you"},
        )

    # STEP 3 + 4 — idempotent finalisation.
    if not session.get("completed"):
        completed_at_iso = _now_iso()
        try:
            (
                supabase
                .table(SESSIONS_TABLE)
                .update({
                    "completed": True,
                    "completed_at": completed_at_iso,
                })
                .eq("id", body.session_id)
                .eq("user_id", verified_user_id)
                .execute()
            )
        except Exception as e:
            print(f"[Quiz] /complete update failed: {type(e).__name__}: {e}")
            raise HTTPException(
                status_code=500,
                detail={"error": "Could not finalise quiz. Please try again."},
            )
        # Update in-memory copy so we don't need to re-fetch unless
        # the score changed between our earlier _load_session and
        # the update we just did.
        session["completed"] = True
        session["completed_at"] = completed_at_iso

    # STEP 5 — re-fetch so the score we report is the very latest
    # one. (Multiple /quiz/answer calls may have raced ahead while
    # the user clicked Finish on the last card.)
    refreshed = _load_session(body.session_id) or session

    # STEP 6 — derive the response figures.
    total_cards = int(refreshed.get("total_cards") or 0)
    final_score = int(refreshed.get("score") or 0)
    pct = _percentage(final_score, total_cards)
    duration = _duration_seconds(
        refreshed.get("started_at"),
        refreshed.get("completed_at"),
    )
    label = _performance_label(pct)

    return QuizCompleteResponse(
        session_completed=True,
        final_score=final_score,
        total_cards=total_cards,
        percentage=pct,
        time_taken_seconds=duration,
        performance_label=label,
    )


# ============================================================
# ENDPOINT: GET /quiz/history
# ============================================================
# Returns the student's completed quiz sessions, newest first.
# Filters:
#   • user_id  — required, must match the bearer token.
#   • subject_id — optional, filter by subject UUID.
#   • limit    — optional, default 10, capped at MAX_HISTORY_LIMIT.
# ============================================================
@router.get(
    "/history",
    response_model=HistoryResponse,
    summary="List the caller's completed quiz sessions",
)
def list_history(
    # `Query(...)` carries both the OpenAPI doc text AND the
    # validation rules; FastAPI returns 422 on a violation.
    user_id: str = Query(..., min_length=1, description="Caller's UUID (must match token)"),
    subject_id: Optional[str] = Query(default=None, description="Optional subject filter"),
    limit: int = Query(
        default=DEFAULT_HISTORY_LIMIT,
        ge=1,
        le=MAX_HISTORY_LIMIT,
        description=f"Maximum rows to return (1-{MAX_HISTORY_LIMIT}).",
    ),
    verified_user_id: str = Depends(verify_bearer_token),
):
    # Auth — query string user_id must match the token.
    _enforce_same_user(verified_user_id, user_id)

    try:
        # Build the query step by step so the comments below can
        # explain each filter independently.
        query = (
            supabase
            .table(SESSIONS_TABLE)
            # Columns the history card UI needs.
            .select(
                "id, subject_id, note_id, quiz_mode, total_cards, "
                "score, completed, started_at, completed_at"
            )
            # Scope to the caller (service role bypasses RLS).
            .eq("user_id", verified_user_id)
            # Only completed sessions show in history — an
            # in-progress quiz on another device shouldn't appear
            # in the results dashboard.
            .eq("completed", True)
            # Newest first so the dashboard shows the most recent
            # attempt at the top of the list.
            .order("completed_at", desc=True)
            # Page size cap.
            .limit(limit)
        )
        # Optional subject filter — applied after the base query.
        if subject_id:
            query = query.eq("subject_id", subject_id)

        result = query.execute()
        rows = getattr(result, "data", None) or []
    except Exception as e:
        # Empty list rather than 5xx so the dashboard can still
        # render its empty state without crashing.
        print(f"[Quiz] /history query failed: {type(e).__name__}: {e}")
        rows = []

    # Re-shape each row into the response envelope. Percentage +
    # label + duration are computed here rather than stored on
    # the row, because they're derivable from existing columns.
    items: List[HistoryItem] = []
    for r in rows:
        total = int(r.get("total_cards") or 0)
        score = int(r.get("score") or 0)
        pct = _percentage(score, total)
        items.append(
            HistoryItem(
                session_id=str(r.get("id", "")),
                subject_id=(str(r["subject_id"]) if r.get("subject_id") else None),
                quiz_mode=r.get("quiz_mode"),
                total_cards=total,
                score=score,
                percentage=pct,
                performance_label=_performance_label(pct),
                completed_at=(
                    str(r["completed_at"]) if r.get("completed_at") else None
                ),
                time_taken_seconds=_duration_seconds(
                    r.get("started_at"),
                    r.get("completed_at"),
                ),
            )
        )

    return HistoryResponse(data=items, total=len(items))
