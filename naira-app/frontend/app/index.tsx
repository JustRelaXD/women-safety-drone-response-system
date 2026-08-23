import * as Location from "expo-location";
import { Accelerometer } from "expo-sensors";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LiveMap } from "../src/components/LiveMap";
import { storage } from "../src/utils/storage";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

const API = `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}/api`;
const FALLBACK = { latitude: 12.9141, longitude: 74.8560 };
type Tab = "home" | "contacts" | "history" | "operator";
type User = { id: string; name: string; email: string };
type Contact = { id: string; name: string; relationship: string; phone: string; preferred_channel: string };
type Emergency = { id: string; status: string; trigger_type: string; created_at: string; location: { latitude: number; longitude: number }; drone: { id: string; status: string; battery: number; location: { latitude: number; longitude: number }; eta_seconds: number; distance_km: number }; notifications: { name: string; channel: string; status: string }[] };
type ActivityItem = { id: string; action: string; category: string; timestamp: string; details?: any };

type Drone = { id: string; name?: string; lat: number; lon: number; status: string; battery?: number };
type ActiveMission = { user_id: string; drone_id: string; emergency_id?: string; status: string; current_location?: { latitude: number; longitude: number } };
type FleetStatus = { drones: Drone[]; recent_sos_events: any[]; active_missions: ActiveMission[] };

function apiErrorMessage(body: any): string {
  const detail = body && body.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((d) => d && d.msg).filter(Boolean);
    if (messages.length) return messages.join(" · ");
  }
  return "Something went wrong";
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } });
  let body: any;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(apiErrorMessage(body));
  return body;
}

function Icon({ name, color = "#F8FAFC", size = 20 }: { name: keyof typeof Ionicons.glyphMap; color?: string; size?: number }) {
  return <Ionicons name={name} color={color} size={size} />;
}

function Button({ title, onPress, variant = "primary", icon, testID, disabled = false }: { title: string; onPress: () => void; variant?: "primary" | "secondary" | "ghost"; icon?: keyof typeof Ionicons.glyphMap; testID: string; disabled?: boolean }) {
  return <Pressable testID={testID} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, styles[`button_${variant}`], pressed && styles.pressed, disabled && styles.disabled]}>{icon && <Icon name={icon} size={17} color={variant === "primary" ? "#0B0F19" : "#F8FAFC"} />}<Text style={[styles.buttonText, variant !== "primary" && styles.buttonTextLight]}>{title}</Text></Pressable>;
}

function AuthScreen({ onAuth }: { onAuth: (token: string, user: User) => void }) {
  const [signup, setSignup] = useState(false); const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const submit = async () => { setLoading(true); setError(""); try { const result = await request<{ token: string; user: User }>(signup ? "/auth/signup" : "/auth/login", { method: "POST", body: JSON.stringify(signup ? { name, email, password } : { email, password }) }); await storage.secureSet("naira_token", result.token); await storage.setItem("naira_user", result.user); onAuth(result.token, result.user); } catch (e) { setError(e instanceof Error ? e.message : "Unable to continue"); } finally { setLoading(false); } };
  return <SafeAreaView style={styles.authWrap}><StatusBar style="light" /><View style={styles.brandRow}><View style={styles.brandMark}><Icon name="shield-checkmark" color="#FF3B30" size={25} /></View><View><Text style={styles.brand}>NAIRA</Text><Text style={styles.kicker}>SAFETY RESPONSE NETWORK</Text></View></View><View style={styles.authHero}><Text style={styles.eyebrow}>YOUR SIGNAL. OUR RESPONSE.</Text><Text style={styles.authTitle}>{signup ? "Create your safety account" : "Stay ready. Stay visible."}</Text><Text style={styles.muted}>A rapid-response layer for your walk home, backed by trusted contacts and drone dispatch.</Text></View><KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.authCard}>{signup && <TextInput testID="name-input" value={name} onChangeText={setName} placeholder="Full name" placeholderTextColor="#64748B" style={styles.input} /> }<TextInput testID="email-input" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="Email address" placeholderTextColor="#64748B" style={styles.input} /><TextInput testID="password-input" value={password} onChangeText={setPassword} secureTextEntry placeholder="Password (6+ characters)" placeholderTextColor="#64748B" style={styles.input} />{error ? <Text style={styles.error}>{error}</Text> : null}<Button testID="auth-submit" title={loading ? "Connecting..." : signup ? "Create account" : "Sign in"} onPress={submit} disabled={loading} icon="arrow-forward" />{loading && <ActivityIndicator color="#FF3B30" style={styles.loader} />}<Pressable testID="auth-toggle" onPress={() => setSignup(!signup)}><Text style={styles.switchText}>{signup ? "Already have an account? Sign in" : "New to Naira? Create account"}</Text></Pressable></KeyboardAvoidingView><Text style={styles.legal}>Your location is shared only when you activate an emergency.</Text></SafeAreaView>;
}

