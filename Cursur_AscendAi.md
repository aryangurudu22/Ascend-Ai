# AscendAI — Cursor Project Intelligence File
# Read this file completely before writing any code or making any suggestion.
# This file is the single source of truth for this project.

---

## WHO IS ARYAN

- Name: Aryan Reddy, 21, Lusaka Zambia
- Education: BTech Computer Science — VIT
- Goal: First paying client by June 2026. Scale to $100k/year by 2029
- Fiverr: fiverr.com/users/aryanreddy22
- GitHub: github.com/aryangurudu22
- LinkedIn: linkedin.com/in/aryanreddy22
- Project repo: github.com/aryangurudu22/Ascend-Ai

---

## STRICT TEACHING RULES — NEVER BREAK THESE

1. Always explain WHAT and WHY before showing any code
2. One step at a time — wait for confirmation before moving on
3. Use real-world analogies for every technical concept
4. Define every technical term immediately when used
5. Every line of code must have a comment a non-technical person can understand
6. NO HARDCODING ANYWHERE — not colours, not keys, not URLs, not messages, not sizes
   - Colours come from tailwind.config.js
   - Keys come from .env or .env.local
   - API URLs come from environment variables
7. Never rush. Never skip steps. Never assume understanding.
8. Read every screenshot fully before responding
9. Check understanding before moving on

---

## PROJECT — ASCENDAI

### What It Is
A premium Cambridge AS Level AI Study Assistant built for Aryan's sister Aisha.
She is the first real user and will give the first Fiverr review.
The app is also a portfolio piece to attract paying clients.

### Brand
- App name: AscendAI
- Tagline: by Shivora
- Personality: Premium, academic, bold — Oxford/Cambridge prestige meets modern SaaS

### Sister's Subjects
- Economics 9708
- Business Studies 9609
- English Language 9093
- ICT 9626

### 5 Features
1. Homework Assistant — student asks question, AI answers in Cambridge format
2. Note Summariser — auto-summarises Google Classroom posts via n8n
3. Flashcard + Quiz Engine — adaptive flashcards from notes, spaced repetition
4. Intelligent Timetable — auto-generates weekly schedule every Sunday via n8n
5. Past Paper Solver — PDF upload, AI solves with step-by-step Cambridge explanations

---

## DESIGN SYSTEM — LOCKED IN — NO HARDCODING

### Mode
Light mode only. Dark mode shelved for later.

### Colours (all defined in tailwind.config.js)
Use the EXACT token names below in className. Do not invent new ones.
| Tailwind class      | Hex value  | Usage                          |
|---------------------|------------|--------------------------------|
| bg-background       | #FAF6EE    | Page background                |
| bg-card             | #F2EBD9    | Card backgrounds               |
| bg-hover            | #E8DFC8    | Hover states                   |
| bg-gold / text-gold | #B8960C    | Primary accent, buttons        |
| bg-gold-light       | #D4A820    | Lighter gold for gradients     |
| bg-review-bg        | #FFF8F0    | "Needs Review" item background |
| text-text-primary   | #1A1A1A    | Main text                      |
| text-text-muted     | #6B5E3E    | Secondary text                 |
| text-text-hint      | #9E8E6A    | Placeholders, hints            |
| bg-input-bg         | #FFFFFF    | Input backgrounds              |
| border-input-border | #E8DFC8    | Input borders                  |

### Subject Colours (light mode, all in tailwind.config.js)
| Subject        | Background | Text    | Border  |
|----------------|------------|---------|---------|
| Economics 9708 | #EBF4FC    | #1B5E8A | #A8CDE8 |
| Business 9609  | #EBF7EF    | #1B5E3A | #A8DDB8 |
| English 9093   | #FBF3EB    | #7A3E10 | #E8C4A0 |
| ICT 9626       | #F3EBFB    | #4E1B8A | #C4A0E8 |

### Typography
- Headings: Playfair Display — weight 700 / 500
- Body, labels, buttons, inputs: Inter — weight 400 / 500 / 600

### Other
- Border radius: 4px sharp corners everywhere
- Fully responsive — mobile first
- Icons: use Lucide React only

