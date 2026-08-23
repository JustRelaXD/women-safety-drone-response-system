/**
 * The structured "case state" tracked per conversation, separate from the
 * raw chat transcript. This is intentionally minimal — see PRIVACY.md /
 * README for why we avoid collecting direct identifiers.
 */
export function emptyCaseState() {
  return {
    case_type: null, // e.g. "sexual_harassment", "workplace_bullying", "discrimination", "general_conflict"
    workplace_context: null, // e.g. "private_company", "government", "factory", "startup" — never employer name
    relationship_to_person: null, // e.g. "manager", "coworker", "client", "senior_leadership"
    power_relationship: null, // "peer" | "person_has_more_power" | "user_has_more_power" | "unknown"
    incident_summary: null, // short, user-authored or user-approved summary — not verbatim raw transcript
    timeline: [], // [{ approx_date: string|null, description: string }]
    evidence_mentioned: [], // e.g. ["emails", "screenshots"] — never the content itself
    witnesses_mentioned: [], // boolean-ish flags/counts, not names
    immediate_safety: "unknown", // "none" | "possible_concern" | "urgent_concern" | "unknown"
    user_goal: null, // e.g. "understand_options", "file_complaint", "just_talk", "unsure"
    legal_topics: [], // topics matched against the curated legal knowledge base
    action_plan: [], // steps offered to the user, user retains control
    confidence: 0, // 0-1, orchestrator's confidence in the situation classification
    updated_at: null,
  };
}

/**
 * Shallow-merges a partial update into existing case state, only accepting
 * known keys so a prompt-injected "update" can't smuggle arbitrary fields in.
 */
const ALLOWED_KEYS = new Set(Object.keys(emptyCaseState()));

export function mergeCaseState(current, partialUpdate = {}) {
  const next = { ...current };
  for (const [key, value] of Object.entries(partialUpdate)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    next[key] = value;
  }
  next.updated_at = new Date().toISOString();
  return next;
}