function Home({ token, user, onEmergency, active, onOpenContacts, onOpenHistory, onOpenOperator, onLogout }: { token: string; user: User; onEmergency: (emergency: Emergency) => void; active: Emergency | null; onOpenContacts: () => void; onOpenHistory: () => void; onOpenOperator: () => void; onLogout: () => void }) {
  const router = useRouter();
  const [walkEndsAt, setWalkEndsAt] = useState<number | null>(null); const [walkRemaining, setWalkRemaining] = useState(0); const [walkPickerOpen, setWalkPickerOpen] = useState(false); const [checkinOpen, setCheckinOpen] = useState(false); const [grace, setGrace] = useState(60); const [safeBanner, setSafeBanner] = useState(false);
  const [protectionOn, setProtectionOn] = useState(true);
  const [location, setLocation] = useState(FALLBACK); const [locationLabel, setLocationLabel] = useState("Mangaluru, Karnataka"); const [battery] = useState(82); const [sosOpen, setSosOpen] = useState(false); const [countdown, setCountdown] = useState(5); const [sending, setSending] = useState(false); const shakeTriggered = useRef(false); const triggerRef = useRef("MANUAL_SOS");
  const walk = walkEndsAt !== null;

  useEffect(() => { (async () => { const permission = await Location.requestForegroundPermissionsAsync(); if (permission.granted) { const current = await Location.getCurrentPositionAsync({}); setLocation({ latitude: current.coords.latitude, longitude: current.coords.longitude }); setLocationLabel("Current device location"); } })(); }, []);

  // Restore Active Walk state from backend database
  useEffect(() => {
    (async () => {
      try {
        const walkRes = await request<any>("/walks/active", {}, token);
        if (walkRes && walkRes.status === "ACTIVE" && walkRes.expected_end_at) {
          const endMs = new Date(walkRes.expected_end_at).getTime();
          if (endMs > Date.now()) {
            setWalkEndsAt(endMs);
            setWalkRemaining(Math.max(0, Math.ceil((endMs - Date.now()) / 1000)));
          }
        }
      } catch (e) {}
    })();
  }, [token]);

  // Live Location Background Streaming Effect (Rescue SOS System)
  useEffect(() => {
    if (!protectionOn && !walk && !active) return;
    const intervalMs = active ? 4000 : 15000;
    const sendLocation = async () => {
      try {
        const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const loc = { latitude: current.coords.latitude, longitude: current.coords.longitude };
        setLocation(loc);
        await request("/location", { method: "POST", body: JSON.stringify({ user_id: user.id, ...loc }) }, token);
      } catch (e) {}
    };
    sendLocation();
    const timer = setInterval(sendLocation, intervalMs);
    return () => clearInterval(timer);
  }, [protectionOn, walk, active?.id, token, user.id]);

  useEffect(() => { if (!sosOpen || countdown <= 0) return; const timer = setTimeout(() => setCountdown(countdown - 1), 1000); return () => clearTimeout(timer); }, [sosOpen, countdown]);
  
  // Sensitive Shake Pattern Detector
  useEffect(() => { 
    if ((!walk && !protectionOn) || active || Platform.OS === "web" || typeof Accelerometer.addListener !== "function") { 
      shakeTriggered.current = false; 
      return; 
    } 
    Accelerometer.setUpdateInterval(200); 
    const subscription = Accelerometer.addListener(({ x, y, z }) => { 
      const force = Math.sqrt(x * x + y * y + z * z); 
      if (force > 2.25 && !shakeTriggered.current) { 
        shakeTriggered.current = true; 
        triggerRef.current = "SHAKE_PATTERN"; 
        setCountdown(5); 
        setSosOpen(true); 
      } 
    }); 
    return () => subscription.remove(); 
  }, [walk, protectionOn, active]);

  useEffect(() => { if (sosOpen && countdown === 0) activate(triggerRef.current); }, [sosOpen, countdown]);
  useEffect(() => { if (!walkEndsAt || checkinOpen || active) return; const tick = () => { const remaining = Math.max(0, Math.ceil((walkEndsAt - Date.now()) / 1000)); setWalkRemaining(remaining); if (remaining <= 0) { setGrace(60); setCheckinOpen(true); } }; tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer); }, [walkEndsAt, checkinOpen, active]);
  useEffect(() => { if (!checkinOpen || active) return; if (grace <= 0) { activate("MISSED_CHECK_IN"); return; } const timer = setTimeout(() => setGrace(grace - 1), 1000); return () => clearTimeout(timer); }, [checkinOpen, grace, active]);
  
  const activate = async (triggerType: string = "MANUAL_SOS") => { 
    if (sending) return; 
    setSending(true); 
    try { 
      const res = await request<any>("/sos", { method: "POST", body: JSON.stringify({ user_id: user.id, ...location, battery, network_status: "CONNECTED", trigger_type: triggerType }) }, token); 
      const emergency = res.emergency || res;
      onEmergency(emergency); 
      setSosOpen(false); 
      setCheckinOpen(false); 
      setWalkEndsAt(null); 
    } catch (e) { 
      Alert.alert("Unable to dispatch", e instanceof Error ? e.message : "Please try again"); 
      setSosOpen(false); 
    } finally { 
      setSending(false); 
    } 
  };

  const startWalk = async (minutes: number) => { 
    setWalkPickerOpen(false); 
    setSafeBanner(false); 
    const endMs = Date.now() + minutes * 60 * 1000;
    setWalkRemaining(minutes * 60); 
    setWalkEndsAt(endMs); 
    try {
      await request("/walks/start", { method: "POST", body: JSON.stringify({ duration_minutes: minutes, ...location }) }, token);
    } catch (e) {}
  };

  const madeItHome = async () => { 
    setWalkEndsAt(null); 
    setCheckinOpen(false); 
    setSafeBanner(true); 
    setTimeout(() => setSafeBanner(false), 6000); 
    try {
      await request("/walks/complete", { method: "POST" }, token);
    } catch (e) {}
  };

  const toggleProtection = async () => {
    const next = !protectionOn;
    setProtectionOn(next);
    try {
      await request("/activities", { method: "POST", body: JSON.stringify({ action: next ? "PROTECTION_ENABLED" : "PROTECTION_DISABLED", category: "SAFETY" }) }, token);
    } catch (e) {}
  };

  const formatWalk = (secs: number) => `${Math.floor(secs / 60).toString().padStart(2, "0")}:${(secs % 60).toString().padStart(2, "0")}`;
  const cancelActive = async () => { 
    if (!active) return; 
    try { 
      const cancelled = await request<Emergency>(`/emergencies/${active.id}/cancel`, { method: "POST" }, token); 
      await request("/sos/resolve", { method: "POST", body: JSON.stringify({ user_id: user.id, emergency_id: active.id }) }, token);
      onEmergency(cancelled); 
    } catch (e) { 
      Alert.alert("Unable to cancel", e instanceof Error ? e.message : "Please try again"); 
    } 
  };
  const openSwagger = () => { const docsUrl = `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}/docs`; if (Platform.OS === "web") { window.open(docsUrl, "_blank"); } else { Linking.openURL(docsUrl); } };

  return <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}><View style={styles.topBar}><View><Text style={styles.kicker}>GOOD EVENING, {user.name.split(" ")[0].toUpperCase()}</Text><Text style={styles.screenTitle}>Your safety, on watch.</Text></View><View style={{ flexDirection: "row", gap: 8 }}><Pressable testID="swagger-open" onPress={openSwagger} style={styles.iconButton}><Icon name="code-slash" color="#38D996" /></Pressable><Pressable testID="operator-open" onPress={onOpenOperator} style={styles.iconButton}><Icon name="radio" color="#FF3B30" /></Pressable><Pressable testID="logout-button" onPress={onLogout} style={styles.iconButton}><Icon name="log-out-outline" color="#94A3B8" /></Pressable></View></View>{safeBanner && <View testID="safe-arrival-banner" style={styles.safeBanner}><Icon name="checkmark-circle" color="#38D996" size={18} /><Text style={styles.safeBannerText}>Safe arrival confirmed. Walk Mode is off — glad you made it.</Text></View>}<View style={[styles.safeCard, active && styles.alertCard]}><View style={styles.statusLine}><View style={[styles.statusDot, active && styles.statusDotAlert, !protectionOn && !active && { backgroundColor: "#94A3B8" }]} /><Text style={styles.statusText}>{active ? active.status.replaceAll("_", " ") : walk ? "WALK MODE ACTIVE" : protectionOn ? "RESCUE SOS PROTECTION ON" : "PROTECTION OFF"}</Text><Text style={styles.statusTime}>{active ? "LIVE" : walk ? formatWalk(walkRemaining) : protectionOn ? "ACTIVE" : "STANDBY"}</Text></View><Text style={styles.monitoring}>{active ? "Naira rescue response active" : walk ? "Naira is monitoring your route" : protectionOn ? "Background Rescue Protection Active" : "Protection paused"}</Text><Text style={styles.mutedSmall}>{active ? `Assigned Drone: ${active.drone?.id || "Dispatched"} · Live GPS tracking` : walk ? `Tap "I made it home" before the timer ends or contacts are alerted` : protectionOn ? "Shake phone 3 times or tap SOS for immediate drone dispatch" : "Turn Protection ON for automated shake SOS and GPS streaming"}</Text></View>{active ? <><LiveMap emergency={active} /><View style={styles.etaCard}><View><Text style={styles.kicker}>DRONE RESPONSE ({active.drone.id})</Text><Text style={styles.eta}>{active.status === "DRONE_ARRIVED" ? "ARRIVED" : `${Math.floor(active.drone.eta_seconds / 60).toString().padStart(2, "0")}:${(active.drone.eta_seconds % 60).toString().padStart(2, "0")}`}</Text><Text style={styles.mutedSmall}>{active.status === "DRONE_ARRIVED" ? `${active.drone.id} is on scene` : `${active.drone.distance_km} km remaining · ${active.drone.id} en route`}</Text></View><View style={styles.droneBadge}><Icon name="navigate" color="#FF3B30" size={24} /><Text style={styles.droneBadgeText}>{active.drone.battery}%</Text></View></View>{active.status !== "DRONE_ARRIVED" && <Button testID="cancel-active-emergency" title="Cancel active emergency" onPress={cancelActive} variant="secondary" />}</> : <><View style={styles.quickGrid}><Info icon="location" label="LOCATION" value={locationLabel} /><Info icon="battery-half" label="PHONE BATTERY" value={`${battery}%`} /><Info icon="shield" label="PROTECTION" value={protectionOn ? "Active" : "Off"} onPress={toggleProtection} /><Info icon="people" label="CONTACTS" value="Ready" onPress={onOpenContacts} /></View><LiveMap compact center={location} /></>}<View style={styles.actionRow}><Button testID="protection-toggle" title={protectionOn ? "Turn Protection OFF" : "Turn Protection ON"} onPress={toggleProtection} variant={protectionOn ? "secondary" : "primary"} icon="shield-checkmark" /><Button testID="walk-mode-toggle" title={walk ? "I made it home" : "Start Walk Mode"} onPress={walk ? madeItHome : () => setWalkPickerOpen(true)} variant="secondary" icon={walk ? "checkmark-circle" : "walk"} /><Button testID="sos-button" title="SOS" onPress={() => { triggerRef.current = "MANUAL_SOS"; setCountdown(5); setSosOpen(true); }} icon="warning" /></View><View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Response tools</Text><Pressable testID="history-open" onPress={onOpenHistory}><Text style={styles.link}>History & Activity</Text></Pressable></View><View style={styles.toolRow}><Tool icon="flash-outline" title="Panic Widget" detail="One-tap instant SOS screen" onPress={() => router.push("/panic")} /><Tool icon="people-outline" title="Contacts" detail="Trusted people" onPress={onOpenContacts} /><Tool icon="time-outline" title="History & Logs" detail="Past incidents & activity timeline" onPress={onOpenHistory} /><Tool icon="code-slash-outline" title="API & Swagger Docs" detail="Open interactive FastAPI documentation" onPress={openSwagger} /><Tool icon="log-out-outline" title="Sign Out" detail="Log out of your Naira account" onPress={onLogout} /></View><Modal transparent visible={walkPickerOpen} animationType="fade"><View style={styles.modalBackdrop}><View style={styles.sosModal}><Text style={styles.modalEyebrow}>SAFE ARRIVAL CHECK</Text><Text style={styles.modalTitle}>How long is your walk?</Text><Text style={styles.muted}>{`If you don't tap "I made it home" when the timer ends, Naira automatically alerts your trusted contacts.`}</Text><View style={styles.walkChipRow}>{[5, 10, 15, 30].map((m) => <Pressable key={m} testID={`walk-duration-${m}`} onPress={() => startWalk(m)} style={({ pressed }) => [styles.walkChip, pressed && styles.pressed]}><Text style={styles.walkChipText}>{m}</Text><Text style={styles.walkChipUnit}>MIN</Text></Pressable>)}</View><Button testID="walk-picker-cancel" title="Not now" onPress={() => setWalkPickerOpen(false)} variant="secondary" /></View></View></Modal><Modal transparent visible={checkinOpen && !active} animationType="fade"><View style={styles.modalBackdrop}><View style={styles.sosModal}><View style={styles.sosIcon}><Icon name="help" color="#FFB020" size={30} /></View><Text style={styles.modalEyebrow}>SAFE ARRIVAL CHECK</Text><Text style={styles.modalTitle}>Did you make it home?</Text><Text testID="grace-countdown" style={styles.graceNumber}>{grace}</Text><Text style={styles.muted}>Stay silent and Naira will automatically alert your trusted contacts and request a drone.</Text><Button testID="checkin-made-it-home" title="I made it home" onPress={madeItHome} icon="checkmark" /><Button testID="checkin-need-help" title="I need help — send SOS" onPress={() => activate("MISSED_CHECK_IN")} variant="secondary" icon="warning" />{sending && <ActivityIndicator color="#FF3B30" style={styles.loader} />}</View></View></Modal><Modal transparent visible={sosOpen} animationType="fade"><View style={styles.modalBackdrop}><View style={styles.sosModal}><View style={styles.sosIcon}><Icon name="warning" color="#FF3B30" size={30} /></View><Text style={styles.modalEyebrow}>EMERGENCY ACTIVATION</Text><Text style={styles.modalTitle}>{countdown > 0 ? `Dispatching in ${countdown}` : "Dispatching..."}</Text><Text style={styles.muted}>Your location will be shared with trusted contacts and the nearest available drone.</Text><Button testID="cancel-sos" title="Cancel activation" onPress={() => setSosOpen(false)} variant="secondary" />{sending && <ActivityIndicator color="#FF3B30" style={styles.loader} />}</View></View></Modal></ScrollView>;
}

