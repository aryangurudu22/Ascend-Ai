# ============================================================
# ASCENDAI BACKEND — routers/notifications.py
# ============================================================
# In-app notification bell: list, mark one read, mark all read.
# Other routers call create_notification() after successful events.
# ============================================================

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from database import supabase

NOTIFICATIONS_TABLE = "notifications"
NOTIFICATION_LIST_LIMIT = 20

router = APIRouter()


def create_notification(
    user_id: str,
    type: str,
    title: str,
    message: str,
) -> None:
    """
    Insert a notification row for the user.

    Called internally by other routers when events happen.
    Silent — never raises, only logs on failure.
    """

    try:
        supabase.table(NOTIFICATIONS_TABLE).insert(
            {
                "user_id": user_id,
                "type": type,
                "title": title,
                "message": message,
                "is_read": False,
            }
        ).execute()
    except Exception as e:
        print(f"[Notifications] Failed to create: {e}")


def exam_alert_sent_today(user_id: str, subject_label: str) -> bool:
    """
    Return True if an exam_alert for this subject was already
    created today (UTC) — prevents duplicate critical alerts.
    """

    try:
        today_start = (
            datetime.now(timezone.utc)
            .replace(hour=0, minute=0, second=0, microsecond=0)
            .isoformat()
        )
        title = f"Exam Alert — {subject_label}"
        result = (
            supabase.table(NOTIFICATIONS_TABLE)
            .select("id")
            .eq("user_id", user_id)
            .eq("type", "exam_alert")
            .eq("title", title)
            .gte("created_at", today_start)
            .limit(1)
            .execute()
        )
        rows = getattr(result, "data", None) or []
        return len(rows) > 0
    except Exception as e:
        print(f"[Notifications] exam_alert dedupe check failed: {e}")
        return True


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
        print(f"[Notifications] Bearer token verify raised: {type(e).__name__}")
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


def _parse_created_at(raw: object) -> Optional[datetime]:
    """Parse Supabase created_at into a timezone-aware datetime."""

    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _format_relative_time(created_at_raw: object) -> str:
    """
    Format created_at as human-readable relative time:
    minutes / hours / days ago, else DD Mon YYYY.
    """

    created = _parse_created_at(created_at_raw)
    if not created:
        return ""

    now = datetime.now(timezone.utc)
    delta = now - created
    total_seconds = max(0, int(delta.total_seconds()))

    if total_seconds < 3600:
        minutes = max(1, total_seconds // 60)
        suffix = "minute" if minutes == 1 else "minutes"
        return f"{minutes} {suffix} ago"

    if total_seconds < 86400:
        hours = max(1, total_seconds // 3600)
        suffix = "hour" if hours == 1 else "hours"
        return f"{hours} {suffix} ago"

    if total_seconds < 604800:
        days = max(1, total_seconds // 86400)
        suffix = "day" if days == 1 else "days"
        return f"{days} {suffix} ago"

    return created.strftime("%d %b %Y")


class NotificationItem(BaseModel):
    """One notification row returned to the frontend."""

    id: str
    type: str
    title: str
    message: str
    is_read: bool
    created_at: str


class NotificationsListResponse(BaseModel):
    """GET /notifications response envelope."""

    notifications: List[NotificationItem]
    unread_count: int


class MarkReadResponse(BaseModel):
    """PATCH /notifications/{id}/read response."""

    success: bool


class MarkAllReadResponse(BaseModel):
    """PATCH /notifications/read-all response."""

    updated: int


@router.get(
    "",
    response_model=NotificationsListResponse,
    summary="List recent notifications for the signed-in user",
)
def list_notifications(
    verified_user_id: str = Depends(verify_bearer_token),
):
    """Return the last 20 notifications plus unread count."""

    try:
        result = (
            supabase.table(NOTIFICATIONS_TABLE)
            .select("id, type, title, message, is_read, created_at")
            .eq("user_id", verified_user_id)
            .order("created_at", desc=True)
            .limit(NOTIFICATION_LIST_LIMIT)
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception as e:
        print(f"[Notifications] List failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Could not load notifications. Please try again."},
        )

    items: List[NotificationItem] = []
    unread_count = 0

    for row in rows:
        is_read = bool(row.get("is_read"))
        if not is_read:
            unread_count += 1
        items.append(
            NotificationItem(
                id=str(row.get("id", "")),
                type=str(row.get("type") or ""),
                title=str(row.get("title") or ""),
                message=str(row.get("message") or ""),
                is_read=is_read,
                created_at=_format_relative_time(row.get("created_at")),
            )
        )

    return NotificationsListResponse(
        notifications=items,
        unread_count=unread_count,
    )


@router.patch(
    "/read-all",
    response_model=MarkAllReadResponse,
    summary="Mark all notifications as read for the signed-in user",
)
def mark_all_notifications_read(
    verified_user_id: str = Depends(verify_bearer_token),
):
    """Set is_read=true on every unread row for this user."""

    try:
        result = (
            supabase.table(NOTIFICATIONS_TABLE)
            .update({"is_read": True})
            .eq("user_id", verified_user_id)
            .eq("is_read", False)
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception as e:
        print(f"[Notifications] Mark all read failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Could not update notifications."},
        )

    return MarkAllReadResponse(updated=len(rows))


@router.patch(
    "/{notification_id}/read",
    response_model=MarkReadResponse,
    summary="Mark one notification as read",
)
def mark_notification_read(
    notification_id: str,
    verified_user_id: str = Depends(verify_bearer_token),
):
    """Set is_read=true for a single notification owned by the caller."""

    notif_id = (notification_id or "").strip()
    if not notif_id:
        raise HTTPException(
            status_code=422,
            detail={"error": "notification_id is required"},
        )

    try:
        supabase.table(NOTIFICATIONS_TABLE).update({"is_read": True}).eq(
            "id", notif_id
        ).eq("user_id", verified_user_id).execute()
    except Exception as e:
        print(f"[Notifications] Mark read failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "Could not update notification."},
        )

    return MarkReadResponse(success=True)
