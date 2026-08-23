import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";

import { validateChatBody, validateSessionParam } from "./src/middleware/validateInput.js";
import {
  getOrCreateSession,
  getSession,
  deleteSession,
  exportSession,
  clearCaseState,
  touchSession,
} from "./src/state/store.js";
import { runOrchestrator } from "./src/orchestrator.js";

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN || "http://localhost:5173").split(","),
    credentials: false,
  })
);
app.use(express.json({ limit: "64kb" }));

// Basic logging that deliberately omits raw message content — see README's
// privacy section for why. Only metadata is logged.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      })
    );
  });
  next();
});

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});
app.use("/api/", limiter);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Starts (or resumes) a private session. No auth required for the MVP —
// sessions are opaque, unlinkable IDs. See README for the auth roadmap if
// you need persistent accounts.
app.post("/api/session", (req, res) => {
  const sessionId = nanoid(24);
  getOrCreateSession(sessionId);
  res.json({ sessionId });
});

app.post("/api/chat", validateChatBody, async (req, res) => {
  try {
    const sessionId = req.body.sessionId || nanoid(24);
    const session = getOrCreateSession(sessionId);
    touchSession(sessionId);

    const message = req.body.message.trim();
    session.messages.push({ role: "user", content: message, at: new Date().toISOString() });

    const result = await runOrchestrator({ session, latestMessage: message });

    session.messages.push({
      role: "assistant",
      content: result.reply,
      at: new Date().toISOString(),
    });

    res.json({
      sessionId,
      reply: result.reply,
      safety: result.safety,
      caseState: result.caseState,
      legalInfo: result.legalInfo,
      actionPlan: result.actionPlan,
      flags: result.flags,
    });
  } catch (err) {
    console.error("[/api/chat] error:", err);
    res.status(500).json({
      error:
        "Something went wrong on our end. Your message wasn't lost — you can try sending it again.",
    });
  }
});

app.get("/api/case/:sessionId", validateSessionParam, (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "session not found" });
  res.json({ caseState: session.caseState });
});

app.get("/api/conversation/:sessionId/export", validateSessionParam, (req, res) => {
  const data = exportSession(req.params.sessionId);
  if (!data) return res.status(404).json({ error: "session not found" });
  res.json(data);
});

app.delete("/api/conversation/:sessionId", validateSessionParam, (req, res) => {
  const existed = deleteSession(req.params.sessionId);
  if (!existed) return res.status(404).json({ error: "session not found" });
  res.json({ deleted: true });
});

app.post("/api/case/:sessionId/clear", validateSessionParam, (req, res) => {
  const cleared = clearCaseState(req.params.sessionId);
  if (!cleared) return res.status(404).json({ error: "session not found" });
  res.json({ caseState: cleared });
});

app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

// Vercel detects the `server` entrypoint and the app.listen() call during
// module startup, then routes requests to it as a Vercel Function. The port
// here is only used when running locally.
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`SafeWorkplace backend listening on http://localhost:${PORT}`);
});
