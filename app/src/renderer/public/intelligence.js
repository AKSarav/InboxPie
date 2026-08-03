/* intelligence.js — SmartSearch + Intelligence Dashboard for InboxPie Desktop */
(function () {
  'use strict';

  // ─── Shared utilities ──────────────────────────────────────────────────────

  function getMessages() {
    return (window._ip && Array.isArray(window._ip.messages))
      ? window._ip.messages : [];
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtNum(n) { return Number(n).toLocaleString(); }

  function fmtBytes(b) {
    if (!b) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return Math.round(b / 1024) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function privacyOn() { return localStorage.getItem('mail-audit-privacy-mask') === 'true'; }

  function maskEmail(email) {
    if (!email || !email.includes('@')) return email;
    var parts = email.split('@');
    return parts[0][0] + '***@' + maskDomain(parts[1]);
  }

  function maskDomain(domain) {
    if (!domain) return '';
    return domain.split('.').map(function (p, i, a) {
      return i === a.length - 1 ? p : p[0] + '***';
    }).join('.');
  }

  function displayEmail(e)  { return privacyOn() ? maskEmail(e)  : e; }
  function displayDomain(d) { return privacyOn() ? maskDomain(d) : d; }
  // Masks account/mailbox names that are email addresses; leaves plain names untouched.
  function displayAccountName(n) {
    if (!n) return n;
    return (privacyOn() && String(n).indexOf('@') !== -1) ? maskEmail(String(n)) : String(n);
  }
  // Masks folder names that happen to be (or contain) an email address.
  function displayFolderName(n) {
    if (!n || !privacyOn()) return n;
    var s = String(n);
    return s.indexOf('@') !== -1 ? maskEmail(s) : s;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SMART SEARCH
  // ══════════════════════════════════════════════════════════════════════════

  // Cloud AI provider constants
  var CLOUD_MODELS = {
    openai:    ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    google:    ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  };
  var CLOUD_PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };

  var chat = {
    history: [],
    model: '',
    ollamaOk: null,
    busy: false,
    showThinking: true,
    mode: 'fast',          // 'fast' (direct text) | 'deep' (visual report) — fast is the quick default
    availableModels: [],   // from ollama list
    selectedModel: '',     // user-overridden model chip ('' = use auto-picked); cloud: 'openai:gpt-4o'
    // AI settings (loaded from backend)
    aiProvider: 'ollama',  // active provider from preferences
    aiSettings: {
      openai:    { hasKey: false, maskedKey: '', model: 'gpt-4o' },
      anthropic: { hasKey: false, maskedKey: '', model: 'claude-sonnet-4-6' },
      google:    { hasKey: false, maskedKey: '', model: 'gemini-2.0-flash' },
    },
  };

  // ── Render chat shell ──────────────────────────────────────────────────────

  window.renderSmartSearch = function () {
    var panel = document.getElementById('smartsearchView');
    if (!panel) return;

    var hasData = true; // always enabled — agent works with LanceDB index directly

    panel.innerHTML = [
      '<div class="ss-chat-shell">',

        '<button class="ss-newchat-btn" id="ssClearBtn" title="New conversation">',
          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">',
            '<path d="M8 3h5v5"/><path d="M13 3l-6 6"/><path d="M7 4H3.5A1.5 1.5 0 002 5.5v7A1.5 1.5 0 003.5 14h7A1.5 1.5 0 0012 12.5V9"/>',
          '</svg>',
          'New chat',
        '</button>',

        '<div class="ss-chat-thread" id="ssChatThread">',
          '<div id="ssChatMessages"></div>',
        '</div>',

        '<div class="ss-chat-input-bar">',
          '<div class="ss-input-row" style="position:relative">',
            '<div class="ss-cmd-picker" id="ssCmdPicker" style="display:none"></div>',
            '<textarea id="ssChatInput" class="ss-chat-input" rows="1"',
              ' placeholder="Type / to pick a model (↑↓/Tab, Enter), then ask…"',
              (hasData ? '' : ' disabled'),
            '></textarea>',
          '</div>',
          '<div class="ss-input-footer">',
            '<div class="ss-mode-toggle" id="ssModeToggle">',
              '<button class="ss-mode-btn' + (chat.mode === 'fast' ? ' active' : '') + '" data-mode="fast" title="Direct chat answer — quick, no report">Fast</button>',
              '<button class="ss-mode-btn' + (chat.mode === 'deep' ? ' active' : '') + '" data-mode="deep" title="Generate a full visual report / widget — slower">Deep</button>',
            '</div>',
            '<div class="ss-model-chips" id="ssModelChips"></div>',
            '<button id="ssChatStop" class="ss-chat-send ss-chat-stop" style="display:none" title="Stop generating">',
              '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="2"/></svg>',
            '</button>',
            '<button id="ssChatSend" class="ss-chat-send" title="Send" ' + (hasData ? '' : 'disabled') + '>',
              '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z"/></svg>',
            '</button>',
          '</div>',
        '</div>',

      '</div>',
    ].join('');

    document.getElementById('ssClearBtn').addEventListener('click', ssClearChat);
    var sendBtn  = document.getElementById('ssChatSend');
    var stopBtn  = document.getElementById('ssChatStop');
    var inputEl  = document.getElementById('ssChatInput');
    sendBtn.addEventListener('click', ssSendMessage);
    stopBtn.addEventListener('click', function () {
      browser.runtime.sendMessage({ action: 'cancelChatQuery' }).catch(function () {});
    });
    inputEl.addEventListener('keydown', function (e) {
      // When the "/" picker is open, drive it with the keyboard (arrows / Tab / Enter).
      if (ssPickerOpen()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); ssPickerMove(1);  return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); ssPickerMove(-1); return; }
        if (e.key === 'Tab')       { e.preventDefault(); ssPickerMove(e.shiftKey ? -1 : 1); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ssPickerSelectCurrent(); return; }
        if (e.key === 'Escape')    { e.preventDefault(); ssHidePicker(); return; }
        return;
      }
      if (e.key === 'Escape') { ssHidePicker(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ssSendMessage(); }
    });
    inputEl.addEventListener('input', function () {
      ssAutoResize(inputEl);
      ssCheckPickerTrigger(inputEl);
    });
    document.addEventListener('click', function (e) {
      var picker = document.getElementById('ssCmdPicker');
      if (picker && !picker.contains(e.target) && e.target !== inputEl) ssHidePicker();
    });

    document.getElementById('ssModeToggle').addEventListener('click', function (e) {
      var btn = e.target.closest('.ss-mode-btn');
      if (!btn) return;
      var mode = btn.getAttribute('data-mode');
      if (!mode || mode === chat.mode) return;
      chat.mode = mode;
      document.querySelectorAll('.ss-mode-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === mode);
      });
    });

    // Restore persistent chat state across view switches (panel HTML is rebuilt each time)
    ssRenderChips();
    ssUpdateActiveModel();

    if (chat.history.length) {
      // Re-render existing conversation — skip greeting and Ollama check
      ssRerenderHistory();
      ssCheckOllama(); // still needed to know if send is available
      return;
    }

    ssCheckOllama();
    ssLoadIndexingStats(); // will update greeting once stats arrive
    ssShowGreeting(false, ''); // placeholder — ssLoadIndexingStats will update it

    setTimeout(function () { inputEl.focus(); }, 80);
  };

  // ── Picker (model + cloud provider selection via "/") ──────────────────────

  function ssLoadIndexingStats() {
    browser.runtime.sendMessage({ action: 'getIndexingStats' }).then(function (stats) {
      var hasIndexed = stats && stats.total > 0;
      if (hasIndexed && !chat.history.length) {
        ssShowGreeting(true, fmtNum(stats.total));
      } else if (!hasIndexed && !getMessages().length && !chat.history.length) {
        ssShowGreeting(false, '');
      }
    }).catch(function () {});
  }

  function ssCheckPickerTrigger(inputEl) {
    var val      = inputEl.value;
    var caret    = inputEl.selectionStart;
    var before   = val.slice(0, caret);
    var words    = before.split(/\s/);
    var lastWord = words[words.length - 1] || '';
    if (lastWord.startsWith('/')) {
      ssShowCombinedPicker(lastWord.slice(1).toLowerCase());
    } else {
      ssHidePicker();
    }
  }

  var MODEL_ICON  = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="10" height="7" rx="1.5"/><path d="M5 4V3a2 2 0 014 0v1"/><circle cx="5" cy="7.5" r=".8" fill="currentColor" stroke="none"/><circle cx="9" cy="7.5" r=".8" fill="currentColor" stroke="none"/></svg>';

  function ssShowCombinedPicker(filter) {
    var picker = document.getElementById('ssCmdPicker');
    if (!picker) return;

    var availModels = chat.availableModels || [];
    var filtModels = filter
      ? availModels.filter(function (m) { return m.toLowerCase().includes(filter); })
      : availModels;

    // Build cloud model entries for providers that have keys configured
    var cloudEntries = []; // [{provider, model, label}]
    ['openai', 'anthropic', 'google'].forEach(function (p) {
      if (!chat.aiSettings[p] || !chat.aiSettings[p].hasKey) return;
      var pModels = CLOUD_MODELS[p] || [];
      pModels.forEach(function (m) {
        var id = p + ':' + m;
        if (!filter || id.toLowerCase().includes(filter) || m.toLowerCase().includes(filter)) {
          cloudEntries.push({ provider: p, model: m, id: id });
        }
      });
    });

    if (!filtModels.length && !cloudEntries.length) { ssHidePicker(); return; }

    var html = '';

    if (filtModels.length) {
      html += '<div class="ss-picker-section-header">Local (Ollama)</div>';
      html += filtModels.slice(0, 8).map(function (m) {
        var active = m === (chat.selectedModel || (chat.aiProvider === 'ollama' ? chat.model : ''));
        return '<div class="ss-cmd-option" data-type="model" data-model="' + esc(m) + '">' +
          MODEL_ICON +
          '<span class="ss-co-name">' + esc(m) + '</span>' +
          (active ? '<span class="ss-co-count ss-co-active">active</span>' : '') +
          '</div>';
      }).join('');
    }

    // Cloud provider sections grouped by provider
    if (cloudEntries.length) {
      var byProvider = {};
      cloudEntries.forEach(function (e) {
        if (!byProvider[e.provider]) byProvider[e.provider] = [];
        byProvider[e.provider].push(e);
      });
      Object.keys(byProvider).forEach(function (p) {
        html += '<div class="ss-picker-section-header ss-picker-cloud-header">' +
          '<span class="ss-cloud-dot">☁</span> ' + (CLOUD_PROVIDER_NAMES[p] || p) + '</div>';
        html += byProvider[p].map(function (e) {
          var active = chat.selectedModel === e.id || (chat.aiProvider === p && !chat.selectedModel && chat.aiSettings[p] && chat.aiSettings[p].model === e.model);
          return '<div class="ss-cmd-option ss-cloud-option" data-type="model" data-model="' + esc(e.id) + '">' +
            MODEL_ICON +
            '<span class="ss-co-name">' + esc(e.model) + '</span>' +
            (active ? '<span class="ss-co-count ss-co-active">active</span>' : '') +
            '</div>';
        }).join('');
      });
    }

    picker.innerHTML = html;
    picker.style.display = 'block';

    picker.querySelectorAll('.ss-cmd-option').forEach(function (el, i) {
      el.addEventListener('click', function () { ssPickerActivate(el); });
      el.addEventListener('mousemove', function () {   // hover follows the keyboard highlight
        if (ssPickerIndex !== i) { ssPickerIndex = i; ssPickerHighlight(); }
      });
    });

    // Highlight the first option so Enter works immediately without a mouse.
    ssPickerIndex = 0;
    ssPickerHighlight();
  }

  // ── "/" picker keyboard navigation ─────────────────────────────────────────
  var ssPickerIndex = -1;

  function ssPickerOpen() {
    var picker = document.getElementById('ssCmdPicker');
    return !!(picker && picker.style.display !== 'none');
  }
  function ssPickerItems() {
    var picker = document.getElementById('ssCmdPicker');
    if (!picker) return [];
    return Array.prototype.slice.call(picker.querySelectorAll('.ss-cmd-option'));
  }
  function ssPickerHighlight() {
    var items = ssPickerItems();
    items.forEach(function (el, i) { el.classList.toggle('ss-co-highlight', i === ssPickerIndex); });
    if (ssPickerIndex >= 0 && items[ssPickerIndex] && items[ssPickerIndex].scrollIntoView) {
      items[ssPickerIndex].scrollIntoView({ block: 'nearest' });
    }
  }
  function ssPickerMove(delta) {
    var items = ssPickerItems();
    if (!items.length) return;
    ssPickerIndex = (ssPickerIndex + delta + items.length) % items.length;
    ssPickerHighlight();
  }
  function ssPickerActivate(el) {
    if (!el) return;
    ssSetModelChip(el.getAttribute('data-model'));
    ssHidePicker();
    ssPickerClearSlash();
  }
  function ssPickerSelectCurrent() {
    var items = ssPickerItems();
    var el = (ssPickerIndex >= 0 && items[ssPickerIndex]) ? items[ssPickerIndex] : items[0];
    ssPickerActivate(el);
  }

  function ssPickerClearSlash() {
    var inputEl = document.getElementById('ssChatInput');
    if (inputEl) {
      inputEl.value = inputEl.value.replace(/\/\S*$/, '').trimEnd();
      ssAutoResize(inputEl);
      inputEl.focus();
    }
  }

  function ssHidePicker() {
    var picker = document.getElementById('ssCmdPicker');
    if (picker) picker.style.display = 'none';
    ssPickerIndex = -1;
  }

  function ssSetModelChip(modelName) {
    chat.selectedModel = modelName;
    ssRenderChips();
    ssUpdateActiveModel();
  }

  function ssRenderChips() {
    var chips = document.getElementById('ssModelChips');
    if (!chips) return;
    var html = '';

    if (chat.selectedModel) {
      var chipProvider = ssParseModelChip(chat.selectedModel).provider;
      var chipLabel    = ssParseModelChip(chat.selectedModel).model;
      var isCloud = chipProvider !== 'ollama';
      var providerLabel = isCloud ? ' · ' + (CLOUD_PROVIDER_NAMES[chipProvider] || chipProvider) : '';
      html += '<span class="ss-model-chip' + (isCloud ? ' ss-cloud-chip' : '') + '">' +
        (isCloud
          ? '<span class="ss-cloud-dot-sm">☁</span>'
          : '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="10" height="7" rx="1.5"/><path d="M4 3V2a2 2 0 014 0v1"/><circle cx="4.5" cy="6.5" r=".7" fill="currentColor" stroke="none"/><circle cx="7.5" cy="6.5" r=".7" fill="currentColor" stroke="none"/></svg>') +
        esc(chipLabel) + '<span class="ss-chip-provider">' + esc(providerLabel) + '</span>' +
        '<button class="ss-chip-remove ss-model-remove" title="Remove">&times;</button>' +
        '</span>';
    }

    chips.innerHTML = html;

    var modelRemove = chips.querySelector('.ss-model-remove');
    if (modelRemove) modelRemove.addEventListener('click', function () {
      chat.selectedModel = ''; ssRenderChips(); ssUpdateActiveModel();
    });
  }

  // ── Model chip helpers ─────────────────────────────────────────────────────

  function ssParseModelChip(chip) {
    var cloudPrefixes = ['openai', 'anthropic', 'google'];
    for (var i = 0; i < cloudPrefixes.length; i++) {
      if (chip.startsWith(cloudPrefixes[i] + ':')) {
        return { provider: cloudPrefixes[i], model: chip.slice(cloudPrefixes[i].length + 1) };
      }
    }
    return { provider: 'ollama', model: chip };
  }

  // ── Ollama check ───────────────────────────────────────────────────────────

  function ssCheckOllama() {
    // Load AI settings (cloud provider config) alongside Ollama status
    browser.runtime.sendMessage({ action: 'getAISettings' }).then(function (s) {
      if (s && s.activeProvider) chat.aiProvider = s.activeProvider;
      if (s && s.ollamaModel) chat._savedOllamaModel = s.ollamaModel;
      if (s && s.providers) {
        Object.keys(s.providers).forEach(function (p) {
          if (chat.aiSettings[p]) {
            chat.aiSettings[p].hasKey  = s.providers[p].hasKey;
            chat.aiSettings[p].maskedKey = s.providers[p].maskedKey;
            if (s.providers[p].model) chat.aiSettings[p].model = s.providers[p].model;
          }
        });
      }
    }).catch(function () {});

    browser.runtime.sendMessage({ action: 'checkOllama' }).then(function (res) {
      chat.ollamaOk = res && res.available;
      if (!res || !res.available) {
        ssUpdateActiveModel();
        if (!chat.history.length && chat.aiProvider === 'ollama') ssAppendSetupHint(true);
        return;
      }
      var models = res.models || [];
      chat.availableModels = models;

      // Use the saved preference if it's still in the available model list
      var savedModel = chat._savedOllamaModel || '';
      var picked = '';
      if (savedModel && models.indexOf(savedModel) !== -1) {
        picked = savedModel;
      } else {
        // Auto-select by preference order
        var preferred = ['qwen3.5:27b', 'qwen2.5', 'qwen', 'llama3.2', 'llama3.1', 'llama3', 'phi4', 'gemma3', 'mistral'];
        for (var i = 0; i < preferred.length; i++) {
          var found = models.find(function (m) { return m.startsWith(preferred[i]); });
          if (found) { picked = found; break; }
        }
        if (!picked) picked = models[0] || '';
        // Persist the auto-selected model so graph indexing and other components can use it
        if (picked) {
          browser.runtime.sendMessage({ action: 'saveAISettings', provider: 'ollama', model: picked }).catch(function () {});
        }
      }
      chat.model = picked;
      ssUpdateActiveModel();
      if (!picked && !chat.history.length && chat.aiProvider === 'ollama') ssAppendSetupHint(true);
    }).catch(function () {
      chat.ollamaOk = false;
      ssUpdateActiveModel();
      if (!chat.history.length && chat.aiProvider === 'ollama') ssAppendSetupHint(true);
    });
  }

  function ssUpdateActiveModel() {
    var el = document.getElementById('ssActiveModel');
    if (!el) return;
    // When a chip is selected, the chip itself communicates the active model
    if (chat.selectedModel) { el.style.display = 'none'; return; }

    // Show default active provider/model as muted indicator
    if (chat.aiProvider !== 'ollama') {
      var ps = chat.aiSettings[chat.aiProvider];
      var pName = CLOUD_PROVIDER_NAMES[chat.aiProvider] || chat.aiProvider;
      el.style.display = '';
      el.textContent = '☁ ' + pName + ' · ' + (ps && ps.model ? ps.model : '');
      el.className = 'ss-active-model ss-active-model-cloud';
      return;
    }
    var active = chat.model;
    if (!active) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.textContent = chat.ollamaOk === false ? 'Ollama offline' : active.split(':')[0];
    el.className = 'ss-active-model' + (chat.ollamaOk === false ? ' ss-active-model-warn' : '');
  }

  // ── Greeting ───────────────────────────────────────────────────────────────

  function ssShowGreeting(hasData, indexedCount) {
    var body = document.getElementById('ssChatMessages');
    if (!body) return;
    body.innerHTML = '';
    var vbHint = indexedCount ? ' Virtual Box: <strong>' + esc(indexedCount) + ' emails</strong> indexed.' : '';
    var greetingText = hasData
      ? 'Hi! I can search your indexed emails semantically. Try:\n\n• "Who sends me the most email?"\n• "Show me all Amazon orders"\n• "Find travel booking emails last year"\n\n' + vbHint + '\n\nType <code>/</code> to switch AI model.'
      : 'Go to the <strong>Intelligence</strong> tab to index your emails first — then come back here to search them with AI.\n\nEverything runs fully on your device, no data leaves your machine.';
    body.insertAdjacentHTML('beforeend', ssAssistantBubble(greetingText.replace(/\n/g, '<br>')));
  }

  function ssAppendSetupHint(hasData) {
    var body = document.getElementById('ssChatMessages');
    if (!body || !hasData) return;
    if (chat.ollamaOk === false) {
      body.insertAdjacentHTML('beforeend', [
        '<div class="ss-setup-card">',
          '<div class="ss-setup-title">Ollama not detected</div>',
          '<div class="ss-setup-steps">',
            '<div class="ss-setup-step"><span class="ss-step-num">1</span> Install Ollama from <code>ollama.com</code></div>',
            '<div class="ss-setup-step"><span class="ss-step-num">2</span> Run <code>ollama pull llama3.2</code></div>',
            '<div class="ss-setup-step"><span class="ss-step-num">3</span> Keep <code>ollama serve</code> running, then reload InboxPie</div>',
          '</div>',
        '</div>',
      ].join(''));
    } else if (chat.model === '') {
      body.insertAdjacentHTML('beforeend', [
        '<div class="ss-setup-card">',
          '<div class="ss-setup-title">No model found</div>',
          '<div class="ss-setup-steps">',
            '<div class="ss-setup-step">Run <code>ollama pull llama3.2</code> in your terminal, then reload.</div>',
          '</div>',
        '</div>',
      ].join(''));
    }
  }

  // ── Send & receive ─────────────────────────────────────────────────────────

  function ssSendMessage() {
    if (chat.busy) return;
    var inputEl = document.getElementById('ssChatInput');
    if (!inputEl) return;
    var text = inputEl.value.trim();
    if (!text) return;

    // No default — require the user to explicitly pick a model.
    if (!chat.selectedModel) {
      var bodyG = document.getElementById('ssChatMessages');
      if (bodyG) bodyG.insertAdjacentHTML('beforeend', ssAssistantBubble(
        'Please choose a model before asking. Type <code>/</code> to pick — use ↑ ↓ / Tab and Enter to select. ' +
        '(Your question is kept; just select, then press Enter.)'));
      ssScrollToBottom();
      ssShowCombinedPicker('');   // open the picker to choose right away
      return;                      // keep the typed question
    }

    inputEl.value = '';
    ssAutoResize(inputEl);

    var body = document.getElementById('ssChatMessages');
    if (body) body.insertAdjacentHTML('beforeend', ssUserBubble(text));
    ssScrollToBottom();

    // Determine effective provider + model
    var chipParsed = chat.selectedModel ? ssParseModelChip(chat.selectedModel) : null;
    var effectiveProvider = chipParsed ? chipParsed.provider : chat.aiProvider;
    var effectiveModel    = chipParsed ? chipParsed.model
      : (effectiveProvider !== 'ollama'
          ? (chat.aiSettings[effectiveProvider] && chat.aiSettings[effectiveProvider].model) || ''
          : chat.model);

    // Guard: Ollama required for local, cloud key required for cloud
    if (effectiveProvider === 'ollama') {
      if (!chat.ollamaOk) {
        if (body) body.insertAdjacentHTML('beforeend', ssAssistantBubble('Ollama is not running. Start it with <code>ollama serve</code> and reload InboxPie.'));
        ssScrollToBottom(); return;
      }
      if (!effectiveModel) {
        if (body) body.insertAdjacentHTML('beforeend', ssAssistantBubble('No Ollama model found. Run <code>ollama pull llama3.2</code> in your terminal, then reload.'));
        ssScrollToBottom(); return;
      }
    } else {
      if (!chat.aiSettings[effectiveProvider] || !chat.aiSettings[effectiveProvider].hasKey) {
        if (body) body.insertAdjacentHTML('beforeend', ssAssistantBubble(
          (CLOUD_PROVIDER_NAMES[effectiveProvider] || effectiveProvider) + ' API key not configured. ' +
          'Go to <strong>AI Settings</strong> to add your key.'));
        ssScrollToBottom(); return;
      }
    }

    var typingId = 'ssTyping_' + Date.now();
    if (body) body.insertAdjacentHTML('beforeend', ssTypingBubble(typingId));
    ssUpdateTypingLabel(typingId, 'Thinking…');   // immediate feedback before any backend event
    ssScrollToBottom();

    chat.busy = true;
    var sendBtn  = document.getElementById('ssChatSend');
    var stopBtn2 = document.getElementById('ssChatStop');
    var inputElQ = document.getElementById('ssChatInput');
    if (sendBtn)  { sendBtn.disabled = true; sendBtn.style.display = 'none'; }
    if (stopBtn2) stopBtn2.style.display = 'flex';
    if (inputElQ) inputElQ.disabled = true;

    // Subscribe to agentStep events while query is running — render them LIVE so the
    // user watches what the agent searches, what it found, and what it's deciding.
    var liveSteps = [];
    var streamedText = '';
    var reasoningText = '';
    var agentStepListener = function (ev) {
      if (!ev) return;
      // Stream the model's answer tokens live so the user always sees progress.
      if (ev.action === 'agentToken') {
        streamedText += (ev.text || '');
        ssRenderStreamingAnswer(typingId, streamedText, reasoningText);
        return;
      }
      // Stream the model's reasoning (thinking models) into a muted area above the answer.
      if (ev.action === 'agentReasoning') {
        reasoningText += (ev.text || '');
        if (!streamedText) ssRenderStreamingAnswer(typingId, '', reasoningText);
        return;
      }
      if (ev.action !== 'agentStep' || !ev.label) return;
      var label = ev.label;
      var t = 'intent';
      if (ev.tool === 'think')                            t = 'think';
      else if (/^Found|^Validation|^Stats|^Semantic matches/i.test(label)) t = 'result';
      else if (/not built|No |error|fail/i.test(label))   t = 'error';
      else if (/^Retry|gap/i.test(label))                 t = 'retry';
      liveSteps.push({ type: t, label: label, detail: ev.detail });
      // Don't clobber a streaming answer/reasoning with the step list once tokens are flowing.
      if (!streamedText && !reasoningText) ssRenderLiveThinking(typingId, liveSteps);
    };
    browser.runtime.onMessage.addListener(agentStepListener);

    chat.history.push({ role: 'user', content: text });

    browser.runtime.sendMessage({
      action:      'chatQuery',
      userMessage: text,
      history: chat.history.slice(0, -1).map(function (m) {
        return { role: m.role, content: m.content };
      }),
      model:    effectiveModel,
      provider: effectiveProvider,
      mode:     chat.mode,
    }).then(function (res) {
      var typingEl = document.getElementById(typingId);
      if (typingEl) typingEl.remove();

      var widgetHtml   = (res && res.widgetHtml)    ? res.widgetHtml    : '';
      var htmlWidget   = (res && res.htmlWidget)    ? res.htmlWidget    : '';   // model-authored, sandboxed
      var answerText   = (res && res.answer_text)   ? res.answer_text   : 'No response.';
      var responseType = (res && res.response_type) ? res.response_type : 'text';
      var thinking     = (res && res.thinking)      ? res.thinking      : '';
      var agentSteps   = (res && res.agentSteps && res.agentSteps.length)
        ? res.agentSteps : buildFallbackSteps(res);

      // In fast mode: if the LLM was already streaming a plain-text answer (the user saw it),
      // use that as the final response instead of any server-rendered widget/table that may
      // have been produced as a fallback. The streamed text IS the real answer.
      if (chat.mode === 'fast' && streamedText.trim()) {
        var cleanStreamed = streamedText
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/<think>[\s\S]*$/i, '')
          .trim();
        if (cleanStreamed) {
          responseType = 'text';
          answerText   = cleanStreamed;
          widgetHtml   = '';
          htmlWidget   = '';
        }
      }

      chat.history.push({
        role: 'assistant', content: answerText,
        _thinking: thinking, _steps: agentSteps,
        _responseType: responseType, _widgetHtml: widgetHtml, _htmlWidget: htmlWidget,
      });

      if (body) {
        var thinkBlock = ssThinkingBlock(thinking, agentSteps);
        var bubbleHtml;
        if (htmlWidget && htmlWidget.trim()) {
          bubbleHtml = ssIframeWidgetBubble(htmlWidget, thinkBlock + ssWidgetProse(answerText));
        } else if (responseType === 'text') {
          bubbleHtml = ssAssistantBubble(thinkBlock + answerText);
        } else {
          bubbleHtml = ssWidgetBubble(thinkBlock + widgetHtml, answerText);
        }
        body.insertAdjacentHTML('beforeend', bubbleHtml);
        ssInitCharts(body);
      }

      if (body) {
        body.querySelectorAll('.sw-select-email[data-email]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var email = btn.getAttribute('data-email');
            if (window._ip && window._ip.openSenderReview) window._ip.openSenderReview(email);
          });
        });
      }
      ssScrollToBottom();
    }).catch(function (err) {
      var typingEl = document.getElementById(typingId);
      if (typingEl) typingEl.remove();
      if (body) body.insertAdjacentHTML('beforeend', ssAssistantBubble('Error: ' + String(err)));
      chat.history.pop();
      ssScrollToBottom();
    }).finally(function () {
      try { browser.runtime.onMessage.removeListener(agentStepListener); } catch (_) {}
      chat.busy = false;
      var btn  = document.getElementById('ssChatSend');
      var stop = document.getElementById('ssChatStop');
      if (stop) stop.style.display = 'none';
      if (btn)  { btn.style.display = ''; btn.disabled = false; }
      var inp = document.getElementById('ssChatInput');
      if (inp) { inp.disabled = false; inp.focus(); }
    });
  }

  function ssClearChat() {
    chat.history = [];
    chat.selectedModel = '';
    var body = document.getElementById('ssChatMessages');
    if (body) body.innerHTML = '';
    ssRenderChips();
    ssUpdateActiveModel();
    ssLoadIndexingStats(); // re-run to refresh the greeting's Virtual Box count
  }

  // ── Bubble HTML helpers ────────────────────────────────────────────────────

  function ssUserBubble(text) {
    return '<div class="ss-bubble ss-bubble-user"><div class="ss-bubble-inner">' + esc(text) + '</div></div>';
  }

  var SS_BOT_AVATAR = [
    '<div class="ss-bubble-avatar">',
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">',
        '<rect x="3" y="6" width="14" height="10" rx="2"/>',
        '<path d="M7 6V4.5a3 3 0 016 0V6"/>',
        '<circle cx="8" cy="11" r="1" fill="currentColor" stroke="none"/>',
        '<circle cx="12" cy="11" r="1" fill="currentColor" stroke="none"/>',
      '</svg>',
    '</div>',
  ].join('');

  function ssAssistantBubble(htmlContent) {
    return '<div class="ss-bubble ss-bubble-assistant">' + SS_BOT_AVATAR +
      '<div class="ss-bubble-inner ss-bubble-prose">' + htmlContent + '</div></div>';
  }

  function ssWidgetBubble(widgetHtml, proseText) {
    if (!widgetHtml || !widgetHtml.trim()) return ssAssistantBubble(proseText);
    return '<div class="ss-bubble ss-bubble-assistant ss-bubble-widget">' + SS_BOT_AVATAR +
      '<div class="ss-bubble-body">' + widgetHtml + '</div></div>';
  }

  // ── MCP-UI style sandboxed HTML widget ─────────────────────────────────────
  // The model authors an HTML fragment; we render it inside a null-origin
  // <iframe sandbox="allow-scripts"> with a strict CSP (no network, no same-origin),
  // so it is fully isolated from the app and cannot phone home (privacy-first).

  var ssFrameSeq = 0;

  function ssWidgetProse(text) {
    if (!text) return '';
    return '<div class="ss-widget-prose">' + esc(text).replace(/\n/g, '<br>') + '</div>';
  }

  function ssEscAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function ssWidgetThemeVars() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fb) { var x = cs.getPropertyValue(name); return (x && x.trim()) || fb; }
    return '--w-fg:' + v('--text-primary', '#e6e9ef') + ';' +
           '--w-muted:' + v('--text-muted', '#8892aa') + ';' +
           '--w-accent:' + v('--accent', '#6f8bff') + ';' +
           '--w-card:' + v('--bg-secondary', '#171b24') + ';' +
           '--w-border:' + v('--border', '#2a3040') + ';';
  }

  function ssBuildWidgetDoc(rawHtml, frameId) {
    var csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; " +
              "script-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";
    return '<!doctype html><html><head>' +
      '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
      '<style>' +
        ':root{' + ssWidgetThemeVars() + '}' +
        '*{box-sizing:border-box;max-width:100%}' +
        'html,body{margin:0;padding:0;background:transparent}' +
        // Generous, consistent padding + a sane base size so widgets never look cramped.
        'body{color:var(--w-fg);font:13px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;padding:18px 20px}' +
        // Cap typography regardless of what the model emits (defends against giant inline fonts).
        'h1,h2,h3{margin:0 0 8px;line-height:1.25;font-weight:650}' +
        'h1{font-size:18px}h2{font-size:16px}h3{font-size:14px}' +
        'p{margin:0 0 8px}' +
        'ul,ol{margin:0 0 8px;padding-left:18px}li{margin:2px 0}' +
        // KPI / headline number — the model should use class="kpi"; cap the size hard.
        '.kpi,.headline{font-size:22px;font-weight:700;line-height:1.2;margin:2px 0 10px;color:var(--w-fg)}' +
        '.label,.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--w-muted);margin-bottom:2px}' +
        'table{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}' +
        'th,td{padding:7px 10px;border-bottom:1px solid var(--w-border);text-align:left;vertical-align:top}' +
        'th{color:var(--w-muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em}' +
        'td:nth-child(2),th:nth-child(2){white-space:nowrap}' +
        'a{color:var(--w-accent)}' +
      '</style></head><body>' + rawHtml +
      // Self-report content height, but guard hard against a resize feedback loop:
      // measure body.scrollHeight (content, NOT the viewport-inclusive documentElement),
      // only post when it CHANGES, debounce via rAF, and cap total posts as a backstop.
      '<script>(function(){var ID="' + frameId + '",last=-1,posts=0,pending=false;' +
        'function measure(){return document.body?Math.ceil(document.body.scrollHeight):0;}' +
        'function post(){pending=false;var h=measure();if(h===last)return;last=h;if(++posts>80)return;' +
        'parent.postMessage({type:"ss-widget-height",id:ID,height:h},"*");}' +
        'function schedule(){if(pending)return;pending=true;(window.requestAnimationFrame||setTimeout)(post);}' +
        'window.addEventListener("load",schedule);setTimeout(schedule,30);setTimeout(schedule,300);setTimeout(schedule,1000);' +
        'if(window.ResizeObserver){new ResizeObserver(schedule).observe(document.body);}})();<\/script>' +
      '</body></html>';
  }

  function ssIframeWidgetBubble(rawHtml, headerHtml) {
    var id  = 'sw-frame-' + (++ssFrameSeq);
    var doc = ssBuildWidgetDoc(rawHtml, id);
    return '<div class="ss-bubble ss-bubble-assistant ss-bubble-widget">' + SS_BOT_AVATAR +
      '<div class="ss-bubble-body">' + (headerHtml || '') +
        '<iframe class="ss-widget-frame" id="' + id + '" sandbox="allow-scripts" ' +
        'referrerpolicy="no-referrer" srcdoc="' + ssEscAttr(doc) + '"></iframe>' +
      '</div></div>';
  }

  // Size sandboxed widget iframes from their self-reported content height (once).
  // Apply only when the height actually changes — this is the other half of the
  // feedback-loop guard: a no-op resize never re-triggers the iframe's observer.
  if (!window.__ssWidgetHeightWired) {
    window.__ssWidgetHeightWired = true;
    window.addEventListener('message', function (e) {
      var d = e && e.data;
      if (!d || d.type !== 'ss-widget-height' || !d.id) return;
      var f = document.getElementById(d.id);
      if (!f) return;
      var nh = Math.min(1200, Math.max(40, (d.height || 0) + 4));
      if (String(nh) === f.dataset.h) return;
      f.dataset.h = String(nh);
      f.style.height = nh + 'px';
    });
  }

  function ssTypingBubble(id) {
    return '<div class="ss-bubble ss-bubble-assistant" id="' + id + '">' + SS_BOT_AVATAR +
      '<div class="ss-bubble-inner ss-typing">' +
        '<span class="ss-typing-dots"><span></span><span></span><span></span></span>' +
        '<span class="ss-typing-label" id="' + id + '_label"></span>' +
      '</div></div>';
  }

  function ssUpdateTypingLabel(id, label) {
    var el = document.getElementById(id + '_label');
    if (el) el.textContent = label;
  }

  // Live, streaming view of the agent's steps inside the pending bubble.
  function ssRenderLiveThinking(typingId, steps) {
    var el = document.getElementById(typingId);
    if (!el) return;
    var inner = el.querySelector('.ss-bubble-inner');
    if (!inner) return;
    inner.classList.remove('ss-typing');
    inner.classList.add('ss-live-thinking');
    var rows = steps.map(ssThinkStepHtml).join('');
    inner.innerHTML =
      '<div class="ss-live-head">' +
        '<span class="ss-typing-dots"><span></span><span></span><span></span></span>' +
        '<span class="ss-live-title">Thinking…</span>' +
      '</div>' +
      '<div class="ss-live-steps">' + rows + '</div>';
    ssScrollToBottom();
  }

  // Stream the model's answer (and reasoning, for thinking models) into the pending bubble.
  function ssRenderStreamingAnswer(typingId, raw, reasoning) {
    var el = document.getElementById(typingId);
    if (!el) return;
    var inner = el.querySelector('.ss-bubble-inner');
    if (!inner) return;
    // Strip any inline <think> tags from the answer text (separate reasoning is handled below).
    var clean = String(raw || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*$/i, '')
      .trim();
    inner.classList.remove('ss-typing', 'ss-live-thinking');
    inner.classList.add('ss-bubble-prose', 'ss-streaming');

    var html = '';
    var reason = String(reasoning || '').trim();
    if (reason && !clean) {
      // Reasoning phase — show the FULL thinking in a self-scrolling box (no tail-slicing,
      // which made lines shift). The box scrolls to its own bottom below.
      html = '<details class="ss-stream-reason" open><summary>Reasoning…</summary>' +
        '<div class="ss-stream-reason-body" id="' + typingId + '_reason">' + esc(reason).replace(/\n/g, '<br>') + '</div></details>';
    } else if (clean) {
      // Answer phase — collapse reasoning (if any) above the answer.
      if (reason) html += '<details class="ss-stream-reason"><summary>Reasoning</summary>' +
        '<div class="ss-stream-reason-body">' + esc(reason).replace(/\n/g, '<br>') + '</div></details>';
      html += '<div class="ss-stream-answer">' + esc(clean).replace(/\n/g, '<br>') + '<span class="ss-cursor"></span></div>';
    } else {
      html = '<span class="ss-stream-think">Thinking<span class="ss-cursor"></span></span>';
    }
    inner.innerHTML = html;
    // Keep the reasoning box pinned to its newest line (append, never "reverse").
    var rbox = document.getElementById(typingId + '_reason');
    if (rbox) rbox.scrollTop = rbox.scrollHeight;
    ssScrollToBottom();
  }

  function buildFallbackSteps(res) {
    var steps = [];
    if (!res) return steps;
    if (res.intent && res.intent !== 'error' && res.intent !== 'general') {
      steps.push({ type: 'intent', label: 'Intent', detail: res.intent });
    }
    if (res.rows !== undefined) {
      steps.push({ type: 'result', label: 'Result', detail: res.rows.length + ' row(s) returned' });
    }
    if (res.error) steps.push({ type: 'error', label: 'Error', detail: res.error });
    return steps;
  }

  var SS_THINK_ICONS = {
    think:  '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M7 1.5a3.5 3.5 0 012.8 5.6V8.5a.5.5 0 01-.5.5h-4.6a.5.5 0 01-.5-.5V7.1A3.5 3.5 0 017 1.5z"/><path d="M5.5 9v.5a1.5 1.5 0 003 0V9"/></svg>',
    intent: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><circle cx="7" cy="7" r="2" fill="currentColor" stroke="none"/></svg>',
    sql:    '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1.5" y="2.5" width="11" height="9" rx="1.5"/><path d="M4 5.5h2M4 7.5h6M4 9.5h4"/></svg>',
    result: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7l3 3 6-6"/></svg>',
    retry:  '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 7a5 5 0 001 3M12 7a5 5 0 00-1-3M4 12.5l-1.5-2.5 2.5-.5"/></svg>',
    error:  '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M7 2l5.5 9.5H1.5L7 2z"/><path d="M7 5.5v2.5M7 9.5h.01"/></svg>',
  };

  // Render one thinking step (shared by the live stream + the collapsed block).
  function ssThinkStepHtml(s) {
    var icon = SS_THINK_ICONS[s.type] || SS_THINK_ICONS.intent;
    var detail = s.detail ? String(s.detail).trim() : '';
    var detailHtml = '';
    if (detail) {
      if (s.type === 'sql' || s.type === 'think') {
        detailHtml = '<code class="ss-think-detail-code">' + esc(detail) + '</code>';
      } else if (detail.indexOf('\n') !== -1) {
        // multi-line detail (e.g. the list of matched emails) → render each line
        detailHtml = '<div class="ss-think-detail-list">' +
          detail.split('\n').map(function (line) { return esc(line); }).join('<br>') +
          '</div>';
      } else {
        var short = detail.length > 160 ? detail.slice(0, 160) + '…' : detail;
        detailHtml = '<span class="ss-think-detail">— ' + esc(short) + '</span>';
      }
    }
    var extraClass = s.label === 'Data gap' ? ' ss-think-datagap' : '';
    return '<div class="ss-think-step ss-think-' + s.type + extraClass + '">' +
      '<span class="ss-think-icon">' + icon + '</span>' +
      '<span class="ss-think-label">' + esc(s.label) + '</span>' +
      detailHtml + '</div>';
  }

  function ssThinkingBlock(thinking, steps) {
    if (!thinking && (!steps || !steps.length)) return '';

    var bodyContent;
    var cleanThinking = thinking ? String(thinking).trim() : '';
    if (cleanThinking) {
      // Actual model chain-of-thought text (thinking models) — show verbatim
      bodyContent = '<div class="ss-thinking-reasoning">' + esc(cleanThinking).replace(/\n/g, '<br>') + '</div>';
    } else {
      // Agent pipeline steps — plain text, no icons/colours
      bodyContent = '<div class="ss-thinking-steps-text">' +
        (steps || []).map(function (s) {
          var detail = s.detail ? String(s.detail).trim() : '';
          var trunc  = detail.length > 200 ? detail.slice(0, 200) + '…' : detail;
          return '<div class="ss-think-step-plain">' +
            esc(s.label) +
            (trunc ? ' <span class="ss-think-detail-plain">— ' + esc(trunc) + '</span>' : '') +
          '</div>';
        }).join('') +
      '</div>';
    }

    var stepCount = (steps || []).length;
    return '<details class="ss-thinking-block" open>' +
      '<summary class="ss-thinking-summary">' +
        '<svg class="ss-thinking-brain" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2a4.5 4.5 0 013.5 7.3V11a1 1 0 01-1 1H5.5a1 1 0 01-1-1v-1.7A4.5 4.5 0 018 2z"/><path d="M6 12v1a2 2 0 004 0v-1"/></svg>' +
        '<span class="ss-thinking-label">Thinking</span>' +
        (stepCount > 0 ? '<span class="ss-thinking-count">' + stepCount + ' step' + (stepCount === 1 ? '' : 's') + '</span>' : '') +
        '<svg class="ss-thinking-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg>' +
      '</summary>' +
      '<div class="ss-thinking-body">' + bodyContent + '</div>' +
      '</details>';
  }

  function ssScrollToBottom(force) {
    var thread = document.getElementById('ssChatThread');
    if (!thread) return;
    // Auto-follow only when the user is already near the bottom — otherwise streaming
    // updates would yank the view around while they read (the "reverse" jitter).
    var nearBottom = (thread.scrollHeight - thread.scrollTop - thread.clientHeight) < 140;
    if (force || nearBottom) thread.scrollTop = thread.scrollHeight;
  }

  function ssAutoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function ssRerenderHistory() {
    var body = document.getElementById('ssChatMessages');
    if (!body) return;
    body.innerHTML = '';
    chat.history.forEach(function (msg) {
      if (msg.role === 'user') {
        body.insertAdjacentHTML('beforeend', ssUserBubble(msg.content));
      } else {
        var thinkBlock = ssThinkingBlock(msg._thinking || '', msg._steps || []);
        if (msg._htmlWidget && msg._htmlWidget.trim()) {
          body.insertAdjacentHTML('beforeend', ssIframeWidgetBubble(msg._htmlWidget, thinkBlock + ssWidgetProse(msg.content)));
        } else if (msg._responseType !== 'text' && msg._widgetHtml) {
          body.insertAdjacentHTML('beforeend', ssWidgetBubble(thinkBlock + msg._widgetHtml, msg.content));
        } else {
          body.insertAdjacentHTML('beforeend', ssAssistantBubble(thinkBlock + msg.content));
        }
      }
    });
    ssInitCharts(body);
    ssScrollToBottom();
  }

  // ── ECharts initializer ────────────────────────────────────────────────────
  // Finds all .sw-echarts-host containers in `root` that haven't been
  // initialized yet and creates an ECharts instance for each one.
  function ssInitCharts(root) {
    if (!window.echarts) return;
    root.querySelectorAll('.sw-echarts-host[data-echarts-option]').forEach(function (el) {
      if (el._echartsInstance) return; // already initialized
      try {
        var optionStr = decodeURIComponent(el.getAttribute('data-echarts-option') || '{}');
        var option = JSON.parse(optionStr);
        // Use dark theme to match the app's dark UI
        var chart = window.echarts.init(el, 'dark', { renderer: 'canvas' });
        chart.setOption(option);
        el._echartsInstance = chart;
        // Resize when the panel width changes (e.g. sidebar expand/collapse)
        var ro = new ResizeObserver(function () { chart.resize(); });
        ro.observe(el);
      } catch (e) {
        console.warn('[ssInitCharts] failed to init chart:', e);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INTELLIGENCE DASHBOARD  (replaces KnowledgeMap)
  // ══════════════════════════════════════════════════════════════════════════

  var id = {
    state: 'idle',   // idle | indexing | indexed
    progress: { total: 0, done: 0, errors: 0, folder: '' },
  };

  // Persistent listener — active regardless of which view is shown so progress
  // events are never dropped while the user is on the PieView or other tabs.
  browser.runtime.onMessage.addListener(function (ev) {
    if (ev.action === 'vectorIndexStarted') {
      id.state = 'indexing';
      id.progress = { total: ev.total || 0, done: 0, errors: 0, folder: '' };
      if (window._ip) window._ip.indexing = true;
    } else if (ev.action === 'vectorIndexProgress') {
      idHandleProgress(ev);
    } else if (ev.action === 'vectorIndexComplete') {
      idHandleComplete(ev);
    } else if (ev.action === 'vectorIndexError') {
      idHandleError(ev);
    }
  });

  window.renderKnowledgeMap = function () {
    var panel = document.getElementById('knowledgemapView');
    if (!panel) return;

    panel.innerHTML = '<div class="id-shell" id="idShell"></div>';

    // Always check real index state first — never let a stale id.state show
    // the progress screen over a graph that already has data.
    browser.runtime.sendMessage({ action: 'getIndexingStats' }).then(function (stats) {
      if (stats && stats.total > 0) {
        // Has indexed data — show graph regardless of id.state
        id.state = 'indexed';
        idRenderClusters(stats);
      } else {
        // No indexed data yet — show progress only if actively building
        var activelyIndexing =
          (id.state === 'indexing' && id.progress.total > 0 && id.progress.done < id.progress.total) ||
          (window._ip && window._ip.indexing);
        if (activelyIndexing) {
          id.state = 'indexing';
          idRenderProgress(id.progress.total || (window._ip && window._ip.messages ? window._ip.messages.length : 0), id.progress.done || 0, id.progress.errors || 0);
        } else {
          id.state = 'idle';
          idRenderNotIndexed();
        }
      }
    }).catch(function () { idRenderNotIndexed(); });
  };

  // ── Not-indexed state (replaces folder picker) ─────────────────────────────

  function idRenderNotIndexed() {
    var shell = document.getElementById('idShell');
    if (!shell) return;
    var hasMessages = (window._ip && window._ip.messages && window._ip.messages.length > 0);
    shell.innerHTML = [
      '<div class="id-empty-state">',
        '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">',
          '<circle cx="24" cy="24" r="20"/>',
          '<path d="M24 14v10l6 4"/>',
        '</svg>',
        hasMessages
          ? '<h3>Building AI index…</h3><p>The semantic index is being built in the background. Come back in a moment.</p>'
          : '<h3>Scan to enable AI Intelligence</h3>' +
            '<p>Click <strong>Scan Mailbox</strong> in the toolbar. The AI index is built automatically — no extra steps needed.</p>',
      '</div>',
    ].join('');
  }

  // ── Progress display (state: indexing) ────────────────────────────────────

  function idRenderProgress(total, done, errors) {
    var shell = document.getElementById('idShell');
    if (!shell) return;
    var pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    shell.innerHTML = [
      '<div class="id-progress-wrap">',
        '<div class="id-progress-icon">',
          '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">',
            '<path d="M20 5a15 15 0 010 30A15 15 0 0120 5"/>',
            '<path d="M20 12v8l5 3"/>',
          '</svg>',
        '</div>',
        '<h3 class="id-progress-title">Building Index…</h3>',
        '<p class="id-progress-sub">Processing ' + fmtNum(total) + ' emails.</p>',
        '<div class="id-progress-bar-wrap">',
          '<div class="id-progress-bar"><div class="id-progress-fill" id="idProgressFill" style="width:' + pct + '%"></div></div>',
          '<div class="id-progress-pct" id="idProgressPct">' + pct + '%</div>',
        '</div>',
        '<div class="id-progress-detail" id="idProgressDetail">Initializing model…</div>',
        (errors > 0 ? '<div class="id-progress-err">' + errors + ' errors</div>' : ''),
      '</div>',
    ].join('');
  }

  function idHandleProgress(ev) {
    // Always persist latest progress so re-entering the view shows correct state
    id.progress = {
      total:  ev.total  || id.progress.total,
      done:   ev.done   || 0,
      errors: ev.errors || 0,
      folder: ev.folder || '',
    };
    if (id.state !== 'indexing') id.state = 'indexing';

    var fill   = document.getElementById('idProgressFill');
    var pctEl  = document.getElementById('idProgressPct');
    var detail = document.getElementById('idProgressDetail');
    if (!fill && !pctEl && !detail) return; // Not on the Knowledge Map view
    var total  = id.progress.total || 1;
    var done   = id.progress.done;
    var pct    = Math.min(100, Math.round((done / total) * 100));
    if (fill)   fill.style.width  = pct + '%';
    if (pctEl)  pctEl.textContent = pct + '%';
    if (detail) detail.textContent = id.progress.folder
      ? 'Indexing: ' + id.progress.folder + ' (' + fmtNum(done) + ' / ' + fmtNum(total) + ')'
      : fmtNum(done) + ' / ' + fmtNum(total) + ' emails';
  }

  function idHandleComplete(ev) {
    id.state = 'indexed';
    if (window._ip) window._ip.indexing = false;
    browser.runtime.sendMessage({ action: 'getIndexingStats' }).then(function (stats) {
      idRenderClusters(stats);
    }).catch(function () {
      idRenderClusters({ total: ev.total || 0, folders: [] });
    });
  }

  function idHandleError(ev) {
    id.state = 'idle';
    if (window._ip) window._ip.indexing = false;
    var shell = document.getElementById('idShell');
    if (!shell) return;
    shell.innerHTML = [
      '<div class="id-error-state">',
        '<div class="id-error-icon">⚠️</div>',
        '<h3>Indexing Failed</h3>',
        '<p>' + esc(ev.error || 'Unknown error') + '</p>',
        '<button class="id-retry-btn" id="idRetryBtn">Retry</button>',
      '</div>',
    ].join('');
    document.getElementById('idRetryBtn').addEventListener('click', function () {
      id.state = 'idle';
      idRenderNotIndexed();
    });
  }

  function idShowError(msg) {
    var shell = document.getElementById('idShell');
    if (!shell) return;
    var existing = shell.querySelector('.id-error-banner');
    if (existing) existing.remove();
    var banner = document.createElement('div');
    banner.className = 'id-error-banner';
    banner.textContent = msg;
    shell.insertBefore(banner, shell.firstChild);
    setTimeout(function () { banner.remove(); }, 5000);
  }

  // ── Cluster graph (state: indexed) ───────────────────────────────────────

  // Fruchterman-Reingold layout — O(N² + E) per iteration, runs synchronously
  function idFRLayout(positions, edges, iterations) {
    var n = positions.length;
    // Scale initial PCA positions up to match the larger layout space
    var pos = positions.map(function(p) { return { x: p.x * 6, y: p.y * 6 }; });
    var W = 3.0, k = W * Math.sqrt(1.0 / n) * 2.2;

    for (var iter = 0; iter < iterations; iter++) {
      var temp = W * 0.6 * Math.exp(-iter / (iterations * 0.5));
      var disp = Array.from({ length: n }, function() { return { x: 0, y: 0 }; });

      // Repulsion: every pair
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
          var dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.001);
          var f = (k * k) / dist;
          disp[i].x += (dx / dist) * f; disp[i].y += (dy / dist) * f;
          disp[j].x -= (dx / dist) * f; disp[j].y -= (dy / dist) * f;
        }
      }

      // Attraction: edges only
      for (var ei = 0; ei < edges.length; ei++) {
        var s = edges[ei].s, t = edges[ei].t;
        var dx = pos[s].x - pos[t].x, dy = pos[s].y - pos[t].y;
        var dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.001);
        var f = (dist * dist) / k;
        disp[s].x -= (dx / dist) * f; disp[s].y -= (dy / dist) * f;
        disp[t].x += (dx / dist) * f; disp[t].y += (dy / dist) * f;
      }

      // Apply displacement + very weak gravity to keep graph centered
      for (var i = 0; i < n; i++) {
        var mag = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y);
        if (mag > 0) {
          var cap = Math.min(mag, temp);
          pos[i].x += (disp[i].x / mag) * cap;
          pos[i].y += (disp[i].y / mag) * cap;
        }
        pos[i].x -= pos[i].x * 0.002;
        pos[i].y -= pos[i].y * 0.002;
      }
    }

    // Post-process: clamp outliers to [5th, 95th] percentile + 15% padding.
    // Isolated nodes from FR push the sigma normalization range wide, making the
    // main cluster appear as a tiny blob. Clamping collapses outliers to the edge.
    var sortX = pos.map(function(p) { return p.x; }).slice().sort(function(a,b){ return a-b; });
    var sortY = pos.map(function(p) { return p.y; }).slice().sort(function(a,b){ return a-b; });
    var lo = Math.max(0, Math.floor(n * 0.05)), hi = Math.min(n-1, Math.floor(n * 0.95));
    var xLo = sortX[lo], xHi = sortX[hi], yLo = sortY[lo], yHi = sortY[hi];
    var xPad = (xHi - xLo) * 0.15 || 0.1, yPad = (yHi - yLo) * 0.15 || 0.1;
    return pos.map(function(p) {
      return {
        x: Math.max(xLo - xPad, Math.min(xHi + xPad, p.x)),
        y: Math.max(yLo - yPad, Math.min(yHi + yPad, p.y))
      };
    });
  }

  // ── Knowledge Graph render ───────────────────────────────────────────────────

  function idRenderKnowledgeGraph(kg, shell, statsTotal) {
    var nodes   = kg.nodes   || [];
    var edges   = kg.edges   || [];
    var kgStats = kg.stats   || {};
    var folders = kg.folders || [];

    // ── Pre-compute groups ───────────────────────────────────────────────────
    var KG_TYPE_ORDER  = ['ORG','PERSON','PRODUCT','TOPIC','PLACE','EVENT','DATE','AMOUNT','Entity'];
    var TYPE_COLORS    = {
      ORG:'#5887e4', PERSON:'#58e470', PRODUCT:'#e4b558',
      TOPIC:'#e45864', PLACE:'#58e4d8', EVENT:'#e458cd',
      DATE:'#9258e4', AMOUNT:'#aae458', Entity:'#93909f'
    };
    var typeGroups = {};
    nodes.forEach(function(n) {
      var t = n.type || 'Entity';
      if (!typeGroups[t]) typeGroups[t] = [];
      typeGroups[t].push(n);
    });
    var sidebarTypes = KG_TYPE_ORDER.filter(function(t) { return typeGroups[t] && typeGroups[t].length; });

    var relCounts = {};
    edges.forEach(function(e) {
      var p = e.predicate || 'RELATED_TO';
      relCounts[p] = (relCounts[p] || 0) + 1;
    });
    var uniqueRels = Object.keys(relCounts)
      .sort(function(a, b) { return relCounts[b] - relCounts[a]; })
      .map(function(p) { return { pred: p, count: relCounts[p] }; });

    // ── Build sidebar HTML ───────────────────────────────────────────────────
    var nodePillsHtml =
      '<span class="id-kg-pill id-kg-pill-star active" data-kgtype="*">*</span>' +
      sidebarTypes.map(function(t) {
        var col = TYPE_COLORS[t] || '#a855f7';
        return '<span class="id-kg-pill" data-kgtype="' + esc(t) + '" data-col="' + col + '">' +
          '<span class="id-kg-pill-dot" style="background:' + col + '"></span>' +
          esc(t) + '<span class="id-kg-pill-cnt">' + typeGroups[t].length + '</span>' +
          '</span>';
      }).join('');

    var relPillsHtml =
      '<span class="id-kg-pill id-kg-pill-star active" data-kgrel="*">*</span>' +
      uniqueRels.map(function(r) {
        return '<span class="id-kg-pill id-kg-rel-pill" data-kgrel="' + esc(r.pred) + '">' +
          esc(r.pred) + '<span class="id-kg-pill-cnt">' + r.count + '</span>' +
          '</span>';
      }).join('');

    // Resolve initial folder selection from the global view-filter dropdown.
    // dashboard.js exposes the live Set via window._ipGetViewFilter(); keys are
    // "accountId::folderPath" — we match on the last path segment vs folder.name.
    var _globalFilterKeys = (typeof window._ipGetViewFilter === 'function') ? window._ipGetViewFilter() : null;
    var _selectedFolderNames = new Set();
    if (_globalFilterKeys && _globalFilterKeys.size > 0) {
      _globalFilterKeys.forEach(function(key) {
        var idx = key.indexOf('::');
        var path = idx >= 0 ? key.slice(idx + 2) : key;
        var name = (path.split('/').pop() || path).toLowerCase();
        if (name) _selectedFolderNames.add(name);
      });
    }
    // Only apply the filter when at least one Galaxy folder matches — otherwise
    // fall back to all folders so the graph isn't blank.
    var _hasGlobalFilter = _selectedFolderNames.size > 0 &&
      folders.some(function(f) { return _selectedFolderNames.has(f.name.toLowerCase()); });

    var folderSectionHtml = (folders.length > 0)
      ? '<div class="id-kg-section">' +
          '<div class="id-kg-section-hdr">Folders (' + folders.length + ')</div>' +
          '<div class="id-kg-folder-list" id="idKgFolderList">' +
            folders.map(function(f) {
              var isChecked = !_hasGlobalFilter || _selectedFolderNames.has(f.name.toLowerCase());
              return '<label class="id-kg-folder-row">' +
                '<input type="checkbox"' + (isChecked ? ' checked' : '') + ' class="id-kg-folder-cb" data-folderid="' + f.id + '">' +
                '<span>' + esc(f.name) + '</span>' +
                '</label>';
            }).join('') +
          '</div>' +
        '</div>'
      : '';

    // ── Shell HTML ───────────────────────────────────────────────────────────
    shell.innerHTML =
      '<div class="id-graph-layout">' +
        '<div class="id-galaxy-canvas-wrap">' +
          '<div class="id-galaxy-searchbar">' +
            '<input id="idGalaxySearch" type="text" class="id-galaxy-search-input" placeholder="Search nodes…" />' +
          '</div>' +
          '<div id="idGraphHost" class="id-graph-host"></div>' +
          '<div class="id-galaxy-zoom-controls">' +
            '<button class="id-galaxy-zoom-btn" id="idGalaxyZoomIn"  title="Zoom in">+</button>' +
            '<button class="id-galaxy-zoom-btn" id="idGalaxyZoomOut" title="Zoom out">−</button>' +
            '<button class="id-galaxy-zoom-btn" id="idGalaxyZoomReset" title="Reset view" style="font-size:11px;">⊙</button>' +
            '<button class="id-galaxy-zoom-btn" id="idGalaxyToggleLabels" title="Toggle edge labels">Å</button>' +
          '</div>' +
        '</div>' +
        '<div class="id-graph-sidebar">' +
          '<div class="id-kg-header">' +
            '<div class="id-graph-sidebar-title">GALAXY</div>' +
            '<div class="id-kg-header-meta">' +
              fmtNum(kgStats.totalNodes || nodes.length) + ' entities · ' +
              fmtNum(kgStats.totalEdges || edges.length) + ' relationships' +
            '</div>' +
          '</div>' +
          '<div class="id-kg-scroll" id="idKgFilterScroll">' +
            '<div class="id-kg-section">' +
              '<div class="id-kg-section-hdr">Nodes (' + nodes.length + ')</div>' +
              '<div class="id-kg-pills" id="idKgNodePills">' + nodePillsHtml + '</div>' +
            '</div>' +
            '<div class="id-kg-section">' +
              '<div class="id-kg-section-hdr">Relationships (' + uniqueRels.length + ')</div>' +
              '<div class="id-kg-pills id-kg-rel-pills" id="idKgRelPills">' + relPillsHtml + '</div>' +
            '</div>' +
            folderSectionHtml +
            '<div class="id-kg-tip">Click a node · Drag · Scroll to zoom</div>' +
          '</div>' +
          '<div class="id-kg-node-detail" id="idKgNodeDetail" style="display:none"></div>' +
        '</div>' +
      '</div>';

    // ── Chart init ───────────────────────────────────────────────────────────
    var host = document.getElementById('idGraphHost');
    if (!host || !window.echarts) {
      host && (host.innerHTML = '<div class="id-empty-state"><p>ECharts not loaded — check echarts.min.js</p></div>');
      return;
    }

    var chart = echarts.init(host, null, { renderer: 'canvas' });
    var maxFreq = nodes.reduce(function(m, n) { return Math.max(m, n.frequency || 1); }, 1);

    var ecNodes = nodes.map(function(n) {
      var freq  = n.frequency || 1;
      var sz    = Math.round(16 + (Math.log(freq + 1) / Math.log(maxFreq + 1)) * 52);
      var col   = n.color || '#a855f7';
      return {
        id:         n.id,
        name:       n.label,
        value:      freq,
        _type:      n.type,
        _color:     col,
        _folderIds: n.folderIds || [],
        symbolSize: sz,
        itemStyle:  { color: col, borderColor: 'rgba(255,255,255,0.18)', borderWidth: 1.5 },
        label: {
          show: sz >= 24,
          fontSize: Math.max(9, Math.min(13, Math.round(sz * 0.21))),
          color: '#e2e8f0',
          fontFamily: 'Inter, system-ui, sans-serif',
          position: 'right',
          textBorderColor: 'rgba(0,0,0,0.5)',
          textBorderWidth: 2
        },
        // Dim, don't hide the label — a stray blur state during pan/zoom (cursor
        // resting over a node while scrolling) should never make labels vanish.
        blur:     { itemStyle: { opacity: 0.07 }, label: { show: sz >= 24, opacity: 0.35 } },
        emphasis: {
          label: { show: true, fontSize: 12, fontWeight: '600', color: '#fff', textBorderColor: 'transparent' },
          itemStyle: { borderColor: '#ffffff', borderWidth: 2.5, shadowBlur: 14, shadowColor: col }
        }
      };
    });

    // Neo4j-style relationships: static neutral silver-gray line + always-visible predicate label
    var EDGE_COLOR       = '#9aa1ae';  // silver / whitesmoke-on-dark
    var EDGE_COLOR_HOVER = '#d3d7de';
    var ecEdges = edges.map(function(e) {
      return {
        source:    e.subjectNodeId,
        target:    e.objectNodeId,
        _pred:     e.predicate || '',
        label: {
          show: true,
          formatter: e.predicate || '',
          fontSize: 9,
          color: '#c9cfd9',
          backgroundColor: 'rgba(8,11,20,0.78)',
          padding: [1, 4],
          borderRadius: 3
        },
        lineStyle: { color: EDGE_COLOR, curveness: 0.25, width: 1, opacity: 0.55 },
        // Dim, don't hide — see matching comment on node blur above.
        blur:      { lineStyle: { opacity: 0.05 }, label: { show: true, opacity: 0.3 } },
        emphasis: {
          label: {
            show: true, formatter: e.predicate || '',
            fontSize: 10, fontWeight: '600', color: '#f5f7fa',
            backgroundColor: 'rgba(8,11,20,0.92)', padding: [2, 6], borderRadius: 3
          },
          lineStyle: { color: EDGE_COLOR_HOVER, width: 2, opacity: 1.0 }
        }
      };
    });

    // Apply global folder filter to the initial render
    var _initFolderIds = _hasGlobalFilter
      ? new Set(folders.filter(function(f) { return _selectedFolderNames.has(f.name.toLowerCase()); }).map(function(f) { return f.id; }))
      : null;
    var _initNodes = _initFolderIds
      ? ecNodes.filter(function(n) { return n._folderIds.some(function(id) { return _initFolderIds.has(id); }); })
      : ecNodes;
    var _initNodeIdSet = _initFolderIds ? new Set(_initNodes.map(function(n) { return n.id; })) : null;
    var _initEdges = _initFolderIds
      ? ecEdges.filter(function(e) { return _initNodeIdSet.has(e.source) && _initNodeIdSet.has(e.target); })
      : ecEdges;

    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(5,9,20,0.93)',
        borderColor: 'rgba(129,140,248,0.35)',
        borderWidth: 1,
        textStyle: { color: '#dde6f4', fontSize: 12 },
        formatter: function(params) {
          if (params.dataType === 'node') {
            var d = params.data;
            return '<b style="color:#e2e8f0;font-size:13px">' + esc(d.name) + '</b><br>' +
                   '<span style="color:' + d._color + ';font-size:11px">' + esc(d._type || 'Entity') + '</span><br>' +
                   '<span style="color:#8899aa;font-size:11px">' + fmtNum(d.value || 0) + ' mentions</span>';
          }
          if (params.dataType === 'edge') {
            return '<span style="color:#aab;font-size:11px">' + esc(params.data._pred || '') + '</span>';
          }
          return '';
        }
      },
      series: [{
        type: 'graph',
        layout: 'force',
        animation: true,
        animationDuration: 1200,
        roam: true,
        draggable: true,
        force: { repulsion: 350, edgeLength: [80, 260], gravity: 0.06, layoutAnimation: true, friction: 0.65 },
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [0, 10],
        emphasis: { focus: 'adjacency', blurScope: 'global' },
        data:  _initNodes,
        links: _initEdges
      }]
    });

    new ResizeObserver(function() { chart.resize(); }).observe(host);

    // ── Zoom & pan wiring ────────────────────────────────────────────────────
    // Prevent #mainContent from stealing the scroll event — ECharts handles
    // zoom and drag-to-pan natively via roam:true. We only need to stop the
    // outer container from scrolling; dispatching graphRoam here would double-zoom.
    host.addEventListener('wheel', function(e) {
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });

    // Overlay zoom buttons
    var btnZoomIn    = document.getElementById('idGalaxyZoomIn');
    var btnZoomOut   = document.getElementById('idGalaxyZoomOut');
    var btnZoomReset = document.getElementById('idGalaxyZoomReset');
    var btnToggleLabels = document.getElementById('idGalaxyToggleLabels');
    var showEdgeLabels = true;

    // Native wheel/pinch zoom implicitly anchors on the cursor position; dispatchAction
    // has no such default, so we must pass an explicit origin (viewport center) or the
    // roam ends up zooming around the container's corner — compounding into the
    // "pinwheel" explosion after a couple of clicks.
    if (btnZoomIn)    btnZoomIn.addEventListener('click',    function() {
      chart.dispatchAction({ type: 'graphRoam', zoom: 1.3, originX: host.clientWidth / 2, originY: host.clientHeight / 2 });
    });
    if (btnZoomOut)   btnZoomOut.addEventListener('click',   function() {
      chart.dispatchAction({ type: 'graphRoam', zoom: 1 / 1.3, originX: host.clientWidth / 2, originY: host.clientHeight / 2 });
    });
    if (btnZoomReset) btnZoomReset.addEventListener('click', function() {
      chart.setOption({ series: [{ roam: true, draggable: true, zoom: 1, center: [host.offsetWidth / 2, host.offsetHeight / 2] }] });
    });
    if (btnToggleLabels) btnToggleLabels.addEventListener('click', function() {
      showEdgeLabels = !showEdgeLabels;
      chart.setOption({
        series: [{
          links: _initEdges.map(function(link) {
            return Object.assign({}, link, { label: { show: showEdgeLabels } });
          })
        }]
      });
    });

    // ── Node detail panel ────────────────────────────────────────────────────
    var filterScroll = document.getElementById('idKgFilterScroll');
    var nodeDetailEl = document.getElementById('idKgNodeDetail');

    function _showNodeDetail(nodeId, nodeName, nodeType, nodeColor) {
      if (!nodeDetailEl || !filterScroll) return;
      filterScroll.style.display = 'none';
      nodeDetailEl.style.display = 'flex';
      nodeDetailEl.innerHTML =
        '<div class="id-kg-nd-back">' +
          '<button class="id-kg-nd-back-btn" id="idKgNdBack">← Galaxy</button>' +
        '</div>' +
        '<div class="id-kg-nd-head">' +
          '<div class="id-kg-nd-name">' + esc(nodeName) + '</div>' +
          '<span class="id-kg-nd-badge" style="background:' + esc(nodeColor || '#a855f7') + '">' + esc(nodeType || 'Entity') + '</span>' +
        '</div>' +
        '<div class="id-kg-nd-loading">Loading emails…</div>';

      document.getElementById('idKgNdBack').addEventListener('click', function() {
        nodeDetailEl.style.display = 'none';
        filterScroll.style.display = '';
        nodeDetailEl.innerHTML = '';
      });

      browser.runtime.sendMessage({ action: 'getEmailsForNode', nodeId: nodeId })
        .then(function(emails) {
          emails = emails || [];
          var listHtml = emails.length === 0
            ? '<div class="id-kg-nd-empty">No source emails found for this entity.</div>'
            : emails.map(function(e, i) {
                var displaySender = privacyOn() ? maskEmail(e.sender || '') : (e.sender || '');
                var dateStr = e.date ? new Date(e.date).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) : '';
                var metaParts = [displaySender];
                if (e.domain) metaParts.push(e.domain);
                if (dateStr)  metaParts.push(dateStr);
                if (e.folderName) metaParts.push(e.folderName);
                return '<label class="id-kg-nd-email-row">' +
                  '<input type="checkbox" class="id-kg-nd-email-cb" data-idx="' + i + '" data-subject="' + esc(e.subject || '') + '" data-sender="' + esc(e.sender || '') + '">' +
                  '<div class="id-kg-nd-email-info">' +
                    '<div class="id-kg-nd-email-subj">' + esc(e.subject || '(no subject)') + '</div>' +
                    '<div class="id-kg-nd-email-meta">' + esc(metaParts.join(' · ')) + '</div>' +
                    (e.category ? '<span class="id-kg-nd-email-cat">' + esc(e.category) + '</span>' : '') +
                  '</div>' +
                '</label>';
              }).join('');

          nodeDetailEl.innerHTML =
            '<div class="id-kg-nd-back">' +
              '<button class="id-kg-nd-back-btn" id="idKgNdBack">← Galaxy</button>' +
            '</div>' +
            '<div class="id-kg-nd-head">' +
              '<div class="id-kg-nd-name">' + esc(nodeName) + '</div>' +
              '<span class="id-kg-nd-badge" style="background:' + esc(nodeColor || '#a855f7') + '">' + esc(nodeType || 'Entity') + '</span>' +
            '</div>' +
            '<div class="id-kg-nd-count">' + fmtNum(emails.length) + ' email' + (emails.length !== 1 ? 's' : '') + '</div>' +
            (emails.length > 0
              ? '<div class="id-kg-nd-toolbar">' +
                  '<label class="id-kg-nd-sel-all"><input type="checkbox" id="idKgNdSelAll"> Select all</label>' +
                  '<button class="id-kg-nd-open-btn" id="idKgNdOpenReview" disabled>Open in Review</button>' +
                '</div>'
              : '') +
            '<div class="id-kg-nd-emails" id="idKgNdEmailList">' + listHtml + '</div>';

          document.getElementById('idKgNdBack').addEventListener('click', function() {
            nodeDetailEl.style.display = 'none';
            filterScroll.style.display = '';
            nodeDetailEl.innerHTML = '';
          });

          var openBtn = document.getElementById('idKgNdOpenReview');
          var selAllCb = document.getElementById('idKgNdSelAll');

          function _getCheckedEmails() {
            return Array.from(nodeDetailEl.querySelectorAll('.id-kg-nd-email-cb:checked')).map(function(cb) {
              return { subject: cb.getAttribute('data-subject'), sender_email: cb.getAttribute('data-sender') };
            });
          }
          function _refreshOpenBtn() {
            var n = nodeDetailEl.querySelectorAll('.id-kg-nd-email-cb:checked').length;
            if (openBtn) { openBtn.disabled = n === 0; openBtn.textContent = n > 0 ? 'Open ' + n + ' in Review' : 'Open in Review'; }
            if (selAllCb) selAllCb.indeterminate = n > 0 && n < emails.length;
          }

          if (selAllCb) {
            selAllCb.addEventListener('change', function() {
              nodeDetailEl.querySelectorAll('.id-kg-nd-email-cb').forEach(function(cb) { cb.checked = selAllCb.checked; });
              _refreshOpenBtn();
            });
          }
          nodeDetailEl.querySelectorAll('.id-kg-nd-email-cb').forEach(function(cb) {
            cb.addEventListener('change', function() {
              if (selAllCb) selAllCb.checked = nodeDetailEl.querySelectorAll('.id-kg-nd-email-cb:checked').length === emails.length;
              _refreshOpenBtn();
            });
          });
          if (openBtn) {
            openBtn.addEventListener('click', function() {
              var checked = _getCheckedEmails();
              if (!checked.length) return;
              if (window._ip && window._ip.openCategoryReview) {
                window._ip.openCategoryReview(checked);
              } else {
                alert('No scan data loaded. Run a scan first, then try again.');
              }
            });
          }
        })
        .catch(function() {
          var loading = nodeDetailEl.querySelector('.id-kg-nd-loading');
          if (loading) loading.textContent = 'Could not load emails for this node.';
        });
    }

    // ECharts node click → show detail panel
    chart.on('click', function(params) {
      if (!params || params.dataType !== 'node') return;
      var d = params.data;
      _showNodeDetail(d.id, d.name, d._type, d._color);
    });

    // ── Filter state ─────────────────────────────────────────────────────────
    var activeNodeTypes = new Set();
    var activeRelTypes  = new Set();
    var allFolderIds    = new Set(folders.map(function(f) { return f.id; }));
    var activeFolderIds = _hasGlobalFilter
      ? new Set(folders.filter(function(f) { return _selectedFolderNames.has(f.name.toLowerCase()); }).map(function(f) { return f.id; }))
      : new Set(allFolderIds);

    // Tracks what is currently rendered in the chart (may be folder-filtered subset)
    var _renderedNodes = _initNodes;
    var _renderedEdges = _initEdges;

    function hexToRgba(hex, alpha) {
      var r = parseInt(hex.slice(1,3), 16);
      var g = parseInt(hex.slice(3,5), 16);
      var b = parseInt(hex.slice(5,7), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    // Folder filter: hard-removes nodes that don't belong to any active folder
    // and re-renders the graph via setOption (restarts force layout).
    function _updateRenderedGraph() {
      var hasFF = activeFolderIds.size < allFolderIds.size;
      if (!hasFF) {
        _renderedNodes = ecNodes;
        _renderedEdges = ecEdges;
      } else {
        var visibleIds = new Set();
        ecNodes.forEach(function(n) {
          if (n._folderIds.some(function(id) { return activeFolderIds.has(id); })) {
            visibleIds.add(n.id);
          }
        });
        _renderedNodes = ecNodes.filter(function(n) { return visibleIds.has(n.id); });
        _renderedEdges = ecEdges.filter(function(e) {
          return visibleIds.has(e.source) && visibleIds.has(e.target);
        });
      }
      // Always include roam+draggable so a partial setOption doesn't silently reset them.
      chart.setOption({ series: [{ roam: true, draggable: true, data: _renderedNodes, links: _renderedEdges }] });
    }

    // Node type + rel filter: highlight/downplay on the currently rendered graph.
    // Does NOT touch the node/edge arrays — layout stays stable.
    function _applyTypeRelHighlight() {
      var hasNF = activeNodeTypes.size > 0;
      var hasRF = activeRelTypes.size > 0;
      if (!hasNF && !hasRF) {
        chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
        return;
      }
      var relNodeIds = null;
      if (hasRF) {
        relNodeIds = new Set();
        _renderedEdges.forEach(function(e) {
          if (activeRelTypes.has(e._pred)) { relNodeIds.add(e.source); relNodeIds.add(e.target); }
        });
      }
      var visibleIdx = [];
      _renderedNodes.forEach(function(n, i) {
        var typeOk = !hasNF || activeNodeTypes.has(n._type);
        var relOk  = !hasRF || (relNodeIds && relNodeIds.has(n.id));
        if (typeOk && relOk) visibleIdx.push(i);
      });
      chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
      if (visibleIdx.length && visibleIdx.length < _renderedNodes.length) {
        chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: visibleIdx });
      }
    }

    // ── Node type pills ──────────────────────────────────────────────────────
    var nodePillsEl = document.getElementById('idKgNodePills');
    if (nodePillsEl) {
      nodePillsEl.addEventListener('click', function(ev) {
        var pill = ev.target.closest('.id-kg-pill');
        if (!pill) return;
        var t = pill.getAttribute('data-kgtype');
        if (t === '*') {
          activeNodeTypes.clear();
          nodePillsEl.querySelectorAll('.id-kg-pill').forEach(function(p) {
            p.classList.remove('active');
            p.style.cssText = '';
          });
          pill.classList.add('active');
        } else {
          nodePillsEl.querySelector('[data-kgtype="*"]').classList.remove('active');
          if (activeNodeTypes.has(t)) {
            activeNodeTypes.delete(t);
            pill.classList.remove('active');
            pill.style.cssText = '';
            if (!activeNodeTypes.size) nodePillsEl.querySelector('[data-kgtype="*"]').classList.add('active');
          } else {
            activeNodeTypes.add(t);
            var col = pill.getAttribute('data-col') || '#818cf8';
            pill.classList.add('active');
            pill.style.background   = hexToRgba(col, 0.18);
            pill.style.borderColor  = hexToRgba(col, 0.50);
            pill.style.color        = col;
          }
        }
        _applyTypeRelHighlight();
      });
    }

    // ── Relationship pills ────────────────────────────────────────────────────
    var relPillsEl = document.getElementById('idKgRelPills');
    if (relPillsEl) {
      relPillsEl.addEventListener('click', function(ev) {
        var pill = ev.target.closest('.id-kg-pill');
        if (!pill) return;
        var r = pill.getAttribute('data-kgrel');
        if (r === '*') {
          activeRelTypes.clear();
          relPillsEl.querySelectorAll('.id-kg-pill').forEach(function(p) {
            p.classList.remove('active'); p.style.cssText = '';
          });
          pill.classList.add('active');
        } else {
          relPillsEl.querySelector('[data-kgrel="*"]').classList.remove('active');
          if (activeRelTypes.has(r)) {
            activeRelTypes.delete(r);
            pill.classList.remove('active');
            pill.style.cssText = '';
            if (!activeRelTypes.size) relPillsEl.querySelector('[data-kgrel="*"]').classList.add('active');
          } else {
            activeRelTypes.add(r);
            pill.classList.add('active');
            pill.style.background  = 'rgba(129,140,248,0.18)';
            pill.style.borderColor = 'rgba(129,140,248,0.50)';
            pill.style.color       = '#818cf8';
          }
        }
        _applyTypeRelHighlight();
      });
    }

    // ── Folder checkboxes ────────────────────────────────────────────────────
    var folderListEl = document.getElementById('idKgFolderList');
    if (folderListEl) {
      folderListEl.addEventListener('change', function(ev) {
        var cb = ev.target;
        if (!cb || cb.type !== 'checkbox') return;
        var fid = parseInt(cb.getAttribute('data-folderid'), 10);
        if (cb.checked) activeFolderIds.add(fid);
        else            activeFolderIds.delete(fid);
        // Hard re-render: remove nodes/edges that don't belong to active folders
        _updateRenderedGraph();
        // Re-apply any node-type / rel highlight on top of the new graph
        _applyTypeRelHighlight();
      });
    }

    // ── Search ───────────────────────────────────────────────────────────────
    var searchEl = document.getElementById('idGalaxySearch');
    if (searchEl) {
      searchEl.addEventListener('input', function() {
        var q = this.value.trim().toLowerCase();
        if (!q) { _applyTypeRelHighlight(); return; }
        // Search within the currently rendered (possibly folder-filtered) nodes
        var matches = [];
        _renderedNodes.forEach(function(n, i) {
          if (n.name.toLowerCase().indexOf(q) >= 0) matches.push(i);
        });
        chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
        if (matches.length) chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: matches });
      });
    }

    // ── Canvas click → restore ────────────────────────────────────────────────
    chart.on('click', function(params) {
      if (!params || !params.dataType) {
        var s = document.getElementById('idGalaxySearch');
        if (s) s.value = '';
        _applyTypeRelHighlight();
      }
    });
  }

  // ── Cluster render (K-means fallback) ────────────────────────────────────────

  function idRenderClusters(stats) {
    var shell = document.getElementById('idShell');
    if (!shell) return;
    var total = (stats && stats.total) ? stats.total : 0;

    shell.innerHTML = '<div class="id-graph-loading">Computing semantic space…</div>';

    // Try knowledge graph first — if enough entities exist, render as entity graph
    browser.runtime.sendMessage({ action: 'getKnowledgeGraph' })
      .catch(function() { return null; })
      .then(function(kg) {
        if (kg && kg.stats && kg.stats.totalNodes >= 5) {
          idRenderKnowledgeGraph(kg, shell, total);
          return;
        }
        // Fall back to K-means cluster view
        browser.runtime.sendMessage({ action: 'getCluster2D' }).then(function (result) {
      if (!result || !result.points || !result.points.length) {
        shell.innerHTML = '<div class="id-empty-state"><p>No clusters found. Index your emails in the Indexes page first.</p></div>';
        return;
      }

      var points      = result.points;
      var clusters    = result.clusters;
      var withinEdges = result.withinEdges || [];
      var crossEdges  = result.crossEdges  || [];
      var allEdges    = withinEdges.concat(crossEdges);

      var clusterMap = {};
      clusters.forEach(function(c) { clusterMap[c.k] = c; });

      var byK = {};
      points.forEach(function(p) {
        if (!byK[p.k]) byK[p.k] = [];
        byK[p.k].push(p);
      });

      // FR layout uses all edges for attraction (within + cross)
      var laid = idFRLayout(points, allEdges, 200);

      // Degree from within-cluster edges only (cross-cluster edges skew degree unfairly)
      var degree = new Array(points.length).fill(0);
      withinEdges.forEach(function(e) { degree[e.s]++; degree[e.t]++; });
      var maxDeg = Math.max.apply(null, degree) || 1;

      // Highest-degree node per cluster becomes the labelled anchor
      var clusterAnchor = {};
      clusters.forEach(function(c) {
        var best = -1, bestDeg = -1;
        (byK[c.k] || []).forEach(function(p) {
          var idx = points.indexOf(p);
          if (degree[idx] > bestDeg) { bestDeg = degree[idx]; best = idx; }
        });
        clusterAnchor[c.k] = best;
      });

      // Build layout HTML
      shell.innerHTML =
        '<div class="id-graph-layout">' +
          '<div id="idGraphHost" class="id-graph-host"></div>' +
          '<div id="idGraphTooltip" class="id-graph-tooltip"></div>' +
          '<div class="id-graph-sidebar">' +
            '<div class="id-graph-sidebar-top">' +
              '<span class="id-graph-sidebar-title">CLUSTERS</span>' +
            '</div>' +
            '<div class="id-graph-sidebar-meta">' + fmtNum(total) + ' emails · ' + clusters.length + ' clusters</div>' +
            '<div class="id-community-list" id="idCommunityList"></div>' +
          '</div>' +
        '</div>';

      var host  = document.getElementById('idGraphHost');
      var tipEl = document.getElementById('idGraphTooltip');
      if (!host || !window.Sigma || !window.graphology) return;

      // ── Chip / badge label renderer (GitNexus style) ──────────────────────────
      function drawChipLabel(ctx, data, settings) {
        if (!data.label) return;
        var fs = settings.labelSize || 11;
        var fw = settings.labelWeight || '600';
        var ff = settings.labelFont || 'Inter, system-ui, sans-serif';
        ctx.font = fw + ' ' + fs + 'px ' + ff;
        var tw = ctx.measureText(data.label).width;
        var px = 7, py = 3;
        var bx = data.x + data.size + 5;
        var by = data.y - Math.round((fs + py * 2) / 2);
        var bw = tw + px * 2, bh = fs + py * 2;
        // data.color is the anchor's colour (20% lightenHex of cluster colour)
        var accent = data.color || '#818cf8';
        // Chip: deep navy background + cluster-accented border
        ctx.fillStyle = 'rgba(5, 9, 20, 0.93)';
        if (ctx.roundRect) {
          ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4); ctx.fill();
          ctx.strokeStyle = accent + 'B0'; // ~69% opacity border
          ctx.lineWidth = 1.0;
          ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4); ctx.stroke();
        } else {
          ctx.fillRect(bx, by, bw, bh);
        }
        // Soft white text — always legible on dark background
        ctx.fillStyle = '#dde6f4';
        ctx.fillText(data.label, bx + px, data.y + Math.round(fs * 0.36));
      }

      // ── Build Graphology graph ────────────────────────────────────────────────
      var G = new graphology.Graph({ type: 'undirected', multi: false });

      // ── Colour helpers ────────────────────────────────────────────────────────
      // Lighten a hex colour by mixing toward white (t=0…1)
      function lightenHex(hex, t) {
        var r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
        r = Math.min(255, Math.round(r + (255-r) * t));
        g = Math.min(255, Math.round(g + (255-g) * t));
        b = Math.min(255, Math.round(b + (255-b) * t));
        return '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + b.toString(16).padStart(2,'0');
      }
      function hexToRgba(hex, alpha) {
        var r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
      }

      // ── Build Graphology graph (nodes only — edges drawn on canvas overlay) ──
      points.forEach(function(p, i) {
        var c   = clusterMap[p.k] || {};
        var deg = degree[i] || 0;
        var isAnchor = clusterAnchor[p.k] === i;
        var clusterColor = c.color || '#818cf8';
        // Small nodes: full cluster colour. Anchors: 20% toward white so they pop.
        var nodeColor = isAnchor ? lightenHex(clusterColor, 0.20) : clusterColor;
        var sz = isAnchor
          ? Math.min(9, Math.max(5.5, 5.5 + (deg / maxDeg) * 3.5))
          : Math.min(3, Math.max(1.5, 1.5 + (deg / maxDeg) * 1.5));
        G.addNode(String(i), {
          x: laid[i].x, y: laid[i].y,
          size: sz,
          color: nodeColor,
          label: isAnchor ? (c.label || '') : '',
          _k: p.k, _subject: p.subject,
          _email: p.sender_email, _name: p.sender_name,
          _baseSize: sz, _baseColor: nodeColor, _clusterColor: clusterColor
        });
      });

      // Edges go in G as invisible so sigma topology works but WebGL draws nothing.
      // The canvas overlay below draws them as bezier curves.
      var allEdgesForOverlay = [];
      withinEdges.forEach(function(e) {
        allEdgesForOverlay.push({ s: e.s, t: e.t, within: true });
        try { G.addEdge(String(e.s), String(e.t), { color: 'rgba(0,0,0,0)', size: 0 }); } catch(ex) {}
      });
      crossEdges.forEach(function(e) {
        allEdgesForOverlay.push({ s: e.s, t: e.t, within: false });
        try { G.addEdge(String(e.s), String(e.t), { color: 'rgba(0,0,0,0)', size: 0 }); } catch(ex) {}
      });

      // ── Sigma.js renderer ─────────────────────────────────────────────────────
      var SigmaClass = window.Sigma.Sigma || window.Sigma.default;
      var renderer = new SigmaClass(G, host, {
        renderEdgeLabels: false,
        defaultEdgeColor: 'rgba(0,0,0,0)',
        defaultNodeColor: '#3B5280',
        allowInvalidContainer: true,
        labelFont: 'Inter, system-ui, -apple-system, sans-serif',
        labelSize: 11,
        labelWeight: '600',
        labelThreshold: 4,
        minCameraRatio: 0.05,
        maxCameraRatio: 15,
        enableEdgeClickEvents: false,
        enableEdgeWheelEvents: false,
        enableEdgeHoverEvents: false,
        defaultDrawNodeLabel: drawChipLabel
      });

      // ── Bezier curve edge overlay ─────────────────────────────────────────────
      // Sigma WebGL only draws straight lines. We draw quadratic bezier curves
      // on a 2D canvas overlay that sits above Sigma's WebGL canvas.
      var overlayCanvas = document.createElement('canvas');
      overlayCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
      host.appendChild(overlayCanvas);

      var highlightedK = -1; // -1 = show all

      function drawCurvedEdges() {
        var W = host.clientWidth, H = host.clientHeight;
        if (!W || !H) return;
        overlayCanvas.width = W; overlayCanvas.height = H;
        var ctx = overlayCanvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        ctx.lineCap = 'round';

        allEdgesForOverlay.forEach(function(e) {
          try {
            var sA = G.getNodeAttributes(String(e.s));
            var tA = G.getNodeAttributes(String(e.t));
            var s  = renderer.graphToViewport({ x: sA.x, y: sA.y });
            var t  = renderer.graphToViewport({ x: tA.x, y: tA.y });
            var dx = t.x - s.x, dy = t.y - s.y;
            var curv = e.within ? 0.22 : 0.10;
            // Control point perpendicular to edge midpoint (alternates side per edge index)
            var cpx = (s.x + t.x) / 2 - dy * curv;
            var cpy = (s.y + t.y) / 2 + dx * curv;

            var clK  = points[e.s].k;
            var active = (highlightedK === -1 || clK === highlightedK);
            var c = clusterMap[clK] || {};

            if (e.within) {
              ctx.strokeStyle = hexToRgba(c.color || '#818cf8', active ? 0.28 : 0.05);
              ctx.lineWidth = active ? 0.7 : 0.3;
            } else {
              ctx.strokeStyle = hexToRgba('#334155', active ? 0.13 : 0.03);
              ctx.lineWidth = 0.3;
            }
            ctx.beginPath();
            ctx.moveTo(s.x, s.y);
            ctx.quadraticCurveTo(cpx, cpy, t.x, t.y);
            ctx.stroke();
          } catch(ex) {}
        });
      }

      // Redraw curves on every sigma render (camera moves, zoom, etc.)
      renderer.on('afterRender', drawCurvedEdges);

      // ── Tooltip ───────────────────────────────────────────────────────────────
      renderer.on('enterNode', function(e) {
        var a = G.getNodeAttributes(e.node);
        var c = clusterMap[a._k] || {};
        tipEl.innerHTML =
          '<div class="id-tt-subject">' + esc(a._subject || '(no subject)') + '</div>' +
          '<div class="id-tt-email">' + esc(a._email || '') + '</div>' +
          '<div class="id-tt-cluster" style="color:' + (c.color || '#818cf8') + '">' + esc(c.label || '') + '</div>';
        tipEl.style.display = 'block';
        host.style.cursor = 'pointer';
      });
      renderer.on('leaveNode', function() {
        tipEl.style.display = 'none';
        host.style.cursor = '';
      });
      host.addEventListener('mousemove', function(ev) {
        var rect = host.getBoundingClientRect();
        tipEl.style.left = (ev.clientX - rect.left + 18) + 'px';
        tipEl.style.top  = (ev.clientY - rect.top  + 12) + 'px';
      });

      renderer.on('clickNode', function(e) {
        var a = G.getNodeAttributes(e.node);
        var rows = (byK[a._k] || []).map(function(pt) {
          return { subject: pt.subject, sender_email: pt.sender_email };
        });
        if (rows.length && window._ip && window._ip.openCategoryReview) {
          window._ip.openCategoryReview(rows);
        }
      });

      requestAnimationFrame(function() {
        renderer.getCamera().animatedReset();
      });

      new ResizeObserver(function() {
        renderer.refresh();
        drawCurvedEdges();
      }).observe(host);

      // ── Sidebar ───────────────────────────────────────────────────────────────
      var listEl = document.getElementById('idCommunityList');
      if (!listEl) return;

      listEl.innerHTML = clusters.map(function(c) {
        return '<div class="id-community-row" data-k="' + c.k + '">' +
          '<span class="id-community-dot" style="background:' + c.color + '"></span>' +
          '<span class="id-community-name">' + esc(c.label) + '</span>' +
          '<span class="id-community-count">' + c.count + '</span>' +
        '</div>';
      }).join('');

      function restoreColors() {
        highlightedK = -1;
        G.forEachNode(function(nodeId, attrs) {
          G.setNodeAttribute(nodeId, 'color', attrs._baseColor);
          G.setNodeAttribute(nodeId, 'size',  attrs._baseSize);
        });
        renderer.refresh();
        drawCurvedEdges();
        listEl.querySelectorAll('.id-community-row').forEach(function(r) { r.classList.remove('active'); });
      }

      listEl.querySelectorAll('.id-community-row').forEach(function(row) {
        row.addEventListener('click', function() {
          var activeK = parseInt(row.getAttribute('data-k'), 10);
          highlightedK = activeK;
          G.forEachNode(function(nodeId, attrs) {
            var active = attrs._k === activeK;
            G.setNodeAttribute(nodeId, 'color', active ? attrs._baseColor : '#161b22');
            G.setNodeAttribute(nodeId, 'size',  active ? attrs._baseSize  : 0.8);
          });
          renderer.refresh();
          drawCurvedEdges();
          listEl.querySelectorAll('.id-community-row').forEach(function(r) { r.classList.remove('active'); });
          row.classList.add('active');
          // No camera move — highlight happens in-place so the graph stays put
        });

        row.addEventListener('dblclick', function() {
          var k = parseInt(row.getAttribute('data-k'), 10);
          var rows = (byK[k] || []).map(function(pt) {
            return { subject: pt.subject, sender_email: pt.sender_email };
          });
          if (rows.length && window._ip && window._ip.openCategoryReview) {
            window._ip.openCategoryReview(rows);
          }
        });
      });

      renderer.on('clickStage', restoreColors);

        }).catch(function(err) {
          console.error('[clusters]', err);
          shell.innerHTML = '<div class="id-empty-state"><p>Could not compute cluster space.</p>' +
            '<button class="id-retry-btn" id="idRetryBtn2">Retry</button></div>';
          var btn = document.getElementById('idRetryBtn2');
          if (btn) btn.addEventListener('click', function() { idRenderClusters(stats); });
        });
      });
  }

  // ── Cluster email modal ────────────────────────────────────────────────────

  function idShowClusterModal(label, icon, totalCount) {
    var existing = document.getElementById('idClusterModal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'idClusterModal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = [
      '<div class="modal-box selection-review-modal ic-modal">',
        '<div class="selection-review-head ic-modal-head">',
          '<div>',
            '<h3>' + icon + ' ' + esc(label) + '</h3>',
            '<p>' + fmtNum(totalCount) + ' emails in this category</p>',
          '</div>',
          '<button class="ic-close-btn" id="idClusterModalClose">',
            '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l12 12M13 1L1 13"/></svg>',
          '</button>',
        '</div>',
        '<div class="selection-review-controls ic-search-row">',
          '<input type="text" id="icSearchInput" class="search-input" placeholder="Search emails…">',
        '</div>',
        '<div class="ic-table-head">',
          '<span class="ic-col-subject">Subject</span>',
          '<span class="ic-col-sender">Sender</span>',
          '<span class="ic-col-date">Date</span>',
          '<span class="ic-col-folder">Folder</span>',
        '</div>',
        '<div id="icEmailList" class="ic-email-list">',
          '<div class="selection-empty">Loading…</div>',
        '</div>',
      '</div>',
    ].join('');

    document.body.appendChild(overlay);

    document.getElementById('idClusterModalClose').addEventListener('click', function () {
      overlay.remove();
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    var allEmails = [];

    function renderEmailList(emails) {
      var list = document.getElementById('icEmailList');
      if (!list) return;
      if (!emails.length) {
        list.innerHTML = '<div class="selection-empty">No emails found in this category.</div>';
        return;
      }
      list.innerHTML = emails.slice(0, 200).map(function (e) {
        var d = e.date_unix ? new Date(e.date_unix * 1000) : null;
        var dateStr = d ? (d.toLocaleString('default', { month: 'short' }) + ' ' + d.getFullYear()) : '—';
        var senderDisplay = (e.sender_name && e.sender_name !== e.sender_email)
          ? e.sender_name : (e.domain || e.sender_email || '—');
        var boldClass = e.is_read ? '' : ' ic-row-unread';
        return '<div class="ic-email-row' + boldClass + '">' +
          '<div class="ic-col-subject">' + esc(e.subject || '(no subject)') + '</div>' +
          '<div class="ic-col-sender">' + esc(senderDisplay) + '</div>' +
          '<div class="ic-col-date">'   + esc(dateStr) + '</div>' +
          '<div class="ic-col-folder">' + esc(e.folder || '—') + '</div>' +
          '</div>';
      }).join('');
    }

    browser.runtime.sendMessage({ action: 'getClusterEmails', label: label }).then(function (emails) {
      console.log('[InboxPie] getClusterEmails returned', (emails || []).length, 'emails for', label);
      allEmails = emails || [];
      renderEmailList(allEmails);
    }).catch(function (err) {
      console.error('[InboxPie] getClusterEmails error:', err);
      var list = document.getElementById('icEmailList');
      if (list) list.innerHTML = '<div class="selection-empty">Could not load emails.</div>';
    });

    document.getElementById('icSearchInput').addEventListener('input', function () {
      var q = this.value.toLowerCase().trim();
      if (!q) { renderEmailList(allEmails); return; }
      renderEmailList(allEmails.filter(function (e) {
        return (e.subject || '').toLowerCase().includes(q) ||
               (e.sender_name || '').toLowerCase().includes(q) ||
               (e.sender_email || '').toLowerCase().includes(q) ||
               (e.domain || '').toLowerCase().includes(q);
      }));
    });
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  AI SETTINGS PAGE
  // ══════════════════════════════════════════════════════════════════════════

  var ais = {
    editing: {},   // provider → true when editing key
    testing: {},   // provider → true when validating
    saving:  false,
  };

  window.renderAISettings = function () {
    var panel = document.getElementById('aisettingsView');
    if (!panel) return;

    panel.innerHTML = '<div class="ais-shell" id="aisShell"><div class="ais-loading">Loading…</div></div>';

    Promise.all([
      browser.runtime.sendMessage({ action: 'getAISettings' }),
      browser.runtime.sendMessage({ action: 'checkOllama' }),
    ]).then(function (results) {
      var s = results[0];
      var ollamaRes = results[1];
      if (s && s.activeProvider) chat.aiProvider = s.activeProvider;
      if (s && s.ollamaModel) chat._savedOllamaModel = s.ollamaModel;
      if (s && s.providers) {
        ['openai', 'anthropic', 'google'].forEach(function (p) {
          if (s.providers[p]) {
            chat.aiSettings[p].hasKey    = s.providers[p].hasKey;
            chat.aiSettings[p].maskedKey = s.providers[p].maskedKey;
            if (s.providers[p].model) chat.aiSettings[p].model = s.providers[p].model;
          }
        });
      }
      chat.ollamaOk = ollamaRes && ollamaRes.available;
      if (chat.ollamaOk) chat.availableModels = ollamaRes.models || [];
      aisRender(s);
    }).catch(function () { aisRender(null); });
  };

  function aisRender(s) {
    var shell = document.getElementById('aisShell');
    if (!shell) return;

    var activeProvider = (s && s.activeProvider) || chat.aiProvider || 'ollama';
    var providers = (s && s.providers) || {};

    function providerCard(id, name, icon, keyHint, modelList) {
      var p = providers[id] || { hasKey: false, maskedKey: '', model: '' };
      var isActive = activeProvider === id;
      var storedModel = p.model || modelList[0] || '';

      var statusBadge = p.hasKey
        ? '<span class="ais-badge ais-badge-ok">Connected</span>'
        : '<span class="ais-badge ais-badge-off">Not configured</span>';

      var keyRow = ais.editing[id]
        ? '<div class="ais-key-edit-row">' +
            '<input type="password" class="ais-key-input" id="aisKeyInput_' + id + '" placeholder="' + esc(keyHint) + '" autocomplete="off">' +
            '<button class="ais-btn ais-btn-test" data-provider="' + id + '" id="aisTestBtn_' + id + '">Test</button>' +
          '</div>' +
          (p.hasKey ? '<div class="ais-key-note">Existing key will be replaced on Save</div>' : '')
        : (p.hasKey
            ? '<div class="ais-key-saved-row">' +
                '<span class="ais-masked-key">' + esc(p.maskedKey) + '</span>' +
                '<button class="ais-btn ais-btn-sm ais-btn-edit" data-provider="' + id + '">Edit</button>' +
                '<button class="ais-btn ais-btn-sm ais-btn-clear" data-provider="' + id + '">Clear</button>' +
              '</div>'
            : '<div class="ais-key-empty">' +
                '<button class="ais-btn ais-btn-add" data-provider="' + id + '">Add API Key</button>' +
              '</div>');

      var modelRow = modelList.length
        ? '<div class="ais-model-row">' +
            '<label class="ais-label">Model</label>' +
            '<select class="ais-model-select" id="aisModel_' + id + '" data-provider="' + id + '">' +
              modelList.map(function (m) {
                return '<option value="' + esc(m) + '"' + (m === storedModel ? ' selected' : '') + '>' + esc(m) + '</option>';
              }).join('') +
            '</select>' +
          '</div>'
        : '';

      var activeRow = isActive
        ? '<div class="ais-active-row"><span class="ais-badge ais-badge-ok ais-badge-active-provider">✓ Active provider</span></div>'
        : (p.hasKey
            ? '<button class="ais-btn ais-btn-use" data-provider="' + id + '">Use this provider</button>'
            : '');

      return '<div class="ais-card' + (isActive ? ' ais-card-active' : '') + '" id="aisCard_' + id + '">' +
        '<div class="ais-card-header">' +
          '<span class="ais-card-icon">' + icon + '</span>' +
          '<div>' +
            '<div class="ais-card-name">' + esc(name) + '</div>' +
            '<div class="ais-card-sub">Cloud AI — Your Key, Your Account</div>' +
          '</div>' +
          statusBadge +
        '</div>' +
        '<div class="ais-card-body">' +
          '<div class="ais-label-row"><label class="ais-label">API Key</label></div>' +
          keyRow +
          '<div id="aisTestResult_' + id + '" class="ais-test-result" style="display:none"></div>' +
          modelRow +
          activeRow +
        '</div>' +
      '</div>';
    }

    shell.innerHTML =
      '<div class="ais-page">' +
        '<div class="ais-header">' +
          '<h2 class="ais-title">Settings</h2>' +
          '<p class="ais-desc">Manage which AI engine answers your questions. Everything stays on your device unless you opt into a cloud provider with your own key.</p>' +
        '</div>' +

        '<div class="ais-section-label">Local AI</div>' +
        '<div class="ais-card" id="aisEmbeddingCard">' +
          '<div class="ais-card-header">' +
            '<span class="ais-card-icon">🧠</span>' +
            '<div>' +
              '<div class="ais-card-name">Embedding Model</div>' +
              '<div class="ais-card-sub">bge-base-en-v1.5 — 768-dim, ~110 MB · quantized ONNX · runs offline</div>' +
            '</div>' +
            '<span class="ais-badge" id="aisEmbedBadge">Checking…</span>' +
          '</div>' +
          '<div class="ais-card-body">' +
            '<div class="ais-ollama-hint" id="aisEmbedHint">Loading status…</div>' +
            '<div class="ais-embed-bar-wrap" id="aisEmbedBarWrap" style="display:none">' +
              '<div class="ais-embed-bar"><div class="ais-embed-bar-fill" id="aisEmbedBarFill"></div></div>' +
              '<span class="ais-embed-bar-label" id="aisEmbedBarLabel"></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ais-card" id="aisRerankerCard">' +
          '<div class="ais-card-header">' +
            '<span class="ais-card-icon">🎯</span>' +
            '<div>' +
              '<div class="ais-card-name">Reranker Model</div>' +
              '<div class="ais-card-sub">bge-reranker-base — cross-encoder, ~300 MB · quantized ONNX · runs offline</div>' +
            '</div>' +
            '<span class="ais-badge" id="aisRerankBadge">Checking…</span>' +
          '</div>' +
          '<div class="ais-card-body">' +
            '<div class="ais-ollama-hint" id="aisRerankHint">Loading status…</div>' +
            '<div class="ais-embed-bar-wrap" id="aisRerankBarWrap" style="display:none">' +
              '<div class="ais-embed-bar"><div class="ais-embed-bar-fill" id="aisRerankBarFill"></div></div>' +
              '<span class="ais-embed-bar-label" id="aisRerankBarLabel"></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div id="aisIndexingStatusCard"></div>' +
        (function() {
          var ollamaBadge = chat.ollamaOk === false
            ? '<span class="ais-badge ais-badge-off">Offline</span>'
            : chat.ollamaOk === true
              ? '<span class="ais-badge ais-badge-ok">Online · ' + chat.availableModels.length + ' model' + (chat.availableModels.length !== 1 ? 's' : '') + '</span>'
              : '<span class="ais-badge">Checking…</span>';

          // Model dropdown — show available models when Ollama is online
          var savedOllamaModel = chat._savedOllamaModel || chat.model || '';
          var ollamaModelRow = '';
          if (chat.ollamaOk === true && chat.availableModels.length) {
            ollamaModelRow = '<div class="ais-model-row">' +
              '<label class="ais-label">Model</label>' +
              '<select class="ais-model-select" id="aisModel_ollama" data-provider="ollama">' +
                chat.availableModels.map(function(m) {
                  return '<option value="' + esc(m) + '"' + (m === savedOllamaModel ? ' selected' : '') + '>' + esc(m) + '</option>';
                }).join('') +
              '</select>' +
            '</div>';
          } else if (chat.ollamaOk === false) {
            ollamaModelRow = '<div class="ais-ollama-hint">Install from <code>ollama.com</code> and run <code>ollama serve</code></div>';
          }

          var activeRow = activeProvider === 'ollama'
            ? '<div class="ais-active-row"><span class="ais-badge ais-badge-ok ais-badge-active-provider">✓ Active provider</span></div>'
            : '<button class="ais-btn ais-btn-use" data-provider="ollama">Use this provider</button>';

          return '<div class="ais-card' + (activeProvider === 'ollama' ? ' ais-card-active' : '') + '" id="aisCard_ollama">' +
            '<div class="ais-card-header">' +
              '<span class="ais-card-icon">🖥</span>' +
              '<div>' +
                '<div class="ais-card-name">Ollama (Local)</div>' +
                '<div class="ais-card-sub">100% private — runs on your machine</div>' +
              '</div>' +
              ollamaBadge +
            '</div>' +
            '<div class="ais-card-body">' +
              ollamaModelRow +
              activeRow +
            '</div>' +
          '</div>';
        })() +

        '<div class="ais-section-label">Cloud AI</div>' +

        providerCard('openai', 'OpenAI', '✦', 'sk-...', CLOUD_MODELS.openai) +
        providerCard('anthropic', 'Anthropic', '◆', 'sk-ant-...', CLOUD_MODELS.anthropic) +
        providerCard('google', 'Google Gemini', '⬡', 'AIza...', CLOUD_MODELS.google) +
      '</div>';

    aisLoadEmbeddingStatus();
    aisLoadRerankerStatus();
    aisLoadIndexingStatus();

    // Wire up events
    shell.querySelectorAll('.ais-btn-add, .ais-btn-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        ais.editing[btn.getAttribute('data-provider')] = true;
        aisRender(s);
      });
    });

    shell.querySelectorAll('.ais-btn-clear').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.getAttribute('data-provider');
        if (!confirm('Remove ' + (CLOUD_PROVIDER_NAMES[p] || p) + ' API key?')) return;
        browser.runtime.sendMessage({ action: 'clearProviderKey', provider: p }).then(function () {
          ais.editing[p] = false;
          chat.aiSettings[p].hasKey = false;
          chat.aiSettings[p].maskedKey = '';
          if (chat.aiProvider === p) chat.aiProvider = 'ollama';
          s = null;
          window.renderAISettings();
        });
      });
    });

    shell.querySelectorAll('.ais-btn-test').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.getAttribute('data-provider');
        var inp = document.getElementById('aisKeyInput_' + p);
        if (!inp || !inp.value.trim()) return;
        var key = inp.value.trim();
        var resultEl = document.getElementById('aisTestResult_' + p);
        btn.disabled = true; btn.textContent = 'Testing…';
        if (resultEl) { resultEl.style.display = 'none'; }
        browser.runtime.sendMessage({ action: 'validateProviderKey', provider: p, apiKey: key })
          .then(function (res) {
            btn.disabled = false; btn.textContent = 'Test';
            if (resultEl) {
              resultEl.style.display = '';
              if (res && res.valid) {
                resultEl.className = 'ais-test-result ais-test-ok';
                resultEl.textContent = '✓ Key is valid — click Save to store it';
                // Add Save button dynamically
                var saveBtn = document.createElement('button');
                saveBtn.className = 'ais-btn ais-btn-save'; saveBtn.textContent = 'Save';
                saveBtn.addEventListener('click', function () {
                  var model = (document.getElementById('aisModel_' + p) || {}).value || CLOUD_MODELS[p][0];
                  browser.runtime.sendMessage({ action: 'saveAISettings', provider: p, model: model, apiKey: key })
                    .then(function () {
                      ais.editing[p] = false;
                      chat.aiSettings[p].hasKey = true;
                      chat.aiSettings[p].model  = model;
                      window.renderAISettings();
                    });
                });
                resultEl.appendChild(saveBtn);
              } else {
                resultEl.className = 'ais-test-result ais-test-err';
                resultEl.textContent = '✗ ' + ((res && res.error) || 'Invalid key');
              }
            }
          }).catch(function (e) {
            btn.disabled = false; btn.textContent = 'Test';
            if (resultEl) {
              resultEl.style.display = ''; resultEl.className = 'ais-test-result ais-test-err';
              resultEl.textContent = '✗ ' + String(e);
            }
          });
      });
    });

    shell.querySelectorAll('.ais-btn-use').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.getAttribute('data-provider');
        browser.runtime.sendMessage({ action: 'saveAISettings', provider: p }).then(function () {
          chat.aiProvider = p;
          ssUpdateActiveModel();
          window.renderAISettings();
        });
      });
    });

    shell.querySelectorAll('.ais-model-select').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var p = sel.getAttribute('data-provider');
        if (!p) return; // not a provider model select (e.g. index-mode select)
        var m = sel.value;
        if (p === 'ollama') {
          chat.model = m;
          chat._savedOllamaModel = m;
          ssUpdateActiveModel();
        } else if (chat.aiSettings[p]) {
          chat.aiSettings[p].model = m;
        }
        browser.runtime.sendMessage({ action: 'saveAISettings', provider: p, model: m }).catch(function () {});
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SETTINGS — Indexing (per-folder read mode, selection-driven actions)
  // ══════════════════════════════════════════════════════════════════════════

  var aisSelected   = {};   // folder name → true, current selection
  var aisAllFolders = [];   // all folder names currently in the table

  function aisFmtDate(s) {
    if (!s) return '—';
    var d = new Date((s.indexOf('Z') === -1 ? s.replace(' ', 'T') + 'Z' : s));
    if (isNaN(d.getTime())) return esc(s);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function aisSelCount() { return Object.keys(aisSelected).length; }

  function aisFolderCellSelector(folder) {
    var safe = (window.CSS && CSS.escape) ? CSS.escape(folder) : folder.replace(/"/g, '\\"');
    return '.ais-indexed-cell[data-folder="' + safe + '"]';
  }

  // Static dual-bar cell: vector (amber) + graph (indigo) progress for a folder at rest.
  function aisIndexedCell(folder, folderId, vecCount, graphCount, total) {
    var vecPct   = total > 0 ? Math.min(100, Math.round((vecCount   / total) * 100)) : 0;
    var graphPct = total > 0 ? Math.min(100, Math.round((graphCount / total) * 100)) : 0;
    var vecDone  = total > 0 && vecCount >= total;
    var graphDone = total > 0 && graphCount >= total;
    // Hide the graph bar track entirely when there's no graph data — only show it
    // once graph indexing has actually run for this folder (graphCount > 0).
    var graphStyle = graphCount > 0 ? '' : ' style="display:none"';
    return '<td class="ais-indexed-cell" data-folder="' + esc(folder) + '">' +
      '<div class="ais-bar' + (vecDone ? ' ais-bar-done' : '') + '">' +
        '<div class="ais-bar-fill ais-vec-fill" style="width:' + vecPct + '%"></div>' +
      '</div>' +
      '<div class="ais-bar ais-bar-graph' + (graphDone ? ' ais-bar-done' : '') + '"' + graphStyle + '>' +
        '<div class="ais-bar-fill ais-graph-fill" data-fid="' + esc(String(folderId)) + '" style="width:' + graphPct + '%"></div>' +
      '</div>' +
      '<div class="ais-bar-labels">' +
        '<span class="ais-vec-label' + (vecDone ? ' done' : '') + '">' +
          (vecDone ? '✓ Vector ' + fmtNum(vecCount) : fmtNum(vecCount) + ' / ' + fmtNum(total)) +
        '</span>' +
        '<span class="ais-graph-label' + (graphDone ? ' done' : '') + '"' + (graphCount === 0 ? ' style="display:none"' : '') + '>' +
          (graphDone ? '✓ Graph ' + fmtNum(graphCount) : '⚙ Graph ' + fmtNum(graphCount)) +
        '</span>' +
      '</div>' +
    '</td>';
  }

  // Live update a row's vector bar while it is actively syncing this run.
  function aisUpdateRowProgress(folder, done, total) {
    // Only fold a row into the live "Syncing" state when it has ACTUAL work. A multi-folder
    // job emits a {done:0,total:0} tick for folders with nothing new (already indexed) — those
    // must keep their static indexed bar, not flash "Syncing 0 / 0".
    if (!total || total <= 0) return;
    var cell = document.querySelector(aisFolderCellSelector(folder));
    if (!cell) return;
    var pct   = Math.min(100, Math.round((done / total) * 100));
    // Target only the vector bar (first .ais-bar) — graph bar is .ais-bar-graph
    var bar   = cell.querySelector('.ais-bar:not(.ais-bar-graph)');
    var fill  = cell.querySelector('.ais-vec-fill');
    var label = cell.querySelector('.ais-vec-label');
    if (bar)   { bar.classList.add('ais-bar-active'); bar.classList.remove('ais-bar-done'); }
    if (fill)  fill.style.width = pct + '%';
    if (label) { label.textContent = 'Vector ' + fmtNum(done) + ' / ' + fmtNum(total); label.classList.remove('done'); }
  }

  // Live update graph bars from DB (called on graphIndexProgress — updates all rows at once).
  function aisRefreshGraphBars() {
    browser.runtime.sendMessage({ action: 'getFolderStats' }).catch(function() { return []; })
      .then(function(rows) {
        if (!Array.isArray(rows)) return;
        rows.forEach(function(f) {
          var fill = document.querySelector('.ais-graph-fill[data-fid="' + f.id + '"]');
          if (!fill) return;
          var total = f.mailCount || 0;
          var graphCount = f.graphIndexedCount || 0;
          var pct = total > 0 ? Math.min(100, Math.round((graphCount / total) * 100)) : 0;
          fill.style.width = pct + '%';
          var bar = fill.parentElement;
          if (bar) {
            if (graphCount > 0) bar.style.display = '';
            if (graphCount >= total && total > 0) bar.classList.add('ais-bar-done');
          }
          // Update graph label text
          var cell = fill.closest ? fill.closest('td') : null;
          if (cell && graphCount > 0) {
            var graphLabel = cell.querySelector('.ais-graph-label');
            if (graphLabel) {
              var isDone = total > 0 && graphCount >= total;
              graphLabel.style.display = '';
              graphLabel.textContent = (isDone ? '✓ Graph ' : '⚙ Graph ') + fmtNum(graphCount);
              graphLabel.classList.toggle('done', isDone);
            }
          }
        });
      });
  }

  function aisRenderToolbar() {
    var el = document.getElementById('aisFolderActions');
    if (!el) return;
    var n = aisSelCount();
    // Categorize is a global action (re-groups latest indexed mail) — always available.
    var categorize = '<button class="ais-btn ais-btn-sm" data-act="categorize" ' +
      'title="Re-categorize the latest indexed mail and open the Knowledge Map">Categorize</button>';
    if (n === 0) {
      el.innerHTML = '<span class="ais-sel-count">Select folders for Sync / Rebuild / Delete / Categorize </span>'
    } else {
      el.innerHTML =
        '<span class="ais-sel-count">' + n + ' selected</span>' +
        '<button class="ais-btn ais-btn-sm" data-act="sync-sel" title="Catch up new / unindexed mail">Sync</button>' +
        '<button class="ais-btn ais-btn-sm" data-act="rebuild-sel" title="Rebuild from scratch">Rebuild</button>' +
        '<button class="ais-btn ais-btn-sm ais-btn-danger" data-act="delete-sel" title="Remove these folders entirely">Delete</button>' +
        categorize;
    }
  }

  function aisSelectedFolders() { return Object.keys(aisSelected); }

  function aisLoadIndexingStatus() {
    var card = document.getElementById('aisIndexingStatusCard');
    if (!card) return;
    browser.runtime.sendMessage({ action: 'getIndexingStatus' }).then(function (s) {
      if (!s || !s.paused) { card.innerHTML = ''; return; }
      var folders = s.pausedFolders || [];
      var folderPills = folders.length
        ? '<div class="ais-paused-folders">' + folders.map(function (f) { return '<span class="ais-paused-folder-pill">' + esc(f) + '</span>'; }).join('') + '</div>'
        : '';
      var pendingLabel = folders.length
        ? folders.length + ' folder' + (folders.length !== 1 ? 's' : '') + ' pending'
        : 'Resume to rebuild Smart Search';
      card.innerHTML =
        '<div class="ais-card ais-card-paused">' +
          '<div class="ais-card-header">' +
            '<span class="ais-card-icon">⏸</span>' +
            '<div>' +
              '<div class="ais-card-name">Indexing Paused</div>' +
              '<div class="ais-card-sub">' + esc(pendingLabel) + '</div>' +
            '</div>' +
            '<button class="ais-btn ais-btn-resume" id="aisResumeIndexBtn">Resume</button>' +
          '</div>' +
          (folderPills ? '<div class="ais-card-body">' + folderPills + '</div>' : '') +
        '</div>';
      var btn = document.getElementById('aisResumeIndexBtn');
      if (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          btn.textContent = 'Resuming…';
          browser.runtime.sendMessage({ action: 'resumeIndexing' })
            .then(function () { card.innerHTML = ''; })
            .catch(function () { btn.disabled = false; btn.textContent = 'Resume'; });
        });
      }
    }).catch(function () {});
  }

  function aisLoadEmbeddingStatus() {
    var badge   = document.getElementById('aisEmbedBadge');
    var hint    = document.getElementById('aisEmbedHint');
    var barWrap = document.getElementById('aisEmbedBarWrap');
    var barFill = document.getElementById('aisEmbedBarFill');
    var barLabel= document.getElementById('aisEmbedBarLabel');
    if (!badge || !hint) return;

    browser.runtime.sendMessage({ action: 'checkEmbedding' }).then(function (s) {
      if (!s) return;
      if (s.ready) {
        badge.className  = 'ais-badge ais-badge-ok';
        badge.textContent = 'Ready';
        hint.textContent  = 'Model loaded in memory — semantic search is active.';
        if (barWrap) barWrap.style.display = 'none';
      } else if (s.cached) {
        badge.className  = 'ais-badge ais-badge-ok';
        badge.textContent = 'Cached';
        var mb = s.downloadedMB || 0;
        hint.textContent  = 'Downloaded (' + mb + ' MB on disk). Will load into memory on first search.';
        if (barWrap) barWrap.style.display = 'none';
      } else {
        badge.className  = 'ais-badge';
        badge.textContent = 'Downloading…';
        var total = s.totalMB || 335;
        var dl    = s.downloadedMB || 0;
        hint.textContent  = 'Downloading bge-base-en-v1.5 in the background (~' + total + ' MB). You can use the app while this runs.';
        if (barWrap && barFill && barLabel) {
          barWrap.style.display = '';
          var pct = total > 0 ? Math.min(100, Math.round((dl / total) * 100)) : 0;
          barFill.style.width = pct + '%';
          barLabel.textContent = dl + ' / ' + total + ' MB';
        }
        // Poll every 4s until cached
        setTimeout(aisLoadEmbeddingStatus, 4000);
      }
    }).catch(function () {
      if (hint) hint.textContent = 'Could not check embedding model status.';
    });
  }

  function aisLoadRerankerStatus() {
    var badge   = document.getElementById('aisRerankBadge');
    var hint    = document.getElementById('aisRerankHint');
    var barWrap = document.getElementById('aisRerankBarWrap');
    var barFill = document.getElementById('aisRerankBarFill');
    var barLabel= document.getElementById('aisRerankBarLabel');
    if (!badge || !hint) return;

    browser.runtime.sendMessage({ action: 'checkReranker' }).then(function (s) {
      if (!s) return;
      if (s.ready) {
        badge.className  = 'ais-badge ais-badge-ok';
        badge.textContent = 'Ready';
        hint.textContent  = 'Model loaded in memory — AgentChat search results are relevance-reranked.';
        if (barWrap) barWrap.style.display = 'none';
      } else if (s.cached) {
        badge.className  = 'ais-badge ais-badge-ok';
        badge.textContent = 'Cached';
        var mb = s.downloadedMB || 0;
        hint.textContent  = 'Downloaded (' + mb + ' MB on disk). Will load into memory on first AgentChat search.';
        if (barWrap) barWrap.style.display = 'none';
      } else {
        badge.className  = 'ais-badge';
        badge.textContent = 'Downloading…';
        var total = s.totalMB || 300;
        var dl    = s.downloadedMB || 0;
        hint.textContent  = 'Downloading bge-reranker-base in the background (~' + total + ' MB). Optional — search still works via hybrid ranking until this is ready.';
        if (barWrap && barFill && barLabel) {
          barWrap.style.display = '';
          var pct = total > 0 ? Math.min(100, Math.round((dl / total) * 100)) : 0;
          barFill.style.width = pct + '%';
          barLabel.textContent = dl + ' / ' + total + ' MB';
        }
        // Poll every 4s until cached
        setTimeout(aisLoadRerankerStatus, 4000);
      }
    }).catch(function () {
      if (hint) hint.textContent = 'Could not check reranker model status.';
    });
  }

  function aisLoadFolderTable(providerFilter) {
    var body    = document.getElementById('aisFoldersBody');
    var summary = document.getElementById('aisFoldersSummary');
    if (!body) return;
    aisSelected = {};  // selection resets on a full reload

    // SQLite stats give mailCount + lastScanned + per-folder read_mode; LanceDB breakdown
    // gives the ACTUAL indexed/body counts (reliable across modes — see ID-scheme note).
    Promise.all([
      browser.runtime.sendMessage({ action: 'getFolderStats' }).catch(function () { return []; }),
      browser.runtime.sendMessage({ action: 'getFolderIndexBreakdown' }).catch(function () { return []; }),
    ]).then(function (res) {
      var rows = res[0] || [];
      // Filter by active mail provider when called from the Indexes view
      if (providerFilter) {
        rows = rows.filter(function (f) { return (f.mailProvider || 'apple-mail') === providerFilter; });
      }
      var bd   = res[1] || [];
      var bdMap = {};
      bd.forEach(function (b) { bdMap[b.folder] = b; });
      aisAllFolders = rows.map(function (f) { return String(f.id); });

      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6" class="ais-folders-empty">No folders scanned yet. Run a scan to populate the index.</td></tr>';
        if (summary) summary.textContent = 'No folders indexed';
        aisRenderToolbar();
        return;
      }

      var totalIndexed = 0, totalMails = 0;
      body.innerHTML = rows.map(function (f) {
        var b = bdMap[f.name] || { count: 0, bodyCount: 0 };
        totalIndexed += b.count;
        totalMails   += f.mailCount || 0;

        var mode = f.readMode === 'content' ? 'content' : 'metadata';
        var modeCell = '<select class="ais-fmode-select" data-folder="' + f.id + '" data-folder-name="' + esc(f.name) + '">' +
          '<option value="metadata"' + (mode === 'metadata' ? ' selected' : '') + '>Metadata</option>' +
          '<option value="content"'  + (mode === 'content'  ? ' selected' : '') + '>Full content</option>' +
          '</select>';

        var providerLabel = f.mailProvider === 'thunderbird' ? 'Thunderbird' : 'Apple Mail';
        return '<tr>' +
          '<td class="ais-check-col"><input type="checkbox" class="ais-row-check" data-folder="' + f.id + '" data-folder-name="' + esc(f.name) + '"></td>' +
          '<td><div class="ais-fname">' + esc(displayFolderName(f.name)) + '</div>' +
            (f.mailboxName ? '<div class="ais-fmailbox">' + esc(displayAccountName(f.mailboxName)) + ' · <span class="ais-fprovider">' + providerLabel + '</span></div>' : '') + '</td>' +
          '<td class="ais-num">' + fmtNum(f.mailCount || 0) + '</td>' +
          '<td>' + modeCell + '</td>' +
          aisIndexedCell(f.name, f.id, b.count, f.graphIndexedCount || 0, f.mailCount || 0) +
          '<td class="ais-fdate">' + aisFmtDate(f.lastScanned) + '</td>' +
        '</tr>';
      }).join('');

      if (summary) {
        summary.textContent = rows.length + ' folder' + (rows.length !== 1 ? 's' : '') +
          ' · ' + fmtNum(totalIndexed) + ' / ' + fmtNum(totalMails) + ' indexed';
      }

      // Row checkboxes — use folder ID (globally unique) not name
      body.querySelectorAll('.ais-row-check').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var folderId = cb.getAttribute('data-folder');
          if (cb.checked) aisSelected[folderId] = true; else delete aisSelected[folderId];
          var all = document.getElementById('aisSelectAll');
          if (all) all.checked = aisSelCount() === aisAllFolders.length && aisAllFolders.length > 0;
          aisRenderToolbar();
        });
      });

      // Read-mode dropdowns — change persists + auto-rebuilds that folder in the new mode (use folder ID)
      body.querySelectorAll('.ais-fmode-select').forEach(function (sel) {
        var prev = sel.value;
        sel.addEventListener('change', function () {
          var folderId = sel.getAttribute('data-folder');
          var folderName = sel.getAttribute('data-folder-name');
          var next   = sel.value;
          if (next === 'content') {
            var ok = window.confirm(
              'Read full content for "' + folderName + '"?\n\n' +
              'This rebuilds the folder\'s index from email body text so the AI can answer ' +
              'about amounts and details. It may take a while for large folders.\n\nContinue?'
            );
            if (!ok) { sel.value = prev; return; }
          }
          sel.disabled = true;
          browser.runtime.sendMessage({ action: 'setFolderReadMode', folder: folderId, mode: next })
            .then(function () {
              prev = next; sel.disabled = false;
              // Immediately reset the progress bar so it doesn't misleadingly show "done"
              // while the backend wipes and re-builds the index.
              var cell  = document.querySelector(aisFolderCellSelector(folderName));
              if (cell) {
                var bar   = cell.querySelector('.ais-bar:not(.ais-bar-graph)');
                var fill  = cell.querySelector('.ais-vec-fill');
                var label = cell.querySelector('.ais-vec-label');
                if (bar)   { bar.classList.remove('ais-bar-done'); bar.classList.add('ais-bar-active'); }
                if (fill)  fill.style.width = '0%';
                if (label) { label.textContent = 'Rebuilding…'; label.classList.remove('done'); }
              }
              aisReindexFolders([folderId], /* incremental */ false);
            })
            .catch(function () { sel.value = prev; sel.disabled = false; });
        });
      });

      var selectAll = document.getElementById('aisSelectAll');
      if (selectAll) {
        selectAll.checked = false;
        selectAll.onchange = function () {
          aisSelected = {};
          if (selectAll.checked) aisAllFolders.forEach(function (n) { aisSelected[n] = true; });
          body.querySelectorAll('.ais-row-check').forEach(function (cb) {
            cb.checked = selectAll.checked;
          });
          aisRenderToolbar();
        };
      }

      aisRenderToolbar();
    }).catch(function () {
      body.innerHTML = '<tr><td colspan="6" class="ais-folders-empty">Could not load folder stats.</td></tr>';
    });
  }

  // Toolbar actions are delegated on the (persistent) container.
  function aisWireGlobalActions() {
    var el = document.getElementById('aisFolderActions');
    if (!el) return;
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      switch (btn.getAttribute('data-act')) {
        case 'sync-sel':    aisReindexFolders(aisSelectedFolders(), true);  break;
        case 'rebuild-sel': aisReindexFolders(aisSelectedFolders(), false); break;
        case 'delete-sel':  aisDeleteFolders(aisSelectedFolders());         break;
        case 'categorize':  aisCategorizeNow();                             break;
      }
    });
  }

  // Re-categorize: the Knowledge Map recomputes groups from the latest indexed mail
  // (using your current categories), so just open/refresh it.
  function aisCategorizeNow() {
    var nav = document.querySelector('.tab.nav-item[data-view="knowledgemap"]') ||
              document.querySelector('[data-view="knowledgemap"]');
    if (nav) { nav.click(); return; }
    if (window.renderKnowledgeMap) window.renderKnowledgeMap();
  }

  function aisDeleteFolders(folders) {
    if (!folders.length) return;
    var ok = window.confirm(
      'Delete ' + folders.length + ' folder' + (folders.length !== 1 ? 's' : '') + '?\n\n' +
      'This removes their indexed data, scanned mails and history from InboxPie. ' +
      'Your actual emails in Apple Mail are NOT touched — the folders reappear on the next scan.\n\nContinue?'
    );
    if (!ok) return;
    browser.runtime.sendMessage({ action: 'deleteFolders', folders: folders })
      .then(function () { aisLoadFolderTable(); })
      .catch(function (e) { window.alert('Delete failed: ' + String(e)); });
  }

  // Reindex specific folders; backend resolves each folder's read mode + dedups.
  function aisReindexFolders(folders, incremental) {
    if (!folders.length) return;
    window._ip = window._ip || {};
    window._ip.indexing = true;
    var summary = document.getElementById('aisFoldersSummary');
    if (summary) summary.textContent = (incremental ? 'Syncing new mail…' : 'Rebuilding…') +
      ' (' + folders.length + ' folder' + (folders.length !== 1 ? 's' : '') + ')';
    browser.runtime.sendMessage({
      action: 'reindexFolders', folders: folders, incremental: !!incremental,
    }).catch(function () { if (window._ip) window._ip.indexing = false; });
  }

  // ── Categories (built-in + user-defined, all editable) ─────────────────────
  function aisSaveCategoryKeywords(name, keywords) {
    return browser.runtime.sendMessage({ action: 'saveCategory', name: name, keywords: keywords })
      .then(function () { aisLoadCategories(); });
  }

  function aisLoadCategories() {
    var list = document.getElementById('aisCategoriesList');
    if (!list) return;
    browser.runtime.sendMessage({ action: 'getCategories' }).then(function (cats) {
      cats = cats || [];
      if (!cats.length) {
        list.innerHTML = '<div class="ais-folders-empty">No categories yet. Add one below.</div>';
        return;
      }
      var byName = {};
      cats.forEach(function (c) { byName[c.name] = (c.keywords || []).slice(); });

      list.innerHTML = cats.map(function (c) {
        var chips = (c.keywords || []).map(function (k) {
          return '<span class="ais-cat-chip" data-cat="' + esc(c.name) + '" data-kw="' + esc(k) + '">' +
            esc(k) + '<button class="ais-cat-chip-x" title="Remove keyword">×</button></span>';
        }).join('');
        return '<div class="ais-cat-row">' +
          '<div class="ais-cat-head">' +
            '<span class="ais-cat-name">' + esc(c.icon || '🏷️') + ' ' + esc(c.name) +
              (c.builtin ? ' <span class="ais-cat-tag">built-in</span>' : '') + '</span>' +
            '<button class="ais-cat-del" title="Delete category" data-cat="' + esc(c.name) + '">✕</button>' +
          '</div>' +
          '<div class="ais-cat-kws">' + chips +
            '<input type="text" class="ais-cat-kwadd" data-cat="' + esc(c.name) + '" placeholder="+ keyword">' +
          '</div>' +
        '</div>';
      }).join('');

      // Remove a keyword chip
      list.querySelectorAll('.ais-cat-chip-x').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var chip = btn.closest('.ais-cat-chip');
          var cat = chip.getAttribute('data-cat'), kw = chip.getAttribute('data-kw');
          aisSaveCategoryKeywords(cat, (byName[cat] || []).filter(function (k) { return k !== kw; }));
        });
      });
      // Add keyword(s) to a category (Enter; comma-separated allowed)
      list.querySelectorAll('.ais-cat-kwadd').forEach(function (inp) {
        inp.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          var cat = inp.getAttribute('data-cat'), val = inp.value.trim();
          if (!val) return;
          var adds = val.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          var next = (byName[cat] || []).concat(adds);
          next = next.filter(function (k, i) { return next.indexOf(k) === i; });   // dedupe
          aisSaveCategoryKeywords(cat, next);
        });
      });
      // Delete a whole category (built-in or user)
      list.querySelectorAll('.ais-cat-del').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var name = btn.getAttribute('data-cat');
          if (!window.confirm('Delete category "' + name + '"?')) return;
          browser.runtime.sendMessage({ action: 'deleteCategory', name: name })
            .then(function () { aisLoadCategories(); }).catch(function () {});
        });
      });
    }).catch(function () {
      list.innerHTML = '<div class="ais-folders-empty">Could not load categories.</div>';
    });
  }

  function aisWireCategoryAdd() {
    var btn  = document.getElementById('aisCatAdd');
    var name = document.getElementById('aisCatName');
    var kw   = document.getElementById('aisCatKeywords');
    if (!btn || !name || !kw) return;
    function add() {
      var n = name.value.trim();
      if (!n) { name.focus(); return; }
      var keywords = kw.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      btn.disabled = true;
      browser.runtime.sendMessage({ action: 'saveCategory', name: n, keywords: keywords })
        .then(function () {
          name.value = ''; kw.value = ''; btn.disabled = false;
          aisLoadCategories();
        })
        .catch(function () { btn.disabled = false; });
    }
    btn.addEventListener('click', add);
    kw.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  }

  // ── Indexes view (Mailbox → Indexes) ─────────────────────────────────────

  function aisLoadGraphStatus() {
    var card = document.getElementById('aisGraphStatusCard');
    if (!card) return;
    Promise.all([
      browser.runtime.sendMessage({ action: 'getGraphIndexStatus' }).catch(function() { return null; }),
      browser.runtime.sendMessage({ action: 'getKnowledgeGraph' }).catch(function() { return null; }),
    ]).then(function(res) {
      var gStats = res[0] || { total: 0, todo: 0, inprogress: 0, complete: 0 };
      var kgData = res[1] || { stats: { totalNodes: 0, totalEdges: 0 } };
      var nodes = (kgData.stats && kgData.stats.totalNodes) || 0;
      var edges = (kgData.stats && kgData.stats.totalEdges) || 0;
      var done  = gStats.complete || 0;
      var total = gStats.total   || 0;
      var pct   = total > 0 ? Math.round((done / total) * 100) : 0;

      var statusLabel;
      if (total === 0) {
        statusLabel = 'No emails indexed yet';
      } else if ((gStats.todo || 0) > 0 || (gStats.inprogress || 0) > 0) {
        statusLabel = 'Building… ' + fmtNum(done) + ' / ' + fmtNum(total);
      } else {
        statusLabel = 'Complete';
      }

      card.innerHTML =
        '<div class="ais-folders-toolbar" style="margin-bottom:8px">' +
          '<span class="ais-graph-section-title">KNOWLEDGE GRAPH</span>' +
          '<button class="ais-btn ais-btn-sm" id="aisGraphRebuildBtn">Rebuild</button>' +
        '</div>' +
        (nodes > 0
          ? '<div class="ais-graph-meta" style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">' +
              fmtNum(nodes) + ' entities · ' + fmtNum(edges) + ' relationships</div>'
          : '') +
        (total > 0
          ? '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
              '<div class="ais-indexed-bar" style="flex:1"><div class="ais-indexed-fill" id="aisGraphFill" style="width:' + pct + '%"></div></div>' +
              '<span style="font-size:12px;color:var(--text-secondary);white-space:nowrap">' + fmtNum(done) + ' / ' + fmtNum(total) + '</span>' +
            '</div>'
          : '') +
        '<div style="font-size:12px;color:var(--text-tertiary)">' + esc(statusLabel) + '</div>';

      var rebuildBtn = document.getElementById('aisGraphRebuildBtn');
      if (rebuildBtn) {
        rebuildBtn.addEventListener('click', function() {
          rebuildBtn.disabled = true; rebuildBtn.textContent = 'Rebuilding…';
          browser.runtime.sendMessage({ action: 'rebuildGraphIndex' })
            .catch(function() { rebuildBtn.disabled = false; rebuildBtn.textContent = 'Rebuild'; });
        });
      }
    });
  }

  function aisUpdateGraphProgress(done, total) {
    var fill = document.getElementById('aisGraphFill');
    if (fill && total > 0) fill.style.width = Math.round((done / total) * 100) + '%';
  }

  window.renderIndexes = function () {
    var panel = document.getElementById('indexesView');
    if (!panel) return;

    browser.runtime.sendMessage({ action: 'getPreference', key: 'index_consent_given' })
      .then(function(res) {
        if (res && res.value === 'yes') {
          idxRenderDashboard(panel);
        } else {
          idxRenderConsent(panel);
        }
      }).catch(function() { idxRenderDashboard(panel); });
  };

  function idxRenderConsent(panel) {
    panel.innerHTML =
      '<div class="ais-shell"><div class="idx-consent-wrap">' +
        '<div class="idx-consent-card">' +
          '<div class="idx-consent-shield">' +
            '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
              '<polyline points="9 12 11 14 15 10"/>' +
            '</svg>' +
          '</div>' +
          '<h2 class="idx-consent-title">Before building your Intelligence Index</h2>' +
          '<p class="idx-consent-intro">To power AI search, Knowledge Graph, and smart answers, InboxPie reads your email <strong>metadata</strong> (sender, subject, domain) and <strong>full content</strong> (body text).</p>' +
          '<div class="idx-consent-points">' +
            '<div class="idx-consent-point">' +
              '<span class="idx-consent-dot idx-dot-green"></span>' +
              '<div><strong>Your data never leaves your device.</strong><br>InboxPie does not send your emails to any server. Everything is stored locally in your app data folder.</div>' +
            '</div>' +
            '<div class="idx-consent-point">' +
              '<span class="idx-consent-dot idx-dot-amber"></span>' +
              '<div><strong>Using a public AI model? A small note.</strong><br>If you connect OpenAI, Anthropic, or Google for smart answers, relevant email fragments may be included in your search query to that provider. You can use Ollama for a fully local, zero-sharing experience.</div>' +
            '</div>' +
            '<div class="idx-consent-point">' +
              '<span class="idx-consent-dot idx-dot-indigo"></span>' +
              '<div><strong>You are always in control.</strong><br>Use Virtual Box to choose exactly which emails are indexed. Reset or clear your index at any time from this page.</div>' +
            '</div>' +
          '</div>' +
          '<div class="idx-consent-actions">' +
            '<button id="idxConsentAccept" class="idx-btn-primary idx-consent-cta">I understand — Set Up Intelligence</button>' +
            '<button id="idxConsentCancel" class="idx-btn-ghost">Maybe later</button>' +
          '</div>' +
        '</div>' +
      '</div></div>';

    document.getElementById('idxConsentAccept').addEventListener('click', function() {
      browser.runtime.sendMessage({ action: 'setPreference', key: 'index_consent_given', value: 'yes' })
        .then(function() { idxRenderDashboard(panel); })
        .catch(function() { idxRenderDashboard(panel); });
    });
    document.getElementById('idxConsentCancel').addEventListener('click', function() {
      var btn = document.querySelector('.tab[data-view="sunburst"]') || document.querySelector('.tab[data-view="sender"]');
      if (btn) btn.click();
    });
  }

  function idxRenderDashboard(panel) {
    panel.innerHTML =
      '<div class="ais-shell" id="aisIndexesShell"><div class="ais-page">' +
        '<div class="ais-header">' +
          '<h2 class="ais-title">Intelligence Index</h2>' +
          '<p class="ais-desc">InboxPie reads your email content to power AI search, Knowledge Graph, and smart answers. Use <strong>Virtual Box</strong> to control exactly which emails are indexed.</p>' +
        '</div>' +
        '<div class="idx-stat-cards" id="idxStatCards">' +
          '<div class="idx-card">' +
            '<div class="idx-card-icon idx-icon-scan"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 10h8M8 14h5"/></svg></div>' +
            '<div class="idx-card-value" id="idxScannedCount">—</div>' +
            '<div class="idx-card-label">Emails scanned</div>' +
            '<div class="idx-card-sub" id="idxScannedSub">—</div>' +
          '</div>' +
          '<div class="idx-card">' +
            '<div class="idx-card-icon idx-icon-vec"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg></div>' +
            '<div class="idx-card-value" id="idxVecCount">—</div>' +
            '<div class="idx-card-label">Vector indexed</div>' +
            '<div class="idx-card-bar"><div class="idx-card-fill" id="idxVecFill" style="width:0%"></div></div>' +
          '</div>' +
          '<div class="idx-card">' +
            '<div class="idx-card-icon idx-icon-graph"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M7.5 12h4M16.6 6.8l-3.1 3.7M16.6 17.2l-3.1-3.7"/></svg></div>' +
            '<div class="idx-card-value" id="idxGraphNodes">—</div>' +
            '<div class="idx-card-label">Graph nodes</div>' +
            '<div class="idx-card-sub" id="idxGraphEdges">—</div>' +
          '</div>' +
          '<div class="idx-card idx-card-vbox">' +
            '<div class="idx-card-icon idx-icon-vbox"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg></div>' +
            '<div class="idx-card-value" id="idxVBoxCount">—</div>' +
            '<div class="idx-card-label">In Virtual Box</div>' +
            '<div class="idx-card-sub" id="idxVBoxSub">emails selected for indexing</div>' +
          '</div>' +
        '</div>' +
        '<div class="idx-actions">' +
          '<button class="idx-btn-primary" id="idxBuildBtn">Build Index</button>' +
          '<button class="idx-btn-secondary" id="idxSyncBtn">Sync New</button>' +
          '<span class="idx-actions-sep"></span>' +
          '<button class="idx-btn-ghost idx-btn-danger" id="idxResetBtn">Reset Index</button>' +
        '</div>' +
        '<div class="idx-progress-section" id="idxProgressSection" style="display:none">' +
          '<div class="idx-progress-header">' +
            '<span class="idx-progress-label" id="idxProgressLabel">Preparing…</span>' +
            '<span class="idx-progress-pct" id="idxProgressPct"></span>' +
          '</div>' +
          '<div class="idx-progress-track"><div class="idx-progress-fill" id="idxProgressFill" style="width:0%"></div></div>' +
          '<div class="idx-progress-sub" id="idxProgressSub"></div>' +
        '</div>' +
        '<div class="idx-sources-section">' +
          '<div class="idx-history-header"><span class="idx-history-title">Scanned sources</span></div>' +
          '<div id="idxSourcesList"></div>' +
        '</div>' +
        '<div class="idx-history-section" id="idxHistorySection"></div>' +
      '</div></div>';

    idxLoadStats();
    idxWireActions();
  }

  function idxLoadStats() {
    Promise.all([
      browser.runtime.sendMessage({ action: 'getFolderStats' }).catch(function() { return []; }),
      browser.runtime.sendMessage({ action: 'getVectorIndexStats' }).catch(function() { return {}; }),
      browser.runtime.sendMessage({ action: 'getGraphIndexStatus' }).catch(function() { return {}; }),
      browser.runtime.sendMessage({ action: 'getVirtualBoxStats' }).catch(function() { return {}; }),
      browser.runtime.sendMessage({ action: 'getIndexRunHistory' }).catch(function() { return []; }),
    ]).then(function(res) {
      var folders   = res[0] || [];
      var vecStats  = res[1] || {};
      var graphStat = res[2] || {};
      var vbox      = res[3] || {};
      var history   = res[4] || [];

      var totalMails = folders.reduce(function(s, f) { return s + (f.mailCount || 0); }, 0);
      var vecCount   = vecStats.total || 0;
      var vboxTotal  = vbox.total || 0;
      // Progress is relative to Virtual Box, not full inbox
      var vecPct     = vboxTotal > 0 ? Math.min(100, Math.round(vecCount / vboxTotal * 100)) : 0;

      idxSet('idxScannedCount', fmtNum(totalMails));
      idxSet('idxScannedSub', folders.length + ' folder' + (folders.length !== 1 ? 's' : ''));
      idxSet('idxVecCount', fmtNum(vecCount) + ' / ' + fmtNum(vboxTotal));
      var fill = document.getElementById('idxVecFill');
      if (fill) fill.style.width = vecPct + '%';
      idxSet('idxGraphNodes', fmtNum(graphStat.totalNodes || 0));
      idxSet('idxGraphEdges', fmtNum(graphStat.totalEdges || 0) + ' edges');
      idxSet('idxVBoxCount', fmtNum(vboxTotal));
      idxSet('idxVBoxSub', (vboxTotal === 1 ? 'email' : 'emails') + ' selected for indexing');

      var list = document.getElementById('idxSourcesList');
      if (list) {
        if (!folders.length) {
          list.innerHTML = '<div class="idx-history-empty">No folders scanned yet.</div>';
        } else {
          var srcRows = folders.map(function(f) {
            var provider = f.mailProvider === 'thunderbird' ? 'Thunderbird' : 'Apple Mail';
            return '<tr>' +
              '<td><span class="idx-source-name-cell">' + esc(displayFolderName(f.name)) + '</span></td>' +
              '<td>' + esc(displayAccountName(f.mailboxName || '')) + '</td>' +
              '<td>' + esc(provider) + '</td>' +
              '<td style="font-variant-numeric:tabular-nums">' + fmtNum(f.mailCount || 0) + '</td>' +
              '<td>' + esc(aisFmtDate(f.lastScanned)) + '</td>' +
              '<td style="text-align:center">' +
                '<button class="idx-source-del" data-fid="' + esc(String(f.id)) + '" title="Remove from InboxPie">' +
                  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
                '</button>' +
              '</td>' +
            '</tr>';
          }).join('');
          list.innerHTML =
            '<div class="idx-history-table-wrap">' +
              '<table class="idx-history-table">' +
                '<thead><tr>' +
                  '<th>Folder</th><th>Account</th><th>Provider</th><th>Emails</th><th>Last scan</th><th></th>' +
                '</tr></thead>' +
                '<tbody>' + srcRows + '</tbody>' +
              '</table>' +
            '</div>';
          list.querySelectorAll('.idx-source-del').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var fid = btn.getAttribute('data-fid');
              if (!window.confirm('Remove this folder from InboxPie? Your actual emails are not touched.')) return;
              browser.runtime.sendMessage({ action: 'deleteFolders', folders: [fid] })
                .then(function() { idxLoadStats(); });
            });
          });
        }
      }

      idxRenderHistory(history);
    });
  }

  function idxRenderHistory(runs) {
    var section = document.getElementById('idxHistorySection');
    if (!section) return;
    if (!runs || !runs.length) {
      section.innerHTML =
        '<div class="idx-history-header"><span class="idx-history-title">Index run history</span></div>' +
        '<div class="idx-history-empty">No index runs yet. Click <strong>Build Index</strong> to start.</div>';
      return;
    }
    var rows = runs.map(function(r) {
      var statusClass = r.status === 'success' ? 'idx-run-ok' : r.status === 'failed' ? 'idx-run-fail' : 'idx-run-inprog';
      var statusLabel = r.status === 'success' ? 'Success' : r.status === 'failed' ? 'Failed' : 'In progress';
      var startedFmt  = r.started_at ? aisFmtDate(r.started_at) : '—';
      var duration    = '';
      if (r.started_at && r.completed_at) {
        var ms = new Date(r.completed_at).getTime() - new Date(r.started_at).getTime();
        if (!isNaN(ms) && ms >= 0) {
          duration = ms < 60000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
        }
      }
      var folders = '';
      try { var fs = JSON.parse(r.folders || '[]'); folders = fs.length ? fs.slice(0, 2).join(', ') + (fs.length > 2 ? ' +' + (fs.length - 2) : '') : '—'; }
      catch(e) { folders = '—'; }
      return '<tr>' +
        '<td><span class="idx-run-badge ' + statusClass + '">' + statusLabel + '</span></td>' +
        '<td>' + esc(startedFmt) + '</td>' +
        '<td>' + esc(duration || '—') + '</td>' +
        '<td>' + fmtNum(r.indexed_count || 0) + '</td>' +
        '<td>' + (r.failed_count > 0 ? '<span class="idx-run-errors">' + r.failed_count + '</span>' : '0') + '</td>' +
        '<td class="idx-run-folders" title="' + esc(r.folders || '') + '">' + esc(folders) + '</td>' +
        (r.error ? '<td class="idx-run-error-msg" title="' + esc(r.error) + '">' + esc(r.error.slice(0, 40)) + (r.error.length > 40 ? '…' : '') + '</td>' : '<td></td>') +
      '</tr>';
    }).join('');
    section.innerHTML =
      '<div class="idx-history-header">' +
        '<span class="idx-history-title">Index run history</span>' +
      '</div>' +
      '<div class="idx-history-table-wrap">' +
        '<table class="idx-history-table">' +
          '<thead><tr>' +
            '<th>Status</th><th>Started</th><th>Duration</th><th>Indexed</th><th>Errors</th><th>Folders</th><th>Error</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>';
  }

  function idxSet(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function idxWireActions() {
    var buildBtn = document.getElementById('idxBuildBtn');
    if (buildBtn) {
      buildBtn.addEventListener('click', function() {
        browser.runtime.sendMessage({ action: 'getVirtualBoxStats' }).then(function(stats) {
          if (!stats || !stats.total) {
            window.alert('Virtual Box is empty. Add emails via Subscriptions or the selection review before building an index.');
            return;
          }
          idxShowProgress('Building index from Virtual Box (' + stats.total + ' emails)…', 0);
          browser.runtime.sendMessage({ action: 'buildVirtualBoxIndex', incremental: false });
        });
      });
    }

    var syncBtn = document.getElementById('idxSyncBtn');
    if (syncBtn) {
      syncBtn.addEventListener('click', function() {
        browser.runtime.sendMessage({ action: 'getVirtualBoxStats' }).then(function(stats) {
          if (!stats || !stats.total) {
            window.alert('Virtual Box is empty. Add emails via Subscriptions or the selection review before syncing.');
            return;
          }
          idxShowProgress('Syncing new Virtual Box emails…', 0);
          browser.runtime.sendMessage({ action: 'buildVirtualBoxIndex', incremental: true });
        });
      });
    }

    var resetBtn = document.getElementById('idxResetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function() {
        if (!window.confirm('Reset vector index? All indexed embeddings will be deleted. Your scanned email list is kept — you can rebuild without rescanning.')) return;
        browser.runtime.sendMessage({ action: 'resetVectorIndex' })
          .then(function() { idxLoadStats(); });
      });
    }
  }

  function idxShowProgress(label, pct) {
    var sec = document.getElementById('idxProgressSection');
    if (sec) sec.style.display = '';
    idxSet('idxProgressLabel', label);
    idxSet('idxProgressPct', pct != null ? pct + '%' : '');
    var fill = document.getElementById('idxProgressFill');
    if (fill) fill.style.width = (pct || 0) + '%';
  }

  // ── Groups view (Mailbox → Groups) ───────────────────────────────────────

  window.renderGroups = function () {
    var panel = document.getElementById('groupsView');
    if (!panel) return;

    panel.innerHTML =
      '<div class="ais-shell" id="aisGroupsShell">' +
        '<div class="ais-page">' +
          '<div class="ais-header">' +
            '<h2 class="ais-title">Groups</h2>' +
            '<p class="ais-desc">Define your own categories and keywords (e.g. <strong>Investments</strong> → portfolio, mutual fund, NAV, SIP). They merge with the built-in groups in the Knowledge Map so it reflects your taxonomy.</p>' +
          '</div>' +
          '<div class="ais-card">' +
            '<div class="ais-card-body">' +
              '<div id="aisCategoriesList" class="ais-cat-list"><div class="ais-folders-empty">Loading…</div></div>' +
              '<div class="ais-cat-add">' +
                '<input type="text" id="aisCatName" class="ais-cat-input" placeholder="Category name (e.g. Investments)">' +
                '<input type="text" id="aisCatKeywords" class="ais-cat-input ais-cat-kw" placeholder="keywords, comma separated">' +
                '<button class="ais-btn ais-btn-sm" id="aisCatAdd">Add</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    aisLoadCategories();
    aisWireCategoryAdd();
  };

  // Live progress — updates the Indexes dashboard while it is visible.
  function aisIndexesVisible() {
    var v = document.getElementById('indexesView');
    return v && v.style.display !== 'none';
  }
  browser.runtime.onMessage.addListener(function (ev) {
    if (!aisIndexesVisible()) return;
    if (ev.action === 'vectorIndexStarted') {
      idxShowProgress('Building index…', 0);
    } else if (ev.action === 'vectorIndexProgress') {
      var done  = ev.done  || 0;
      var total = ev.total || 0;
      var pct   = total > 0 ? Math.round(done / total * 100) : 0;
      idxShowProgress('Indexing ' + fmtNum(done) + ' / ' + fmtNum(total), pct);
      idxSet('idxProgressSub', ev.folder ? 'Processing: ' + esc(String(ev.folder)) : '');
    } else if (ev.action === 'vectorIndexComplete') {
      idxShowProgress('Index complete', 100);
      idxSet('idxProgressSub', '');
      idxLoadStats();
      setTimeout(function() {
        var sec = document.getElementById('idxProgressSection');
        if (sec) sec.style.display = 'none';
      }, 3000);
    } else if (ev.action === 'vectorIndexError') {
      idxShowProgress('Error: ' + esc(String(ev.error || 'unknown')), 0);
      idxSet('idxProgressSub', '');
    } else if (ev.action === 'graphIndexProgress' || ev.action === 'graphIndexComplete' || ev.action === 'graphIndexError') {
      idxLoadStats();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  BY CATEGORY view
  // ══════════════════════════════════════════════════════════════════════════

  // Cache only the category keyword definitions (rarely change).
  // Never cache counts — always re-classify from the current folder filter.
  var _catDefs = null;

  function anGetFilteredMsgs() {
    if (window._ip && window._ip.getFilteredMessages) return window._ip.getFilteredMessages();
    if (window._ip && window._ip.messages) return window._ip.messages;
    return [];
  }

  function anBuildCatDefs(rawCats) {
    // Mirror buildClusters() ordering: user categories first, then builtins, then Other
    var user    = rawCats.filter(function(c) { return !c.builtin && c.keywords && c.keywords.length; });
    var builtin = rawCats.filter(function(c) { return  c.builtin && c.keywords && c.keywords.length; });
    return user.concat(builtin)
      .map(function(c) { return { label: c.name, icon: c.icon || '📨', keywords: c.keywords }; })
      .concat([{ label: 'Other', icon: '📨', keywords: [] }]);
  }

  function anClassifyMsg(msg, cats) {
    var text = ((msg.subject || '') + ' ' + (msg.domain || '') + ' ' + (msg.senderEmail || '')).toLowerCase();
    for (var i = 0; i < cats.length - 1; i++) {
      var kws = cats[i].keywords || [];
      for (var j = 0; j < kws.length; j++) {
        if (text.indexOf(kws[j].toLowerCase()) !== -1) return i;
      }
    }
    return cats.length - 1; // Other
  }

  function anClassifyAndRender(cats) {
    var msgs       = anGetFilteredMsgs();
    var counts     = new Array(cats.length).fill(0);
    var topSubjects = cats.map(function() { return []; });
    msgs.forEach(function(m) {
      var idx = anClassifyMsg(m, cats);
      counts[idx]++;
      if (topSubjects[idx].length < 3 && m.subject && m.subject.trim()) {
        topSubjects[idx].push(m.subject.trim());
      }
    });
    var result = cats
      .map(function(c, i) { return { label: c.label, icon: c.icon, count: counts[i], topSubjects: topSubjects[i] }; })
      .filter(function(c) { return c.count > 0; })
      .sort(function(a, b) { return b.count - a.count; });
    anRenderCatUI(result);
  }

  window.renderCategories = function () {
    var panel = document.getElementById('categoriesView');
    if (!panel) return;
    var grid    = document.getElementById('categoriesGrid');
    var drillEl = document.getElementById('categoriesDrill');

    if (drillEl) drillEl.style.display = 'none';
    if (grid)    grid.style.display    = '';

    var msgs = anGetFilteredMsgs();
    if (!msgs.length) {
      if (grid) grid.innerHTML = '<div class="an-empty">No emails loaded. Scan your mailbox first.</div>';
      return;
    }

    // Category definitions cached; counts always recomputed from current folder filter
    if (_catDefs) { anClassifyAndRender(_catDefs); return; }

    if (grid) grid.innerHTML = '<div class="an-loading">Loading categories…</div>';
    browser.runtime.sendMessage({ action: 'getCategories' }).then(function(rawCats) {
      _catDefs = anBuildCatDefs(rawCats || []);
      anClassifyAndRender(_catDefs);
    }).catch(function() {
      if (grid) grid.innerHTML = '<div class="an-empty">Could not load categories.</div>';
    });
  };

  function anRenderCatUI(cats) {
    var grid     = document.getElementById('categoriesGrid');
    var chartEl  = document.getElementById('categoriesChart');
    var topList  = document.getElementById('categoriesTopList');
    var subtitle = document.getElementById('categoriesSubtitle');

    if (!cats.length) {
      if (grid) grid.innerHTML = '<div class="an-empty">No indexed emails yet. Index your folders in the Intelligence tab first.</div>';
      return;
    }

    var total = cats.reduce(function(s, c) { return s + c.count; }, 0);
    if (subtitle) subtitle.textContent = total.toLocaleString() + ' emails across ' + cats.length + ' categories';

    // ECharts donut
    if (chartEl && window.echarts) {
      if (!chartEl._echartsInstance) {
        chartEl._echartsInstance = window.echarts.init(chartEl, 'dark');
        new ResizeObserver(function() { chartEl._echartsInstance.resize(); }).observe(chartEl);
      }
      var pieData = cats.slice(0, 10).map(function(c) {
        return { name: c.icon + ' ' + c.label, value: c.count };
      });
      chartEl._echartsInstance.setOption({
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: { show: false },
        series: [{
          type: 'pie', radius: ['42%', '70%'], center: ['50%', '50%'],
          data: pieData,
          label: { formatter: '{b}\n{d}%', fontSize: 11 },
          emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.4)' } },
        }]
      });
    }

    // Top-list sidebar
    if (topList) {
      topList.innerHTML = cats.slice(0, 8).map(function(c) {
        var pct = total > 0 ? Math.round(c.count / total * 100) : 0;
        return '<div class="an-top-row">' +
          '<span class="an-top-icon">' + (c.icon || '📨') + '</span>' +
          '<span class="an-top-label">' + c.label + '</span>' +
          '<span class="an-top-count">' + c.count.toLocaleString() + '</span>' +
          '<div class="an-top-bar"><div class="an-top-bar-fill" style="width:' + pct + '%"></div></div>' +
        '</div>';
      }).join('');
    }

    // Category cards grid
    if (grid) {
      grid.innerHTML = cats.map(function(c) {
        return '<div class="an-cat-card" data-label="' + c.label + '">' +
          '<div class="an-cat-icon">' + (c.icon || '📨') + '</div>' +
          '<div class="an-cat-name">' + c.label + '</div>' +
          '<div class="an-cat-count">' + c.count.toLocaleString() + ' emails</div>' +
          (c.topSubjects && c.topSubjects.length ? '<div class="an-cat-subjects">' + c.topSubjects.slice(0, 2).map(function(s){ return '<span class="an-cat-subject">' + s.slice(0,40) + '</span>'; }).join('') + '</div>' : '') +
        '</div>';
      }).join('');

      grid.querySelectorAll('.an-cat-card').forEach(function(card) {
        card.addEventListener('click', function() {
          var label = card.getAttribute('data-label');
          anDrillCategory(label);
        });
      });
    }
  }

  function anDrillCategory(label) {
    var cats = _catDefs;
    if (!cats) return;
    var idx = -1;
    for (var i = 0; i < cats.length; i++) { if (cats[i].label === label) { idx = i; break; } }
    if (idx === -1) return;
    var msgs = anGetFilteredMsgs();
    var rows = msgs
      .filter(function(m) { return anClassifyMsg(m, cats) === idx; })
      .map(function(m) { return { subject: m.subject, sender_email: m.senderEmail }; });
    if (rows.length && window._ip && window._ip.openCategoryReview) {
      window._ip.openCategoryReview(rows);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUBSCRIPTIONS view
  // ══════════════════════════════════════════════════════════════════════════

  var _subFreqFilter = 'All';
  var _inclDomains = new Set(); // domains currently in Virtual Box

  function anLoadInclusionRules() {
    browser.runtime.sendMessage({ action: 'getInclusionRules' }).then(function(rules) {
      _inclDomains = new Set((rules && rules.domains) ? rules.domains.map(function(d) { return d.toLowerCase(); }) : []);
    }).catch(function() {});
  }

  function anComputeSubStats(msgs) {
    var byDomain = {};
    msgs.forEach(function(m) {
      if (!m.domain || !m.date) return;
      var ts = Math.floor(new Date(m.date).getTime() / 1000);
      if (!ts || isNaN(ts)) return;
      if (!byDomain[m.domain]) byDomain[m.domain] = { dates: [], subjects: [], senders: {}, size: 0 };
      var g = byDomain[m.domain];
      g.dates.push(ts);
      if (m.subject) g.subjects.push(m.subject.toLowerCase());
      if (m.senderEmail) g.senders[m.senderEmail] = true;
      g.size += m.size || 0;
    });

    var results = [];
    Object.keys(byDomain).forEach(function(domain) {
      var g = byDomain[domain];
      if (g.dates.length < 3) return;
      g.dates.sort(function(a, b) { return a - b; });

      var totalGap = 0;
      for (var i = 1; i < g.dates.length; i++) totalGap += (g.dates[i] - g.dates[i - 1]) / 86400;
      var avgDays = totalGap / (g.dates.length - 1);

      var frequency;
      if      (avgDays <= 1.5)  frequency = 'Daily';
      else if (avgDays <= 4)    frequency = 'Every few days';
      else if (avgDays <= 10)   frequency = 'Weekly';
      else if (avgDays <= 25)   frequency = 'Bi-weekly';
      else if (avgDays <= 55)   frequency = 'Monthly';
      else if (avgDays <= 100)  frequency = 'Quarterly';
      else                      frequency = 'Occasional';

      if (frequency === 'Occasional') return;

      var hasUnsubscribe = g.subjects.some(function(s) { return s.indexOf('unsubscribe') !== -1; });

      results.push({
        domain:            domain,
        email_count:       g.dates.length,
        sender_count:      Object.keys(g.senders).length,
        avg_interval_days: Math.round(avgDays * 10) / 10,
        frequency:         frequency,
        is_newsletter:     hasUnsubscribe,
        last_date_unix:    g.dates[g.dates.length - 1],
        size_bytes:        g.size,
      });
    });

    return results.sort(function(a, b) { return b.email_count - a.email_count; });
  }

  function anShowSubDetectionInfo() {
    var existing = document.getElementById('anDetectModal');
    if (existing) { existing.remove(); return; }

    var overlay = document.createElement('div');
    overlay.id = 'anDetectModal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = [
      '<div class="modal-box an-detect-modal">',
        '<div class="an-detect-modal-head">',
          '<h3>How subscriptions are detected</h3>',
          '<button class="ic-close-btn" id="anDetectModalClose">',
            '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l12 12M13 1L1 13"/></svg>',
          '</button>',
        '</div>',
        '<p class="an-detect-intro">InboxPie uses two signals to identify recurring senders and newsletters. No email body is ever read.</p>',
        '<div class="an-detect-methods">',

          '<div class="an-detect-method">',
            '<div class="an-detect-method-icon an-detect-icon-1">',
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">',
                '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
                '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
              '</svg>',
            '</div>',
            '<div class="an-detect-method-body">',
              '<div class="an-detect-method-title">Recurrence by Domain</div>',
              '<div class="an-detect-method-desc">Emails are grouped by sender domain. Any domain that sends at least 3 emails with a regular cadence — Daily, Weekly, Monthly, etc. — is listed as a recurring sender. The average gap between emails determines the frequency label.</div>',
              '<div class="an-detect-method-tag">Applied to: all senders</div>',
            '</div>',
          '</div>',

          '<div class="an-detect-method">',
            '<div class="an-detect-method-icon an-detect-icon-2">',
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">',
                '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>',
                '<polyline points="22,6 12,13 2,6"/>',
              '</svg>',
            '</div>',
            '<div class="an-detect-method-body">',
              '<div class="an-detect-method-title">Subject Keyword Check</div>',
              '<div class="an-detect-method-desc">If any email from a sender contains the word <em>unsubscribe</em> in its subject line, it is flagged as a Newsletter. This is a reliable signal because email marketing platforms routinely include unsubscribe prompts in their subject lines.</div>',
              '<div class="an-detect-method-tag">Applied to: Newsletter badge</div>',
            '</div>',
          '</div>',

        '</div>',
        '<div class="an-detect-footer">',
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>',
          'Only metadata is used — sender address, subject line, date, and size. Email bodies are never read.',
        '</div>',
      '</div>',
    ].join('');

    document.body.appendChild(overlay);

    document.getElementById('anDetectModalClose').addEventListener('click', function() { overlay.remove(); });
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  }

  window.renderSubscriptions = function () {
    var panel = document.getElementById('subscriptionsView');
    if (!panel) return;

    anLoadInclusionRules();

    var msgs = anGetFilteredMsgs();
    var grid = document.getElementById('subscriptionsGrid');

    if (!msgs.length) {
      if (grid) grid.innerHTML = '<div class="an-empty">No emails loaded. Scan your mailbox first.</div>';
      return;
    }

    // Always recompute from current filtered messages — respects folder selection
    var data = anComputeSubStats(msgs);
    anRenderSubUI(data, _subFreqFilter);

    // Wire frequency tabs once per panel lifetime
    var tabs = document.getElementById('subscriptionsTabs');
    if (tabs && !tabs._subWired) {
      tabs._subWired = true;
      tabs.querySelectorAll('.an-tab').forEach(function(btn) {
        btn.addEventListener('click', function() {
          tabs.querySelectorAll('.an-tab').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          _subFreqFilter = btn.getAttribute('data-freq');
          anRenderSubUI(anComputeSubStats(anGetFilteredMsgs()), _subFreqFilter);
        });
      });
    }
  };

  function anRenderSubUI(data, freqFilter) {
    var chartEl = document.getElementById('subscriptionsChart');
    var statsEl = document.getElementById('subscriptionsStats');
    var grid    = document.getElementById('subscriptionsGrid');
    var subtitle= document.getElementById('subscriptionsSubtitle');

    // Filter
    var filtered = freqFilter === 'All'
      ? data
      : freqFilter === 'Newsletter'
        ? data.filter(function(s) { return s.is_newsletter; })
        : data.filter(function(s) { return s.frequency === freqFilter; });

    if (subtitle) {
      var newsletters = data.filter(function(s) { return s.is_newsletter; }).length;
      subtitle.innerHTML =
        data.length + ' recurring senders detected &nbsp;·&nbsp; ' + newsletters + ' newsletters' +
        ' &nbsp;<a class="an-detect-link" id="anDetectInfoLink" href="javascript:void(0)">How is this detected? &#9432;</a>';
      var infoLink = document.getElementById('anDetectInfoLink');
      if (infoLink) infoLink.addEventListener('click', anShowSubDetectionInfo);
    }

    // Frequency distribution bar chart
    var freqOrder = ['Daily', 'Every few days', 'Weekly', 'Bi-weekly', 'Monthly', 'Quarterly'];
    var freqCounts = {};
    freqOrder.forEach(function(f) { freqCounts[f] = 0; });
    data.forEach(function(s) { if (freqCounts[s.frequency] !== undefined) freqCounts[s.frequency]++; });

    if (chartEl && window.echarts) {
      if (!chartEl._echartsInstance) {
        chartEl._echartsInstance = window.echarts.init(chartEl, 'dark');
        new ResizeObserver(function() { chartEl._echartsInstance.resize(); }).observe(chartEl);
      }
      chartEl._echartsInstance.setOption({
        tooltip: { trigger: 'axis' },
        grid: { left: 16, right: 16, top: 12, bottom: 40, containLabel: true },
        xAxis: { type: 'category', data: freqOrder, axisLabel: { fontSize: 11 } },
        yAxis: { type: 'value', minInterval: 1 },
        series: [{
          type: 'bar', data: freqOrder.map(function(f) { return freqCounts[f]; }),
          itemStyle: { borderRadius: [4, 4, 0, 0], color: '#7c6af7' },
          label: { show: true, position: 'top', fontSize: 11 }
        }]
      });
    }

    // Stats sidebar
    if (statsEl) {
      var totalEmails = data.reduce(function(s, r) { return s + r.email_count; }, 0);
      statsEl.innerHTML =
        '<div class="an-stat-row"><span class="an-stat-val">' + data.length + '</span><span class="an-stat-lbl">Total senders</span></div>' +
        '<div class="an-stat-row"><span class="an-stat-val">' + data.filter(function(s) { return s.is_newsletter; }).length + '</span><span class="an-stat-lbl">Newsletters</span></div>' +
        '<div class="an-stat-row"><span class="an-stat-val">' + totalEmails.toLocaleString() + '</span><span class="an-stat-lbl">Total emails</span></div>' +
        '<div class="an-stat-row"><span class="an-stat-val">' + (freqCounts['Daily'] + freqCounts['Every few days']) + '</span><span class="an-stat-lbl">High frequency</span></div>';
    }

    // Cards grid
    if (grid) {
      if (!filtered.length) {
        grid.innerHTML = '<div class="an-empty">No senders in this frequency category.</div>';
        return;
      }
      grid.innerHTML = filtered.slice(0, 60).map(function(s) {
        var lastDate  = s.last_date_unix ? new Date(s.last_date_unix * 1000).toLocaleDateString() : '—';
        var initial   = privacyOn() ? '?' : (s.domain || '?')[0].toUpperCase();
        var nlBadge   = s.is_newsletter ? '<span class="an-sub-badge an-sub-badge-nl">Newsletter</span>' : '';
        var freqBadge = '<span class="an-sub-badge an-sub-badge-freq">' + s.frequency + '</span>';
        var included  = _inclDomains.has((s.domain || '').toLowerCase());
        var inclBtn   = '<button class="an-sub-incl-btn' + (included ? ' active' : '') +
                        '" data-domain="' + esc(s.domain || '') + '">' +
                        (included ? '&#10003; In Virtual Box' : '+ Virtual Box') + '</button>';
        return '<div class="an-sub-card">' +
          '<div class="an-sub-avatar">' + initial + '</div>' +
          '<div class="an-sub-body">' +
            '<div class="an-sub-domain">' + esc(displayDomain(s.domain)) + '</div>' +
            '<div class="an-sub-badges">' + freqBadge + nlBadge + '</div>' +
            '<div class="an-sub-meta">Every ~' + s.avg_interval_days + ' days &nbsp;·&nbsp; ' + s.email_count + ' emails &nbsp;·&nbsp; Last: ' + lastDate + '</div>' +
            '<div class="an-sub-card-footer">' + inclBtn + '</div>' +
          '</div>' +
        '</div>';
      }).join('');

      // Wire Virtual Box toggle clicks
      grid.querySelectorAll('.an-sub-incl-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var domain   = btn.getAttribute('data-domain');
          var isActive = btn.classList.contains('active');
          var action   = isActive ? 'removeInclusionDomain' : 'addInclusionDomain';
          browser.runtime.sendMessage({ action: action, domain: domain }).then(function(res) {
            if (isActive) { _inclDomains.delete(domain.toLowerCase()); }
            else          { _inclDomains.add(domain.toLowerCase()); }
            btn.classList.toggle('active', !isActive);
            btn.innerHTML = !isActive ? '&#10003; In Virtual Box' : '+ Virtual Box';
            if (res && res.stats && window.updateVirtualBoxNavCount) {
              window.updateVirtualBoxNavCount(res.stats.total);
            }
          }).catch(function() {});
        });
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  VIRTUAL BOX
  // ══════════════════════════════════════════════════════════════════════════

  window.renderVirtualBox = function() {
    var panel = document.getElementById('virtualboxView');
    if (!panel) return;

    panel.innerHTML = '<div class="vb-shell"><div class="vb-header"><h2>Virtual Box</h2><p id="vbSubtitle" class="vb-subtitle">Loading&hellip;</p><div class="vb-header-actions"><button id="vbClearAll" class="btn-ghost-sm">Clear All</button></div></div><div class="vb-loading" id="vbLoading">Loading&hellip;</div></div>';

    browser.runtime.sendMessage({ action: 'getVirtualBoxMails' }).then(function(mails) {
      var stats = { total: mails.length, vectorDone: 0, graphDone: 0 };
      mails.forEach(function(m) {
        if (m.indexed_meta === 'yes') stats.vectorDone++;
        if (m.graph_indexed === 'complete') stats.graphDone++;
      });

      if (window.updateVirtualBoxNavCount) window.updateVirtualBoxNavCount(stats.total);

      var shell = panel.querySelector('.vb-shell');
      shell.innerHTML = vbBuildShell(mails, stats);

      vbWireEvents(panel, mails);
    }).catch(function(e) {
      panel.innerHTML = '<div class="vb-shell"><p class="vb-error">Failed to load Virtual Box: ' + esc(String(e)) + '</p></div>';
    });
  };

  var VB_ICON_SMART  = '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2c.32 0 .6.21.7.52L12 7l4.48 1.3c.6.18.6 1.03 0 1.2L12 11l-1.3 4.48c-.18.6-1.03.6-1.2 0L8 11l-4.48-1.3c-.6-.18-.6-1.03 0-1.2L8 7l1.3-4.48c.1-.31.38-.52.7-.52z"/></svg>';
  var VB_ICON_SIMPLE = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M17 17l-4-4"/></svg>';

  // 10 fixed, muted hues (Outlook-contact-style) — subtle enough for dark theme, evenly
  // spread so adjacent senders rarely collide. Assignment is a stable hash, not random,
  // so the same sender always gets the same color across renders/sessions.
  var VB_AVATAR_COLORS = [
    '#7c6af7', '#5b8def', '#3fb6c4', '#2fae8a', '#6cb44e',
    '#d3a13c', '#e08a4e', '#e0687a', '#cd6bc9', '#6e7fe0',
  ];
  function vbAvatarColor(key) {
    var str = String(key || '');
    var hash = 0;
    for (var i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    return VB_AVATAR_COLORS[Math.abs(hash) % VB_AVATAR_COLORS.length];
  }

  function vbBuildShell(mails, stats) {
    var subtitleText = stats.total + ' email' + (stats.total !== 1 ? 's' : '') +
      ' &nbsp;·&nbsp; ' + stats.vectorDone + ' vector-indexed' +
      ' &nbsp;·&nbsp; ' + stats.graphDone + ' graph-indexed';

    var emptyDetail = '<div class="vb-detail-empty">Select an email to view details</div>';

    if (!mails.length) {
      return '<div class="vb-header">' +
        '<h2>Virtual Box</h2>' +
        '<p class="vb-subtitle">No emails added yet</p>' +
        '<div class="vb-header-actions"><button id="vbClearAll" class="btn-ghost-sm" disabled>Clear All</button></div>' +
        '</div>' +
        '<div class="vb-empty"><p>No emails in Virtual Box yet.</p>' +
        '<p class="vb-empty-hint">Add emails using the selection review modal or the Subscriptions view.</p></div>';
    }

    var rows = mails.map(function(m) { return vbRowHtml(m); }).join('');
    var defaultStatus = mails.length.toLocaleString() + ' email' + (mails.length !== 1 ? 's' : '') + ' in Virtual Box';
    var notIndexedCount = Math.max(0, stats.total - stats.vectorDone);
    var notIndexedHint = notIndexedCount > 0
      ? notIndexedCount.toLocaleString() + ' email' + (notIndexedCount !== 1 ? 's aren\'t' : ' isn\'t') + ' vector-indexed yet — Simple Search covers ' + (notIndexedCount !== 1 ? 'them' : 'it') + ' too'
      : 'Keyword match across every email, indexed or not';

    return '<div class="vb-header">' +
      '<h2>Virtual Box</h2>' +
      '<p class="vb-subtitle" id="vbSubtitle">' + subtitleText + '</p>' +
      '<div class="vb-header-actions">' +
        '<button type="button" id="vbDetailToggle" class="vb-icon-btn" title="Hide reading pane">' +
          '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="15" height="12" rx="1.5"/><path d="M12 4v12"/></svg>' +
        '</button>' +
        '<button id="vbClearAll" class="btn-ghost-sm">Clear All</button>' +
      '</div>' +
      '</div>' +
      '<div class="vb-layout" id="vbLayoutRoot">' +
        '<div class="vb-list-panel">' +
          '<div class="vb-smart-banner" id="vbSmartBanner">' +
            '<span id="vbSmartBannerText">' + esc(defaultStatus) + '</span>' +
            '<button type="button" id="vbSmartClear" class="vb-smart-clear-btn" style="display:none">Clear</button>' +
          '</div>' +
          '<div id="vbList" class="vb-list">' + rows + '</div>' +
          '<div class="vb-smart-bar">' +
            '<div class="vb-smart-bar-top">' +
              '<div class="vb-smart-bar-label">' +
                '<span class="vb-smart-bar-icon" id="vbSearchModeIcon">' + VB_ICON_SMART + '</span>' +
                '<div class="vb-smart-bar-text">' +
                  '<span class="vb-smart-bar-title" id="vbSearchModeTitle">Smart Search</span>' +
                  '<span class="vb-smart-bar-subtitle" id="vbSearchModeSubtitle">Powered by vector &amp; hybrid search</span>' +
                '</div>' +
              '</div>' +
              '<div class="vb-search-mode-tabs" id="vbSearchModeTabs">' +
                '<button type="button" class="vb-mode-tab active" data-mode="smart">Smart</button>' +
                '<button type="button" class="vb-mode-tab" data-mode="simple" title="' + esc(notIndexedHint) + '">Simple</button>' +
              '</div>' +
            '</div>' +
            '<div class="vb-smart-bar-row">' +
              '<input id="vbSmartInput" class="vb-smart-input" type="text" placeholder="Ask: List all my FastTag emails&hellip;" autocomplete="off">' +
              '<button type="button" id="vbSmartSend" class="vb-smart-send" title="Search">' +
                '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z"/></svg>' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="vb-detail-panel" id="vbDetailPanel"><div id="vbDetail" class="vb-detail">' + emptyDetail + '</div></div>' +
      '</div>';
  }

  function vbRowHtml(m, score) {
    // Hash on the raw (unmasked) sender identity so color assignment stays stable
    // regardless of privacy-mask state, then mask only the displayed initial/text.
    var identity    = m.sender || m.domain || '';
    var avatarColor = vbAvatarColor(identity);
    var initial = privacyOn() ? '?' : (m.domain || '?')[0].toUpperCase();
    var subject = privacyOn() ? '••••••••' : esc(m.subject || '(No Subject)');
    var sender  = privacyOn() ? '••••••••' : esc(m.sender || m.domain || '');
    var date    = m.created_at ? new Date(m.created_at).toLocaleDateString() : '';
    var vecCls  = m.indexed_meta === 'yes' ? 'done' : 'pending';
    var grpCls  = m.graph_indexed === 'complete' ? 'done' : m.graph_indexed === 'inprogress' ? 'partial' : 'pending';
    var scoreBadge = (typeof score === 'number')
      ? '<span class="vb-score-badge" title="Match confidence">' + Math.round(score * 100) + '%</span>'
      : '';
    return '<div class="vb-row" data-id="' + esc(m.id) + '">' +
      '<div class="vb-row-avatar" style="background:' + avatarColor + ';">' + initial + '</div>' +
      '<div class="vb-row-body">' +
        '<div class="vb-row-subject">' + subject + '</div>' +
        '<div class="vb-row-meta">' + sender + ' &nbsp;·&nbsp; ' + date + '</div>' +
      '</div>' +
      scoreBadge +
      '<div class="vb-row-badges">' +
        '<span class="vb-badge vb-vec ' + vecCls + '" title="Vector index">V</span>' +
        '<span class="vb-badge vb-grp ' + grpCls + '" title="Graph index">G</span>' +
      '</div>' +
    '</div>';
  }

  function vbWireEvents(panel, mails) {
    var mailMap = {};
    mails.forEach(function(m) { mailMap[String(m.id)] = m; });

    var list       = panel.querySelector('#vbList');
    var detail     = panel.querySelector('#vbDetail');
    var layoutRoot = panel.querySelector('#vbLayoutRoot');
    var detailToggle = panel.querySelector('#vbDetailToggle');

    // ── Collapsible detail panel — gives the list more room when not needed.
    // Auto-expands again the moment a row is clicked (see list click handler below).
    function vbSetDetailCollapsed(collapsed) {
      if (!layoutRoot) return;
      layoutRoot.classList.toggle('vb-detail-hidden', collapsed);
      if (detailToggle) {
        detailToggle.classList.toggle('active', collapsed);
        detailToggle.title = collapsed ? 'Show reading pane' : 'Hide reading pane';
      }
    }
    if (detailToggle) {
      detailToggle.addEventListener('click', function() {
        vbSetDetailCollapsed(!layoutRoot.classList.contains('vb-detail-hidden'));
      });
    }

    // ── Search: Smart (hybrid vector + BM25, needs vector-indexed content) or
    // Simple (plain keyword match, works on every email including ones not yet
    // vector-indexed). Smart shows a per-row confidence score; Simple doesn't.
    var smartInput   = panel.querySelector('#vbSmartInput');
    var smartSend    = panel.querySelector('#vbSmartSend');
    var smartText    = panel.querySelector('#vbSmartBannerText');
    var smartClear   = panel.querySelector('#vbSmartClear');
    var modeIcon     = panel.querySelector('#vbSearchModeIcon');
    var modeTitle    = panel.querySelector('#vbSearchModeTitle');
    var modeSubtitle = panel.querySelector('#vbSearchModeSubtitle');
    var modeTabsEl   = panel.querySelector('#vbSearchModeTabs');

    var VB_MODE_COPY = {
      smart:  { icon: VB_ICON_SMART,  title: 'Smart Search',  subtitle: 'Powered by vector & hybrid search',       placeholder: 'Ask: List all my FastTag emails…' },
      simple: { icon: VB_ICON_SIMPLE, title: 'Simple Search', subtitle: 'Keyword match — works on every email',    placeholder: 'Search subject, sender, domain…' },
    };
    var vbSearchMode = 'smart';

    function vbDefaultStatus() {
      return mails.length.toLocaleString() + ' email' + (mails.length !== 1 ? 's' : '') + ' in Virtual Box';
    }

    function vbClearSearch() {
      if (smartInput) smartInput.value = '';
      if (smartClear) smartClear.style.display = 'none';
      if (smartText) smartText.textContent = vbDefaultStatus();
      if (list) list.innerHTML = mails.map(function(m) { return vbRowHtml(m); }).join('');
    }

    function vbSetSearchMode(mode) {
      if (mode === vbSearchMode) return;
      vbSearchMode = mode;
      var copy = VB_MODE_COPY[mode];
      if (modeIcon) modeIcon.innerHTML = copy.icon;
      if (modeTitle) modeTitle.textContent = copy.title;
      if (modeSubtitle) modeSubtitle.textContent = copy.subtitle;
      if (smartInput) smartInput.placeholder = copy.placeholder;
      if (modeTabsEl) {
        modeTabsEl.querySelectorAll('.vb-mode-tab').forEach(function(tab) {
          tab.classList.toggle('active', tab.getAttribute('data-mode') === mode);
        });
      }
      vbClearSearch();
    }
    if (modeTabsEl) {
      modeTabsEl.addEventListener('click', function(e) {
        var tab = e.target.closest('.vb-mode-tab');
        if (tab) vbSetSearchMode(tab.getAttribute('data-mode'));
      });
    }

    function vbRunSimpleSearch(q) {
      var needle = q.toLowerCase();
      var matched = mails.filter(function(m) {
        return (
          (m.subject || '').toLowerCase().indexOf(needle) !== -1 ||
          (m.sender  || '').toLowerCase().indexOf(needle) !== -1 ||
          (m.domain  || '').toLowerCase().indexOf(needle) !== -1
        );
      });
      if (!matched.length) {
        if (smartText) smartText.textContent = 'No matches for "' + q + '"';
        if (list) list.innerHTML = '<div class="vb-empty" style="padding:24px 16px;"><p>No emails matched.</p></div>';
      } else {
        if (smartText) {
          smartText.textContent = matched.length.toLocaleString() + ' match' + (matched.length !== 1 ? 'es' : '') + ' for "' + q + '"';
        }
        if (list) list.innerHTML = matched.map(function(m) { return vbRowHtml(m); }).join('');
      }
      if (smartClear) smartClear.style.display = '';
    }

    function vbRunSmartSearch(q) {
      smartInput.disabled = true;
      if (smartSend) smartSend.disabled = true;
      if (smartClear) smartClear.style.display = 'none';
      if (smartText) smartText.textContent = 'Searching…';

      browser.runtime.sendMessage({ action: 'smartSearchVirtualBox', query: q, limit: 50 }).then(function(res) {
        smartInput.disabled = false;
        if (smartSend) smartSend.disabled = false;
        var results = (res && res.results) || [];
        var matched = results
          .map(function(r) { var m = mailMap[String(r.id)]; return m ? { mail: m, score: r.score } : null; })
          .filter(Boolean);

        if (!matched.length) {
          if (smartText) smartText.textContent = 'No matches for "' + q + '"';
          if (smartClear) smartClear.style.display = '';
          if (list) list.innerHTML = '<div class="vb-empty" style="padding:24px 16px;"><p>No emails matched.</p></div>';
          return;
        }
        if (smartText) {
          smartText.textContent = 'Top ' + matched.length.toLocaleString() + ' match' + (matched.length !== 1 ? 'es' : '') + ' for "' + q + '"';
        }
        if (smartClear) smartClear.style.display = '';
        if (list) list.innerHTML = matched.map(function(x) { return vbRowHtml(x.mail, x.score); }).join('');
      }).catch(function() {
        smartInput.disabled = false;
        if (smartSend) smartSend.disabled = false;
        if (smartText) smartText.textContent = 'Search failed — try again.';
        if (smartClear) smartClear.style.display = '';
      });
    }

    function vbRunSearch() {
      if (!smartInput) return;
      var q = smartInput.value.trim();
      if (!q) return;
      if (vbSearchMode === 'simple') vbRunSimpleSearch(q);
      else vbRunSmartSearch(q);
    }

    if (smartSend)  smartSend.addEventListener('click', vbRunSearch);
    if (smartInput) smartInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); vbRunSearch(); }
    });
    if (smartClear) smartClear.addEventListener('click', vbClearSearch);

    if (list && detail) {
      list.addEventListener('click', function(e) {
        var row = e.target.closest('.vb-row');
        if (!row) return;
        list.querySelectorAll('.vb-row').forEach(function(r) { r.classList.remove('selected'); });
        row.classList.add('selected');
        vbSetDetailCollapsed(false); // clicking a row always means "show me details"
        var m = mailMap[row.getAttribute('data-id')];
        if (m) detail.innerHTML = vbDetailHtml(m);

        var rmBtn = detail.querySelector('.vb-remove-btn');
        if (rmBtn) {
          rmBtn.addEventListener('click', function() {
            browser.runtime.sendMessage({ action: 'removeInclusionMails', mailIds: [String(m.id)] }).then(function(res) {
              row.remove();
              detail.innerHTML = '<div class="vb-detail-empty">Email removed from Virtual Box.</div>';
              mails = mails.filter(function(x) { return String(x.id) !== String(m.id); });
              if (res && res.stats && window.updateVirtualBoxNavCount) {
                window.updateVirtualBoxNavCount(res.stats.total);
              }
              var sub = panel.querySelector('#vbSubtitle');
              if (sub && res && res.stats) {
                var s = res.stats;
                sub.textContent = s.total + ' email' + (s.total !== 1 ? 's' : '') +
                  ' · ' + s.vectorDone + ' vector-indexed · ' + s.graphDone + ' graph-indexed';
              }
            }).catch(function() {});
          });
        }
      });
    }

    var clearBtn = panel.querySelector('#vbClearAll');
    if (clearBtn && !clearBtn.disabled) {
      clearBtn.addEventListener('click', function() {
        if (!confirm('Remove all emails from Virtual Box? This does not delete your emails — it only removes them from the intelligence index set.')) return;
        browser.runtime.sendMessage({ action: 'clearAllInclusions' }).then(function() {
          if (window.updateVirtualBoxNavCount) window.updateVirtualBoxNavCount(0);
          window.renderVirtualBox();
        }).catch(function() {});
      });
    }
  }

  function vbDetailHtml(m) {
    var subject = privacyOn() ? '••••••••' : esc(m.subject || '(No Subject)');
    var sender  = privacyOn() ? '••••' : esc(m.sender || '');
    var domain  = privacyOn() ? '••••' : esc(m.domain || '');
    var date    = m.created_at ? new Date(m.created_at).toLocaleString() : '—';
    var size    = m.size ? (m.size > 1048576 ? (m.size / 1048576).toFixed(1) + ' MB' : Math.round(m.size / 1024) + ' KB') : '—';
    var vecCls  = m.indexed_meta === 'yes' ? 'done' : 'pending';
    var vecLbl  = m.indexed_meta === 'yes' ? 'Indexed' : 'Pending';
    var grpCls  = m.graph_indexed === 'complete' ? 'done' : m.graph_indexed === 'inprogress' ? 'partial' : 'pending';
    var grpLbl  = m.graph_indexed === 'complete' ? 'Indexed' : m.graph_indexed === 'inprogress' ? 'In Progress' : 'Pending';

    var entities = '';

    var bodySection = '';
    if (m.body_text) {
      var bodyContent = privacyOn()
        ? '<div class="vb-body-blur">Content hidden in privacy mode</div>'
        : '<div class="vb-body-text">' + vbFormatBody(m.body_text) + '</div>';
      bodySection = '<div class="vb-body">' +
        '<div class="vb-body-label">Content</div>' +
        bodyContent +
        '</div>';
    } else if (m.indexed_meta === 'yes') {
      bodySection = '<div class="vb-body"><div class="vb-body-label">Content</div>' +
        '<div class="vb-body-empty">Body text not available — re-run Build Index to fetch.</div></div>';
    }

    return '<div class="vb-detail-subject">' + subject + '</div>' +
      '<div class="vb-detail-meta-grid">' +
        '<span class="vb-meta-label">Sender</span><span>' + sender + '</span>' +
        '<span class="vb-meta-label">Domain</span><span>' + domain + '</span>' +
        '<span class="vb-meta-label">Date</span><span>' + date + '</span>' +
        '<span class="vb-meta-label">Size</span><span>' + size + '</span>' +
      '</div>' +
      '<div class="vb-index-status">' +
        '<div class="vb-status-row"><span class="vb-status-label">Vector Index</span><span class="vb-status-pill ' + vecCls + '">' + vecLbl + '</span></div>' +
        '<div class="vb-status-row"><span class="vb-status-label">Graph Index</span><span class="vb-status-pill ' + grpCls + '">' + grpLbl + '</span></div>' +
      '</div>' +
      entities +
      bodySection +
      '<div class="vb-detail-actions"><button class="vb-remove-btn">Remove from Virtual Box</button></div>';
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BROWSE — search the full scanned mailbox, pick emails, add to Virtual Box
  //  Reuses the Selection Review modal's virtual-scroll table markup/CSS
  //  (.selection-review-table / .selection-review-row / .sr-*) as a full page.
  // ══════════════════════════════════════════════════════════════════════════

  var browseState = { query: '', sort: 'date-desc', folder: '' };
  var browseCheckedIds = new Set();
  var BR_ROW_HEIGHT = 54;
  var BR_VIRTUAL_BUFFER = 8;

  function brFormatBytes(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function brFormatDate(dateValue) {
    var d = new Date(dateValue);
    if (isNaN(d.getTime())) return 'Unknown date';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function brMatchesQuery(m, q) {
    return (
      (m.subject || '').toLowerCase().indexOf(q) !== -1 ||
      (m.senderName || '').toLowerCase().indexOf(q) !== -1 ||
      (m.senderEmail || '').toLowerCase().indexOf(q) !== -1 ||
      (m.domain || '').toLowerCase().indexOf(q) !== -1 ||
      (m.folder || '').toLowerCase().indexOf(q) !== -1 ||
      (m.account || '').toLowerCase().indexOf(q) !== -1
    );
  }

  function brGetFiltered() {
    var q = browseState.query.trim().toLowerCase();
    var filtered = getMessages().filter(function(m) {
      if (browseState.folder && (m.folder || '') !== browseState.folder) return false;
      if (q && !brMatchesQuery(m, q)) return false;
      return true;
    });
    var sort = browseState.sort;
    filtered.sort(function(a, b) {
      if (sort === 'date-asc')    return new Date(a.date) - new Date(b.date);
      if (sort === 'size-desc')   return (Number(b.size) || 0) - (Number(a.size) || 0);
      if (sort === 'sender-asc')  return (a.senderEmail || '').localeCompare(b.senderEmail || '');
      if (sort === 'subject-asc') return (a.subject || '').localeCompare(b.subject || '');
      return new Date(b.date) - new Date(a.date);
    });
    return filtered;
  }

  window.renderBrowse = function() {
    var panel = document.getElementById('browseView');
    if (!panel) return;

    browseCheckedIds.clear();
    var all = getMessages();

    if (!all.length) {
      panel.innerHTML = '<div class="vb-shell"><div class="vb-header"><h2>Browse</h2>' +
        '<p class="vb-subtitle">No scanned emails yet</p></div>' +
        '<div class="vb-empty"><p>Scan a mailbox first (Indexes page), then come back here to browse and pick emails for Virtual Box.</p></div></div>';
      return;
    }

    var folderCounts = {};
    all.forEach(function(m) { if (m.folder) folderCounts[m.folder] = (folderCounts[m.folder] || 0) + 1; });
    var folders = Object.keys(folderCounts).sort();

    panel.innerHTML =
      '<div class="vb-shell">' +
        '<div class="vb-header">' +
          '<h2>Browse</h2>' +
          '<p class="vb-subtitle" id="brSubtitle"></p>' +
        '</div>' +
        '<div class="selection-review-controls">' +
          '<input type="text" id="brSearch" class="search-input" placeholder="Search subject, sender, folder…">' +
          '<select id="brFolder">' +
            '<option value="">All folders</option>' +
            folders.map(function(f) {
              return '<option value="' + esc(f) + '">' + esc(displayFolderName(f) || f) + ' (' + fmtNum(folderCounts[f]) + ')</option>';
            }).join('') +
          '</select>' +
          '<select id="brSort">' +
            '<option value="date-desc">Newest first</option>' +
            '<option value="date-asc">Oldest first</option>' +
            '<option value="size-desc">Largest first</option>' +
            '<option value="sender-asc">Sender A→Z</option>' +
            '<option value="subject-asc">Subject A→Z</option>' +
          '</select>' +
        '</div>' +
        '<div id="brTable" class="selection-review-table br-table"></div>' +
        '<div class="modal-actions selection-review-actions br-actions">' +
          '<div id="brCheckedActions" class="sr-checked-actions" style="display:none">' +
            '<button type="button" id="brAddToVB" class="btn btn-primary" title="Add checked emails to the Virtual Box intelligence index">Add selected to VirtualBox</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    brWire(panel);
  };

  function brWire(panel) {
    var table     = panel.querySelector('#brTable');
    var search    = panel.querySelector('#brSearch');
    var folderSel = panel.querySelector('#brFolder');
    var sortSel   = panel.querySelector('#brSort');

    search.value    = browseState.query;
    folderSel.value = browseState.folder;
    sortSel.value   = browseState.sort;

    search.oninput    = function() { browseState.query  = search.value;    brRenderTable(panel); };
    folderSel.onchange = function() { browseState.folder = folderSel.value; brRenderTable(panel); };
    sortSel.onchange  = function() { browseState.sort   = sortSel.value;   brRenderTable(panel); };

    table.addEventListener('click', function(e) {
      var link = e.target.closest('[data-open-message]');
      if (!link) return;
      e.preventDefault();
      if (window._ip && window._ip.openMessageInThunderbird) window._ip.openMessageInThunderbird(link.getAttribute('data-open-message'));
    });

    brRenderTable(panel);
  }

  function brRenderTable(panel) {
    var table      = panel.querySelector('#brTable');
    var subtitleEl = panel.querySelector('#brSubtitle');
    var filtered   = brGetFiltered();

    if (subtitleEl) {
      subtitleEl.textContent = fmtNum(getMessages().length) + ' emails scanned · ' + fmtNum(filtered.length) + ' matched';
    }

    if (!filtered.length) {
      table.innerHTML = '<div class="selection-empty">No emails match your filters.</div>';
      return;
    }

    var allIds     = filtered.map(function(m) { return String(m.id); });
    var allChecked = allIds.length > 0 && allIds.every(function(id) { return browseCheckedIds.has(id); });
    var someChecked = allIds.some(function(id) { return browseCheckedIds.has(id); });
    var totalHeight = filtered.length * BR_ROW_HEIGHT;

    table.innerHTML =
      '<div class="selection-review-table-head">' +
        '<span class="sr-col-check"><input type="checkbox" id="brSelectAll"' + (allChecked ? ' checked' : '') + '></span>' +
        '<span>Subject</span><span>Sender</span><span>Date</span><span>Size</span>' +
      '</div>' +
      '<div class="sr-virtual-spacer" id="brVirtualSpacer" style="height:' + totalHeight + 'px;"></div>';

    var selAllCb = table.querySelector('#brSelectAll');
    if (selAllCb && someChecked && !allChecked) selAllCb.indeterminate = true;
    var spacer = table.querySelector('#brVirtualSpacer');
    var headEl = table.querySelector('.selection-review-table-head');

    function rowHtml(m, idx) {
      var mid         = String(m.id);
      var subject     = privacyOn() ? '••••••••' : esc(m.subject || '(No Subject)');
      var senderName  = privacyOn() ? '••••••••' : esc(m.senderName || displayEmail(m.senderEmail));
      var senderEmail = privacyOn() ? '' : esc(displayEmail(m.senderEmail) || '');
      return '<div class="selection-review-row' + (browseCheckedIds.has(mid) ? ' sr-row-checked' : '') + '" data-id="' + esc(mid) + '" style="top:' + (idx * BR_ROW_HEIGHT) + 'px;">' +
        '<div class="sr-col-check"><input type="checkbox" class="sr-row-cb" data-id="' + esc(mid) + '"' + (browseCheckedIds.has(mid) ? ' checked' : '') + '></div>' +
        '<div class="selection-subject">' +
          '<button type="button" class="selection-open-link" data-open-message="' + esc(mid) + '" title="Open in Thunderbird">' + subject + '</button>' +
          '<span>' + esc(displayFolderName(m.folder) || 'Unknown folder') + ' · ' + esc(displayAccountName(m.account || '')) + '</span>' +
        '</div>' +
        '<div class="selection-sender"><strong>' + senderName + '</strong><span>' + senderEmail + '</span></div>' +
        '<div class="selection-date">' + esc(brFormatDate(m.date)) + '</div>' +
        '<div class="selection-size">' + esc(brFormatBytes(m.size)) + '</div>' +
      '</div>';
    }

    var rafPending = false;
    function renderVisible() {
      rafPending = false;
      var headH = headEl ? headEl.offsetHeight : 0;
      var relTop = Math.max(0, table.scrollTop - headH);
      var startIndex = Math.max(0, Math.floor(relTop / BR_ROW_HEIGHT) - BR_VIRTUAL_BUFFER);
      var visibleCount = Math.ceil(table.clientHeight / BR_ROW_HEIGHT) + BR_VIRTUAL_BUFFER * 2;
      var endIndex = Math.min(filtered.length, startIndex + visibleCount);
      var html = '';
      for (var i = startIndex; i < endIndex; i++) html += rowHtml(filtered[i], i);
      spacer.innerHTML = html;
    }
    function scheduleRender() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(renderVisible);
    }
    table.onscroll = scheduleRender;
    renderVisible();

    if (selAllCb) {
      selAllCb.addEventListener('change', function() {
        allIds.forEach(function(id) { selAllCb.checked ? browseCheckedIds.add(id) : browseCheckedIds.delete(id); });
        brUpdateCheckedActions();
        renderVisible();
      });
    }

    spacer.addEventListener('change', function(e) {
      var cb = e.target.closest('.sr-row-cb');
      if (!cb) return;
      var id = cb.dataset.id;
      cb.checked ? browseCheckedIds.add(id) : browseCheckedIds.delete(id);
      var row = cb.closest('.selection-review-row');
      if (row) row.classList.toggle('sr-row-checked', cb.checked);
      var allNow  = allIds.every(function(vid) { return browseCheckedIds.has(vid); });
      var someNow = allIds.some(function(vid) { return browseCheckedIds.has(vid); });
      if (selAllCb) { selAllCb.checked = allNow; selAllCb.indeterminate = someNow && !allNow; }
      brUpdateCheckedActions();
    });

    brUpdateCheckedActions();
  }

  function brUpdateCheckedActions() {
    var n = browseCheckedIds.size;
    var actionsEl = document.getElementById('brCheckedActions');
    var addBtn    = document.getElementById('brAddToVB');
    if (!actionsEl) return;
    actionsEl.style.display = n > 0 ? '' : 'none';
    if (addBtn) {
      addBtn.textContent = 'Add selected to VirtualBox (' + fmtNum(n) + ')';
      addBtn.onclick = function() {
        var ids = Array.from(browseCheckedIds);
        if (!ids.length) return;
        browser.runtime.sendMessage({ action: 'addInclusionMails', mailIds: ids }).then(function(res) {
          if (window._ip && window._ip.showToast) {
            window._ip.showToast(fmtNum(ids.length) + ' email' + (ids.length !== 1 ? 's' : '') + ' added to Virtual Box');
          }
          if (res && res.stats && window.updateVirtualBoxNavCount) window.updateVirtualBoxNavCount(res.stats.total);
          browseCheckedIds.clear();
          var panel = document.getElementById('browseView');
          if (panel) brRenderTable(panel);
        });
      };
    }
  }

  // Render plain-text email body with light markdown: bold, inline code, headings, bullets, URLs
  function vbFormatBody(text) {
    var lines = text.split('\n');
    var out = '';
    var inList = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Heading
      var hm = line.match(/^(#{1,3}) (.+)/);
      if (hm) {
        if (inList) { out += '</ul>'; inList = false; }
        var lvl = Math.min(hm[1].length + 2, 6);
        out += '<h' + lvl + ' class="vb-md-h">' + vbInline(hm[2]) + '</h' + lvl + '>';
        continue;
      }
      // Bullet list
      var lm = line.match(/^[\-\*\+] (.+)/);
      if (lm) {
        if (!inList) { out += '<ul class="vb-md-ul">'; inList = true; }
        out += '<li>' + vbInline(lm[1]) + '</li>';
        continue;
      }
      if (inList) { out += '</ul>'; inList = false; }
      // Blank line → spacer
      if (line.trim() === '') {
        out += '<div class="vb-md-gap"></div>';
      } else {
        out += '<p class="vb-md-p">' + vbInline(line) + '</p>';
      }
    }
    if (inList) out += '</ul>';
    return out;
  }

  function vbInline(text) {
    var s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`\n]+)`/g, '<code class="vb-md-code">$1</code>');
    s = s.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noopener" class="vb-md-link">$1</a>');
    return s;
  }

})();
