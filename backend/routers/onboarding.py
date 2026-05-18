# ============================================================
# ASCENDAI BACKEND — routers/onboarding.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# Every HTTP request that comes from the onboarding wizard
# (the five-step flow under app/onboarding/* on the frontend).
# Three endpoints live here:
#
#   POST /onboarding/profile
#     • Called when Step 3 (Study Hours) is completed.
#     • Upserts a row in the `profiles` table for the caller.
#     • If a row already exists for this user_id we UPDATE it;
#       otherwise we INSERT a new one. (One row per user.)
#     • Sets sensible defaults for any field the spec doesn't
#       hand us (google_classroom_connected=false,
#       ai_response_style="detailed").
#
#   POST /onboarding/exam-dates
#     • Called when Step 2 (Exam Dates) is completed.
#     • For each subject_code in the payload, sets the matching
#       row in the `subjects` table's `exam_date` column.
#     • Subjects is a SHARED tenant-wide table (no user_id),
#       so this UPDATE is per-code, not per-user.
#     • Returns how many subjects were successfully updated.
#
#   GET /onboarding/profile/check
#     • Used by the Dashboard's "safety net" — confirms
#       whether the caller's profile row already exists.
#     • Returns { profile_exists: true | false }.
#
# WHY THIS ROUTER EXISTS (THE BUG IT FIXES)
# ------------------------------------------------------------
# Before this router, onboarding wrote everything to
# localStorage only. The Timetable endpoint
# (/timetable/generate) needs to read the student's
# `study_start_time` + `study_end_time` from the `profiles`
# table — so for any user who completed onboarding but had
# no profile row, Timetable returned 404 "Profile not found".
# This router closes that loop: every onboarding step that
# captures profile-shaped data now writes through to Supabase
# in addition to localStorage.
#
# ⚠ LIVE-SCHEMA NOTES — confirmed by probe on 2026-05-14
# ------------------------------------------------------------
# `profiles` columns (from a live row):
#   id, user_id, full_name, email,
#   google_classroom_connected (bool),
#   study_start_time (time, stored as 'HH:MM:SS'),
#   study_end_time   (time, stored as 'HH:MM:SS'),
#   ai_response_style (text, e.g. 'detailed'),
#   created_at, updated_at.
# Note: Postgres' time column happily accepts the 'HH:MM' shape
# that a browser <input type="time"> produces, so we send the
# value through verbatim and let Postgres coerce.
#
# `subjects` columns we touch:
#   id, code (text — '9708', '9609', '9093', '9626'),
#   name, exam_date (nullable date), is_active.
# There is NO user_id column on `subjects` today — the table is
# shared across the (single) tenant.
#
# WHAT EXTERNAL SERVICES WE USE
# ------------------------------------------------------------
#   • Supabase Auth (admin) — JWT verification.
#   • Supabase Postgres     — profiles read/write,
#                             subjects read/update.
#
# PROJECT RULES THIS FILE OBEYS
# ------------------------------------------------------------
#   • No hardcoded keys, URLs, or values that belong in .env.
#   • Service-role Supabase client only (never the anon key).
#   • A failed Supabase call NEVER surfaces a stack trace to
#     the caller — internal errors are logged and translated
#     to a generic 500 with a friendly message.
#   • Onboarding writes never block the user — the frontend
#     is wired to swallow non-2xx responses (with a warning
#     log) and continue to the next step regardless.
#   • No new packages — only libraries the other routers
#     already use.
# ============================================================

# ── Standard library imports ─────────────────────────────────
# `Optional[X]` lets a Pydantic field be either X or None.
# `List` types the array on the exam-dates request payload.
from typing import List, Optional

# ── FastAPI imports ──────────────────────────────────────────
# APIRouter — the mini-FastAPI we attach to main.py via
# include_router(...). Depends + Header power our bearer-token
# verification dependency. HTTPException returns a clean JSON
# body with the right status code. Query lets us declare and
# validate the ?user_id= parameter on the profile-check route.
from fastapi import APIRouter, Depends, Header, HTTPException, Query

