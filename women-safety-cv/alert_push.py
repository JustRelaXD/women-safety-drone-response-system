"""
Instant alert push via WebSockets.

The dashboard opens ONE persistent connection to this server. The moment
fusion_engine.py reports CRITICAL, this server pushes a small JSON message
to every connected dashboard immediately — no polling, no delay waiting
for a refresh cycle. This is the "notify" half; mjpeg_stream.py is the
"show the video" half — they work together but are independent.

pip install websockets --break-system-packages

Runs its own asyncio event loop in a background thread, so it plugs into
your existing synchronous OpenCV frame loop without needing to rewrite
unified_detection.py as async.
"""

import asyncio
import json
import threading
import time

import websockets


class AlertPushServer:
    def __init__(self, ws_port=8765):
        self.ws_port = ws_port
        self._connected_clients = set()
        self._loop = None
        self._last_pushed_level = None  # avoid re-pushing the same level every frame

        self._ready = threading.Event()
        self.thread = threading.Thread(target=self._run_event_loop, daemon=True)
        self.thread.start()
        self._ready.wait(timeout=5)  # block briefly until the server is actually listening

        print(f"[alert_push] WebSocket server started. Dashboard should connect to: "
              f"ws://<this-machine-lan-ip>:{ws_port}")

    def _run_event_loop(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._start_server())

    async def _start_server(self):
        async def handler(websocket):
            self._connected_clients.add(websocket)
            try:
                await websocket.wait_closed()
            finally:
                self._connected_clients.discard(websocket)

        async with websockets.serve(handler, "0.0.0.0", self.ws_port):
            self._ready.set()
            await asyncio.Future()  # run forever

    def notify(self, fused_result, extra_info=None):
        """
        Call this once per frame from your main loop (cheap — it only
        actually sends a message when the alert level CHANGES, so calling
        it every frame is fine and simpler than tracking state yourself).

        fused_result: the dict from FusionEngine.update() this frame.
        extra_info:   optional dict merged into the pushed message —
                      e.g. which signals contributed, saved clip filename.
        """
        level_name = fused_result["alert_level"].name

        # only push when the level actually changes — avoids spamming the
        # dashboard with the same "CRITICAL" message every single frame
        # while an event is ongoing
        if level_name == self._last_pushed_level:
            return
        self._last_pushed_level = level_name

        message = {
            "type": "alert_level_change",
            "alert_level": level_name,
            "score": fused_result.get("score"),
            "contributing_signals": fused_result.get("contributing_signals", []),
            "corroborated": fused_result.get("corroborated", False),
            "timestamp": time.time(),
        }
        if extra_info:
            message.update(extra_info)

        if self._loop is not None:
            asyncio.run_coroutine_threadsafe(self._broadcast(message), self._loop)

    def notify_clip_ready(self, filename, reason, clip_base_url):
        """
        Call this once a clip finishes encoding (via output_layer.py's
        on_clip_saved callback). Separate message type from notify() —
        the dashboard needs to tell "alert started" apart from "here's
        the evidence clip", since they arrive at different times.
        """
        message = {
            "type": "clip_ready",
            "filename": filename,
            "reason": reason,
            "clip_url": f"{clip_base_url}/clips/{filename}",
            "timestamp": time.time(),
        }
        if self._loop is not None:
            asyncio.run_coroutine_threadsafe(self._broadcast(message), self._loop)

    async def _broadcast(self, message):
        if not self._connected_clients:
            return  # no dashboard connected yet — message is simply not sent, not queued
        payload = json.dumps(message)
        # send to all connected dashboards at once; if multiple control
        # rooms are watching later, they all get it simultaneously
        await asyncio.gather(
            *(client.send(payload) for client in self._connected_clients),
            return_exceptions=True,  # one disconnected client shouldn't break the others
        )

    def stop(self):
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._loop.stop)
        print("[alert_push] Stopped.")


# -----------------------------------------------------------------------
# Example integration sketch
# -----------------------------------------------------------------------
if __name__ == "__main__":
    """
    alert_push = AlertPushServer(ws_port=8765)   # instantiate once, outside your loop

    # --- inside your unified_detection.py frame loop, AFTER
    #     fused = fusion.update(...) this frame ---
    #
    # alert_push.notify(fused)

    Dashboard side (later), plain JavaScript, no libraries needed:
        const ws = new WebSocket("ws://<drone-ip>:8765");
        ws.onmessage = (event) => {
            const alert = JSON.parse(event.data);
            if (alert.alert_level === "CRITICAL") {
                // show the MJPEG stream, flash a banner, whatever the UI needs
            }
        };
    """
    print("This module is meant to be imported into unified_detection.py — "
          "see the docstring above for the integration sketch.")
