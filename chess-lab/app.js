console.log("app.js loaded");

/* global Chess, Chessboard */

let game = new Chess();
let board = null;

const $status = document.getElementById("status");
const $debug = document.getElementById("debug");
const $moves = document.getElementById("moves");
const $elo = document.getElementById("elo");
const $eloValue = document.getElementById("eloValue");
const $newGame = document.getElementById("newGame");
const $undo = document.getElementById("undo");
const $flip = document.getElementById("flip");
const $playWhite = document.getElementById("playWhite");
const $clickToMove = document.getElementById("clickToMove");
const $showMoveSquares = document.getElementById("showMoveSquares");
const $showMoveDots = document.getElementById("showMoveDots");
const $debugCard = document.getElementById("debugCard");
const $debugToggle = document.getElementById("debugToggle");

// ---------- Debug helper ----------
function logDebug(line) {
  console.log("DEBUG>", line);
  if (!$debug) return;
  $debug.textContent = (String(line) + "\n" + $debug.textContent).slice(
    0,
    4000,
  );
}
function clearDebug() {
  if ($debug) $debug.textContent = "";
}

// ---------- Move list ----------
function renderMoveList() {
  if (!$moves) return;

  const hist = game.history(); // SAN list
  let out = "";

  for (let i = 0; i < hist.length; i += 2) {
    const moveNum = i / 2 + 1;
    const white = hist[i] || "";
    const black = hist[i + 1] || "";
    out += `${moveNum}. ${white.padEnd(8, " ")} ${black}\n`;
  }

  $moves.textContent = out.trimEnd();

  // Auto-scroll to newest move (smooth)
  $moves.scrollTo({ top: $moves.scrollHeight, behavior: "smooth" });
}

// ---------- Board highlights ----------
let selectedSquare = null;

function clearHighlights() {
  $("#board .square-55d63").removeClass(
    "square-highlight square-highlight-from square-move-dot",
  );
}

function highlightMovesFrom(square) {
  clearHighlights();

  const showSquares = $showMoveSquares?.checked ?? true;
  const showDots = $showMoveDots?.checked ?? true;

  if (!showSquares && !showDots) return;

  if (showSquares) {
    $(`#board .square-55d63[data-square="${square}"]`).addClass(
      "square-highlight-from",
    );
  }

  const moves = game.moves({ square, verbose: true });
  for (const m of moves) {
    const $sq = $(`#board .square-55d63[data-square="${m.to}"]`);
    if (showSquares) $sq.addClass("square-highlight");
    if (showDots) $sq.addClass("square-move-dot");
  }
}

function isHumanPieceOn(square) {
  const piece = game.get(square);
  if (!piece) return false;
  const humanColor = $playWhite.checked ? "w" : "b";
  return piece.color === humanColor;
}

// Last move highlight
function clearLastMoveHighlight() {
  $("#board .square-55d63").removeClass("square-last-from square-last-to");
}

function highlightLastMove(from, to) {
  clearLastMoveHighlight();
  $(`#board .square-55d63[data-square="${from}"]`).addClass("square-last-from");
  $(`#board .square-55d63[data-square="${to}"]`).addClass("square-last-to");
}

// Check / checkmate highlight
function clearCheckHighlight() {
  $("#board .square-55d63").removeClass("square-check square-checkmate");
}

function highlightCheck() {
  clearCheckHighlight();

  if (!game.isCheck()) return;

  const inMate = game.isCheckmate();
  const turn = game.turn(); // side currently in check
  const boardState = game.board();

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = boardState[rank][file];
      if (piece && piece.type === "k" && piece.color === turn) {
        const square = "abcdefgh"[file] + (8 - rank);
        $(`#board .square-55d63[data-square="${square}"]`).addClass(
          inMate ? "square-checkmate" : "square-check",
        );
        return;
      }
    }
  }
}

// ---------- Stockfish worker ----------
let sf = null;
let engineBusy = false;
let pendingBestMoveResolver = null;

let engineReady = false;
let pendingReadyResolver = null;

function waitForReady() {
  if (engineReady) return Promise.resolve();
  return new Promise(resolve => {
    pendingReadyResolver = resolve;
  });
}

