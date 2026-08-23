"""
Violence / hitting detection — lightweight pose-heuristic version.

Design goal: reuse landmarks you're already computing for fall detection
(MediaPipe Tasks API pose_landmarker_lite) — no new model, no extra
per-frame inference cost. Mirrors the same pattern as your other
detectors: track a signal over a rolling window, fire on a two-condition
threshold, require sustain/repetition to cut false positives.

What it actually detects: two tracked people in close proximity, where at
least one has a wrist moving at high, repeated velocity (consistent with
a striking motion rather than a single wave/gesture/reach).

Known limitations (be upfront about these — they matter for how much you
trust this signal downstream in the fusion layer):
- Cannot distinguish playful/athletic contact (sports, dancing, horsing
    around) from actual violence — proximity + fast limb motion is a
    correlate, not proof.
- Needs BOTH people's pose landmarks to be tracked cleanly. Occlusion
    (bodies overlapping, which is common in an actual altercation) will
    degrade MediaPipe's pose estimation right when you need it most —
    this is the same failure mode your fall detector's bbox backup
    signal was built to handle, but this module doesn't have an
    equivalent fallback yet.
- Single-camera 2D landmarks — no depth, so "close proximity" is a
    frame-distance proxy, not real-world distance (same limitation your
    chase detector already has).
- Recommend treating this as a MEDIUM-confidence signal in the fusion
    layer, not a standalone critical alert — best used to corroborate
    audio distress or a sudden fall, not fire alone.
"""

import numpy as np
from collections import deque


# MediaPipe Pose landmark indices (Tasks API, BlazePose 33-point model)
LEFT_WRIST = 15
RIGHT_WRIST = 16
LEFT_ELBOW = 13
RIGHT_ELBOW = 14
LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12


class PersonLimbTracker:
    """
    Tracks one person's wrist positions/velocities over a rolling window.
    One instance per tracked person ID (same pattern as your fall
    detector's per-ID torso-gap history).
    """

    def __init__(self, window_size=8):
        self.window_size = window_size
        self.left_wrist_history = deque(maxlen=window_size)   # (x, y, timestamp)
        self.right_wrist_history = deque(maxlen=window_size)
        self.velocity_spike_history = deque(maxlen=window_size)  # bool per frame

    def update(self, landmarks, timestamp, frame_width, frame_height):
        """
        landmarks: MediaPipe pose landmarks for this person this frame
                (same object you already get per-person from your
                fall detector's pose step).
        timestamp: frame timestamp in seconds (monotonic).
        frame_width/height: for normalizing pixel-space velocity.

        Returns: peak wrist speed this frame (normalized units/sec),
                or None if landmarks are missing/low-confidence.
        """
        if landmarks is None:
            self.velocity_spike_history.append(False)
            return None

        lw = landmarks[LEFT_WRIST]
        rw = landmarks[RIGHT_WRIST]

        # visibility check — MediaPipe gives a visibility score per landmark;
        # skip frames where the wrist isn't confidently tracked rather than
        # feeding noisy positions into the velocity calc
        min_visibility = 0.5
        left_ok = getattr(lw, "visibility", 1.0) >= min_visibility
        right_ok = getattr(rw, "visibility", 1.0) >= min_visibility

        self.left_wrist_history.append((lw.x, lw.y, timestamp) if left_ok else None)
        self.right_wrist_history.append((rw.x, rw.y, timestamp) if right_ok else None)

        left_speed = self._calc_speed(self.left_wrist_history)
        right_speed = self._calc_speed(self.right_wrist_history)

        speeds = [s for s in (left_speed, right_speed) if s is not None]
        peak_speed = max(speeds) if speeds else None

        return peak_speed

    def _calc_speed(self, history):
        """Speed between the two most recent valid points, normalized
        (x,y) units per second — same units/sec regardless of resolution,
        so thresholds are comparable across camera setups."""
        valid = [p for p in history if p is not None]
        if len(valid) < 2:
            return None
        (x1, y1, t1), (x2, y2, t2) = valid[-2], valid[-1]
        dt = t2 - t1
        if dt <= 0:
            return None
        dist = np.hypot(x2 - x1, y2 - y1)  # normalized coords, so this is
                                            # fraction-of-frame per step
        return dist / dt

    def record_spike(self, is_spike):
        self.velocity_spike_history.append(is_spike)

    def spike_repeat_count(self):
        """How many of the recent frames counted as a velocity spike —
        used for the 'repeated' condition so a single reach/wave doesn't
        trigger, but a flurry of strikes does."""
        return sum(1 for v in self.velocity_spike_history if v)


