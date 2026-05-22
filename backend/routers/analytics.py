# ============================================================
# ASCENDAI BACKEND — routers/analytics.py
# ============================================================
# Study Analytics — three read-only GET endpoints that aggregate
# activity from existing Supabase tables (no new tables).
#
#   GET /analytics/summary?period=week|month|all
#   GET /analytics/subject-breakdown?period=week|month|all
#   GET /analytics/activity-feed
#   GET /analytics/dashboard-summary?user_id&week_start&week_end
# ============================================================

from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel

from database import supabase
from routers.notifications import create_notification, exam_alert_sent_today

# Table names — single place to update if schema renames.
HOMEWORK_TABLE = "homework_questions"
ESSAY_CHECKS_TABLE = "essay_checks"
QUIZ_SESSIONS_TABLE = "quiz_sessions"
PAST_PAPERS_TABLE = "past_papers"
NOTES_TABLE = "notes"
FLASHCARDS_TABLE = "flashcards"
TIMETABLE_TABLE = "timetable_entries"
SUBJECTS_TABLE = "subjects"
# Spec name for per-user exam JSON; we also try `profiles` if missing.
USER_PROFILES_TABLE = "user_profiles"
PROFILES_TABLE = "profiles"
SYLLABUS_TOPICS_TABLE = "syllabus_topics"

# Cambridge syllabus code → canonical subject key.
SUBJECT_CODE_TO_KEY: Dict[str, str] = {
    "9708": "economics",
    "9609": "business",
    "9093": "english",
    "9626": "ict",
}

# Canonical subject keys returned to the frontend.
SUBJECT_KEYS = ("economics", "business", "english", "ict")

# Display names for in-app exam alert notifications.
SUBJECT_KEY_TO_LABEL: Dict[str, str] = {
    "economics": "Economics",
    "business": "Business Studies",
    "english": "English Language",
    "ict": "ICT",
}

# Allowed period query values.
ALLOWED_PERIODS = ("week", "month", "all")


class AnalyticsSummaryResponse(BaseModel):
    """GET /analytics/summary response envelope."""

    questions_asked: int
    flashcard_sessions: int
    papers_solved: int
    avg_quiz_score: float
    period: str


class SubjectBreakdownItem(BaseModel):
    """One row in the subject breakdown chart."""

    subject: str
    percentage: int


class SubjectBreakdownResponse(BaseModel):
    """GET /analytics/subject-breakdown response envelope."""

    breakdown: List[SubjectBreakdownItem]


class ActivityItem(BaseModel):
    """One row in the recent activity feed."""

    type: str
    description: str
    time: str
    subject: Optional[str] = None


class ActivityFeedResponse(BaseModel):
    """GET /analytics/activity-feed response envelope."""

    activities: List[ActivityItem]


class ExamIntelligenceSubject(BaseModel):
    """One subject row for GET /analytics/exam-intelligence."""

    subject: str
    exam_date: str
    days_remaining: int
    coverage_percentage: float
    topics_remaining: int
    total_topics: int
    urgency_level: str
    daily_topics_needed: float
    smart_message: str


class ExamIntelligenceResponse(BaseModel):
    """GET /analytics/exam-intelligence response envelope."""

    subjects: List[ExamIntelligenceSubject]


class DashboardTimetableEntryItem(BaseModel):
    """One timetable row — same shape as GET /timetable/entries items."""

    id: str
    subject_id: Optional[str] = None
    subject_name: Optional[str] = None
    subject_code: Optional[str] = None
    title: str = ""
    notes: Optional[str] = ""
    date: str = ""
    start_time: str = ""
    end_time: str = ""
    is_completed: bool = False


class DashboardTimetableBlock(BaseModel):
    """Timetable block — mirrors TimetableEntriesResponse."""

    data: List[DashboardTimetableEntryItem]
    total: int


class DashboardNoteListItem(BaseModel):
    """One note row — same shape as GET /notes/list items."""

    id: str
    user_id: str
    subject_id: str
    subject_name: str
    subject_code: str
    title: str
    summary: str
    key_points: List[str]
    created_at: str


class DashboardNotesBlock(BaseModel):
    """Notes block — mirrors NotesListResponse (data + total)."""

    data: List[DashboardNoteListItem]
    total: int


class DashboardSummaryResponse(BaseModel):
    """GET /analytics/dashboard-summary combined dashboard payload."""

    timetable_entries: DashboardTimetableBlock
    notes: DashboardNotesBlock
    questions_asked: int
    exam_intelligence: ExamIntelligenceResponse


