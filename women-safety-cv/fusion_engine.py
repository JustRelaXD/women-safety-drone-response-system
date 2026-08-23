"""
Step 1 (final piece): Fusion / intensity layer.

Combines all six signals you now have working:
  - fall            (vision, per-person)
  - running         (vision, per-person)
  - chase           (vision, pairwise)
  - violence        (vision, pairwise, pose-heuristic — documented as
                      medium-confidence-alone in violence_detection.py)
  - audio distress  (YAMNet, via shared JSON state from audio_service.py)
  - keyword distress (Whisper, via same shared JSON state)

...into ONE alert level with a numeric score, using:
  1. Per-signal severity weights (not all signals are equally trustworthy)
  2. A cross-modal corroboration bonus (two independent modalities agreeing
     in the same time window is stronger evidence than either alone)
  3. Asymmetric debounce — escalates fast (1-2 frames), de-escalates slow
     (several consecutive clear frames) — because for a safety system, a
     missed real event is worse than a few extra seconds of lingering alert.

This module does NOT replace your existing per-detector alert dict or your
HUD's individual readout panels — those still show raw detector state.
This SITS ON TOP of them and produces the single banner-level decision.
"""

import time
from collections import deque
from enum import Enum


class AlertLevel(Enum):
    NONE = 0
    LOW = 1
    MEDIUM = 2
    CRITICAL = 3


# -----------------------------------------------------------------------
# Signal severity weights
# -----------------------------------------------------------------------
# Score contributed to the fusion total when a signal is active THIS frame.
# These are starting points, not calibrated — expect to tune after watching
# real footage, same as every other threshold in this project.
SIGNAL_WEIGHTS = {
    "fall": 70,
    "chase": 65,
    "audio_high_priority": 70,     # YAMNet: Screaming, Shout, Yell, Crying, etc.
    "audio_supporting": 30,        # YAMNet: Whimper, Groan, etc.
    "keyword_high_priority": 75,   # Whisper: "help me", "call the police"
    "keyword_supporting": 25,      # Whisper: "stop", "leave me alone"
    "violence": 45,                # deliberately capped below fall/chase alone,
                                    # per its own documented reliability limits
    "running": 15,                 # weak alone — joggers exist
}

# Alert level thresholds on the final fused score (0-100 scale, can exceed
# 100 briefly with corroboration bonus — clamp before display if needed)
LEVEL_THRESHOLDS = {
    AlertLevel.CRITICAL: 70,
    AlertLevel.MEDIUM: 40,
    AlertLevel.LOW: 15,
    # anything below LOW threshold = NONE
}

CORROBORATION_BONUS = 20  # added when 2+ independent modalities agree


