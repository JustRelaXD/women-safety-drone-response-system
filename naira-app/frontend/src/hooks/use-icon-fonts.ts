import { useEffect, useState } from "react";
import * as Font from "expo-font";
import { Ionicons } from "@expo/vector-icons";

export function useIconFonts() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await Font.loadAsync(Ionicons.font);
        setLoaded(true);
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Font load failed"));
        setLoaded(true);
      }
    })();
  }, []);

  return [loaded, error] as const;
}
