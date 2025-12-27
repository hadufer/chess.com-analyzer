// Background Service Worker
// Communicates between content script, popup, and Stockfish

let offscreenReady = false;
let currentAnalysis = null;
let currentTabId = null;
let lastDepthSent = 0;
let currentFen = null;
let latestAnalysisData = null; // Store latest analysis for popup

// Pre-compiled regex patterns
const REGEX = {
    depth: /depth (\d+)/,
    multipv: /multipv (\d+)/,
    score: /score (cp|mate) (-?\d+)/,
    pv: / pv (.+)/
};

// Create offscreen document if needed
async function setupOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
        offscreenReady = true;
        return;
    }

    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run Stockfish chess engine in a Web Worker'
    });

    offscreenReady = true;
}

// Send command to Stockfish
async function sendStockfishCommand(command) {
    if (!offscreenReady) await setupOffscreenDocument();
    chrome.runtime.sendMessage({ type: 'stockfishCommand', command });
}

// Parse analysis line from Stockfish
function parseAnalysisLine(line) {
    if (!currentAnalysis) {
        currentAnalysis = { moves: [], depth: 0 };
    }

    const depthMatch = line.match(REGEX.depth);
    const pvMatch = line.match(REGEX.pv);

    if (depthMatch && pvMatch) {
        const depth = parseInt(depthMatch[1]);
        const multipvMatch = line.match(REGEX.multipv);
        const multipv = multipvMatch ? parseInt(multipvMatch[1]) : 1;
        const pv = pvMatch[1].split(' ');
        const bestMove = pv[0];

        let score = 0;
        let isMate = false;
        const scoreMatch = line.match(REGEX.score);
        if (scoreMatch) {
            isMate = scoreMatch[1] === 'mate';
            score = parseInt(scoreMatch[2]);
        }

        currentAnalysis.depth = depth;
        currentAnalysis.moves[multipv - 1] = {
            move: bestMove,
            score,
            isMate,
            pv: pv.slice(0, 5).join(' ')
        };

        // Send results progressively at each new depth
        if (depth > lastDepthSent && currentAnalysis.moves[0]) {
            lastDepthSent = depth;
            broadcastAnalysis(false);
        }
    }
}

// Broadcast analysis to content script AND popup
function broadcastAnalysis(isFinal) {
    if (!currentAnalysis) return;

    const validMoves = currentAnalysis.moves.filter(m => m);
    if (validMoves.length === 0) return;

    const analysisData = {
        depth: currentAnalysis.depth,
        moves: validMoves,
        fen: currentFen
    };

    // Store for popup requests
    latestAnalysisData = analysisData;

    // Send to content script
    if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, {
            type: 'analysis',
            data: analysisData,
            isFinal
        }).catch(() => { });
    }

    // Send to popup (if open)
    chrome.runtime.sendMessage({
        type: 'analysisUpdate',
        data: analysisData
    }).catch(() => { }); // Popup might not be open

    if (isFinal) {
        currentAnalysis = null;
        lastDepthSent = 0;
    }
}

// Start analysis of a position
async function analyzePosition(fen, depth) {
    await setupOffscreenDocument();

    currentAnalysis = { moves: [], depth: 0 };
    lastDepthSent = 0;
    currentFen = fen;

    sendStockfishCommand('stop');
    sendStockfishCommand(`position fen ${fen}`);
    sendStockfishCommand(`go depth ${depth}`);
}

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'analyze') {
        currentTabId = sender.tab?.id;
        analyzePosition(message.fen, message.depth || 18);
        sendResponse({ status: 'analyzing' });
        return true;
    }

    if (message.type === 'stop') {
        sendStockfishCommand('stop');
        sendResponse({ status: 'stopped' });
        return true;
    }

    if (message.type === 'ping') {
        sendResponse({ status: 'ok', ready: offscreenReady });
        return true;
    }

    // Popup requesting latest analysis
    if (message.type === 'getLatestAnalysis') {
        sendResponse({ analysis: latestAnalysisData });
        return true;
    }

    // Messages from offscreen document (Stockfish output)
    if (message.type === 'stockfishOutput') {
        const line = message.line;

        if (line.includes('info depth') && line.includes(' pv ')) {
            parseAnalysisLine(line);
        }

        if (line.startsWith('bestmove')) {
            broadcastAnalysis(true);
        }
    }

    return true;
});

// Initialize on startup
setupOffscreenDocument();
