from ultralytics import YOLO
import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
from collections import defaultdict, deque
from itertools import combinations
import time
import json
import time as time_module  # avoid clashing with your existing `time` import
from violence_detection import ViolenceDetector
from fusion_engine import FusionEngine, AlertLevel, LEVEL_COLOR
from output_layer import OutputManager
from mjpeg_stream import MJPEGStreamer
from alert_push import AlertPushServer
import socket


def get_lan_ip():
    """Best-effort LAN IP detection — doesn't send data anywhere, just
    asks the OS which interface would be used to reach the internet,
    so we don't have to hardcode/hunt for the IP manually."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def read_audio_state():
    try:
        with open("shared_state.json") as f:
            data = json.load(f)
        if time_module.time() - data.get("timestamp", 0) > 5:
            return {"audio_alert": False, "audio_top_sound": "", "audio_score": 0.0,
                    "yamnet_alert": False, "yamnet_category": "",
                    "keyword_alert": False, "keyword_text": ""}
        # add the keys fusion_engine.py expects, mapped from your actual field names
        data["yamnet_alert"] = data.get("audio_alert", False)
        data["yamnet_category"] = data.get("audio_top_sound", "")
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return {"audio_alert": False, "audio_top_sound": "", "audio_score": 0.0,
                "yamnet_alert": False, "yamnet_category": "",
                "keyword_alert": False, "keyword_text": ""}

# ---------- Setup: YOLO ----------
yolo_model = YOLO("yolov8n.pt")

# ---------- Setup: MediaPipe Pose ----------
mp_pose_connections = mp.solutions.pose.POSE_CONNECTIONS
base_options = python.BaseOptions(model_asset_path='pose_landmarker.task')
pose_options = vision.PoseLandmarkerOptions(
    base_options=base_options,
    running_mode=vision.RunningMode.VIDEO
)
landmarker = vision.PoseLandmarker.create_from_options(pose_options)
violence_detector = ViolenceDetector()
fusion = FusionEngine()

LAN_IP = get_lan_ip()
print(f"[unified_detection] LAN IP detected: {LAN_IP}")

CLIPS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "alert_clips")
os.makedirs(CLIPS_DIR, exist_ok=True)

mjpeg = MJPEGStreamer(http_port=8000, clips_dir=CLIPS_DIR)
alert_push = AlertPushServer(ws_port=8765)


def on_clip_ready(filename, reason):
    alert_push.notify_clip_ready(filename, reason, clip_base_url=f"http://{LAN_IP}:8000")


output_manager = OutputManager(
    fps=8,   # your measured rate from the FPS CHECK test
    output_dir=CLIPS_DIR,
    on_clip_saved=on_clip_ready,
)

# ---------- Shared state ----------
position_history = defaultdict(lambda: deque(maxlen=15))
pair_distance_history = defaultdict(lambda: deque(maxlen=15))
box_history = defaultdict(lambda: deque(maxlen=15))   # (t, box_width, box_height, y_center) per YOLO track id
gap_history = deque(maxlen=15)  # ~15 frames at 30fps ≈ 0.5 sec window
fall_alert_active = False       # pose-based fall flag
fall_alert_time = None
box_fall_ids = set()            # bbox-based fall flag, per track id, this frame

# ---------- Thresholds ----------
RUNNING_SPEED_THRESHOLD = 160
CHASE_DISTANCE_THRESHOLD = 200
SHRINK_RATE_THRESHOLD = 50

# Pose (shoulder/hip gap) fall thresholds — loosened from the original strict values,
# since MediaPipe pose landmarks are unreliable during the fast motion of an actual fall.
SUDDEN_COLLAPSE_RATE = 0.08    # normalized gap shrinking this fast per second (was 0.15)
LOW_GAP_THRESHOLD = 0.18       # current gap counts as "horizontal-ish" (was 0.12)
FALL_RESET_GAP = 0.22          # gap this large again = back on their feet

# Bounding-box fall thresholds — robust backup signal, works even when pose tracking
# drops out mid-fall. A fallen person's box goes wide-and-short instead of tall-and-thin,
# and the box center drops sharply.
ASPECT_FALL_RATIO = 1.3        # box_width / box_height above this ≈ lying down
DROP_PX_THRESHOLD = 40         # box center moved down this many px within the window

DEBUG = True   # prints live gap/rate/aspect numbers to the console so you can tune thresholds
cap = cv2.VideoCapture(0)
frame_index = 0
fps = 8   # was 30 — fixed to match your measured real-world rate (also fixes MediaPipe timestamp drift flagged earlier)



def get_alerts():
    """Central place where we'll collect this frame's detections."""
    return {"fall": False, "running_ids": [], "chase": False, "chase_pair": None ,"violence": False, "violence_pair": None}



# ---------- HUD helpers (bigger, cleaner, easier to read at a glance) ----------
FONT = cv2.FONT_HERSHEY_DUPLEX

def draw_text(frame, text, org, scale=0.8, color=(255, 255, 255), thickness=2):
    """Text with a black shadow so it stays readable over any background."""
    x, y = org
    cv2.putText(frame, text, (x + 2, y + 2), FONT, scale, (0, 0, 0), thickness + 2, cv2.LINE_AA)
    cv2.putText(frame, text, (x, y), FONT, scale, color, thickness, cv2.LINE_AA)

def draw_panel(frame, pt1, pt2, color=(20, 20, 20), alpha=0.55):
    """Semi-transparent rounded-feel background panel behind HUD text."""
    overlay = frame.copy()
    cv2.rectangle(overlay, pt1, pt2, color, -1)
    cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, frame)

def flash_border(frame, color, thickness=14):
    """Full-frame colored border so a critical alert is impossible to miss."""
    h, w = frame.shape[:2]
    cv2.rectangle(frame, (0, 0), (w - 1, h - 1), color, thickness)


while True:
    ret, frame = cap.read()
    
    if not ret:
        break

    h, w, _ = frame.shape
    now = time.time()
    if 'fps_counter' not in dir():
        fps_counter = deque(maxlen=30)
    fps_counter.append(now)
    if len(fps_counter) >= 2:
        measured_fps = len(fps_counter) / (fps_counter[-1] - fps_counter[0])
        if frame_index % 30 == 0:
            print(f"[FPS CHECK] measured: {measured_fps:.1f}")
    alerts = get_alerts()
    audio_state = read_audio_state()
    alerts["audio"] = audio_state.get("audio_alert", False)
    alerts["audio_sound"] = audio_state.get("audio_top_sound", "")
    alerts["audio_score"] = audio_state.get("audio_score", 0.0)

    # =========================================================
    # PART 1: YOLO + Tracking → Running & Chase
    # =========================================================
    yolo_results = yolo_model.track(frame, classes=[0], persist=True, verbose=False)
    current_positions = {}

    if yolo_results[0].boxes.id is not None:
        boxes = yolo_results[0].boxes.xywh.cpu()
        ids = yolo_results[0].boxes.id.cpu().numpy().astype(int)

        for box, track_id in zip(boxes, ids):
            x, y, bw, bh = box.tolist()
            position_history[track_id].append((now, x, y))

            speed, vx, vy = 0, 0, 0
            if len(position_history[track_id]) == position_history[track_id].maxlen:
                t0, x0, y0 = position_history[track_id][0]
                t1, x1, y1 = position_history[track_id][-1]
                dt = t1 - t0
                if dt > 0:
                    vx, vy = (x1 - x0) / dt, (y1 - y0) / dt
                    speed = (vx ** 2 + vy ** 2) ** 0.5

            current_positions[track_id] = (x, y, speed, vx, vy)
            is_running = speed > RUNNING_SPEED_THRESHOLD
            if is_running:
                alerts["running_ids"].append(track_id)

            # --- Bounding-box fall check: wide-not-tall box + sharp downward drop ---
            box_history[track_id].append((now, bw, bh, y))
            aspect_ratio = bw / bh if bh > 0 else 0
            box_is_fallen = False
            if len(box_history[track_id]) == box_history[track_id].maxlen:
                t0b, bw0, bh0, y0b = box_history[track_id][0]
                t1b, bw1, bh1, y1b = box_history[track_id][-1]
                dropped = (y1b - y0b) > DROP_PX_THRESHOLD
                if aspect_ratio > ASPECT_FALL_RATIO and dropped:
                    box_is_fallen = True
                    box_fall_ids.add(track_id)
                elif aspect_ratio < 1.5:
                    # Require the box to look upright for several consecutive
                    # frames, not just one — observed standing aspect ratio
                    # jitters between ~1.1 and 1.7 in practice, so a single-
                    # frame threshold at 1.105 (the old 0.85x multiplier)
                    # was almost never reachable and left box_fall_ids stuck
                    # True indefinitely once set.
                    recent_aspects = [bwx / bhx for _, bwx, bhx, _ in box_history[track_id] if bhx > 0]
                    if len(recent_aspects) >= 5 and all(a < 1.5 for a in recent_aspects[-5:]):
                        box_fall_ids.discard(track_id)

            if DEBUG:
                print(f"[BOX] ID{track_id} aspect={aspect_ratio:.2f} fallen={track_id in box_fall_ids}")

            is_box_fallen = track_id in box_fall_ids
            color = (0, 0, 255) if (is_running or is_box_fallen) else (0, 255, 0)
            x1b, y1b = int(x - bw / 2), int(y - bh / 2)
            x2b, y2b = int(x + bw / 2), int(y + bh / 2)
            cv2.rectangle(frame, (x1b, y1b), (x2b, y2b), color, 3)
            state = "FALLEN" if is_box_fallen else ("RUNNING" if is_running else "walking")
            tag = f"ID{track_id} · {state} · {speed:.0f}px/s"
            draw_text(frame, tag, (x1b, max(y1b - 12, 22)), scale=0.6, color=color, thickness=2)

    # Prune stale track IDs — if a person's ID disappeared (left frame,
    # or BoT-SORT reassigned a new ID), their old "fallen" flag must not
    # linger forever and keep the whole system stuck CRITICAL.
    box_fall_ids &= set(current_positions.keys())
    for stale_id in list(position_history.keys()):
        if stale_id not in current_positions:
            position_history.pop(stale_id, None)
            box_history.pop(stale_id, None)

    # Chase check across all pairs
    for id_a, id_b in combinations(current_positions.keys(), 2):
        xa, ya, speed_a, vxa, vya = current_positions[id_a]
        xb, yb, speed_b, vxb, vyb = current_positions[id_b]
        distance = ((xa - xb) ** 2 + (ya - yb) ** 2) ** 0.5
        pair_key = tuple(sorted([id_a, id_b]))
        pair_distance_history[pair_key].append((now, distance))

        both_running = speed_a > RUNNING_SPEED_THRESHOLD and speed_b > RUNNING_SPEED_THRESHOLD
        is_closing = False
        if len(pair_distance_history[pair_key]) == pair_distance_history[pair_key].maxlen:
            t0, d0 = pair_distance_history[pair_key][0]
            t1, d1 = pair_distance_history[pair_key][-1]
            dt = t1 - t0
            if dt > 0:
                is_closing = (d0 - d1) / dt > SHRINK_RATE_THRESHOLD

        to_b_x, to_b_y = xb - xa, yb - ya
        moving_toward = (vxa * to_b_x + vya * to_b_y) > 0

        if both_running and distance < CHASE_DISTANCE_THRESHOLD and is_closing and moving_toward:
            alerts["chase"] = True
            alerts["chase_pair"] = (id_a, id_b)
            cv2.line(frame, (int(xa), int(ya)), (int(xb), int(yb)), (0, 0, 255), 3)

    # =========================================================
    # PART 2: MediaPipe Pose → Fall Detection (proper version)
    # =========================================================
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
    timestamp_ms = int((frame_index / fps) * 1000)
    pose_result = landmarker.detect_for_video(mp_image, timestamp_ms)
    frame_index += 1

    normalized_gap = None
    people_landmarks = {}

    if pose_result.pose_landmarks:
        # Build {track_id: landmarks} for violence detector by matching pose
    # detections to the closest YOLO-tracked box (crude but workable —
    # MediaPipe Tasks API gives no track ID directly)
        
        if pose_result.pose_landmarks:
            for person_landmarks in pose_result.pose_landmarks:
                ls, rs = person_landmarks[11], person_landmarks[12]
                torso_x, torso_y = (ls.x * w + rs.x * w) / 2, (ls.y * h + rs.y * h) / 2

                best_id, best_dist = None, float("inf")
                for tid, (px, py, *_ ) in current_positions.items():
                    dist = ((px - torso_x) ** 2 + (py - torso_y) ** 2) ** 0.5
                    if dist < best_dist:
                        best_dist, best_id = dist, tid

                if best_id is not None:
                    people_landmarks[best_id] = person_landmarks
        for person_landmarks in pose_result.pose_landmarks:

            # Draw skeleton + landmark dots
            for connection in mp_pose_connections:
                s, e = connection
                sp = person_landmarks[s]
                ep = person_landmarks[e]
                cv2.line(frame, (int(sp.x * w), int(sp.y * h)), (int(ep.x * w), int(ep.y * h)), (0, 255, 255), 2)
            for lm in person_landmarks:
                cv2.circle(frame, (int(lm.x * w), int(lm.y * h)), 3, (255, 0, 0), -1)

            # --- Core fall logic ---
            left_shoulder_y = person_landmarks[11].y * h
            right_shoulder_y = person_landmarks[12].y * h
            left_hip_y = person_landmarks[23].y * h
            right_hip_y = person_landmarks[24].y * h

            shoulder_y = (left_shoulder_y + right_shoulder_y) / 2
            hip_y = (left_hip_y + right_hip_y) / 2

            # Vertical torso gap — large when standing, small when horizontal
            torso_gap = abs(hip_y - shoulder_y)

            # Normalize by frame height so this works regardless of camera distance/resolution
            normalized_gap = torso_gap / h
            gap_history.append((now, normalized_gap))

            # Need enough history to judge a *change*, not just a snapshot
            if len(gap_history) == gap_history.maxlen:
                t_old, gap_old = gap_history[0]
                t_new, gap_new = gap_history[-1]
                dt = t_new - t_old

                if dt > 0:
                    # positive = gap shrinking = collapsing toward horizontal
                    gap_change_rate = (gap_old - gap_new) / dt

                    if DEBUG:
                        print(f"[POSE] gap={normalized_gap:.3f} rate={gap_change_rate:.3f} "
                            f"(need rate>{SUDDEN_COLLAPSE_RATE} and gap<{LOW_GAP_THRESHOLD})")

                    if gap_change_rate > SUDDEN_COLLAPSE_RATE and normalized_gap < LOW_GAP_THRESHOLD:
                        if not fall_alert_active:
                            fall_alert_active = True
                            fall_alert_time = now
                            print(f"⚠️  FALL DETECTED (pose) at {time.strftime('%H:%M:%S')}")

            # Reset alert if person has been upright and stable again
            if fall_alert_active and normalized_gap > FALL_RESET_GAP:
                fall_alert_active = False

    # Unified fall flag = pose-based OR bounding-box-based (whichever fires first/works)
    violence_result = violence_detector.update(people_landmarks, now, w, h)
    alerts["violence"] = violence_result["violence_alert"]
    alerts["violence_pair"] = violence_result["pair"]
    alerts["fall"] = fall_alert_active or bool(box_fall_ids)
    fused = fusion.update(alerts, audio_state, now)

    # =========================================================
    # PART 3: Unified alert display — one clear status banner
    # =========================================================
    # =========================================================
    # PART 3: Unified alert display — one clear status banner
    # =========================================================
    frame_w = frame.shape[1]

    # Severity now comes from the fusion engine, not manual OR-ing of flags
    status_color = LEVEL_COLOR[fused["alert_level"]]
    is_critical = fused["alert_level"] == AlertLevel.CRITICAL

    level_label = fused["alert_level"].name  # "NONE", "LOW", "MEDIUM", "CRITICAL"
    if fused["contributing_signals"]:
        signal_label = " + ".join(s.upper() for s in fused["contributing_signals"])
        status_text = f"{level_label}: {signal_label}"
    else:
        status_text = "ALL CLEAR"
    if fused["corroborated"]:
        status_text += " (corroborated)"

    banner_bg = tuple(int(c * 0.35) for c in status_color)  # dim version of status_color for background

    # --- Top banner: big, unmissable status ---
    banner_h = 78
    draw_panel(frame, (0, 0), (frame_w, banner_h), color=banner_bg, alpha=0.65)
    cv2.rectangle(frame, (0, 0), (frame_w, banner_h), status_color, 3)
    draw_text(frame, status_text, (18, 34), scale=1.1, color=status_color, thickness=3)

    # --- Detail line inside the banner: who / what triggered it ---
    details = []
    if alerts["audio"]:
        details.append(f"Audio distress: {alerts['audio_sound']} ({alerts['audio_score']:.2f})")
    if box_fall_ids:
        details.append(f"Fallen (box): {sorted(box_fall_ids)}")
    if alerts["running_ids"]:
        details.append(f"Running: {alerts['running_ids']}")
    if alerts["chase"]:
        details.append(f"Chase pair: {alerts['chase_pair']}")
    if alerts["violence"]:
        details.append(f"Violence: pair {alerts['violence_pair']}")
    detail_text = ("  |  ".join(details) if details else "No unusual motion in frame")
    detail_text += f"   [score: {fused['score']:.0f}]"
    draw_text(frame, detail_text, (18, 62), scale=0.6, color=(230, 230, 230), thickness=1)

    # --- Small readout panel bottom-left: live fall-gap metric ---
    if normalized_gap is not None:
        frame_h = frame.shape[0]
        panel_top = frame_h - 46
        draw_panel(frame, (0, panel_top), (230, frame_h), color=(15, 15, 15), alpha=0.6)
        gap_color = (0, 0, 255) if alerts["fall"] else (0, 255, 0)
        draw_text(frame, f"Torso gap: {normalized_gap:.3f}", (14, frame_h - 14), scale=0.55, color=gap_color, thickness=1)

    # --- Small readout panel bottom-right: live audio metric (always visible) ---
    frame_h, frame_w2 = frame.shape[0], frame.shape[1]
    audio_panel_left = frame_w2 - 320
    draw_panel(frame, (audio_panel_left, frame_h - 46), (frame_w2, frame_h), color=(15, 15, 15), alpha=0.6)
    audio_color = (0, 0, 255) if alerts["audio"] else (200, 200, 200)
    audio_sound_display = alerts["audio_sound"] if alerts["audio_sound"] else "..."
    draw_text(frame, f"Audio: {audio_sound_display} ({alerts['audio_score']:.2f})",
            (audio_panel_left + 14, frame_h - 14), scale=0.55, color=audio_color, thickness=1)

    # --- Critical alerts get a full-frame flashing border, impossible to miss ---
    if is_critical:
        flash_border(frame, status_color, thickness=14)
    output_manager.update(frame, fused, now)
    mjpeg.push_frame(frame)
    alert_push.notify(fused)

    cv2.imshow("Unified Threat Detection", frame)

    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
output_manager.shutdown()
mjpeg.stop()
alert_push.stop()