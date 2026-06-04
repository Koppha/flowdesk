import React, { useEffect, useMemo, useState } from "react";
import Swal from "sweetalert2";
import { api } from "./api";
import {
  AlertTriangle,
  Check,
  GripVertical,
  Landmark,
  MoreVertical,
  Pencil,
  Plus,
  Scale,
  ShieldCheck,
  ShoppingCart,
  Trash2,
  User,
  UserRoundCheck,
  Users,
  X
} from "lucide-react";

type PositionType = {
  id: string;
  name: string;
  code: string;
  description: string;
  applies_to: string[];
  is_active: boolean;
};

type WorkflowStep = {
  id: string;
  workflowId?: string | null;
  stepOrder: number;
  positionTypeId?: string | null;
  positionTypeCode: string;
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
};

type WorkflowRule = {
  id: string;
  workflowId?: string | null;
  ruleName: string;
  conditionField: string;
  conditionOperator: string;
  conditionValue: string;
  additionalPositionTypeId: string;
  isActive: boolean;
};

type WorkflowRuleDraft = Omit<WorkflowRule, "id" | "workflowId">;

type Workflow = {
  id: string;
  name: string;
  requestType: string;
  department?: string | null;
  status: "DRAFT" | "ACTIVE" | "INACTIVE";
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  steps: WorkflowStep[];
  rules: WorkflowRule[];
};

const REQUEST_TYPES = [
  { value: "ADVANCE_REQUEST", label: "Advance Request" },
  { value: "CLAIM_REQUEST", label: "Claim Request" },
  { value: "OVERTIME_REQUEST", label: "Overtime Request" },
  { value: "CLEARANCE_REQUEST", label: "Clearance Request" }
];

