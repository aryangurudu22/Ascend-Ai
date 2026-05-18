# ============================================================
# ASCENDAI BACKEND — routers/notes.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# The Note Summariser feature — everything n8n and the Notes
# page need to turn Google Classroom posts into study notes.
#
#   POST /notes/summarise
#     • Receives raw post content from n8n (text, YouTube URL,
#       Drive link, or pre-extracted PDF text).
#     • Optionally fetches a YouTube transcript.
#     • Asks Groq (LLaMA-3.3 70B) for a Cambridge-style title
#       and structured summary + key points.
#     • Saves the row to the `notes` table in Supabase.
#
#   POST /notes/sync
#     • Triggers the n8n workflow that polls Google Classroom.
#     • Gracefully no-ops when N8N_WEBHOOK_URL is not set yet.
#
#   POST /notes/trigger-sync
#     • Internal n8n cron — loops all user_profiles and syncs each.
#     • No auth — uses service-role Supabase client from database.py.
#
#   GET /notes/list
#     • Returns paginated notes for the signed-in student,
#       with subject name + code joined from `subjects`.
#
#   GET /classroom/posts  (mounted at /classroom via main.py)
#     • Reads stored Google tokens from `profiles`.
#     • Fetches active Classroom courses + recent announcements.
#
# WHAT TABLE WE WRITE TO
# ------------------------------------------------------------
# • `notes` — id, user_id, subject_id, google_post_id, title,
#             summary, key_points, created_at, updated_at
#
# WHAT EXTERNAL SERVICES WE USE
# ------------------------------------------------------------
#   • Groq — title generation + summarisation.
#   • Supabase Auth (admin) — JWT verification via service role.
#   • Supabase Postgres — read subjects, read/write notes.
#   • youtube-transcript-api — optional transcript for YouTube posts.
#   • httpx — optional POST to n8n webhook on manual sync.
# ============================================================

import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from database import supabase

# ============================================================
# CONFIGURATION CONSTANTS
# ============================================================

# Groq model — same as homework / flashcards / past papers.
GROQ_MODEL = "llama-3.3-70b-versatile"

# Max tokens for the main summarise call (3-4 paragraphs + key points).
GROQ_SUMMARISE_MAX_TOKENS = 2048

# Max tokens for the quick title-only call when no title_hint.
GROQ_TITLE_MAX_TOKENS = 50

# Temperature — lower = more consistent Cambridge phrasing.
GROQ_TEMPERATURE = 0.3

# Table names — single place to rename later.
NOTES_TABLE = "notes"
SUBJECTS_TABLE = "subjects"
PROFILES_TABLE = "profiles"
USER_PROFILES_TABLE = "user_profiles"
CLASSROOM_POSTS_TABLE = "google_classroom_posts"

# Google OAuth client credentials — from backend/.env.
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID") or ""
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET") or ""

# Google access tokens expire after one hour (seconds).
GOOGLE_ACCESS_TOKEN_SECONDS = 3600

# Allowed source_type values from n8n / Classroom.
ALLOWED_SOURCE_TYPES = ("text", "youtube", "drive", "pdf")

# YouTube transcript cap — keeps Groq prompts within budget.
MAX_YOUTUBE_WORDS = 4000

# How much content we send to the quick title Groq call.
MAX_TITLE_CONTENT_WORDS = 500

# n8n webhook URL — empty until n8n is deployed (see backend/.env).
N8N_WEBHOOK_URL = os.getenv("N8N_WEBHOOK_URL") or ""

# Regex patterns for common YouTube URL shapes.
_YOUTUBE_WATCH_RE = re.compile(
    r"(?:youtube\.com/watch\?v=|youtube\.com/watch\?.+&v=)([A-Za-z0-9_-]{11})",
    re.IGNORECASE,
)
_YOUTUBE_SHORT_RE = re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})", re.IGNORECASE)
_YOUTUBE_EMBED_RE = re.compile(
    r"youtube\.com/embed/([A-Za-z0-9_-]{11})", re.IGNORECASE
)

router = APIRouter()

# Separate router so main.py can mount GET /classroom/posts exactly
# as specified (prefix="/classroom") while note CRUD stays on /notes.
classroom_router = APIRouter()


# ============================================================
# PYDANTIC MODELS — request / response shapes
# ============================================================


class NotesSummariseRequest(BaseModel):
    # UUID of the student who owns this note.
    user_id: str = Field(..., description="UUID of the student")
    # UUID from the subjects table (Economics, Business, etc.).
    subject_id: str = Field(..., description="UUID of the subject")
    # How the Classroom post arrived: text | youtube | drive | pdf.
    source_type: str = Field(..., description="text, youtube, drive, or pdf")
    # Raw payload: post text, YouTube URL, Drive URL, or PDF text.
    raw_content: str = Field(..., description="Raw post content from Classroom")
    # Optional Classroom post id — used to skip duplicate inserts.
    google_post_id: Optional[str] = Field(
        default=None, description="Google Classroom post id for deduplication"
    )
    # Optional subject line from Classroom — skips Groq title call.
    title_hint: Optional[str] = Field(
        default=None, description="Suggested title from Classroom subject line"
    )


