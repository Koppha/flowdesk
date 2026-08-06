import React, { useEffect, useMemo, useState } from "react";
import Swal from "sweetalert2";
import { api } from "./api";
import { useStaffDirectory, isActiveStaff, type StaffMember } from "./useStaffDirectory";
import WorkflowAddParticipantModal from "./WorkflowAddParticipantModal";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  Copy,
  Eye,
  Filter,
  GitBranch,
  GripVertical,
  Landmark,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Scale,
  Search,
  ShieldCheck,
  ShoppingCart,
  Trash2,
  User,
  UserRoundCheck,
  Users,
  X
} from "lucide-react";

type WorkflowStatus = "DRAFT" | "ACTIVE" | "INACTIVE";
type WorkflowMode = "create" | "edit" | "view";
type WorkflowScreen = "LIST" | "DETAILS" | "TEMPLATE" | "DESIGNER";

type PositionType = {
  id: string;
  name: string;
  code: string;
  description: string;
  applies_to: string[];
  is_active: boolean;
  assignedUserId?: string | null;
  approvalMode?: "SINGLE" | "ANY_ONE";
  approvalGroupName?: string | null;
};

type WorkflowStep = {
  id: string;
  workflowId?: string | null;
  stepOrder: number;
  positionTypeId?: string | null;
  positionTypeCode: string;
  assignedUserId?: string | null;
  approvalMode: "SINGLE" | "ANY_ONE";
  approvalGroupName: string | null;
  positionName: string;
  description: string;
  isRequired: boolean;
  skipIfUnassigned: boolean;
  allowDelegation: boolean;
  commentsRequired: boolean;
  escalationDays: number;
  isFinalApproval: boolean;
  isSystemStep: boolean;
  isActive: boolean;
  requiresAccommodation: boolean;
  parallelWithPrevious: boolean;
  // Not a fixed enum - admins can register custom action types (e.g.
  // "DEPT_CAPTURE") via the Action Types panel, beyond the 3 built-ins.
  actionType: string;
  canReject: boolean;
  canRollback: boolean;
};

type WorkflowRule = {
  id: string;
  workflowId?: string | null;
  ruleName: string;
  conditionField: string;
  conditionOperator: string;
  conditionValue: string;
  additionalPositionTypeId: string;
  additionalPositionName?: string | null;
  additionalAssignedUserId?: string | null;
  isActive: boolean;
};

type WorkflowRuleDraft = Omit<WorkflowRule, "id" | "workflowId">;

type RuleTargetOption = {
  value: string;
  group: string;
  label: string;
  code: string;
  positionName: string;
  assignedUserId: string | null;
};

type Workflow = {
  id: string;
  name: string;
  requestType: string;
  advanceSubType?: string | null;
  department?: string | null;
  section?: string | null;
  team?: string | null;
  description?: string | null;
  status: WorkflowStatus;
  requesterRoles?: string[] | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  stepCount: number;
  approvalFlowPreview: string;
  steps: WorkflowStep[];
  rules: WorkflowRule[];
};

type WorkflowMetadata = {
  name: string;
  requestType: string;
  advanceSubType: string;
  division: string;
  department: string;
  section: string;
  team: string;
  description: string;
  status: WorkflowStatus;
  requesterRoles: string[];
};

const ALL_REQUEST_TYPES = [
  "ADVANCE_REQUEST",
  "TRAVEL_REQUEST",
  "OVERTIME_REQUEST",
  "PROCUREMENT_REQUEST",
  "CLEARANCE_REQUEST",
  "PETTY_CASH_REQUEST",
  "CLAIM_REQUEST"
];

// Must stay in sync with the built-in module list on the Request Types page
const BUILTIN_REQUEST_TYPES = [
  { value: "ADVANCE_REQUEST", label: "Advance Request" },
  { value: "CLEARANCE_REQUEST", label: "Clearance Request" },
  { value: "OVERTIME_REQUEST", label: "Overtime Request" }
];

