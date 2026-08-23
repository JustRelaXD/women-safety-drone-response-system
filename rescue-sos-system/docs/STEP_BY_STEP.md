# STEP BY STEP — Do This In Exact Order

Don't skip ahead. Each phase only makes sense once the previous one works.

---

## PHASE 1 — Get the backend (the "SOS system") running on your laptop

1. Install Python if you don't have it (you likely already do — check by
   opening a terminal and typing `python3 --version`).
2. Open a terminal in the `backend/` folder.
3. Run:
   ```bash
   pip install flask
   python3 sos_server.py
   ```
4. You should see it print something like `Running on http://0.0.0.0:5000`.
   Leave this terminal open — this is your SOS system, now running.
5. **Find your laptop's local IP address** (you'll need this in Phase 2):
   - Windows: open a new terminal, type `ipconfig`, look for "IPv4 Address"
     — something like `192.168.1.42`.
   - Mac: System Settings → Wi-Fi → Details, or run `ifconfig | grep inet`.
6. **Test it works**, without the phone at all — in a browser on your
   laptop, go to `http://localhost:5000/status`. You should see JSON with
   3 drones listed, all "available." If you see that, Phase 1 is done.

---

## PHASE 2 — Build the Android app

1. Install **Android Studio** (free, from developer.android.com/studio) if
   you don't have it. This is the only tool you need — it includes
   everything else (Kotlin, the Android build system, an emulator if you
   want one).
2. Open Android Studio → **Open** → select the `android-app` folder from
   what I gave you.
3. Let it "Gradle sync" — this takes a few minutes the first time
   (downloading build tools). Just wait for it to finish; you'll see a
   progress bar at the bottom.
4. Open `MainActivity.kt` and find this line:
   ```kotlin
   intent.putExtra("sosApiUrl", "http://YOUR_LAPTOP_IP:5000/sos")
   ```
   Replace `YOUR_LAPTOP_IP` with the real IP address from Phase 1, step 5.
   Example: `http://192.168.1.42:5000/sos`.
5. **Connect your real Android phone to your laptop with a USB cable.**
   - On your phone: Settings → About Phone → tap "Build Number" 7 times
     (this unlocks Developer Options).
   - Settings → Developer Options → turn on "USB Debugging."
   - Your phone will pop up "Allow USB debugging?" — tap Allow.
6. In Android Studio, you should now see your phone's name in the device
   dropdown at the top. Click the green **Run ▶** button.
7. The app installs and opens on your actual phone. You'll see one button:
   "Turn Protection ON."

**Important — your phone and laptop must be on the same WiFi network**
for the phone to reach your laptop's server. If your phone is on mobile
data, this won't work — turn on WiFi and connect to the same network your
laptop is using.

---

## PHASE 3 — Test the whole thing together

1. Both should be running right now: `sos_server.py` in a terminal, and
   the Rescue SOS app open on your phone.
2. On the phone, tap **"Turn Protection ON."**
3. It will ask for permissions (location, notifications) — allow them.
4. You'll see a notification appear: "Rescue SOS protection active." This
   proves the background service is actually running.
5. **Lock your phone** (press the power button — screen off).
6. **Shake the phone firmly, 3 times, within about 2 seconds.**
7. Look at your laptop's terminal running `sos_server.py` — you should see
   a new line print:
   ```
   [SOS] Received from demo-user-1 at (...) -> dispatching DRONE-1
   ```
   That line appearing is proof the entire chain worked: locked phone →
   shake detected → SOS sent → backend received it → nearest drone chosen.
8. Refresh `http://localhost:5000/status` in your laptop's browser — you'll
   see `DRONE-1`'s status is now `"dispatched"`, and your SOS event listed
   under `recent_sos_events`.

---

## If step 7 doesn't print anything

Work through these in order — the fix is almost always in one of these:

- **Nothing at all happens, no notification even appears** → the app
  crashed on the permission step. Go back to Android Studio, look at the
  "Logcat" panel at the bottom (this shows live error messages from your
  phone) for a red error line.
- **Notification appears, but shaking does nothing** → your shake isn't
  hard enough to cross `magnitudeThreshold = 18f` in
  `ShakeForegroundService.kt`. Try shaking harder, or lower that number to
  `14f` and re-run from Android Studio.
- **You see an error in Logcat about `UnknownHostException` or
  `ConnectException`** → your phone can't reach your laptop. Double-check
  both are on the same WiFi, and that you replaced `YOUR_LAPTOP_IP`
  correctly.
- **Terminal shows the SOS arriving, but with `latitude: 0.0`** → location
  permission wasn't granted, or GPS hasn't gotten a location fix yet
  indoors — this is a real GPS limitation, not a bug; test near a window
  or outdoors for a real coordinate.

---

## Live location — how to test it

The app now sends a location update every 15 seconds just from Protection
being ON, and every 4 seconds once an SOS is active (not just once, at the
moment of the shake). To see this working:

1. Turn Protection ON, then check `http://localhost:5000/status` — after
   ~15 seconds you won't see anything yet (no mission exists until an SOS
   fires — `/location` updates `LIVE_LOCATIONS` internally, but `/status`
   only shows it once it's attached to an `active_missions` entry).
2. Trigger a real SOS (shake 3x). Now refresh `/status` — you'll see an
   `active_missions` entry with a `current_location`.
3. **Physically walk around with the phone** for a minute or two, then
   refresh `/status` again — `current_location` should have changed to
   match where you actually walked, updating roughly every 4 seconds. This
   is what proves live tracking (not just a one-time snapshot) is working.
4. When you're done testing a mission, call:
   ```bash
   curl -X POST http://localhost:5000/sos/resolve -H "Content-Type: application/json" -d '{"user_id":"demo-user-1"}'
   ```
   This frees the drone back to "available" so you can run another test
   SOS without restarting the server.

## Where the dashboard fits in

Your friend's SAFESKIES webpage should call
`http://YOUR_LAPTOP_IP:5000/status` every few seconds (a simple
`fetch()` in JavaScript, repeated with `setInterval`) and display whatever
comes back — that single `/status` endpoint is the entire connection
between your phone app and her dashboard. Once this is working, share that
endpoint's shape with her; you don't need to touch her webpage code
yourself.

## What's left after this works

- Right now `/sos`'s drone list is 3 fake fixed positions. Swapping those
  for real drone GPS data later is a change only inside `sos_server.py` —
  nothing on the phone app changes.
- Deploying `sos_server.py` somewhere other than your laptop (so it works
  off your home WiFi, e.g. at the actual hackathon venue) is a separate,
  smaller step once this works locally — ask if you want that walked
  through when you get there.
