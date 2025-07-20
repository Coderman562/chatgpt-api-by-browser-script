// ==UserScript==
// @name         ChatGPT API By Browser Script
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Simplified script that exposes a WebSocket API for ChatGPT
// @match        https://chatgpt.com/*
// @grant        none
// @license      MIT
// ==/UserScript==

/*
  FLOW OVERVIEW
  -------------
  This script turns the ChatGPT web UI into a lightweight WebSocket API. A local
  server connects to the websocket and sends prompts in the following shape:

    { text: "prompt text", newChat?: boolean, webSearch?: boolean }

  When the page loads we restore any models that previously hit usage limits and
  attempt to start the conversation with the preferred model.  The `MODELS`
  array controls the order in which models are used.  If a model hits its daily
  quota we rotate to the next entry in the list and persist the timestamp so it
  won't be tried again until its cooldown in `MODEL_LIMITS` expires.

  Prompts received over the websocket are inserted into the page.  The script
  watches DOM changes to know when ChatGPT has finished responding.  Once the
  answer is complete it's sent back to the websocket client.

  Quota handling occurs in two ways:
    1. After each response we compare the page's displayed model to the model we
       believe is active.  If ChatGPT silently switched due to a quota hit we
       mark the old model unavailable and rotate to the next.
    2. Error messages such as "You've hit your limit" are detected and treated
       the same as a quota hit.

  When all models are temporarily exhausted we wait until the soonest cooldown
  expires before retrying.  A floating status indicator shows connection state
  and helps diagnose issues.
*/

