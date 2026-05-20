# ============================================================
# ASCENDAI BACKEND — routers/reminders.py
# ============================================================
# Email reminders router for AscendAI. Handles study reminder
# emails sent to students via the Resend API (daily schedules,
# weekly progress, exam alerts). Endpoints:
#   POST /reminders/test-email — send a delivery test email.
#   POST /reminders/preferences — save reminder email settings.
#   GET  /reminders/preferences — load reminder email settings.
#   POST /reminders/send-daily — email today's timetable sessions.
#   POST /reminders/send-weekly — weekly progress report email.
#   POST /reminders/send-exam-alert — urgent exam countdown email.
#   POST /reminders/trigger-daily — n8n batch daily emails (no auth).
#   POST /reminders/trigger-weekly — n8n batch weekly emails (no auth).
#   POST /reminders/trigger-exam-alert — n8n batch exam alerts (no auth).
# ============================================================

# Standard library — read BREVO_API_KEY from the environment.
import os  # Access process environment variables for API keys.

# Standard library — parse exam_dates JSON from Postgres.
import json  # deserialise profiles.exam_dates when stored as a string.

# Standard library — format today's date for scheduled_date queries and email copy.
from datetime import date, datetime, timedelta, timezone  # calendar week ranges and ISO timestamps.
from typing import Any, Dict, List, Optional, Tuple  # type hints for helpers and responses.

# Brevo (Sendinblue) SDK — send transactional and reminder emails.
import sib_api_v3_sdk  # Official Python client for the Brevo transactional email API.
from sib_api_v3_sdk.rest import ApiException  # Brevo API error type for send failures.

# FastAPI — build the /reminders route group and HTTP errors.
from fastapi import APIRouter, Depends, Header  # Router plus JWT dependency injection.

# FastAPI — return structured error responses when sending fails.
from fastapi import HTTPException  # Raise 4xx/5xx with a JSON detail body.

# Pydantic — validate JSON bodies from the frontend.
from pydantic import BaseModel  # Base class for request/response schemas.

# Supabase — service-role client shared across all backend routers.
from database import supabase  # same connection object homework.py uses for Postgres writes

# python-dotenv — load backend/.env before we read BREVO_API_KEY.
from dotenv import load_dotenv  # loads environment variables from .env file

load_dotenv()  # loads all variables from .env into memory so os.environ can access them

# Configure Brevo API key
BREVO_API_KEY = os.getenv("BREVO_API_KEY", "")  # transactional email API key from environment
if not BREVO_API_KEY:  # if key is missing, server will log a clear warning
    print("WARNING: BREVO_API_KEY is not set in environment")  # visible in uvicorn console on startup

# Router for all reminder-email endpoints under /reminders.
router = APIRouter()  # prefix and tags are set in main.py when mounted, same as homework router.

# Groq model for motivational copy in weekly and exam emails.
GROQ_MODEL = "llama-3.3-70b-versatile"  # same model family as homework and analytics.

# Groq token cap for short encouragement paragraphs.
GROQ_WEEKLY_MAX_TOKENS = 100  # weekly report asks for two sentences only.

# Groq token cap for exam alert closing line.
GROQ_EXAM_MAX_TOKENS = 60  # single motivational sentence.

# Groq temperature for warm, varied reminder copy.
GROQ_REMINDER_TEMPERATURE = 0.8  # slightly creative tone for encouragement.

# Supabase table names — single place to update if schema renames.
REMINDER_PREFS_TABLE = "reminder_preferences"  # student email toggles and delivery address.
TIMETABLE_TABLE = "timetable_entries"  # study sessions with scheduled_date and completed flag.
HOMEWORK_TABLE = "homework_questions"  # homework assistant questions per student.
QUIZ_SESSIONS_TABLE = "quiz_sessions"  # flashcard quiz attempts and scores.
USER_PROFILES_TABLE = "profiles"  # exam_dates JSON per student.
PROFILES_TABLE = "profiles"  # fallback when profiles row is missing.
SUBJECTS_TABLE = "subjects"  # shared exam_date fallback by syllabus code.
SYLLABUS_TOPICS_TABLE = "syllabus_topics"  # syllabus coverage and topic names.

# Frontend base URL for deep links inside exam alert emails.
FRONTEND_BASE_URL = os.getenv("FRONTEND_URL", "http://localhost:3001")  # from .env or dev default.

# Cambridge subject keys stored in exam_dates JSON.
SUBJECT_KEYS = ("economics", "business", "english", "ict")  # canonical slugs used across the app.

# Human-readable subject labels for email headings.
SUBJECT_LABELS: Dict[str, str] = {  # map slug → display name in HTML emails.
    "economics": "Economics",  # 9708
    "business": "Business Studies",  # 9609
    "english": "English Language",  # 9093
    "ict": "Information Technology",  # 9626
}  # end SUBJECT_LABELS

# Syllabus code → slug when exam_dates keys are numeric codes.
SUBJECT_CODE_TO_KEY: Dict[str, str] = {  # same mapping as analytics router.
    "9708": "economics",  # Economics
    "9609": "business",  # Business Studies
    "9093": "english",  # English Language
    "9626": "ict",  # Information Technology
}  # end SUBJECT_CODE_TO_KEY


# ============================================================
# AUTH DEPENDENCY — verify_bearer_token (same pattern as homework)
# ============================================================
def verify_bearer_token(  # validates Supabase JWT from Authorization header.
    authorization: Optional[str] = Header(default=None, alias="Authorization"),  # Bearer token from client.
) -> str:  # returns verified user UUID string.
    """Verify Supabase JWT and return the authenticated user's UUID."""

    if not authorization:  # missing Authorization header entirely.
        raise HTTPException(status_code=401, detail={"error": "Unauthorised — please log in"})  # generic 401.

    parts = authorization.split(maxsplit=1)  # split "Bearer <jwt>" into scheme + token.
    if len(parts) != 2 or parts[0].lower() != "bearer":  # malformed scheme.
        raise HTTPException(status_code=401, detail={"error": "Unauthorised — please log in"})  # generic 401.

    token = parts[1].strip()  # raw JWT string after Bearer prefix.
    if not token:  # empty token after Bearer.
        raise HTTPException(status_code=401, detail={"error": "Unauthorised — please log in"})  # generic 401.

    try:  # ask Supabase Auth to validate and decode the JWT.
        response = supabase.auth.get_user(token)  # service-role client can verify any user token.
    except Exception as exc:  # expired, revoked, or malformed token.
        print(f"[Reminders] Bearer token verify raised: {type(exc).__name__}: {exc}")  # server log only.
        raise HTTPException(status_code=401, detail={"error": "Unauthorised — please log in"}) from exc  # 401.

    user_obj = None  # normalise supabase-py response shape.
    if hasattr(response, "user"):  # object-style response.
        user_obj = response.user  # extract user attribute.
    elif isinstance(response, dict):  # dict-style response.
        user_obj = response.get("user")  # extract user key.

    if not user_obj:  # no user payload after verify.
        raise HTTPException(status_code=401, detail={"error": "Unauthorised — please log in"})  # generic 401.

    user_id = (  # pull UUID from user object or dict.
        getattr(user_obj, "id", None) if not isinstance(user_obj, dict) else user_obj.get("id")  # id field.
    )  # end user_id extraction
    if not user_id:  # verified response without an id (should not happen).
        raise HTTPException(status_code=401, detail={"error": "Unauthorised — please log in"})  # generic 401.

    return str(user_id)  # coerce to str for Supabase filters.


# ============================================================
# HELPER: get_email_wrapper — shared HTML email shell
# ============================================================
def get_email_wrapper(content: str, title: str) -> str:  # wraps inner HTML with AscendAI email chrome.
    """Return a complete HTML document with AscendAI header, body slot, and footer."""

    return f"""<!DOCTYPE html>  <!-- email clients expect a full HTML document -->
<html>  <!-- root element -->
<head>  <!-- metadata and shared styles -->
<meta charset="UTF-8">  <!-- UTF-8 for Cambridge subject names and punctuation -->
<meta name="viewport" content="width=device-width, initial-scale=1.0">  <!-- mobile-friendly scaling -->
<style>  <!-- inline stylesheet for clients that strip external CSS -->
  body {{ margin: 0; padding: 20px 0; background: #f4f1e8; font-family: Inter, Arial, sans-serif; }}
  .container {{ max-width: 600px; margin: 0 auto; background: #0A0F1E; border-radius: 12px; overflow: hidden; border: 1px solid rgba(212,175,55,0.3); }}
  .header {{ background: #080D18; padding: 24px 32px; border-bottom: 1px solid rgba(212,175,55,0.2); }}
  .logo {{ font-size: 22px; font-weight: 700; color: #D4AF37; font-family: Georgia, serif; }}
  .tagline {{ font-size: 11px; color: rgba(212,175,55,0.5); margin-top: 2px; }}
  .body {{ padding: 28px 32px; color: #EDE9D8; background: #0A0F1E; }}
  .stat-box {{ display: inline-block; background: #1A2235; border: 0.5px solid rgba(212,175,55,0.2); border-radius: 8px; padding: 14px 18px; margin: 6px; text-align: center; min-width: 110px; }}
  .stat-number {{ font-size: 24px; font-weight: 700; color: #D4AF37; font-family: Georgia, serif; }}
  .stat-label {{ font-size: 10px; color: rgba(237,233,216,0.5); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 4px; }}
  .footer {{ padding: 16px 32px; border-top: 1px solid rgba(212,175,55,0.1); font-size: 11px; color: rgba(237,233,216,0.3); text-align: center; background: #080D18; }}
  a {{ color: #D4AF37; text-decoration: none; }}
  p {{ color: #EDE9D8; }}
  h1, h2, h3 {{ color: #D4AF37; }}
</style>  <!-- end style block -->
</head>  <!-- end head -->
<body>  <!-- visible email body -->
  <div class="container">  <!-- centred card wrapper -->
    <div class="header">  <!-- branded header -->
      <div class="logo">AscendAI</div>  <!-- product name -->
      <div class="tagline">{title}</div>  <!-- dynamic subtitle e.g. Weekly Progress Report -->
    </div>  <!-- end header -->
    <div class="body">{content}</div>  <!-- caller-supplied sections -->
    <div class="footer">AscendAI by Shivora — Unsubscribe</div>  <!-- legal/footer line -->
  </div>  <!-- end container -->
</body>  <!-- end body -->
</html>"""


