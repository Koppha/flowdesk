import type { LucideIcon } from "lucide-react";
import {
  BarChart3, Banknote, Briefcase, Building2, Calendar, ClipboardList, Clock3, FileText, Folder, FolderTree,
  GitBranch, Home, Layers, LayoutGrid, Mail, Monitor, Network, Settings, ShieldCheck, Sparkles, Star,
  Truck, Users, Wallet, Wrench
} from "lucide-react";

// Icons an admin can give a menu group (stored by name in the layout).
export const GROUP_ICONS: Record<string, LucideIcon> = {
  Folder, FolderTree, Layers, LayoutGrid, Star,
  ClipboardList, FileText, GitBranch, Wallet, Banknote, BarChart3, Users, Network, Settings,
  Wrench, Briefcase, Building2, Calendar, Clock3, Mail, Monitor, ShieldCheck, Sparkles, Truck, Home
};

export const groupIcon = (name: string): LucideIcon => GROUP_ICONS[name] ?? Folder;
