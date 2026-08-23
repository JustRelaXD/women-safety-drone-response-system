# Here to Listen — Workplace Safety & Support Platform

A private, AI-supported conversational tool for people in India dealing with
possible workplace harassment, abuse, intimidation, coercion, or
discrimination. It listens, helps organize what happened, flags safety
concerns, and shares general Indian legal information (currently: the POSH
Act, 2013) with citations — while being explicit about what it is not: a
licensed counsellor, lawyer, police officer, or emergency service.

This repo is a **working vertical slice covering Phases 1 and 2** of the
build plan, plus a lightweight, honest version of Phase 3 (see below). It is
not a finished production system — see [Scope & what's simplified](#scope--whats-simplified-read-this)
before deploying it anywhere real people will use it.

```
User message → Orchestrator → Safety + Situation agents (parallel)
             → [if appropriate] Legal retrieval + Action planning
             → Response Composer → reply + case state + UI panels
```

## What's implemented

- **Chat UI** (React + Vite) with a calm, non-clinical visual design, typing
  indicator, safety banner, and a "Why am I seeing this?" explanation.
- **Backend orchestrator** (Node/Express) coordinating five agents:
  - **Emotional Support / Response Composer Agent** — writes the actual reply,
    follows LISTEN → UNDERSTAND → SAFETY → CLARIFY → SUPPORT → LAW → OPTIONS
    → PLAN, and never dumps legal info on the first message.
  - **Situation Understanding Agent** — extracts structured case fields
    (never a finding of guilt, never inventing details).
  - **Safety Agent** — classifies `none` / `possible_concern` /
    `urgent_concern`, fails toward caution on error.
  - **Indian Legal Information Agent** — retrieval over a small curated
    knowledge base with mandatory source/section/date citations; explicitly
    says "I don't have a confident answer" rather than guessing.
  - **Action Planning Agent** — offers 3–5 non-directive next steps.
- **Structured case state**, kept separate from the raw transcript, with a
  strict field allow-list (see `backend/src/state/caseState.js`).
- **Privacy controls**: delete conversation, export conversation, clear
  extracted case details, start a fresh private session.
- **Security basics**: helmet, CORS allow-list, rate limiting, input
  validation, a prompt-injection guard (wrapping + pattern flagging), and
  logging that deliberately omits raw message content.
- **Automated tests**: 11 fast unit tests (no API calls) plus 12 integration
  tests mapped 1:1 to the required test scenarios (require a live API key).

## Scope & what's simplified (read this)

Being upfront about where this MVP takes shortcuts, and what to fix before
any real deployment:

1. **Legal knowledge base is small and hand-curated, not a full RAG
   pipeline.** `backend/src/knowledge/legalKnowledgeBase.json` has ~6 entries
   about the POSH Act, 2013, written from general knowledge and marked
   `_readme` as needing independent re-verification against
   [India Code](https://www.indiacode.nic.in) before production use. The
   retrieval step (`backend/src/agents/legalAgent.js`) does simple tag
   matching, not embeddings. `backend/src/db/schema.sql` documents the
   `legal_documents` / `legal_chunks` tables and pgvector-ready column for
   the real pipeline (parser → chunking → embeddings → vector DB → semantic
   retrieval → source filtering) described in the spec — that's Phase 3
   proper, intentionally not built here yet.
2. **Storage is in-memory**, not Postgres. Restarting the backend clears all
   sessions. This was a deliberate choice to minimize what's persisted while
   validating the product; `backend/src/db/schema.sql` is ready for when you
   need durability.
3. **No authentication.** Sessions are opaque, unlinkable IDs generated
   client-side-triggered, server-side-issued. Fine for an anonymous MVP;
   add real auth before you need persistent accounts, admin roles, or
   cross-device history.
4. **Privacy claims are deliberately modest.** The UI does not claim the
   conversation is anonymous or confidential in any strong technical sense
   (no end-to-end encryption, server can see plaintext) — see the "Why am I
   seeing this?" copy and `PrivacyControls.jsx`. Don't strengthen this
   language without actually changing the architecture to back it up.
5. **This has not been reviewed by a lawyer, a counsellor, or a workplace
   safety professional.** Do that before anyone relies on it.

## Project structure

```
safeworkplace/
├── backend/
│   ├── server.js                  Express app, routes
│   ├── src/
│   │   ├── orchestrator.js        Ties all agents together
│   │   ├── llmClient.js           Single Anthropic API choke point
│   │   ├── agents/
│   │   │   ├── safetyAgent.js
│   │   │   ├── situationAgent.js
│   │   │   ├── legalAgent.js
│   │   │   ├── actionPlanAgent.js
│   │   │   └── responseComposerAgent.js
│   │   ├── state/
│   │   │   ├── caseState.js       Schema + safe merge (field allow-list)
│   │   │   └── store.js           In-memory session store
│   │   ├── middleware/
│   │   │   ├── validateInput.js
│   │   │   └── promptInjectionGuard.js
│   │   ├── knowledge/
│   │   │   └── legalKnowledgeBase.json
│   │   └── db/
│   │       └── schema.sql         Future Postgres schema (not wired up)
│   └── tests/
│       ├── unit.test.js           11 tests, no API calls, always run
│       └── scenarios.test.js      12 tests mapped to required scenarios
└── frontend/
    └── src/
        ├── App.jsx                Layout, session + panel state
        ├── api.js                 Fetch wrapper for the backend
        └── components/
            ├── ChatWindow.jsx
            ├── MessageBubble.jsx
            ├── TypingIndicator.jsx
            ├── SafetyBanner.jsx
            ├── LegalPanel.jsx
            ├── ActionPlanPanel.jsx
            └── PrivacyControls.jsx
```

## Setup

### Prerequisites

- Node.js 20+
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

### Backend

```bash
cd backend
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY

npm install
npm run dev        # starts on http://localhost:8787
```

### Frontend

```bash
cd frontend
npm install
npm run dev         # starts on http://localhost:5173
```

Open http://localhost:5173. The frontend talks to the backend at
`http://localhost:8787` by default — override with a `VITE_API_BASE` env var
if you deploy them separately.

### Running tests

```bash
cd backend
npm test                                  # 11 unit tests, no API key needed
ANTHROPIC_API_KEY=sk-... npm test         # also runs the 12 scenario tests
```

## Deploying to Vercel

This repo uses Vercel's **Services** model: two services in one project,
served from a single URL. `vercel.json` declares them and routes traffic:

- `frontend` service (root `frontend/`) — serves the committed build in
  `frontend/dist/`. The install/build commands are intentionally skipped
  because `frontend/src` is not part of this repo; to rebuild from source,
  add `frontend/src` back and remove the `installCommand`/`buildCommand`
  overrides.
- `backend` service (root `backend/`) — runs the Express app in
  `server.js`. Vercel detects the `server` entrypoint and the
  `app.listen()` call during startup, then runs it as a Vercel Function
  on Fluid compute.

1. Push to GitHub, then import the repo in Vercel.
2. In **Project → Settings → Build & Deployment → Framework Preset**, set
   the framework to **Services**. (A project only builds as services when
   BOTH this setting is selected AND `vercel.json` contains a `services`
   key.)
3. Add environment variables in **Project → Settings → Environment
   Variables** (applies to the backend service):
   - `GROQ_API_KEY` (or `ANTHROPIC_API_KEY` — the code auto-detects the key
     type and routes to Groq/OpenRouter/Gemini/Anthropic accordingly)
   - `GROQ_MODEL` (optional; default `openai/gpt-oss-20b`)
   - `CORS_ORIGIN` (optional — same-origin requests don't trigger CORS)
4. Deploy. The frontend and all `/api/*` routes are served from the same
   URL (e.g. `https://your-app.vercel.app` and
   `https://your-app.vercel.app/api/health`).

No `PORT` (Vercel manages it) and no `SESSION_SECRET` (unused by the code)
are needed.

## API reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/session` | Start a new private session, returns `sessionId` |
| POST | `/api/chat` | `{ sessionId, message }` → runs the full agent pipeline |
| GET | `/api/case/:sessionId` | Read current structured case state |
| POST | `/api/case/:sessionId/clear` | Reset extracted case details (keeps messages) |
| GET | `/api/conversation/:sessionId/export` | Export full conversation + case state as JSON |
| DELETE | `/api/conversation/:sessionId` | Permanently delete a session |
| GET | `/api/health` | Liveness check |

`/api/chat` response shape:

```json
{
  "sessionId": "…",
  "reply": "…",
  "safety": { "immediate_safety": "none|possible_concern|urgent_concern", "reasoning": "…" },
  "caseState": { "...": "see backend/src/state/caseState.js" },
  "legalInfo": { "status": "confident|low_confidence|no_match", "items": [...], "disclaimer": "…" },
  "actionPlan": [{ "title": "…", "description": "…" }],
  "flags": { "possiblePromptInjection": false }
}
```

## Security notes

- `ANTHROPIC_API_KEY` is read server-side only (`backend/.env`), never sent
  to the frontend.
- CORS is restricted to `CORS_ORIGIN` (comma-separated list).
- `express-rate-limit` caps requests per IP per window (configurable via
  `.env`).
- All chat input goes through `validateChatBody` (length/type checks)
  before touching any agent.
- User text is wrapped in explicit `<user_message>` delimiters
  (`promptInjectionGuard.js`) before being sent to any agent, and flagged
  for logging when it matches common override phrasings. This is
  defense-in-depth, not a guarantee — see `tests/scenarios.test.js` #10 for
  how it's exercised.
- Request logging omits raw message content by design.
- No admin/role-based UI exists yet in this MVP (no admin features to
  protect); add role checks alongside any future admin dashboard.

## Roadmap (Phase 3 → 4, not built here)

- Swap `legalAgent.js`'s tag-matching retrieval for the real pipeline in
  `db/schema.sql`: document parser → chunking → embeddings → pgvector →
  semantic retrieval → confidence thresholds.
- Expand the legal knowledge base beyond POSH (labour law, Standing Orders,
  relevant criminal-law provisions) with each entry independently verified
  against India Code and current notifications.
- Move session/case storage from in-memory to Postgres using the provided
  schema; add scheduled deletion of inactive sessions.
- Add authentication if persistent accounts are needed; add a genuinely
  admin-only surface with role-based access before adding any admin UI.
- Expand automated tests: adversarial prompt-injection corpus, legal-answer
  accuracy review by an actual lawyer, and load/rate-limit testing.
- Accessibility and localization pass (multiple Indian languages).
