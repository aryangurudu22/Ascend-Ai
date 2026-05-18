# ============================================================
# ASCENDAI BACKEND — routers/flashcards.py
# ============================================================
# WHAT THIS ROUTER HANDLES
# ------------------------------------------------------------
# Every HTTP request to do with the Flashcard generator feature.
# Three endpoints live here:
#
#   POST /flashcards/generate
#     • Reads a specific note belonging to the caller.
#     • Asks Groq (LLaMA-3.3 70B) to draft 6-8 Cambridge-style
#       Q&A flashcards from that note.
#     • Parses the JSON array Groq returns.
#     • Saves every card to the `flashcards` table.
#     • Returns the saved cards plus a small summary envelope.
#
#   GET /flashcards/by-subject?subject_id=…&user_id=…
#     • Returns every card for a given subject + user.
#
#   GET /flashcards/by-note?note_id=…&user_id=…
#     • Returns every card generated from a specific note.
#
# WHAT TABLES WE READ/WRITE
# ------------------------------------------------------------
# • `notes`       — read source content (title, summary,
#                   key_points, subject_id).
# • `flashcards`  — write generated cards, then read them back.
#
# HOW WE LINK CARDS BACK TO THEIR SOURCE NOTE
# ------------------------------------------------------------
# Every flashcard row carries two pieces of information about
# the note that produced it:
#
#   • `note_id`  — the source note's UUID. This is the canonical
#                  foreign key we use for duplicate prevention
#                  and for "fetch all cards for this note" reads.
#                  UUIDs never change, so the link survives note
#                  title edits.
#   • `topic`    — the source note's title at generation time.
#                  Stored alongside note_id so the flashcards
#                  page can label a topic without an extra JOIN
#                  back to the notes table.
#
# WHAT EXTERNAL SERVICES WE USE
# ------------------------------------------------------------
#   • Groq (chat completions API) — for card generation.
#   • Supabase Auth (admin) — for JWT verification.
#   • Supabase Postgres — for reading notes + writing flashcards.
#
# PROJECT RULES THIS FILE OBEYS
# ------------------------------------------------------------
#   • Never expose API keys / internal errors / stack traces.
#   • Use the service-role Supabase client for all DB work
#     (never the anon key).
#   • Duplicate prevention: if a note already has cards we DO
#     NOT regenerate — saves Groq money AND prevents flooding
#     Aisha's study deck with near-duplicates.
#   • A failed Supabase save on ONE card never blocks the whole
#     batch — we log and continue with the rest.
#   • No new packages — only stdlib + libraries already used by
#     routers/homework.py.
# ============================================================

# ── Standard library imports ─────────────────────────────────
# `json` — parses the array Groq returns.
# `re`   — strips markdown fences and isolates the first JSON
#          array if the model decides to be chatty.
# `Optional[X]` / `Tuple[...]` — typed Pydantic fields.
import json
import re
from typing import Any, Dict, List, Optional, Tuple

# ── FastAPI imports ──────────────────────────────────────────
# APIRouter is the mini-FastAPI we attach to main.py via
# include_router(...).  Depends + Header power our bearer-token
# verification dependency. HTTPException is how we return any
# non-2xx response with a clean JSON body. Query lets us add
# validation to ?subject_id= and ?user_id= query parameters.
from fastapi import APIRouter, Depends, Header, HTTPException, Query

# ── Pydantic imports ─────────────────────────────────────────
# BaseModel + Field describe and auto-validate every request /
# response shape on this router.
from pydantic import BaseModel, Field

# ── Supabase service-role client ─────────────────────────────
# Same instance the homework router uses. Required because:
#   1. We bypass RLS to insert + read on behalf of the user.
#   2. We use supabase.auth.get_user(jwt) to verify any user's
#      access token (the anon client cannot do that).
from database import supabase
from routers.notifications import create_notification


# ============================================================
# CONFIGURATION CONSTANTS — single source of truth.
# ============================================================
# Values are loaded ONCE when uvicorn starts (module-level), not
# on every request, so endpoint latency stays low.
# ============================================================