class NotesSummariseResponse(BaseModel):
    note_id: Optional[str] = None
    title: Optional[str] = None
    summary_preview: Optional[str] = None
    key_points_count: Optional[int] = None
    source_type: Optional[str] = None
    duplicate: bool = False
    message: Optional[str] = None


class NotesSyncRequest(BaseModel):
    # UUID of the student requesting a manual Classroom sync.
    user_id: str = Field(..., description="UUID of the student")


class NotesSyncResponse(BaseModel):
    synced: bool
    message: str
    note: Optional[str] = None


class NotesTriggerSyncResponse(BaseModel):
    # Number of users whose Classroom sync webhook succeeded.
    triggered: int
    # Number of users skipped or failed (no tokens, refresh error, webhook error).
    errors: int
    # Total user_id rows returned from user_profiles.
    total_users: int


class NoteListItem(BaseModel):
    id: str
    user_id: str
    subject_id: str
    subject_name: str
    subject_code: str
    title: str
    summary: str
    key_points: List[str]
    created_at: str


class NotesListResponse(BaseModel):
    data: List[NoteListItem]
    total: int


# ============================================================
# AUTH DEPENDENCY: verify_bearer_token
# ============================================================
# Same five-step flow as routers/homework.py — keeps every
# feature's auth behaviour identical for the frontend.
# ============================================================
def verify_bearer_token(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:
    # Step 1 — header must exist.
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # Step 2 — scheme must be Bearer.
    parts = authorization.split(maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    token = parts[1].strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    try:
        response = supabase.auth.get_user(token)
    except Exception as e:
        print(f"[Notes] Bearer token verify raised: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        ) from e

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
# HELPER: _now_iso
# ============================================================
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ============================================================
# HELPER: _is_valid_uuid
# ============================================================
# The live `notes.google_post_id` column is UUID-typed. Classroom
# ids from n8n may not always be UUIDs — we only store/check when
# the value parses cleanly so Supabase never throws 22P02.
# ============================================================
def _is_valid_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value).strip())
        return True
    except (ValueError, AttributeError, TypeError):
        return False


# ============================================================
# HELPER: _resolve_google_post_id
# ============================================================
# notes.google_post_id FK → google_classroom_posts.id. n8n must
# create the classroom row first; if the id is missing we store
# NULL so the summarise still succeeds.
# ============================================================
def _resolve_google_post_id(post_id_raw: str) -> Optional[str]:
    candidate = (post_id_raw or "").strip()
    if not candidate or not _is_valid_uuid(candidate):
        return None
    try:
        lookup = (
            supabase.table(CLASSROOM_POSTS_TABLE)
            .select("id")
            .eq("id", candidate)
            .limit(1)
            .execute()
        )
        rows = getattr(lookup, "data", None) or []
        if rows:
            return candidate
    except Exception as e:
        print(
            f"[Notes] google_classroom_posts lookup failed: "
            f"{type(e).__name__}: {e}"
        )
    print(
        f"[Notes] google_post_id {candidate!r} not in "
        f"{CLASSROOM_POSTS_TABLE} — saving note without FK link."
    )
    return None


# ============================================================
# HELPER: _limit_words
# ============================================================
# Truncates long strings so Groq prompts stay within limits.
# ============================================================
def _limit_words(text: str, max_words: int) -> str:
    words = (text or "").split()
    if len(words) <= max_words:
        return (text or "").strip()
    return " ".join(words[:max_words]).strip()


# ============================================================
# HELPER: _extract_youtube_video_id
# ============================================================
def _extract_youtube_video_id(url: str) -> Optional[str]:
    raw = (url or "").strip()
    if not raw:
        return None
    for pattern in (_YOUTUBE_WATCH_RE, _YOUTUBE_SHORT_RE, _YOUTUBE_EMBED_RE):
        match = pattern.search(raw)
        if match:
            return match.group(1)
    return None


# ============================================================
# HELPER: extract_content
# ============================================================
# Turns raw Classroom payload into plain text for Groq.
# Returns (content_text, youtube_transcript_unavailable).
# ============================================================
def extract_content(source_type: str, raw_content: str) -> Tuple[str, bool]:
    st = (source_type or "").strip().lower()
    raw = (raw_content or "").strip()
    youtube_failed = False

    # Plain text posts are used as-is — no extra processing.
    if st == "text":
        return (raw, False)

    # YouTube — pull transcript when possible; never block the request.
    if st == "youtube":
        video_id = _extract_youtube_video_id(raw)
        if not video_id:
            # Could not parse an id — fall back to the URL string.
            return (raw, True)

        try:
            # v1.x API uses .fetch(); older docs used get_transcript().
            from youtube_transcript_api import YouTubeTranscriptApi

            fetched = YouTubeTranscriptApi().fetch(video_id)
            pieces = []
            for snippet in fetched:
                piece = getattr(snippet, "text", None) or ""
                if piece:
                    pieces.append(str(piece).strip())
            transcript_text = " ".join(pieces).strip()
            if transcript_text:
                return (_limit_words(transcript_text, MAX_YOUTUBE_WORDS), False)
        except Exception as e:
            print(
                f"[Notes] YouTube transcript unavailable for {video_id!r}: "
                f"{type(e).__name__}: {e}"
            )
            youtube_failed = True

        # Transcript missing — continue with URL so Groq still runs.
        return (raw, youtube_failed)

    # TODO: Google Drive API integration — for now uses raw content passed by n8n.
    if st == "drive":
        return (raw, False)

    # PDF text is pre-extracted before calling this endpoint.
    if st == "pdf":
        return (raw, False)

    return (raw, False)


# ============================================================
# HELPER: _parse_groq_json
# ============================================================
# Three-attempt JSON parse — same pattern as past_papers.py.
# ============================================================
def _parse_groq_json(raw: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not raw:
        return (None, "Empty response from Groq.")

    text = raw.strip()

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return (parsed, None)
    except json.JSONDecodeError:
        pass

    fenced = text
    if fenced.startswith("```"):
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

    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return (parsed, None)
        except json.JSONDecodeError:
            pass

    return (None, "Could not parse Groq response as JSON.")


# ============================================================
# HELPER: get_title_prompt
# ============================================================
def get_title_prompt(subject_name: str, content_sample: str) -> str:
    subj = (subject_name or "the subject").strip()
    sample = _limit_words(content_sample or "", MAX_TITLE_CONTENT_WORDS)
    return (
        f"Generate a concise Cambridge AS Level note title (max 8 words) "
        f"for this content about {subj}.\n"
        f"Return ONLY the title, nothing else. No punctuation at end.\n\n"
        f"Content:\n{sample}"
    )


# ============================================================
# HELPER: get_summarise_system_prompt
# ============================================================
def get_summarise_system_prompt(
    subject_name: str, subject_code: str, source_type: str
) -> str:
    subj = (subject_name or "the subject").strip()
    code = (subject_code or "").strip()
    src = (source_type or "text").strip()
    return (
        "You are an expert Cambridge AS Level tutor creating structured "
        "study notes for a student in Zambia, Southern Africa.\n\n"
        f"Subject: {subj} ({code})\n"
        f"Source: {src} post from Google Classroom\n\n"
        "Read the content carefully and create a comprehensive study note.\n\n"
        "Return ONLY a valid JSON object. No introduction. No markdown.\n\n"
        "Format:\n"
        "{\n"
        '  "title": "Concise Cambridge AS Level topic title (max 8 words)",\n'
        '  "summary": "Write 3-4 comprehensive paragraphs summarising the '
        "key content. Use Cambridge AS Level academic language. "
        "Reference relevant Cambridge syllabus concepts by name. "
        "Include real-world examples where relevant. "
        "Write in plain sentences — no markdown symbols, no bullet "
        'points, no hashtags.",\n'
        '  "key_points": [\n'
        '    "First key point as a complete sentence",\n'
        '    "Second key point as a complete sentence",\n'
        '    "Third key point as a complete sentence",\n'
        '    "Fourth key point as a complete sentence",\n'
        '    "Fifth key point as a complete sentence"\n'
        "  ]\n"
        "}\n\n"
        "Rules:\n"
        "- summary must be 3-4 full paragraphs of academic prose\n"
        "- key_points must be exactly 5-7 items\n"
        "- Each key_point is one complete, exam-relevant sentence\n"
        "- No markdown symbols anywhere\n"
        "- No bullet points inside summary\n"
        "- Title must be specific to the Cambridge topic covered"
    )


# ============================================================
# HELPER: _fetch_subject_row
# ============================================================
def _fetch_subject_row(subject_id: str) -> Optional[Dict[str, Any]]:
    try:
        result = (
            supabase.table(SUBJECTS_TABLE)
            .select("id, name, code")
            .eq("id", subject_id)
            .limit(1)
            .execute()
        )
        rows = getattr(result, "data", None) or []
        return rows[0] if rows else None
    except Exception as e:
        print(f"[Notes] Subject lookup failed: {type(e).__name__}: {e}")
        return None


# ============================================================
# HELPER: _call_groq_text
# ============================================================
def _call_groq_text(
    system_prompt: str,
    user_content: str,
    max_tokens: int,
    json_mode: bool = False,
) -> str:
    try:
        from main import groq_client  # noqa: WPS433
    except Exception as e:
        print(f"[Notes] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service is temporarily unavailable. Please try again."},
        ) from e

    try:
        create_kwargs: Dict[str, Any] = {
            "model": GROQ_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "max_tokens": max_tokens,
            "temperature": GROQ_TEMPERATURE,
        }
        if json_mode:
            create_kwargs["response_format"] = {"type": "json_object"}
        completion = groq_client.chat.completions.create(**create_kwargs)
        return (completion.choices[0].message.content or "").strip()
    except Exception as e:
        print(f"[Notes] Groq call failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service is temporarily unavailable. Please try again."},
        ) from e


