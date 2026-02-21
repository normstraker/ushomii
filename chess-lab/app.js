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
// ---------- MultiPV (humanized engine) ----------
let pendingAnalysisResolver = null;
let analysisBuffer = new Map(); // multipv -> { moveUci, scoreCp, scoreMate, depth }
let analysisBestDepthSeen = 0;
let engineReady = false;
let pendingReadyResolver = null;

function waitForReady() {
  if (engineReady) return Promise.resolve();
  return new Promise(resolve => {
    pendingReadyResolver = resolve;
  });
}
let currentMultiPV = 5;
let analysisTargetDepth = 10;

// Parses lines like:
// info depth 15 multipv 2 score cp 12 pv e2e4 e7e5 ...
function parseInfoLine(line) {
  // quick exits
  if (!line.includes(" pv ")) return null;

  const depthMatch = line.match(/\bdepth\s+(\d+)\b/);
  const mpvMatch = line.match(/\bmultipv\s+(\d+)\b/);
  const pvMatch = line.match(/\bpv\s+([a-h][1-8][a-h][1-8][qrbn]?)\b/);
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)\b/);
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)\b/);

  if (!depthMatch || !mpvMatch || !pvMatch) return null;

  const depth = Number(depthMatch[1]);
  const multipv = Number(mpvMatch[1]);
  const moveUci = pvMatch[1];

  return {
    depth,
    multipv,
    moveUci,
    scoreCp: cpMatch ? Number(cpMatch[1]) : null,
    scoreMate: mateMatch ? Number(mateMatch[1]) : null,
  };
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

    // Keep debug readable: ignore spammy "info" unless we want it
    if (!line.startsWith("bestmove") && !line.startsWith("info"))
      logDebug(line);

    // Parse MultiPV info lines when we're in analysis mode
    if (line.startsWith("info")) {
      const parsed = parseInfoLine(line);
      if (parsed && pendingAnalysisResolver) {
        // Track best depth seen to know when we have "enough" info
        analysisBestDepthSeen = Math.max(analysisBestDepthSeen, parsed.depth);

        analysisBuffer.set(parsed.multipv, parsed);

        // When we have all N multipv lines at a decent depth, resolve early
        const wantN = currentMultiPV;
        if (
          analysisBestDepthSeen >= analysisTargetDepth &&
          analysisBuffer.size >= wantN
        ) {
          const resolve = pendingAnalysisResolver;
          pendingAnalysisResolver = null;
          const candidates = [...analysisBuffer.values()].sort(
            (a, b) => a.multipv - b.multipv,
          );
          resolve(candidates);
        }
      }
    }

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

  const slowMover = Math.max(
    10,
    Math.min(1000, Math.round(300 - (elo - 400) * 0.12)),
  );

  // Set engine options
  sf.postMessage(`setoption name Skill Level value ${skill}`);
  sf.postMessage(`setoption name Slow Mover value ${slowMover}`);
  sf.postMessage(`setoption name MultiPV value ${currentMultiPV}`);

  // Ask engine to confirm readiness AFTER options are set
  sf.postMessage("isready");

  logDebug(
    `Applied slider: ${elo} -> Skill ${skill}, Slow Mover ${slowMover}, MultiPV ${currentMultiPV}`,
  );
}

