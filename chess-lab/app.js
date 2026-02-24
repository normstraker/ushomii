console.log("app.js loaded");

/* global Chess, Chessboard */

/* ============================================================================
   ===== GLOBAL STATE =========================================================
   ============================================================================ */

let game = new Chess();
let board = null;

let engineReplyRequested = false;
let engineReplyTimer = null;

// Used to start the board at a restored FEN (or "start")
let initialPosition = "start";

// Used to restore board orientation ("white" or "black")
let initialOrientation = "white";

// Click-to-move selection
let selectedSquare = null;

// Stockfish / engine UI indicator
let $engineInline = null;
let thinkingDelayTimer = null;

/* ============================================================================
   ===== DOM REFERENCES =======================================================
   ============================================================================ */

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
const $movesCard = document.getElementById("movesCard");
const $blunder = document.getElementById("blunder");
const $blunderValue = document.getElementById("blunderValue");

/* ============================================================================
   ===== PERSISTENCE (FEN) ====================================================
   Save/restore current position using localStorage.
   ============================================================================ */

const STORAGE_FEN = "chesslab_fen_v1";

function saveFenToStorage() {
  try {
    localStorage.setItem(STORAGE_FEN, game.fen());
  } catch (_) {}
}

function loadFenFromStorage() {
  try {
    return localStorage.getItem(STORAGE_FEN);
  } catch (_) {
    return null;
  }
}

function clearFenFromStorage() {
  try {
    localStorage.removeItem(STORAGE_FEN);
  } catch (_) {}
}

const STORAGE_SETTINGS = "chesslab_settings_v1";

function saveSettingsToStorage() {
  try {
    const settings = {
      playWhite: $playWhite?.checked ?? true,
      clickToMove: $clickToMove?.checked ?? false,
      showMoveSquares: $showMoveSquares?.checked ?? true,
      showMoveDots: $showMoveDots?.checked ?? true,

      // Chessboard.js orientation: "white" | "black"
      orientation: board?.orientation?.() ?? initialOrientation,
    };

    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
  } catch (_) {}
}

function loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function applySettings(settings) {
  // If user has saved settings, respect them
  if (settings) {
    if ($playWhite) $playWhite.checked = !!settings.playWhite;
    if ($clickToMove) $clickToMove.checked = !!settings.clickToMove;
    if ($showMoveSquares) $showMoveSquares.checked = !!settings.showMoveSquares;
    if ($showMoveDots) $showMoveDots.checked = !!settings.showMoveDots;

    if (settings.orientation === "black" || settings.orientation === "white") {
      initialOrientation = settings.orientation;
    }
    return;
  }

  // No saved settings yet: choose touch-friendly defaults
  if ($clickToMove && isTouchDevice()) {
    $clickToMove.checked = true;
  }
}

/* ============================================================================
   ===== ENGINE REPLY TIMER (HUMAN-LIKE DELAY) ================================
   ============================================================================ */

function clearEngineReplyTimer() {
  if (engineReplyTimer) {
    clearTimeout(engineReplyTimer);
    engineReplyTimer = null;
  }
}

// Delay that feels human (and not twitchy)
function computeHumanDelayMs() {
  const elo = Number($elo.value);
  const t = Math.max(0, Math.min(1, (elo - 400) / (2500 - 400)));

  // Bigger + more natural:
  // low elo: ~900–1500ms
  // high elo: ~1400–2600ms
  return Math.round(900 + t * 900 + Math.random() * (600 + t * 200));
}

function scheduleEngineReplyAfterSnap() {
  clearEngineReplyTimer();

  const delay = computeHumanDelayMs();
  engineReplyTimer = setTimeout(() => {
    engineReplyTimer = null;
    engineReplyRequested = false;

    if (!game.isGameOver() && !isHumansTurn()) {
      maybeEnginePlays();
    }
  }, delay);
}

/* ============================================================================
   ===== INLINE ENGINE INDICATOR (Thinking…) =================================
   ============================================================================ */

