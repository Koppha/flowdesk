import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { confirmAction, showNotice } from "./alerts";
import {
  AlertTriangle, Calendar, CheckCircle, Clock, Download,
  FileText, Plus, RefreshCw, Settings, Shield, Star, Trash2, TrendingUp, Users, X, XCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type SlaStatus = "on_time" | "breached" | "at_risk" | "pending";

type SlaRequest = {
  id: string; type: string; status: string;
  requester_name: string | null; department: string | null;
  requested_total: string; approved_total: string;
  created_at: string; submitted_at: string | null;
  approved_at: string | null; paid_at: string | null;
  submission_hours: number | null; approval_hours: number | null;
  payment_hours: number | null; total_hours: number | null;
  sla_status: SlaStatus;
};

type SlaReport = {
  sla_targets: { submission_hours: number; approval_hours: number; payment_hours: number };
  summary: { total: number; on_time: number; at_risk: number; breached: number; pending: number };
  avg_metrics: { avg_submission_hours: number | null; avg_approval_hours: number | null; avg_payment_hours: number | null };
  by_department: Record<string, { total: number; on_time: number; breached: number; at_risk: number }>;
  by_type: Record<string, { total: number; on_time: number; breached: number; avg_total_hours: number | null }>;
  requests: SlaRequest[];
};

type ClaimSlaStatus = "on_time" | "late" | "at_risk" | "pending" | "no_data";

type ByApprover = {
  approver_id: string; approver_name: string;
  on_time: number; late: number; at_risk: number; pending: number; no_data: number;
  avg_turnaround_hours: number | null;
};

type LateApproval = {
  claim_id: string; claimant_name: string | null; department: string | null;
  approver_name: string | null; position_name: string;
  hours_late: number | null; still_pending: boolean;
};

type SlaThreshold = { position_type_code: string; sla_days: number };

type ClaimsSlaReport = {
  thresholds: SlaThreshold[];
  summary: { on_time: number; late: number; at_risk: number; pending: number; no_data: number };
  by_approver: ByApprover[];
  late_approvals: LateApproval[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtHours(h: number | null | undefined): string {
  if (h == null) return "—";
  const days = h / 24;
  if (days >= 1) return `${days.toFixed(1)} Days`;
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${h.toFixed(1)}h`;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function typeLabel(t: string): string {
  if (t === "SALARY") return "Salary Advance";
  if (t === "LOAN") return "Loan";
  if (t === "TRAVEL") return "Travel / Per Diem";
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const DEPT_COLORS = ["#3b82f6","#10b981","#f59e0b","#8b5cf6","#ef4444","#06b6d4","#84cc16","#f97316"];

// ─── SVG Donut ────────────────────────────────────────────────────────────────

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = (deg - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function DonutChart({ segments, size = 130, thickness = 26 }: {
  segments: { label: string; value: number; color: string }[];
  size?: number; thickness?: number;
}) {
  const total = segments.reduce((s, d) => s + d.value, 0);
  const cx = size / 2, cy = size / 2, oR = size / 2 - 3, iR = oR - thickness;
  if (total === 0)
    return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}><circle cx={cx} cy={cy} r={(oR+iR)/2} fill="none" stroke="#e5e7eb" strokeWidth={thickness}/></svg>;
  let cum = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {segments.map((seg, i) => {
        if (seg.value <= 0) return null;
        const deg = (seg.value / total) * 360;
        const start = cum, end = cum + Math.min(deg, 359.99);
        cum += deg;
        if (deg >= 359.9) return <circle key={i} cx={cx} cy={cy} r={(oR+iR)/2} fill="none" stroke={seg.color} strokeWidth={thickness}/>;
        const large = deg > 180 ? 1 : 0;
        const s1 = polar(cx,cy,oR,start), e1 = polar(cx,cy,oR,end);
        const s2 = polar(cx,cy,iR,end),   e2 = polar(cx,cy,iR,start);
        return <path key={i} fill={seg.color} d={`M${s1.x.toFixed(2)} ${s1.y.toFixed(2)} A${oR} ${oR} 0 ${large} 1 ${e1.x.toFixed(2)} ${e1.y.toFixed(2)} L${s2.x.toFixed(2)} ${s2.y.toFixed(2)} A${iR} ${iR} 0 ${large} 0 ${e2.x.toFixed(2)} ${e2.y.toFixed(2)}Z`}/>;
      })}
    </svg>
  );
}

// ─── SVG Line Chart ───────────────────────────────────────────────────────────

function LineChart({ data }: { data: { label: string; value: number }[] }) {
  if (data.length < 2)
    return <div style={{ height: 180, display:"flex", alignItems:"center", justifyContent:"center", color:"#94a3b8", fontSize:13 }}>Not enough monthly data yet</div>;
  const W=500,H=210,pL=34,pR=12,pT=26,pB=32;
  const plotW=W-pL-pR, plotH=H-pT-pB;
  const vals=data.map(d=>d.value);
  const minV=Math.max(0,Math.min(...vals)-6), maxV=100, rng=maxV-minV||1;
  const px=(i:number)=>pL+(i/(data.length-1))*plotW;
  const py=(v:number)=>pT+plotH-((v-minV)/rng)*plotH;
  const line=data.map((d,i)=>`${i===0?"M":"L"}${px(i).toFixed(1)},${py(d.value).toFixed(1)}`).join(" ");
  const area=`${line} L${px(data.length-1).toFixed(1)},${(pT+plotH).toFixed(1)} L${pL.toFixed(1)},${(pT+plotH).toFixed(1)}Z`;
  const yticks=[0,25,50,75,100].filter(v=>v>=minV-5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:"auto", display:"block" }}>
      <defs>
        <linearGradient id="slaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.22"/>
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0"/>
        </linearGradient>
      </defs>
      {yticks.map(v=>(
        <g key={v}>
          <line x1={pL} x2={W-pR} y1={py(v)} y2={py(v)} stroke="#f0f4f8" strokeWidth={1}/>
          <text x={pL-4} y={py(v)+4} textAnchor="end" fontSize={10} fill="#94a3b8">{v}%</text>
        </g>
      ))}
      <path d={area} fill="url(#slaGrad)"/>
      <path d={line} fill="none" stroke="#3b82f6" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round"/>
      {data.map((d,i)=>(
        <g key={i}>
          <circle cx={px(i)} cy={py(d.value)} r={4.5} fill="#3b82f6" stroke="white" strokeWidth={2}/>
          <text x={px(i)} y={py(d.value)-10} textAnchor="middle" fontSize={10} fontWeight="700" fill="#1d4ed8">{d.value}%</text>
          <text x={px(i)} y={H-5} textAnchor="middle" fontSize={11} fill="#6b7280">{d.label}</text>
        </g>
      ))}
    </svg>
  );
}

// ─── Small reusables ──────────────────────────────────────────────────────────

function CompBar({ pct }: { pct: number }) {
  const color = pct>=90?"#10b981":pct>=70?"#f59e0b":"#ef4444";
  return (
    <div style={{ display:"flex", alignItems:"center", gap:7 }}>
      <div style={{ flex:1, height:7, background:"#f1f5f9", borderRadius:99, overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${pct}%`, background:color, borderRadius:99 }}/>
      </div>
      <span style={{ minWidth:38, fontWeight:700, color, fontSize:13 }}>{pct}%</span>
    </div>
  );
}

