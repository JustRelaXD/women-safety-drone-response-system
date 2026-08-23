# Women Safety — Threat Detection (CV)

Real-time, multi-modal threat detection pipeline for women's safety. A webcam
feed is analyzed by six independent detectors; a fusion engine combines them
into a single alert level (with debounce and cross-modal corroboration) and
pushes critical alerts to a LAN dashboard over WebSockets, while an MJPEG
stream shows the live feed with an annotated HUD.

## Detectors (6 signals)

| Signal | Module | How |
| --- | --- | --- |
| Fall | `fall_detection.py` | MediaPipe pose landmarks, per person |
| Running | `running_detection.py` | YOLO bbox dynamics, per person |
| Chase | `chase_detection.py` | Pairwise proximity + motion vectors |
| Violence | `violence_detection.py` | Pose heuristic: close pair + fast repeated wrist motion |
| Audio distress | `audio_service.py` | YAMNet sound events (screaming, crying, shouting) |
| Keyword distress | `distress_keywords.py` | faster-whisper transcription matched against distress keywords |

`fusion_engine.py` weights each signal, adds a cross-modal corroboration bonus,
and debounces asymmetrically (escalates fast, de-escalates slowly) into a
single alert level — because for a safety system, a missed real event is worse
than a lingering alert.

## Architecture

```
audio_service.py ── writes shared_state.json (atomic tmp+rename) ──┐
                                                                    ▼
camera → unified_detection.py (YOLO + MediaPipe pose + violence) → fusion_engine.py → alert level
     │                                                                  │
     └── mjpeg_stream.py (port 8000)  <img src="http://<ip>:8000/stream">
     └── alert_push.py   (port 8765)  WebSocket JSON push to dashboard
     └── output_layer.py              saves critical clips to alert_clips/
```

The audio service and the vision pipeline run as **separate processes** and
communicate only through `shared_state.json` (with a 5-second staleness guard).

## Setup — two environments (important)

The vision env and audio env **must stay separate**: mediapipe pins
`protobuf<5` while tensorflow (for YAMNet) needs `protobuf>=7`.

```bash
# Vision env (main pipeline)
python -m venv venv_vision
venv_vision/bin/pip install -r requirements-vision.txt

# Audio env (YAMNet + Whisper)
python -m venv venv_audio
venv_audio/bin/pip install -r requirements-audio.txt
```

Models are included: `yolov8n.pt` and `pose_landmarker.task`. YAMNet is
downloaded from tfhub on first run of the audio service.

## Run

Terminal 1 — audio service:

```bash
venv_audio/bin/python audio_service.py
```

Terminal 2 — main pipeline (opens the camera window):

```bash
venv_vision/bin/python unified_detection.py
```

- MJPEG live feed: `http://<this-machine-lan-ip>:8000/stream`
- Saved critical clips: `http://<this-machine-lan-ip>:8000/clips/<filename>`
- WebSocket alert pushes on port 8765 (JSON, pushed on level changes)
- Press `q` in the OpenCV window to quit

`alert_clips/` is created next to the script and critical events are saved
there as mp4s. The dashboard can be any browser page that opens the MJPEG
stream and a WebSocket to port 8765.
