import { callAgentJSON } from "../llmClient.js";
import { wrapUntrustedUserText } from "../middleware/promptInjectionGuard.js";

const SYSTEM_PROMPT = `You are the Action Planning Agent inside a workplace safety support system.
Your goal is to analyze the user's specific situation and input, and produce 3-5 concrete next steps tailored EXACTLY to what they described.

Rules:
- Thoroughly analyze the user's latest input and case state.
- Tailor every single option to their specific situation (e.g., if unpaid overtime/threats -> steps on shift logs and written records; if unwanted touching/messages -> steps on securing messages and Internal Committee filing; if general issue -> steps on documenting and finding an ally).
- Never tell the user what they must do. Offer options, not directives.
- Keep each option title short (3-6 words) and concrete description (1-2 sentences).
- If immediate_safety is "urgent_concern", the FIRST option must be about immediate physical safety (getting to safety or contacting emergency services/112).

Respond with ONLY a JSON array of objects, no prose, no markdown fences:
[{ "title": "short title", "description": "1-2 concrete sentences tailored to situation" }, ...]`;

export async function runActionPlanAgent({ caseState, latestMessage = "", recentHistory = [] }) {
  const historyBlock = recentHistory
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const userContent = [
    `Case state (JSON):\n${JSON.stringify(caseState, null, 2)}`,
    historyBlock ? `Recent conversation:\n${historyBlock}` : "",
    latestMessage ? wrapUntrustedUserText(latestMessage) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const options = await callAgentJSON({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 800,
      temperature: 0.4,
    });
    if (!Array.isArray(options) || options.length === 0) throw new Error("expected non-empty array");
    return options;
  } catch (err) {
    console.error("[actionPlanAgent] falling back to generic options:", err.message);
    return [
      {
        title: "Write down what happened",
        description:
          "Note dates, what was said or done, and who was around, while it's fresh — this can help later even if you're not sure you'll act on it.",
      },
      {
        title: "Identify one person you trust",
        description:
          "That could be a friend, family member, or colleague — someone you can talk this through with outside the situation.",
      },
      {
        title: "Look into your options when you're ready",
        description:
          "That might include your organisation's HR or Internal Committee, or speaking with a lawyer — no need to decide anything right now.",
      },
    ];
  }
}