# Which Groq model to use. Hard literal (no os.getenv) so a stale
# `.env` value can't override what's known to work today. The
# homework router uses the same model — keep them in sync.
GROQ_MODEL = "llama-3.3-70b-versatile"

# Max tokens the model may use to draft 6-8 cards. 2048 is plenty;
# Groq billing is per token so we keep the cap reasonable.
GROQ_MAX_TOKENS = 2048

# Temperature — lower means more consistent, deterministic cards.
# 0.3 gives crisp Cambridge-style Q&A without robotic phrasing.
GROQ_TEMPERATURE = 0.3

# Tables we read from / write to — declared once so a future
# rename is a single-line change.
NOTES_TABLE = "notes"
FLASHCARDS_TABLE = "flashcards"

# The default `mastery_level` for every freshly generated card.
# 0 = brand new, never studied. The flashcards page increments
# this on correct quiz answers (cap at MASTERY_MAX=5 client-side).
DEFAULT_MASTERY_LEVEL = 0

# Hard cap on how many cards we ever store from one note. Even if
# Groq returns 12 cards we only keep the first N — keeps the study
# deck focused and predictable.
MAX_CARDS_PER_NOTE = 8

# Minimum acceptable size for a card. Anything shorter is almost
# certainly the model hallucinating an empty entry — we drop it.
MIN_CARD_TEXT_LENGTH = 3


# ============================================================
# SYSTEM PROMPT — the Cambridge tutor persona for flashcards.
# ============================================================
# Verbatim from the spec. Tells Groq to return ONLY a JSON array
# of {front, back} objects. We parse that array below in
# _parse_groq_cards(). Any deviation (markdown fences, preamble,
# trailing commentary) is tolerated by the parser.
# ============================================================
SYSTEM_PROMPT = """
You are an expert Cambridge AS Level revision specialist.
You create flashcards that help students score Band 4.

THE STUDENT: Aisha, Cambridge AS Level, Lusaka Zambia.

You will receive a study note. Generate exactly 6 to 8 flashcard
question and answer pairs from it.

FLASHCARD QUALITY RULES:
- Every front (question) must be specific and testable
- Every back (answer) must be precise and complete
- Use Cambridge mark scheme language in every answer
- Include ceteris paribus where relevant
- Include a real Zambian/African example in at least
  30% of cards where genuinely relevant
- Never create vague or generic cards
- Every card must directly help in an exam
- Questions must be answerable from the note content only

CARD TYPES TO INCLUDE:
1. Definition cards — precise Cambridge definitions
2. Concept cards — explain a concept in 2-3 sentences
3. Application cards — apply concept to a real example
4. Analysis cards — chain of reasoning questions
5. Formula cards — for calculations and diagrams

FORMAT — return valid JSON array only:
[
  {
    "front": "Define price elasticity of demand",
    "back": "PED measures the responsiveness of quantity
    demanded to a change in price, ceteris paribus.
    Formula: % change in Qd ÷ % change in P.
    PED > 1 = elastic, PED < 1 = inelastic."
  }
]

No markdown. No explanation. JSON only.
If you cannot generate cards from this note return an empty array: []

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
Flashcard fronts should feel like questions a real
tutor would ask in a revision session.
Flashcard backs should feel like a tutor giving
a quick clear explanation — not a textbook definition.
Include the formula or key phrase that makes it click.
One sentence that gives the core idea, one that
applies it, one that connects to Cambridge marking.
Never sound like copy-pasted from a textbook.
"""


# ============================================================
# REQUEST / RESPONSE PYDANTIC MODELS
# ============================================================

class FlashcardGenerateRequest(BaseModel):
    """JSON body the frontend POSTs to /flashcards/generate."""

    # The UUID of the note the cards should be drawn from. The
    # backend verifies this note belongs to the caller before
    # doing anything else.
    note_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the note to generate flashcards from.",
    )

    # The UUID of the signed-in user. Must match the user_id
    # encoded in the bearer token — otherwise we return 401.
    user_id: str = Field(
        ...,
        min_length=1,
        description="UUID of the authenticated user (must match token).",
    )