---

## TECH STACK — LOCKED IN

| Layer           | Technology                        | Port  |
|-----------------|-----------------------------------|-------|
| Frontend        | Next.js 16.2.6 + Tailwind CSS v3  | 3001  |
| Backend         | FastAPI (Python)                  | 8001  |
| Database + Auth | Supabase                          | -     |
| AI brain        | Groq (LLaMA 3 70B)                | -     |
| Automation      | n8n                               | -     |
| Frontend deploy | Vercel                            | -     |
| Backend deploy  | Render                            | -     |
| Version control | GitHub                            | -     |
| Editor          | Cursor                            | -     |

---

## PROJECT STRUCTURE

```
C:\Users\DELL\Desktop\ascendai\
├── frontend\
│   ├── app\
│   │   ├── page.js                          ✅ Root redirect (login or dashboard)
│   │   ├── login\
│   │   │   └── page.js                      ✅ Google OAuth login page
│   │   ├── onboarding\
│   │   │   ├── welcome\page.js              ✅ Step 1 — subjects display
│   │   │   ├── exam-dates\page.js           ✅ Step 2 — exam date inputs
│   │   │   ├── study-hours\page.js          ✅ Step 3 — study window picker
│   │   │   ├── connect-google\page.js       ✅ Step 4 — Google Classroom connect
│   │   │   └── features\page.js             ✅ Step 5 — feature tour + go to dashboard
│   │   ├── dashboard\
│   │   │   └── page.js                      ✅ Premium dashboard (auth check done)
│   │   └── features\
│   │       └── homework\
│   │           └── page.js                  ✅ Homework Assistant UI (mock responses)
│   ├── app\auth\callback\route.js           ✅ PKCE OAuth callback (exchanges code → session cookies)
│   ├── lib\
│   │   ├── supabaseClient.js                ✅ Browser client (createBrowserClient from @supabase/ssr)
│   │   ├── supabaseServer.js                ✅ Server client for Route Handlers / Server Components
│   │   └── subjects.js                      ✅ Single source of truth for subject metadata (mirrors DB)
│   ├── proxy.js                              ✅ Next.js 16 session-refresh + route-protection (replaces deprecated middleware.js)
│   ├── tailwind.config.js                   ✅ Full design system — all tokens
│   ├── postcss.config.js                    ✅ Tailwind v3 + autoprefixer
│   ├── app\globals.css                      ✅ Tailwind directives + Google Fonts + feature-card hover
│   └── .env.local                           ✅ NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_API_URL
├── backend\
│   ├── venv\                                ✅ Virtual environment
│   ├── main.py                              ✅ FastAPI app — Groq + Supabase connected
│   ├── database.py                          ✅ Supabase client — imports into main.py
│   ├── .env                                 ✅ All secret keys
│   └── requirements.txt                     ✅ All libraries listed
└── .gitignore                               ✅ Protects all secrets
```

---

## CREDENTIALS (saved locally — never in code)

| Key                          | Location              |
|------------------------------|-----------------------|
| GROQ_API_KEY                 | backend/.env          |
| SUPABASE_URL                 | backend/.env          |
| SUPABASE_ANON_KEY            | backend/.env          |
| SUPABASE_SERVICE_ROLE_KEY    | backend/.env          |
| SUPABASE_DB_PASSWORD         | backend/.env          |
| GOOGLE_CLIENT_ID             | backend/.env          |
| GOOGLE_CLIENT_SECRET         | backend/.env          |
| NEXT_PUBLIC_SUPABASE_URL     | frontend/.env.local   |
| NEXT_PUBLIC_SUPABASE_ANON_KEY| frontend/.env.local   |
| NEXT_PUBLIC_API_URL          | frontend/.env.local   |

Supabase project URL: https://fdbsenfroiayakbjtcjk.supabase.co

---

## DATABASE SCHEMA — 10 TABLES IN SUPABASE

All tables have:
- UUID primary keys
- created_at timestamps
- Row Level Security (RLS) enabled
- user_id foreign key linking to auth.users