# ============================================================
# HELPER: _current_calendar_week — Monday through Sunday (today's week)
# ============================================================
def _current_calendar_week() -> Tuple[date, date]:  # returns (monday, sunday) date objects.
    """Return the Monday and Sunday bounding the current local calendar week."""

    today = date.today()  # local date for student-facing week labels.
    monday = today - timedelta(days=today.weekday())  # weekday() is 0=Monday.
    sunday = monday + timedelta(days=6)  # six days after Monday is Sunday.
    return monday, sunday  # tuple for range filters and display strings.


# ============================================================
# HELPER: _week_start_iso — UTC midnight on Monday for timestamp filters
# ============================================================
def _week_start_iso(monday: date) -> str:  # ISO timestamp at start of Monday UTC.
    """Convert calendar Monday to UTC ISO string for created_at / started_at filters."""

    start_dt = datetime.combine(monday, datetime.min.time(), tzinfo=timezone.utc)  # Monday 00:00 UTC.
    return start_dt.isoformat()  # e.g. 2026-05-12T00:00:00+00:00


# ============================================================
# HELPER: _fetch_preferences — load reminder_preferences row
# ============================================================
def _fetch_preferences(user_id: str) -> Optional[Dict[str, Any]]:  # one preferences dict or None.
    """Load the student's reminder_preferences row if it exists."""

    try:  # Supabase read.
        result = (  # chain query builder.
            supabase.table(REMINDER_PREFS_TABLE)  # reminder_preferences table.
            .select("*")  # all columns for toggles and email.
            .eq("user_id", user_id)  # scoped to authenticated student.
            .limit(1)  # at most one row per user.
            .execute()  # run query.
        )  # end chain
        rows = getattr(result, "data", None) or []  # normalise response list.
        return rows[0] if rows else None  # first row or None.
    except Exception as exc:  # network or schema error.
        print(f"[Reminders] preferences read failed: {type(exc).__name__}: {exc}")  # log server-side.
        return None  # treat as missing preferences.


# ============================================================
# HELPER: _count_table_rows — count rows with optional date column filter
# ============================================================
def _count_table_rows(  # generic exact-count helper.
    table: str,  # Supabase table name.
    user_id: str,  # student UUID.
    date_column: Optional[str],  # column to apply gte filter (or None).
    start_iso: Optional[str],  # inclusive lower bound ISO timestamp.
    extra_eq: Optional[Dict[str, Any]] = None,  # additional .eq filters.
) -> int:  # row count.
    """Count rows for one table with optional period and equality filters."""

    try:  # Supabase count query.
        query = supabase.table(table).select("id", count="exact").eq("user_id", user_id)  # base filter.
        if extra_eq:  # optional equality filters e.g. completed=True.
            for col, val in extra_eq.items():  # apply each .eq.
                query = query.eq(col, val)  # chain filter.
        if date_column and start_iso:  # period lower bound.
            query = query.gte(date_column, start_iso)  # created_at / started_at >= week start.
        result = query.execute()  # run count.
        return int(getattr(result, "count", None) or 0)  # exact count from PostgREST.
    except Exception as exc:  # query failure.
        print(f"[Reminders] count failed table={table}: {type(exc).__name__}: {exc}")  # log.
        return 0  # safe zero.


# ============================================================
# HELPER: _count_timetable_in_range — sessions between two dates
# ============================================================
def _count_timetable_in_range(  # timetable_entries count for calendar week.
    user_id: str,  # student UUID.
    week_start: str,  # YYYY-MM-DD Monday.
    week_end: str,  # YYYY-MM-DD Sunday.
    completed_only: Optional[bool] = None,  # True=completed, False=incomplete, None=all.
) -> int:  # session count.
    """Count timetable rows whose scheduled_date falls inside the week range."""

    try:  # Supabase count.
        query = (  # builder chain.
            supabase.table(TIMETABLE_TABLE)  # timetable_entries.
            .select("id", count="exact")  # exact count only.
            .eq("user_id", user_id)  # owner filter.
            .gte("scheduled_date", week_start)  # on/after Monday.
            .lte("scheduled_date", week_end)  # on/before Sunday.
        )  # end base query
        if completed_only is not None:  # optional completed filter.
            query = query.eq("completed", completed_only)  # True or False.
        result = query.execute()  # run.
        return int(getattr(result, "count", None) or 0)  # count.
    except Exception as exc:  # failure.
        print(f"[Reminders] timetable count failed: {type(exc).__name__}: {exc}")  # log.
        return 0  # zero.


# ============================================================
# HELPER: _hours_studied_in_range — sum minutes from completed sessions
# ============================================================
def _hours_studied_in_range(user_id: str, week_start: str, week_end: str) -> float:  # hours as float.
    """Sum completed session durations in the week and return decimal hours."""

    try:  # fetch completed rows in range.
        result = (  # query chain.
            supabase.table(TIMETABLE_TABLE)  # timetable_entries.
            .select("start_time, end_time, duration_minutes")  # fields needed for duration.
            .eq("user_id", user_id)  # owner.
            .eq("completed", True)  # only finished sessions count as study time.
            .gte("scheduled_date", week_start)  # week lower bound.
            .lte("scheduled_date", week_end)  # week upper bound.
            .execute()  # run.
        )  # end chain
        rows = getattr(result, "data", None) or []  # session list.
    except Exception as exc:  # read failure.
        print(f"[Reminders] hours studied read failed: {type(exc).__name__}: {exc}")  # log.
        return 0.0  # zero hours.

    total_minutes = 0  # accumulator.
    for row in rows:  # each completed session.
        mins = row.get("duration_minutes")  # prefer stored duration when present.
        if mins is None:  # compute from start/end times.
            start_time = str(row.get("start_time") or "")  # HH:MM:SS or HH:MM.
            end_time = str(row.get("end_time") or "")  # HH:MM:SS or HH:MM.
            try:  # parse first five chars as HH:MM.
                sp = start_time[:5].split(":")  # start parts.
                ep = end_time[:5].split(":")  # end parts.
                start_m = int(sp[0]) * 60 + int(sp[1])  # minutes from midnight.
                end_m = int(ep[0]) * 60 + int(ep[1])  # minutes from midnight.
                mins = max(0, end_m - start_m)  # non-negative session length.
            except (ValueError, IndexError):  # bad time strings.
                mins = 0  # skip broken row.
        total_minutes += int(mins or 0)  # add to total.

    return round(total_minutes / 60.0, 1)  # convert to hours with one decimal.


# ============================================================
# HELPER: _quiz_average_percentage — mean quiz % for completed sessions
# ============================================================
def _quiz_average_percentage(user_id: str, start_iso: str) -> float:  # 0–100 average.
    """Average (score/total_cards)*100 across completed quiz_sessions since start_iso."""

    try:  # load completed quizzes in period.
        result = (  # query.
            supabase.table(QUIZ_SESSIONS_TABLE)  # quiz_sessions.
            .select("score, total_cards")  # fields for percentage.
            .eq("user_id", user_id)  # owner.
            .eq("completed", True)  # finished sessions only.
            .gte("completed_at", start_iso)  # within calendar week (UTC).
            .execute()  # run.
        )  # end chain
        rows = getattr(result, "data", None) or []  # sessions.
    except Exception as exc:  # failure.
        print(f"[Reminders] quiz avg failed: {type(exc).__name__}: {exc}")  # log.
        return 0.0  # zero percent.

    percentages: List[float] = []  # per-session percentages.
    for row in rows:  # each completed quiz.
        total = int(row.get("total_cards") or 0)  # cards in session.
        score = int(row.get("score") or 0)  # correct count.
        if total > 0:  # avoid divide-by-zero.
            percentages.append((float(score) / float(total)) * 100.0)  # session %.

    if not percentages:  # no quizzes this week.
        return 0.0  # zero average.

    return round(sum(percentages) / len(percentages), 1)  # mean percentage.


# ============================================================
# HELPER: _normalise_exam_dates_json — parse exam_dates from Postgres
# ============================================================
def _normalise_exam_dates_json(raw: Any) -> Dict[str, str]:  # slug → YYYY-MM-DD.
    """Normalise exam_dates JSON into canonical subject slug keys."""

    if raw is None:  # null column.
        return {}  # empty map.

    data = raw  # working value.
    if isinstance(data, str):  # sometimes returned as JSON string.
        try:  # parse JSON text.
            data = json.loads(data)  # dict or list.
        except json.JSONDecodeError:  # invalid JSON.
            return {}  # empty map.

    if not isinstance(data, dict):  # expect object keyed by subject.
        return {}  # empty map.

    out: Dict[str, str] = {}  # normalised output.
    for key, val in data.items():  # each subject entry.
        if val is None:  # skip null dates.
            continue  # next key.
        date_str = str(val)[:10]  # YYYY-MM-DD portion.
        norm_key = str(key).strip().lower()  # lower slug or code string.
        if norm_key in SUBJECT_KEYS:  # already canonical.
            out[norm_key] = date_str  # store.
            continue  # next.
        if norm_key in SUBJECT_CODE_TO_KEY:  # syllabus code key.
            out[SUBJECT_CODE_TO_KEY[norm_key]] = date_str  # map to slug.
            continue  # next.
        code_key = str(key).strip()  # preserve numeric codes.
        if code_key in SUBJECT_CODE_TO_KEY:  # e.g. "9708".
            out[SUBJECT_CODE_TO_KEY[code_key]] = date_str  # map to slug.

    return out  # final dict.


