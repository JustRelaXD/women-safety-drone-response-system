from ultralytics import YOLO
import cv2
from collections import defaultdict, deque
import time
from itertools import combinations

model = YOLO("yolov8n.pt")
cap = cv2.VideoCapture(0)

history = defaultdict(lambda: deque(maxlen=15))
RUNNING_SPEED_THRESHOLD = 150
CHASE_DISTANCE_THRESHOLD = 200  # pixels — "close enough to be pursuit," tune this

while True:
    ret, frame = cap.read()
    if not ret:
        break

    results = model.track(frame, classes=[0], persist=True, verbose=False)
    now = time.time()

    current_positions = {}  # track_id -> (x, y, speed)

    if results[0].boxes.id is not None:
        boxes = results[0].boxes.xywh.cpu()
        ids = results[0].boxes.id.cpu().numpy().astype(int)

        for box, track_id in zip(boxes, ids):
            x, y, w, h = box.tolist()
            history[track_id].append((now, x, y))

            speed = 0
            if len(history[track_id]) == history[track_id].maxlen:
                t0, x0, y0 = history[track_id][0]
                t1, x1, y1 = history[track_id][-1]
                dt = t1 - t0
                if dt > 0:
                    dist = ((x1-x0)**2 + (y1-y0)**2) ** 0.5
                    speed = dist / dt

            current_positions[track_id] = (x, y, speed)

            color = (0, 255, 0)
            cv2.circle(frame, (int(x), int(y)), 6, color, -1)
            cv2.putText(frame, f"ID{track_id}", (int(x)+10, int(y)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

    # --- Chase logic: check every pair of currently tracked people ---
    chase_detected = False
    for id_a, id_b in combinations(current_positions.keys(), 2):
        xa, ya, speed_a = current_positions[id_a]
        xb, yb, speed_b = current_positions[id_b]

        distance = ((xa - xb)**2 + (ya - yb)**2) ** 0.5

        both_running = speed_a > RUNNING_SPEED_THRESHOLD and speed_b > RUNNING_SPEED_THRESHOLD
        close_enough = distance < CHASE_DISTANCE_THRESHOLD

        if both_running and close_enough:
            chase_detected = True
            cv2.line(frame, (int(xa), int(ya)), (int(xb), int(yb)), (0, 0, 255), 3)
            cv2.putText(frame, f"POSSIBLE CHASE: ID{id_a} & ID{id_b}", (30, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)

    if not chase_detected:
        cv2.putText(frame, "Normal", (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

    cv2.imshow("Chase Detection", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
