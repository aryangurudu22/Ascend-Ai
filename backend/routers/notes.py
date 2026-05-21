# ============================================================
# ASCENDAI BACKEND — routers/notes.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# The Note Summariser feature — AI note generation and listing.
#
#   POST /notes/summarise
#     • Receives raw post content (text, YouTube URL,
#       Drive link, or pre-extracted PDF text).
#     • Optionally fetches a YouTube transcript.
#     • Asks Groq (LLaMA-3.3 70B) for a Cambridge-style title
#       and structured summary + key points.
#     • Saves the row to the `notes` table in Supabase.
#
#   POST /notes/generate
#     • Generates one study note from a syllabus topic name via Groq.
#
#   POST /notes/upload-pdf
#     • Extracts text from an uploaded PDF, identifies topics via Groq,
#       and creates one note per topic in Supabase.
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
#   • PyMuPDF (fitz) — PDF text extraction for upload-pdf.
# ============================================================

import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import fitz  # PyMuPDF — already in requirements.txt as PyMuPDF==1.27.2.3
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile
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


class GenerateNoteRequest(BaseModel):
    # UUID of the student requesting the note.
    user_id: str = Field(..., description="UUID of the student")
    # UUID of the subject from the subjects table.
    subject_id: str = Field(..., description="UUID of the subject from subjects table")
    # The exact topic name from syllabus_topics table.
    topic_name: str = Field(..., description="Topic name to generate notes for")


class GenerateNoteResponse(BaseModel):
    note_id: str
    title: str
    summary_preview: str
    key_points_count: int
    message: str