# ============================================================
# HELPER: _load_exam_dates_for_user — profiles then profiles fallback
# ============================================================
def _load_exam_dates_for_user(user_id: str) -> Dict[str, str]:  # slug → exam date ISO date.
    """Load exam dates from the shared subjects table (code → exam_date)."""

    dates: Dict[str, str] = {}  # accumulator keyed by subject slug.

    try:  # query subjects rows that have an exam_date set.
        result = (  # PostgREST query chain.
            supabase.table("subjects")  # shared Cambridge subjects table.
            .select("code, exam_date")  # syllabus code and exam date columns only.
            .not_.is_("exam_date", "null")  # skip rows with no exam date.
            .execute()  # run the query.
        )  # end chain
        for row in getattr(result, "data", None) or []:  # each subject row returned.
            code = str(row.get("code") or "").strip()  # syllabus code e.g. 9708.
            exam_value = row.get("exam_date")  # date value from Postgres.
            if not code or not exam_value:  # skip incomplete rows.
                continue  # next row.
            subject_key = SUBJECT_CODE_TO_KEY.get(code)  # map code to slug (economics, etc.).
            if subject_key:  # known Cambridge code.
                dates[subject_key] = str(exam_value)[:10]  # store ISO date YYYY-MM-DD.
    except Exception as exc:  # subjects read failed.
        print(f"[Reminders] subjects exam_date failed: {exc}")  # log for server debugging.

    return dates  # may be empty if no exam dates on file.


# ============================================================
# HELPER: _days_until_exam — calendar days from today to exam date
# ============================================================
def _days_until_exam(exam_date_str: str) -> int:  # non-negative day count.
    """Return whole days from today until exam_date (0 if exam is today or past)."""

    try:  # parse exam date.
        exam_day = date.fromisoformat(exam_date_str[:10])  # YYYY-MM-DD.
    except ValueError:  # invalid date string.
        return 0  # treat as zero days.

    delta = (exam_day - date.today()).days  # signed day difference.
    return max(0, delta)  # never negative.


# ============================================================
# HELPER: _exam_countdown_color — red / gold / green by days remaining
# ============================================================
def _exam_countdown_color(days_remaining: int) -> str:  # hex colour for email text.
    """Pick countdown colour: red <30, gold <60, green otherwise."""

    if days_remaining < 30:  # urgent window.
        return "#E74C3C"  # red.
    if days_remaining < 60:  # approaching window.
        return "#D4AF37"  # gold.
    return "#2ECC71"  # green for 60+ days.


# ============================================================
# HELPER: _syllabus_topic_rows — user topics or global seed rows
# ============================================================
def _syllabus_topic_rows(user_id: str, subject_key: str) -> List[Dict[str, Any]]:  # topic dicts.
    """Load syllabus topic rows for coverage (mirrors analytics / syllabus routers)."""

    try:  # user-owned topics first.
        user_result = (  # query.
            supabase.table(SYLLABUS_TOPICS_TABLE)  # syllabus_topics.
            .select("topic_name, is_covered, created_at")  # fields for coverage email.
            .eq("user_id", user_id)  # owner.
            .eq("subject", subject_key)  # subject slug.
            .eq("is_global", False)  # personal rows only.
            .execute()  # run.
        )  # end chain
        user_rows = getattr(user_result, "data", None) or []  # list.
        if user_rows:  # prefer user syllabus when present.
            return user_rows  # done.
    except Exception as exc:  # column or table issue.
        print(f"[Reminders] syllabus user rows ({subject_key}): {type(exc).__name__}: {exc}")  # log.

    try:  # global seed topics fallback.
        global_result = (  # query.
            supabase.table(SYLLABUS_TOPICS_TABLE)  # syllabus_topics.
            .select("topic_name, is_covered, created_at")  # same fields.
            .eq("subject", subject_key)  # subject slug.
            .eq("is_global", True)  # shared seed rows.
            .is_("user_id", "null")  # no owner.
            .execute()  # run.
        )  # end chain
        return getattr(global_result, "data", None) or []  # global list or empty.
    except Exception as exc:  # failure.
        print(f"[Reminders] syllabus global rows ({subject_key}): {type(exc).__name__}: {exc}")  # log.
        return []  # empty.


# ============================================================
# HELPER: _top_uncovered_topics — five newest uncovered topic names
# ============================================================
def _top_uncovered_topics(user_id: str, subject_key: str, limit: int = 5) -> List[str]:  # topic names.
    """Return up to `limit` uncovered topics, newest created_at first."""

    rows = _syllabus_topic_rows(user_id, subject_key)  # all visible topics.
    uncovered = [r for r in rows if not r.get("is_covered")]  # filter not covered.
    uncovered.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)  # newest first.
    names: List[str] = []  # output labels.
    for row in uncovered[:limit]:  # take first N.
        name = str(row.get("topic_name") or "").strip()  # topic label.
        if name:  # skip blanks.
            names.append(name)  # collect.
    return names  # up to five strings.


# ============================================================
# HELPER: _call_groq_text — short motivational copy via Groq
# ============================================================
def _call_groq_text(prompt: str, max_tokens: int) -> str:  # plain-text reply.
    """Call Groq chat completions and return stripped assistant text."""

    try:  # lazy import matches flashcards / notes routers.
        from main import groq_client  # noqa: WPS433 — shared Groq client from main.py.
    except Exception as exc:  # main not ready.
        print(f"[Reminders] groq_client import failed: {type(exc).__name__}: {exc}")  # log.
        return ""  # empty fallback.

    try:  # Groq API call.
        completion = groq_client.chat.completions.create(  # chat completion request.
            model=GROQ_MODEL,  # llama-3.3-70b-versatile.
            messages=[{"role": "user", "content": prompt}],  # single user prompt.
            max_tokens=max_tokens,  # token cap per email type.
            temperature=GROQ_REMINDER_TEMPERATURE,  # 0.8 warm tone.
        )  # end create
        raw = completion.choices[0].message.content or ""  # first choice text.
        return raw.strip()  # trimmed plain text.
    except Exception as exc:  # Groq outage or rate limit.
        print(f"[Reminders] Groq call failed: {type(exc).__name__}: {exc}")  # log.
        return ""  # caller supplies static fallback.


# ============================================================
# HELPER: _send_email — deliver HTML via Brevo transactional API
# ============================================================
def _send_email(to_email: str, subject: str, html: str) -> None:  # raises on failure.
    """Send one HTML email through Brevo to the student's preference address."""

    # Configure Brevo API client
    configuration = sib_api_v3_sdk.Configuration()  # fresh SDK configuration object
    configuration.api_key['api-key'] = BREVO_API_KEY  # attach API key for authenticated sends

    # Create API instance
    api_instance = sib_api_v3_sdk.TransactionalEmailsApi(  # transactional email API client
        sib_api_v3_sdk.ApiClient(configuration)  # HTTP client bound to the configuration above
    )

    # Build email object
    send_smtp_email = sib_api_v3_sdk.SendSmtpEmail(  # Brevo payload for one HTML message
        to=[{"email": to_email}],  # recipient list (student email from reminder_preferences)
        sender={"name": "AscendAI", "email": "ascend.ai.study@gmail.com"},  # from name + address
        subject=subject,  # inbox subject line (unchanged from caller)
        html_content=html  # full HTML body from get_email_wrapper or inline builders
    )

    # Log before send so Render logs show which message is in flight.
    print(f"[Reminders] Sending email to {to_email} subject: {subject}")  # pre-send trace line.

    try:  # deliver via Brevo; log success or re-raise on failure.
        api_instance.send_transac_email(send_smtp_email)  # POST to Brevo transactional API.
        print(f"[Reminders] Email sent successfully to {to_email}")  # confirm delivery in logs.
    except ApiException as exc:  # Brevo returned a structured API error.
        print(f"[Reminders] Brevo API error: {exc}")  # log Brevo response body / status.
        raise  # propagate so callers can return HTTP 500.
    except Exception as exc:  # network, auth, or unexpected failure.
        print(f"[Reminders] Email send failed: {type(exc).__name__}: {exc}")  # log exception type.
        raise  # propagate to caller.


# Data the frontend sends when testing email delivery.
class TestEmailRequest(BaseModel):  # Pydantic schema for POST /reminders/test-email body.
    email: str  # Recipient address to receive the test message.


# JSON body shape for saving a student's email reminder settings.
class ReminderPreferences(BaseModel):  # Pydantic schema for POST /reminders/preferences body.
    user_id: str  # the unique ID of the student
    email: str  # the email address to send reminders to
    daily_reminder: bool  # True if student wants daily study schedule email
    weekly_report: bool  # True if student wants weekly progress report email
    exam_alert: bool  # True if student wants exam countdown alert email
    reminder_time: str  # time to send daily reminder e.g. "08:00"


# Response shape for GET /reminders/preferences — same fields as the save body (without user_id).
class ReminderPreferencesOut(BaseModel):  # Pydantic schema for preferences returned to the dashboard.
    email: str  # the email address to send reminders to
    daily_reminder: bool  # True if student wants daily study schedule email
    weekly_report: bool  # True if student wants weekly progress report email
    exam_alert: bool  # True if student wants exam countdown alert email
    reminder_time: str  # time to send daily reminder e.g. "08:00"