function initStockfish() {
  console.log("initStockfish() called");

  try {
    sf = new Worker("./engine/stockfish.js");
  } catch (err) {
    console.error("Worker constructor failed:", err);
    logDebug("ERROR: Worker constructor failed (see console).");
    return;
  }

  logDebug("Stockfish worker created.");

  sf.onerror = err => {
    console.error("Stockfish worker error:", err);
    logDebug("ERROR: Stockfish worker error (see console).");
  };

  sf.onmessage = e => {
    const line = String(e.data);

    // Keep debug readable: ignore spammy info and raw bestmove lines
    if (!line.startsWith("info") && !line.startsWith("bestmove"))
      logDebug(line);

    if (line === "readyok") {
      engineReady = true;
      if (pendingReadyResolver) {
        pendingReadyResolver();
        pendingReadyResolver = null;
      }
      return;
    }

    if (line.startsWith("bestmove")) {
      const parts = line.split(/\s+/);
      const best = parts[1];
      engineBusy = false;

      if (pendingBestMoveResolver) {
        const resolve = pendingBestMoveResolver;
        pendingBestMoveResolver = null;
        resolve(best);
      }
    }
  };

  engineReady = false;
  sf.postMessage("uci");
  sf.postMessage("isready");

  applyEloToEngine(Number($elo.value));
}

function applyEloToEngine(elo) {
  if (!sf) return;

  engineReady = false;

  const skill = Math.max(
    0,
    Math.min(20, Math.round(((elo - 400) / (2500 - 400)) * 20)),
  );

  // This build supports Slow Mover; Skill Level may or may not exist (safe to try)
  sf.postMessage(`setoption name Skill Level value ${skill}`);

  const slowMover = Math.max(
    10,
    Math.min(1000, Math.round(300 - (elo - 400) * 0.12)),
  );
  sf.postMessage(`setoption name Slow Mover value ${slowMover}`);

  sf.postMessage("isready");
  logDebug(`Applied slider: ${elo} -> Skill ${skill}, Slow Mover ${slowMover}`);
}

function getEngineMove({ movetimeMs = 200 } = {}) {
  return new Promise(async resolve => {
    if (!sf) {
      logDebug("ERROR: Stockfish not initialized.");
      resolve("(none)");
      return;
    }

    await waitForReady();

    if (engineBusy) {
      resolve("(busy)");
      return;
    }

    engineBusy = true;
    pendingBestMoveResolver = resolve;

    sf.postMessage(`position fen ${game.fen()}`);
    sf.postMessage(`go movetime ${movetimeMs}`);
  });
}

// ---------- Game flow ----------
function updateStatus() {
  let status = "";
  const turn = game.turn() === "w" ? "White" : "Black";

  if (game.isCheckmate()) {
    status = `Checkmate. ${turn} to move — but it's over.`;
  } else if (game.isDraw()) {
    status = "Draw.";
  } else {
    status = `${turn} to move.`;
    if (game.isCheck()) status += " (Check)";
  }

  $status.textContent = status;
  highlightCheck();
}

function isHumansTurn() {
  const humanColor = $playWhite.checked ? "w" : "b";
  return game.turn() === humanColor;
}

async function maybeEnginePlays() {
  if (game.isGameOver()) return;
  if (isHumansTurn()) return;

  const fenAtRequest = game.fen();

  const elo = Number($elo.value);
  const movetimeMs = Math.round(80 + (elo - 400) * 0.12);

  const best = await getEngineMove({ movetimeMs });

  // If game changed while engine was thinking, ignore result
  if (game.fen() !== fenAtRequest) return;

  if (!best || best === "(none)" || best === "(busy)") return;

  logDebug(`bestmove: ${best}`);

  const from = best.slice(0, 2);
  const to = best.slice(2, 4);
  const promo = best.length >= 5 ? best[4] : undefined;

  const move = game.move({ from, to, promotion: promo || "q" });
  if (move) {
    board.position(game.fen(), true);
    updateStatus();
    renderMoveList();
    highlightLastMove(from, to);
  }
}

function onDragStart(source, piece) {
  if ($clickToMove?.checked) return false;
  if (game.isGameOver()) return false;
  if (!isHumansTurn()) return false;

  const humanIsWhite = $playWhite.checked;
  if (humanIsWhite && piece.startsWith("b")) return false;
  if (!humanIsWhite && piece.startsWith("w")) return false;

  selectedSquare = source;
  highlightMovesFrom(source);
  return true;
}

function onDrop(source, target) {
  // Drop back on original square = "never mind"
  if (source === target) {
    clearHighlights();
    selectedSquare = null;
    return;
  }

  const move = game.move({
    from: source,
    to: target,
    promotion: "q",
  });

  if (move === null) return "snapback";

  updateStatus();
  renderMoveList();
  highlightLastMove(source, target);

  clearHighlights();
  selectedSquare = null;

  setTimeout(maybeEnginePlays, 0);
}

function onSnapEnd() {
  board.position(game.fen());
}

// ---------- Controls ----------
$elo.addEventListener("input", () => {
  $eloValue.textContent = $elo.value;
});

$elo.addEventListener("change", () => {
  applyEloToEngine(Number($elo.value));
  if (engineBusy && sf) sf.postMessage("stop");
});

