# ============================================================
# ASCENDAI BACKEND — routers/chat.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# The global Floating Chat Assistant — one endpoint:
#
#   POST /chat/message
#     • Verifies the caller's Supabase JWT (same pattern as
#       homework.py).
#     • Persists user + assistant rows to chat_messages.
#     • Builds a conversational system prompt with the
#       student's current page context.
#     • Calls Groq (llama-3.3-70b-versatile) with optional
#       conversation_history for multi-turn chat.
#     • Returns { "reply", "suggestions", "error": null }.
#
#   GET /chat/history
#     • Returns the last 20 chat_messages for the caller.
#
# WHAT EXTERNAL SERVICES WE USE
# ------------------------------------------------------------
#   • Groq (chat completions API).
#   • Supabase Auth (admin) — JWT verification via the
#     service-role client.
# ============================================================

import json
import os
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from database import supabase

# Supabase table for persisted floating-chat turns.
CHAT_MESSAGES_TABLE = "chat_messages"

# How many rows GET /chat/history returns (matches frontend window).
CHAT_HISTORY_LIMIT = 20

# Groq model — same default as homework (llama-3.3-70b-versatile).
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

# Max tokens — chat replies stay short and conversational (spec: 512).
GROQ_MAX_TOKENS = 512

# Temperature — 0.7 for a warmer, more conversational tone than homework.
GROQ_TEMPERATURE = 0.7


# ============================================================
# SYSTEM PROMPT — AscendAI floating assistant persona.
# ============================================================
# The {current_page} placeholder is filled per request so the
# model knows which screen the student is viewing.
# ============================================================
CHAT_SYSTEM_PROMPT_TEMPLATE = """You are Ace — AscendAI's study companion.
You are like a brilliant older sibling who went to
Cambridge and knows exactly how to explain things.

The chat must feel like texting a smart friend who
happens to know everything about Cambridge AS Level.

THE STUDENT: {student_name}, Cambridge AS Level, Lusaka Zambia.
Current page: {current_page}

YOUR PERSONALITY:
- Warm, direct, confident — never robotic
- You speak like a real person, not a textbook
- You celebrate wins and encourage without being fake
- You are honest when something is hard
- You use humour occasionally when appropriate
- You never say "Certainly!" or "Great question!"
- You never start with pleasantries — get straight to it

RESPONSE STYLE:
- Short and crisp — maximum 4 sentences for most answers
- One powerful analogy or example per concept
- Plain conversational English — no markdown, no bullets
- If they ask a concept: define it in one sentence,
  give one real example, connect it to their exam
- If they are stressed: acknowledge in one sentence,
  then immediately give practical help
- If they ask about the app: give direct navigation steps

RESPONSE LENGTH RULES:
- Casual question: 1-2 sentences
- Concept explanation: 3-4 sentences maximum
- Step by step guidance: maximum 5 sentences
- Never write an essay unless explicitly asked

WRITING STYLE RULES:
Sound like a real person wrote this:
- Vary sentence length — mix short punchy sentences
  with longer explanatory ones
- Use natural transitions: "Here's the thing...",
  "Think of it this way...", "The key point is...",
  "What Cambridge really wants to see is..."
- Occasional light emphasis words: "actually", "really",
  "in fact", "the truth is"
- Never start two consecutive sentences the same way
- Never use lists unless absolutely necessary
- Flow like spoken explanation, not bullet points

AVOID THESE AI GIVEAWAYS — never use:
- "Certainly!" — never use
- "Of course!" — never use
- "Great question!" — never use
- "It is important to note that" — never use
- "In conclusion" — never use
- "Furthermore" — never use
- "Moreover" — never use
- "It is worth noting" — never use
- "As mentioned above" — never use
- "In summary" — never use
- Numbered lists for explanations — never use
- Bullet points in flowing text — never use
- Starting every paragraph with the topic word
- Repeating the question back before answering
- Overly formal academic language when simpler works

WHAT TO USE INSTEAD:
- "Here's what this means in practice..."
- "The way to think about this is..."
- "What actually happens is..."
- "Cambridge examiners look for exactly this..."
- "The reason this matters is..."
- "Most students miss this, but..."
- "Think about it from the examiner's perspective..."

HUMANISATION RULES:
Sound exactly like a real person texting back.
Match {student_name}'s energy — if they are stressed, be calm
and reassuring. If they are curious, be enthusiastic.
Use contractions naturally: "you're", "it's", "don't",
"here's", "that's".
Occasionally ask a follow-up question to check
understanding — but only when it genuinely helps.
Never sound like you are reading from a script.
Never sound like a customer service bot.
If a concept is hard, say "okay this one is tricky
but here is the simplest way to think about it..."
If they get something right, say something real like
"yes exactly — that's the key insight most students miss"
Short responses should feel conversational not abrupt.
Never use markdown formatting.
Never be longer than needed.
Always sound like a real person who genuinely cares.
Reference Zambia and African context naturally.
"""