function Info({ icon, label, value, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; onPress?: () => void }) { return <Pressable onPress={onPress} style={styles.infoCard}><Icon name={icon} color="#FF3B30" size={18} /><Text style={styles.infoLabel}>{label}</Text><Text numberOfLines={1} style={styles.infoValue}>{value}</Text></Pressable>; }
function Tool({ icon, title, detail, onPress }: { icon: keyof typeof Ionicons.glyphMap; title: string; detail: string; onPress: () => void }) { return <Pressable onPress={onPress} style={styles.tool}><Icon name={icon} color="#94A3B8" size={19} /><View><Text style={styles.toolTitle}>{title}</Text><Text style={styles.toolDetail}>{detail}</Text></View><Icon name="chevron-forward" color="#64748B" size={16} /></Pressable>; }

function Contacts({ token }: { token: string }) { const [contacts, setContacts] = useState<Contact[]>([]); const [form, setForm] = useState({ name: "", relationship: "", phone: "" }); const [adding, setAdding] = useState(false); const load = async () => setContacts(await request<Contact[]>("/contacts", {}, token)); useEffect(() => { load().catch(() => undefined); }, []); const add = async () => { if (!form.name || !form.relationship || !form.phone) return; await request("/contacts", { method: "POST", body: JSON.stringify({ ...form, preferred_channel: "SMS" }) }, token); setForm({ name: "", relationship: "", phone: "" }); setAdding(false); load(); }; return <ScrollView contentContainerStyle={styles.scroll}><View style={styles.topBar}><View><Text style={styles.kicker}>TRUSTED CIRCLE</Text><Text style={styles.screenTitle}>Emergency contacts</Text></View><Pressable testID="add-contact" onPress={() => setAdding(!adding)} style={styles.iconButton}><Icon name={adding ? "close" : "add"} color="#FF3B30" /></Pressable></View><Text style={styles.muted}>People who receive your Naira alert when an emergency is activated.</Text>{adding && <View style={styles.formCard}><TextInput testID="contact-name" value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} placeholder="Name" placeholderTextColor="#64748B" style={styles.input} /><TextInput testID="contact-relationship" value={form.relationship} onChangeText={(v) => setForm({ ...form, relationship: v })} placeholder="Relationship" placeholderTextColor="#64748B" style={styles.input} /><TextInput testID="contact-phone" value={form.phone} onChangeText={(v) => setForm({ ...form, phone: v })} placeholder="Phone (+country code)" keyboardType="phone-pad" placeholderTextColor="#64748B" style={styles.input} /><Button testID="save-contact" title="Save contact" onPress={add} icon="checkmark" /></View>}{contacts.length === 0 && !adding && <View style={styles.empty}><Icon name="people-outline" color="#64748B" size={36} /><Text style={styles.emptyTitle}>No trusted contacts yet</Text><Text style={styles.muted}>Add someone who should know when your safety signal is active.</Text></View>}{contacts.map((contact) => <View key={contact.id} style={styles.contactCard}><View style={styles.avatar}><Text style={styles.avatarText}>{contact.name.slice(0, 1).toUpperCase()}</Text></View><View style={styles.contactMain}><Text style={styles.contactName}>{contact.name}</Text><Text style={styles.mutedSmall}>{contact.relationship} · {contact.phone}</Text><View style={styles.delivery}><Icon name="chatbubble-ellipses" color="#FFB020" size={13} /><Text style={styles.deliveryText}>SMS status: provider setup pending</Text></View></View><Pressable testID={`delete-contact-${contact.id}`} onPress={() => request(`/contacts/${contact.id}`, { method: "DELETE" }, token).then(load)}><Icon name="trash-outline" color="#64748B" size={19} /></Pressable></View>)}</ScrollView>; }