# ============================================================
# HELPER: _call_groq_summarise
# ============================================================
# Tries JSON mode first (reliable structure). If Groq cannot
# finish a valid JSON document within the token cap, retries
# once without JSON mode and lets _parse_groq_json salvage it.
# ============================================================
def _call_groq_summarise(system_prompt: str, user_content: str) -> str:
    try:
        return _call_groq_text(
            system_prompt=system_prompt,
            user_content=user_content,
            max_tokens=GROQ_SUMMARISE_MAX_TOKENS,
            json_mode=True,
        )
    except HTTPException as first_err:
        detail = getattr(first_err, "detail", None)
        if not isinstance(detail, dict):
            raise
        print("[Notes] JSON-mode summarise failed — retrying without JSON mode.")
        return _call_groq_text(
            system_prompt=system_prompt,
            user_content=user_content,
            max_tokens=GROQ_SUMMARISE_MAX_TOKENS,
            json_mode=False,
        )


# ============================================================
# HELPER: _normalise_subject_fields
# ============================================================
def _normalise_subject_fields(
    nested: Any,
) -> Tuple[str, str]:
    if isinstance(nested, dict):
        return (
            str(nested.get("name") or "").strip(),
            str(nested.get("code") or "").strip(),
        )
    return ("", "")


# ============================================================
# ENDPOINT: POST /notes/summarise
# ============================================================
@router.post(
    "/summarise",
    response_model=NotesSummariseResponse,
    summary="Summarise a Google Classroom post into a study note",
)
def summarise_note(
    body: NotesSummariseRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    # Identity check — body user must match the JWT subject.
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    source_type = (body.source_type or "").strip().lower()
    if source_type not in ALLOWED_SOURCE_TYPES:
        allowed = ", ".join(ALLOWED_SOURCE_TYPES)
        raise HTTPException(
            status_code=422,
            detail={
                "error": (
                    f"Invalid source_type '{body.source_type}'. "
                    f"Must be one of: {allowed}"
                )
            },
        )

    # STEP 1 — duplicate check when google_post_id is present.
    # Prevents creating duplicate notes from the same Classroom post.
    post_id_raw = (body.google_post_id or "").strip()
    post_id = _resolve_google_post_id(post_id_raw) or ""
    if post_id:
        try:
            dup_result = (
                supabase.table(NOTES_TABLE)
                .select("id")
                .eq("google_post_id", post_id)
                .eq("user_id", verified_user_id)
                .limit(1)
                .execute()
            )
            dup_rows = getattr(dup_result, "data", None) or []
            if dup_rows:
                existing_id = str(dup_rows[0].get("id", ""))
                return NotesSummariseResponse(
                    message="Note already exists for this post",
                    note_id=existing_id,
                    duplicate=True,
                )
        except Exception as e:
            print(f"[Notes] Duplicate check failed: {type(e).__name__}: {e}")

    # STEP 2 — extract plain text from the raw payload.
    content_text, _youtube_fallback = extract_content(source_type, body.raw_content)
    if not content_text:
        raise HTTPException(
            status_code=422,
            detail={"error": "raw_content is empty after extraction."},
        )

    # STEP 3 — resolve subject name + code for Groq prompts.
    subject_row = _fetch_subject_row(body.subject_id.strip())
    if not subject_row:
        raise HTTPException(
            status_code=404,
            detail={"error": "Subject not found"},
        )
    subject_name = str(subject_row.get("name") or "").strip()
    subject_code = str(subject_row.get("code") or "").strip()

    # STEP 4 — title: use Classroom hint or quick Groq title call.
    title_hint = (body.title_hint or "").strip()
    generated_title = ""
    if title_hint:
        # Use the hint from Classroom post subject line — skip Groq title call.
        final_title = title_hint
    else:
        title_prompt = get_title_prompt(subject_name, content_text)
        generated_title = _call_groq_text(
            system_prompt="You generate short academic note titles only.",
            user_content=title_prompt,
            max_tokens=GROQ_TITLE_MAX_TOKENS,
        )
        final_title = generated_title.strip() or "Study Note"

    # STEP 5 — main Groq summarise call.
    system_prompt = get_summarise_system_prompt(
        subject_name, subject_code, source_type
    )
    raw_summary = _call_groq_summarise(system_prompt, content_text)

    # STEP 6 — parse JSON from Groq (three attempts inside helper).
    parsed, parse_err = _parse_groq_json(raw_summary)
    if parsed is None:
        print(f"[Notes] Summarise parse failed: {parse_err}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate note summary. Please try again."},
        )

    summary = (parsed.get("summary") or "").strip()
    key_points_raw = parsed.get("key_points")
    key_points: List[str] = []
    if isinstance(key_points_raw, list):
        key_points = [
            str(p).strip() for p in key_points_raw if str(p or "").strip()
        ]
    elif isinstance(key_points_raw, str) and key_points_raw.strip():
        key_points = [
            line.strip()
            for line in re.split(r"[\n;]+", key_points_raw)
            if line.strip()
        ]

    groq_title = (parsed.get("title") or "").strip()
    if title_hint:
        final_title = title_hint
    elif generated_title:
        final_title = generated_title.strip()
    elif groq_title:
        final_title = groq_title
    else:
        final_title = "Study Note"

    if not summary:
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate note summary. Please try again."},
        )

    # STEP 7 — insert into Supabase notes table.
    now = _now_iso()
    insert_payload: Dict[str, Any] = {
        "user_id": verified_user_id,
        "subject_id": body.subject_id.strip(),
        "google_post_id": post_id if post_id else None,
        "title": final_title,
        "summary": summary,
        "key_points": key_points,
        "created_at": now,
        "updated_at": now,
    }

    try:
        insert_result = (
            supabase.table(NOTES_TABLE).insert(insert_payload).execute()
        )
        inserted = getattr(insert_result, "data", None) or []
        if not inserted:
            raise RuntimeError("Insert returned no rows.")
        saved = inserted[0]
        note_id = str(saved.get("id", ""))
    except Exception as e:
        print(f"[Notes] Supabase insert failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not save note. Please try again."},
        ) from e

    preview = summary[:200]
    return NotesSummariseResponse(
        note_id=note_id,
        title=final_title,
        summary_preview=preview,
        key_points_count=len(key_points),
        source_type=source_type,
        duplicate=False,
    )