# ── Pydantic imports ─────────────────────────────────────────
# BaseModel + Field describe and auto-validate the JSON bodies
# the frontend sends and the responses we return. The text we
# put in Field(description=...) shows up in /docs.
from pydantic import BaseModel, Field

# NOTE on the email field type:
# The spec says `email` is a required string. We deliberately
# use plain `str` (not Pydantic's `EmailStr`) because EmailStr
# requires the optional `email-validator` package — and the
# project rule is "no new packages". The value the frontend
# sends comes straight from `session.user.email`, which
# Supabase Auth has already validated at signup, so a light
# in-endpoint check ("must contain an @") is enough.

# ── Supabase service-role client ─────────────────────────────
# Same shared instance every other router uses. Service-role
# is required because:
#   1. supabase.auth.get_user(jwt) verifies any user's token
#      (the anon client cannot do this).
#   2. We bypass RLS to insert/update rows on the caller's
#      behalf — auth is already proven via the verified
#      user_id we get back from get_user().
from database import supabase


# ============================================================
# CONFIGURATION CONSTANTS — single source of truth.
# ============================================================
# Table names declared at module level so a future rename is
# a one-line change.
# ============================================================

# The Supabase table we read + write profile rows from.
PROFILES_TABLE = "profiles"

# The Supabase table we update exam dates on.
SUBJECTS_TABLE = "subjects"

# Default value for `ai_response_style` when we create a new
# profile row. The frontend doesn't capture this during
# onboarding today; "detailed" matches the existing rows in
# the table and is what the rest of the app assumes.
DEFAULT_AI_RESPONSE_STYLE = "detailed"

# Default value for `google_classroom_connected`. The dedicated
# Connect-Google step in onboarding flips this to true on
# success; everyone else stays false.
DEFAULT_GOOGLE_CONNECTED = False


# ============================================================
# REQUEST / RESPONSE PYDANTIC MODELS
# ============================================================
# FastAPI uses these to:
#   1. Validate the JSON the frontend sends. Missing/invalid
#      values produce an automatic 422 with a helpful body.
#   2. Auto-generate the docs at /docs.
#   3. Coerce our return value into JSON.
# ============================================================

class OnboardingProfileRequest(BaseModel):
    """JSON body the frontend POSTs to /onboarding/profile."""

    # UUID of the signed-in user. Must equal the user_id
    # decoded from the bearer token — we reject any mismatch
    # with a 401 to prevent a logged-in user from writing on
    # someone else's behalf.
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match the token).",
    )

    # Full name shown across the app (header, dashboard
    # greeting, etc). We accept any non-empty string up to a
    # generous 200 chars — long enough for hyphenated double-
    # barrelled names, short enough to stop pathological input.
    full_name: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="Display name (e.g. 'Aryan Reddy').",
    )

    # Email address as Supabase Auth stored it. Kept as a
    # plain `str` — see the comment on the import block above
    # for why we don't use `EmailStr`. A trivial "contains @"
    # check happens inside the route body before we write the
    # value, so genuinely malformed values still error out.
    email: str = Field(
        ...,
        min_length=3,
        max_length=320,
        description="The caller's email (used for profile display).",
    )

    # Preferred study window start. HTML <input type="time">
    # produces the 'HH:MM' shape (24-hour). Postgres' `time`
    # column accepts both 'HH:MM' and 'HH:MM:SS' so we forward
    # the value as-is.
    study_start_time: str = Field(
        ...,
        min_length=4,
        max_length=8,
        description="Study window start in 24-hour 'HH:MM' format.",
    )

    # Preferred study window end. Same shape + reasoning as
    # study_start_time above.
    study_end_time: str = Field(
        ...,
        min_length=4,
        max_length=8,
        description="Study window end in 24-hour 'HH:MM' format.",
    )


