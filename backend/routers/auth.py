# ============================================================
# ASCENDAI BACKEND — routers/auth.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# Google OAuth token persistence after the student signs in.
# When Aisha completes Google login, the frontend callback
# sends her Google access + refresh tokens here so the backend
# can call Classroom / Drive / YouTube on her behalf later
# (even when she is not actively using the app).
#
#   POST /auth/save-google-tokens
#     • Receives tokens from the auth callback page.
#     • Updates the caller's row in the `profiles` table.
#     • Sets google_classroom_connected = true.
#
# WHAT TABLE WE WRITE TO
# ------------------------------------------------------------
# • `profiles` — google_access_token, google_refresh_token,
#                google_token_expiry, google_id,
#                google_classroom_connected, updated_at
#
# WHAT EXTERNAL SERVICES WE USE
# ------------------------------------------------------------
#   • Supabase Auth (admin) — JWT verification.
#   • Supabase Postgres — profiles update.
#
# SECURITY
# ------------------------------------------------------------
#   • Tokens are NEVER returned in any response body.
#   • Only the service-role client touches the profiles table.
# ============================================================

import os
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from database import supabase

# Table that stores one row per student.
PROFILES_TABLE = "profiles"

# Google access tokens last 3600 seconds (one hour).
GOOGLE_ACCESS_TOKEN_SECONDS = 3600

# OAuth client credentials — loaded from backend/.env (never hardcoded).
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID") or ""
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET") or ""

router = APIRouter()


# ============================================================
# PYDANTIC MODELS
# ============================================================


class SaveGoogleTokensRequest(BaseModel):
    # UUID of the signed-in student — must match the JWT subject.
    user_id: str = Field(..., description="UUID of the student")
    # Short-lived token used to call Google APIs right now.
    google_access_token: str = Field(..., description="Google OAuth access token")
    # Long-lived token used to mint new access tokens without re-login.
    google_refresh_token: Optional[str] = Field(
        default=None,
        description="Google OAuth refresh token (may be null on re-consent)",
    )
    # Google's stable user id (sub claim) — optional metadata.
    google_id: Optional[str] = Field(
        default=None, description="Google account subject id",
    )


class SaveGoogleTokensResponse(BaseModel):
    tokens_saved: bool
    classroom_connected: bool
    message: str


# ============================================================
# AUTH DEPENDENCY: verify_bearer_token
# ============================================================
def verify_bearer_token(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:
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
        print(f"[Auth] Bearer token verify raised: {type(e).__name__}: {e}")
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
# HELPER: _token_expiry_string
# ============================================================
# Google access tokens expire after about one hour — store when
# we expect expiry so downstream Classroom calls know when to
# refresh using the refresh token.
# ============================================================
def _token_expiry_string() -> str:
    expires_at = datetime.utcnow() + timedelta(seconds=GOOGLE_ACCESS_TOKEN_SECONDS)
    return expires_at.isoformat()


# ============================================================
# HELPER: _fetch_auth_user_details
# ============================================================
# When INSERT-ing a missing profile row we still want real name
# and email from Supabase Auth so the dashboard greeting works.
# ============================================================
def _fetch_auth_user_details(user_id: str) -> tuple[str, str]:
    full_name = "Student"
    email = "student@pending.local"
    try:
        admin_resp = supabase.auth.admin.get_user_by_id(user_id)
        user_obj = getattr(admin_resp, "user", None)
        if user_obj is None:
            return (full_name, email)
        email_attr = getattr(user_obj, "email", None) or email
        meta = getattr(user_obj, "user_metadata", None) or {}
        if isinstance(meta, dict):
            name_from_meta = (
                meta.get("full_name")
                or meta.get("name")
                or meta.get("preferred_username")
            )
            if name_from_meta:
                full_name = str(name_from_meta).strip() or full_name
        return (full_name, str(email_attr).strip() if email_attr else email)
    except Exception as e:
        print(f"[Auth] admin.get_user_by_id failed: {type(e).__name__}: {e}")
        return (full_name, email)


# ============================================================
# ENDPOINT: POST /auth/save-google-tokens
# ============================================================
@router.post(
    "/save-google-tokens",
    response_model=SaveGoogleTokensResponse,
    summary="Persist Google OAuth tokens on the student profile",
)
def save_google_tokens(
    body: SaveGoogleTokensRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    # Identity check — caller cannot save tokens for someone else.
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    access_token = (body.google_access_token or "").strip()
    if not access_token:
        raise HTTPException(
            status_code=422,
            detail={"error": "google_access_token is required."},
        )

    refresh_token = body.google_refresh_token
    if isinstance(refresh_token, str):
        refresh_token = refresh_token.strip() or None

    google_id = (body.google_id or "").strip() or None

    token_expiry_string = _token_expiry_string()

    try:
        # Explicit UPDATE shape — google_classroom_connected must be True here
        # so Postgres stores the flag even if older clients relied on defaults.
        result = (
            supabase.table(PROFILES_TABLE)
            .update(
                {
                    "google_access_token": access_token,
                    "google_refresh_token": refresh_token,
                    "google_token_expiry": token_expiry_string,
                    "google_id": google_id,
                    "google_classroom_connected": True,
                    "updated_at": datetime.utcnow().isoformat(),
                }
            )
            .eq("user_id", verified_user_id)
            .execute()
        )
        rows = getattr(result, "data", None) or []

        # Safety net — creates profile if it does not exist yet (UPDATE touched 0 rows).
        if not rows:
            full_name, email = _fetch_auth_user_details(verified_user_id)
            insert_payload = {
                "user_id": verified_user_id,
                "full_name": full_name,
                "email": email,
                "study_start_time": "09:00",
                "study_end_time": "17:00",
                "ai_response_style": "detailed",
                "google_access_token": access_token,
                "google_refresh_token": refresh_token,
                "google_token_expiry": token_expiry_string,
                "google_id": google_id,
                "google_classroom_connected": True,
                "updated_at": datetime.utcnow().isoformat(),
            }
            insert_result = (
                supabase.table(PROFILES_TABLE).insert(insert_payload).execute()
            )
            rows = getattr(insert_result, "data", None) or []

        if not rows:
            raise HTTPException(
                status_code=500,
                detail={"error": "Could not save Google tokens. Please try again."},
            )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Auth] Token save failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": "Could not save Google tokens. Please try again."},
        ) from e

    return SaveGoogleTokensResponse(
        tokens_saved=True,
        classroom_connected=True,
        message="Google Classroom connected successfully",
    )
