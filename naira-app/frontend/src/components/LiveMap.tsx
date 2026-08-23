import { Ionicons } from "@expo/vector-icons";
import { Image, StyleSheet, Text, View } from "react-native";

type Emergency = {
  id: string;
  status: string;
  location: { latitude: number; longitude: number };
  drone: {
    id: string;
    status: string;
    battery: number;
    location: { latitude: number; longitude: number };
    eta_seconds: number;
    distance_km: number;
  };
  station?: { latitude: number; longitude: number };
};

type LiveMapProps = {
  compact?: boolean;
  center?: { latitude: number; longitude: number };
  emergency?: Emergency | null;
};

export function LiveMap({ compact = false, center, emergency }: LiveMapProps) {
  const userLat = emergency ? emergency.location.latitude : center?.latitude ?? 12.9141;
  const userLon = emergency ? emergency.location.longitude : center?.longitude ?? 74.8560;

  return (
    <View style={[styles.map, compact && styles.mapCompact]}>
      <View style={styles.mapGrid}>
        <Image
          source={{ uri: "https://a.basemaps.cartocdn.com/dark_all/14/11598/7542.png" }}
          style={StyleSheet.absoluteFillObject}
          resizeMode="cover"
        />
        <View style={styles.overlay} />
      </View>
      <Text style={styles.mapLabel}>LIVE TACTICAL DISPATCH GRID · CARTO OSM</Text>

      <View style={[styles.station, { top: "35%", left: "25%" }]}>
        <Ionicons name="radio" color="#64748B" size={14} />
      </View>

      <View style={[styles.userMarker, { top: "55%", left: "65%" }]}>
        <Ionicons name="person" color="#0B0F19" size={14} />
      </View>

      {emergency && (
        <View style={[styles.droneMarker, { top: "42%", left: "45%" }]}>
          <Ionicons name="navigate" color="#0B0F19" size={15} />
        </View>
      )}

      <Text style={styles.coordinates}>
        GPS {userLat.toFixed(4)} N, {userLon.toFixed(4)} E · {emergency ? emergency.status : "SAFE"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    height: 275,
    borderRadius: 18,
    backgroundColor: "#101826",
    borderWidth: 1,
    borderColor: "#25334A",
    overflow: "hidden",
    position: "relative",
    marginBottom: 14,
  },
  mapCompact: { height: 205 },
  mapGrid: { ...StyleSheet.absoluteFillObject, backgroundColor: "#0F172A" },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(11, 15, 25, 0.45)" },
  mapLabel: { position: "absolute", top: 14, left: 15, color: "#64748B", fontSize: 10, fontWeight: "800", letterSpacing: 1.3 },
  station: { position: "absolute", width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "#1E293B", borderWidth: 1, borderColor: "#334155" },
  droneMarker: { position: "absolute", width: 32, height: 32, borderRadius: 16, backgroundColor: "#FFB020", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#78350F" },
  userMarker: { position: "absolute", width: 32, height: 32, borderRadius: 16, backgroundColor: "#38D996", alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "#163A2D" },
  coordinates: { position: "absolute", bottom: 14, left: 15, color: "#94A3B8", fontSize: 10, fontWeight: "700" },
});
