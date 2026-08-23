import sounddevice as sd
import numpy as np
import tensorflow as tf
import tensorflow_hub as hub
import csv
import time
from collections import deque

print("Loading YAMNet model...")
yamnet_model = hub.load('https://tfhub.dev/google/yamnet/1')

class_map_path = yamnet_model.class_map_path().numpy()
class_names = []
with tf.io.gfile.GFile(class_map_path) as f:
    reader = csv.DictReader(f)
    for row in reader:
        class_names.append(row['display_name'])

# --- The categories we actually care about ---
# These are exact display names from YAMNet's AudioSet label list.
DISTRESS_CLASSES = {
    "Screaming",
    "Shout",
    "Yell",
    "Crying, sobbing",
    "Wail, moan",
    "Battle cry",
    "Children shouting",
}

DISTRESS_INDICES = [i for i, name in enumerate(class_names) if name in DISTRESS_CLASSES]
print(f"Watching for {len(DISTRESS_INDICES)} distress-related sound classes: {DISTRESS_CLASSES}")

SAMPLE_RATE = 16000
DURATION = 1.5  # shorter chunk = faster reaction time than the 2s test version

# Rolling history of distress confidence, for smoothing over a few chunks
distress_score_history = deque(maxlen=3)

DISTRESS_CONFIDENCE_THRESHOLD = 0.15  # per-chunk score needed to count as "possible distress"
ALERT_CONSISTENCY_REQUIRED = 2        # how many of the last N chunks must trigger to raise a real alert

audio_alert_active = False

print("Listening for distress sounds... (Ctrl+C to stop)")

while True:
    audio_chunk = sd.rec(int(DURATION * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype='float32')
    sd.wait()
    waveform = audio_chunk.flatten()

    scores, embeddings, spectrogram = yamnet_model(waveform)
    mean_scores = scores.numpy().mean(axis=0)

    # Sum confidence across just our distress-relevant classes
    distress_score = sum(mean_scores[i] for i in DISTRESS_INDICES)
    distress_score_history.append(distress_score > DISTRESS_CONFIDENCE_THRESHOLD)

    # Alert only if enough recent chunks agree — avoids single-chunk false positives
    recent_triggers = sum(distress_score_history)
    audio_alert_active = recent_triggers >= ALERT_CONSISTENCY_REQUIRED

    # Show what's actually being heard right now, for tuning purposes
    top_idx = mean_scores.argmax()
    status = "🔴 DISTRESS ALERT" if audio_alert_active else "  normal"
    print(f"{status} | distress_score={distress_score:.3f} | top sound: {class_names[top_idx]} ({mean_scores[top_idx]:.2f})")