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
    showThinking: true,
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
    ssRenderFolderChips();
    ssUpdateActiveModel();

    if (chat.history.length) {
      // Re-render existing conversation — skip greeting and Ollama check
      ssRerenderHistory();
      ssCheckOllama(); // still needed to know if send is available
      return;
    }

    ssCheckOllama();
    ssLoadIndexedFolders(); // will update greeting once stats arrive
    ssShowGreeting(false, ''); // placeholder — ssLoadIndexedFolders will update it

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

  function idRenderClusters(stats) {
    var shell = document.getElementById('idShell');
    if (!shell) return;
    var total = (stats && stats.total) ? stats.total : 0;

    shell.innerHTML = '<div class="id-graph-loading">Computing semantic space…</div>';

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
        '<div id="aisIndexingStatusCard"></div>' +
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

    aisLoadEmbeddingStatus();
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
          '<td><div class="ais-fname">' + esc(f.name) + '</div>' +
            (f.mailboxName ? '<div class="ais-fmailbox">' + esc(f.mailboxName) + ' · <span class="ais-fprovider">' + providerLabel + '</span></div>' : '') + '</td>' +
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

  // ── Indexes view (Mailbox → Indexes) ─────────────────────────────────────

  window.renderIndexes = function () {
    var panel = document.getElementById('indexesView');
    if (!panel) return;

    // Read active mail provider from localStorage to filter the table
    var activeMailProvider = localStorage.getItem('inboxpie-selected-provider') || 'apple-mail';
    var providerLabel = activeMailProvider === 'thunderbird' ? 'Thunderbird' : 'Apple Mail';

    panel.innerHTML =
      '<div class="ais-shell" id="aisIndexesShell">' +
        '<div class="ais-page">' +
          '<div class="ais-header">' +
            '<h2 class="ais-title">Indexes</h2>' +
            '<p class="ais-desc">Each folder is indexed in its own mode. <strong>Metadata</strong> reads subjects, senders &amp; domains only. <strong>Full content</strong> also reads the email body so the AI can answer about amounts and details.</p>' +
          '</div>' +
          '<div class="ais-provider-filter-note">Showing folders for <strong>' + esc(providerLabel) + '</strong></div>' +
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
        '</div>' +
      '</div>';

    aisLoadFolderTable(activeMailProvider);
    aisWireGlobalActions();
  };

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

  // Live progress + refresh when an index run finishes, while Indexes view is visible.
  function aisIndexesVisible() {
    var v = document.getElementById('indexesView');
    return v && v.style.display !== 'none';
  }
  browser.runtime.onMessage.addListener(function (ev) {
    if (!aisIndexesVisible()) return;
    if (ev.action === 'vectorIndexProgress' && ev.folder) {
      aisUpdateRowProgress(ev.folder, ev.done || 0, ev.total || 0);
    } else if (ev.action === 'vectorIndexComplete' || ev.action === 'vectorIndexError') {
      aisLoadFolderTable(localStorage.getItem('inboxpie-selected-provider') || 'apple-mail');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  BY CATEGORY view
  // ══════════════════════════════════════════════════════════════════════════

  var _catData = null; // cache until page reload

  window.renderCategories = function () {
    var panel = document.getElementById('categoriesView');
    if (!panel) return;
    var grid    = document.getElementById('categoriesGrid');
    var drillEl = document.getElementById('categoriesDrill');
    var chartEl = document.getElementById('categoriesChart');
    var topList = document.getElementById('categoriesTopList');
    var subtitle= document.getElementById('categoriesSubtitle');

    // Hide drill, show grid
    if (drillEl) drillEl.style.display = 'none';
    if (grid)    grid.style.display    = '';

    if (_catData) { anRenderCatUI(_catData); return; }

    if (grid) grid.innerHTML = '<div class="an-loading">Loading categories…</div>';

    browser.runtime.sendMessage({ action: 'getSemanticClusters' }).then(function (cats) {
      _catData = cats || [];
      anRenderCatUI(_catData);
    }).catch(function () {
      if (grid) grid.innerHTML = '<div class="an-empty">Could not load categories. Make sure emails are indexed in the Intelligence tab.</div>';
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
    browser.runtime.sendMessage({ action: 'getClusterEmails', label: label }).then(function(rows) {
      if (!rows || !rows.length) return;
      if (window._ip && window._ip.openCategoryReview) {
        window._ip.openCategoryReview(rows);
      }
    }).catch(function() {});
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUBSCRIPTIONS view
  // ══════════════════════════════════════════════════════════════════════════

  var _subData = null;
  var _subFreqFilter = 'All';

  window.renderSubscriptions = function () {
    var panel = document.getElementById('subscriptionsView');
    if (!panel) return;

    if (_subData) { anRenderSubUI(_subData, _subFreqFilter); return; }

    var grid = document.getElementById('subscriptionsGrid');
    if (grid) grid.innerHTML = '<div class="an-loading">Analyzing email patterns…</div>';

    browser.runtime.sendMessage({ action: 'getSubscriptionStats' }).then(function(data) {
      _subData = data || [];
      anRenderSubUI(_subData, _subFreqFilter);

      // Wire frequency tabs
      var tabs = document.getElementById('subscriptionsTabs');
      if (tabs) {
        tabs.querySelectorAll('.an-tab').forEach(function(btn) {
          btn.addEventListener('click', function() {
            tabs.querySelectorAll('.an-tab').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            _subFreqFilter = btn.getAttribute('data-freq');
            anRenderSubUI(_subData, _subFreqFilter);
          });
        });
      }
    }).catch(function() {
      if (grid) grid.innerHTML = '<div class="an-empty">Could not analyze subscriptions. Index your emails first.</div>';
    });
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
      subtitle.textContent = data.length + ' recurring senders detected · ' + newsletters + ' newsletters';
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
        var lastDate = s.last_date_unix ? new Date(s.last_date_unix * 1000).toLocaleDateString() : '—';
        var initial  = (s.domain || '?')[0].toUpperCase();
        var nlBadge  = s.is_newsletter ? '<span class="an-sub-badge an-sub-badge-nl">Newsletter</span>' : '';
        var freqBadge= '<span class="an-sub-badge an-sub-badge-freq">' + s.frequency + '</span>';
        return '<div class="an-sub-card">' +
          '<div class="an-sub-avatar">' + initial + '</div>' +
          '<div class="an-sub-body">' +
            '<div class="an-sub-domain">' + s.domain + '</div>' +
            '<div class="an-sub-badges">' + freqBadge + nlBadge + '</div>' +
            '<div class="an-sub-meta">Every ~' + s.avg_interval_days + ' days &nbsp;·&nbsp; ' + s.email_count + ' emails &nbsp;·&nbsp; Last: ' + lastDate + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
  }

})();