# JSON body shape for triggering a daily study-schedule reminder email.
class DailyReminderRequest(BaseModel):  # Pydantic schema for POST /reminders/send-daily body.
    user_id: str  # the unique ID of the student whose timetable we are fetching


# NOTE: Resend free tier restricts sending to account owner email only until a custom domain is verified
# Once domain is verified this restriction is lifted and emails can be sent to any address
@router.post("/test-email")  # POST /reminders/test-email — verify Resend delivery works.
async def send_test_email(body: TestEmailRequest):  # body is validated JSON from the frontend.
    # Send a one-off test email so the student can confirm Resend delivery.

    try:  # Catch any Brevo or network failure and return HTTP 500.
        _send_email(  # deliver test message via Brevo helper.
            body.email.strip(),  # recipient from request body (student's inbox)
            "AscendAI — Email Reminders Active",  # inbox subject line (unchanged).
            "<h2>Your study reminders are set up correctly.</h2><p>AscendAI will now send you daily study schedules, weekly progress reports, and exam alerts.</p>",  # HTML body (unchanged).
        )  # end _send_email
        return {"success": True, "message": "Test email sent successfully"}  # JSON success response for the frontend.
    except Exception:  # Any send failure becomes a 500 for the client.
        raise HTTPException(status_code=500, detail="Failed to send test email")  # Generic error — no internal details exposed.


@router.post("/preferences")  # POST /reminders/preferences — save or update reminder settings.
async def save_reminder_preferences(body: ReminderPreferences):  # body is validated ReminderPreferences JSON.
    # Persist the student's reminder toggles and delivery time to Supabase.

    try:  # Catch any Supabase failure and return HTTP 500.
        upsert_payload = {  # Row dict passed to Supabase upsert.
            "user_id": body.user_id,  # the unique ID of the student
            "email": body.email,  # the email address to send reminders to
            "daily_reminder": body.daily_reminder,  # True if student wants daily study schedule email
            "weekly_report": body.weekly_report,  # True if student wants weekly progress report email
            "exam_alert": body.exam_alert,  # True if student wants exam countdown alert email
            "reminder_time": body.reminder_time,  # time to send daily reminder e.g. "08:00"
        }  # End of upsert payload.
        supabase.table("reminder_preferences").upsert(upsert_payload, on_conflict="user_id").execute()  # insert or update on user_id conflict
        return {"success": True, "message": "Reminder preferences saved"}  # JSON success response for the frontend.
    except Exception:  # Any database error becomes a 500 for the client.
        raise HTTPException(status_code=500, detail="Failed to save preferences")  # Generic error — no internal details exposed.


@router.get("/preferences")  # GET /reminders/preferences — load saved reminder settings.
async def get_reminder_preferences(  # no body; user_id comes from the Bearer token.
    verified_user_id: str = Depends(verify_bearer_token),  # authenticated student UUID.
) -> ReminderPreferencesOut:  # typed JSON for OpenAPI docs and the dashboard form.
    # Return saved preferences or sensible defaults when the row does not exist yet.

    prefs = _fetch_preferences(verified_user_id)  # read reminder_preferences for this user.
    if not prefs:  # first visit — no row in Supabase yet.
        return ReminderPreferencesOut(  # default toggles on so reminders work out of the box.
            email="",  # empty until the student types an address.
            daily_reminder=True,  # daily schedule email enabled by default.
            weekly_report=True,  # Sunday weekly report enabled by default.
            exam_alert=True,  # exam countdown alerts enabled by default.
            reminder_time="08:00",  # default morning send time.
        )  # end defaults

    return ReminderPreferencesOut(  # map database columns to API field names.
        email=str(prefs.get("email") or ""),  # delivery address.
        daily_reminder=bool(prefs.get("daily_reminder", True)),  # daily toggle.
        weekly_report=bool(prefs.get("weekly_report", True)),  # weekly toggle.
        exam_alert=bool(prefs.get("exam_alert", True)),  # exam alert toggle.
        reminder_time=str(prefs.get("reminder_time") or "08:00"),  # HH:MM send time.
    )  # end saved preferences


@router.post("/send-daily")  # POST /reminders/send-daily — email today's study sessions.
async def send_daily_reminder(body: DailyReminderRequest):  # body carries the student user_id to look up.
    # Build and send the daily study-schedule email for one student.

    try:  # Wrap all steps; unexpected errors become HTTP 500.
        today = datetime.now().strftime("%Y-%m-%d")  # gets today's date in the exact format Supabase stores it e.g. 2026-05-17
        timetable_result = (  # Supabase query for today's sessions (same client as timetable.py).
            supabase.table("timetable_entries")  # timetable rows for this student.
            .select("start_time, end_time, duration_minutes, topic, subjects(name)")  # session times + joined subject name.
            .eq("user_id", body.user_id)  # only this student's rows.
            .eq("scheduled_date", today)  # fetch only sessions scheduled for today's date
            .execute()  # run the PostgREST query.
        )  # end timetable query chain
        sessions = getattr(timetable_result, "data", None) or []  # list of matching timetable rows (may be empty).

        if not sessions:  # no sessions today — use the empty-state copy.
            sessions_html = "<p>You have no study sessions scheduled for today. Use this time to review your weakest subject.</p>"  # empty-day message
        else:  # at least one session — build an HTML table of rows.
            table_rows_html = ""  # accumulates <tr> cells for each session.
            for session in sessions:  # one row per timetable entry.
                subj_embed = session.get("subjects")  # PostgREST nested subject object.
                if isinstance(subj_embed, list):  # join sometimes returns a one-element list.
                    subj_embed = subj_embed[0] if subj_embed else None  # take first subject dict if present.
                subject = (  # display name for the Subject column.
                    (subj_embed.get("name") if isinstance(subj_embed, dict) else None)  # prefer joined subjects.name.
                    or session.get("subject")  # fallback if a flat subject column exists.
                    or session.get("topic")  # fallback to topic/title text.
                    or "Study session"  # last-resort label.
                )  # end subject resolution
                start_time = str(session.get("start_time") or "")  # session start HH:MM from DB.
                end_time = str(session.get("end_time") or "")  # session end HH:MM from DB.
                duration_minutes = session.get("duration_minutes")  # use DB value when the column is populated.
                if duration_minutes is None:  # compute minutes from start/end when column is absent.
                    start_parts = str(start_time)[:5].split(":")  # HH and MM from start_time.
                    end_parts = str(end_time)[:5].split(":")  # HH and MM from end_time.
                    start_mins = int(start_parts[0]) * 60 + int(start_parts[1])  # start as minutes since midnight.
                    end_mins = int(end_parts[0]) * 60 + int(end_parts[1])  # end as minutes since midnight.
                    duration_minutes = end_mins - start_mins  # length of the session in minutes.
                table_rows_html += (  # append one styled table row for this session.
                    f"<tr>"  # open table row for this session.
                    f"<td style='padding:8px;border-bottom:1px solid #D4AF37;'>{subject}</td>"  # subject column cell.
                    f"<td style='padding:8px;border-bottom:1px solid #D4AF37;'>{start_time}</td>"  # start time column cell.
                    f"<td style='padding:8px;border-bottom:1px solid #D4AF37;'>{end_time}</td>"  # end time column cell.
                    f"<td style='padding:8px;border-bottom:1px solid #D4AF37;'>{duration_minutes}</td>"  # duration column cell.
                    f"</tr>"  # close table row for this session.
                )  # end row append
            sessions_html = (  # full table wrapper with AscendAI navy/gold/cream inline styles.
                "<table style='width:100%;border-collapse:collapse;background:#0A0F1E;color:#EDE9D8;'>"  # outer table element.
                "<thead><tr>"  # table header row.
                "<th style='padding:8px;text-align:left;color:#D4AF37;'>Subject</th>"  # subject column heading.
                "<th style='padding:8px;text-align:left;color:#D4AF37;'>Start</th>"  # start column heading.
                "<th style='padding:8px;text-align:left;color:#D4AF37;'>End</th>"  # end column heading.
                "<th style='padding:8px;text-align:left;color:#D4AF37;'>Minutes</th>"  # duration column heading.
                "</tr></thead><tbody>"  # close header and open body.
                f"{table_rows_html}"  # inject one row per session.
                "</tbody></table>"  # close body and table.
            )  # end sessions_html table

        email_html = (  # complete HTML body sent through Resend.
            f"<div style='background:#0A0F1E;color:#EDE9D8;padding:24px;font-family:sans-serif;'>"  # outer email wrapper div.
            f"<h1 style='color:#D4AF37;margin:0 0 16px;'>Your Study Schedule for {today}</h1>"  # shows the actual date in the email heading
            f"{sessions_html}"  # sessions table or empty-state paragraph.
            f"</div>"  # close outer email wrapper div.
        )  # end email_html — closes outer div wrapper

        prefs_result = (  # fetch reminder_preferences so we know where to send mail.
            supabase.table("reminder_preferences")  # one row per student email settings.
            .select("email")  # only need the delivery address column.
            .eq("user_id", body.user_id)  # match the student from the request body.
            .limit(1)  # at most one preferences row per user_id.
            .execute()  # run the PostgREST query.
        )  # end preferences query chain
        prefs_rows = getattr(prefs_result, "data", None) or []  # list of preference rows (0 or 1).
        if not prefs_rows:  # student has never saved preferences.
            raise HTTPException(status_code=404, detail="No reminder preferences found for this user")  # tell caller to save prefs first
        student_email = str(prefs_rows[0].get("email") or "").strip()  # delivery address from reminder_preferences
        if not student_email:  # preferences row without email
            raise HTTPException(status_code=404, detail="No email on file in reminder preferences")  # cannot send

        _send_email(  # deliver the daily schedule via Brevo.
            student_email,  # student email from reminder_preferences
            f"AscendAI — Your Study Schedule for {today}",  # inbox subject shows today's date like the email heading
            email_html,  # full HTML schedule built in STEP 2 (unchanged).
        )  # end _send_email
        return {  # success JSON for the frontend or cron caller.
            "success": True,  # operation completed without error.
            "message": "Daily reminder sent",  # human-readable confirmation.
            "sessions_count": len(sessions),  # how many timetable rows were included.
        }  # end return dict
    except HTTPException:  # re-raise 404 (and any other HTTPException) unchanged.
        raise  # do not convert intentional 404 into 500.
    except Exception:  # any other failure (Supabase, Resend, parsing).
        raise HTTPException(status_code=500, detail="Failed to send daily reminder")  # generic error for the client.