class FusionEngine:
    def __init__(
        self,
        escalate_frames=1,      # frames needed at a level before we escalate TO it
        deescalate_frames=8,    # frames needed CLEAR before we drop level
        corroboration_window=3.0,  # seconds — how "same time window" is defined
    ):
        self.escalate_frames = escalate_frames
        self.deescalate_frames = deescalate_frames
        self.corroboration_window = corroboration_window

        self.current_level = AlertLevel.NONE
        self.score_history = deque(maxlen=max(escalate_frames, deescalate_frames) + 1)

        # recent-signal log for corroboration checking: list of (signal_name, timestamp)
        self.recent_signals = deque(maxlen=50)

        # how many consecutive frames the CANDIDATE level (not yet committed)
        # has been proposed — separate counters for escalate vs de-escalate
        self._pending_level = AlertLevel.NONE
        self._pending_count = 0

    def _classify_audio(self, audio_state):
        """audio_state: the dict read from your shared JSON file."""
        active = []
        if audio_state.get("yamnet_alert"):
            category = audio_state.get("yamnet_category", "")
            # you can refine this by importing DISTRESS_CATEGORIES from
            # distress_audio.py and checking tier directly if you want it
            # exact rather than inferred — kept simple here
            active.append(("audio_high_priority", SIGNAL_WEIGHTS["audio_high_priority"]))
        if audio_state.get("keyword_alert"):
            active.append(("keyword_high_priority", SIGNAL_WEIGHTS["keyword_high_priority"]))
        return active

    def update(self, vision_alerts, audio_state, timestamp=None):
        """
        vision_alerts: your existing alerts dict from unified_detection.py,
                        e.g. {"fall": bool, "running_ids": [...], "chase": bool,
                              "chase_pair": (...), "violence": bool,
                              "violence_pair": (...)}
        audio_state:    the dict read from your shared JSON file this frame,
                        e.g. {"yamnet_alert": bool, "yamnet_category": str,
                              "keyword_alert": bool, "keyword_text": str, ...}
        timestamp:      seconds, defaults to time.time()

        Returns: {
            "alert_level": AlertLevel,
            "score": float,
            "contributing_signals": list[str],
            "corroborated": bool,
        }
        """
        if timestamp is None:
            timestamp = time.time()

        active_signals = []  # list of (name, weight)

        if vision_alerts.get("fall"):
            active_signals.append(("fall", SIGNAL_WEIGHTS["fall"]))
        if vision_alerts.get("chase"):
            active_signals.append(("chase", SIGNAL_WEIGHTS["chase"]))
        if vision_alerts.get("violence"):
            active_signals.append(("violence", SIGNAL_WEIGHTS["violence"]))
        if vision_alerts.get("running_ids"):
            active_signals.append(("running", SIGNAL_WEIGHTS["running"]))

        active_signals.extend(self._classify_audio(audio_state))

        # log every active signal this frame for corroboration lookback
        for name, _ in active_signals:
            self.recent_signals.append((name, timestamp))

        # prune old entries outside the corroboration window
        while (self.recent_signals and
               timestamp - self.recent_signals[0][1] > self.corroboration_window):
            self.recent_signals.popleft()

        # corroboration check: do we have signals from 2+ DIFFERENT
        # modality groups within the window? (vision vs audio vs speech)
        modality_map = {
            "fall": "vision", "chase": "vision", "violence": "vision", "running": "vision",
            "audio_high_priority": "audio", "audio_supporting": "audio",
            "keyword_high_priority": "speech", "keyword_supporting": "speech",
        }
        modalities_present = {modality_map[name] for name, _ in self.recent_signals}
        corroborated = len(modalities_present) >= 2

        raw_score = sum(weight for _, weight in active_signals)
        if corroborated and active_signals:
            raw_score += CORROBORATION_BONUS

        self.score_history.append(raw_score)

        # determine what level this frame's score WOULD justify
        candidate_level = AlertLevel.NONE
        for level in (AlertLevel.CRITICAL, AlertLevel.MEDIUM, AlertLevel.LOW):
            if raw_score >= LEVEL_THRESHOLDS[level]:
                candidate_level = level
                break

        self._apply_hysteresis(candidate_level)

        return {
            "alert_level": self.current_level,
            "score": raw_score,
            "contributing_signals": [name for name, _ in active_signals],
            "corroborated": corroborated,
        }

    def _apply_hysteresis(self, candidate_level):
        """
        Asymmetric debounce: escalating (going to a HIGHER level than
        current) needs only `escalate_frames` consecutive frames.
        De-escalating (going to a LOWER level) needs `deescalate_frames`
        consecutive frames. This is deliberately lopsided — safety system,
        false negatives cost more than a lingering alert.
        """
        is_escalation = candidate_level.value > self.current_level.value
        required_frames = self.escalate_frames if is_escalation else self.deescalate_frames

        if candidate_level == self._pending_level:
            self._pending_count += 1
        else:
            self._pending_level = candidate_level
            self._pending_count = 1

        if self._pending_count >= required_frames:
            self.current_level = candidate_level


# -----------------------------------------------------------------------
# HUD color mapping — matches your existing green/orange/red banner scheme
# -----------------------------------------------------------------------
LEVEL_COLOR = {
    AlertLevel.NONE: (0, 200, 0),        # green (BGR, since you're in OpenCV)
    AlertLevel.LOW: (0, 200, 0),         # still green — informational only
    AlertLevel.MEDIUM: (0, 165, 255),    # orange
    AlertLevel.CRITICAL: (0, 0, 255),    # red
}


# -----------------------------------------------------------------------
# Example integration sketch
# -----------------------------------------------------------------------
if __name__ == "__main__":
    """
    fusion = FusionEngine()   # instantiate once, outside your frame loop

    # --- inside your unified_detection.py frame loop, after you've
    #     already built `alerts` (Step 16 style) and read the shared
    #     audio JSON state (Step 18/20 style) ---
    #
    # fused = fusion.update(alerts, audio_state, frame_timestamp)
    #
    # banner_color = LEVEL_COLOR[fused["alert_level"]]
    # banner_text = f"{fused['alert_level'].name}"
    # if fused["corroborated"]:
    #     banner_text += " (corroborated)"
    #
    # # your flashing red border condition becomes:
    # if fused["alert_level"] == AlertLevel.CRITICAL:
    #     draw_flashing_border(frame)
    #
    # # detail line can still show raw contributing signals:
    # detail_text = ", ".join(fused["contributing_signals"])
    """
    print("This module is meant to be imported into unified_detection.py — "
          "see the docstring above for the integration sketch.")