function History({ token }: { token: string }) { 
  const [subTab, setSubTab] = useState<"incidents" | "timeline">("incidents");
  const [items, setItems] = useState<Emergency[]>([]); 
  const [activities, setActivities] = useState<ActivityItem[]>([]);

  const loadData = () => {
    request<Emergency[]>("/emergencies", {}, token).then(setItems).catch(() => undefined);
    request<ActivityItem[]>("/activities", {}, token).then(setActivities).catch(() => undefined);
  };

  useEffect(() => { loadData(); }, []);

  return <ScrollView contentContainerStyle={styles.scroll}><Text style={styles.kicker}>ACTIVITY & LOGS</Text><Text style={styles.screenTitle}>History & Timeline</Text><Text style={[styles.muted, { marginBottom: 16 }]}>A persistent, real-time log of all your safety activities.</Text>

  <View style={styles.tabRow}>
    <Pressable onPress={() => setSubTab("incidents")} style={[styles.subTabButton, subTab === "incidents" && styles.subTabActive]}><Text style={[styles.subTabText, subTab === "incidents" && styles.subTabTextActive]}>Emergency Incidents ({items.length})</Text></Pressable>
    <Pressable onPress={() => setSubTab("timeline")} style={[styles.subTabButton, subTab === "timeline" && styles.subTabActive]}><Text style={[styles.subTabText, subTab === "timeline" && styles.subTabTextActive]}>Activity Feed ({activities.length})</Text></Pressable>
  </View>

  {subTab === "incidents" ? (
    items.length === 0 ? <View style={styles.empty}><Icon name="time-outline" color="#64748B" size={36} /><Text style={styles.emptyTitle}>No incidents recorded</Text><Text style={styles.muted}>Your completed safety events will appear here.</Text></View> : items.map((item) => <View key={item.id} style={styles.historyCard}><View style={styles.historyIcon}><Icon name={item.status === "CANCELLED" || item.status === "RESOLVED" ? "close" : "shield-checkmark"} color={item.status === "CANCELLED" || item.status === "RESOLVED" ? "#94A3B8" : "#FF3B30"} size={18} /></View><View style={{ flex: 1 }}><Text style={styles.contactName}>{item.id}</Text><Text style={styles.mutedSmall}>{new Date(item.created_at).toLocaleString()} · {item.trigger_type.replaceAll("_", " ")}</Text><Text style={styles.historyStatus}>{item.status.replaceAll("_", " ")}</Text></View></View>)
  ) : (
    activities.length === 0 ? <View style={styles.empty}><Icon name="list-outline" color="#64748B" size={36} /><Text style={styles.emptyTitle}>No activity logged yet</Text><Text style={styles.muted}>Every action is persistently logged in the backend.</Text></View> : activities.map((act) => <View key={act.id} style={styles.historyCard}><View style={styles.historyIcon}><Icon name="pulse-outline" color="#38D996" size={18} /></View><View style={{ flex: 1 }}><Text style={styles.contactName}>{act.action.replaceAll("_", " ")}</Text><Text style={styles.mutedSmall}>{new Date(act.timestamp).toLocaleString()} · {act.category}</Text></View></View>)
  )}
  </ScrollView>; 
}

