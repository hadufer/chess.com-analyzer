// Content Script - Chess.com Position Analyzer

(function () {
    'use strict';

    const ANALYSIS_DEBOUNCE = 50;
    const ARROW_COLORS = ['#32CD32', '#FFA500', '#FFD700'];

    const PIECE_MAP = {
        'wp': 'P', 'wn': 'N', 'wb': 'B', 'wr': 'R', 'wq': 'Q', 'wk': 'K',
        'bp': 'p', 'bn': 'n', 'bb': 'b', 'br': 'r', 'bq': 'q', 'bk': 'k'
    };

    // Settings
    let settings = { enabled: true, depth: 15, showArrows: true };

    // State
    let lastFen = '';
    let lastAnalysisTime = 0;
    let cachedOrientation = null;
    let arrowsSvg = null;
    let latestAnalysis = null;

    // Load settings
    function loadSettings() {
        chrome.storage.local.get(['enabled', 'depth', 'showArrows'], (result) => {
            settings.enabled = result.enabled !== false;
            settings.depth = result.depth || 15;
            settings.showArrows = result.showArrows !== false;
        });
    }

    // Get board context
    function getBoardContext() {
        const board = document.querySelector('wc-chess-board');
        if (!board) return null;

        if (board.shadowRoot) {
            const pieces = board.shadowRoot.querySelectorAll('.piece');
            if (pieces.length > 0) return { root: board.shadowRoot, board, type: 'shadow' };
        }

        const pieces = board.querySelectorAll('.piece');
        if (pieces.length > 0) return { root: board, board, type: 'light' };

        const docPieces = document.querySelectorAll('.piece');
        if (docPieces.length > 0) return { root: document, board, type: 'document' };

        return null;
    }

    // Create SVG container for arrows
    function createArrowsContainer() {
        if (arrowsSvg && arrowsSvg.isConnected) return;

        const context = getBoardContext();
        if (!context) return;

        let boardElement = context.board;
        if (context.type === 'shadow') {
            boardElement = context.root.querySelector('.board') || context.board;
        }

        arrowsSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        arrowsSvg.id = 'stockfish-arrows';
        arrowsSvg.setAttribute('viewBox', '0 0 100 100');
        arrowsSvg.style.cssText = `
            position: absolute; top: 0; left: 0;
            width: 100%; height: 100%;
            pointer-events: none; z-index: 100;
        `;

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        ARROW_COLORS.forEach((color, i) => {
            const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
            marker.setAttribute('id', `arrow-head-${i}`);
            marker.setAttribute('markerWidth', '4');
            marker.setAttribute('markerHeight', '4');
            marker.setAttribute('refX', '0');
            marker.setAttribute('refY', '2');
            marker.setAttribute('orient', 'auto');

            const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            polygon.setAttribute('points', '0,0 4,2 0,4');
            polygon.setAttribute('fill', color);
            polygon.setAttribute('fill-opacity', String(0.7 - i * 0.1));

            marker.appendChild(polygon);
            defs.appendChild(marker);
        });
        arrowsSvg.appendChild(defs);

        boardElement.style.position = 'relative';
        boardElement.appendChild(arrowsSvg);
    }

    // Extract FEN
    function extractFEN() {
        const context = getBoardContext();
        if (!context) return null;

        const pieces = context.root.querySelectorAll('.piece');
        if (pieces.length === 0) return null;

        const boardArray = Array(8).fill(null).map(() => Array(8).fill(''));

        pieces.forEach(piece => {
            const match = piece.className.match(/square-(\d)(\d)/);
            if (!match) return;

            const file = parseInt(match[1]) - 1;
            const rank = parseInt(match[2]) - 1;

            for (const cls of piece.classList) {
                if (PIECE_MAP[cls]) {
                    boardArray[7 - rank][file] = PIECE_MAP[cls];
                    break;
                }
            }
        });

        let fen = '';
        for (let rank = 0; rank < 8; rank++) {
            let empty = 0;
            for (let file = 0; file < 8; file++) {
                const p = boardArray[rank][file];
                if (p === '') { empty++; }
                else {
                    if (empty > 0) { fen += empty; empty = 0; }
                    fen += p;
                }
            }
            if (empty > 0) fen += empty;
            if (rank < 7) fen += '/';
        }

        return `${fen} ${detectTurn()} KQkq - 0 1`;
    }

    // Detect turn
    function detectTurn() {
        const clocks = document.querySelectorAll('.clock-component');
        for (const clock of clocks) {
            if (clock.classList.contains('clock-player-turn') || clock.classList.contains('clock-running')) {
                const rect = clock.getBoundingClientRect();
                const boardRect = document.querySelector('wc-chess-board')?.getBoundingClientRect();
                if (boardRect) {
                    const isBottom = rect.top > boardRect.top + boardRect.height / 2;
                    const isFlipped = document.querySelector('wc-chess-board')?.classList.contains('flipped');
                    return isBottom ? (isFlipped ? 'b' : 'w') : (isFlipped ? 'w' : 'b');
                }
            }
        }
        const moves = document.querySelectorAll('.move-text-component, [data-ply]');
        return moves.length % 2 === 0 ? 'w' : 'b';
    }

    // Get orientation (cached)
    function getBoardOrientation() {
        const board = document.querySelector('wc-chess-board');
        if (!board) return 'white';
        const isFlipped = board.classList.contains('flipped') || board.getAttribute('flipped') === 'true';
        cachedOrientation = isFlipped ? 'black' : 'white';
        return cachedOrientation;
    }

    // Square to coords
    function squareToCoords(square) {
        const file = square.charCodeAt(0) - 97;
        const rank = parseInt(square[1]) - 1;
        const orientation = cachedOrientation || getBoardOrientation();
        return orientation === 'white' ? { x: file, y: 7 - rank } : { x: 7 - file, y: rank };
    }

    // Draw arrow
    function drawArrow(from, to, colorIndex, scoreText) {
        if (!settings.showArrows) return;
        if (!arrowsSvg || !arrowsSvg.isConnected) {
            createArrowsContainer();
            if (!arrowsSvg) return;
        }

        const fromCoords = squareToCoords(from);
        const toCoords = squareToCoords(to);
        const squareSize = 12.5;

        const x1 = (fromCoords.x + 0.5) * squareSize;
        const y1 = (fromCoords.y + 0.5) * squareSize;
        const targetX = (toCoords.x + 0.5) * squareSize;
        const targetY = (toCoords.y + 0.5) * squareSize;

        const dx = targetX - x1, dy = targetY - y1;
        const length = Math.sqrt(dx * dx + dy * dy);
        const x2 = targetX - (dx / length) * 5;
        const y2 = targetY - (dy / length) * 5;

        const color = ARROW_COLORS[colorIndex];
        const opacity = 0.7 - colorIndex * 0.1;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', '2.5');
        line.setAttribute('stroke-opacity', opacity);
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('marker-end', `url(#arrow-head-${colorIndex})`);
        arrowsSvg.appendChild(line);

        if (scoreText) {
            const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', midX);
            text.setAttribute('y', midY);
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'central');
            text.setAttribute('fill', color);
            text.setAttribute('font-size', '4');
            text.setAttribute('font-weight', 'bold');
            text.setAttribute('font-family', 'Arial, sans-serif');
            text.setAttribute('stroke', '#000');
            text.setAttribute('stroke-width', '0.4');
            text.textContent = scoreText;
            arrowsSvg.appendChild(text);
        }
    }

    // Clear arrows
    function clearArrows() {
        if (arrowsSvg) {
            const defs = arrowsSvg.querySelector('defs');
            arrowsSvg.innerHTML = '';
            if (defs) arrowsSvg.appendChild(defs);
        }
    }

    // Parse UCI move
    function parseUCIMove(move) {
        if (!move || move.length < 4) return null;
        return { from: move.substring(0, 2), to: move.substring(2, 4) };
    }

    // Display analysis (arrows only)
    function displayAnalysis(data) {
        if (!settings.enabled || !data?.moves) return;

        if (data.fen) {
            const analysisFenPosition = data.fen.split(' ')[0];
            if (analysisFenPosition !== lastFen) return;
        }

        latestAnalysis = data;

        if (data.moves.length > 0) {
            clearArrows();
            getBoardOrientation();
        }

        data.moves.forEach((move, index) => {
            if (!move) return;
            const scoreText = move.isMate
                ? `M${move.score > 0 ? '+' : ''}${move.score}`
                : `${move.score > 0 ? '+' : ''}${(move.score / 100).toFixed(1)}`;
            const parsed = parseUCIMove(move.move);
            if (parsed) drawArrow(parsed.from, parsed.to, index, scoreText);
        });
    }

    // Analyze current position
    function analyzeCurrentPosition() {
        if (!settings.enabled) return;

        const now = Date.now();
        if (now - lastAnalysisTime < ANALYSIS_DEBOUNCE) return;
        lastAnalysisTime = now;

        const fen = extractFEN();
        if (!fen) return;

        const fenPosition = fen.split(' ')[0];
        if (fenPosition === lastFen) return;

        lastFen = fenPosition;
        clearArrows();

        chrome.runtime.sendMessage({
            type: 'analyze',
            fen: fen,
            depth: settings.depth
        }).catch(() => { });
    }

    // Message listener
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'analysis') {
            displayAnalysis(message.data);
        }
        if (message.type === 'settingsUpdate') {
            settings.enabled = message.settings.enabled;
            settings.depth = message.settings.depth;
            settings.showArrows = message.settings.showArrows;

            if (!settings.enabled) {
                clearArrows();
            } else {
                lastFen = '';
                analyzeCurrentPosition();
            }
            sendResponse({ status: 'updated' });
        }
        if (message.type === 'getAnalysis') {
            sendResponse({ analysis: latestAnalysis });
        }
        return true;
    });

    // Setup observer
    function setupObserver() {
        const context = getBoardContext();
        if (!context) {
            setTimeout(setupObserver, 1000);
            return;
        }

        createArrowsContainer();
        loadSettings();

        const observer = new MutationObserver(() => {
            cachedOrientation = null;
            analyzeCurrentPosition();
        });

        observer.observe(context.root === document ? context.board : context.root, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['class', 'style']
        });

        const docObserver = new MutationObserver(() => {
            if (!document.querySelector('wc-chess-board')) arrowsSvg = null;
        });
        docObserver.observe(document.body, { childList: true, subtree: true });

        setTimeout(analyzeCurrentPosition, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupObserver);
    } else {
        setupObserver();
    }

})();
