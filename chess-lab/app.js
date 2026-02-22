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

// ---------- Inline engine indicator injected into #status ----------
let $engineInline = null;
let thinkingDelayTimer = null;

function ensureEngineInline() {
  if ($engineInline || !$status) return;

  $engineInline = document.createElement("span");
  $engineInline.className = "engine-inline";
  $engineInline.hidden = true;
  $engineInline.setAttribute("aria-live", "polite");
  $engineInline.innerHTML = `<span class="spinner" aria-hidden="true"></span>Thinking…`;

  $status.appendChild($engineInline);
}

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

// ---------- ELO UI sync + persistence ----------
function syncEloUI() {
  if (!$elo || !$eloValue) return;
  $eloValue.textContent = $elo.value;
}
function loadSavedElo() {
  try {
    const saved = localStorage.getItem("chesslab_elo");
    if (saved) $elo.value = saved;
  } catch (_) {}
  syncEloUI();
}
function saveElo() {
  try {
    localStorage.setItem("chesslab_elo", String($elo.value));
  } catch (_) {}
}

// ---------- Engine thinking / UI lock ----------
function setEngineThinking(isThinking) {
  ensureEngineInline();

  // Show only if thinking lasts > 150ms (prevents flicker on fast moves)
  if (isThinking) {
    if (thinkingDelayTimer) clearTimeout(thinkingDelayTimer);
    thinkingDelayTimer = setTimeout(() => {
      if ($engineInline) $engineInline.hidden = false;
    }, 150);
  } else {
    if (thinkingDelayTimer) {
      clearTimeout(thinkingDelayTimer);
      thinkingDelayTimer = null;
    }
    if ($engineInline) $engineInline.hidden = true;
  }

  // Disable controls while thinking
  if ($newGame) $newGame.disabled = isThinking;
  if ($undo) $undo.disabled = isThinking;
  if ($flip) $flip.disabled = isThinking;
  if ($elo) $elo.disabled = isThinking;
  if ($playWhite) $playWhite.disabled = isThinking;

  if ($clickToMove) $clickToMove.disabled = isThinking;
  if ($showMoveSquares) $showMoveSquares.disabled = isThinking;
  if ($showMoveDots) $showMoveDots.disabled = isThinking;
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

// MultiPV analysis
let pendingAnalysisResolver = null;
let analysisBuffer = new Map(); // multipv -> { moveUci, scoreCp, scoreMate, depth }
let analysisBestDepthSeen = 0;

let engineReady = false;
let pendingReadyResolver = null;

let currentMultiPV = 5;
let analysisTargetDepth = 10;

function waitForReady() {
  if (engineReady) return Promise.resolve();
  return new Promise(resolve => {
    pendingReadyResolver = resolve;
  });
}

// Parses lines like:
// info depth 15 multipv 2 score cp 12 pv e2e4 e7e5 ...
function parseInfoLine(line) {
  if (!line.includes(" pv ")) return null;

  const depthMatch = line.match(/\bdepth\s+(\d+)\b/);
  const mpvMatch = line.match(/\bmultipv\s+(\d+)\b/);
  const pvMatch = line.match(/\bpv\s+([a-h][1-8][a-h][1-8][qrbn]?)\b/);
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)\b/);
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)\b/);

  if (!depthMatch || !mpvMatch || !pvMatch) return null;

  return {
    depth: Number(depthMatch[1]),
    multipv: Number(mpvMatch[1]),
    moveUci: pvMatch[1],
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
    engineBusy = false;
    setEngineThinking(false);
  };

  sf.onmessage = e => {
    const line = String(e.data);

    // Keep debug readable
    if (!line.startsWith("bestmove") && !line.startsWith("info"))
      logDebug(line);

    // MultiPV info lines
    if (line.startsWith("info")) {
      const parsed = parseInfoLine(line);
      if (parsed && pendingAnalysisResolver) {
        analysisBestDepthSeen = Math.max(analysisBestDepthSeen, parsed.depth);
        analysisBuffer.set(parsed.multipv, parsed);

        const wantN = currentMultiPV;
        if (
          analysisBestDepthSeen >= analysisTargetDepth &&
          analysisBuffer.size >= wantN
        ) {
          const resolve = pendingAnalysisResolver;
          pendingAnalysisResolver = null;
          pendingBestMoveResolver = null;

          const candidates = [...analysisBuffer.values()].sort(
            (a, b) => a.multipv - b.multipv,
          );

          engineBusy = false;
          setEngineThinking(false);
          resolve(candidates);
        }
      }
      return;
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

      // Engine is done
      engineBusy = false;
      setEngineThinking(false);

      // If we were collecting MultiPV but didn't hit threshold, resolve partial
      if (pendingAnalysisResolver) {
        const resolveAnalysis = pendingAnalysisResolver;
        pendingAnalysisResolver = null;
        pendingBestMoveResolver = null;

        const partial = [...analysisBuffer.values()].sort(
          (a, b) => a.multipv - b.multipv,
        );

        if (partial.length === 0 && best) {
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
        return;
      }

      // Classic bestmove path
      if (pendingBestMoveResolver) {
        const resolve = pendingBestMoveResolver;
        pendingBestMoveResolver = null;
        resolve(best);
      }
    }
  };

  engineReady = false;

  // Start UCI
  sf.postMessage("uci");
  sf.postMessage("isready");

  // Apply slider after boot
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

  sf.postMessage(`setoption name Skill Level value ${skill}`);
  sf.postMessage(`setoption name Slow Mover value ${slowMover}`);
  sf.postMessage(`setoption name MultiPV value ${currentMultiPV}`);
  sf.postMessage("isready");

  logDebug(
    `Applied slider: ${elo} -> Skill ${skill}, Slow Mover ${slowMover}, MultiPV ${currentMultiPV}`,
  );
}

