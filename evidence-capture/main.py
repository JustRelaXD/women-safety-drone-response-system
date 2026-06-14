from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from hasher import generate_hash
from uploader import upload_file
import json

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

evidence_log = []

@app.post("/evidence/upload")
async def upload_evidence(
    video: UploadFile = File(None),
    audio: UploadFile = File(None),
    gps_data: str = Form(None),
    incident_id: str = Form(...)
):
    timestamp = datetime.utcnow().isoformat()
    result = {
        "incident_id": incident_id,
        "timestamp": timestamp,
        "files": []
    }

    folder = f"naira/incidents/{incident_id}"

    if video:
        video_bytes = await video.read()
        video_hash = generate_hash(video_bytes)
        video_url = upload_file(video_bytes, f"video_{timestamp}", folder)
        result["files"].append({
            "type": "video",
            "url": video_url,
            "hash": video_hash,
            "timestamp": timestamp
        })

    if audio:
        audio_bytes = await audio.read()
        audio_hash = generate_hash(audio_bytes)
        audio_url = upload_file(audio_bytes, f"audio_{timestamp}", folder)
        result["files"].append({
            "type": "audio",
            "url": audio_url,
            "hash": audio_hash,
            "timestamp": timestamp
        })

    if gps_data:
        result["gps_trail"] = json.loads(gps_data)

    evidence_log.append(result)
    return result


@app.get("/evidence/{incident_id}")
async def get_evidence(incident_id: str):
    records = [e for e in evidence_log if e["incident_id"] == incident_id]
    return {"incident_id": incident_id, "evidence": records}


@app.get("/")
async def health():
    return {"status": "Evidence capture API running"}