const STATUS_OPTIONS = [
  { value: "DRAFT", label: "Draft" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" }
];

const POSITION_TYPE_FALLBACKS: PositionType[] = [
  { id: "system-employee", code: "EMPLOYEE", name: "Employee", description: "Request Initiator", applies_to: ["ADVANCE_REQUEST", "CLAIM_REQUEST", "OVERTIME_REQUEST", "CLEARANCE_REQUEST"], is_active: true },
  { id: "pos-hod", code: "HOD", name: "HOD", description: "Department Head", applies_to: ["ADVANCE_REQUEST", "CLAIM_REQUEST", "OVERTIME_REQUEST", "CLEARANCE_REQUEST"], is_active: true },
  { id: "pos-manager", code: "MANAGER", name: "Manager", description: "Department Manager", applies_to: ["ADVANCE_REQUEST", "CLAIM_REQUEST", "OVERTIME_REQUEST", "CLEARANCE_REQUEST"], is_active: true },
  { id: "pos-exco", code: "EXCO_OWNER", name: "EXCO Owner", description: "Executive Committee Member", applies_to: ["ADVANCE_REQUEST", "CLAIM_REQUEST", "OVERTIME_REQUEST", "CLEARANCE_REQUEST"], is_active: true },
  { id: "pos-finance", code: "FINANCE", name: "Finance", description: "Finance Approval", applies_to: ["ADVANCE_REQUEST", "CLAIM_REQUEST", "OVERTIME_REQUEST", "CLEARANCE_REQUEST"], is_active: true },
  { id: "pos-procurement", code: "PROCUREMENT", name: "Procurement", description: "Procurement Manager", applies_to: ["ADVANCE_REQUEST", "CLAIM_REQUEST", "OVERTIME_REQUEST", "CLEARANCE_REQUEST"], is_active: true },
  { id: "pos-hr-review", code: "HR_REVIEW", name: "HR Review", description: "HR Review", applies_to: ["ADVANCE_REQUEST", "CLAIM_REQUEST", "OVERTIME_REQUEST", "CLEARANCE_REQUEST"], is_active: true },
  { id: "pos-legal", code: "LEGAL_REVIEW", name: "Legal Review", description: "Legal Department", applies_to: ["ADVANCE_REQUEST", "CLAIM_REQUEST", "OVERTIME_REQUEST", "CLEARANCE_REQUEST"], is_active: true },
  { id: "pos-ceo", code: "CEO", name: "CEO", description: "Chief Executive Officer", applies_to: ["ADVANCE_REQUEST", "CLAIM_REQUEST", "OVERTIME_REQUEST", "CLEARANCE_REQUEST"], is_active: true }
];

const DEFAULT_STEPS: WorkflowStep[] = [
  {
    id: "step-employee",
    stepOrder: 1,
    positionTypeCode: "EMPLOYEE",
    positionTypeId: "system-employee",
    positionName: "Employee",
    description: "Request Initiator",
    isRequired: true,
    skipIfUnassigned: false,
    allowDelegation: false,
    commentsRequired: false,
    escalationDays: 0,
    isFinalApproval: false,
    isSystemStep: true,
    isActive: true
  },
  {
    id: "step-hod",
    stepOrder: 2,
    positionTypeCode: "HOD",
    positionTypeId: "pos-hod",
    positionName: "HOD",
    description: "Department Head",
    isRequired: false,
    skipIfUnassigned: true,
    allowDelegation: false,
    commentsRequired: false,
    escalationDays: 2,
    isFinalApproval: false,
    isSystemStep: false,
    isActive: true
  },
  {
    id: "step-manager",
    stepOrder: 3,
    positionTypeCode: "MANAGER",
    positionTypeId: "pos-manager",
    positionName: "Manager",
    description: "Department Manager",
    isRequired: true,
    skipIfUnassigned: false,
    allowDelegation: true,
    commentsRequired: false,
    escalationDays: 2,
    isFinalApproval: false,
    isSystemStep: false,
    isActive: true
  },
  {
    id: "step-exco",
    stepOrder: 4,
    positionTypeCode: "EXCO_OWNER",
    positionTypeId: "pos-exco",
    positionName: "EXCO Owner",
    description: "Executive Committee Member",
    isRequired: true,
    skipIfUnassigned: false,
    allowDelegation: true,
    commentsRequired: false,
    escalationDays: 2,
    isFinalApproval: false,
    isSystemStep: false,
    isActive: true
  },
  {
    id: "step-finance",
    stepOrder: 5,
    positionTypeCode: "FINANCE",
    positionTypeId: "pos-finance",
    positionName: "Finance",
    description: "Finance Approval",
    isRequired: true,
    skipIfUnassigned: false,
    allowDelegation: false,
    commentsRequired: false,
    escalationDays: 1,
    isFinalApproval: true,
    isSystemStep: false,
    isActive: true
  }
];

const DEFAULT_RULES: WorkflowRule[] = [
  {
    id: "rule-1",
    ruleName: "High Value Approval",
    conditionField: "Amount",
    conditionOperator: ">",
    conditionValue: "20000",
    additionalPositionTypeId: "pos-exco",
    isActive: true
  },
  {
    id: "rule-2",
    ruleName: "Very High Value Approval",
    conditionField: "Amount",
    conditionOperator: ">",
    conditionValue: "50000",
    additionalPositionTypeId: "pos-ceo",
    isActive: true
  }
];

function generateId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2, 10)}`;
}

function getPositionIcon(code: string) {
  switch (code) {
    case "HOD":
      return Users;
    case "MANAGER":
      return UserRoundCheck;
    case "EXCO_OWNER":
      return ShieldCheck;
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
    default:
      return User;
  }
}

function getPositionToneClass(code: string) {
  return `workflow-tone-${String(code || "default").toLowerCase().replace(/_/g, "-")}`;
}

function getDepartmentName(department: any) {
  return typeof department === "string"
    ? department.trim()
    : String(department?.name || department?.department || "").trim();
}

export default function WorkflowBuilder() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [positionTypes, setPositionTypes] = useState<PositionType[]>(POSITION_TYPE_FALLBACKS);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [workflowName, setWorkflowName] = useState("Advance Request Workflow");
  const [requestType, setRequestType] = useState("ADVANCE_REQUEST");
  const [workflowDepartment, setWorkflowDepartment] = useState("");
  const [status, setStatus] = useState<"DRAFT" | "ACTIVE" | "INACTIVE">("ACTIVE");
  const [steps, setSteps] = useState<WorkflowStep[]>(DEFAULT_STEPS);
  const [selectedStepId, setSelectedStepId] = useState<string>(DEFAULT_STEPS[0].id);
  const [rules, setRules] = useState<WorkflowRule[]>(DEFAULT_RULES);
  const [ruleDraft, setRuleDraft] = useState<WorkflowRuleDraft>({ ruleName: "", conditionField: "Amount", conditionOperator: ">", conditionValue: "", additionalPositionTypeId: "pos-exco", isActive: true });
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [departments, setDepartments] = useState<any[]>([]);
  const [dragSource, setDragSource] = useState<{ type: "step" | "position"; id: string } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const activePositionTypes = useMemo(
    () => positionTypes.filter((position) => position.is_active && position.code !== "EMPLOYEE"),
    [positionTypes]
  );

  const selectedStep = useMemo(() => steps.find((step) => step.id === selectedStepId) || steps[0] || null, [steps, selectedStepId]);

  const detailPositionOptions = useMemo(() => {
    if (!selectedStep || activePositionTypes.some((position) => position.code === selectedStep.positionTypeCode)) {
      return activePositionTypes;
    }

    return [
      {
        id: selectedStep.positionTypeId || selectedStep.id,
        code: selectedStep.positionTypeCode,
        name: selectedStep.positionName,
        description: selectedStep.description,
        applies_to: [requestType],
        is_active: true
      },
      ...activePositionTypes
    ];
  }, [activePositionTypes, requestType, selectedStep]);

  const departmentOptions = useMemo(() => {
    return Array.from(
      new Set([...departments.map(getDepartmentName), workflowDepartment].filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
  }, [departments, workflowDepartment]);

  const validationDepartments = useMemo(() => {
    return workflowDepartment
      ? departments.filter((department) => getDepartmentName(department) === workflowDepartment)
      : departments;
  }, [departments, workflowDepartment]);

  const validationCounts = useMemo(() => {
    const total = validationDepartments.length;
    const managerCount = validationDepartments.filter((dept) => dept.manager_user_id).length;
    const excoCount = validationDepartments.filter((dept) => dept.exco_user_id).length;
    const hodMissing = validationDepartments.filter((dept) => !dept.manager_user_id).length;
    return { total, managerCount, excoCount, hodMissing };
  }, [validationDepartments]);

  useEffect(() => {
    loadPositionTypes();
    loadWorkflows();
    loadDepartments();
  }, []);

  useEffect(() => {
    loadWorkflows();
  }, [requestType, workflowDepartment]);

  async function loadPositionTypes() {
    try {
      const result = await api.positionTypes();
      if (Array.isArray(result) && result.length > 0) {
        const merged = POSITION_TYPE_FALLBACKS.map((fallback) => result.find((type: PositionType) => type.code === fallback.code) || fallback);
        const extras = result.filter((type: PositionType) => !POSITION_TYPE_FALLBACKS.some((fallback) => fallback.code === type.code));
        setPositionTypes([...merged, ...extras]);
      }
    } catch {
      setPositionTypes(POSITION_TYPE_FALLBACKS);
    }
  }

  async function loadWorkflows() {
    try {
      const result = await api.workflows(requestType, workflowDepartment);
      if (Array.isArray(result)) {
        setWorkflows(result);
      }
    } catch {
      setWorkflows([]);
    }
  }

  async function loadDepartments() {
    try {
      const result = await api.departmentsWithSections();
      if (Array.isArray(result)) {
        setDepartments(result);
      }
    } catch {
      setDepartments([]);
    }
  }

  async function loadWorkflowDetail(workflowId: string) {
    if (!workflowId) return;
    setLoading(true);
    try {
      const result = await api.workflowDetail(workflowId);
      setSelectedWorkflowId(result.id);
      setWorkflowName(result.name);
      setRequestType((result.requestType as string) || (result.request_type as string) || "ADVANCE_REQUEST");
      setWorkflowDepartment(result.department || "");
      setStatus(result.status);
      const loadedSteps = (result.steps || []).map((raw: any, index: number) => {
        const positionTypeId = raw.position_type_id || raw.positionTypeId || null;
        const positionTypeCode = raw.position_type_code || raw.positionTypeCode || raw.positionTypeCode || "";
        const positionType =
          positionTypes.find((type) => type.id === positionTypeId) ||
          positionTypes.find((type) => type.code === positionTypeCode) ||
          positionTypes.find((type) => type.name === raw.position_name) ||
          POSITION_TYPE_FALLBACKS.find((fallback) => fallback.code === positionTypeCode || fallback.name === raw.position_name);

        return {
          id: raw.id || generateId(),
          workflowId: result.id,
          stepOrder: index + 1,
          positionTypeId: isUuid(positionTypeId) ? positionTypeId : positionType?.id || null,
          positionTypeCode: positionType?.code || positionTypeCode || "",
          positionName: String(raw.position_name || raw.positionName || positionType?.name || ""),
          description: String(raw.description || raw.description || ""),
          isRequired: raw.is_required ?? raw.isRequired ?? false,
          skipIfUnassigned: raw.skip_if_unassigned ?? raw.skipIfUnassigned ?? false,
          allowDelegation: raw.allow_delegation ?? raw.allowDelegation ?? false,
          commentsRequired: raw.comments_required ?? raw.commentsRequired ?? false,
          escalationDays: raw.escalation_days ?? raw.escalationDays ?? 0,
          isFinalApproval: raw.is_final_approval ?? raw.isFinalApproval ?? false,
          isSystemStep: raw.is_system_step ?? raw.isSystemStep ?? false,
          isActive: raw.is_active ?? raw.isActive ?? true
        };
      });
      setSteps(loadedSteps);
      setSelectedStepId(loadedSteps[0]?.id || "");
      const loadedRules = (result.rules || []).map((raw: any) => ({
        id: raw.id || generateId(),
        workflowId: result.id,
        ruleName: raw.rule_name || raw.ruleName || "",
        conditionField: raw.condition_field || raw.conditionField || "Amount",
        conditionOperator: raw.condition_operator || raw.conditionOperator || ">",
        conditionValue: raw.condition_value || raw.conditionValue || "",
        additionalPositionTypeId: raw.additional_position_type_id || raw.additionalPositionTypeId || "",
        isActive: raw.is_active ?? raw.isActive ?? true
      }));
      setRules(loadedRules);
    } catch (error) {
      console.warn(error);
    } finally {
      setLoading(false);
    }
  }

  function normalizeSteps(nextSteps: WorkflowStep[]) {
    const normalized = nextSteps.map((step, index) => ({ ...step, stepOrder: index + 1 }));
    setSteps(normalized);
    if (!normalized.find((step) => step.id === selectedStepId) && normalized.length > 0) {
      setSelectedStepId(normalized[0].id);
    }
  }

  function moveStep(fromIndex: number, toIndex: number) {
    const next = [...steps];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    normalizeSteps(next);
  }

  function addStep(positionTypeCode: string, insertIndex?: number) {
    const positionType = positionTypes.find((type) => type.code === positionTypeCode) || POSITION_TYPE_FALLBACKS.find((type) => type.code === positionTypeCode)!;
    const step: WorkflowStep = {
      id: generateId(),
      workflowId: selectedWorkflowId || null,
      stepOrder: insertIndex != null ? insertIndex + 1 : steps.length + 1,
      positionTypeCode: positionType.code,
      positionTypeId: positionType.id,
      positionName: positionType.name,
      description: positionType.description,
      isRequired: true,
      skipIfUnassigned: false,
      allowDelegation: false,
      commentsRequired: false,
      escalationDays: 0,
      isFinalApproval: false,
      isSystemStep: false,
      isActive: true
    };
    const next = [...steps];
    if (insertIndex != null) next.splice(insertIndex, 0, step);
    else next.push(step);
    normalizeSteps(next);
    setSelectedStepId(step.id);
  }

  function updateStep(stepId: string, updates: Partial<WorkflowStep>) {
    normalizeSteps(steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)));
  }

  function updateStepPosition(stepId: string, positionCode: string) {
    const positionType = positionTypes.find((type) => type.code === positionCode) || POSITION_TYPE_FALLBACKS.find((type) => type.code === positionCode);
    if (!positionType) return;
    updateStep(stepId, {
      positionTypeCode: positionType.code,
      positionTypeId: positionType.id,
      positionName: positionType.name,
      description: positionType.description
    });
  }

  function handleWorkflowNameChange(nextName: string) {
    setWorkflowName(nextName);
    const matchedWorkflow = workflows.find((workflow) => workflow.name === nextName);
    if (matchedWorkflow && matchedWorkflow.id !== selectedWorkflowId) {
      void loadWorkflowDetail(matchedWorkflow.id);
    } else if (!matchedWorkflow && selectedWorkflowId) {
      setSelectedWorkflowId("");
    }
  }

  async function removeStep(stepId: string) {
    const result = await Swal.fire({ title: "Remove step?", text: "Remove this step from the workflow?", icon: "warning", showCancelButton: true, confirmButtonText: "Remove" });
    if (!result.isConfirmed) return;
    normalizeSteps(steps.filter((step) => step.id !== stepId));
  }

  function handleDrop(targetIndex: number) {
    if (!dragSource) return;
    if (dragSource.type === "step") {
      const fromIndex = steps.findIndex((step) => step.id === dragSource.id);
      if (fromIndex === -1) return;
      moveStep(fromIndex, targetIndex);
    } else {
      addStep(dragSource.id, targetIndex);
    }
    setDragSource(null);
    setDragOverIndex(null);
  }

  function handleAddRule() {
    if (!showRuleForm) {
      setShowRuleForm(true);
      return;
    }

    if (!ruleDraft.ruleName || !ruleDraft.conditionValue || !ruleDraft.additionalPositionTypeId) {
      void Swal.fire({ icon: "warning", title: "Incomplete rule", text: "Please complete the rule details." });
      return;
    }

    if (editingRuleId) {
      setRules((current) =>
        current.map((rule) =>
          rule.id === editingRuleId
            ? {
                ...rule,
                ruleName: ruleDraft.ruleName,
                conditionField: ruleDraft.conditionField || "Amount",
                conditionOperator: ruleDraft.conditionOperator || ">",
                conditionValue: ruleDraft.conditionValue || "",
                additionalPositionTypeId: ruleDraft.additionalPositionTypeId || activePositionTypes[0]?.id || "",
                isActive: ruleDraft.isActive ?? true
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
          ruleName: ruleDraft.ruleName,
          conditionField: ruleDraft.conditionField || "Amount",
          conditionOperator: ruleDraft.conditionOperator || ">",
          conditionValue: ruleDraft.conditionValue || "",
          additionalPositionTypeId: ruleDraft.additionalPositionTypeId || activePositionTypes[0]?.id || "",
          isActive: ruleDraft.isActive ?? true
        }
      ]);
    }

    setRuleDraft({ ruleName: "", conditionField: "Amount", conditionOperator: ">", conditionValue: "", additionalPositionTypeId: activePositionTypes[0]?.id || "", isActive: true });
    setEditingRuleId(null);
    setShowRuleForm(false);
  }

  function removeRule(ruleId: string) {
    setRules((current) => current.filter((rule) => rule.id !== ruleId));
  }

  function editRule(rule: WorkflowRule) {
    setRuleDraft({
      ruleName: rule.ruleName,
      conditionField: rule.conditionField,
      conditionOperator: rule.conditionOperator,
      conditionValue: rule.conditionValue,
      additionalPositionTypeId: rule.additionalPositionTypeId,
      isActive: rule.isActive
    });
    setEditingRuleId(rule.id);
    setShowRuleForm(true);
  }

  function cancelRuleEdit() {
    setRuleDraft({ ruleName: "", conditionField: "Amount", conditionOperator: ">", conditionValue: "", additionalPositionTypeId: activePositionTypes[0]?.id || "", isActive: true });
    setEditingRuleId(null);
    setShowRuleForm(false);
  }

  function resolvePositionLabel(positionTypeId: string | undefined | null) {
    const direct = positionTypes.find((type) => type.id === positionTypeId || type.code === positionTypeId);
    if (direct) return direct.name;
    const fallback = POSITION_TYPE_FALLBACKS.find((type) => type.id === positionTypeId || type.code === positionTypeId);
    return fallback?.name || "Unknown";
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

  function isUuid(value: string | undefined | null) {
    return typeof value === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
  }

  function resolvePositionTypeId(positionTypeId: string | undefined | null, positionTypeCode?: string) {
    if (isUuid(positionTypeId)) return positionTypeId;

    const normalizedCode = String(positionTypeCode || "").trim();
    if (normalizedCode) {
      const matchedType = positionTypes.find((type) => type.code === normalizedCode);
      if (matchedType && isUuid(matchedType.id)) return matchedType.id;
    }

    if (positionTypeId) {
      const fallback = POSITION_TYPE_FALLBACKS.find((type) => type.id === positionTypeId);
      const fallbackCode = fallback?.code || positionTypeId;
      const matchedType = positionTypes.find((type) => type.code === fallbackCode || type.id === fallbackCode);
      if (matchedType && isUuid(matchedType.id)) return matchedType.id;
    }

    return undefined;
  }

  async function saveWorkflow(targetStatus?: "DRAFT" | "ACTIVE" | "INACTIVE") {
    if (!workflowName.trim()) {
      void Swal.fire({ icon: "warning", title: "Missing name", text: "Workflow name is required." });
      return;
    }
    const payload = {
      name: workflowName.trim(),
      request_type: requestType,
      department: workflowDepartment || null,
      status: targetStatus || status,
      steps: steps.map((step) => ({
        workflow_id: selectedWorkflowId || undefined,
        step_order: step.stepOrder,
        position_type_id: resolvePositionTypeId(step.positionTypeId, step.positionTypeCode),
        position_name: step.positionName,
        description: step.description || undefined,
        is_required: step.isRequired,
        skip_if_unassigned: step.skipIfUnassigned,
        allow_delegation: step.allowDelegation,
        comments_required: step.commentsRequired,
        escalation_days: step.escalationDays,
        is_final_approval: step.isFinalApproval,
        is_system_step: step.isSystemStep,
        is_active: step.isActive
      })),
      rules: rules.map((rule) => ({
        rule_name: rule.ruleName,
        condition_field: rule.conditionField,
        condition_operator: rule.conditionOperator,
        condition_value: rule.conditionValue,
        additional_position_type_id: resolvePositionTypeId(rule.additionalPositionTypeId),
        is_active: rule.isActive
      }))
    };

    try {
      setLoading(true);
      if (selectedWorkflowId) {
        await api.updateWorkflow(selectedWorkflowId, payload);
        void Swal.fire({ icon: "success", title: "Saved", text: "Workflow updated." });
      } else {
        const result = await api.createWorkflow(payload);
        setSelectedWorkflowId(result.id || "");
        void Swal.fire({ icon: "success", title: "Created", text: "Workflow created." });
      }
      await loadWorkflows();
    } catch (error: any) {
      void Swal.fire({ icon: "error", title: "Save failed", text: "Unable to save workflow: " + (error?.message || "Unknown error") });
    } finally {
      setLoading(false);
    }
  }

  function cancelChanges() {
    if (selectedWorkflowId) {
      loadWorkflowDetail(selectedWorkflowId);
    } else {
      setWorkflowName("Advance Request Workflow");
      setRequestType("ADVANCE_REQUEST");
      setWorkflowDepartment("");
      setStatus("ACTIVE");
      normalizeSteps(DEFAULT_STEPS);
      setRules(DEFAULT_RULES);
    }
  }

  function selectWorkflow(workflowId: string) {
    if (!workflowId) {
      setSelectedWorkflowId("");
      setWorkflowName("Advance Request Workflow");
      setRequestType("ADVANCE_REQUEST");
      setWorkflowDepartment("");
      setStatus("ACTIVE");
      normalizeSteps(DEFAULT_STEPS);
      setRules(DEFAULT_RULES);
      return;
    }
    loadWorkflowDetail(workflowId);
  }

  return (
    <div className="workflow-page">
      <div className="page-heading workflow-page-heading">
        <div>
          <h2>Approval Workflow Builder</h2>
          <p>Design and configure approval workflows for different request types.</p>
        </div>
        <button className="icon-button has-icon workflow-heading-menu" type="button" aria-label="More workflow actions">
          <MoreVertical size={18} aria-hidden />
        </button>
      </div>

      <div className="workflow-config-bar">
        <label className="workflow-config-field workflow-config-name">
          <span>Workflow Name</span>
          <input
            list="workflow-name-options"
            value={workflowName}
            onChange={(event) => handleWorkflowNameChange(event.target.value)}
            placeholder="Workflow name"
          />
          <datalist id="workflow-name-options">
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.name}>
                {workflow.department ? `${workflow.name} (${workflow.department})` : workflow.name}
              </option>
            ))}
          </datalist>
        </label>

        <label className="workflow-config-field">
          <span>Request Type</span>
          <select value={requestType} onChange={(event) => setRequestType(event.target.value)}>
            {REQUEST_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="workflow-config-field workflow-config-department">
          <span>Department</span>
          <select value={workflowDepartment} onChange={(event) => setWorkflowDepartment(event.target.value)}>
            <option value="">All Departments</option>
            {departmentOptions.map((department) => (
              <option key={department} value={department}>
                {department}
              </option>
            ))}
          </select>
        </label>

        <label className="workflow-config-field workflow-config-status">
          <span>Status</span>
          <select className={`workflow-status-select status-${status.toLowerCase()}`} value={status} onChange={(event) => setStatus(event.target.value as "DRAFT" | "ACTIVE" | "INACTIVE")}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className="workflow-config-actions">
          <button className="button button-subtle" type="button" onClick={cancelChanges} disabled={loading}>
            Cancel
          </button>
          <button className="button button-subtle" type="button" onClick={() => saveWorkflow("DRAFT")} disabled={loading}>
            Save As Draft
          </button>
          <button className="button button-primary" type="button" onClick={() => saveWorkflow("ACTIVE")} disabled={loading}>
            Save & Activate
          </button>
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
              const supportLabel = step.isFinalApproval ? "Final Approval" : step.skipIfUnassigned ? "Skip if unassigned" : step.isRequired ? "Must approve" : "Can be skipped";

              return (
                <React.Fragment key={step.id}>
                  <div
                    className={`workflow-step-card ${toneClass}${selectedStep?.id === step.id ? " selected" : ""}${dragOverIndex === index ? " drag-over" : ""}`}
                    draggable
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
                    <div className="workflow-step-icon">
                      <Icon size={18} aria-hidden />
                    </div>
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
                  {index < steps.length - 1 ? <div className="workflow-step-connector" aria-hidden>↓</div> : null}
                </React.Fragment>
              );
            })}

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
          </div>
        </section>

        <aside className="workflow-panel workflow-detail-panel">
          <div className="workflow-panel-header">
            <div>
              <h3>Step Details</h3>
            </div>
            <button className="icon-button has-icon workflow-panel-close" type="button" aria-label="Close step details">
              <X size={16} aria-hidden />
            </button>
          </div>

          {selectedStep ? (
            <div className="workflow-step-details">
              <div className="workflow-step-detail-title">Step {selectedStep.stepOrder}: {selectedStep.positionName}</div>

              <label>
                <span>Position <sup>*</sup></span>
                <select
                  value={selectedStep.positionTypeCode}
                  onChange={(event) => updateStepPosition(selectedStep.id, event.target.value)}
                  disabled={selectedStep.isSystemStep}
                >
                  {detailPositionOptions.map((position) => (
                    <option key={position.code} value={position.code}>
                      {position.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Step Order <sup>*</sup></span>
                <input
                  type="number"
                  min={1}
                  max={steps.length}
                  value={selectedStep.stepOrder}
                  onChange={(event) => {
                    const target = Number(event.target.value) - 1;
                    const currentIndex = steps.findIndex((step) => step.id === selectedStep.id);
                    if (!Number.isNaN(target) && currentIndex !== -1) {
                      moveStep(currentIndex, Math.max(0, Math.min(target, steps.length - 1)));
                    }
                  }}
                />
              </label>

              <label>
                <span>Required <sup>*</sup></span>
                <select value={selectedStep.isRequired ? "YES" : "NO"} onChange={(event) => updateStep(selectedStep.id, { isRequired: event.target.value === "YES" })}>
                  <option value="YES">Yes</option>
                  <option value="NO">No</option>
                </select>
              </label>

              <label>
                <span>Skip if unassigned</span>
                <select value={selectedStep.skipIfUnassigned ? "YES" : "NO"} onChange={(event) => updateStep(selectedStep.id, { skipIfUnassigned: event.target.value === "YES" })}>
                  <option value="NO">No</option>
                  <option value="YES">Yes</option>
                </select>
              </label>

              <div className="workflow-checkbox-list">
                <label className="workflow-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedStep.allowDelegation}
                    onChange={(event) => updateStep(selectedStep.id, { allowDelegation: event.target.checked })}
                  />
                  <span>Allow Delegation</span>
                </label>

                <label className="workflow-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedStep.commentsRequired}
                    onChange={(event) => updateStep(selectedStep.id, { commentsRequired: event.target.checked })}
                  />
                  <span>Comments Required</span>
                </label>
              </div>

              <label>
                <span>Escalate After</span>
                <select value={selectedStep.escalationDays} onChange={(event) => updateStep(selectedStep.id, { escalationDays: Number(event.target.value) })}>
                  {[0, 1, 2, 3, 5, 7, 10].map((days) => (
                    <option key={days} value={days}>
                      {days === 0 ? "None" : `${days} Day${days > 1 ? "s" : ""}`}
                    </option>
                  ))}
                </select>
              </label>

              <button className="button button-danger workflow-remove-step" type="button" onClick={() => removeStep(selectedStep.id)}>
                <Trash2 size={15} aria-hidden />
                Remove Step
              </button>
            </div>
          ) : (
            <div className="workflow-empty-note">Select a step to edit its details.</div>
          )}
        </aside>

        <aside className="workflow-panel workflow-positions-panel">
          <div className="workflow-panel-header">
            <div>
              <h3>Available Positions</h3>
              <p>Drag any position to the workflow</p>
            </div>
          </div>

          <div className="workflow-position-list">
            {activePositionTypes.map((position) => {
              const Icon = getPositionIcon(position.code);
              return (
                <div
                  key={position.code}
                  className={`workflow-position-card ${getPositionToneClass(position.code)}`}
                  draggable
                  onDragStart={() => setDragSource({ type: "position", id: position.code })}
                >
                  <div className="workflow-position-card-icon">
                    <Icon size={18} aria-hidden />
                  </div>
                  <div className="workflow-position-card-copy">
                    <strong>{position.name}</strong>
                    <p>{position.description}</p>
                  </div>
                  <GripVertical size={16} aria-hidden className="workflow-drag-handle" />
                </div>
              );
            })}
          </div>
        </aside>

        <section className="workflow-panel workflow-validation-card">
          <h3>Workflow Validation</h3>
          <div className="workflow-validation-list">
            <span className="workflow-validation-pill success">
              <Check size={15} aria-hidden />
              Manager assigned in {validationCounts.managerCount} of {validationCounts.total} departments
            </span>
            <span className="workflow-validation-pill success">
              <Check size={15} aria-hidden />
              EXCO owner assigned in {validationCounts.excoCount} of {validationCounts.total} departments
            </span>
            <span className="workflow-validation-pill warning">
              <AlertTriangle size={15} aria-hidden />
              HOD not assigned in {validationCounts.hodMissing} departments
            </span>
            <button className="button button-subtle small-button" type="button" onClick={() => void Swal.fire({ title: "Validation details", text: `Managers: ${validationCounts.managerCount}/${validationCounts.total}\nEXCO: ${validationCounts.excoCount}/${validationCounts.total}\nHOD missing: ${validationCounts.hodMissing}`, icon: "info", confirmButtonText: "OK" })}>
              View Details
            </button>
          </div>
        </section>

        <section className="workflow-panel workflow-rules-card">
          <div className="workflow-rules-header">
            <h3>Workflow Rules (Conditional Approvals)</h3>
            <button className="button button-subtle small-button" type="button" onClick={handleAddRule}>
              <Plus size={14} aria-hidden />
              {showRuleForm ? (editingRuleId ? "Save Rule" : "Save Rule") : "Add Rule"}
            </button>
          </div>

          {showRuleForm ? (
            <div className="workflow-rule-form">
              <input
                placeholder="Rule name"
                value={ruleDraft.ruleName || ""}
                onChange={(event) => setRuleDraft((current) => ({ ...current, ruleName: event.target.value }))}
              />
              <div className="workflow-rule-grid">
                <select value={ruleDraft.conditionField || "Amount"} onChange={(event) => setRuleDraft((current) => ({ ...current, conditionField: event.target.value }))}>
                  <option value="Amount">Amount</option>
                </select>
                <select value={ruleDraft.conditionOperator || ">"} onChange={(event) => setRuleDraft((current) => ({ ...current, conditionOperator: event.target.value }))}>
                  <option value=">">Greater than</option>
                  <option value="<">Less than</option>
                  <option value="=">Equal to</option>
                </select>
                <input
                  type="number"
                  placeholder="Value"
                  value={ruleDraft.conditionValue || ""}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, conditionValue: event.target.value }))}
                />
              </div>
              <div className="workflow-rule-form-footer">
                <select value={ruleDraft.additionalPositionTypeId || activePositionTypes[0]?.id || ""} onChange={(event) => setRuleDraft((current) => ({ ...current, additionalPositionTypeId: event.target.value }))}>
                  {activePositionTypes.map((position) => (
                    <option key={position.id} value={position.id}>
                      {position.name}
                    </option>
                  ))}
                </select>
                <button className="button button-subtle small-button" type="button" onClick={cancelRuleEdit}>
                  Cancel
                </button>
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
                    <td>{resolvePositionLabel(rule.additionalPositionTypeId)}</td>
                    <td>
                      <button className="icon-button has-icon workflow-table-action" type="button" aria-label={`Edit ${rule.ruleName}`} onClick={() => editRule(rule)}>
                        <Pencil size={15} aria-hidden />
                      </button>
                      <button className="icon-button has-icon workflow-table-action danger" type="button" aria-label={`Remove ${rule.ruleName}`} onClick={() => removeRule(rule.id)}>
                        <Trash2 size={15} aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
                {rules.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No conditional rules defined.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="workflow-panel workflow-summary-card">
          <h3>Workflow Summary</h3>
          <div className="summary-row">
            <span>Department</span>
            <strong>{workflowDepartment || "All Departments"}</strong>
          </div>
          <div className="summary-row">
            <span>Total Steps</span>
            <strong>{steps.length}</strong>
          </div>
          <div className="summary-row">
            <span>Required Steps</span>
            <strong>{steps.filter((step) => step.isRequired && !step.isSystemStep).length}</strong>
          </div>
          <div className="summary-row">
            <span>Optional Steps</span>
            <strong>{steps.filter((step) => !step.isRequired && !step.isSystemStep).length}</strong>
          </div>
          <div className="summary-row">
            <span>Final Approval</span>
            <strong>{steps.find((step) => step.isFinalApproval)?.positionName || "Not set"}</strong>
          </div>
        </aside>
      </div>
    </div>
  );
}
