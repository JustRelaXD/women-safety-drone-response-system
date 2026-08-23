import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = path.join(__dirname, "..", "knowledge", "legalKnowledgeBase.json");

let kbCache = null;
async function loadKB() {
  if (!kbCache) {
    const raw = await readFile(KB_PATH, "utf-8");
    kbCache = JSON.parse(raw).entries;
  }
  return kbCache;
}

const CASE_TYPE_TO_TAGS = {
  sexual_harassment: ["POSH_Act", "sexual_harassment"],
  workplace_bullying: ["workplace_bullying"],
  discrimination: ["discrimination"],
  retaliation: ["workplace_bullying", "discrimination"],
  general_conflict: ["general_conflict"],
};

const MIN_CONFIDENT_MATCHES = 1;

/**
 * Pure keyword/tag retrieval over the curated knowledge base.
 *
 * IMPORTANT: this function is a stand-in for the full RAG pipeline
 * (parser -> chunking -> embeddings -> vector DB -> semantic retrieval)
 * described in README.md. It is intentionally simple and auditable for
 * the MVP. Every returned entry is used verbatim (source, section, plain
 * language summary) — nothing here asks an LLM to invent legal content.
 */
export async function retrieveLegalInfo({ legalTopics = [], caseType }) {
  const kb = await loadKB();
  const wantedTags = new Set([
    ...legalTopics,
    ...(caseType && CASE_TYPE_TO_TAGS[caseType] ? CASE_TYPE_TO_TAGS[caseType] : []),
  ]);

  if (wantedTags.size === 0) {
    return { status: "no_query", matches: [] };
  }

  const scored = kb
    .map((entry) => {
      const overlap = entry.topic_tags.filter((tag) => wantedTags.has(tag)).length;
      return { entry, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  const highConfidenceMatches = scored.filter(
    (s) => s.entry.confidence === "high"
  );

  if (highConfidenceMatches.length >= MIN_CONFIDENT_MATCHES) {
    return {
      status: "confident",
      matches: highConfidenceMatches.slice(0, 4).map((s) => s.entry),
    };
  }

  if (scored.length > 0) {
    // Only low-confidence / general orientation notes matched.
    return {
      status: "low_confidence",
      matches: scored.slice(0, 2).map((s) => s.entry),
    };
  }

  return { status: "no_match", matches: [] };
}

export function formatLegalResponse(retrieval) {
  const disclaimer =
    "This is general legal information, not individualized legal advice, and it is not guaranteed to be complete or fully up to date. For anything specific to your situation, please consult a qualified lawyer.";

  if (retrieval.status === "no_query") {
    return null; // nothing to show yet — orchestrator hasn't asked for legal info
  }

  if (retrieval.status === "no_match") {
    return {
      status: "no_match",
      message:
        "I don't have a confident, sourced answer for this specific question in my current legal knowledge base, so I don't want to guess. A labour lawyer or your nearest legal aid service would be able to give you a reliable answer here.",
      items: [],
      disclaimer,
    };
  }

  const items = retrieval.matches.map((entry) => ({
    law: entry.law,
    section: entry.section,
    explanation: entry.plain_language_summary,
    source: entry.source_title,
    source_url: entry.source_url,
    source_date: entry.source_date,
    confidence: entry.confidence,
  }));

  if (retrieval.status === "low_confidence") {
    return {
      status: "low_confidence",
      message:
        "I can share a general orientation note, but I don't have a confident, section-level answer for this — please treat it as a starting point, not a final answer.",
      items,
      disclaimer,
    };
  }

  return {
    status: "confident",
    message: null,
    items,
    disclaimer,
  };
}