function ensureEngineInline() {
  if ($engineInline || !$status) return;

  $engineInline = document.createElement("span");
  $engineInline.className = "engine-inline";
  $engineInline.hidden = true;
  $engineInline.setAttribute("aria-live", "polite");
  $engineInline.innerHTML = `<span class="spinner" aria-hidden="true"></span>Thinking…`;

  $status.appendChild($engineInline);
}

/* ============================================================================
   ===== DEBUG OUTPUT =========================================================
   ============================================================================ */

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

/* ============================================================================
   ===== ELO UI + PERSISTENCE =================================================
   ============================================================================ */

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

function syncBlunderUI() {
  if (!$blunder || !$blunderValue) return;
  $blunderValue.textContent = $blunder.value;
}

function loadSavedBlunder() {
  try {
    const saved = localStorage.getItem("chesslab_blunder");
    if (saved !== null && $blunder) $blunder.value = saved;
  } catch (_) {}
  syncBlunderUI();
}

function saveBlunder() {
  try {
    localStorage.setItem("chesslab_blunder", String($blunder.value));
  } catch (_) {}
}

/* ============================================================================
   ===== ENGINE THINKING / UI LOCK ===========================================
   ============================================================================ */

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

/* ============================================================================
   ===== MOVE LIST ============================================================
   ============================================================================ */

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

/* ============================================================================
   ===== BOARD HIGHLIGHTS (moves / last move / check) =========================
   ============================================================================ */

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

/* ============================================================================
   ===== STOCKFISH WORKER =====================================================
   ============================================================================ */

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

/* ============================================================================
   ===== GAME FLOW / STATUS ===================================================
   ============================================================================ */

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
  // Base behavior from ELO
  let blunderChance = (1 - t) * 0.28;
  let maxDrop = 500 - t * 450;

  // Blunder slider tweak (-100..+100), center=0
  const b = Number($blunder?.value ?? 0); // -100..100
  const u = Math.max(-1, Math.min(1, b / 100)); // -1..1

  // Left (u<0): more blunders + bigger drops
  // Right (u>0): fewer blunders + smaller drops
  const chanceMult = u < 0 ? 1 + -u * 1.25 : 1 - u * 0.75; // up to +125% / down to -75%
  const dropMult = u < 0 ? 1 + -u * 0.9 : 1 - u * 0.6; // up to +90% / down to -60%

  blunderChance *= chanceMult;
  maxDrop *= dropMult;

  // Clamp to sane bounds
  blunderChance = Math.max(0, Math.min(0.9, blunderChance));
  maxDrop = Math.max(30, Math.min(900, maxDrop));

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
    // Animate the piece sliding
    board.move(from + "-" + to);

    updateStatus();
    renderMoveList();
    highlightLastMove(from, to);

    // Persist after engine move
    saveFenToStorage();
  }
}

/* ============================================================================
   ===== DRAG / DROP HANDLERS (chessboard.js) =================================
   ============================================================================ */

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

  const move = game.move({ from: source, to: target, promotion: "q" });
  if (move === null) return "snapback";

  updateStatus();
  renderMoveList();
  highlightLastMove(source, target);

  // Persist after human drag move
  saveFenToStorage();

  clearHighlights();
  selectedSquare = null;

  // Request engine reply, but wait until snap animation finishes (onSnapEnd)
  engineReplyRequested = true;
}

function onSnapEnd() {
  board.position(game.fen());

  // Now that the human move has visually finished, start the engine delay clock
  if (engineReplyRequested) {
    scheduleEngineReplyAfterSnap();
  }
}

/* ============================================================================
   ===== CONTROLS (ELO / NEW GAME / UNDO / FLIP / HIGHLIGHTS) =================
   ============================================================================ */

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

