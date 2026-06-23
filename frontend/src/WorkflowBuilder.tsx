import React, { useEffect, useMemo, useState } from "react";
import Swal from "sweetalert2";
import { api } from "./api";
import { useStaffDirectory, isActiveStaff, type StaffMember } from "./useStaffDirectory";
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
  actionType: "APPROVE" | "COUNTER_SIGN" | "MARK_PAID";
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
  { id: "pos-hod", code: "HOD", name: "HOD", description: "Department Head", applies_to: ALL_REQUEST_TYPES, is_active: true },
  { id: "pos-manager", code: "MANAGER", name: "Manager", description: "Department Manager", applies_to: ALL_REQUEST_TYPES, is_active: true },
  { id: "pos-finance", code: "FINANCE", name: "Finance", description: "Finance Approval", applies_to: ALL_REQUEST_TYPES, is_active: true },
  { id: "pos-hr-review", code: "HR_REVIEW", name: "HR Review", description: "HR Review", applies_to: ALL_REQUEST_TYPES, is_active: true },
  { id: "pos-ceo", code: "CEO", name: "CEO", description: "Chief Executive Officer", applies_to: ALL_REQUEST_TYPES, is_active: true }
];

type TemplateStepDef = string | { code: string; name: string; description?: string };

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
    description: "Counter Signer → Approver → HR Manager → HR Team → Finance",
    steps: [
      "EMPLOYEE",
      { code: "MANAGER",    name: "Counter Signer",          description: "Manager, Supervisor or Delegated person to counter-sign" },
      { code: "HR_REVIEW",  name: "Human Resource Manager",  description: "HR Manager review — fixed step, does not change" },
      { code: "HR_REVIEW",  name: "Human Resource",            description: "HR team final check before finance settlement" },
      { code: "FINANCE",    name: "Finance",                  description: "Finance processes and settles the advance" }
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
  status: "DRAFT"
};

