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
  /** Raw (unmasked) domain/sender set by clicking a pie slice; exact-matches the table, keeping the visible search box masked. */
  let domainChartFilterValue = null;
  let senderChartFilterValue = null;

  const timelineState = {
    windowMonths: 24,
    offsetMonths: 0,
    selectedMonth: null,
  };
  const reviewState = {
    query: "",
    sort: "date-desc",
  };
  /** IDs (as strings) checked via the checkbox column in the Review Selected modal. Reset to "all checked" whenever the modal opens or a bulk action runs. */
  let reviewCheckedIds = new Set();
  /** Virtual scroll tuning for the selection review table — must match .selection-review-row height in CSS. */
  const SR_ROW_HEIGHT = 54;
  const SR_VIRTUAL_BUFFER = 8;
  const browseState = {
    query: "",
    sort: "date-desc",
  };
  let privacyMaskEnabled = false;
  const DEFAULT_FOLDER_TYPES = ["inbox"];
  /** Selected scan folders as `${accountId}::${path}` keys. */
  let selectedFolderKeys = new Set();
  let scanFolderList = [];
  let folderListLoaded = false;
  /** True only once the folder checkboxes have actually been painted into #folderDropdownList — distinct from folderListLoaded, which can become true via a background fetch (e.g. right after switching accounts) with no checkboxes in the DOM at all. */
  let folderDropdownRendered = false;
  /** Scan date-range filter: { fromYear, fromMonth, toYear, toMonth } (1-indexed months), or null for all time. */
  let scanDateRange = null;
  /** Last domain drill-down shown under PieView (for refresh on privacy toggle). */
  let sunburstDetailState = null;
  
  /** Filter folders for view rendering (subset of scanned data). Empty = show all. */
  let viewFilterFolderKeys = new Set();
  /** Folders present in current scan results (for filter dropdown). */
  let scannedFolderList = [];

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
    // Version badge reads straight from manifest.json so it can't silently drift out of sync on future releases.
    const versionBadge = $(".version-badge");
    if (versionBadge && browser?.runtime?.getManifest) {
      versionBadge.textContent = `v${browser.runtime.getManifest().version}`;
    }

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

    $("#resetBtn").addEventListener("click", () => {
      if (allMessages.length > 0 || selectedIds.size > 0) {
        const ok = confirm(
          "Reset the dashboard? Scan results and selections will be cleared so you can choose folders and scan again."
        );
        if (!ok) return;
      }
      resetDashboard();
    });

    // Privacy mask toggle
    $("#privacyToggle").addEventListener("click", () => {
      privacyMaskEnabled = !privacyMaskEnabled;
      localStorage.setItem("mail-audit-privacy-mask", privacyMaskEnabled);
      updatePrivacyToggle();
      updateAccountSelectDisplay();
      const folderDropdown = $("#folderDropdown");
      if (folderDropdown?.style.display === "block") {
        if (isViewFilterMode()) renderViewFilterDropdown();
        else renderScanFolderDropdown();
      } else if (isViewFilterMode()) {
        updateViewFilterLabel();
      }
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

    // Floating selection bar — follows the user around the app and opens the review modal
    $("#floatingSelectionBar").addEventListener("click", () => {
      if (selectedIds.size > 0) showSelectionReviewModal();
    });
    $("#floatingSelectionReviewBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectedIds.size > 0) showSelectionReviewModal();
    });
    $("#floatingSelectionResetBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectedIds.size > 0) clearSelection();
    });

    // Folder selection
    initFolderSelection();

    // Scan date range
    initDateRangeSelection();

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
    updateAccountSelectActiveState();

    scanBtn.addEventListener("click", startScan);
    accountSelect.addEventListener("change", () => {
      updateAccountSelectActiveState();
      resetDashboard();
      // Proactively load this account's folders and apply the default selection so the
      // Folders button shows the real (active, correctly-counted) state immediately —
      // not just once the user happens to open the dropdown or click Scan.
      loadScanFolders().catch((e) => console.warn("Could not load folders for account:", e));
    });
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => switchView(t.dataset.view))
    );

    // Export buttons
    $("#exportCsvBtn").addEventListener("click", exportCSV);
    $("#exportJsonBtn").addEventListener("click", exportJSON);
    $("#contactsExportCsvBtn").addEventListener("click", exportContactsCSV);
    $("#contactsExportJsonBtn").addEventListener("click", exportContactsJSON);

    $("#selectionReviewTable").addEventListener("click", (e) => {
      const link = e.target.closest("[data-open-message]");
      if (!link) return;
      e.preventDefault();
      openMessageInThunderbird(link.getAttribute("data-open-message"));
    });

    $("#browseTable").addEventListener("click", (e) => {
      const link = e.target.closest("[data-open-message]");
      if (!link) return;
      e.preventDefault();
      openMessageInThunderbird(link.getAttribute("data-open-message"));
    });

    $("#app").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const act = btn.getAttribute("data-action");
      if (act === "bulk-review") {
        e.preventDefault();
        showSelectionReviewModal();
      }
    });

    // Per-page tip banners — dismissed state persists (per tip id) across sessions.
    initTipBanners();
    $("#app").addEventListener("click", (e) => {
      const closeBtn = e.target.closest("[data-tip-close]");
      if (!closeBtn) return;
      const tipId = closeBtn.dataset.tipClose;
      localStorage.setItem(`inboxpie-tip-dismissed-${tipId}`, "true");
      const banner = closeBtn.closest(".tip-banner");
      if (banner) banner.style.display = "none";
    });

    // Scan progress listener. deleteProgress/moveProgress are handled locally by
    // showDeleteModal()/showMoveFolderModal() so their in-modal pie ring can update live.
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.action === "progress") {
        $("#progressText").textContent = `Scanned ${msg.count.toLocaleString()} messages…`;
        $("#progressFill").style.width = "60%";
      }
    });

    // Tab bar horizontal scroll (small screens / lots of tabs) — fade-edge arrows
    // only appear once the tab row actually overflows its container.
    const tabsScrollEl = $("#viewTabs");
    $("#tabsScrollLeft").addEventListener("click", () => {
      tabsScrollEl.scrollBy({ left: -160, behavior: "smooth" });
    });
    $("#tabsScrollRight").addEventListener("click", () => {
      tabsScrollEl.scrollBy({ left: 160, behavior: "smooth" });
    });
    let tabsScrollRafPending = false;
    tabsScrollEl.addEventListener("scroll", () => {
      if (tabsScrollRafPending) return;
      tabsScrollRafPending = true;
      requestAnimationFrame(() => { tabsScrollRafPending = false; updateTabsScrollState(); });
    });
    window.addEventListener("resize", updateTabsScrollState);

    // Sunburst zoom reset
    $("#sunburstResetBtn").addEventListener("click", () => {
      const chartHost = $("#sunburstChart");
      const chart = chartHost && chartHost.querySelector(".chart-host")?._echartsInstance;
      if (chart) chart.dispatchAction({ type: "restore" });
    });

    // Guided tour
    $("#tourHelpBtn").addEventListener("click", startTour);
    $("#tourNextBtn").addEventListener("click", advanceTour);
    $("#tourBackBtn").addEventListener("click", rewindTour);
    $("#tourSkipBtn").addEventListener("click", endTour);
    window.addEventListener("resize", () => {
      if ($("#tourOverlay").style.display !== "none") positionTourStep();
    });
    if (localStorage.getItem("mail-audit-tour-completed") !== "true") {
      setTimeout(startTour, 500);
    }

    // Support popover — scheduled once the user has actually scanned and spent some time
    // in the app (see scan-completion handler below), not on cold page load.
    $("#supportPopoverClose").addEventListener("click", () => {
      $("#supportPopover").style.display = "none";
      sessionStorage.setItem("inboxpie-support-dismissed", "true");
    });
  }

  // ══════════════════════════════════════════
  //  GUIDED TOUR
  // ══════════════════════════════════════════
  // Pre-scan: shown on the landing screen, walks through how to start a scan.
  const GETTING_STARTED_TOUR_STEPS = [
    {
      target: "#accountSelect",
      title: "Select your email account",
      text: "Choose which mail account InboxPie should analyze, or leave it on “All Accounts” to scan everything at once.",
    },
    {
      target: "#folderSelectBtn",
      title: "Choose folders",
      text: "Pick specific folders to scan, or keep the default selection to cover your whole mailbox.",
    },
    {
      target: "#scanBtn",
      title: "Scan your mailbox",
      text: "Click Scan Mailbox to start. InboxPie reads only metadata — sender, subject, size, date — never your email content.",
    },
    {
      target: "#privacyToggle",
      title: "Privacy mode (optional)",
      text: "Presenting or sitting with someone else? Click the eye icon to mask sender emails and domains before they're shown on screen.",
    },
    {
      target: "#githubLink",
      title: "Enjoying InboxPie?",
      text: "If InboxPie helped you clean up your inbox, consider starring the project on GitHub or leaving a review in the Thunderbird Add-ons community — it really helps!",
    },
  ];

  // Post-scan: shown once results are in, walks through what each tab does.
  const APP_TOUR_STEPS = [
    {
      target: '.tab[data-view="sunburst"]',
      title: "PieView — the big picture",
      text: "A sunburst of your mailbox: Year → Month → Domain. Click a ring to zoom in, click a domain to see exactly who's emailing you from it.",
    },
    {
      target: '.tab[data-view="sender"]',
      title: "By Sender",
      text: "Every sender ranked by volume, with a year/month breakdown per sender. Select and bulk move or trash straight from here.",
    },
    {
      target: '.tab[data-view="domain"]',
      title: "By Domain",
      text: "The same idea grouped by sending domain — handy for spotting newsletter or notification domains worth unsubscribing from in bulk.",
    },
    {
      target: '.tab[data-view="size"]',
      title: "By Size",
      text: "Find what's eating your mailbox storage: size buckets, the heaviest senders and domains, and old large messages worth clearing out.",
    },
    {
      target: '.tab[data-view="timeline"]',
      title: "Timeline",
      text: "Monthly email volume over time. Click a month to focus the cleanup insights below on just that period.",
    },
    {
      target: '.tab[data-view="subscriptions"]',
      title: "Subscriptions",
      text: "Recurring senders and newsletters, auto-detected with a frequency breakdown (daily, weekly, monthly...).",
    },
    {
      target: '.tab[data-view="categories"]',
      title: "Categories",
      text: "Emails auto-sorted into smart categories like Finance, Shopping, and Travel, each with its own sender chart.",
    },
    {
      target: '.tab[data-view="contacts"]',
      title: "Contacts",
      text: "Every unique sender as a searchable contact card, grouped A–Z. Export the list to CSV or JSON whenever you need it.",
    },
    {
      target: '.tab[data-view="settings"]',
      title: "Settings",
      text: "Manage your categories here — edit keywords, add your own categories, or remove ones you don't need.",
    },
  ];

  // Review Selected modal: walks through search/sort, the checkbox selection engine, and every action button.
  const REVIEW_TOUR_STEPS = [
    {
      target: "#selectionReviewSearch",
      title: "Search within your selection",
      text: "Narrow the list down to a subject, sender, or folder. Everything below — including the action buttons — reacts to what's currently matched.",
    },
    {
      target: "#selectionReviewSort",
      title: "Sort the list",
      text: "Reorder by date, size, sender, or subject to make it easier to spot what you're looking for.",
    },
    {
      target: "#selectionReviewSelectAllVisible",
      title: "Select all",
      text: "Ticks or unticks every matched row — including ones you'd have to scroll to see. Rows start checked by default — everything you selected is included unless you uncheck it.",
    },
    {
      target: ".selection-row-checkbox",
      title: "Per-row checkbox",
      text: "Uncheck individual emails you want to spare from whatever bulk action you're about to run — without losing them from your overall selection permanently.",
    },
    {
      target: "#selectionReviewExcludeMatches",
      title: "Exclude checked",
      text: "Removes every checked, currently-matched email from your selection. Nothing is deleted or moved — it just drops out of the review list.",
    },
    {
      target: "#selectionReviewKeepOnlyMatches",
      title: "Keep only checked",
      text: "The opposite: keeps just the checked, matched emails in your selection and drops everything else. Handy after a search — narrow down, then prune the rest away.",
    },
    {
      target: "#selectionReviewExport",
      title: "Export CSV",
      text: "Save the checked, matched emails to a CSV file for your records before taking any action.",
    },
    {
      target: "#selectionReviewFolder",
      title: "Move to Folder",
      text: "Moves only the checked, matched emails to a folder you choose. The count on the button always reflects exactly what will move.",
    },
    {
      target: "#selectionReviewTrash",
      title: "Move to Trash",
      text: "Moves the checked, matched emails to Trash — not permanently deleted. You can recover them from Trash afterward if needed.",
    },
  ];

  let activeTourSteps = GETTING_STARTED_TOUR_STEPS;
  let activeTourFlag = "mail-audit-tour-completed";
  let tourStepIndex = 0;

  /** Support popover: only offered once the user has scanned and spent ~30s actually using the app — not on cold load. One timer per tab session. */
  let supportPopoverScheduled = false;
  function scheduleSupportPopover() {
    if (supportPopoverScheduled) return;
    if (sessionStorage.getItem("inboxpie-support-dismissed") === "true") return;
    supportPopoverScheduled = true;
    setTimeout(() => {
      if (sessionStorage.getItem("inboxpie-support-dismissed") === "true") return;
      const popover = $("#supportPopover");
      if (popover) popover.style.display = "block";
    }, 30000);
  }

  /** Hide any per-page tip banners the user already dismissed in a previous session (localStorage — permanent, unlike the session-scoped support popover). */
  function initTipBanners() {
    document.querySelectorAll(".tip-banner[data-tip-id]").forEach((banner) => {
      if (localStorage.getItem(`inboxpie-tip-dismissed-${banner.dataset.tipId}`) === "true") {
        banner.style.display = "none";
      }
    });
  }

  function startTour() {
    const isPostScan = allMessages.length > 0;
    const steps = isPostScan ? APP_TOUR_STEPS : GETTING_STARTED_TOUR_STEPS;
    const flag = isPostScan ? "mail-audit-app-tour-completed" : "mail-audit-tour-completed";
    startCustomTour(steps, flag);
  }

  function startReviewTour() {
    startCustomTour(REVIEW_TOUR_STEPS, "mail-audit-review-tour-completed");
  }

  function startCustomTour(steps, flag) {
    activeTourSteps = steps;
    activeTourFlag = flag;
    tourStepIndex = 0;
    $("#tourOverlay").style.display = "block";
    renderTourStep();
  }

  function endTour() {
    $("#tourOverlay").style.display = "none";
    localStorage.setItem(activeTourFlag, "true");
  }

  function advanceTour() {
    if (tourStepIndex >= activeTourSteps.length - 1) {
      endTour();
      return;
    }
    tourStepIndex++;
    renderTourStep();
  }

  function rewindTour() {
    if (tourStepIndex === 0) return;
    tourStepIndex--;
    renderTourStep();
  }

  function renderTourStep() {
    const step = activeTourSteps[tourStepIndex];
    const target = document.querySelector(step.target);
    if (!target) {
      // Target not present in this build; skip to the next step defensively.
      advanceTour();
      return;
    }

    $("#tourStepLabel").textContent = `Step ${tourStepIndex + 1} of ${activeTourSteps.length}`;
    $("#tourTitle").textContent = step.title;
    $("#tourText").textContent = step.text;
    setSafeHtml($("#tourDots"), activeTourSteps
      .map((_, i) => `<span class="tour-dot ${i === tourStepIndex ? "active" : ""}"></span>`)
      .join(""));
    $("#tourBackBtn").style.visibility = tourStepIndex === 0 ? "hidden" : "visible";
    $("#tourNextBtn").textContent = tourStepIndex === activeTourSteps.length - 1 ? "Finish" : "Next";

    positionTourStep();
  }

  function positionTourStep() {
    const step = activeTourSteps[tourStepIndex];
    const target = document.querySelector(step.target);
    const spotlight = $("#tourSpotlight");
    const popover = $("#tourPopover");
    if (!target || !spotlight || !popover) return;

    const rect = target.getBoundingClientRect();
    const pad = 6;
    spotlight.style.top = `${rect.top - pad}px`;
    spotlight.style.left = `${rect.left - pad}px`;
    spotlight.style.width = `${rect.width + pad * 2}px`;
    spotlight.style.height = `${rect.height + pad * 2}px`;

    const popW = popover.offsetWidth || 320;
    const popH = popover.offsetHeight || 160;
    let top = rect.bottom + 14;
    if (top + popH > window.innerHeight - 12) top = Math.max(12, rect.top - popH - 14);
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - popW - 12);
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  /** Toggles the fade-edge scroll arrows on the tab bar based on actual overflow/scroll position. */
  function updateTabsScrollState() {
    const wrap = $("#viewTabsWrap");
    const tabs = $("#viewTabs");
    if (!wrap || !tabs || wrap.style.display === "none") return;
    const maxScroll = tabs.scrollWidth - tabs.clientWidth;
    wrap.classList.toggle("can-scroll-left", tabs.scrollLeft > 2);
    wrap.classList.toggle("can-scroll-right", tabs.scrollLeft < maxScroll - 2);
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

  function maskFolderName(name) {
    if (!name || typeof name !== "string") return name || "";
    const trimmed = name.trim();
    if (!trimmed) return name;
    if (looksLikeEmail(trimmed)) return maskEmail(trimmed);
    if (looksLikeDomain(trimmed)) return maskDomain(trimmed);
    if (trimmed.length <= 1) return `${trimmed}***`;
    return `${trimmed.charAt(0)}***`;
  }

  function maskFolderPath(path) {
    if (!path || typeof path !== "string") return path || "";
    return path.split("/").map((segment) => maskFolderName(segment)).join("/");
  }

  function displayFolderName(name, path) {
    const leaf = name || (path ? path.split("/").pop() : "") || "";
    if (!privacyMaskEnabled) return leaf;
    return leaf ? maskFolderName(leaf) : "";
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
  function folderKey(accountId, path) {
    return `${accountId}::${path}`;
  }

  function parseFolderKey(key) {
    const idx = key.indexOf("::");
    return { accountId: key.slice(0, idx), path: key.slice(idx + 2) };
  }

  function loadSavedFolderSelections() {
    const saved = localStorage.getItem("mail-audit-folder-selections");
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        selectedFolderKeys = new Set(parsed);
      }
    } catch (e) {
      console.warn("Could not parse saved folder selections:", e);
    }
  }

  function saveFolderSelections() {
    localStorage.setItem("mail-audit-folder-selections", JSON.stringify(Array.from(selectedFolderKeys)));
  }

  function getLegacyFolderTypes() {
    const saved = localStorage.getItem("mail-audit-folder-types");
    if (!saved) return [...DEFAULT_FOLDER_TYPES];
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
      console.warn("Could not parse saved folder types:", e);
    }
    return [...DEFAULT_FOLDER_TYPES];
  }

  function applyDefaultFolderSelections() {
    const types = getLegacyFolderTypes();
    const typeMatches = new Set();
    for (const folder of scanFolderList) {
      if (types.includes(folder.type)) {
        typeMatches.add(folderKey(folder.accountId, folder.path));
      }
    }
    selectedFolderKeys.clear();
    for (const folder of scanFolderList) {
      const key = folderKey(folder.accountId, folder.path);
      if (typeMatches.has(key)) {
        selectedFolderKeys.add(key);
        continue;
      }
      for (const matchKey of typeMatches) {
        const { accountId, path } = parseFolderKey(matchKey);
        if (folder.accountId === accountId && folder.path.startsWith(`${path}/`)) {
          selectedFolderKeys.add(key);
          break;
        }
      }
    }
    if (selectedFolderKeys.size === 0) {
      const inbox = scanFolderList.find((f) => f.type === "inbox");
      if (inbox) selectedFolderKeys.add(folderKey(inbox.accountId, inbox.path));
    }
    saveFolderSelections();
    updateFolderBadge();
  }

  function syncFolderSelectionsToList() {
    const validKeys = new Set(scanFolderList.map((f) => folderKey(f.accountId, f.path)));
    selectedFolderKeys = new Set(Array.from(selectedFolderKeys).filter((key) => validKeys.has(key)));
    if (selectedFolderKeys.size === 0) applyDefaultFolderSelections();
    updateFolderBadge();
  }

  async function loadScanFolders() {
    const acctVal = accountSelect.value;
    const accountId = acctVal === "all" ? null : acctVal;
    scanFolderList = await browser.runtime.sendMessage({ action: "listFoldersForScan", accountId });
    folderListLoaded = true;
    syncFolderSelectionsToList();
  }

  function isViewFilterMode() {
    return allMessages.length > 0;
  }

  function getFolderCheckboxes() {
    const list = $("#folderDropdownList");
    if (!list) return [];
    if (isViewFilterMode()) {
      return list.querySelectorAll('input[type="checkbox"][data-filterable="true"]');
    }
    return list.querySelectorAll('input[type="checkbox"]');
  }

  function syncSelectedFoldersFromDom() {
    const checkboxes = $("#folderDropdownList")?.querySelectorAll('input[type="checkbox"]') || [];
    selectedFolderKeys.clear();
    checkboxes.forEach((cb) => {
      if (cb.checked) selectedFolderKeys.add(cb.value);
    });
    saveFolderSelections();
    updateFolderBadge();
  }

  function getScannedFolderKeys() {
    return new Set(scannedFolderList.map((f) => folderKey(f.accountId, f.path)));
  }

  function getUnscannedFolderList() {
    const scannedKeys = getScannedFolderKeys();
    return scanFolderList.filter((f) => !scannedKeys.has(folderKey(f.accountId, f.path)));
  }

  async function ensureScanFolderListLoaded() {
    if (!folderListLoaded) await loadScanFolders();
  }

  function appendFolderSectionHeader(list, title, note) {
    const hdr = document.createElement("div");
    hdr.className = "folder-dropdown-section";
    hdr.textContent = title;
    if (note) {
      const noteEl = document.createElement("div");
      noteEl.className = "folder-dropdown-section-note";
      noteEl.textContent = note;
      hdr.appendChild(noteEl);
    }
    list.appendChild(hdr);
  }

  function appendAccountHeader(list, accountName, showAccountGroups, lastAccountIdRef, accountId) {
    if (!showAccountGroups || accountId === lastAccountIdRef.value) return;
    lastAccountIdRef.value = accountId;
    const hdr = document.createElement("div");
    hdr.className = "folder-dropdown-account";
    hdr.textContent = displayAccount(accountName);
    list.appendChild(hdr);
  }

  function renderFolderDropdown() {
    if (isViewFilterMode()) renderViewFilterDropdown();
    else renderScanFolderDropdown();
  }

  function renderScanFolderDropdown() {
    const list = $("#folderDropdownList");
    const header = $("#folderDropdownHeader");
    const footer = $("#folderDropdownFooter");
    if (header) header.textContent = "Select folders to scan";
    if (footer) {
      footer.style.display = "none";
      clearElement(footer);
    }
    clearElement(list);
    if (!scanFolderList.length) {
      const empty = document.createElement("div");
      empty.className = "folder-dropdown-empty";
      empty.textContent = "No folders found";
      list.appendChild(empty);
      return;
    }

    let lastAccountId = null;
    const showAccountGroups = accountSelect.value === "all";
    scanFolderList.forEach((folder) => {
      if (showAccountGroups && folder.accountId !== lastAccountId) {
        lastAccountId = folder.accountId;
        const hdr = document.createElement("div");
        hdr.className = "folder-dropdown-account";
        hdr.textContent = displayAccount(folder.accountName);
        list.appendChild(hdr);
      }

      const key = folderKey(folder.accountId, folder.path);
      const label = document.createElement("label");
      label.className = "folder-option";
      label.style.paddingLeft = `${14 + folder.depth * 16}px`;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = key;
      cb.checked = selectedFolderKeys.has(key);

      const span = document.createElement("span");
      span.textContent = displayFolderName(folder.name, folder.path);

      label.appendChild(cb);
      label.appendChild(span);
      list.appendChild(label);
    });
    folderDropdownRendered = true;
    updateFolderBadge();
  }

  async function refreshFolderDropdown() {
    const list = $("#folderDropdownList");
    clearElement(list);
    const loading = document.createElement("div");
    loading.className = "folder-dropdown-empty";
    loading.textContent = "Loading folders…";
    list.appendChild(loading);
    try {
      await loadScanFolders();
      renderScanFolderDropdown();
    } catch (e) {
      clearElement(list);
      const err = document.createElement("div");
      err.className = "folder-dropdown-empty";
      err.textContent = `Could not load folders: ${e.message}`;
      list.appendChild(err);
    }
  }

  function initFolderSelection() {
    loadSavedFolderSelections();
    updateFolderBadge();

    const dropdown = $("#folderDropdown");
    const list = $("#folderDropdownList");

    $("#folderSelectBtn").addEventListener("click", async (e) => {
      e.stopPropagation();
      const isVisible = dropdown.style.display === "block";
      if (isVisible) {
        dropdown.style.display = "none";
        return;
      }
      dropdown.style.display = "block";
      if (isViewFilterMode()) {
        await renderViewFilterDropdown();
      } else if (!folderListLoaded) {
        await refreshFolderDropdown();
      } else {
        renderScanFolderDropdown();
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".folder-select-wrap")) {
        dropdown.style.display = "none";
      }
    });

    list.addEventListener("change", (e) => {
      if (e.target.type !== "checkbox") return;
      if (isViewFilterMode()) applyViewFilterFromCheckboxes();
      else updateSelectedFolders();
    });

    $("#folderSelectAll").addEventListener("click", (e) => {
      e.preventDefault();
      handleFolderSelectAll();
    });

    $("#folderSelectNone").addEventListener("click", (e) => {
      e.preventDefault();
      handleFolderSelectNone();
    });
  }

  function handleFolderSelectAll() {
    const checkboxes = getFolderCheckboxes();
    checkboxes.forEach((cb) => { cb.checked = true; });
    if (isViewFilterMode()) {
      viewFilterFolderKeys.clear();
      onViewFilterApply();
    } else {
      scanFolderList.forEach((folder) => {
        selectedFolderKeys.add(folderKey(folder.accountId, folder.path));
      });
      updateSelectedFolders();
    }
  }

  function handleFolderSelectNone() {
    const checkboxes = getFolderCheckboxes();
    checkboxes.forEach((cb) => { cb.checked = false; });
    if (isViewFilterMode()) {
      viewFilterFolderKeys.clear();
      onViewFilterApply();
    } else {
      selectedFolderKeys.clear();
      updateSelectedFolders();
    }
  }

  function updateSelectedFolders() {
    const checkboxes = getFolderCheckboxes();
    selectedFolderKeys.clear();
    checkboxes.forEach((cb) => {
      if (cb.checked) selectedFolderKeys.add(cb.value);
    });
    saveFolderSelections();
    updateFolderBadge();
  }

  function updateAccountSelectActiveState() {
    $(".account-select-wrap")?.classList.toggle("active", accountSelect.value !== "all");
  }

  function updateFolderBadge() {
    const badge = $("#folderCountBadge");
    const label = $("#folderSelectLabel");
    const btn = $("#folderSelectBtn");
    if (label) label.textContent = "Folders";
    if (btn) btn.classList.toggle("active", selectedFolderKeys.size > 0);
    if (!badge) return;
    badge.textContent = selectedFolderKeys.size;
    badge.style.display = selectedFolderKeys.size > 0 ? "inline-block" : "none";
  }

  /**
   * Build scannedFolderList from allMessages after a scan.
   */
  function buildScannedFolderList() {
    const folderMap = {};
    allMessages.forEach((m) => {
      const key = folderKey(m.accountId, m.folder);
      if (!folderMap[key]) {
        folderMap[key] = {
          accountId: m.accountId,
          accountName: m.account || m.accountId,
          path: m.folder,
          name: m.folder ? m.folder.split("/").pop() : "(Unknown)",
          count: 0,
        };
      }
      folderMap[key].count++;
    });
    scannedFolderList = Object.values(folderMap).sort((a, b) => b.count - a.count);
  }

  async function renderViewFilterDropdown() {
    const list = $("#folderDropdownList");
    const header = $("#folderDropdownHeader");
    const footer = $("#folderDropdownFooter");
    if (!list) return;

    if (header) header.textContent = "Filter scanned folders";
    clearElement(list);
    if (footer) {
      footer.style.display = "none";
      clearElement(footer);
    }

    if (!scannedFolderList.length) {
      const empty = document.createElement("div");
      empty.className = "folder-dropdown-empty";
      empty.textContent = "No scanned folders available";
      list.appendChild(empty);
      return;
    }

    try {
      await ensureScanFolderListLoaded();
    } catch (e) {
      const err = document.createElement("div");
      err.className = "folder-dropdown-empty";
      err.textContent = `Could not load folder list: ${e.message}`;
      list.appendChild(err);
      return;
    }

    const showAccountGroups = accountSelect.value === "all";
    const unscannedFolders = getUnscannedFolderList();

    appendFolderSectionHeader(
      list,
      "Scanned folders",
      "Toggle folders included in the current report"
    );

    let lastAccountId = { value: null };
    scannedFolderList.forEach((folder) => {
      appendAccountHeader(list, folder.accountName, showAccountGroups, lastAccountId, folder.accountId);

      const key = folderKey(folder.accountId, folder.path);
      const label = document.createElement("label");
      label.className = "folder-option";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = key;
      cb.dataset.folderName = folder.name;
      cb.dataset.filterable = "true";
      cb.checked = viewFilterFolderKeys.size === 0 || viewFilterFolderKeys.has(key);

      const nameSpan = document.createElement("span");
      nameSpan.textContent = displayFolderName(folder.name, folder.path);
      nameSpan.style.flex = "1";

      const countSpan = document.createElement("span");
      countSpan.textContent = folder.count.toLocaleString();
      countSpan.style.fontSize = "11px";
      countSpan.style.color = "var(--text-muted)";
      countSpan.style.fontFamily = "var(--font-mono)";

      label.appendChild(cb);
      label.appendChild(nameSpan);
      label.appendChild(countSpan);
      list.appendChild(label);
    });

    if (unscannedFolders.length > 0) {
      appendFolderSectionHeader(
        list,
        "Not scanned",
        "These folders were not included in the current scan"
      );

      lastAccountId = { value: null };
      unscannedFolders.forEach((folder) => {
        appendAccountHeader(list, folder.accountName, showAccountGroups, lastAccountId, folder.accountId);

        const row = document.createElement("div");
        row.className = "folder-option folder-option-unscanned";
        row.style.paddingLeft = `${14 + folder.depth * 16}px`;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = displayFolderName(folder.name, folder.path);

        row.appendChild(nameSpan);
        list.appendChild(row);
      });

      if (footer) {
        footer.style.display = "block";
        const note = document.createElement("p");
        note.textContent = `${unscannedFolders.length.toLocaleString()} folder${unscannedFolders.length === 1 ? "" : "s"} not included in this scan. Reset the dashboard to choose folders and scan again.`;
        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "btn btn-secondary btn-small";
        resetBtn.textContent = "Reset & choose folders";
        resetBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const ok = confirm(
            "Reset the dashboard? Scan results will be cleared so you can choose folders and scan again."
          );
          if (!ok) return;
          $("#folderDropdown").style.display = "none";
          resetDashboard();
        });
        footer.appendChild(note);
        footer.appendChild(resetBtn);
      }
    }

    updateViewFilterLabel();
  }

  function applyViewFilterFromCheckboxes() {
    const checkboxes = getFolderCheckboxes();
    const checkedCount = Array.from(checkboxes).filter((cb) => cb.checked).length;
    const totalCount = checkboxes.length;

    viewFilterFolderKeys.clear();
    if (checkedCount !== totalCount && checkedCount !== 0) {
      checkboxes.forEach((cb) => {
        if (cb.checked) viewFilterFolderKeys.add(cb.value);
      });
    }

    onViewFilterApply();
  }

  function onViewFilterApply() {
    expandedDomains.clear();
    expandedSenders.clear();
    expandedSenderYears.clear();
    sunburstDetailState = null;
    timelineState.selectedMonth = null;

    updateViewFilterLabel();
    updateStats();
    switchView(currentView);
  }

  function updateViewFilterLabel() {
    const label = $("#folderSelectLabel");
    const badge = $("#folderCountBadge");
    const checkboxes = getFolderCheckboxes();
    const checkedCount = Array.from(checkboxes).filter((cb) => cb.checked).length;
    const totalCount = checkboxes.length;

    if (label) {
      if (viewFilterFolderKeys.size === 0 || checkedCount === totalCount || checkedCount === 0) {
        label.textContent = "Folders";
      } else if (viewFilterFolderKeys.size === 1) {
        const checked = Array.from(checkboxes).find((cb) => cb.checked);
        label.textContent = displayFolderName(checked?.dataset.folderName) || "1 folder";
      } else {
        label.textContent = `${viewFilterFolderKeys.size} folders selected`;
      }
    }

    if (badge) {
      const unscannedCount = getUnscannedFolderList().length;
      if (viewFilterFolderKeys.size === 0) {
        badge.textContent = String(scannedFolderList.length);
        badge.title = unscannedCount
          ? `Showing all ${scannedFolderList.length} scanned folder(s). ${unscannedCount} not scanned.`
          : "Showing all scanned folders";
      } else {
        badge.textContent = String(viewFilterFolderKeys.size);
        badge.title = `Filtering to ${viewFilterFolderKeys.size} scanned folder(s)`;
      }
      badge.style.display = "inline-block";
    }
  }

  // ══════════════════════════════════════════
  //  SCAN DATE RANGE
  // ══════════════════════════════════════════
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DATE_RANGE_EARLIEST_YEAR = 1995;

  function initDateRangeSelection() {
    const btn = $("#dateRangeBtn");
    const dropdown = $("#dateRangeDropdown");
    if (!btn || !dropdown) return;

    const nowYear = new Date().getFullYear();
    const monthOptions = MONTH_NAMES.map((name, i) => `<option value="${i + 1}">${name}</option>`).join("");
    let yearOptions = "";
    for (let y = nowYear; y >= DATE_RANGE_EARLIEST_YEAR; y--) {
      yearOptions += `<option value="${y}">${y}</option>`;
    }
    setSafeHtml($("#dateRangeFromMonth"), monthOptions);
    setSafeHtml($("#dateRangeToMonth"), monthOptions);
    setSafeHtml($("#dateRangeFromYear"), yearOptions);
    setSafeHtml($("#dateRangeToYear"), yearOptions);

    loadSavedDateRange();
    applyDateRangeToSelects();
    updateDateRangeLabel();

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = dropdown.style.display === "block";
      dropdown.style.display = isVisible ? "none" : "block";
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#dateRangeBtn") && !e.target.closest("#dateRangeDropdown")) {
        dropdown.style.display = "none";
      }
    });

    $("#dateRangeApply").addEventListener("click", () => {
      const fromYear = parseInt($("#dateRangeFromYear").value, 10);
      const fromMonth = parseInt($("#dateRangeFromMonth").value, 10);
      const toYear = parseInt($("#dateRangeToYear").value, 10);
      const toMonth = parseInt($("#dateRangeToMonth").value, 10);

      if (fromYear > toYear || (fromYear === toYear && fromMonth > toMonth)) {
        alert("The \"From\" date must be before the \"To\" date.");
        return;
      }

      scanDateRange = { fromYear, fromMonth, toYear, toMonth };
      saveDateRange();
      updateDateRangeLabel();
      dropdown.style.display = "none";
    });

    $("#dateRangeClear").addEventListener("click", () => {
      scanDateRange = null;
      saveDateRange();
      applyDateRangeToSelects();
      updateDateRangeLabel();
      dropdown.style.display = "none";
    });
  }

  function applyDateRangeToSelects() {
    const nowYear = new Date().getFullYear();
    const nowMonth = new Date().getMonth() + 1;
    const range = scanDateRange || { fromYear: nowYear - 1, fromMonth: nowMonth, toYear: nowYear, toMonth: nowMonth };
    $("#dateRangeFromYear").value = String(range.fromYear);
    $("#dateRangeFromMonth").value = String(range.fromMonth);
    $("#dateRangeToYear").value = String(range.toYear);
    $("#dateRangeToMonth").value = String(range.toMonth);
  }

  function updateDateRangeLabel() {
    const label = $("#dateRangeLabel");
    const btn = $("#dateRangeBtn");
    if (!label || !btn) return;
    if (!scanDateRange) {
      label.textContent = "Scan Range";
      btn.classList.remove("active");
      btn.title = "Scan Range — limits which messages get scanned (currently: all time)";
    } else {
      const { fromYear, fromMonth, toYear, toMonth } = scanDateRange;
      label.textContent = `${MONTH_NAMES[fromMonth - 1]} ${fromYear} – ${MONTH_NAMES[toMonth - 1]} ${toYear}`;
      btn.classList.add("active");
      btn.title = "Scan Range — limits which messages get scanned (click to change)";
    }
  }

  function saveDateRange() {
    if (scanDateRange) localStorage.setItem("mail-audit-date-range", JSON.stringify(scanDateRange));
    else localStorage.removeItem("mail-audit-date-range");
  }

  function loadSavedDateRange() {
    try {
      const saved = localStorage.getItem("mail-audit-date-range");
      scanDateRange = saved ? JSON.parse(saved) : null;
    } catch (e) {
      scanDateRange = null;
    }
  }

  /** First/last instant of the saved range, as epoch ms, for filtering message dates. Null fields mean unbounded. */
  function getDateRangeBounds() {
    if (!scanDateRange) return null;
    const { fromYear, fromMonth, toYear, toMonth } = scanDateRange;
    const from = new Date(fromYear, fromMonth - 1, 1, 0, 0, 0, 0).getTime();
    const to = new Date(toYear, toMonth, 0, 23, 59, 59, 999).getTime(); // day 0 of next month = last day of toMonth
    return { from, to };
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
    domainChartFilterValue = null;
    senderChartFilterValue = null;
    timelineState.windowMonths = 24;
    timelineState.offsetMonths = 0;
    timelineState.selectedMonth = null;
    reviewState.query = "";
    reviewState.sort = "date-desc";
    currentView = "sunburst";
    sunburstDetailState = null;
    folderListLoaded = false;
    folderDropdownRendered = false;
    viewFilterFolderKeys.clear();
    scannedFolderList = [];
    scanFolderList = [];
    selectedFolderKeys.clear();
    saveFolderSelections();
    updateFolderBadge();

    const folderHeader = $("#folderDropdownHeader");
    const folderLabel = $("#folderSelectLabel");
    if (folderHeader) folderHeader.textContent = "Select folders to scan";
    if (folderLabel) folderLabel.textContent = "Folders";
    updateFolderBadge();

    const folderDropdown = $("#folderDropdown");
    if (folderDropdown) folderDropdown.style.display = "none";

    const folderList = $("#folderDropdownList");
    if (folderList) {
      clearElement(folderList);
      const empty = document.createElement("div");
      empty.className = "folder-dropdown-empty";
      empty.textContent = "Open to load folders…";
      folderList.appendChild(empty);
    }

    const folderFooter = $("#folderDropdownFooter");
    if (folderFooter) {
      folderFooter.style.display = "none";
      clearElement(folderFooter);
    }

    $("#selectionReviewModal").style.display = "none";
    $("#deleteModal").style.display = "none";
    $("#folderModal").style.display = "none";

    $("#progressArea").style.display = "none";
    $("#viewTabsWrap").style.display = "none";
    $("#exportBar").style.display = "none";
    $("#floatingSelectionBar").style.display = "none";
    $("#landingState").style.display = "flex";

    document.querySelectorAll(".view-panel").forEach((p) => (p.style.display = "none"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-view="sunburst"]')?.classList.add("active");

    $("#statTotal").textContent = "0";
    $("#statSize").textContent = "0";
    $("#floatingSelectionCount").textContent = "0";
    lastSelectedStatCount = null;

    clearElement($("#sunburstChart"));
    clearElement($("#sunburstCenterStat"));
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

    browseState.query = "";
    browseState.sort = "date-desc";
    const browseTable = $("#browseTable");
    if (browseTable) { browseTable.onscroll = null; clearElement(browseTable); }

    scanBtn.disabled = false;
    scanBtn.querySelector(".btn-text").style.display = "inline";
    scanBtn.querySelector(".btn-loader").style.display = "none";
    $("#progressFill").style.width = "0%";
  }

  // ══════════════════════════════════════════
  //  SCAN
  // ══════════════════════════════════════════
  async function startScan() {
    // Only trust the dropdown's checkbox DOM if it was actually painted — folderListLoaded
    // can be true from a background fetch (e.g. right after switching accounts) with no
    // checkboxes ever rendered, which would otherwise wipe the just-computed defaults to empty.
    if (folderDropdownRendered && !isViewFilterMode()) {
      syncSelectedFoldersFromDom();
    }

    if (selectedFolderKeys.size === 0) {
      if (!folderListLoaded) {
        try {
          await loadScanFolders();
        } catch (e) {
          alert(`Could not load folders: ${e.message}`);
          return;
        }
      }
      if (selectedFolderKeys.size === 0) {
        alert("Please select at least one folder to scan.");
        return;
      }
    }

    const folderSelections = Array.from(selectedFolderKeys).map(parseFolderKey);

    scanBtn.querySelector(".btn-text").style.display = "none";
    scanBtn.querySelector(".btn-loader").style.display = "inline";
    scanBtn.disabled = true;
    $("#landingState").style.display = "none";
    $("#progressArea").style.display = "block";
    $("#progressFill").style.width = "20%";
    const rangeSuffix = scanDateRange ? ` (${$("#dateRangeLabel").textContent})` : "";
    $("#progressText").textContent = `Scanning ${folderSelections.length.toLocaleString()} folder${folderSelections.length === 1 ? "" : "s"}${rangeSuffix}…`;

    try {
      const acctVal = accountSelect.value;
      const dateBounds = getDateRangeBounds();
      const result = await browser.runtime.sendMessage({
        action: "fetchAllMail",
        options: {
          accountId: acctVal === "all" ? null : acctVal,
          folderSelections,
          dateFrom: dateBounds ? dateBounds.from : null,
          dateTo: dateBounds ? dateBounds.to : null,
        },
      });

      allMessages = result.messages;
      $("#progressFill").style.width = "100%";
      $("#progressText").textContent = `Done — ${allMessages.length.toLocaleString()} messages loaded.`;

      // Build scanned folder list for filtering
      buildScannedFolderList();
      viewFilterFolderKeys.clear(); // Reset filter to show all

      setTimeout(() => {
        $("#progressArea").style.display = "none";
        $("#viewTabsWrap").style.display = "block";
        $("#exportBar").style.display = "flex";
        updateStats();
        renderViewFilterDropdown();
        switchView("sunburst");
        updateTabsScrollState();
        if (localStorage.getItem("mail-audit-app-tour-completed") !== "true") {
          setTimeout(startTour, 500);
        }
        scheduleSupportPopover();
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

  let lastSelectedStatCount = null;

  function updateStats() {
    const msgs = getFilteredMessages();
    $("#statTotal").textContent = msgs.length.toLocaleString();
    $("#statSize").textContent = formatBytes(msgs.reduce((sum, m) => sum + messageSize(m), 0));
    updateFloatingSelectionBar();
    updateBulkButtons();
  }

  /** Floating selection bar — fixed to the viewport (not the scrolling body), so it's always visible regardless of scroll position. Bumps briefly whenever the count changes. */
  function updateFloatingSelectionBar() {
    const bar = $("#floatingSelectionBar");
    if (!bar) return;
    const count = selectedIds.size;
    $("#floatingSelectionCount").textContent = count.toLocaleString();
    bar.style.display = count > 0 ? "flex" : "none";
    if (count > 0 && lastSelectedStatCount !== null && count !== lastSelectedStatCount) {
      bar.classList.remove("bump");
      void bar.offsetWidth; // restart the animation even if it's still running
      bar.classList.add("bump");
    }
    lastSelectedStatCount = count;
  }

  function updateBulkButtons() {
    const senderBar = $("#senderBulkButtons");
    const domainBar = $("#domainBulkButtons");
    const sizeBar = $("#sizeBulkButtons");
    const timelineBar = $("#timelineBulkButtons");
    const categoriesBar = $("#categoriesBulkButtons");
    if (senderBar) senderBar.style.display = selectedIds.size > 0 && currentView === "sender" ? "flex" : "none";
    if (domainBar) domainBar.style.display = selectedIds.size > 0 && currentView === "domain" ? "flex" : "none";
    if (sizeBar) sizeBar.style.display = selectedIds.size > 0 && currentView === "size" ? "flex" : "none";
    if (timelineBar) timelineBar.style.display = selectedIds.size > 0 && currentView === "timeline" ? "flex" : "none";
    if (categoriesBar) categoriesBar.style.display = selectedIds.size > 0 && currentView === "categories" ? "flex" : "none";
    document.querySelectorAll(".bulk-delete-count").forEach((el) => {
      el.textContent = String(selectedIds.size);
    });
  }

  function switchView(view) {
    currentView = view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    const activeTab = document.querySelector(`.tab[data-view="${view}"]`);
    activeTab.classList.add("active");
    activeTab.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    updateTabsScrollState();
    document.querySelectorAll(".view-panel").forEach((p) => (p.style.display = "none"));
    const panel = $(`#${view}View`);
    if (panel) {
      panel.style.display = "block";
      if (view === "sunburst") renderSunburst();
      else if (view === "sender") renderSenderTable();
      else if (view === "domain") renderDomainTable();
      else if (view === "size") renderSizeDashboard();
      else if (view === "timeline") renderTimeline();
      else if (view === "subscriptions") renderSubscriptionsView();
      else if (view === "categories") renderCategoriesView();
      else if (view === "contacts") renderContactsView();
      else if (view === "browse") renderBrowseView();
      else if (view === "settings") renderSettingsView();
    }
    updateBulkButtons();
  }

  // ══════════════════════════════════════════
  //  ECHARTS UTILITIES & BAR CHART RENDERING
  // ══════════════════════════════════════════

  function initViewChart(hostId, option, legendData = null) {
    if (!window.echarts) return;
    const el = document.getElementById(hostId);
    if (!el) return;

    // Clear container and set up split layout if legend is provided
    let chartHost = el.querySelector('.chart-host');
    if (!chartHost) {
      clearElement(el);
      chartHost = document.createElement('div');
      chartHost.className = 'chart-host';
      el.appendChild(chartHost);
      if (legendData) {
        el.classList.add('with-legend');
        const legendContainer = document.createElement('div');
        legendContainer.className = 'chart-legend';
        setSafeHtml(legendContainer, legendData.map((item, i) => `
          <div class="chart-legend-item" data-index="${i}">
            <div class="chart-legend-dot" style="background-color: ${item.color}"></div>
            <div class="chart-legend-label" title="${escHtml(item.name)}">${escHtml(item.name)}</div>
            <div class="chart-legend-value">${item.value.toLocaleString()}</div>
          </div>
        `).join(''));
        el.appendChild(legendContainer);
      }
    }

    if (!chartHost._echartsInstance) {
      chartHost._echartsInstance = echarts.init(chartHost, getChartTheme());
      new ResizeObserver(() => {
        if (chartHost._echartsInstance) chartHost._echartsInstance.resize();
      }).observe(chartHost);
    }
    chartHost._echartsInstance.setOption(option, true);
    requestAnimationFrame(() => {
      if (chartHost._echartsInstance) chartHost._echartsInstance.resize();
    });
  }

  function getChartTheme() {
    const theme = document.documentElement.getAttribute("data-theme") || "dark";
    return theme === "light" ? "light" : "dark";
  }

  /** Pie chart for the "Size Buckets" card — built from the same buildSizeBuckets() rows the card lists, so slices and rows always agree. */
  function buildSizeBucketsChartOption(buckets) {
    const bucketColors = ["#ef4444", "#f97316", "#eab308", "#3b82f6", "#22c55e"];
    const titleByValue = {};
    buckets.forEach(b => { titleByValue[b.value] = b.title; });

    const data = buckets.map((b, i) => ({
      name: b.value,
      value: b.count,
      itemStyle: { color: bucketColors[i % bucketColors.length] }
    }));

    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const textColor = isLight ? "#1a1d24" : "#eaedf2";

    return {
      backgroundColor: "transparent",
      tooltip: { trigger: "item", formatter: (p) => `${titleByValue[p.name] || p.name}: ${formatBytes(p.value)} (${p.percent}%)`, textStyle: { color: textColor } },
      legend: { show: false },
      series: [{
        type: "pie",
        radius: ["38%", "68%"],
        center: ["50%", "50%"],
        data: data,
        label: { formatter: (p) => `${titleByValue[p.name] || p.name}\n${p.percent}%`, fontSize: 11, color: textColor },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: isLight ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.4)" } }
      }]
    };
  }

  function buildDomainBarChartOption(limit = 12) {
    const domains = {};
    allMessages.forEach(m => {
      if (!m.domain) return;
      domains[m.domain] = (domains[m.domain] || 0) + 1;
    });

    const sorted = Object.entries(domains)
      .sort((a, b) => b[1] - a[1]);

    const sliced = limit === "all" ? sorted : sorted.slice(0, parseInt(limit) || 12);

    const data = sliced.map(([domain, count], i) => ({
      name: domain,
      value: count,
      itemStyle: { color: colorFor(i) }
    }));

    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const textColor = isLight ? "#1a1d24" : "#eaedf2";

    return {
      backgroundColor: "transparent",
      tooltip: { trigger: "item", formatter: (p) => `${displayDomain(p.name)}: ${p.value.toLocaleString()} emails (${p.percent}%)`, textStyle: { color: textColor } },
      legend: { show: false },
      series: [{
        type: "pie",
        radius: ["38%", "68%"],
        center: ["50%", "50%"],
        data: data,
        label: { formatter: (p) => `${displayDomain(p.name)}\n${p.percent}%`, fontSize: 11, color: textColor },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: isLight ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.4)" } }
      }]
    };
  }

  function buildSenderBarChartOption(limit = 12) {
    const senders = {};
    allMessages.forEach(m => {
      const key = m.senderEmail || m.author || "Unknown";
      senders[key] = (senders[key] || 0) + 1;
    });

    const sorted = Object.entries(senders)
      .sort((a, b) => b[1] - a[1]);

    const sliced = limit === "all" ? sorted : sorted.slice(0, parseInt(limit) || 12);

    const data = sliced.map(([sender, count], i) => ({
      name: sender,
      value: count,
      itemStyle: { color: colorFor(i) }
    }));

    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const textColor = isLight ? "#1a1d24" : "#eaedf2";

    return {
      backgroundColor: "transparent",
      tooltip: { trigger: "item", formatter: (p) => `${displayEmail(p.name)}: ${p.value.toLocaleString()} emails (${p.percent}%)`, textStyle: { color: textColor } },
      legend: { show: false },
      series: [{
        type: "pie",
        radius: ["38%", "68%"],
        center: ["50%", "50%"],
        data: data,
        label: { formatter: (p) => `${displayEmail(p.name)}\n${p.percent}%`, fontSize: 11, color: textColor },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: isLight ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.4)" } }
      }]
    };
  }

  function buildTopSendersChartOption(senders, limit = 12) {
    const sliced = limit === "all" ? senders : senders.slice(0, parseInt(limit) || 12);
    const data = sliced.map((s, i) => ({
      name: s.title,
      value: s.count,
      itemStyle: { color: colorFor(i) }
    }));

    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const textColor = isLight ? "#1a1d24" : "#eaedf2";

    return {
      backgroundColor: "transparent",
      tooltip: { trigger: "item", formatter: (p) => `${p.name}: ${formatBytes(p.value)} (${p.percent}%)`, textStyle: { color: textColor } },
      legend: { show: false },
      series: [{
        type: "pie",
        radius: ["38%", "68%"],
        center: ["50%", "50%"],
        data: data,
        label: { formatter: "{b}\n{d}%", fontSize: 11, color: textColor },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: isLight ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.4)" } }
      }]
    };
  }

  // ══════════════════════════════════════════
  //  SUNBURST CHART (ECharts, theme-aware)
  // ══════════════════════════════════════════
  function renderSunburst() {
    const chartHost = $("#sunburstChart");
    const centerStat = $("#sunburstCenterStat");
    const legend = $("#legendPanel");
    clearElement($("#sunburstDetail"));
    sunburstDetailState = null;
    if (!chartHost) return;

    const msgs = getFilteredMessages();
    const total = msgs.length;
    if (total === 0) {
      setSafeHtml(chartHost, '<div class="insight-empty">No messages</div>');
      if (centerStat) clearElement(centerStat);
      clearElement(legend);
      return;
    }

    const MONTH_ORDER = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    // Build tree: year -> month -> domain -> messages
    const tree = {};
    msgs.forEach((m) => {
      const y = String(m.year), mo = m.monthName, d = m.domain;
      if (!tree[y]) tree[y] = {};
      if (!tree[y][mo]) tree[y][mo] = {};
      if (!tree[y][mo][d]) tree[y][mo][d] = [];
      tree[y][mo][d].push(m);
    });

    const legendYears = [];
    const legendDomains = {};
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const otherColor = cssVar("--text-muted");

    const years = Object.keys(tree).sort();
    const sunburstData = years.map((year, yi) => {
      const yearColor = colorFor(yi);
      const yearMsgs = msgs.filter((m) => String(m.year) === year);
      legendYears.push({ label: year, color: yearColor, count: yearMsgs.length });

      const months = Object.keys(tree[year]).sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));
      const monthChildren = months.map((month, mi) => {
        const moColor = colorFor(yi * 4 + mi);
        const domains = Object.keys(tree[year][month]).sort((a, b) => tree[year][month][b].length - tree[year][month][a].length);
        const topDomains = domains.slice(0, 15);
        const otherDomains = domains.slice(15);

        const domainChildren = topDomains.map((domain, di) => {
          const dMsgs = tree[year][month][domain];
          const dColor = colorFor(di + 3);
          if (!legendDomains[domain]) legendDomains[domain] = { color: dColor, count: 0 };
          legendDomains[domain].count += dMsgs.length;
          return {
            id: `d::${year}::${month}::${domain}`,
            name: displayDomain(domain),
            value: dMsgs.length,
            itemStyle: { color: dColor },
            __rawDomain: domain,
            __messages: dMsgs,
          };
        });

        if (otherDomains.length) {
          const otherMsgs = otherDomains.flatMap((d) => tree[year][month][d]);
          domainChildren.push({
            id: `other::${year}::${month}`,
            name: "Other",
            value: otherMsgs.length,
            itemStyle: { color: otherColor, opacity: 0.5 },
          });
        }

        return {
          id: `m::${year}::${month}`,
          name: month,
          itemStyle: { color: moColor },
          children: domainChildren,
        };
      });

      return {
        id: `y::${year}`,
        name: year,
        itemStyle: { color: yearColor },
        children: monthChildren,
      };
    });

    if (centerStat) {
      setSafeHtml(centerStat, `<span class="scs-count">${total.toLocaleString()}</span><span class="scs-label">EMAILS</span>`);
    }

    initViewChart("sunburstChart", {
      backgroundColor: "transparent",
      tooltip: {
        formatter: (info) => {
          const value = info.value || 0;
          const pct = total ? ((value / total) * 100).toFixed(1) : "0";
          return `<strong>${escHtml(info.name)}</strong><br/>${value.toLocaleString()} emails (${pct}% of total)`;
        },
      },
      series: [{
        type: "sunburst",
        radius: ["8%", "74%"],
        center: ["50%", "50%"],
        data: sunburstData,
        nodeClick: "rootToNode",
        emphasis: { focus: "ancestor" },
        itemStyle: { borderWidth: 1.5, borderColor: isLight ? "#fff" : "#0c0f14" },
        label: { show: true, color: "#fff", minAngle: 8 },
        levels: [
          {},
          { r0: "8%", r: "32%", label: { rotate: "tangential", fontSize: 13, fontWeight: 700 } },
          { r0: "32%", r: "53%", label: { rotate: "tangential", fontSize: 10, fontWeight: 600 } },
          { r0: "53%", r: "74%", label: { rotate: "radial", fontSize: 9 } },
        ],
      }],
    });

    const chart = chartHost.querySelector(".chart-host")._echartsInstance;
    if (chart) {
      chart.on("click", (params) => {
        if (params.data && params.data.__rawDomain) {
          showDomainDetail(params.data.__rawDomain, params.data.__messages);
        }
      });
    }

    // Legend
    renderLegend(legend, legendYears, legendDomains);
  }

  function legendItemMessages(filterType, filterValue) {
    if (filterType === 'year') {
      return allMessages.filter((m) => m.year.toString() === filterValue);
    } else if (filterType === 'domain') {
      return allMessages.filter((m) => m.domain === filterValue);
    }
    return [];
  }

  function renderLegend(panel, years, domains) {
    let html = '<div class="legend-title">Chart Legend</div>';

    html += '<div class="legend-section"><div class="legend-section-title">Years (inner ring)</div>';
    years.forEach((y) => {
      html += renderLegendItem('year', y.label, y.color, y.label, y.count);
    });
    html += '</div>';

    // Top 10 domains
    const topDomains = Object.entries(domains).sort((a, b) => b[1].count - a[1].count).slice(0, 15);
    html += '<div class="legend-section"><div class="legend-section-title">Top Domains (outer ring)</div>';
    topDomains.forEach(([name, d]) => {
      html += renderLegendItem('domain', name, d.color, displayDomain(name), d.count);
    });
    html += '</div>';

    setSafeHtml(panel, html);
    attachLegendClickHandlers();
  }

  function renderLegendItem(filterType, filterValue, color, displayLabel, count) {
    const itemMessages = legendItemMessages(filterType, filterValue);
    const selectedCount = itemMessages.filter((m) => selectedIds.has(m.id)).length;
    const isFullySelected = selectedCount > 0 && selectedCount === itemMessages.length;
    const isPartiallySelected = selectedCount > 0 && !isFullySelected;
    const selectedClass = isFullySelected ? 'legend-fully-selected' : isPartiallySelected ? 'legend-partially-selected' : '';
    const marker = isFullySelected ? `<span class="legend-check">✓</span>` : isPartiallySelected ? `<span class="legend-check legend-check-partial">–</span>` : '';
    const title = isFullySelected
      ? `Click to unselect all emails from ${escAttr(displayLabel)}`
      : `Click to select all emails from ${escAttr(displayLabel)}`;
    return `<div class="legend-item legend-clickable ${selectedClass}" data-filter-type="${filterType}" data-filter-value="${escAttr(filterValue)}" title="${title}">${marker}<div class="legend-swatch" style="background:${escAttr(color)}"></div><span class="legend-label">${escHtml(displayLabel)}</span><span class="legend-count">${count.toLocaleString()}</span></div>`;
  }

  function attachLegendClickHandlers() {
    const legendItems = document.querySelectorAll('.legend-clickable');
    legendItems.forEach((item) => {
      item.style.cursor = 'pointer';
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const filterType = item.dataset.filterType;
        const filterValue = item.dataset.filterValue;

        const matchingMessages = legendItemMessages(filterType, filterValue);
        const allSelected = matchingMessages.length > 0 && matchingMessages.every((m) => selectedIds.has(m.id));

        if (allSelected) {
          matchingMessages.forEach((m) => selectedIds.delete(m.id));
        } else {
          matchingMessages.forEach((m) => selectedIds.add(m.id));
        }

        updateStats();
        // Re-render sunburst to show updated selection markers in legend
        renderSunburst();
      });
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
    const pool = scopeMsgs || getFilteredMessages();
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
  //  SENDER TABLE
  // ══════════════════════════════════════════
  function renderSenderTable() {
    const container = $("#senderTable");
    const searchInput = $("#senderSearch");
    const sortSelect = $("#senderSort");

    const bySender = groupBy("senderEmail");
    let entries = Object.entries(bySender);
    const maxCount = Math.max(1, ...entries.map(([, v]) => v.length));

    if (senderChartFilterValue) {
      entries = entries.filter(([email]) => email === senderChartFilterValue);
    } else {
      const q = (searchInput.value || "").toLowerCase();
      if (q) entries = entries.filter(([email, msgs]) => email.includes(q) || msgs[0].senderName.toLowerCase().includes(q));
    }

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

    searchInput.oninput = () => { senderChartFilterValue = null; renderSenderTable(); };
    sortSelect.onchange = () => renderSenderTable();

    // Render chart with Top X dropdown
    const senderChartContainer = document.getElementById("chart-sender-container");
    if (senderChartContainer) {
      setSafeHtml(senderChartContainer, `
        <div style="display: flex; gap: 12px; margin-bottom: 12px; align-items: center;">
          <h3 style="margin: 0; font-size: 14px;">Top Senders</h3>
          <select class="sender-topx-dropdown" style="padding: 4px 8px; font-size: 11px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary);">
            <option value="5">Top 5</option>
            <option value="10" selected>Top 10</option>
            <option value="20">Top 20</option>
            <option value="all">All</option>
          </select>
        </div>
        <div id="chart-sender-host" class="chart-container" style="margin: 0;"></div>
      `);
      // Move chart rendering into the new host
      initViewChart("chart-sender-host", buildSenderBarChartOption());
      const chart = document.getElementById("chart-sender-host").querySelector('.chart-host')._echartsInstance;
      if (chart) {
        chart.on("click", (params) => {
          if (params.value && params.value > 0) {
            toggleSelectMessages(allMessages.filter((m) => (m.senderEmail || m.author || "Unknown") === params.name));
            renderSenderTable();
          }
        });
      }
      // Wire up Top X dropdown for sender
      const senderDropdown = document.querySelector('.sender-topx-dropdown');
      if (senderDropdown) {
        senderDropdown.addEventListener('change', function() {
          const newOption = buildSenderBarChartOption(this.value);
          const hostEl = document.getElementById("chart-sender-host");
          if (hostEl && hostEl.querySelector('.chart-host')._echartsInstance) {
            hostEl.querySelector('.chart-host')._echartsInstance.setOption(newOption, true);
          }
        });
      }
    } else {
      initViewChart("chart-sender-container", buildSenderBarChartOption());
      const chart = document.getElementById("chart-sender-container").querySelector('.chart-host')._echartsInstance;
      if (chart) {
        chart.on("click", (params) => {
          if (params.value && params.value > 0) {
            toggleSelectMessages(allMessages.filter((m) => (m.senderEmail || m.author || "Unknown") === params.name));
            renderSenderTable();
          }
        });
      }
    }

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
    if (domainChartFilterValue) {
      entries = entries.filter(([domain]) => domain === domainChartFilterValue);
    } else {
      const q = (searchInput.value || "").toLowerCase();
      if (q) entries = entries.filter(([domain]) => domain.toLowerCase().includes(q));
    }
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

    searchInput.oninput = () => { domainChartFilterValue = null; renderDomainTable(); };

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
          const list = getFilteredMessages().filter((m) => m.domain === domain && m.senderEmail === email);
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

    // Render chart with Top X dropdown
    const domainChartContainer = document.getElementById("chart-domain-container");
    if (domainChartContainer) {
      setSafeHtml(domainChartContainer, `
        <div style="display: flex; gap: 12px; margin-bottom: 12px; align-items: center;">
          <h3 style="margin: 0; font-size: 14px;">Top Domains</h3>
          <select class="domain-topx-dropdown" style="padding: 4px 8px; font-size: 11px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary);">
            <option value="5">Top 5</option>
            <option value="10" selected>Top 10</option>
            <option value="20">Top 20</option>
            <option value="all">All</option>
          </select>
        </div>
        <div id="chart-domain-host" class="chart-container" style="margin: 0;"></div>
      `);
      // Move chart rendering into the new host
      initViewChart("chart-domain-host", buildDomainBarChartOption());
      const chart = document.getElementById("chart-domain-host").querySelector('.chart-host')._echartsInstance;
      if (chart) {
        chart.on("click", (params) => {
          if (params.value && params.value > 0) {
            toggleSelectMessages(allMessages.filter((m) => m.domain === params.name));
            renderDomainTable();
          }
        });
      }
      // Wire up Top X dropdown for domain
      const domainDropdown = document.querySelector('.domain-topx-dropdown');
      if (domainDropdown) {
        domainDropdown.addEventListener('change', function() {
          const newOption = buildDomainBarChartOption(this.value);
          const hostEl = document.getElementById("chart-domain-host");
          if (hostEl && hostEl.querySelector('.chart-host')._echartsInstance) {
            hostEl.querySelector('.chart-host')._echartsInstance.setOption(newOption, true);
          }
        });
      }
    } else {
      initViewChart("chart-domain-container", buildDomainBarChartOption());
      const chart = document.getElementById("chart-domain-container").querySelector('.chart-host')._echartsInstance;
      if (chart) {
        chart.on("click", (params) => {
          if (params.value && params.value > 0) {
            toggleSelectMessages(allMessages.filter((m) => m.domain === params.name));
            renderDomainTable();
          }
        });
      }
    }

    updateBulkButtons();
  }

  // ══════════════════════════════════════════
  //  SIZE DASHBOARD
  // ══════════════════════════════════════════
  function renderSizeDashboard() {
    const container = $("#sizeInsights");
    const summary = $("#sizeSummaryLabel");
    if (!container) return;

    const filteredMsgs = getFilteredMessages();
    const knownMessages = filteredMsgs.filter((m) => messageSize(m) > 0);
    const totalBytes = knownMessages.reduce((sum, m) => sum + messageSize(m), 0);
    const unknownCount = filteredMsgs.length - knownMessages.length;
    const largest = knownMessages.slice().sort((a, b) => messageSize(b) - messageSize(a));

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
      <div class="insight-grid size-grid">
        ${renderSizeCard("Size Buckets", "Select a size band to recover storage quickly.", buckets, "bucket", buckets.length ? `<div id="chart-size-buckets" class="chart-container insight-chart-host"></div>` : "")}
        ${renderSizeCard("Top Space-Heavy Senders", "Senders consuming the most total mailbox space.", heavySenders, "sender", heavySenders.length ? `
          <div style="display: flex; gap: 12px; padding: 10px 14px 0; align-items: center; justify-content: flex-end;">
            <select class="size-senders-topx-dropdown" style="padding: 4px 8px; font-size: 11px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary);">
              <option value="5">Top 5</option>
              <option value="10" selected>Top 10</option>
              <option value="20">Top 20</option>
              <option value="all">All</option>
            </select>
          </div>
          <div id="chart-size-senders" class="chart-container insight-chart-host"></div>
        ` : "")}
        ${renderSizeCard("Top Space-Heavy Domains", "Domains consuming storage across many senders.", heavyDomains, "domain", heavyDomains.length ? `<div id="chart-size-domains" class="chart-container insight-chart-host"></div>` : "")}
        ${renderSizeCard("Large Old Messages", "Large messages older than one year.", largeOld, "message", largeOld.length ? `<div id="chart-size-large-old" class="chart-container insight-chart-host"></div>` : "")}
      </div>
    `);

    container.querySelectorAll("[data-size-kind]").forEach((btn) => {
      btn.addEventListener("click", () => selectSizeInsight(btn, knownMessages));
    });

    // Size Buckets chart — lives inside the "Size Buckets" card, built from the same rows as its rows list
    if (buckets.length && document.getElementById("chart-size-buckets")) {
      initViewChart("chart-size-buckets", buildSizeBucketsChartOption(buckets));
      const bucketChart = document.getElementById("chart-size-buckets").querySelector('.chart-host')._echartsInstance;
      if (bucketChart) {
        bucketChart.on("click", (params) => {
          const btn = document.querySelector(`[data-size-kind="bucket"][data-value="${escAttr(params.name)}"]`);
          if (btn) selectSizeInsight(btn, knownMessages);
        });
      }
    }

    // Top Senders by Space chart — lives inside the "Top Space-Heavy Senders" card
    if (heavySenders.length && document.getElementById("chart-size-senders")) {
      initViewChart("chart-size-senders", buildTopSendersChartOption(heavySenders));
      const sendersChart = document.getElementById("chart-size-senders").querySelector('.chart-host')._echartsInstance;
      if (sendersChart) {
        sendersChart.on("click", (params) => {
          const sender = heavySenders.find(s => s.title === params.name);
          if (sender) {
            const btn = document.querySelector(`[data-size-kind="sender"][data-value="${escAttr(sender.value || "")}"]`);
            if (btn) selectSizeInsight(btn, knownMessages);
          }
        });
      }
      document.querySelector('.size-senders-topx-dropdown')?.addEventListener('change', function() {
        const newOption = buildTopSendersChartOption(heavySenders, this.value);
        const hostEl = document.getElementById("chart-size-senders");
        if (hostEl && hostEl.querySelector('.chart-host')._echartsInstance) {
          hostEl.querySelector('.chart-host')._echartsInstance.setOption(newOption, true);
        }
      });
    }

    // Top Space-Heavy Domains chart — lives inside its card; heavyDomains titles are already displayDomain()-masked
    if (heavyDomains.length && document.getElementById("chart-size-domains")) {
      initViewChart("chart-size-domains", buildTopSendersChartOption(heavyDomains));
      const domainsChart = document.getElementById("chart-size-domains").querySelector('.chart-host')._echartsInstance;
      if (domainsChart) {
        domainsChart.on("click", (params) => {
          const domainEntry = heavyDomains.find(d => d.title === params.name);
          if (domainEntry) {
            const btn = document.querySelector(`[data-size-kind="domain"][data-value="${escAttr(domainEntry.value || "")}"]`);
            if (btn) selectSizeInsight(btn, knownMessages);
          }
        });
      }
    }

    // Large Old Messages chart — lives inside its card; one slice per message, sized by bytes
    if (largeOld.length && document.getElementById("chart-size-large-old")) {
      initViewChart("chart-size-large-old", buildTopSendersChartOption(largeOld));
      const largeOldChart = document.getElementById("chart-size-large-old").querySelector('.chart-host')._echartsInstance;
      if (largeOldChart) {
        largeOldChart.on("click", (params) => {
          const msgEntry = largeOld.find(m => m.title === params.name);
          if (msgEntry) {
            const btn = document.querySelector(`[data-size-kind="message"][data-value="${escAttr(msgEntry.value || "")}"]`);
            if (btn) selectSizeInsight(btn, knownMessages);
          }
        });
      }
    }

    updateBulkButtons();
  }

  function renderSizeCard(title, subtitle, rows, kind, chartHtml) {
    const body = rows.length
      ? rows.map((row) => renderSizeRow(row, kind)).join("")
      : `<div class="insight-empty">No matching messages.</div>`;
    return `
      <section class="insight-card">
        <div class="insight-card-head">
          <h3>${escHtml(title)}</h3>
          <p>${escHtml(subtitle)}</p>
        </div>
        ${chartHtml || ""}
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
    const scanRangeNote = $("#timelineScanRangeNote");
    if (scanRangeNote) {
      if (scanDateRange) {
        scanRangeNote.style.display = "block";
        scanRangeNote.textContent = `Data limited to ${$("#dateRangeLabel").textContent} by the Scan Range filter — this applies to every view, not just Timeline. Clear it (top bar) and rescan to see full history.`;
      } else {
        scanRangeNote.style.display = "none";
      }
    }
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
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        const month = el.dataset.month;
        timelineState.selectedMonth = timelineState.selectedMonth === month ? null : month;
        renderTimeline();
      });
    });
    if (insights) {
      insights.querySelectorAll("[data-select-kind]").forEach((btn) => {
        btn.addEventListener("click", () => selectTimelineInsight(btn, messagesInRange));
      });
    }

    updateBulkButtons();
  }

  function buildTimelineMonths() {
    const filteredMsgs = getFilteredMessages();
    if (!filteredMsgs.length) return [];
    const byMonth = {};
    filteredMsgs.forEach((m) => {
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
    return getFilteredMessages().filter((m) => keys.has(monthKey(m)));
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
      title: displayFolderName("", m.folder) || "(Unknown folder)",
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

    renderInsightChart("sender", topUnreadSenders, messages);
    renderInsightChart("age", ageBuckets, messages);
    renderInsightChart("domain", noisyDomains, messages);
    renderInsightChart("folder", folderHotspots, messages);
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
        ${rows.length ? `<div id="chart-insight-${kind}" class="chart-container insight-chart-host"></div>` : ""}
        <div class="insight-rows">${body}</div>
      </section>`;
  }

  /** Pie chart mirroring an insight card's rows; clicking a slice selects the same messages as its row's Select button. */
  function renderInsightChart(kind, rows, rangeMessages) {
    const hostId = `chart-insight-${kind}`;
    const chartContainer = document.getElementById(hostId);
    if (!chartContainer || !rows.length) return;

    const data = rows.map((row, i) => ({
      name: row.title,
      value: row.count,
      itemStyle: { color: colorFor(i) }
    }));

    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const textColor = isLight ? "#1a1d24" : "#eaedf2";

    initViewChart(hostId, {
      backgroundColor: "transparent",
      tooltip: { trigger: "item", formatter: (p) => `${p.name}: ${p.value.toLocaleString()} (${p.percent}%)`, textStyle: { color: textColor } },
      legend: { show: false },
      series: [{
        type: "pie",
        radius: ["38%", "68%"],
        center: ["50%", "50%"],
        data: data,
        label: { formatter: "{b}\n{d}%", fontSize: 10, color: textColor },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: isLight ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.4)" } }
      }]
    });

    const chart = chartContainer.querySelector('.chart-host')._echartsInstance;
    if (chart) {
      chart.on("click", (params) => {
        const row = rows.find(r => r.title === params.name);
        if (!row) return;
        selectTimelineInsightByKind(kind, row.value, row.bucket, row.accountId, rangeMessages);
      });
    }
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
    selectTimelineInsightByKind(
      btn.dataset.selectKind,
      btn.dataset.value,
      btn.dataset.bucket,
      btn.dataset.accountId,
      rangeMessages
    );
  }

  function selectTimelineInsightByKind(kind, value, bucket, accountId, rangeMessages) {
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

  /** Clears the entire selection — shared by the review modal's Clear Selection button and the floating bar's reset button. */
  function clearSelection() {
    selectedIds.clear();
    reviewCheckedIds.clear();
    updateStats();
    switchView(currentView);
  }

  // ══════════════════════════════════════════
  //  SELECTION REVIEW
  // ══════════════════════════════════════════
  function showSelectionReviewModal() {
    if (selectedIds.size === 0) return;
    const modal = $("#selectionReviewModal");
    modal.style.display = "flex";
    // Default: everything currently selected starts out checked in the review table.
    reviewCheckedIds = new Set(Array.from(selectedIds, String));
    renderSelectionReview();

    $("#selectionReviewClose").onclick = () => { modal.style.display = "none"; };
    $("#selectionReviewHelpBtn").onclick = () => { startReviewTour(); };
    $("#selectionReviewClear").onclick = () => {
      modal.style.display = "none";
      clearSelection();
    };
    $("#selectionReviewTrash").onclick = () => {
      const checkedIds = getCheckedSelectedOriginalIds();
      if (checkedIds.length === 0) return;
      modal.style.display = "none";
      showDeleteModal(checkedIds);
    };
    $("#selectionReviewFolder").onclick = () => {
      const checkedIds = getCheckedSelectedOriginalIds();
      if (checkedIds.length === 0) return;
      modal.style.display = "none";
      showMoveFolderModal(checkedIds);
    };
    $("#selectionReviewExport").onclick = () => {
      exportSelectedCSV();
    };
    const excludeCheckedBtn = $("#selectionReviewExcludeMatches");
    if (excludeCheckedBtn) {
      excludeCheckedBtn.onclick = () => {
        const checked = getCheckedReviewMessages();
        checked.forEach((m) => {
          removeSelectedId(String(m.id));
          reviewCheckedIds.delete(String(m.id));
        });
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
    }
    const keepOnlyCheckedBtn = $("#selectionReviewKeepOnlyMatches");
    if (keepOnlyCheckedBtn) {
      keepOnlyCheckedBtn.onclick = () => {
        const checked = getCheckedReviewMessages();
        const checkedIdSet = new Set(checked.map((m) => String(m.id)));
        Array.from(selectedIds).forEach((id) => {
          if (!checkedIdSet.has(String(id))) removeSelectedId(String(id));
        });
        reviewCheckedIds = new Set(Array.from(selectedIds, String));
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
    }
  }

  /** Messages matching the current search/sort AND checked via the row checkboxes (not just the rendered slice). */
  function getCheckedReviewMessages() {
    return getReviewedSelectedMessages().filter((m) => reviewCheckedIds.has(String(m.id)));
  }

  /** Original-typed message IDs for the checked+matched working set — the exact target for Trash/Folder/Exclude/Keep-only. */
  function getCheckedSelectedOriginalIds() {
    return getCheckedReviewMessages().map((m) => m.id);
  }

  function renderSelectionReview() {
    const matched = getReviewedSelectedMessages();
    const table = $("#selectionReviewTable");
    const totalBytes = matched.reduce((sum, m) => sum + messageSize(m), 0);
    const unread = matched.filter((m) => !m.read).length;
    const accounts = new Set(matched.map((m) => m.account || m.accountId));

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

    if (selectedIds.size === 0) {
      table.onscroll = null;
      setSafeHtml(table, `<div class="selection-empty">No messages selected.</div>`);
      $("#selectionReviewTrash").disabled = true;
      $("#selectionReviewFolder").disabled = true;
      updateReviewBulkCounts();
      return;
    }

    $("#selectionReviewTrash").disabled = false;
    $("#selectionReviewFolder").disabled = false;

    if (matched.length === 0) {
      table.onscroll = null;
      setSafeHtml(table, `<div class="selection-empty">No selected messages match your search.</div>`);
      updateReviewBulkCounts();
      return;
    }

    // Virtual scroll: only the rows currently in view are ever rendered, but
    // select-all / checkbox-sync operate on the full filtered+sorted list so
    // "select all" genuinely covers everything, not just what's on screen.
    const allIds = matched.map((m) => String(m.id));
    const allChecked = allIds.length > 0 && allIds.every((id) => reviewCheckedIds.has(id));
    const someChecked = allIds.some((id) => reviewCheckedIds.has(id));
    const totalHeight = matched.length * SR_ROW_HEIGHT;

    setSafeHtml(table, `
      <div class="selection-review-table-head">
        <span class="selection-checkbox-cell"><input type="checkbox" id="selectionReviewSelectAllVisible" ${allChecked ? "checked" : ""} aria-label="Select all"></span>
        <span>Subject</span><span>Sender</span><span>Date</span><span>Size</span>
      </div>
      <div class="sr-virtual-spacer" id="srVirtualSpacer" style="height:${totalHeight}px;"></div>
    `);

    const selectAllCb = table.querySelector("#selectionReviewSelectAllVisible");
    if (selectAllCb && someChecked && !allChecked) selectAllCb.indeterminate = true;
    const spacer = table.querySelector("#srVirtualSpacer");
    const headEl = table.querySelector(".selection-review-table-head");

    function rowHtml(m, idx) {
      const mid = String(m.id);
      const checked = reviewCheckedIds.has(mid);
      return `
        <div class="selection-review-row${checked ? " sr-row-checked" : ""}" data-id="${escAttr(mid)}" style="top:${idx * SR_ROW_HEIGHT}px;">
          <div class="selection-checkbox-cell">
            <input type="checkbox" class="selection-row-checkbox" data-id="${escAttr(mid)}" ${checked ? "checked" : ""} aria-label="Select message">
          </div>
          <div class="selection-subject">
            <button type="button" class="selection-open-link" data-open-message="${escAttr(mid)}" title="Open in Thunderbird">${escHtml(m.subject || "(No Subject)")}</button>
            <span>${escHtml(displayFolderName("", m.folder) || "Unknown folder")} · ${escHtml(displayAccount(m.account || ""))}</span>
          </div>
          <div class="selection-sender">
            <strong>${escHtml(m.senderName || displayEmail(m.senderEmail))}</strong>
            <span>${escHtml(displayEmail(m.senderEmail) || "")}</span>
          </div>
          <div class="selection-date">${escHtml(formatDate(m.date))}</div>
          <div class="selection-size">${formatBytes(messageSize(m))}</div>
        </div>`;
    }

    let rafPending = false;
    function renderVirtualRows() {
      rafPending = false;
      const headH = headEl ? headEl.offsetHeight : 0;
      const relTop = Math.max(0, table.scrollTop - headH);
      const startIndex = Math.max(0, Math.floor(relTop / SR_ROW_HEIGHT) - SR_VIRTUAL_BUFFER);
      const visibleCount = Math.ceil(table.clientHeight / SR_ROW_HEIGHT) + SR_VIRTUAL_BUFFER * 2;
      const endIndex = Math.min(matched.length, startIndex + visibleCount);
      let html = "";
      for (let i = startIndex; i < endIndex; i++) html += rowHtml(matched[i], i);
      setSafeHtml(spacer, html);
    }
    function scheduleRenderVirtualRows() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(renderVirtualRows);
    }
    table.onscroll = scheduleRenderVirtualRows;
    renderVirtualRows();

    // Select-all: operates on the full filtered/sorted list, not just the rendered window.
    if (selectAllCb) {
      selectAllCb.addEventListener("change", () => {
        allIds.forEach((id) => {
          if (selectAllCb.checked) reviewCheckedIds.add(id); else reviewCheckedIds.delete(id);
        });
        selectAllCb.indeterminate = false;
        updateReviewBulkCounts();
        renderVirtualRows();
      });
    }

    // Per-row checkbox — delegated on the spacer since rows are recreated as the user scrolls.
    spacer.addEventListener("change", (e) => {
      const cb = e.target.closest(".selection-row-checkbox");
      if (!cb) return;
      const id = cb.dataset.id;
      if (cb.checked) reviewCheckedIds.add(id); else reviewCheckedIds.delete(id);
      const row = cb.closest(".selection-review-row");
      if (row) row.classList.toggle("sr-row-checked", cb.checked);
      const allNow = allIds.every((vid) => reviewCheckedIds.has(vid));
      const someNow = allIds.some((vid) => reviewCheckedIds.has(vid));
      if (selectAllCb) { selectAllCb.checked = allNow; selectAllCb.indeterminate = someNow && !allNow; }
      updateReviewBulkCounts();
    });

    updateReviewBulkCounts();
  }

  /** Refresh Exclude/Keep-only/Trash/Folder button counts — they all target the same checked+matched working set, so their counts must always agree. */
  function updateReviewBulkCounts() {
    const checkedCount = getCheckedReviewMessages().length;

    const excludeBtn = $("#selectionReviewExcludeMatches");
    if (excludeBtn) {
      excludeBtn.disabled = checkedCount === 0;
      const span = excludeBtn.querySelector("span");
      if (span) span.textContent = checkedCount.toLocaleString();
    }

    const keepOnlyBtn = $("#selectionReviewKeepOnlyMatches");
    if (keepOnlyBtn) {
      keepOnlyBtn.disabled = checkedCount === 0 || checkedCount === selectedIds.size;
      const span = keepOnlyBtn.querySelector("span");
      if (span) span.textContent = checkedCount.toLocaleString();
    }

    const trashBtn = $("#selectionReviewTrash");
    if (trashBtn) {
      trashBtn.disabled = checkedCount === 0;
      const span = trashBtn.querySelector("span");
      if (span) span.textContent = checkedCount.toLocaleString();
    }

    const folderBtn = $("#selectionReviewFolder");
    if (folderBtn) {
      folderBtn.disabled = checkedCount === 0;
      const span = folderBtn.querySelector("span");
      if (span) span.textContent = checkedCount.toLocaleString();
    }
  }

  function removeSelectedId(rawId) {
    selectedIds.delete(rawId);
    const numericId = Number(rawId);
    if (!Number.isNaN(numericId)) selectedIds.delete(numericId);
  }

  /** Toggle a whole group of messages in/out of the selection — same all-or-nothing pattern used by Categories pie clicks. */
  function toggleSelectMessages(msgs) {
    if (!msgs || !msgs.length) return;
    const allSelected = msgs.every((m) => selectedIds.has(m.id));
    msgs.forEach((m) => {
      if (allSelected) selectedIds.delete(m.id);
      else selectedIds.add(m.id);
    });
    updateStats();
  }

  async function openMessageInThunderbird(messageId) {
    if (messageId == null || messageId === "") return;
    try {
      const result = await browser.runtime.sendMessage({
        action: "openMessage",
        messageId,
      });
      if (!result || !result.success) {
        alert(result?.error || "Could not open this message in Thunderbird.");
      }
    } catch (e) {
      alert(`Could not open message: ${e.message}`);
    }
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
  //  BROWSE — flat, searchable, virtual-scrolled table of every scanned
  //  email. Checkboxes write straight into the shared `selectedIds`, so
  //  checking a row here is identical to clicking a slice in By Sender/Domain:
  //  it shows up in the floating selection bar and Review Selected immediately.
  // ══════════════════════════════════════════
  function getBrowseMessages() {
    const q = browseState.query.trim().toLowerCase();
    let msgs = getFilteredMessages();
    if (q) msgs = msgs.filter((m) => matchesReviewQuery(m, q));

    const sort = browseState.sort;
    msgs = msgs.slice().sort((a, b) => {
      if (sort === "date-asc") return new Date(a.date) - new Date(b.date);
      if (sort === "size-desc") return messageSize(b) - messageSize(a);
      if (sort === "sender-asc") return (a.senderEmail || "").localeCompare(b.senderEmail || "");
      if (sort === "subject-asc") return (a.subject || "").localeCompare(b.subject || "");
      return new Date(b.date) - new Date(a.date);
    });
    return msgs;
  }

  function renderBrowseView() {
    const table = $("#browseTable");
    const search = $("#browseSearch");
    const sort = $("#browseSort");
    if (!table || !search || !sort) return;

    search.value = browseState.query;
    sort.value = browseState.sort;
    search.oninput = () => { browseState.query = search.value; renderBrowseView(); };
    sort.onchange = () => { browseState.sort = sort.value; renderBrowseView(); };

    const msgs = getBrowseMessages();
    const totalAll = getFilteredMessages().length;

    function updateBrowseSummary() {
      const summaryEl = $("#browseSummary");
      if (!summaryEl) return;
      const selCount = selectedIds.size;
      summaryEl.textContent = browseState.query.trim()
        ? `${msgs.length.toLocaleString()} of ${totalAll.toLocaleString()} matched · ${selCount.toLocaleString()} selected`
        : `${totalAll.toLocaleString()} emails · ${selCount.toLocaleString()} selected`;
    }
    updateBrowseSummary();

    if (msgs.length === 0) {
      table.onscroll = null;
      setSafeHtml(table, `<div class="selection-empty">${totalAll === 0 ? "No emails scanned yet." : "No emails match your search."}</div>`);
      return;
    }

    // Virtual scroll — same technique as the Review Selected modal: a spacer
    // holds the full scrollable height, only the visible window (+ buffer) is
    // ever in the DOM, and select-all operates on the full list, not just what's rendered.
    const idToMsg = new Map(msgs.map((m) => [String(m.id), m]));
    const allIds = Array.from(idToMsg.keys());
    const allChecked = allIds.length > 0 && allIds.every((id) => selectedIds.has(idToMsg.get(id).id));
    const someChecked = allIds.some((id) => selectedIds.has(idToMsg.get(id).id));
    const totalHeight = msgs.length * SR_ROW_HEIGHT;

    setSafeHtml(table, `
      <div class="selection-review-table-head">
        <span class="selection-checkbox-cell"><input type="checkbox" id="browseSelectAll" ${allChecked ? "checked" : ""} aria-label="Select all"></span>
        <span>Subject</span><span>Sender</span><span>Date</span><span>Size</span>
      </div>
      <div class="sr-virtual-spacer" id="browseVirtualSpacer" style="height:${totalHeight}px;"></div>
    `);

    const selectAllCb = table.querySelector("#browseSelectAll");
    if (selectAllCb && someChecked && !allChecked) selectAllCb.indeterminate = true;
    const spacer = table.querySelector("#browseVirtualSpacer");
    const headEl = table.querySelector(".selection-review-table-head");

    function rowHtml(m, idx) {
      const mid = String(m.id);
      const checked = selectedIds.has(m.id);
      return `
        <div class="selection-review-row${checked ? " sr-row-checked" : ""}" data-id="${escAttr(mid)}" style="top:${idx * SR_ROW_HEIGHT}px;">
          <div class="selection-checkbox-cell">
            <input type="checkbox" class="selection-row-checkbox" data-id="${escAttr(mid)}" ${checked ? "checked" : ""} aria-label="Select message">
          </div>
          <div class="selection-subject">
            <button type="button" class="selection-open-link" data-open-message="${escAttr(mid)}" title="Open in Thunderbird">${escHtml(m.subject || "(No Subject)")}</button>
            <span>${escHtml(displayFolderName("", m.folder) || "Unknown folder")} · ${escHtml(displayAccount(m.account || ""))}</span>
          </div>
          <div class="selection-sender">
            <strong>${escHtml(m.senderName || displayEmail(m.senderEmail))}</strong>
            <span>${escHtml(displayEmail(m.senderEmail) || "")}</span>
          </div>
          <div class="selection-date">${escHtml(formatDate(m.date))}</div>
          <div class="selection-size">${formatBytes(messageSize(m))}</div>
        </div>`;
    }

    let rafPending = false;
    function renderVirtualRows() {
      rafPending = false;
      const headH = headEl ? headEl.offsetHeight : 0;
      const relTop = Math.max(0, table.scrollTop - headH);
      const startIndex = Math.max(0, Math.floor(relTop / SR_ROW_HEIGHT) - SR_VIRTUAL_BUFFER);
      const visibleCount = Math.ceil(table.clientHeight / SR_ROW_HEIGHT) + SR_VIRTUAL_BUFFER * 2;
      const endIndex = Math.min(msgs.length, startIndex + visibleCount);
      let html = "";
      for (let i = startIndex; i < endIndex; i++) html += rowHtml(msgs[i], i);
      setSafeHtml(spacer, html);
    }
    function scheduleRenderVirtualRows() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(renderVirtualRows);
    }
    table.onscroll = scheduleRenderVirtualRows;
    renderVirtualRows();

    if (selectAllCb) {
      selectAllCb.addEventListener("change", () => {
        allIds.forEach((id) => {
          const msg = idToMsg.get(id);
          if (selectAllCb.checked) selectedIds.add(msg.id); else removeSelectedId(id);
        });
        selectAllCb.indeterminate = false;
        updateStats();
        updateBrowseSummary();
        renderVirtualRows();
      });
    }

    // Per-row checkbox — delegated on the spacer since rows are recreated as the user scrolls.
    spacer.addEventListener("change", (e) => {
      const cb = e.target.closest(".selection-row-checkbox");
      if (!cb) return;
      const id = cb.dataset.id;
      const msg = idToMsg.get(id);
      if (!msg) return;
      if (cb.checked) selectedIds.add(msg.id); else removeSelectedId(id);
      const row = cb.closest(".selection-review-row");
      if (row) row.classList.toggle("sr-row-checked", cb.checked);
      const allNow = allIds.every((vid) => selectedIds.has(idToMsg.get(vid).id));
      const someNow = allIds.some((vid) => selectedIds.has(idToMsg.get(vid).id));
      if (selectAllCb) { selectAllCb.checked = allNow; selectAllCb.indeterminate = someNow && !allNow; }
      updateStats();
      updateBrowseSummary();
    });
  }

  // ══════════════════════════════════════════
  //  DELETE (modal-based)
  // ══════════════════════════════════════════
  /** Drives the in-modal pie progress ring (Move to Trash / Move to Folder) — pct = 0..100 conic-gradient fill + centered label. */
  function setModalProgress(prefix, moved, total, statusText, isError = false) {
    const pct = total > 0 ? Math.min(100, Math.round((moved / total) * 100)) : 0;
    const ring = $(`#${prefix}Ring`);
    const pctEl = $(`#${prefix}Pct`);
    const statusEl = $(`#${prefix}Status`);
    if (ring) ring.style.setProperty("--pct", pct);
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (statusEl) {
      statusEl.textContent = statusText;
      statusEl.classList.toggle("modal-progress-error", isError);
    }
  }

  function showDeleteModal(targetIds = null) {
    const idsToAct = targetIds || Array.from(selectedIds);
    const idsToActSet = new Set(idsToAct);
    const count = idsToAct.length;
    if (count === 0) return;
    const senders = new Set();
    allMessages.forEach((m) => { if (idsToActSet.has(m.id)) senders.add(m.senderEmail); });

    setSafeHtml($("#deleteModalText"), `
      You're about to move <strong>${count.toLocaleString()} email(s)</strong> from
      <strong>${senders.size} sender(s)</strong> to Trash.
    `);

    const modal = $("#deleteModal");
    const confirmView = $("#deleteModalConfirmView");
    const progressView = $("#deleteModalProgress");
    confirmView.style.display = "";
    progressView.style.display = "none";
    setModalProgress("deleteModal", 0, count, "Preparing…");
    modal.style.display = "flex";

    $("#modalCancel").onclick = () => { modal.style.display = "none"; };
    $("#modalConfirm").onclick = async () => {
      confirmView.style.display = "none";
      progressView.style.display = "flex";
      setModalProgress("deleteModal", 0, count, `Moving 0 of ${count.toLocaleString()}…`);

      const progressListener = (msg) => {
        if (msg.action === "deleteProgress") {
          setModalProgress("deleteModal", msg.moved, msg.total, `Moving ${msg.moved.toLocaleString()} of ${msg.total.toLocaleString()}…`);
        }
      };
      browser.runtime.onMessage.addListener(progressListener);

      try {
        const result = await browser.runtime.sendMessage({
          action: "deleteMessages",
          messageIds: idsToAct,
        });
        browser.runtime.onMessage.removeListener(progressListener);

        if (result && result.success) {
          const movedIds = Array.isArray(result.movedIds) ? result.movedIds : idsToAct;
          const movedSet = new Set(movedIds);
          allMessages = allMessages.filter((m) => !movedSet.has(m.id));
          movedIds.forEach((id) => { selectedIds.delete(id); reviewCheckedIds.delete(String(id)); });
          updateStats();
          setModalProgress("deleteModal", result.count, result.total, result.count === result.total
            ? `Done — moved ${result.count.toLocaleString()} to Trash.`
            : `Partial — moved ${result.count.toLocaleString()} of ${result.total.toLocaleString()}. Review remaining selections.`);
          if (result.errors) {
            console.warn("Some batches had errors:", result.errors);
          }
          setTimeout(() => {
            modal.style.display = "none";
            switchView(currentView);
          }, 1200);
        } else {
          const msg = result?.error || result?.errors?.[0] || "Could not move selected messages to Trash.";
          setModalProgress("deleteModal", 0, count, `Error: ${msg}`, true);
        }
      } catch (e) {
        browser.runtime.onMessage.removeListener(progressListener);
        setModalProgress("deleteModal", 0, count, `Error: ${e.message}`, true);
      }
    };
  }

  // ══════════════════════════════════════════
  //  MOVE TO FOLDER (modal + background)
  // ══════════════════════════════════════════
  async function showMoveFolderModal(targetIds = null) {
    const idsToAct = targetIds || Array.from(selectedIds);
    const idsToActSet = new Set(idsToAct);
    const totalSel = idsToAct.length;
    if (totalSel === 0) return;

    const selectedMsgs = allMessages.filter((m) => idsToActSet.has(m.id));
    const accountIds = [...new Set(selectedMsgs.map((m) => m.accountId))];

    const modal = $("#folderModal");
    const select = $("#folderModalSelect");
    const confirmBtn = $("#folderModalConfirm");
    const confirmView = $("#folderModalConfirmView");
    const progressView = $("#folderModalProgress");
    confirmView.style.display = "";
    progressView.style.display = "none";
    setModalProgress("folderModal", 0, totalSel, "Preparing…");

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
          opt.textContent = privacyMaskEnabled
            ? `${displayAccount(acctName)} — ${maskFolderPath(f.path)}`
            : f.displayPath;
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
        .filter((m) => idsToActSet.has(m.id) && m.accountId === accountId)
        .map((m) => m.id);

      if (idsToMove.length === 0) {
        modal.style.display = "none";
        alert("None of the selected messages belong to the account for that folder. Pick a folder under another account or adjust your selection.");
        return;
      }

      confirmView.style.display = "none";
      progressView.style.display = "flex";
      setModalProgress("folderModal", 0, idsToMove.length, `Moving 0 of ${idsToMove.length.toLocaleString()}…`);

      const progressListener = (msg) => {
        if (msg.action === "moveProgress") {
          setModalProgress("folderModal", msg.moved, msg.total, `Moving ${msg.moved.toLocaleString()} of ${msg.total.toLocaleString()}…`);
        }
      };
      browser.runtime.onMessage.addListener(progressListener);

      try {
        const result = await browser.runtime.sendMessage({
          action: "moveMessagesToFolder",
          messageIds: idsToMove,
          accountId,
          folderPath,
        });
        browser.runtime.onMessage.removeListener(progressListener);

        if (result && result.success) {
          const movedIds = Array.isArray(result.movedIds) ? result.movedIds : idsToMove;
          const movedSet = new Set(movedIds);
          allMessages = allMessages.filter((m) => !movedSet.has(m.id));
          movedIds.forEach((id) => { selectedIds.delete(id); reviewCheckedIds.delete(String(id)); });
          updateStats();
          setModalProgress("folderModal", result.count, result.total, result.count === result.total
            ? `Done — moved ${result.count.toLocaleString()} message(s).`
            : `Partial — moved ${result.count.toLocaleString()} of ${result.total.toLocaleString()} message(s). Review remaining selections.`);
          if (result.errors) console.warn("Some batches had errors:", result.errors);
          setTimeout(() => {
            modal.style.display = "none";
            switchView(currentView);
          }, 1200);
        } else {
          const msg = result?.error || result?.errors?.[0] || "Move failed";
          setModalProgress("folderModal", 0, idsToMove.length, `Error: ${msg}`, true);
        }
      } catch (e) {
        browser.runtime.onMessage.removeListener(progressListener);
        setModalProgress("folderModal", 0, idsToMove.length, `Error: ${e.message}`, true);
      }
    };
  }

  // ══════════════════════════════════════════
  //  EXPORT
  // ══════════════════════════════════════════
  function exportCSV() {
    const msgs = getFilteredMessages();
    const header = "Sender Email,Sender Name,Domain,Subject,Date,Year,Month,Read,Folder,Account\n";
    const rows = msgs.map((m) =>
      [m.senderEmail, m.senderName, m.domain, `"${(m.subject || '').replace(/"/g, '""')}"`, m.date, m.year, m.monthName, m.read, m.folder, m.account].join(",")
    ).join("\n");
    downloadFile(header + rows, "mail-audit-report.csv", "text/csv");
  }

  function exportJSON() {
    const bySender = groupBy("senderEmail"); // Already uses filtered messages
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
    const msgs = getFilteredMessages();
    msgs.forEach((m) => { const k = m[key]; if (!g[k]) g[k] = []; g[k].push(m); });
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

  /**
   * Get messages filtered by viewFilterFolderKeys.
   * If viewFilterFolderKeys is empty, returns all messages.
   */
  function getFilteredMessages() {
    if (viewFilterFolderKeys.size === 0) return allMessages;
    return allMessages.filter((m) => {
      const key = folderKey(m.accountId, m.folder);
      return viewFilterFolderKeys.has(key);
    });
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

  // ══════════════════════════════════════════
  //  CATEGORIES (Phase 3)
  // ══════════════════════════════════════════

  const DEFAULT_BUILT_IN_CATEGORIES = [
    { name: "Finance", icon: "💰", keywords: ["payment","invoice","bill","bank","credit","debit","statement","transaction","balance","money","fund","investment","loan","tax"] },
    { name: "Shopping", icon: "🛍️", keywords: ["order","purchase","delivery","shipping","amazon","cart","shop","buy","receipt","product","item","refund","return","track"] },
    { name: "Travel", icon: "✈️", keywords: ["flight","hotel","booking","ticket","reservation","travel","trip","journey","airline","airport","itinerary"] },
    { name: "Work", icon: "💼", keywords: ["meeting","project","deadline","team","report","schedule","task","office","manager","sprint","standup","review","jira"] },
    { name: "Newsletters", icon: "📰", keywords: ["newsletter","unsubscribe","weekly","digest","subscribe","edition","substack","mailchimp"] },
    { name: "Social", icon: "👥", keywords: ["friend","follow","comment","like","mention","invite","connect","profile","network","notification"] },
    { name: "Tech", icon: "⚙️", keywords: ["update","release","version","feature","bug","security","software","app","github","deploy","patch"] },
    { name: "Healthcare", icon: "🏥", keywords: ["appointment","prescription","doctor","health","medical","clinic","hospital","insurance","lab","test"] },
    { name: "Food", icon: "🍔", keywords: ["restaurant","food","delivery","menu","zomato","swiggy","meal","doordash","order","cuisine"] },
    { name: "Utilities", icon: "⚡", keywords: ["electricity","water","gas","internet","phone","broadband","utility","provider","bill","recharge"] },
    { name: "Real Estate", icon: "🏠", keywords: ["property","rent","lease","apartment","house","mortgage","tenant","landlord","flat","listing"] }
  ];

  let emailCategories = new Map(); // Map<mailId, categoryName>

  async function loadCategoriesFromStorage() {
    try {
      const result = await browser.storage.local.get("categories");
      return result.categories || [];
    } catch (e) {
      console.error("Failed to load categories:", e);
      return [];
    }
  }

  async function saveCategoryToStorage(name, keywords) {
    try {
      const cats = await loadCategoriesFromStorage();
      const exists = cats.findIndex(c => c.name === name);
      // Get icon from default categories if available
      const defaultCat = DEFAULT_BUILT_IN_CATEGORIES.find(c => c.name === name);
      const icon = defaultCat ? defaultCat.icon : "🏷️";

      if (exists >= 0) {
        cats[exists].keywords = keywords;
        cats[exists].icon = icon;
      } else {
        cats.push({ name, icon, keywords, builtin: 0 });
      }
      await browser.storage.local.set({ categories: cats });
      return true;
    } catch (e) {
      console.error("Failed to save category:", e);
      return false;
    }
  }

  async function deleteCategoryFromStorage(name) {
    try {
      const cats = await loadCategoriesFromStorage();
      const filtered = cats.filter(c => c.name !== name);
      await browser.storage.local.set({ categories: filtered });
      return true;
    } catch (e) {
      console.error("Failed to delete category:", e);
      return false;
    }
  }

  function classifyEmail(email, categories) {
    const text = (email.subject + " " + email.author + " " + (email.domain || "")).toLowerCase();
    for (const cat of categories) {
      for (const kw of (cat.keywords || [])) {
        if (text.includes(kw.toLowerCase())) return cat.name;
      }
    }
    return null;
  }

  async function renderSettingsView() {
    const container = $("#settingsView");
    if (!container) return;

    // Seed default categories if not already done
    const existing = await loadCategoriesFromStorage();
    if (!existing || !existing.length) {
      for (const cat of DEFAULT_BUILT_IN_CATEGORIES) {
        await saveCategoryToStorage(cat.name, cat.keywords);
      }
    }

    await renderCategoryList();
    wireUpCategoryAdd();

    // Also classify emails when Settings is opened
    await reclassifyAllEmails();
  }

  async function renderCategoryList() {
    const list = $("#aisCategoriesList");
    if (!list) return;

    const categories = await loadCategoriesFromStorage();
    if (!categories.length) {
      setSafeHtml(list, '<div class="ais-folders-empty">No categories. Add one below.</div>');
      return;
    }

    const byName = {};
    categories.forEach(c => { byName[c.name] = (c.keywords || []).slice(); });

    setSafeHtml(list, categories.map(c => {
      const chips = (c.keywords || []).map(k => {
        return '<span class="ais-cat-chip" data-cat="' + escAttr(c.name) + '" data-kw="' + escAttr(k) + '">' +
          escHtml(k) + '<button class="ais-cat-chip-x" title="Remove keyword">×</button></span>';
      }).join('');
      return '<div class="ais-cat-row">' +
        '<div class="ais-cat-head">' +
          '<span class="ais-cat-name">' + escHtml(c.icon || '🏷️') + ' ' + escHtml(c.name) + '</span>' +
          '<button class="ais-cat-del" title="Delete category" data-cat="' + escAttr(c.name) + '">✕</button>' +
        '</div>' +
        '<div class="ais-cat-kws">' + chips +
          '<input type="text" class="ais-cat-kwadd" data-cat="' + escAttr(c.name) + '" placeholder="+ keyword">' +
        '</div>' +
      '</div>';
    }).join(''));

    // Wire up keyword chip removal
    list.querySelectorAll('.ais-cat-chip-x').forEach(btn => {
      btn.addEventListener('click', async function () {
        const chip = btn.closest('.ais-cat-chip');
        const cat = chip.getAttribute('data-cat'), kw = chip.getAttribute('data-kw');
        const updated = (byName[cat] || []).filter(k => k !== kw);
        await saveCategoryToStorage(cat, updated);
        await renderCategoryList();
        reclassifyAllEmails();
      });
    });

    // Wire up adding keywords
    list.querySelectorAll('.ais-cat-kwadd').forEach(inp => {
      inp.addEventListener('keydown', async function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const cat = inp.getAttribute('data-cat'), val = inp.value.trim();
        if (!val) return;
        const adds = val.split(',').map(s => s.trim()).filter(Boolean);
        let next = (byName[cat] || []).concat(adds);
        next = next.filter((k, i) => next.indexOf(k) === i); // dedupe
        inp.value = '';
        await saveCategoryToStorage(cat, next);
        await renderCategoryList();
        reclassifyAllEmails();
      });
    });

    // Wire up category deletion
    list.querySelectorAll('.ais-cat-del').forEach(btn => {
      btn.addEventListener('click', async function () {
        const name = btn.getAttribute('data-cat');
        if (!window.confirm('Delete category "' + name + '"?')) return;
        await deleteCategoryFromStorage(name);
        await renderCategoryList();
        reclassifyAllEmails();
      });
    });
  }

  function wireUpCategoryAdd() {
    const btn = $("#aisCatAdd");
    const nameInput = $("#aisCatName");
    const kwInput = $("#aisCatKeywords");
    if (!btn || !nameInput || !kwInput) return;

    async function add() {
      const n = nameInput.value.trim();
      if (!n) { nameInput.focus(); return; }
      const keywords = kwInput.value.split(',').map(s => s.trim()).filter(Boolean);
      btn.disabled = true;
      await saveCategoryToStorage(n, keywords);
      nameInput.value = '';
      kwInput.value = '';
      btn.disabled = false;
      await renderCategoryList();
      reclassifyAllEmails();
    }

    btn.addEventListener('click', add);
    kwInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  }

  async function reclassifyAllEmails() {
    const categories = await loadCategoriesFromStorage();
    emailCategories.clear();
    allMessages.forEach(msg => {
      const cat = classifyEmail(msg, categories);
      if (cat) emailCategories.set(msg.id, cat);
    });
  }

  // ══════════════════════════════════════════
  //  SUBSCRIPTIONS (Phase 4)
  // ══════════════════════════════════════════

  function computeSubscriptionStats(msgs) {
    const byDomain = {};
    msgs.forEach(m => {
      if (!m.domain || !m.date) return;
      const ts = Math.floor(new Date(m.date).getTime() / 1000);
      if (!ts || isNaN(ts)) return;
      if (!byDomain[m.domain]) byDomain[m.domain] = { dates: [], subjects: [], senders: {}, size: 0 };
      const g = byDomain[m.domain];
      g.dates.push(ts);
      if (m.subject) g.subjects.push(m.subject.toLowerCase());
      if (m.senderEmail) g.senders[m.senderEmail] = true;
      g.size += m.size || 0;
    });

    const results = [];
    Object.keys(byDomain).forEach(domain => {
      const g = byDomain[domain];
      if (g.dates.length < 3) return;
      g.dates.sort((a, b) => a - b);

      let totalGap = 0;
      for (let i = 1; i < g.dates.length; i++) totalGap += (g.dates[i] - g.dates[i - 1]) / 86400;
      const avgDays = totalGap / (g.dates.length - 1);

      let frequency;
      if (avgDays <= 1.5) frequency = "Daily";
      else if (avgDays <= 4) frequency = "Every few days";
      else if (avgDays <= 10) frequency = "Weekly";
      else if (avgDays <= 25) frequency = "Bi-weekly";
      else if (avgDays <= 55) frequency = "Monthly";
      else if (avgDays <= 100) frequency = "Quarterly";
      else frequency = "Occasional";

      if (frequency === "Occasional") return;

      const hasUnsubscribe = g.subjects.some(s => s.indexOf("unsubscribe") !== -1);

      results.push({
        domain: domain,
        email_count: g.dates.length,
        sender_count: Object.keys(g.senders).length,
        avg_interval_days: Math.round(avgDays * 10) / 10,
        frequency: frequency,
        is_newsletter: hasUnsubscribe,
        last_date_unix: g.dates[g.dates.length - 1],
        size_bytes: g.size
      });
    });

    return results.sort((a, b) => b.email_count - a.email_count);
  }

  async function renderSubscriptionsView() {
    const stats = computeSubscriptionStats(allMessages);
    if (!stats.length) {
      const container = $("#subscriptionsCards");
      if (container) setSafeHtml(container, '<div class="ais-folders-empty">No subscriptions detected.</div>');
      return;
    }

    renderSubscriptionChart(stats);
    renderSubscriptionFreqTabs(stats);
  }

  function renderSubscriptionChart(stats) {
    const freqCounts = {};
    stats.forEach(s => {
      freqCounts[s.frequency] = (freqCounts[s.frequency] || 0) + 1;
    });

    const freqOrder = ["Daily", "Every few days", "Weekly", "Bi-weekly", "Monthly", "Quarterly"];
    const data = freqOrder
      .filter(f => freqCounts[f])
      .map((f, i) => ({
        name: f,
        value: freqCounts[f],
        itemStyle: { color: colorFor(i) }
      }));

    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const textColor = isLight ? "#1a1d24" : "#eaedf2";

    initViewChart("chart-subscriptions-container", {
      backgroundColor: "transparent",
      tooltip: { trigger: "item", formatter: (p) => `${p.name}: ${p.value.toLocaleString()} subscriptions (${p.percent}%)`, textStyle: { color: textColor } },
      legend: { show: false },
      series: [{
        type: "pie",
        radius: ["38%", "68%"],
        center: ["50%", "50%"],
        data: data,
        label: { formatter: "{b}\n{d}%", fontSize: 11, color: textColor },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: isLight ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.4)" } }
      }]
    });
  }

  function renderSubscriptionFreqTabs(stats) {
    const tabs = $("#subscriptionsFreqTabs");
    if (!tabs) return;

    const freqs = ["All", "Newsletter", ...["Daily", "Every few days", "Weekly", "Bi-weekly", "Monthly", "Quarterly"]];
    setSafeHtml(tabs, freqs.map(f => {
      const count = f === "All" ? stats.length :
                    f === "Newsletter" ? stats.filter(s => s.is_newsletter).length :
                    stats.filter(s => s.frequency === f).length;
      return `<button class="sub-freq-tab ${f === 'All' ? 'active' : ''}" data-freq="${f}">${f} (${count})</button>`;
    }).join(''));

    tabs.querySelectorAll('.sub-freq-tab').forEach(btn => {
      btn.addEventListener('click', function () {
        tabs.querySelectorAll('.sub-freq-tab').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const freq = this.getAttribute('data-freq');
        renderSubscriptionCards(stats, freq);
      });
    });

    renderSubscriptionCards(stats, "All");
  }

  function renderSubscriptionCards(stats, filter) {
    let filtered = stats;
    if (filter === "Newsletter") filtered = stats.filter(s => s.is_newsletter);
    else if (filter !== "All") filtered = stats.filter(s => s.frequency === filter);

    const cards = $("#subscriptionsCards");
    if (!cards) return;

    if (!filtered.length) {
      setSafeHtml(cards, '<div class="ais-folders-empty">No subscriptions in this category.</div>');
      return;
    }

    setSafeHtml(cards, filtered.map((s, i) => {
      const lastDate = new Date(s.last_date_unix * 1000);
      const dateStr = lastDate.toLocaleDateString();
      const domain = displayDomain(s.domain);
      return `<div class="an-sub-card" style="border-left: 4px solid ${colorFor(i)}">
        <div class="an-sub-domain">${escHtml(domain)}</div>
        <div class="an-sub-badges">
          ${s.is_newsletter ? '<span class="an-sub-badge an-sub-newsletter">Newsletter</span>' : ''}
          <span class="an-sub-badge an-sub-freq">${escHtml(s.frequency)}</span>
        </div>
        <div class="an-sub-meta">
          <div><strong>${s.email_count}</strong> emails</div>
          <div><strong>${s.avg_interval_days}</strong> days avg</div>
          <div>Last: ${dateStr}</div>
        </div>
      </div>`;
    }).join(''));
  }

  // ══════════════════════════════════════════
  //  BY CATEGORIES VIEW
  // ══════════════════════════════════════════

  async function renderCategoriesView() {
    const container = $("#categoriesGrid");
    if (!container) return;

    // Seed default categories if not already done
    let categories = await loadCategoriesFromStorage();
    if (!categories || !categories.length) {
      for (const cat of DEFAULT_BUILT_IN_CATEGORIES) {
        await saveCategoryToStorage(cat.name, cat.keywords);
      }
      categories = await loadCategoriesFromStorage();
    }

    if (!categories || !categories.length) {
      setSafeHtml(container, '<div class="ais-folders-empty">No categories defined.</div>');
      return;
    }

    const entries = categories.map(cat => {
      const msgs = allMessages.length > 0 ? allMessages.filter(m => classifyEmail(m, [cat])) : [];
      const bySender = {};
      msgs.forEach(m => {
        const key = m.senderEmail || m.author || "Unknown";
        if (!bySender[key]) bySender[key] = { email: key, name: m.senderName || key, count: 0, msgs: [] };
        bySender[key].count++;
        bySender[key].msgs.push(m);
      });
      const senders = Object.values(bySender).sort((a, b) => b.count - a.count);
      return { ...cat, msgs, count: msgs.length, senders };
    }).sort((a, b) => b.count - a.count);

    setSafeHtml(container, entries.map((cat, i) => {
      const selected = cat.count > 0 && cat.msgs.every(m => selectedIds.has(m.id));
      const topSenders = cat.senders.slice(0, 5);

      const miniRows = topSenders.length
        ? topSenders.map(s => {
            const sSelected = s.msgs.every(m => selectedIds.has(m.id));
            return `
              <div class="category-mini-row ${sSelected ? "selected" : ""}" data-email="${escAttr(s.email)}">
                <div class="category-mini-info">
                  <div class="category-mini-name">${escHtml(s.name)}</div>
                  <div class="category-mini-email">${escHtml(displayEmail(s.email))}</div>
                </div>
                <div class="category-mini-count">${s.count.toLocaleString()}</div>
              </div>`;
          }).join("")
        : `<div class="insight-empty">No emails in this category yet.</div>`;

      return `
      <div class="category-card" data-cat="${escAttr(cat.name)}">
        <div class="category-card-head">
          <div class="category-card-title"><span class="category-icon">${escHtml(cat.icon)}</span><strong>${escHtml(cat.name)}</strong></div>
          <div class="category-card-count">${cat.count.toLocaleString()} emails</div>
        </div>
        <div class="category-keywords">${escHtml((cat.keywords || []).slice(0, 4).join(", "))}${cat.keywords && cat.keywords.length > 4 ? '…' : ''}</div>
        ${cat.count > 0 ? `<div id="chart-cat-${i}" class="chart-container category-card-chart"></div>` : ""}
        <div class="category-mini-list">${miniRows}</div>
        <button type="button" class="btn btn-secondary btn-small category-select-btn ${selected ? "active" : ""}" data-cat="${escAttr(cat.name)}" ${cat.count === 0 ? "disabled" : ""}>
          ${selected ? "✓ Selected" : `Select all ${cat.count.toLocaleString()} for Review`}
        </button>
      </div>`;
    }).join(''));

    const toggleSelectAll = (msgs) => {
      if (!msgs.length) return;
      const allSelected = msgs.every(m => selectedIds.has(m.id));
      msgs.forEach(m => {
        if (allSelected) selectedIds.delete(m.id);
        else selectedIds.add(m.id);
      });
      updateStats();
      renderCategoriesView();
    };

    // Per-card chart: top senders in that category
    entries.forEach((cat, i) => {
      if (!cat.count) return;
      const hostId = `chart-cat-${i}`;
      if (!document.getElementById(hostId)) return;

      const chartSenders = cat.senders.slice(0, 8);
      const data = chartSenders.map((s, si) => ({
        name: s.email,
        value: s.count,
        itemStyle: { color: colorFor(si) }
      }));

      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      const textColor = isLight ? "#1a1d24" : "#eaedf2";

      initViewChart(hostId, {
        backgroundColor: "transparent",
        tooltip: { trigger: "item", formatter: (p) => `${displayEmail(p.name)}: ${p.value.toLocaleString()} emails (${p.percent}%)`, textStyle: { color: textColor } },
        legend: { show: false },
        series: [{
          type: "pie",
          radius: ["45%", "72%"],
          center: ["50%", "50%"],
          data: data,
          label: { formatter: (p) => `${displayEmail(p.name)}\n${p.percent}%`, fontSize: 10, color: textColor },
          emphasis: { itemStyle: { shadowBlur: 8, shadowColor: isLight ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.4)" } }
        }]
      });

      const chart = document.getElementById(hostId).querySelector('.chart-host')._echartsInstance;
      if (chart) {
        chart.on("click", (params) => {
          const sender = chartSenders.find(s => s.email === params.name);
          if (sender) toggleSelectAll(sender.msgs);
        });
      }
    });

    container.querySelectorAll('.category-card').forEach((card, idx) => {
      const cat = entries[idx];

      card.querySelectorAll('.category-mini-row').forEach((row) => {
        row.addEventListener('click', () => {
          const sender = cat.senders.find(s => s.email === row.dataset.email);
          if (sender) toggleSelectAll(sender.msgs);
        });
      });

      const selectBtn = card.querySelector('.category-select-btn');
      if (selectBtn) {
        selectBtn.addEventListener('click', () => toggleSelectAll(cat.msgs));
      }
    });
  }

  // ══════════════════════════════════════════
  //  CONTACTS
  // ══════════════════════════════════════════
  const CONTACTS_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").concat(["#"]);

  /** One row per unique sender email, aggregated from the current (filtered) scan. Always raw/unmasked — masking is applied only at render/export time. */
  function getContactsData() {
    const msgs = getFilteredMessages();
    const byEmail = {};
    msgs.forEach((m) => {
      const email = (m.senderEmail || "").trim();
      if (!email) return;
      if (!byEmail[email]) {
        byEmail[email] = {
          email,
          name: m.senderName || "",
          domain: m.domain || "",
          count: 0,
          unread: 0,
          firstDate: m.date,
          lastDate: m.date,
        };
      }
      const c = byEmail[email];
      c.count++;
      if (!m.read) c.unread++;
      if (!c.name && m.senderName) c.name = m.senderName;
      if (new Date(m.date) > new Date(c.lastDate)) c.lastDate = m.date;
      if (new Date(m.date) < new Date(c.firstDate)) c.firstDate = m.date;
    });
    return Object.values(byEmail);
  }

  function contactLabel(c) {
    return (c.name && c.name.trim()) ? c.name.trim() : c.email;
  }

  function contactLetter(c) {
    const first = contactLabel(c).charAt(0).toUpperCase();
    return /[A-Z]/.test(first) ? first : "#";
  }

  function renderContactsView() {
    const listEl = $("#contactsList");
    const azEl = $("#contactsAzIndex");
    const searchInput = $("#contactsSearch");
    if (!listEl || !azEl || !searchInput) return;

    searchInput.oninput = () => renderContactsView();

    const query = (searchInput.value || "").toLowerCase().trim();
    let contacts = getContactsData();
    if (query) {
      contacts = contacts.filter((c) =>
        (c.name || "").toLowerCase().includes(query) ||
        c.email.toLowerCase().includes(query) ||
        (c.domain || "").toLowerCase().includes(query)
      );
    }
    contacts.sort((a, b) => contactLabel(a).localeCompare(contactLabel(b), undefined, { sensitivity: "base" }));

    const totalMsgs = getFilteredMessages().length;
    $("#contactsSummaryLabel").textContent =
      `${contacts.length.toLocaleString()} unique contact${contacts.length === 1 ? "" : "s"} from ${totalMsgs.toLocaleString()} scanned email${totalMsgs === 1 ? "" : "s"}.`;

    if (contacts.length === 0) {
      setSafeHtml(listEl, `<div class="selection-empty">No contacts match your search.</div>`);
      setSafeHtml(azEl, CONTACTS_ALPHABET.map((l) => `<button type="button" class="contacts-az-btn" disabled>${l}</button>`).join(""));
      return;
    }

    const groups = {};
    contacts.forEach((c) => {
      const letter = contactLetter(c);
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(c);
    });

    const sectionId = (letter) => `contacts-letter-${letter === "#" ? "hash" : letter}`;

    setSafeHtml(listEl, CONTACTS_ALPHABET.filter((l) => groups[l]).map((letter) => `
      <div class="contacts-section" id="${sectionId(letter)}">
        <div class="contacts-section-header">${letter}</div>
        ${groups[letter].map((c) => {
          const name = displaySenderName(c.name, c.email) || displayEmail(c.email);
          const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
          return `
          <div class="contact-row">
            <div class="contact-avatar" aria-hidden="true">${escHtml(initial)}</div>
            <div class="contact-main">
              <div class="contact-name">${escHtml(name)}</div>
              <div class="contact-email">${escHtml(displayEmail(c.email))}</div>
            </div>
            <div class="contact-domain">${escHtml(displayDomain(c.domain) || "")}</div>
            <div class="contact-count">${c.count.toLocaleString()} email${c.count === 1 ? "" : "s"}</div>
            <div class="contact-last">${escHtml(formatDate(c.lastDate))}</div>
          </div>`;
        }).join("")}
      </div>`).join(""));

    setSafeHtml(azEl, CONTACTS_ALPHABET.map((letter) => {
      const has = !!groups[letter];
      return `<button type="button" class="contacts-az-btn" data-target="${sectionId(letter)}" ${has ? "" : "disabled"}>${letter}</button>`;
    }).join(""));

    azEl.querySelectorAll(".contacts-az-btn[data-target]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const section = document.getElementById(btn.dataset.target);
        if (section) section.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    });
  }

  function exportContactsCSV() {
    const contacts = getContactsData().sort((a, b) => contactLabel(a).localeCompare(contactLabel(b), undefined, { sensitivity: "base" }));
    const header = "Name,Email,Domain,Email Count,Unread Count,First Email,Last Email\n";
    const rows = contacts.map((c) => [
      `"${(c.name || "").replace(/"/g, '""')}"`,
      c.email,
      c.domain,
      c.count,
      c.unread,
      c.firstDate,
      c.lastDate,
    ].join(",")).join("\n");
    downloadFile(header + rows, "inboxpie-contacts.csv", "text/csv");
  }

  function exportContactsJSON() {
    const contacts = getContactsData().sort((a, b) => contactLabel(a).localeCompare(contactLabel(b), undefined, { sensitivity: "base" }));
    const report = contacts.map((c) => ({
      name: c.name || null,
      email: c.email,
      domain: c.domain,
      emailCount: c.count,
      unreadCount: c.unread,
      firstEmail: c.firstDate,
      lastEmail: c.lastDate,
    }));
    downloadFile(JSON.stringify(report, null, 2), "inboxpie-contacts.json", "application/json");
  }

  init();
})();
