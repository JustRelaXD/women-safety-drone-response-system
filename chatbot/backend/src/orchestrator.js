import { mergeCaseState } from "./state/caseState.js";
import { runSafetyAgent } from "./agents/safetyAgent.js";
import { runSituationAgent } from "./agents/situationAgent.js";
import { retrieveLegalInfo, formatLegalResponse } from "./agents/legalAgent.js";
import { runActionPlanAgent } from "./agents/actionPlanAgent.js";
import { composeResponse } from "./agents/responseComposerAgent.js";
import { flagPromptInjection } from "./middleware/promptInjectionGuard.js";

const LEGAL_KEYWORDS =
  /\b(law|laws|legal|section|posh|rights|file a complaint|complaint process|internal committee|court|police|fir|lawyer)\b/i;

function recentHistory(messages, n = 8) {
  return messages.slice(-n);
}

/**
 * Runs one full turn of the orchestrated pipeline:
 * LISTEN -> UNDERSTAND -> CHECK SAFETY -> (CLARIFY / SUPPORT) ->
 * RETRIEVE LAW (if appropriate) -> EXPLAIN OPTIONS -> ACTION PLAN
 */
export async function runOrchestrator({ session, latestMessage }) {
  const injectionFlagged = flagPromptInjection(latestMessage);
  if (injectionFlagged) {
    console.warn("[orchestrator] message flagged as possible prompt injection attempt");
  }

  const history = recentHistory(session.messages);

  // Run classifiers sequentially with small delays to stay within free-tier API rate limits
  const safety = await runSafetyAgent({ latestMessage, recentHistory: history });
  await new Promise((r) => setTimeout(r, 500));
  
  const situationUpdate = await runSituationAgent({
    latestMessage,
    recentHistory: history,
    currentCaseState: session.caseState,
  });
  await new Promise((r) => setTimeout(r, 500));

  session.caseState = mergeCaseState(session.caseState, situationUpdate);
  session.caseState.immediate_safety = safety.immediate_safety;

  const turnCount = session.messages.filter((m) => m.role === "user").length;
  const userAskedLegalDirectly = LEGAL_KEYWORDS.test(latestMessage);
  const hasCaseType = Boolean(session.caseState.case_type) && session.caseState.case_type !== "unclear";
  const hasLegalTopics = Boolean(session.caseState.legal_topics?.length);
  
  // Always surface legal info and action plan after every chat turn
  const askLegalNow = true;
  const askActionPlanNow = true;

  const topics = session.caseState.legal_topics?.length ? session.caseState.legal_topics : ["POSH_Act", "workplace_bullying"];
  const caseType = session.caseState.case_type && session.caseState.case_type !== "unclear" ? session.caseState.case_type : "sexual_harassment";

  const retrieval = await retrieveLegalInfo({
    legalTopics: topics,
    caseType: caseType,
  });
  const legalInfo = formatLegalResponse(retrieval);
  if (legalInfo) {
    session.caseState.legal_topics = Array.from(
      new Set([...(session.caseState.legal_topics || []), ...topics])
    );
  }

  const actionPlan = await runActionPlanAgent({
    caseState: session.caseState,
    latestMessage,
    recentHistory: history,
  });
  session.caseState.action_plan = actionPlan;

  const replyText = await composeResponse({
    latestMessage,
    recentHistory: history,
    caseState: session.caseState,
    safety,
    legalInfo,
    actionPlan,
    askLegalNow,
    askActionPlanNow,
  });

  return {
    reply: replyText,
    safety,
    caseState: session.caseState,
    legalInfo,
    actionPlan,
    flags: { possiblePromptInjection: injectionFlagged },
  };
}