# ============================================================
# ENDPOINT: POST /notes/sync
# ============================================================
@router.post(
    "/sync",
    response_model=NotesSyncResponse,
    summary="Trigger Google Classroom sync via n8n webhook",
)
async def sync_notes(
    body: NotesSyncRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    webhook = (N8N_WEBHOOK_URL or "").strip()

    if webhook:
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    webhook,
                    json={
                        "user_id": verified_user_id,
                        "triggered_by": "manual_sync",
                    },
                    timeout=10.0,
                )
            if response.is_success:
                return NotesSyncResponse(
                    synced=True,
                    message=(
                        "Sync triggered — checking Google Classroom for new posts."
                    ),
                )
            print(
                f"[Notes] n8n webhook returned HTTP {response.status_code}: "
                f"{response.text[:200]!r}"
            )
            return NotesSyncResponse(
                synced=False,
                message="Sync requested but webhook returned an error.",
                note="Partial success — try again shortly.",
            )
        except Exception as e:
            print(f"[Notes] n8n webhook call failed: {type(e).__name__}: {e}")
            return NotesSyncResponse(
                synced=False,
                message="Sync requested but webhook call failed.",
                note="Partial success — try again shortly.",
            )

    # Graceful fallback when n8n is not yet connected.
    return NotesSyncResponse(
        synced=False,
        message=(
            "Sync triggered. Google Classroom polling will begin shortly."
        ),
        note=(
            "n8n webhook not configured yet — will activate when n8n is deployed"
        ),
    )