// ELO -> search params (makes slider feel real)
function engineParamsForElo(elo) {
  const t = Math.max(0, Math.min(1, (elo - 400) / (2500 - 400)));

  const movetimeMs = Math.round(80 + (elo - 400) * 0.12);
  const targetDepth = Math.round(6 + t * 8); // ~6..14
  const multiPV = t < 0.35 ? 3 : 5;

  return { movetimeMs, targetDepth, multiPV };
}

// Get top N candidate moves (MultiPV). Uses bestmove as fallback.
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
    setEngineThinking(true);

    currentMultiPV = multiPV;
    analysisTargetDepth = targetDepth;
    analysisBuffer = new Map();
    analysisBestDepthSeen = 0;

    pendingAnalysisResolver = candidates => resolve(candidates);

    // Fallback if we never get enough info lines
    pendingBestMoveResolver = best => {
      if (!pendingAnalysisResolver) return;

      const resolveAnalysis = pendingAnalysisResolver;
      pendingAnalysisResolver = null;

      engineBusy = false;
      setEngineThinking(false);

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
  ensureEngineInline(); // re-attach after textContent wipe
  highlightCheck();
}

function isHumansTurn() {
  const humanColor = $playWhite.checked ? "w" : "b";
  return game.turn() === humanColor;
}

function chooseHumanMove(candidates, elo) {
  if (!candidates || candidates.length === 0) return null;

  function effectiveCp(c) {
    if (c.scoreMate !== null) return Math.sign(c.scoreMate) * 100000;
    return c.scoreCp ?? 0;
  }

  const sorted = [...candidates].sort((a, b) => a.multipv - b.multipv);
  const best = sorted[0];
  const bestCp = effectiveCp(best);

  // ELO -> blunder behavior
  const t = Math.max(0, Math.min(1, (elo - 400) / (2500 - 400)));
  const blunderChance = (1 - t) * 0.28;
  const maxDrop = 500 - t * 450;

  // Slightly fewer blunders when position is "easy"
  const situational = Math.max(0.4, Math.min(1.0, 1 - (bestCp / 800) * 0.25));
  const finalBlunderChance = blunderChance * situational;

  const doBlunder = Math.random() < finalBlunderChance;
  if (!doBlunder) return best.moveUci;

  const allowed = sorted.filter(c => bestCp - effectiveCp(c) <= maxDrop);
  if (allowed.length === 0) return best.moveUci;

  const weights = allowed.map(c => {
    const drop = Math.max(0, bestCp - effectiveCp(c));
    return 1 / (1 + drop / 50);
  });

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
  const { movetimeMs, targetDepth, multiPV } = engineParamsForElo(elo);

  logDebug(
    `ELO ${elo}: movetime=${movetimeMs}ms depth≈${targetDepth} multipv=${multiPV}`,
  );

  const candidates = await getEngineCandidates({
    movetimeMs,
    multiPV,
    targetDepth,
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
  syncEloUI();
});

$elo.addEventListener("change", () => {
  syncEloUI();
  saveElo();

  applyEloToEngine(Number($elo.value));

  // If slider moved mid-think, stop engine and unlock UI
  if (engineBusy && sf) {
    sf.postMessage("stop");
    engineBusy = false;
    pendingBestMoveResolver = null;
    pendingAnalysisResolver = null;
    setEngineThinking(false);
  }
});

$playWhite.addEventListener("change", () => startNewGame());
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
  clearLastMoveHighlight();
});

$flip.addEventListener("click", () => board.flip());

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

  if (sf) {
    if (engineBusy) sf.postMessage("stop");

    engineBusy = false;
    pendingBestMoveResolver = null;
    pendingAnalysisResolver = null;
    setEngineThinking(false);

    engineReady = false;
    sf.postMessage("ucinewgame");
    sf.postMessage("isready");
  }

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
  boardEl.onclick = null;

  // Click-to-move (sticky pick up / put down)
  boardEl.addEventListener("click", e => {
    if (!$clickToMove?.checked) return;
    if (game.isGameOver()) return;
    if (!isHumansTurn()) return;

    e.stopPropagation();

    const sqEl = e.target.closest(".square-55d63");
    if (!sqEl) return;

    const square = sqEl.getAttribute("data-square");
    if (!square) return;

    if (!selectedSquare) {
      if (!isHumanPieceOn(square)) return;
      selectedSquare = square;
      highlightMovesFrom(square);
      return;
    }

    if (square === selectedSquare) {
      clearHighlights();
      selectedSquare = null;
      return;
    }

    if (isHumanPieceOn(square)) {
      selectedSquare = square;
      highlightMovesFrom(square);
      return;
    }

    const move = game.move({
      from: selectedSquare,
      to: square,
      promotion: "q",
    });

    if (move === null) return;

    board.position(game.fen(), true);
    updateStatus();
    renderMoveList();
    highlightLastMove(selectedSquare, square);

    clearHighlights();
    selectedSquare = null;

    setTimeout(maybeEnginePlays, 0);
  });

  // Click off-board cancels
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

  setDebugOpen(isOpen);

  $debugToggle.addEventListener("click", () => {
    const nowOpen = !$debugCard.classList.contains("is-open");
    setDebugOpen(nowOpen);
  });
})();

(function main() {
  initBoard();

  // Restore ELO before engine init
  loadSavedElo();

  // Handle Firefox/Back-Forward cache + form restore mismatch
  window.addEventListener("pageshow", () => syncEloUI());

  initStockfish();

  setEngineThinking(false);

  updateStatus();
  renderMoveList();

  setTimeout(maybeEnginePlays, 0);
})();
