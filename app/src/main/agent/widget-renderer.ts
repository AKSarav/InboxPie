/**
 * Widget Renderer — generates self-contained HTML+CSS response widgets
 * that are injected as innerHTML into SmartSearch chat response bubbles.
 *
 * Widgets use the "sw-" CSS prefix (SmartWidget).
 * All styles are inline or reference global .sw-* classes in styles.css.
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

function domainHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0) % 360;
}

function autoFmt(key: string, val: unknown): string {
  const k = key.toLowerCase();
  if (k.includes("size")) return fmtBytes(val);
  if (k.includes("count") || k === "n" || k === "total") return fmtNum(val);
  if (k.includes("date")) return relDate(val);
  const s = String(val ?? "—");
  return s.length > 42 ? s.slice(0, 40) + "…" : s;
}

// ── Widget builders ───────────────────────────────────────────────────────────

function buildStatCard(rows: Record<string, unknown>[], text: string): string {
  const row = rows[0] ?? {};
  const keys = Object.keys(row);

  // Primary value: prefer message_count / total_* / any numeric
  const numKey =
    keys.find((k) => k === "message_count") ??
    keys.find((k) => k === "total_size") ??
    keys.find((k) => /count|total|size|n\b/.test(k) && typeof row[k] === "number") ??
    keys.find((k) => typeof row[k] === "number") ??
    keys[0];

  const mainVal = numKey
    ? numKey.includes("size")
      ? fmtBytes(row[numKey])
      : fmtNum(row[numKey])
    : "—";

  // Label: first string key that isn't the numeric one
  const labelKey = keys.find((k) => k !== numKey && typeof row[k] === "string") ?? "";
  const labelVal = labelKey ? esc(String(row[labelKey])) : "";

  // Sub-stats: remaining numerics
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

function buildBarChart(rows: Record<string, unknown>[], text: string): string {
  if (!rows.length) return buildTextAnswer(text);

  const keys = Object.keys(rows[0]);
  const labelKey = keys.find((k) => typeof rows[0][k] === "string") ?? keys[0];
  const valKey = keys.find((k) => k !== labelKey && typeof rows[0][k] === "number") ?? "";
  const maxVal = valKey ? Math.max(...rows.map((r) => Number(r[valKey]) || 0)) : 1;

  const bars = rows
    .slice(0, 12)
    .map((row) => {
      const label = String(row[labelKey] ?? "");
      const val = valKey ? Number(row[valKey]) || 0 : 0;
      const pct = maxVal > 0 ? ((val / maxVal) * 100).toFixed(1) : "0";
      const hue = domainHue(label);
      const displayVal = valKey?.includes("size") ? fmtBytes(val) : fmtNum(val);
      const shortLabel = label.length > 30 ? label.slice(0, 28) + "…" : label;

      return `<div class="sw-bar-row">
  <span class="sw-bar-label" title="${esc(label)}">${esc(shortLabel)}</span>
  <div class="sw-bar-track"><div class="sw-bar-fill" style="width:${pct}%;background:hsl(${hue},52%,50%)"></div></div>
  <span class="sw-bar-val">${esc(displayVal)}</span>
</div>`;
    })
    .join("");

  return `<div class="sw-widget sw-bar-chart">
  <div class="sw-chart-prose">${esc(text)}</div>
  <div class="sw-bars">${bars}</div>
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

  const footer =
    rows.length > 25
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
  const rows      = response.rows ?? [];
  const text      = response.answer_text || "—";
  const limitation = (response as any).data_limitation as string | undefined;

  let html = "";
  switch (response.response_type) {
    case "stat_card":
      html = rows.length ? buildStatCard(rows, text) : buildTextAnswer(text); break;
    case "bar_chart":
      html = rows.length ? buildBarChart(rows, text) : buildTextAnswer(text); break;
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
