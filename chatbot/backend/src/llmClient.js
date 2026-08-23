import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

function getApiKey() {
  return (
    process.env.GROQ_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    ""
  ).trim();
}

async function callGroq({ system, messages, maxTokens = 1024, temperature = 0.4, apiKey }) {
  const modelName = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  const formattedMessages = [];
  if (system) formattedMessages.push({ role: "system", content: system });
  for (const m of messages) formattedMessages.push({ role: m.role, content: m.content });

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: formattedMessages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    if (res.status === 429 && attempt < 4) {
      const waitMs = (attempt + 1) * 1500;
      console.warn(`[callGroq] rate limit 429 hit, retrying in ${waitMs}ms (attempt ${attempt + 1}/5)...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Groq API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }
}

async function callOpenRouter({ system, messages, maxTokens = 1024, temperature = 0.4, apiKey }) {
  const modelName = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
  const formattedMessages = [];
  if (system) formattedMessages.push({ role: "system", content: system });
  for (const m of messages) formattedMessages.push({ role: m.role, content: m.content });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      messages: formattedMessages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callGemini({ system, messages, maxTokens = 1024, temperature = 0.4, apiKey }) {
  const modelName = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const promptText = messages.map((m) => m.content).join("\n\n");

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: promptText }],
      },
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  if (system) {
    payload.system_instruction = {
      parts: [{ text: system }],
    };
  }

  let res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 404 || errText.includes("NOT_FOUND")) {
      const fallbackRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!fallbackRes.ok) {
        const fallbackErr = await fallbackRes.text();
        throw new Error(`Gemini API error (${fallbackRes.status}): ${fallbackErr}`);
      }
      const fallbackData = await fallbackRes.json();
      return fallbackData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

/**
 * Calls the appropriate model provider based on API key prefix or env var.
 * Supports: Groq (gsk_...), OpenRouter (sk-or-v1-...), Google Gemini (AIzaSy...), Anthropic (sk-ant-...)
 */
export async function callAgent({ system, messages, maxTokens = 1024, temperature = 0.4 }) {
  const apiKey = getApiKey();

  if (
    !apiKey ||
    apiKey.includes("xxxxxxxx") ||
    apiKey.includes("your_anthropic_api_key_here") ||
    apiKey.includes("your_gemini_api_key_here") ||
    apiKey.includes("your_groq_api_key_here")
  ) {
    throw new Error(
      "No valid API key configured in backend/.env. Please paste your key into backend/.env."
    );
  }

  let resultText = "";
  if (apiKey.startsWith("gsk_") || Boolean(process.env.GROQ_API_KEY)) {
    resultText = await callGroq({ system, messages, maxTokens, temperature, apiKey });
  } else if (apiKey.startsWith("sk-or-v1-") || Boolean(process.env.OPENROUTER_API_KEY)) {
    resultText = await callOpenRouter({ system, messages, maxTokens, temperature, apiKey });
  } else if (
    apiKey.startsWith("AIza") ||
    apiKey.startsWith("AQ.") ||
    Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
  ) {
    resultText = await callGemini({ system, messages, maxTokens, temperature, apiKey });
  } else {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    resultText = textBlock ? textBlock.text : "";
  }

  let clean = resultText.replace(/<think>[\s\S]*?<\/think>/gi, "");
  clean = clean.replace(/<think>[\s\S]*/gi, "").trim();
  return clean;
}

/**
 * Calls the model and expects strictly-JSON output.
 */
export async function callAgentJSON(args) {
  const raw = await callAgent(args);
  const cleaned = raw
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (inner) {}
    }
    // Salvage truncated JSON by closing open object
    const openBraceIndex = raw.indexOf("{");
    if (openBraceIndex !== -1) {
      let partial = raw.substring(openBraceIndex);
      // Remove trailing partial key/value
      partial = partial.replace(/,\s*"[^"]*"?\s*:\s*[^,}]*$/, "");
      partial = partial.replace(/,\s*$/, "");
      if (!partial.endsWith("}")) partial += "}";
      try {
        return JSON.parse(partial);
      } catch (repairErr) {}
    }
    throw e;
  }
}
