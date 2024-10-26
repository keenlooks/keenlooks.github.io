// assets/js/chat-widget.js
document.addEventListener('DOMContentLoaded', function() {
    // First inject the HTML for the chat widget
    const chatWidgetHTML = `
        <div id="chat-widget" class="chat-widget-container closed">
            <div class="chat-header">
                <span class="chat-title">Ask Claude</span>
                <button class="minimize-button">+</button>
            </div>
            <div class="chat-content">
                <div id="chat-messages"></div>
                <div class="chat-input">
                    <textarea id="user-input" placeholder="Type your message..."></textarea>
                    <button id="send-button">Send</button>
                </div>
            </div>
        </div>
    `;

    // Inject the chat widget HTML into the body
    document.body.insertAdjacentHTML('beforeend', chatWidgetHTML);

    // Add the styles
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
            z-index: 1000;
            transition: height 0.3s ease;
            display: flex;
            flex-direction: column;
        }

        .chat-widget-container.closed {
            height: 48px;
        }

        .chat-widget-container.open {
            height: 600px;
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
        }

        .chat-title {
            color: #e0e0e0;
            font-weight: 500;
        }

        .minimize-button {
            background: none;
            border: none;
            color: #e0e0e0;
            font-size: 18px;
            cursor: pointer;
            padding: 0 4px;
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

        .chat-input {
            padding: 12px;
            border-top: 1px solid #2d2d2d;
            display: flex;
            gap: 8px;
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
        }

        #send-button:hover {
            background: #357abd;
        }

        #send-button:disabled {
            background: #2d2d2d;
        }

        .message {
            margin-bottom: 12px;
            padding: 10px;
            border-radius: 4px;
            max-width: 85%;
            word-wrap: break-word;
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

    // Constants
    const WORKER_URL = 'https://flat-bread-e3e2.keenlooks-cloudflare.workers.dev/';
    let isLoading = false;

    // Add event listeners
    const header = document.querySelector('.chat-header');
    const sendButton = document.getElementById('send-button');
    const userInput = document.getElementById('user-input');

    header.addEventListener('click', function() {
        const widget = document.getElementById('chat-widget');
        const minimizeButton = widget.querySelector('.minimize-button');
        const isOpen = widget.classList.contains('open');
        
        widget.classList.toggle('open');
        widget.classList.toggle('closed');
        minimizeButton.textContent = isOpen ? '+' : '−';
    });

    async function sendMessage() {
        if (isLoading || !userInput.value.trim()) return;
        
        const messagesDiv = document.getElementById('chat-messages');
        isLoading = true;
        sendButton.disabled = true;
        userInput.disabled = true;
        
        try {
            const userMessage = document.createElement('div');
            userMessage.className = 'message user-message';
            userMessage.textContent = userInput.value;
            messagesDiv.appendChild(userMessage);

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

            const claudeMessage = document.createElement('div');
            claudeMessage.className = 'message claude-message';
            claudeMessage.textContent = data.content[0].text;
            messagesDiv.appendChild(claudeMessage);
            
            localStorage.setItem('chatMessages', messagesDiv.innerHTML);
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

    sendButton.addEventListener('click', sendMessage);
    userInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Load saved messages
    const savedMessages = localStorage.getItem('chatMessages');
    if (savedMessages) {
        document.getElementById('chat-messages').innerHTML = savedMessages;
    }
});