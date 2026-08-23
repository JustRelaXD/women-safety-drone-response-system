# Naira App — Safety Response Network

Real-time emergency safety response platform: a FastAPI backend (mock Mongo + Twilio SMS + drone dispatch simulation) and an Expo React Native frontend with a web build.

## Repository layout

```
api/            Vercel serverless entrypoint (loads the FastAPI app)
backend/        FastAPI application (server.py, requirements, seed data)
frontend/       Expo app (iOS / Android / web via react-native-web)
vercel.json     Build + route config for Vercel
```

## Deploy to Vercel

This repo is set up to deploy **both** the API and the web build of the frontend from a single Vercel project:

1. Push the repo to GitHub.
2. In the Vercel dashboard, **Add New → Project → Import** the GitHub repo.
   - Framework preset: leave as **Other** (the `vercel.json` in the repo drives the build).
   - Build/Output settings: leave defaults — `vercel.json` already defines them.
3. Deploy. The API is served at `https://<project>.vercel.app/api/...` (Swagger docs at `/docs`) and the web app at the root.

### Environment variables

Set these in **Project Settings → Environment Variables** (no secrets live in the repo):

| Variable | Required | Notes |
| --- | --- | --- |
| `USE_MOCK_DB` | no | Defaults to `true` → in-memory mock Mongo seeded from `backend/data/naira_db.json`. Set to `false` + `MONGO_URL` to use a real MongoDB. |
| `MONGO_URL` | if `USE_MOCK_DB=false` | e.g. a MongoDB Atlas connection string. |
| `DB_NAME` | no | Database name, defaults to `test_database`. |
| `TWILIO_ACCOUNT_SID` | no | Enables real SMS to trusted contacts. |
| `TWILIO_AUTH_TOKEN` | no | Required for the `/api/twilio/status` callback signature check. |
| `TWILIO_FROM_NUMBER` | no | Sender number (or use `TWILIO_MESSAGING_SERVICE_SID`). |
| `TWILIO_STATUS_CALLBACK_URL` | no | Public URL for Twilio delivery receipts: `https://<project>.vercel.app/api/twilio/status`. |

Without Twilio credentials, emergency dispatch still works end-to-end; contact notifications are recorded as `PENDING_PROVIDER_SETUP`.

### Notes & limitations

- **Persistence:** with the mock DB, state lives in memory per serverless instance and is lost on cold starts; the JSON file is read-only on Vercel. Use a real MongoDB (`USE_MOCK_DB=false`) for durable data.
- **WebSockets:** Vercel serverless functions don't support WebSockets, so `/ws/emergencies/{id}` is unavailable in the hosted deployment (REST polling is used by the frontend).
- **Frontend env:** the web build calls the same origin (`/api`) automatically. For a native build pointing at the hosted API, set `EXPO_PUBLIC_BACKEND_URL=https://<project>.vercel.app`.

## Local development

Backend:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --reload --port 8001
```

Frontend:

```bash
cd frontend
npm install
EXPO_PUBLIC_BACKEND_URL=http://localhost:8001 npm start
```
