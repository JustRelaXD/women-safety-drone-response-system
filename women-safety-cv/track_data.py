from ultralytics import YOLO
import cv2

model = YOLO("yolov8n.pt")
cap = cv2.VideoCapture(0)


while True:
    ret, frame = cap.read()
    if not ret:
        break

    results = model.track(frame, classes=[0], persist=True, verbose=False, tracker="my_botsort.yaml")

    # Check if there are any detections with tracking IDs
    if results[0].boxes.id is not None:
        boxes = results[0].boxes.xywh.cpu()   # center_x, center_y, width, height
        ids = results[0].boxes.id.cpu().numpy().astype(int)

        for box, track_id in zip(boxes, ids):
            x, y, w, h = box
            print(f"Person ID {track_id}: center=({x:.0f},{y:.0f}) size=({w:.0f}x{h:.0f})")

    annotated_frame = results[0].plot()
    cv2.imshow("Tracking Data", annotated_frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()