@router.post("/send-weekly")  # POST /reminders/send-weekly — weekly progress report email.
async def send_weekly_reminder(  # no body; user_id from JWT.
    verified_user_id: str = Depends(verify_bearer_token),  # authenticated student UUID.
):
    # Build and send the weekly progress report for the logged-in student.

    try:  # wrap all steps; failures become HTTP 500 unless early return.
        prefs = _fetch_preferences(verified_user_id)  # load reminder_preferences row.
        if not prefs or not prefs.get("weekly_report"):  # missing row or weekly emails disabled.
            return {  # early exit without sending mail.
                "sent": False,  # nothing delivered.
                "message": "Weekly report disabled or preferences not found",  # reason for caller.
            }  # end early return

        user_email = str(prefs.get("email") or "").strip()  # delivery address from preferences.
        if not user_email:  # preferences row without email.
            return {"sent": False, "message": "No email on file in reminder preferences"}  # cannot send.

        monday, sunday = _current_calendar_week()  # calendar week bounds (Mon–Sun).
        week_start_iso = _week_start_iso(monday)  # UTC timestamp for created_at filters.
        monday_label = monday.strftime("%d %b %Y")  # human-readable Monday label.
        sunday_label = sunday.strftime("%d %b %Y")  # human-readable Sunday label.

        total_sessions = _count_timetable_in_range(  # all sessions scheduled this week.
            verified_user_id, monday.isoformat(), sunday.isoformat(), completed_only=None  # any completion state.
        )  # end total_sessions count
        completed_sessions = _count_timetable_in_range(  # completed sessions this week.
            verified_user_id, monday.isoformat(), sunday.isoformat(), completed_only=True  # completed only.
        )  # end completed_sessions count
        hours_studied = _hours_studied_in_range(  # decimal hours from completed sessions.
            verified_user_id, monday.isoformat(), sunday.isoformat()  # same week range.
        )  # end hours_studied
        questions_asked = _count_table_rows(  # homework questions asked since Monday UTC.
            HOMEWORK_TABLE, verified_user_id, "created_at", week_start_iso, None  # no extra filters.
        )  # end questions_asked
        _flashcard_sessions = _count_table_rows(  # flashcard quiz sessions started this week (spec step 3).
            QUIZ_SESSIONS_TABLE, verified_user_id, "started_at", week_start_iso, None  # count for weekly stats bundle.
        )  # end flashcard_sessions — available for future email layout expansion
        avg_quiz = _quiz_average_percentage(verified_user_id, week_start_iso)  # mean quiz % this week.

        exam_dates = _load_exam_dates_for_user(verified_user_id)  # slug → exam date for countdown block.
        countdown_html = ""  # HTML lines for each subject countdown.
        for subject_key in SUBJECT_KEYS:  # iterate canonical subjects.
            exam_date = exam_dates.get(subject_key)  # ISO date or missing.
            if not exam_date:  # no exam date on file.
                continue  # skip subject.
            days_left = _days_until_exam(exam_date)  # non-negative day count.
            colour = _exam_countdown_color(days_left)  # red / gold / green hex.
            label = SUBJECT_LABELS.get(subject_key, subject_key.title())  # display name.
            countdown_html += (  # append one line per subject.
                f"<p style='color:{colour};margin:6px 0;'>"
                f"<strong>{label}</strong> — {days_left} days remaining (exam {exam_date})"
                f"</p>"
            )  # end line
        if not countdown_html:  # no exam dates configured.
            countdown_html = "<p style='color:rgba(237,233,216,0.6);'>No exam dates on file yet.</p>"  # placeholder.

        groq_prompt = (  # motivational copy prompt for Groq.
            f"Write 2 encouraging sentences for a Cambridge AS Level student in Zambia "
            f"who completed {completed_sessions} study sessions this week and has exams coming up. "
            f"Be warm, specific, and motivating. No markdown."
        )  # end prompt
        motivation = _call_groq_text(groq_prompt, GROQ_WEEKLY_MAX_TOKENS)  # AI encouragement paragraph.
        if not motivation:  # Groq unavailable.
            motivation = (  # static fallback copy.
                "You showed up this week — that consistency is what Cambridge rewards. "
                "Keep building momentum before your exams."
            )  # end fallback

        inner_html = (  # body HTML passed into get_email_wrapper.
            f"<p style='color:#EDE9D8;margin:0 0 16px;'>Week of {monday_label} — {sunday_label}</p>"
            f"<div style='text-align:center;margin-bottom:20px;'>"
            f"<span class='stat-box'><span class='stat-number'>{completed_sessions}/{total_sessions}</span>"
            f"<br><span class='stat-label'>Sessions Completed</span></span>"
            f"<span class='stat-box'><span class='stat-number'>{hours_studied}h</span>"
            f"<br><span class='stat-label'>Hours Studied</span></span>"
            f"<span class='stat-box'><span class='stat-number'>{questions_asked}</span>"
            f"<br><span class='stat-label'>Questions Asked</span></span>"
            f"<span class='stat-box'><span class='stat-number'>{avg_quiz}%</span>"
            f"<br><span class='stat-label'>Avg Quiz Score</span></span>"
            f"</div>"
            f"<h2 style='color:#D4AF37;font-size:16px;margin:24px 0 8px;'>Exam countdown</h2>"
            f"{countdown_html}"
            f"<p style='color:#EDE9D8;margin-top:24px;font-style:italic;'>{motivation}</p>"
        )  # end inner_html

        email_html = get_email_wrapper(inner_html, "Weekly Progress Report")  # full HTML document.
        _send_email(  # deliver via Brevo.
            user_email,  # preference email from reminder_preferences.
            "AscendAI — Your Weekly Progress Report",  # fixed subject line from spec.
            email_html,  # HTML body.
        )  # end send

        return {"sent": True, "email": user_email}  # success payload from spec.

    except HTTPException:  # pass through deliberate HTTP errors.
        raise  # unchanged.
    except Exception:  # unexpected failure.
        raise HTTPException(status_code=500, detail="Failed to send weekly reminder")  # generic 500.


