"""
Step 19: Distress audio detection built on top of your Step 18 YAMNet pipeline.

What this adds over 18b:
1. Pulls YAMNet's real class list at load time (no hardcoded indices —
    if Google ever reorders/updates class_map.csv, this still works).
2. Filters that list down to a curated set of distress-relevant categories.
3. Applies fall-detector-style two-condition alerting:
    - confidence above a threshold
    - AND sustained across N consecutive chunks (cuts down one-off false
        positives from a single loud bang, door slam, etc.)
4. Exposes a clean `check_distress(scores)` call you can drop into your
    existing 2-second-chunk loop in place of your current top-3 print.

Integration: import DistressDetector, instantiate once, call .update(scores)
each chunk. scores = the raw YAMNet output array you already have from 18b.
"""

import numpy as np
import csv
import io
import urllib.request
from collections import deque


# -----------------------------------------------------------------------
# 1. Curated distress category list
# -----------------------------------------------------------------------
# These are matched by *display_name* against YAMNet's class_map.csv, so we
# never have to hardcode index numbers. Split into two tiers:
#   HIGH_PRIORITY  -> unambiguous distress sounds, lower confidence threshold ok
#   SUPPORTING     -> could be distress but noisier/more ambiguous, needs
#                     higher confidence or should mainly boost a high-priority hit
DISTRESS_CATEGORIES = {
    "high_priority": [
        "Screaming",
        "Shout",
        "Yell",
        "Crying, sobbing",
        "Wail, moan",
        "Children shouting",
    ],
    "supporting": [
        "Whimper",
        "Groan",
        "Battle cry",
        "Shriek",
        "Fear",
        "Bellow",
    ],
}


# -----------------------------------------------------------------------
# 2. Load YAMNet's actual class map (run once at startup)
# -----------------------------------------------------------------------
def load_yamnet_class_names(yamnet_model):
    """
    yamnet_model: the loaded tensorflow_hub YAMNet model (same object you
    already created in Step 18b via hub.load(...)).

    Returns: list of 521 display names, index-aligned with model output.
    """
    class_map_path = yamnet_model.class_map_path().numpy().decode("utf-8")

    # class_map_path is a local file path baked into the model asset,
    # e.g. .../assets/yamnet_class_map.csv
    class_names = []
    with open(class_map_path, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            class_names.append(row["display_name"])
    return class_names


def build_distress_index_map(class_names):
    """
    Matches our curated category names against the model's actual class
    list and returns {index: (name, tier)}. Prints a warning if any
    curated name isn't found (naming can drift slightly between YAMNet
    releases, so this is worth checking once at setup).
    """
    name_to_index = {name: i for i, name in enumerate(class_names)}
    index_map = {}

    for tier, names in DISTRESS_CATEGORIES.items():
        for name in names:
            if name in name_to_index:
                index_map[name_to_index[name]] = (name, tier)
            else:
                print(f"[distress_audio] WARNING: category '{name}' not found "
                    f"in YAMNet class list — check spelling against class_map.csv")

    return index_map


# -----------------------------------------------------------------------
# 3. Two-condition alert logic (mirrors your fall detector pattern)
# -----------------------------------------------------------------------
class DistressDetector:
    def __init__(
        self,
        yamnet_model,
        high_priority_conf=0.35,
        supporting_conf=0.50,
        sustain_chunks=2,
        window_chunks=5,
    ):
        """
        high_priority_conf: confidence threshold for high_priority categories
                            (lower bar — these are already fairly unambiguous)
        supporting_conf:    confidence threshold for supporting categories
                            (higher bar — more prone to false positives)
        sustain_chunks:     how many chunks (out of the trailing window) must
                            cross threshold before we fire an alert. Since
                            each chunk is ~2s, sustain_chunks=2 means ~4s of
                            sustained distress sound, not a single spike.
        window_chunks:      size of the rolling window we check sustain over.
        """
        self.class_names = load_yamnet_class_names(yamnet_model)
        self.index_map = build_distress_index_map(self.class_names)

        self.high_priority_conf = high_priority_conf
        self.supporting_conf = supporting_conf
        self.sustain_chunks = sustain_chunks

        # rolling window of "did this chunk hit any distress category" bools,
        # plus which category, so we can report *what* sustained
        self.history = deque(maxlen=window_chunks)

        self.alert_active = False

    def update(self, scores):
        """
        scores: 1D numpy array of length 521 (YAMNet's output for the
                current 2-sec chunk — same object you already compute in
                Step 18b, e.g. scores.numpy().mean(axis=0)).

        Returns a dict:
            {
            "distress_alert": bool,
              "chunk_hit": bool,          # did *this* chunk cross threshold
            "category": str or None,    # top matching category this chunk
            "confidence": float or None,
            "tier": "high_priority"/"supporting"/None
            }
        """
        chunk_hit = False
        hit_category = None
        hit_confidence = None
        hit_tier = None

        # check every distress category present in this chunk's scores,
        # keep the strongest one that clears its tier's threshold
        best_score = -1.0
        for idx, (name, tier) in self.index_map.items():
            conf = float(scores[idx])
            threshold = (
                self.high_priority_conf if tier == "high_priority"
                else self.supporting_conf
            )
            if conf >= threshold and conf > best_score:
                best_score = conf
                chunk_hit = True
                hit_category = name
                hit_confidence = conf
                hit_tier = tier

        self.history.append(chunk_hit)

        # sustain check: need >= sustain_chunks True's in the trailing window
        sustained_count = sum(self.history)
        self.alert_active = sustained_count >= self.sustain_chunks

        return {
            "distress_alert": self.alert_active,
            "chunk_hit": chunk_hit,
            "category": hit_category,
            "confidence": hit_confidence,
            "tier": hit_tier,
        }


# -----------------------------------------------------------------------
# 4. Example integration (adapt to your actual Step 18b loop)
# -----------------------------------------------------------------------
if __name__ == "__main__":
    """
    Drop-in replacement sketch for your 18b loop. This assumes you already
    have `yamnet_model` loaded via tensorflow_hub and a working mic capture
    chunk loop from 18a — this file only adds the filtering/alert layer,
    it doesn't re-implement mic capture.
    """
    import tensorflow_hub as hub

    print("Loading YAMNet...")
    yamnet_model = hub.load("https://tfhub.dev/google/yamnet/1")

    detector = DistressDetector(yamnet_model)

    print(f"Tracking {len(detector.index_map)} distress categories:")
    for idx, (name, tier) in detector.index_map.items():
        print(f"  [{tier}] {name} (class index {idx})")

    # --- replace this block with your real 18a/18b chunk-capture loop ---
    # waveform = <your 2-sec audio chunk as float32 numpy array, 16kHz>
    # scores, embeddings, spectrogram = yamnet_model(waveform)
    # scores = scores.numpy().mean(axis=0)   # average over the chunk
    # result = detector.update(scores)
    # if result["distress_alert"]:
    #     print(f"DISTRESS ALERT: {result['category']} "
    #           f"({result['confidence']:.2f}, {result['tier']})")
    # ----------------------------------------------------------------------
