// chat-widget.js
// This file's own URL (read while it runs; document.currentScript is null later
// inside the DOMContentLoaded callback). Sibling assets (the vendored marked)
// and the /terms/ page are resolved from it, so the site's baseurl is respected.
const CHAT_WIDGET_SRC = (document.currentScript && document.currentScript.src) ||
    (location.origin + '/assets/js/chat-widget.js');

document.addEventListener('DOMContentLoaded', function() {
    // marked (Markdown for the replies) is vendored in assets/js/markedlib/
    // (12.0.1, MIT) and loaded only when a reply or a stored conversation has
    // to be rendered. If it cannot load, replies are shown as plain text.
    const MARKED_URL = new URL('markedlib/marked.min.js', CHAT_WIDGET_SRC).href;
    const TERMS_URL = new URL('../../terms/', CHAT_WIDGET_SRC).href;

    // First inject the HTML for the chat widget
    const chatWidgetHTML = `
        <div id="chat-widget" class="chat-widget-container closed">
            <div class="chat-header">
                <div class="chat-header-buttons">
                    <button class="fullscreen-button" title="Toggle fullscreen" aria-label="Toggle fullscreen" aria-pressed="false">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                        </svg>
                    </button>
                    <button class="reset-button" title="Reset chat" aria-label="Reset chat">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                            <path d="M3 3v5h5"/>
                        </svg>
                    </button>
                </div>
                <span class="chat-title">Ask About My Research</span>
                <button class="minimize-button" aria-label="Open chat" aria-expanded="false" aria-controls="chat-content">+</button>
            </div>
            <div class="chat-content" id="chat-content" inert aria-hidden="true">
                <div id="chat-messages"></div>
                <div id="suggestion-chips" class="suggestion-chips">
                    <button class="suggestion-chip">Recent work summary</button>
                    <button class="suggestion-chip">Write a 50-word bio</button>
                    <button class="suggestion-chip">Get BibTeX entries</button>
                    <button class="suggestion-chip">Code availability</button>
                    <button class="suggestion-chip">How can I collaborate?</button>
                </div>
                <div class="chat-input">
                    <textarea id="user-input" placeholder="Ask me about Keane's research..." maxlength="2000" aria-label="Your question"></textarea>
                    <button id="send-button">Send</button>
                </div>
                <p class="chat-disclosure">Messages go to Anthropic's API through a Cloudflare Worker and stay in this browser until you reset the chat. <a class="chat-terms-link" href="">Privacy</a></p>
            </div>
        </div>
    `;

    // Add styles to document
    const styles = `
        .chat-widget-container {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 400px;
            background: #1a1a1a;
            border: 1px solid #2d2d2d;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 1050; /* above the masthead (20) and floating buttons (1000), below full-screen overlays like the PDF editor (1200) */
            transition: all 0.3s ease;
            display: flex;
            flex-direction: column;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
        }

        .chat-widget-container.closed {
            height: 48px;
            overflow: hidden;
        }

        .chat-widget-container.open {
            height: 600px;
        }

        .chat-widget-container.fullscreen {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100%;
            height: 100% !important;
            border-radius: 0;
            z-index: 1060;
        }

        .chat-header {
            padding: 12px 16px;
            background: #2d2d2d;
            border-radius: 8px 8px 0 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            user-select: none;
            z-index: 10000;
        }

        .chat-header-buttons {
            display: flex;
            gap: 8px;
        }

        .chat-title {
            color: #e0e0e0;
            font-weight: 500;
            flex-grow: 1;
            text-align: center;
        }

        .minimize-button,
        .fullscreen-button,
        .reset-button {
            background: none;
            border: none;
            color: #e0e0e0;
            cursor: pointer;
            padding: 4px;
            opacity: 0.7;
            transition: opacity 0.2s;
        }

        .minimize-button:hover,
        .fullscreen-button:hover,
        .reset-button:hover {
            opacity: 1;
        }

        .chat-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        #chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            color: #e0e0e0;
        }

        .suggestion-chips {
            padding: 12px;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            border-bottom: 1px solid #2d2d2d;
            background: #1a1a1a;
        }

        .suggestion-chips:empty {
            display: none;
            padding: 0;
        }

        .suggestion-chip {
            background: #2d2d2d;
            border: none;
            color: #e0e0e0;
            padding: 8px 12px;
            border-radius: 16px;
            cursor: pointer;
            transition: background 0.2s;
            font-size: 14px;
            white-space: nowrap;
        }

        .suggestion-chip:hover {
            background: #3d3d3d;
        }

        .chat-input {
            padding: 12px;
            border-top: 1px solid #2d2d2d;
            display: flex;
            gap: 8px;
            background: #1a1a1a;
        }

        #user-input {
            flex: 1;
            padding: 8px 12px;
            border: 1px solid #2d2d2d;
            border-radius: 4px;
            background: #2d2d2d;
            color: #e0e0e0;
            resize: none;
            min-height: 38px;
            max-height: 120px;
            font-family: inherit;
            font-size: 14px;
            line-height: 1.5;
        }

        #send-button {
            padding: 8px 16px;
            background: #4a9eff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            transition: background 0.2s;
            white-space: nowrap;
            font-family: inherit;
        }

        #send-button:hover {
            background: #357abd;
        }

        #send-button:disabled {
            background: #2d2d2d;
            cursor: not-allowed;
        }

        .message {
            margin-bottom: 12px;
            padding: 10px;
            border-radius: 4px;
            max-width: 85%;
            word-wrap: break-word;
            line-height: 1.5;
        }

        .user-message {
            background: #2d2d2d;
            margin-left: auto;
            color: #e0e0e0;
        }

        .claude-message {
            background: #1e3a5f;
            margin-right: auto;
            color: #e0e0e0;
        }

        .claude-message a {
            color: #4a9eff;
            text-decoration: none;
            border-bottom: 1px solid #4a9eff;
        }

        .claude-message a:hover {
            color: #357abd;
            border-bottom-color: #357abd;
        }

        .claude-message p {
            margin: 0 0 0.5em 0;
        }

        .claude-message p:last-child {
            margin-bottom: 0;
        }

        .claude-message ul, .claude-message ol {
            margin: 0.5em 0;
            padding-left: 1.5em;
        }

        .claude-message li {
            margin-bottom: 0.25em;
        }

        .claude-message code {
            background: #2d2d2d;
            padding: 0.2em 0.4em;
            border-radius: 3px;
            font-family: monospace;
        }

        .claude-message pre {
            background: #2d2d2d;
            padding: 1em;
            border-radius: 4px;
            overflow-x: auto;
            margin: 0.5em 0;
        }

        .claude-message pre code {
            background: none;
            padding: 0;
        }

        .claude-message.chat-plain {
            white-space: pre-wrap;
        }

        .claude-message table {
            border-collapse: collapse;
            margin: 0.5em 0;
            font-size: 0.9em;
        }

        .claude-message th,
        .claude-message td {
            border: 1px solid #3d3d3d;
            padding: 0.25em 0.5em;
        }

        .claude-message blockquote {
            margin: 0.5em 0;
            padding-left: 0.75em;
            border-left: 3px solid #3d3d3d;
        }

        .claude-message h1, .claude-message h2, .claude-message h3,
        .claude-message h4, .claude-message h5, .claude-message h6 {
            font-size: 1em;
            margin: 0.5em 0 0.25em;
        }

        /* The site's own table, code and (light theme) link colours would
           otherwise reach into the dark panel: the ID keeps these in charge. */
        #chat-widget .claude-message thead {
            background: #2d2d2d;
            border-bottom: 1px solid #3d3d3d;
        }

        #chat-widget .claude-message th,
        #chat-widget .claude-message td {
            color: #e0e0e0;
        }

        #chat-widget .claude-message code {
            background: #2d2d2d;
            color: #e0e0e0;
            border: 0;
        }

        #chat-widget .claude-message pre {
            background: #2d2d2d;
            color: #e0e0e0;
        }

        #chat-widget .claude-message pre code {
            background: none;
        }

        #chat-widget .claude-message a {
            color: #8fc0ff;
            border-bottom: 1px solid #8fc0ff;
        }

        #chat-widget .claude-message a:hover {
            color: #b8d8ff;
            border-bottom-color: #b8d8ff;
        }

        #chat-widget .chat-disclosure a {
            color: #8fc0ff;
        }

        .chat-welcome-list {
            margin: 0.5em 0;
            padding-left: 1.25em;
        }

        .chat-disclosure {
            margin: 0;
            padding: 0 12px 10px;
            background: #1a1a1a;
            color: #a8a8a8;
            font-size: 12px;
            line-height: 1.4;
        }

        .chat-disclosure a {
            color: #8fc0ff;
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .error-message {
            background: #5f1e1e;
            color: #e0e0e0;
            text-align: center;
            margin: 10px auto;
        }

        .loading-message {
            background: #1e3a5f;
            margin-right: auto;
            color: #e0e0e0;
            text-align: left;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .loading-dots {
            display: inline-flex;
            gap: 2px;
        }

        .loading-dots span {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: #4a9eff;
            animation: loading-bounce 1.4s infinite ease-in-out both;
        }

        .loading-dots span:nth-child(1) { animation-delay: -0.32s; }
        .loading-dots span:nth-child(2) { animation-delay: -0.16s; }
        .loading-dots span:nth-child(3) { animation-delay: 0s; }

        @keyframes loading-bounce {
            0%, 80%, 100% {
                transform: scale(0);
            }
            40% {
                transform: scale(1);
            }
        }

        @media (max-width: 768px) {
            .chat-widget-container {
                bottom: 0;
                right: 0;
                width: 100%;
                border-radius: 8px 8px 0 0;
            }
            
            .chat-widget-container.open {
                height: 80vh;
                height: 80dvh;
            }

            /* Full-screen gadget pages (.life-app): the bottom bar would cover the
               canvas (lander ground, epidemic curve), so hide the widget on phones. */
            .chat-widget-container.chat-widget--immersive {
                display: none;
            }
        }

        /* Phones in landscape are wider than 768 px but only about 390 px tall:
           the bar would sit over the gadget's controls there too. */
        @media (pointer: coarse) and (max-height: 500px) {
            .chat-widget-container.chat-widget--immersive {
                display: none;
            }
        }

        /* Touch: header buttons get 40 x 40 targets; the header padding shrinks
           so the closed bar keeps its 48 px height. */
        @media (pointer: coarse) {
            .chat-header {
                padding: 3px 8px;
            }

            .minimize-button,
            .fullscreen-button,
            .reset-button {
                min-width: 40px;
                min-height: 40px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
            }

            .minimize-button {
                font-size: 20px;
            }
        }
    `;

    // Add styles to document
    const styleSheet = document.createElement("style");
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    // Inject the chat widget HTML into the body
    document.body.insertAdjacentHTML('beforeend', chatWidgetHTML);

    // Full-screen gadget pages get a class so the mobile CSS can hide the bottom bar
    if (document.querySelector('.life-app')) {
        document.getElementById('chat-widget').classList.add('chat-widget--immersive');
    }

    // Constants and state
    const WORKER_URL = 'https://flat-bread-e3e2.keenlooks-cloudflare.workers.dev/';
    const LOG_KEY = 'claudeChatLog';          // JSON: { v: 2, log: [{ role, text }] }
    const LEGACY_KEY = 'claudeChatHistory';   // pre-2026-10 rendered HTML: never rendered again, dropped
    const LOG_MAX = 60;                       // messages kept in storage
    let isLoading = false;
    let chatLog = [];                         // [{ role: 'user' | 'assistant', text }]

    const widget = document.getElementById('chat-widget');
    const content = widget.querySelector('.chat-content');
    const messagesDiv = document.getElementById('chat-messages');
    const suggestionsDiv = document.getElementById('suggestion-chips');
    const header = widget.querySelector('.chat-header');
    const fullscreenButton = widget.querySelector('.fullscreen-button');
    const resetButton = widget.querySelector('.reset-button');
    const minimizeButton = widget.querySelector('.minimize-button');
    const sendButton = document.getElementById('send-button');
    const userInput = document.getElementById('user-input');
    const suggestionChips = widget.querySelectorAll('.suggestion-chip');
    widget.querySelector('.chat-terms-link').setAttribute('href', TERMS_URL);

    // Welcome message (a fixed string of ours, so innerHTML is safe here)
    const welcomeMessage = `<p>Hi! I'm an AI assistant who can tell you about Keane's work in:</p>
    <ul class="chat-welcome-list">
    <li>Frontier AI cyber capabilities (Anthropic Frontier Red Team)</li>
    <li>Claude in CTFs and exploit benchmarks</li>
    <li>ML-based malware detection</li>
    <li>Adversarial and robust ML</li>
    </ul>
    <p>How can I help you today?</p>`;

    // ---- storage (every call guarded: storage can be blocked or full) ----
    function storeGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function storeSet(key, value) {
        try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
    }
    function storeRemove(key) {
        try { window.localStorage.removeItem(key); } catch (e) { /* storage blocked */ }
    }

    function readLog() {
        // The old format stored the rendered HTML of the panel and wrote it back
        // with innerHTML on every page. It is never rendered again: drop it.
        if (storeGet(LEGACY_KEY) !== null) storeRemove(LEGACY_KEY);
        const raw = storeGet(LOG_KEY);
        if (!raw) return [];
        try {
            const data = JSON.parse(raw);
            const log = data && data.v === 2 && Array.isArray(data.log) ? data.log : null;
            if (!log) throw new Error('bad shape');
            return log.filter(m => m && (m.role === 'user' || m.role === 'assistant') &&
                typeof m.text === 'string').slice(-LOG_MAX);
        } catch (e) {
            storeRemove(LOG_KEY);
            return [];
        }
    }

    function saveLog() {
        storeSet(LOG_KEY, JSON.stringify({ v: 2, log: chatLog.slice(-LOG_MAX) }));
    }

    // ---- Markdown rendering ----
    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    let markedConfigured = false;
    function markedReadyNow() {
        const m = window.marked;
        if (!m || typeof m.parse !== 'function' || typeof m.use !== 'function') return false;
        if (!markedConfigured) {
            markedConfigured = true;
            m.use({
                breaks: true,
                gfm: true,
                renderer: {
                    // Raw HTML in a reply is shown as text, never parsed as HTML.
                    // (marked 12 passes (html, block); later versions pass a token.)
                    html(html, block) {
                        const text = html && typeof html === 'object' ? html.text : html;
                        const isBlock = html && typeof html === 'object' ? html.block : block;
                        const out = escapeHtml(text == null ? '' : text);
                        return isBlock ? '<p>' + out + '</p>' : out;
                    },
                    // No remote images in replies: show the alt text instead.
                    image(href, title, text) {
                        const alt = href && typeof href === 'object' ? href.text : text;
                        return escapeHtml(alt == null ? '' : alt);
                    }
                }
            });
        }
        return true;
    }

    let markedPromise = null;
    function ensureMarked() {
        if (markedReadyNow()) return Promise.resolve(true);
        if (markedPromise) return markedPromise;
        markedPromise = new Promise(resolve => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                resolve(markedReadyNow());
            };
            const script = document.createElement('script');
            script.src = MARKED_URL;
            script.async = true;
            script.onload = finish;
            script.onerror = finish;
            setTimeout(finish, 8000);
            document.head.appendChild(script);
        });
        return markedPromise;
    }

    // Second line of defence after the escaping above: only these tags and
    // attributes survive, links keep http(s) and mailto URLs only.
    const ALLOWED_TAGS = new Set(['P', 'BR', 'STRONG', 'EM', 'B', 'I', 'DEL', 'S', 'CODE', 'PRE',
        'UL', 'OL', 'LI', 'A', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR']);
    const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
        'NOSCRIPT', 'TEXTAREA', 'SELECT', 'SVG', 'MATH']);

    function cleanTree(node) {
        Array.from(node.childNodes).forEach(child => {
            if (child.nodeType === Node.TEXT_NODE) return;
            if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); return; }
            const tag = child.tagName.toUpperCase();
            if (DROP_WITH_CONTENT.has(tag)) { child.remove(); return; }
            cleanTree(child);
            if (!ALLOWED_TAGS.has(tag)) {
                while (child.firstChild) node.insertBefore(child.firstChild, child);
                child.remove();
                return;
            }
            Array.from(child.attributes).forEach(attr => {
                const name = attr.name.toLowerCase();
                const keep = (tag === 'A' && name === 'href') ||
                    ((tag === 'TH' || tag === 'TD') && name === 'align') ||
                    (tag === 'OL' && name === 'start');
                if (!keep) child.removeAttribute(attr.name);
            });
            if (tag === 'A') {
                let ok = false;
                try {
                    const url = new URL(child.getAttribute('href') || '', location.href);
                    ok = url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
                } catch (e) { ok = false; }
                if (ok) {
                    child.setAttribute('target', '_blank');
                    child.setAttribute('rel', 'noopener noreferrer');
                } else {
                    child.removeAttribute('href');
                }
            }
        });
    }

    function fillReply(el, text) {
        if (markedReadyNow()) {
            let html = null;
            try { html = window.marked.parse(String(text)); } catch (e) { html = null; }
            if (typeof html === 'string') {
                // A <template> parses without running anything or loading images.
                const tpl = document.createElement('template');
                tpl.innerHTML = html;
                cleanTree(tpl.content);
                el.classList.remove('chat-plain');
                el.textContent = '';
                el.appendChild(tpl.content);
                return;
            }
        }
        // marked unavailable: plain text, line breaks kept by CSS
        el.classList.add('chat-plain');
        el.textContent = String(text);
    }

    function appendMessage(role, text) {
        const div = document.createElement('div');
        if (role === 'user') {
            div.className = 'message user-message';
            div.textContent = text;
        } else {
            div.className = 'message claude-message';
            fillReply(div, text);
        }
        messagesDiv.appendChild(div);
        return div;
    }

    function showWelcomeMessage() {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'message claude-message';
        welcomeDiv.innerHTML = welcomeMessage;
        messagesDiv.appendChild(welcomeDiv);
    }

    // Restores the stored conversation once (on idle, on open, or before a send,
    // whichever comes first).
    let restorePromise = null;
    let resetCount = 0;
    function restoreOnce() {
        if (restorePromise) return restorePromise;
        const gen = resetCount;
        restorePromise = (async () => {
            const log = readLog();
            if (log.length) await ensureMarked();
            if (gen !== resetCount) return;   // the chat was reset meanwhile
            chatLog = log;
            messagesDiv.textContent = '';
            showWelcomeMessage();
            chatLog.forEach(m => appendMessage(m.role, m.text));
            suggestionsDiv.style.display = chatLog.length ? 'none' : '';
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        })();
        return restorePromise;
    }

    // ---- open / close ----
    function setOpen(open) {
        widget.classList.toggle('open', open);
        widget.classList.toggle('closed', !open);
        minimizeButton.textContent = open ? '−' : '+';
        minimizeButton.setAttribute('aria-label', open ? 'Minimize chat' : 'Open chat');
        minimizeButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        // A closed panel is 0 px tall: take its controls out of the tab order
        // and the accessibility tree so nothing hidden can take focus or keys.
        if (open) {
            content.removeAttribute('inert');
            content.removeAttribute('aria-hidden');
        } else {
            content.setAttribute('inert', '');
            content.setAttribute('aria-hidden', 'true');
        }
    }

    function setFullscreen(on) {
        widget.classList.toggle('fullscreen', on);
        fullscreenButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    function openChat() {
        setOpen(true);
        restoreOnce();
        ensureMarked();
        // Put the cursor in the input on desktop (also lets Escape close the
        // panel right away); skip on phones so the keyboard doesn't pop up.
        if (window.matchMedia('(min-width: 769px)').matches) {
            /* setTimeout(0): a real click's default action can move focus to
               <body> after this handler and undo a synchronous focus() */
            setTimeout(() => userInput.focus(), 0);
        }
    }

    function minimizeChat() {
        const active = document.activeElement;
        const focusWasInside = !!(active && widget.contains(active));
        setFullscreen(false);
        setOpen(false);
        // Focus goes back to the toggle that opens the chat, not to <body>
        if (focusWasInside) minimizeButton.focus();
    }

    function toggleFullscreen() {
        if (!widget.classList.contains('open')) {
            // Fullscreen from the closed bar opens the chat too, so the header
            // reads "Minimize" and the panel is not inert.
            openChat();
            setFullscreen(true);
            return;
        }
        setFullscreen(!widget.classList.contains('fullscreen'));
    }

    function resetChat() {
        resetCount++;
        chatLog = [];
        restorePromise = Promise.resolve();
        messagesDiv.textContent = '';
        showWelcomeMessage();
        suggestionsDiv.style.display = '';
        storeRemove(LOG_KEY);
        storeRemove(LEGACY_KEY);
    }

    async function sendMessage(text = null) {
        const messageText = (text || userInput.value).trim();
        if (isLoading || !messageText) return;

        isLoading = true;
        sendButton.disabled = true;
        if (!text) userInput.disabled = true;

        // Declared outside the try so the catch can remove it on fetch failure
        let loadingMessage = null;
        try {
            await restoreOnce();
            suggestionsDiv.style.display = 'none';

            appendMessage('user', messageText);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;

            // Show loading indicator
            loadingMessage = document.createElement('div');
            loadingMessage.className = 'message loading-message';
            loadingMessage.innerHTML = `
                <span>Thinking</span>
                <div class="loading-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            `;
            messagesDiv.appendChild(loadingMessage);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;

            let response;
            try {
                response = await fetch(WORKER_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        messages: [{
                            role: 'user',
                            content: messageText
                        }]
                    })
                });
            } catch (e) {
                throw new Error('Could not reach the assistant. Check your connection and try again.');
            }

            let data = null;
            try { data = await response.json(); } catch (e) { data = null; }

            if (!response.ok) {
                throw new Error((data && typeof data.error === 'string' && data.error) ||
                    ('The assistant could not answer right now (HTTP ' + response.status + ').'));
            }

            let claudeResponseText = '';
            if (data && Array.isArray(data.content)) {
                claudeResponseText = data.content
                    .filter(item => item && item.type === 'text' && typeof item.text === 'string')
                    .map(item => item.text)
                    .join('\n');
            } else {
                throw new Error('Unexpected response format from Claude');
            }

            await ensureMarked();

            // Remove loading indicator
            messagesDiv.removeChild(loadingMessage);
            loadingMessage = null;

            appendMessage('assistant', claudeResponseText);
            chatLog.push({ role: 'user', text: messageText }, { role: 'assistant', text: claudeResponseText });
            saveLog();
            messagesDiv.scrollTop = messagesDiv.scrollHeight;

        } catch (error) {
            console.error('Error:', error);

            // Remove loading indicator if it exists
            if (loadingMessage && loadingMessage.parentNode) {
                messagesDiv.removeChild(loadingMessage);
            }

            const errorMessage = document.createElement('div');
            errorMessage.className = 'message error-message';
            errorMessage.textContent = 'Error: ' + (error && error.message ? error.message : String(error));
            messagesDiv.appendChild(errorMessage);
        } finally {
            isLoading = false;
            sendButton.disabled = false;
            if (!text) {
                userInput.disabled = false;
                userInput.value = '';
            }
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
    }

    // Add event listeners
    // Prevent parent click when clicking buttons
    fullscreenButton.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFullscreen();
    });

    resetButton.addEventListener('click', (e) => {
        e.stopPropagation();
        resetChat();
    });

    // Handle suggestion chip clicks
    suggestionChips.forEach(chip => {
        chip.addEventListener('click', () => {
            sendMessage(chip.textContent.trim());
        });
    });

    header.addEventListener('click', function() {
        if (widget.classList.contains('open')) {
            minimizeChat();
            return;
        }
        openChat();
    });

    // Escape minimizes the open chat (leaving fullscreen first). Scoped to when
    // focus is inside the widget so pages with their own Escape behavior
    // (gadgets, canvas editors) keep it when the user is working in the page.
    // Capture phase + stopPropagation keeps a chat-scoped Escape from also
    // triggering those page handlers.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!widget.classList.contains('open')) return;
        const active = document.activeElement;
        const inWidget = widget.contains(e.target) || (active && widget.contains(active));
        if (!inWidget) return;
        e.stopPropagation();
        if (widget.classList.contains('fullscreen')) {
            setFullscreen(false);
            return;
        }
        minimizeChat();
    }, true);

    // Prevent chat from minimizing when clicking inside
    widget.addEventListener('click', (e) => {
        if (!e.target.closest('.chat-header')) {
            e.stopPropagation();
        }
    });

    sendButton.addEventListener('click', () => sendMessage());
    userInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Load chat state and show welcome message if needed.
    // r24 (1): restoring a long history measured 117 to 240 ms on a cold
    // landing, which lands in the middle of the first paint of whatever page
    // is under it. It waits for the browser's own idle moment, with a 2 s
    // timeout so a busy page still gets its history, and a straight call where
    // requestIdleCallback is not available. The widget starts closed and
    // nobody can read this panel before it is opened (opening restores at once).
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => { restoreOnce(); }, { timeout: 2000 });
    } else {
        restoreOnce();
    }

    // Prevent link clicks from minimizing chat
    document.addEventListener('click', (e) => {
        if (e.target.tagName === 'A' && e.target.closest('.chat-widget-container')) {
            e.stopPropagation();
        }
    });
});
