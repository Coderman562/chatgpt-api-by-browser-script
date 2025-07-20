// ==UserScript==
// @name         ChatGPT API By Browser Script
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Simplified script that exposes a WebSocket API for ChatGPT
// @match        https://chatgpt.com/*
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const WS_URL         = 'ws://localhost:8765';
  const STOP_BTN_SEL   = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]'
  ].join(',');

  const MODELS = [
    'gpt-4o',
    'gpt-4-1',
    'o4-mini',
    'o4-mini-high',
    'gpt-4-5'
  ];

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
    unavailable = new Set();
    pendingNewChat = false;

    // Initialize the script once the page loads
    init() {
      window.addEventListener('load', async () => {
        this._injectStatus();
        // Set up the conversation first so the correct model is active before
        // the websocket starts sending requests.
        await this._initConversation();
        this._connect();
        setInterval(() => this._heartbeat(), 30000);
      });
    }

    /* -------- websocket handling -------- */
    // Establish a websocket connection to the local API server
    _connect() {
      log('opening websocket', WS_URL);
      this.socket = new WebSocket(WS_URL);
      this.socket.onopen    = () => { log('websocket open'); this._setStatus('API Connected',    '#16a34a'); };
      this.socket.onclose   = () => { log('websocket closed'); this._setStatus('API Disconnected', '#ef4444');
                                      setTimeout(() => this._connect(), 2000); };
      this.socket.onerror   = err => { log('websocket error', err); this._setStatus('API Error',        '#ef4444'); };
      this.socket.onmessage = e => {
        try {
          const req = JSON.parse(e.data);
          if (req?.text) this._sendPrompt(req.text, !!req.newChat);
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

    /* -------- model management -------- */
    async _initConversation() {
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
        this._startChat(MODELS[this.modelIndex]);
      }
    }

    _startChat(model) {
      log('starting chat with', model);
      const url = new URL('/', location.origin);
      url.searchParams.set('model', model);
      // Persist the requested model so that if ChatGPT reloads the page without
      // it (which happens when the model is at capacity) _initConversation can
      // detect the failure on the next startup.
      sessionStorage.setItem('pendingModel', model);
      location.href = url.toString();
    }

    _newChat() {
      log('starting new chat thread');
      this._startChat(MODELS[this.modelIndex]);
    }

    _switchModel() {
      log('attempting model switch');
      for (let i = 1; i <= MODELS.length; i++) {
        const idx = (this.modelIndex + i) % MODELS.length;
        const candidate = MODELS[idx];
        if (!this.unavailable.has(candidate)) {
          this.modelIndex = idx;
          log('switching to model', candidate);
          this._startChat(candidate);
          return;
        }
      }
      log('All models exhausted');
    }

    _markUnavailable(model) {
      log('marking unavailable', model);
      this.unavailable.add(model);
    }

    _checkModelAfterAnswer() {
      // After an answer is finished, ChatGPT may silently switch to a different
      // model if the current one has hit its usage limit. Comparing the model
      // now lets us detect that automatic change and pick the next available
      // model from our list.
      if (this._getCurrentModel() !== MODELS[this.modelIndex]) {
        log('model changed after answer');
        this._markUnavailable(MODELS[this.modelIndex]);
        this._switchModel();
      }
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
      ['keydown', 'keyup'].forEach(t =>
        editor.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', bubbles: true }))
      );
      this._watchForAnswer();
    }

    /* ----------- answer collection ---------- */
    // Watch DOM mutations to know when ChatGPT has finished responding
    _watchForAnswer() {
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
    _sendFinalAnswer() {
      const lastArticle = document.querySelector('article[data-testid^="conversation-turn-"]:last-of-type');
      if (!lastArticle) { log('article not found'); return; }
      const md = lastArticle.querySelector('div[data-message-author-role="assistant"] .markdown');
      if (!md) { log('markdown not found'); return; }
      const text = md.innerText.trim();
      const the_model = this._getCurrentModel();
      log('final answer', { length: text.length, the_model });
      this.socket.send(JSON.stringify({ type: 'answer', text, the_model }));
      this.socket.send(JSON.stringify({ type: 'stop' }));
      this._checkModelAfterAnswer();
      if (this.pendingNewChat) {
        // Reload after sending the answer so the websocket receives it before
        // the page refreshes to start a new thread
        this.pendingNewChat = false;
        this._newChat();
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

