import type { TourStep } from "../shared/GuidedTour";

// Hover tips for side-menu links: what the page is for and how it works, in a
// few lines. Keyed by menu item id; custom processes (Change Request, ...) by
// their label, since their ids are per installation.

export type MenuTip = { title: string; text: string; points: string[] };

export const MENU_TIPS: Record<string, MenuTip> = {
  maintenance: {
    title: "Maintenance",
    text: "Report a fault at a store or office - a leak, broken aircon, power, doors - and follow it until it's fixed.",
    points: [
      "New request: pick the site, category and priority, and add photos",
      "The Admin Office assigns a worker or contractor, with a target date",
      "Spend above the limit goes for approval",
      "You confirm the fix, or it closes itself after a few working days"
    ]
  },
  mobile_app_config: {
    title: "Mobile App",
    text: "Set up the FlowDesk mobile app for everyone.",
    points: [
      "Home screen modules and the bottom tab bar",
      "Branding: app icon, logo and colour",
      "Push notifications, event by event",
      "Distribution and analytics: downloads, devices and versions in use"
    ]
  },
  brs: {
    title: "BRS Studio",
    text: "Write a Business Requirements Specification with your team, get it reviewed and approved, and baseline it.",
    points: [
      "Co-writers edit at the same time - you see who's on which section",
      "AI can draft or improve a section; insert charts and diagrams",
      "Departments add their input; reviewers comment",
      "Approved, it's baselined as a PDF and can start a Change Request"
    ]
  },
  signatures: {
    title: "Sign a Document",
    text: "Sign PDFs electronically - every signed copy gets a public verification code.",
    points: [
      "Quick Sign: upload a PDF, place your signature, download it",
      "Request Signature: several people sign in turn, each in their spot",
      "Add Text to PDF: fill in or correct a PDF before sending it"
    ]
  },
  salary_advances: {
    title: "Salary Advances",
    text: "Every salary advance and how it's being repaid.",
    points: [
      "Deductions start the month after the request, one installment a month",
      "One salary advance at a time per person, until it's repaid",
      "Review repayments employees made (with proof) - accept or reject",
      "Mark an advance paid in full; export with a column per month"
    ]
  },
  "label:change request": {
    title: "Change Request",
    text: "Ask the Change Advisory Board to approve a change to IT, network or business systems.",
    points: [
      "Describe it, with the implementation and back-out plans",
      "Save as a draft and write it with co-owners and co-writers",
      "Assignees confirm the plan, then the approvers sign it off",
      "Recall it for correction while it's in progress; close it after implementation"
    ]
  }
};

export function menuTipFor(id: string, label: string): MenuTip | null {
  return MENU_TIPS[id] ?? MENU_TIPS[`label:${label.trim().toLowerCase()}`] ?? null;
}

