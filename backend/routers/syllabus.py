# ============================================================
# ASCENDAI BACKEND — routers/syllabus.py
# ============================================================
# Syllabus PDF extraction, topic storage, coverage tracking.
# Endpoints:
#   POST /syllabus/extract       — PDF → Groq topic list
#   POST /syllabus/save-topics   — persist user topics
#   GET  /syllabus/topics        — grouped topics + coverage
#   PATCH /syllabus/topics/{id}/toggle — mark covered / not
# ============================================================

import json
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional

import fitz  # PyMuPDF — extract text from uploaded syllabus PDFs.
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from database import supabase

router = APIRouter()

# Groq model — same family as homework / past papers.
GROQ_MODEL = "llama-3.3-70b-versatile"
EXTRACT_MAX_TOKENS = 2000
EXTRACT_TEMPERATURE = 0.1

# Supabase table for syllabus topics.
SYLLABUS_TOPICS_TABLE = "syllabus_topics"

# Canonical subject keys the frontend sends.
ALLOWED_SUBJECTS = ("economics", "business", "english", "ict")
ALL_SUBJECT_KEYS = list(ALLOWED_SUBJECTS)

# Groq system prompt — must return a raw JSON array of topic strings.
EXTRACT_SYSTEM_PROMPT = """
You are an expert Cambridge International AS Level curriculum
analyst. Your job is to extract all syllabus topics from a
Cambridge AS Level subject syllabus PDF.

Extract EVERY topic, subtopic, and learning objective.
Format each topic as a clean, concise phrase.
Remove page numbers, headers, footers, and administrative text.
Focus only on actual learning content topics.

Return ONLY a JSON array of topic strings.
No preamble. No explanation. No markdown.
Just the raw JSON array like this:
["Topic 1", "Topic 2", "Topic 3"]

Be thorough — extract every single topic you can find.
"""


