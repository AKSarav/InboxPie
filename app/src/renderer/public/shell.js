// shell.js — onboarding, 3-step account/folder setup, left-nav sync
(function () {
  "use strict";

  var ONBOARDING_KEY = "inboxpie-onboarding-done";
  var ACCOUNT_KEY    = "inboxpie-selected-account";
  var PROVIDER_KEY   = "inboxpie-selected-provider";

  // ── Screen management ──────────────────────────────────────────────────────

  var SCREENS = ["onboardingScreen", "accountScreen", "appShell"];

  function showScreen(id) {
    SCREENS.forEach(function (name) {
      var el = document.getElementById(name);
      if (el) el.classList.toggle("screen-active", el.id === id);
    });
  }

  // Steps live inside #accountScreen
  var STEPS = ["providerStep", "accountStep", "folderStep"];

  function showStep(id) {
    STEPS.forEach(function (name) {
      var el = document.getElementById(name);
      if (el) el.style.display = el.id === id ? "" : "none";
    });
  }

  // ── Onboarding ─────────────────────────────────────────────────────────────

  if (!localStorage.getItem(ONBOARDING_KEY)) {
    showScreen("onboardingScreen");
    var fill = document.querySelector(".onboarding-loader-fill");
    if (fill) {
      requestAnimationFrame(function () {
        fill.style.transition = "width 2.2s cubic-bezier(0.4, 0, 0.2, 1)";
        fill.style.width = "100%";
      });
    }
    setTimeout(function () {
      localStorage.setItem(ONBOARDING_KEY, "1");
      var onb = document.getElementById("onboardingScreen");
      if (onb) { onb.style.opacity = "0"; onb.style.transition = "opacity 0.4s ease"; }
      setTimeout(function () { showScreen("accountScreen"); initProviderStep(); }, 420);
    }, 2600);
  } else {
    showScreen("accountScreen");
    initProviderStep();
  }

  // ── Step 1: Provider selection ─────────────────────────────────────────────

  function initProviderStep() {
    var appleMailBtn = document.getElementById("appleMailProvider");
    if (appleMailBtn) {
      appleMailBtn.addEventListener("click", function () { showAccountStep("apple-mail"); });
    }
  }

  // ── Step 2: Account selection ──────────────────────────────────────────────

  // State shared between step 2 and step 3
  var activeProviderId  = null;
  var activeAccountId   = null;  // UUID or "all"
  var activeAccountName = null;  // resolved display name

  function showAccountStep(providerId) {
    activeProviderId = providerId;
    localStorage.setItem(PROVIDER_KEY, providerId);

    showStep("accountStep");

    var title = document.getElementById("accountPickerTitle");
    var sub   = document.getElementById("accountPickerSub");
    if (title) title.textContent = "Select account";
    if (sub)   sub.textContent   = "Choose which Apple Mail account to analyze";

    initAccountStep(providerId);

    // Back from accounts → providers
    var backBtn = document.getElementById("backToProviders");
    if (backBtn && !backBtn.dataset.wired) {
      backBtn.dataset.wired = "1";
      backBtn.addEventListener("click", function () {
        showStep("providerStep");
        var t = document.getElementById("accountPickerTitle");
        var s = document.getElementById("accountPickerSub");
        if (t) t.textContent = "Connect your email";
        if (s) s.textContent = "Choose your email app to get started";
      });
    }
  }

  // ── Email masking helpers ──────────────────────────────────────────────────

  var maskingEnabled = true;

  function maskDomain(domain) {
    var parts = domain.split(".");
    if (parts.length <= 2) {
      return parts[0].length <= 3 ? domain : parts[0].charAt(0) + "***." + parts.slice(1).join(".");
    }
    return "***." + parts.slice(-2).join(".");
  }

  function maskEmail(email) {
    if (!email || !email.includes("@")) return email;
    var at     = email.indexOf("@");
    var local  = email.slice(0, at);
    var domain = email.slice(at + 1);
    return (local.length <= 1 ? local + "***" : local.charAt(0) + "***") + "@" + maskDomain(domain);
  }

  function maskText(text) {
    return text.replace(
      /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
      function (_, local, domain) { return maskEmail(local + "@" + domain); }
    );
  }

  function displayText(raw) { return maskingEnabled ? maskText(raw) : raw; }

  // ── initAccountStep ────────────────────────────────────────────────────────

  var accountStepLoaded = false;
  var loadedAccounts    = [];

  function initAccountStep(providerId) {
    var cardList    = document.getElementById("accountCardList");
    var continueBtn = document.getElementById("accountContinueBtn");
    var maskToggle  = document.getElementById("accountMaskToggle");
    var maskIconOff = document.getElementById("maskIconOff");
    var maskIconOn  = document.getElementById("maskIconOn");

    if (!cardList || !continueBtn) return;

    activeAccountId = localStorage.getItem(ACCOUNT_KEY) || "all";

    // Mask toggle (wire once)
    if (maskToggle && !maskToggle.dataset.wired) {
      maskToggle.dataset.wired = "1";
      maskToggle.addEventListener("click", function () {
        maskingEnabled = !maskingEnabled;
        maskToggle.title = maskingEnabled
          ? "Emails masked. Click to reveal." : "Emails visible. Click to mask.";
        if (maskIconOff) maskIconOff.style.display = maskingEnabled ? "" : "none";
        if (maskIconOn)  maskIconOn.style.display  = maskingEnabled ? "none" : "";
        maskToggle.classList.toggle("account-mask-btn-active", !maskingEnabled);
        renderAccountCards();
      });
    }

    // Load accounts once per session
    if (!accountStepLoaded) {
      accountStepLoaded = true;
      cardList.innerHTML = '<div class="account-loading"><svg class="account-loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Loading accounts…</div>';

      window.inboxpie.getAccountsForProvider(providerId).then(function (accounts) {
        loadedAccounts = accounts || [];
        syncAccountSelect(loadedAccounts);
        renderAccountCards();

        console.log("[InboxPie] accounts received from provider:", JSON.stringify(accounts));
      }).catch(function (err) {
        cardList.innerHTML = '<div class="account-error">Could not load accounts: ' + escHtml(String(err && err.message ? err.message : err)) + '</div>';
      });
    } else {
      renderAccountCards();
    }

    // Continue → folder step (wire once)
    if (continueBtn && !continueBtn.dataset.wired) {
      continueBtn.dataset.wired = "1";
      continueBtn.addEventListener("click", function () {
        if (!activeAccountId) return;
        var name = activeAccountId === "all"
          ? "All Accounts"
          : (loadedAccounts.find(function (a) { return a.id === activeAccountId; }) || {}).name || activeAccountId;
        activeAccountName = name;
        showFolderStep(providerId, activeAccountId, activeAccountName);
      });
    }

    function renderAccountCards() {
      if (loadedAccounts.length === 0) return;
      cardList.innerHTML = "";
      cardList.appendChild(buildAllCard(loadedAccounts));
      loadedAccounts.forEach(function (account) {
        cardList.appendChild(buildAccountCard(account));
      });
      continueBtn.disabled = false;
    }

    function buildAllCard(accounts) {
      var isSelected = activeAccountId === "all";
      var card = document.createElement("div");
      card.className = "account-card" + (isSelected ? " account-card-active" : "");

      var subtitle = accounts.map(function (a) { return displayText(a.name); }).join(" · ") || "All detected accounts";

      card.innerHTML =
        '<div class="account-card-main">' +
          '<div class="account-card-icon account-card-icon-all" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 12h18M3 17h12"/></svg>' +
          '</div>' +
          '<div class="account-card-info">' +
            '<span class="account-card-name">All Accounts</span>' +
            '<span class="account-card-sub">' + subtitle + '</span>' +
          '</div>' +
          (isSelected ? '<span class="account-card-check">&#10003;</span>' : "") +
        '</div>';

      card.addEventListener("click", function () {
        activeAccountId = "all";
        localStorage.setItem(ACCOUNT_KEY, "all");
        syncAccountSelectValue("all");
        renderAccountCards();
        continueBtn.disabled = false;
      });
      return card;
    }

    function buildAccountCard(account) {
      var isSelected  = activeAccountId === account.id;
      var displayName = displayText(account.name);
      var typeLabel   = (account.type || "").toUpperCase();

      var card = document.createElement("div");
      card.className = "account-card" + (isSelected ? " account-card-active" : "");

      card.innerHTML =
        '<div class="account-card-main">' +
          '<div class="account-card-icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9l9 6 9-6"/></svg>' +
          '</div>' +
          '<div class="account-card-info">' +
            '<span class="account-card-name">' + escHtml(displayName) + '</span>' +
            (typeLabel ? '<span class="account-card-type">' + escHtml(typeLabel) + '</span>' : "") +
          '</div>' +
          (isSelected ? '<span class="account-card-check">&#10003;</span>' : "") +
        '</div>';

      card.addEventListener("click", function () {
        activeAccountId = account.id;
        localStorage.setItem(ACCOUNT_KEY, account.id);
        syncAccountSelectValue(account.id);
        renderAccountCards();
        continueBtn.disabled = false;
      });
      return card;
    }
  }

  // ── Step 3: Folder selection ───────────────────────────────────────────────

  // selectedFolderPaths: Set of folder path strings for the active account
  var selectedFolderPaths = new Set();

  function showFolderStep(providerId, accountId, accountName) {
    showStep("folderStep");

    // Expand to full viewport for the folder step
    var acctScreen = document.getElementById("accountScreen");
    if (acctScreen) acctScreen.classList.add("folder-step-active");

    var title = document.getElementById("accountPickerTitle");
    var sub   = document.getElementById("accountPickerSub");
    if (title) title.textContent = "Select folders";
    if (sub)   sub.textContent   = "Choose which folders to include in the scan";

    // Account breadcrumb chip
    var chip = document.getElementById("folderStepAccountChip");
    if (chip) chip.textContent = displayText(accountName || accountId);

    // Back → account step (remove full-screen class when leaving folder step)
    var backBtn = document.getElementById("backToAccounts");
    if (backBtn && !backBtn.dataset.wired) {
      backBtn.dataset.wired = "1";
      backBtn.addEventListener("click", function () {
        var acctScreen = document.getElementById("accountScreen");
        if (acctScreen) acctScreen.classList.remove("folder-step-active");
        showAccountStep(providerId);
      });
    }

    initFolderStep(providerId, accountId);
  }

  function initFolderStep(providerId, accountId) {
    var list       = document.getElementById("folderCheckList");
    var scanBtn    = document.getElementById("startScanBtn");
    var scanLabel  = document.getElementById("startScanLabel");
    var allBtn     = document.getElementById("folderSelectAll");
    var inboxBtn   = document.getElementById("folderSelectInbox");
    var noneBtn    = document.getElementById("folderSelectNone");

    if (!list || !scanBtn) return;

    selectedFolderPaths = new Set();
    var indexedFolderPaths = new Set();
    list.innerHTML = '<div class="account-loading"><svg class="account-loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Loading folders…</div>';
    scanBtn.disabled = true;

    var acctIdForApi = accountId === "all" ? null : accountId;

    Promise.all([
      window.inboxpie.getFoldersForAccount(providerId, acctIdForApi),
      window.inboxpie.invoke({ action: "getIndexingStats" }).catch(function () { return null; }),
    ]).then(function (results) {
      var folders     = results[0];
      var statsResult = results[1];
      if (statsResult && statsResult.folders) {
        statsResult.folders.forEach(function (f) {
          var name = typeof f === "object" ? (f.folder || "") : String(f);
          if (name) indexedFolderPaths.add(name.toLowerCase());
        });
      }
      if (!folders || folders.length === 0) {
        list.innerHTML = '<div class="account-empty">No folders found.</div>';
        return;
      }

      // Default selection: inbox + sent + archive (skip trash/junk)
      folders.forEach(function (f) {
        if (f.type === "inbox" || f.type === "sent" || f.type === "archives") {
          selectedFolderPaths.add(f.path);
        }
      });

      renderFolderList(folders);
      updateScanBtn(folders);
      scanBtn.disabled = false;

      // Quick-select buttons
      if (allBtn && !allBtn.dataset.wired) {
        allBtn.dataset.wired = "1";
        allBtn.addEventListener("click", function () {
          folders.forEach(function (f) { selectedFolderPaths.add(f.path); });
          renderFolderList(folders);
          updateScanBtn(folders);
        });
      }
      if (inboxBtn && !inboxBtn.dataset.wired) {
        inboxBtn.dataset.wired = "1";
        inboxBtn.addEventListener("click", function () {
          selectedFolderPaths = new Set();
          folders.forEach(function (f) {
            if (f.type === "inbox") selectedFolderPaths.add(f.path);
          });
          renderFolderList(folders);
          updateScanBtn(folders);
        });
      }
      if (noneBtn && !noneBtn.dataset.wired) {
        noneBtn.dataset.wired = "1";
        noneBtn.addEventListener("click", function () {
          selectedFolderPaths = new Set();
          renderFolderList(folders);
          updateScanBtn(folders);
        });
      }

      // Start Scan
      if (!scanBtn.dataset.wired) {
        scanBtn.dataset.wired = "1";
        scanBtn.addEventListener("click", function () {
          if (selectedFolderPaths.size === 0) return;

          var folderSelections = Array.from(selectedFolderPaths).map(function (p) {
            // accountId for each folder: for "all" accounts, use the account
            // stored in the folder object; for single account, use activeAccountId
            var folder = folders.find(function (f) { return f.path === p; });
            return { accountId: folder ? folder.accountId : activeAccountId, path: p };
          });

          window.inboxpie.setScanOverride({
            accountId: accountId === "all" ? null : accountId,
            folderSelections: folderSelections,
          });

          syncAccountSelectValue(accountId === "all" ? "all" : accountId);
          window.inboxpie.setActiveProvider(providerId).catch(function () {});
          transitionToAppAndScan();
        });
      }

    }).catch(function (err) {
      list.innerHTML = '<div class="account-error">Could not load folders: ' + escHtml(String(err && err.message ? err.message : err)) + '</div>';
    });

    function renderFolderList(folders) {
      list.innerHTML = "";

      var SYSTEM_TYPES = ["inbox", "sent", "drafts", "archives", "trash", "junk"];
      var SYSTEM_ORDER = ["inbox", "sent", "archives", "drafts", "trash", "junk"];

      // System folders in defined order
      var systemFolders = SYSTEM_ORDER
        .map(function (t) { return folders.filter(function (f) { return f.type === t; }); })
        .reduce(function (acc, arr) { return acc.concat(arr); }, []);

      // Custom folders alphabetically
      var customFolders = folders
        .filter(function (f) { return !SYSTEM_TYPES.includes(f.type); })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });

      if (systemFolders.length > 0) {
        var sysSection = document.createElement("div");
        sysSection.className = "folder-grid-section";
        var sysHeader = document.createElement("div");
        sysHeader.className = "folder-grid-header";
        sysHeader.textContent = "System Folders";
        sysSection.appendChild(sysHeader);
        var sysGrid = document.createElement("div");
        sysGrid.className = "folder-grid folder-grid-system";
        systemFolders.forEach(function (f) { sysGrid.appendChild(buildFolderCard(f, folders)); });
        sysSection.appendChild(sysGrid);
        list.appendChild(sysSection);
      }

      if (customFolders.length > 0) {
        var customSection = document.createElement("div");
        customSection.className = "folder-grid-section";
        var customHeader = document.createElement("div");
        customHeader.className = "folder-grid-header";
        customHeader.textContent = "Folders (" + customFolders.length + ")";
        customSection.appendChild(customHeader);
        var customGrid = document.createElement("div");
        customGrid.className = "folder-grid folder-grid-custom";
        customFolders.forEach(function (f) { customGrid.appendChild(buildFolderCard(f, folders)); });
        customSection.appendChild(customGrid);
        list.appendChild(customSection);
      }
    }

    function buildFolderCard(folder, allFolders) {
      var isChecked = selectedFolderPaths.has(folder.path);
      var isIndexed = indexedFolderPaths.has((folder.path || "").toLowerCase());
      var count     = folder.totalCount  || 0;
      var unread    = folder.unreadCount || 0;
      var type      = folder.type || "custom";
      var isSystem  = ["inbox","sent","drafts","archives","trash","junk"].includes(type);

      var card = document.createElement("label");
      card.className = "folder-card folder-card-" + escHtml(type) +
        (isChecked ? " folder-card-selected" : "") +
        (isSystem  ? " folder-card-system"   : " folder-card-sm");
      card.setAttribute("for", "fc-" + escHtml(folder.path));

      var countDisplay = count > 0 ? count.toLocaleString() : "0";

      // Check mark is absolute-positioned top-right; icon + name + count centered
      card.innerHTML =
        '<span class="folder-card-check-mark" aria-hidden="true">' +
          '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,5.5 3.8,8.5 9,2"/></svg>' +
        '</span>' +
        '<input type="checkbox" id="fc-' + escHtml(folder.path) + '" class="folder-cb-hidden"' +
          (isChecked ? ' checked' : '') + '>' +
        '<span class="folder-card-icon folder-icon-' + escHtml(type) + '" aria-hidden="true">' +
          escHtml((folder.name || '?').charAt(0).toUpperCase()) +
        '</span>' +
        '<div class="folder-card-name">' + escHtml(folder.name) + '</div>' +
        '<div class="folder-card-count">' + countDisplay + '</div>' +
        (isIndexed ? '<span class="folder-indexed-badge">Indexed</span>' : '');

      var cb = card.querySelector("input");
      if (cb) {
        cb.addEventListener("change", function () {
          if (cb.checked) {
            selectedFolderPaths.add(folder.path);
            card.classList.add("folder-card-selected");
          } else {
            selectedFolderPaths.delete(folder.path);
            card.classList.remove("folder-card-selected");
          }
          updateScanBtn(allFolders);
        });
      }

      return card;
    }

    function getFolderIcon(type, large) {
      var sz = large ? "20" : "16";
      var s  = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
      var icons = {
        inbox:
          '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" ' + s + '>' +
          '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
          '<path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>' +
          '</svg>',
        sent:
          '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" ' + s + '>' +
          '<line x1="22" y1="2" x2="11" y2="13"/>' +
          '<polygon points="22 2 15 22 11 13 2 9 22 2"/>' +
          '</svg>',
        drafts:
          '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" ' + s + '>' +
          '<path d="M12 20h9"/>' +
          '<path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>' +
          '</svg>',
        archives:
          '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" ' + s + '>' +
          '<polyline points="21 8 21 21 3 21 3 8"/>' +
          '<rect x="1" y="3" width="22" height="5"/>' +
          '<line x1="10" y1="12" x2="14" y2="12"/>' +
          '</svg>',
        trash:
          '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" ' + s + '>' +
          '<polyline points="3 6 5 6 21 6"/>' +
          '<path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>' +
          '</svg>',
        junk:
          '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" ' + s + '>' +
          '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
          '<line x1="12" y1="9" x2="12" y2="13"/>' +
          '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
          '</svg>',
        custom:
          '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" ' + s + '>' +
          '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>' +
          '</svg>',
      };
      return icons[type] || icons.custom;
    }

    function updateScanBtn(folders) {
      var n = selectedFolderPaths.size;
      if (scanLabel) {
        scanLabel.textContent = n === 0
          ? "Select at least one folder"
          : "Scan " + n + " folder" + (n === 1 ? "" : "s");
      }
      scanBtn.disabled = n === 0;
    }
  }

  // ── Sync #accountSelect so dashboard.js reads the right value ─────────────

  function syncAccountSelect(accounts) {
    var sel = document.getElementById("accountSelect");
    if (!sel) return;
    while (sel.options.length > 0) sel.remove(0);

    var allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All Accounts";
    sel.appendChild(allOpt);

    accounts.forEach(function (account) {
      var opt = document.createElement("option");
      opt.value = account.id;
      opt.textContent = account.name + " (" + account.type + ")";
      opt.dataset.originalText = opt.textContent;
      sel.appendChild(opt);
    });

    syncAccountSelectValue(localStorage.getItem(ACCOUNT_KEY) || "all");
  }

  function syncAccountSelectValue(accountId) {
    var sel = document.getElementById("accountSelect");
    if (!sel) return;
    sel.value = accountId;
    sel.dispatchEvent(new Event("change"));
  }

  // ── Transition to app shell and trigger scan ───────────────────────────────

  function transitionToAppAndScan() {
    var accountScreen = document.getElementById("accountScreen");
    if (accountScreen) {
      accountScreen.style.opacity    = "0";
      accountScreen.style.transition = "opacity 0.3s ease";
    }
    setTimeout(function () {
      showScreen("appShell");
      setTimeout(function () {
        var scanBtn = document.getElementById("scanBtn");
        if (scanBtn && !scanBtn.disabled) scanBtn.click();
      }, 100);
    }, 320);
  }

  // ── Analytics nav visibility (watches #viewTabs signal from dashboard.js) ──

  var viewTabs = document.getElementById("viewTabs");
  if (viewTabs) {
    new MutationObserver(function () {
      var visible = viewTabs.style.display === "flex";
      var navAnalytics = document.getElementById("navAnalytics");
      if (navAnalytics) navAnalytics.style.display = visible ? "block" : "none";
      // Intelligence nav is shown by dashboard.js after scan;
      // hide it here only when viewTabs itself disappears (reset flow)
      if (!visible) {
        var navIntelligence = document.getElementById("navIntelligence");
        if (navIntelligence) navIntelligence.style.display = "none";
      }
    }).observe(viewTabs, { attributes: true, attributeFilter: ["style"] });
  }

  // ── Left-nav active state sync ─────────────────────────────────────────────

  var leftNav = document.getElementById("leftNav");
  if (leftNav) {
    new MutationObserver(function () {
      document.querySelectorAll(".left-nav .tab.nav-item").forEach(function (item) {
        item.toggleAttribute("aria-current", item.classList.contains("active"));
      });
    }).observe(leftNav, { attributes: true, attributeFilter: ["class"], subtree: true });
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

})();
