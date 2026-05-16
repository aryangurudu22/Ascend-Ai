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
#     • Returns { "response": "<text>", "error": null }.
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
CHAT_SYSTEM_PROMPT_TEMPLATE = """You are AscendAI, a friendly and knowledgeable Cambridge 
AS Level study assistant for a student in Zambia.

The student is studying:
- Economics (9708)
- Business Studies (9609)  
- English Language (9093)
- ICT (9626)

Current page: {current_page}

Your personality:
- Warm, encouraging, and supportive
- Concise but thorough — never too long
- Use Cambridge terminology correctly
- Reference Zambia and African context when relevant
- Celebrate progress and effort
- Never patronising

You can help with:
- Cambridge AS Level subject questions
- Explaining concepts in simple terms
- Study tips and exam technique
- App navigation and features
- General questions and motivation

Keep responses conversational and under 150 words unless
a detailed explanation is genuinely needed.
Never use markdown symbols like ** or ## in responses.
Write in plain conversational sentences.
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

    response: str
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

    system_prompt = f"""
You are AscendAI — a world-class Cambridge AS Level tutor
and study companion for a student in Lusaka, Zambia.

The student studies:
- Economics 9708
- Business Studies 9609
- English Language 9093
- ICT 9626

Current page: {current_page}

YOUR COMMUNICATION STYLE:
- Short, crisp, and clear — never more than 4-5 sentences
  unless a detailed explanation is genuinely needed
- Every response must give instant clarity
- Use one strong analogy or real-world example per concept
- Never use bullet points — write in flowing sentences
- Never use markdown symbols like ** ## * or ---
- Sound like a brilliant tutor sitting next to the student
  not like a textbook or a chatbot
- Warm but confident — like a mentor who knows their stuff

WHEN ANSWERING STUDY QUESTIONS:
- Lead with the core idea in one sentence
- Follow with one real-world example or analogy
- End with the Cambridge examiner angle if relevant
- Maximum 5 sentences total for concept explanations

WHEN ANSWERING EXAM TECHNIQUE QUESTIONS:
- Be direct and specific — "Write your definition first,
  then your example, then your analysis"
- Reference Cambridge mark schemes naturally
- Give the student the exact formula for full marks

WHEN THE STUDENT IS STRESSED OR STRUGGLING:
- Acknowledge briefly — one sentence maximum
- Then immediately pivot to practical help
- Be encouraging without being patronising

WHEN ASKED ABOUT THE APP:
- Give direct navigation instructions
- "Go to Past Papers, click Upload Paper, choose your PDF"
- Never say "I'm not sure" about app features

RESPONSE LENGTH RULES:
- Casual question: 1-2 sentences
- Concept explanation: 3-5 sentences
- Step by step process: maximum 6 sentences
- Never write an essay unless explicitly asked

EXAMPLES OF GOOD RESPONSES:

Student: "What is PED?"
You: "Price elasticity of demand measures how much quantity
demanded changes when price changes. Think of it like this —
if petrol prices double and you still fill up your tank,
that's inelastic demand. For Cambridge, always state
ceteris paribus and use the formula: % change in Qd divided
by % change in Price."

Student: "I'm struggling with market failure"
You: "Market failure is simply when the free market
produces the wrong amount of something — too much of a bad
thing like pollution, or too little of a good thing like
education. The four types Cambridge tests are externalities,
public goods, merit goods, and information failure.
Which one is giving you trouble?"

Student: "How do I use the timetable?"
You: "Go to My Timetable from the dashboard, click Generate
Now and your 2-week study plan will be ready in seconds.
Each session card shows your subject and topic — tick it
off when done to track your progress."
"""

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

    assistant_text = raw_text.strip()

    # Persist the assistant reply after Groq succeeds.
    _insert_chat_message(
        user_id=verified_user_id,
        role="assistant",
        content=assistant_text,
        current_page=current_page,
    )

    return ChatMessageResponse(response=assistant_text, error=None)


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
