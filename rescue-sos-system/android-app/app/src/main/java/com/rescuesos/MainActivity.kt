/**
 * MainActivity.kt
 *
 * The only screen in this app. One button: "Turn Protection ON." When
 * pressed, it asks for the permissions it needs, then starts
 * ShakeForegroundService, which is the part that keeps running even after
 * you lock the phone.
 */
package com.rescuesos

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private var protectionOn = false

    private val requiredPermissions = mutableListOf(
        Manifest.permission.ACCESS_FINE_LOCATION
    ).apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }.toTypedArray()

    private val permissionLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (results.values.all { it }) {
            startProtection()
        } else {
            findViewById<TextView>(R.id.statusText).text =
                "Permissions denied — protection cannot run without them"
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val statusText = findViewById<TextView>(R.id.statusText)
        val toggleButton = findViewById<Button>(R.id.toggleButton)

        toggleButton.setOnClickListener {
            if (!protectionOn) {
                val missing = requiredPermissions.filter {
                    ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
                }
                if (missing.isNotEmpty()) {
                    permissionLauncher.launch(missing.toTypedArray())
                } else {
                    startProtection()
                }
            } else {
                stopProtection()
            }
        }
    }

    private fun startProtection() {
        val intent = Intent(this, ShakeForegroundService::class.java)
        // This is the ONE line you'll change to point at your real backend
        // once it's deployed somewhere other than your laptop.
        intent.putExtra("sosApiUrl", "http://192.168.132.107:5000/sos")
        intent.putExtra("userId", "demo-user-1")
        ContextCompat.startForegroundService(this, intent)

        protectionOn = true
        findViewById<TextView>(R.id.statusText).text = "Protection: ON — lock your phone now"
        findViewById<Button>(R.id.toggleButton).text = "Turn Protection OFF"
    }

    private fun stopProtection() {
        stopService(Intent(this, ShakeForegroundService::class.java))
        protectionOn = false
        findViewById<TextView>(R.id.statusText).text = "Protection: OFF"
        findViewById<Button>(R.id.toggleButton).text = "Turn Protection ON"
    }
}