(() => {
  'use strict';

  const WS_URL         = 'ws://localhost:8765';

  const MODELS = [
    'gpt-4o',
    'gpt-4-1',
    'o4-mini',
    'o4-mini-high',
    'gpt-4-5'
  ];

  // How long each model remains unavailable after hitting its quota
  const MODEL_LIMITS = {
    'gpt-4o':       3 * 60 * 60 * 1000, // 3 hours
    'gpt-4-1':      3 * 60 * 60 * 1000, // 3 hours
    'o4-mini':      24 * 60 * 60 * 1000, // 1 day
    'o4-mini-high': 24 * 60 * 60 * 1000, // 1 day
    'gpt-4-5':      7 * 24 * 60 * 60 * 1000 // 7 days
  };

  const log = (...a) => {
    const stamp = new Date().toISOString();
    console.log('chatgpt-api', stamp, ...a);
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  class App {
    socket = null;
    observer = null;
    statusNode = null;
    modelIndex = 0;
    // Map of unavailable models to the timestamp when they were blocked
    unavailableModels = new Map();
    pendingNewChat = false;
    // Timer id for the next model availability check
    waitTimer = null;
    // Promise that resolves when waiting for the next model ends
    waitPromise = null;

    // Initialize the script once the page loads
    init() {
      window.addEventListener('load', async () => {
        this._injectStatus();
        this._loadUnavailableModels();
        // Set up the conversation first so the correct model is active before
        // the websocket starts sending requests.
        await this._prepareConversation();
        this._openWebSocket();
        setInterval(() => this._heartbeat(), 30000);
      });
    }

    /* -------- websocket handling -------- */
    // Establish a websocket connection to the local API server
    _openWebSocket() {
      log('opening websocket', WS_URL);
      this.socket = new WebSocket(WS_URL);
      this.socket.onopen    = () => { log('websocket open'); this._setStatus('API Connected',    '#16a34a'); };
      this.socket.onclose   = () => { log('websocket closed'); this._setStatus('API Disconnected', '#ef4444');
                                      setTimeout(() => this._openWebSocket(), 2000); };
      this.socket.onerror   = err => { log('websocket error', err); this._setStatus('API Error',        '#ef4444'); };
      this.socket.onmessage = async e => {
        try {
          const req = JSON.parse(e.data);
          if (req?.text) {
            // webSearch defaults to true so every prompt will include web search
            // unless explicitly disabled by sending { webSearch: false }
            const enableSearch = req.webSearch ?? true;
            if (enableSearch) await this._ensureWebSearchState();
            this._sendPrompt(req.text, !!req.newChat);
          }
        } catch (err) { log('parse error', err); }
      };
    }

    // Periodically send keep-alive messages
    _heartbeat() {
      if (this.socket?.readyState === WebSocket.OPEN) {
        log('sending heartbeat');
        this.socket.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }

    // Load unavailable models from localStorage and drop any that have expired
    _loadUnavailableModels() {
      try {
        const data = JSON.parse(localStorage.getItem('unavailableModels') || '[]');
        this.unavailableModels = new Map(data);
      } catch (err) { log('failed to load unavailable', err); }
      this._purgeUnavailableModels();
    }

    // Persist the unavailable map to localStorage
    _saveUnavailableModels() {
      try {
        localStorage.setItem('unavailableModels', JSON.stringify(Array.from(this.unavailableModels.entries())));
      } catch (err) { log('failed to save unavailable', err); }
    }

    // Remove models whose cooldown has expired.  All timestamps are stored in
    // UTC using Date.now() so that time zone changes won't affect expiration
    // checks.  Each time this runs we log the reevaluation so usage patterns
    // can be audited.
    _purgeUnavailableModels() {
      const now = Date.now();
      log('re-evaluating model availability', new Date(now).toISOString());
      let changed = false;
      for (const [model, ts] of this.unavailableModels.entries()) {
        const limit = MODEL_LIMITS[model];
        const expire = ts + (limit || 0);
        const remainingMs = expire - now;
        const minutesLeft = Math.max(0, Math.ceil(remainingMs / 60000));
        log('  checking', model, 'cooldown left', minutesLeft, 'minute(s)');
        if (limit && remainingMs <= 0) {
          log('  model', model, 'cooldown expired');
          this.unavailableModels.delete(model);
          changed = true;
        }
      }
      if (changed) this._saveUnavailableModels();
    }

    /* -------- model management -------- */
    async _prepareConversation() {
      // The model selector button may not immediately reflect the selected
      // model after navigation. Waiting a moment avoids a race where we read
      // the previous model and think the switch failed.
      await sleep(1000);

      const pending = sessionStorage.getItem('pendingModel');
      const current = this._getCurrentModel();

      log('init conversation', { pending, current });

      // When a model hits its daily cap ChatGPT strips the ?model parameter and
      // refreshes the page. The refresh resets our script, so we persist the
      // attempted model in sessionStorage. On startup we compare that stored
      // value with the page's current model: if the parameter vanished or the
      // models differ, the switch was rejected due to limits.
      if (pending && (!location.search.includes('model=') || pending !== current)) {
        log('model usage cap hit', pending);
        this._markUnavailable(pending);
        sessionStorage.removeItem('pendingModel');
        this._switchModel();
        return;
      }
      sessionStorage.removeItem('pendingModel');

      if (current) {
        const idx = MODELS.indexOf(current);
        if (idx !== -1) {
          this.modelIndex = idx;
          log('current model index set', idx);
        }
      }

      if (this._getCurrentModel() !== MODELS[this.modelIndex]) {
        log('switching page model to', MODELS[this.modelIndex]);
        this._navigateToModel(MODELS[this.modelIndex]);
      }
    }

    _navigateToModel(model) {
      log('starting chat with', model);
      const url = new URL('/', location.origin);
      url.searchParams.set('model', model);
      // Persist the requested model so that if ChatGPT reloads the page without
      // it (which happens when the model is at capacity) _prepareConversation can
      // detect the failure on the next startup.
      sessionStorage.setItem('pendingModel', model);
      location.href = url.toString();
    }

    _startNewThread() {
      log('starting new chat thread');
      this._navigateToModel(MODELS[this.modelIndex]);
    }

    _switchModel() {
      log('attempting model switch');
      this._purgeUnavailableModels();
      for (let i = 1; i <= MODELS.length; i++) {
        const idx = (this.modelIndex + i) % MODELS.length;
        const candidate = MODELS[idx];
        if (!this.unavailableModels.has(candidate)) {
          this.modelIndex = idx;
          log('switching to model', candidate);
          this._navigateToModel(candidate);
          return;
        }
      }
      log('All models exhausted');
      this._waitForNextModel();
    }

    /**
     * When no models are immediately usable, wait for the soonest cooldown to
     * expire and try again. The timeout is stored so multiple calls don't stack
     * up when several prompts fail in a row.
     */
    _waitForNextModel() {
      if (this.waitTimer) return;

      let delay = 60 * 1000; // default to 1 minute
      const now = Date.now();
      for (const [model, ts] of this.unavailableModels.entries()) {
        const limit = MODEL_LIMITS[model];
        if (!limit) continue;
        const remaining = ts + limit - now;
        if (remaining > 0 && remaining < delay) delay = remaining;
      }

      log('waiting', delay, 'ms for next model; next check at', new Date(now + delay).toISOString());
      this.waitPromise = sleep(delay).then(() => {
        this.waitTimer = null;
        this.waitPromise = null;
        this._switchModel();
      });
      this.waitTimer = true;
    }

    _markUnavailable(model) {
      // Record the UTC timestamp when a model becomes unavailable so that the
      // cooldown can be calculated reliably even if the browser's timezone
      // changes between sessions.
      log('marking unavailable', model);
      this.unavailableModels.set(model, Date.now());
      this._saveUnavailableModels();
    }

    /**
     * After an answer completes ChatGPT might silently switch models when the
     * current one hits its quota. By comparing the displayed model with the one
     * we believe is active we can detect that automatic change and move on to
     * the next available model in our rotation.
     */
    _checkModelAfterAnswer() {
      if (this._getCurrentModel() !== MODELS[this.modelIndex]) {
        log('model changed after answer');
        this._markUnavailable(MODELS[this.modelIndex]);
        this._switchModel();
      }
    }

    /**
     * Some quota errors are shown inline without changing models. Usage
     * notifications do not have a consistent structure, so we scan the entire
     * article for known phrases such as "hit your limit" or "usage cap". The
     * presence of the regenerate error button also indicates the message.
     * When detected we handle it like a silent model swap and rotate to the
     * next model.
     */
    _checkLimitMessage(article) {
      const button = article.querySelector('[data-testid="regenerate-thread-error-button"]');
      const txt = article.textContent || '';
      if (/hit your limit/i.test(txt) || /usage cap/i.test(txt) || /usage limit/i.test(txt) || button) {
        log('usage limit message detected');
        this._markUnavailable(MODELS[this.modelIndex]);
        this._switchModel();
        return true;
      }
      return false;
    }

    /**
     * Consolidated post-answer checks for any indications that the chosen model
     * has reached its usage limit.
     */
    _postAnswerChecks(article) {
      this._checkModelAfterAnswer();
      this._checkLimitMessage(article);
    }

    // Check if the "Search" pill is present in the composer toolbar. The
    // pill only appears when the web search feature is active for the current
    // prompt.
    _isWebSearchOn() {
      const pills = document.querySelectorAll('button[data-pill][data-is-selected="true"]');
      return Array.from(pills).some(btn => /search/i.test(btn.textContent || ''));
    }

    // Ensure the web search tool is enabled. The menu DOM can change, so
    // elements are located by text rather than stable selectors.
    async _ensureWebSearchState() {
      if (this._isWebSearchOn()) return;

      const toolsBtn = document.getElementById('system-hint-button');
      if (!toolsBtn) { log('tools button not found'); return; }

      // Radix UI listens for pointer events to open the dropdown, so
      // programmatically dispatch them before the click.
      ['pointerdown', 'pointerup'].forEach(type =>
        toolsBtn.dispatchEvent(new PointerEvent(type, { bubbles: true }))
      );
      toolsBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // Wait briefly for the menu to render
      await sleep(100);

      // Locate the "Web search" menu item in the dropdown by text since there
      // is no stable identifier for it.
      const items = document.querySelectorAll('div[role="menuitemradio"]');
      const searchItem = Array.from(items).find(el => /web search/i.test(el.textContent || ''));
      if (!searchItem) { log('web search menu item not found'); return; }

      searchItem.click();

      // Give the UI time to update and close
      await sleep(100);
    }

    /* ------------ sending prompt ------------ */
    // Insert text into the editor and submit it. When newChat is true we queue
    // a fresh thread to start after the answer has been sent back to the server
    async _sendPrompt(text, newChat) {
      log('send prompt', { newChat, length: text.length });
      if (newChat) this.pendingNewChat = true;

      const editor = document.querySelector('div.ProseMirror[contenteditable="true"]');
      if (!editor) { log('editor not found'); return; }

      editor.focus();
      editor.innerHTML = text.replace(/\n/g, '<br>');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(100);
      this._submitEditor(editor);
      this._watchForAnswer();
    }

    // Simulate pressing Enter to submit the current editor contents
    _submitEditor(editor) {
      ['keydown', 'keyup'].forEach(t =>
        editor.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', bubbles: true }))
      );
    }

    /* ----------- answer collection ---------- */
    // Watch DOM mutations to know when ChatGPT has finished responding
    _watchForAnswer() {
      const STOP_BTN_SEL = [
        'button[data-testid="stop-button"]',
        'button[aria-label="Stop streaming"]',
        'button[aria-label="Stop generating"]'
      ].join(',');
      let started = false;
      log('watching for answer');
      this.observer?.disconnect();
      this.observer = new MutationObserver(() => {
        const stopBtn = document.querySelector(STOP_BTN_SEL);
        if (stopBtn) started = true;
        if (started && !stopBtn) {
          this.observer.disconnect();
          setTimeout(() => this._sendFinalAnswer(), 500);
        }
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
    }

    // Read the completed answer from the page and send it over the socket
    async _sendFinalAnswer() {
      const lastArticle = document.querySelector('article[data-testid^="conversation-turn-"]:last-of-type');
      if (!lastArticle) { log('article not found'); return; }
      const md = lastArticle.querySelector('div[data-message-author-role="assistant"] .markdown');
      if (!md) { log('markdown not found'); return; }
      const text = md.innerText.trim();
      const the_model = this._getCurrentModel();
      log('final answer', { length: text.length, the_model });
      // Check usage limits before replying to the server. If all models are
      // exhausted _switchModel() will schedule a wait via waitPromise which we
      // await so the server doesn't immediately send another prompt.
      this._postAnswerChecks(lastArticle);
      if (this.waitPromise) {
        log('delaying response until next model is available');
        await this.waitPromise;
      }
      this.socket.send(JSON.stringify({ type: 'answer', text, the_model }));
      this.socket.send(JSON.stringify({ type: 'stop' }));
      if (this.pendingNewChat) {
        // Reload after sending the answer so the websocket receives it before
        // the page refreshes to start a new thread
        this.pendingNewChat = false;
        this._startNewThread();
      }
    }


    // Determine which model is currently selected
    _getCurrentModel() {
      // The active model is displayed inside the selector button, e.g.:
      //   <button data-testid="model-switcher-dropdown-button" aria-label="Model selector, current model is 4o">ChatGPT <span>4o</span></button>
      // when the dropdown shows "ChatGPT o4-mini" or "ChatGPT 4.1". Because the
      // URL no longer includes the model name, reading this button is the only
      // reliable way to detect which model is active.
      // We normalize the label so variants like "ChatGPT 4.5" and "ChatGPT o4-mini-high"
      // map to the API style names such as "gpt-4-5" or "o4-mini-high".
      const btn = document.querySelector('button[data-testid="model-switcher-dropdown-button"]');
      if (!btn) return '';

      const label = btn.getAttribute('aria-label') || btn.textContent;
      if (!label) return '';
      const match = label.match(/current model is\s*(.+)$/i);
      const rawModel = match ? match[1] : label;
      const model = this._norm(rawModel.trim());
      log('current model detected', model);
      return model;
    }

    // Normalize a model string to the API's expected format
    _norm(m) {
      // Button labels look like "ChatGPT o4-mini-high" or "ChatGPT 4.1".
      // Strip the "ChatGPT"/"GPT" prefix, replace spaces and periods with
      // hyphens, then add the "gpt-" prefix when the name starts with a number
      // so "ChatGPT 4.5" becomes "gpt-4-5" and "ChatGPT o4-mini" stays
      // "o4-mini".
      m = m.toLowerCase().replace(/^chatgpt\s*/i, '').replace(/^gpt[\s-]*/i, '');
      m = m.replace(/\s+/g, '-').replace(/\./g, '-');
      if (/^[0-9]/.test(m)) m = 'gpt-' + m;
      return m;
    }

    /* -------------- status UI -------------- */
    // Create the floating status indicator element
    _injectStatus() {
      this.statusNode = Object.assign(document.createElement('div'), {
        style: 'position:fixed;top:10px;right:10px;z-index:9999;font-weight:600'
      });
      document.body.appendChild(this.statusNode);
      log('status indicator injected');
    }

    // Update text and color of the status indicator
    _setStatus(text, color) {
      if (!this.statusNode) return;
      this.statusNode.textContent = text;
      this.statusNode.style.color = color;
      log('status', text);
    }
  }

  new App().init();
})();

