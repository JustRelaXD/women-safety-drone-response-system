// Vercel serverless entry: the same Express app that runs locally (node
// server.js) is exported here as the /api function.  server.js skips
// app.listen() when process.env.VERCEL is set, and Vercel routes every
// request through this exported handler - so only /api/* paths reach it
// (the vercel.json rewrite excludes /api and sends everything else to the
// static index.html).
import app from '../server.js';

export default app;
