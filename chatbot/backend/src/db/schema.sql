-- Future durable storage schema (Postgres).
-- NOT used by the MVP, which intentionally keeps everything in-memory
-- (src/state/store.js) to minimize what's persisted while the product is
-- being validated. Wire this up when you need durability across restarts,
-- multi-instance deployment, or the export/delete features to survive a
-- server restart.
--
-- Design principles carried over from src/state/caseState.js:
--   * No direct identifiers (names, employer names, phone numbers) in
--     structured fields.
--   * Raw message content is kept separate from derived case_state so it
--     can be deleted independently and more aggressively.
--   * Every row is scoped to an opaque session_id, never a real user
--     identity, unless you add a separate authenticated-accounts feature.

CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set only if you add authenticated accounts later; NULL for anonymous.
  account_id      TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

CREATE TABLE IF NOT EXISTS case_states (
  session_id              TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  case_type               TEXT,
  workplace_context       TEXT,
  relationship_to_person  TEXT,
  power_relationship      TEXT,
  incident_summary        TEXT,
  timeline                JSONB NOT NULL DEFAULT '[]',
  evidence_mentioned      JSONB NOT NULL DEFAULT '[]',
  witnesses_mentioned     JSONB NOT NULL DEFAULT '[]',
  immediate_safety        TEXT NOT NULL DEFAULT 'unknown',
  user_goal               TEXT,
  legal_topics            JSONB NOT NULL DEFAULT '[]',
  action_plan             JSONB NOT NULL DEFAULT '[]',
  confidence               REAL NOT NULL DEFAULT 0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 3: legal knowledge base + RAG pipeline tables.
-- These back the full "documents -> parser -> chunking -> embeddings ->
-- vector DB -> semantic retrieval" pipeline described in README.md. The
-- MVP instead reads a small curated JSON file (src/knowledge/legalKnowledgeBase.json).
CREATE TABLE IF NOT EXISTS legal_documents (
  id               BIGSERIAL PRIMARY KEY,
  source_title     TEXT NOT NULL,
  authority        TEXT NOT NULL,
  source_url       TEXT,
  source_date      DATE,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_text         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legal_chunks (
  id                BIGSERIAL PRIMARY KEY,
  document_id       BIGINT NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
  section           TEXT,
  chunk_text        TEXT NOT NULL,
  topic_tags        JSONB NOT NULL DEFAULT '[]',
  -- embedding VECTOR(1536)  -- enable with the pgvector extension
  confidence_note   TEXT
);
CREATE INDEX IF NOT EXISTS idx_legal_chunks_document_id ON legal_chunks(document_id);

-- Audit log deliberately excludes raw message content — see README privacy
-- section. Only metadata needed for debugging/abuse monitoring.
CREATE TABLE IF NOT EXISTS request_log (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT,
  route         TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  flagged_injection BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
