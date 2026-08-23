const MAX_MESSAGE_LENGTH = 4000;

export function validateChatBody(req, res, next) {
  const { message, sessionId } = req.body ?? {};

  if (typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "message must be a non-empty string" });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res
      .status(400)
      .json({ error: `message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` });
  }
  if (sessionId !== undefined && typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId must be a string" });
  }
  next();
}

export function validateSessionParam(req, res, next) {
  const { sessionId } = req.params;
  if (!sessionId || typeof sessionId !== "string" || sessionId.length > 128) {
    return res.status(400).json({ error: "invalid sessionId" });
  }
  next();
}