function Operator({ token }: { token: string }) { 
  const [fleet, setFleet] = useState<FleetStatus | null>(null); 
  const [items, setItems] = useState<Emergency[]>([]);

  const loadData = async () => {
    try {
      const statusData = await request<FleetStatus>("/sos/status", {}, token);
      setFleet(statusData);
      const activeEmergencies = await request<Emergency[]>("/operator/active", {}, token);
      setItems(activeEmergencies);
    } catch (e) {}
  };

  useEffect(() => { 
    loadData(); 
    const timer = setInterval(loadData, 3000); 
    return () => clearInterval(timer); 
  }, []);

  const resolveMission = async (emergencyId?: string, userId?: string) => {
    try {
      await request("/sos/resolve", { method: "POST", body: JSON.stringify({ emergency_id: emergencyId, user_id: userId }) }, token);
      if (emergencyId) {
        await request(`/emergencies/${emergencyId}/cancel`, { method: "POST" }, token);
      }
      loadData();
    } catch (e) {
      Alert.alert("Error", "Could not resolve rescue mission");
    }
  };

  const resetFleet = async () => {
    try {
      await request("/sos/reset", { method: "POST" }, token);
      loadData();
    } catch (e) {
      Alert.alert("Error", "Could not reset fleet");
    }
  };

  const active = items[0]; 

  return <ScrollView contentContainerStyle={styles.scroll}><Text style={styles.kicker}>NAIRA COMMAND CENTER</Text><Text style={styles.screenTitle}>Rescue Fleet Monitor</Text><View style={styles.operatorHeader}><View style={styles.statusDot} /><Text style={styles.statusText}>{fleet?.active_missions.length || items.length} ACTIVE RESCUE MISSION{(fleet?.active_missions.length || items.length) === 1 ? "" : "S"}</Text><Text style={styles.mutedSmall}>Live 3s</Text><Pressable testID="reset-fleet" onPress={resetFleet} style={[styles.iconButton, { marginLeft: "auto", width: 36, height: 36 }]}><Icon name="refresh-outline" color="#38D996" size={18} /></Pressable></View>

  <Text style={[styles.kicker, { marginTop: 12, marginBottom: 8 }]}>FLEET STATUS</Text>
  <View style={styles.fleetGrid}>
    {(fleet?.drones || [
      { id: "DRONE-1", name: "Eagle-1", lat: 12.9141, lon: 74.8560, status: "available", battery: 98 },
      { id: "DRONE-2", name: "Falcon-2", lat: 12.9250, lon: 74.8620, status: "available", battery: 92 },
      { id: "DRONE-3", name: "Vanguard-3", lat: 12.9020, lon: 74.8450, status: "available", battery: 95 },
      { id: "N-01", name: "Naira-01", lat: 12.9100, lon: 74.8500, status: "available", battery: 94 },
    ]).map((d) => (
      <View key={d.id} style={styles.droneCard}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={styles.droneCardTitle}>{d.id}</Text>
          <View style={[styles.droneStatusTag, d.status === "available" ? styles.tagAvailable : styles.tagDispatched]}>
            <Text style={styles.droneStatusTagText}>{d.status.toUpperCase()}</Text>
          </View>
        </View>
        <Text style={styles.mutedSmall}>{d.name || "Drone Unit"}</Text>
        <Text style={styles.droneCardCoords}>{d.lat.toFixed(4)}, {d.lon.toFixed(4)}</Text>
      </View>
    ))}
  </View>

  {active ? <><Text style={[styles.kicker, { marginTop: 20, marginBottom: 8 }]}>ACTIVE EMERGENCY TARGET</Text><LiveMap emergency={active} /><View style={styles.operatorCard}><View style={{ flex: 1 }}><Text style={styles.kicker}>ACTIVE DISPATCH</Text><Text style={styles.contactName}>{active.id}</Text><Text style={styles.mutedSmall}>Target GPS: {active.location.latitude.toFixed(4)}, {active.location.longitude.toFixed(4)}</Text><Text style={styles.mutedSmall}>Assigned: {active.drone.id}</Text></View><View style={styles.operatorRight}><Text style={styles.eta}>{active.status === "DRONE_ARRIVED" ? "ON SCENE" : `${Math.floor(active.drone.eta_seconds / 60).toString().padStart(2, "0")}:${(active.drone.eta_seconds % 60).toString().padStart(2, "0")}`}</Text><Button testID="resolve-mission-button" title="Resolve Mission" onPress={() => resolveMission(active.id, active.user_id)} variant="secondary" icon="checkmark-done" /></View></View></> : <View style={styles.empty}><Icon name="radio-outline" color="#64748B" size={36} /><Text style={styles.emptyTitle}>All Drones Standby</Text><Text style={styles.muted}>The operations grid is clear. All rescue units ready.</Text></View>}</ScrollView>; 
}