# ============================================================
# HELPER: _fetch_all_user_profile_ids — all students for n8n cron
# ============================================================
def _fetch_all_user_profile_ids() -> List[str]:
    # Query user_profiles via service-role client (database.py supabase).
    try:  # wrap Supabase read so cron still returns partial results on failure.
        result = (  # PostgREST query chain.
            supabase.from_("profiles")  # all onboarded students.
            .select("user_id")  # only need UUID column for the batch loop.
            .execute()  # run query with service role (bypasses RLS).
        )  # end chain
        rows = getattr(result, "data", None) or []  # normalise to list of dicts.
    except Exception as e:  # network or schema error.
        print(  # log for uvicorn console — n8n can alert on empty batches.
            f"[Notes] user_profiles list failed: {type(e).__name__}: {e}"
        )  # end print
        return []  # empty list — caller reports total_users=0.

    user_ids: List[str] = []  # accumulator for non-empty UUID strings.
    for row in rows:  # one user_profiles row per student.
        uid = str(row.get("user_id") or "").strip()  # coerce UUID to str.
        if uid:  # skip blank ids from malformed rows.
            user_ids.append(uid)  # collect for trigger loop.
    return user_ids  # full student list for hourly sync.


# ============================================================
# HELPER: _user_has_usable_google_tokens — same check as /classroom/posts
# ============================================================
def _user_has_usable_google_tokens(user_id: str) -> bool:
    # Load google_* columns from profiles (same helper as Classroom routes).
    profile = _fetch_profile_google_tokens(user_id)  # read profiles row via service role.
    if not profile:  # student never connected Google or row missing.
        return False  # count as error in trigger-sync batch.

    access_token = (profile.get("google_access_token") or "").strip()  # short-lived token.
    refresh_token = (profile.get("google_refresh_token") or "").strip()  # long-lived refresh secret.
    if not access_token and not refresh_token:  # Classroom not linked.
        return False  # cannot sync without OAuth tokens.

    # Refresh when expired — mirrors GET /classroom/posts before API calls.
    try:  # validate or refresh access token with Google OAuth library.
        _get_valid_google_access_token(profile)  # may write new token back to profiles.
    except HTTPException:  # expired refresh — student must reconnect Google.
        return False  # count as error.
    except Exception as e:  # unexpected Google client failure.
        print(  # log per-user failure without stopping the batch.
            f"[Notes] Google token check failed for {user_id!r}: "
            f"{type(e).__name__}: {e}"
        )  # end print
        return False  # count as error.

    return True  # tokens OK — safe to trigger n8n sync for this user.


