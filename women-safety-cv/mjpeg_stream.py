"""
Live streaming via MJPEG — simplest possible option, no ffmpeg needed.

How MJPEG works: instead of a real video codec, it just sends a continuous
stream of individual JPEG images over one long-lived HTTP connection, using
a special content type (multipart/x-mixed-replace) that browsers know how
to display as a live-updating <img> tag automatically. This is the same
technology old-school IP security cameras used for decades — dead simple,
zero extra dependencies, works in any browser natively.

Trade-off vs HLS: no adaptive bitrate, more bandwidth (each frame is a full
JPEG, no inter-frame compression), no built-in seeking/buffering. For a
single-device LAN setup where you just want the dashboard to SEE the feed
immediately, none of that matters — this is the right tool for this job.

Dashboard side (later): just
    <img src="http://<drone-ip>:8000/stream">
No JavaScript, no player library, nothing else needed.
"""

import threading
import http.server
import socketserver
import cv2


class MJPEGHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/clips/"):
            self._serve_clip()
            return

        if self.path != "/stream":
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header(
            "Content-Type", "multipart/x-mixed-replace; boundary=frame"
        )
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")  # browser dashboard on a different port needs this
        self.end_headers()

        try:
            while True:
                frame = self.server.mjpeg_streamer.get_latest_frame()
                if frame is None:
                    continue

                ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if not ok:
                    continue

                self.wfile.write(b"--frame\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(jpeg)}\r\n\r\n".encode())
                self.wfile.write(jpeg.tobytes())
                self.wfile.write(b"\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass  # dashboard closed the connection — normal, not an error

    def _serve_clip(self):
        import os
        clips_dir = self.server.clips_dir
        if not clips_dir:
            self.send_response(404)
            self.end_headers()
            return

        filename = self.path[len("/clips/"):]
        # basic safety: no path traversal outside clips_dir
        if ".." in filename or filename.startswith("/"):
            self.send_response(400)
            self.end_headers()
            return

        filepath = os.path.join(clips_dir, filename)
        if not os.path.isfile(filepath):
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        with open(filepath, "rb") as f:
            self.wfile.write(f.read())

    def log_message(self, format, *args):
        pass  # silence per-request logging, this streams continuously


class MJPEGStreamer:
    def __init__(self, http_port=8000, clips_dir=None):
        self.http_port = http_port
        self.clips_dir = clips_dir
        self._latest_frame = None
        self._lock = threading.Lock()

        self.server = socketserver.ThreadingTCPServer(("0.0.0.0", http_port), MJPEGHandler)
        self.server.daemon_threads = True
        self.server.mjpeg_streamer = self  # handler reaches back to us for the latest frame
        self.server.clips_dir = clips_dir  # handler reaches this for /clips/<filename> requests

        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

        print(f"[mjpeg_stream] Streaming started. Dashboard should connect to: "
              f"http://<this-machine-lan-ip>:{http_port}/stream")

    def push_frame(self, frame):
        """Call once per frame from your main loop. Just updates a shared
        reference — cheap, no encoding happens here (encoding happens lazily
        per connected viewer in the handler, so cost only exists if someone
        is actually watching)."""
        with self._lock:
            self._latest_frame = frame

    def get_latest_frame(self):
        with self._lock:
            return self._latest_frame

    def stop(self):
        self.server.shutdown()
        print("[mjpeg_stream] Stopped.")


# -----------------------------------------------------------------------
# Example integration sketch
# -----------------------------------------------------------------------
if __name__ == "__main__":
    """
    streamer = MJPEGStreamer(http_port=8000)

    # --- inside your unified_detection.py frame loop, every frame ---
    # streamer.push_frame(frame)

    # --- on clean shutdown ---
    # streamer.stop()

    To view manually while testing (before the dashboard exists), open
    this URL directly in any browser:
        http://<this-machine-ip>:8000/stream
    """
    print("This module is meant to be imported into unified_detection.py — "
          "see the docstring above for the integration sketch.")
