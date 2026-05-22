// dashboard.js — Mail Audit Dashboard v2
(function () {
  "use strict";

  let allMessages = [];
  let selectedIds = new Set();
  let currentView = "sunburst";
  /** Domains expanded in By Domain tab (chevron open). */
  const expandedDomains = new Set();
  /** Sender emails expanded in By Sender (year breakdown). */
  const expandedSenders = new Set();
  /** Sender/year rows expanded in By Sender (month breakdown). */
  const expandedSenderYears = new Set();

  const timelineState = {
    windowMonths: 24,
    offsetMonths: 0,
    selectedMonth: null,
  };
  const reviewState = {
    query: "",
    sort: "date-desc",
  };
  let privacyMaskEnabled = false;
  const DEFAULT_FOLDER_TYPES = ["inbox", "sent", "archives", "junk"];
  let selectedFolderTypes = [...DEFAULT_FOLDER_TYPES];
  /** Last domain drill-down shown under PieView (for refresh on privacy toggle). */
  let sunburstDetailState = null;

  const PALETTE = [
    "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
    "#06b6d4", "#a855f7", "#eab308", "#ef4444", "#22c55e",
    "#6366f1", "#f43f5e", "#0ea5e9", "#d946ef", "#84cc16"
  ];
  function colorFor(i) { return PALETTE[i % PALETTE.length]; }

  // Theme-aware colors — read CSS vars at render time
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const $ = (s) => document.querySelector(s);
  const scanBtn = $("#scanBtn");
  const accountSelect = $("#accountSelect");

  // ══════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════
  async function init() {
    // Load saved theme
    const saved = localStorage.getItem("mail-audit-theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    updateThemeIcon(saved);

    // Load saved privacy mask setting
    privacyMaskEnabled = localStorage.getItem("mail-audit-privacy-mask") === "true";
    updatePrivacyToggle();

    // Theme toggle
    $("#themeToggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("mail-audit-theme", next);
      updateThemeIcon(next);
      // Re-render current view with new theme colors
      if (allMessages.length > 0) switchView(currentView);
    });

    // Privacy mask toggle
    $("#privacyToggle").addEventListener("click", () => {
      privacyMaskEnabled = !privacyMaskEnabled;
      localStorage.setItem("mail-audit-privacy-mask", privacyMaskEnabled);
      updatePrivacyToggle();
      updateAccountSelectDisplay();
      const detailSnapshot = sunburstDetailState
        ? { domain: sunburstDetailState.domain, msgs: sunburstDetailState.msgs.slice() }
        : null;
      if (allMessages.length > 0) switchView(currentView);
      if (currentView === "sunburst" && detailSnapshot) {
        showDomainDetail(detailSnapshot.domain, detailSnapshot.msgs);
      }
    });

    $("#sunburstDetail").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-select-email]");
      if (!btn || !sunburstDetailState) return;
      e.preventDefault();
      selectSenderForReview(btn.getAttribute("data-select-email"), sunburstDetailState.msgs);
    });

    // Clickable stat card for selected emails
    $("#statCardSelected").addEventListener("click", () => {
      if (selectedIds.size > 0) showSelectionReviewModal();
    });

    // Folder selection
    initFolderSelection();

    // Accounts
    try {
      const accounts = await browser.runtime.sendMessage({ action: "getAccounts" });
      accounts.forEach((a) => {
        const opt = document.createElement("option");
        opt.value = a.id;
        const originalText = `${a.name} (${a.type})`;
        opt.dataset.originalText = originalText;
        opt.textContent = privacyMaskEnabled ? maskAccountText(originalText) : originalText;
        accountSelect.appendChild(opt);
      });
    } catch (e) {
      console.warn("Could not fetch accounts:", e);
    }

    scanBtn.addEventListener("click", startScan);
    accountSelect.addEventListener("change", resetDashboard);
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => switchView(t.dataset.view))
    );

    // Export buttons
    $("#exportCsvBtn").addEventListener("click", exportCSV);
    $("#exportJsonBtn").addEventListener("click", exportJSON);

    $("#app").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const act = btn.getAttribute("data-action");
      if (act === "bulk-review") {
        e.preventDefault();
        showSelectionReviewModal();
      }
    });

    // Progress listener
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.action === "progress") {
        $("#progressText").textContent = `Scanned ${msg.count.toLocaleString()} messages…`;
        $("#progressFill").style.width = "60%";
      }
      if (msg.action === "deleteProgress") {
        $("#progressText").textContent = `Moving ${msg.moved}/${msg.total} to Trash…`;
      }
      if (msg.action === "moveProgress") {
        $("#progressText").textContent = `Moving ${msg.moved}/${msg.total} messages…`;
      }
    });
  }

  function updateThemeIcon(theme) {
    $("#themeToggle").textContent = theme === "dark" ? "☀" : "☾";
    $("#themeToggle").title = theme === "dark" ? "Switch to Light" : "Switch to Dark";
  }

  function updatePrivacyToggle() {
    const btn = $("#privacyToggle");
    if (privacyMaskEnabled) {
      btn.classList.add("active");
      btn.title = "Privacy mode ON — emails masked. Click to show full emails.";
    } else {
      btn.classList.remove("active");
      btn.title = "Privacy mode OFF — full emails shown. Click to mask emails.";
    }
  }

  function updateAccountSelectDisplay() {
    const select = accountSelect;
    Array.from(select.options).forEach((opt) => {
      if (opt.value === "all") return;
      const original = opt.dataset.originalText || opt.textContent;
      opt.dataset.originalText = original;
      opt.textContent = privacyMaskEnabled ? maskAccountText(original) : original;
    });
  }

  function maskAccountText(text) {
    return text.replace(/([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, (match, local, domain) => {
      return maskEmail(`${local}@${domain}`);
    });
  }

  function maskEmail(email) {
    if (!email || !email.includes("@")) return email;
    const [local, domain] = email.split("@");
    const maskedLocal = local.length <= 1 ? `${local}***` : `${local.charAt(0)}***`;
    return `${maskedLocal}@${maskDomain(domain)}`;
  }

  function maskDomain(domain) {
    if (!domain || typeof domain !== "string") return domain || "";
    const trimmed = domain.trim();
    if (!trimmed || trimmed === "unknown") return domain;
    const parts = trimmed.split(".");
    if (parts.length < 2) return `${trimmed.charAt(0)}***`;
    const tld = parts[parts.length - 1];
    const base = parts.slice(0, -1).join(".");
    return `${base.charAt(0)}***.${tld}`;
  }

  function displayEmail(email) {
    return privacyMaskEnabled ? maskEmail(email) : email;
  }

  function displayDomain(domain) {
    return privacyMaskEnabled ? maskDomain(domain) : domain;
  }

  function displayAccount(account) {
    if (!account) return "";
    if (!privacyMaskEnabled) return account;
    return maskAccountText(String(account));
  }

  function looksLikeEmail(value) {
    return typeof value === "string" && value.includes("@");
  }

  function looksLikeDomain(value) {
    return typeof value === "string" && !value.includes("@") && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim());
  }

  function displayPrivateLabel(label) {
    if (!privacyMaskEnabled || label == null) return label;
    const text = String(label);
    if (looksLikeEmail(text)) return displayEmail(text);
    if (looksLikeDomain(text)) return displayDomain(text);
    return maskAccountText(text);
  }

  function displaySenderName(name, email) {
    const n = name || "";
    if (!privacyMaskEnabled) return n || displayEmail(email);
    if (looksLikeEmail(n) || n.toLowerCase() === String(email || "").toLowerCase()) {
      return displayEmail(email || n);
    }
    return n;
  }

  // ══════════════════════════════════════════
  //  FOLDER SELECTION
  // ══════════════════════════════════════════
  function initFolderSelection() {
    // Load saved folder selection
    const saved = localStorage.getItem("mail-audit-folder-types");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          selectedFolderTypes = parsed;
        }
      } catch (e) {
        console.warn("Could not parse saved folder types:", e);
      }
    }

    // Apply saved selection to checkboxes
    const dropdown = $("#folderDropdown");
    const checkboxes = dropdown.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      cb.checked = selectedFolderTypes.includes(cb.value);
    });
    updateFolderBadge();

    // Toggle dropdown
    $("#folderSelectBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = dropdown.style.display === "block";
      dropdown.style.display = isVisible ? "none" : "block";
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".folder-select-wrap")) {
        dropdown.style.display = "none";
      }
    });

    // Handle checkbox changes
    checkboxes.forEach((cb) => {
      cb.addEventListener("change", () => {
        updateSelectedFolders();
      });
    });

    // Select All button
    $("#folderSelectAll").addEventListener("click", () => {
      checkboxes.forEach((cb) => { cb.checked = true; });
      updateSelectedFolders();
    });

    // Select None button
    $("#folderSelectNone").addEventListener("click", () => {
      checkboxes.forEach((cb) => { cb.checked = false; });
      updateSelectedFolders();
    });
  }

  function updateSelectedFolders() {
    const checkboxes = $("#folderDropdown").querySelectorAll('input[type="checkbox"]:checked');
    selectedFolderTypes = Array.from(checkboxes).map((cb) => cb.value);
    localStorage.setItem("mail-audit-folder-types", JSON.stringify(selectedFolderTypes));
    updateFolderBadge();
  }

  function updateFolderBadge() {
    const badge = $("#folderCountBadge");
    badge.textContent = selectedFolderTypes.length;
    badge.style.display = selectedFolderTypes.length > 0 ? "inline-block" : "none";
  }

  // ══════════════════════════════════════════
  //  RESET (account change)
  // ══════════════════════════════════════════
  function resetDashboard() {
    allMessages = [];
    selectedIds.clear();
    expandedDomains.clear();
    expandedSenders.clear();
    expandedSenderYears.clear();
    timelineState.windowMonths = 24;
    timelineState.offsetMonths = 0;
    timelineState.selectedMonth = null;
    reviewState.query = "";
    reviewState.sort = "date-desc";
    currentView = "sunburst";
    sunburstDetailState = null;

    $("#selectionReviewModal").style.display = "none";
    $("#deleteModal").style.display = "none";
    $("#folderModal").style.display = "none";

    $("#progressArea").style.display = "none";
    $("#statsBar").style.display = "none";
    $("#viewTabs").style.display = "none";
    $("#exportBar").style.display = "none";
    $("#landingState").style.display = "flex";

    document.querySelectorAll(".view-panel").forEach((p) => (p.style.display = "none"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-view="sunburst"]')?.classList.add("active");

    $("#statTotal").textContent = "0";
    $("#statSenders").textContent = "0";
    $("#statUnread").textContent = "0";
    $("#statSelected").textContent = "0";

    clearElement($("#sunburstSvg"));
    clearElement($("#sunburstBreadcrumb"));
    clearElement($("#legendPanel"));
    clearElement($("#sunburstDetail"));
    clearElement($("#senderTable"));
    clearElement($("#domainTable"));
    clearElement($("#sizeInsights"));
    clearElement($("#timelineChart"));
    clearElement($("#timelineControls"));
    clearElement($("#timelineInsights"));

    const senderSearch = $("#senderSearch");
    const domainSearch = $("#domainSearch");
    if (senderSearch) senderSearch.value = "";
    if (domainSearch) domainSearch.value = "";

    scanBtn.disabled = false;
    scanBtn.querySelector(".btn-text").style.display = "inline";
    scanBtn.querySelector(".btn-loader").style.display = "none";
    $("#progressFill").style.width = "0%";
  }

  // ══════════════════════════════════════════
  //  SCAN
  // ══════════════════════════════════════════
  async function startScan() {
    if (selectedFolderTypes.length === 0) {
      alert("Please select at least one folder type to scan.");
      return;
    }

    scanBtn.querySelector(".btn-text").style.display = "none";
    scanBtn.querySelector(".btn-loader").style.display = "inline";
    scanBtn.disabled = true;
    $("#landingState").style.display = "none";
    $("#progressArea").style.display = "block";
    $("#progressFill").style.width = "20%";
    $("#progressText").textContent = `Scanning ${selectedFolderTypes.length} folder type${selectedFolderTypes.length > 1 ? "s" : ""}…`;

    try {
      const acctVal = accountSelect.value;
      const result = await browser.runtime.sendMessage({
        action: "fetchAllMail",
        options: {
          accountId: acctVal === "all" ? null : acctVal,
          folderTypes: selectedFolderTypes,
        },
      });

      allMessages = result.messages;
      $("#progressFill").style.width = "100%";
      $("#progressText").textContent = `Done — ${allMessages.length.toLocaleString()} messages loaded.`;

      setTimeout(() => {
        $("#progressArea").style.display = "none";
        $("#statsBar").style.display = "grid";
        $("#viewTabs").style.display = "flex";
        $("#exportBar").style.display = "flex";
        updateStats();
        switchView("sunburst");
      }, 600);
    } catch (e) {
      $("#progressText").textContent = `Error: ${e.message}`;
      $("#progressFill").style.width = "0%";
    } finally {
      scanBtn.querySelector(".btn-text").style.display = "inline";
      scanBtn.querySelector(".btn-loader").style.display = "none";
      scanBtn.disabled = false;
    }
  }

  function updateStats() {
    $("#statTotal").textContent = allMessages.length.toLocaleString();
    $("#statSenders").textContent = new Set(allMessages.map((m) => m.senderEmail)).size.toLocaleString();
    $("#statUnread").textContent = allMessages.filter((m) => !m.read).length.toLocaleString();
    $("#statSelected").textContent = selectedIds.size.toLocaleString();
    updateBulkButtons();
  }

  function updateBulkButtons() {
    const senderBar = $("#senderBulkButtons");
    const domainBar = $("#domainBulkButtons");
    const sizeBar = $("#sizeBulkButtons");
    const timelineBar = $("#timelineBulkButtons");
    if (senderBar) senderBar.style.display = selectedIds.size > 0 && currentView === "sender" ? "flex" : "none";
    if (domainBar) domainBar.style.display = selectedIds.size > 0 && currentView === "domain" ? "flex" : "none";
    if (sizeBar) sizeBar.style.display = selectedIds.size > 0 && currentView === "size" ? "flex" : "none";
    if (timelineBar) timelineBar.style.display = selectedIds.size > 0 && currentView === "timeline" ? "flex" : "none";
    document.querySelectorAll(".bulk-delete-count").forEach((el) => {
      el.textContent = String(selectedIds.size);
    });
  }

  function switchView(view) {
    currentView = view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector(`.tab[data-view="${view}"]`).classList.add("active");
    document.querySelectorAll(".view-panel").forEach((p) => (p.style.display = "none"));
    const panel = $(`#${view}View`);
    if (panel) {
      panel.style.display = "block";
      if (view === "sunburst") renderSunburst();
      else if (view === "sender") renderSenderTable();
      else if (view === "domain") renderDomainTable();
      else if (view === "size") renderSizeDashboard();
      else if (view === "timeline") renderTimeline();
    }
    updateBulkButtons();
  }

  // ══════════════════════════════════════════
  //  SUNBURST CHART (theme-aware)
  // ══════════════════════════════════════════
  function renderSunburst(filterFn = null, breadcrumbPath = []) {
    const svg = $("#sunburstSvg");
    clearElement(svg);
    clearElement($("#sunburstDetail"));
    sunburstDetailState = null;
    const tooltip = $("#sunburstTooltip");
    const breadcrumb = $("#sunburstBreadcrumb");
    const legend = $("#legendPanel");

    const accentColor = cssVar("--accent");
    const textMuted = cssVar("--text-muted");
    const textLabel = cssVar("--text-label");
    const gapStroke = cssVar("--svg-gap-stroke");

    const msgs = filterFn ? allMessages.filter(filterFn) : allMessages;
    const total = msgs.length;
    if (total === 0) {
      clearElement(svg);
      addSvgText(svg, 400, 400, "No messages", { fill: textMuted, fontSize: "14" });
      clearElement(legend);
      return;
    }

    const cx = 400, cy = 400;
    const rings = [
      { key: "year", label: "Year", innerR: 80, outerR: 160 },
      { key: "monthName", label: "Month", innerR: 165, outerR: 250 },
      { key: "domain", label: "Domain", innerR: 255, outerR: 340 },
    ];

    // Build tree
    const tree = {};
    msgs.forEach((m) => {
      const y = String(m.year), mo = m.monthName, d = m.domain;
      if (!tree[y]) tree[y] = {};
      if (!tree[y][mo]) tree[y][mo] = {};
      if (!tree[y][mo][d]) tree[y][mo][d] = [];
      tree[y][mo][d].push(m);
    });

    // Center text
    addSvgText(svg, cx, cy - 8, total.toLocaleString(), { fill: accentColor, fontSize: "28", fontWeight: "700", fontFamily: "monospace" });
    addSvgText(svg, cx, cy + 16, "EMAILS", { fill: textMuted, fontSize: "11", letterSpacing: "1.5" });

    // Ring labels
    rings.forEach((ring) => {
      const r = (ring.innerR + ring.outerR) / 2;
      addSvgText(svg, cx, cy - r - 6, ring.label.toUpperCase(), { fill: textLabel, fontSize: "10", fontWeight: "600", letterSpacing: "1.5" });
    });

    // Legend data collectors
    const legendYears = [];
    const legendMonths = [];
    const legendDomains = {};

    // Ring 0: Year
    const years = Object.keys(tree).sort();
    let angle0 = 0;

    years.forEach((year, yi) => {
      const yearMsgs = msgs.filter((m) => String(m.year) === year);
      const yearAngle = (yearMsgs.length / total) * 360;
      const color = colorFor(yi);
      legendYears.push({ label: year, color, count: yearMsgs.length });

      drawArc(svg, cx, cy, rings[0].innerR, rings[0].outerR, angle0, angle0 + yearAngle, color, 0.9, gapStroke,
        () => renderSunburst((m) => String(m.year) === year && (!filterFn || filterFn(m)), [...breadcrumbPath, { label: year }]),
        (e) => showTooltip(tooltip, e, year, yearMsgs.length, total)
      );

      // Add arc label for years with enough space
      if (yearAngle > 15) {
        const midAngle = angle0 + yearAngle / 2;
        const labelR = (rings[0].innerR + rings[0].outerR) / 2;
        const pt = polarToCartesian(cx, cy, labelR, midAngle);
        addSvgText(svg, pt.x, pt.y + 4, year, { fill: "#fff", fontSize: "11", fontWeight: "600" });
      }

      // Ring 1: Month
      const months = Object.keys(tree[year]).sort((a, b) => {
        const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return mo.indexOf(a) - mo.indexOf(b);
      });
      let angle1 = angle0;

      months.forEach((month, mi) => {
        const moMsgs = yearMsgs.filter((m) => m.monthName === month);
        const moAngle = (moMsgs.length / total) * 360;
        const moColor = colorFor(yi * 4 + mi);
        const moKey = `${month} ${year}`;
        legendMonths.push({ label: moKey, color: moColor, count: moMsgs.length });

        drawArc(svg, cx, cy, rings[1].innerR, rings[1].outerR, angle1, angle1 + moAngle, moColor, 0.75, gapStroke,
          () => renderSunburst((m) => String(m.year) === year && m.monthName === month && (!filterFn || filterFn(m)), [...breadcrumbPath, { label: year }, { label: month }]),
          (e) => showTooltip(tooltip, e, moKey, moMsgs.length, total)
        );
        addArcLabel(svg, cx, cy, rings[1], angle1, angle1 + moAngle, month, {
          minAngle: 18,
          maxChars: 6,
          fill: "rgba(255,255,255,0.88)",
          fontSize: "10",
          fontWeight: "600",
        });

        // Ring 2: Domain
        const domains = Object.keys(tree[year][month]).sort((a, b) => tree[year][month][b].length - tree[year][month][a].length);
        let angle2 = angle1;
        const topDomains = domains.slice(0, 15);
        const otherCount = domains.slice(15).reduce((s, d) => s + tree[year][month][d].length, 0);

        topDomains.forEach((domain, di) => {
          const dMsgs = tree[year][month][domain];
          const dAngle = (dMsgs.length / total) * 360;
          const dColor = colorFor(di + 3);
          if (!legendDomains[domain]) legendDomains[domain] = { color: dColor, count: 0 };
          legendDomains[domain].count += dMsgs.length;

          drawArc(svg, cx, cy, rings[2].innerR, rings[2].outerR, angle2, angle2 + dAngle, dColor, 0.6, gapStroke,
            () => showDomainDetail(domain, dMsgs),
            (e) => showTooltip(tooltip, e, displayDomain(domain), dMsgs.length, total)
          );
          addArcLabel(svg, cx, cy, rings[2], angle2, angle2 + dAngle, displayDomain(domain), {
            minAngle: 24,
            maxChars: 12,
            fill: "rgba(255,255,255,0.82)",
            fontSize: "9",
            fontWeight: "600",
          });
          angle2 += dAngle;
        });

        if (otherCount > 0) {
          const oAngle = (otherCount / total) * 360;
          drawArc(svg, cx, cy, rings[2].innerR, rings[2].outerR, angle2, angle2 + oAngle, textMuted, 0.3, gapStroke,
            null, (e) => showTooltip(tooltip, e, "Other domains", otherCount, total));
        }

        angle1 += moAngle;
      });

      angle0 += yearAngle;
    });

    svg.addEventListener("mouseleave", () => (tooltip.style.display = "none"));

    // Breadcrumb
    renderBreadcrumb(breadcrumb, breadcrumbPath, filterFn);

    // Legend
    renderLegend(legend, legendYears, legendMonths, legendDomains);
  }

  function renderLegend(panel, years, months, domains) {
    let html = '<div class="legend-title">Chart Legend</div>';

    html += '<div class="legend-section"><div class="legend-section-title">Years (inner ring)</div>';
    years.forEach((y) => {
      html += `<div class="legend-item"><div class="legend-swatch" style="background:${escAttr(y.color)}"></div><span class="legend-label">${escHtml(y.label)}</span><span class="legend-count">${y.count.toLocaleString()}</span></div>`;
    });
    html += '</div>';

    // Top 10 domains
    const topDomains = Object.entries(domains).sort((a, b) => b[1].count - a[1].count).slice(0, 15);
    html += '<div class="legend-section"><div class="legend-section-title">Top Domains (outer ring)</div>';
    topDomains.forEach(([name, d]) => {
      html += `<div class="legend-item"><div class="legend-swatch" style="background:${escAttr(d.color)}"></div><span class="legend-label">${escHtml(displayDomain(name))}</span><span class="legend-count">${d.count.toLocaleString()}</span></div>`;
    });
    html += '</div>';

    setSafeHtml(panel, html);
  }

  function renderBreadcrumb(breadcrumb, path, filterFn) {
    clearElement(breadcrumb);
    const allSpan = document.createElement("span");
    allSpan.textContent = "All Mail";
    allSpan.classList.toggle("bc-active", path.length === 0);
    allSpan.addEventListener("click", () => renderSunburst(null, []));
    breadcrumb.appendChild(allSpan);

    path.forEach((crumb, i) => {
      const sep = document.createElement("span");
      sep.className = "bc-sep";
      sep.textContent = "›";
      breadcrumb.appendChild(sep);
      const s = document.createElement("span");
      s.textContent = crumb.label;
      s.classList.toggle("bc-active", i === path.length - 1);
      breadcrumb.appendChild(s);
    });
  }

  function showDomainDetail(domain, msgs) {
    const detail = $("#sunburstDetail");
    sunburstDetailState = { domain, msgs };
    const bySender = {};
    msgs.forEach((m) => {
      if (!bySender[m.senderEmail]) bySender[m.senderEmail] = { name: m.senderName, count: 0, ids: [] };
      bySender[m.senderEmail].count++;
      bySender[m.senderEmail].ids.push(m.id);
    });
    const sorted = Object.entries(bySender).sort((a, b) => b[1].count - a[1].count);

    setSafeHtml(detail, `
      <h3 style="font-size:14px; margin-bottom:10px; color:var(--accent);">${escHtml(displayDomain(domain))} — ${msgs.length} emails</h3>
      <table>
        <thead><tr><th>Sender</th><th>Count</th><th>Select</th></tr></thead>
        <tbody>
          ${sorted.map(([email, data]) => {
            const senderMsgs = msgs.filter((m) => m.senderEmail === email);
            const allSelected = senderMsgs.length > 0 && senderMsgs.every((m) => selectedIds.has(m.id));
            return `
            <tr>
              <td><strong>${escHtml(displaySenderName(data.name, email))}</strong><br><span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escHtml(displayEmail(email))}</span></td>
              <td style="font-family:var(--font-mono);color:var(--accent);">${data.count}</td>
              <td><button type="button" class="btn btn-secondary" style="font-size:11px;padding:4px 10px;" data-select-email="${escAttr(email)}">${allSelected ? "Selected" : "Select"}</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    `);
  }

  function selectSenderForReview(email, scopeMsgs = null) {
    const pool = scopeMsgs || allMessages;
    const matches = pool.filter((m) => m.senderEmail === email);
    if (!matches.length) return;
    const allSelected = matches.every((m) => selectedIds.has(m.id));
    matches.forEach((m) => {
      if (allSelected) removeSelectedId(String(m.id));
      else selectedIds.add(m.id);
    });
    updateStats();
    if (currentView === "sender") renderSenderTable();
    else if (currentView === "domain") renderDomainTable();
    else if (currentView === "sunburst" && sunburstDetailState) {
      showDomainDetail(sunburstDetailState.domain, sunburstDetailState.msgs);
    }
  }

  // ══════════════════════════════════════════
  //  SVG HELPERS
  // ══════════════════════════════════════════
  function drawArc(svg, cx, cy, r1, r2, startAngle, endAngle, color, opacity, gapStroke, onClick, onHover) {
    if (endAngle - startAngle < 0.3) return;
    const gap = 0.5;
    const sa = startAngle + gap / 2, ea = endAngle - gap / 2;
    if (ea <= sa) return;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", describeArc(cx, cy, r1, r2, sa, ea));
    path.setAttribute("fill", color);
    path.setAttribute("opacity", opacity);
    path.setAttribute("stroke", gapStroke);
    path.setAttribute("stroke-width", "1.5");
    path.style.cursor = onClick ? "pointer" : "default";
    path.style.transition = "opacity 0.15s";

    path.addEventListener("mouseenter", (e) => { path.setAttribute("opacity", Math.min(1, opacity + 0.25)); if (onHover) onHover(e); });
    path.addEventListener("mousemove", (e) => { if (onHover) onHover(e); });
    path.addEventListener("mouseleave", () => { path.setAttribute("opacity", opacity); });
    if (onClick) path.addEventListener("click", onClick);

    svg.appendChild(path);
  }

  function describeArc(cx, cy, r1, r2, startAngle, endAngle) {
    const s1 = polarToCartesian(cx, cy, r2, endAngle);
    const s2 = polarToCartesian(cx, cy, r2, startAngle);
    const s3 = polarToCartesian(cx, cy, r1, startAngle);
    const s4 = polarToCartesian(cx, cy, r1, endAngle);
    const large = endAngle - startAngle > 180 ? 1 : 0;
    return `M ${s2.x} ${s2.y} A ${r2} ${r2} 0 ${large} 1 ${s1.x} ${s1.y} L ${s4.x} ${s4.y} A ${r1} ${r1} 0 ${large} 0 ${s3.x} ${s3.y} Z`;
  }

  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function addSvgText(svg, x, y, text, opts = {}) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
    el.setAttribute("x", x);
    el.setAttribute("y", y);
    el.setAttribute("text-anchor", "middle");
    el.setAttribute("fill", opts.fill || "#fff");
    el.setAttribute("font-size", opts.fontSize || "12");
    if (opts.fontWeight) el.setAttribute("font-weight", opts.fontWeight);
    if (opts.fontFamily) el.setAttribute("font-family", opts.fontFamily);
    if (opts.letterSpacing) el.setAttribute("letter-spacing", opts.letterSpacing);
    el.textContent = text;
    svg.appendChild(el);
    return el;
  }

  function addArcLabel(svg, cx, cy, ring, startAngle, endAngle, label, opts = {}) {
    const angle = endAngle - startAngle;
    if (angle < (opts.minAngle || 20)) return;

    const midAngle = startAngle + angle / 2;
    const labelR = (ring.innerR + ring.outerR) / 2;
    const pt = polarToCartesian(cx, cy, labelR, midAngle);
    const text = truncateLabel(label, opts.maxChars || 10);
    const el = addSvgText(svg, pt.x, pt.y + 3, text, {
      fill: opts.fill || "rgba(255,255,255,0.85)",
      fontSize: opts.fontSize || "10",
      fontWeight: opts.fontWeight || "600",
    });

    if (angle > 36 && ring.outerR > 200) {
      const rotation = midAngle > 90 && midAngle < 270 ? midAngle + 90 : midAngle - 90;
      el.setAttribute("transform", `rotate(${rotation} ${pt.x} ${pt.y})`);
    }
  }

  function truncateLabel(label, maxChars) {
    const s = String(label || "");
    if (s.length <= maxChars) return s;
    return `${s.slice(0, Math.max(1, maxChars - 1))}…`;
  }

  function showTooltip(tooltip, event, label, count, total) {
    const pct = ((count / total) * 100).toFixed(1);
    setSafeHtml(tooltip, `
      <div class="tt-label">${escHtml(displayPrivateLabel(label))}</div>
      <div class="tt-count">${count.toLocaleString()} emails</div>
      <div class="tt-pct">${pct}% of total</div>
    `);
    tooltip.style.display = "block";
    tooltip.style.left = event.clientX + 14 + "px";
    tooltip.style.top = event.clientY - 10 + "px";
  }

  // ══════════════════════════════════════════
  //  SENDER TABLE
  // ══════════════════════════════════════════
  function renderSenderTable() {
    const container = $("#senderTable");
    const searchInput = $("#senderSearch");
    const sortSelect = $("#senderSort");

    const bySender = groupBy("senderEmail");
    let entries = Object.entries(bySender);
    const maxCount = Math.max(1, ...entries.map(([, v]) => v.length));

    const q = (searchInput.value || "").toLowerCase();
    if (q) entries = entries.filter(([email, msgs]) => email.includes(q) || msgs[0].senderName.toLowerCase().includes(q));

    const sort = sortSelect.value;
    if (sort === "count-desc") entries.sort((a, b) => b[1].length - a[1].length);
    else if (sort === "count-asc") entries.sort((a, b) => a[1].length - b[1].length);
    else if (sort === "name-asc") entries.sort((a, b) => a[0].localeCompare(b[0]));
    else if (sort === "date-desc") entries.sort((a, b) => new Date(b[1][0].date) - new Date(a[1][0].date));

    setSafeHtml(container, entries.map(([email, msgs], i) => {
      const name = msgs[0].senderName || email;
      const count = msgs.length;
      const unread = msgs.filter((m) => !m.read).length;
      const isSelected = msgs.some((m) => selectedIds.has(m.id));
      const pct = ((count / maxCount) * 100).toFixed(0);
      const color = colorFor(i);
      const expanded = expandedSenders.has(email);

      const byYear = {};
      msgs.forEach((m) => {
        const y = m.year;
        if (!byYear[y]) byYear[y] = [];
        byYear[y].push(m);
      });
      const yearEntries = Object.entries(byYear).sort((a, b) => Number(b[0]) - Number(a[0]));
      const yMax = Math.max(1, ...yearEntries.map(([, arr]) => arr.length));

      const yearRowsHtml = expanded
        ? yearEntries
            .map(([year, ymsgs], yi) => {
              const ycount = ymsgs.length;
              const yunread = ymsgs.filter((m) => !m.read).length;
              const ySel = ymsgs.some((m) => selectedIds.has(m.id));
              const ypct = ((ycount / yMax) * 100).toFixed(0);
              const ycolor = colorFor(yi + i * 2);
              const yearKey = senderYearKey(email, year);
              const yearExpanded = expandedSenderYears.has(yearKey);
              const byMonth = {};
              ymsgs.forEach((m) => {
                const monthKey = String(m.month).padStart(2, "0");
                if (!byMonth[monthKey]) byMonth[monthKey] = [];
                byMonth[monthKey].push(m);
              });
              const monthEntries = Object.entries(byMonth).sort((a, b) => Number(b[0]) - Number(a[0]));
              const mMax = Math.max(1, ...monthEntries.map(([, arr]) => arr.length));
              const monthRowsHtml = yearExpanded
                ? monthEntries.map(([month, mmsgs], mi) => {
                    const monthName = mmsgs[0].monthName || month;
                    const mcount = mmsgs.length;
                    const munread = mmsgs.filter((m) => !m.read).length;
                    const mSel = mmsgs.some((m) => selectedIds.has(m.id));
                    const mpct = ((mcount / mMax) * 100).toFixed(0);
                    const mcolor = colorFor(mi + yi * 2 + i);
                    return `
          <div class="sender-month-row ${mSel ? "selected" : ""}" data-email="${escAttr(email)}" data-year="${year}" data-month="${month}">
            <div class="sr-check"></div>
            <div class="sr-info">
              <div class="sr-name">${escHtml(monthName)}</div>
              <div class="sr-email">${year} · ${mcount === 1 ? "1 email" : mcount + " emails"}</div>
            </div>
            <div class="sr-count">${mcount}</div>
            <div class="sr-bar-wrap"><div class="sr-bar" style="width:${mpct}%;background:${mcolor};"></div></div>
            <div class="sr-unread">${munread ? munread + " unread" : ""}</div>
            <div class="sr-expand"></div>
          </div>`;
                  }).join("")
                : "";
              return `
        <div class="sender-year-group" data-email="${escAttr(email)}" data-year="${year}">
          <div class="sender-year-row ${yearExpanded ? "expanded" : ""} ${ySel ? "selected" : ""}" data-email="${escAttr(email)}" data-year="${year}">
            <div class="sr-check"></div>
            <div class="sr-info">
              <div class="sr-name">${escHtml(String(year))}</div>
              <div class="sr-email">this sender · ${ycount === 1 ? "1 email" : ycount + " emails"}</div>
            </div>
            <div class="sr-count">${ycount}</div>
            <div class="sr-bar-wrap"><div class="sr-bar" style="width:${ypct}%;background:${ycolor};"></div></div>
            <div class="sr-unread">${yunread ? yunread + " unread" : ""}</div>
            <div class="sr-expand" title="Show months">›</div>
          </div>
          ${yearExpanded ? `<div class="sender-month-list">${monthRowsHtml}</div>` : ""}
        </div>`;
            })
            .join("")
        : "";

      return `
        <div class="sender-group" data-email="${escAttr(email)}">
          <div class="sender-row sender-head ${expanded ? "expanded" : ""} ${isSelected ? "selected" : ""}" data-email="${escAttr(email)}">
            <div class="sr-check"></div>
            <div class="sr-info"><div class="sr-name">${escHtml(name)}</div><div class="sr-email">${escHtml(displayEmail(email))}</div></div>
            <div class="sr-count">${count}</div>
            <div class="sr-bar-wrap"><div class="sr-bar" style="width:${pct}%;background:${color};"></div></div>
            <div class="sr-unread">${unread ? unread + " unread" : ""}</div>
            <div class="sr-expand" title="Show breakdown by year">›</div>
          </div>
          ${expanded ? `<div class="sender-year-list">${yearRowsHtml}</div>` : ""}
        </div>`;
    }).join(""));

    container.querySelectorAll(".sender-group").forEach((group) => {
      const email = group.dataset.email;
      const head = group.querySelector(".sender-head");
      const chev = head && head.querySelector(".sr-expand");

      if (chev) {
        chev.addEventListener("click", (e) => {
          e.stopPropagation();
          if (expandedSenders.has(email)) expandedSenders.delete(email);
          else expandedSenders.add(email);
          renderSenderTable();
        });
      }

      if (head) {
        head.addEventListener("click", (e) => {
          if (e.target.closest(".sr-expand")) return;
          const msgs = bySender[email];
          if (!msgs) return;
          const allSelected = msgs.every((m) => selectedIds.has(m.id));
          msgs.forEach((m) => {
            if (allSelected) selectedIds.delete(m.id);
            else selectedIds.add(m.id);
          });
          updateStats();
          renderSenderTable();
        });
      }

      group.querySelectorAll(".sender-year-row").forEach((row) => {
        row.addEventListener("click", (e) => {
          if (e.target.closest(".sr-expand")) {
            e.stopPropagation();
            const yearKey = senderYearKey(email, row.dataset.year);
            if (expandedSenderYears.has(yearKey)) expandedSenderYears.delete(yearKey);
            else expandedSenderYears.add(yearKey);
            renderSenderTable();
            return;
          }
          e.stopPropagation();
          const y = Number(row.dataset.year);
          const ymsgs = bySender[email].filter((m) => m.year === y);
          if (!ymsgs.length) return;
          const allSelected = ymsgs.every((m) => selectedIds.has(m.id));
          ymsgs.forEach((m) => {
            if (allSelected) selectedIds.delete(m.id);
            else selectedIds.add(m.id);
          });
          updateStats();
          renderSenderTable();
        });
      });

      group.querySelectorAll(".sender-month-row").forEach((row) => {
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          const y = Number(row.dataset.year);
          const mo = Number(row.dataset.month);
          const mmsgs = bySender[email].filter((m) => m.year === y && m.month === mo);
          if (!mmsgs.length) return;
          const allSelected = mmsgs.every((m) => selectedIds.has(m.id));
          mmsgs.forEach((m) => {
            if (allSelected) selectedIds.delete(m.id);
            else selectedIds.add(m.id);
          });
          updateStats();
          renderSenderTable();
        });
      });
    });

    searchInput.oninput = () => renderSenderTable();
    sortSelect.onchange = () => renderSenderTable();
    updateBulkButtons();
  }

  // ══════════════════════════════════════════
  //  DOMAIN TABLE
  // ══════════════════════════════════════════
  function renderDomainTable() {
    const container = $("#domainTable");
    const searchInput = $("#domainSearch");
    const byDomain = groupBy("domain");
    let entries = Object.entries(byDomain);
    const maxCount = Math.max(1, ...entries.map(([, v]) => v.length));
    const q = (searchInput.value || "").toLowerCase();
    if (q) entries = entries.filter(([domain]) => domain.toLowerCase().includes(q));
    entries.sort((a, b) => b[1].length - a[1].length);

    setSafeHtml(container, entries.map(([domain, msgs], i) => {
      const count = msgs.length;
      const senderNum = new Set(msgs.map((m) => m.senderEmail)).size;
      const pct = ((count / maxCount) * 100).toFixed(0);
      const color = colorFor(i);
      const expanded = expandedDomains.has(domain);

      const bySender = {};
      msgs.forEach((m) => {
        if (!bySender[m.senderEmail]) bySender[m.senderEmail] = [];
        bySender[m.senderEmail].push(m);
      });
      const senderEntries = Object.entries(bySender).sort((a, b) => b[1].length - a[1].length);
      const subMax = Math.max(1, ...senderEntries.map(([, list]) => list.length));

      const subRows = expanded
        ? senderEntries
            .map(([email, subMsgs], si) => {
              const name = subMsgs[0].senderName || email;
              const subCount = subMsgs.length;
              const unread = subMsgs.filter((m) => !m.read).length;
              const partialSel = subMsgs.some((m) => selectedIds.has(m.id));
              const spct = ((subCount / subMax) * 100).toFixed(0);
              const sc = colorFor(si + i * 3);
              return `
        <div class="sender-row ${partialSel ? "selected" : ""}" data-role="sender" data-email="${escAttr(email)}">
          <div class="sr-check"></div>
          <div class="sr-info"><div class="sr-name">${escHtml(name)}</div><div class="sr-email">${escHtml(displayEmail(email))}</div></div>
          <div class="sr-count">${subCount}</div>
          <div class="sr-bar-wrap"><div class="sr-bar" style="width:${spct}%;background:${sc};"></div></div>
          <div class="sr-unread">${unread ? unread + " unread" : ""}</div>
          <div class="sr-expand"></div>
        </div>`;
            })
            .join("")
        : "";

      const anySel = msgs.some((m) => selectedIds.has(m.id));

      return `
        <div class="domain-group" data-domain="${escAttr(domain)}">
          <div class="sender-row domain-row ${expanded ? "expanded" : ""} ${anySel ? "selected" : ""}" data-role="domain-head">
            <div class="sr-check"></div>
            <div class="sr-info"><div class="sr-name">${escHtml(displayDomain(domain))}</div><div class="sr-email">${senderNum} sender${senderNum > 1 ? "s" : ""} · click › to expand</div></div>
            <div class="sr-count">${count}</div>
            <div class="sr-bar-wrap"><div class="sr-bar" style="width:${pct}%;background:${color};"></div></div>
            <div class="sr-unread"></div>
            <div class="sr-expand" title="Show senders">›</div>
          </div>
          ${expanded ? `<div class="domain-sender-list">${subRows}</div>` : ""}
        </div>`;
    }).join(""));

    searchInput.oninput = () => renderDomainTable();

    container.querySelectorAll(".domain-group").forEach((group) => {
      const domain = group.dataset.domain;
      const head = group.querySelector('[data-role="domain-head"]');
      const chev = head && head.querySelector(".sr-expand");

      if (chev) {
        chev.addEventListener("click", (e) => {
          e.stopPropagation();
          if (expandedDomains.has(domain)) expandedDomains.delete(domain);
          else expandedDomains.add(domain);
          renderDomainTable();
        });
      }

      if (head) {
        head.addEventListener("click", (e) => {
          if (e.target.closest(".sr-expand")) return;
          const list = byDomain[domain];
          if (!list) return;
          const allSelected = list.every((m) => selectedIds.has(m.id));
          list.forEach((m) => {
            if (allSelected) selectedIds.delete(m.id);
            else selectedIds.add(m.id);
          });
          updateStats();
          renderDomainTable();
        });
      }

      group.querySelectorAll('.sender-row[data-role="sender"]').forEach((row) => {
        row.addEventListener("click", () => {
          const email = row.dataset.email;
          const list = allMessages.filter((m) => m.domain === domain && m.senderEmail === email);
          if (!list.length) return;
          const allSelected = list.every((m) => selectedIds.has(m.id));
          list.forEach((m) => {
            if (allSelected) selectedIds.delete(m.id);
            else selectedIds.add(m.id);
          });
          updateStats();
          renderDomainTable();
        });
      });
    });

    updateBulkButtons();
  }

  // ══════════════════════════════════════════
  //  SIZE DASHBOARD
  // ══════════════════════════════════════════
  function renderSizeDashboard() {
    const container = $("#sizeInsights");
    const summary = $("#sizeSummaryLabel");
    if (!container) return;

    const knownMessages = allMessages.filter((m) => messageSize(m) > 0);
    const totalBytes = knownMessages.reduce((sum, m) => sum + messageSize(m), 0);
    const unknownCount = allMessages.length - knownMessages.length;
    const largest = knownMessages.slice().sort((a, b) => messageSize(b) - messageSize(a));
    const topLargest = largest.slice(0, 12).map((m) => ({
      title: m.subject || "(No Subject)",
      subtitle: `${m.senderName || displayEmail(m.senderEmail)} · ${m.folder || "Unknown folder"} · ${formatDate(m.date)}`,
      count: messageSize(m),
      value: String(m.id),
      messages: [m],
    }));

    const buckets = buildSizeBuckets(knownMessages);
    const heavySenders = groupBySize(knownMessages, (m) => m.senderEmail, (m) => ({
      title: m.senderName || displayEmail(m.senderEmail),
      subtitle: displayEmail(m.senderEmail),
      value: m.senderEmail,
    })).slice(0, 8);
    const heavyDomains = groupBySize(knownMessages, (m) => m.domain, (m) => ({
      title: displayDomain(m.domain),
      subtitle: "domain storage",
      value: m.domain,
    })).slice(0, 8);
    const largeOld = knownMessages
      .filter((m) => ageDays(m.date) >= 365 && messageSize(m) >= 1024 * 1024)
      .sort((a, b) => messageSize(b) - messageSize(a))
      .slice(0, 8)
      .map((m) => ({
        title: m.subject || "(No Subject)",
        subtitle: `${m.senderName || displayEmail(m.senderEmail)} · ${Math.floor(ageDays(m.date) / 365)}y old`,
        count: messageSize(m),
        value: String(m.id),
        messages: [m],
      }));

    if (summary) {
      summary.textContent = unknownCount
        ? `${formatBytes(totalBytes)} known size across ${knownMessages.length.toLocaleString()} messages · ${unknownCount.toLocaleString()} unknown-size messages`
        : `${formatBytes(totalBytes)} across ${knownMessages.length.toLocaleString()} messages`;
    }

    setSafeHtml(container, `
      <div class="timeline-kpis">
        <div class="timeline-kpi"><span>${formatBytes(totalBytes)}</span><label>Known mailbox size</label></div>
        <div class="timeline-kpi"><span>${knownMessages.length.toLocaleString()}</span><label>Messages with size</label></div>
        <div class="timeline-kpi"><span>${formatBytes(largest[0] ? messageSize(largest[0]) : 0)}</span><label>Largest message</label></div>
        <div class="timeline-kpi"><span>${unknownCount.toLocaleString()}</span><label>Unknown size</label></div>
      </div>
      <div class="size-note">Size data depends on what Thunderbird exposes per account. Unknown-size messages are kept out of storage rankings.</div>
      <div class="insight-grid size-grid">
        ${renderSizeCard("Size Buckets", "Select a size band to recover storage quickly.", buckets, "bucket")}
        ${renderSizeCard("Top Space-Heavy Senders", "Senders consuming the most total mailbox space.", heavySenders, "sender")}
        ${renderSizeCard("Top Space-Heavy Domains", "Domains consuming storage across many senders.", heavyDomains, "domain")}
        ${renderSizeCard("Large Old Messages", "Large messages older than one year.", largeOld, "message")}
      </div>
      <section class="insight-card size-wide-card">
        <div class="insight-card-head">
          <h3>Largest Individual Messages</h3>
          <p>Fastest path to reclaiming space. Select rows and use Move to Trash or Move to Folder.</p>
        </div>
        <div class="insight-rows">
          ${topLargest.length ? topLargest.map((row) => renderSizeRow(row, "message")).join("") : `<div class="insight-empty">No message sizes available.</div>`}
        </div>
      </section>
    `);

    container.querySelectorAll("[data-size-kind]").forEach((btn) => {
      btn.addEventListener("click", () => selectSizeInsight(btn, knownMessages));
    });
    updateBulkButtons();
  }

  function renderSizeCard(title, subtitle, rows, kind) {
    const body = rows.length
      ? rows.map((row) => renderSizeRow(row, kind)).join("")
      : `<div class="insight-empty">No matching messages.</div>`;
    return `
      <section class="insight-card">
        <div class="insight-card-head">
          <h3>${escHtml(title)}</h3>
          <p>${escHtml(subtitle)}</p>
        </div>
        <div class="insight-rows">${body}</div>
      </section>`;
  }

  function renderSizeRow(row, kind) {
    const allSelected = row.messages.length > 0 && row.messages.every((m) => selectedIds.has(m.id));
    return `
      <div class="insight-row size-row ${allSelected ? "selected" : ""}">
        <div>
          <strong>${escHtml(row.title)}</strong>
          <span>${escHtml(row.subtitle || "")} · ${row.messages.length.toLocaleString()} message${row.messages.length === 1 ? "" : "s"}</span>
        </div>
        <div class="insight-row-meta">
          <span>${formatBytes(row.count)}</span>
          <button type="button" class="btn btn-secondary" data-size-kind="${kind}" data-value="${escAttr(row.value || "")}">${allSelected ? "Selected" : "Select"}</button>
        </div>
      </div>`;
  }

  function buildSizeBuckets(messages) {
    const mb = 1024 * 1024;
    const buckets = [
      { value: "25mb-plus", title: "> 25 MB", subtitle: "Very large messages", min: 25 * mb, max: Infinity, messages: [] },
      { value: "10-25mb", title: "10-25 MB", subtitle: "Large messages", min: 10 * mb, max: 25 * mb, messages: [] },
      { value: "5-10mb", title: "5-10 MB", subtitle: "Attachment-heavy", min: 5 * mb, max: 10 * mb, messages: [] },
      { value: "1-5mb", title: "1-5 MB", subtitle: "Medium storage impact", min: mb, max: 5 * mb, messages: [] },
      { value: "under-1mb", title: "< 1 MB", subtitle: "Small messages", min: 1, max: mb, messages: [] },
    ];
    messages.forEach((m) => {
      const size = messageSize(m);
      const bucket = buckets.find((b) => size >= b.min && size < b.max);
      if (bucket) bucket.messages.push(m);
    });
    return buckets
      .map((b) => ({ ...b, count: b.messages.reduce((sum, m) => sum + messageSize(m), 0) }))
      .filter((b) => b.messages.length > 0);
  }

  function groupBySize(messages, keyFn, metaFn) {
    const grouped = {};
    messages.forEach((m) => {
      const key = keyFn(m);
      if (!grouped[key]) grouped[key] = { ...metaFn(m), key, count: 0, messages: [] };
      grouped[key].messages.push(m);
      grouped[key].count += messageSize(m);
    });
    return Object.values(grouped).sort((a, b) => b.count - a.count);
  }

  function selectSizeInsight(btn, knownMessages) {
    const kind = btn.dataset.sizeKind;
    const value = btn.dataset.value;
    let matches = [];

    if (kind === "bucket") {
      matches = buildSizeBuckets(knownMessages).find((b) => b.value === value)?.messages || [];
    } else if (kind === "sender") {
      matches = knownMessages.filter((m) => m.senderEmail === value);
    } else if (kind === "domain") {
      matches = knownMessages.filter((m) => m.domain === value);
    } else if (kind === "message") {
      matches = knownMessages.filter((m) => String(m.id) === value);
    }

    toggleMessageSelection(matches.map((m) => m.id));
    updateStats();
    renderSizeDashboard();
  }

  // ══════════════════════════════════════════
  //  TIMELINE
  // ══════════════════════════════════════════
  function renderTimeline() {
    const container = $("#timelineChart");
    const controls = $("#timelineControls");
    const insights = $("#timelineInsights");
    const label = $("#timelineRangeLabel");
    const textMuted = cssVar("--text-muted");
    const border = cssVar("--border");
    const accent = cssVar("--accent");
    const textPrimary = cssVar("--text-primary");

    const months = buildTimelineMonths();
    if (!months.length) {
      if (controls) clearElement(controls);
      if (insights) clearElement(insights);
      if (label) label.textContent = "No timeline data";
      setSafeHtml(container, `<p style="color:${textMuted};">No data</p>`);
      updateBulkButtons();
      return;
    }

    const visible = getVisibleTimelineMonths(months);
    const selected = timelineState.selectedMonth && months.find((m) => m.key === timelineState.selectedMonth);
    const messagesInRange = selected ? selected.messages : messagesForMonths(visible);
    const activeLabel = selected
      ? `${selected.label} selected · ${selected.count.toLocaleString()} emails`
      : `${visible[0].label} - ${visible[visible.length - 1].label} · ${messagesInRange.length.toLocaleString()} emails`;
    if (label) label.textContent = activeLabel;

    setSafeHtml(controls, `
      <div class="timeline-control-group">
        <button class="btn btn-secondary ${timelineState.windowMonths === null ? "active" : ""}" data-timeline-action="window" data-window="all">All</button>
        <button class="btn btn-secondary ${timelineState.windowMonths === 12 ? "active" : ""}" data-timeline-action="window" data-window="12">12M</button>
        <button class="btn btn-secondary ${timelineState.windowMonths === 24 ? "active" : ""}" data-timeline-action="window" data-window="24">24M</button>
        <button class="btn btn-secondary ${timelineState.windowMonths === 60 ? "active" : ""}" data-timeline-action="window" data-window="60">5Y</button>
      </div>
      <div class="timeline-control-group">
        <button class="btn btn-secondary" data-timeline-action="prev">Previous</button>
        <button class="btn btn-secondary" data-timeline-action="next">Next</button>
        <button class="btn btn-secondary" data-timeline-action="zoom-in">Zoom In</button>
        <button class="btn btn-secondary" data-timeline-action="zoom-out">Zoom Out</button>
        <button class="btn btn-secondary" data-timeline-action="reset">Reset</button>
      </div>
    `);

    const maxVal = Math.max(1, ...visible.map((m) => m.count));
    const svgW = Math.max(760, visible.length * 34 + 70);
    const svgH = 300, chartH = 210;
    const barGap = 6;
    const barW = Math.max(10, Math.min(34, (svgW - 70) / visible.length - barGap));

    let bars = "";
    visible.forEach((m, i) => {
      const h = Math.max(2, (m.count / maxVal) * chartH);
      const unreadH = m.count ? Math.max(1, (m.unread / m.count) * h) : 0;
      const x = 48 + i * (barW + barGap);
      const y = svgH - 48 - h;
      const unreadY = svgH - 48 - unreadH;
      const isSelected = timelineState.selectedMonth === m.key;
      const color = colorFor(i % 12);
      bars += `
        <g class="timeline-month ${isSelected ? "selected" : ""}" data-month="${escAttr(m.key)}">
          <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" opacity="${isSelected ? "0.95" : "0.68"}" rx="4"></rect>
          <rect x="${x}" y="${unreadY}" width="${barW}" height="${unreadH}" fill="${accent}" opacity="0.9" rx="4"></rect>
          <title>${m.label}: ${m.count.toLocaleString()} total, ${m.unread.toLocaleString()} unread</title>
          <text x="${x + barW / 2}" y="${svgH - 30}" text-anchor="middle" fill="${textMuted}" font-size="8" transform="rotate(-45, ${x + barW / 2}, ${svgH - 30})">${m.shortLabel}</text>
        </g>`;
    });

    setSafeHtml(container, `
      <svg viewBox="0 0 ${svgW} ${svgH}" width="${svgW}">
        <line x1="44" y1="${svgH - 48}" x2="${svgW - 10}" y2="${svgH - 48}" stroke="${border}" stroke-width="1"/>
        <text x="44" y="20" fill="${textPrimary}" font-size="12" font-weight="600">Monthly volume</text>
        <text x="44" y="38" fill="${textMuted}" font-size="11">Click a month to focus cleanup insights</text>
        ${bars}
      </svg>
    `);

    renderTimelineInsights(messagesInRange, selected ? selected.key : null);

    controls.querySelectorAll("[data-timeline-action]").forEach((btn) => {
      btn.addEventListener("click", () => handleTimelineAction(btn.dataset.timelineAction, btn.dataset.window, months.length));
    });
    container.querySelectorAll(".timeline-month").forEach((el) => {
      el.addEventListener("click", () => {
        const month = el.dataset.month;
        timelineState.selectedMonth = timelineState.selectedMonth === month ? null : month;
        renderTimeline();
      });
    });
    insights.querySelectorAll("[data-select-kind]").forEach((btn) => {
      btn.addEventListener("click", () => selectTimelineInsight(btn, messagesInRange));
    });

    updateBulkButtons();
  }

  function buildTimelineMonths() {
    if (!allMessages.length) return [];
    const byMonth = {};
    allMessages.forEach((m) => {
      const key = monthKey(m);
      if (!byMonth[key]) {
        byMonth[key] = {
          key,
          year: m.year,
          month: m.month,
          date: new Date(m.year, m.month - 1, 1),
          label: `${m.monthName} ${m.year}`,
          shortLabel: `${m.monthName} '${String(m.year).slice(-2)}`,
          messages: [],
          count: 0,
          unread: 0,
        };
      }
      byMonth[key].messages.push(m);
      byMonth[key].count++;
      if (!m.read) byMonth[key].unread++;
    });

    const sorted = Object.values(byMonth).sort((a, b) => a.key.localeCompare(b.key));
    const filled = [];
    let cursor = new Date(sorted[0].date);
    const end = new Date(sorted[sorted.length - 1].date);
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      filled.push(byMonth[key] || {
        key,
        year: cursor.getFullYear(),
        month: cursor.getMonth() + 1,
        date: new Date(cursor),
        label: cursor.toLocaleString("default", { month: "short", year: "numeric" }),
        shortLabel: `${cursor.toLocaleString("default", { month: "short" })} '${String(cursor.getFullYear()).slice(-2)}`,
        messages: [],
        count: 0,
        unread: 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return filled;
  }

  function getVisibleTimelineMonths(months) {
    if (timelineState.windowMonths === null || timelineState.windowMonths >= months.length) return months;
    const size = Math.max(1, Math.min(timelineState.windowMonths, months.length));
    const end = Math.max(size, months.length - timelineState.offsetMonths);
    const start = Math.max(0, end - size);
    return months.slice(start, end);
  }

  function handleTimelineAction(action, windowValue, totalMonths) {
    timelineState.selectedMonth = null;
    if (action === "window") {
      timelineState.windowMonths = windowValue === "all" ? null : Number(windowValue);
      timelineState.offsetMonths = 0;
    } else if (action === "prev" && timelineState.windowMonths !== null) {
      timelineState.offsetMonths = Math.min(Math.max(0, totalMonths - timelineState.windowMonths), timelineState.offsetMonths + timelineState.windowMonths);
    } else if (action === "next" && timelineState.windowMonths !== null) {
      timelineState.offsetMonths = Math.max(0, timelineState.offsetMonths - timelineState.windowMonths);
    } else if (action === "zoom-in") {
      const current = timelineState.windowMonths || totalMonths;
      timelineState.windowMonths = Math.max(3, Math.floor(current / 2));
      timelineState.offsetMonths = 0;
    } else if (action === "zoom-out") {
      const current = timelineState.windowMonths || totalMonths;
      timelineState.windowMonths = Math.min(totalMonths, current * 2);
      if (timelineState.windowMonths >= totalMonths) timelineState.windowMonths = null;
      timelineState.offsetMonths = 0;
    } else if (action === "reset") {
      timelineState.windowMonths = Math.min(24, totalMonths);
      timelineState.offsetMonths = 0;
    }
    renderTimeline();
  }

  function messagesForMonths(months) {
    const keys = new Set(months.map((m) => m.key));
    return allMessages.filter((m) => keys.has(monthKey(m)));
  }

  function monthKey(m) {
    return `${m.year}-${String(m.month).padStart(2, "0")}`;
  }

  function renderTimelineInsights(messages, selectedMonthKey) {
    const insights = $("#timelineInsights");
    const unread = messages.filter((m) => !m.read);
    const total = messages.length;
    const unreadPct = total ? Math.round((unread.length / total) * 100) : 0;

    const topUnreadSenders = groupTimeline(messages.filter((m) => !m.read), (m) => m.senderEmail, (m) => ({
      title: m.senderName || displayEmail(m.senderEmail),
      subtitle: displayEmail(m.senderEmail),
      value: m.senderEmail,
    })).slice(0, 8);

    const ageBuckets = buildAgeBuckets(messages);

    const noisyDomains = groupTimeline(messages, (m) => m.domain, (m) => ({
      title: displayDomain(m.domain),
      subtitle: "domain volume",
      value: m.domain,
    }))
      .map((row) => ({
        ...row,
        unreadCount: row.messages.filter((m) => !m.read).length,
        unreadPct: row.count ? Math.round((row.messages.filter((m) => !m.read).length / row.count) * 100) : 0,
      }))
      .sort((a, b) => (b.unreadCount + b.count * 0.2) - (a.unreadCount + a.count * 0.2))
      .slice(0, 8);

    const folderHotspots = groupTimeline(messages, (m) => `${m.accountId}::${m.folder}`, (m) => ({
      title: m.folder || "(Unknown folder)",
      subtitle: displayAccount(m.account || m.accountId),
      value: m.folder || "",
      accountId: m.accountId,
    })).slice(0, 8);

    setSafeHtml(insights, `
      <div class="timeline-kpis">
        <div class="timeline-kpi"><span>${total.toLocaleString()}</span><label>Emails in range</label></div>
        <div class="timeline-kpi"><span>${unread.length.toLocaleString()}</span><label>Unread</label></div>
        <div class="timeline-kpi"><span>${unreadPct}%</span><label>Unread rate</label></div>
        <div class="timeline-kpi"><span>${new Set(messages.map((m) => m.senderEmail)).size.toLocaleString()}</span><label>Senders</label></div>
      </div>
      <div class="insight-grid">
        ${renderInsightCard("Top Unread Senders", "Prioritize senders creating unread backlog.", topUnreadSenders, "sender")}
        ${renderInsightCard("Old Unread Mail", "Find stale unread groups by age.", ageBuckets, "age")}
        ${renderInsightCard("Noisy Domains", "High-volume domains with cleanup potential.", noisyDomains, "domain")}
        ${renderInsightCard("Folder Hotspots", "Where inbox clutter is concentrated.", folderHotspots, "folder")}
      </div>
      ${selectedMonthKey ? `<div class="timeline-note">Showing insights for ${escHtml(selectedMonthKey)}. Click the month again to return to the visible range.</div>` : ""}
    `);
  }

  function renderInsightCard(title, subtitle, rows, kind) {
    const body = rows.length
      ? rows.map((row) => renderInsightRow(row, kind)).join("")
      : `<div class="insight-empty">No matching messages in this range.</div>`;
    return `
      <section class="insight-card">
        <div class="insight-card-head">
          <h3>${escHtml(title)}</h3>
          <p>${escHtml(subtitle)}</p>
        </div>
        <div class="insight-rows">${body}</div>
      </section>`;
  }

  function renderInsightRow(row, kind) {
    const unreadText = row.unreadCount !== undefined ? ` · ${row.unreadCount.toLocaleString()} unread` : "";
    const pctText = row.unreadPct !== undefined ? ` · ${row.unreadPct}% unread` : "";
    const accountAttr = row.accountId ? ` data-account-id="${escAttr(row.accountId)}"` : "";
    const bucketAttr = row.bucket ? ` data-bucket="${escAttr(row.bucket)}"` : "";
    const value = row.value === undefined ? row.bucket : row.value;
    const allSelected = row.messages.length > 0 && row.messages.every((m) => selectedIds.has(m.id));
    return `
      <div class="insight-row ${allSelected ? "selected" : ""}">
        <div>
          <strong>${escHtml(row.title)}</strong>
          <span>${escHtml(row.subtitle || "")}${unreadText}${pctText}</span>
        </div>
        <div class="insight-row-meta">
          <span>${row.count.toLocaleString()}</span>
          <button type="button" class="btn btn-secondary" data-select-kind="${kind}" data-value="${escAttr(value || "")}"${accountAttr}${bucketAttr}>${allSelected ? "Selected" : "Select"}</button>
        </div>
      </div>`;
  }

  function groupTimeline(messages, keyFn, metaFn) {
    const byKey = {};
    messages.forEach((m) => {
      const key = keyFn(m);
      if (!byKey[key]) byKey[key] = { ...metaFn(m), key, count: 0, messages: [] };
      byKey[key].count++;
      byKey[key].messages.push(m);
    });
    return Object.values(byKey).sort((a, b) => b.count - a.count);
  }

  function buildAgeBuckets(messages) {
    const now = Date.now();
    const buckets = [
      { bucket: "0-30", title: "0-30 days", subtitle: "Recent unread", min: 0, max: 30, messages: [] },
      { bucket: "31-90", title: "31-90 days", subtitle: "Needs review", min: 31, max: 90, messages: [] },
      { bucket: "91-365", title: "91-365 days", subtitle: "Likely stale", min: 91, max: 365, messages: [] },
      { bucket: "1y-plus", title: "1 year+", subtitle: "Old unread backlog", min: 366, max: Infinity, messages: [] },
    ];

    messages.filter((m) => !m.read).forEach((m) => {
      const ageDays = Math.floor((now - new Date(m.date).getTime()) / 86400000);
      const bucket = buckets.find((b) => ageDays >= b.min && ageDays <= b.max);
      if (bucket) bucket.messages.push(m);
    });

    return buckets
      .map((b) => ({ ...b, value: b.bucket, count: b.messages.length }))
      .filter((b) => b.count > 0);
  }

  function selectTimelineInsight(btn, rangeMessages) {
    const kind = btn.dataset.selectKind;
    const value = btn.dataset.value;
    const bucket = btn.dataset.bucket;
    const accountId = btn.dataset.accountId;
    let matches = [];

    if (kind === "sender") {
      matches = rangeMessages.filter((m) => m.senderEmail === value && !m.read);
    } else if (kind === "domain") {
      matches = rangeMessages.filter((m) => m.domain === value);
    } else if (kind === "folder") {
      matches = rangeMessages.filter((m) => m.accountId === accountId && (m.folder || "") === value);
    } else if (kind === "age") {
      matches = messagesForAgeBucket(rangeMessages, bucket || value);
    }

    toggleMessageSelection(matches.map((m) => m.id));
    updateStats();
    renderTimeline();
  }

  function messagesForAgeBucket(messages, bucket) {
    const now = Date.now();
    return messages.filter((m) => {
      if (m.read) return false;
      const ageDays = Math.floor((now - new Date(m.date).getTime()) / 86400000);
      if (bucket === "0-30") return ageDays >= 0 && ageDays <= 30;
      if (bucket === "31-90") return ageDays >= 31 && ageDays <= 90;
      if (bucket === "91-365") return ageDays >= 91 && ageDays <= 365;
      if (bucket === "1y-plus") return ageDays >= 366;
      return false;
    });
  }

  function toggleMessageSelection(ids) {
    if (!ids.length) return;
    const allSelected = ids.every((id) => selectedIds.has(id));
    ids.forEach((id) => {
      if (allSelected) selectedIds.delete(id);
      else selectedIds.add(id);
    });
  }

  // ══════════════════════════════════════════
  //  SELECTION REVIEW
  // ══════════════════════════════════════════
  function showSelectionReviewModal() {
    if (selectedIds.size === 0) return;
    const modal = $("#selectionReviewModal");
    modal.style.display = "flex";
    renderSelectionReview();

    $("#selectionReviewClose").onclick = () => { modal.style.display = "none"; };
    $("#selectionReviewClear").onclick = () => {
      selectedIds.clear();
      modal.style.display = "none";
      updateStats();
      switchView(currentView);
    };
    $("#selectionReviewTrash").onclick = () => {
      modal.style.display = "none";
      showDeleteModal();
    };
    $("#selectionReviewFolder").onclick = () => {
      modal.style.display = "none";
      showMoveFolderModal();
    };
    $("#selectionReviewExport").onclick = () => {
      exportSelectedCSV();
    };
  }

  function renderSelectionReview() {
    const selected = getReviewedSelectedMessages();
    const table = $("#selectionReviewTable");
    const totalBytes = selected.reduce((sum, m) => sum + messageSize(m), 0);
    const unread = selected.filter((m) => !m.read).length;
    const accounts = new Set(selected.map((m) => m.account || m.accountId));

    $("#selectionReviewSummary").textContent =
      `${selectedIds.size.toLocaleString()} selected · ${unread.toLocaleString()} unread · ${formatBytes(totalBytes)} known size · ${accounts.size} account${accounts.size === 1 ? "" : "s"}`;

    const search = $("#selectionReviewSearch");
    const sort = $("#selectionReviewSort");
    search.value = reviewState.query;
    sort.value = reviewState.sort;
    search.oninput = () => {
      reviewState.query = search.value;
      renderSelectionReview();
    };
    sort.onchange = () => {
      reviewState.sort = sort.value;
      renderSelectionReview();
    };

    $("#selectionReviewUnselectMatches").disabled = selected.length === 0;
    $("#selectionReviewUnselectMatches").textContent = `Unselect Matches (${selected.length.toLocaleString()})`;
    $("#selectionReviewUnselectMatches").onclick = () => {
      selected.forEach((m) => removeSelectedId(String(m.id)));
      updateStats();
      if (selectedIds.size === 0) {
        $("#selectionReviewModal").style.display = "none";
        switchView(currentView);
      } else {
        renderSelectionReview();
        switchView(currentView);
        $("#selectionReviewModal").style.display = "flex";
      }
    };

    if (selectedIds.size === 0) {
      setSafeHtml(table, `<div class="selection-empty">No messages selected.</div>`);
      $("#selectionReviewTrash").disabled = true;
      $("#selectionReviewFolder").disabled = true;
      return;
    }

    $("#selectionReviewTrash").disabled = false;
    $("#selectionReviewFolder").disabled = false;

    if (selected.length === 0) {
      setSafeHtml(table, `<div class="selection-empty">No selected messages match your search.</div>`);
      return;
    }

    const visible = selected.slice(0, 500);
    setSafeHtml(table, `
      <div class="selection-review-table-head">
        <span>Subject</span><span>Sender</span><span>Date</span><span>Size</span><span></span>
      </div>
      ${visible.map((m) => `
        <div class="selection-review-row" data-id="${escAttr(String(m.id))}">
          <div class="selection-subject">
            <strong>${escHtml(m.subject || "(No Subject)")}</strong>
            <span>${escHtml(m.folder || "Unknown folder")} · ${escHtml(displayAccount(m.account || ""))}</span>
          </div>
          <div class="selection-sender">
            <strong>${escHtml(m.senderName || displayEmail(m.senderEmail))}</strong>
            <span>${escHtml(displayEmail(m.senderEmail) || "")}</span>
          </div>
          <div class="selection-date">${escHtml(formatDate(m.date))}</div>
          <div class="selection-size">${formatBytes(messageSize(m))}</div>
          <button type="button" class="btn btn-secondary selection-unselect-btn" data-review-remove="${escAttr(String(m.id))}">
            <span aria-hidden="true">×</span> Unselect
          </button>
        </div>`).join("")}
      ${selected.length > visible.length ? `<div class="selection-review-more">Showing first ${visible.length.toLocaleString()} of ${selected.length.toLocaleString()} matches. Narrow with search to inspect more.</div>` : ""}
    `);

    table.querySelectorAll("[data-review-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        removeSelectedId(btn.dataset.reviewRemove);
        updateStats();
        if (selectedIds.size === 0) {
          $("#selectionReviewModal").style.display = "none";
          switchView(currentView);
        } else {
          renderSelectionReview();
          switchView(currentView);
          $("#selectionReviewModal").style.display = "flex";
        }
      });
    });
  }

  function removeSelectedId(rawId) {
    selectedIds.delete(rawId);
    const numericId = Number(rawId);
    if (!Number.isNaN(numericId)) selectedIds.delete(numericId);
  }

  function getReviewedSelectedMessages() {
    const q = reviewState.query.trim().toLowerCase();
    let selected = allMessages.filter((m) => selectedIds.has(m.id));
    if (q) selected = selected.filter((m) => matchesReviewQuery(m, q));

    const sort = reviewState.sort;
    selected.sort((a, b) => {
      if (sort === "date-asc") return new Date(a.date) - new Date(b.date);
      if (sort === "size-desc") return messageSize(b) - messageSize(a);
      if (sort === "sender-asc") return (a.senderEmail || "").localeCompare(b.senderEmail || "");
      if (sort === "subject-asc") return (a.subject || "").localeCompare(b.subject || "");
      return new Date(b.date) - new Date(a.date);
    });
    return selected;
  }

  function matchesReviewQuery(m, q) {
    return (
      (m.subject || "").toLowerCase().includes(q) ||
      (m.senderName || "").toLowerCase().includes(q) ||
      (m.senderEmail || "").toLowerCase().includes(q) ||
      (m.domain || "").toLowerCase().includes(q) ||
      (m.folder || "").toLowerCase().includes(q) ||
      (m.account || "").toLowerCase().includes(q)
    );
  }

  // ══════════════════════════════════════════
  //  DELETE (modal-based)
  // ══════════════════════════════════════════
  function showDeleteModal() {
    const count = selectedIds.size;
    const senders = new Set();
    allMessages.forEach((m) => { if (selectedIds.has(m.id)) senders.add(m.senderEmail); });

    setSafeHtml($("#deleteModalText"), `
      You're about to move <strong>${count.toLocaleString()} email(s)</strong> from
      <strong>${senders.size} sender(s)</strong> to Trash.
    `);

    const modal = $("#deleteModal");
    modal.style.display = "flex";

    $("#modalCancel").onclick = () => { modal.style.display = "none"; };
    $("#modalConfirm").onclick = async () => {
      modal.style.display = "none";
      $("#progressArea").style.display = "block";
      $("#progressText").textContent = `Moving ${count} emails to Trash…`;
      $("#progressFill").style.width = "30%";

      try {
        const result = await browser.runtime.sendMessage({
          action: "deleteMessages",
          messageIds: Array.from(selectedIds),
        });

        if (result && result.success) {
          const movedIds = Array.isArray(result.movedIds) ? result.movedIds : Array.from(selectedIds);
          const movedSet = new Set(movedIds);
          allMessages = allMessages.filter((m) => !movedSet.has(m.id));
          movedIds.forEach((id) => selectedIds.delete(id));
          updateStats();
          $("#progressFill").style.width = "100%";
          $("#progressText").textContent = result.count === result.total
            ? `Done — moved ${result.count} of ${result.total} to Trash.`
            : `Partial — moved ${result.count} of ${result.total} to Trash. Review remaining selections.`;
          if (result.errors) {
            console.warn("Some batches had errors:", result.errors);
          }
          setTimeout(() => {
            $("#progressArea").style.display = "none";
            switchView(currentView);
          }, 1500);
        } else {
          const msg = result?.error || result?.errors?.[0] || "Could not move selected messages to Trash.";
          $("#progressText").textContent = `Error: ${msg}`;
        }
      } catch (e) {
        $("#progressText").textContent = `Error: ${e.message}`;
      }
    };
  }

  // ══════════════════════════════════════════
  //  MOVE TO FOLDER (modal + background)
  // ══════════════════════════════════════════
  async function showMoveFolderModal() {
    const totalSel = selectedIds.size;
    if (totalSel === 0) return;

    const selectedMsgs = allMessages.filter((m) => selectedIds.has(m.id));
    const accountIds = [...new Set(selectedMsgs.map((m) => m.accountId))];

    const modal = $("#folderModal");
    const select = $("#folderModalSelect");
    const confirmBtn = $("#folderModalConfirm");

    setSafeHtml($("#folderModalText"),
      accountIds.length > 1
        ? `You have <strong>${totalSel.toLocaleString()} email(s)</strong> selected across <strong>${accountIds.length} accounts</strong>. Pick a destination folder — only messages that belong to that account will be moved.`
        : `You are moving <strong>${totalSel.toLocaleString()} email(s)</strong>. Pick a destination folder under <strong>${escHtml(displayAccount(selectedMsgs[0].account))}</strong>.`);

    clearElement(select);
    confirmBtn.disabled = true;
    modal.style.display = "flex";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Loading folders…";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);

    try {
      for (const aid of accountIds) {
        const folders = await browser.runtime.sendMessage({ action: "listFolders", accountId: aid });
        const acctName = selectedMsgs.find((m) => m.accountId === aid)?.account || aid;
        const og = document.createElement("optgroup");
        og.label = displayAccount(acctName);
        let n = 0;
        folders.forEach((f) => {
          const opt = document.createElement("option");
          opt.textContent = displayAccount(f.displayPath);
          opt.dataset.accountId = f.accountId;
          opt.dataset.folderPath = f.path;
          og.appendChild(opt);
          n++;
        });
        if (n === 0) {
          const opt = document.createElement("option");
          opt.disabled = true;
          opt.textContent = "(No folders)";
          og.appendChild(opt);
        }
        select.appendChild(og);
      }
    } catch (e) {
      clearElement(select);
      const err = document.createElement("option");
      err.textContent = `Could not load folders: ${e.message}`;
      err.disabled = true;
      select.appendChild(err);
    }

    if (placeholder.parentNode === select) select.removeChild(placeholder);

    const firstReal = select.querySelector("option[data-folder-path]");
    if (firstReal) {
      firstReal.selected = true;
      confirmBtn.disabled = false;
    }

    select.onchange = () => {
      const opt = select.selectedOptions[0];
      confirmBtn.disabled = !(opt && opt.dataset.folderPath);
    };

    $("#folderModalCancel").onclick = () => { modal.style.display = "none"; };

    $("#folderModalConfirm").onclick = async () => {
      const opt = select.selectedOptions[0];
      if (!opt || !opt.dataset.folderPath) return;

      const accountId = opt.dataset.accountId;
      const folderPath = opt.dataset.folderPath;
      const idsToMove = allMessages
        .filter((m) => selectedIds.has(m.id) && m.accountId === accountId)
        .map((m) => m.id);

      modal.style.display = "none";

      if (idsToMove.length === 0) {
        alert("None of the selected messages belong to the account for that folder. Pick a folder under another account or adjust your selection.");
        return;
      }

      $("#progressArea").style.display = "block";
      $("#progressText").textContent = `Moving ${idsToMove.length} message(s)…`;
      $("#progressFill").style.width = "30%";

      try {
        const result = await browser.runtime.sendMessage({
          action: "moveMessagesToFolder",
          messageIds: idsToMove,
          accountId,
          folderPath,
        });

        if (result && result.success) {
          const movedIds = Array.isArray(result.movedIds) ? result.movedIds : idsToMove;
          const movedSet = new Set(movedIds);
          allMessages = allMessages.filter((m) => !movedSet.has(m.id));
          movedIds.forEach((id) => selectedIds.delete(id));
          updateStats();
          $("#progressFill").style.width = "100%";
          $("#progressText").textContent = result.count === result.total
            ? `Done — moved ${result.count} of ${result.total} message(s).`
            : `Partial — moved ${result.count} of ${result.total} message(s). Review remaining selections.`;
          if (result.errors) console.warn("Some batches had errors:", result.errors);
          setTimeout(() => {
            $("#progressArea").style.display = "none";
            switchView(currentView);
          }, 1500);
        } else {
          const msg = result?.error || result?.errors?.[0] || "Move failed";
          $("#progressText").textContent = `Error: ${msg}`;
        }
      } catch (e) {
        $("#progressText").textContent = `Error: ${e.message}`;
      }
    };
  }

  // ══════════════════════════════════════════
  //  EXPORT
  // ══════════════════════════════════════════
  function exportCSV() {
    const header = "Sender Email,Sender Name,Domain,Subject,Date,Year,Month,Read,Folder,Account\n";
    const rows = allMessages.map((m) =>
      [m.senderEmail, m.senderName, m.domain, `"${(m.subject || '').replace(/"/g, '""')}"`, m.date, m.year, m.monthName, m.read, m.folder, m.account].join(",")
    ).join("\n");
    downloadFile(header + rows, "mail-audit-report.csv", "text/csv");
  }

  function exportJSON() {
    const bySender = groupBy("senderEmail");
    const report = Object.entries(bySender).map(([email, msgs]) => ({
      email,
      name: msgs[0].senderName,
      domain: msgs[0].domain,
      count: msgs.length,
      unread: msgs.filter((m) => !m.read).length,
      oldest: msgs.reduce((a, m) => (new Date(m.date) < new Date(a.date) ? m : a)).date,
      newest: msgs.reduce((a, m) => (new Date(m.date) > new Date(a.date) ? m : a)).date,
    })).sort((a, b) => b.count - a.count);
    downloadFile(JSON.stringify(report, null, 2), "mail-audit-report.json", "application/json");
  }

  function exportSelectedCSV() {
    const selected = getReviewedSelectedMessages();
    if (selected.length === 0) {
      alert("No selected messages to export.");
      return;
    }
    const header = "Subject,Sender Name,Sender Email,Domain,Date,Size (bytes),Read,Folder,Account\n";
    const rows = selected.map((m) =>
      [
        `"${(m.subject || '').replace(/"/g, '""')}"`,
        `"${(m.senderName || '').replace(/"/g, '""')}"`,
        m.senderEmail || "",
        m.domain || "",
        m.date || "",
        messageSize(m),
        m.read ? "Yes" : "No",
        `"${(m.folder || '').replace(/"/g, '""')}"`,
        `"${(m.account || "").replace(/"/g, '""')}"`,
      ].join(",")
    ).join("\n");
    const timestamp = new Date().toISOString().slice(0, 10);
    downloadFile(header + rows, `inboxpie-selected-${timestamp}.csv`, "text/csv");
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ══════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════
  function groupBy(key) {
    const g = {};
    allMessages.forEach((m) => { const k = m[key]; if (!g[k]) g[k] = []; g[k].push(m); });
    return g;
  }

  function messageSize(m) {
    return Number(m.size) > 0 ? Number(m.size) : 0;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function formatDate(dateValue) {
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return "Unknown date";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function ageDays(dateValue) {
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  }

  function senderYearKey(email, year) {
    return `${email}::${year}`;
  }

  function clearElement(el) {
    if (el) el.replaceChildren();
  }

  function setSafeHtml(el, html) {
    if (!el) return;
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    el.replaceChildren(...Array.from(doc.body.childNodes));
  }

  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function escAttr(s) { return (s || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

  init();
})();