const STATUS_OPTIONS: Array<{ value: WorkflowStatus; label: string }> = [
  { value: "DRAFT", label: "Draft" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" }
];

const POSITION_TYPE_FALLBACKS: PositionType[] = [
  { id: "system-employee", code: "EMPLOYEE", name: "Employee", description: "Request Initiator", applies_to: ALL_REQUEST_TYPES, is_active: true },
  { id: "pos-hod", code: "HOD", name: "HOD", description: "Division Head", applies_to: ALL_REQUEST_TYPES, is_active: true },
  { id: "pos-manager", code: "MANAGER", name: "Manager", description: "Division Manager", applies_to: ALL_REQUEST_TYPES, is_active: true },
  { id: "pos-exco", code: "EXCO", name: "EXCO Member", description: "Executive Committee Member", applies_to: ALL_REQUEST_TYPES, is_active: true },
  { id: "pos-ceo", code: "CEO", name: "CEO", description: "Chief Executive Officer", applies_to: ALL_REQUEST_TYPES, is_active: true }
];

type TemplateStepDef = string | {
  code: string;
  name: string;
  description?: string;
  // Role-based ANY_ONE group (e.g. "EXCO", "CEO", "Team: X") instead of a
  // specific assignedUserId - self-maintaining as membership changes, since
  // getUserGroups() already includes a user's own role as a group name.
  approvalMode?: "SINGLE" | "ANY_ONE";
  approvalGroupName?: string;
  assignedUserId?: string;
  allowDelegation?: boolean;
  // Not a fixed enum in practice - admins can register custom action types
  // (e.g. "DEPT_CAPTURE") via the Action Types panel, beyond the 3 built-ins.
  actionType?: string;
};

const TEMPLATE_DEFINITIONS: Array<{ id: string; name: string; description: string; steps: TemplateStepDef[] }> = [
  {
    id: "BLANK",
    name: "Blank Workflow",
    description: "Start from scratch",
    steps: ["EMPLOYEE"]
  },
  {
    id: "STANDARD",
    name: "Standard Approval",
    description: "Counter Signer → Approver → Finance",
    steps: [
      "EMPLOYEE",
      { code: "MANAGER", name: "Counter Signer", description: "Manager, Supervisor or Delegated person to counter-sign" },
      { code: "FINANCE", name: "Finance", description: "Finance processes and settles the advance" }
    ]
  },
  {
    id: "EXECUTIVE",
    name: "Executive Approval",
    description: "Employee to HOD to Manager to Finance",
    steps: ["EMPLOYEE", "HOD", "MANAGER", "FINANCE"]
  },
  {
    id: "TRAVEL",
    name: "Travel Workflow",
    description: "Employee to HOD to Manager to Finance",
    steps: ["EMPLOYEE", "HOD", "MANAGER", "FINANCE"]
  },
  {
    id: "INTERNATIONAL_TRAVEL",
    name: "International Travel / Rest of Africa",
    description: "Employee → EXCO → GM - Human Resources → CEO → Treasury Capture → Payment Officer",
    steps: [
      "EMPLOYEE",
      { code: "EXCO", name: "EXCO Member", approvalMode: "ANY_ONE", approvalGroupName: "EXCO", allowDelegation: true },
      // GM - Human Resources is a specific title, not a role class like EXCO/CEO,
      // so it stays a named assignment - update this id if that person changes.
      { code: "EXCO", name: "GM - Human Resources", assignedUserId: "3c8dbb3c-6469-4ac3-b198-51bd161e84f1", allowDelegation: true },
      { code: "CEO", name: "CEO", approvalMode: "ANY_ONE", approvalGroupName: "CEO", allowDelegation: true },
      { code: "MANAGER", name: "Team: Treasury & Financial Accounting", approvalMode: "ANY_ONE", approvalGroupName: "Team: Treasury & Financial Accounting", actionType: "DEPT_CAPTURE", allowDelegation: true },
      { code: "MANAGER", name: "Agnes Mohapi", assignedUserId: "3ca53b79-e9f2-4501-af38-366882c1c050", actionType: "MARK_PAID", allowDelegation: true }
    ]
  },
  {
    id: "PROCUREMENT",
    name: "Procurement Workflow",
    description: "Employee to Manager to Procurement to Finance",
    steps: ["EMPLOYEE", "MANAGER", "PROCUREMENT", "FINANCE"]
  }
];

const EMPTY_METADATA: WorkflowMetadata = {
  name: "",
  requestType: "ADVANCE_REQUEST",
  advanceSubType: "SALARY",
  division: "",
  department: "",
  section: "",
  team: "",
  description: "",
  status: "DRAFT",
  requesterRoles: []
};

const ADVANCE_SUB_TYPES_STATIC = [
  { value: "SALARY", label: "Salary Advance" },
  { value: "LOAN",   label: "Loan" },
  { value: "TRAVEL", label: "Travel / Per Diem (Any Type)" },
];


const DEFAULT_RULES: WorkflowRule[] = [
  {
    id: "rule-high-value",
    ruleName: "High Value Approval",
    conditionField: "Amount",
    conditionOperator: ">",
    conditionValue: "20000",
    additionalPositionTypeId: "pos-finance",
    additionalPositionName: "Finance",
    additionalAssignedUserId: null,
    isActive: true
  },
  {
    id: "rule-very-high-value",
    ruleName: "Very High Value Approval",
    conditionField: "Amount",
    conditionOperator: ">",
    conditionValue: "50000",
    additionalPositionTypeId: "pos-ceo",
    additionalPositionName: "CEO",
    additionalAssignedUserId: null,
    isActive: true
  }
];

const RULE_TARGET_ROLE_CODES = ["HOD", "MANAGER", "FINANCE", "CEO"];
const RULE_TARGET_STAFF_ROLES = ["HOD", "MANAGER", "FINANCE", "CEO"];

function generateId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2, 10)}`;
}

function requestTypeLabel(value: string, options?: Array<{ value: string; label: string }>) {
  return options?.find((option) => option.value === value)?.label || value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function getDepartmentName(department: any) {
  return typeof department === "string"
    ? department.trim()
    : String(department?.name || department?.department || "").trim();
}

function assignedRuleTargetValue(userId: string, code: string) {
  return `assigned:${userId}:${code}`;
}

function assignedRuleTargetCode(value: string | undefined | null) {
  const match = String(value || "").match(/^assigned:[^:]+:(.+)$/);
  return match?.[1] || "";
}

function staffName(user: StaffMember | undefined | null) {
  return String(user?.full_name || user?.email || "").trim();
}

function staffOrgPath(user: StaffMember | undefined | null) {
  return [user?.department, user?.section_name, user?.team_name].filter(Boolean).join(" / ");
}

function staffRoleToWorkflowCode(role: string | undefined | null) {
  switch (String(role || "").toUpperCase()) {
    case "HOD":
    case "MANAGER":
    case "FINANCE":
    case "CEO":
      return String(role || "").toUpperCase();
    default:
      return "";
  }
}

function workflowCodeLabel(code: string) {
  const known = POSITION_TYPE_FALLBACKS.find((position) => position.code === code);
  return known?.name || code.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

// Steps added via "add a team" are stored with a "Team: " position_name/
// approvalGroupName prefix (see handleAddTeam below) — that stored value must
// stay as-is so existing saved workflow steps keep matching, but it should
// read as "Section: " wherever it's shown to a user (Team -> Section rename).
function displayPositionName(name: string) {
  return name.startsWith("Team: ") ? `Section: ${name.slice("Team: ".length)}` : name;
}

function getPositionIcon(code: string) {
  switch (code) {
    case "HOD":
      return Users;
    case "MANAGER":
      return UserRoundCheck;
    case "FINANCE":
      return Landmark;
    case "PROCUREMENT":
      return ShoppingCart;
    case "LEGAL_REVIEW":
      return Scale;
    case "CEO":
      return UserRoundCheck;
    case "TEAM_APPROVAL":
      return Users;
    default:
      return User;
  }
}

function getPositionToneClass(code: string) {
  return `workflow-tone-${String(code || "default").toLowerCase().replace(/_/g, "-")}`;
}

function getStatusPill(status: WorkflowStatus) {
  if (status === "ACTIVE") return "status-pill status-pill-success";
  if (status === "DRAFT") return "status-pill status-pill-warning";
  return "status-pill status-pill-danger";
}

export default function WorkflowBuilder() {
  const [screen, setScreen] = useState<WorkflowScreen>("LIST");
  const [mode, setMode] = useState<WorkflowMode>("create");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [positionTypes, setPositionTypes] = useState<PositionType[]>(POSITION_TYPE_FALLBACKS);
  const [departments, setDepartments] = useState<any[]>([]);
  const [orgStructure, setOrgStructure] = useState<{ divisions: any[]; departments: any[]; sections: any[]; teams: any[] }>({ divisions: [], departments: [], sections: [], teams: [] });
  const [extraPositions, setExtraPositions] = useState<PositionType[]>([]);
  const [showAddPosition, setShowAddPosition] = useState(false);
  const { staff } = useStaffDirectory();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [metadata, setMetadata] = useState<WorkflowMetadata>(EMPTY_METADATA);
  // Multi-select of request types for a NEW workflow (step 1 of the create
  // flow only) - checking more than one creates one workflow per type at
  // save time, all sharing the same steps/rules. Editing an existing
  // workflow never revisits step 1, so this only matters during creation.
  const [selectedRequestTypeValues, setSelectedRequestTypeValues] = useState<string[]>([`${EMPTY_METADATA.requestType}:${EMPTY_METADATA.advanceSubType}`]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("STANDARD");
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [selectedStepId, setSelectedStepId] = useState<string>("");
  const [rules, setRules] = useState<WorkflowRule[]>(DEFAULT_RULES);
  const [ruleDraft, setRuleDraft] = useState<WorkflowRuleDraft>({ ruleName: "", conditionField: "Amount", conditionOperator: ">", conditionValue: "", additionalPositionTypeId: "pos-finance", additionalPositionName: "Finance", additionalAssignedUserId: null, isActive: true });
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [dragSource, setDragSource] = useState<{ type: "step" | "position"; id: string; overrides?: { positionName?: string; description?: string; assignedUserId?: string | null; approvalMode?: "SINGLE" | "ANY_ONE"; approvalGroupName?: string | null } } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [requestTypeFilter, setRequestTypeFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [workflowPage, setWorkflowPage] = useState(1);
  const [customRequestTypes, setCustomRequestTypes] = useState<Array<{ value: string; label: string }>>([]);
  const [travelTypes, setTravelTypes] = useState<Array<{ code: string; name: string; active?: boolean }>>([]);
  const [loading, setLoading] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [allUsers, setAllUsers] = useState<Array<{ id: string; full_name: string | null; email: string; role: string; department: string | null; employee_no: string | null; section_id?: string | null; section_name?: string | null; team_name?: string | null }>>([]);
  const [stepUserSearch, setStepUserSearch] = useState<Record<string, string>>({});
  const [managerTypes, setManagerTypes] = useState<Array<{ id: string; name: string; role: string; description: string | null; active: boolean; sort_order: number }>>([]);
  const [actionTypes, setActionTypes] = useState<Array<{ id: number; code: string; label: string; is_system: boolean; is_active: boolean; sort_order: number }>>([]);
  const [myRole, setMyRole] = useState<string>("");
  const [showActionTypesPanel, setShowActionTypesPanel] = useState(false);
  const [actionTypeDraft, setActionTypeDraft] = useState({ code: "", label: "" });
  const [actionTypeError, setActionTypeError] = useState("");

  const requestTypeOptions = useMemo(() => {
    const custom = customRequestTypes.filter((c) => !BUILTIN_REQUEST_TYPES.some((b) => b.value === c.value));
    return [...BUILTIN_REQUEST_TYPES, ...custom];
  }, [customRequestTypes]);

  // Each travel type gets its own selectable sub-type (in addition to the
  // generic "Travel / Per Diem (Any Type)" bucket) so international travel,
  // local travel, etc. can each be routed through a dedicated workflow.
  // resolveWorkflowChain already matches an exact travel-type code with
  // higher priority than the generic "TRAVEL" bucket — see workflowEngine.ts.
  const advanceSubTypes = useMemo(() => {
    const perTravelType = travelTypes.map((t) => ({ value: t.code, label: `Travel / Per Diem — ${t.name}` }));
    return [...ADVANCE_SUB_TYPES_STATIC, ...perTravelType];
  }, [travelTypes]);

  // A clearance is always for a travel advance (no Salary/Loan clearances),
  // so its sub-types are just the travel types plus a generic "Any Type"
  // bucket — same underlying advance_sub_type column and matching rules as
  // ADVANCE_REQUEST, just scoped by request_type='CLEARANCE_REQUEST'.
  const clearanceSubTypes = useMemo(() => {
    const perTravelType = travelTypes.map((t) => ({ value: t.code, label: `Clearance — ${t.name}` }));
    return [{ value: "TRAVEL", label: "Clearance (Any Type)" }, ...perTravelType];
  }, [travelTypes]);

  const SUB_TYPED_REQUEST_TYPES: Record<string, { value: string; label: string }[]> = {
    ADVANCE_REQUEST: advanceSubTypes,
    CLEARANCE_REQUEST: clearanceSubTypes
  };

  // Splits "Advance Request" and "Clearance Request" into their sub-types
  // (Salary/Loan/per-travel-type, and per-travel-type respectively) so each
  // can be picked directly.
  const step1RequestTypeOptions = useMemo(() => {
    const expanded: { value: string; label: string }[] = [];
    for (const type of requestTypeOptions) {
      const subTypes = SUB_TYPED_REQUEST_TYPES[type.value];
      if (subTypes) {
        for (const sub of subTypes) {
          expanded.push({ value: `${type.value}:${sub.value}`, label: sub.label });
        }
      } else {
        expanded.push(type);
      }
    }
    return expanded;
  }, [requestTypeOptions, advanceSubTypes, clearanceSubTypes]);

  const DEFAULT_SUB_TYPE: Record<string, string> = { ADVANCE_REQUEST: "SALARY", CLEARANCE_REQUEST: "TRAVEL" };

  function handleStep1RequestTypeChange(value: string) {
    const colonIdx = value.indexOf(":");
    const requestType = colonIdx === -1 ? value : value.slice(0, colonIdx);
    if (SUB_TYPED_REQUEST_TYPES[requestType] && colonIdx !== -1) {
      updateMetadata({ requestType, advanceSubType: value.slice(colonIdx + 1) });
    } else {
      updateMetadata({ requestType: value, advanceSubType: "" });
    }
    // A direct single-value change (e.g. from the Designer screen's own
    // Request Type dropdown) collapses any multi-selection from step 1 back
    // down to just this one value, so the two controls can't disagree.
    setSelectedRequestTypeValues([value]);
  }

  // Toggles a request type in/out of the create-flow's multi-select (step 1
  // only - see step1RequestTypeOptions). metadata.requestType/advanceSubType
  // track whichever value is first in the list, since template/step defaults
  // still need one "primary" type to build against - the other checked types
  // reuse those same steps verbatim when saved (see saveWorkflow).
  function toggleRequestTypeValue(value: string) {
    setSelectedRequestTypeValues((current) => {
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      const primary = next[0];
      if (primary) {
        const colonIdx = primary.indexOf(":");
        const requestType = colonIdx === -1 ? primary : primary.slice(0, colonIdx);
        const advanceSubType = colonIdx === -1 ? "" : primary.slice(colonIdx + 1);
        updateMetadata({ requestType, advanceSubType });
      }
      return next;
    });
  }

  function toStep1Value(requestType: string, advanceSubType: string) {
    return SUB_TYPED_REQUEST_TYPES[requestType]
      ? `${requestType}:${advanceSubType || DEFAULT_SUB_TYPE[requestType]}`
      : requestType;
  }

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const readOnly = mode === "view";

  const activePositionTypes = useMemo(
    () => positionTypes.filter((position) => position.is_active),
    [positionTypes]
  );

  const availablePositionTypes = useMemo(
    () => activePositionTypes.filter((position) => position.code !== "EMPLOYEE"),
    [activePositionTypes]
  );

  const scopedPositionTypes = useMemo(() => {
    const byCode = (code: string) => availablePositionTypes.find((position) => position.code === code);

    if (!metadata.department) {
      // HOD is a type of Manager, not a separate draggable position — fold it into Manager.
      const base = availablePositionTypes.filter((p) => p.code !== "FINANCE" && p.code !== "CEO" && p.code !== "HOD");
      return [...base, ...extraPositions];
    }

    const dept = departments.find((department) => getDepartmentName(department) === metadata.department);

    // When a section is selected, prefer the section's own leadership over the department's
    const orgDept = orgStructure.departments.find((d) => d?.name === metadata.department);
    const orgSection = metadata.section
      ? orgStructure.sections.find((s) => s?.name === metadata.section && s?.department_id === orgDept?.id)
      : null;

    const scopeLabel = metadata.section ? `${metadata.section}, ${metadata.department}` : metadata.department;
    const scopeKey = metadata.section ? `${metadata.department}-${metadata.section}` : metadata.department;
    const personLabel = (name: string | null | undefined) => (name ? `${name} — ${scopeLabel}` : `Unassigned — ${scopeLabel}`);

    const cards: PositionType[] = [];

    // HOD is a type of Manager, not a separate draggable position — fold it into Manager.
    const manager = byCode("MANAGER");
    if (manager) cards.push({ ...manager, id: `scoped-manager-${scopeKey}`, description: personLabel(orgSection?.manager_name ?? dept?.manager_name) });

    // EXCO Member for this department/section — shown even when vacant
    // (same "Unassigned — {scope}" treatment as Manager above).
    const exco = byCode("EXCO");
    if (exco) cards.push({ ...exco, id: `scoped-exco-${scopeKey}`, description: personLabel(orgSection?.exco_name ?? dept?.exco_name) });

    // Extra positions added by admin from other departments/sections
    extraPositions.forEach((p) => cards.push(p));

    return cards;
  }, [availablePositionTypes, departments, orgStructure, metadata.department, metadata.section, extraPositions]);

  const selectedStep = useMemo(() => steps.find((step) => step.id === selectedStepId) || steps[0] || null, [steps, selectedStepId]);

  const ruleTargetOptions = useMemo<RuleTargetOption[]>(() => {
    const options: RuleTargetOption[] = [];
    const seen = new Set<string>();

    const addOption = (option: RuleTargetOption) => {
      if (!option.value || seen.has(option.value)) return;
      seen.add(option.value);
      options.push(option);
    };

    const positionByRuleCode = (code: string) =>
      activePositionTypes.find((position) => position.code === code) ||
      POSITION_TYPE_FALLBACKS.find((position) => position.code === code);

    for (const code of RULE_TARGET_ROLE_CODES) {
      const position = positionByRuleCode(code);
      if (!position?.is_active && !POSITION_TYPE_FALLBACKS.some((fallback) => fallback.code === code)) continue;
      addOption({
        value: position?.id || code,
        group: "Approval roles",
        label: position?.name || workflowCodeLabel(code),
        code,
        positionName: position?.name || workflowCodeLabel(code),
        assignedUserId: null
      });
    }

    for (const department of departments) {
      const deptName = getDepartmentName(department);
      if (!deptName) continue;
      const leadership = [
        { code: "HOD", title: "HOD", userId: department.hod_user_id, name: department.hod_name },
        { code: "MANAGER", title: "Manager", userId: department.manager_user_id, name: department.manager_name }
      ];

      for (const leader of leadership) {
        if (!leader.userId) continue;
        addOption({
          value: assignedRuleTargetValue(leader.userId, leader.code),
          group: "Division leadership",
          label: `${deptName} - ${leader.title}${leader.name ? ` (${leader.name})` : ""}`,
          code: leader.code,
          positionName: `${deptName} ${leader.title}`,
          assignedUserId: leader.userId
        });
      }
    }

    const approvers = staff
      .filter((user) => isActiveStaff(user) && RULE_TARGET_STAFF_ROLES.includes(String(user.role || "").toUpperCase()))
      .sort((a, b) => {
        const deptCompare = String(a.department || "").localeCompare(String(b.department || ""));
        if (deptCompare) return deptCompare;
        return staffName(a).localeCompare(staffName(b));
      });

    for (const user of approvers) {
      const code = staffRoleToWorkflowCode(user.role);
      if (!code) continue;
      const name = staffName(user);
      const roleLabel = workflowCodeLabel(code);
      const orgPath = staffOrgPath(user);
      addOption({
        value: assignedRuleTargetValue(user.id, code),
        group: `People - ${user.department || "No Division"}`,
        label: `${name || user.email} - ${roleLabel}${orgPath ? ` - ${orgPath}` : ""}`,
        code,
        positionName: roleLabel,
        assignedUserId: user.id
      });
    }

    return options;
  }, [activePositionTypes, departments, staff]);

  const groupedRuleTargetOptions = useMemo(() => {
    const groups: Array<{ label: string; options: RuleTargetOption[] }> = [];
    const groupIndex = new Map<string, RuleTargetOption[]>();
    for (const option of ruleTargetOptions) {
      let list = groupIndex.get(option.group);
      if (!list) {
        list = [];
        groupIndex.set(option.group, list);
        groups.push({ label: option.group, options: list });
      }
      list.push(option);
    }
    return groups;
  }, [ruleTargetOptions]);

  const defaultRuleTargetValue = useMemo(
    () => ruleTargetOptions.find((option) => option.code === "FINANCE")?.value || ruleTargetOptions[0]?.value || "pos-finance",
    [ruleTargetOptions]
  );

  const departmentOptions = useMemo(() => {
    let base = departments.map(getDepartmentName).filter(Boolean) as string[];
    if (metadata.division) {
      const div = orgStructure.divisions.find((d) => d.name === metadata.division);
      if (div) {
        base = orgStructure.departments
          .filter((d) => (d.division_ids as string[] | undefined)?.includes(div.id) || d.division_id === div.id)
          .map((d) => d.name as string)
          .filter(Boolean);
      }
    }
    return Array.from(new Set([...base, metadata.department].filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [departments, orgStructure, metadata.department, metadata.division]);

  const otherDeptOptions = useMemo(
    () => departmentOptions.filter((d) => d !== metadata.department),
    [departmentOptions, metadata.department]
  );

  const divisionOptionsForPicker = useMemo(
    () => orgStructure.divisions.filter((d) => d.active !== false).map((d) => d.name as string).sort((a, b) => a.localeCompare(b)),
    [orgStructure.divisions]
  );

  function removeExtraPosition(id: string) {
    setExtraPositions((prev) => prev.filter((p) => p.id !== id));
  }

  // Pools + handlers for the unified "Add Workflow Participant" search modal.
  const allSectionNames = useMemo(
    () => Array.from(new Set(orgStructure.sections.map((s: any) => s.name as string).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [orgStructure.sections]
  );
  const allTeamNames = useMemo(
    () => Array.from(new Set(orgStructure.teams.map((t: any) => t.name as string).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [orgStructure.teams]
  );

  const participantPositionPool = useMemo(() => {
    const fromManagerTypes = managerTypes.map((mt) => ({ id: `mt-${mt.id}`, code: mt.role, name: mt.name, description: mt.description || "Custom position" }));
    // HOD is a type of Manager, not a separate searchable position here — selecting
    // "Manager" (or a custom manager type) covers it; only exclude MANAGER itself
    // once a custom manager type already substitutes for it.
    const basePositions = availablePositionTypes
      .filter((p) => p.code !== "HOD" && (managerTypes.length === 0 || p.code !== "MANAGER"))
      .map((p) => ({ id: p.id, code: p.code, name: p.name, description: p.description }));
    return [...fromManagerTypes, ...basePositions];
  }, [managerTypes, availablePositionTypes]);

  const participantTeamPool = useMemo(() => {
    return orgStructure.teams.map((t: any) => {
      const section = orgStructure.sections.find((s: any) => s?.id === t.section_id);
      const dept = section ? orgStructure.departments.find((d: any) => d?.id === section.department_id) : null;
      return { id: t.id, name: t.name, departmentLabel: dept?.name || "", sectionLabel: section?.name || "" };
    });
  }, [orgStructure]);

  // Any active staff member can be named individually as a step's approver,
  // regardless of role — matches the old addExtraMember picker, which never
  // restricted by role. Doesn't require profile_completed either: HOD/Manager/
  // EXCO accounts are routinely provisioned by an admin (role, division, etc.
  // already set via the Managers/Leadership screens) before that person has
  // ever logged in to complete their own profile, and they still need to be
  // assignable as a workflow approver in the meantime.
  const participantEmployeePool = useMemo(() => {
    return staff
      .filter((u) => isActiveStaff(u) && u.role !== "ADMIN")
      .map((u) => ({ id: u.id, full_name: u.full_name, email: u.email, title: u.title, department: u.department }));
  }, [staff]);

  function handleAddParticipantPosition(
    position: { id: string; code: string; name: string; description: string },
    filters: { division: string; department: string; section: string; team: string }
  ) {
    const { division, department, section, team } = filters;
    const managerType = managerTypes.find((mt) => mt.role === position.code && mt.name === position.name);
    let personId: string | null = null;
    let personName: string | null = null;

    if (department) {
      const dept = departments.find((d) => getDepartmentName(d) === department);
      const orgDept = orgStructure.departments.find((d: any) => d?.name === department);
      const orgSection = section ? orgStructure.sections.find((s: any) => s?.name === section && s?.department_id === orgDept?.id) : null;
      const orgTeam = team ? orgStructure.teams.find((t: any) => t?.name === team) : null;

      if (managerType) {
        const candidates = staff.filter((u) => isActiveStaff(u) && u.manager_type_id === managerType.id && u.department === department);
        const person = orgTeam
          ? candidates.find((u) => u.team_id === orgTeam.id) ?? candidates.find((u) => u.section_id === orgSection?.id) ?? candidates[0]
          : orgSection
          ? candidates.find((u) => u.section_id === orgSection.id) ?? candidates[0]
          : candidates[0];
        personId = person?.id ?? null;
        personName = person?.full_name ?? null;
      } else if (position.code === "HOD") {
        personId = orgSection?.hod_user_id ?? dept?.hod_user_id ?? null;
        personName = orgSection?.hod_name ?? dept?.hod_name ?? null;
      } else if (position.code === "MANAGER") {
        personId = orgTeam?.leader_user_id ?? orgSection?.manager_user_id ?? dept?.manager_user_id ?? null;
        personName = orgTeam?.leader_name ?? orgSection?.manager_name ?? dept?.manager_name ?? null;
      } else if (position.code === "EXCO") {
        personId = orgSection?.exco_user_id ?? dept?.exco_user_id ?? null;
        personName = orgSection?.exco_name ?? dept?.exco_name ?? null;
      }
    }

    const scopeLabel = [team, section, department, division].filter(Boolean).join(", ");
    addStep(position.code, steps.length, {
      positionName: position.name,
      description: personName
        ? `${personName} — ${scopeLabel || position.name}`
        : department ? `Unassigned — ${scopeLabel}` : position.description,
      assignedUserId: personId
    });
    setShowAddPosition(false);
  }

  function handleAddParticipantTeam(team: { id: string; name: string; departmentLabel: string }, anyTeamMember: boolean) {
    if (!anyTeamMember) return;
    addStep("MANAGER", steps.length, {
      positionName: `Team: ${team.name}`,
      description: `Anyone in ${team.name}${team.departmentLabel ? ` — ${team.departmentLabel}` : ""}`,
      approvalMode: "ANY_ONE",
      approvalGroupName: `Team: ${team.name}`,
      assignedUserId: null
    });
    setShowAddPosition(false);
  }

  function handleAddParticipantDepartment(name: string, anyDepartmentMember: boolean) {
    if (!anyDepartmentMember) return;
    addStep("MANAGER", steps.length, {
      positionName: `Department: ${name}`,
      description: `Anyone in ${name}`,
      approvalMode: "ANY_ONE",
      approvalGroupName: `Department: ${name}`,
      assignedUserId: null
    });
    setShowAddPosition(false);
  }

  function handleAddParticipantSection(name: string, anySectionMember: boolean) {
    if (!anySectionMember) return;
    addStep("MANAGER", steps.length, {
      positionName: `Section: ${name}`,
      description: `Anyone in ${name}`,
      approvalMode: "ANY_ONE",
      approvalGroupName: `Section: ${name}`,
      assignedUserId: null
    });
    setShowAddPosition(false);
  }

  function handleAddParticipantEmployee(employee: { id: string; full_name: string | null; email: string; department?: string | null }) {
    addStep("MANAGER", steps.length, {
      positionName: employee.full_name || employee.email,
      description: `${employee.full_name || employee.email}${employee.department ? ` — ${employee.department}` : ""}`,
      assignedUserId: employee.id
    });
    setShowAddPosition(false);
  }

  const sectionOptions = useMemo(() => {
    if (!metadata.department) return [];
    const orgDept = orgStructure.departments.find((d) => d?.name === metadata.department);
    if (!orgDept) return [];
    return orgStructure.sections
      .filter((s) => s?.department_id === orgDept.id)
      .map((s) => s.name as string)
      .sort((a, b) => a.localeCompare(b));
  }, [orgStructure, metadata.department]);

  const teamOptions = useMemo(() => {
    if (!metadata.section) return [];
    const orgSection = orgStructure.sections.find((s) => s?.name === metadata.section);
    if (!orgSection) return [];
    return orgStructure.teams
      .filter((t) => t?.section_id === orgSection.id)
      .map((t) => t.name as string)
      .sort((a, b) => a.localeCompare(b));
  }, [orgStructure, metadata.section]);


  const filteredWorkflows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return workflows.filter((workflow) => {
      if (requestTypeFilter && workflow.requestType !== requestTypeFilter) return false;
      if (departmentFilter && (workflow.department || "") !== departmentFilter) return false;
      if (statusFilter && workflow.status !== statusFilter) return false;
      if (!query) return true;
      return [
        workflow.name,
        requestTypeLabel(workflow.requestType),
        workflow.department || "All Divisions",
        workflow.approvalFlowPreview,
        workflow.description
      ].some((value) => String(value || "").toLowerCase().includes(query));
    });
  }, [departmentFilter, requestTypeFilter, search, statusFilter, workflows]);

  const WORKFLOW_PAGE_SIZE = 10;
  const workflowTotalPages = Math.max(1, Math.ceil(filteredWorkflows.length / WORKFLOW_PAGE_SIZE));
  // Clamp rather than reset via effect - handles both "filters changed" and
  // "list shrank" (e.g. after a delete) without an extra render pass.
  const workflowCurrentPage = Math.min(workflowPage, workflowTotalPages);
  const paginatedWorkflows = useMemo(
    () => filteredWorkflows.slice((workflowCurrentPage - 1) * WORKFLOW_PAGE_SIZE, workflowCurrentPage * WORKFLOW_PAGE_SIZE),
    [filteredWorkflows, workflowCurrentPage]
  );
  useEffect(() => { setWorkflowPage(1); }, [search, requestTypeFilter, departmentFilter, statusFilter]);

  const summary = useMemo(() => ({
    total: workflows.length,
    active: workflows.filter((workflow) => workflow.status === "ACTIVE").length,
    draft: workflows.filter((workflow) => workflow.status === "DRAFT").length,
    inactive: workflows.filter((workflow) => workflow.status === "INACTIVE").length
  }), [workflows]);

  const validationDepartments = useMemo(() => {
    return metadata.department
      ? departments.filter((department) => getDepartmentName(department) === metadata.department)
      : departments;
  }, [departments, metadata.department]);

  const validationCounts = useMemo(() => {
    const total = validationDepartments.length;
    const hodCount = validationDepartments.filter((dept) => dept.hod_user_id).length;
    const managerCount = validationDepartments.filter((dept) => dept.manager_user_id).length;
    const excoCount = validationDepartments.filter((dept) => dept.exco_user_id).length;
    const hodMissing = validationDepartments.filter((dept) => !dept.hod_user_id).length;
    const managerMissing = validationDepartments.filter((dept) => !dept.manager_user_id).length;
    const excoMissing = validationDepartments.filter((dept) => !dept.exco_user_id).length;
    return { total, hodCount, managerCount, excoCount, hodMissing, managerMissing, excoMissing };
  }, [validationDepartments]);

  const workflowSummary = useMemo(() => ({
    totalSteps: steps.length,
    requiredSteps: steps.filter((step) => step.isRequired && !step.isSystemStep).length,
    optionalSteps: steps.filter((step) => !step.isRequired && !step.isSystemStep).length,
    finalApproval: (() => {
      const name = steps.find((step) => step.isFinalApproval)?.positionName;
      return name ? displayPositionName(name) : "Not set";
    })()
  }), [steps]);

  useEffect(() => {
    void loadInitialData();
  }, []);

  async function loadInitialData() {
    setLoading(true);
    try {
      const [workflowResult, departmentResult, orgStructureResult, requestTypesResult, usersResult, actionTypesResult, meResult, managerTypesResult, travelTypesResult] = await Promise.all([
        api.workflows(),
        api.departmentsWithSections(),
        api.orgStructure(),
        api.requestTypes(),
        api.adminUsers(),
        api.workflowActionTypes(),
        api.me(),
        api.managerTypes().catch(() => []),
        api.travelTypes().catch(() => [])
      ]);
      setWorkflows(Array.isArray(workflowResult) ? workflowResult.map(normalizeWorkflow) : []);
      setDepartments(Array.isArray(departmentResult) ? departmentResult : []);
      if (orgStructureResult && typeof orgStructureResult === "object") {
        setOrgStructure({
          divisions: Array.isArray(orgStructureResult.divisions) ? orgStructureResult.divisions : [],
          departments: Array.isArray(orgStructureResult.departments) ? orgStructureResult.departments : [],
          sections: Array.isArray(orgStructureResult.sections) ? orgStructureResult.sections : [],
          teams: Array.isArray(orgStructureResult.teams) ? orgStructureResult.teams : []
        });
      }
      setAllUsers(Array.isArray(usersResult) ? usersResult.filter((u: any) => !["EMPLOYEE"].includes(u.role)) : []);
      if (Array.isArray(requestTypesResult)) {
        setCustomRequestTypes(
          requestTypesResult
            .filter((rt: any) => rt.status === "ACTIVE")
            .map((rt: any) => ({ value: rt.code, label: rt.name }))
        );
      }
      if (Array.isArray(actionTypesResult)) setActionTypes(actionTypesResult);
      if (meResult && typeof meResult === "object") setMyRole((meResult as any).role || "");
      if (Array.isArray(managerTypesResult)) {
        setManagerTypes(managerTypesResult.filter((mt: any) => mt.active !== false));
      }
      if (Array.isArray(travelTypesResult)) {
        setTravelTypes(travelTypesResult.filter((tt: any) => tt.active !== false));
      }
    } catch (error) {
      console.warn(error);
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  }

  async function refreshWorkflows() {
    try {
      const workflowResult = await api.workflows();
      setWorkflows(Array.isArray(workflowResult) ? workflowResult.map(normalizeWorkflow) : []);
    } catch (error) {
      console.warn(error);
    }
  }

  function normalizeWorkflow(raw: any): Workflow {
    const normalizedSteps = Array.isArray(raw.steps) ? raw.steps.map((step: any, index: number) => normalizeStep(step, raw.id, index)) : [];
    return {
      id: raw.id,
      name: raw.name || "",
      requestType: raw.requestType || raw.request_type || "ADVANCE_REQUEST",
      advanceSubType: raw.advanceSubType || raw.advance_sub_type || null,
      department: raw.department || null,
      section: raw.section || null,
      team: raw.team || null,
      description: raw.description || "",
      status: raw.status || "DRAFT",
      requesterRoles: raw.requesterRoles || raw.requester_roles || [],
      createdBy: raw.createdBy || raw.created_by_id || null,
      createdAt: raw.createdAt || raw.created_at || null,
      updatedAt: raw.updatedAt || raw.updated_at || null,
      stepCount: Number(raw.stepCount ?? raw.step_count ?? normalizedSteps.length ?? 0),
      approvalFlowPreview: raw.approvalFlowPreview || raw.approval_flow_preview || flowPreview(normalizedSteps),
      steps: normalizedSteps,
      rules: Array.isArray(raw.rules) ? raw.rules.map((rule: any) => normalizeRule(rule, raw.id)) : []
    };
  }

  function normalizeStep(raw: any, workflowId: string | null = null, index = 0): WorkflowStep {
    const rawCode = raw.position_type_code || raw.positionTypeCode || "";
    const positionType =
      positionTypes.find((type) => type.code === rawCode) ||
      positionTypes.find((type) => type.name === raw.position_name) ||
      POSITION_TYPE_FALLBACKS.find((fallback) => fallback.code === rawCode || fallback.name === raw.position_name);

    return {
      id: raw.id || generateId(),
      workflowId,
      stepOrder: Number(raw.step_order ?? raw.stepOrder ?? index + 1),
      positionTypeId: positionType?.id || null,
      positionTypeCode: positionType?.code || rawCode || "",
      assignedUserId: raw.assigned_user_id || raw.assignedUserId || null,
      approvalMode: (raw.approval_mode || raw.approvalMode || "SINGLE") as "SINGLE" | "ANY_ONE",
      approvalGroupName: raw.approval_group_name || raw.approvalGroupName || null,
      positionName: String(raw.position_name || raw.positionName || positionType?.name || ""),
      description: String(raw.description || positionType?.description || ""),
      isRequired: raw.is_required ?? raw.isRequired ?? false,
      skipIfUnassigned: raw.skip_if_unassigned ?? raw.skipIfUnassigned ?? false,
      allowDelegation: raw.allow_delegation ?? raw.allowDelegation ?? false,
      commentsRequired: raw.comments_required ?? raw.commentsRequired ?? false,
      escalationDays: Number(raw.escalation_days ?? raw.escalationDays ?? 0),
      isFinalApproval: raw.is_final_approval ?? raw.isFinalApproval ?? false,
      isSystemStep: raw.is_system_step ?? raw.isSystemStep ?? false,
      isActive: raw.is_active ?? raw.isActive ?? true,
      requiresAccommodation: raw.requires_accommodation ?? raw.requiresAccommodation ?? false,
      parallelWithPrevious: raw.parallel_with_previous ?? raw.parallelWithPrevious ?? false,
      actionType: (raw.action_type || raw.actionType || "APPROVE") as "APPROVE" | "COUNTER_SIGN" | "MARK_PAID",
      canReject: raw.can_reject ?? raw.canReject ?? true,
      canRollback: raw.can_rollback ?? raw.canRollback ?? true
    };
  }

  function normalizeRule(raw: any, workflowId: string | null = null): WorkflowRule {
    const rawCode = raw.additional_position_type_code || raw.additionalPositionTypeCode || raw.additional_position_code || raw.additionalPositionCode || "";
    const additionalAssignedUserId = raw.additional_assigned_user_id || raw.additionalAssignedUserId || null;
    const positionType =
      positionTypes.find((type) => type.code === rawCode || type.id === rawCode) ||
      positionTypes.find((type) => type.name === raw.additional_position_name) ||
      POSITION_TYPE_FALLBACKS.find((fallback) => fallback.code === rawCode || fallback.name === raw.additional_position_name);
    const normalizedCode = positionType?.code || rawCode || "";
    return {
      id: raw.id || generateId(),
      workflowId,
      ruleName: raw.rule_name || raw.ruleName || "",
      conditionField: raw.condition_field || raw.conditionField || "Amount",
      conditionOperator: raw.condition_operator || raw.conditionOperator || ">",
      conditionValue: raw.condition_value || raw.conditionValue || "",
      additionalPositionTypeId: additionalAssignedUserId && normalizedCode
        ? assignedRuleTargetValue(additionalAssignedUserId, normalizedCode)
        : positionType?.id || raw.additionalPositionTypeId || rawCode || "",
      additionalPositionName: raw.additional_position_name || raw.additionalPositionName || positionType?.name || null,
      additionalAssignedUserId,
      isActive: raw.is_active ?? raw.isActive ?? true
    };
  }

  function positionByCode(code: string) {
    return positionTypes.find((type) => type.code === code) || POSITION_TYPE_FALLBACKS.find((type) => type.code === code) || POSITION_TYPE_FALLBACKS[0];
  }

  function makeStep(positionCode: string, index: number, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
    const position = positionByCode(positionCode);
    const isEmployee = position.code === "EMPLOYEE";
    const isFinal = overrides.isFinalApproval ?? false;
    return {
      id: generateId(),
      workflowId: selectedWorkflowId || null,
      stepOrder: index + 1,
      positionTypeCode: position.code,
      positionTypeId: position.id,
      positionName: position.name,
      description: position.description,
      isRequired: isEmployee || !["HOD"].includes(position.code),
      skipIfUnassigned: position.code === "HOD",
      allowDelegation: ["HOD", "MANAGER"].includes(position.code),
      commentsRequired: false,
      escalationDays: position.code === "EMPLOYEE" ? 0 : 2,
      isFinalApproval: isFinal,
      isSystemStep: isEmployee,
      isActive: true,
      requiresAccommodation: false,
      parallelWithPrevious: false,
      actionType: position.code === "MANAGER" ? "COUNTER_SIGN" : "APPROVE",
      canReject: true,
      canRollback: true,
      ...overrides,
      approvalMode: overrides.approvalMode ?? "SINGLE",
      approvalGroupName: overrides.approvalGroupName ?? null
    };
  }

  function buildTemplateSteps(templateId: string) {
    const template = TEMPLATE_DEFINITIONS.find((item) => item.id === templateId) || TEMPLATE_DEFINITIONS[0];
    const next = template.steps.map((stepDef, index) => {
      if (typeof stepDef === "string") return makeStep(stepDef, index);
      const overrides: Partial<WorkflowStep> = { positionName: stepDef.name };
      if (stepDef.description) overrides.description = stepDef.description;
      if (stepDef.approvalMode) overrides.approvalMode = stepDef.approvalMode;
      if (stepDef.approvalGroupName) overrides.approvalGroupName = stepDef.approvalGroupName;
      if (stepDef.assignedUserId) overrides.assignedUserId = stepDef.assignedUserId;
      if (stepDef.actionType) overrides.actionType = stepDef.actionType;
      if (stepDef.allowDelegation !== undefined) overrides.allowDelegation = stepDef.allowDelegation;
      return makeStep(stepDef.code, index, overrides);
    });
    if (next.length > 0) {
      next[next.length - 1] = { ...next[next.length - 1], isFinalApproval: true };
    }
    return next;
  }

  function flowPreview(stepList = steps) {
    return stepList.map((step) => displayPositionName(step.positionName)).filter(Boolean).join(" → ");
  }

  function resetDesigner(nextMetadata: Partial<WorkflowMetadata> = {}) {
    setSelectedWorkflowId("");
    const merged = { ...EMPTY_METADATA, ...nextMetadata };
    setMetadata(merged);
    setSelectedRequestTypeValues([toStep1Value(merged.requestType, merged.advanceSubType)]);
    const nextSteps = buildTemplateSteps("STANDARD");
    setSteps(nextSteps);
    setSelectedStepId(nextSteps[0]?.id || "");
    setRules(DEFAULT_RULES);
    setSelectedTemplateId("STANDARD");
    setRuleDraft(makeBlankRuleDraft());
    setShowRuleForm(false);
    setEditingRuleId(null);
  }

  function startNewWorkflow() {
    setMode("create");
    resetDesigner();
    setScreen("DETAILS");
  }

  async function verifyAdminPassword(): Promise<boolean> {
    const result = await Swal.fire({
      title: "Confirm your password",
      text: "Please re-enter your password to continue with this action.",
      input: "password",
      inputAttributes: { autocapitalize: "off", autocomplete: "current-password" },
      showCancelButton: true,
      confirmButtonText: "Confirm",
      inputValidator: (value) => (!value ? "Password is required" : undefined)
    });
    if (!result.isConfirmed) return false;
    try {
      await api.verifyPassword(result.value);
      return true;
    } catch (error: any) {
      void Swal.fire({ icon: "error", title: "Incorrect password", text: error?.message || "Unable to verify password." });
      return false;
    }
  }

  async function loadWorkflowDetail(workflowId: string, nextMode: WorkflowMode) {
    if (!workflowId) return;
    if (nextMode === "edit" && !(await verifyAdminPassword())) return;
    setLoading(true);
    try {
      const result = await api.workflowDetail(workflowId);
      const workflow = normalizeWorkflow(result);
      setSelectedWorkflowId(workflow.id);
      setMetadata({
        name: workflow.name,
        requestType: workflow.requestType,
        advanceSubType: workflow.advanceSubType || "",
        division: "",
        department: workflow.department || "",
        section: workflow.section || "",
        team: workflow.team || "",
        description: workflow.description || "",
        status: workflow.status,
        requesterRoles: Array.isArray(workflow.requesterRoles) ? workflow.requesterRoles : []
      });
      const loadedSteps = workflow.steps.length ? workflow.steps : buildTemplateSteps("STANDARD");
      setSteps(loadedSteps);
      setSelectedStepId(loadedSteps[0]?.id || "");
      setRules(workflow.rules);
      setMode(nextMode);
      setScreen("DESIGNER");
    } catch (error: any) {
      void Swal.fire({ icon: "error", title: "Workflow unavailable", text: error?.message || "Unable to load workflow." });
    } finally {
      setLoading(false);
    }
  }

  function updateMetadata(updates: Partial<WorkflowMetadata>) {
    setMetadata((current) => ({ ...current, ...updates }));
  }

  function normalizeSteps(nextSteps: WorkflowStep[]) {
    const normalized = nextSteps.map((step, index) => ({ ...step, stepOrder: index + 1 }));
    setSteps(normalized);
    if (!normalized.find((step) => step.id === selectedStepId) && normalized.length > 0) {
      setSelectedStepId(normalized[0].id);
    }
  }

  function moveStep(fromIndex: number, toIndex: number) {
    if (readOnly) return;
    const next = [...steps];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    normalizeSteps(next);
  }

  function addStep(positionTypeCode: string, insertIndex?: number, overrides: Partial<WorkflowStep> = {}) {
    if (readOnly) return;
    const step = makeStep(positionTypeCode, insertIndex != null ? insertIndex : steps.length, { isFinalApproval: false, ...overrides });
    const next = [...steps];
    if (insertIndex != null) next.splice(insertIndex, 0, step);
    else next.push(step);
    normalizeSteps(next);
    setSelectedStepId(step.id);
  }


  function updateStep(stepId: string, updates: Partial<WorkflowStep>) {
    if (readOnly) return;
    normalizeSteps(steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)));
  }

  async function removeStep(stepId: string) {
    if (readOnly) return;
    if (steps.length <= 1) {
      void Swal.fire({ icon: "warning", title: "At least one step is required" });
      return;
    }
    const result = await Swal.fire({ title: "Remove step?", text: "Remove this step from the workflow?", icon: "warning", showCancelButton: true, confirmButtonText: "Remove" });
    if (!result.isConfirmed) return;
    normalizeSteps(steps.filter((step) => step.id !== stepId));
  }

  function handleDrop(targetIndex: number) {
    if (!dragSource || readOnly) return;
    if (dragSource.type === "step") {
      const fromIndex = steps.findIndex((step) => step.id === dragSource.id);
      if (fromIndex === -1) return;
      moveStep(fromIndex, targetIndex);
    } else {
      addStep(dragSource.id, targetIndex, dragSource.overrides ? { positionName: dragSource.overrides.positionName, description: dragSource.overrides.description, assignedUserId: dragSource.overrides.assignedUserId, approvalMode: dragSource.overrides.approvalMode, approvalGroupName: dragSource.overrides.approvalGroupName } : {});
    }
    setDragSource(null);
    setDragOverIndex(null);
  }

  function resolvePositionLabel(positionTypeId: string | undefined | null) {
    const direct = positionTypes.find((type) => type.id === positionTypeId || type.code === positionTypeId);
    if (direct) return direct.name;
    const fallback = POSITION_TYPE_FALLBACKS.find((type) => type.id === positionTypeId || type.code === positionTypeId);
    return fallback?.name || "Unknown";
  }

  function resolveRuleTarget(rule: Pick<WorkflowRule, "additionalPositionTypeId" | "additionalPositionName" | "additionalAssignedUserId">) {
    const selected = ruleTargetOptions.find((option) => option.value === rule.additionalPositionTypeId);
    if (selected) return selected;

    const decodedCode = assignedRuleTargetCode(rule.additionalPositionTypeId);
    const assignedUser = rule.additionalAssignedUserId
      ? staff.find((user) => user.id === rule.additionalAssignedUserId)
      : null;
    const code = decodedCode || resolvePositionCode(rule.additionalPositionTypeId);
    const positionName = rule.additionalPositionName || workflowCodeLabel(code) || resolvePositionLabel(rule.additionalPositionTypeId);
    const name = staffName(assignedUser);
    return {
      value: rule.additionalPositionTypeId || code,
      group: "Saved target",
      label: name ? `${name} - ${positionName}` : positionName,
      code,
      positionName,
      assignedUserId: rule.additionalAssignedUserId || null
    };
  }

  function resolveRuleTargetLabel(rule: WorkflowRule) {
    return resolveRuleTarget(rule).label;
  }

  // FINANCE and HR_REVIEW steps don't resolve to a fixed role at all - real
  // approval-time authorization for these is department-based
  // (canApproveStep/isFinanceDept and resolveWorkflowChain's HR leadership
  // lookup on the backend), and there's no reliable, non-hardcoded way to
  // identify "the Finance department" or "the HR department" from here (department
  // names are freeform per company/environment). So those two fall through to
  // the same full-list default as any other unrecognized position type -
  // this picker is only for the optional manual override anyway.
  function usersForStep(step: WorkflowStep) {
    const group = String(step.approvalGroupName || "");
    let targetDepartment: string | null = metadata.department || null;
    let targetSection: string | null = metadata.section || null;
    let targetTeam: string | null = metadata.team || null;

    if (group.startsWith("Team: ")) {
      targetTeam = group.slice("Team: ".length);
    } else if (group.startsWith("Section: ")) {
      targetSection = group.slice("Section: ".length);
    } else if (group.startsWith("Department: ")) {
      targetDepartment = group.slice("Department: ".length);
    } else {
      if (step.positionName.startsWith("Team: ")) targetTeam = step.positionName.slice("Team: ".length);
      else if (step.positionName.startsWith("Section: ")) targetSection = step.positionName.slice("Section: ".length);
      else if (step.positionName.startsWith("Department: ")) targetDepartment = step.positionName.slice("Department: ".length);
    }

    const orgDept = targetDepartment ? orgStructure.departments.find((d) => d?.name === targetDepartment) : null;
    const orgSection = targetSection && orgDept ? orgStructure.sections.find((s) => s?.name === targetSection && s?.department_id === orgDept.id) : null;
    const orgTeam = targetTeam ? orgStructure.teams.find((t) => t?.name === targetTeam) : null;

    const candidateIds = new Set<string>();
    const candidateById = new Map(allUsers.map((user) => [user.id, user]));

    function addCandidate(id: string | null | undefined) {
      if (id) candidateIds.add(id);
    }

    switch (step.positionTypeCode) {
      case "HOD":
        addCandidate(orgSection?.hod_user_id ?? orgDept?.hod_user_id);
        break;
      case "MANAGER":
        addCandidate(orgTeam?.leader_user_id ?? orgSection?.manager_user_id ?? orgDept?.manager_user_id);
        break;
      case "EXCO":
        addCandidate(orgSection?.exco_user_id ?? orgDept?.exco_user_id);
        break;
      case "CEO":
        return allUsers.filter((user) => user.role === "CEO");
      case "FINANCE":
        return allUsers.filter((user) => user.role === "FINANCE");
      default:
        return allUsers.filter((user) => {
          if (targetTeam) return user.team_name === targetTeam;
          if (targetSection) return user.section_name === targetSection;
          if (targetDepartment) return user.department === targetDepartment;
          return true;
        });
    }

    const candidates = Array.from(candidateIds)
      .map((id) => candidateById.get(id))
      .filter((user): user is typeof allUsers[number] => Boolean(user));

    if (candidates.length > 0) return candidates;

    // Fallback: if no org-structure assignment found, return all users with the required role in the target scope
    const deptName = orgDept?.name || targetDepartment;
    const posCode = String(step.positionTypeCode || "");

    if (posCode === "HOD") {
      if (deptName) {
        return allUsers.filter((user) => user.role === "HOD" && user.department === deptName);
      } else {
        return allUsers.filter((user) => user.role === "HOD");
      }
    }
    if (posCode === "MANAGER") {
      if (deptName) {
        // Department-scoped step: show managers/HODs from that specific department
        return allUsers.filter((user) => (user.role === "MANAGER" || user.role === "HOD") && user.department === deptName);
      } else {
        // No scope: show all managers and HODs
        return allUsers.filter((user) => user.role === "MANAGER" || user.role === "HOD");
      }
    }
    if (posCode === "EXCO") {
      // Always show all EXCO members regardless of department scope
      return allUsers.filter((user) => user.role === "EXCO");
    }
    if (posCode === "CEO") {
      return allUsers.filter((user) => user.role === "CEO");
    }
    if (posCode === "FINANCE") {
      return allUsers.filter((user) => user.role === "FINANCE");
    }

    // Fallback for team/section/department scopes
    if (targetTeam) {
      return allUsers.filter((user) => user.team_name === targetTeam);
    }
    if (targetSection) {
      // For section-scoped steps, include both section-specific users and division-level staff
      const sectionUsers = allUsers.filter((user) => user.section_name === targetSection);
      if (sectionUsers.length > 0) return sectionUsers;

      // If no section-specific users, return division-level staff from the department
      if (deptName) {
        return allUsers.filter((user) => !user.section_name && user.department === deptName);
      }
      return sectionUsers;
    }
    if (targetDepartment) {
      return allUsers.filter((user) => user.department === targetDepartment);
    }

    return allUsers;
  }

  function describeRuleCondition(rule: WorkflowRule) {
    const operator =
      rule.conditionOperator === ">"
        ? "greater than"
        : rule.conditionOperator === "<"
          ? "less than"
          : "equal to";
    return `${rule.conditionField} ${operator} M${rule.conditionValue}`;
  }

  function resolvePositionCode(positionTypeId: string | undefined | null, positionTypeCode?: string) {
    const normalizedCode = String(positionTypeCode || "").trim();
    if (normalizedCode) return normalizedCode;
    if (positionTypeId) {
      const assignedCode = assignedRuleTargetCode(positionTypeId);
      if (assignedCode) return assignedCode;
      const matchedType =
        positionTypes.find((type) => type.id === positionTypeId || type.code === positionTypeId) ||
        POSITION_TYPE_FALLBACKS.find((type) => type.id === positionTypeId || type.code === positionTypeId);
      return matchedType?.code || positionTypeId;
    }
    return "";
  }

  function workflowPayload(targetStatus?: WorkflowStatus) {
    return {
      name: metadata.name.trim(),
      request_type: metadata.requestType,
      advance_sub_type: (SUB_TYPED_REQUEST_TYPES[metadata.requestType] && metadata.advanceSubType) ? metadata.advanceSubType : null,
      department: metadata.department || null,
      section: metadata.section || null,
      team: metadata.team || null,
      description: metadata.description.trim() || null,
      status: targetStatus || metadata.status,
      requester_roles: metadata.requesterRoles.length ? metadata.requesterRoles : null,
      steps: steps.map((step) => ({
        workflow_id: selectedWorkflowId || undefined,
        step_order: step.stepOrder,
        position_type_code: resolvePositionCode(step.positionTypeId, step.positionTypeCode),
        assigned_user_id: step.assignedUserId || undefined,
        approval_mode: step.approvalMode,
        approval_group_name: step.approvalGroupName || undefined,
        position_name: step.positionName,
        description: step.description || undefined,
        is_required: step.isRequired,
        skip_if_unassigned: step.skipIfUnassigned,
        allow_delegation: step.allowDelegation,
        comments_required: step.commentsRequired,
        escalation_days: step.escalationDays,
        is_final_approval: step.isFinalApproval,
        is_system_step: step.isSystemStep,
        is_active: step.isActive,
        requires_accommodation: step.requiresAccommodation,
        parallel_with_previous: step.parallelWithPrevious,
        action_type: step.actionType,
        can_reject: step.canReject,
        can_rollback: step.canRollback
      })),
      rules: rules.map((rule) => {
        const target = resolveRuleTarget(rule);
        return {
          rule_name: rule.ruleName,
          condition_field: rule.conditionField,
          condition_operator: rule.conditionOperator,
          condition_value: rule.conditionValue,
          additional_position_type_code: target.code || resolvePositionCode(rule.additionalPositionTypeId),
          additional_position_name: target.positionName || resolvePositionLabel(rule.additionalPositionTypeId),
          additional_assigned_user_id: target.assignedUserId || null,
          is_active: rule.isActive
        };
      })
    };
  }

  async function saveWorkflow(targetStatus?: WorkflowStatus) {
    if (readOnly) return;
    if (!metadata.name.trim()) {
      void Swal.fire({ icon: "warning", title: "Missing workflow name", text: "Workflow name is required." });
      return;
    }
    if (!steps.length) {
      void Swal.fire({ icon: "warning", title: "No workflow steps", text: "Add at least one approval step." });
      return;
    }
    if (!selectedWorkflowId && selectedRequestTypeValues.length === 0) {
      void Swal.fire({ icon: "warning", title: "Select a request type", text: "Choose at least one request type for this workflow." });
      return;
    }
    try {
      setLoading(true);
      if (selectedWorkflowId) {
        await api.updateWorkflow(selectedWorkflowId, workflowPayload(targetStatus));
      } else if (selectedRequestTypeValues.length > 1) {
        // Multiple request types checked on step 1 - create one workflow per
        // type, all sharing today's steps/rules, named to disambiguate.
        for (const value of selectedRequestTypeValues) {
          const colonIdx = value.indexOf(":");
          const requestType = colonIdx === -1 ? value : value.slice(0, colonIdx);
          const advanceSubType = colonIdx === -1 ? null : value.slice(colonIdx + 1);
          const label = step1RequestTypeOptions.find((o) => o.value === value)?.label || value;
          await api.createWorkflow({
            ...workflowPayload(targetStatus),
            name: `${metadata.name.trim()} — ${label}`,
            request_type: requestType,
            advance_sub_type: advanceSubType
          });
        }
      } else {
        const result = await api.createWorkflow(workflowPayload(targetStatus));
        setSelectedWorkflowId(result.id || "");
      }
      await refreshWorkflows();
      setScreen("LIST");
      void Swal.fire({
        icon: "success",
        title: selectedRequestTypeValues.length > 1 ? `${selectedRequestTypeValues.length} workflows created` : "Workflow saved",
        timer: 1400,
        showConfirmButton: false
      });
    } catch (error: any) {
      void Swal.fire({ icon: "error", title: "Save failed", text: "Unable to save workflow: " + (error?.message || "Unknown error") });
    } finally {
      setLoading(false);
    }
  }

  async function updateWorkflowStatus(workflow: Workflow, status: WorkflowStatus) {
    if (!(await verifyAdminPassword())) return;
    try {
      await api.updateWorkflow(workflow.id, { status });
      await refreshWorkflows();
    } catch (error: any) {
      void Swal.fire({ icon: "error", title: "Status update failed", text: error?.message || "Unable to update workflow." });
    }
  }

  async function deleteWorkflow(workflow: Workflow) {
    const result = await Swal.fire({ title: "Delete workflow?", text: `Delete ${workflow.name}?`, icon: "warning", showCancelButton: true, confirmButtonText: "Delete" });
    if (!result.isConfirmed) return;
    if (!(await verifyAdminPassword())) return;
    try {
      await api.deleteWorkflow(workflow.id);
      await refreshWorkflows();
    } catch (error: any) {
      void Swal.fire({ icon: "error", title: "Delete failed", text: error?.message || "Unable to delete workflow." });
    }
  }

  async function duplicateWorkflow(workflow: Workflow) {
    if (!(await verifyAdminPassword())) return;
    try {
      setLoading(true);
      const detail = normalizeWorkflow(await api.workflowDetail(workflow.id));
      setSelectedWorkflowId("");
      setMetadata({
        name: `${detail.name} Copy`,
        requestType: detail.requestType,
        advanceSubType: detail.advanceSubType || "",
        division: "",
        department: detail.department || "",
        section: detail.section || "",
        team: detail.team || "",
        description: detail.description || "",
        status: "DRAFT",
        requesterRoles: Array.isArray(detail.requesterRoles) ? detail.requesterRoles : []
      });
      // Duplicating jumps straight to the Designer (never revisits step 1),
      // but keep this in sync so a stale multi-selection from an earlier
      // create-flow session can't leak in and create extra copies on save.
      setSelectedRequestTypeValues([toStep1Value(detail.requestType, detail.advanceSubType || "")]);
      const clonedSteps = detail.steps.map((step, index) => ({ ...step, id: generateId(), workflowId: null, stepOrder: index + 1 }));
      setSteps(clonedSteps);
      setSelectedStepId(clonedSteps[0]?.id || "");
      setRules(detail.rules.map((rule) => ({ ...rule, id: generateId(), workflowId: null })));
      setMode("create");
      setScreen("DESIGNER");
    } catch (error: any) {
      void Swal.fire({ icon: "error", title: "Duplicate failed", text: error?.message || "Unable to duplicate workflow." });
    } finally {
      setLoading(false);
    }
  }

  function makeBlankRuleDraft(): WorkflowRuleDraft {
    const target = ruleTargetOptions.find((option) => option.value === defaultRuleTargetValue);
    return {
      ruleName: "",
      conditionField: "Amount",
      conditionOperator: ">",
      conditionValue: "",
      additionalPositionTypeId: target?.value || defaultRuleTargetValue,
      additionalPositionName: target?.positionName || "Finance",
      additionalAssignedUserId: target?.assignedUserId || null,
      isActive: true
    };
  }

  function normalizeRuleDraftTarget(draft: WorkflowRuleDraft) {
    const target = resolveRuleTarget({
      additionalPositionTypeId: draft.additionalPositionTypeId || defaultRuleTargetValue,
      additionalPositionName: draft.additionalPositionName || null,
      additionalAssignedUserId: draft.additionalAssignedUserId || null
    });
    return {
      additionalPositionTypeId: target.value || draft.additionalPositionTypeId || defaultRuleTargetValue,
      additionalPositionName: target.positionName || draft.additionalPositionName || null,
      additionalAssignedUserId: target.assignedUserId || null
    };
  }

  function handleAddRule() {
    if (readOnly) return;
    if (!showRuleForm) {
      setShowRuleForm(true);
      return;
    }

    if (!ruleDraft.ruleName || !ruleDraft.conditionValue || !ruleDraft.additionalPositionTypeId) {
      void Swal.fire({ icon: "warning", title: "Incomplete rule", text: "Please complete the rule details." });
      return;
    }

    const target = normalizeRuleDraftTarget(ruleDraft);
    const nextRuleFields = {
      ruleName: ruleDraft.ruleName,
      conditionField: ruleDraft.conditionField || "Amount",
      conditionOperator: ruleDraft.conditionOperator || ">",
      conditionValue: ruleDraft.conditionValue || "",
      additionalPositionTypeId: target.additionalPositionTypeId,
      additionalPositionName: target.additionalPositionName,
      additionalAssignedUserId: target.additionalAssignedUserId,
      isActive: ruleDraft.isActive ?? true
    };

    if (editingRuleId) {
      setRules((current) =>
        current.map((rule) =>
          rule.id === editingRuleId
            ? {
                ...rule,
                ...nextRuleFields
              }
            : rule
        )
      );
    } else {
      setRules((current) => [
        ...current,
        {
          id: generateId(),
          workflowId: selectedWorkflowId || null,
          ...nextRuleFields
        }
      ]);
    }

    setRuleDraft(makeBlankRuleDraft());
    setEditingRuleId(null);
    setShowRuleForm(false);
  }

  function removeRule(ruleId: string) {
    if (readOnly) return;
    setRules((current) => current.filter((rule) => rule.id !== ruleId));
  }

  function editRule(rule: WorkflowRule) {
    if (readOnly) return;
    setRuleDraft({
      ruleName: rule.ruleName,
      conditionField: rule.conditionField,
      conditionOperator: rule.conditionOperator,
      conditionValue: rule.conditionValue,
      additionalPositionTypeId: rule.additionalPositionTypeId,
      additionalPositionName: rule.additionalPositionName || null,
      additionalAssignedUserId: rule.additionalAssignedUserId || null,
      isActive: rule.isActive
    });
    setEditingRuleId(rule.id);
    setShowRuleForm(true);
  }

  function cancelRuleEdit() {
    setRuleDraft(makeBlankRuleDraft());
    setEditingRuleId(null);
    setShowRuleForm(false);
  }

  function showValidationDetails() {
    const missingHods = validationDepartments.filter((department) => !department.hod_user_id).map(getDepartmentName);
    const missingManagers = validationDepartments.filter((department) => !department.manager_user_id).map(getDepartmentName);
    const missingExco = validationDepartments.filter((department) => !department.exco_user_id).map(getDepartmentName);
    void Swal.fire({
      title: "Workflow validation",
      html: `
        <div style="text-align:left;display:grid;gap:8px">
          <div>HOD assigned in ${validationCounts.hodCount} of ${validationCounts.total} departments.</div>
          <div>Manager assigned in ${validationCounts.managerCount} of ${validationCounts.total} departments.</div>
          <div>EXCO member assigned in ${validationCounts.excoCount} of ${validationCounts.total} departments.</div>
          <div><strong>Missing HOD:</strong> ${missingHods.length ? missingHods.join(", ") : "None"}</div>
          <div><strong>Missing Manager:</strong> ${missingManagers.length ? missingManagers.join(", ") : "None"}</div>
          <div><strong>Missing EXCO:</strong> ${missingExco.length ? missingExco.join(", ") : "None"}</div>
        </div>
      `,
      icon: validationCounts.hodMissing || validationCounts.managerMissing || validationCounts.excoMissing ? "warning" : "success",
      confirmButtonText: "OK"
    });
  }

  function continueToTemplate() {
    if (!metadata.name.trim()) {
      void Swal.fire({ icon: "warning", title: "Missing workflow name", text: "Workflow name is required." });
      return;
    }
    if (selectedRequestTypeValues.length === 0) {
      void Swal.fire({ icon: "warning", title: "Select a request type", text: "Choose at least one request type for this workflow." });
      return;
    }
    setScreen("TEMPLATE");
  }

  function continueToDesigner() {
    const templateSteps = buildTemplateSteps(selectedTemplateId);
    setSteps(templateSteps);
    setSelectedStepId(templateSteps[0]?.id || "");
    setMode("create");
    setScreen("DESIGNER");
  }

  function renderStepper(active: 1 | 2 | 3) {
    const items = [
      { index: 1, title: "Workflow Details", subtitle: "Basic information" },
      { index: 2, title: "Select Template", subtitle: "Choose a starting template" },
      { index: 3, title: "Design Workflow", subtitle: "Build and configure workflow" }
    ];
    return (
      <div className="workflow-stepper">
        {items.map((item) => (
          <div key={item.index} className={`workflow-stepper-item ${item.index === active ? "active" : ""} ${item.index < active ? "complete" : ""}`}>
            <span>{item.index < active ? <Check size={16} aria-hidden /> : item.index}</span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.subtitle}</small>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderFlow(stepList: WorkflowStep[], compact = false) {
    const list = stepList.filter((step) => step.isActive !== false);
    if (!list.length) return <span className="workflow-flow-empty">No steps</span>;
    return (
      <div className={`workflow-flow ${compact ? "compact" : ""}`}>
        {list.map((step, index) => {
          const Icon = getPositionIcon(step.positionTypeCode);
          return (
            <React.Fragment key={`${step.id}-${index}`}>
              <span className={`workflow-flow-node ${getPositionToneClass(step.positionTypeCode)}`}>
                <Icon size={compact ? 13 : 16} aria-hidden />
                <span>{displayPositionName(step.positionName)}</span>
              </span>
              {index < list.length - 1 ? <span className="workflow-flow-arrow" aria-hidden>→</span> : null}
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  function renderListScreen() {
    return (
      <div className="workflow-page workflow-management-page ep-page">
        <div className="ep-breadcrumb" style={{ marginBottom: 0 }}>
          <span>Administration</span><ChevronLeft size={13} style={{ transform: "rotate(180deg)" }} /><span>Organizational Structure</span><ChevronLeft size={13} style={{ transform: "rotate(180deg)" }} /><span className="ep-breadcrumb-active">Approval Workflow Builder</span>
        </div>
        <div className="ep-header">
          <div className="ep-header-text">
            <h1 className="ep-title">Approval Workflow Builder</h1>
            <p className="ep-subtitle">Design and configure approval workflows for different request types.</p>
          </div>
          <div className="ep-actions">
            <button className="ep-btn" type="button" onClick={startNewWorkflow}><Plus size={15} aria-hidden />New Workflow</button>
          </div>
        </div>

        <div className="workflow-summary-grid">
          <button className="workflow-summary-tile" type="button" onClick={() => setStatusFilter("")}>
            <span className="workflow-summary-icon"><GitBranch size={26} aria-hidden /></span>
            <div><strong>{summary.total}</strong><small>Total Workflows</small></div>
          </button>
          <button className="workflow-summary-tile" type="button" onClick={() => setStatusFilter("ACTIVE")}>
            <span className="workflow-summary-icon"><CheckCircle2 size={26} aria-hidden /></span>
            <div><strong>{summary.active}</strong><small>Active</small></div>
          </button>
          <button className="workflow-summary-tile" type="button" onClick={() => setStatusFilter("DRAFT")}>
            <span className="workflow-summary-icon"><Pencil size={26} aria-hidden /></span>
            <div><strong>{summary.draft}</strong><small>Draft</small></div>
          </button>
          <button className="workflow-summary-tile" type="button" onClick={() => setStatusFilter("INACTIVE")}>
            <span className="workflow-summary-icon"><X size={26} aria-hidden /></span>
            <div><strong>{summary.inactive}</strong><small>Inactive</small></div>
          </button>
        </div>

        <section className="workflow-list-panel">
          <div className="workflow-list-toolbar">
            <label className="workflow-search">
              <Search size={17} aria-hidden />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search workflows by name..." />
            </label>
            <select value={requestTypeFilter} onChange={(event) => setRequestTypeFilter(event.target.value)}>
              <option value="">All Request Types</option>
              {requestTypeOptions.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
            <select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}>
              <option value="">All Divisions</option>
              {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">All Statuses</option>
              {STATUS_OPTIONS.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
            </select>
            <button className="button small-button button-subtle" type="button">
              <Filter size={15} aria-hidden />
              Filters
            </button>
            <button className="icon-button workflow-table-action" type="button" onClick={() => void loadInitialData()} disabled={loading} aria-label="Refresh workflows" title="Refresh workflows">
              <RefreshCw size={16} aria-hidden />
            </button>
          </div>

          <div className="workflow-table-wrap">
            <table className="workflow-management-table">
              <thead>
                <tr>
                  <th>Workflow Name</th>
                  <th>Request Type</th>
                  <th>Division</th>
                  <th>Approval Flow Preview</th>
                  <th>Steps</th>
                  <th>Status</th>
                  <th>Last Modified</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginatedWorkflows.map((workflow) => {
                  const isExpanded = expandedRows.has(workflow.id);
                  return (
                    <React.Fragment key={workflow.id}>
                      <tr className={isExpanded ? "workflow-row-expanded" : undefined}>
                        <td>
                          <strong>{workflow.name}</strong>
                          <small>{workflow.description || "No description"}</small>
                        </td>
                        <td>
                          <span className="workflow-request-chip">{requestTypeLabel(workflow.requestType)}</span>
                          {workflow.advanceSubType && (
                            <span style={{ display: "block", fontSize: 11, marginTop: 3, color: "var(--muted)", fontWeight: 500 }}>
                              {(SUB_TYPED_REQUEST_TYPES[workflow.requestType] ?? advanceSubTypes).find((t) => t.value === workflow.advanceSubType)?.label ?? workflow.advanceSubType}
                            </span>
                          )}
                        </td>
                        <td>{workflow.department || "All Divisions"}</td>
                        <td>{renderFlow(workflow.steps, true)}</td>
                        <td>{workflow.stepCount || workflow.steps.length}</td>
                        <td><span className={getStatusPill(workflow.status)}>{workflow.status[0] + workflow.status.slice(1).toLowerCase()}</span></td>
                        <td>
                          <span>{formatDate(workflow.updatedAt || workflow.createdAt)}</span>
                          <small>System Administrator</small>
                        </td>
                        <td>
                          <button
                            className={`icon-button workflow-table-action${isExpanded ? " active" : ""}`}
                            type="button"
                            aria-label={`Actions for ${workflow.name}`}
                            aria-expanded={isExpanded}
                            onClick={() => toggleRow(workflow.id)}
                          >
                            <MoreVertical size={16} aria-hidden />
                          </button>
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr className="workflow-row-actions-expanded">
                          <td colSpan={8}>
                            <div className="workflow-inline-actions">
                              <button type="button" onClick={() => void loadWorkflowDetail(workflow.id, "view")}><Eye size={14} aria-hidden />View</button>
                              <button type="button" onClick={() => void loadWorkflowDetail(workflow.id, "edit")}><Pencil size={14} aria-hidden />Edit</button>
                              <button type="button" onClick={() => void duplicateWorkflow(workflow)}><Copy size={14} aria-hidden />Duplicate</button>
                              {workflow.status !== "ACTIVE" ? <button type="button" onClick={() => void updateWorkflowStatus(workflow, "ACTIVE")}><CheckCircle2 size={14} aria-hidden />Activate</button> : null}
                              {workflow.status !== "INACTIVE" ? <button type="button" onClick={() => void updateWorkflowStatus(workflow, "INACTIVE")}><X size={14} aria-hidden />Deactivate</button> : null}
                              <button type="button" className="danger" onClick={() => void deleteWorkflow(workflow)}><Trash2 size={14} aria-hidden />Delete</button>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
                {!filteredWorkflows.length ? (
                  <tr>
                    <td colSpan={8} className="workflow-empty-table">{loading ? "Loading workflows..." : "No workflows match the selected filters."}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {filteredWorkflows.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid var(--border)", fontSize: 13, color: "var(--muted, #6b7280)" }}>
              <span>
                Showing {(workflowCurrentPage - 1) * WORKFLOW_PAGE_SIZE + 1}–{Math.min(workflowCurrentPage * WORKFLOW_PAGE_SIZE, filteredWorkflows.length)} of {filteredWorkflows.length}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button className="button small-button button-subtle" type="button" disabled={workflowCurrentPage <= 1} onClick={() => setWorkflowPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft size={14} aria-hidden /> Prev
                </button>
                <span>Page {workflowCurrentPage} of {workflowTotalPages}</span>
                <button className="button small-button button-subtle" type="button" disabled={workflowCurrentPage >= workflowTotalPages} onClick={() => setWorkflowPage((p) => Math.min(workflowTotalPages, p + 1))}>
                  Next <ChevronLeft size={14} aria-hidden style={{ transform: "rotate(180deg)" }} />
                </button>
              </div>
            </div>
          )}
        </section>

        {myRole === "ADMIN" && (
          <section className="workflow-list-panel" style={{ marginTop: 24 }}>
            <div className="workflow-list-toolbar" style={{ cursor: "pointer" }} onClick={() => setShowActionTypesPanel((v) => !v)}>
              <strong style={{ fontSize: 14 }}>Step Action Labels</strong>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-muted, #888)" }}>
                {showActionTypesPanel ? "Hide" : "Manage"}
              </span>
            </div>
            {showActionTypesPanel && (
              <div style={{ padding: "12px 16px" }}>
                <table className="workflow-table" style={{ marginBottom: 16 }}>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Label</th>
                      <th>Built-in</th>
                      <th>Active</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionTypes.map((at) => (
                      <tr key={at.id}>
                        <td><code>{at.code}</code></td>
                        <td>
                          <input
                            type="text"
                            defaultValue={at.label}
                            disabled={at.is_system && at.code !== at.code}
                            onBlur={async (e) => {
                              const newLabel = e.target.value.trim();
                              if (!newLabel || newLabel === at.label) return;
                              await api.updateWorkflowActionType(at.id, { label: newLabel });
                              setActionTypes((prev) => prev.map((x) => x.id === at.id ? { ...x, label: newLabel } : x));
                            }}
                            style={{ border: "1px solid var(--color-border, #ddd)", borderRadius: 4, padding: "2px 6px", width: "100%" }}
                          />
                        </td>
                        <td style={{ textAlign: "center" }}>{at.is_system ? "✓" : ""}</td>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={at.is_active}
                            onChange={async (e) => {
                              await api.updateWorkflowActionType(at.id, { is_active: e.target.checked });
                              setActionTypes((prev) => prev.map((x) => x.id === at.id ? { ...x, is_active: e.target.checked } : x));
                            }}
                          />
                        </td>
                        <td>
                          {!at.is_system && (
                            <button
                              type="button"
                              className="ep-btn ep-btn-danger"
                              style={{ padding: "2px 8px", fontSize: 12 }}
                              onClick={async () => {
                                if (!confirm(`Delete "${at.label}"?`)) return;
                                await api.deleteWorkflowActionType(at.id);
                                setActionTypes((prev) => prev.filter((x) => x.id !== at.id));
                              }}
                            >Remove</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <label style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>Code (e.g. DEPT_REVIEWER)</div>
                    <input
                      type="text"
                      placeholder="DEPT_REVIEWER"
                      value={actionTypeDraft.code}
                      onChange={(e) => setActionTypeDraft((d) => ({ ...d, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") }))}
                      style={{ width: "100%", border: "1px solid var(--color-border, #ddd)", borderRadius: 4, padding: "4px 8px" }}
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>Label (shown in dropdown)</div>
                    <input
                      type="text"
                      placeholder="Division Reviewer"
                      value={actionTypeDraft.label}
                      onChange={(e) => setActionTypeDraft((d) => ({ ...d, label: e.target.value }))}
                      style={{ width: "100%", border: "1px solid var(--color-border, #ddd)", borderRadius: 4, padding: "4px 8px" }}
                    />
                  </label>
                  <button
                    type="button"
                    className="ep-btn"
                    onClick={async () => {
                      setActionTypeError("");
                      if (!actionTypeDraft.code || !actionTypeDraft.label) { setActionTypeError("Both code and label are required."); return; }
                      if (actionTypes.some((at) => at.code === actionTypeDraft.code)) { setActionTypeError("That code already exists."); return; }
                      try {
                        const result = await api.createWorkflowActionType({ code: actionTypeDraft.code, label: actionTypeDraft.label, sort_order: 99 });
                        setActionTypes((prev) => [...prev, { id: (result as any).id, code: actionTypeDraft.code, label: actionTypeDraft.label, is_system: false, is_active: true, sort_order: 99 }]);
                        setActionTypeDraft({ code: "", label: "" });
                      } catch (err: any) {
                        setActionTypeError(err.message || "Failed to add action type");
                      }
                    }}
                  >Add</button>
                </div>
                {actionTypeError && <p style={{ color: "red", fontSize: 12, marginTop: 6 }}>{actionTypeError}</p>}
                <p style={{ fontSize: 11, color: "var(--color-muted, #888)", marginTop: 8 }}>
                  Built-in labels (Approver, Counter Signer, Payment Officer) can be renamed but not removed. Custom labels all act as approvers.
                </p>
              </div>
            )}
          </section>
        )}
      </div>
    );
  }

  function renderDetailsScreen() {
    return (
      <div className="workflow-page workflow-create-page">
        <div className="page-heading workflow-page-heading">
          <div>
            <h2>Create New Workflow</h2>
            <p>Define the basic information before designing the approval flow.</p>
          </div>
        </div>
        {renderStepper(1)}

        <div className="workflow-details-layout">
          <section className="workflow-panel workflow-metadata-card">
            <h3>Workflow Details</h3>
            <div className="workflow-form-grid">
              <label>
                <span>Workflow Name <sup>*</sup></span>
                <input value={metadata.name} onChange={(event) => updateMetadata({ name: event.target.value })} placeholder="Advance Request Workflow" />
              </label>
              <label>
                <span>Company</span>
                <select value={metadata.division} onChange={(event) => updateMetadata({ division: event.target.value, department: "", section: "", team: "" })}>
                  <option value="">All Companies</option>
                  {divisionOptionsForPicker.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label>
                <span>Division Scope <sup>*</sup></span>
                <select value={metadata.department} onChange={(event) => updateMetadata({ department: event.target.value, section: "", team: "" })}>
                  <option value="">All Divisions</option>
                  {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
                </select>
              </label>
              <label>
                <span>Department</span>
                <select value={metadata.section} onChange={(event) => updateMetadata({ section: event.target.value, team: "" })} disabled={!metadata.department || sectionOptions.length === 0}>
                  <option value="">All Departments</option>
                  {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label>
                <span>Section</span>
                <select value={metadata.team} onChange={(event) => updateMetadata({ team: event.target.value })} disabled={!metadata.section || teamOptions.length === 0}>
                  <option value="">All Sections</option>
                  {teamOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="workflow-form-wide">
                <span>Requester Scope <span style={{ color: "var(--muted, #6b7280)", fontWeight: 400 }}>(optional)</span></span>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
                  {[
                    { code: "EXCO", label: "EXCO" },
                    { code: "MANAGER", label: "Manager" },
                    { code: "CEO", label: "CEO" }
                  ].map((r) => (
                    <label key={r.code} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                      <input
                        type="checkbox"
                        checked={metadata.requesterRoles.includes(r.code)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...metadata.requesterRoles, r.code]
                            : metadata.requesterRoles.filter((c) => c !== r.code);
                          updateMetadata({ requesterRoles: next });
                        }}
                      />
                      {r.label}
                    </label>
                  ))}
                </div>
                <small>
                  Leave unchecked to apply to all requesters. When checked, this workflow only resolves for requesters
                  with the selected role(s) — useful for a dedicated EXCO/Manager/CEO travel advance workflow.
                </small>
              </label>
              <label className="workflow-form-wide">
                <span>Description</span>
                <textarea value={metadata.description} onChange={(event) => updateMetadata({ description: event.target.value })} maxLength={500} />
                <small>{metadata.description.length} / 500</small>
              </label>
              <label>
                <span>Status</span>
                <select value={metadata.status} onChange={(event) => updateMetadata({ status: event.target.value as WorkflowStatus })}>
                  {STATUS_OPTIONS.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
                </select>
              </label>
            </div>
          </section>

          <aside className="workflow-panel workflow-request-type-card">
            <h3>Request Type <sup>*</sup></h3>
            <p>
              Select one or more request types this workflow applies to. Checking more than one
              creates a separate copy of this workflow per type (same steps), so pick every type
              that should share this exact approval flow.
            </p>
            <div className="workflow-radio-list">
              {step1RequestTypeOptions.map((type) => (
                <label key={type.value}>
                  <input
                    type="checkbox"
                    checked={selectedRequestTypeValues.includes(type.value)}
                    onChange={() => toggleRequestTypeValue(type.value)}
                  />
                  <span>{type.label}</span>
                </label>
              ))}
            </div>
          </aside>
        </div>

        <div className="workflow-screen-actions">
          <button className="button button-subtle" type="button" onClick={() => setScreen("LIST")}>Cancel</button>
          <button className="button button-primary" type="button" onClick={continueToTemplate}>
            Next: Select Template
          </button>
        </div>
      </div>
    );
  }

  function renderTemplateScreen() {
    const selectedTemplate = TEMPLATE_DEFINITIONS.find((template) => template.id === selectedTemplateId) || TEMPLATE_DEFINITIONS[0];
    const previewSteps = buildTemplateSteps(selectedTemplate.id);
    return (
      <div className="workflow-page workflow-template-page">
        <div className="page-heading workflow-page-heading">
          <div>
            <h2>Create New Workflow</h2>
            <p>Choose a starting template or begin with a blank workflow.</p>
          </div>
        </div>
        {renderStepper(2)}

        <section className="workflow-panel workflow-template-panel">
          <h3>Start From Template</h3>
          <div className="workflow-template-grid">
            {TEMPLATE_DEFINITIONS.map((template) => (
              <button key={template.id} className={`workflow-template-card ${selectedTemplateId === template.id ? "selected" : ""}`} type="button" onClick={() => setSelectedTemplateId(template.id)}>
                <strong>{template.name}</strong>
                <span>{template.description}</span>
                {template.id === "BLANK" ? (
                  <div className="workflow-template-blank"><Plus size={18} aria-hidden /></div>
                ) : (
                  renderFlow(template.steps.map((stepDef, index) => {
                    if (typeof stepDef === "string") return makeStep(stepDef, index);
                    const ov: Partial<WorkflowStep> = { positionName: stepDef.name };
                    if (stepDef.description) ov.description = stepDef.description;
                    return makeStep(stepDef.code, index, ov);
                  }), true)
                )}
              </button>
            ))}
          </div>
          <div className="workflow-template-preview">
            <h3>Preview</h3>
            {renderFlow(previewSteps)}
          </div>
        </section>

        <div className="workflow-screen-actions">
          <button className="button button-subtle" type="button" onClick={() => setScreen("DETAILS")}>
            <ChevronLeft size={16} aria-hidden />
            Back
          </button>
          <button className="button button-primary" type="button" onClick={continueToDesigner}>
            Next: Design Workflow
          </button>
        </div>
      </div>
    );
  }

  function renderDesignerScreen() {
    return (
      <div className="workflow-page">
        <div className="page-heading workflow-page-heading">
          <div>
            <h2>{readOnly ? "Workflow Details" : "Approval Workflow Builder"}</h2>
            <p>{readOnly ? "Review workflow configuration and approval routing." : "Design and configure approval workflows for different request types."}</p>
          </div>
        </div>

        <div className="workflow-config-bar">
          <label className="workflow-config-field workflow-config-name">
            <span>Workflow Name</span>
            <input value={metadata.name} onChange={(event) => updateMetadata({ name: event.target.value })} disabled={readOnly} />
          </label>
          <label className="workflow-config-field">
            <span>Request Type</span>
            <select
              value={SUB_TYPED_REQUEST_TYPES[metadata.requestType] && metadata.advanceSubType ? `${metadata.requestType}:${metadata.advanceSubType}` : metadata.requestType}
              onChange={(event) => handleStep1RequestTypeChange(event.target.value)}
              disabled={readOnly}
            >
              <optgroup label="Advance Request">
                <option value="ADVANCE_REQUEST">All Advances (any type)</option>
                {advanceSubTypes.map((opt) => (
                  <option key={opt.value} value={`ADVANCE_REQUEST:${opt.value}`}>{opt.label}</option>
                ))}
              </optgroup>
              <optgroup label="Clearance Request">
                {clearanceSubTypes.map((opt) => (
                  <option key={opt.value} value={`CLEARANCE_REQUEST:${opt.value}`}>{opt.label}</option>
                ))}
              </optgroup>
              {requestTypeOptions.filter((o) => !SUB_TYPED_REQUEST_TYPES[o.value]).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="workflow-config-field">
            <span>Company</span>
            <select value={metadata.division} onChange={(event) => updateMetadata({ division: event.target.value, department: "", section: "", team: "" })} disabled={readOnly}>
              <option value="">All Companies</option>
              {divisionOptionsForPicker.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="workflow-config-field workflow-config-department">
            <span>Division</span>
            <select value={metadata.department} onChange={(event) => updateMetadata({ department: event.target.value, section: "", team: "" })} disabled={readOnly}>
              <option value="">All Divisions</option>
              {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
            </select>
          </label>
          <label className="workflow-config-field">
            <span>Department</span>
            <select value={metadata.section} onChange={(event) => updateMetadata({ section: event.target.value, team: "" })} disabled={readOnly || !metadata.department || sectionOptions.length === 0}>
              <option value="">All Departments</option>
              {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="workflow-config-field">
            <span>Section</span>
            <select value={metadata.team} onChange={(event) => updateMetadata({ team: event.target.value })} disabled={readOnly || !metadata.section || teamOptions.length === 0}>
              <option value="">All Sections</option>
              {teamOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="workflow-config-field workflow-config-status">
            <span>Status</span>
            <select className={`workflow-status-select status-${metadata.status.toLowerCase()}`} value={metadata.status} onChange={(event) => updateMetadata({ status: event.target.value as WorkflowStatus })} disabled={readOnly}>
              {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <div className="workflow-config-actions">
            <button className="button button-subtle" type="button" onClick={() => setScreen("LIST")} disabled={loading}>
              {readOnly ? "Back" : "Cancel"}
            </button>
            {!readOnly ? (
              <>
                <button className="button button-subtle" type="button" onClick={() => saveWorkflow("DRAFT")} disabled={loading}>
                  Save Draft
                </button>
                <button className="button button-primary" type="button" onClick={() => saveWorkflow("ACTIVE")} disabled={loading}>
                  Save & Activate
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="workflow-workspace">
          <section className="workflow-panel workflow-designer-panel">
            <div className="workflow-panel-header">
              <div>
                <h3>Workflow Designer</h3>
                <p>Drag and drop positions to build and reorder the approval flow.</p>
              </div>
            </div>

            <div
              className="workflow-designer-canvas"
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverIndex(steps.length);
              }}
              onDrop={() => handleDrop(steps.length)}
            >
              {steps.map((step, index) => {
                const Icon = getPositionIcon(step.positionTypeCode);
                const toneClass = getPositionToneClass(step.positionTypeCode);
                const statusLabel = step.isSystemStep ? "System Step" : step.isRequired ? "Required" : "Optional";
                const statusClass = step.isSystemStep ? "status-pill-info" : step.isRequired ? "status-pill-success" : "status-pill-warning";
                const actionLabel =
                  actionTypes.find((at) => at.code === step.actionType)?.label
                  ?? ({ APPROVE: "Approver", COUNTER_SIGN: "Counter Signer", MARK_PAID: "Payment Officer" } as Record<string, string>)[step.actionType]
                  ?? step.actionType;
                const supportLabel = step.isFinalApproval ? `${actionLabel} · Final Approval` : actionLabel;
                const isGrouped = step.parallelWithPrevious || steps[index + 1]?.parallelWithPrevious;
                return (
                  <React.Fragment key={step.id}>
                    <div
                      className={`workflow-step-card ${toneClass}${selectedStep?.id === step.id ? " selected" : ""}${dragOverIndex === index ? " drag-over" : ""}${isGrouped ? " workflow-step-card-grouped" : ""}`}
                      draggable={!readOnly}
                      onClick={() => setSelectedStepId(step.id)}
                      onDragStart={() => setDragSource({ type: "step", id: step.id })}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragOverIndex(index);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        handleDrop(index);
                      }}
                      onDragLeave={() => setDragOverIndex(null)}
                    >
                      <div className="workflow-step-badge">{index + 1}</div>
                      <div className="workflow-step-icon"><Icon size={18} aria-hidden /></div>
                      <div className="workflow-step-labels">
                        <strong>{displayPositionName(step.positionName)}</strong>
                        <span>{step.description}</span>
                      </div>
                      <div className="workflow-step-meta">
                        <span className={`status-pill ${statusClass}`}>{statusLabel}</span>
                        <small>{supportLabel}</small>
                      </div>
                      <MoreVertical className="workflow-card-menu" size={18} aria-hidden />
                    </div>
                    {index < steps.length - 1 ? (
                      steps[index + 1]?.parallelWithPrevious ? (
                        <div className="workflow-step-connector workflow-step-connector-parallel" aria-hidden>
                          <span>+</span>
                          <small>Both must approve</small>
                        </div>
                      ) : (
                        <div className="workflow-step-connector" aria-hidden>↓</div>
                      )
                    ) : null}
                  </React.Fragment>
                );
              })}

              {!readOnly ? (
                <div
                  className={`workflow-drop-target${dragOverIndex === steps.length ? " drag-over" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverIndex(steps.length);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    handleDrop(steps.length);
                  }}
                  onDragLeave={() => setDragOverIndex(null)}
                >
                  <Plus size={16} aria-hidden />
                  <span>Drag a position here to add a new step</span>
                </div>
              ) : null}
            </div>
          </section>

          <aside className="workflow-panel workflow-detail-panel">
            <div className="workflow-panel-header">
              <div><h3>Step Details</h3></div>
              <button className="icon-button has-icon workflow-panel-close" type="button" aria-label="Close step details">
                <X size={16} aria-hidden />
              </button>
            </div>

            {selectedStep ? (
              <div className="workflow-step-details">
                <div className="workflow-step-detail-title">Step {selectedStep.stepOrder}: {displayPositionName(selectedStep.positionName)}</div>
                {!selectedStep.isSystemStep && (() => {
                  const pool = usersForStep(selectedStep);
                  const q = (stepUserSearch[selectedStep.id] ?? "").toLowerCase();
                  const filtered = q ? pool.filter(u =>
                    (u.full_name || "").toLowerCase().includes(q) ||
                    (u.email || "").toLowerCase().includes(q) ||
                    (u.department || "").toLowerCase().includes(q) ||
                    (u.section_name || "").toLowerCase().includes(q) ||
                    (u.role || "").toLowerCase().includes(q)
                  ) : pool;
                  const selectedUser = pool.find(u => u.id === selectedStep.assignedUserId);
                  return (
                    <div>
                      <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                        Assigned To <span style={{ color: "var(--muted, #6b7280)", fontWeight: 400 }}>(optional)</span>
                      </span>
                      {selectedUser && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--surface-soft)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 6, fontSize: 13 }}>
                          <User size={13} style={{ color: "var(--muted, #6b7280)", flexShrink: 0 }} aria-hidden />
                          <span style={{ flex: 1, fontWeight: 500 }}>{selectedUser.full_name || selectedUser.email}</span>
                          <span style={{ color: "var(--muted, #6b7280)", fontSize: 11 }}>{selectedUser.department || ""}</span>
                          {!readOnly && (
                            <button type="button" onClick={() => { updateStep(selectedStep.id, { assignedUserId: null }); setStepUserSearch(p => ({ ...p, [selectedStep.id]: "" })); }}
                              className="ep-icon-btn" style={{ width: 22, height: 22 }} aria-label="Clear assigned user"><X size={13} aria-hidden /></button>
                          )}
                        </div>
                      )}
                      {!readOnly && (
                        <div style={{ position: "relative" }}>
                          <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted, #9ca3af)", pointerEvents: "none" }} aria-hidden />
                          <input
                            type="text"
                            value={stepUserSearch[selectedStep.id] ?? ""}
                            onChange={e => setStepUserSearch(p => ({ ...p, [selectedStep.id]: e.target.value }))}
                            placeholder={pool.length ? `Search ${pool.length} available ${displayPositionName(selectedStep.positionName)} users…` : "Search available users…"}
                            className="ep-form-input"
                            style={{ width: "100%", paddingLeft: 30, boxSizing: "border-box" }}
                          />
                          {(q || pool.length > 0) && filtered.length > 0 && (
                            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, zIndex: 50, maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
                              {filtered.map(u => (
                                <div key={u.id}
                                  onMouseDown={e => { e.preventDefault(); updateStep(selectedStep.id, { assignedUserId: u.id }); setStepUserSearch(p => ({ ...p, [selectedStep.id]: "" })); }}
                                  style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 2 }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#eff6ff"; }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
                                >
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span style={{ fontWeight: 500 }}>{u.full_name || u.email}</span>
                                    <span style={{ color: "var(--muted, #9ca3af)", fontSize: 11, marginLeft: 8 }}>{u.role}</span>
                                  </div>
                                  <span style={{ color: "var(--muted, #9ca3af)", fontSize: 11 }}>
                                    {[u.section_name, u.department].filter(Boolean).join(" • ")}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <label>
                  <span>Step Order <sup>*</sup></span>
                  <input
                    type="number"
                    min={1}
                    max={steps.length}
                    value={selectedStep.stepOrder}
                    disabled={readOnly}
                    onChange={(event) => {
                      const target = Number(event.target.value) - 1;
                      const currentIndex = steps.findIndex((step) => step.id === selectedStep.id);
                      if (!Number.isNaN(target) && currentIndex !== -1) moveStep(currentIndex, Math.max(0, Math.min(target, steps.length - 1)));
                    }}
                  />
                </label>
                <label>
                  <span>Required <sup>*</sup></span>
                  <select value={selectedStep.isRequired ? "YES" : "NO"} onChange={(event) => updateStep(selectedStep.id, { isRequired: event.target.value === "YES" })} disabled={readOnly}>
                    <option value="YES">Yes</option>
                    <option value="NO">No</option>
                  </select>
                </label>
                <label>
                  <span>Skip If Unassigned</span>
                  <select value={selectedStep.skipIfUnassigned ? "YES" : "NO"} onChange={(event) => updateStep(selectedStep.id, { skipIfUnassigned: event.target.value === "YES" })} disabled={readOnly}>
                    <option value="NO">No</option>
                    <option value="YES">Yes</option>
                  </select>
                </label>
                <label>
                  <span>Action Label</span>
                  <select value={selectedStep.actionType} onChange={(event) => updateStep(selectedStep.id, { actionType: event.target.value as "APPROVE" | "COUNTER_SIGN" | "MARK_PAID" })} disabled={readOnly}>
                    {(actionTypes.filter((at) => at.is_active).length > 0
                      ? actionTypes.filter((at) => at.is_active)
                      : [{ code: "APPROVE", label: "Approver" }, { code: "COUNTER_SIGN", label: "Counter Signer" }, { code: "MARK_PAID", label: "Payment Officer" }]
                    ).map((at) => (
                      <option key={at.code} value={at.code}>{at.label}</option>
                    ))}
                  </select>
                  <span style={{ display: "block", fontSize: 11, color: "var(--muted, #6b7280)", marginTop: 4 }}>
                    Set this to "Counter Signer" or "Approver" to let CEO/Exco/Manager requesters pick
                    their own countersigner/approver for travel advances, replacing this step.
                  </span>
                </label>
                <div className="workflow-checkbox-list">
                  <label className="workflow-checkbox">
                    <input type="checkbox" checked={selectedStep.allowDelegation} onChange={(event) => updateStep(selectedStep.id, { allowDelegation: event.target.checked })} disabled={readOnly} />
                    <span>Allow Delegation</span>
                  </label>
                  <label className="workflow-checkbox">
                    <input type="checkbox" checked={selectedStep.commentsRequired} onChange={(event) => updateStep(selectedStep.id, { commentsRequired: event.target.checked })} disabled={readOnly} />
                    <span>Comments Required</span>
                  </label>
                  <label className="workflow-checkbox">
                    <input type="checkbox" checked={selectedStep.isFinalApproval} onChange={(event) => updateStep(selectedStep.id, { isFinalApproval: event.target.checked })} disabled={readOnly} />
                    <span>Final Approval</span>
                  </label>
                  <label className="workflow-checkbox">
                    <input type="checkbox" checked={selectedStep.canReject} onChange={(event) => updateStep(selectedStep.id, { canReject: event.target.checked })} disabled={readOnly} />
                    <span>Allow Reject at this step</span>
                  </label>
                  <label className="workflow-checkbox">
                    <input type="checkbox" checked={selectedStep.canRollback} onChange={(event) => updateStep(selectedStep.id, { canRollback: event.target.checked })} disabled={readOnly} />
                    <span>Allow Roll Back to Draft at this step</span>
                  </label>
                  <label className="workflow-checkbox">
                    <input type="checkbox" checked={selectedStep.requiresAccommodation} onChange={(event) => updateStep(selectedStep.id, { requiresAccommodation: event.target.checked })} disabled={readOnly} />
                    <span>Only required if accommodation is needed (overnight travel)</span>
                  </label>
                  <label className="workflow-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedStep.parallelWithPrevious}
                      disabled={readOnly || steps.findIndex((s) => s.id === selectedStep.id) === 0}
                      onChange={(event) => updateStep(selectedStep.id, { parallelWithPrevious: event.target.checked })}
                    />
                    <span>Run in parallel with the step above (both must approve)</span>
                  </label>
                </div>
                <label>
                  <span>Escalation Days</span>
                  <select value={selectedStep.escalationDays} onChange={(event) => updateStep(selectedStep.id, { escalationDays: Number(event.target.value) })} disabled={readOnly}>
                    {[0, 1, 2, 3, 5, 7, 10].map((days) => <option key={days} value={days}>{days === 0 ? "None" : `${days} Day${days > 1 ? "s" : ""}`}</option>)}
                  </select>
                </label>
                {!readOnly ? (
                  <button className="button button-danger workflow-remove-step" type="button" onClick={() => removeStep(selectedStep.id)}>
                    <Trash2 size={15} aria-hidden />
                    Remove Step
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="workflow-empty-note">Select a step to edit its details.</div>
            )}
          </aside>

          <aside className="workflow-panel workflow-positions-panel">
            <div className="workflow-panel-header">
              <div>
                <h3>Available Positions</h3>
                <p>
                  {metadata.department
                    ? <>Drag a position to the workflow — scoped to <strong>{metadata.department}</strong>'s org structure</>
                    : "Drag any position to the workflow"}
                </p>
              </div>
            </div>
            <div className="workflow-position-list">
              {scopedPositionTypes.map((position) => {
                const Icon = getPositionIcon(position.code);
                const isExtra = extraPositions.some((p) => p.id === position.id);
                return (
                  <div
                    key={position.id}
                    className={`workflow-position-card ${getPositionToneClass(position.code)}`}
                    draggable={!readOnly}
                    onDragStart={() => setDragSource({ type: "position", id: position.code, overrides: { positionName: position.name, description: position.description, assignedUserId: position.assignedUserId, approvalMode: position.approvalMode, approvalGroupName: position.approvalGroupName } })}
                  >
                    <div className="workflow-position-card-icon"><Icon size={18} aria-hidden /></div>
                    <div className="workflow-position-card-copy">
                      <strong>{position.name}</strong>
                      <p>{position.description}</p>
                    </div>
                    {isExtra && !readOnly ? (
                      <button type="button" className="workflow-position-remove" title="Remove from list" onClick={() => removeExtraPosition(position.id)}>
                        <X size={14} aria-hidden />
                      </button>
                    ) : null}
                    <GripVertical size={16} aria-hidden className="workflow-drag-handle" />
                  </div>
                );
              })}
            </div>

            {!readOnly && (
              <div style={{ padding: "10px 0 4px" }}>
                <button type="button" className="button button-subtle small-button" onClick={() => setShowAddPosition(true)} style={{ width: "100%" }}>
                  <Plus size={14} aria-hidden /> Add position or team member from another department
                </button>
              </div>
            )}
          </aside>

          {showAddPosition && (
            <WorkflowAddParticipantModal
              positions={participantPositionPool}
              teams={participantTeamPool}
              employees={participantEmployeePool}
              divisionOptions={divisionOptionsForPicker}
              departmentOptions={departmentOptions}
              sectionOptions={allSectionNames}
              teamOptions={allTeamNames}
              onAddPosition={handleAddParticipantPosition}
              onAddTeam={handleAddParticipantTeam}
              onAddDepartment={handleAddParticipantDepartment}
              onAddSection={handleAddParticipantSection}
              onAddEmployee={handleAddParticipantEmployee}
              onClose={() => setShowAddPosition(false)}
            />
          )}

          <section className="workflow-panel workflow-validation-card">
            <h3>Workflow Validation</h3>
            <div className="workflow-validation-list">
              <span className="workflow-validation-pill success"><Check size={15} aria-hidden />Manager assigned in {validationCounts.managerCount} of {validationCounts.total} departments</span>
              <span className="workflow-validation-pill success"><Check size={15} aria-hidden />EXCO member assigned in {validationCounts.excoCount} of {validationCounts.total} departments</span>
              <span className={validationCounts.hodMissing ? "workflow-validation-pill warning" : "workflow-validation-pill success"}>
                {validationCounts.hodMissing ? <AlertTriangle size={15} aria-hidden /> : <Check size={15} aria-hidden />}
                HOD missing in {validationCounts.hodMissing} departments
              </span>
              <button className="button button-subtle small-button" type="button" onClick={showValidationDetails}>View Details</button>
            </div>
          </section>

          <section className="workflow-panel workflow-rules-card">
            <div className="workflow-rules-header">
              <h3>Workflow Rules (Conditional Approvals)</h3>
              {!readOnly ? (
                <button className="button button-subtle small-button" type="button" onClick={handleAddRule}>
                  <Plus size={14} aria-hidden />
                  {showRuleForm ? "Save Rule" : "Add Rule"}
                </button>
              ) : null}
            </div>

            {showRuleForm ? (
              <div className="workflow-rule-form">
                <input placeholder="Rule name" value={ruleDraft.ruleName || ""} onChange={(event) => setRuleDraft((current) => ({ ...current, ruleName: event.target.value }))} />
                <div className="workflow-rule-grid">
                  <select value={ruleDraft.conditionField || "Amount"} onChange={(event) => setRuleDraft((current) => ({ ...current, conditionField: event.target.value }))}>
                    <option value="Amount">Amount</option>
                  </select>
                  <select value={ruleDraft.conditionOperator || ">"} onChange={(event) => setRuleDraft((current) => ({ ...current, conditionOperator: event.target.value }))}>
                    <option value=">">Greater than</option>
                    <option value="<">Less than</option>
                    <option value="=">Equal to</option>
                  </select>
                  <input type="number" placeholder="Value" value={ruleDraft.conditionValue || ""} onChange={(event) => setRuleDraft((current) => ({ ...current, conditionValue: event.target.value }))} />
                </div>
                <div className="workflow-rule-form-footer">
                  <select
                    value={ruleDraft.additionalPositionTypeId || defaultRuleTargetValue}
                    onChange={(event) => {
                      const selected = ruleTargetOptions.find((option) => option.value === event.target.value);
                      setRuleDraft((current) => ({
                        ...current,
                        additionalPositionTypeId: event.target.value,
                        additionalPositionName: selected?.positionName || null,
                        additionalAssignedUserId: selected?.assignedUserId || null
                      }));
                    }}
                  >
                    {ruleDraft.additionalPositionTypeId && !ruleTargetOptions.some((option) => option.value === ruleDraft.additionalPositionTypeId) ? (
                      <option value={ruleDraft.additionalPositionTypeId}>{resolveRuleTarget(ruleDraft).label}</option>
                    ) : null}
                    {groupedRuleTargetOptions.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.options.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <button className="button button-subtle small-button" type="button" onClick={cancelRuleEdit}>Cancel</button>
                </div>
              </div>
            ) : null}

            <div className="workflow-rules-table-wrap">
              <table className="workflow-rules-table">
                <thead>
                  <tr>
                    <th>Rule Name</th>
                    <th>Condition</th>
                    <th>Additional Step</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <td>{rule.ruleName}</td>
                      <td>{describeRuleCondition(rule)}</td>
                      <td>{resolveRuleTargetLabel(rule)}</td>
                      <td>
                        {!readOnly ? (
                          <>
                            <button className="icon-button has-icon workflow-table-action" type="button" aria-label={`Edit ${rule.ruleName}`} onClick={() => editRule(rule)}>
                              <Pencil size={15} aria-hidden />
                            </button>
                            <button className="icon-button has-icon workflow-table-action danger" type="button" aria-label={`Remove ${rule.ruleName}`} onClick={() => removeRule(rule.id)}>
                              <Trash2 size={15} aria-hidden />
                            </button>
                          </>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                  {rules.length === 0 ? <tr><td colSpan={4}>No conditional rules defined.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="workflow-panel workflow-summary-card">
            <h3>Workflow Summary</h3>
            <div className="summary-row"><span>Total Steps</span><strong>{workflowSummary.totalSteps}</strong></div>
            <div className="summary-row"><span>Required Steps</span><strong>{workflowSummary.requiredSteps}</strong></div>
            <div className="summary-row"><span>Optional Steps</span><strong>{workflowSummary.optionalSteps}</strong></div>
            <div className="summary-row"><span>Final Approval</span><strong>{workflowSummary.finalApproval}</strong></div>
            <div className="summary-row"><span>Division</span><strong>{metadata.department || "All Divisions"}</strong></div>
          </aside>
        </div>
      </div>
    );
  }

  if (screen === "DETAILS") return renderDetailsScreen();
  if (screen === "TEMPLATE") return renderTemplateScreen();
  if (screen === "DESIGNER") return renderDesignerScreen();
  return renderListScreen();
}
