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
  const FINAL_DELAY_MS = 3000;
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

  const log   = (...a) => console.log('chatgpt-api', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  class App {
    socket = null;
    observer = null;
    statusNode = null;
    modelIndex = 0;
    unavailable = new Set();

    // Initialize the script once the page loads
    init() {
      window.addEventListener('load', () => {
        this._injectStatus();
        this._connect();
        this._initConversation();
        setInterval(() => this._heartbeat(), 30000);
      });
    }

    /* -------- websocket handling -------- */
    // Establish a websocket connection to the local API server
    _connect() {
      this.socket = new WebSocket(WS_URL);
      this.socket.onopen    = () => this._setStatus('API Connected',    '#16a34a');
      this.socket.onclose   = () => { this._setStatus('API Disconnected', '#ef4444');
                                      setTimeout(() => this._connect(), 2000); };
      this.socket.onerror   = () => this._setStatus('API Error',        '#ef4444');
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
        this.socket.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }

    /* -------- model management -------- */
    _initConversation() {
      const current = this._getCurrentModel();
      if (current) {
        const idx = MODELS.indexOf(current);
        if (idx !== -1) this.modelIndex = idx;
      }

      if (this._getCurrentModel() !== MODELS[this.modelIndex]) {
        this._startChat(MODELS[this.modelIndex]);
        setTimeout(() => {
          if (this._getCurrentModel() !== MODELS[this.modelIndex]) {
            this._markUnavailable(MODELS[this.modelIndex]);
            this._switchModel();
          }
        }, 1000);
      }
    }

    _startChat(model) {
      const url = new URL('/', location.origin);
      url.searchParams.set('model', model);
      location.href = url.toString();
      // After navigation ChatGPT may drop the ?model parameter if the model
      // has already hit its usage limit. Checking for that redirect lets us
      // know the model is unavailable.
      setTimeout(() => {
        if (!location.search.includes('model=')) {
          this._markUnavailable(model);
          this._switchModel();
        }
      }, 1000);
    }

    _newChat() {
      this._startChat(MODELS[this.modelIndex]);
    }

    _switchModel() {
      for (let i = 1; i <= MODELS.length; i++) {
        const idx = (this.modelIndex + i) % MODELS.length;
        const candidate = MODELS[idx];
        if (!this.unavailable.has(candidate)) {
          this.modelIndex = idx;
          this._startChat(candidate);
          return;
        }
      }
      log('All models exhausted');
    }

    _markUnavailable(model) {
      this.unavailable.add(model);
    }

    _checkModelAfterAnswer() {
      if (this._getCurrentModel() !== MODELS[this.modelIndex]) {
        this._markUnavailable(MODELS[this.modelIndex]);
        this._switchModel();
      }
    }

    /* ------------ sending prompt ------------ */
    // Insert text into the editor and submit it. If newChat is true, start a fresh thread
    async _sendPrompt(text, newChat) {
      if (newChat) { this._newChat(); return; }

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
      this.observer?.disconnect();
      this.observer = new MutationObserver(() => {
        const stopBtn = document.querySelector(STOP_BTN_SEL);
        if (stopBtn) started = true;
        if (started && !stopBtn) {
          this.observer.disconnect();
          setTimeout(() => this._sendFinalAnswer(), FINAL_DELAY_MS);
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
      this.socket.send(JSON.stringify({ type: 'answer', text, the_model }));
      this.socket.send(JSON.stringify({ type: 'stop' }));
      this._checkModelAfterAnswer();
    }


    // Determine which model is currently selected
    _getCurrentModel() {
      const urlModel = new URLSearchParams(location.search).get('model');
      if (urlModel) return this._norm(urlModel);
      const btn = document.querySelector('[data-testid="model-picker"] span') ||
                  document.querySelector('[data-testid="model-switcher"] span');
      return btn ? this._norm(btn.textContent.trim()) : '';
    }

    // Normalize a model string to the API's expected format
    _norm(m) {
      return m.toLowerCase().replace(/\s+/g, '').replace(/\./g, '-');
    }

    /* -------------- status UI -------------- */
    // Create the floating status indicator element
    _injectStatus() {
      this.statusNode = Object.assign(document.createElement('div'), {
        style: 'position:fixed;top:10px;right:10px;z-index:9999;font-weight:600'
      });
      document.body.appendChild(this.statusNode);
    }

    // Update text and color of the status indicator
    _setStatus(text, color) {
      if (!this.statusNode) return;
      this.statusNode.textContent = text;
      this.statusNode.style.color = color;
    }
  }

  new App().init();
})();