class CardPair(BaseModel):
    """One {front, back} pair returned to the frontend."""

    # The question side of the card. Plain text.
    front: str

    # The Cambridge-style answer. Plain text, 1-3 sentences.
    back: str


class FlashcardGenerateResponse(BaseModel):
    """Envelope returned by /flashcards/generate."""

    # Human-readable result message. The frontend can show this
    # directly in a toast if it wants to.
    message: str

    # How many cards we actually wrote to Supabase. Zero is a
    # legitimate result (Groq returned []), not an error.
    cards_saved: int

    # The title of the note the cards came from. Pre-resolved
    # so the toast doesn't have to round-trip to fetch it.
    note_title: Optional[str] = None

    # The subject UUID those cards are tied to. The frontend
    # uses this to refresh the matching subject card.
    subject_id: Optional[str] = None

    # The actual list of saved cards (front + back only). The
    # frontend re-renders the flashcards page from these without
    # needing a second fetch.
    cards: List[CardPair] = []

    # True iff we hit the duplicate-prevention guard. False on
    # the happy path AND on the "Groq returned 0 cards" path.
    already_existed: bool = False


class HistoryFlashcard(BaseModel):
    """One row in the GET /flashcards/by-* responses."""

    # UUID of the flashcard.
    id: str
    # Card front (question).
    front: str
    # Card back (answer).
    back: str
    # 0-5 mastery score; defaults to 0 for new cards.
    mastery_level: int
    # UUID of the source note. The frontend uses this as the
    # grouping key for topics AND as the `note_id` body field
    # on /quiz/session — DO NOT confuse it with `note_title`.
    note_id: Optional[str] = None
    # The source-note title (read from the `topic` column).
    # Kept on the response so the frontend can label a topic
    # group without joining back to the notes table.
    note_title: Optional[str] = None
    # ISO timestamp the card was created at.
    created_at: str


class FlashcardListResponse(BaseModel):
    """Envelope returned by both GET endpoints."""

    # The slice of cards the caller asked for.
    data: List[HistoryFlashcard]
    # Total count (same as len(data) — no pagination today, but
    # we keep the field so the frontend's contract is identical
    # to the homework history shape).
    total: int