const ADVANCE_SUB_TYPES_STATIC = [
  { value: "SALARY", label: "Salary Advance" },
  { value: "LOAN",   label: "Loan" },
  { value: "TRAVEL", label: "Travel / Per Diem" },
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

const RULE_TARGET_ROLE_CODES = ["HOD", "MANAGER", "FINANCE", "HR_REVIEW", "CEO"];
const RULE_TARGET_STAFF_ROLES = ["HOD", "MANAGER", "HR_MANAGER", "FINANCE", "CEO"];

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
    case "HR_MANAGER":
      return "HR_REVIEW";
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
    case "HR_REVIEW":
      return Users;
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
  const [addPositionPicker, setAddPositionPicker] = useState<{ division: string; department: string; section: string; team: string; role: string; anyTeamMember: boolean }>({ division: "", department: "", section: "", team: "", role: "HOD", anyTeamMember: false });
  const [showAddPosition, setShowAddPosition] = useState(false);
  const [addPanelMode, setAddPanelMode] = useState<"position" | "member">("position");
  const [addMemberPicker, setAddMemberPicker] = useState<{ department: string; team: string; userId: string }>({ department: "", team: "", userId: "" });
  const { staff } = useStaffDirectory();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [metadata, setMetadata] = useState<WorkflowMetadata>(EMPTY_METADATA);
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
  const [customRequestTypes, setCustomRequestTypes] = useState<Array<{ value: string; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [allUsers, setAllUsers] = useState<Array<{ id: string; full_name: string | null; email: string; role: string; department: string | null; employee_no: string | null }>>([]);
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

  const advanceSubTypes = ADVANCE_SUB_TYPES_STATIC;

  // Splits "Advance Request" into its sub-types (Salary, Loan, Travel) so each can be picked directly.
  const step1RequestTypeOptions = useMemo(() => {
    const expanded: { value: string; label: string }[] = [];
    for (const type of requestTypeOptions) {
      if (type.value === "ADVANCE_REQUEST") {
        for (const sub of advanceSubTypes) {
          expanded.push({ value: `ADVANCE_REQUEST:${sub.value}`, label: sub.label });
        }
      } else {
        expanded.push(type);
      }
    }
    return expanded;
  }, [requestTypeOptions, advanceSubTypes]);

  const step1RequestTypeValue =
    metadata.requestType === "ADVANCE_REQUEST"
      ? `ADVANCE_REQUEST:${metadata.advanceSubType || "SALARY"}`
      : metadata.requestType;

  function handleStep1RequestTypeChange(value: string) {
    if (value.startsWith("ADVANCE_REQUEST:")) {
      updateMetadata({ requestType: "ADVANCE_REQUEST", advanceSubType: value.split(":")[1] });
    } else {
      updateMetadata({ requestType: value, advanceSubType: "" });
    }
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
      const base = availablePositionTypes.filter((p) => p.code !== "HR_REVIEW" && p.code !== "FINANCE" && p.code !== "CEO");
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

    const hod = byCode("HOD");
    if (hod) cards.push({ ...hod, id: `scoped-hod-${scopeKey}`, description: personLabel(orgSection?.hod_name ?? dept?.hod_name) });

    const manager = byCode("MANAGER");
    if (manager) cards.push({ ...manager, id: `scoped-manager-${scopeKey}`, description: personLabel(orgSection?.manager_name ?? dept?.manager_name) });

    // Extra positions added by admin from other departments/sections
    extraPositions.forEach((p) => cards.push(p));

    return cards;
  }, [availablePositionTypes, departments, orgStructure, metadata.department, metadata.section, extraPositions]);

  const selectedStep = useMemo(() => steps.find((step) => step.id === selectedStepId) || steps[0] || null, [steps, selectedStepId]);

  const detailPositionOptions = useMemo(() => {
    // Hide HR Review and Finance from the Position picker — these are no
    // longer assignable as new step positions, but stay selectable if a
    // pre-existing step already uses one (avoids an invalid select value).
    const hideRetiredCodes = (list: PositionType[]) =>
      list.filter((p) => (p.code !== "HR_REVIEW" && p.code !== "FINANCE") || p.code === selectedStep?.positionTypeCode);
    if (!selectedStep || activePositionTypes.some((position) => position.code === selectedStep.positionTypeCode)) {
      return hideRetiredCodes(activePositionTypes);
    }
    return hideRetiredCodes([
      {
        id: selectedStep.positionTypeId || selectedStep.id,
        code: selectedStep.positionTypeCode,
        name: selectedStep.positionName,
        description: selectedStep.description,
        applies_to: [metadata.requestType],
        is_active: true
      },
      ...activePositionTypes
    ]);
  }, [activePositionTypes, metadata.requestType, selectedStep]);

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
          group: "Department leadership",
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
        group: `People - ${user.department || "No Department"}`,
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

  const deptOptionsForAddPicker = useMemo(() => {
    let depts = orgStructure.departments.map((d) => d.name as string);
    if (addPositionPicker.division) {
      const div = orgStructure.divisions.find((d) => d.name === addPositionPicker.division);
      if (div) {
        depts = orgStructure.departments
          .filter((d) => (d.division_ids as string[] | undefined)?.includes(div.id) || d.division_id === div.id)
          .map((d) => d.name as string);
      }
    }
    return depts.filter((n) => n !== metadata.department).sort((a, b) => a.localeCompare(b));
  }, [orgStructure, addPositionPicker.division, metadata.department]);

  const sectionOptionsForPosition = useMemo(() => {
    if (!addPositionPicker.department) return [];
    const orgDept = orgStructure.departments.find((d) => d?.name === addPositionPicker.department);
    if (!orgDept) return [];
    return orgStructure.sections
      .filter((s) => s?.department_id === orgDept.id)
      .map((s) => s.name as string)
      .sort((a, b) => a.localeCompare(b));
  }, [orgStructure, addPositionPicker.department]);

  // Teams belonging to the selected department, optionally narrowed to a selected section.
  const teamOptionsForPosition = useMemo(() => {
    if (!addPositionPicker.department) return [];
    const orgDept = orgStructure.departments.find((d) => d?.name === addPositionPicker.department);
    if (!orgDept) return [];
    let sectionIds: Set<string>;
    if (addPositionPicker.section) {
      const sec = orgStructure.sections.find((s) => s?.name === addPositionPicker.section && s?.department_id === orgDept.id);
      sectionIds = new Set(sec ? [sec.id] : []);
    } else {
      sectionIds = new Set(orgStructure.sections.filter((s) => s?.department_id === orgDept.id).map((s) => s.id));
    }
    return orgStructure.teams
      .filter((t) => t?.section_id && sectionIds.has(t.section_id))
      .map((t) => t.name as string)
      .sort((a, b) => a.localeCompare(b));
  }, [orgStructure, addPositionPicker.department, addPositionPicker.section]);

  // Manager type IDs are UUIDs; position type codes are short strings (HOD, FINANCE, etc.)
  const isManagerTypeId = (role: string) => managerTypes.some((mt) => mt.id === role);
  // All manager types are department-scoped
  const isRoleDeptScoped = (role: string) =>
    isManagerTypeId(role) || role === "HOD" || role === "MANAGER";

  function addExtraPosition() {
    const { division, department, section, team, role, anyTeamMember } = addPositionPicker;
    const selectedManagerType = managerTypes.find((mt) => mt.id === role);
    // Resolve the position type: from manager type's role code or directly as position code
    const posCode = selectedManagerType ? selectedManagerType.role : role;
    const base = activePositionTypes.find((p) => p.code === posCode);
    if (!base) return;
    if (isRoleDeptScoped(role) && !department) return;

    const resetPicker = () => setAddPositionPicker({ division: "", department: "", section: "", team: "", role: "HOD", anyTeamMember: false });

    // "Any one in <team>" — group-based position card.
    if (anyTeamMember && team) {
      const id = `extra-TEAM-${department}-${team}`;
      if (extraPositions.some((p) => p.id === id)) return;
      setExtraPositions((prev) => [
        ...prev,
        {
          id,
          code: base.code,
          name: `Team: ${team}`,
          description: `Anyone in ${team} — ${department}`,
          applies_to: base.applies_to,
          is_active: true,
          assignedUserId: null,
          approvalMode: "ANY_ONE",
          approvalGroupName: `Team: ${team}`
        }
      ]);
      resetPicker();
      setShowAddPosition(false);
      return;
    }

    const scopeParts = [team, section, department, division].filter(Boolean);
    const scopeLabel = scopeParts.join(", ") || (selectedManagerType?.name ?? role);
    const id = `extra-${[role, division, department, section, team].filter(Boolean).join("-")}`;
    if (extraPositions.some((p) => p.id === id)) return;

    const dept = departments.find((d) => getDepartmentName(d) === department);
    const orgDept = orgStructure.departments.find((d) => d?.name === department);
    const orgSection = section
      ? orgStructure.sections.find((s) => s?.name === section && s?.department_id === orgDept?.id)
      : null;
    const orgTeam = team ? orgStructure.teams.find((t) => t?.name === team) : null;

    let personName: string | null = null;
    let personId: string | null = null;

    if (selectedManagerType) {
      // Look up the person in this dept/section/team with that specific manager type
      const candidates = staff.filter(
        (u) =>
          isActiveStaff(u) &&
          u.manager_type_id === selectedManagerType.id &&
          (!department || u.department === department)
      );
      const person = orgTeam
        ? candidates.find((u) => u.team_id === orgTeam.id) ?? candidates.find((u) => u.section_id === orgSection?.id) ?? candidates[0]
        : orgSection
        ? candidates.find((u) => u.section_id === orgSection.id) ?? candidates[0]
        : candidates[0];
      personName = person?.full_name ?? null;
      personId = person?.id ?? null;
    } else if (posCode === "HOD") {
      personName = orgSection?.hod_name ?? dept?.hod_name ?? null;
      personId = orgSection?.hod_user_id ?? dept?.hod_user_id ?? null;
    } else if (posCode === "MANAGER") {
      personName = orgTeam?.leader_name ?? orgSection?.manager_name ?? dept?.manager_name ?? null;
      personId = orgTeam?.leader_user_id ?? orgSection?.manager_user_id ?? dept?.manager_user_id ?? null;
    }
    // For FINANCE, HR_REVIEW, CEO, custom: role-based, no assigned person.

    const displayName = selectedManagerType?.name ?? base.name;

    setExtraPositions((prev) => [
      ...prev,
      {
        id,
        code: base.code,
        name: displayName,
        description: personName
          ? `${personName} — ${scopeLabel}`
          : department ? `Unassigned — ${scopeLabel}` : displayName,
        applies_to: base.applies_to,
        is_active: true,
        assignedUserId: personId || null
      }
    ]);
    resetPicker();
    setShowAddPosition(false);
  }

  const deptMembers = useMemo(() => {
    if (!addMemberPicker.department) return [];
    return staff.filter((u) => isActiveStaff(u) && u.department === addMemberPicker.department);
  }, [staff, addMemberPicker.department]);

  const teamOptionsForMember = useMemo(() => {
    return Array.from(new Set(deptMembers.map((u) => u.team_name).filter(Boolean) as string[]))
      .sort((a, b) => a.localeCompare(b));
  }, [deptMembers]);

  const memberOptions = useMemo(() => {
    return deptMembers
      .filter((u) => !addMemberPicker.team || u.team_name === addMemberPicker.team)
      .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  }, [deptMembers, addMemberPicker.team]);

  function addExtraMember() {
    if (!addMemberPicker.department || !addMemberPicker.userId) return;
    const member = memberOptions.find((u) => u.id === addMemberPicker.userId);
    if (!member) return;
    const id = `extra-member-${member.id}`;
    if (extraPositions.some((p) => p.id === id)) return;
    const base = activePositionTypes.find((p) => p.code === "MANAGER") || POSITION_TYPE_FALLBACKS.find((p) => p.code === "MANAGER")!;
    const scopeLabel = member.team_name ? `${member.team_name}, ${addMemberPicker.department}` : addMemberPicker.department;
    setExtraPositions((prev) => [
      ...prev,
      {
        id,
        code: base.code,
        name: member.full_name || member.email,
        description: `${member.full_name || member.email} — ${scopeLabel}`,
        applies_to: base.applies_to,
        is_active: true,
        assignedUserId: member.id
      }
    ]);
    setAddMemberPicker({ department: "", team: "", userId: "" });
    setShowAddPosition(false);
  }

  function removeExtraPosition(id: string) {
    setExtraPositions((prev) => prev.filter((p) => p.id !== id));
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
        workflow.department || "All Departments",
        workflow.approvalFlowPreview,
        workflow.description
      ].some((value) => String(value || "").toLowerCase().includes(query));
    });
  }, [departmentFilter, requestTypeFilter, search, statusFilter, workflows]);

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
    finalApproval: steps.find((step) => step.isFinalApproval)?.positionName || "Not set"
  }), [steps]);

  useEffect(() => {
    void loadInitialData();
  }, []);

  async function loadInitialData() {
    setLoading(true);
    try {
      const [workflowResult, departmentResult, orgStructureResult, requestTypesResult, usersResult, actionTypesResult, meResult, managerTypesResult] = await Promise.all([
        api.workflows(),
        api.departmentsWithSections(),
        api.orgStructure(),
        api.requestTypes(),
        api.adminUsers(),
        api.workflowActionTypes(),
        api.me(),
        api.managerTypes().catch(() => [])
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
      setAllUsers(Array.isArray(usersResult) ? usersResult.filter((u: any) => u.profile_completed && !["EMPLOYEE"].includes(u.role)) : []);
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
        const activeMt = managerTypesResult.filter((mt: any) => mt.active !== false);
        setManagerTypes(activeMt);
        if (activeMt.length > 0) setAddPositionPicker((p) => ({ ...p, role: activeMt[0].id }));
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
      return makeStep(stepDef.code, index, overrides);
    });
    if (next.length > 0) {
      next[next.length - 1] = { ...next[next.length - 1], isFinalApproval: true };
    }
    return next;
  }

  function flowPreview(stepList = steps) {
    return stepList.map((step) => step.positionName).filter(Boolean).join(" → ");
  }

  function resetDesigner(nextMetadata: Partial<WorkflowMetadata> = {}) {
    setSelectedWorkflowId("");
    setMetadata({ ...EMPTY_METADATA, ...nextMetadata });
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
        status: workflow.status
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

  function updateStepPosition(stepId: string, positionCode: string) {
    const positionType = positionByCode(positionCode);
    updateStep(stepId, {
      positionTypeCode: positionType.code,
      positionTypeId: positionType.id,
      positionName: positionType.name,
      description: positionType.description
    });
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

  function usersForStep(step: WorkflowStep) {
    const nameLower = step.positionName.toLowerCase();
    let roles: string[];
    switch (step.positionTypeCode) {
      case "MANAGER":     roles = ["MANAGER", "HOD"]; break;
      case "HOD":         roles = ["HOD"]; break;
      case "FINANCE":     roles = ["FINANCE"]; break;
      case "CEO":         roles = ["CEO"]; break;
      case "HR_REVIEW":
        roles = (nameLower.includes("manager")) ? ["HR_MANAGER"] : ["MANAGER", "HR_MANAGER"];
        break;
      default:            roles = allUsers.map(u => u.role);
    }
    return allUsers.filter(u => roles.includes(u.role));
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
      advance_sub_type: (metadata.requestType === "ADVANCE_REQUEST" && metadata.advanceSubType) ? metadata.advanceSubType : null,
      department: metadata.department || null,
      section: metadata.section || null,
      team: metadata.team || null,
      description: metadata.description.trim() || null,
      status: targetStatus || metadata.status,
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
    try {
      setLoading(true);
      if (selectedWorkflowId) {
        await api.updateWorkflow(selectedWorkflowId, workflowPayload(targetStatus));
      } else {
        const result = await api.createWorkflow(workflowPayload(targetStatus));
        setSelectedWorkflowId(result.id || "");
      }
      await refreshWorkflows();
      setScreen("LIST");
      void Swal.fire({ icon: "success", title: "Workflow saved", timer: 1400, showConfirmButton: false });
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
        status: "DRAFT"
      });
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
                <span>{step.positionName}</span>
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
              <option value="">All Departments</option>
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
                  <th>Department</th>
                  <th>Approval Flow Preview</th>
                  <th>Steps</th>
                  <th>Status</th>
                  <th>Last Modified</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredWorkflows.map((workflow) => {
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
                              {advanceSubTypes.find((t) => t.value === workflow.advanceSubType)?.label ?? workflow.advanceSubType}
                            </span>
                          )}
                        </td>
                        <td>{workflow.department || "All Departments"}</td>
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
                      placeholder="Department Reviewer"
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
                <span>Request Type <sup>*</sup></span>
                <select value={step1RequestTypeValue} onChange={(event) => handleStep1RequestTypeChange(event.target.value)}>
                  {step1RequestTypeOptions.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
              </label>
              <label>
                <span>Division</span>
                <select value={metadata.division} onChange={(event) => updateMetadata({ division: event.target.value, department: "", section: "", team: "" })}>
                  <option value="">All Divisions</option>
                  {divisionOptionsForPicker.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label>
                <span>Department Scope <sup>*</sup></span>
                <select value={metadata.department} onChange={(event) => updateMetadata({ department: event.target.value, section: "", team: "" })}>
                  <option value="">All Departments</option>
                  {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
                </select>
              </label>
              <label>
                <span>Section</span>
                <select value={metadata.section} onChange={(event) => updateMetadata({ section: event.target.value, team: "" })} disabled={!metadata.department || sectionOptions.length === 0}>
                  <option value="">All Sections</option>
                  {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label>
                <span>Team</span>
                <select value={metadata.team} onChange={(event) => updateMetadata({ team: event.target.value })} disabled={!metadata.section || teamOptions.length === 0}>
                  <option value="">All Teams</option>
                  {teamOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
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
            <h3>Request Type</h3>
            <p>Select the request type this workflow will be used for.</p>
            <div className="workflow-radio-list">
              {step1RequestTypeOptions.map((type) => (
                <label key={type.value}>
                  <input type="radio" checked={step1RequestTypeValue === type.value} onChange={() => handleStep1RequestTypeChange(type.value)} />
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
              value={metadata.requestType === "ADVANCE_REQUEST" && metadata.advanceSubType ? `ADVANCE_REQUEST:${metadata.advanceSubType}` : metadata.requestType}
              onChange={(event) => {
                const val = event.target.value;
                if (val.startsWith("ADVANCE_REQUEST:")) {
                  updateMetadata({ requestType: "ADVANCE_REQUEST", advanceSubType: val.split(":")[1] });
                } else {
                  updateMetadata({ requestType: val, advanceSubType: "" });
                }
              }}
              disabled={readOnly}
            >
              <optgroup label="Advance Request">
                <option value="ADVANCE_REQUEST">All Advances (any type)</option>
                {advanceSubTypes.map((opt) => (
                  <option key={opt.value} value={`ADVANCE_REQUEST:${opt.value}`}>{opt.label}</option>
                ))}
              </optgroup>
              {requestTypeOptions.filter((o) => o.value !== "ADVANCE_REQUEST").map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="workflow-config-field">
            <span>Division</span>
            <select value={metadata.division} onChange={(event) => updateMetadata({ division: event.target.value, department: "", section: "", team: "" })} disabled={readOnly}>
              <option value="">All Divisions</option>
              {divisionOptionsForPicker.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="workflow-config-field workflow-config-department">
            <span>Department</span>
            <select value={metadata.department} onChange={(event) => updateMetadata({ department: event.target.value, section: "", team: "" })} disabled={readOnly}>
              <option value="">All Departments</option>
              {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
            </select>
          </label>
          <label className="workflow-config-field">
            <span>Section</span>
            <select value={metadata.section} onChange={(event) => updateMetadata({ section: event.target.value, team: "" })} disabled={readOnly || !metadata.department || sectionOptions.length === 0}>
              <option value="">All Sections</option>
              {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="workflow-config-field">
            <span>Team</span>
            <select value={metadata.team} onChange={(event) => updateMetadata({ team: event.target.value })} disabled={readOnly || !metadata.section || teamOptions.length === 0}>
              <option value="">All Teams</option>
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
                        <strong>{step.positionName}</strong>
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
                <div className="workflow-step-detail-title">Step {selectedStep.stepOrder}: {selectedStep.positionName}</div>
                <label>
                  <span>Position <sup>*</sup></span>
                  <select value={selectedStep.positionTypeCode} onChange={(event) => updateStepPosition(selectedStep.id, event.target.value)} disabled={readOnly || selectedStep.isSystemStep}>
                    {detailPositionOptions.map((position) => (
                      <option key={position.id} value={position.code}>
                        {position.name}
                      </option>
                    ))}
                  </select>
                </label>
                {!selectedStep.isSystemStep && (() => {
                  const pool = usersForStep(selectedStep);
                  const q = (stepUserSearch[selectedStep.id] ?? "").toLowerCase();
                  const filtered = q ? pool.filter(u => (u.full_name || u.email).toLowerCase().includes(q) || (u.department || "").toLowerCase().includes(q)) : pool;
                  const selectedUser = pool.find(u => u.id === selectedStep.assignedUserId);
                  return (
                    <div>
                      <span style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                        Assigned To <span style={{ color: "var(--muted, #6b7280)", fontWeight: 400 }}>(optional)</span>
                      </span>
                      {selectedUser && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--color-green-soft, #f0fdf4)", border: "1px solid var(--color-green, #86efac)", borderRadius: 6, marginBottom: 6, fontSize: 13 }}>
                          <User size={13} style={{ color: "var(--color-green-dark, #16a34a)", flexShrink: 0 }} aria-hidden />
                          <span style={{ flex: 1, fontWeight: 500 }}>{selectedUser.full_name || selectedUser.email}</span>
                          <span style={{ color: "var(--muted, #6b7280)", fontSize: 11 }}>{selectedUser.department || ""}</span>
                          {!readOnly && (
                            <button type="button" onClick={() => { updateStep(selectedStep.id, { assignedUserId: null }); setStepUserSearch(p => ({ ...p, [selectedStep.id]: "" })); }}
                              style={{ background: "none", border: "none", cursor: "pointer", color: "#aaa", padding: 0, fontSize: 16, lineHeight: 1 }} aria-label="Clear assigned user">×</button>
                          )}
                        </div>
                      )}
                      {!readOnly && (
                        <div style={{ position: "relative" }}>
                          <input
                            type="text"
                            value={stepUserSearch[selectedStep.id] ?? ""}
                            onChange={e => setStepUserSearch(p => ({ ...p, [selectedStep.id]: e.target.value }))}
                            placeholder={pool.length ? `Search ${pool.length} available ${selectedStep.positionName} users…` : "No users available for this role"}
                            style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--input-border, #d1d5db)", fontSize: 13, boxSizing: "border-box" }}
                            disabled={pool.length === 0}
                          />
                          {q && filtered.length > 0 && (
                            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: "1px solid #d1d5db", borderRadius: 6, zIndex: 50, maxHeight: 200, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                              {filtered.map(u => (
                                <div key={u.id}
                                  onMouseDown={e => { e.preventDefault(); updateStep(selectedStep.id, { assignedUserId: u.id }); setStepUserSearch(p => ({ ...p, [selectedStep.id]: "" })); }}
                                  style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #f3f4f6", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#f5f7ff"; }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
                                >
                                  <span style={{ fontWeight: 500 }}>{u.full_name || u.email}</span>
                                  <span style={{ color: "#9ca3af", fontSize: 11 }}>{u.department || ""}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {q && filtered.length === 0 && (
                            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: "1px solid #d1d5db", borderRadius: 6, zIndex: 50, padding: "8px 12px", fontSize: 13, color: "#9ca3af" }}>
                              No matches
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
                {showAddPosition ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className={`button small-button ${addPanelMode === "position" ? "" : "button-subtle"}`}
                        onClick={() => setAddPanelMode("position")}
                        style={{ flex: 1 }}
                      >
                        Position
                      </button>
                      <button
                        type="button"
                        className={`button small-button ${addPanelMode === "member" ? "" : "button-subtle"}`}
                        onClick={() => setAddPanelMode("member")}
                        style={{ flex: 1 }}
                      >
                        Team member
                      </button>
                    </div>

                    {addPanelMode === "position" ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <select
                          value={addPositionPicker.division}
                          onChange={(e) => setAddPositionPicker((p) => ({ ...p, division: e.target.value, department: "", section: "", team: "" }))}
                          style={{ flex: 1, minWidth: 110, fontSize: 13 }}
                        >
                          <option value="">All divisions…</option>
                          {divisionOptionsForPicker.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <select
                          value={addPositionPicker.department}
                          onChange={(e) => setAddPositionPicker((p) => ({ ...p, department: e.target.value, section: "", team: "" }))}
                          style={{ flex: 1, minWidth: 140, fontSize: 13 }}
                        >
                          <option value="">Choose department…</option>
                          {deptOptionsForAddPicker.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <select
                          value={addPositionPicker.section}
                          onChange={(e) => setAddPositionPicker((p) => ({ ...p, section: e.target.value, team: "" }))}
                          disabled={sectionOptionsForPosition.length === 0}
                          style={{ flex: 1, minWidth: 120, fontSize: 13 }}
                        >
                          <option value="">All sections…</option>
                          {sectionOptionsForPosition.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <select
                          value={addPositionPicker.team}
                          onChange={(e) => setAddPositionPicker((p) => ({ ...p, team: e.target.value, anyTeamMember: e.target.value ? p.anyTeamMember : false }))}
                          disabled={!addPositionPicker.department || teamOptionsForPosition.length === 0}
                          style={{ flex: 1, minWidth: 110, fontSize: 13 }}
                        >
                          <option value="">All teams…</option>
                          {teamOptionsForPosition.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <select
                          value={addPositionPicker.role}
                          onChange={(e) => setAddPositionPicker((p) => ({ ...p, role: e.target.value }))}
                          disabled={addPositionPicker.anyTeamMember}
                          style={{ fontSize: 13 }}
                        >
                          {managerTypes.length > 0 ? (
                            <>
                              <optgroup label="Manager Types">
                                {managerTypes.map((mt) => (
                                  <option key={mt.id} value={mt.id}>{mt.name}</option>
                                ))}
                              </optgroup>
                              <optgroup label="Other Positions">
                                {availablePositionTypes
                                  .filter((p) => p.code !== "HOD" && p.code !== "MANAGER")
                                  .map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                              </optgroup>
                            </>
                          ) : (
                            availablePositionTypes.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)
                          )}
                        </select>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, whiteSpace: "nowrap" }}>
                          <input
                            type="checkbox"
                            checked={addPositionPicker.anyTeamMember}
                            disabled={!addPositionPicker.team}
                            onChange={(e) => setAddPositionPicker((p) => ({ ...p, anyTeamMember: e.target.checked }))}
                          />
                          Any team member
                        </label>
                        <button
                          type="button"
                          className="button button-subtle small-button"
                          onClick={addExtraPosition}
                          disabled={isRoleDeptScoped(addPositionPicker.role) && !addPositionPicker.department}
                        >
                          <Plus size={13} aria-hidden /> Add
                        </button>
                        <button type="button" className="button button-subtle small-button" onClick={() => setShowAddPosition(false)}>
                          <X size={13} aria-hidden />
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <select
                          value={addMemberPicker.department}
                          onChange={(e) => setAddMemberPicker({ department: e.target.value, team: "", userId: "" })}
                          style={{ flex: 1, minWidth: 140, fontSize: 13 }}
                        >
                          <option value="">Choose department…</option>
                          {departmentOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <select
                          value={addMemberPicker.team}
                          onChange={(e) => setAddMemberPicker((p) => ({ ...p, team: e.target.value, userId: "" }))}
                          disabled={!addMemberPicker.department || teamOptionsForMember.length === 0}
                          style={{ flex: 1, minWidth: 120, fontSize: 13 }}
                        >
                          <option value="">All teams…</option>
                          {teamOptionsForMember.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <select
                          value={addMemberPicker.userId}
                          onChange={(e) => setAddMemberPicker((p) => ({ ...p, userId: e.target.value }))}
                          disabled={!addMemberPicker.department || memberOptions.length === 0}
                          style={{ flex: 1, minWidth: 140, fontSize: 13 }}
                        >
                          <option value="">Choose person…</option>
                          {memberOptions.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
                        </select>
                        <button type="button" className="button button-subtle small-button" onClick={addExtraMember} disabled={!addMemberPicker.userId}>
                          <Plus size={13} aria-hidden /> Add
                        </button>
                        <button type="button" className="button button-subtle small-button" onClick={() => setShowAddPosition(false)}>
                          <X size={13} aria-hidden />
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button type="button" className="button button-subtle small-button" onClick={() => setShowAddPosition(true)} style={{ width: "100%" }}>
                    <Plus size={14} aria-hidden /> Add position or team member from another department
                  </button>
                )}
              </div>
            )}
          </aside>

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
            <div className="summary-row"><span>Department</span><strong>{metadata.department || "All Departments"}</strong></div>
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