# ============================================================
# HELPER: _post_n8n_notes_sync_webhook — core logic from POST /notes/sync
# ============================================================
async def _post_n8n_notes_sync_webhook(user_id: str, triggered_by: str) -> bool:
    # Same webhook POST as sync_notes — does not modify that endpoint.
    n8n_url = os.getenv("N8N_WEBHOOK_URL", "")
    if not n8n_url:
        # No webhook URL configured — skip silently
        return

    try:  # httpx async POST — one request per student.
        async with httpx.AsyncClient() as client:  # short-lived HTTP client.
            response = await client.post(  # call n8n webhook (same body as /notes/sync).
                n8n_url,  # N8N_WEBHOOK_URL target.
                json={  # JSON body n8n expects.
                    "user_id": user_id,  # which student to poll Classroom for.
                    "triggered_by": triggered_by,  # scheduled_sync vs manual_sync.
                },  # end json
                timeout=10.0,  # do not block the hourly cron too long.
            )  # end post
        if response.is_success:  # HTTP 2xx from n8n.
            return True  # sync successfully queued for this user.
        print(  # log non-success status for debugging.
            f"[Notes] trigger-sync webhook HTTP {response.status_code} "
            f"for user {user_id!r}: {response.text[:200]!r}"
        )  # end print
        return False  # n8n rejected or errored.
    except Exception as e:  # network timeout or DNS failure.
        print(  # log and continue batch.
            f"[Notes] trigger-sync webhook failed for {user_id!r}: "
            f"{type(e).__name__}: {e}"
        )  # end print
        return False  # count as error for this user.


# ================================================
# INTERNAL TRIGGER — called by n8n every hour
# No auth required — uses service role key
# n8n URL: POST /notes/trigger-sync
# No Authorization header needed
# ================================================
@router.post(
    "/trigger-sync",
    response_model=NotesTriggerSyncResponse,
    summary="Batch-trigger Google Classroom sync for all students (n8n cron)",
)
async def trigger_notes_sync() -> NotesTriggerSyncResponse:
    # STEP 1 — load every student UUID from user_profiles (service role).
    user_ids = _fetch_all_user_profile_ids()  # all user_id values from Postgres.
    total_users = len(user_ids)  # denominator for n8n monitoring.
    triggered_count = 0  # successful webhook calls.
    error_count = 0  # missing tokens or failed webhook calls.

    n8n_url = os.getenv("N8N_WEBHOOK_URL", "")
    if not n8n_url:
        # No webhook URL configured — skip silently
        return NotesTriggerSyncResponse(
            triggered=triggered_count,
            errors=error_count,
            total_users=total_users,
        )

    # STEP 2 — process each user independently so one failure does not stop the batch.
    for user_id in user_ids:  # foreach student in user_profiles.
        try:  # isolate per-user errors.
            # STEP 2a — ensure Google tokens exist and are refreshable (profiles table).
            if not _user_has_usable_google_tokens(user_id):  # same token path as Classroom.
                error_count += 1  # skip user without usable Google session.
                continue  # next student.

            # STEP 2b — fire the same n8n webhook payload as manual POST /notes/sync.
            ok = await _post_n8n_notes_sync_webhook(  # POST to N8N_WEBHOOK_URL.
                user_id, triggered_by="scheduled_sync"  # distinguish from manual_sync.
            )  # end await
            if ok:  # n8n accepted the sync job.
                triggered_count += 1  # success tally.
            else:  # webhook missing or HTTP error.
                error_count += 1  # failure tally.
        except Exception as e:  # guard against unexpected bugs per iteration.
            print(  # log and continue — never crash the whole hourly cron.
                f"[Notes] trigger-sync unexpected error for {user_id!r}: "
                f"{type(e).__name__}: {e}"
            )  # end print
            error_count += 1  # count as error.

    # STEP 3 — summary JSON for n8n monitoring.
    return NotesTriggerSyncResponse(  # spec response shape for n8n HTTP node.
        triggered=triggered_count,  # int — syncs queued successfully.
        errors=error_count,  # int — failures (tokens or webhook).
        total_users=total_users,  # int — rows read from user_profiles.
    )  # end return