export default function Index() { 
  const [token, setToken] = useState<string | null>(null); 
  const [user, setUser] = useState<User | null>(null); 
  const [tab, setTab] = useState<Tab>("home"); 
  const [active, setActive] = useState<Emergency | null>(null); 

  useEffect(() => { 
    (async () => { 
      const savedToken = await storage.secureGet<string | null>("naira_token", null); 
      const savedUser = await storage.getItem<User | null>("naira_user", null); 
      if (savedToken && savedUser) { 
        setToken(savedToken); 
        setUser(savedUser); 
      } 
    })(); 
  }, []);

  // Restore Active Emergency state from backend database on mount
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const activeRes = await request<{ active: boolean; emergency?: Emergency }>("/emergencies/active", {}, token);
        if (activeRes.active && activeRes.emergency) {
          setActive(activeRes.emergency);
        }
      } catch (e) {}
    })();
  }, [token]);

  useEffect(() => { 
    if (!active || !token || active.status === "DRONE_ARRIVED") return; 
    const timer = setInterval(() => request<Emergency>(`/emergencies/${active.id}`, {}, token).then(setActive).catch(() => undefined), 3000); 
    return () => clearInterval(timer); 
  }, [active?.id, active?.status, token]); 

  const handleLogout = async () => { 
    if (token) { try { await request("/auth/logout", { method: "POST" }, token); } catch (e) {} }
    await storage.removeItem("naira_token"); 
    await storage.removeItem("naira_user"); 
    setToken(null); 
    setUser(null); 
    setActive(null); 
    setTab("home"); 
  }; 

  if (!token || !user) return <AuthScreen onAuth={(nextToken, nextUser) => { setToken(nextToken); setUser(nextUser); }} />; 
  const body = tab === "home" ? <Home token={token} user={user} active={active} onEmergency={setActive} onOpenContacts={() => setTab("contacts")} onOpenHistory={() => setTab("history")} onOpenOperator={() => setTab("operator")} onLogout={handleLogout} /> : tab === "contacts" ? <Contacts token={token} /> : tab === "history" ? <History token={token} /> : <Operator token={token} />; 
  return <SafeAreaView style={styles.app}><StatusBar style="light" />{body}<View style={styles.nav}>{([ ["home", "Home", "home-outline"], ["contacts", "Contacts", "people-outline"], ["history", "History", "time-outline"], ["operator", "Command", "radio-outline"] ] as [Tab, string, keyof typeof Ionicons.glyphMap][]).map(([key, label, icon]) => <Pressable key={key} testID={`tab-${key}`} onPress={() => setTab(key)} style={styles.navItem}><Icon name={icon} color={tab === key ? "#FF3B30" : "#64748B"} size={21} /><Text style={[styles.navLabel, tab === key && styles.navLabelActive]}>{label}</Text></Pressable>)}</View></SafeAreaView>; 
}