@router.post("/send-exam-alert")  # POST /reminders/send-exam-alert — urgent exam warning email.
async def send_exam_alert(  # no body; user_id from JWT.
    verified_user_id: str = Depends(verify_bearer_token),  # authenticated student UUID.
):
    # Send exam alert when any subject exam is within 14 days.

    try:  # wrap steps; map failures to HTTP 500 unless early return.
        prefs = _fetch_preferences(verified_user_id)  # load reminder_preferences row.
        if not prefs or not prefs.get("exam_alert"):  # missing or exam alerts disabled.
            return {  # early exit.
                "sent": False,  # not sent.
                "message": "Exam alerts disabled or preferences not found",  # reason.
            }  # end return

        user_email = str(prefs.get("email") or "").strip()  # delivery address.
        if not user_email:  # no email stored.
            return {"sent": False, "message": "No email on file in reminder preferences"}  # cannot send.

        exam_dates = _load_exam_dates_for_user(verified_user_id)  # slug → exam date.
        urgent: List[Tuple[str, int, str]] = []  # (slug, days_left, date_str) within 14 days.
        for subject_key in SUBJECT_KEYS:  # check each subject.
            exam_date = exam_dates.get(subject_key)  # ISO date or None.
            if not exam_date:  # not scheduled.
                continue  # next subject.
            days_left = _days_until_exam(exam_date)  # calendar days remaining.
            if days_left <= 14:  # within alert window from spec.
                urgent.append((subject_key, days_left, exam_date))  # collect alert candidate.

        if not urgent:  # no exam within 14 days.
            return {  # spec response when nothing to alert.
                "sent": False,  # not sent.
                "message": "No exams within 14 days",  # exact message from spec.
            }  # end return

        urgent.sort(key=lambda item: item[1])  # sort by days_left ascending (most urgent first).
        focus_key, focus_days, focus_date = urgent[0]  # primary subject for email body.
        subjects_alerted = [SUBJECT_LABELS.get(k, k) for k, _, _ in urgent]  # display names list.

        topic_rows = _syllabus_topic_rows(verified_user_id, focus_key)  # syllabus rows for focus subject.
        total_topics = len(topic_rows)  # denominator for coverage bar.
        covered_count = sum(1 for r in topic_rows if r.get("is_covered"))  # numerator.
        coverage_pct = int(round((covered_count / total_topics) * 100)) if total_topics else 0  # percentage.
        topics_remaining = max(0, total_topics - covered_count)  # uncovered count.
        top_topics = _top_uncovered_topics(verified_user_id, focus_key, limit=5)  # five newest uncovered names.

        topics_list_html = ""  # bullet list of uncovered topics.
        if top_topics:  # we have topic names.
            for topic_name in top_topics:  # each uncovered topic.
                topics_list_html += f"<li style='margin:4px 0;color:#EDE9D8;'>{topic_name}</li>"  # list item.
        else:  # syllabus empty.
            topics_list_html = "<li style='color:rgba(237,233,216,0.6);'>No syllabus topics loaded yet</li>"  # placeholder.

        subject_label = SUBJECT_LABELS.get(focus_key, focus_key.title())  # heading subject name.
        timetable_url = f"{FRONTEND_BASE_URL}/features/timetable"  # deep link to timetable feature.
        syllabus_url = f"{FRONTEND_BASE_URL}/syllabus"  # deep link to syllabus tracker (app route).

        exam_prompt = (  # one-sentence Groq prompt for closing line.
            f"Write 1 motivating sentence for a Cambridge AS Level student in Zambia whose "
            f"{subject_label} exam is in {focus_days} days with {coverage_pct}% syllabus coverage. "
            f"No markdown."
        )  # end prompt
        closing_line = _call_groq_text(exam_prompt, GROQ_EXAM_MAX_TOKENS)  # AI closing sentence.
        if not closing_line:  # Groq fallback.
            closing_line = "You still have time — focus your next sessions on the gaps below."  # static line.

        inner_html = (  # exam alert body HTML.
            f"<div style='background:#E74C3C;padding:16px 20px;text-align:center;margin:-28px -32px 24px;'>"
            f"<span style='color:#FFFFFF;font-weight:700;font-size:18px;letter-spacing:0.08em;'>EXAM ALERT</span>"
            f"</div>"
            f"<h1 style='color:#D4AF37;font-size:28px;margin:0 0 8px;'>{subject_label}</h1>"
            f"<p style='color:#EDE9D8;font-size:20px;margin:0 0 20px;'>{focus_days} days remaining — exam on {focus_date}</p>"
            f"<p style='color:rgba(237,233,216,0.7);margin:0 0 8px;'>Syllabus coverage</p>"
            f"<div style='background:#1A2235;border-radius:8px;height:12px;overflow:hidden;margin-bottom:8px;'>"
            f"<div style='width:{coverage_pct}%;height:100%;background:#D4AF37;'></div>"
            f"</div>"
            f"<p style='color:#EDE9D8;margin:0 0 16px;'>{coverage_pct}% covered — <strong>{topics_remaining}</strong> topics still to cover</p>"
            f"<p style='color:#D4AF37;margin:0 0 8px;font-size:13px;'>Top topics to focus on:</p>"
            f"<ul style='margin:0 0 24px;padding-left:20px;'>{topics_list_html}</ul>"
            f"<p style='margin:0 0 12px;'>"
            f"<a href='{timetable_url}' style='display:inline-block;background:#1A2235;border:1px solid #D4AF37;"
            f"padding:10px 16px;border-radius:8px;margin-right:8px;'>Open Timetable</a>"
            f"<a href='{syllabus_url}' style='display:inline-block;background:#1A2235;border:1px solid #D4AF37;"
            f"padding:10px 16px;border-radius:8px;'>View Syllabus</a>"
            f"</p>"
            f"<p style='color:#EDE9D8;font-style:italic;margin-top:16px;'>{closing_line}</p>"
        )  # end inner_html

        email_html = get_email_wrapper(inner_html, "Exam Alert")  # wrap with shared template.
        subject_line = f"⚠ AscendAI — {subject_label} Exam in {focus_days} Days"  # spec subject format.
        _send_email(user_email, subject_line, email_html)  # send via Resend.

        return {"sent": True, "subjects_alerted": subjects_alerted}  # success payload from spec.

    except HTTPException:  # deliberate HTTP errors unchanged.
        raise  # re-raise.
    except Exception:  # unexpected errors.
        raise HTTPException(status_code=500, detail="Failed to send exam alert")  # generic 500.


# ================================================
# INTERNAL TRIGGER ENDPOINTS — called by n8n only
# No authentication required
# Use service role key to access all users
# Update n8n HTTP nodes to call these URLs:
# POST /reminders/trigger-daily (no auth header)
# POST /reminders/trigger-weekly (no auth header)
# POST /reminders/trigger-exam-alert (no auth header)
# ================================================


# JSON response for batch daily / weekly trigger endpoints.
class TriggerBatchResponse(BaseModel):  # Pydantic schema for n8n cron responses.
    triggered: int  # number of emails sent successfully
    errors: int  # number of users whose send failed
    total_users: int  # total preference rows considered


# JSON response for batch exam-alert trigger endpoint.
class TriggerExamAlertResponse(BaseModel):  # Pydantic schema for exam alert cron.
    triggered: int  # number of alert emails sent
    skipped: int  # users with no exam within 14 days
    errors: int  # send failures


# ============================================================
# HELPER: _prefs_rows_with_email — filter reminder_preferences rows
# ============================================================
def _prefs_rows_with_email(  # load rows where a boolean toggle is true and email is set.
    toggle_column: str,  # e.g. daily_reminder, weekly_report, exam_alert
) -> List[Dict[str, Any]]:  # list of preference dicts.
    """Query reminder_preferences where toggle is true and email is non-empty."""

    try:  # Supabase read via service-role client from database.py.
        result = (  # chain query builder.
            supabase.table(REMINDER_PREFS_TABLE)  # reminder_preferences table.
            .select("*")  # all columns including user_id and email.
            .eq(toggle_column, True)  # only students who opted into this email type.
            .execute()  # run PostgREST query.
        )  # end chain
        rows = getattr(result, "data", None) or []  # normalise to list.
    except Exception as exc:  # table or network error.
        print(f"[Reminders] prefs query failed ({toggle_column}): {type(exc).__name__}: {exc}")  # log.
        return []  # empty list — caller treats as zero users.

    out: List[Dict[str, Any]] = []  # filtered rows with deliverable email.
    for row in rows:  # each preferences row.
        email = str(row.get("email") or "").strip()  # delivery address string.
        if email:  # skip blank emails per n8n spec.
            out.append(row)  # keep row for processing.
    return out  # final list


# ============================================================
# HELPER: _get_first_name — display name for email greeting
# ============================================================
def _get_first_name(user_id: str) -> str:  # first name or fallback "Student".
    """Load first token of profiles.full_name for email greeting."""

    try:  # profiles.full_name from onboarding POST /onboarding/profile.
        result = (  # query chain.
            supabase.table(PROFILES_TABLE)  # profiles table.
            .select("full_name")  # display name from onboarding POST /onboarding/profile.
            .eq("user_id", user_id)  # owner filter.
            .limit(1)  # one row.
            .execute()  # run query.
        )  # end chain
        rows = getattr(result, "data", None) or []  # rows list.
        if rows:  # profile exists.
            full = str(rows[0].get("full_name") or "").strip()  # full display name.
            if full:  # use first word as greeting.
                return full.split()[0]  # e.g. "Aisha" from "Aisha Khan".
    except Exception as exc:  # read failure.
        print(f"[Reminders] profiles full_name: {type(exc).__name__}: {exc}")  # log.

    return "Student"  # spec fallback when no name on file.


# ============================================================
# HELPER: _format_time_hh_mm — trim DB time to HH:MM for emails
# ============================================================
def _format_time_hh_mm(raw: Any) -> str:  # HH:MM display string.
    """Return first five characters of a time value (HH:MM)."""

    return str(raw or "")[:5]  # e.g. "15:00:00" → "15:00"


# ============================================================
# HELPER: _fetch_today_incomplete_sessions — timetable for trigger-daily
# ============================================================
def _fetch_today_incomplete_sessions(user_id: str, today: str) -> List[Dict[str, Any]]:  # session rows.
    """Load incomplete timetable_entries for today ordered by start_time ASC."""

    try:  # Supabase read.
        result = (  # query chain.
            supabase.table(TIMETABLE_TABLE)  # timetable_entries.
            .select("start_time, end_time, topic, subjects(name)")  # times + joined subject name.
            .eq("user_id", user_id)  # owner filter.
            .eq("scheduled_date", today)  # today's date YYYY-MM-DD (live column name).
            .eq("completed", False)  # incomplete sessions only per n8n spec.
            .order("start_time", desc=False)  # ascending by start_time.
            .execute()  # run query.
        )  # end chain
        return getattr(result, "data", None) or []  # session list (may be empty).
    except Exception as exc:  # query failure.
        print(f"[Reminders] today sessions failed user={user_id}: {type(exc).__name__}: {exc}")  # log.
        return []  # empty — email will show no-sessions copy.


# ============================================================
# HELPER: _build_trigger_daily_sessions_html — list HTML for daily email
# ============================================================
def _build_trigger_daily_sessions_html(sessions: List[Dict[str, Any]]) -> str:  # HTML fragment.
    """Build div-per-session HTML for trigger-daily email body."""

    if not sessions:  # no incomplete sessions today.
        return "<p style='color:rgba(237,233,216,0.6);font-size:13px;'>No sessions scheduled for today</p>"  # empty copy.

    parts: List[str] = []  # accumulated session divs.
    for session in sessions:
        subj_embed = session.get("subjects")
        if isinstance(subj_embed, list):
            subj_embed = subj_embed[0] if subj_embed else None
        subject = (
            (subj_embed.get("name") if isinstance(subj_embed, dict) else None)
            or session.get("topic")
            or "Study session"
        )
        topic = str(session.get("topic") or subject)
        start_time = _format_time_hh_mm(session.get("start_time"))
        end_time = _format_time_hh_mm(session.get("end_time"))
        parts.append(
            '<div style="padding:8px 0;border-bottom:1px solid rgba(212,175,55,0.1)">'
            f'<span style="color:#D4AF37;font-weight:500">{subject}</span> — {topic}<br>'
            f'<span style="color:rgba(237,233,216,0.5);font-size:12px">{start_time} – {end_time}</span>'
            "</div>"
        )
    return "".join(parts)  # concatenated session HTML


