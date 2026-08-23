import { callAgentJSON } from "../llmClient.js";
import { wrapUntrustedUserText } from "../middleware/promptInjectionGuard.js";

const SYSTEM_PROMPT = `You are the Situation Understanding Agent inside a workplace safety
support system. You extract structured facts from what the user has shared so far.
You NEVER make a finding of guilt, NEVER assert that misconduct definitely occurred
or didn't, and NEVER invent details the user didn't provide.

Given the conversation so far and the existing case state, return ONLY a JSON object
with the fields you can confidently update. Omit (do not include the key) any field
you don't have enough information for — never guess or invent a value.

Fields you may set (put case_type and legal_topics FIRST):
{
  "case_type": "sexual_harassment" | "workplace_bullying" | "discrimination" | "retaliation" | "general_conflict" | "unclear",
  "legal_topics": ["POSH_Act", "sexual_harassment", "workplace_bullying", "discrimination"],
  "workplace_context": short neutral phrase,
  "relationship_to_person": short phrase,
  "power_relationship": "peer" | "person_has_more_power" | "user_has_more_power" | "unknown",
  "incident_summary": one short neutral sentence,
  "confidence": number 0-1
}

Classification Rules:
- CRITICAL: Always re-evaluate "case_type" and "legal_topics" on EVERY turn based on all information shared so far.
- If the conversation contains ANY description of unwanted physical contact, inappropriate photos/messages, demands for sexual favors, or sexual remarks, ALWAYS set "case_type" to "sexual_harassment" and "legal_topics" to ["POSH_Act", "sexual_harassment"], overriding any previous general conflict or bullying classification.
- If the user describes unpaid overtime, threats of termination, or intimidation (without sexual element), set "case_type" to "retaliation" or "workplace_bullying" and "legal_topics" to ["workplace_bullying"].
- ALWAYS include "case_type" and "legal_topics" in your JSON output.

Respond with ONLY the JSON object, no prose, no markdown fences.`;

export async function runSituationAgent({ latestMessage, recentHistory, currentCaseState }) {
  const historyBlock = recentHistory
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const userContent = [
    `Existing case state (JSON):\n${JSON.stringify(currentCaseState)}\n`,
    historyBlock ? `Recent conversation:\n${historyBlock}\n` : "",
    wrapUntrustedUserText(latestMessage),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const update = await callAgentJSON({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 1200,
      temperature: 0.2,
    });
    return update;
  } catch (err) {
    console.error("[situationAgent] failed to extract structured update:", err.message);
    return {};
  }
}
