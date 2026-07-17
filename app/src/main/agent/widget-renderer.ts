/**
 * Widget Renderer — generates HTML for SmartSearch response bubbles.
 *
 * Chart types (bar, pie, line) emit a container div with the ECharts option
 * JSON encoded in a data-echarts attribute. The renderer calls
 * window.ssInitCharts(el) after insertion to initialize ECharts instances.
 *
 * Widgets use the "sw-" CSS prefix (SmartWidget).
 */

import type { AgentResponse } from "./nlp-agent";

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNum(n: number | string | unknown): string {
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  return num.toLocaleString();
}

function fmtBytes(n: number | string | unknown): string {
  const b = Number(n);
  if (!b || Number.isNaN(b)) return "0 B";
  if (b < 1_024) return b + " B";
  if (b < 1_048_576) return Math.round(b / 1_024) + " KB";
  if (b < 1_073_741_824) return (b / 1_048_576).toFixed(1) + " MB";
  return (b / 1_073_741_824).toFixed(2) + " GB";
}

function relDate(dateStr: unknown): string {
  const s = String(dateStr ?? "");
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10) || "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function autoFmt(key: string, val: unknown): string {
  const k = key.toLowerCase();
  if (k.includes("size")) return fmtBytes(val);
  if (k.includes("count") || k === "n" || k === "total") return fmtNum(val);
  if (k.includes("date")) return relDate(val);
  const s = String(val ?? "—");
  return s.length > 42 ? s.slice(0, 40) + "…" : s;
}

// Strip currency symbols / commas so "₹3,62,797" → 362797
function parseNumericVal(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[₹$€£¥,\s]/g, "");
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function isNumericLike(v: unknown): boolean {
  if (typeof v === "number") return true;
  if (typeof v === "string") {
    const cleaned = v.replace(/[₹$€£¥,\s]/g, "");
    return cleaned.length > 0 && !isNaN(parseFloat(cleaned)) && !/[a-zA-Z]{2,}/.test(cleaned);
  }
  return false;
}

/**
 * Find which key to use as the label and which as the numeric value.
 * Samples across multiple rows so string-amounts on row 0 don't break detection.
 */
function detectKeys(rows: Record<string, unknown>[]): { labelKey: string; valKey: string } {
  const keys = Object.keys(rows[0] ?? {});
  const sample = rows.slice(0, Math.min(5, rows.length));

  const valKey = keys.find((k) =>
    sample.some((r) => isNumericLike(r[k])) &&
    sample.every((r) => r[k] == null || isNumericLike(r[k]) || r[k] === ""),
  ) ?? "";

  const labelKey = keys.find((k) => k !== valKey && typeof rows[0][k] === "string") ?? keys[0] ?? "";
  return { labelKey, valKey };
}

// ── ECharts container helpers ─────────────────────────────────────────────────

// Unique ID for each chart so ECharts can find the element
let _chartId = 0;
function nextChartId(): string {
  return `sw-chart-${Date.now()}-${++_chartId}`;
}

function chartContainer(id: string, option: object, prose: string, height = 300): string {
  const encoded = encodeURIComponent(JSON.stringify(option));
  return `<div class="sw-widget sw-chart-widget">
  <div class="sw-chart-prose">${esc(prose)}</div>
  <div id="${id}" class="sw-echarts-host" style="width:100%;height:${height}px" data-echarts-option="${encoded}"></div>
</div>`;
}

// ── Widget builders ───────────────────────────────────────────────────────────

function buildBarChart(rows: Record<string, unknown>[], text: string): string {
  if (!rows.length) return buildTextAnswer(text);

  const { labelKey, valKey } = detectKeys(rows);
  const labels = rows.slice(0, 20).map((r) => String(r[labelKey] ?? ""));
  const values = rows.slice(0, 20).map((r) => parseNumericVal(r[valKey]));
  const id = nextChartId();

  const option = {
    tooltip: { trigger: "axis", formatter: (p: any[]) => `${p[0].name}: ${Number(p[0].value).toLocaleString()}` },
    grid: { left: 16, right: 24, top: 12, bottom: 60, containLabel: true },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { rotate: labels.some((l) => l.length > 6) ? 30 : 0, fontSize: 12 },
    },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v) } },
    series: [{ type: "bar", data: values, itemStyle: { borderRadius: [4, 4, 0, 0] }, color: "#7c6af7" }],
  };

  return chartContainer(id, option, text, Math.max(260, Math.min(380, labels.length * 36)));
}

function buildPieChart(rows: Record<string, unknown>[], text: string): string {
  if (!rows.length) return buildTextAnswer(text);

  const { labelKey, valKey } = detectKeys(rows);
  const data = rows.slice(0, 12).map((r) => ({
    name: String(r[labelKey] ?? ""),
    value: parseNumericVal(r[valKey]),
  }));
  const id = nextChartId();

  const option = {
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: { orient: "vertical", right: 8, top: "center", textStyle: { fontSize: 12 } },
    series: [{
      type: "pie",
      radius: ["35%", "65%"],
      center: ["38%", "50%"],
      data,
      emphasis: { itemStyle: { shadowBlur: 8, shadowOffsetX: 0, shadowColor: "rgba(0,0,0,0.4)" } },
      label: { show: false },
    }],
  };

  return chartContainer(id, option, text, 300);
}

