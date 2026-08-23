"""
Vercel serverless entry point.

Wraps the existing Flask app from backend/sos_server.py.
All /api/* requests are forwarded to the SOS Flask app.
Static files (index.html etc.) are served by Vercel's filesystem.
"""
import sys
import os

# Ensure the project root is on the Python path so `backend.sos_server` resolves
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from flask import Flask, send_from_directory  # noqa: E402
from werkzeug.middleware.dispatcher import DispatcherMiddleware  # noqa: E402
from backend.sos_server import app as sos_app  # noqa: E402

# Serve index.html from the project root for any non-API request
frontend = Flask(__name__, static_folder=ROOT)

@frontend.route("/")
def index():
    return send_from_directory(ROOT, "index.html")

# Mount the SOS API under /api/*
# Vercel requires the top-level WSGI app to be named `app` — it won't pick
# up `handler` unless it's a class.
app = DispatcherMiddleware(frontend, {"/api": sos_app})