| Table                  | Purpose                                              |
|------------------------|------------------------------------------------------|
| profiles               | Student profile — name, study hours, preferences    |
| subjects               | 4 Cambridge subjects with exam dates + colour codes |
| homework_questions     | Every question asked + AI answer + subject tag      |
| google_classroom_posts | Raw posts fetched from Classroom by n8n             |
| notes                  | AI-summarised structured notes per subject          |
| flashcards             | Front/back cards generated from notes               |
| quiz_sessions          | Each quiz attempt with score and subject            |
| quiz_answers           | Individual card answers within a session            |
| timetable_entries      | Weekly schedule entries with completion status      |
| past_papers            | Uploaded PDFs + AI solutions                        |

Storage bucket: past_papers (user-isolated RLS)

---

## COMMANDS TO START THE PROJECT

### Terminal 1 — Backend
```
cd C:\Users\DELL\Desktop\ascendai\backend
.\venv\Scripts\activate
uvicorn main:app --reload --port 8001
```

### Terminal 2 — Frontend
```
cd C:\Users\DELL\Desktop\ascendai\frontend
npm run dev
```
(Port 3001 is baked into the `dev` script in package.json — no `--port` flag needed.)

### URLs
| Service    | URL                          |
|------------|------------------------------|
| Frontend   | http://localhost:3001        |
| Backend    | http://127.0.0.1:8001        |
| API Docs   | http://127.0.0.1:8001/docs   |

---

## WHAT IS FULLY COMPLETE

### Day 1 ✅
- All 6 accounts created (Groq, Supabase, Vercel, Render, Google Cloud, GitHub)
- Google APIs enabled: Classroom, YouTube Data v3, Google Drive
- OAuth consent screen configured — sister added as test user
- Next.js frontend created — port 3001
- FastAPI backend created — port 8001
- Groq AI connected and confirmed
- CORS configured — frontend and backend talking
- Health check live at /
- Auto-docs live at /docs
- AscendAI brand visible in browser
- Everything pushed to GitHub

### Day 2 ✅
- Tailwind CSS downgraded from v4 to v3
- tailwind.config.js created — full design system, all colour tokens
- postcss.config.js configured
- globals.css rewritten with Tailwind v3 directives + Google Fonts
- All 10 Supabase tables created with UUID keys, RLS, indexes
- 4 subjects inserted into subjects table
- Supabase Storage bucket past_papers created with RLS
- database.py created — Supabase client
- Supabase connected to FastAPI backend — read/write confirmed
- supabaseClient.js created — frontend Supabase client
- Login page built — Google OAuth button — premium design
- Supabase Auth configured — Google provider, redirect URLs set
- Root page.js updated — redirects to login or dashboard
- Onboarding flow built — all 5 steps complete
  - Step 1: Welcome + subjects display
  - Step 2: Exam dates input
  - Step 3: Study hours window picker
  - Step 4: Google Classroom connect (mock for now)
  - Step 5: Feature tour + go to dashboard
- Onboarding saves to localStorage (ascendai_onboarding_data)
- Premium dashboard page created — auth check in place
- Premium dashboard mockup approved (HTML)
- Homework Assistant UI built — mock responses
- Homework Assistant mockup approved (HTML)
- Features folder structure created (app/features/)
- Project moved from VS Code to Cursor