# ============================================================
# ENDPOINT: GET /notes/list
# ============================================================
@router.get(
    "/list",
    response_model=NotesListResponse,
    summary="List study notes for the signed-in student",
)
def list_notes(
    user_id: str = Query(..., description="UUID of the student"),
    subject_id: Optional[str] = Query(
        default=None, description="Optional subject UUID filter"
    ),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    verified_user_id: str = Depends(verify_bearer_token),
):
    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    try:
        count_query = (
            supabase.table(NOTES_TABLE)
            .select("id", count="exact")
            .eq("user_id", verified_user_id)
        )
        if subject_id and subject_id.strip():
            count_query = count_query.eq("subject_id", subject_id.strip())
        count_result = count_query.execute()
        total = getattr(count_result, "count", None) or 0
    except Exception as e:
        print(f"[Notes] List count failed: {type(e).__name__}: {e}")
        total = 0

    try:
        list_query = (
            supabase.table(NOTES_TABLE)
            .select(
                "id, user_id, subject_id, title, summary, key_points, "
                "created_at, subjects(name, code)"
            )
            .eq("user_id", verified_user_id)
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
        )
        if subject_id and subject_id.strip():
            list_query = list_query.eq("subject_id", subject_id.strip())
        list_result = list_query.execute()
        rows = getattr(list_result, "data", None) or []
    except Exception as e:
        print(f"[Notes] List query failed: {type(e).__name__}: {e}")
        rows = []

    items: List[NoteListItem] = []
    for row in rows:
        subj_name, subj_code = _normalise_subject_fields(row.get("subjects"))
        kp = row.get("key_points")
        if not isinstance(kp, list):
            kp = []
        items.append(
            NoteListItem(
                id=str(row.get("id", "")),
                user_id=str(row.get("user_id", "")),
                subject_id=str(row.get("subject_id", "")),
                subject_name=subj_name,
                subject_code=subj_code,
                title=str(row.get("title") or ""),
                summary=str(row.get("summary") or ""),
                key_points=[str(p) for p in kp if str(p or "").strip()],
                created_at=str(row.get("created_at") or ""),
            )
        )

    return NotesListResponse(data=items, total=total)


# ============================================================
# CLASSROOM — Pydantic models (GET /classroom/posts)
# ============================================================


class ClassroomPostItem(BaseModel):
    post_id: str
    course_id: str
    course_name: str
    text: str
    materials: List[Dict[str, Any]]
    created_time: str


class ClassroomPostsResponse(BaseModel):
    data: List[ClassroomPostItem]


# ============================================================
# HELPER: _parse_profile_expiry
# ============================================================
def _parse_profile_expiry(raw: Any) -> datetime:
    if not raw:
        return datetime.min.replace(tzinfo=timezone.utc)
    if isinstance(raw, datetime):
        dt = raw
    else:
        text = str(raw).strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return datetime.min.replace(tzinfo=timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ============================================================
# HELPER: _fetch_profile_google_tokens
# ============================================================
def _fetch_profile_google_tokens(user_id: str) -> Optional[Dict[str, Any]]:
    try:
        result = (
            supabase.table(PROFILES_TABLE)
            .select(
                "user_id, google_access_token, google_refresh_token, "
                "google_token_expiry"
            )
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        rows = getattr(result, "data", None) or []
        return rows[0] if rows else None
    except Exception as e:
        print(f"[Notes] Profile token fetch failed: {type(e).__name__}: {e}")
        return None


# ============================================================
# HELPER: _save_refreshed_tokens
# ============================================================
def _save_refreshed_tokens(user_id: str, access_token: str) -> None:
    expiry = datetime.now(timezone.utc) + timedelta(seconds=GOOGLE_ACCESS_TOKEN_SECONDS)
    try:
        supabase.table(PROFILES_TABLE).update(
            {
                "google_access_token": access_token,
                "google_token_expiry": expiry.isoformat(),
                "updated_at": _now_iso(),
            }
        ).eq("user_id", user_id).execute()
    except Exception as e:
        print(f"[Notes] Refreshed token save failed: {type(e).__name__}: {e}")


# ============================================================
# HELPER: _get_valid_google_access_token
# ============================================================
# Access tokens expire every hour. We use the refresh token to get
# a new one automatically without asking Aisha to log in again.
# ============================================================
def _get_valid_google_access_token(profile: Dict[str, Any]) -> str:
    access = (profile.get("google_access_token") or "").strip()
    refresh = (profile.get("google_refresh_token") or "").strip()
    expiry = _parse_profile_expiry(profile.get("google_token_expiry"))
    user_id = str(profile.get("user_id") or "")

    now = datetime.now(timezone.utc)
    if access and expiry > now:
        return access

    if not refresh:
        raise HTTPException(
            status_code=401,
            detail={
                "error": (
                    "Google session expired. Please sign out and "
                    "sign in again to reconnect Classroom."
                )
            },
        )

    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        print("[Notes] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing.")
        raise HTTPException(
            status_code=503,
            detail={"error": "Google OAuth is not configured on the server."},
        )

    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        creds = Credentials(
            token=access or None,
            refresh_token=refresh,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=GOOGLE_CLIENT_ID,
            client_secret=GOOGLE_CLIENT_SECRET,
        )

        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            if creds.token and user_id:
                _save_refreshed_tokens(user_id, creds.token)
            return str(creds.token or "")
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Notes] Google token refresh failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=401,
            detail={
                "error": (
                    "Google session expired. Please sign out and "
                    "sign in again to reconnect Classroom."
                )
            },
        ) from e

    if access:
        return access

    raise HTTPException(
        status_code=401,
        detail={
            "error": (
                "Google session expired. Please sign out and "
                "sign in again to reconnect Classroom."
            )
        },
    )


