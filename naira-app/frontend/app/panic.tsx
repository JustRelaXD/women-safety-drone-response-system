import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { storage } from "../src/utils/storage";

const API = `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}/api`;
const FALLBACK = { latitude: 12.9141, longitude: 74.856 };

function apiErrorMessage(body: any): string {
  const detail = body && body.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((d) => d && d.msg).filter(Boolean);
    if (messages.length) return messages.join(" · ");
  }
  return "Dispatch failed";
}

export default function PanicScreen() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [state, setState] = useState<"ready" | "sending" | "sent" | "error">("ready");
  const [emergencyId, setEmergencyId] = useState("");
  const locationRef = useRef(FALLBACK);

  useEffect(() => {
    (async () => {
      const saved = await storage.secureGet<string | null>("naira_token", null);
      setToken(saved);
      setChecked(true);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (Platform.OS !== "web") {
          const last = await Location.getLastKnownPositionAsync();
          if (last) locationRef.current = { latitude: last.coords.latitude, longitude: last.coords.longitude };
        }
        const permission = await Location.getForegroundPermissionsAsync();
        if (permission.granted) {
          const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          locationRef.current = { latitude: current.coords.latitude, longitude: current.coords.longitude };
        }
      } catch {
        // keep last known / fallback — panic dispatch must never block on GPS
      }
    })();
  }, []);

  const fire = async () => {
    if (!token || state === "sending" || state === "sent") return;
    setState("sending");
    try {
      const response = await fetch(`${API}/sos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...locationRef.current, battery: 82, network_status: "CONNECTED", trigger_type: "PANIC_WIDGET" }),
      });
      let body: any;
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      if (!response.ok) throw new Error(apiErrorMessage(body));
      setEmergencyId(body.emergency_id || body.id);
      setState("sent");
      fetch(`${API}/location`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...locationRef.current }),
      }).catch(() => undefined);
    } catch {
      setState("error");
    }
  };

  return (
    <SafeAreaView style={styles.wrap}>
      <StatusBar style="light" />
      <Pressable testID="panic-back" onPress={() => router.back()} style={styles.back} hitSlop={12}>
        <Ionicons name="chevron-back" color="#94A3B8" size={22} />
        <Text style={styles.backText}>NAIRA</Text>
      </Pressable>
      {!checked ? (
        <ActivityIndicator color="#FF3B30" />
      ) : !token ? (
        <View style={styles.centerBlock}>
          <Ionicons name="lock-closed" color="#64748B" size={38} />
          <Text style={styles.title}>Panic widget locked</Text>
          <Text style={styles.muted}>Sign in to Naira once to arm your one-tap panic shortcut.</Text>
          <Pressable testID="panic-signin" onPress={() => router.replace("/")} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Open Naira</Text>
          </Pressable>
        </View>
      ) : state === "sent" ? (
        <View style={styles.centerBlock}>
          <View style={styles.sentRing}>
            <Ionicons name="checkmark" color="#38D996" size={54} />
          </View>
          <Text style={styles.eyebrow}>SIGNAL CONFIRMED</Text>
          <Text testID="panic-sent-title" style={styles.title}>Help is on the way</Text>
          <Text style={styles.muted}>Emergency {emergencyId} · trusted contacts alerted · drone dispatched to your location.</Text>
          <Pressable testID="panic-open-app" onPress={() => router.replace("/")} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Track response in Naira</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.centerBlock}>
          <Text style={styles.eyebrow}>PANIC WIDGET</Text>
          <Text style={styles.title}>One tap. Instant response.</Text>
          <Pressable
            testID="panic-fire"
            onPress={fire}
            disabled={state === "sending"}
            style={({ pressed }) => [styles.panicButton, pressed && styles.panicPressed, state === "sending" && styles.panicSending]}
          >
            {state === "sending" ? (
              <ActivityIndicator color="#FFFFFF" size="large" />
            ) : (
              <>
                <Ionicons name="warning" color="#FFFFFF" size={52} />
                <Text style={styles.panicText}>TAP FOR HELP</Text>
              </>
            )}
          </Pressable>
          {state === "error" && <Text testID="panic-error" style={styles.error}>Could not dispatch. Tap again to retry.</Text>}
          <Text style={styles.muted}>No countdown. Tapping instantly shares your location with trusted contacts and requests a drone.</Text>
          <Text style={styles.footnote}>Tip: keep this screen one swipe away. A true lock-screen widget ships with the native build (Publish → iOS/Android).</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#0B0F19", padding: 24, justifyContent: "center" },
  back: { position: "absolute", top: 58, left: 20, flexDirection: "row", alignItems: "center", gap: 4 },
  backText: { color: "#94A3B8", fontSize: 13, fontWeight: "900", letterSpacing: 2 },
  centerBlock: { alignItems: "center", gap: 14 },
  eyebrow: { color: "#FF3B30", fontSize: 11, fontWeight: "900", letterSpacing: 2 },
  title: { color: "#F8FAFC", fontSize: 28, fontWeight: "900", textAlign: "center" },
  muted: { color: "#94A3B8", fontSize: 14, lineHeight: 21, textAlign: "center" },
  error: { color: "#FF6B63", fontSize: 13, fontWeight: "700" },
  panicButton: { width: 230, height: 230, borderRadius: 115, backgroundColor: "#FF3B30", alignItems: "center", justifyContent: "center", gap: 10, marginVertical: 22, borderWidth: 8, borderColor: "#2A1719", shadowColor: "#FF3B30", shadowOpacity: 0.5, shadowRadius: 30, elevation: 12 },
  panicPressed: { transform: [{ scale: 0.95 }] },
  panicSending: { opacity: 0.75 },
  panicText: { color: "#FFFFFF", fontSize: 18, fontWeight: "900", letterSpacing: 2 },
  sentRing: { width: 120, height: 120, borderRadius: 60, backgroundColor: "#13251E", borderWidth: 2, borderColor: "#38D996", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  secondaryButton: { minHeight: 50, borderRadius: 12, paddingHorizontal: 22, alignItems: "center", justifyContent: "center", backgroundColor: "#131825", borderWidth: 1, borderColor: "#334155", marginTop: 8 },
  secondaryButtonText: { color: "#F8FAFC", fontSize: 14, fontWeight: "900" },
  footnote: { color: "#475569", fontSize: 11, textAlign: "center", marginTop: 10 },
});
