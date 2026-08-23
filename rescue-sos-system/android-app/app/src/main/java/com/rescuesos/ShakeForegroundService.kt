/**
 * ShakeForegroundService.kt
 *
 * Watches for a shake pattern, even while the phone is locked,
 * and sends the SOS to the backend.
 *
 * It also sends the phone's live location to the backend while
 * Protection is ON.
 */

package com.rescuesos

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlin.math.abs
import kotlin.math.sqrt
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject


class ShakeForegroundService : Service(),
    SensorEventListener,
    LocationListener {

    // ---------------------------------------------------------
    // SENSOR / LOCATION
    // ---------------------------------------------------------

    private lateinit var sensorManager: SensorManager
    private var accelerometer: Sensor? = null
    private var locationManager: LocationManager? = null

    // ---------------------------------------------------------
    // BACKEND
    // ---------------------------------------------------------

    private var sosApiUrl: String = ""
    private var locationApiUrl: String = ""
    private var userId: String = ""

    // ---------------------------------------------------------
    // LIVE LOCATION SETTINGS
    // ---------------------------------------------------------

    private var missionActive = false

    // Send location every 15 seconds normally
    private val normalSendIntervalMs = 15000L

    // Send location every 4 seconds during active SOS
    private val activeMissionSendIntervalMs = 4000L

    private var lastLocationSentAt = 0L
    private var latestLocation: Location? = null

    // ---------------------------------------------------------
    // SHAKE DETECTION SETTINGS
    // ---------------------------------------------------------

    /*
     * Instead of checking the total acceleration,
     * we check how much the acceleration changes.
     *
     * Lower value = easier to trigger.
     *
     * 3.0f is intentionally sensitive for testing.
     */
    private val magnitudeThreshold = 3.0f

    /*
     * Prevent one physical shake from being counted
     * several times.
     */
    private val cooldownMs = 400L

    /*
     * Three shakes must happen within 3.5 seconds.
     */
    private val windowMs = 3500L

    /*
     * Number of shakes required to trigger SOS.
     */
    private val requiredShakeCount = 3

    /*
     * Stores the timestamps of detected shakes.
     */
    private val recentShakeTimestamps = mutableListOf<Long>()

    /*
     * Time when the previous shake was counted.
     */
    private var lastCountedAt = 0L

    /*
     * Previous acceleration magnitude.
     */
    private var previousMagnitude = 0f

    // ---------------------------------------------------------
    // NOTIFICATION
    // ---------------------------------------------------------

    companion object {
        const val CHANNEL_ID = "sos_shake_monitor"
        const val NOTIFICATION_ID = 1001
    }

    // ---------------------------------------------------------
    // SERVICE CREATED
    // ---------------------------------------------------------

    override fun onCreate() {
        super.onCreate()

        // Get sensor manager
        sensorManager =
            getSystemService(Context.SENSOR_SERVICE) as SensorManager

        // Get accelerometer
        accelerometer =
            sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

        // Get location manager
        locationManager =
            getSystemService(Context.LOCATION_SERVICE) as LocationManager

        // Debug information
        if (accelerometer == null) {
            android.util.Log.e(
                "ShakeSOS",
                "NO ACCELEROMETER FOUND ON THIS DEVICE"
            )
        } else {
            android.util.Log.i(
                "ShakeSOS",
                "Accelerometer found successfully"
            )
        }
    }

    // ---------------------------------------------------------
    // SERVICE STARTED
    // ---------------------------------------------------------

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int
    ): Int {

        // Get backend SOS URL
        sosApiUrl =
            intent?.getStringExtra("sosApiUrl") ?: ""

        // Automatically create /location URL
        locationApiUrl =
            sosApiUrl.removeSuffix("/sos") + "/location"

        // Get user ID
        userId =
            intent?.getStringExtra("userId") ?: "unknown"

        android.util.Log.i(
            "ShakeSOS",
            "Service started"
        )

        android.util.Log.i(
            "ShakeSOS",
            "SOS URL: $sosApiUrl"
        )

        android.util.Log.i(
            "ShakeSOS",
            "Location URL: $locationApiUrl"
        )

        android.util.Log.i(
            "ShakeSOS",
            "User ID: $userId"
        )

        // Start foreground notification
        startForeground(
            NOTIFICATION_ID,
            buildNotification()
        )

        // Register accelerometer listener
        accelerometer?.also { sensor ->

            sensorManager.registerListener(
                this,
                sensor,
                SensorManager.SENSOR_DELAY_GAME
            )

            android.util.Log.i(
                "ShakeSOS",
                "Accelerometer listener registered"
            )
        }

        // Start location tracking
        startLocationUpdates()

        return START_STICKY
    }

    // ---------------------------------------------------------
    // SERVICE DESTROYED
    // ---------------------------------------------------------

    override fun onDestroy() {

        android.util.Log.i(
            "ShakeSOS",
            "Service destroyed"
        )

        sensorManager.unregisterListener(this)

        locationManager?.removeUpdates(this)

        super.onDestroy()
    }

    // ---------------------------------------------------------
    // LOCATION
    // ---------------------------------------------------------

    private fun startLocationUpdates() {

        val manager = locationManager ?: return

        try {

            // GPS updates
            manager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                2000L,
                5f,
                this
            )

            // Network location updates
            manager.requestLocationUpdates(
                LocationManager.NETWORK_PROVIDER,
                2000L,
                5f,
                this
            )

            android.util.Log.i(
                "ShakeSOS",
                "Location updates started"
            )

        } catch (e: SecurityException) {

            android.util.Log.e(
                "ShakeSOS",
                "Location permission missing: ${e.message}"
            )
        }
    }

    // ---------------------------------------------------------
    // LOCATION CHANGED
    // ---------------------------------------------------------

    override fun onLocationChanged(location: Location) {

        latestLocation = location

        android.util.Log.d(
            "ShakeSOS",
            "Location: ${location.latitude}, ${location.longitude}"
        )

        maybeSendLocation()
    }

    override fun onProviderDisabled(provider: String) {
        // Nothing required
    }

    override fun onProviderEnabled(provider: String) {
        // Nothing required
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(
        provider: String?,
        status: Int,
        extras: Bundle?
    ) {
        // Nothing required
    }

    // ---------------------------------------------------------
    // SEND LOCATION IF NEEDED
    // ---------------------------------------------------------

    private fun maybeSendLocation() {

        val location = latestLocation ?: return

        val now = System.currentTimeMillis()

        val interval =
            if (missionActive) {
                activeMissionSendIntervalMs
            } else {
                normalSendIntervalMs
            }

        // Don't send too frequently
        if (now - lastLocationSentAt < interval) {
            return
        }

        lastLocationSentAt = now

        sendLocationUpdate(location)
    }

    // ---------------------------------------------------------
    // SEND LOCATION TO BACKEND
    // ---------------------------------------------------------

    private fun sendLocationUpdate(
        location: Location
    ) {

        if (locationApiUrl.isBlank()) {
            return
        }

        Thread {

            try {

                val body =
                    JSONObject().apply {

                        put(
                            "user_id",
                            userId
                        )

                        put(
                            "latitude",
                            location.latitude
                        )

                        put(
                            "longitude",
                            location.longitude
                        )
                    }

                val connection =
                    URL(locationApiUrl)
                        .openConnection() as HttpURLConnection

                connection.requestMethod = "POST"

                connection.setRequestProperty(
                    "Content-Type",
                    "application/json"
                )

                connection.doOutput = true

                connection.outputStream.use { output ->

                    output.write(
                        body.toString().toByteArray()
                    )
                }

                val responseCode =
                    connection.responseCode

                android.util.Log.d(
                    "ShakeSOS",
                    "Location sent. Server response: $responseCode"
                )

                connection.disconnect()

            } catch (e: Exception) {

                android.util.Log.e(
                    "ShakeSOS",
                    "Failed to send location: ${e.message}"
                )
            }

        }.start()
    }

    // ---------------------------------------------------------
    // SENSOR BINDING
    // ---------------------------------------------------------

    override fun onBind(
        intent: Intent?
    ): IBinder? = null

    // ---------------------------------------------------------
    // SENSOR ACCURACY
    // ---------------------------------------------------------

    override fun onAccuracyChanged(
        sensor: Sensor?,
        accuracy: Int
    ) {
        android.util.Log.d(
            "ShakeSOS",
            "Sensor accuracy changed: $accuracy"
        )
    }

    // ---------------------------------------------------------
    // SHAKE DETECTION
    // ---------------------------------------------------------

    override fun onSensorChanged(
        event: SensorEvent
    ) {

        // Make sure this is the accelerometer
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) {
            return
        }

        // Read X/Y/Z acceleration
        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]

        // Calculate total acceleration magnitude
        val magnitude =
            sqrt(
                x * x +
                        y * y +
                        z * z
            )

        // First sensor reading
        if (previousMagnitude == 0f) {

            previousMagnitude = magnitude

            android.util.Log.d(
                "ShakeSOS",
                "First accelerometer reading: $magnitude"
            )

            return
        }

        // Calculate acceleration change
        val delta =
            abs(
                magnitude - previousMagnitude
            )

        // Store current magnitude
        previousMagnitude = magnitude

        val now =
            System.currentTimeMillis()

        /*
         * DEBUG:
         * Uncomment this if you want to see every
         * accelerometer change in Logcat.
         *
         * android.util.Log.d(
         *     "ShakeSOS",
         *     "delta=$delta magnitude=$magnitude"
         * )
         */

        // Ignore small movements
        if (delta < magnitudeThreshold) {
            return
        }

        // Prevent duplicate detection from one shake
        if (now - lastCountedAt < cooldownMs) {
            return
        }

        // Record time of this shake
        lastCountedAt = now

        android.util.Log.d(
            "ShakeSOS",
            "SHAKE DETECTED | delta=$delta | magnitude=$magnitude"
        )

        // Add this shake
        recentShakeTimestamps.add(now)

        // Remove old shakes
        recentShakeTimestamps.removeAll {
            it < now - windowMs
        }

        android.util.Log.d(
            "ShakeSOS",
            "SHAKE COUNT = ${recentShakeTimestamps.size}"
        )

        // -----------------------------------------------------
        // THREE SHAKES = SOS
        // -----------------------------------------------------

        if (
            recentShakeTimestamps.size >=
            requiredShakeCount
        ) {

            android.util.Log.i(
                "ShakeSOS",
                "================================"
            )

            android.util.Log.i(
                "ShakeSOS",
                "3 SHAKES DETECTED!"
            )

            android.util.Log.i(
                "ShakeSOS",
                "SENDING SOS TO BACKEND"
            )

            android.util.Log.i(
                "ShakeSOS",
                "================================"
            )

            // Clear previous shakes
            recentShakeTimestamps.clear()

            // Send SOS
            sendSOS()
        }
    }

    // ---------------------------------------------------------
    // SEND SOS
    // ---------------------------------------------------------

    private fun sendSOS() {

        Thread {

            try {

                android.util.Log.i(
                    "ShakeSOS",
                    "Preparing SOS request..."
                )

                // Prefer live location
                val location =
                    latestLocation
                        ?: getBestKnownLocation()

                val latitude =
                    location?.latitude ?: 0.0

                val longitude =
                    location?.longitude ?: 0.0

                android.util.Log.i(
                    "ShakeSOS",
                    "SOS Location: $latitude, $longitude"
                )

                val body =
                    JSONObject().apply {

                        put(
                            "user_id",
                            userId
                        )

                        put(
                            "latitude",
                            latitude
                        )

                        put(
                            "longitude",
                            longitude
                        )
                    }

                android.util.Log.i(
                    "ShakeSOS",
                    "SOS URL: $sosApiUrl"
                )

                android.util.Log.i(
                    "ShakeSOS",
                    "SOS body: $body"
                )

                // Create connection
                val connection =
                    URL(sosApiUrl)
                        .openConnection() as HttpURLConnection

                connection.requestMethod = "POST"

                connection.setRequestProperty(
                    "Content-Type",
                    "application/json"
                )

                connection.doOutput = true

                // Send request
                connection.outputStream.use { output ->

                    output.write(
                        body.toString().toByteArray()
                    )
                }

                // Get server response
                val responseCode =
                    connection.responseCode

                android.util.Log.i(
                    "ShakeSOS",
                    "================================"
                )

                android.util.Log.i(
                    "ShakeSOS",
                    "SOS SENT!"
                )

                android.util.Log.i(
                    "ShakeSOS",
                    "Server response: $responseCode"
                )

                android.util.Log.i(
                    "ShakeSOS",
                    "================================"
                )

                // Activate live mission
                if (
                    responseCode in 200..299
                ) {

                    missionActive = true

                    android.util.Log.i(
                        "ShakeSOS",
                        "Mission is now ACTIVE"
                    )
                }

                connection.disconnect()

            } catch (e: Exception) {

                android.util.Log.e(
                    "ShakeSOS",
                    "================================"
                )

                android.util.Log.e(
                    "ShakeSOS",
                    "FAILED TO SEND SOS"
                )

                android.util.Log.e(
                    "ShakeSOS",
                    "Error: ${e.message}"
                )

                android.util.Log.e(
                    "ShakeSOS",
                    "================================"
                )
            }

        }.start()
    }

    // ---------------------------------------------------------
    // GET LAST KNOWN LOCATION
    // ---------------------------------------------------------

    private fun getBestKnownLocation(): Location? {

        val manager =
            locationManager
                ?: return null

        return try {

            manager.getLastKnownLocation(
                LocationManager.GPS_PROVIDER
            )
                ?: manager.getLastKnownLocation(
                    LocationManager.NETWORK_PROVIDER
                )

        } catch (e: SecurityException) {

            android.util.Log.e(
                "ShakeSOS",
                "Cannot get location: ${e.message}"
            )

            null
        }
    }

    // ---------------------------------------------------------
    // FOREGROUND NOTIFICATION
    // ---------------------------------------------------------

    private fun buildNotification(): Notification {

        // Android 8+
        if (
            Build.VERSION.SDK_INT >=
            Build.VERSION_CODES.O
        ) {

            val channel =
                NotificationChannel(
                    CHANNEL_ID,
                    "Safety Monitoring",
                    NotificationManager.IMPORTANCE_LOW
                )

            val manager =
                getSystemService(
                    NotificationManager::class.java
                )

            manager.createNotificationChannel(
                channel
            )
        }

        return NotificationCompat
            .Builder(
                this,
                CHANNEL_ID
            )
            .setContentTitle(
                "Rescue SOS protection active"
            )
            .setContentText(
                "Shake detection is running"
            )
            .setSmallIcon(
                android.R.drawable.ic_lock_idle_lock
            )
            .setOngoing(true)
            .build()
    }
}