# ============================================================
# HELPER: _extract_announcement_materials
# ============================================================
def _extract_announcement_materials(materials: Any) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    if not isinstance(materials, list):
        return items

    for material in materials:
        if not isinstance(material, dict):
            continue
        if "link" in material and isinstance(material["link"], dict):
            link = material["link"]
            items.append(
                {
                    "type": "link",
                    "title": str(link.get("title") or ""),
                    "url": str(link.get("url") or ""),
                }
            )
        if "driveFile" in material and isinstance(material["driveFile"], dict):
            drive = material["driveFile"]
            drive_meta = drive.get("driveFile") if isinstance(drive.get("driveFile"), dict) else {}
            items.append(
                {
                    "type": "drive",
                    "title": str(drive_meta.get("title") or ""),
                    "url": str(drive_meta.get("alternateLink") or ""),
                }
            )
        if "youtubeVideo" in material and isinstance(material["youtubeVideo"], dict):
            video = material["youtubeVideo"]
            video_id = str(video.get("id") or "")
            items.append(
                {
                    "type": "youtube",
                    "title": str(video.get("title") or ""),
                    "url": (
                        f"https://www.youtube.com/watch?v={video_id}"
                        if video_id
                        else ""
                    ),
                }
            )
    return items


# ============================================================
# ENDPOINT: GET /classroom/posts
# ============================================================
@classroom_router.get(
    "/posts",
    response_model=ClassroomPostsResponse,
    summary="Fetch recent Google Classroom announcements for the student",
)
def get_classroom_posts(
    user_id: str = Query(..., description="UUID of the student"),
    max_results: int = Query(default=10, ge=1, le=50),
    verified_user_id: str = Depends(verify_bearer_token),
):
    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # STEP 1 — load Google tokens from profiles.
    profile = _fetch_profile_google_tokens(verified_user_id)
    if not profile:
        raise HTTPException(
            status_code=404,
            detail={"error": "Profile not found"},
        )

    access_token = (profile.get("google_access_token") or "").strip()
    refresh_token = (profile.get("google_refresh_token") or "").strip()
    if not access_token and not refresh_token:
        raise HTTPException(
            status_code=403,
            detail={
                "error": (
                    "Google Classroom not connected. "
                    "Please reconnect your Google account."
                )
            },
        )

    # STEP 2 — refresh the access token when it has expired.
    valid_access = _get_valid_google_access_token(profile)

    # STEP 3 — build the Classroom API client.
    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        creds = Credentials(token=valid_access)
        classroom_service = build("classroom", "v1", credentials=creds)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Notes] Classroom client build failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Could not connect to Google Classroom."},
        ) from e

    posts: List[ClassroomPostItem] = []

    try:
        # Fetch all active courses Aisha is enrolled in.
        courses_response = (
            classroom_service.courses()
            .list(courseStates=["ACTIVE"])
            .execute()
        )
        courses = courses_response.get("courses") or []
    except Exception as e:
        print(f"[Notes] Classroom courses.list failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Could not fetch Google Classroom courses."},
        ) from e

    for course in courses:
        course_id = str(course.get("id") or "")
        course_name = str(course.get("name") or "Untitled course")
        if not course_id:
            continue

        try:
            # Fetch teacher announcements from each course.
            announcements_response = (
                classroom_service.courses()
                .announcements()
                .list(courseId=course_id, pageSize=max_results)
                .execute()
            )
            announcements = announcements_response.get("announcements") or []
        except Exception as e:
            print(
                f"[Notes] announcements.list failed for {course_id!r}: "
                f"{type(e).__name__}: {e}"
            )
            continue

        for announcement in announcements:
            posts.append(
                ClassroomPostItem(
                    post_id=str(announcement.get("id") or ""),
                    course_id=course_id,
                    course_name=course_name,
                    text=str(announcement.get("text") or ""),
                    materials=_extract_announcement_materials(
                        announcement.get("materials")
                    ),
                    created_time=str(
                        announcement.get("creationTime")
                        or announcement.get("updateTime")
                        or ""
                    ),
                )
            )

    return ClassroomPostsResponse(data=posts)