function SlaBadge({ status }: { status: SlaStatus }) {
  const m: Record<SlaStatus,[string,string,string]> = {
    on_time:  ["On Time",     "#d1fae5","#065f46"],
    breached: ["Breached",    "#fee2e2","#dc2626"],
    at_risk:  ["Near Breach", "#fef3c7","#92400e"],
    pending:  ["Pending",     "#f1f5f9","#64748b"],
  };
  const [label,bg,color]=m[status];
  return <span style={{ padding:"3px 10px", borderRadius:99, fontSize:12, fontWeight:700, background:bg, color, whiteSpace:"nowrap" }}>{label}</span>;
}

function ClaimSlaBadge({ status }: { status: ClaimSlaStatus }) {
  const m: Record<ClaimSlaStatus,[string,string,string]> = {
    on_time:  ["On Time",   "#d1fae5","#065f46"],
    late:     ["Late",      "#fee2e2","#dc2626"],
    at_risk:  ["Near Due",  "#fef3c7","#92400e"],
    pending:  ["Pending",   "#e0f2fe","#075985"],
    no_data:  ["No Data",   "#f1f5f9","#64748b"],
  };
  const [label,bg,color]=m[status];
  return <span style={{ padding:"3px 10px", borderRadius:99, fontSize:12, fontWeight:700, background:bg, color, whiteSpace:"nowrap" }}>{label}</span>;
}

// ─── Data builders ────────────────────────────────────────────────────────────

function buildTrend(requests: SlaRequest[]) {
  const map: Record<string,{t:number;ok:number}> = {};
  for (const r of requests) {
    if (!r.created_at) continue;
    const d = new Date(r.created_at);
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    if (!map[k]) map[k]={t:0,ok:0};
    map[k].t++;
    if (r.sla_status==="on_time") map[k].ok++;
  }
  return Object.entries(map).sort(([a],[b])=>a.localeCompare(b)).slice(-6).map(([k,{t,ok}])=>({
    label: new Date(k+"-15").toLocaleDateString("en-GB",{month:"short"}),
    value: t>0?Math.round((ok/t)*100):0,
  }));
}

