import { emptyCaseState } from "./caseState.js";

/**
 * In-memory store for Phase 1/2 MVP.
 *
 * This is deliberately simple and NOT durable — restarting the server
 * clears all sessions. For a production deployment, replace this module
 * with a Postgres-backed implementation using db/schema.sql, keeping the
 * same function signatures so nothing else has to change.
 *
 * Sessions expire after INACTIVITY_MS of no activity so nothing lingers
 * in memory indefinitely.
 */
const INACTIVITY_MS = 1000 * 60 * 60 * 2; // 2 hours

const sessions = new Map(); // sessionId -> { messages, caseState, createdAt, lastActiveAt }

function sweepExpired() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActiveAt > INACTIVITY_MS) {
      sessions.delete(id);
    }
  }
}
setInterval(sweepExpired, 1000 * 60 * 10).unref();

export function createSession(sessionId) {
  const session = {
    messages: [], // [{ role: "user"|"assistant", content: string, at: ISOString }]
    caseState: emptyCaseState(),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId) {
  return sessions.get(sessionId) ?? null;
}

export function getOrCreateSession(sessionId) {
  return getSession(sessionId) ?? createSession(sessionId);
}

export function touchSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.lastActiveAt = Date.now();
}

export function deleteSession(sessionId) {
  return sessions.delete(sessionId);
}

export function exportSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return {
    createdAt: new Date(session.createdAt).toISOString(),
    messages: session.messages,
    caseState: session.caseState,
  };
}

export function clearCaseState(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.caseState = emptyCaseState();
  return session.caseState;
}