function getEngineCandidates({
  movetimeMs = 200,
  multiPV = 5,
  targetDepth = 10,
} = {}) {
  return new Promise(async resolve => {
    if (!sf) {
      logDebug("ERROR: Stockfish not initialized.");
      resolve([]);
      return;
    }

    await waitForReady();

    if (engineBusy) {
      resolve([]);
      return;
    }

    engineBusy = true;

    // Prepare analysis collection
    currentMultiPV = multiPV;
    analysisTargetDepth = targetDepth;
    analysisBuffer = new Map();
    analysisBestDepthSeen = 0;

    pendingAnalysisResolver = candidates => {
      engineBusy = false;
      resolve(candidates);
    };

    // Safety: if we don't get enough info lines, fallback when bestmove arrives
    pendingBestMoveResolver = best => {
      // If analysis already resolved, ignore
      if (!pendingAnalysisResolver) return;

      const resolveAnalysis = pendingAnalysisResolver;
      pendingAnalysisResolver = null;

      engineBusy = false;

      // Use whatever we collected; if nothing, at least return bestmove
      const partial = [...analysisBuffer.values()].sort(
        (a, b) => a.multipv - b.multipv,
      );
      if (
        partial.length === 0 &&
        best &&
        best !== "(none)" &&
        best !== "(busy)"
      ) {
        resolveAnalysis([
          {
            depth: 0,
            multipv: 1,
            moveUci: best,
            scoreCp: null,
            scoreMate: null,
          },
        ]);
      } else {
        resolveAnalysis(partial);
      }
    };

    sf.postMessage(`setoption name MultiPV value ${multiPV}`);
    sf.postMessage(`position fen ${game.fen()}`);
    sf.postMessage(`go movetime ${movetimeMs}`);
  });
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
function chooseHumanMove(candidates, elo) {
  if (!candidates || candidates.length === 0) return null;

  // --- Convert mate scores into huge cp so we can compare ---
  function effectiveCp(c) {
    if (c.scoreMate !== null) {
      // mate in N: treat as extremely good/bad
      const sign = Math.sign(c.scoreMate);
      return sign * 100000;
    }
    return c.scoreCp ?? 0;
  }

  // Best = multipv 1 (usually)
  const sorted = [...candidates].sort((a, b) => a.multipv - b.multipv);
  const best = sorted[0];
  const bestCp = effectiveCp(best);

  // --- ELO → blunder behavior ---
  // Tune these numbers later; they're sane starters.
  const t = Math.max(0, Math.min(1, (elo - 400) / (2500 - 400))); // 0..1
  const blunderChance = (1 - t) * 0.28; // ~28% at 400, ~0% at 2500
  const maxDrop = 500 - t * 450; // ~500cp at low elo, ~50cp at high elo

  // If we're winning big, reduce blunders a bit (humans still blunder, but less often when it’s “easy”)
  const situational = Math.max(0.4, Math.min(1.0, 1 - (bestCp / 800) * 0.25));
  const finalBlunderChance = blunderChance * situational;

  // Decide if we intentionally deviate
  const doBlunder = Math.random() < finalBlunderChance;

  if (!doBlunder) return best.moveUci;

  // Allowed candidates within eval drop tolerance
  const allowed = sorted.filter(c => bestCp - effectiveCp(c) <= maxDrop);

  // If nothing fits (rare), take best
  if (allowed.length === 0) return best.moveUci;

  // Weighted pick: prefer better moves but allow mistakes
  // Weight decreases as eval gets worse.
  const weights = allowed.map(c => {
    const drop = Math.max(0, bestCp - effectiveCp(c));
    return 1 / (1 + drop / 50); // drop 0 -> 1.0 ; drop 200 -> ~0.2
  });

  // Weighted random selection
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < allowed.length; i++) {
    r -= weights[i];
    if (r <= 0) return allowed[i].moveUci;
  }

  return allowed[0].moveUci;
}
async function maybeEnginePlays() {
  if (game.isGameOver()) return;
  if (isHumansTurn()) return;

  const fenAtRequest = game.fen();

  const elo = Number($elo.value);
  const movetimeMs = Math.round(80 + (elo - 400) * 0.12);

  const candidates = await getEngineCandidates({
    movetimeMs,
    multiPV: 5,
    targetDepth: 10,
  });

  // If game changed while engine was thinking, ignore result
  if (game.fen() !== fenAtRequest) return;

  const chosen = chooseHumanMove(candidates, elo);
  if (!chosen) return;

  logDebug(`engine move: ${chosen} (best ${candidates[0]?.moveUci ?? "?"})`);

  const from = chosen.slice(0, 2);
  const to = chosen.slice(2, 4);
  const promo = chosen.length >= 5 ? chosen[4] : undefined;

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