# ============================================================
# AUTH DEPENDENCY: verify_bearer_token
# ============================================================
# Same pattern as routers/homework.py. Reads the Authorization
# header, splits "Bearer <jwt>", verifies the JWT with Supabase,
# returns the decoded user_id. Every failure path returns the
# exact same generic 401 body so token-probing attackers can't
# distinguish "no token" from "expired" from "unknown user".
# ============================================================
def verify_bearer_token(
    # `Header(default=None, alias="Authorization")` populates this
    # parameter from the real HTTP header by name.
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> str:

    # --- STEP 1: ensure the header exists at all. ----------
    if not authorization:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 2: ensure the scheme is "Bearer". ------------
    parts = authorization.split(maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 3: extract the JWT. --------------------------
    token = parts[1].strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # --- STEP 4: hand the JWT to Supabase for verification. -
    # supabase.auth.get_user(jwt) returns a UserResponse on
    # success and raises on failure (expired/invalid/unknown).
    try:
        response = supabase.auth.get_user(token)
    except Exception as e:
        print(f"[Flashcards] Bearer token verify raised: {type(e).__name__}")
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # Handle both object-shaped and dict-shaped responses so a
    # supabase-py upgrade can't silently break auth.
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

    # --- STEP 5: pull the UUID out. -------------------------
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

    # Coerce to str so endpoints get a predictable type back.
    return str(user_id)


# ============================================================
# THE ROUTER
# ============================================================
# Every route below is registered against this object. main.py
# attaches it with:
#   app.include_router(flashcards.router, prefix="/flashcards",
#                      tags=["Flashcards"])
# Final paths: /flashcards/generate, /flashcards/by-subject,
# /flashcards/by-note.
# ============================================================
router = APIRouter()


# ============================================================
# HELPER: _parse_groq_cards
# ============================================================
# Convert Groq's raw text reply into a clean list of
# {front, back} dicts. The system prompt asks for a bare JSON
# array, but real-world LLM output sometimes includes:
#
#   • markdown code fences ( ```json ... ``` )
#   • a one-line preamble ("Here are the cards:")
#   • trailing commentary
#
# Strategy (in order):
#   1. Try json.loads on the raw string.
#   2. If that fails, strip any leading/trailing markdown
#      fences and try again.
#   3. If THAT fails, regex out the first balanced [...] block
#      and try json.loads on that.
#
# Returns (cards, ok). `ok=False` means we couldn't parse
# anything sensible — the caller turns that into a 503.
# Returns an EMPTY LIST + ok=True when Groq explicitly returned
# an empty array (the model decided the note isn't usable).
# ============================================================
def _parse_groq_cards(raw: str) -> Tuple[List[Dict[str, str]], bool]:
    # Defensive: an empty / falsy reply is treated like "model
    # had no useful output" rather than a parse error so the
    # caller can return a graceful "no cards" message.
    if not raw or not raw.strip():
        return ([], True)

    # ── ATTEMPT 1: parse the raw string directly. ───────
    candidates = [raw]

    # ── ATTEMPT 2: strip a leading/trailing markdown fence. ─
    # Models occasionally wrap output in ```json … ``` despite
    # the prompt forbidding markdown. We peel those off in a
    # forgiving way (any fence with or without a language tag).
    fence_stripped = re.sub(
        r"^\s*```[a-zA-Z]*\s*", "", raw.strip()
    )
    fence_stripped = re.sub(r"```\s*$", "", fence_stripped).strip()
    if fence_stripped and fence_stripped != raw:
        candidates.append(fence_stripped)

    # ── ATTEMPT 3: regex out the first [...] block. ────────
    # Greedy match from the first `[` to the LAST `]` survives
    # nested arrays and trailing commentary. The DOTALL flag
    # lets `.` match newlines so multiline arrays are caught.
    array_match = re.search(r"\[.*\]", raw, flags=re.DOTALL)
    if array_match:
        candidates.append(array_match.group(0))

    # Now try each candidate. First one that yields a list wins.
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue

        # Accept either a bare list, OR an object whose only
        # interesting key is "cards" (some models like to wrap).
        if isinstance(parsed, dict):
            for key in ("cards", "flashcards", "data"):
                if isinstance(parsed.get(key), list):
                    parsed = parsed[key]
                    break

        if isinstance(parsed, list):
            # Trust the prompt — return whatever it gave us;
            # validation happens at the next stage.
            cleaned: List[Dict[str, str]] = []
            for item in parsed:
                if not isinstance(item, dict):
                    continue
                front = str(item.get("front") or "").strip()
                back = str(item.get("back") or "").strip()
                # Drop cards that are too short to be real
                # questions/answers (almost always a model glitch).
                if len(front) < MIN_CARD_TEXT_LENGTH:
                    continue
                if len(back) < MIN_CARD_TEXT_LENGTH:
                    continue
                cleaned.append({"front": front, "back": back})

            # Cap the deck so a chatty model can't write 30
            # cards from one note. Newest cards win because
            # the prompt asks for a focused set.
            return (cleaned[:MAX_CARDS_PER_NOTE], True)

    # Nothing parsed — bubble up so the caller returns 503.
    return ([], False)


# ============================================================
# HELPER: _fetch_note_for_user
# ============================================================
# Fetch ONE note row, scoped to the caller's user_id, with the
# four columns we need to build the prompt. Returns the row dict
# on success or None when the row doesn't exist / doesn't
# belong to this user.
#
# Why we filter by user_id even though we're using the service
# role: the service role bypasses RLS, so without an explicit
# .eq("user_id", …) filter a malicious client could pass any
# note_id and read another student's note.
# ============================================================
def _fetch_note_for_user(note_id: str, user_id: str) -> Optional[Dict[str, Any]]:
    try:
        result = (
            supabase
            .table(NOTES_TABLE)
            # Only the columns we actually need for the prompt
            # and the response envelope.
            .select("id, user_id, subject_id, title, summary, key_points")
            # Match the requested note...
            .eq("id", note_id)
            # ...AND make sure it belongs to the caller.
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        rows = getattr(result, "data", None) or []
        return rows[0] if rows else None
    except Exception as e:
        # Logged for debugging; caller treats None as "not found".
        print(f"[Flashcards] Note fetch failed: {type(e).__name__}: {e}")
        return None


# ============================================================
# HELPER: _count_existing_cards_for_note
# ============================================================
# Duplicate-prevention check: how many flashcards in this user's
# library already point at this source note? If the answer is
# > 0 we skip the Groq call entirely.
#
# We filter by `note_id` (the source note's UUID) rather than by
# the title text. UUIDs are immutable, so the check stays correct
# even if the student renames the underlying note later — title
# text could drift and let a duplicate batch slip through.
# ============================================================
def _count_existing_cards_for_note(user_id: str, note_id: str) -> int:
    try:
        result = (
            supabase
            .table(FLASHCARDS_TABLE)
            .select("id", count="exact")
            .eq("user_id", user_id)
            # `note_id` is the foreign key into the notes table.
            .eq("note_id", note_id)
            .execute()
        )
        return getattr(result, "count", None) or 0
    except Exception as e:
        # On error we conservatively say "0 cards exist". Worst
        # case the user re-generates — they don't lose data.
        print(f"[Flashcards] Existing-count query failed: {type(e).__name__}: {e}")
        return 0


# ============================================================
# HELPER: _build_user_prompt
# ============================================================
# Combine the note's title + summary + key_points into a single
# text block we hand to Groq as the user message. We number the
# key points so the model is more likely to treat them as
# discrete revision points rather than a wall of prose.
# ============================================================
def _build_user_prompt(note: Dict[str, Any]) -> str:
    # Pull each field safely — every row in the notes table has
    # these columns, but a defensive default keeps us from
    # crashing on partial data.
    title = (note.get("title") or "").strip() or "Untitled note"
    summary = (note.get("summary") or "").strip()
    key_points = note.get("key_points") or []

    # `key_points` may be a Python list (when PostgREST gives us
    # a real text[]), or occasionally a JSON-encoded string in
    # older rows. Normalise to a list of strings either way.
    if isinstance(key_points, str):
        try:
            decoded = json.loads(key_points)
            if isinstance(decoded, list):
                key_points = decoded
            else:
                key_points = [key_points]
        except json.JSONDecodeError:
            key_points = [key_points]

    if not isinstance(key_points, list):
        key_points = []

    # Build the numbered list. We use 1. / 2. / 3. so the LLM
    # treats each one as a distinct concept to test.
    numbered = ""
    for idx, point in enumerate(key_points, start=1):
        text = str(point or "").strip()
        if not text:
            continue
        numbered += f"{idx}. {text}\n"

    # Assemble the final user message. Cambridge tutors talk in
    # paragraphs — keep the layout natural rather than JSON-ish.
    parts = [f"Note title: {title}"]
    if summary:
        parts.append(f"Summary:\n{summary}")
    if numbered:
        parts.append(f"Key points:\n{numbered.strip()}")
    return "\n\n".join(parts)


# ============================================================
# ENDPOINT: POST /flashcards/generate
# ============================================================
# END-TO-END FLOW:
#   1. Pydantic validates the body. Auth dep verifies the token.
#   2. We confirm token's user_id == body.user_id (anti-spoof).
#   3. We fetch the source note (scoped to this user).
#   4. We check whether this user already has cards for the note.
#      If yes → return 200 with `already_existed=true` and
#      DO NOT regenerate.
#   5. We build the user prompt + call Groq.
#   6. We parse Groq's response into a list of {front, back}.
#   7. We insert each card into the flashcards table. A failure
#      on one row is logged and skipped; other rows still save.
#   8. We respond with the saved cards + a result message.
# ============================================================
@router.post(
    "/generate",
    response_model=FlashcardGenerateResponse,
    summary="Generate flashcards from a note",
)
def generate_flashcards(
    body: FlashcardGenerateRequest,
    # Auth runs first; bad tokens never reach the route body.
    verified_user_id: str = Depends(verify_bearer_token),
):
    # ── STEP 1: identity check ──────────────────────────────
    # Token says caller is user X. Body claims to act as user Y.
    # We require X == Y — without this a logged-in user could
    # generate cards on someone else's notes.
    if body.user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    # ── STEP 2: fetch the source note ──────────────────────
    note = _fetch_note_for_user(body.note_id, verified_user_id)
    if not note:
        # 404 because either the row doesn't exist, OR it
        # exists but isn't ours. We don't differentiate — that
        # would leak the existence of other users' notes.
        raise HTTPException(
            status_code=404,
            detail={"error": "Note not found"},
        )

    note_title = (note.get("title") or "").strip()
    note_subject_id = note.get("subject_id")

    # ── STEP 3: duplicate prevention ───────────────────────
    # If this user already has any card linked to this note,
    # we return 200 with a friendly message rather than calling
    # Groq again. Saves money AND prevents the deck from being
    # flooded with near-duplicate cards on accidental clicks.
    existing_count = _count_existing_cards_for_note(
        user_id=verified_user_id,
        # Pass the source note's UUID — see helper docstring for
        # why this is more reliable than matching on the title.
        note_id=body.note_id,
    )
    if existing_count > 0:
        return FlashcardGenerateResponse(
            message="Cards already exist for this note",
            cards_saved=existing_count,
            note_title=note_title,
            subject_id=note_subject_id,
            cards=[],
            already_existed=True,
        )

    # ── STEP 4: lazy-import groq_client and build the prompt. ──
    # We import groq_client inside the function (rather than at
    # module top) to dodge the circular import: main.py imports
    # this router, this router would have to import main.py. By
    # the time this function actually RUNS, main.py is fully
    # loaded and groq_client is ready.
    try:
        from main import groq_client  # noqa: WPS433 (intentional lazy import)
    except Exception as e:
        print(f"[Flashcards] groq_client import failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    user_prompt = _build_user_prompt(note)

    # ── STEP 5: call Groq ───────────────────────────────────
    try:
        completion = groq_client.chat.completions.create(
            # MODEL — locked to llama-3.3-70b-versatile.
            model=GROQ_MODEL,
            # MESSAGES — persona (system) + the note (user).
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt},
            ],
            # MAX TOKENS — fits 8 Cambridge-style Q&A pairs.
            max_tokens=GROQ_MAX_TOKENS,
            # TEMPERATURE — low for reproducible Cambridge style.
            temperature=GROQ_TEMPERATURE,
        )
    except Exception as e:
        # ALL Groq failure modes map to the same 503 — the user
        # only needs to know to retry. Internal cause is logged.
        print(f"[Flashcards] Groq call failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    # Pull the raw assistant text out — Groq mirrors OpenAI's
    # response shape so .choices[0].message.content is the text.
    try:
        raw_answer = completion.choices[0].message.content or ""
    except (AttributeError, IndexError) as e:
        print(f"[Flashcards] Groq response shape unexpected: {e}")
        raise HTTPException(
            status_code=503,
            detail={"error": "AI service unavailable. Please try again."},
        )

    # ── STEP 6: parse the JSON array. ──────────────────────
    cards_raw, parse_ok = _parse_groq_cards(raw_answer)
    if not parse_ok:
        # We couldn't extract any valid JSON. Log the raw text
        # so an engineer can inspect it, but never return it
        # to the caller — it may contain prompt fragments.
        print(
            "[Flashcards] Could not parse Groq response. "
            f"First 200 chars: {raw_answer[:200]!r}"
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "Failed to generate cards. Please try again."},
        )

    if len(cards_raw) == 0:
        # The model decided the note isn't usable for cards
        # (e.g. too short, too vague). This is NOT an error —
        # we return a 200 with the explanation.
        return FlashcardGenerateResponse(
            message="Could not generate cards from this note",
            cards_saved=0,
            note_title=note_title,
            subject_id=note_subject_id,
            cards=[],
            already_existed=False,
        )

    # ── STEP 7: save each card to Supabase ─────────────────
    # We insert ONE AT A TIME so a single bad row (e.g. a row
    # that violates a CHECK constraint) doesn't kill the batch.
    saved_cards: List[CardPair] = []
    for card in cards_raw:
        # Payload mirrors the live schema:
        #   • user_id       — the verified caller.
        #   • subject_id    — copied from the source note.
        #   • note_id       — UUID of the source note (foreign
        #                     key; the canonical link).
        #   • topic         — note.title kept for display so the
        #                     flashcards page can label a topic
        #                     without joining back to `notes`.
        #   • front / back  — the question / answer from Groq.
        #   • mastery_level — 0 (brand new).
        # created_at is auto-populated by the default value.
        payload = {
            "user_id": verified_user_id,
            "subject_id": note_subject_id,
            "note_id": body.note_id,
            "topic": note_title,
            "front": card["front"],
            "back": card["back"],
            "mastery_level": DEFAULT_MASTERY_LEVEL,
        }
        try:
            insert_result = supabase.table(FLASHCARDS_TABLE).insert(payload).execute()
            # supabase-py returns either an object with .data
            # or a dict with "data" — accept both.
            rows = (
                getattr(insert_result, "data", None)
                or (insert_result.get("data") if isinstance(insert_result, dict) else [])
            )
            if rows:
                saved_cards.append(CardPair(front=card["front"], back=card["back"]))
            else:
                # Insert ran but returned no row — rare. Log and
                # move on so the other cards still save.
                print(
                    "[Flashcards] Card insert returned no rows for "
                    f"topic={note_title!r}; skipping."
                )
        except Exception as e:
            # Log and continue with the rest of the batch.
            print(
                f"[Flashcards] Insert failed for card "
                f"({card.get('front','')[:60]!r}): "
                f"{type(e).__name__}: {e}"
            )
            continue

    # ── STEP 8: notify student when cards were saved. ─────────
    saved_count = len(saved_cards)
    if saved_count > 0:
        subject_label = note_title or "your note"
        if note_subject_id:
            try:
                subj_result = (
                    supabase.table("subjects")
                    .select("name")
                    .eq("id", note_subject_id)
                    .limit(1)
                    .execute()
                )
                subj_rows = getattr(subj_result, "data", None) or []
                if subj_rows and subj_rows[0].get("name"):
                    subject_label = str(subj_rows[0]["name"]).strip()
            except Exception as e:
                print(f"[Flashcards] Subject name lookup failed: {e}")
        create_notification(
            user_id=verified_user_id,
            type="flashcards",
            title=f"{saved_count} Flashcards Created",
            message=(
                f"New revision cards generated for {subject_label}. "
                "Head to Flashcards to start studying."
            ),
        )

    # ── STEP 9: respond. ────────────────────────────────────
    message = (
        f"{saved_count} cards generated successfully"
        if saved_count > 0
        else "Could not save any cards. Please try again."
    )
    return FlashcardGenerateResponse(
        message=message,
        cards_saved=saved_count,
        note_title=note_title,
        subject_id=note_subject_id,
        cards=saved_cards,
        already_existed=False,
    )


# ============================================================
# ENDPOINT: GET /flashcards/by-subject
# ============================================================
# Returns every flashcard the caller owns for a single subject,
# lowest-mastery first so the cards that need the most practice
# bubble to the top.
# ============================================================
@router.get(
    "/by-subject",
    response_model=FlashcardListResponse,
    summary="List flashcards for one subject",
)
def list_by_subject(
    # Query parameters — `Query(...)` carries the OpenAPI doc
    # text AND the validation rules (min_length=1). FastAPI
    # returns 422 automatically if either is missing.
    subject_id: str = Query(..., min_length=1, description="Subject UUID"),
    user_id: str = Query(..., min_length=1, description="Caller's UUID (must match token)"),
    verified_user_id: str = Depends(verify_bearer_token),
):
    # Anti-spoof: the user_id query param must match the JWT.
    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    try:
        result = (
            supabase
            .table(FLASHCARDS_TABLE)
            # Columns the response envelope needs. `note_id` is
            # the source-note UUID (the foreign key); `topic`
            # carries the source-note title so the frontend can
            # label a topic group without joining back to notes.
            .select(
                "id, front, back, mastery_level, note_id, topic, created_at"
            )
            # Scope to the caller (service role bypasses RLS).
            .eq("user_id", verified_user_id)
            # And to the requested subject.
            .eq("subject_id", subject_id)
            # Lowest mastery first → these cards need work first.
            .order("mastery_level", desc=False)
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception as e:
        # Failure is logged + surfaced as an empty list rather
        # than a 5xx, so the page can still render the empty
        # state without crashing.
        print(f"[Flashcards] by-subject query failed: {type(e).__name__}: {e}")
        rows = []

    # Normalise each row into the HistoryFlashcard shape.
    items: List[HistoryFlashcard] = []
    for r in rows:
        items.append(
            HistoryFlashcard(
                id=str(r.get("id", "")),
                front=r.get("front") or "",
                back=r.get("back") or "",
                mastery_level=int(r.get("mastery_level") or 0),
                # Source-note UUID and title, kept separate so the
                # frontend can use the UUID for backend calls and
                # the title only for display.
                note_id=(str(r["note_id"]) if r.get("note_id") else None),
                note_title=r.get("topic"),
                created_at=str(r.get("created_at") or ""),
            )
        )

    return FlashcardListResponse(data=items, total=len(items))


# ============================================================
# ENDPOINT: GET /flashcards/by-note
# ============================================================
# Returns every flashcard generated from one specific note.
# Filters directly on the `note_id` foreign key column — no
# title lookup needed, so the query is one round-trip and stays
# correct even if the source note's title was edited later.
# ============================================================
@router.get(
    "/by-note",
    response_model=FlashcardListResponse,
    summary="List flashcards for one note",
)
def list_by_note(
    note_id: str = Query(..., min_length=1, description="Source note UUID"),
    user_id: str = Query(..., min_length=1, description="Caller's UUID (must match token)"),
    verified_user_id: str = Depends(verify_bearer_token),
):
    # Anti-spoof check.
    if user_id.strip() != verified_user_id.strip():
        raise HTTPException(
            status_code=401,
            detail={"error": "Unauthorised — please log in"},
        )

    try:
        result = (
            supabase
            .table(FLASHCARDS_TABLE)
            .select(
                "id, front, back, mastery_level, note_id, topic, created_at"
            )
            .eq("user_id", verified_user_id)
            # Filter on the foreign key UUID, not the title text —
            # immutable, so a later note rename can't break this.
            .eq("note_id", note_id)
            .order("mastery_level", desc=False)
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception as e:
        print(f"[Flashcards] by-note query failed: {type(e).__name__}: {e}")
        rows = []

    items: List[HistoryFlashcard] = []
    for r in rows:
        items.append(
            HistoryFlashcard(
                id=str(r.get("id", "")),
                front=r.get("front") or "",
                back=r.get("back") or "",
                mastery_level=int(r.get("mastery_level") or 0),
                note_id=(str(r["note_id"]) if r.get("note_id") else None),
                note_title=r.get("topic"),
                created_at=str(r.get("created_at") or ""),
            )
        )

    return FlashcardListResponse(data=items, total=len(items))
