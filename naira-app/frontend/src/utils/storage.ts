import AsyncStorage from "@react-native-async-storage/async-storage";

export const storage = {
  async secureSet(key: string, value: any): Promise<void> {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  async secureGet<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const val = await AsyncStorage.getItem(key);
      return val ? JSON.parse(val) : defaultValue;
    } catch {
      return defaultValue;
    }
  },
  async setItem(key: string, value: any): Promise<void> {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  async getItem<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const val = await AsyncStorage.getItem(key);
      return val ? JSON.parse(val) : defaultValue;
    } catch {
      return defaultValue;
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(key);
    } catch {}
  }
};