$playWhite.addEventListener("change", () => {
  saveSettingsToStorage();
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

$clickToMove?.addEventListener("change", () => {
  saveSettingsToStorage();
  syncDraggableMode();
});

$showMoveSquares?.addEventListener("change", () => {
  clearHighlights();
  if (selectedSquare) highlightMovesFrom(selectedSquare);
  saveSettingsToStorage();
});

$showMoveDots?.addEventListener("change", () => {
  clearHighlights();
  if (selectedSquare) highlightMovesFrom(selectedSquare);
  saveSettingsToStorage();
});

$blunder?.addEventListener("input", () => {
  syncBlunderUI();
});

$blunder?.addEventListener("change", () => {
  syncBlunderUI();
  saveBlunder();
});

// ===== UNDO CONTROL =====
$undo.addEventListener("click", () => {
  if (game.history().length === 0) return;

  // Cancel any scheduled engine reply
  engineReplyRequested = false;
  clearEngineReplyTimer();

  game.undo();
  if (!isHumansTurn() && game.history().length > 0) game.undo();

  board.position(game.fen(), true);
  updateStatus();
  renderMoveList();
  clearLastMoveHighlight();

  // Persist after undo
  saveFenToStorage();
});

$flip.addEventListener("click", () => {
  board.flip();
  saveSettingsToStorage();
});

/* ============================================================================
   ===== NEW GAME =============================================================
   ============================================================================ */

function startNewGame() {
  game = new Chess();
  board.start(true);

  // Clear saved game state and save fresh start
  clearFenFromStorage();
  saveFenToStorage();

  // Cancel any scheduled engine reply
  engineReplyRequested = false;
  clearEngineReplyTimer();

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

  // --- Human-like engine delay ---
  const elo = Number($elo.value);
  const t = Math.max(0, Math.min(1, (elo - 400) / (2500 - 400)));
  const delay = Math.round(350 + t * 700 + Math.random() * 400);

  setTimeout(() => {
    if (!game.isGameOver() && !isHumansTurn()) {
      maybeEnginePlays();
    }
  }, delay);
}

function syncDraggableMode() {
  if (!board) return;

  const wantDrag = !$clickToMove?.checked;
  // chessboard.js supports changing draggable after init
  board.draggable = wantDrag;

  // Also update the config if available (some builds expose it)
  if (board.cfg) board.cfg.draggable = wantDrag;
}

/* ============================================================================
   ===== BOARD INIT + CLICK-TO-MOVE ==========================================
   ============================================================================ */

function initBoard() {
  board = Chessboard("board", {
    position: initialPosition,
    orientation: initialOrientation, // ✅ restore flip state
    draggable: true,
    pieceTheme: "./vendor/chessboardjs/img/chesspieces/wikipedia/{piece}.png",
    onDragStart,
    onDrop,
    onSnapEnd,
  });

  syncDraggableMode();

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

    // 1) Selecting a piece
    if (!selectedSquare) {
      if (!isHumanPieceOn(square)) return;
      selectedSquare = square;
      highlightMovesFrom(square);
      return;
    }

    // 2) Clicking the same square cancels
    if (square === selectedSquare) {
      clearHighlights();
      selectedSquare = null;
      return;
    }

    // 3) Clicking another of your pieces changes selection
    if (isHumanPieceOn(square)) {
      selectedSquare = square;
      highlightMovesFrom(square);
      return;
    }

    // 4) Try move to destination
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

    // Persist after click-to-move
    saveFenToStorage();

    clearHighlights();
    selectedSquare = null;

    engineReplyRequested = true;
    clearEngineReplyTimer();

    // Give the browser a tick to paint the human move, then start the “human” delay
    setTimeout(() => {
      if (engineReplyRequested) scheduleEngineReplyAfterSnap();
    }, 50);
  });

  // Click off-board cancels selection
  document.removeEventListener("click", window.__chesslabCancelClickToMove);
  window.__chesslabCancelClickToMove = function () {
    if (!$clickToMove?.checked) return;
    if (!selectedSquare) return;
    clearHighlights();
    selectedSquare = null;
  };
  document.addEventListener("click", window.__chesslabCancelClickToMove);
}
/* ============================================================================
   ===== RESPONSIVE UI (board resize + moves collapse) =========================
   ============================================================================ */

const STORAGE_MOVES_OPEN = "chesslab_moves_open_v1";
const MOBILE_BP = 900; // match your CSS breakpoint

function debounce(fn, wait = 120) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function afterLayoutChange() {
  // Let DOM reflow, then resize chessboard.js
  requestAnimationFrame(() => {
    if (board && typeof board.resize === "function") board.resize();
  });
}

