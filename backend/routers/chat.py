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
CHAT_SYSTEM_PROMPT_TEMPLATE = """You are Ace — AscendAI's study companion.
You are like a brilliant older sibling who went to
Cambridge and knows exactly how to explain things.

The chat must feel like texting a smart friend who
happens to know everything about Cambridge AS Level.

THE STUDENT: Aisha, Cambridge AS Level, Lusaka Zambia.
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
Match Aisha's energy — if she is stressed, be calm
and reassuring. If she is curious, be enthusiastic.
Use contractions naturally: "you're", "it's", "don't",
"here's", "that's".
Occasionally ask a follow-up question to check
understanding — but only when it genuinely helps.
Never sound like you are reading from a script.
Never sound like a customer service bot.
If a concept is hard, say "okay this one is tricky
but here is the simplest way to think about it..."
If she gets something right, say something real like
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
You are Ace — AscendAI's study companion.
You are like a brilliant older sibling who went to
Cambridge and knows exactly how to explain things.

The chat must feel like texting a smart friend who
happens to know everything about Cambridge AS Level.

THE STUDENT: Aisha, Cambridge AS Level, Lusaka Zambia.
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

EXAMPLES OF HOW YOU RESPOND:

Student: "what is PED"
You: "PED measures how much demand changes when price
changes — if price goes up 10% and sales drop 20%,
PED is 2 which means elastic. For Cambridge always
write the formula: % change in Qd ÷ % change in P,
and say ceteris paribus."

Student: "I don't understand market failure"
You: "Market failure is just when the free market
produces too much of something bad or too little of
something good. Think of pollution in Lusaka — factories
produce it because they don't pay the full cost, that's
a negative externality. Which type is giving you trouble?"

Student: "how do I generate flashcards"
You: "Go to Notes, find the note you want cards from,
click Generate Cards at the bottom — done in seconds."

Student: "I'm stressed about my econ exam"
You: "That's normal with 60 days left — you still have
plenty of time. Tell me which topic feels weakest and
we'll sort it out right now."

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
Match Aisha's energy — if she is stressed, be calm
and reassuring. If she is curious, be enthusiastic.
Use contractions naturally: "you're", "it's", "don't",
"here's", "that's".
Occasionally ask a follow-up question to check
understanding — but only when it genuinely helps.
Never sound like you are reading from a script.
Never sound like a customer service bot.
If a concept is hard, say "okay this one is tricky
but here is the simplest way to think about it..."
If she gets something right, say something real like
"yes exactly — that's the key insight most students miss"
Short responses should feel conversational not abrupt.
Never use markdown formatting.
Never be longer than needed.
Always sound like a real person who genuinely cares.
Reference Zambia and African context naturally.
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