# ============================================================
# AUTH DEPENDENCY — same pattern as homework.py
# ============================================================
def verify_bearer_token(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:
    """Verify Supabase JWT and return the authenticated user's UUID."""

    if not authorization:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

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
        print(f"[Syllabus] Bearer token verify raised: {type(e).__name__}: {e}")
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
# PYDANTIC MODELS
# ============================================================
class ExtractResponse(BaseModel):
    """JSON returned after PDF topic extraction."""

    topics: List[str]
    count: int
    subject: str
    error: Optional[str] = None


class SaveTopicsRequest(BaseModel):
    """Body for POST /syllabus/save-topics."""

    subject: str = Field(..., min_length=1)
    topics: List[str] = Field(default_factory=list)
    user_id: str = Field(..., min_length=1)


class SaveTopicsResponse(BaseModel):
    """How many topic rows were inserted."""

    saved: int
    error: Optional[str] = None


class TopicItem(BaseModel):
    """One syllabus topic row for the tracker UI."""

    id: str
    topic_name: str
    chapter: Optional[str] = None
    is_covered: bool
    covered_at: Optional[str] = None
    is_global: bool = False


class CoverageStat(BaseModel):
    """Covered / total / percentage for one subject."""

    covered: int
    total: int
    percentage: int


class TopicsResponse(BaseModel):
    """Grouped topics and coverage stats."""

    topics: Dict[str, List[TopicItem]]
    coverage: Dict[str, CoverageStat]


class ToggleResponse(BaseModel):
    """Result of PATCH toggle."""

    id: str
    is_covered: bool
    covered_at: Optional[str] = None


# ============================================================
# HELPERS
# ============================================================
def _normalise_subject(subject: str) -> str:
    """Lowercase trim; reject unknown subject keys."""

    key = (subject or "").strip().lower()
    if key not in ALLOWED_SUBJECTS:
        raise HTTPException(
            status_code=422,
            detail={"error": f"subject must be one of: {', '.join(ALLOWED_SUBJECTS)}"},
        )
    return key


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    """
    Read every page of the PDF with PyMuPDF and concatenate plain text.
    """

    pdf_document = fitz.open(stream=pdf_bytes, filetype="pdf")
    full_text = ""
    for page_num in range(len(pdf_document)):
        page = pdf_document[page_num]
        full_text += page.get_text()
    pdf_document.close()
    return full_text


def _parse_topics_json(raw: str) -> List[str]:
    """
    Parse Groq's JSON array response; strip markdown fences if present.
    """

    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```\s*$", "", text)
    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise ValueError("Groq response is not a JSON array")
    topics: List[str] = []
    for item in parsed:
        name = str(item).strip()
        if name:
            topics.append(name)
    return topics


def _infer_chapter(topic_name: str) -> Optional[str]:
    """
    Best-effort chapter label from topic text (e.g. "Unit 3: Markets").
    """

    unit_match = re.match(
        r"^((?:Unit|Chapter|Section)\s+[\w\.]+)",
        topic_name,
        re.IGNORECASE,
    )
    if unit_match:
        return unit_match.group(1).strip()
    return None


def _row_to_topic_item(row: dict) -> TopicItem:
    """Map a Supabase row dict to TopicItem."""

    covered_at = row.get("covered_at")
    return TopicItem(
        id=str(row.get("id") or ""),
        topic_name=str(row.get("topic_name") or ""),
        chapter=row.get("chapter"),
        is_covered=bool(row.get("is_covered")),
        covered_at=str(covered_at) if covered_at is not None else None,
        is_global=bool(row.get("is_global")),
    )


def _coverage_for_rows(rows: List[dict]) -> CoverageStat:
    """Compute covered count and percentage for a subject's topic list."""

    total = len(rows)
    covered = sum(1 for r in rows if r.get("is_covered"))
    percentage = int(round((covered / total) * 100)) if total else 0
    return CoverageStat(covered=covered, total=total, percentage=percentage)


def _fetch_topics_for_subject(
    user_id: str,
    subject_key: str,
) -> List[dict]:
    """
    Load user-specific topics; if none exist, fall back to global defaults.
    """

    try:
        user_result = (
            supabase.table(SYLLABUS_TOPICS_TABLE)
            .select("*")
            .eq("user_id", user_id)
            .eq("subject", subject_key)
            .eq("is_global", False)
            .order("created_at")
            .execute()
        )
        user_rows = getattr(user_result, "data", None) or []
        if user_rows:
            return user_rows
    except Exception as e:
        print(
            f"[Syllabus] user topics query failed ({subject_key}): "
            f"{type(e).__name__}: {e}"
        )

    # Fallback — global seed topics (user_id IS NULL, is_global = true).
    try:
        global_result = (
            supabase.table(SYLLABUS_TOPICS_TABLE)
            .select("*")
            .is_("user_id", "null")
            .eq("subject", subject_key)
            .eq("is_global", True)
            .order("created_at")
            .execute()
        )
        return getattr(global_result, "data", None) or []
    except Exception as e:
        print(
            f"[Syllabus] global topics query failed ({subject_key}): "
            f"{type(e).__name__}: {e}"
        )
        return []


# ============================================================
# ENDPOINT 1: POST /syllabus/extract
# ============================================================
@router.post(
    "/extract",
    response_model=ExtractResponse,
    summary="Extract Cambridge syllabus topics from a PDF",
)
async def extract_syllabus(
    file: UploadFile = File(...),
    subject: str = Form(...),
    user_id: str = Form(...),
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Accept a syllabus PDF, extract text with PyMuPDF, ask Groq for topics.
    """

    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    subject_key = _normalise_subject(subject)

    # Read uploaded PDF bytes from the multipart form.
    try:
        pdf_bytes = await file.read()
    except Exception as e:
        print(f"[Syllabus] file read failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=422,
            detail={"error": "Could not read uploaded file."},
        )

    if not pdf_bytes:
        raise HTTPException(
            status_code=422,
            detail={"error": "Uploaded file is empty."},
        )

    # PyMuPDF text extraction across all pages.
    try:
        extracted_text = _extract_pdf_text(pdf_bytes)
    except Exception as e:
        print(f"[Syllabus] PDF extract failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=422,
            detail={
                "error": (
                    "Could not extract text from PDF. "
                    "Please use a text-based Cambridge syllabus PDF."
                )
            },
        )

    if not extracted_text.strip():
        raise HTTPException(
            status_code=422,
            detail={"error": "No text found in PDF."},
        )

    user_prompt = (
        f"Subject: {subject_key}\n"
        f"Extract all topics from this Cambridge AS Level syllabus:\n\n"
        f"{extracted_text[:8000]}"
    )

    try:
        from main import groq_client  # noqa: WPS433
    except Exception as e:
        print(f"[Syllabus] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    try:
        completion = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=EXTRACT_MAX_TOKENS,
            temperature=EXTRACT_TEMPERATURE,
        )
        raw_text = completion.choices[0].message.content or ""
    except Exception as e:
        print(f"[Syllabus] Groq extract failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    try:
        topics = _parse_topics_json(raw_text)
    except Exception as e:
        print(f"[Syllabus] JSON parse failed: {type(e).__name__}: {e}")
        return ExtractResponse(
            topics=[],
            count=0,
            subject=subject_key,
            error="Could not parse topics from AI response. Please try again.",
        )

    return ExtractResponse(
        topics=topics,
        count=len(topics),
        subject=subject_key,
        error=None,
    )


# ============================================================
# ENDPOINT 2: POST /syllabus/save-topics
# ============================================================
@router.post(
    "/save-topics",
    response_model=SaveTopicsResponse,
    summary="Save extracted syllabus topics for a user and subject",
)
def save_topics(
    body: SaveTopicsRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Replace the user's topics for one subject (non-global rows only).
    """

    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    subject_key = _normalise_subject(body.subject)
    topics = [t.strip() for t in (body.topics or []) if t and str(t).strip()]

    # Delete existing user topics for this subject to avoid duplicates on re-upload.
    try:
        supabase.table(SYLLABUS_TOPICS_TABLE).delete().eq(
            "user_id", verified_user_id
        ).eq("subject", subject_key).eq("is_global", False).execute()
    except Exception as e:
        print(f"[Syllabus] delete old topics failed: {type(e).__name__}: {e}")

    if not topics:
        return SaveTopicsResponse(saved=0, error=None)

    # Build one insert payload per topic string.
    payloads = []
    for topic in topics:
        payloads.append(
            {
                "user_id": verified_user_id,
                "subject": subject_key,
                "topic_name": topic,
                "chapter": _infer_chapter(topic),
                "is_covered": False,
                "is_global": False,
            }
        )

    try:
        result = supabase.table(SYLLABUS_TOPICS_TABLE).insert(payloads).execute()
        rows = getattr(result, "data", None) or []
        saved = len(rows) if rows else len(payloads)
    except Exception as e:
        print(f"[Syllabus] insert topics failed: {type(e).__name__}: {e}")
        return SaveTopicsResponse(
            saved=0,
            error="Could not save topics. Run backend/migrations/syllabus_topics.sql.",
        )

    return SaveTopicsResponse(saved=saved, error=None)


# ============================================================
# ENDPOINT 3: GET /syllabus/topics
# ============================================================
@router.get(
    "/topics",
    response_model=TopicsResponse,
    summary="Get syllabus topics and coverage by subject",
)
def get_topics(
    subject: Optional[str] = Query(
        default=None,
        description="Optional subject filter (economics|business|english|ict).",
    ),
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Return topics grouped by subject with coverage percentages.
    User rows first; global defaults when the user has none.
    """

    if subject:
        subject_keys = [_normalise_subject(subject)]
    else:
        subject_keys = ALL_SUBJECT_KEYS

    topics_out: Dict[str, List[TopicItem]] = {}
    coverage_out: Dict[str, CoverageStat] = {}

    for key in subject_keys:
        rows = _fetch_topics_for_subject(verified_user_id, key)
        topics_out[key] = [_row_to_topic_item(r) for r in rows]
        coverage_out[key] = _coverage_for_rows(rows)

    return TopicsResponse(topics=topics_out, coverage=coverage_out)


# ============================================================
# ENDPOINT 4: PATCH /syllabus/topics/{topic_id}/toggle
# ============================================================
@router.patch(
    "/topics/{topic_id}/toggle",
    response_model=ToggleResponse,
    summary="Toggle a syllabus topic covered / not covered",
)
def toggle_topic(
    topic_id: str,
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Flip is_covered and set or clear covered_at for the user's topic row.
    """

    try:
        fetch_result = (
            supabase.table(SYLLABUS_TOPICS_TABLE)
            .select("id, user_id, is_covered, is_global")
            .eq("id", topic_id)
            .limit(1)
            .execute()
        )
        rows = getattr(fetch_result, "data", None) or []
    except Exception as e:
        print(f"[Syllabus] toggle fetch failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Database unavailable. Please try again."},
        )

    if not rows:
        raise HTTPException(
            status_code=404,
            detail={"error": "Topic not found."},
        )

    row = rows[0]
    row_user = row.get("user_id")
    is_global = bool(row.get("is_global"))

    # Only the owner may toggle; global rows are read-only via API.
    if is_global or str(row_user) != str(verified_user_id):
        raise HTTPException(
            status_code=403,
            detail={"error": "You can only update your own syllabus topics."},
        )

    currently_covered = bool(row.get("is_covered"))
    if currently_covered:
        new_covered = False
        new_covered_at = None
    else:
        new_covered = True
        new_covered_at = datetime.now(timezone.utc).isoformat()

    try:
        supabase.table(SYLLABUS_TOPICS_TABLE).update(
            {
                "is_covered": new_covered,
                "covered_at": new_covered_at,
            }
        ).eq("id", topic_id).execute()
    except Exception as e:
        print(f"[Syllabus] toggle update failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Could not update topic. Please try again."},
        )

    return ToggleResponse(
        id=topic_id,
        is_covered=new_covered,
        covered_at=new_covered_at,
    )