class UploadPDFResponse(BaseModel):
    notes_created: int
    titles: List[str]
    message: str


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
        "You are an expert Cambridge AS Level teacher creating\n"
        "revision notes for a student in Lusaka, Zambia.\n\n"
        "THE STUDENT: Aisha, Cambridge AS Level, needs clear,\n"
        "exam-focused notes she can revise from directly.\n\n"
        f"Subject: {subj} ({code})\n"
        f"Source: {src} post from Google Classroom\n\n"
        "SUMMARY QUALITY RULES:\n"
        "- Extract only exam-relevant content\n"
        "- Use Cambridge mark scheme language throughout\n"
        "- Structure content logically for revision\n"
        "- Include key definitions with ceteris paribus where relevant\n"
        "- Include worked examples where helpful\n"
        "- Flag high-frequency exam topics with [EXAM FOCUS]\n"
        "- Keep language clear and direct — no waffle\n\n"
        "KEY POINTS RULES:\n"
        "- Maximum 5 key points per note\n"
        "- Each key point must be a complete, usable fact\n"
        "- Written as if it will appear directly in an exam answer\n"
        "- Include a Zambian/African example in at least one point\n"
        "  where genuinely relevant\n\n"
        "NEVER:\n"
        "- Summarise administrative or non-academic content\n"
        "- Include vague points like \"this is important\"\n"
        "- Use jargon without explanation\n"
        "- Pad with unnecessary words\n\n"
        "Read the content carefully and create a comprehensive study note.\n\n"
        "Return ONLY a valid JSON object. No introduction. No markdown.\n\n"
        "Format:\n"
        "{\n"
        '  "title": "Concise Cambridge AS Level topic title (max 8 words)",\n'
        '  "summary": "Write 3-4 comprehensive paragraphs summarising the '
        "key content. Use Cambridge mark scheme language. "
        "Include [EXAM FOCUS] for high-frequency topics. "
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
        "- key_points must be exactly 5 items (maximum 5)\n"
        "- Each key_point is one complete, exam-relevant sentence\n"
        "- No markdown symbols anywhere\n"
        "- No bullet points inside summary\n"
        "- Title must be specific to the Cambridge topic covered\n\n"
        "WRITING STYLE RULES:\n"
        "Sound like a real person wrote this:\n"
        "- Vary sentence length — mix short punchy sentences\n"
        "  with longer explanatory ones\n"
        "- Use natural transitions: \"Here's the thing...\",\n"
        "  \"Think of it this way...\", \"The key point is...\",\n"
        "  \"What Cambridge really wants to see is...\"\n"
        "- Occasional light emphasis words: \"actually\", \"really\",\n"
        "  \"in fact\", \"the truth is\"\n"
        "- Never start two consecutive sentences the same way\n"
        "- Never use lists unless absolutely necessary\n"
        "- Flow like spoken explanation, not bullet points\n\n"
        "AVOID THESE AI GIVEAWAYS — never use:\n"
        "- \"Certainly!\" — never use\n"
        "- \"Of course!\" — never use\n"
        "- \"Great question!\" — never use\n"
        "- \"It is important to note that\" — never use\n"
        "- \"In conclusion\" — never use\n"
        "- \"Furthermore\" — never use\n"
        "- \"Moreover\" — never use\n"
        "- \"It is worth noting\" — never use\n"
        "- \"As mentioned above\" — never use\n"
        "- \"In summary\" — never use\n"
        "- Numbered lists for explanations — never use\n"
        "- Bullet points in flowing text — never use\n"
        "- Starting every paragraph with the topic word\n"
        "- Repeating the question back before answering\n"
        "- Overly formal academic language when simpler works\n\n"
        "WHAT TO USE INSTEAD:\n"
        "- \"Here's what this means in practice...\"\n"
        "- \"The way to think about this is...\"\n"
        "- \"What actually happens is...\"\n"
        "- \"Cambridge examiners look for exactly this...\"\n"
        "- \"The reason this matters is...\"\n"
        "- \"Most students miss this, but...\"\n"
        "- \"Think about it from the examiner's perspective...\"\n\n"
        "HUMANISATION RULES:\n"
        "Write summaries like a top student's revision notes —\n"
        "the kind that actually make sense when you read them\n"
        "back the night before an exam.\n"
        "Use natural language — not formal academic prose.\n"
        "Key points should feel like the things a tutor would\n"
        "circle and say \"make sure you remember this\".\n"
        "The tone should be clear and direct — like someone\n"
        "who understands the material completely and is\n"
        "explaining it to a friend."
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
# ENDPOINT: POST /notes/generate
# ============================================================
# Creates one study note from a syllabus topic name using Groq.
# ============================================================
@router.post("/generate", response_model=GenerateNoteResponse)
def generate_note(
    body: GenerateNoteRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    # STEP 1 — identity check: JWT subject must match body user_id.
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(status_code=401, detail={"error": "Unauthorised — please log in"})

    # STEP 2 — validate topic_name is not empty.
    topic_name = (body.topic_name or "").strip()
    if not topic_name:
        raise HTTPException(status_code=422, detail={"error": "topic_name is required"})

    # STEP 3 — fetch subject name and code from subjects table.
    subject_row = _fetch_subject_row(body.subject_id.strip())
    if not subject_row:
        raise HTTPException(status_code=404, detail={"error": "Subject not found"})
    subject_name = str(subject_row.get("name") or "").strip()
    subject_code = str(subject_row.get("code") or "").strip()

    # STEP 4 — build Groq system prompt (friendly tutor tone, JSON-only reply).
    system_prompt = (
        f"You are a genius friend who just aced Cambridge AS Level {subject_name}. "
        f"You are explaining this topic to your friend Aisha who needs to actually understand it — not just memorise it.\n\n"
        f"Your goal is ONE thing: make Aisha genuinely understand this topic so well she could explain it to someone else.\n\n"
        f"How to write:\n"
        f"- Talk like a real person. Short sentences when making a point. Longer ones when explaining.\n"
        f"- Use analogies. Use real examples from Zambia — matatus, kwacha, Shoprite, MTN, load shedding.\n"
        f"- If a diagram would help, describe it in words.\n"
        f"- Call out common misconceptions — most students think X but actually...\n"
        f"- No walls of text. Mix short and long paragraphs naturally.\n"
        f"- Never use: Certainly, Of course, Furthermore, Moreover, In conclusion, In summary\n\n"
        f"You MUST respond with ONLY this JSON structure and nothing else:\n\n"
        f"{{\n"
        f'  "title": "string — the topic name written naturally",\n'
        f'  "summary": "string — your full explanation as one continuous block of plain text. No line breaks inside this string. No nested quotes.",\n'
        f'  "key_points": ["string — write as many points as the topic needs. Each point must be a complete standalone sentence that captures one core idea so clearly that if Aisha only read the key points she would still understand the whole topic. Write them like a smart friend circling the most important things and saying — make sure you remember this."]\n'
        f"}}\n\n"
        f"CRITICAL JSON RULES:\n"
        f"- summary must be a single flat string — no newlines inside it, no nested quotes\n"
        f"- key_points must be a JSON array of plain strings\n"
        f"- Do not put key_points inside the summary string\n"
        f"- Do not use markdown inside any string value\n"
        f"- The response must be valid JSON that can be parsed with json.loads()"
    )

    user_content = (
        f"Generate comprehensive Cambridge AS Level notes for this topic:\n\n"
        f"Subject: {subject_name} ({subject_code})\nTopic: {topic_name}"
    )

    # STEP 5 — call Groq with JSON mode for structured note output.
    raw_response = _call_groq_text(
        system_prompt=system_prompt,
        user_content=user_content,
        max_tokens=4096,
        json_mode=True,
    )

    # STEP 6 — parse the JSON response from Groq.
    parsed, parse_err = _parse_groq_json(raw_response)
    if parsed is None:
        print(f"[Notes] Generate note parse failed: {parse_err}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate notes. Please try again."},
        )

    title = (parsed.get("title") or topic_name).strip()
    summary = (parsed.get("summary") or "").strip()
    key_points_raw = parsed.get("key_points")
    key_points = []
    if isinstance(key_points_raw, list):
        key_points = [str(p).strip() for p in key_points_raw if str(p or "").strip()]

    if not summary:
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate notes. Please try again."},
        )

    # STEP 7 — save to Supabase notes table (no google_post_id for topic-generated notes).
    now = _now_iso()
    insert_payload = {
        "user_id": verified_user_id,
        "subject_id": body.subject_id.strip(),
        "google_post_id": None,
        "title": title,
        "summary": summary,
        "key_points": key_points,
        "created_at": now,
        "updated_at": now,
    }

    try:
        insert_result = supabase.table(NOTES_TABLE).insert(insert_payload).execute()
        inserted = getattr(insert_result, "data", None) or []
        if not inserted:
            raise RuntimeError("Insert returned no rows.")
        saved = inserted[0]
        note_id = str(saved.get("id", ""))
    except Exception as e:
        print(f"[Notes] Generate note insert failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not save note. Please try again."},
        ) from e

    return GenerateNoteResponse(
        note_id=note_id,
        title=title,
        summary_preview=summary[:200],
        key_points_count=len(key_points),
        message="Note generated successfully",
    )


