import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSafetyRoutes } from './safety-command.js';

const { Pool } = pg;

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, 'dist');
const staticDir = path.join(__dirname, 'public');

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

const getPool = () => {
  if (!pool) {
    const error = new Error('DATABASE_URL is not configured');
    error.status = 503;
    throw error;
  }
  return pool;
};

app.use(express.json({ limit: '5mb' }));
app.use(express.static(clientDir));
app.use(express.static(staticDir));

registerSafetyRoutes(app, getPool);

// Planner runtime config: the public tunnel URL (and optional API key) live
// in server-side env vars so the frontend can pick them up at runtime via
// configurePlanner() without rebuilding the bundle.  `netbird expose` URLs
// rotate whenever the tunnel process restarts, so update PLANNER_API_URL on
// the platform + redeploy instead of touching the frontend build.
app.get('/api/planner-config', (_req, res) => {
  res.json({
    url: process.env.PLANNER_API_URL || '',
    key: process.env.PLANNER_API_KEY || ''
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Unexpected server error' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'), (error) => {
    if (error) res.sendFile(path.join(staticDir, 'index.html'));
  });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`SOS dashboard API running at http://localhost:${port}`);
  });
}

export default app;