$playWhite.addEventListener("change", () => {
  startNewGame();
});

$newGame.addEventListener("click", () => startNewGame());

$showMoveSquares?.addEventListener("change", () => {
  clearHighlights();
  if (selectedSquare) highlightMovesFrom(selectedSquare);
});

$showMoveDots?.addEventListener("change", () => {
  clearHighlights();
  if (selectedSquare) highlightMovesFrom(selectedSquare);
});

$undo.addEventListener("click", () => {
  if (game.history().length === 0) return;

  game.undo();
  if (!isHumansTurn() && game.history().length > 0) game.undo();

  board.position(game.fen(), true);
  updateStatus();
  renderMoveList();

  // After undo, simplest is to clear last-move highlight (optional: recompute later)
  clearLastMoveHighlight();
});

$flip.addEventListener("click", () => {
  board.flip();
});

function startNewGame() {
  game = new Chess();
  board.start(true);

  clearDebug();
  clearHighlights();
  clearLastMoveHighlight();
  clearCheckHighlight();
  selectedSquare = null;

  updateStatus();
  renderMoveList();

  // Reset engine for new game
  if (sf) {
    engineBusy = false;
    pendingBestMoveResolver = null;

    engineReady = false;
    sf.postMessage("ucinewgame");
    sf.postMessage("isready");
  }

  // If human chose black, engine should open
  setTimeout(maybeEnginePlays, 0);
}

// ---------- Init ----------
function initBoard() {
  board = Chessboard("board", {
    position: "start",
    draggable: true,
    pieceTheme: "./vendor/chessboardjs/img/chesspieces/wikipedia/{piece}.png",
    onDragStart,
    onDrop,
    onSnapEnd,
  });

  const boardEl = document.getElementById("board");

  // Remove any previous handlers (in case of hot reloads / re-init)
  boardEl.onclick = null;

  // Click-to-move on the board (sticky pick up / put down)
  boardEl.addEventListener("click", e => {
    if (!$clickToMove?.checked) return;
    if (game.isGameOver()) return;
    if (!isHumansTurn()) return;

    // Prevent the document click handler from firing on board clicks
    e.stopPropagation();

    // Find the clicked square no matter whether you clicked the piece image or the square
    const sqEl = e.target.closest(".square-55d63");
    if (!sqEl) return;

    const square = sqEl.getAttribute("data-square");
    if (!square) return;

    // Nothing held: must click your piece to pick up
    if (!selectedSquare) {
      if (!isHumanPieceOn(square)) return;
      selectedSquare = square;
      highlightMovesFrom(square);
      return;
    }

    // Something is held:

    // Click same square again = cancel ("put it back")
    if (square === selectedSquare) {
      clearHighlights();
      selectedSquare = null;
      return;
    }

    // Clicking another of your pieces switches selection
    if (isHumanPieceOn(square)) {
      selectedSquare = square;
      highlightMovesFrom(square);
      return;
    }

    // Attempt move
    const move = game.move({
      from: selectedSquare,
      to: square,
      promotion: "q",
    });

    // Illegal: keep holding + keep highlights
    if (move === null) return;

    // Legal: commit
    board.position(game.fen(), true);
    updateStatus();
    renderMoveList();
    highlightLastMove(selectedSquare, square);

    clearHighlights();
    selectedSquare = null;

    setTimeout(maybeEnginePlays, 0);
  });

  // Click off-board cancels (REGISTER ONCE)
  document.removeEventListener("click", window.__chesslabCancelClickToMove);
  window.__chesslabCancelClickToMove = function () {
    if (!$clickToMove?.checked) return;
    if (!selectedSquare) return;
    clearHighlights();
    selectedSquare = null;
  };
  document.addEventListener("click", window.__chesslabCancelClickToMove);
}

function setDebugOpen(isOpen) {
  if (!$debugCard) return;

  $debugCard.classList.toggle("is-open", isOpen);
  $debugCard.classList.toggle("is-collapsed", !isOpen);

  try {
    localStorage.setItem("chesslab_debug_open", isOpen ? "1" : "0");
  } catch (_) {}
}

(function initDebugCollapse() {
  if (!$debugToggle || !$debugCard) return;

  let isOpen = false;
  try {
    isOpen = localStorage.getItem("chesslab_debug_open") === "1";
  } catch (_) {}

  // Default collapsed
  setDebugOpen(isOpen);

  $debugToggle.addEventListener("click", () => {
    const nowOpen = !$debugCard.classList.contains("is-open");
    setDebugOpen(nowOpen);
  });
})();

(function main() {
  initBoard();
  initStockfish();
  $eloValue.textContent = $elo.value;

  updateStatus();
  renderMoveList();

  setTimeout(maybeEnginePlays, 0);
})();
