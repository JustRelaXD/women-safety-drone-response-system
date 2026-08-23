from ultralytics import YOLO
import cv2
from collections import defaultdict, deque
import time

model = YOLO("yolov8n.pt")
cap = cv2.VideoCapture(0)

history = defaultdict(lambda: deque(maxlen=15))  # ~0.5 sec at 30fps
running_status = defaultdict(bool)

RUNNING_SPEED_THRESHOLD = 150  # pixels/sec — TUNE this by testing

while True:
    ret, frame = cap.read()
    if not ret:
        break

    results = model.track(frame, classes=[0], persist=True, verbose=False)
    now = time.time()

    if results[0].boxes.id is not None:
        boxes = results[0].boxes.xywh.cpu()
        ids = results[0].boxes.id.cpu().numpy().astype(int)

        for box, track_id in zip(boxes, ids):
            x, y, w, h = box.tolist()
            history[track_id].append((now, x, y))

            if len(history[track_id]) == history[track_id].maxlen:
                t0, x0, y0 = history[track_id][0]
                t1, x1, y1 = history[track_id][-1]
                dt = t1 - t0

                if dt > 0:
                    dist = ((x1 - x0)**2 + (y1 - y0)**2) ** 0.5
                    speed = dist / dt

                    is_running = speed > RUNNING_SPEED_THRESHOLD
                    running_status[track_id] = is_running
                    print(f"ID{track_id}: speed={speed:.1f}px/s  threshold={RUNNING_SPEED_THRESHOLD}  running={is_running}")

                    # Draw box + label manually so we can show speed/status
                    x1_box, y1_box = int(x - w/2), int(y - h/2)
                    x2_box, y2_box = int(x + w/2), int(y + h/2)
                    color = (0, 0, 255) if is_running else (0, 255, 0)
                    label = f"ID{track_id} {'RUNNING' if is_running else 'walking'} {speed:.0f}px/s"
                    cv2.rectangle(frame, (x1_box, y1_box), (x2_box, y2_box), color, 2)
                    cv2.putText(frame, label, (x1_box, y1_box - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

    cv2.imshow("Running Detection", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()