const styles = StyleSheet.create({ 
  app: { flex: 1, backgroundColor: "#0B0F19" }, 
  authWrap: { flex: 1, backgroundColor: "#0B0F19", padding: 24, justifyContent: "center" }, 
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 56 }, 
  brandMark: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#131825", borderWidth: 1, borderColor: "#FF3B30" }, 
  brand: { color: "#F8FAFC", fontSize: 23, fontWeight: "900", letterSpacing: 3 }, 
  eyebrow: { color: "#FF3B30", fontSize: 11, fontWeight: "800", letterSpacing: 1.5 }, 
  kicker: { color: "#FF3B30", fontSize: 11, fontWeight: "800", letterSpacing: 1.5 }, 
  authHero: { marginBottom: 28 }, 
  authTitle: { color: "#F8FAFC", fontSize: 34, lineHeight: 39, fontWeight: "900", marginTop: 12, marginBottom: 12 }, 
  muted: { color: "#94A3B8", fontSize: 15, lineHeight: 23 }, 
  mutedSmall: { color: "#94A3B8", fontSize: 12, lineHeight: 18 }, 
  authCard: { gap: 12 }, 
  input: { minHeight: 50, backgroundColor: "#131825", borderRadius: 12, borderWidth: 1, borderColor: "#1E293B", color: "#F8FAFC", paddingHorizontal: 16, fontSize: 15 }, 
  button: { minHeight: 50, borderRadius: 12, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 }, 
  button_primary: { backgroundColor: "#FF3B30" }, 
  button_secondary: { backgroundColor: "#131825", borderWidth: 1, borderColor: "#334155" }, 
  button_ghost: { backgroundColor: "transparent" }, 
  buttonText: { color: "#0B0F19", fontSize: 14, fontWeight: "900", letterSpacing: 0.4 }, 
  buttonTextLight: { color: "#F8FAFC" }, 
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] }, 
  disabled: { opacity: 0.5 }, 
  loader: { marginVertical: 4 }, 
  switchText: { color: "#FF3B30", textAlign: "center", fontWeight: "700", padding: 12 }, 
  legal: { color: "#64748B", fontSize: 11, textAlign: "center", marginTop: 45 }, 
  error: { color: "#FF6B63", fontSize: 13 }, 
  scroll: { padding: 20, paddingBottom: 110 }, 
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }, 
  screenTitle: { color: "#F8FAFC", fontSize: 27, fontWeight: "900", marginTop: 6 }, 
  iconButton: { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#131825", borderWidth: 1, borderColor: "#1E293B" }, 
  safeCard: { padding: 20, backgroundColor: "#13251E", borderRadius: 18, borderWidth: 1, borderColor: "#24543B", marginBottom: 14 }, 
  alertCard: { backgroundColor: "#2A1719", borderColor: "#7F1D1D" }, 
  statusLine: { flexDirection: "row", alignItems: "center", gap: 8 }, 
  statusDot: { width: 9, height: 9, borderRadius: 10, backgroundColor: "#38D996" }, 
  statusDotAlert: { backgroundColor: "#FF3B30" }, 
  statusText: { color: "#F8FAFC", fontSize: 12, fontWeight: "900", letterSpacing: 1.2 }, 
  statusTime: { color: "#94A3B8", fontSize: 11, marginLeft: "auto", fontWeight: "700" }, 
  monitoring: { color: "#F8FAFC", fontSize: 22, fontWeight: "900", marginTop: 20, marginBottom: 4 }, 
  quickGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 14 }, 
  infoCard: { width: "48.5%", minHeight: 92, backgroundColor: "#131825", borderRadius: 14, borderWidth: 1, borderColor: "#1E293B", padding: 13 }, 
  infoLabel: { color: "#64748B", fontSize: 10, fontWeight: "800", marginTop: 8 }, 
  infoValue: { color: "#F8FAFC", fontSize: 13, fontWeight: "700", marginTop: 5 }, 
  map: { height: 275, borderRadius: 18, backgroundColor: "#101826", borderWidth: 1, borderColor: "#25334A", overflow: "hidden", position: "relative", marginBottom: 14 }, 
  mapCompact: { height: 205 }, 
  mapGrid: { ...StyleSheet.absoluteFillObject, opacity: 0.33, backgroundColor: "#142236", borderWidth: 1, borderColor: "#1D3A56" }, 
  mapLabel: { position: "absolute", top: 14, left: 15, color: "#64748B", fontSize: 10, fontWeight: "800", letterSpacing: 1.3 }, 
  station: { position: "absolute", width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "#1E293B" }, 
  markerText: { position: "absolute", color: "#94A3B8", fontSize: 9, fontWeight: "800" }, 
  route: { height: 2, backgroundColor: "#FF3B30", position: "absolute", transformOrigin: "left" }, 
  droneMarker: { position: "absolute", width: 30, height: 30, borderRadius: 9, backgroundColor: "#FFB020", alignItems: "center", justifyContent: "center" }, 
  userMarker: { position: "absolute", width: 32, height: 32, borderRadius: 16, backgroundColor: "#38D996", alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#163A2D" }, 
  coordinates: { position: "absolute", bottom: 14, left: 15, color: "#64748B", fontFamily: Platform.select({ ios: "Courier", android: "monospace", default: "monospace" }), fontSize: 10 }, 
  actionRow: { flexDirection: "row", gap: 8, marginBottom: 28 }, 
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }, 
  sectionTitle: { color: "#F8FAFC", fontSize: 18, fontWeight: "900" }, 
  link: { color: "#FF3B30", fontWeight: "800", fontSize: 13 }, 
  toolRow: { gap: 10 }, 
  tool: { backgroundColor: "#131825", borderRadius: 14, minHeight: 62, borderWidth: 1, borderColor: "#1E293B", paddingHorizontal: 15, flexDirection: "row", alignItems: "center", gap: 13 }, 
  toolTitle: { color: "#F8FAFC", fontWeight: "800", fontSize: 14 }, 
  toolDetail: { color: "#64748B", fontSize: 12, marginTop: 3 }, 
  etaCard: { backgroundColor: "#131825", borderRadius: 16, borderWidth: 1, borderColor: "#FF3B30", padding: 17, marginBottom: 24, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, 
  eta: { color: "#F8FAFC", fontSize: 31, fontWeight: "900", marginTop: 4 }, 
  droneBadge: { alignItems: "center", gap: 3 }, 
  droneBadgeText: { color: "#FFB020", fontWeight: "900" }, 
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.78)", justifyContent: "center", padding: 22 }, 
  sosModal: { backgroundColor: "#131825", borderRadius: 22, padding: 25, borderWidth: 1, borderColor: "#7F1D1D", alignItems: "center", gap: 13 }, 
  sosIcon: { width: 68, height: 68, borderRadius: 34, backgroundColor: "#2A1719", alignItems: "center", justifyContent: "center" }, 
  modalEyebrow: { color: "#FF3B30", fontWeight: "900", letterSpacing: 1.2, fontSize: 11 }, 
  modalTitle: { color: "#F8FAFC", fontSize: 27, fontWeight: "900" }, 
  formCard: { backgroundColor: "#131825", borderRadius: 17, padding: 15, gap: 10, borderWidth: 1, borderColor: "#1E293B", marginTop: 20, marginBottom: 16 }, 
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: 90, gap: 10 }, 
  emptyTitle: { color: "#F8FAFC", fontSize: 18, fontWeight: "900" }, 
  contactCard: { backgroundColor: "#131825", borderRadius: 16, padding: 15, marginTop: 11, borderWidth: 1, borderColor: "#1E293B", flexDirection: "row", alignItems: "center", gap: 12 }, 
  avatar: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#2A1719" }, 
  avatarText: { color: "#FF3B30", fontSize: 18, fontWeight: "900" }, 
  contactMain: { flex: 1 }, 
  contactName: { color: "#F8FAFC", fontSize: 15, fontWeight: "900" }, 
  delivery: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 7 }, 
  deliveryText: { color: "#FFB020", fontSize: 10, fontWeight: "700" }, 
  historyCard: { backgroundColor: "#131825", borderRadius: 16, padding: 15, marginTop: 11, borderWidth: 1, borderColor: "#1E293B", flexDirection: "row", gap: 13 }, 
  historyIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: "#2A1719", alignItems: "center", justifyContent: "center" }, 
  historyStatus: { color: "#FF3B30", fontSize: 11, fontWeight: "900", marginTop: 7, letterSpacing: 0.5 }, 
  tabRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  subTabButton: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: "#131825", borderWidth: 1, borderColor: "#1E293B", alignItems: "center" },
  subTabActive: { borderColor: "#FF3B30", backgroundColor: "#2A1719" },
  subTabText: { color: "#64748B", fontSize: 12, fontWeight: "800" },
  subTabTextActive: { color: "#F8FAFC" },
  operatorHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, marginBottom: 16 }, 
  operatorCard: { backgroundColor: "#131825", borderRadius: 16, borderWidth: 1, borderColor: "#FF3B30", padding: 16, flexDirection: "row", justifyContent: "space-between", marginTop: 12 }, 
  operatorRight: { alignItems: "flex-end", gap: 8 }, 
  fleetGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 16 },
  droneCard: { width: "48.5%", backgroundColor: "#131825", borderRadius: 14, borderWidth: 1, borderColor: "#1E293B", padding: 12, gap: 4 },
  droneCardTitle: { color: "#F8FAFC", fontSize: 14, fontWeight: "900" },
  droneCardCoords: { color: "#64748B", fontSize: 10, fontFamily: Platform.select({ ios: "Courier", android: "monospace", default: "monospace" }) },
  droneStatusTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  tagAvailable: { backgroundColor: "#13251E", borderWidth: 1, borderColor: "#24543B" },
  tagDispatched: { backgroundColor: "#2A1719", borderWidth: 1, borderColor: "#7F1D1D" },
  droneStatusTagText: { fontSize: 8, fontWeight: "900", color: "#38D996" },
  nav: { position: "absolute", bottom: 0, left: 0, right: 0, height: 76, paddingBottom: 10, paddingTop: 10, backgroundColor: "#0B0F19", borderTopWidth: 1, borderTopColor: "#1E293B", flexDirection: "row", justifyContent: "space-around" }, 
  navItem: { alignItems: "center", justifyContent: "center", gap: 4, minWidth: 64 }, 
  navLabel: { color: "#64748B", fontSize: 10, fontWeight: "700" }, 
  navLabelActive: { color: "#FF3B30" }, 
  walkChipRow: { flexDirection: "row", gap: 10, alignSelf: "stretch", marginVertical: 6 }, 
  walkChip: { flex: 1, minHeight: 56, borderRadius: 12, backgroundColor: "#0F1A2E", borderWidth: 1, borderColor: "#334155", alignItems: "center", justifyContent: "center" }, 
  walkChipText: { color: "#F8FAFC", fontWeight: "900", fontSize: 16 }, 
  walkChipUnit: { color: "#64748B", fontSize: 9, fontWeight: "800", marginTop: 2 }, 
  graceNumber: { color: "#FFB020", fontSize: 44, fontWeight: "900" }, 
  safeBanner: { flexDirection: "row", alignItems: "center", gap: 9, backgroundColor: "#13251E", borderColor: "#24543B", borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 14 }, 
  safeBannerText: { flex: 1, color: "#38D996", fontWeight: "800", fontSize: 12, lineHeight: 17 } 
});