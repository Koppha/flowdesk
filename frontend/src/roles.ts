export function roleLabel(role: string | null | undefined): string {
  if (!role) return "—";
  return role
    .trim()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.length <= 4 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}
