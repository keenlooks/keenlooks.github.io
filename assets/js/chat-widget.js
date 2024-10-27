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
                <span class="chat-title">Ask About My Research</span>
                <button class="minimize-button">+</button>
            </div>
            <div class="chat-content">
                <div id="chat-messages"></div>
                <div class="chat-input">
                    <textarea id="user-input" placeholder="Ask me about Keane's research..."></textarea>
                    <button id="send-button">Send</button>
                </div>
            </div>
        </div>
    `;

    // Inject the chat widget HTML into the body
    document.body.insertAdjacentHTML('beforeend', chatWidgetHTML);

    // Add the styles
    const styles = `
        /* Previous styles remain the same */
        
        /* Add styles for markdown content */
        .claude-message {
            background: #1e3a5f;
            margin-right: auto;
            color: #e0e0e0;
            line-height: 1.5;
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
            margin: 0 0 1em 0;
        }

        .claude-message p:last-child {
            margin-bottom: 0;
        }

        .claude-message ul, .claude-message ol {
            margin: 0.5em 0;
            padding-left: 1.5em;
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

        .claude-message blockquote {
            border-left: 3px solid #4a9eff;
            margin: 0.5em 0;
            padding-left: 1em;
            color: #cccccc;
        }

        .claude-message h1, .claude-message h2, .claude-message h3, 
        .claude-message h4, .claude-message h5, .claude-message h6 {
            margin: 0.5em 0;
            color: #ffffff;
        }

        .claude-message table {
            border-collapse: collapse;
            margin: 0.5em 0;
            width: 100%;
        }

        .claude-message th, .claude-message td {
            border: 1px solid #2d2d2d;
            padding: 0.4em 0.8em;
        }

        .claude-message th {
            background: #2d2d2d;
        }
    `;

    // Add styles to document
    const styleSheet = document.createElement("style");
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    // Constants and state
    const WORKER_URL = 'https://flat-bread-e3e2.keenlooks-cloudflare.workers.dev/';
    let isLoading = false;

    // Chat state management functions
    function saveChatState() {
        const messagesDiv = document.getElementById('chat-messages');
        if (messagesDiv) {
            localStorage.setItem('claudeChatHistory', messagesDiv.innerHTML);
        }
    }

    function loadChatState() {
        const messagesDiv = document.getElementById('chat-messages');
        const savedMessages = localStorage.getItem('claudeChatHistory');
        if (messagesDiv && savedMessages) {
            messagesDiv.innerHTML = savedMessages;
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
    }

    // Toggle chat function
    function toggleChat() {
        const widget = document.getElementById('chat-widget');
        const minimizeButton = widget.querySelector('.minimize-button');
        const isOpen = widget.classList.contains('open');
        
        widget.classList.toggle('open');
        widget.classList.toggle('closed');
        minimizeButton.textContent = isOpen ? '+' : '−';
    }

    async function sendMessage() {
        const userInput = document.getElementById('user-input');
        const sendButton = document.getElementById('send-button');
        const messagesDiv = document.getElementById('chat-messages');
        
        if (isLoading || !userInput.value.trim()) return;
        
        isLoading = true;
        sendButton.disabled = true;
        userInput.disabled = true;
        
        try {
            const userMessage = document.createElement('div');
            userMessage.className = 'message user-message';
            userMessage.textContent = userInput.value;
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
                        content: userInput.value
                    }]
                })
            });

            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'Failed to get response');
            }

            // Extract text from Claude's response format
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
            
            // Render markdown with security options
            claudeMessage.innerHTML = marked.parse(claudeResponseText, {
                breaks: true,
                gfm: true,
                sanitize: true,
                headerIds: false,
                mangle: false
            });

            // Make all links open in new tab
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
            userInput.disabled = false;
            userInput.value = '';
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
    }
    
    // Add event listeners
    const header = document.querySelector('.chat-header');
    const sendButton = document.getElementById('send-button');
    const userInput = document.getElementById('user-input');

    header.addEventListener('click', toggleChat);
    sendButton.addEventListener('click', sendMessage);
    userInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Load saved chat history
    loadChatState();

    // Save chat state before page unload
    window.addEventListener('beforeunload', saveChatState);
});