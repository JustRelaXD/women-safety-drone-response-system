import sounddevice as sd
import numpy as np
import tensorflow as tf
import tensorflow_hub as hub
import csv
import json
import time
from collections import deque
from distress_keywords import KeywordDistressDetector

print("Loading YAMNet...")
yamnet_model = hub.load('https://tfhub.dev/google/yamnet/1')

class_map_path = yamnet_model.class_map_path().numpy()
class_names = []
with tf.io.gfile.GFile(class_map_path) as f:
    reader = csv.DictReader(f)
    for row in reader:
        class_names.append(row['display_name'])

keyword_detector = KeywordDistressDetector() 

DISTRESS_CLASSES = {
    "Screaming", "Shout", "Yell", "Crying, sobbing",
    "Wail, moan", "Children shouting",
}
DISTRESS_INDICES = [i for i, name in enumerate(class_names) if name in DISTRESS_CLASSES]

SAMPLE_RATE = 16000
DURATION = 1.5
DISTRESS_CONFIDENCE_THRESHOLD = 0.15
ALERT_CONSISTENCY_REQUIRED = 2

distress_score_history = deque(maxlen=3)

print("Audio service running, listening...")

while True:
    
    audio_chunk = sd.rec(int(DURATION * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype='float32')
    sd.wait()
    waveform = audio_chunk.flatten()
    kw_result = keyword_detector.update(waveform)

    scores, embeddings, spectrogram = yamnet_model(waveform)
    mean_scores = scores.numpy().mean(axis=0)

    distress_score = float(sum(mean_scores[i] for i in DISTRESS_INDICES))
    distress_score_history.append(distress_score > DISTRESS_CONFIDENCE_THRESHOLD)

    recent_triggers = sum(distress_score_history)
    audio_alert_active = recent_triggers >= ALERT_CONSISTENCY_REQUIRED

    top_idx = mean_scores.argmax()

    state = {
        "audio_alert": bool(audio_alert_active) or kw_result["keyword_alert"],
        "audio_top_sound": class_names[top_idx],
        "audio_score": distress_score,
        "keyword_alert": kw_result["keyword_alert"],
        "keyword_text": kw_result["text"],
        "matched_keywords": kw_result["matched_keywords"],
        "timestamp": time.time()
    }

    # Write atomically-ish: write to temp file then rename, avoids reading a half-written file
    with open("shared_state.json.tmp", "w") as f:
        json.dump(state, f)
    import os
    os.replace("shared_state.json.tmp", "shared_state.json")

    print(f"audio: {state['audio_top_sound']} (distress_score={distress_score:.2f}, alert={audio_alert_active})")