### Day 3 (in progress) ✅ Highlights
- @supabase/ssr installed; lib/supabaseClient + lib/supabaseServer set up
- proxy.js (Next 16 replacement for middleware.js) handles session refresh
  AND server-side route protection (/dashboard + /onboarding/*)
- /auth/callback Route Handler performs PKCE code exchange server-side
- Premium dashboard fully built: sticky header (search/bell/avatar dropdown),
  5-card feature shortcut grid, two-column layout (sessions/notes left,
  review/AI usage/exam dates right)
- Onboarding flow no longer loses session after redirect to dashboard
- lib/subjects.js created — eliminates hardcoded subject names everywhere

---

## WHAT IS PENDING — PRIORITY ORDER

### CRITICAL — Fix First (Session Persistence Bug) ✅ RESOLVED
**Problem (resolved):** After Google OAuth login and completing onboarding,
user was redirected back to /login instead of staying on /dashboard.

**Resolution:**
1. ✅ Installed @supabase/ssr
2. ✅ Rewrote lib/supabaseClient.js to use createBrowserClient
3. ✅ Added lib/supabaseServer.js for server-side use
4. ✅ Created proxy.js (Next.js 16 renamed `middleware.js` → `proxy.js`)
5. ✅ Added app/auth/callback/route.js for PKCE code exchange
6. ✅ Updated login + dashboard + root page to use the new client
7. ✅ Verified login → onboarding → dashboard flow stays logged in

### External action still required (Aryan to verify in dashboards)
- [ ] Supabase Dashboard → Auth → URL Configuration must include
      `http://localhost:3001/auth/callback`
- [ ] Google Cloud Console → OAuth client → Authorised redirect URIs
      must include `http://localhost:3001/auth/callback`
      (NOT the old `/api/auth/callback/google` path)

---

## REMAINING BUILD PLAN — DAY BY DAY

### Day 3 — Complete (one Supabase persistence task deferred)
- [x] Session persistence fixed (@supabase/ssr + proxy.js + PKCE callback)
- [x] Premium dashboard mockup converted into real Next.js component
- [x] Feature shortcut grid added above the two-column dashboard layout
- [x] lib/subjects.js created — single source of truth for subject data
- [x] Homework + exam-dates + dashboard refactored to import from it
      (eliminates hardcoded subject names across components)
- [x] **FastAPI endpoint built: POST /api/homework**
  - Receives `{ subject, question, adjustment? }`
  - Subject-specific Cambridge system prompts (PEEL for Economics/Business,
    CLS for English, technical glossary for ICT)
  - Adjustment param re-shapes answer (simplify | detail | shorten | examples)
  - Returns `{ answer, breakdown }` parsed from a strict ANSWER:/BREAKDOWN:
    delimited Groq reply
  - GROQ_MODEL is configurable via .env (default llama-3.3-70b-versatile)
  - 400 for invalid subject, 502 for upstream AI failures, 503 if API key missing
- [x] Frontend homework page now calls the real endpoint via fetch using
      NEXT_PUBLIC_API_URL. MOCK_RESPONSES removed. Inline error banner replaces
      alert() on failure. localStorage history still kept (last 10 questions).
- [ ] **DEFERRED:** Save homework history to Supabase `homework_questions`
      (requires backend JWT verification + frontend Authorization header;
      will land in a follow-up task)
- [ ] Push to GitHub

### Day 4 — Note Summariser + Google Classroom
- [ ] Set up n8n instance on Render
- [ ] Build n8n workflow: poll Google Classroom every 30 minutes
- [ ] Save raw posts to google_classroom_posts table
- [ ] Build FastAPI endpoint: POST /notes/summarise
  - Receives raw classroom post content
  - Sends to Groq for structured summarisation
  - Saves to notes table with subject tag
- [ ] Build frontend notes page — organised by subject
- [ ] Push to GitHub

### Day 5 — Flashcard + Quiz Engine
- [ ] Build FastAPI endpoint: POST /flashcards/generate
  - Takes a note_id, generates flashcards using Groq
  - Saves cards to flashcards table
- [ ] Build frontend flashcard viewer
- [ ] Build quiz mode — shows card front, user answers, records result
- [ ] Build FastAPI endpoint: POST /quiz/session and POST /quiz/answer
  - Saves quiz_sessions and quiz_answers to Supabase
- [ ] Implement basic spaced repetition (harder cards appear more often)
- [ ] Push to GitHub

### Day 6 — Intelligent Timetable
- [ ] Build FastAPI endpoint: POST /timetable/generate
  - Reads student's exam dates, study hours, subject workload from Supabase
  - Sends to Groq to generate weekly schedule
  - Saves entries to timetable_entries table
- [ ] Build n8n workflow: trigger timetable generation every Sunday
- [ ] Build frontend timetable page — weekly view, mark sessions as done
- [ ] Push to GitHub

### Day 7 — Past Paper Solver
- [ ] Set up Supabase Storage upload from frontend
- [ ] Build frontend past papers page — upload PDF button
- [ ] Build FastAPI endpoint: POST /past-papers/solve
  - Receives PDF file
  - Stores in Supabase Storage
  - Processes with Groq — step-by-step Cambridge solutions
  - Saves solutions to past_papers table
- [ ] Display solutions on frontend
- [ ] Push to GitHub

### Day 8 — YouTube Transcript Summariser
- [ ] Build FastAPI endpoint: POST /notes/youtube
  - Receives YouTube URL from a classroom post
  - Fetches transcript using YouTube Data API v3
  - Summarises with Groq
  - Saves to notes table with source_type = youtube
- [ ] Integrate into Note Summariser pipeline
- [ ] Push to GitHub

### Day 9 — Google Drive File Summariser
- [ ] Build FastAPI endpoint: POST /notes/drive
  - Receives Google Drive file link
  - Fetches content using Drive API
  - Summarises with Groq
  - Saves to notes table with source_type = drive
- [ ] Integrate into Note Summariser pipeline
- [ ] Push to GitHub

### Day 10 — Polish + Mobile + Performance
- [ ] Test every screen on mobile (375px)
- [ ] Fix any responsive issues
- [ ] Add loading states to every button and data fetch
- [ ] Add error messages for every possible failure
- [ ] UptimeRobot setup — ping Render every 5 minutes
- [ ] Push to GitHub

### Final Phase — Deploy + Launch
- [ ] Deploy frontend to Vercel — connect GitHub repo
- [ ] Deploy backend to Render — connect GitHub repo
- [ ] Update Google OAuth redirect URIs with live Vercel URL
- [ ] Update Supabase Auth site URL with live Vercel URL
- [ ] Update CORS in main.py with live Vercel URL
- [ ] Update .env files on Render with production keys
- [ ] End-to-end test on live URLs
- [ ] Record demo video — all 5 features
- [ ] Update Fiverr gig with demo video
- [ ] Sister uses app — gives Fiverr review
- [ ] Pricing moves from $150 to $300

---

## IMPORTANT TECHNICAL NOTES

### Virtual environment on Windows
Always activate with:
```
.\venv\Scripts\activate
```
NOT `source venv/bin/activate` — that is Mac/Linux only.

### Ports
Frontend always runs on 3001. Backend always runs on 8001. Never use defaults.

### Tailwind v3 — critical
The project uses Tailwind CSS v3 NOT v4.
v4 does not use tailwind.config.js.
If Tailwind stops working always check version first: `npm list tailwind`

### Supabase Auth — @supabase/ssr (done)
Standard @supabase/supabase-js does not persist sessions in Next.js App Router.
The project uses @supabase/ssr with `createBrowserClient` (browser),
`createServerClient` (server), and a `proxy.js` at the project root that
refreshes the session cookie on every request. The OAuth flow uses PKCE
and exchanges the code server-side in `app/auth/callback/route.js`.

### Next.js 16 — middleware renamed to proxy
Next.js 16 deprecated the `middleware.js` file convention. Use `proxy.js`
with an exported function named `proxy` (not `middleware`). Same API,
same `config.matcher` shape — only the file name and function name changed.

### No hardcoding rule
This applies to EVERYTHING:
- Colours → tailwind.config.js tokens only
- API keys → .env / .env.local only
- URLs → environment variables only
- Text strings that repeat → constants file
- Subject names and codes → import from `frontend/lib/subjects.js`
  (this module mirrors the Supabase `subjects` table; update both together
  if the syllabus list ever changes)

### pip on Windows
If `pip` is blocked by Application Control policy, always use:
```
python -m pip install packagename
```

### GitHub push sequence
```
git add .
git commit -m "clear description of what changed"
git push
```
Never push without a meaningful commit message.
Never push broken code — test first, push after.

### Google OAuth redirect URI
The project uses a custom Route Handler at `/auth/callback`, NOT the old
`/api/auth/callback/google` path. Register these in BOTH Google Cloud
Console (OAuth client) AND Supabase Dashboard (Auth → URL Configuration):

Development: http://localhost:3001/auth/callback
Production:  https://[vercel-url]/auth/callback

---

