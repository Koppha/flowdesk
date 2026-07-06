import { query } from "../db.js";
import { getUserGroups } from "../permissionGroups.js";
// Standalone, admin-managed grant list — not composed with canViewAdvance /
// canViewClaim / etc. The admin explicitly decides who can view or design
// PDFs for a request type; the one exception is that a user can always view
// their own document, so a missing/forgotten grant can't lock someone out of
// their own submitted request.
export async function canAccessPdf(args) {
    if (args.role === "ADMIN")
        return true;
    if (args.action === "view" && args.isOwner)
        return true;
    const rows = await query(`SELECT permission_type, group_name, user_id, can_view_pdf, can_design_pdf
       FROM pdf_permissions
      WHERE request_type = $1 AND (custom_request_type_id = $2 OR custom_request_type_id IS NULL)`, [args.requestType, args.customRequestTypeId ?? null]);
    if (rows.length === 0)
        return false;
    const col = args.action === "view" ? "can_view_pdf" : "can_design_pdf";
    if (rows.some((r) => r.permission_type === "ALL" && r[col]))
        return true;
    if (rows.some((r) => r.permission_type === "USER" && r.user_id === args.userId && r[col]))
        return true;
    const groupRows = rows.filter((r) => r.permission_type === "GROUP" && r[col]);
    if (groupRows.length === 0)
        return false;
    const groups = await getUserGroups(args.userId);
    return groupRows.some((r) => r.group_name && groups.includes(r.group_name));
}
