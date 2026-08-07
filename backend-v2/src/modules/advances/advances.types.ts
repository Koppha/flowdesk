export type AdvanceStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "COUNTERSIGNED"
  | "HR_OFFICER"
  | "APPROVED"
  | "PAID"
  | "REJECTED"
  | "CANCELLED";

export type AdvanceAction = "SUBMIT" | "APPROVE" | "MARK_PAID" | "REJECT" | "CANCEL" | "ROLLBACK";

export const AdvanceTransitions: Record<AdvanceStatus, Partial<Record<AdvanceAction, AdvanceStatus>>> = {
  DRAFT:               { SUBMIT: "SUBMITTED", CANCEL: "CANCELLED" },
  // SUBMITTED: Manager (Counter Signer) approves. Destination resolved dynamically in route.
  SUBMITTED:           { APPROVE: "COUNTERSIGNED", CANCEL: "CANCELLED", REJECT: "REJECTED", ROLLBACK: "DRAFT" },
  // COUNTERSIGNED: HOD/EXCO approves, then the request moves to HR/Finance processing.
  COUNTERSIGNED:       { APPROVE: "HR_OFFICER", REJECT: "REJECTED", ROLLBACK: "DRAFT" },
  HR_OFFICER:          { APPROVE: "APPROVED", MARK_PAID: "PAID", REJECT: "REJECTED" },
  APPROVED:            { MARK_PAID: "PAID", REJECT: "REJECTED" },
  PAID:                {},
  REJECTED:            {},
  CANCELLED:           {},
};
