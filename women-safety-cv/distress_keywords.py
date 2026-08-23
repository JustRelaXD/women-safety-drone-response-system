"""
Step 20: Speech-to-text distress keyword detection.

Runs alongside your existing YAMNet distress classifier in audio_service.py
— same process, same environment (Whisper uses PyTorch, so it coexists
fine with tensorflow_hub; the conflict you hit earlier was specifically
mediapipe vs tensorflow protobuf versions, which doesn't apply here).

Design choice: uses faster-whisper (CTranslate2-based reimplementation)
rather than openai-whisper. Same model weights, same accuracy — but
meaningfully faster CPU inference, which matters since this is runningss
continuously alongside YAMNet on (eventually) drone-constrained hardware.

pip install faster-whisper --break-system-packages

Model size tradeoff:
"tiny.en"  - fastest, least accurate, English-only. Good starting point.
"base.en"  - still fast, noticeably better accuracy. Recommended default.
"small.en" - meaningfully better, meaningfully slower. Consider once you
            have real drone hardware specs and know your compute budget.
"""

import numpy as np
from collections import deque
from faster_whisper import WhisperModel


# -----------------------------------------------------------------------
# Distress keyword set
# -----------------------------------------------------------------------
# Split into tiers like your audio distress categories: direct calls for
# help are unambiguous, others are supporting context that raise
# confidence when combined with other signals rather than firing alone.
DISTRESS_KEYWORDS = {
    "high_priority": [
        "help", "help me", "call the police", "call police",
        "somebody help", "someone help", "let go of me", "get off me",
    ],
    "supporting": [
        "stop", "no stop", "please stop", "please don't",
        "leave me alone", "don't touch me",
    ],
}


class KeywordDistressDetector:
    def __init__(
        self,
        model_size="base.en",
        device="cpu",
        compute_type="int8",       # int8 = fastest CPU inference, small accuracy tradeoff
        sustain_hits=1,            # keyword detections needed within window
        window_chunks=3,
    ):
        """
        model_size/device/compute_type: passed straight to faster-whisper.
        sustain_hits: unlike the fall/audio detectors, we DON'T require
                    repetition by default — a single clear "help me" or
                    "call the police" is meaningful on its own, unlike a
                    single loud audio spike. Raise this if you're seeing
                    false positives from misheard words.
        window_chunks: how many recent transcription chunks we remember
                    for the sustain check.
        """
        print(f"[distress_keywords] Loading Whisper ({model_size}, {device}, {compute_type})...")
        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)

        self.sustain_hits = sustain_hits
        self.history = deque(maxlen=window_chunks)  # bool per chunk

        # flatten keyword tiers into one lookup: keyword -> tier
        self.keyword_tier = {}
        for tier, words in DISTRESS_KEYWORDS.items():
            for w in words:
                self.keyword_tier[w] = tier

    def transcribe_chunk(self, audio_chunk, sample_rate=16000):
        """
        audio_chunk: 1D float32 numpy array, same chunk you're already
                capturing via sounddevice for YAMNet (resample to
                    16kHz first if your capture rate differs — Whisper
                    expects 16kHz).
        sample_rate: sanity-checked, not currently used to resample —
                    resample upstream in your capture code if needed.

        Returns: (text, matched_keywords, tier) — text is the raw
                transcription (useful for logging/debugging even when no
                keyword matches), matched_keywords is a list of hits,
                tier is the highest-priority tier matched or None.
        """
        segments, info = self.model.transcribe(
            audio_chunk,
            language="en",
            beam_size=1,           # greedy decoding — faster, fine for short chunks
            vad_filter=True,       # skip silence, avoids hallucinated text on quiet audio
        )

        text = " ".join(seg.text for seg in segments).strip().lower()

        matched = []
        best_tier = None
        for keyword, tier in self.keyword_tier.items():
            if keyword in text:
                matched.append(keyword)
                if best_tier is None or (tier == "high_priority"):
                    best_tier = tier

        return text, matched, best_tier

    def update(self, audio_chunk, sample_rate=16000):
        """
        Full pipeline: transcribe + keyword match + sustain check.

        Returns: {
            "keyword_alert": bool,
            "text": str,               # raw transcription, always returned
            "matched_keywords": list,
            "tier": str or None,
        }
        """
        text, matched, tier = self.transcribe_chunk(audio_chunk, sample_rate)

        chunk_hit = len(matched) > 0
        self.history.append(chunk_hit)

        alert = sum(self.history) >= self.sustain_hits

        return {
            "keyword_alert": alert,
            "text": text,
            "matched_keywords": matched,
            "tier": tier,
        }


# -----------------------------------------------------------------------
# Example integration into your existing audio_service.py
# -----------------------------------------------------------------------
if __name__ == "__main__":
    """
    Sketch — adapt to your real audio_service.py chunk-capture loop.
    You already have a 2-sec chunk loop feeding YAMNet; add this as a
    second check on the SAME chunk (no extra mic capture needed):

    from distress_keywords import KeywordDistressDetector

    keyword_detector = KeywordDistressDetector()   # load once, outside loop

    # --- inside your existing while-loop, same chunk you feed YAMNet ---
    # kw_result = keyword_detector.update(audio_chunk)
    # if kw_result["keyword_alert"]:
    #     print(f"KEYWORD ALERT: '{kw_result['text']}' "
    #           f"matched {kw_result['matched_keywords']} ({kw_result['tier']})")
    #
    # Then merge into the same JSON state file your YAMNet alert already
    # writes to, e.g.:
    #   state = {
    #       "yamnet_alert": yamnet_result["distress_alert"],
    #       "yamnet_category": yamnet_result["category"],
    #       "keyword_alert": kw_result["keyword_alert"],
    #       "keyword_text": kw_result["text"],
    #       "matched_keywords": kw_result["matched_keywords"],
    #       "timestamp": time.time(),
    #   }
    #   json.dump(state, open(SHARED_STATE_PATH, "w"))
    # ---------------------------------------------------------------------
    """
    print("This module is meant to be imported into audio_service.py — "
        "see the docstring above for the integration sketch.")