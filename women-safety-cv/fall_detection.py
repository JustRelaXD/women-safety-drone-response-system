import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
from collections import deque
import time

mp_pose_connections = mp.solutions.pose.POSE_CONNECTIONS

base_options = python.BaseOptions(model_asset_path='pose_landmarker.task')
options = vision.PoseLandmarkerOptions(
    base_options=base_options,
    running_mode=vision.RunningMode.VIDEO
)
landmarker = vision.PoseLandmarker.create_from_options(options)

cap = cv2.VideoCapture(0)
frame_index = 0
fps = 30

# Rolling history of the "torso gap" over the last ~1 second
gap_history = deque(maxlen=15)  # ~15 frames at 30fps ≈ 0.5 sec window

fall_alert_active = False
fall_alert_time = None

while True:
    ret, frame = cap.read()
    if not ret:
        break

    h, w, _ = frame.shape
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
    timestamp_ms = int((frame_index / fps) * 1000)
    result = landmarker.detect_for_video(mp_image, timestamp_ms)
    frame_index += 1
    now = time.time()

    if result.pose_landmarks:
        for person_landmarks in result.pose_landmarks:

            # Draw skeleton (as before)
            for connection in mp_pose_connections:
                s, e = connection
                sp = person_landmarks[s]
                ep = person_landmarks[e]
                cv2.line(frame, (int(sp.x*w), int(sp.y*h)), (int(ep.x*w), int(ep.y*h)), (0,255,255), 2)
            for lm in person_landmarks:
                cv2.circle(frame, (int(lm.x*w), int(lm.y*h)), 3, (255,0,0), -1)

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
                    gap_change_rate = (gap_old - gap_new) / dt  # positive = gap shrinking = collapsing toward horizontal

                    # THRESHOLDS — tune these by testing
                    SUDDEN_COLLAPSE_RATE = 0.15   # normalized gap shrinking this fast per second
                    LOW_GAP_THRESHOLD = 0.12      # current gap is small = already horizontal-ish

                    if gap_change_rate > SUDDEN_COLLAPSE_RATE and normalized_gap < LOW_GAP_THRESHOLD:
                        if not fall_alert_active:
                            fall_alert_active = True
                            fall_alert_time = now
                            print(f"⚠️  FALL DETECTED at {time.strftime('%H:%M:%S')}")

            # Reset alert if person has been upright and stable for a while
            if fall_alert_active and normalized_gap > 0.20:
                fall_alert_active = False

            # Visual feedback on screen
            status_text = "FALL DETECTED" if fall_alert_active else "Normal"
            status_color = (0, 0, 255) if fall_alert_active else (0, 255, 0)
            cv2.putText(frame, status_text, (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, status_color, 2)
            cv2.putText(frame, f"gap={normalized_gap:.3f}", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255,255,255), 1)

    cv2.imshow("Fall Detection", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()