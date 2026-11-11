import { useState } from "react";

// A chart the AI Assistant drew (its show_chart tool): bar, line or pie, in
// plain SVG. Colours are the validated categorical order (.fda-chart
// --series-N in styles.css, with their own dark-mode steps); identity is
// never colour alone - a legend for 2+ series, values on hover, and a table
// view of the same numbers.

export type AssistantChartData = {
  title: string;
  type: "bar" | "line" | "pie";
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
  unit?: string;
};

const W = 640;
const H = 280;
const PAD = { top: 12, right: 12, bottom: 54, left: 56 };

function fmt(v: number, unit?: string) {
  const n = Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (!unit) return n;
  return unit.length <= 2 && /^[^\d\s]+$/.test(unit) ? `${unit}${n}` : `${n} ${unit}`;
}

// Short axis numbers: 12k, 1.5M.
function short(v: number) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return `${+v.toFixed(2)}`;
}

// 4-5 round gridlines from 0 (or the minimum, if below 0) to the maximum.
function ticks(min: number, max: number) {
  const lo = Math.min(0, min);
  const span = max - lo || 1;
  const step0 = span / 4;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(+v.toFixed(10));
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

const color = (i: number) => `var(--series-${(i % 8) + 1})`;

export default function AssistantChart({ chart }: { chart: AssistantChartData }) {
  const [table, setTable] = useState(false);
  const { labels, series, unit } = chart;
  const multi = series.length > 1;

  return (
    <figure className="fda-chart" aria-label={chart.title}>
      <figcaption className="fda-chart-title">{chart.title}</figcaption>
      {chart.type === "pie" ? <Pie chart={chart} /> : <Cartesian chart={chart} />}
      {(multi || chart.type === "pie") && (
        <div className="fda-chart-legend">
          {(chart.type === "pie" ? labels : series.map((s) => s.name)).map((name, i) => (
            <span key={name}><i style={{ background: color(i) }} />{name}</span>
          ))}
        </div>
      )}
      <button type="button" className="fda-chart-toggle" onClick={() => setTable(!table)} aria-expanded={table}>
        {table ? "Hide table" : "Table"}
      </button>
      {table && (
        <div className="fda-chart-table">
          <table>
            <thead><tr><th />{series.map((s) => <th key={s.name}>{s.name}</th>)}</tr></thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={l}><td>{l}</td>{series.map((s) => <td key={s.name}>{fmt(s.values[i], unit)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

function Cartesian({ chart }: { chart: AssistantChartData }) {
  const { labels, series, unit } = chart;
  const all = series.flatMap((s) => s.values);
  const t = ticks(Math.min(...all), Math.max(...all));
  const lo = t[0];
  const hi = t[t.length - 1];
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const band = plotW / labels.length;
  const x = (i: number) => PAD.left + band * i + band / 2;
  const zero = y(Math.max(lo, 0));
  // Long or many category names: show every other / tilt.
  const every = labels.length > 12 ? 2 : 1;
  const tilt = labels.length > 6 || labels.some((l) => l.length > 10);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title} className="fda-chart-svg">
      {t.map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className={v === 0 ? "fda-chart-base" : "fda-chart-grid"} />
          <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fda-chart-axis">{short(v)}</text>
        </g>
      ))}
      {labels.map((l, i) => (i % every === 0 ? (
        <text key={l} x={x(i)} y={H - PAD.bottom + 16} textAnchor={tilt ? "end" : "middle"} transform={tilt ? `rotate(-35 ${x(i)} ${H - PAD.bottom + 16})` : undefined} className="fda-chart-axis">
          {l.length > 16 ? `${l.slice(0, 15)}…` : l}
        </text>
      ) : null))}

      {chart.type === "bar" && series.map((s, si) => {
        // Grouped bars: a 2px gap between neighbours, a third of the band left as space.
        const groupW = band * 0.68;
        const barW = Math.max(2, (groupW - 2 * (series.length - 1)) / series.length);
        return s.values.map((v, i) => {
          const bx = PAD.left + band * i + (band - groupW) / 2 + si * (barW + 2);
          const top = Math.min(y(v), zero);
          const h = Math.max(1, Math.abs(zero - y(v)));
          const r = Math.min(4, barW / 2, h);
          // Rounded only at the data end, square on the baseline.
          const d = v >= 0
            ? `M${bx},${top + h} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + barW - r} Q${bx + barW},${top} ${bx + barW},${top + r} V${top + h} Z`
            : `M${bx},${top} V${top + h - r} Q${bx},${top + h} ${bx + r},${top + h} H${bx + barW - r} Q${bx + barW},${top + h} ${bx + barW},${top + h - r} V${top} Z`;
          return (
            <path key={`${si}-${i}`} d={d} style={{ fill: color(si) }} className="fda-chart-mark">
              <title>{`${labels[i]}${series.length > 1 ? ` · ${s.name}` : ""}: ${fmt(v, unit)}`}</title>
            </path>
          );
        });
      })}

      {chart.type === "line" && series.map((s, si) => (
        <g key={s.name}>
          <polyline points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" style={{ stroke: color(si) }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {s.values.map((v, i) => (
            <g key={i}>
              <circle cx={x(i)} cy={y(v)} r={4} style={{ fill: color(si) }} className="fda-chart-dot" />
              {/* Bigger than the mark, so it's easy to hover. */}
              <circle cx={x(i)} cy={y(v)} r={12} fill="transparent">
                <title>{`${labels[i]}${series.length > 1 ? ` · ${s.name}` : ""}: ${fmt(v, unit)}`}</title>
              </circle>
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}

function Pie({ chart }: { chart: AssistantChartData }) {
  const values = chart.series[0].values.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = W / 2;
  const cy = H / 2 - 6;
  const r = Math.min(W, H) / 2 - 24;
  let angle = -Math.PI / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title} className="fda-chart-svg">
      {values.map((v, i) => {
        const a0 = angle;
        const a1 = angle + (v / total) * Math.PI * 2;
        angle = a1;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (a: number) => `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
        const d = v >= total ? `M${cx - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0` : `M${cx},${cy} L${p(a0)} A${r},${r} 0 ${large} 1 ${p(a1)} Z`;
        const pct = Math.round((v / total) * 100);
        return (
          <path key={i} d={d} style={{ fill: color(i) }} className="fda-chart-slice">
            <title>{`${chart.labels[i]}: ${fmt(chart.series[0].values[i], chart.unit)} (${pct}%)`}</title>
          </path>
        );
      })}
    </svg>
  );
}