function buildLineChart(rows: Record<string, unknown>[], text: string): string {
  if (!rows.length) return buildTextAnswer(text);

  const { labelKey, valKey } = detectKeys(rows);
  const labels = rows.map((r) => String(r[labelKey] ?? ""));
  const values = rows.map((r) => parseNumericVal(r[valKey]));
  const id = nextChartId();

  const option = {
    tooltip: { trigger: "axis" },
    grid: { left: 16, right: 24, top: 16, bottom: 48, containLabel: true },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { rotate: labels.some((l) => l.length > 6) ? 30 : 0, fontSize: 12 },
    },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v) } },
    series: [{
      type: "line",
      data: values,
      smooth: true,
      lineStyle: { width: 2.5, color: "#7c6af7" },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(124,106,247,0.35)" }, { offset: 1, color: "rgba(124,106,247,0)" }] } },
      symbol: "circle",
      symbolSize: 6,
      itemStyle: { color: "#7c6af7" },
    }],
  };

  return chartContainer(id, option, text, Math.max(240, Math.min(340, labels.length * 28)));
}

function buildStatCard(rows: Record<string, unknown>[], text: string): string {
  const row = rows[0] ?? {};
  const keys = Object.keys(row);

  const numKey =
    keys.find((k) => k === "message_count") ??
    keys.find((k) => k === "total_size") ??
    keys.find((k) => /count|total|size|n\b/.test(k) && typeof row[k] === "number") ??
    keys.find((k) => typeof row[k] === "number") ??
    keys[0];

  const mainVal = numKey
    ? numKey.includes("size") ? fmtBytes(row[numKey]) : fmtNum(row[numKey])
    : "—";

  const labelKey = keys.find((k) => k !== numKey && typeof row[k] === "string") ?? "";
  const labelVal = labelKey ? esc(String(row[labelKey])) : "";

  const subParts = keys
    .filter((k) => k !== numKey && k !== labelKey && typeof row[k] === "number")
    .slice(0, 3)
    .map((k) => `${k.includes("size") ? fmtBytes(row[k]) : fmtNum(row[k])} <span class="sw-sub-key">${esc(k.replace(/_/g, " "))}</span>`);

  return `<div class="sw-widget sw-stat-card">
  <div class="sw-stat-number">${esc(mainVal)}</div>
  ${labelVal ? `<div class="sw-stat-label">${labelVal}</div>` : ""}
  ${subParts.length ? `<div class="sw-stat-sub">${subParts.join(" &nbsp;·&nbsp; ")}</div>` : ""}
  <div class="sw-stat-prose">${esc(text)}</div>
</div>`;
}

function buildDataTable(rows: Record<string, unknown>[], text: string): string {
  if (!rows.length) return buildTextAnswer(text);

  const keys = Object.keys(rows[0]).slice(0, 5);
  const headers = keys.map((k) => `<th>${esc(k.replace(/_/g, " "))}</th>`).join("");
  const tableRows = rows
    .slice(0, 25)
    .map((row) => {
      const cells = keys.map((k) => `<td>${esc(autoFmt(k, row[k]))}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  const footer = rows.length > 25
    ? `<div class="sw-table-footer">Showing 25 of ${fmtNum(rows.length)} rows</div>`
    : "";

  return `<div class="sw-widget sw-data-table">
  <div class="sw-chart-prose">${esc(text)}</div>
  <div class="sw-table-wrap">
    <table class="sw-table">
      <thead><tr>${headers}</tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>
  ${footer}
</div>`;
}

function buildTextAnswer(text: string): string {
  return `<div class="sw-widget sw-text-answer">${esc(text)}</div>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderWidget(response: AgentResponse): string {
  const rows       = response.rows ?? [];
  const text       = response.answer_text || "—";
  const limitation = (response as any).data_limitation as string | undefined;

  let html = "";
  switch (response.response_type) {
    case "bar_chart":
      html = rows.length ? buildBarChart(rows, text) : buildTextAnswer(text); break;
    case "pie_chart":
      html = rows.length ? buildPieChart(rows, text)  : buildTextAnswer(text); break;
    case "line_chart":
      html = rows.length ? buildLineChart(rows, text) : buildTextAnswer(text); break;
    case "stat_card":
      html = rows.length ? buildStatCard(rows, text)  : buildTextAnswer(text); break;
    case "data_table":
      html = rows.length ? buildDataTable(rows, text) : buildTextAnswer(text); break;
    default:
      html = buildTextAnswer(text);
  }

  if (limitation) {
    html += `<div class="sw-limitation-note">
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3M8 10h.01"/></svg>
  <span>${esc(limitation)}</span>
</div>`;
  }

  return html;
}
