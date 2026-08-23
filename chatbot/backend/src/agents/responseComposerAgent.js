import { callAgent } from "../llmClient.js";
import { wrapUntrustedUserText } from "../middleware/promptInjectionGuard.js";

/**
 * This agent writes the actual chat reply the user sees. It is given the
 * outputs of the other agents (safety classification, case state, legal
 * matches, action plan options) as CONTEXT, but it does not invent legal
 * facts itself — it only summarizes/frames the legal items it's handed.
 */
const SYSTEM_PROMPT = `You are a warm, deeply empathetic, and natural human listener for a private workplace safety support chat aimed at people in India dealing with workplace harassment, abuse, coercion, intimidation, or discrimination.

- PROPER SITUATION ANALYSIS & RESPONSE: Explicitly acknowledge and reflect the specific details of what they described (e.g. manager's comments, late-night messages, physical closeness, unpaid overtime, threats, or isolation). Show them clearly that their exact words have been analyzed, understood, and validated.
- SOUND HUMAN, WARM, AND NATURAL. Speak like a compassionate, gentle counsellor (like Dr. Meera) sitting across from them.
- NEVER use rigid or robotic headers such as "**Listening**", "**Safety & Well-being**", "**Things to consider**", or "**General legal note**".
- Write in warm, conversational, flowing paragraphs with soft line breaks.
- Validate their experience deeply ("If something made you uncomfortable, it is worth talking about. You shouldn't have had to change your behavior or walk on eggshells just to feel safe at your job. What happened is not your fault.").
- Avoid corporate platitudes, robotic bullet lists, or stiff academic disclaimers in the main chat response.
- Gently weave in support and options in natural prose. (Detailed legal citations and step-by-step checklists are automatically displayed in the side panels for them).
- Never victim-blame, minimize, or assume unstated facts.
- Never claim to be a licensed counsellor, lawyer, police officer, or emergency service — you are a compassionate support tool walking alongside them.`;

export async function composeResponse({
  latestMessage,
  recentHistory,
  caseState,
  safety,
  legalInfo, // formatted object from legalAgent.formatLegalResponse, or null
  actionPlan, // array or null
  askLegalNow, // boolean — whether it's appropriate to surface legal_info this turn
  askActionPlanNow, // boolean
}) {
  const historyBlock = recentHistory
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const contextBlock = [
    `case_state (JSON): ${JSON.stringify(caseState)}`,
    `urgent_safety_concern: ${safety.immediate_safety === "urgent_concern"}`,
    `possible_safety_concern: ${safety.immediate_safety === "possible_concern"}`,
    askLegalNow && legalInfo
      ? `legal_info (JSON, use verbatim facts only): ${JSON.stringify(legalInfo)}`
      : "legal_info: not applicable this turn",
    askActionPlanNow && actionPlan
      ? `action_plan (JSON): ${JSON.stringify(actionPlan)}`
      : "action_plan: not applicable this turn",
  ].join("\n\n");

  const userContent = [
    historyBlock ? `Recent conversation:\n${historyBlock}\n` : "",
    `Context for this turn:\n${contextBlock}\n`,
    wrapUntrustedUserText(latestMessage),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const reply = await callAgent({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 900,
      temperature: 0.6,
    });

    return reply.trim();
  } catch (err) {
    console.error("[responseComposerAgent] error generating response:", err.message);
    
    if (err.message.includes("403") || err.message.includes("PERMISSION_DENIED")) {
      return "⚠️ Key Error (403 Permission Denied): The API key in backend/.env was denied by Google. Please generate a new free key starting with 'AIzaSy...' at https://aistudio.google.com and update your backend/.env file.";
    }
    if (err.message.includes("401") || err.message.includes("authentication_error") || err.message.includes("API key")) {
      return "⚠️ Key Error: Please set a valid GEMINI_API_KEY (starts with AIzaSy...) or ANTHROPIC_API_KEY in backend/.env.";
    }
    return "Thank you for sharing that with me. I am here to listen and support you. Please take your time and tell me a bit more about what you are going through.";
  }
}
