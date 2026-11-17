import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "@/lib/api";
import StatusPill, { type StatusPillProps } from "@/components/StatusPill";
import { colors, radii, spacing } from "@/theme";

type Claim = {
  id: string;
  month: string | null;
  status: string;
  claim_total: number;
  closed_at: string | null;
};

function toneFor(status: string): StatusPillProps["tone"] {
  const s = status.toUpperCase();
  if (s.includes("REJECT") || s.includes("CANCEL")) return "bad";
  if (s.includes("SETTLE") || s.includes("CLOSE")) return "good";
  if (s === "DRAFT") return "muted";
  return "warn";
}

export default function MyClearancesScreen() {
  const [items, setItems] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.myClearances();
        setItems(Array.isArray(res) ? res : res.items || []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {items.map((c) => (
        <View key={c.id} style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.title}>{c.month ? `${c.month} Travel Clearance` : "Travel Clearance"}</Text>
            <Text style={styles.amount}>M{Number(c.claim_total).toFixed(2)}</Text>
          </View>
          <View style={styles.pillRow}>
            <StatusPill label={c.status.replace(/_/g, " ")} tone={toneFor(c.status)} />
          </View>
          <Text style={styles.meta}>{c.closed_at ? `Closed ${new Date(c.closed_at).toLocaleDateString()}` : "In progress"}</Text>
        </View>
      ))}
      {items.length === 0 && <Text style={styles.empty}>No clearances yet.</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper1 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: spacing.lg },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  title: { fontSize: 14.5, fontWeight: "600", color: colors.ink },
  amount: { fontSize: 15, fontWeight: "700", color: colors.ink },
  pillRow: { marginTop: spacing.sm },
  meta: { marginTop: spacing.sm, fontSize: 12, color: colors.muted },
  empty: { textAlign: "center", color: colors.muted, marginTop: spacing.xxl }
});