# ============================================================
# ENDPOINT: POST /notes/upload-pdf
# ============================================================
# Extracts PDF text, discovers topics via Groq, generates one note per topic.
# ============================================================
@router.post("/upload-pdf", response_model=UploadPDFResponse)
async def upload_pdf_notes(
    file: UploadFile = File(...),
    subject_id: str = Form(...),
    user_id: str = Form(...),
    verified_user_id: str = Depends(verify_bearer_token),
):
    # STEP 1 — identity check: form user_id must match JWT subject.
    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(status_code=401, detail={"error": "Unauthorised — please log in"})

    # STEP 2 — validate file is a PDF by extension.
    filename = (file.filename or "").lower()
    if not filename.endswith(".pdf"):
        raise HTTPException(status_code=422, detail={"error": "Only PDF files are supported."})

    # STEP 3 — read file bytes from the multipart upload.
    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=422, detail={"error": "Uploaded file is empty."})

    # STEP 4 — extract text from PDF using PyMuPDF (fitz).
    try:
        pdf_document = fitz.open(stream=pdf_bytes, filetype="pdf")
        full_text = ""
        for page_num in range(len(pdf_document)):
            page = pdf_document[page_num]
            full_text += page.get_text()
        pdf_document.close()
    except Exception as e:
        print(f"[Notes] PDF extraction failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=422,
            detail={"error": "Could not read PDF. Please use a text-based PDF."},
        ) from e

    if not full_text.strip():
        raise HTTPException(status_code=422, detail={"error": "No text found in PDF."})

    # STEP 5 — fetch subject info from subjects table.
    subject_row = _fetch_subject_row(subject_id.strip())
    if not subject_row:
        raise HTTPException(status_code=404, detail={"error": "Subject not found"})
    subject_name = str(subject_row.get("name") or "").strip()
    subject_code = str(subject_row.get("code") or "").strip()

    # STEP 6 — ask Groq to identify the distinct topics in this PDF.
    topic_system_prompt = """You are a Cambridge AS Level curriculum expert.
Your job is to identify the distinct topics covered in this study material.
Return ONLY a JSON array of topic name strings.
Each topic should be a clear concise phrase — like a chapter heading.
Maximum 10 topics. Minimum 1 topic.
No preamble. No explanation. Just the raw JSON array.
Example: ["Supply and Demand", "Price Elasticity", "Market Structures"]"""

    topic_user_content = (
        f"Subject: {subject_name}\n"
        f"Identify all the distinct topics in this study material:\n\n"
        f"{full_text[:6000]}"
    )

    raw_topics = _call_groq_text(
        system_prompt=topic_system_prompt,
        user_content=topic_user_content,
        max_tokens=500,
        json_mode=True,
    )

    # STEP 7 — parse the topics list from Groq response.
    try:
        topics_text = raw_topics.strip()
        if topics_text.startswith("```"):
            topics_text = topics_text.split("\n", 1)[1] if "\n" in topics_text else topics_text[3:]
        if topics_text.endswith("```"):
            topics_text = topics_text[:-3]
        topics_list = json.loads(topics_text.strip())
        if not isinstance(topics_list, list):
            topics_list = [subject_name + " Overview"]
        topics_list = [str(t).strip() for t in topics_list if str(t or "").strip()][:10]
    except Exception as e:
        print(f"[Notes] PDF topic parse failed: {type(e).__name__}: {e}")
        topics_list = [subject_name + " — Study Notes"]

    if not topics_list:
        topics_list = [subject_name + " — Study Notes"]

    # STEP 8 — for each topic generate a full note and save it to Supabase.
    created_notes = []
    now = _now_iso()

    for topic_name in topics_list:
        try:
            # Build the note generation prompt for this specific topic.
            note_system = f"""You are a genius friend who just aced Cambridge AS Level {subject_name}.
Explain this specific topic to Aisha like you are helping her understand it over WhatsApp — clear, real, no fluff.
Make her actually get the concept — not just memorise words.
Use Zambian examples where they help. Use Kwacha, Lusaka, MTN, Shoprite, load shedding — whatever makes it click.
Use the uploaded material as context but explain it in your own words.

Respond ONLY with a valid JSON object:
{{
  "title": "The topic name written naturally",
  "summary": "Explain this like a smart friend. Make it click. No walls of text. Real examples. Short punchy sentences mixed with explanations. Use as much space as the topic needs — no more, no less.",
  "key_points": ["As many points as needed to truly understand and apply this topic in an exam — each as one clear sentence"]
}}
No markdown. No bullet points inside summary. Sound like a real person."""

            note_user = (
                f"Subject: {subject_name} ({subject_code})\n"
                f"Topic: {topic_name}\n\n"
                f"Context from uploaded material:\n{full_text[:3000]}"
            )

            raw_note = _call_groq_text(
                system_prompt=note_system,
                user_content=note_user,
                max_tokens=2048,
                json_mode=True,
            )

            # Parse the JSON note from Groq.
            parsed, _ = _parse_groq_json(raw_note)
            if not parsed:
                continue

            title = (parsed.get("title") or topic_name).strip()
            summary = (parsed.get("summary") or "").strip()
            key_points_raw = parsed.get("key_points")
            key_points = []
            if isinstance(key_points_raw, list):
                key_points = [str(p).strip() for p in key_points_raw if str(p or "").strip()]

            if not summary:
                continue

            # Save this topic's note to Supabase.
            insert_payload = {
                "user_id": verified_user_id,
                "subject_id": subject_id.strip(),
                "google_post_id": None,
                "title": title,
                "summary": summary,
                "key_points": key_points,
                "created_at": now,
                "updated_at": now,
            }

            insert_result = supabase.table(NOTES_TABLE).insert(insert_payload).execute()
            inserted = getattr(insert_result, "data", None) or []
            if inserted:
                created_notes.append(title)

        except Exception as e:
            # If one topic fails keep going — do not crash the whole upload.
            print(
                f"[Notes] PDF note generation failed for topic {topic_name!r}: "
                f"{type(e).__name__}: {e}"
            )
            continue

    if not created_notes:
        raise HTTPException(
            status_code=503,
            detail={"error": "Could not generate notes from this PDF. Please try again."},
        )

    return UploadPDFResponse(
        notes_created=len(created_notes),
        titles=created_notes,
        message=f"Created {len(created_notes)} notes from your PDF",
    )


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