class HistoryMessage(BaseModel):
    """One turn in the conversation_history array."""

    role: str = Field(..., description="user or assistant")
    content: str = Field(..., min_length=1)


class ChatMessageRequest(BaseModel):
    """JSON body the frontend POSTs to /chat/message."""

    message: str = Field(..., min_length=1, description="The student's latest message.")
    user_id: str = Field(..., min_length=1, description="UUID of the authenticated user.")
    current_page: Optional[str] = Field(
        default=None,
        description="Next.js pathname the student is on (e.g. /dashboard).",
    )
    conversation_history: Optional[List[HistoryMessage]] = Field(
        default=None,
        description="Prior turns (role + content) for multi-turn context.",
    )


class ChatMessageResponse(BaseModel):
    """JSON body returned by /chat/message on success."""

    reply: str
    suggestions: List[str] = Field(default_factory=list)
    conversation_id: Optional[str] = None
    message_id: Optional[str] = None
    error: Optional[str] = None


class StoredChatMessage(BaseModel):
    """One row from chat_messages returned by GET /chat/history."""

    role: str
    content: str
    current_page: Optional[str] = None
    created_at: str


class ChatHistoryResponse(BaseModel):
    """JSON envelope for GET /chat/history."""

    messages: List[StoredChatMessage]


def _insert_chat_message(
    user_id: str,
    role: str,
    content: str,
    current_page: str,
) -> None:
    """
    Insert one turn into chat_messages via the service-role client.

    Failures are logged only — Groq replies and HTTP responses are
    never blocked by a database error (same pattern as homework).
    """

    payload = {
        "user_id": user_id,
        "role": role,
        "content": content,
        "current_page": current_page,
    }
    try:
        supabase.table(CHAT_MESSAGES_TABLE).insert(payload).execute()
    except Exception as e:
        print(
            f"[Chat] chat_messages insert failed role={role}: "
            f"{type(e).__name__}: {e}"
        )


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
        print(f"[Chat] Bearer token verify raised: {type(e).__name__}")
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


router = APIRouter()


