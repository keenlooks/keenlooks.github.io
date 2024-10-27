// chat-widget.js
document.addEventListener('DOMContentLoaded', function() {
    // First load marked library
    const markedScript = document.createElement('script');
    markedScript.src = 'https://cdn.jsdelivr.net/npm/marked@12.0.1/lib/marked.umd.min.js';
    document.head.appendChild(markedScript);

    // First inject the HTML for the chat widget
    const chatWidgetHTML = `
        <div id="chat-widget" class="chat-widget-container closed">
            <div class="chat-header">
                <div class="chat-header-buttons">
                    <button class="fullscreen-button" title="Toggle fullscreen">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                        </svg>
                    </button>
                    <button class="reset-button" title="Reset chat">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                            <path d="M3 3v5h5"/>
                        </svg>
                    </button>
                </div>
                <span class="chat-title">Ask About My Research</span>
                <button class="minimize-button">+</button>
            </div>
            <div class="chat-content">
                <div id="chat-messages"></div>
                <div id="suggestion-chips" class="suggestion-chips">
                    <button class="suggestion-chip">🔍 Tell me about recent work</button>
                    <button class="suggestion-chip">✍️ Write a 50-word bio</button>
                    <button class="suggestion-chip">📚 Get BibTeX entries</button>
                    <button class="suggestion-chip">💻 Code availability</button>
                    <button class="suggestion-chip">👥 How can I collaborate?</button>
                </div>
                <div class="chat-input">
                    <textarea id="user-input" placeholder="Ask me about Keane's research..."></textarea>
                    <button id="send-button">Send</button>
                </div>
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
            z-index: 9999;
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
            z-index: 10000;
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

        .error-message {
            background: #5f1e1e;
            color: #e0e0e0;
            text-align: center;
            margin: 10px auto;
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
            }
        }
    `;

    // Add styles to document
    const styleSheet = document.createElement("style");
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    // Inject the chat widget HTML into the body
    document.body.insertAdjacentHTML('beforeend', chatWidgetHTML);

    // Constants and state
    const WORKER_URL = 'https://flat-bread-e3e2.keenlooks-cloudflare.workers.dev/';
    let isLoading = false;

    // Welcome message with explicit <br> tags
    const welcomeMessage = `👋 Hi! I'm an AI assistant who can tell you about Keane's research in:<br><br>
    🛡️ AI Safety<br>
    🦠 ML-based Malware Detection<br>
    🤝 Cooperative Multi-agent RL<br>
    🔒 National Security<br><br>
    How can I help you today?`;

    // Set up marked options
    markedScript.onload = function() {
        marked.use({
            breaks: true,
            gfm: true
        });
    };

    function showWelcomeMessage() {
        const messagesDiv = document.getElementById('chat-messages');
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'message claude-message';
        welcomeDiv.innerHTML = welcomeMessage;  // Use innerHTML to interpret <br> tags
        messagesDiv.appendChild(welcomeDiv);
    }


    function saveChatState() {
        const messagesDiv = document.getElementById('chat-messages');
        if (messagesDiv) {
            localStorage.setItem('claudeChatHistory', messagesDiv.innerHTML);
        }
    }

    function loadChatState() {
        const messagesDiv = document.getElementById('chat-messages');
        const savedMessages = localStorage.getItem('claudeChatHistory');
        if (messagesDiv) {
            if (savedMessages) {
                messagesDiv.innerHTML = savedMessages;
                document.getElementById('suggestion-chips').style.display = 'none';
            } else {
                showWelcomeMessage();
            }
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
    }

    function toggleFullscreen() {
        const widget = document.getElementById('chat-widget');
        widget.classList.toggle('fullscreen');
    }

    function resetChat() {
        const messagesDiv = document.getElementById('chat-messages');
        const suggestionsDiv = document.getElementById('suggestion-chips');
        
        // Clear messages and show welcome message
        messagesDiv.innerHTML = '';
        showWelcomeMessage();
        
        // Show suggestions
        suggestionsDiv.style.display = 'flex';
        
        // Clear localStorage
        localStorage.removeItem('claudeChatHistory');
    }

    async function sendMessage(text = null) {
        const userInput = document.getElementById('user-input');
        const sendButton = document.getElementById('send-button');
        const messagesDiv = document.getElementById('chat-messages');
        
        const messageText = text || userInput.value.trim();
        if (isLoading || !messageText) return;
        
        isLoading = true;
        sendButton.disabled = true;
        if (!text) userInput.disabled = true;
        
        try {
            // Hide suggestions
            document.getElementById('suggestion-chips').style.display = 'none';

            const userMessage = document.createElement('div');
            userMessage.className = 'message user-message';
            userMessage.textContent = messageText;
            messagesDiv.appendChild(userMessage);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;

            const response = await fetch(WORKER_URL, {
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

            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'Failed to get response');
            }

            let claudeResponseText = '';
            if (data.content && Array.isArray(data.content)) {
                claudeResponseText = data.content
                    .filter(item => item.type === 'text')
                    .map(item => item.text)
                    .join('\n');
            } else {
                throw new Error('Unexpected response format from Claude');
            }

            const claudeMessage = document.createElement('div');
            claudeMessage.className = 'message claude-message';
            claudeMessage.innerHTML = marked.parse(claudeResponseText);

            // Make links safe and open in new tab
            claudeMessage.querySelectorAll('a').forEach(link => {
                link.setAttribute('target', '_blank');
                link.setAttribute('rel', 'noopener noreferrer');
            });

            messagesDiv.appendChild(claudeMessage);
            saveChatState();
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            
        } catch (error) {
            console.error('Error:', error);
            const errorMessage = document.createElement('div');
            errorMessage.className = 'message error-message';
            errorMessage.textContent = 'Error: ' + error.message;
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
    const header = document.querySelector('.chat-header');
    const fullscreenButton = document.querySelector('.fullscreen-button');
    const resetButton = document.querySelector('.reset-button');
    const sendButton = document.getElementById('send-button');
    const userInput = document.getElementById('user-input');
    const suggestionChips = document.querySelectorAll('.suggestion-chip');

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
            sendMessage(chip.textContent);
        });
    });

    header.addEventListener('click', function() {
        const widget = document.getElementById('chat-widget');
        const minimizeButton = widget.querySelector('.minimize-button');
        const isOpen = widget.classList.contains('open');
        
        widget.classList.toggle('open');
        widget.classList.toggle('closed');
        minimizeButton.textContent = isOpen ? '+' : '−';
    });

    // Prevent chat from minimizing when clicking inside
    document.getElementById('chat-widget').addEventListener('click', (e) => {
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

    // Load chat state and show welcome message if needed
    loadChatState();

    // Prevent link clicks from minimizing chat
    document.addEventListener('click', (e) => {
        if (e.target.tagName === 'A' && e.target.closest('.chat-widget-container')) {
            e.stopPropagation();
        }
    });
});