class OnboardingProfileResponse(BaseModel):
    """JSON body returned by /onboarding/profile on success."""

    # True whenever the row was successfully inserted OR
    # updated. The frontend ignores this on failure (it always
    # navigates onward), but exposing it makes the route
    # introspectable from /docs and integration tests.
    profile_saved: bool

    # Friendly human-readable message the frontend can surface
    # in a toast if it ever wants to. Centralising the string
    # here keeps the wording consistent.
    message: str


class OnboardingExamDateEntry(BaseModel):
    """One subject_code → exam_date pair inside the exam-dates payload."""

    # Cambridge syllabus code (e.g. '9708' for Economics). We
    # match by code rather than name because codes are the
    # stable identifier the syllabus owns; names occasionally
    # drift between branding revisions.
    subject_code: str = Field(
        ...,
        min_length=1,
        max_length=10,
        description="Cambridge syllabus code (e.g. 9708).",
    )

    # ISO-formatted date string ('YYYY-MM-DD'). The HTML
    # <input type="date"> produces exactly this shape.
    exam_date: str = Field(
        ...,
        min_length=8,
        max_length=20,
        description="ISO date string for the exam ('YYYY-MM-DD').",
    )


class OnboardingExamDatesRequest(BaseModel):
    """JSON body the frontend POSTs to /onboarding/exam-dates."""

    # UUID of the signed-in user. Same identity check as the
    # profile route — we won't process the request unless the
    # bearer token matches this value.
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match the token).",
    )

    # Array of (subject_code, exam_date) pairs. May be empty
    # (the user might not know any dates yet); we just return
    # dates_saved=0 in that case rather than raising.
    exam_dates: List[OnboardingExamDateEntry] = Field(
        default_factory=list,
        description="One entry per subject the user filled a date for.",
    )


class OnboardingExamDatesResponse(BaseModel):
    """JSON body returned by /onboarding/exam-dates on success."""

    # How many of the supplied subject_codes were successfully
    # updated. Lets the frontend confirm "all four saved" if it
    # ever wants to surface that count to the user.
    dates_saved: int

    # Friendly message. Mirrors the profile route's shape.
    message: str


class OnboardingProfileCheckResponse(BaseModel):
    """JSON body returned by GET /onboarding/profile/check."""

    # Boolean flag the dashboard uses to decide whether to
    # fire the safety-net POST /onboarding/profile call. The
    # answer is "does a profiles row exist for this user_id?".
    profile_exists: bool