const handleWindowResize = debounce(() => {
  // Auto-collapse moves on mobile widths unless user explicitly opened it
  enforceMobileMovesRule();
  afterLayoutChange();
}, 120);

window.addEventListener("resize", handleWindowResize);

function setMovesOpen(isOpen, { persist = true } = {}) {
  if (!$movesCard) return;

  $movesCard.classList.toggle("is-open", isOpen);
  $movesCard.classList.toggle("is-collapsed", !isOpen);

  if (persist) {
    try {
      localStorage.setItem(STORAGE_MOVES_OPEN, isOpen ? "1" : "0");
    } catch (_) {}
  }

  afterLayoutChange();
}

function getSavedMovesOpen() {
  try {
    const raw = localStorage.getItem(STORAGE_MOVES_OPEN);
    if (raw === null) return null; // not set
    return raw === "1";
  } catch (_) {
    return null;
  }
}

// Rule:
// - On mobile (< MOBILE_BP), default moves collapsed unless user has a saved pref.
// - On desktop, default open.
function enforceMobileMovesRule() {
  if (!$movesCard) return;

  const saved = getSavedMovesOpen();
  const isMobile = window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches;

  if (saved === null) {
    setMovesOpen(!isMobile, { persist: false });
    return;
  }

  // Respect user preference always
  setMovesOpen(saved, { persist: false });
}

function initMovesCollapse() {
  if (!$movesCard) return;

  // Make header clickable (like debug)
  const titleEl = $movesCard.querySelector(".card-title");
  if (titleEl) {
    titleEl.classList.add("collapsible");
    titleEl.setAttribute("role", "button");
    titleEl.setAttribute("tabindex", "0");

    // Add chevron if not present
    if (!titleEl.querySelector(".chev")) {
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.textContent = "▸";
      titleEl.appendChild(chev);
    }

    const toggle = () => {
      const nowOpen = !$movesCard.classList.contains("is-open");
      setMovesOpen(nowOpen, { persist: true });
    };

    titleEl.addEventListener("click", toggle);
    titleEl.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  }

  enforceMobileMovesRule();
}
/* ============================================================================
   ===== DEBUG PANEL COLLAPSE STATE ==========================================
   ============================================================================ */

function setDebugOpen(isOpen) {
  if (!$debugCard) return;

  $debugCard.classList.toggle("is-open", isOpen);
  $debugCard.classList.toggle("is-collapsed", !isOpen);

  try {
    localStorage.setItem("chesslab_debug_open", isOpen ? "1" : "0");
  } catch (_) {}

  afterLayoutChange();
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

/* ============================================================================
   ===== TOUCH DEVICES ========================================================
   ============================================================================ */

function isTouchDevice() {
  // Covers iOS/Android + touch laptops in a reasonable way
  return (
    window.matchMedia?.("(pointer: coarse)").matches ||
    "ontouchstart" in window ||
    (navigator.maxTouchPoints ?? 0) > 0
  );
}
/* ============================================================================
   ===== MAIN INIT ============================================================
   ============================================================================ */

(function main() {
  // Restore saved game (FEN) before board init so board starts in correct position
  const savedFen = loadFenFromStorage();

  if (savedFen) {
    try {
      game.load(savedFen);
      initialPosition = savedFen;
    } catch (_) {
      // Invalid saved fen -> reset
      game = new Chess();
      initialPosition = "start";
      clearFenFromStorage();
      saveFenToStorage();
    }
  } else {
    initialPosition = "start";
  }

  // Restore saved UI settings (play side, highlights, click-to-move, orientation)
  const savedSettings = loadSettingsFromStorage();
  applySettings(savedSettings);

  initBoard();
  initMovesCollapse();

  // Restore ELO before engine init
  loadSavedElo();

  loadSavedBlunder();

  // Handle Firefox/Back-Forward cache + form restore mismatch
  window.addEventListener("pageshow", () => {
    syncEloUI();
    syncBlunderUI();
  });

  initStockfish();

  setEngineThinking(false);

  updateStatus();
  renderMoveList();
  afterLayoutChange();

  // Ensure we save at least once on fresh loads
  saveFenToStorage();

  setTimeout(maybeEnginePlays, 0);
})();
