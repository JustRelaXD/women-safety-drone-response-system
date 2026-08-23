import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

# Just the index-pair list for skeleton connections, reused from legacy — still valid
mp_pose_connections = mp.solutions.pose.POSE_CONNECTIONS

# --- Setup: load the model once ---
base_options = python.BaseOptions(model_asset_path='pose_landmarker.task')
options = vision.PoseLandmarkerOptions(
    base_options=base_options,
    running_mode=vision.RunningMode.VIDEO  # video mode = designed for continuous frame streams
)
landmarker = vision.PoseLandmarker.create_from_options(options)

cap = cv2.VideoCapture(0)
frame_index = 0
fps = 30  # approximate, used for timestamping

while True:
    ret, frame = cap.read()
    if not ret:
        break

    h, w, _ = frame.shape
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    # Tasks API wants its own Image wrapper, not raw numpy
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)

    # Video mode requires a timestamp per frame (in milliseconds)
    timestamp_ms = int((frame_index / fps) * 1000)
    result = landmarker.detect_for_video(mp_image, timestamp_ms)
    frame_index += 1

    if result.pose_landmarks:
        # result.pose_landmarks is a list of detected people; each has 33 landmarks
        for person_landmarks in result.pose_landmarks:

            # Draw skeleton lines first (so dots sit on top, looks cleaner)
            for connection in mp_pose_connections:
                start_idx, end_idx = connection
                start_lm = person_landmarks[start_idx]
                end_lm = person_landmarks[end_idx]
                start_point = (int(start_lm.x * w), int(start_lm.y * h))
                end_point = (int(end_lm.x * w), int(end_lm.y * h))
                cv2.line(frame, start_point, end_point, (0, 255, 255), 2)

            # Then draw all 33 landmarks as blue dots
            for lm in person_landmarks:
                cx, cy = int(lm.x * w), int(lm.y * h)
                cv2.circle(frame, (cx, cy), 3, (255, 0, 0), -1)

            # Shoulder/hip specific tracking + print logic
            left_hip_y = person_landmarks[23].y * h
            right_hip_y = person_landmarks[24].y * h
            left_shoulder_y = person_landmarks[11].y * h
            right_shoulder_y = person_landmarks[12].y * h

            hip_y = (left_hip_y + right_hip_y) / 2
            shoulder_y = (left_shoulder_y + right_shoulder_y) / 2

            print(f"shoulder_y={shoulder_y:.0f}  hip_y={hip_y:.0f}")

            # Draw green dots on top for shoulders/hips so you can see them clearly
            for idx in [11, 12, 23, 24]:
                lm = person_landmarks[idx]
                cx, cy = int(lm.x * w), int(lm.y * h)
                cv2.circle(frame, (cx, cy), 6, (0, 255, 0), -1)

    cv2.imshow("Pose (Tasks API)", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()