# ============================================================
# AUTH DEPENDENCY: verify_bearer_token
# ============================================================
# Identical contract to the dependency in routers/homework.py:
#   1. Reads the Authorization header.
#   2. Confirms the scheme is "Bearer ".
#   3. Extracts the raw JWT.
#   4. Calls supabase.auth.get_user(jwt) to verify + decode.
#   5. Returns the verified user_id (UUID as a string).
#
# Every failure mode returns the SAME generic 401 body
#   {"error": "Unauthorised — please log in"}
# so probing can't distinguish "expired" from "malformed" from
# "no header at all".
#
# Why duplicate this across routers instead of importing one
# helper? Lock-step with the existing project pattern — every
# router currently owns its own copy so a single router can be
# tightened (e.g. extra checks) without touching the others.
# ============================================================
def verify_bearer_token(
    # `Header(...)` pulls the value from the named HTTP header.
    # alias="Authorization" lets us keep the canonical title-
    # case spelling in OpenAPI docs (Python disallows dashes).
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:

    # --- STEP 1: the header has to exist. ------------------
    if not authorization:
        # 401 Unauthorised — caller supplied no token at all.
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 2: the scheme has to be "Bearer". ------------
    # split(maxsplit=1) yields at most two pieces so any extra
    # whitespace inside the token doesn't trip the parser.
    parts = authorization.split(maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 3: pull the actual JWT out. ------------------
    token = parts[1].strip()
    if not token:
        # Header was "Bearer " with no value after the space.
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 4: ask Supabase to verify the JWT. -----------
    # supabase.auth.get_user(jwt) raises on any invalid token
    # (expired / unknown / malformed). We catch broadly because
    # we don't care WHY it failed — only that it did.
    try:
        response = supabase.auth.get_user(token)
    except Exception as e:
        # Log so we can debug auth issues server-side without
        # leaking detail to the caller.
        print(f"[Onboarding] Bearer token verify raised: {type(e).__name__}")
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # Different supabase-py versions return either an object
    # with a `.user` attribute or a plain dict — handle both.
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

    # Always return a str so downstream code never has to think
    # about whether it got a UUID object vs a string.
    return str(user_id)


# ============================================================
# THE ROUTER
# ============================================================
# main.py mounts this at prefix "/onboarding", so the final
# paths become /onboarding/profile, /onboarding/exam-dates,
# and /onboarding/profile/check.
# ============================================================
router = APIRouter()


# ============================================================
# HELPER: _now_iso
# ============================================================
# Returns the current timestamp as an ISO-8601 string Postgres
# accepts for a `timestamptz` column. Importing it lazily here
# (rather than at module top) keeps the import list narrower
# for files that don't need it.
# ============================================================
def _now_iso() -> str:
    # Imported inside so the cost only lands when someone calls
    # the helper — keeps cold-start time identical to the
    # other routers, which don't pull datetime at module load.
    from datetime import datetime, timezone

    # `timezone.utc` so the value never carries the host's
    # local offset (the backend runs on UTC inside Docker /
    # Render; local dev on Windows could differ).
    return datetime.now(timezone.utc).isoformat()


# ============================================================
# ENDPOINT: POST /onboarding/profile
# ============================================================
# END-TO-END FLOW (what happens between request and response):
#   1. FastAPI validates the JSON body against
#      OnboardingProfileRequest. Missing / out-of-range fields
#      → automatic 422 with a helpful error message.
#   2. The verify_bearer_token dependency runs FIRST so any
#      unauthenticated request never reaches our route body.
#   3. We compare the verified user_id from the token against
#      body.user_id; mismatches return 401 (defence against a
#      client trying to write a row for another user).
#   4. We look up whether a row already exists for user_id.
#      • If yes — UPDATE the row with the new values.
#      • If no  — INSERT a fresh row.
#      Doing both branches manually (rather than using the
#      generic .upsert()) is what the spec asks for AND
#      avoids the on_conflict=user_id quirk we'd otherwise
#      need a unique index for.
#   5. Return { profile_saved: true, message: "..." }.
#
# A Supabase failure surfaces as a 500 with a generic message;
# the frontend swallows non-2xx responses, so the user is never
# blocked from completing onboarding.
# ============================================================
@router.post(
    "/profile",
    response_model=OnboardingProfileResponse,
    summary="Save the caller's onboarding profile (study hours + identity).",
)
def save_profile(
    body: OnboardingProfileRequest,
    # FastAPI evaluates the dependency BEFORE the route body —
    # so an invalid token returns 401 without ever touching
    # the database.
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: identity check. ──────────────────────────────
    # The token says the caller is user X. The body says we
    # should write for user Y. We REQUIRE X == Y so a logged-in
    # user cannot poison another user's profile row.
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # ── STEP 1b: light email shape check. ───────────────────
    # We don't run a full RFC-5322 validator (would need an
    # extra package); we only need to stop blatantly malformed
    # values that won't survive a future "send a reminder
    # email" feature. An "@" inside the string is sufficient
    # signal — Supabase Auth has already validated the address
    # against Google at signup, so this is just defence in
    # depth.
    if "@" not in body.email:
        raise HTTPException(
            status_code=422,
            detail={"error": "Email address looks invalid."},
        )

    # ── STEP 2: see whether the row already exists. ──────────
    # We could call `.upsert(... on_conflict="user_id")` but the
    # spec asks for explicit branching AND we get clearer logs
    # this way. Both code paths set the same column values.
    try:
        existing = (
            supabase
            .table(PROFILES_TABLE)
            # Only need `id` to know whether a row exists.
            .select("id")
            .eq("user_id", verified_user_id)
            .limit(1)
            .execute()
        )
        rows = getattr(existing, "data", None) or []
    except Exception as e:
        # Any DB hiccup → log + 500 with generic body. The
        # frontend swallows this without blocking onboarding.
        print(
            f"[Onboarding] profile existence check failed: "
            f"{type(e).__name__}: {e}"
        )
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not save profile. Please try again."},
        )

    # ── STEP 3: build the payload of values to write. ────────
    # Every column we touch is named here, with a short comment
    # describing why we set it to this value. created_at is
    # left out — Postgres populates it on INSERT via its
    # column default (now()).
    write_payload = {
        # user_id  — FK to auth.users.id. The unique identity
        # column on the profiles table; what every other table
        # joins back to.
        "user_id":                    verified_user_id,
        # full_name — what we render in the header + dashboard
        # greeting. Trimmed so trailing spaces don't sneak in.
        "full_name":                  body.full_name.strip(),
        # email     — Pydantic already shape-validated this.
        # We persist it for offline lookups (e.g. dashboard
        # "signed in as" caption when Supabase Auth lookups fail).
        "email":                      str(body.email).strip(),
        # study_start_time — 'HH:MM' from the time picker.
        # Postgres time column accepts it without coercion.
        "study_start_time":           body.study_start_time.strip(),
        # study_end_time   — same shape as start time.
        "study_end_time":             body.study_end_time.strip(),
        # google_classroom_connected — Step 4 of onboarding
        # flips this true on a successful OAuth handshake.
        # Until then, false is the safe default.
        "google_classroom_connected": DEFAULT_GOOGLE_CONNECTED,
        # ai_response_style — defaults to "detailed" because
        # every existing row uses that value and the rest of
        # the app expects one of the known styles.
        "ai_response_style":          DEFAULT_AI_RESPONSE_STYLE,
        # updated_at — refresh on every write so the most-
        # recent edit is queryable. Postgres `now()` would work
        # too, but supplying an explicit value keeps the
        # behaviour identical across drivers.
        "updated_at":                 _now_iso(),
    }

    # ── STEP 4: branch on existing vs new. ──────────────────
    try:
        if rows:
            # Row exists — UPDATE every column from the payload
            # except user_id (which is also our WHERE clause).
            # Pop it before the update so PostgREST doesn't
            # complain about a no-op set of the primary
            # identity column.
            update_payload = {k: v for k, v in write_payload.items() if k != "user_id"}
            result = (
                supabase
                .table(PROFILES_TABLE)
                .update(update_payload)
                .eq("user_id", verified_user_id)
                .execute()
            )
        else:
            # No row yet — INSERT a fresh one with the full
            # payload (user_id included this time).
            result = (
                supabase
                .table(PROFILES_TABLE)
                .insert(write_payload)
                .execute()
            )

        # Both .update() and .insert() return result.data with
        # the affected rows. Empty means the write silently
        # failed (RLS rejection, FK violation, etc).
        affected = getattr(result, "data", None) or []
        if not affected:
            # Logged so we can spot the cause server-side
            # (most likely RLS or a column constraint).
            print(
                "[Onboarding] profile write returned no rows; "
                "the row may have been rejected by RLS or a "
                "column constraint."
            )
            raise HTTPException(
                status_code=500,
                detail={"error": "Could not save profile. Please try again."},
            )

    except HTTPException:
        # Re-raise our own 4xx/5xx unchanged. The blanket
        # `except Exception` below would otherwise mask the
        # status code we deliberately picked.
        raise
    except Exception as e:
        # Any DB-side failure (network, FK, etc.) lands here.
        print(
            f"[Onboarding] profile {'update' if rows else 'insert'} "
            f"failed: {type(e).__name__}: {e}"
        )
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not save profile. Please try again."},
        )

    # ── STEP 5: success. ─────────────────────────────────────
    return OnboardingProfileResponse(
        profile_saved=True,
        message="Profile saved successfully",
    )


# ============================================================
# ENDPOINT: POST /onboarding/exam-dates
# ============================================================
# END-TO-END FLOW:
#   1. Validate the body shape (Pydantic) and the token
#      (verify_bearer_token).
#   2. Compare body.user_id against the verified user_id.
#      Mismatches → 401.
#   3. For each entry in body.exam_dates we run an UPDATE
#      against the `subjects` table where code = subject_code.
#      We do them ONE AT A TIME (rather than a single bulk
#      UPDATE) because Supabase's batch update API doesn't
#      support different SET values per row in one call — and
#      because per-row writes give us a clean per-subject
#      success count for the response.
#   4. Return how many subjects were successfully updated.
#
# IMPORTANT: `subjects` is a SHARED tenant-wide table — there
# is no user_id column today. So an exam date set by one user
# is visible to every user of the same tenant. That matches
# the spec (and the existing behaviour of the rest of the app);
# if multi-tenancy is added later this routine will need a
# user_subjects join table.
# ============================================================
@router.post(
    "/exam-dates",
    response_model=OnboardingExamDatesResponse,
    summary="Save the caller's exam dates into the shared subjects table.",
)
def save_exam_dates(
    body: OnboardingExamDatesRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: identity check. ──────────────────────────────
    # Same defence-in-depth check the profile endpoint does.
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # ── STEP 2: short-circuit on an empty payload. ───────────
    # Pydantic allows an empty list (the user might submit Step
    # 2 without filling any dates). We return 0 rather than
    # raising — that's still a successful no-op.
    if not body.exam_dates:
        return OnboardingExamDatesResponse(
            dates_saved=0,
            message="No exam dates were provided.",
        )

    # ── STEP 3: process each subject_code one at a time. ─────
    # We count successful updates so the response can confirm
    # how many of the four subjects were saved. A miss (subject
    # code that doesn't exist) is logged and skipped — we
    # never raise 404 from the loop because partial success is
    # the most useful outcome for the user.
    saved_count = 0
    unmatched_codes = []

    for entry in body.exam_dates:
        # Trim both fields so accidental whitespace doesn't
        # cause a no-match on the WHERE clause or send a
        # malformed date to Postgres.
        code = entry.subject_code.strip()
        date_value = entry.exam_date.strip()

        # Skip silently if either field is empty after trimming.
        # Pydantic already enforces non-empty + length bounds,
        # but defence-in-depth here costs nothing.
        if not code or not date_value:
            continue

        try:
            # The UPDATE: sets exam_date and user_id for the row whose code matches.
            result = (  # Supabase client returns affected rows under .data
                supabase  # Service-role client from database.py (shared across routers)
                .table(SUBJECTS_TABLE)  # Constant "subjects" — one UPDATE per payload entry
                .update({  # Only these columns are written; other columns stay unchanged
                    # exam_date — ISO date string from the date picker
                    "exam_date": date_value,
                    # user_id — now saved per user so each user has
                    # their own exam dates and they don't overwrite
                    # each other
                    "user_id": verified_user_id,
                })
                .eq("code", code)  # WHERE syllabus code matches this loop's trimmed subject_code
                .execute()  # Run the PostgREST UPDATE and wait for the HTTP response
            )
            affected = getattr(result, "data", None) or []  # Normalise to list of updated rows (may be empty)

            if affected:
                # Bump the success counter for each row we
                # successfully updated (typically 1).
                saved_count += len(affected)
            else:
                # Code matched no row — log + collect for the
                # final response message. NOT raised because we
                # want partial success to flow through.
                unmatched_codes.append(code)
                print(
                    "[Onboarding] exam-date update matched 0 rows "
                    f"for subject_code={code!r}; subject may be "
                    "missing from the table."
                )
        except Exception as e:
            # Any per-row DB failure → log + skip. The loop
            # keeps going so one bad row doesn't kill the rest.
            print(
                f"[Onboarding] exam-date update failed for "
                f"subject_code={code!r}: {type(e).__name__}: {e}"
            )
            unmatched_codes.append(code)

    # ── STEP 4: build the message — communicates partial wins. ─
    if saved_count == 0 and unmatched_codes:
        # Nothing saved AND every code missed → that's worth a
        # clearer message so the frontend can warn the user.
        # We still return 200 (not 404) because the request
        # itself was valid; the data just didn't match.
        message = (
            "None of the provided subject codes matched a row in the "
            "subjects table."
        )
    elif unmatched_codes:
        # Partial success — call it out so the user can fix
        # the wrong code on their next visit.
        message = (
            f"Saved {saved_count} exam date(s); "
            f"unrecognised codes: {', '.join(unmatched_codes)}."
        )
    else:
        # Every code matched and saved. Mirror the profile
        # endpoint's wording so toasts look uniform.
        message = "Exam dates saved successfully"

    return OnboardingExamDatesResponse(
        dates_saved=saved_count,
        message=message,
    )


# ============================================================
# ENDPOINT: GET /onboarding/profile/check
# ============================================================
# The dashboard calls this on every load as a safety net:
#   • If the profile exists → do nothing (fast path).
#   • If it does not exist → silently POST a default profile
#     using the user's auth metadata. This protects users who
#     completed onboarding before the Supabase write was wired
#     up, OR whose write failed mid-flow (network blip etc.).
#
# We require a bearer token AND we still require user_id to
# match the verified token, so this endpoint cannot be used as
# a "does this UUID have an account?" probe by anyone other
# than the user themselves.
# ============================================================
@router.get(
    "/profile/check",
    response_model=OnboardingProfileCheckResponse,
    summary="Check whether the caller's profile row exists.",
)
def check_profile(
    # Pulled from the URL query string ?user_id=...
    # Pydantic-style Query() ensures a missing parameter
    # returns 422 (not a silent default).
    user_id: str = Query(
        ...,
        min_length=1,
        description="UUID of the user whose profile we're checking.",
    ),
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: identity check. ──────────────────────────────
    # Same defence-in-depth used by the other two routes. Even
    # a read endpoint must not leak whether a user_id has a
    # profile to anyone other than that user themselves.
    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # ── STEP 2: probe Supabase for ONE row. ─────────────────
    # `limit(1)` keeps the response tiny — we only need to
    # know "exists" / "doesn't exist". We DO NOT use
    # count="exact" here because PostgREST's HEAD probe is
    # slower than a simple limited select for this use case.
    try:
        result = (
            supabase
            .table(PROFILES_TABLE)
            # Only need a single column to test existence.
            .select("id")
            .eq("user_id", verified_user_id)
            .limit(1)
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception as e:
        # Any DB hiccup → log + return profile_exists=false so
        # the dashboard's safety-net code path still runs. We
        # don't want a transient outage to permanently disable
        # the safety net.
        print(
            f"[Onboarding] profile/check probe failed: "
            f"{type(e).__name__}: {e}"
        )
        return OnboardingProfileCheckResponse(profile_exists=False)

    # ── STEP 3: report. ──────────────────────────────────────
    # `rows` is empty when no profile exists yet; non-empty
    # when it does. Coerce to a plain bool for the response.
    return OnboardingProfileCheckResponse(profile_exists=bool(rows))
