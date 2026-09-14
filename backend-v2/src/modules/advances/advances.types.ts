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
  // CANCEL is allowed at every one of these pending stages, same as SUBMITTED -
  // the requester can cancel any time before Capture, not just at the very
  // first step. The /revoke route itself additionally checks the live chain
  // and refuses once a capture step has actually been approved, since that
  // can happen before the named status reaches APPROVED depending on the
  // workflow's step order.
  COUNTERSIGNED:       { APPROVE: "HR_OFFICER", CANCEL: "CANCELLED", REJECT: "REJECTED", ROLLBACK: "DRAFT" },
  HR_OFFICER:          { APPROVE: "APPROVED", MARK_PAID: "PAID", CANCEL: "CANCELLED", REJECT: "REJECTED" },
  APPROVED:            { MARK_PAID: "PAID", CANCEL: "CANCELLED", REJECT: "REJECTED" },
  PAID:                {},
  REJECTED:            {},
  CANCELLED:           {},
};
