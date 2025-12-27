// Offscreen document script - runs Stockfish Worker

let stockfish = null;

// Initialize Stockfish worker
function initStockfish() {
    if (stockfish) return;

    const stockfishUrl = chrome.runtime.getURL('stockfish.js');

    try {
        stockfish = new Worker(stockfishUrl);
    } catch (err) {
        console.error('[Offscreen] Failed to create worker:', err);
        return;
    }

    stockfish.addEventListener('message', (e) => {
        const line = e.data;

        // Engine ready - configure options
        if (line.includes('uciok')) {
            stockfish.postMessage('setoption name MultiPV value 3');
            stockfish.postMessage('isready');
        }

        // Forward all output to background script
        chrome.runtime.sendMessage({
            type: 'stockfishOutput',
            line: line
        });
    });

    stockfish.onerror = (e) => {
        console.error('[Stockfish] Worker error:', e.message || e);
    };

    // Start UCI protocol
    stockfish.postMessage('uci');
}

// Listen for commands from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'stockfishCommand') {
        if (!stockfish) initStockfish();
        stockfish.postMessage(message.command);
        sendResponse({ status: 'sent' });
    }

    if (message.type === 'initStockfish') {
        initStockfish();
        sendResponse({ status: 'initializing' });
    }

    return true;
});

// Auto-init on load
initStockfish();