def verify_bearer_token(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:
    """Validate Supabase JWT; return verified user_id or raise 401."""

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
        print(f"[Analytics] Bearer token verify raised: {type(e).__name__}")
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


def _validate_period(period: str) -> str:
    """Normalise and validate the period query param."""

    key = (period or "").strip().lower()
    if key not in ALLOWED_PERIODS:
        raise HTTPException(
            status_code=422,
            detail={
                "error": f"period must be one of: {', '.join(ALLOWED_PERIODS)}",
            },
        )
    return key


def _period_start_iso(period: str) -> Optional[str]:
    """
    Calculate the UTC ISO timestamp for the start of the date range.

    - week:  last 7 days from today
    - month: last 30 days from today
    - all:   no filter (returns None)
    """

    if period == "all":
        return None

    now = datetime.now(timezone.utc)
    if period == "week":
        start = now - timedelta(days=7)
    else:
        # month — last 30 days
        start = now - timedelta(days=30)

    return start.isoformat()


def _apply_date_filter(query, column: str, start_iso: Optional[str]):
    """Append a >= filter when a period start timestamp is set."""

    if start_iso:
        return query.gte(column, start_iso)
    return query


def _count_rows(
    table: str,
    user_id: str,
    date_column: str,
    start_iso: Optional[str],
    extra_filters: Optional[Dict[str, Any]] = None,
) -> int:
    """
    Count rows for one table scoped to user_id (and optional period).

    Uses PostgREST count='exact' so we never pull full row bodies.
    """

    try:
        query = (
            supabase.table(table)
            .select("id", count="exact")
            .eq("user_id", user_id)
        )
        if extra_filters:
            for col, val in extra_filters.items():
                query = query.eq(col, val)
        query = _apply_date_filter(query, date_column, start_iso)
        result = query.execute()
        return int(getattr(result, "count", None) or 0)
    except Exception as e:
        print(
            f"[Analytics] count failed table={table}: {type(e).__name__}: {e}"
        )
        return 0


def _subject_id_to_key_map() -> Dict[str, str]:
    """
    Load subjects table once and map each UUID → lowercase key
    (economics, business, english, ict).
    """

    mapping: Dict[str, str] = {}
    try:
        result = supabase.table(SUBJECTS_TABLE).select("*").execute()
        rows = getattr(result, "data", None) or []
    except Exception as e:
        print(f"[Analytics] subjects load failed: {type(e).__name__}: {e}")
        return mapping

    for row in rows:
        sid = row.get("id")
        if not sid:
            continue

        # Prefer explicit key/slug columns when present.
        for col in ("key", "slug"):
            val = row.get(col)
            if val:
                mapping[str(sid)] = str(val).strip().lower()
                break
        else:
            # Fall back to normalising the display name.
            raw_name = (row.get("name") or "").strip().lower()
            first = raw_name.split()[0] if raw_name else ""
            aliases = {"information": "ict"}
            mapping[str(sid)] = aliases.get(first, first) or ""

    return mapping


def _count_by_subject_id(
    table: str,
    user_id: str,
    subject_id: str,
    date_column: str,
    start_iso: Optional[str],
    extra_filters: Optional[Dict[str, Any]] = None,
) -> int:
    """Count rows for one subject_id within the optional period."""

    filters = {"subject_id": subject_id}
    if extra_filters:
        filters.update(extra_filters)
    return _count_rows(table, user_id, date_column, start_iso, filters)


def _quiz_average_percentage(
    user_id: str,
    start_iso: Optional[str],
) -> float:
    """
    Average quiz score as a percentage (0–100).

    The DB stores raw correct-count in `score`; we convert each
    completed session to (score / total_cards) * 100, then average.
    Returns 0.0 when there are no completed sessions.
    """

    try:
        query = (
            supabase.table(QUIZ_SESSIONS_TABLE)
            .select("score, total_cards")
            .eq("user_id", user_id)
            .eq("completed", True)
        )
        query = _apply_date_filter(query, "completed_at", start_iso)
        result = query.execute()
        rows = getattr(result, "data", None) or []
    except Exception as e:
        print(f"[Analytics] quiz avg failed: {type(e).__name__}: {e}")
        return 0.0

    percentages: List[float] = []
    for row in rows:
        total = int(row.get("total_cards") or 0)
        score = int(row.get("score") or 0)
        if total > 0:
            percentages.append((float(score) / float(total)) * 100.0)

    if not percentages:
        return 0.0

    return round(sum(percentages) / len(percentages), 1)


def _format_relative_time(iso_timestamp: str) -> str:
    """
    Format an ISO timestamp as human-readable relative time.

    - < 1 hour  → "X minutes ago"
    - < 24 hours → "X hours ago"
    - < 7 days   → "X days ago"
    - otherwise  → "DD Mon YYYY"
    """

    if not iso_timestamp:
        return ""

    try:
        cleaned = iso_timestamp.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return iso_timestamp

    now = datetime.now(timezone.utc)
    delta = now - dt.astimezone(timezone.utc)
    seconds = int(delta.total_seconds())

    if seconds < 60:
        return "Just now"

    minutes = seconds // 60
    if minutes < 60:
        label = "minute" if minutes == 1 else "minutes"
        return f"{minutes} {label} ago"

    hours = seconds // 3600
    if hours < 24:
        label = "hour" if hours == 1 else "hours"
        return f"{hours} {label} ago"

    days = seconds // 86400
    if days < 7:
        label = "day" if days == 1 else "days"
        return f"{days} {label} ago"

    return dt.strftime("%d %b %Y")


def _subject_key_from_join(
    joined: Any,
    id_map: Dict[str, str],
    subject_id: Optional[str],
) -> Optional[str]:
    """Resolve a lowercase subject key from a join or UUID map."""

    if subject_id and str(subject_id) in id_map:
        return id_map[str(subject_id)]

    if not joined:
        return None

    if isinstance(joined, list):
        joined = joined[0] if joined else None

    if not isinstance(joined, dict):
        return None

    raw_name = (joined.get("name") or "").strip().lower()
    first = raw_name.split()[0] if raw_name else ""
    aliases = {"information": "ict"}
    return aliases.get(first, first) or None


router = APIRouter()


@router.get(
    "/summary",
    response_model=AnalyticsSummaryResponse,
    summary="Study analytics summary counts for a time period",
)
def analytics_summary(
    period: str = Query(
        default="week",
        description='Time window: "week", "month", or "all".',
    ),
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Aggregate headline stats for the dashboard analytics page.

    Counts rows in homework_questions, essay_checks,
    quiz_sessions, and past_papers where user_id matches and
    created_at (or completed_at for quizzes) falls inside the
    period window.
    """

    period_key = _validate_period(period)
    start_iso = _period_start_iso(period_key)

    # homework_questions + essay_checks → questions asked in the period.
    homework_count = _count_rows(
        HOMEWORK_TABLE,
        verified_user_id,
        "created_at",
        start_iso,
    )
    essay_count = _count_rows(
        ESSAY_CHECKS_TABLE,
        verified_user_id,
        "created_at",
        start_iso,
    )
    questions_asked = homework_count + essay_count

    # quiz_sessions → flashcard quiz sessions (count every session).
    flashcard_sessions = _count_rows(
        QUIZ_SESSIONS_TABLE,
        verified_user_id,
        "started_at",
        start_iso,
    )

    # past_papers → papers uploaded/solved in the period.
    papers_solved = _count_rows(
        PAST_PAPERS_TABLE,
        verified_user_id,
        "created_at",
        start_iso,
    )

    # Average quiz percentage across completed sessions only.
    avg_quiz_score = _quiz_average_percentage(verified_user_id, start_iso)

    return AnalyticsSummaryResponse(
        questions_asked=questions_asked,
        flashcard_sessions=flashcard_sessions,
        papers_solved=papers_solved,
        avg_quiz_score=avg_quiz_score,
        period=period_key,
    )


@router.get(
    "/subject-breakdown",
    response_model=SubjectBreakdownResponse,
    summary="Per-subject activity percentages for a time period",
)
def analytics_subject_breakdown(
    period: str = Query(
        default="week",
        description='Time window: "week", "month", or "all".',
    ),
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Sum activity per subject across homework_questions, notes,
    quiz_sessions, and timetable_entries, then convert to percentages.

    If total activity is zero, return 25% for each subject.
    """

    period_key = _validate_period(period)
    start_iso = _period_start_iso(period_key)

    id_to_key = _subject_id_to_key_map()

    # Reverse map: subject key → UUID (first match wins).
    key_to_id: Dict[str, str] = {}
    for sid, skey in id_to_key.items():
        if skey in SUBJECT_KEYS and skey not in key_to_id:
            key_to_id[skey] = sid

    totals_by_key: Dict[str, int] = {k: 0 for k in SUBJECT_KEYS}

    for skey in SUBJECT_KEYS:
        subject_id = key_to_id.get(skey)
        if not subject_id:
            continue

        homework_n = _count_by_subject_id(
            HOMEWORK_TABLE,
            verified_user_id,
            subject_id,
            "created_at",
            start_iso,
        )
        notes_n = _count_by_subject_id(
            NOTES_TABLE,
            verified_user_id,
            subject_id,
            "created_at",
            start_iso,
        )
        quiz_n = _count_by_subject_id(
            QUIZ_SESSIONS_TABLE,
            verified_user_id,
            subject_id,
            "started_at",
            start_iso,
        )
        timetable_n = _count_by_subject_id(
            TIMETABLE_TABLE,
            verified_user_id,
            subject_id,
            "created_at",
            start_iso,
        )

        totals_by_key[skey] = homework_n + notes_n + quiz_n + timetable_n

    grand_total = sum(totals_by_key.values())

    breakdown: List[SubjectBreakdownItem] = []

    if grand_total == 0:
        # No activity — equal split so the chart still renders.
        for skey in SUBJECT_KEYS:
            breakdown.append(SubjectBreakdownItem(subject=skey, percentage=25))
    else:
        for skey in SUBJECT_KEYS:
            pct = round((totals_by_key[skey] / grand_total) * 100)
            breakdown.append(SubjectBreakdownItem(subject=skey, percentage=pct))

    return SubjectBreakdownResponse(breakdown=breakdown)


@router.get(
    "/activity-feed",
    response_model=ActivityFeedResponse,
    summary="Last 20 study activities across all features",
)
def analytics_activity_feed(
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Merge recent events from five tables, sort newest first,
    return the top 20 with relative timestamps.
    """

    id_to_key = _subject_id_to_key_map()
    merged: List[Dict[str, Any]] = []

    # ── 1. Homework questions ─────────────────────────────────
    try:
        hw_result = (
            supabase.table(HOMEWORK_TABLE)
            .select("question, created_at, subject_id, subjects(name, code)")
            .eq("user_id", verified_user_id)
            .order("created_at", desc=True)
            .limit(50)
            .execute()
        )
        for row in getattr(hw_result, "data", None) or []:
            q = (row.get("question") or "").strip()
            merged.append(
                {
                    "type": "homework",
                    "description": f"Asked about {q[:40]}..." if len(q) > 40 else f"Asked about {q}",
                    "timestamp": row.get("created_at"),
                    "subject": _subject_key_from_join(
                        row.get("subjects"),
                        id_to_key,
                        row.get("subject_id"),
                    ),
                }
            )
    except Exception as e:
        print(f"[Analytics] homework feed failed: {type(e).__name__}: {e}")

    # ── 2. Notes ──────────────────────────────────────────────
    try:
        notes_result = (
            supabase.table(NOTES_TABLE)
            .select("title, created_at, subject_id, subjects(name, code)")
            .eq("user_id", verified_user_id)
            .order("created_at", desc=True)
            .limit(50)
            .execute()
        )
        for row in getattr(notes_result, "data", None) or []:
            title = (row.get("title") or "Untitled").strip()
            merged.append(
                {
                    "type": "note",
                    "description": (
                        f"Note generated: {title[:40]}..."
                        if len(title) > 40
                        else f"Note generated: {title}"
                    ),
                    "timestamp": row.get("created_at"),
                    "subject": _subject_key_from_join(
                        row.get("subjects"),
                        id_to_key,
                        row.get("subject_id"),
                    ),
                }
            )
    except Exception as e:
        print(f"[Analytics] notes feed failed: {type(e).__name__}: {e}")

    # ── 3. Quiz sessions (completed only — has a score) ───────
    try:
        quiz_result = (
            supabase.table(QUIZ_SESSIONS_TABLE)
            .select(
                "score, total_cards, completed_at, subject_id, subjects(name, code)"
            )
            .eq("user_id", verified_user_id)
            .eq("completed", True)
            .order("completed_at", desc=True)
            .limit(50)
            .execute()
        )
        for row in getattr(quiz_result, "data", None) or []:
            total = int(row.get("total_cards") or 0)
            score = int(row.get("score") or 0)
            pct = round((score / total) * 100) if total > 0 else 0
            skey = _subject_key_from_join(
                row.get("subjects"),
                id_to_key,
                row.get("subject_id"),
            )
            subject_label = (skey or "subject").title()
            merged.append(
                {
                    "type": "quiz",
                    "description": f"Scored {pct}% on {subject_label} Quiz",
                    "timestamp": row.get("completed_at"),
                    "subject": skey,
                }
            )
    except Exception as e:
        print(f"[Analytics] quiz feed failed: {type(e).__name__}: {e}")

    # ── 4. Past papers ────────────────────────────────────────
    try:
        papers_result = (
            supabase.table(PAST_PAPERS_TABLE)
            .select("created_at, subject_id, subjects(name, code)")
            .eq("user_id", verified_user_id)
            .order("created_at", desc=True)
            .limit(50)
            .execute()
        )
        for row in getattr(papers_result, "data", None) or []:
            skey = _subject_key_from_join(
                row.get("subjects"),
                id_to_key,
                row.get("subject_id"),
            )
            subject_label = (skey or "subject").title()
            merged.append(
                {
                    "type": "paper",
                    "description": f"Solved {subject_label} past paper",
                    "timestamp": row.get("created_at"),
                    "subject": skey,
                }
            )
    except Exception as e:
        print(f"[Analytics] past papers feed failed: {type(e).__name__}: {e}")

    # ── 5. Completed timetable sessions ───────────────────────
    try:
        tt_result = (
            supabase.table(TIMETABLE_TABLE)
            .select(
                "topic, updated_at, created_at, subject_id, subjects(name, code)"
            )
            .eq("user_id", verified_user_id)
            .eq("completed", True)
            .order("updated_at", desc=True)
            .limit(50)
            .execute()
        )
        for row in getattr(tt_result, "data", None) or []:
            topic = (row.get("topic") or "Study session").strip()
            ts = row.get("updated_at") or row.get("created_at")
            merged.append(
                {
                    "type": "session",
                    "description": (
                        f"Completed: {topic[:40]}..."
                        if len(topic) > 40
                        else f"Completed: {topic}"
                    ),
                    "timestamp": ts,
                    "subject": _subject_key_from_join(
                        row.get("subjects"),
                        id_to_key,
                        row.get("subject_id"),
                    ),
                }
            )
    except Exception as e:
        print(f"[Analytics] timetable feed failed: {type(e).__name__}: {e}")

    # ── Merge, sort by timestamp DESC, take top 20 ─────────────
    merged = [m for m in merged if m.get("timestamp")]
    merged.sort(key=lambda m: str(m.get("timestamp") or ""), reverse=True)
    top = merged[:20]

    activities: List[ActivityItem] = []
    for item in top:
        activities.append(
            ActivityItem(
                type=item["type"],
                description=item["description"],
                time=_format_relative_time(str(item.get("timestamp") or "")),
                subject=item.get("subject"),
            )
        )

    return ActivityFeedResponse(activities=activities)


# ============================================================
# EXAM INTELLIGENCE — helpers + GET /analytics/exam-intelligence
# ============================================================


def _normalise_exam_dates_json(raw: Any) -> Dict[str, str]:
    """
    Turn a JSON exam_dates object into subject_key → YYYY-MM-DD.

    Accepts keys as subject slugs (economics) or syllabus codes (9708).
    """

    if not isinstance(raw, dict):
        return {}

    out: Dict[str, str] = {}
    for key, value in raw.items():
        if value is None:
            continue
        date_str = str(value).strip()[:10]
        if not date_str:
            continue

        norm_key = str(key).strip().lower()
        if norm_key in SUBJECT_KEYS:
            out[norm_key] = date_str
            continue
        if norm_key in SUBJECT_CODE_TO_KEY:
            out[SUBJECT_CODE_TO_KEY[norm_key]] = date_str
            continue
        # Allow numeric codes without string normalisation edge cases.
        code_key = str(key).strip()
        if code_key in SUBJECT_CODE_TO_KEY:
            out[SUBJECT_CODE_TO_KEY[code_key]] = date_str

    return out


def _load_exam_dates_for_user(user_id: str) -> Dict[str, str]:
    """
    Load exam dates for a user from the subjects table.
    Each subject row has an exam_date column per user.
    This replaces the old broken approach of reading from profiles.exam_dates
    which never existed in the database.
    """
    dates: Dict[str, str] = {}
    try:
        # Query subjects table filtered by user_id — this is where exam dates live
        result = (
            supabase.table(SUBJECTS_TABLE)
            .select("code, name, exam_date")
            .eq("user_id", user_id)
            .eq("is_active", True)
            .not_.is_("exam_date", "null")
            .execute()
        )
        rows = getattr(result, "data", None) or []
        for row in rows:
            # Map by subject code first
            code = str(row.get("code") or "").strip()
            exam_value = row.get("exam_date")
            if not exam_value:
                continue
            # Try code-based mapping first
            subject_key = SUBJECT_CODE_TO_KEY.get(code)
            if subject_key:
                dates[subject_key] = str(exam_value)[:10]
                continue
            # Fall back to name-based mapping
            raw_name = str(row.get("name") or "").strip().lower()
            first_word = raw_name.split()[0] if raw_name else ""
            aliases = {"information": "ict"}
            name_key = aliases.get(first_word, first_word)
            if name_key in SUBJECT_KEYS:
                dates[name_key] = str(exam_value)[:10]
    except Exception as e:
        print(f"[Analytics] exam_dates load failed: {type(e).__name__}: {e}")
    return dates


def _syllabus_rows_for_subject(user_id: str, subject_key: str) -> List[dict]:
    """
    Step 2 — Syllabus topics for coverage (mirrors syllabus router).

    User-owned topics win; otherwise global seed rows (is_global = true).
    """

    try:
        user_result = (
            supabase.table(SYLLABUS_TOPICS_TABLE)
            .select("is_covered")
            .eq("user_id", user_id)
            .eq("subject", subject_key)
            .eq("is_global", False)
            .execute()
        )
        user_rows = getattr(user_result, "data", None) or []
        if user_rows:
            return user_rows
    except Exception as e:
        print(
            f"[Analytics] syllabus user rows ({subject_key}): "
            f"{type(e).__name__}: {e}"
        )

    try:
        global_result = (
            supabase.table(SYLLABUS_TOPICS_TABLE)
            .select("is_covered")
            .eq("subject", subject_key)
            .eq("is_global", True)
            .is_("user_id", "null")
            .execute()
        )
        return getattr(global_result, "data", None) or []
    except Exception as e:
        print(
            f"[Analytics] syllabus global rows ({subject_key}): "
            f"{type(e).__name__}: {e}"
        )
        return []


def _coverage_counts(user_id: str, subject_key: str) -> Tuple[int, int]:
    """
    Step 2 — COUNT total / covered for one subject's visible topic set.
    """

    rows = _syllabus_rows_for_subject(user_id, subject_key)
    total = len(rows)
    covered = sum(1 for r in rows if r.get("is_covered"))
    return total, covered


def _count_upcoming_timetable_sessions(user_id: str, subject_key: str) -> int:
    """
    Optional timetable signal — sessions still scheduled from today onward.

    Not returned in the API payload today; kept so the endpoint can be
    extended without reshaping the response contract.
    """

    today_iso = date.today().isoformat()
    try:
        id_to_key = _subject_id_to_key_map()
        subject_id = None
        for sid, skey in id_to_key.items():
            if skey == subject_key:
                subject_id = sid
                break
        if not subject_id:
            return 0

        query = (
            supabase.table(TIMETABLE_TABLE)
            .select("id", count="exact")
            .eq("user_id", user_id)
            .eq("subject_id", subject_id)
            .eq("completed", False)
            .gte("scheduled_date", today_iso)
        )
        result = query.execute()
        return int(getattr(result, "count", None) or 0)
    except Exception as e:
        print(
            f"[Analytics] timetable count ({subject_key}): "
            f"{type(e).__name__}: {e}"
        )
        return 0


def _days_until_exam(exam_date_str: str) -> int:
    """Calendar days from today until exam_date (never negative)."""

    try:
        exam_day = date.fromisoformat(exam_date_str[:10])
    except ValueError:
        return 0
    today = date.today()
    delta = (exam_day - today).days
    return max(0, delta)


def _urgency_level(days_remaining: int, coverage_percentage: float) -> str:
    """
    Step 3 — urgency_level bands from days + coverage percentage.

    critical: exam within 30 days AND coverage below 50%
    warning:  exam within 60 days AND coverage below 70%
    good:     coverage at or above 70%
    normal:   all other combinations
    """

    if days_remaining < 30 and coverage_percentage < 50:
        return "critical"
    if days_remaining < 60 and coverage_percentage < 70:
        return "warning"
    if coverage_percentage >= 70:
        return "good"
    return "normal"


def _daily_topics_needed(topics_remaining: int, days_remaining: int) -> float:
    """
    Step 3 — pace needed to finish remaining topics before the exam.
    """

    if topics_remaining > 0 and days_remaining > 0:
        return round(topics_remaining / days_remaining, 1)
    return 0.0


def _smart_message(
    urgency_level: str,
    days_remaining: int,
    topics_remaining: int,
    daily_topics_needed: float,
) -> str:
    """
    Step 3 — human-readable coaching line per urgency band.
    """

    if urgency_level == "critical":
        return (
            f"Only {days_remaining} days left — "
            f"cover {topics_remaining} more topics immediately"
        )
    if urgency_level == "warning":
        return (
            f"Cover {daily_topics_needed} topics/day "
            f"to reach 70% before your exam"
        )
    if urgency_level == "good":
        return (
            f"On track — {topics_remaining} topics "
            f"remaining with {days_remaining} days to go"
        )
    return (
        f"{topics_remaining} topics remaining, "
        f"{days_remaining} days until exam"
    )


def _assert_caller_user_id(verified_user_id: str, user_id: str) -> None:
    """Reject mismatched user_id query params (anti-spoof, same as timetable)."""

    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )


def _validate_week_date_range(week_start: str, week_end: str) -> None:
    """Ensure week_start/week_end are valid ISO dates (YYYY-MM-DD)."""

    try:
        date.fromisoformat(week_start)
        date.fromisoformat(week_end)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "week_start and week_end must be ISO dates (YYYY-MM-DD).",
            },
        )


def _normalise_note_subject_join(
    joined: Any,
) -> Tuple[str, str]:
    """
    Resolve subject name + code from a PostgREST subjects embed.

    Mirrors routers/notes.py _normalise_subject_fields for list output.
    """

    if not joined:
        return "", ""

    if isinstance(joined, list):
        joined = joined[0] if joined else None

    if not isinstance(joined, dict):
        return "", ""

    return (
        str(joined.get("name") or ""),
        str(joined.get("code") or ""),
    )


def _fetch_timetable_entries_for_week(
    user_id: str,
    week_start: str,
    week_end: str,
) -> DashboardTimetableBlock:
    """
    Load timetable rows for one inclusive Mon–Sun window.

    Same query + field mapping as GET /timetable/entries in timetable.py.
    """

    try:
        result = (
            supabase.table(TIMETABLE_TABLE)
            .select(
                "id, subject_id, topic, scheduled_date, start_time, "
                "end_time, completed, subjects(name, code)"
            )
            .eq("user_id", user_id)
            .gte("scheduled_date", week_start)
            .lte("scheduled_date", week_end)
            .order("scheduled_date", desc=False)
            .order("start_time", desc=False)
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception as e:
        print(
            f"[Analytics] dashboard timetable read failed: "
            f"{type(e).__name__}: {e}"
        )
        rows = []

    items: List[DashboardTimetableEntryItem] = []
    for row in rows:
        subj = row.get("subjects")
        if isinstance(subj, list):
            subj = subj[0] if subj else None
        items.append(
            DashboardTimetableEntryItem(
                id=str(row.get("id", "")),
                subject_id=(
                    str(row["subject_id"]) if row.get("subject_id") else None
                ),
                subject_name=(
                    subj.get("name") if isinstance(subj, dict) else None
                ),
                subject_code=(
                    subj.get("code") if isinstance(subj, dict) else None
                ),
                title=row.get("topic") or "",
                notes="",
                date=str(row.get("scheduled_date") or ""),
                start_time=str(row.get("start_time") or ""),
                end_time=str(row.get("end_time") or ""),
                is_completed=bool(row.get("completed", False)),
            )
        )

    return DashboardTimetableBlock(data=items, total=len(items))


def _fetch_notes_list(
    user_id: str,
    limit: int = 3,
    offset: int = 0,
) -> DashboardNotesBlock:
    """
    Load study notes for the dashboard (newest first).

    Same query + mapping as GET /notes/list with limit/offset.
    """

    try:
        count_result = (
            supabase.table(NOTES_TABLE)
            .select("id", count="exact")
            .eq("user_id", user_id)
            .execute()
        )
        total = int(getattr(count_result, "count", None) or 0)
    except Exception as e:
        print(
            f"[Analytics] dashboard notes count failed: "
            f"{type(e).__name__}: {e}"
        )
        total = 0

    try:
        list_result = (
            supabase.table(NOTES_TABLE)
            .select(
                "id, user_id, subject_id, title, summary, key_points, "
                "created_at, subjects(name, code)"
            )
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        rows = getattr(list_result, "data", None) or []
    except Exception as e:
        print(
            f"[Analytics] dashboard notes list failed: "
            f"{type(e).__name__}: {e}"
        )
        rows = []

    items: List[DashboardNoteListItem] = []
    for row in rows:
        subj_name, subj_code = _normalise_note_subject_join(row.get("subjects"))
        kp = row.get("key_points")
        if not isinstance(kp, list):
            kp = []
        items.append(
            DashboardNoteListItem(
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

    return DashboardNotesBlock(data=items, total=total)


def _questions_asked_all_time(user_id: str) -> int:
    """
    Total questions asked (homework + essay checks), no date filter.

    Reuses _count_rows — same components as GET /analytics/summary period=all.
    """

    homework_count = _count_rows(
        HOMEWORK_TABLE,
        user_id,
        "created_at",
        None,
    )
    essay_count = _count_rows(
        ESSAY_CHECKS_TABLE,
        user_id,
        "created_at",
        None,
    )
    return homework_count + essay_count


def _build_exam_intelligence_subjects(
    verified_user_id: str,
) -> List[ExamIntelligenceSubject]:
    """
    Build per-subject exam intelligence rows.

    Shared by GET /analytics/exam-intelligence and dashboard-summary.
    """

    exam_dates_map = _load_exam_dates_for_user(verified_user_id)
    subjects_out: List[ExamIntelligenceSubject] = []

    for subject_key in SUBJECT_KEYS:
        exam_date_str = exam_dates_map.get(subject_key)
        if not exam_date_str:
            continue

        total_topics, covered = _coverage_counts(verified_user_id, subject_key)
        topics_remaining = max(0, total_topics - covered)

        if total_topics > 0:
            coverage_percentage = round((covered / total_topics) * 100.0, 1)
        else:
            coverage_percentage = 0.0

        days_remaining = _days_until_exam(exam_date_str)
        urgency = _urgency_level(days_remaining, coverage_percentage)
        daily_pace = _daily_topics_needed(topics_remaining, days_remaining)
        message = _smart_message(
            urgency,
            days_remaining,
            topics_remaining,
            daily_pace,
        )

        _count_upcoming_timetable_sessions(verified_user_id, subject_key)

        subjects_out.append(
            ExamIntelligenceSubject(
                subject=subject_key,
                exam_date=exam_date_str[:10],
                days_remaining=days_remaining,
                coverage_percentage=coverage_percentage,
                topics_remaining=topics_remaining,
                total_topics=total_topics,
                urgency_level=urgency,
                daily_topics_needed=daily_pace,
                smart_message=message,
            )
        )

        if urgency == "critical":
            subject_label = SUBJECT_KEY_TO_LABEL.get(
                subject_key, subject_key.replace("_", " ").title()
            )
            if not exam_alert_sent_today(verified_user_id, subject_label):
                create_notification(
                    user_id=verified_user_id,
                    type="exam_alert",
                    title=f"Exam Alert — {subject_label}",
                    message=(
                        f"{subject_label} exam in {days_remaining} days. "
                        f"Only {coverage_percentage}% of syllabus covered."
                    ),
                )

    subjects_out.sort(key=lambda s: s.days_remaining)
    return subjects_out


@router.get(
    "/exam-intelligence",
    response_model=ExamIntelligenceResponse,
    summary="Smart exam countdown with syllabus coverage urgency",
)
def analytics_exam_intelligence(
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Combine exam dates, syllabus coverage, and timetable context into
    per-subject urgency metrics for the dashboard countdown card.
    """

    subjects_out = _build_exam_intelligence_subjects(verified_user_id)
    return ExamIntelligenceResponse(subjects=subjects_out)


@router.get(
    "/dashboard-summary",
    response_model=DashboardSummaryResponse,
    summary="Combined dashboard payload (timetable, notes, counts, exams)",
)
def analytics_dashboard_summary(
    user_id: str = Query(
        ...,
        min_length=1,
        description="Caller's UUID (must match bearer token).",
    ),
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
    """
    Single round-trip for the home dashboard.

    Bundles timetable entries (current week), latest three notes,
    all-time questions asked, and exam intelligence.
    """

    _assert_caller_user_id(verified_user_id, user_id)
    _validate_week_date_range(week_start, week_end)

    timetable_block = _fetch_timetable_entries_for_week(
        verified_user_id,
        week_start,
        week_end,
    )
    notes_block = _fetch_notes_list(verified_user_id, limit=3, offset=0)
    questions_asked = _questions_asked_all_time(verified_user_id)
    exam_subjects = _build_exam_intelligence_subjects(verified_user_id)

    return DashboardSummaryResponse(
        timetable_entries=timetable_block,
        notes=notes_block,
        questions_asked=questions_asked,
        exam_intelligence=ExamIntelligenceResponse(subjects=exam_subjects),
    )