# ============================================================
# HELPER: _trigger_weekly_exam_row_color — countdown colours for weekly email
# ============================================================
def _trigger_weekly_exam_row_color(days_remaining: int) -> str:  # hex colour per n8n spec.
    """Red <30 days, gold <60 days, green otherwise (#27AE60)."""

    if days_remaining < 30:  # urgent.
        return "#E74C3C"  # red.
    if days_remaining < 60:  # approaching.
        return "#D4AF37"  # gold.
    return "#27AE60"  # green for 60+ days per spec.


# ============================================================
# HELPER: _build_trigger_weekly_exam_html — exam countdown block
# ============================================================
def _build_trigger_weekly_exam_html(exam_dates: Dict[str, str]) -> str:  # HTML fragment.
    """Build exam countdown rows for trigger-weekly email."""

    if not exam_dates:  # no dates configured.
        return "<p style='color:rgba(237,233,216,0.5);font-size:12px;'>No exam dates on file yet.</p>"  # placeholder.

    lines: List[str] = []  # HTML lines per subject.
    today = date.today()  # calendar today for day diff.
    for subject_key in SUBJECT_KEYS:  # canonical subjects.
        exam_date_str = exam_dates.get(subject_key)  # YYYY-MM-DD or missing.
        if not exam_date_str:  # skip unset subject.
            continue  # next subject.
        try:  # parse exam date.
            exam_day = date.fromisoformat(exam_date_str[:10])  # date object.
        except ValueError:  # bad date string.
            continue  # skip.
        days = (exam_day - today).days  # signed days until exam.
        days = max(0, days)  # never negative in copy.
        colour = _trigger_weekly_exam_row_color(days)  # red / gold / green.
        label = SUBJECT_LABELS.get(subject_key, subject_key.title())  # display name.
        lines.append(  # one row per subject.
            f'<p style="color:{colour};font-size:13px;margin:4px 0;">'
            f"<strong>{label}</strong> — {days} days remaining"
            f"</p>"
        )  # end row
    return "".join(lines) if lines else "<p style='color:rgba(237,233,216,0.5);'>No exam dates on file yet.</p>"  # fallback


# ============================================================
# HELPER: _syllabus_coverage_stats — covered/total/pct for exam alert
# ============================================================
def _syllabus_coverage_stats(  # coverage numbers for one subject.
    user_id: str,  # student UUID.
    subject_key: str,  # economics | business | english | ict.
) -> Tuple[int, int, int, List[str]]:  # covered, total, pct, top 5 uncovered names.
    """Count syllabus topics and return top five uncovered topic names."""

    rows = _syllabus_topic_rows(user_id, subject_key)  # user rows or global fallback.
    total = len(rows)  # denominator.
    covered = sum(1 for r in rows if r.get("is_covered"))  # numerator.
    pct = int((covered / total) * 100) if total > 0 else 0  # integer percent.
    top_uncovered = _top_uncovered_topics(user_id, subject_key, limit=5)  # up to five names.
    return covered, total, pct, top_uncovered  # tuple for email template


@router.post("/trigger-daily", response_model=TriggerBatchResponse)  # POST /reminders/trigger-daily — n8n cron.
async def trigger_daily_reminders() -> TriggerBatchResponse:  # no auth; loops all opted-in users.
    # Batch-send daily study session emails to every student with daily_reminder enabled.

    prefs_rows = _prefs_rows_with_email("daily_reminder")  # STEP 2 — all daily opt-ins with email.
    total_count = len(prefs_rows)  # total users to process.
    success_count = 0  # emails sent OK.
    error_count = 0  # send failures.

    today = datetime.now().strftime("%Y-%m-%d")  # STEP 3b — today's date string for queries and subject line.

    for row in prefs_rows:  # STEP 3 — foreach user.
        user_id = str(row.get("user_id") or "")  # STEP 3a — student UUID.
        to_email = str(row.get("email") or "").strip()  # delivery address from preferences.
        if not user_id or not to_email:  # guard missing ids.
            error_count += 1  # count as error.
            continue  # next user.

        try:  # per-user send — failure must not stop the batch.
            sessions = _fetch_today_incomplete_sessions(user_id, today)  # STEP 3c — incomplete sessions today.
            first_name = _get_first_name(user_id)  # STEP 3d — greeting name.
            sessions_html = _build_trigger_daily_sessions_html(sessions)  # STEP 3e — session list HTML.

            title = "Your Study Sessions Today"  # STEP 3f — email wrapper title.
            content = (  # STEP 3f — inner HTML body per n8n spec.
                f"<h2 style=\"color:#EDE9D8;font-family:Georgia,serif;"
                f"font-size:20px;margin:0 0 8px\">"
                f"Good morning, {first_name}!</h2>"
                f"<p style=\"color:rgba(237,233,216,0.6);font-size:13px;"
                f"margin:0 0 20px\">"
                f"Here are your study sessions for today:</p>"
                f"{sessions_html}"
                f"<div style=\"margin-top:20px;padding:14px 16px;"
                f"background:rgba(212,175,55,0.08);"
                f"border-left:2px solid #D4AF37;border-radius:6px\">"
                f"<p style=\"color:rgba(237,233,216,0.7);font-size:12px;"
                f"margin:0\">"
                f"Open AscendAI to mark sessions complete and "
                f"track your progress.</p>"
                f"</div>"
            )  # end content

            html = get_email_wrapper(content, title)  # STEP 3g — full HTML document.
            subject = f"AscendAI — Study Sessions for {today}"  # inbox subject with date.
            _send_email(to_email, subject, html)  # STEP 3g — deliver via Resend helper.
            success_count += 1  # STEP 3h — count success.

        except Exception as exc:  # Resend or DB failure for this user.
            print(f"[Reminders] trigger-daily failed user={user_id}: {type(exc).__name__}: {exc}")  # log.
            error_count += 1  # STEP 3h — count error.

    return TriggerBatchResponse(  # STEP 4 — JSON summary for n8n.
        triggered=success_count,  # emails sent.
        errors=error_count,  # failures.
        total_users=total_count,  # rows considered.
    )  # end response


@router.post("/trigger-weekly", response_model=TriggerBatchResponse)  # POST /reminders/trigger-weekly — n8n cron.
async def trigger_weekly_reminders() -> TriggerBatchResponse:  # no auth; loops weekly opt-ins.
    # Batch-send weekly progress emails to every student with weekly_report enabled.

    prefs_rows = _prefs_rows_with_email("weekly_report")  # STEP 2 — weekly opt-ins with email.
    total_count = len(prefs_rows)  # total users.
    success_count = 0  # sends OK.
    error_count = 0  # send failures.

    today_dt = datetime.now()  # STEP 3a — now for week bounds.
    monday = today_dt - timedelta(days=today_dt.weekday())  # Monday of current week.
    sunday = monday + timedelta(days=6)  # Sunday of current week.
    week_start = monday.strftime("%Y-%m-%d")  # STEP 3a — Monday ISO date.
    week_end = sunday.strftime("%Y-%m-%d")  # STEP 3a — Sunday ISO date.
    week_start_iso = _week_start_iso(monday.date())  # UTC ISO for timestamp filters.

    for row in prefs_rows:  # STEP 3 — foreach user.
        user_id = str(row.get("user_id") or "")  # student UUID.
        to_email = str(row.get("email") or "").strip()  # delivery email.
        if not user_id or not to_email:  # invalid row.
            error_count += 1  # count error.
            continue  # next user.

        try:  # per-user processing.
            completed_sessions = _count_timetable_in_range(  # STEP 3b — completed this week.
                user_id, week_start, week_end, completed_only=True  # completed=True filter.
            )  # end completed count
            remaining_sessions = _count_timetable_in_range(  # STEP 3b — incomplete this week.
                user_id, week_start, week_end, completed_only=False  # completed=False filter.
            )  # end remaining count
            total_sessions = completed_sessions + remaining_sessions  # STEP 3b — total scheduled.

            questions_asked = _count_table_rows(  # STEP 3c — homework questions since Monday.
                HOMEWORK_TABLE, user_id, "created_at", week_start_iso, None  # created_at >= monday UTC.
            )  # end homework count

            _ = _quiz_average_percentage(user_id, week_start_iso)  # STEP 3d — avg available if needed later.

            exam_dates = _load_exam_dates_for_user(user_id)  # STEP 3e — exam_dates JSON.
            exam_countdown_html = _build_trigger_weekly_exam_html(exam_dates)  # STEP 3g — countdown rows.

            groq_prompt = (  # STEP 3f — Groq motivational prompt.
                f"Write 2 encouraging sentences for a Cambridge AS Level student in Zambia "
                f"who completed {completed_sessions} study sessions this week and "
                f"asked {questions_asked} questions. Be warm and specific. No markdown. No emojis."
            )  # end prompt
            motivational_message = _call_groq_text(groq_prompt, GROQ_WEEKLY_MAX_TOKENS)  # AI copy.
            if not motivational_message:  # Groq unavailable.
                motivational_message = (  # static fallback.
                    "You showed up this week — that consistency is what Cambridge rewards. "
                    "Keep building momentum before your exams."
                )  # end fallback

            title = "Your Weekly Progress Report"  # STEP 3h — wrapper title.
            content = (  # STEP 3h — email body per n8n spec.
                f"<h2 style=\"color:#EDE9D8;font-family:Georgia,serif;"
                f"font-size:20px;margin:0 0 16px\">"
                f"Week of {monday.strftime('%d %b')} — "
                f"{sunday.strftime('%d %b %Y')}</h2>"
                f"<div style=\"display:grid;grid-template-columns:1fr 1fr;"
                f"gap:12px;margin-bottom:20px\">"
                f"<motion.div style=\"background:#1A2235;border-radius:8px;"
                f"padding:14px;text-align:center\">"
                f"<div style=\"font-size:24px;font-weight:700;"
                f"color:#D4AF37;font-family:Georgia,serif\">"
                f"{completed_sessions}/{total_sessions}</div>"
                f"<div style=\"font-size:10px;color:rgba(237,233,216,0.5);"
                f"text-transform:uppercase;letter-spacing:0.1em;"
                f"margin-top:4px\">Sessions Done</motion.div>"
                f"</div>"
                f"<div style=\"background:#1A2235;border-radius:8px;"
                f"padding:14px;text-align:center\">"
                f"<div style=\"font-size:24px;font-weight:700;"
                f"color:#D4AF37;font-family:Georgia,serif\">"
                f"{questions_asked}</div>"
                f"<motion.div style=\"font-size:10px;color:rgba(237,233,216,0.5);"
                f"text-transform:uppercase;letter-spacing:0.1em;"
                f"margin-top:4px\">Questions Asked</motion.div>"
                f"</div>"
                f"</div>"
                f"<h3 style=\"color:rgba(237,233,216,0.5);font-size:10px;"
                f"text-transform:uppercase;letter-spacing:0.1em;"
                f"margin:0 0 10px\">Exam Countdown</h3>"
                f"{exam_countdown_html}"
                f"<div style=\"margin-top:20px;padding:14px 16px;"
                f"background:rgba(212,175,55,0.08);"
                f"border-left:2px solid #D4AF37;border-radius:6px\">"
                f"<p style=\"color:#EDE9D8;font-size:13px;"
                f"font-style:italic;margin:0\">"
                f"{motivational_message}</p>"
                f"</div>"
            )  # end content
            content = content.replace("<motion.div", "<div").replace("</motion.div>", "</div>")  # fix typos

            html = get_email_wrapper(content, title)  # wrap with shared template.
            _send_email(  # STEP 3i — send via Resend.
                to_email,  # preference email.
                "AscendAI — Your Weekly Progress Report",  # subject line.
                html,  # HTML body.
            )  # end send
            success_count += 1  # STEP 3j — success.

        except Exception as exc:  # per-user failure.
            print(f"[Reminders] trigger-weekly failed user={user_id}: {type(exc).__name__}: {exc}")  # log.
            error_count += 1  # STEP 3j — error.

    return TriggerBatchResponse(  # STEP 4 — batch summary.
        triggered=success_count,  # sent count.
        errors=error_count,  # error count.
        total_users=total_count,  # total opted-in users.
    )  # end response


