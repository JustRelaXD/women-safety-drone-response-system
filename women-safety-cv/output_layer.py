"""
Output layer: buffer footage and save clips — LOCAL DISK VERSION, no cloud.

Same event logic as before (rolling pre-buffer, trigger on CRITICAL or a
manual save request, background thread so encoding never blocks your
main detection loop) — just no S3 upload step. Clips land directly in a
local folder. Since your dashboard is on the same LAN during testing, it
can read this folder later either directly (if dashboard runs on the same
machine) or via a small local file server (same pattern as live_stream.py
— can extend that HTTP server to also serve this clips folder if needed).

No AWS account, no billing, no signup needed for single-drone testing.
"""

import cv2
import time
import threading
import queue
import os
from collections import deque
from enum import Enum


class CaptureState(Enum):
    IDLE = 0
    CAPTURING = 1   # actively buffering post-trigger frames


class OutputManager:
    def __init__(
        self,
        fps=15,
        pre_event_seconds=5,
        post_event_seconds=8,
        output_dir="/home/claude_project/alert_clips",  # change to your real project path
        on_clip_saved=None,
    ):
        """
        fps:                 must match your actual capture frame rate, or
                              exported clips will play back at the wrong speed.
        pre_event_seconds:   how much buffered history to include BEFORE
                              the trigger frame.
        post_event_seconds:  how long to keep recording AFTER the alert
                              first fires, before cutting the clip.
        output_dir:           where finished clips are saved. Point this at
                              a real folder in your project, not /tmp, so
                              clips survive a reboot.
        on_clip_saved:        optional callback, called as
                              on_clip_saved(filename, reason) the moment a
                              clip finishes encoding — this is the hook that
                              lets you notify the dashboard the clip is
                              ready to fetch. Runs on the background worker
                              thread, not the main frame loop, so keep it
                              fast (e.g. just queue a WebSocket message —
                              don't do anything slow in here).
        """
        self.fps = fps
        self.pre_event_seconds = pre_event_seconds
        self.post_event_seconds = post_event_seconds
        self.output_dir = output_dir
        self.on_clip_saved = on_clip_saved

        os.makedirs(output_dir, exist_ok=True)

        pre_buffer_len = fps * pre_event_seconds
        self.pre_buffer = deque(maxlen=pre_buffer_len)  # (frame, timestamp)

        self.state = CaptureState.IDLE
        self.capture_frames = []
        self.capture_start_time = None
        self.capture_reason = None  # "critical_alert" or "manual_save"

        # set by request_manual_save() — checked once per frame in update().
        # threading.Event, not a plain bool, so it's safe to set from
        # another thread (e.g. a future dashboard command-listener thread).
        self._manual_save_requested = threading.Event()

        # background worker — encoding a video file takes real wall-clock
        # time; doing it synchronously in the frame loop would stall
        # detection while it happens
        self.job_queue = queue.Queue()
        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker_thread.start()

    # -----------------------------------------------------------------
    # Called every frame from your main loop
    # -----------------------------------------------------------------
    def update(self, frame, fused_result, timestamp=None):
        """
        frame:         current BGR frame (numpy array) from your video loop.
        fused_result:  the dict returned by FusionEngine.update() this frame.
        timestamp:     seconds, defaults to time.time().
        """
        if timestamp is None:
            timestamp = time.time()

        self.pre_buffer.append((frame.copy(), timestamp))

        is_critical = fused_result["alert_level"].name == "CRITICAL"
        manual_requested = self._manual_save_requested.is_set()

        if self.state == CaptureState.IDLE and (is_critical or manual_requested):
            reason = "critical_alert" if is_critical else "manual_save"
            self._start_capture(timestamp, reason)
            if manual_requested:
                self._manual_save_requested.clear()

        if self.state == CaptureState.CAPTURING:
            self.capture_frames.append((frame.copy(), timestamp))

            elapsed_since_start = timestamp - self.capture_start_time
            if elapsed_since_start >= self.post_event_seconds:
                self._finish_capture()

    def _start_capture(self, timestamp, reason="critical_alert"):
        self.state = CaptureState.CAPTURING
        self.capture_start_time = timestamp
        self.capture_reason = reason
        self.capture_frames = list(self.pre_buffer)

    def request_manual_save(self):
        """
        Call this to trigger a save independent of alert state — e.g. an
        operator on the future dashboard clicks "save this moment" while
        watching the live stream.

        Safe to call from ANY thread. Deliberately decoupled from however
        the dashboard eventually delivers the command (REST endpoint,
        WebSocket, or even just a local function call if the dashboard
        backend runs on the same machine as this script) — whatever
        listener you build just needs to call this method.
        """
        self._manual_save_requested.set()

    def _finish_capture(self):
        frames_to_export = self.capture_frames
        reason = self.capture_reason
        self.capture_frames = []
        self.state = CaptureState.IDLE
        self.capture_reason = None

        self.job_queue.put((frames_to_export, reason))

    # -----------------------------------------------------------------
    # Background worker
    # -----------------------------------------------------------------
    def _worker_loop(self):
        while True:
            frames, reason = self.job_queue.get()
            try:
                self._encode(frames, reason)
            except Exception as e:
                print(f"[output_layer] Unexpected error encoding clip: {e}")
            finally:
                self.job_queue.task_done()

    def _encode(self, frames, reason="critical_alert"):
        if not frames:
            return

        tag = "critical" if reason == "critical_alert" else "manual"
        clip_filename = f"{time.strftime('%Y-%m-%d_%H%M%S')}_{tag}.mp4"
        output_path = os.path.join(self.output_dir, clip_filename)

        first_frame = frames[0][0]
        height, width = first_frame.shape[:2]
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(output_path, fourcc, self.fps, (width, height))
        for frame, _ in frames:
            writer.write(frame)
        writer.release()

        print(f"[output_layer] Saved clip: {output_path} ({len(frames)} frames, tag={tag})")

        if self.on_clip_saved is not None:
            try:
                self.on_clip_saved(clip_filename, reason)
            except Exception as e:
                print(f"[output_layer] on_clip_saved callback error: {e}")

    def shutdown(self):
        """Call this on clean exit so any in-flight clip finishes encoding
        rather than being silently dropped."""
        print("[output_layer] Waiting for pending clips to finish encoding...")
        self.job_queue.join()


# -----------------------------------------------------------------------
# Example integration sketch
# -----------------------------------------------------------------------
if __name__ == "__main__":
    """
    output_manager = OutputManager(
        fps=15,   # MUST match your real capture fps
        output_dir="./alert_clips",
    )

    # --- inside your unified_detection.py frame loop, AFTER you've
    #     computed `fused = fusion.update(...)` this frame ---
    #
    # output_manager.update(frame, fused, frame_timestamp)
    #
    # --- on clean shutdown ---
    # output_manager.shutdown()
    """
    print("This module is meant to be imported into unified_detection.py — "
          "see the docstring above for the integration sketch.")
