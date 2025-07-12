// ==UserScript==
// @name         ChatGPT API By Browser Script (no‑dedupe)
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  Drive ChatGPT from your own websocket server – sends every answer, even identical ones
// @match        https://chatgpt.com/*
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  /* ---------------- configuration ---------------- */
  const WS_URL         = 'ws://localhost:8765';
  const FINAL_DELAY_MS = 3000;          // post‑stream safety wait
  const STOP_BTN_SEL   = [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]'
  ].join(',');

  const MODELS = ['gpt-4o', 'o4-mini', 'o4-mini-high', 'gpt-4-1'];

  const log   = (...a) => console.log('chatgpt‑api‑by‑browser‑script', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------------- main app --------------------- */
  class App {
      socket     = null;
      statusNode = null;
      observer   = null;
      modelIndex = 0;

      init() {
          window.addEventListener('load', () => {
              this._injectStatus();
              this._connect();
              this._ensureModel(MODELS[this.modelIndex]);
              setInterval(() => this._heartbeat(), 30_000);
          });
      }

      /* ---------- websocket plumbing ---------- */
      _connect() {
          this.socket = new WebSocket(WS_URL);

          this.socket.onopen   = () => this._setStatus('API Connected',    '#16a34a');
          this.socket.onclose  = () => { this._setStatus('API Disconnected','#ef4444');
                                         setTimeout(() => this._connect(), 2000); };
          this.socket.onerror  = () =>  this._setStatus('API Error',       '#ef4444');

          this.socket.onmessage = e => {
              try {
                  const req = JSON.parse(e.data);
                  if (req?.text) this._sendPrompt(req.text);
              } catch (err) { log('parse error', err); }
          };
      }

      _heartbeat() {
          if (this.socket?.readyState === WebSocket.OPEN) {
              this.socket.send(JSON.stringify({ type:'heartbeat' }));
          }
      }

      /* ------------- prompt handling ------------- */
      async _sendPrompt(text) {
          const editor = document.querySelector('div.ProseMirror[contenteditable="true"]');
          if (!editor) { log('editor not found'); return; }

          this._ensureModel(MODELS[this.modelIndex]);

          editor.focus();
          editor.innerHTML = text.replace(/\n/g,'<br>');
          editor.dispatchEvent(new Event('input', { bubbles:true }));
          await sleep(100);

          ['keydown','keyup'].forEach(t =>
              editor.dispatchEvent(new KeyboardEvent(t,{ key:'Enter', code:'Enter', bubbles:true }))
          );

          this._watchForAnswer();
      }

      /* ------------- answer collection ------------ */
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

          this.observer.observe(document.body, { childList:true, subtree:true });
      }

      _sendFinalAnswer() {
          // last conversation turn in the thread
          const lastArticle = document.querySelector(
              'article[data-testid^="conversation-turn-"]:last-of-type'
          );
          if (!lastArticle) { log('article not found'); return; }

          const md = lastArticle.querySelector(
              'div[data-message-author-role="assistant"] .markdown'
          );
          if (!md) { log('markdown not found'); return; }

          const text = md.innerText.trim();
          const the_model = this._getCurrentModel();
          this.socket.send(JSON.stringify({ type: 'answer', text, the_model }));
          if (the_model !== MODELS[this.modelIndex]) {
              this._switchModel();
          }
          this.socket.send(JSON.stringify({ type: 'stop'   }));
      }

      _getCurrentModel() {
          const urlModel = new URLSearchParams(location.search).get('model');
          const btn = document.querySelector('[data-testid="model-picker"] span')
                    || document.querySelector('[data-testid="model-switcher"] span');
          const uiModel = btn ? btn.textContent.trim().toLowerCase() : null;
          return uiModel || urlModel || '';
      }

      _ensureModel(model) {
          const url = new URL(location.href);
          if (url.searchParams.get('model') !== model) {
              url.searchParams.set('model', model);
              location.href = url.toString();
          }
      }

      _switchModel() {
          this.modelIndex = (this.modelIndex + 1) % MODELS.length;
          this._ensureModel(MODELS[this.modelIndex]);
      }


      /* ------------- UI helpers ------------------- */
      _injectStatus() {
          this.statusNode = Object.assign(document.createElement('div'), {
              style: 'position:fixed;top:10px;right:10px;z-index:9999;font-weight:600'
          });
          document.body.appendChild(this.statusNode);
      }

      _setStatus(t,c){
          if (this.statusNode) {
              this.statusNode.textContent = t;
              this.statusNode.style.color = c;
          }
      }
  }

  new App().init();
})();