@router.post("/trigger-exam-alert", response_model=TriggerExamAlertResponse)  # POST /reminders/trigger-exam-alert.
async def trigger_exam_alert_reminders() -> TriggerExamAlertResponse:  # no auth; exam alerts for all users.
    # Batch-send exam alert emails when any subject exam is within 14 days.

    prefs_rows = _prefs_rows_with_email("exam_alert")  # STEP 2 — exam_alert opt-ins with email.
    alert_count = 0  # emails sent.
    skipped_count = 0  # users with no exam in window.
    error_count = 0  # send failures.

    today = date.today()  # calendar today for day diffs.
    timetable_url = f"{FRONTEND_BASE_URL}/features/timetable"  # deep link from env.
    syllabus_url = f"{FRONTEND_BASE_URL}/syllabus"  # deep link from env.

    for row in prefs_rows:  # STEP 3 — foreach user.
        user_id = str(row.get("user_id") or "")  # student UUID.
        to_email = str(row.get("email") or "").strip()  # delivery email.
        if not user_id or not to_email:  # invalid row.
            error_count += 1  # count error.
            continue  # next user.

        try:  # per-user processing.
            exam_dates = _load_exam_dates_for_user(user_id)  # STEP 3a — exam_dates JSON.
            urgent_subjects: List[Tuple[str, int, str]] = []  # (slug, days_left, date_str).

            for subject_key in SUBJECT_KEYS:  # STEP 3b — check each subject.
                exam_date_str = exam_dates.get(subject_key)  # ISO date or missing.
                if not exam_date_str:  # no date.
                    continue  # next subject.
                try:  # parse date.
                    exam_day = date.fromisoformat(exam_date_str[:10])  # date object.
                except ValueError:  # bad string.
                    continue  # next subject.
                days_remaining = (exam_day - today).days  # STEP 3b — days until exam.
                if days_remaining <= 14:  # within alert window.
                    urgent_subjects.append((subject_key, days_remaining, exam_date_str))  # collect.

            if not urgent_subjects:  # STEP 3c — nothing urgent.
                skipped_count += 1  # skip user.
                continue  # next user.

            for subject_key, days_remaining, _exam_date_str in urgent_subjects:  # STEP 3d — each urgent subject.
                covered, total, coverage_pct, top_5 = _syllabus_coverage_stats(  # STEP 3d — syllabus stats.
                    user_id, subject_key  # owner + subject slug.
                )  # end stats
                subject_label = SUBJECT_LABELS.get(subject_key, subject_key.title())  # display name.

                topics_html = "".join(  # STEP 3e — uncovered topic list HTML.
                    [
                        (
                            f'<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);'
                            f'color:rgba(237,233,216,0.7);font-size:12px">• {topic}</div>'
                        )
                        for topic in top_5
                    ]
                )  # end join
                topics_html = topics_html.replace("</motion.div>", "</div>")  # fix closing tag typo
                if not topics_html:  # no uncovered topics listed.
                    topics_html = (  # placeholder row.
                        '<div style="color:rgba(237,233,216,0.5);font-size:12px;">'
                        "No uncovered topics listed yet.</div>"
                    )  # end placeholder
                    topics_html = topics_html.replace("</motion.div>", "</div>")  # fix close

                title = f"EXAM ALERT — {subject_label} in {days_remaining} days"  # STEP 3e — title.
                content = (  # STEP 3e — alert body per n8n spec.
                    f'<div style="background:#E74C3C;padding:16px 20px;'
                    f"border-radius:8px;margin-bottom:20px;text-align:center\">"
                    f'<p style="color:white;font-size:11px;'
                    f"text-transform:uppercase;letter-spacing:0.1em;"
                    f'margin:0 0 4px">EXAM ALERT</p>'
                    f'<p style="color:white;font-size:28px;font-weight:700;'
                    f'font-family:Georgia,serif;margin:0">'
                    f"{subject_label}</p>"
                    f'<p style="color:rgba(255,255,255,0.8);font-size:16px;'
                    f'margin:4px 0 0">'
                    f"{days_remaining} days remaining</p>"
                    f"</div>"
                    f'<h3 style="color:rgba(237,233,216,0.5);font-size:10px;'
                    f"text-transform:uppercase;letter-spacing:0.1em;"
                    f'margin:0 0 8px">Syllabus Coverage</h3>'
                    f'<div style="background:#1A2235;border-radius:6px;'
                    f'padding:14px;margin-bottom:16px">'
                    f'<div style="display:flex;justify-content:space-between;'
                    f'margin-bottom:8px">'
                    f'<span style="color:#EDE9D8;font-size:13px">'
                    f"{covered} of {total} topics covered</span>"
                    f'<span style="color:#D4AF37;font-size:13px;'
                    f'font-weight:600">{coverage_pct}%</span>'
                    f"</div>"
                    f'<div style="background:rgba(255,255,255,0.1);'
                    f'border-radius:3px;height:4px">'
                    f'<div style="background:#D4AF37;height:4px;'
                    f'border-radius:3px;width:{coverage_pct}%"></div>'
                    f"</div>"
                    f"</div>"
                    f'<h3 style="color:rgba(237,233,216,0.5);font-size:10px;'
                    f"text-transform:uppercase;letter-spacing:0.1em;"
                    f'margin:0 0 8px">Topics Still To Cover</h3>'
                    f"{topics_html}"
                    f'<div style="margin-top:20px;display:flex;gap:10px">'
                    f'<a href="{timetable_url}"'
                    f' style="flex:1;background:#D4AF37;color:#0A0F1E;'
                    f"padding:10px;border-radius:6px;text-align:center;"
                    f'text-decoration:none;font-size:12px;font-weight:600">'
                    f"Open Timetable</a>"
                    f'<a href="{syllabus_url}"'
                    f' style="flex:1;background:transparent;'
                    f"color:#D4AF37;padding:10px;border-radius:6px;"
                    f"text-align:center;text-decoration:none;"
                    f'font-size:12px;font-weight:600;'
                    f'border:0.5px solid #D4AF37">'
                    f"View Syllabus</a>"
                    f"</div>"
                )  # end content

                html = get_email_wrapper(content, title)  # full HTML document.
                subject_line = f"AscendAI — {title}"  # inbox subject.
                _send_email(to_email, subject_line, html)  # STEP 3f — send.
                alert_count += 1  # STEP 3g — count sent email.

        except Exception as exc:  # per-user failure.
            print(f"[Reminders] trigger-exam-alert failed user={user_id}: {type(exc).__name__}: {exc}")  # log.
            error_count += 1  # STEP 3g — error.

    return TriggerExamAlertResponse(  # STEP 4 — batch summary.
        triggered=alert_count,  # alert emails sent.
        skipped=skipped_count,  # users skipped (no exam in 14 days).
        errors=error_count,  # failures.
    )  # end response