function buildSteps(report: SlaReport) {
  const {sla_targets:t, avg_metrics:m, requests} = report;
  const comp = (get:(r:SlaRequest)=>number|null, target:number) => {
    const w=requests.filter(r=>get(r)!=null);
    return w.length?Math.round((w.filter(r=>get(r)!<=target).length/w.length)*100):null;
  };
  return [
    {name:"Submission",         target:`${(t.submission_hours/24).toFixed(0)} Days`, avg:m.avg_submission_hours, targetH:t.submission_hours, compliance:comp(r=>r.submission_hours,t.submission_hours)},
    {name:"Finance Approval",   target:`${(t.approval_hours/24).toFixed(0)} Days`,   avg:m.avg_approval_hours,   targetH:t.approval_hours,   compliance:comp(r=>r.approval_hours,  t.approval_hours)},
    {name:"Payment Processing", target:`${(t.payment_hours/24).toFixed(0)} Days`,    avg:m.avg_payment_hours,    targetH:t.payment_hours,    compliance:comp(r=>r.payment_hours,   t.payment_hours)},
  ];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PERIODS = [
  {label:"Last 30 days",days:30},{label:"Last 90 days",days:90},
  {label:"Last 6 months",days:180},{label:"Last year",days:365},{label:"All time",days:3650},
];

const C: React.CSSProperties = {
  background:"white", borderRadius:12, boxShadow:"0 1px 4px rgba(0,0,0,0.06)",
  border:"1px solid #e8edf2", padding:20,
};
const TH: React.CSSProperties = { textAlign:"left", color:"#94a3b8", fontWeight:600, fontSize:11, padding:"8px 10px", whiteSpace:"nowrap" };
const TD: React.CSSProperties = { padding:"9px 10px", borderBottom:"1px solid #f8fafc", fontSize:13 };

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SlaReports({ onBack, canViewClaimsSla = false }: { onBack: () => void; canViewClaimsSla?: boolean }) {
  const [reportKind, setReportKind] = useState<"advances" | "clearance">("advances");
  const [report,   setReport]   = useState<SlaReport|null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string|null>(null);
  const [periodDays, setPeriodDays] = useState(90);
  const [filterDept, setFilterDept] = useState("");
  const [showAll,  setShowAll]  = useState(false);

  const [claimsReport, setClaimsReport] = useState<ClaimsSlaReport|null>(null);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [claimsError, setClaimsError] = useState<string|null>(null);
  const [showThresholdsModal, setShowThresholdsModal] = useState(false);
  const [thresholdRows, setThresholdRows] = useState<SlaThreshold[]>([]);
  const [savingThresholds, setSavingThresholds] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setReport(await api.slaReport(periodDays) as SlaReport); }
    catch (e:any) { setError(e.message||"Failed to load SLA report"); }
    finally { setLoading(false); }
  }, [periodDays]);

  const loadClaims = useCallback(async () => {
    setClaimsLoading(true); setClaimsError(null);
    try { setClaimsReport(await api.claimsSlaReport(periodDays) as ClaimsSlaReport); }
    catch (e:any) { setClaimsError(e.message||"Failed to load clearance SLA report"); }
    finally { setClaimsLoading(false); }
  }, [periodDays]);

  useEffect(()=>{ void load(); },[load]);
  useEffect(()=>{ if (reportKind === "clearance" && canViewClaimsSla) void loadClaims(); },[reportKind, canViewClaimsSla, loadClaims]);

  async function openThresholdsModal() {
    try {
      const rows = await api.claimsSlaThresholds() as SlaThreshold[];
      setThresholdRows(rows.length ? rows : [{ position_type_code: "*", sla_days: 3 }]);
      setShowThresholdsModal(true);
    } catch (e:any) {
      void showNotice(e?.message || "Failed to load SLA thresholds.");
    }
  }

  async function saveThresholds() {
    setSavingThresholds(true);
    try {
      await api.updateClaimsSlaThresholds(thresholdRows);
      setShowThresholdsModal(false);
      await loadClaims();
    } catch (e:any) {
      void showNotice(e?.message || "Failed to save SLA thresholds.");
    } finally {
      setSavingThresholds(false);
    }
  }

  async function removeThresholdRow(index: number) {
    if (thresholdRows[index]?.position_type_code === "*") {
      void showNotice("The default (*) threshold can't be removed — edit its days instead.");
      return;
    }
    const ok = await confirmAction({ title: "Remove this threshold row?", confirmButtonText: "Remove" });
    if (!ok) return;
    setThresholdRows((rows) => rows.filter((_, i) => i !== index));
  }

  const compliance = useMemo(()=>
    report?.summary.total?Math.round((report.summary.on_time/report.summary.total)*100):null,[report]);

  const avgDays = useMemo(()=>{
    if (!report) return null;
    const {avg_submission_hours:a,avg_approval_hours:b,avg_payment_hours:c}=report.avg_metrics;
    const tot=(a||0)+(b||0)+(c||0);
    return tot>0?(tot/24).toFixed(1):null;
  },[report]);

  const trend  = useMemo(()=>buildTrend(report?.requests||[]),[report]);
  const steps  = useMemo(()=>report?buildSteps(report):[],[report]);

  const deptSegs = useMemo(()=>
    Object.entries(report?.by_department||{}).sort(([,a],[,b])=>b.total-a.total).slice(0,8)
      .map(([name,d],i)=>({label:name,value:d.total,color:DEPT_COLORS[i%DEPT_COLORS.length]})),[report]);

  const deptRows = useMemo(()=>
    Object.entries(report?.by_department||{}).sort(([,a],[,b])=>b.total-a.total)
      .map(([name,d],i)=>({
        name, total:d.total, onTime:d.on_time, breached:d.breached,
        compliance:d.total>0?Math.round((d.on_time/d.total)*100):0,
        breachPct: d.total>0?Math.round((d.breached/d.total)*100):0,
        color:DEPT_COLORS[i%DEPT_COLORS.length],
      })),[report]);

  const breached = useMemo(()=>
    (report?.requests||[]).filter(r=>r.sla_status==="breached"||r.sla_status==="at_risk")
      .sort((a,b)=>(b.total_hours||0)-(a.total_hours||0)),[report]);

  const topDept   = useMemo(()=>deptRows.filter(d=>d.total>=3).sort((a,b)=>b.compliance-a.compliance)[0],[deptRows]);
  const worstDept = useMemo(()=>deptRows.filter(d=>d.total>=3).sort((a,b)=>a.compliance-b.compliance)[0],[deptRows]);
  const worstStep = useMemo(()=>steps.filter(s=>s.avg!=null).sort((a,b)=>(b.avg!/b.targetH)-(a.avg!/a.targetH))[0]??null,[steps]);

  const periodLabel = useMemo(()=>{
    const now=new Date(), from=new Date(now.getTime()-periodDays*86400000);
    const f=(d:Date)=>d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});
    return `${f(from)} – ${f(now)}`;
  },[periodDays]);

  function exportCsv(){
    if (!report) return;
    const h=["Name","Type","Status","SLA","Department","Created","Submit Hrs","Approval Hrs","Payment Hrs","Total Hrs"];
    const rows=report.requests.map(r=>[r.requester_name??"",typeLabel(r.type),r.status,r.sla_status,r.department??"",fmtDate(r.created_at),r.submission_hours??"",r.approval_hours??"",r.payment_hours??"",r.total_hours??""]);
    const csv=[h,...rows].map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download=`sla-report-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  }

  if (loading&&!report)
    return <div style={{padding:24}}><div style={{...C,textAlign:"center",padding:60,color:"#94a3b8"}}>Loading SLA report…</div></div>;

  return (
    <div style={{ padding:24, background:"#f8fafc", minHeight:"100vh" }}>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:20, flexWrap:"wrap", gap:12 }}>
        <div>
          <div style={{ fontSize:13, color:"#94a3b8", marginBottom:4 }}>
            <span style={{ cursor:"pointer", color:"#3b82f6", fontWeight:600 }} onClick={onBack}>Reports</span>
            {" › "}
            <span style={{ color:"#1e293b" }}>SLA Reports</span>
          </div>
          <h1 style={{ margin:0, fontSize:22, fontWeight:800, color:"#0f172a" }}>SLA Reports</h1>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          {canViewClaimsSla && (
            <div style={{ display:"flex", background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:8, padding:3, gap:2 }}>
              {([["advances","Advances"],["clearance","Clearance Approvals"]] as const).map(([k,label])=>(
                <button key={k} onClick={()=>setReportKind(k)}
                  style={{
                    border:"none", borderRadius:6, padding:"6px 12px", fontSize:13, fontWeight:700, cursor:"pointer",
                    background: reportKind===k ? "#1d4ed8" : "transparent",
                    color: reportKind===k ? "white" : "#374151",
                  }}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div style={{ display:"flex", alignItems:"center", gap:7, background:"white", border:"1px solid #e2e8f0", borderRadius:8, padding:"7px 12px", fontSize:13, color:"#374151" }}>
            <Calendar size={13} style={{ color:"#3b82f6" }}/>{periodLabel}
          </div>
          <select value={periodDays} onChange={e=>setPeriodDays(Number(e.target.value))}
            style={{ background:"white", border:"1px solid #e2e8f0", borderRadius:8, padding:"7px 12px", fontSize:13, color:"#374151", cursor:"pointer" }}>
            {PERIODS.map(o=><option key={o.days} value={o.days}>{o.label}</option>)}
          </select>
          <select value={filterDept} onChange={e=>setFilterDept(e.target.value)}
            style={{ background:"white", border:"1px solid #e2e8f0", borderRadius:8, padding:"7px 12px", fontSize:13, color:"#374151", cursor:"pointer", minWidth:130 }}>
            <option value="">All Departments</option>
            {Object.keys(report?.by_department||{}).sort().map(d=><option key={d} value={d}>{d}</option>)}
          </select>
          <button onClick={()=>void load()} disabled={loading}
            style={{ background:"white", border:"1px solid #e2e8f0", borderRadius:8, padding:"7px 10px", cursor:"pointer", display:"flex", alignItems:"center" }}>
            <RefreshCw size={14} style={{ color:"#64748b" }}/>
          </button>
          <button onClick={()=>void load()}
            style={{ background:"#1d4ed8", color:"white", border:"none", borderRadius:8, padding:"8px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>
            Apply Filter
          </button>
        </div>
      </div>

      {reportKind==="advances" && error&&<div style={{ padding:"10px 16px", background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, color:"#dc2626", marginBottom:16, fontSize:13 }}>{error}</div>}

      {reportKind==="advances" && report&&(
        <>
          {/* KPI row */}
          <div className="inbox-metrics" style={{ marginBottom:18 }}>
            {[
              { icon:<FileText size={22}/>, metric:"metric-blue",
                title:"Total Requests", val:String(report.summary.total), badge:"",
                sub:`${report.summary.pending} pending`, trend:false },
              { icon:<CheckCircle size={22}/>, metric:"metric-green",
                title:"Within SLA", val:String(report.summary.on_time),
                badge:compliance!=null?`(${compliance}%)`:"",
                sub:"On-time compliance", trend:true },
              { icon:<AlertTriangle size={22}/>, metric:"metric-rose",
                title:"Breached SLA", val:String(report.summary.breached),
                badge:report.summary.total>0?`(${Math.round((report.summary.breached/report.summary.total)*100)}%)`:"",
                sub:`${report.summary.at_risk} at risk`, trend:false },
              { icon:<Clock size={22}/>, metric:"metric-gold",
                title:"Avg Resolution Time", val:avgDays!=null?`${avgDays} Days`:"—", badge:"",
                sub:"End-to-end processing", trend:false },
            ].map(({icon,metric,title,val,badge,sub,trend})=>(
              <div key={title} className={`inbox-metric-card ${metric}`}>
                <span className="inbox-metric-icon">{icon}</span>
                <div className="inbox-metric-body">
                  <strong>{val}{badge&&<span style={{fontSize:14,fontWeight:600,marginLeft:5}}>{badge}</span>}</strong>
                  <span>{title}</span>
                  <small style={{display:"flex",alignItems:"center",gap:3}}>{trend&&<TrendingUp size={11}/>}{sub}</small>
                </div>
              </div>
            ))}
          </div>

          {/* Charts row */}
          <div style={{ display:"grid", gridTemplateColumns:"2fr 1.1fr 1.2fr", gap:14, marginBottom:18 }}>

            {/* Compliance trend */}
            <div style={C}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                <span style={{ fontWeight:700,fontSize:14,color:"#0f172a" }}>SLA Compliance Trend</span>
                <span style={{ fontSize:12,padding:"3px 10px",borderRadius:6,background:"#f1f5f9",color:"#64748b",border:"1px solid #e2e8f0" }}>Monthly</span>
              </div>
              <LineChart data={trend}/>
              <div style={{ marginTop:8,display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#64748b" }}>
                <span style={{ width:22,height:3,background:"#3b82f6",display:"inline-block",borderRadius:2,verticalAlign:"middle" }}/>
                SLA Compliance %
              </div>
            </div>

            {/* Workflow step SLA */}
            <div style={C}>
              <div style={{ fontWeight:700,fontSize:14,color:"#0f172a",marginBottom:14 }}>SLA by Workflow Step</div>
              <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid #f1f5f9" }}>
                    <th style={{...TH,paddingLeft:0}}>Workflow Step</th>
                    <th style={{...TH,textAlign:"right"}}>Target</th>
                    <th style={{...TH,textAlign:"right"}}>Avg</th>
                    <th style={TH}>Compliance</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((s,i)=>(
                    <tr key={i} style={{ borderBottom:"1px solid #f8fafc" }}>
                      <td style={{...TD,paddingLeft:0}}>
                        <div style={{ display:"flex",alignItems:"center",gap:7 }}>
                          <span style={{ width:26,height:26,borderRadius:7,background:"#f1f5f9",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                            <FileText size={12} style={{color:"#3b82f6"}}/>
                          </span>
                          <span style={{ fontWeight:500,color:"#374151" }}>{s.name}</span>
                        </div>
                      </td>
                      <td style={{...TD,textAlign:"right",color:"#64748b"}}>{s.target}</td>
                      <td style={{...TD,textAlign:"right",fontWeight:600,color:s.avg!=null&&s.avg>s.targetH?"#ef4444":"#374151"}}>
                        {fmtHours(s.avg)}
                      </td>
                      <td style={TD}>
                        {s.compliance!=null?(
                          <div style={{ display:"flex",alignItems:"center",gap:5 }}>
                            <div style={{ width:52,height:6,background:"#f1f5f9",borderRadius:99,overflow:"hidden" }}>
                              <div style={{ height:"100%",width:`${s.compliance}%`,background:s.compliance>=90?"#10b981":s.compliance>=70?"#f59e0b":"#ef4444",borderRadius:99 }}/>
                            </div>
                            <span style={{ fontWeight:700,fontSize:12,color:s.compliance>=90?"#059669":s.compliance>=70?"#d97706":"#dc2626" }}>{s.compliance}%</span>
                          </div>
                        ):<span style={{color:"#94a3b8"}}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Dept donut */}
            <div style={C}>
              <div style={{ fontWeight:700,fontSize:14,color:"#0f172a",marginBottom:14 }}>SLA by Department</div>
              <div style={{ display:"flex",gap:12,alignItems:"center" }}>
                <div style={{ flexShrink:0 }}>
                  <DonutChart segments={deptSegs} size={120} thickness={24}/>
                </div>
                <div style={{ flex:1,overflow:"hidden" }}>
                  {deptRows.slice(0,6).map(d=>(
                    <div key={d.name} style={{ display:"flex",alignItems:"center",gap:6,marginBottom:7 }}>
                      <span style={{ width:8,height:8,borderRadius:"50%",background:d.color,flexShrink:0 }}/>
                      <span style={{ flex:1,fontSize:11,color:"#374151",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{d.name}</span>
                      <span style={{ fontSize:11,color:"#94a3b8" }}>{d.total}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ marginTop:12,borderTop:"1px solid #f1f5f9",paddingTop:10 }}>
                <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
                  <thead><tr>
                    <th style={{...TH,paddingLeft:0,paddingBottom:6}}>Department</th>
                    <th style={{...TH,textAlign:"right",paddingBottom:6}}>Reqs</th>
                    <th style={{...TH,textAlign:"right",paddingBottom:6,color:"#059669"}}>Within SLA</th>
                    <th style={{...TH,textAlign:"right",paddingBottom:6,color:"#dc2626"}}>Breached</th>
                  </tr></thead>
                  <tbody>
                    {deptRows.slice(0,5).map(d=>(
                      <tr key={d.name}>
                        <td style={{...TD,paddingLeft:0,fontWeight:600,color:"#374151",maxWidth:90,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</td>
                        <td style={{...TD,textAlign:"right",color:"#64748b"}}>{d.total}</td>
                        <td style={{...TD,textAlign:"right",fontWeight:700,color:"#059669"}}>{d.compliance}%</td>
                        <td style={{...TD,textAlign:"right",fontWeight:d.breached>0?700:400,color:d.breached>0?"#dc2626":"#94a3b8"}}>{d.breachPct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {deptRows.length>5&&<div style={{textAlign:"center",marginTop:6}}><span style={{fontSize:12,color:"#3b82f6",cursor:"pointer",fontWeight:600}}>View Full Report</span></div>}
              </div>
            </div>
          </div>

          {/* Breached + Dept perf */}
          <div style={{ display:"grid", gridTemplateColumns:"1.5fr 1fr", gap:14, marginBottom:18 }}>

            <div style={C}>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:14 }}>
                <span style={{ fontWeight:700,fontSize:14,color:"#0f172a" }}>Breached Requests</span>
                {breached.length>0&&<span style={{ background:"#dc2626",color:"white",borderRadius:99,fontSize:11,fontWeight:700,padding:"2px 7px" }}>{breached.length}</span>}
              </div>
              {breached.length===0?(
                <div style={{ textAlign:"center",padding:"28px 0",color:"#94a3b8",fontSize:13 }}>
                  <CheckCircle size={28} style={{ color:"#10b981",display:"block",margin:"0 auto 6px" }}/>
                  No breached or at-risk requests
                </div>
              ):(
                <>
                  <div style={{ overflowX:"auto" }}>
                    <table style={{ width:"100%",borderCollapse:"collapse",fontSize:13 }}>
                      <thead style={{ background:"#f8fafc" }}>
                        <tr>{["Employee","Department","Current Stage","SLA Due","Days Over","Status"].map(h=><th key={h} style={TH}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {(showAll?breached:breached.slice(0,5)).map(r=>{
                          const totalT=report.sla_targets.submission_hours+report.sla_targets.approval_hours+report.sla_targets.payment_hours;
                          const over=r.total_hours!=null&&r.total_hours>totalT?Math.ceil((r.total_hours-totalT)/24):null;
                          const stage=r.status==="SUBMITTED"?"Finance Approval":r.status==="APPROVED"?"Payment Processing":r.status==="PENDING_APPROVAL"?"Manager Approval":r.status;
                          const dueDate=new Date(new Date(r.created_at).getTime()+totalT*3_600_000).toISOString();
                          return (
                            <tr key={r.id}>
                              <td style={{...TD,fontWeight:600,color:"#374151"}}>{r.requester_name||"—"}</td>
                              <td style={{...TD,color:"#64748b"}}>{r.department||"—"}</td>
                              <td style={{...TD,color:"#64748b"}}>{stage}</td>
                              <td style={{...TD,color:"#64748b",whiteSpace:"nowrap"}}>{fmtDate(dueDate)}</td>
                              <td style={{...TD,textAlign:"center"}}>{over!=null&&over>0?<span style={{fontWeight:700,color:"#dc2626"}}>{over}</span>:<span style={{color:"#94a3b8"}}>—</span>}</td>
                              <td style={TD}><SlaBadge status={r.sla_status}/></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {breached.length>5&&<div style={{textAlign:"center",marginTop:10}}>
                    <button onClick={()=>setShowAll(v=>!v)} style={{background:"none",border:"none",color:"#3b82f6",fontWeight:600,fontSize:13,cursor:"pointer"}}>
                      {showAll?"Show Less":`View All ${breached.length} Breached Requests`}
                    </button>
                  </div>}
                </>
              )}
            </div>

            <div style={C}>
              <div style={{ fontWeight:700,fontSize:14,color:"#0f172a",marginBottom:14 }}>Department Performance</div>
              {deptRows.length===0?(
                <div style={{textAlign:"center",padding:"28px 0",color:"#94a3b8",fontSize:13}}>No department data</div>
              ):(
                <table style={{ width:"100%",borderCollapse:"collapse",fontSize:13 }}>
                  <thead style={{background:"#f8fafc"}}>
                    <tr>{["Department","Requests","Avg Time","Compliance"].map(h=><th key={h} style={TH}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {deptRows.map(d=>(
                      <tr key={d.name}>
                        <td style={{...TD,fontWeight:600,color:"#374151",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</td>
                        <td style={{...TD,color:"#64748b"}}>{d.total}</td>
                        <td style={{...TD,color:"#94a3b8",fontSize:12}}>—</td>
                        <td style={{...TD,minWidth:120}}><CompBar pct={d.compliance}/></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Executive summary + config + export */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 220px 210px", gap:14, alignItems:"start" }}>

            <div style={C}>
              <div style={{ fontWeight:700,fontSize:14,color:"#0f172a",marginBottom:14 }}>Executive Summary</div>
              <div style={{ display:"flex",gap:12,flexWrap:"wrap" }}>
                {[
                  {icon:<Shield size={18} style={{color:"#3b82f6"}}/>, bg:"#eff6ff", label:"SLA Compliance Rate",  val:compliance!=null?`${compliance}%`:"—"},
                  {icon:<Clock  size={18} style={{color:"#059669"}}/>, bg:"#d1fae5", label:"Average Approval Time", val:avgDays!=null?`${avgDays} Days`:"—"},
                  {icon:<Star   size={18} style={{color:"#7c3aed"}}/>, bg:"#ede9fe", label:"Top Performing Dept",   val:topDept?`${topDept.name.split(/[\s,/]/)[0]} (${topDept.compliance}%)`:"—"},
                  {icon:<AlertTriangle size={18} style={{color:"#f59e0b"}}/>, bg:"#fef3c7", label:"Highest Breaches", val:worstDept?`${worstDept.name.split(/[\s,/]/)[0]} (${worstDept.breachPct}%)`:"—"},
                  {icon:<XCircle size={18} style={{color:"#dc2626"}}/>, bg:"#fee2e2", label:"Most Delayed Stage",   val:worstStep?worstStep.name:"—"},
                ].map(({icon,bg,label,val})=>(
                  <div key={label} style={{ display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:bg,borderRadius:10,flex:"1 1 150px" }}>
                    <span style={{ width:36,height:36,borderRadius:"50%",background:"white",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>{icon}</span>
                    <div>
                      <div style={{ fontSize:11,color:"#64748b",fontWeight:500 }}>{label}</div>
                      <div style={{ fontSize:14,fontWeight:800,color:"#0f172a" }}>{val}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={C}>
              <div style={{ fontWeight:700,fontSize:14,color:"#0f172a",marginBottom:6 }}>SLA Configuration</div>
              <div style={{ fontSize:12,color:"#94a3b8",marginBottom:12 }}>Manage SLA targets for workflow steps and escalation rules.</div>
              <div style={{ display:"grid",gap:5,marginBottom:12 }}>
                {steps.map(s=>(
                  <div key={s.name} style={{ fontSize:12,display:"flex",justifyContent:"space-between",gap:8 }}>
                    <span style={{color:"#64748b"}}>{s.name}</span>
                    <span style={{fontWeight:700,color:"#374151"}}>{s.target}</span>
                  </div>
                ))}
              </div>
              <button style={{ width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:7,background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 0",fontSize:13,color:"#374151",fontWeight:600,cursor:"pointer" }}>
                <Settings size={13}/> Manage SLA Settings
              </button>
            </div>

            <div style={C}>
              <div style={{ fontWeight:700,fontSize:14,color:"#0f172a",marginBottom:6 }}>Export Report</div>
              <div style={{ fontSize:12,color:"#94a3b8",marginBottom:12 }}>Download SLA reports in your preferred format.</div>
              <div style={{ display:"grid",gap:8 }}>
                <button onClick={exportCsv}
                  style={{ display:"flex",alignItems:"center",gap:8,background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"9px 14px",fontSize:13,color:"#15803d",fontWeight:600,cursor:"pointer" }}>
                  <Download size={15} style={{color:"#16a34a"}}/> Export Excel
                </button>
                <button onClick={()=>window.print()}
                  style={{ display:"flex",alignItems:"center",gap:8,background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,padding:"9px 14px",fontSize:13,color:"#dc2626",fontWeight:600,cursor:"pointer" }}>
                  <Download size={15} style={{color:"#dc2626"}}/> Export PDF
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {reportKind==="clearance" && canViewClaimsSla && (
        <>
          {claimsError&&<div style={{ padding:"10px 16px", background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, color:"#dc2626", marginBottom:16, fontSize:13 }}>{claimsError}</div>}

          {claimsLoading&&!claimsReport?(
            <div style={{...C,textAlign:"center",padding:60,color:"#94a3b8"}}>Loading clearance SLA report…</div>
          ):claimsReport&&(
            <>
              {/* KPI row */}
              <div className="inbox-metrics" style={{ marginBottom:18 }}>
                {[
                  { icon:<CheckCircle size={22}/>, metric:"metric-green", title:"On Time", val:String(claimsReport.summary.on_time) },
                  { icon:<AlertTriangle size={22}/>, metric:"metric-rose", title:"Late", val:String(claimsReport.summary.late) },
                  { icon:<Clock size={22}/>, metric:"metric-gold", title:"Near Due", val:String(claimsReport.summary.at_risk) },
                  { icon:<Users size={22}/>, metric:"metric-blue", title:"Pending", val:String(claimsReport.summary.pending) },
                ].map(({icon,metric,title,val})=>(
                  <div key={title} className={`inbox-metric-card ${metric}`}>
                    <span className="inbox-metric-icon">{icon}</span>
                    <div className="inbox-metric-body"><strong>{val}</strong><span>{title}</span></div>
                  </div>
                ))}
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:14, marginBottom:18 }}>
                <div style={C}>
                  <div style={{ fontWeight:700,fontSize:14,color:"#0f172a",marginBottom:14 }}>SLA by Approver</div>
                  {claimsReport.by_approver.length===0?(
                    <div style={{textAlign:"center",padding:"28px 0",color:"#94a3b8",fontSize:13}}>No approver activity in this period</div>
                  ):(
                    <div style={{ overflowX:"auto" }}>
                      <table style={{ width:"100%",borderCollapse:"collapse",fontSize:13 }}>
                        <thead style={{background:"#f8fafc"}}>
                          <tr>{["Approver","On Time","Late","Near Due","Pending","No Data","Avg Turnaround"].map(h=><th key={h} style={TH}>{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {claimsReport.by_approver.map(a=>(
                            <tr key={a.approver_id}>
                              <td style={{...TD,fontWeight:600,color:"#374151"}}>{a.approver_name}</td>
                              <td style={{...TD,color:"#059669",fontWeight:700}}>{a.on_time}</td>
                              <td style={{...TD,color:a.late>0?"#dc2626":"#94a3b8",fontWeight:a.late>0?700:400}}>{a.late}</td>
                              <td style={{...TD,color:"#92400e"}}>{a.at_risk}</td>
                              <td style={{...TD,color:"#64748b"}}>{a.pending}</td>
                              <td style={{...TD,color:"#94a3b8"}}>{a.no_data}</td>
                              <td style={{...TD,color:"#64748b"}}>{fmtHours(a.avg_turnaround_hours)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div style={C}>
                  <div style={{ fontWeight:700,fontSize:14,color:"#0f172a",marginBottom:6 }}>SLA Thresholds</div>
                  <div style={{ fontSize:12,color:"#94a3b8",marginBottom:12 }}>Day-thresholds per workflow position/step type. "*" is the default for any type with no explicit row.</div>
                  <div style={{ display:"grid",gap:5,marginBottom:12 }}>
                    {claimsReport.thresholds.map(t=>(
                      <div key={t.position_type_code} style={{ fontSize:12,display:"flex",justifyContent:"space-between",gap:8 }}>
                        <span style={{color:"#64748b"}}>{t.position_type_code}</span>
                        <span style={{fontWeight:700,color:"#374151"}}>{t.sla_days} day{t.sla_days===1?"":"s"}</span>
                      </div>
                    ))}
                  </div>
                  <button onClick={()=>void openThresholdsModal()}
                    style={{ width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:7,background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 0",fontSize:13,color:"#374151",fontWeight:600,cursor:"pointer" }}>
                    <Settings size={13}/> Manage SLA Thresholds
                  </button>
                </div>
              </div>

              <div style={C}>
                <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:14 }}>
                  <span style={{ fontWeight:700,fontSize:14,color:"#0f172a" }}>Late Approvals</span>
                  {claimsReport.late_approvals.length>0&&<span style={{ background:"#dc2626",color:"white",borderRadius:99,fontSize:11,fontWeight:700,padding:"2px 7px" }}>{claimsReport.late_approvals.length}</span>}
                </div>
                {claimsReport.late_approvals.length===0?(
                  <div style={{ textAlign:"center",padding:"28px 0",color:"#94a3b8",fontSize:13 }}>
                    <CheckCircle size={28} style={{ color:"#10b981",display:"block",margin:"0 auto 6px" }}/>
                    No late approvals in this period
                  </div>
                ):(
                  <div style={{ overflowX:"auto" }}>
                    <table style={{ width:"100%",borderCollapse:"collapse",fontSize:13 }}>
                      <thead style={{ background:"#f8fafc" }}>
                        <tr>{["Claimant","Department","Approver","Step","Hours Late","Status"].map(h=><th key={h} style={TH}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {claimsReport.late_approvals.map((r,i)=>(
                          <tr key={i}>
                            <td style={{...TD,fontWeight:600,color:"#374151"}}>{r.claimant_name||"—"}</td>
                            <td style={{...TD,color:"#64748b"}}>{r.department||"—"}</td>
                            <td style={{...TD,color:"#64748b"}}>{r.approver_name||"—"}</td>
                            <td style={{...TD,color:"#64748b"}}>{r.position_name}</td>
                            <td style={{...TD,fontWeight:700,color:"#dc2626"}}>{r.hours_late!=null?fmtHours(r.hours_late):"—"}</td>
                            <td style={TD}>
                              <ClaimSlaBadge status="late"/>
                              {r.still_pending && <span style={{marginLeft:6,fontSize:11,color:"#94a3b8"}}>(still pending)</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {showThresholdsModal && (
        <div className="ep-modal-overlay" onClick={()=>setShowThresholdsModal(false)}>
          <div className="ep-modal" onClick={(e)=>e.stopPropagation()}>
            <div className="ep-modal-head">
              <div><h2 className="ep-modal-title">Manage SLA Thresholds</h2><p className="ep-modal-sub">Day-thresholds per workflow position/step type for clearance approvals.</p></div>
              <button className="ep-icon-btn" onClick={()=>setShowThresholdsModal(false)}><X size={18}/></button>
            </div>
            <div className="ep-modal-body">
              <div style={{ display:"grid", gap:8 }}>
                {thresholdRows.map((row, i)=>(
                  <div key={i} style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <input className="ep-form-input" placeholder="Position type code (e.g. MANAGER, HOD, * for default)"
                      value={row.position_type_code} disabled={row.position_type_code==="*"}
                      onChange={(e)=>setThresholdRows(rows=>rows.map((r,idx)=>idx===i?{...r, position_type_code:e.target.value}:r))}
                      style={{ flex:1 }}/>
                    <input className="ep-form-input" type="number" min={0} value={row.sla_days}
                      onChange={(e)=>setThresholdRows(rows=>rows.map((r,idx)=>idx===i?{...r, sla_days:Number(e.target.value)}:r))}
                      style={{ width:90 }}/>
                    <span style={{fontSize:12,color:"#94a3b8",whiteSpace:"nowrap"}}>days</span>
                    <button className="ep-icon-btn danger" onClick={()=>void removeThresholdRow(i)} title="Remove"><Trash2 size={13}/></button>
                  </div>
                ))}
              </div>
              <button className="ep-btn-outline" style={{ marginTop:12 }}
                onClick={()=>setThresholdRows(rows=>[...rows, { position_type_code:"", sla_days:3 }])}>
                <Plus size={13}/> Add Row
              </button>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-btn-outline" onClick={()=>setShowThresholdsModal(false)} disabled={savingThresholds}>Cancel</button>
              <button className="ep-btn" onClick={()=>void saveThresholds()} disabled={savingThresholds}>{savingThresholds?"Saving…":"Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
