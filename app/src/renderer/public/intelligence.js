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

  function privacyOn() { return document.body.classList.contains('privacy-mode'); }

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
    showThinking: false,
    mode: 'fast',          // 'fast' (direct text) | 'deep' (visual report) — fast is the quick default
    selectedFolders: [],   // [{path}] — from picker (max 2)
    indexedFolders: [],    // cached list from lanceStore
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
            '<div class="ss-folder-picker" id="ssFolderPicker" style="display:none"></div>',
            '<textarea id="ssChatInput" class="ss-chat-input" rows="1"',
              ' placeholder="Type / to pick a model and folder (↑↓/Tab, Enter), then ask…"',
              (hasData ? '' : ' disabled'),
            '></textarea>',
          '</div>',
          '<div class="ss-input-footer">',
            '<label class="ss-thinking-toggle" title="Show model reasoning">',
              '<span class="ss-toggle-track">',
                '<input type="checkbox" id="ssThinkingToggle"' + (chat.showThinking ? ' checked' : '') + '>',
                '<span class="ss-toggle-thumb"></span>',
              '</span>',
              '<svg class="ss-thinking-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">',
                '<path d="M8 2a4.5 4.5 0 013.5 7.3V11a1 1 0 01-1 1H5.5a1 1 0 01-1-1v-1.7A4.5 4.5 0 018 2z"/>',
                '<path d="M6 12v1a2 2 0 004 0v-1"/>',
              '</svg>',
              '<span class="ss-toggle-label">Thinking</span>',
            '</label>',
            '<div class="ss-mode-toggle" id="ssModeToggle">',
              '<button class="ss-mode-btn' + (chat.mode === 'fast' ? ' active' : '') + '" data-mode="fast" title="Direct chat answer — quick, no report">Fast</button>',
              '<button class="ss-mode-btn' + (chat.mode === 'deep' ? ' active' : '') + '" data-mode="deep" title="Generate a full visual report / widget — slower">Deep</button>',
            '</div>',
            '<div class="ss-folder-chips" id="ssFolderChips"></div>',
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
        if (e.key === 'Escape')    { e.preventDefault(); ssHideFolderPicker(); return; }
        return;
      }
      if (e.key === 'Escape') { ssHideFolderPicker(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ssSendMessage(); }
    });
    inputEl.addEventListener('input', function () {
      ssAutoResize(inputEl);
      ssCheckPickerTrigger(inputEl);
    });
    document.addEventListener('click', function (e) {
      var picker = document.getElementById('ssFolderPicker');
      if (picker && !picker.contains(e.target) && e.target !== inputEl) ssHideFolderPicker();
    });

    var thinkToggle = document.getElementById('ssThinkingToggle');
    if (thinkToggle) thinkToggle.addEventListener('change', function () {
      chat.showThinking = this.checked;
      if (chat.history.length) ssRerenderHistory();
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

    ssCheckOllama();
    ssLoadIndexedFolders(); // will update greeting once stats arrive

    if (!chat.history.length) {
      ssShowGreeting(false, ''); // placeholder — ssLoadIndexedFolders will update it
    } else {
      ssRerenderHistory();
    }

    setTimeout(function () { inputEl.focus(); }, 80);
  };

  // ── Picker (folders + models combined) ────────────────────────────────────

  function ssLoadIndexedFolders() {
    browser.runtime.sendMessage({ action: 'getIndexingStats' }).then(function (stats) {
      chat.indexedFolders = (stats && stats.folders) ? stats.folders : [];
      var hasIndexed = stats && stats.total > 0;
      if (hasIndexed && !chat.history.length) {
        var folderNames = chat.indexedFolders.slice(0, 3).map(function (f) {
          return typeof f === 'object' ? (f.folder || '') : String(f);
        }).filter(Boolean).join(', ');
        ssShowGreeting(true, folderNames);
      } else if (!hasIndexed && !getMessages().length && !chat.history.length) {
        ssShowGreeting(false, '');
      }
    }).catch(function () { chat.indexedFolders = []; });
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
      ssHideFolderPicker();
    }
  }

  var FOLDER_ICON = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1.5 4.5h11v7a1 1 0 01-1 1h-9a1 1 0 01-1-1v-7zM1.5 4.5l1-2h3l1 2"/></svg>';
  var MODEL_ICON  = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="10" height="7" rx="1.5"/><path d="M5 4V3a2 2 0 014 0v1"/><circle cx="5" cy="7.5" r=".8" fill="currentColor" stroke="none"/><circle cx="9" cy="7.5" r=".8" fill="currentColor" stroke="none"/></svg>';

  function ssShowCombinedPicker(filter) {
    var picker = document.getElementById('ssFolderPicker');
    if (!picker) return;

    var availFolders = chat.indexedFolders.filter(function (f) {
      var path = typeof f === 'object' ? f.folder : f;
      return !chat.selectedFolders.some(function (s) { return s.path === path; });
    });
    var filtFolders = filter
      ? availFolders.filter(function (f) {
          var path = typeof f === 'object' ? f.folder : f;
          return path.toLowerCase().includes(filter);
        })
      : availFolders;

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

    if (!filtFolders.length && !filtModels.length && !cloudEntries.length) { ssHideFolderPicker(); return; }

    var html = '';

    if (filtFolders.length) {
      html += '<div class="ss-picker-section-header">Folders</div>';
      html += filtFolders.slice(0, 6).map(function (f) {
        var path  = typeof f === 'object' ? f.folder : f;
        var count = typeof f === 'object' ? f.count  : '';
        return '<div class="ss-folder-option" data-type="folder" data-path="' + esc(path) + '">' +
          FOLDER_ICON +
          '<span class="ss-fo-name">' + esc(path) + '</span>' +
          (count ? '<span class="ss-fo-count">' + fmtNum(count) + '</span>' : '') +
          '</div>';
      }).join('');
    }

    if (filtModels.length) {
      html += '<div class="ss-picker-section-header">Local (Ollama)</div>';
      html += filtModels.slice(0, 8).map(function (m) {
        var active = m === (chat.selectedModel || (chat.aiProvider === 'ollama' ? chat.model : ''));
        return '<div class="ss-folder-option" data-type="model" data-model="' + esc(m) + '">' +
          MODEL_ICON +
          '<span class="ss-fo-name">' + esc(m) + '</span>' +
          (active ? '<span class="ss-fo-count ss-fo-active">active</span>' : '') +
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
          return '<div class="ss-folder-option ss-cloud-option" data-type="model" data-model="' + esc(e.id) + '">' +
            MODEL_ICON +
            '<span class="ss-fo-name">' + esc(e.model) + '</span>' +
            (active ? '<span class="ss-fo-count ss-fo-active">active</span>' : '') +
            '</div>';
        }).join('');
      });
    }

    picker.innerHTML = html;
    picker.style.display = 'block';

    picker.querySelectorAll('.ss-folder-option').forEach(function (el, i) {
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
    var picker = document.getElementById('ssFolderPicker');
    return !!(picker && picker.style.display !== 'none');
  }
  function ssPickerItems() {
    var picker = document.getElementById('ssFolderPicker');
    if (!picker) return [];
    return Array.prototype.slice.call(picker.querySelectorAll('.ss-folder-option'));
  }
  function ssPickerHighlight() {
    var items = ssPickerItems();
    items.forEach(function (el, i) { el.classList.toggle('ss-fo-highlight', i === ssPickerIndex); });
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
    if (el.getAttribute('data-type') === 'folder') ssAddFolderChip(el.getAttribute('data-path'));
    else                                           ssSetModelChip(el.getAttribute('data-model'));
    ssHideFolderPicker();
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

  function ssHideFolderPicker() {
    var picker = document.getElementById('ssFolderPicker');
    if (picker) picker.style.display = 'none';
    ssPickerIndex = -1;
  }

  function ssAddFolderChip(path) {
    if (chat.selectedFolders.length >= 2) return;
    if (chat.selectedFolders.some(function (f) { return f.path === path; })) return;
    chat.selectedFolders.push({ path: path });
    ssRenderFolderChips();
  }

  function ssRemoveFolderChip(path) {
    chat.selectedFolders = chat.selectedFolders.filter(function (f) { return f.path !== path; });
    ssRenderFolderChips();
  }

  function ssSetModelChip(modelName) {
    chat.selectedModel = modelName;
    ssRenderFolderChips();
    ssUpdateActiveModel();
  }

  function ssRenderFolderChips() {
    var chips = document.getElementById('ssFolderChips');
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

    html += chat.selectedFolders.map(function (f) {
      return '<span class="ss-folder-chip">' +
        '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1 3.5h10v6a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5v-6zM1 3.5l.8-1.5h2.5l.7 1.5"/></svg>' +
        esc(f.path) +
        '<button class="ss-chip-remove" data-path="' + esc(f.path) + '" title="Remove">&times;</button>' +
        '</span>';
    }).join('');

    chips.innerHTML = html;

    var modelRemove = chips.querySelector('.ss-model-remove');
    if (modelRemove) modelRemove.addEventListener('click', function () {
      chat.selectedModel = ''; ssRenderFolderChips(); ssUpdateActiveModel();
    });
    chips.querySelectorAll('.ss-chip-remove:not(.ss-model-remove)').forEach(function (btn) {
      btn.addEventListener('click', function () { ssRemoveFolderChip(btn.getAttribute('data-path')); });
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
      var preferred = ['qwen3.5:27b', 'qwen2.5', 'qwen', 'llama3.2', 'llama3.1', 'llama3', 'phi4', 'gemma3', 'mistral'];
      var picked = '';
      for (var i = 0; i < preferred.length; i++) {
        var found = models.find(function (m) { return m.startsWith(preferred[i]); });
        if (found) { picked = found; break; }
      }
      if (!picked) picked = models[0] || '';
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

  function ssShowGreeting(hasData, folderNames) {
    var body = document.getElementById('ssChatMessages');
    if (!body) return;
    body.innerHTML = '';
    var folderHint = folderNames ? ' Indexed: <strong>' + esc(folderNames) + '</strong>.' : '';
    var greetingText = hasData
      ? 'Hi! I can search your indexed emails semantically. Try:\n\n• "Who sends me the most email?"\n• "Show me all Amazon orders"\n• "Find travel booking emails last year"\n\n' + folderHint + '\n\nType <code>/</code> to scope by folder · <code>/model</code> to switch AI model.'
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

    // No defaults — require the user to explicitly pick a model AND at least one folder.
    var missing = [];
    if (!chat.selectedModel)            missing.push('a model');
    if (!chat.selectedFolders.length)   missing.push('at least one folder');
    if (missing.length) {
      var bodyG = document.getElementById('ssChatMessages');
      if (bodyG) bodyG.insertAdjacentHTML('beforeend', ssAssistantBubble(
        'Please choose ' + missing.join(' and ') +
        ' before asking. Type <code>/</code> to pick — use ↑ ↓ / Tab and Enter to select. ' +
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

    // Include selected folder paths in the query for scoped search
    var folders = chat.selectedFolders.map(function (f) { return f.path; });

    browser.runtime.sendMessage({
      action:      'chatQuery',
      userMessage: text,
      history: chat.history.slice(0, -1).map(function (m) {
        return { role: m.role, content: m.content };
      }),
      model:    effectiveModel,
      provider: effectiveProvider,
      folders:  folders.length ? folders : undefined,
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

      chat.history.push({
        role: 'assistant', content: answerText,
        _thinking: thinking, _steps: agentSteps,
        _responseType: responseType, _widgetHtml: widgetHtml, _htmlWidget: htmlWidget,
      });

      if (body) {
        var thinkBlock = chat.showThinking ? ssThinkingBlock(thinking, agentSteps) : '';
        var bubbleHtml;
        if (htmlWidget && htmlWidget.trim()) {
          bubbleHtml = ssIframeWidgetBubble(htmlWidget, thinkBlock + ssWidgetProse(answerText));
        } else if (responseType === 'text') {
          bubbleHtml = ssAssistantBubble(thinkBlock + answerText);
        } else {
          bubbleHtml = ssWidgetBubble(thinkBlock + widgetHtml, answerText);
        }
        body.insertAdjacentHTML('beforeend', bubbleHtml);
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
    chat.selectedFolders = [];
    chat.selectedModel = '';
    var body = document.getElementById('ssChatMessages');
    if (body) body.innerHTML = '';
    ssRenderFolderChips();
    ssUpdateActiveModel();
    ssLoadIndexedFolders(); // re-run to update greeting with folder context
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
    var rows = (steps || []).map(ssThinkStepHtml).join('');

    var stepCount = (steps || []).length;
    return '<details class="ss-thinking-block">' +
      '<summary class="ss-thinking-summary">' +
        '<svg class="ss-thinking-brain" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2a4.5 4.5 0 013.5 7.3V11a1 1 0 01-1 1H5.5a1 1 0 01-1-1v-1.7A4.5 4.5 0 018 2z"/><path d="M6 12v1a2 2 0 004 0v-1"/></svg>' +
        '<span class="ss-thinking-label">Thinking</span>' +
        (stepCount > 0 ? '<span class="ss-thinking-count">' + stepCount + ' step' + (stepCount === 1 ? '' : 's') + '</span>' : '') +
        '<svg class="ss-thinking-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg>' +
      '</summary>' +
      '<div class="ss-thinking-body">' + rows + '</div>' +
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
        var thinkBlock = (chat.showThinking && (msg._thinking || (msg._steps && msg._steps.length)))
          ? ssThinkingBlock(msg._thinking || '', msg._steps || '') : '';
        if (msg._htmlWidget && msg._htmlWidget.trim()) {
          body.insertAdjacentHTML('beforeend', ssIframeWidgetBubble(msg._htmlWidget, thinkBlock + ssWidgetProse(msg.content)));
        } else if (msg._responseType !== 'text' && msg._widgetHtml) {
          body.insertAdjacentHTML('beforeend', ssWidgetBubble(thinkBlock + msg._widgetHtml, msg.content));
        } else {
          body.insertAdjacentHTML('beforeend', ssAssistantBubble(thinkBlock + msg.content));
        }
      }
    });
    ssScrollToBottom();
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

    // Only show the building screen when indexing is ACTIVELY in progress, i.e. we've
    // received at least one progress event this run (id.progress.total > 0). A stale
    // flag alone is not enough — otherwise we briefly flash "Building index…" on entry.
    var activelyIndexing =
      id.state === 'indexing' &&
      id.progress.total > 0 &&
      id.progress.done < id.progress.total;
    if (activelyIndexing) {
      idRenderProgress(id.progress.total, id.progress.done, id.progress.errors);
      return;
    }

    // Otherwise decide from real index contents — no flash.
    browser.runtime.sendMessage({ action: 'getIndexingStats' }).then(function (stats) {
      if (stats && stats.total > 0) {
        id.state = 'indexed';
        idRenderClusters(stats);
      } else if (window._ip && window._ip.indexing) {
        // A scan just kicked off indexing but no progress event has landed yet.
        id.state = 'indexing';
        idRenderProgress(id.progress.total || (window._ip.messages || []).length, 0, 0);
      } else {
        id.state = 'idle';
        idRenderNotIndexed();
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

  // ── Cluster cards (state: indexed) ────────────────────────────────────────

  function idRenderClusters(stats) {
    var shell = document.getElementById('idShell');
    if (!shell) return;

    var total = (stats && stats.total) ? stats.total : 0;
    var folderList = (stats && stats.folders) ? stats.folders : [];
    var folderNames = folderList.slice(0, 4).map(function (f) {
      return typeof f === 'object' ? (f.folder || '') : String(f);
    }).filter(Boolean).join(', ');
    var extraFolders = folderList.length > 4 ? ' +' + (folderList.length - 4) + ' more' : '';
    var folderBadge = folderNames
      ? '<span class="id-folder-scope">' + esc(folderNames + extraFolders) + '</span>'
      : '';

    browser.runtime.sendMessage({ action: 'getSemanticClusters' }).then(function (clusters) {
      var clusterCards = (clusters || []).map(function (c) {
        var subjects = (c.topSubjects || []).slice(0, 2).map(function (s) {
          return '<div class="id-cluster-subject">' + esc(s) + '</div>';
        }).join('');
        return '<div class="id-cluster-card" data-label="' + esc(c.label) + '">' +
          '<div class="id-cluster-icon">' + c.icon + '</div>' +
          '<div class="id-cluster-label">' + esc(c.label) + '</div>' +
          '<div class="id-cluster-count">' + fmtNum(c.count) + '</div>' +
          (subjects ? '<div class="id-cluster-subjects">' + subjects + '</div>' : '') +
          '</div>';
      }).join('');

      shell.innerHTML = [
        '<div class="id-indexed-wrap">',
          '<div class="id-indexed-header">',
            '<div class="id-indexed-title">',
              '<h2>Inbox Intelligence</h2>',
              '<div class="id-indexed-meta">',
                '<span class="id-indexed-total">' + fmtNum(total) + ' emails indexed</span>',
                folderBadge,
              '</div>',
            '</div>',
            '<button class="id-reindex-btn" id="idReindexBtn">',
              '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 7a5 5 0 001 3M12 7a5 5 0 00-1-3M4 12.5l-1.5-2.5 2.5-.5"/></svg>',
              'Re-index',
            '</button>',
          '</div>',
          '<div class="id-cluster-grid">', clusterCards || '<p class="id-no-clusters">No data yet.</p>', '</div>',
        '</div>',
      ].join('');

      document.getElementById('idReindexBtn').addEventListener('click', function () {
        browser.runtime.sendMessage({ action: 'resetVectorIndex' }).then(function () {
          id.state = 'idle';
          idRenderFolderPicker();
        });
      });

      // Wire cluster card clicks
      shell.querySelectorAll('.id-cluster-card').forEach(function (card) {
        card.addEventListener('click', function () {
          var label = card.getAttribute('data-label') || '';
          var clusterData = (clusters || []).find(function (c) { return c.label === label; });
          var icon  = clusterData ? clusterData.icon : '📨';
          var count = clusterData ? clusterData.count : 0;
          idShowClusterModal(label, icon, count);
        });
      });

    }).catch(function () {
      shell.innerHTML = '<div class="id-empty-state"><p>Could not load intelligence data.</p><button class="id-retry-btn" id="idRetryBtn2">Retry</button></div>';
      var btn = document.getElementById('idRetryBtn2');
      if (btn) btn.addEventListener('click', function () { idRenderClusters(stats); });
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

    browser.runtime.sendMessage({ action: 'getAISettings' }).then(function (s) {
      if (s && s.activeProvider) chat.aiProvider = s.activeProvider;
      if (s && s.providers) {
        ['openai', 'anthropic', 'google'].forEach(function (p) {
          if (s.providers[p]) {
            chat.aiSettings[p].hasKey    = s.providers[p].hasKey;
            chat.aiSettings[p].maskedKey = s.providers[p].maskedKey;
            if (s.providers[p].model) chat.aiSettings[p].model = s.providers[p].model;
          }
        });
      }
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
        ? '<div class="ais-active-row"><span class="ais-active-label">● Active provider</span></div>'
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
          '<p class="ais-desc">Manage how InboxPie indexes your mail and which AI engine answers your questions. Everything stays on your device unless you opt into a cloud provider with your own key.</p>' +
        '</div>' +

        '<div class="ais-section-label">Indexed Folders</div>' +
        '<div class="ais-folders-help">Each folder is indexed in its own mode. <strong>Metadata</strong> reads subjects, senders &amp; domains only. <strong>Full content</strong> also reads the email body so the AI can answer about amounts and details. Select folders to act on them, or use the buttons with nothing selected to act on all.</div>' +
        '<div class="ais-card ais-folders-card">' +
          '<div class="ais-folders-toolbar">' +
            '<span class="ais-folders-summary" id="aisFoldersSummary">Loading…</span>' +
            '<div class="ais-folders-actions" id="aisFolderActions"></div>' +
          '</div>' +
          '<div class="ais-folders-table-wrap">' +
            '<table class="ais-folders-table">' +
              '<thead><tr>' +
                '<th class="ais-check-col"><input type="checkbox" id="aisSelectAll" aria-label="Select all folders"></th>' +
                '<th>Folder</th><th class="ais-num">Mails</th><th>Read mode</th><th>Indexed</th><th>Last scanned</th>' +
              '</tr></thead>' +
              '<tbody id="aisFoldersBody"><tr><td colspan="6" class="ais-folders-empty">Loading folders…</td></tr></tbody>' +
            '</table>' +
          '</div>' +
        '</div>' +

        '<div class="ais-section-label">Categories</div>' +
        '<div class="ais-folders-help">Define your own categories and keywords (e.g. <strong>Investments</strong> → portfolio, mutual fund, NAV, SIP). They merge with the built-in groups in the Knowledge Map so it reflects your taxonomy.</div>' +
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

        '<div class="ais-section-label">Local AI</div>' +
        '<div class="ais-card' + (activeProvider === 'ollama' ? ' ais-card-active' : '') + '" id="aisCard_ollama">' +
          '<div class="ais-card-header">' +
            '<span class="ais-card-icon">🖥</span>' +
            '<div>' +
              '<div class="ais-card-name">Ollama (Local)</div>' +
              '<div class="ais-card-sub">100% private — runs on your machine</div>' +
            '</div>' +
            (chat.ollamaOk === false
              ? '<span class="ais-badge ais-badge-off">Offline</span>'
              : chat.ollamaOk === true
                ? '<span class="ais-badge ais-badge-ok">Online · ' + (chat.availableModels.length) + ' model' + (chat.availableModels.length !== 1 ? 's' : '') + '</span>'
                : '<span class="ais-badge">Checking…</span>') +
          '</div>' +
          '<div class="ais-card-body">' +
            (chat.ollamaOk === false
              ? '<div class="ais-ollama-hint">Install from <code>ollama.com</code> and run <code>ollama serve</code></div>'
              : (chat.model ? '<div class="ais-ollama-hint">Auto-selected: <strong>' + esc(chat.model) + '</strong></div>' : '')) +
            (activeProvider === 'ollama'
              ? '<div class="ais-active-row"><span class="ais-active-label">● Active provider</span></div>'
              : '<button class="ais-btn ais-btn-use" data-provider="ollama">Use this provider</button>') +
          '</div>' +
        '</div>' +

        '<div class="ais-section-label">Cloud AI</div>' +

        providerCard('openai', 'OpenAI', '✦', 'sk-...', CLOUD_MODELS.openai) +
        providerCard('anthropic', 'Anthropic', '◆', 'sk-ant-...', CLOUD_MODELS.anthropic) +
        providerCard('google', 'Google Gemini', '⬡', 'AIza...', CLOUD_MODELS.google) +
      '</div>';

    // Wire up folder table + global actions (read mode is per-folder, in the table)
    aisLoadFolderTable();
    aisWireGlobalActions();
    aisLoadCategories();
    aisWireCategoryAdd();

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
        if (chat.aiSettings[p]) chat.aiSettings[p].model = m;
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

  // Static "indexed N / mails" bar for a folder at rest.
  function aisIndexedCell(folder, count, total) {
    var pct  = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0;
    var done = total > 0 && count >= total;
    return '<td class="ais-indexed-cell" data-folder="' + esc(folder) + '">' +
      '<div class="ais-bar' + (done ? ' ais-bar-done' : '') + '">' +
        '<div class="ais-bar-fill" style="width:' + pct + '%"></div>' +
      '</div>' +
      '<span class="ais-bar-label">' + (done ? '✓ ' + fmtNum(count) : fmtNum(count) + ' / ' + fmtNum(total)) + '</span>' +
    '</td>';
  }

  // Live update a row's bar while it is actively syncing this run.
  function aisUpdateRowProgress(folder, done, total) {
    // Only fold a row into the live "Syncing" state when it has ACTUAL work. A multi-folder
    // job emits a {done:0,total:0} tick for folders with nothing new (already indexed) — those
    // must keep their static indexed bar, not flash "Syncing 0 / 0".
    if (!total || total <= 0) return;
    var cell = document.querySelector(aisFolderCellSelector(folder));
    if (!cell) return;
    var pct   = Math.min(100, Math.round((done / total) * 100));
    var bar   = cell.querySelector('.ais-bar');
    var fill  = cell.querySelector('.ais-bar-fill');
    var label = cell.querySelector('.ais-bar-label');
    if (bar)   { bar.classList.add('ais-bar-active'); bar.classList.remove('ais-bar-done'); }
    if (fill)  fill.style.width = pct + '%';
    if (label) label.textContent = 'Syncing ' + fmtNum(done) + ' / ' + fmtNum(total);
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

  function aisLoadFolderTable() {
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
      var bd   = res[1] || [];
      var bdMap = {};
      bd.forEach(function (b) { bdMap[b.folder] = b; });
      aisAllFolders = rows.map(function (f) { return f.name; });

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
        var modeCell = '<select class="ais-fmode-select" data-folder="' + esc(f.name) + '">' +
          '<option value="metadata"' + (mode === 'metadata' ? ' selected' : '') + '>Metadata</option>' +
          '<option value="content"'  + (mode === 'content'  ? ' selected' : '') + '>Full content</option>' +
          '</select>';

        return '<tr>' +
          '<td class="ais-check-col"><input type="checkbox" class="ais-row-check" data-folder="' + esc(f.name) + '"></td>' +
          '<td><div class="ais-fname">' + esc(f.name) + '</div>' +
            (f.mailboxName ? '<div class="ais-fmailbox">' + esc(f.mailboxName) + '</div>' : '') + '</td>' +
          '<td class="ais-num">' + fmtNum(f.mailCount || 0) + '</td>' +
          '<td>' + modeCell + '</td>' +
          aisIndexedCell(f.name, b.count, f.mailCount || 0) +
          '<td class="ais-fdate">' + aisFmtDate(f.lastScanned) + '</td>' +
        '</tr>';
      }).join('');

      if (summary) {
        summary.textContent = rows.length + ' folder' + (rows.length !== 1 ? 's' : '') +
          ' · ' + fmtNum(totalIndexed) + ' / ' + fmtNum(totalMails) + ' indexed';
      }

      // Row checkboxes
      body.querySelectorAll('.ais-row-check').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var folder = cb.getAttribute('data-folder');
          if (cb.checked) aisSelected[folder] = true; else delete aisSelected[folder];
          var all = document.getElementById('aisSelectAll');
          if (all) all.checked = aisSelCount() === aisAllFolders.length && aisAllFolders.length > 0;
          aisRenderToolbar();
        });
      });

      // Read-mode dropdowns — change persists + auto-rebuilds that folder in the new mode
      body.querySelectorAll('.ais-fmode-select').forEach(function (sel) {
        var prev = sel.value;
        sel.addEventListener('change', function () {
          var folder = sel.getAttribute('data-folder');
          var next   = sel.value;
          if (next === 'content') {
            var ok = window.confirm(
              'Read full content for "' + folder + '"?\n\n' +
              'This rebuilds the folder\'s index from email body text so the AI can answer ' +
              'about amounts and details. It may take a while for large folders.\n\nContinue?'
            );
            if (!ok) { sel.value = prev; return; }
          }
          sel.disabled = true;
          browser.runtime.sendMessage({ action: 'setFolderReadMode', folder: folder, mode: next })
            .then(function () {
              prev = next; sel.disabled = false;
              aisReindexFolders([folder], /* incremental */ false);
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

  // Live progress + refresh when an index run finishes, while Settings is visible.
  function aisSettingsVisible() {
    var v = document.getElementById('aisettingsView');
    return v && v.style.display !== 'none';
  }
  browser.runtime.onMessage.addListener(function (ev) {
    if (!aisSettingsVisible()) return;
    if (ev.action === 'vectorIndexProgress' && ev.folder) {
      aisUpdateRowProgress(ev.folder, ev.done || 0, ev.total || 0);
    } else if (ev.action === 'vectorIndexComplete' || ev.action === 'vectorIndexError') {
      aisLoadFolderTable();
    }
  });

})();