class ViolenceDetector:
    def __init__(
        self,
        wrist_speed_threshold=1.8,       # normalized units/sec — tune on your footage
        proximity_threshold=0.25,         # normalized frame-distance between torsos
        min_spike_repeats=3,              # spikes needed within window to fire
        window_size=8,
    ):
        self.wrist_speed_threshold = wrist_speed_threshold
        self.proximity_threshold = proximity_threshold
        self.min_spike_repeats = min_spike_repeats
        self.window_size = window_size

        self.trackers = {}  # track_id -> PersonLimbTracker

    def _get_tracker(self, track_id):
        if track_id not in self.trackers:
            self.trackers[track_id] = PersonLimbTracker(self.window_size)
        return self.trackers[track_id]

    def _torso_center(self, landmarks):
        ls, rs = landmarks[LEFT_SHOULDER], landmarks[RIGHT_SHOULDER]
        return ((ls.x + rs.x) / 2, (ls.y + rs.y) / 2)

    def update(self, people, timestamp, frame_width, frame_height):
        """
        people: dict of {track_id: landmarks} for this frame — same
                structure you're already assembling per-frame for fall
                detection across tracked IDs.
        timestamp: frame timestamp in seconds.

        Returns: dict {
            "violence_alert": bool,
            "pair": (id_a, id_b) or None,
            "peak_speed": float or None,
            "distance": float or None,
        }
        """
        # update per-person wrist velocity + spike tracking
        peak_speeds = {}
        for track_id, landmarks in people.items():
            tracker = self._get_tracker(track_id)
            speed = tracker.update(landmarks, timestamp, frame_width, frame_height)
            is_spike = speed is not None and speed >= self.wrist_speed_threshold
            tracker.record_spike(is_spike)
            peak_speeds[track_id] = speed

        # drop trackers for people no longer in frame (avoid stale memory growth)
        stale_ids = set(self.trackers.keys()) - set(people.keys())
        for sid in stale_ids:
            del self.trackers[sid]

        # check all pairs for proximity + one side showing repeated spikes
        ids = list(people.keys())
        best_pair = None
        best_speed = None
        best_distance = None

        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                id_a, id_b = ids[i], ids[j]
                if people[id_a] is None or people[id_b] is None:
                    continue

                center_a = self._torso_center(people[id_a])
                center_b = self._torso_center(people[id_b])
                distance = np.hypot(center_a[0] - center_b[0], center_a[1] - center_b[1])

                if distance > self.proximity_threshold:
                    continue

                tracker_a = self.trackers.get(id_a)
                tracker_b = self.trackers.get(id_b)
                repeats_a = tracker_a.spike_repeat_count() if tracker_a else 0
                repeats_b = tracker_b.spike_repeat_count() if tracker_b else 0

                if max(repeats_a, repeats_b) >= self.min_spike_repeats:
                    speed_a = peak_speeds.get(id_a) or 0
                    speed_b = peak_speeds.get(id_b) or 0
                    peak_speed = max(speed_a, speed_b)

                    if best_speed is None or peak_speed > best_speed:
                        best_pair = (id_a, id_b)
                        best_speed = peak_speed
                        best_distance = distance

        return {
            "violence_alert": best_pair is not None,
            "pair": best_pair,
            "peak_speed": best_speed,
            "distance": best_distance,
        }


# -----------------------------------------------------------------------
# Example integration sketch (adapt to your unified_detection.py loop)
# -----------------------------------------------------------------------
if __name__ == "__main__":
    """
    This is a sketch, not a runnable demo — it assumes you already have,
    per frame, in your unified_detection.py:
    - `people_landmarks`: {track_id: pose_landmarks_or_None}
    - `frame_timestamp`: seconds
    - `frame.shape` for width/height

    detector = ViolenceDetector()

    result = detector.update(people_landmarks, frame_timestamp,
                            frame_width, frame_height)

    if result["violence_alert"]:
        id_a, id_b = result["pair"]
        print(f"VIOLENCE ALERT between tracked IDs {id_a} and {id_b} "
            f"(peak wrist speed {result['peak_speed']:.2f}, "
            f"distance {result['distance']:.2f})")
    """
    print("This module is meant to be imported into unified_detection.py — "
        "see the docstring above for the integration sketch.")