// ── Page tours ──────────────────────────────────────────────────────────────
export const TOURS: Record<string, { title: string; steps: TourStep[] }> = {
  maintenance: {
    title: "Maintenance",
    steps: [
      { title: "Maintenance", body: "Report faults at stores and offices and follow them until they're fixed. Here's where everything is." },
      { target: { text: "New request" }, title: "Log a fault", body: "Pick the site, the category and how urgent it is, describe it and add photos. The Admin Office reviews it before anyone is sent." },
      { target: { text: "My requests" }, title: "Follow your requests", body: "See where each request is: assigned, in progress, waiting for materials. You get an email and a notification at every step." },
      { target: { text: "My site" }, title: "Your site's requests", body: "Everything logged for the site you're based at, by anyone." },
      { target: { text: "My jobs" }, title: "Jobs assigned to you", body: "Accept the job, update progress, and complete it with photos of the fix." },
      { target: { text: "Admin Office" }, title: "The Admin Office queue", body: "Review new requests, assign a worker or contractor with a target date, approve spend and close jobs." },
      { target: { text: "Lists" }, title: "Sites, workers and targets", body: "Set up the sites, the workers and contractors, the categories, the response and fix targets per priority, and the spend limit." }
    ]
  },
  mobile_app: {
    title: "Mobile App",
    steps: [
      { title: "Mobile App Configuration", body: "Everything about the FlowDesk mobile app: what people see, how it looks and who uses it." },
      { target: { text: "Home screen modules" }, title: "Home screen modules", body: "Choose which modules show on the app's home screen." },
      { target: { text: "Bottom tab bar" }, title: "Bottom tab bar", body: "Choose the shortcuts in the tab bar at the bottom of the app." },
      { target: { text: "Branding" }, title: "Branding", body: "The app icon, logo and accent colour." },
      { target: { text: "Push notifications" }, title: "Push notifications", body: "Switch each kind of notification on or off for the app." },
      { target: { text: "Distribution" }, title: "Distribution", body: "The app to download and install, and who has downloaded it." },
      { target: { text: "Analytics" }, title: "Analytics", body: "Devices and app versions in use, recent logins and who's online." },
      { target: { text: "Save changes" }, title: "Save", body: "Changes reach the app once you save them." }
    ]
  },
  brs: {
    title: "BRS Studio",
    steps: [
      { title: "BRS Studio", body: "Business Requirements Specifications: drafted together, given department input, reviewed, approved and baselined." },
      { target: { text: "New BRS" }, title: "Start a BRS", body: "Give it a title, the target quarter and the business justification, and add co-owners and co-writers." },
      { target: { placeholder: "Search by BRS" }, title: "Find a BRS", body: "Search by title, BRS number or department." },
      { target: { text: "My BRS" }, title: "Yours and shared", body: "Your BRSs, sections assigned to you for input, and BRSs shared with you." },
      { target: { text: "How a BRS moves" }, title: "How a BRS moves", body: "Draft, department input, review, approval, then baseline - each stage explained here." }
    ]
  },
  brs_workspace: {
    title: "Writing a BRS",
    steps: [
      { title: "Writing a BRS", body: "Each section is written here. Several people can work at once - you'll see who's here and who's editing which section." },
      { target: 'button[title^="Write with AI"]', title: "Write with AI", body: "Let AI draft the section, or improve, expand, shorten or turn the selected text into requirements or a table. You decide whether to use it." },
      { target: 'button[title^="Insert a chart"]', title: "Charts", body: "Column, bar, line, area and pie charts - type the numbers or paste them from Excel. Double-click a chart later to change it." },
      { target: 'button[title^="Insert a diagram"]', title: "Diagrams", body: "Flowcharts and UML: drag shapes, connect them, label the arrows." },
      { target: { text: "+ Invite collaborators" }, title: "Bring people in", body: "Invite people or whole sections to write a section with you." },
      { target: { text: "Save" }, title: "Save often", body: "Save each section. If someone else saved it meanwhile, you choose which version to keep - nothing is overwritten silently." }
    ]
  },
  change_request: {
    title: "Change Request",
    steps: [
      { title: "Change Requests", body: "Ask the Change Advisory Board to approve a change - and follow it through to implementation." },
      { target: { text: "New Request" }, title: "Raise a change", body: "Fill in the form step by step: what's changing, why, the risk and impact, and the implementation and back-out plans. Long fields have \"Write with AI\"." },
      { target: { text: "Save as draft" }, title: "Write it together", body: "Save it as a draft and add co-owners and co-writers - you can all work on it at the same time." },
      { target: { text: "My Requests" }, title: "Your Change Requests", body: "Follow each one through approval. While it's in progress you can Recall for Correction, send a reminder, or cancel; once approved, close it with the implementation details." },
      { target: { text: "Assigned to Me" }, title: "Assigned to you", body: "Changes you're an assignee or implementer on: confirm the plan, or roll it back with a comment." },
      { target: { text: "Shared with Me" }, title: "Shared with you", body: "Change Requests distributed to you for information." }
    ]
  },
  signatures: {
    title: "Sign a Document",
    steps: [
      { title: "Sign a Document", body: "Sign PDFs electronically. Every signed copy carries a verification code anyone can check." },
      { target: { text: "Quick Sign" }, title: "Quick Sign", body: "Sign a PDF yourself: upload it, place your signature, and download the stamped copy." },
      { target: { text: "PDF file" }, title: "Choose the PDF", body: "Give it a title and pick the PDF from your computer." },
      { target: { text: "Your signature" }, title: "Your signature", body: "Draw it once and save it - it's loaded next time." },
      { target: { text: "Request Signature" }, title: "Several signers", body: "Send a document to several people to sign in turn, each placing their mark exactly where it belongs." },
      { target: { text: "Add Text to PDF" }, title: "Add text", body: "Type onto a PDF - fill in a form or fix a detail - before signing or sending it." }
    ]
  },
  salary_advances: {
    title: "Salary Advances",
    steps: [
      { title: "Salary Advances", body: "Every salary advance and its repayment. Deductions start the month after the request, one installment a month for the payback period." },
      { target: { placeholder: "Search name" }, title: "Find someone", body: "Search by name, employee number, division, department or reference." },
      { target: "#repayments-review", title: "Repayments to review", body: "Employees who paid back early upload proof here. Accept it and the remaining months shrink; reject it with a reason." },
      { target: { text: "Columns" }, title: "Choose your columns", body: "Show the columns you need; your choice is remembered." },
      { target: { text: "Export" }, title: "Export", body: "Download the list as a spreadsheet, with one column per deduction month." }
    ]
  }
};
