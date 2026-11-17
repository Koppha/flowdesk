import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { api } from "./api";

// Requests OS permission, then registers the resulting Expo push token with
// the backend (POST /auth/push-token) - see the FlowDesk Mobile write-up's
// Notification delivery section: Expo's push service, not a raw FCM/APNs
// integration, so this one call is all registration needs.
export async function registerForPushNotifications(): Promise<{ granted: boolean }> {
  if (!Device.isDevice) {
    // Simulators/emulators can't receive push - treat as a no-op success
    // so the app doesn't block on it during development.
    return { granted: false };
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== "granted") {
    return { granted: false };
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const { data: expoPushToken } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined
  );

  try {
    await api.registerPushToken(expoPushToken);
  } catch {
    // Non-fatal - the app still works without push, just without alerts.
  }

  return { granted: true };
}
