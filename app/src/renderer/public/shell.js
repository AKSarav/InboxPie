// shell.js — onboarding, 3-step account/folder setup, left-nav sync
(function () {
  "use strict";

  var ONBOARDING_KEY = "inboxpie-onboarding-done";
  var ACCOUNT_KEY    = "inboxpie-selected-account";
  var PROVIDER_KEY   = "inboxpie-selected-provider";

  // ── Screen management ──────────────────────────────────────────────────────

  var SCREENS = ["onboardingScreen", "setupScreen", "accountScreen", "appShell"];

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

  // ── After-setup transition (to normal onboarding → account flow) ───────────

  function enterApp() {
    browser.runtime.sendMessage({ action: "markAppReady" }).catch(function () {});
    if (!localStorage.getItem(ONBOARDING_KEY)) {
      showScreen("onboardingScreen");
      var fill = document.querySelector(".onboarding-loader-fill");
      if (fill) {
        requestAnimationFrame(function () {
          fill.style.transition = "width 1.4s cubic-bezier(0.4, 0, 0.2, 1)";
          fill.style.width = "100%";
        });
      }
      setTimeout(function () {
        localStorage.setItem(ONBOARDING_KEY, "1");
        var onb = document.getElementById("onboardingScreen");
        if (onb) { onb.style.opacity = "0"; onb.style.transition = "opacity 0.4s ease"; }
        setTimeout(function () { showScreen("accountScreen"); initProviderStep(); }, 420);
      }, 1600);
    } else {
      showScreen("accountScreen");
      initProviderStep();
    }
  }

  // ── Setup screen ──────────────────────────────────────────────────────────
  //
  // Shown when app_ready preference is not "yes".
  // Polls getSetupStatus every 3s; also listens for live embeddingProgress events.

  var _setupPollTimer = null;
  var _setupStatus    = null;   // latest server response

  function startSetupScreen() {
    showScreen("setupScreen");
    pollSetupStatus();

    // Wire enter and skip buttons
    var enterBtn = document.getElementById("setupEnterBtn");
    var skipBtn  = document.getElementById("setupSkipBtn");
    if (enterBtn) enterBtn.addEventListener("click", function () { stopSetupPoll(); enterApp(); });
    if (skipBtn)  skipBtn.addEventListener("click",  function () { stopSetupPoll(); enterApp(); });

    // Listen for live embedding progress events (fired from main process prewarm)
    browser.runtime.onMessage.addListener(function (msg) {
      if (!msg || msg.action !== "embeddingProgress") return;
      applyEmbeddingProgress(msg);
      // Re-derive overall state from the latest full status merged with live progress
      if (_setupStatus) updateSetupUI(_setupStatus);
    });
  }

  function stopSetupPoll() {
    if (_setupPollTimer) { clearTimeout(_setupPollTimer); _setupPollTimer = null; }
  }

  function pollSetupStatus() {
    browser.runtime.sendMessage({ action: "getSetupStatus" }).then(function (s) {
      _setupStatus = s;
      updateSetupUI(s);
      // Keep polling until app is ready (all required tasks done)
      if (!s.appReady) {
        _setupPollTimer = setTimeout(pollSetupStatus, 3000);
      }
    }).catch(function () {
      _setupPollTimer = setTimeout(pollSetupStatus, 5000);
    });
  }

  // Map a live embeddingProgress event onto the UI without waiting for a full poll
  function applyEmbeddingProgress(msg) {
    var task   = document.getElementById("setupTaskEmbedding");
    var badge  = document.getElementById("setupBadgeEmbedding");
    var desc   = document.getElementById("setupDescEmbedding");
    var barW   = document.getElementById("setupBarEmbedding");
    var fill   = document.getElementById("setupBarFillEmbedding");
    var pctEl  = document.getElementById("setupPctEmbedding");
    if (!task) return;

    if (msg.phase === "ready") {
      setTaskStatus(task, badge, "done", "Ready");
      if (desc)  desc.textContent  = "bge-large-en-v1.5 loaded in memory";
      if (barW)  barW.style.display = "none";
    } else if (msg.phase === "downloading") {
      setTaskStatus(task, badge, "active", "Downloading");
      if (barW)  barW.style.display = "";
      var pct = msg.pct || 0;
      if (fill)  fill.style.width = pct + "%";
      if (pctEl) pctEl.textContent = pct + "%";
    } else if (msg.phase === "error") {
      setTaskStatus(task, badge, "error", "Failed");
      if (desc) desc.textContent = "Download failed: " + (msg.error || "unknown error");
    }
  }

  function setTaskStatus(taskEl, badgeEl, status, badgeText) {
    if (taskEl)  taskEl.setAttribute("data-status", status);
    if (badgeEl) badgeEl.textContent = badgeText;
  }

  function updateSetupUI(s) {
    if (!s || !s.tasks) return;

    var requiredDone = 0;
    var requiredTotal = 0;
    var totalPct = 0;
    var taskCount = s.tasks.length;

    s.tasks.forEach(function (t) {
      var taskEl  = document.getElementById("setupTaskEmbedding".replace("Embedding", capitalize(t.id)));
      var badgeEl = document.getElementById("setupBadgeEmbedding".replace("Embedding", capitalize(t.id)));
      var descEl  = document.getElementById("setupDescEmbedding".replace("Embedding", capitalize(t.id)));
      var barW    = document.getElementById("setupBarEmbedding".replace("Embedding", capitalize(t.id)));
      var fill    = document.getElementById("setupBarFillEmbedding".replace("Embedding", capitalize(t.id)));
      var pctEl   = document.getElementById("setupPctEmbedding".replace("Embedding", capitalize(t.id)));

      // Use element IDs that match task IDs
      taskEl  = document.getElementById("setupTask"  + capitalize(t.id));
      badgeEl = document.getElementById("setupBadge" + capitalize(t.id));
      descEl  = document.getElementById("setupDesc"  + capitalize(t.id));
      barW    = document.getElementById("setupBar"   + capitalize(t.id));
      fill    = document.getElementById("setupBarFill" + capitalize(t.id));
      pctEl   = document.getElementById("setupPct"   + capitalize(t.id));

      var status = t.status;  // "done" | "active" | "warn" | "error" | "pending"
      var badgeText =
        status === "done"   ? "Done" :
        status === "active" ? "Downloading" :
        status === "warn"   ? "Optional" :
        status === "error"  ? "Error" : "Pending";

      if (taskEl)  taskEl.setAttribute("data-status", status);
      if (badgeEl) badgeEl.textContent = badgeText;
      if (descEl && t.detail) descEl.textContent = t.detail;

      // Show progress bar only for active embedding download
      if (t.id === "embedding" && barW) {
        if (status === "active") {
          barW.style.display = "";
          if (fill)  fill.style.width = (t.pct || 0) + "%";
          if (pctEl) pctEl.textContent = (t.pct || 0) + "%";
        } else {
          barW.style.display = "none";
        }
      }

      totalPct += (status === "done" ? 100 : (t.pct || 0));
      if (t.required) {
        requiredTotal++;
        if (status === "done") requiredDone++;
      }
    });

    // Overall progress bar
    var overallPct = taskCount > 0 ? Math.round(totalPct / taskCount) : 0;
    var overallFill  = document.getElementById("setupOverallFill");
    var overallLabel = document.getElementById("setupOverallLabel");
    if (overallFill)  overallFill.style.width = overallPct + "%";
    if (overallLabel) {
      if (overallPct >= 100) {
        overallLabel.textContent = "All set! Ready to go.";
      } else {
        overallLabel.textContent = "Setting up… " + overallPct + "% complete";
      }
    }

    // Show Enter button when all REQUIRED tasks are done
    var allRequiredDone = requiredDone >= requiredTotal;
    var enterBtn = document.getElementById("setupEnterBtn");
    var skipNote = document.getElementById("setupSkipNote");
    if (enterBtn) enterBtn.style.display = allRequiredDone ? "" : "none";
    if (skipNote) skipNote.style.display = allRequiredDone ? "none" : "";

    // Auto-advance when app is already marked ready
    if (s.appReady) {
      stopSetupPoll();
      var el = document.getElementById("setupScreen");
      if (el) { el.style.opacity = "0"; el.style.transition = "opacity 0.4s ease"; }
      setTimeout(function () { enterApp(); }, 420);
    }
  }

  function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : "";
  }

  // ── Boot: decide which screen to show ──────────────────────────────────────

  // Ask the backend whether the app is fully set up.
  // Keep the screen hidden until we know (avoids flash of wrong screen).
  browser.runtime.sendMessage({ action: "getPreference", key: "app_ready" })
    .then(function (res) {
      if (res && res.value === "yes") {
        // App is ready — fast path to the normal onboarding/account flow
        enterApp();
      } else {
        // First run or incomplete setup — show the setup screen
        startSetupScreen();
      }
    })
    .catch(function () {
      // IPC not yet ready (dev hot-reload edge case) — fall through to account screen
      enterApp();
    });

  // ── Step 1: Provider selection ─────────────────────────────────────────────

  function initProviderStep() {
    // Apple Mail is always wired; detection badge updated dynamically below.
    var appleMailBtn = document.getElementById("appleMailProvider");
    if (appleMailBtn) {
      appleMailBtn.addEventListener("click", function () { showAccountStep("apple-mail"); });
    }

    // Fetch provider list with detection flags, then enable/disable Thunderbird.
    if (window.inboxpie && window.inboxpie.getProviders) {
      window.inboxpie.getProviders().then(function (providers) {
        var tb = providers.find(function (p) { return p.id === "thunderbird"; });
        var tbBtn  = document.getElementById("thunderbirdProvider");
        var tbPill = document.getElementById("thunderbirdPill");
        if (!tbBtn) return;
        if (tb && tb.detected) {
          tbBtn.disabled = false;
          tbBtn.classList.remove("provider-row-disabled");
          var icon = tbBtn.querySelector(".provider-row-icon-dim");
          if (icon) icon.classList.remove("provider-row-icon-dim");
          if (tbPill) tbPill.remove();
          // Add arrow chevron matching Apple Mail button
          var arrow = document.createElement("svg");
          arrow.setAttribute("class", "provider-row-arrow");
          arrow.setAttribute("viewBox", "0 0 20 20");
          arrow.setAttribute("fill", "none");
          arrow.setAttribute("stroke", "currentColor");
          arrow.setAttribute("stroke-width", "1.75");
          arrow.setAttribute("stroke-linecap", "round");
          arrow.setAttribute("stroke-linejoin", "round");
          arrow.setAttribute("aria-hidden", "true");
          arrow.innerHTML = "<path d=\"M7 4l6 6-6 6\"/>";
          tbBtn.appendChild(arrow);
          tbBtn.addEventListener("click", function () { showAccountStep("thunderbird"); });
        } else {
          if (tbPill) tbPill.textContent = "Not Found";
        }
      }).catch(function () {});
    }
  }

  // ── Step 2: Account selection ──────────────────────────────────────────────

  // State shared between step 2 and step 3
  var activeProviderId  = null;
  var activeAccountId   = null;  // UUID or "all"
  var activeAccountName = null;  // resolved display name

  var APPLE_MAIL_BADGE =
    '<svg class="account-step-provider-icon" viewBox="0 0 20 20" aria-hidden="true">' +
      '<defs><linearGradient id="amGrad2" x1="0%" y1="0%" x2="0%" y2="100%">' +
        '<stop offset="0%" style="stop-color:#5ac8fa"/>' +
        '<stop offset="100%" style="stop-color:#007aff"/>' +
      '</linearGradient></defs>' +
      '<rect width="20" height="20" rx="4" fill="url(#amGrad2)"/>' +
      '<rect x="3" y="6" width="14" height="9" rx="1" fill="white" opacity="0.95"/>' +
      '<path d="M3 7.5 L10 12 L17 7.5" fill="none" stroke="url(#amGrad2)" stroke-width="1.2" stroke-linecap="round"/>' +
    '</svg>';

  var THUNDERBIRD_BADGE =
    '<img src="assets/thunderbird-logo.png" alt="" width="20" height="20" ' +
      'style="border-radius:4px;display:inline-block;vertical-align:middle;margin-right:6px;">';

  function showAccountStep(providerId) {
    activeProviderId = providerId;
    localStorage.setItem(PROVIDER_KEY, providerId);

    showStep("accountStep");

    var badge = document.getElementById("accountStepProviderBadge");
    if (badge) badge.innerHTML = providerId === "thunderbird" ? THUNDERBIRD_BADGE : APPLE_MAIL_BADGE;

    var title = document.getElementById("accountPickerTitle");
    var sub   = document.getElementById("accountPickerSub");
    if (title) title.textContent = "Select account";
    if (sub) {
      sub.textContent = providerId === "thunderbird"
        ? "Choose which Thunderbird account to analyze"
        : "Choose which Apple Mail account to analyze";
    }

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
  var accountStepProvider = null;   // which provider was last loaded
  var loadedAccounts    = [];

  function initAccountStep(providerId) {
    var cardList    = document.getElementById("accountCardList");
    var continueBtn = document.getElementById("accountContinueBtn");
    var maskToggle  = document.getElementById("accountMaskToggle");
    var maskIconOff = document.getElementById("maskIconOff");
    var maskIconOn  = document.getElementById("maskIconOn");

    if (!cardList || !continueBtn) return;

    // Reset state when switching providers so the new provider's accounts load fresh
    if (accountStepProvider !== providerId) {
      accountStepLoaded = false;
      accountStepProvider = providerId;
      loadedAccounts = [];
      continueBtn.disabled = true;
    }

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

    // Load accounts once per provider per session
    if (!accountStepLoaded) {
      accountStepLoaded = true;
      cardList.innerHTML = '<div class="account-loading"><svg class="account-loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Loading accounts…</div>';

      window.inboxpie.getAccountsForProvider(providerId).then(function (accounts) {
        loadedAccounts = accounts || [];
        console.log("[InboxPie] accounts received from provider:", providerId, JSON.stringify(accounts));
        syncAccountSelect(loadedAccounts);
        renderAccountCards();
      }).catch(function (err) {
        var errMsg = err && err.message ? err.message : String(err);
        var hint = "";
        if (errMsg.toLowerCase().includes("full disk access") || errMsg.toLowerCase().includes("eperm") || errMsg.toLowerCase().includes("eacces")) {
          hint = ' <a href="#" class="account-fda-link" onclick="window.inboxpie && window.inboxpie.openPrivacySettings && window.inboxpie.openPrivacySettings(); return false;">Open Privacy Settings</a>';
        }
        cardList.innerHTML = '<div class="account-error">Could not load accounts: ' + escHtml(errMsg) + hint + '</div>';
      });
    } else {
      renderAccountCards();
    }

    // Continue → folder step — always re-bind so provider switches work correctly
    continueBtn.onclick = function () {
      if (!activeAccountId) return;
      var name = activeAccountId === "all"
        ? "All Accounts"
        : (loadedAccounts.find(function (a) { return a.id === activeAccountId; }) || {}).name || activeAccountId;
      activeAccountName = name;
      showFolderStep(providerId, activeAccountId, activeAccountName);
    };

    function renderAccountCards() {
      if (loadedAccounts.length === 0) {
        var emptyMsg = providerId === "thunderbird"
          ? "No Thunderbird accounts found. Check that Thunderbird is configured with at least one account."
          : "No Apple Mail accounts found. Make sure <strong>Full Disk Access</strong> is granted to InboxPie in System Settings → Privacy &amp; Security → Full Disk Access.";
        cardList.innerHTML = '<div class="account-error">' + emptyMsg + '</div>';
        return;
      }
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

    // Provider badge (show which provider is selected)
    var providerBadge = document.getElementById("folderStepProviderBadge");
    if (providerBadge) {
      providerBadge.innerHTML = providerId === "thunderbird" ? THUNDERBIRD_BADGE : APPLE_MAIL_BADGE;
    }

    // Account breadcrumb chip
    var chip = document.getElementById("folderStepAccountChip");
    if (chip) chip.textContent = displayText(accountName || accountId);

    // Back → account step — always re-bind so the correct providerId is captured
    var backBtn = document.getElementById("backToAccounts");
    if (backBtn) {
      backBtn.onclick = function () {
        var acctScreen = document.getElementById("accountScreen");
        if (acctScreen) acctScreen.classList.remove("folder-step-active");
        showAccountStep(providerId);
      };
    }

    initFolderStep(providerId, accountId);
  }

  function initFolderStep(providerId, accountId) {
    var list      = document.getElementById("folderCheckList");
    var scanBtn   = document.getElementById("startScanBtn");
    var scanLabel = document.getElementById("startScanLabel");
    var allBtn    = document.getElementById("wizardFolderSelectAll");
    var inboxBtn  = document.getElementById("wizardFolderSelectInbox");
    var noneBtn   = document.getElementById("wizardFolderSelectNone");

    if (!list || !scanBtn) return;

    selectedFolderPaths = new Set();
    var indexedFolderPaths = new Set();
    list.innerHTML = '<div class="account-loading"><svg class="account-loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Loading folders…</div>';
    scanBtn.disabled = true;

    // Reset button handlers fresh on every call so provider switches work correctly
    if (allBtn)   allBtn.onclick   = null;
    if (inboxBtn) inboxBtn.onclick = null;
    if (noneBtn)  noneBtn.onclick  = null;
    scanBtn.onclick = null;

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

      // Quick-select buttons — use onclick so they're always fresh for the current folders
      if (allBtn) allBtn.onclick = function () {
        folders.forEach(function (f) { selectedFolderPaths.add(f.path); });
        renderFolderList(folders);
        updateScanBtn(folders);
      };
      if (inboxBtn) inboxBtn.onclick = function () {
        selectedFolderPaths = new Set();
        folders.forEach(function (f) {
          if (f.type === "inbox") selectedFolderPaths.add(f.path);
        });
        renderFolderList(folders);
        updateScanBtn(folders);
      };
      if (noneBtn) noneBtn.onclick = function () {
        selectedFolderPaths = new Set();
        renderFolderList(folders);
        updateScanBtn(folders);
      };

      // Start Scan — re-bound every time so it captures the current provider + folders
      scanBtn.onclick = function () {
        if (selectedFolderPaths.size === 0) return;

        var folderSelections = Array.from(selectedFolderPaths).map(function (p) {
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
      };

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
      var count     = folder.totalCount;
      var unread    = folder.unreadCount || 0;
      var type      = folder.type || "custom";
      var isSystem  = ["inbox","sent","drafts","archives","trash","junk"].includes(type);

      var card = document.createElement("label");
      card.className = "folder-card folder-card-" + escHtml(type) +
        (isChecked ? " folder-card-selected" : "") +
        (isSystem  ? " folder-card-system"   : " folder-card-sm");
      card.setAttribute("for", "fc-" + escHtml(folder.path));

      var countDisplay = count != null ? count.toLocaleString() : "—";

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

  // ── Indexing overlay + mini bar ──────────────────────────────────────────────
  //
  // Full overlay: blocks the screen while indexing starts. User can dismiss it via
  // "Use app" — indexing keeps running and a mini status bar appears instead.
  // Mini bar: bottom-right pill with live progress, Pause, and Expand buttons.

  var _indexDismissed = false;
  var _lastIdx = { done: 0, total: 0, folder: "" };

  function _setMiniProgress(pct) {
    var fill  = document.getElementById("indexingMiniBarFill");
    var pctEl = document.getElementById("indexingMiniPct");
    if (fill)  fill.style.width  = pct + "%";
    if (pctEl) pctEl.textContent = pct + "%";
  }

  function showIndexingOverlay(total) {
    _indexDismissed = false;
    _lastIdx = { done: 0, total: total || 0, folder: "" };
    var mini = document.getElementById("indexingMiniBar");
    if (mini) { mini.style.display = "none"; mini.style.opacity = ""; mini.style.transition = ""; }
    var el = document.getElementById("indexingOverlay");
    if (!el) return;
    var fill      = document.getElementById("indexingBarFill");
    var stats     = document.getElementById("indexingStatsText");
    var pctEl     = document.getElementById("indexingPctText");
    var folderRow = document.getElementById("indexingFolderRow");
    if (fill)      fill.style.width        = "0%";
    if (stats)     stats.textContent       = total ? "0 / " + Number(total).toLocaleString() + " emails" : "Starting\u2026";
    if (pctEl)     pctEl.textContent       = "0%";
    if (folderRow) folderRow.style.display = "none";
    el.style.opacity    = "1";
    el.style.transition = "";
    el.style.display    = "flex";
  }

  function updateIndexingOverlay(done, total, folder) {
    _lastIdx = { done: done, total: total, folder: folder };
    var pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;

    if (!_indexDismissed) {
      var el = document.getElementById("indexingOverlay");
      if (el && el.style.display !== "none") {
        var fill       = document.getElementById("indexingBarFill");
        var stats      = document.getElementById("indexingStatsText");
        var pctEl      = document.getElementById("indexingPctText");
        var folderRow  = document.getElementById("indexingFolderRow");
        var folderName = document.getElementById("indexingFolderName");
        if (fill)  fill.style.width  = pct + "%";
        if (stats) stats.textContent = Number(done).toLocaleString() + " / " + Number(total).toLocaleString() + " emails";
        if (pctEl) pctEl.textContent = pct + "%";
        if (folder && folderRow && folderName) {
          folderRow.style.display = "";
          folderName.textContent  = folder;
        }
      }
    }

    var mini = document.getElementById("indexingMiniBar");
    if (mini && mini.style.display !== "none") _setMiniProgress(pct);
  }

  function hideIndexingOverlay(success) {
    var el   = document.getElementById("indexingOverlay");
    var mini = document.getElementById("indexingMiniBar");

    function _fadeMiniDone() {
      if (!mini || mini.style.display === "none") return;
      var label = document.getElementById("indexingMiniLabel");
      if (label) label.textContent = "Done \u2713";
      _setMiniProgress(100);
      setTimeout(function () {
        mini.style.opacity    = "0";
        mini.style.transition = "opacity 0.4s ease";
        setTimeout(function () {
          mini.style.display    = "none";
          mini.style.opacity    = "";
          mini.style.transition = "";
        }, 430);
      }, 1500);
    }

    if (success) {
      if (el && el.style.display !== "none") {
        var fill  = document.getElementById("indexingBarFill");
        var stats = document.getElementById("indexingStatsText");
        var pctEl = document.getElementById("indexingPctText");
        if (fill)  fill.style.width  = "100%";
        if (stats) stats.textContent = "Indexing complete \u2713";
        if (pctEl) pctEl.textContent = "100%";
        setTimeout(function () {
          el.style.opacity    = "0";
          el.style.transition = "opacity 0.4s ease";
          setTimeout(function () {
            el.style.display    = "none";
            el.style.opacity    = "";
            el.style.transition = "";
          }, 430);
        }, 900);
      }
      _fadeMiniDone();
    } else {
      if (el)   el.style.display   = "none";
      if (mini) mini.style.display = "none";
    }
    _indexDismissed = false;
  }

  // Global listener — vectorIndex events arrive regardless of current screen
  browser.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    switch (msg.action) {
      case "vectorIndexStarted":
        showIndexingOverlay(msg.total || 0);
        break;
      case "vectorIndexProgress":
        updateIndexingOverlay(msg.done || 0, msg.total || 0, msg.folder || "");
        break;
      case "vectorIndexComplete":
        hideIndexingOverlay(true);
        break;
      case "vectorIndexError":
        hideIndexingOverlay(false);
        break;
    }
  });

  // "Use app" button — dismiss overlay, show mini bar, keep indexing running
  var _indexContinueBtn = document.getElementById("indexingContinueBtn");
  if (_indexContinueBtn) {
    _indexContinueBtn.addEventListener("click", function () {
      _indexDismissed = true;
      var el   = document.getElementById("indexingOverlay");
      var mini = document.getElementById("indexingMiniBar");
      if (el) {
        el.style.opacity    = "0";
        el.style.transition = "opacity 0.25s ease";
        setTimeout(function () {
          el.style.display    = "none";
          el.style.opacity    = "";
          el.style.transition = "";
          if (mini) {
            var label = document.getElementById("indexingMiniLabel");
            if (label) label.textContent = "Indexing";
            var pct = _lastIdx.total > 0
              ? Math.min(99, Math.round((_lastIdx.done / _lastIdx.total) * 100))
              : 0;
            _setMiniProgress(pct);
            mini.style.display = "flex";
          }
        }, 260);
      }
    });
  }

  // Pause button (full overlay)
  var _indexPauseBtn = document.getElementById("indexingPauseBtn");
  if (_indexPauseBtn) {
    _indexPauseBtn.addEventListener("click", function () {
      _indexPauseBtn.disabled = true;
      _indexPauseBtn.textContent = "Pausing\u2026";
      browser.runtime.sendMessage({ action: "pauseIndexing" }).then(function () {
        hideIndexingOverlay(false);
        _indexPauseBtn.disabled  = false;
        _indexPauseBtn.innerHTML = "&#9646;&#9646; Pause &mdash; resume later from Settings";
      }).catch(function () {
        _indexPauseBtn.disabled  = false;
        _indexPauseBtn.innerHTML = "&#9646;&#9646; Pause &mdash; resume later from Settings";
      });
    });
  }

  // Pause button (mini bar)
  var _indexMiniPauseBtn = document.getElementById("indexingMiniPauseBtn");
  if (_indexMiniPauseBtn) {
    _indexMiniPauseBtn.addEventListener("click", function () {
      _indexMiniPauseBtn.disabled = true;
      browser.runtime.sendMessage({ action: "pauseIndexing" }).then(function () {
        hideIndexingOverlay(false);
        _indexMiniPauseBtn.disabled = false;
      }).catch(function () {
        _indexMiniPauseBtn.disabled = false;
      });
    });
  }

  // Expand button (mini bar) — re-show full overlay with current progress
  var _indexExpandBtn = document.getElementById("indexingMiniExpandBtn");
  if (_indexExpandBtn) {
    _indexExpandBtn.addEventListener("click", function () {
      _indexDismissed = false;
      var mini = document.getElementById("indexingMiniBar");
      if (mini) mini.style.display = "none";
      showIndexingOverlay(_lastIdx.total);
      if (_lastIdx.done > 0) updateIndexingOverlay(_lastIdx.done, _lastIdx.total, _lastIdx.folder);
    });
  }

})();