@router.post(
    "/message",
    response_model=ChatMessageResponse,
    summary="Send a message to the AscendAI floating chat assistant",
)
def chat_message(
    body: ChatMessageRequest,
    verified_user_id: str = Depends(verify_bearer_token),
):
    """Call Groq with page context + history; return assistant reply."""

    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # Fetch the student's real name from profiles table
    # This replaces the hardcoded "Aisha" in the system prompt
    student_name = "Student"
    try:
        # Query profiles table for this user's full_name
        name_result = (
            supabase.table("profiles")
            .select("full_name")
            .eq("user_id", verified_user_id)
            .limit(1)
            .execute()
        )
        name_rows = getattr(name_result, "data", None) or []
        if name_rows and name_rows[0].get("full_name"):
            # Use only the first name — more natural in conversation
            student_name = str(name_rows[0]["full_name"]).strip().split()[0]
    except Exception as e:
        # If fetch fails just use "Student" as fallback — never crash
        print(f"[Chat] Could not fetch student name: {type(e).__name__}: {e}")

    try:
        from main import groq_client  # noqa: WPS433
    except Exception as e:
        print(f"[Chat] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    current_page = (body.current_page or "").strip() or "unknown"

    # Persist the student's message before calling Groq.
    _insert_chat_message(
        user_id=verified_user_id,
        role="user",
        content=body.message.strip(),
        current_page=current_page,
    )

    # Build the system prompt from the shared template + live student name
    system_prompt = CHAT_SYSTEM_PROMPT_TEMPLATE.format(
        current_page=current_page,
        student_name=student_name,
    )

    groq_messages = [{"role": "system", "content": system_prompt}]

    if body.conversation_history:
        for turn in body.conversation_history:
            role = (turn.role or "").strip().lower()
            if role not in ("user", "assistant"):
                continue
            content = (turn.content or "").strip()
            if not content:
                continue
            groq_messages.append({"role": role, "content": content})

    groq_messages.append({"role": "user", "content": body.message.strip()})

    try:
        completion = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=groq_messages,
            # MAX TOKENS — 400 enforces short, crisp tutor replies (was 512).
            max_tokens=400,
            # TEMPERATURE — 0.65 keeps warmth while reducing rambling (was 0.7).
            temperature=0.65,
        )
    except Exception as e:
        print(f"[Chat] Groq call failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    try:
        raw_text = completion.choices[0].message.content or ""
    except (AttributeError, IndexError) as e:
        print(f"[Chat] Groq response shape unexpected: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    ai_reply_text = raw_text.strip()

    # Persist the assistant reply after Groq succeeds.
    _insert_chat_message(
        user_id=verified_user_id,
        role="assistant",
        content=ai_reply_text,
        current_page=current_page,
    )

    # Generate contextual follow-up suggestions
    # based on the actual reply just given
    try:
        suggestion_response = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {
                    "role": "system",
                    "content": """You generate exactly 3 short 
follow-up questions a Cambridge AS Level student would 
naturally ask after reading the given reply.

Rules:
- Questions must be directly related to what was just said
- Each question builds naturally on the reply content
- Maximum 8 words per question
- No question marks needed
- Return ONLY a JSON array of 3 strings
- No markdown, no explanation, no preamble
- Example: ["Define ceteris paribus", "Give a real example", "How does this appear in exams"]""",
                },
                {
                    "role": "user",
                    "content": (
                        f"Reply was: {ai_reply_text[:500]}\n\n"
                        "Generate 3 follow-up questions."
                    ),
                },
            ],
            max_tokens=100,
            temperature=0.7,
        )

        raw = suggestion_response.choices[0].message.content.strip()
        # Remove any markdown fences if present
        raw = raw.replace("```json", "").replace("```", "").strip()
        suggestions = json.loads(raw)
        # Validate it is a list of 3 strings
        if not isinstance(suggestions, list) or len(suggestions) != 3:
            raise ValueError("Invalid suggestions format")

    except Exception as e:
        print(f"[Chat] suggestions failed: {e}")
        # Safe fallback suggestions
        suggestions = [
            "Can you give an example",
            "How does this appear in exams",
            "Explain this more simply",
        ]

    return ChatMessageResponse(
        reply=ai_reply_text,
        suggestions=suggestions,
        conversation_id=None,
        message_id=None,
        error=None,
    )


@router.get(
    "/history",
    response_model=ChatHistoryResponse,
    summary="Load the last 20 floating-chat messages for the signed-in user",
)
def chat_history(
    verified_user_id: str = Depends(verify_bearer_token),
):
    """
    Return the caller's most recent chat_messages rows, oldest first,
    so the frontend can render a continuous conversation thread.
    """

    try:
        # Fetch the newest rows first, then reverse so the API returns
        # the last 20 messages in ascending chronological order.
        result = (
            supabase.table(CHAT_MESSAGES_TABLE)
            .select("role, content, current_page, created_at")
            .eq("user_id", verified_user_id)
            .order("created_at", desc=True)
            .limit(CHAT_HISTORY_LIMIT)
            .execute()
        )
        rows = list(reversed(getattr(result, "data", None) or []))
    except Exception as e:
        print(f"[Chat] history query failed: {type(e).__name__}: {e}")
        rows = []

    messages: List[StoredChatMessage] = []
    for row in rows:
        messages.append(
            StoredChatMessage(
                role=str(row.get("role") or ""),
                content=str(row.get("content") or ""),
                current_page=row.get("current_page"),
                created_at=str(row.get("created_at") or ""),
            )
        )

    return ChatHistoryResponse(messages=messages)
