import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Stack, useRouter, useSegments } from "expo-router";
import { AuthProvider, useAuth } from "@/context/auth-context";
import { colors } from "@/theme";

function RootNavigation() {
  const { status, justLoggedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    const top = segments[0] as string | undefined;
    if (status === "signedOut" && top !== "login") {
      router.replace("/login");
    } else if (status === "locked" && top !== "unlock") {
      router.replace("/unlock");
    } else if (status === "signedIn" && (top === "login" || top === "unlock" || top === undefined)) {
      router.replace(justLoggedIn ? "/push-permission" : "/(tabs)");
    }
  }, [status, justLoggedIn, segments, router]);

  if (status === "loading") {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="unlock" />
      <Stack.Screen name="push-permission" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="my-advances" options={{ headerShown: true, title: "My Advance Requests" }} />
      <Stack.Screen name="my-clearances" options={{ headerShown: true, title: "My Clearances" }} />
      <Stack.Screen name="item/[id]" options={{ headerShown: true, title: "" }} />
      <Stack.Screen name="confirmed" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaProvider>
        <AuthProvider>
          <RootNavigation />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface }
});
