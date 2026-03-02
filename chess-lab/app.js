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

let analysisMode = false;

// Stockfish / engine UI indicator
let $engineInline = null;
let thinkingDelayTimer = null;

let reviewMode = false;

let review = {
  plys: [], // [{ fen, san, uci, turn, moveNumber }]
  evals: [], // [{ cp, mate, povCp }]
  blunders: [], // [{ plyIndex, drop, label }]
  currentPly: 0,
  running: false,
};

/* ============================================================================
   ===== DOM REFERENCES =======================================================
   ============================================================================ */

const $status = document.getElementById("status");
const $debug = document.getElementById("debug");
const $moves = document.getElementById("moves");
const $reviewMoves = document.getElementById("reviewMoves");
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
const $themeCard = document.getElementById("themeCard");
const $themeToggle = document.getElementById("themeToggle");
const $themeSqLight = document.getElementById("themeSqLight");
const $themeSqDark = document.getElementById("themeSqDark");
const $themeHlSelected = document.getElementById("themeHlSelected");
const $themeHlLastFrom = document.getElementById("themeHlLastFrom");
const $themeHlLastTo = document.getElementById("themeHlLastTo");
const $themeHlCheck = document.getElementById("themeHlCheck");
const $themeReset = document.getElementById("themeReset");
const $pieceSet = document.getElementById("pieceSet");
const $uiTheme = document.getElementById("uiTheme");
const $analysisMode = document.getElementById("analysisMode");
const $analysisLine = document.getElementById("analysisLine");
const $reviewGame = document.getElementById("reviewGame");
const $reviewCard = document.getElementById("reviewCard");
const $reviewToggle = document.getElementById("reviewToggle");
const $reviewBody = document.getElementById("reviewBody");
const $reviewStatus = document.getElementById("reviewStatus");
const $evalGraph = document.getElementById("evalGraph");
const $reviewPrev = document.getElementById("reviewPrev");
const $reviewNext = document.getElementById("reviewNext");
const $reviewExit = document.getElementById("reviewExit");
const $criticalList = document.getElementById("criticalList");

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

// ======================
// PGN persistence (move history)
// ======================
const STORAGE_PGN = "chesslab_pgn_v1";

function savePgnToStorage() {
  try {
    localStorage.setItem(STORAGE_PGN, game.pgn());
  } catch (_) {}
}

function loadPgnFromStorage() {
  try {
    return localStorage.getItem(STORAGE_PGN);
  } catch (_) {
    return null;
  }
}

function clearPgnFromStorage() {
  try {
    localStorage.removeItem(STORAGE_PGN);
  } catch (_) {}
}

// chess.js compatibility wrapper (some builds use load_pgn, some loadPgn)
function loadPgnIntoGame(chessInstance, pgn) {
  if (!pgn) return false;
  try {
    if (typeof chessInstance.load_pgn === "function") {
      return chessInstance.load_pgn(pgn, { sloppy: true });
    }
    if (typeof chessInstance.loadPgn === "function") {
      return chessInstance.loadPgn(pgn, { sloppy: true });
    }
  } catch (_) {}
  return false;
}

const STORAGE_SETTINGS = "chesslab_settings_v1";

function saveSettingsToStorage() {
  try {
    const settings = {
      playWhite: $playWhite?.checked ?? true,
      clickToMove: $clickToMove?.checked ?? false,
      showMoveSquares: $showMoveSquares?.checked ?? true,
      showMoveDots: $showMoveDots?.checked ?? true,
      analysisMode: $analysisMode?.checked ?? false,
      uiMode: document.documentElement.getAttribute("data-ui") || "dark",
      pieceSet: $pieceSet?.value || currentPieceSet || "wikipedia",
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
    if (settings.uiMode) applyUiMode(settings.uiMode);
    if (settings.pieceSet && PIECE_SET_MAP[settings.pieceSet]) {
      currentPieceSet = settings.pieceSet;
      if ($pieceSet) $pieceSet.value = settings.pieceSet;
    }
    if ($analysisMode) $analysisMode.checked = !!settings.analysisMode;
    analysisMode = !!settings.analysisMode;
    syncAnalysisUi();
    if (settings.orientation === "black" || settings.orientation === "white") {
      initialOrientation = settings.orientation;
    }
    return;
  }

  // No saved settings yet: choose touch-friendly defaults
  if ($clickToMove && isTouchDevice()) {
    $clickToMove.checked = true;
  }
  analysisMode = false;
  syncAnalysisUi();
  applyUiMode("dark");
  currentPieceSet = "wikipedia";
  if ($pieceSet) $pieceSet.value = "wikipedia";
}

/* ============================================================================
   ===== THEME (CSS VARS + localStorage) ======================================
   Live update board/UI colors via CSS variables.
   ============================================================================ */

const STORAGE_THEME = "chesslab_theme_v1";

function hexToRgba(hex, alpha = 1) {
  if (!hex) return `rgba(0,0,0,${alpha})`;

  let h = String(hex).trim();
  if (!h.startsWith("#")) h = "#" + h;

  // Expand #rgb -> #rrggbb
  if (h.length === 4) {
    h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  }

  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);

  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(0,0,0,${alpha})`;
  }

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function setThemeVar(name, value) {
  try {
    document.documentElement.style.setProperty(name, value);
  } catch (_) {}
}

function getDefaultTheme() {
  return {
    "--sq-light": "#f0d9b5",
    "--sq-dark": "#b58863",
    "--hl-selected": hexToRgba("#ffd700", 0.55),
    "--hl-last-from": hexToRgba("#00ff78", 0.55),
    "--hl-last-to": hexToRgba("#00ff78", 0.35),
    "--hl-check": hexToRgba("#ff0000", 0.75),
    "--hl-check-soft": hexToRgba("#ff0000", 0.55),
    "--hl-check-strong": hexToRgba("#ff0000", 0.85),
    "--hl-check-glow": hexToRgba("#ff0000", 0.35),
  };
}

function saveThemeToStorage(themeObj) {
  try {
    localStorage.setItem(STORAGE_THEME, JSON.stringify(themeObj));
  } catch (_) {}
}

function loadThemeFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_THEME);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function applyTheme(themeObj) {
  if (!themeObj) return;
  for (const [k, v] of Object.entries(themeObj)) setThemeVar(k, v);
}

function buildThemeFromInputs() {
  return {
    "--sq-light": $themeSqLight?.value ?? "#f0d9b5",
    "--sq-dark": $themeSqDark?.value ?? "#b58863",
    "--hl-selected": hexToRgba($themeHlSelected?.value ?? "#ffd700", 0.55),
    "--hl-last-from": hexToRgba($themeHlLastFrom?.value ?? "#00ff78", 0.55),
    "--hl-last-to": hexToRgba($themeHlLastTo?.value ?? "#00ff78", 0.35),
    "--hl-check": hexToRgba($themeHlCheck?.value ?? "#ff0000", 0.75),
    "--hl-check-soft": hexToRgba($themeHlCheck?.value ?? "#ff0000", 0.55),
    "--hl-check-strong": hexToRgba($themeHlCheck?.value ?? "#ff0000", 0.85),
    "--hl-check-glow": hexToRgba($themeHlCheck?.value ?? "#ff0000", 0.35),
  };
}

function setInputsToDefaults() {
  if ($themeSqLight) $themeSqLight.value = "#f0d9b5";
  if ($themeSqDark) $themeSqDark.value = "#b58863";
  if ($themeHlSelected) $themeHlSelected.value = "#ffd700";
  if ($themeHlLastFrom) $themeHlLastFrom.value = "#00ff78";
  if ($themeHlLastTo) $themeHlLastTo.value = "#00ff78";
  if ($themeHlCheck) $themeHlCheck.value = "#ff0000";
}

function afterLayoutChange() {
  requestAnimationFrame(() => {
    if (board && typeof board.resize === "function") board.resize();
  });
}

function applyAndSaveThemeFromInputs() {
  const themeObj = buildThemeFromInputs();
  applyTheme(themeObj);
  saveThemeToStorage(themeObj);
  afterLayoutChange();
}

function resetThemeToDefaults() {
  setInputsToDefaults();
  const themeObj = getDefaultTheme();
  applyTheme(themeObj);
  saveThemeToStorage(themeObj);
  afterLayoutChange();
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

function computeHumanDelayMs() {
  if (analysisMode) return 0;

  const elo = Number($elo.value);
  const t = Math.max(0, Math.min(1, (elo - 400) / (2500 - 400)));
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

async function requestAnalysisNow() {
  if (!analysisMode) return;
  if (!sf) return;
  if (engineBusy) return;
  if (game.isGameOver()) return;

  const fenAtRequest = game.fen();

  const candidates = await getEngineCandidates({
    movetimeMs: 250,
    multiPV: 1,
    targetDepth: 12,
  });

  if (game.fen() !== fenAtRequest) return;

  const best = candidates?.[0];
  if (!best || !$analysisLine) return;

  const score =
    best.scoreMate !== null
      ? `mate ${best.scoreMate}`
      : best.scoreCp !== null
        ? `${best.scoreCp} cp`
        : `—`;

  $analysisLine.textContent = `Best: ${best.moveUci}  |  ${score}`;
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

function scoreToPovCp(scoreCp, scoreMate, povColor /* 'w' or 'b' */) {
  // Stockfish scores are from side-to-move POV (commonly).
  // For a consistent graph, we convert to "White POV".
  // We treat mate as huge cp.
  let cp;
  if (scoreMate !== null) cp = Math.sign(scoreMate) * 100000;
  else cp = scoreCp ?? 0;

  // If we want White POV, and it's Black POV, invert
  // We'll define povColor = 'w' means "white advantage positive"
  // Our cp is assumed "side-to-move"; we will rebase using FEN turn.
  // We'll do the rebase elsewhere with fenTurn.
  return cp;
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

function syncAnalysisUi() {
  if (!$analysisLine) return;
  $analysisLine.style.display = analysisMode ? "block" : "none";
  if (!analysisMode) $analysisLine.textContent = "—";
}

function setAnalysisMode(on) {
  analysisMode = !!on;
  if ($analysisMode) $analysisMode.checked = analysisMode;
  syncAnalysisUi();

  // When switching ON, analyze immediately (current position)
  if (analysisMode) requestAnalysisNow();
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

function clearLastMoveHighlight() {
  $("#board .square-55d63").removeClass("square-last-from square-last-to");
}
function highlightLastMove(from, to) {
  clearLastMoveHighlight();
  $(`#board .square-55d63[data-square="${from}"]`).addClass("square-last-from");
  $(`#board .square-55d63[data-square="${to}"]`).addClass("square-last-to");
}

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
   ===== UI MODE + PIECES =====================================================
   ============================================================================ */

function applyUiMode(mode) {
  const m = mode === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-ui", m);

  if ($uiTheme) $uiTheme.checked = m === "dark";
}

const PIECE_SET_MAP = {
  wikipedia: "./vendor/chessboardjs/img/chesspieces/wikipedia/{piece}.png",
  alpha: "./vendor/chessboardjs/img/chesspieces/alpha/{piece}.png",
  uscf: "./vendor/chessboardjs/img/chesspieces/uscf/{piece}.png",
  merida: "./vendor/chessboardjs/img/chesspieces/merida/{piece}.svg",
  cburnett: "./vendor/chessboardjs/img/chesspieces/cburnett/{piece}.svg",
};

let currentPieceSet = "wikipedia";

function getPieceThemePath() {
  return PIECE_SET_MAP[currentPieceSet] || PIECE_SET_MAP.wikipedia;
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

      engineBusy = false;
      setEngineThinking(false);

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

  sf.postMessage(`setoption name Skill Level value ${skill}`);
  sf.postMessage(`setoption name Slow Mover value ${slowMover}`);
  sf.postMessage(`setoption name MultiPV value ${currentMultiPV}`);
  sf.postMessage("isready");

  logDebug(
    `Applied slider: ${elo} -> Skill ${skill}, Slow Mover ${slowMover}, MultiPV ${currentMultiPV}`,
  );
}

function engineParamsForElo(elo) {
  const t = Math.max(0, Math.min(1, (elo - 400) / (2500 - 400)));
  const movetimeMs = Math.round(80 + (elo - 400) * 0.12);
  const targetDepth = Math.round(6 + t * 8); // ~6..14
  const multiPV = t < 0.35 ? 3 : 5;
  return { movetimeMs, targetDepth, multiPV };
}

function getEngineCandidates({
  movetimeMs = 200,
  multiPV = 5,
  targetDepth = 10,
  fenOverride = null,
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
    const fen = arguments[0]?.fenOverride || game.fen();
    sf.postMessage(`position fen ${fenOverride || game.fen()}`);
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
  ensureEngineInline();

  // Show Review button only when game is over
  if ($reviewGame) {
    $reviewGame.style.display = game.isGameOver() ? "" : "none";
  }

  // Keep review card hidden unless actively reviewing
  if (!reviewMode) setReviewOpen(false);

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

  const t = Math.max(0, Math.min(1, (elo - 400) / (2500 - 400)));
  let blunderChance = (1 - t) * 0.28;
  let maxDrop = 500 - t * 450;

  const b = Number($blunder?.value ?? 0); // -100..100
  const u = Math.max(-1, Math.min(1, b / 100));

  const chanceMult = u < 0 ? 1 + -u * 1.25 : 1 - u * 0.75;
  const dropMult = u < 0 ? 1 + -u * 0.9 : 1 - u * 0.6;

  blunderChance *= chanceMult;
  maxDrop *= dropMult;

  blunderChance = Math.max(0, Math.min(0.9, blunderChance));
  maxDrop = Math.max(30, Math.min(900, maxDrop));

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

  const sum = weights.reduce((a, b2) => a + b2, 0);
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

  if (game.fen() !== fenAtRequest) return;

  const chosen = chooseHumanMove(candidates, elo);
  if (!chosen) return;

  logDebug(`engine move: ${chosen} (best ${candidates[0]?.moveUci ?? "?"})`);

  const from = chosen.slice(0, 2);
  const to = chosen.slice(2, 4);
  const promo = chosen.length >= 5 ? chosen[4] : undefined;

  const move = game.move({ from, to, promotion: promo || "q" });
  if (move) {
    board.move(from + "-" + to);

    updateStatus();
    renderMoveList();
    highlightLastMove(from, to);

    saveFenToStorage();
    savePgnToStorage();

    // After engine moves, it's the human's turn -> safe to analyze
    if (analysisMode) requestAnalysisNow();
  }
}

/* ============================================================================
   ===== DRAG / DROP HANDLERS (chessboard.js) =================================
   ============================================================================ */

function onDragStart(source, piece) {
  if (reviewMode) return false;
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
  savePgnToStorage();

  clearHighlights();
  selectedSquare = null;

  // IMPORTANT: do NOT analyze here (it would block engine move).
  // We'll analyze after engine replies (when it's the human's turn).
  engineReplyRequested = true;
}

function onSnapEnd() {
  board.position(game.fen());

  if (engineReplyRequested) {
    engineReplyRequested = false; // prevents double-fire
    scheduleEngineReplyAfterSnap(); // analysisMode => instant (0ms)
  }
}

/* ============================================================================
   ===== CONTROLS (ELO / NEW GAME / UNDO / FLIP / HIGHLIGHTS) =================
   ============================================================================ */

$elo.addEventListener("input", () => syncEloUI());

$elo.addEventListener("change", () => {
  syncEloUI();
  saveElo();

  applyEloToEngine(Number($elo.value));

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

$clickToMove?.addEventListener("change", () => {
  saveSettingsToStorage();
  syncDraggableMode();
});

$uiTheme?.addEventListener("change", () => {
  applyUiMode($uiTheme.checked ? "dark" : "light");
  saveSettingsToStorage();
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

$blunder?.addEventListener("input", () => syncBlunderUI());

$blunder?.addEventListener("change", () => {
  syncBlunderUI();
  saveBlunder();
});

$analysisMode?.addEventListener("change", () => {
  setAnalysisMode($analysisMode.checked);
  saveSettingsToStorage();
});

$reviewGame?.addEventListener("click", () => startPostGameReview());

$reviewPrev?.addEventListener("click", () =>
  gotoReviewPly(review.currentPly - 1),
);
$reviewNext?.addEventListener("click", () =>
  gotoReviewPly(review.currentPly + 1),
);
$reviewExit?.addEventListener("click", () => exitReview());

// Collapsible Review card
$reviewToggle?.addEventListener("click", () => {
  const nowOpen = !$reviewCard.classList.contains("is-open");
  $reviewCard.classList.toggle("is-open", nowOpen);
  $reviewCard.classList.toggle("is-collapsed", !nowOpen);
  afterLayoutChange();
});

// ===== UNDO CONTROL =====
$undo.addEventListener("click", () => {
  if (game.history().length === 0) return;

  engineReplyRequested = false;
  clearEngineReplyTimer();

  game.undo();
  if (!isHumansTurn() && game.history().length > 0) game.undo();

  board.position(game.fen(), true);
  updateStatus();
  renderMoveList();
  clearLastMoveHighlight();

  saveFenToStorage();
  savePgnToStorage();

  // After undo it's always human's turn in your logic -> safe to analyze
  if (analysisMode) requestAnalysisNow();
});

$flip.addEventListener("click", () => {
  board.flip();
  saveSettingsToStorage();
});

$pieceSet?.addEventListener("change", () => {
  const set = $pieceSet.value;
  if (!PIECE_SET_MAP[set]) return;
  currentPieceSet = set;
  rebuildBoardWithPieceTheme(getPieceThemePath());
  saveSettingsToStorage();
});

/* ============================================================================
   ===== NEW GAME =============================================================
   ============================================================================ */

function startNewGame() {
  game = new Chess();
  board.start(true);

  clearFenFromStorage();
  clearPgnFromStorage();
  saveFenToStorage();
  savePgnToStorage();

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

  // If human chose Black, engine should open immediately (analysisMode => instant anyway)
  setTimeout(() => {
    if (game.isGameOver()) return;

    if (!isHumansTurn()) {
      maybeEnginePlays();
    } else if (analysisMode) {
      requestAnalysisNow();
    }
  }, 0);
}

function syncDraggableMode() {
  if (!board) return;

  const wantDrag = !$clickToMove?.checked;
  board.draggable = wantDrag;
  if (board.cfg) board.cfg.draggable = wantDrag;
}

function rebuildBoardWithPieceTheme(pieceThemePath) {
  if (!board) return;

  const fen = game.fen();
  const orient = board.orientation?.() ?? initialOrientation;

  if (typeof board.destroy === "function") {
    board.destroy();
  } else {
    document.getElementById("board").innerHTML = "";
  }

  board = Chessboard("board", {
    position: fen,
    orientation: orient,
    draggable: !$clickToMove?.checked,
    pieceTheme: pieceThemePath,
    onDragStart,
    onDrop,
    onSnapEnd,
  });

  syncDraggableMode();
  afterLayoutChange();

  if (selectedSquare) highlightMovesFrom(selectedSquare);
}

/* ============================================================================
   ===== BOARD INIT + CLICK-TO-MOVE ==========================================
   ============================================================================ */

function initBoard() {
  board = Chessboard("board", {
    position: initialPosition,
    orientation: initialOrientation,
    draggable: true,
    pieceTheme: getPieceThemePath(),
    onDragStart,
    onDrop,
    onSnapEnd,
  });

  syncDraggableMode();

  const boardEl = document.getElementById("board");
  boardEl.onclick = null;

  boardEl.addEventListener("click", e => {
    if (reviewMode) return;
    if (!$clickToMove?.checked) return;
    if (game.isGameOver()) return;
    if (!isHumansTurn()) return;

    e.stopPropagation();

    const sqEl = e.target.closest(".square-55d63");
    if (!sqEl) return;

    const square = sqEl.getAttribute("data-square");
    if (!square) return;

    // 1) Select a piece
    if (!selectedSquare) {
      if (!isHumanPieceOn(square)) return;
      selectedSquare = square;
      highlightMovesFrom(square);
      return;
    }

    // 2) Same square cancels
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

    saveFenToStorage();
    savePgnToStorage();

    clearHighlights();
    selectedSquare = null;

    engineReplyRequested = true;
    clearEngineReplyTimer();

    // Always schedule reply; analysisMode => 0ms delay
    setTimeout(() => {
      if (!engineReplyRequested) return;
      scheduleEngineReplyAfterSnap();
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
const MOBILE_BP = 900;

function debounce(fn, wait = 120) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

let __boardResizeObserver = null;

function initBoardResizeObserver() {
  const boardWrap = document.querySelector(".board");
  if (!boardWrap || typeof ResizeObserver === "undefined") return;

  if (__boardResizeObserver) {
    try {
      __boardResizeObserver.disconnect();
    } catch (_) {}
  }

  __boardResizeObserver = new ResizeObserver(() => afterLayoutChange());
  __boardResizeObserver.observe(boardWrap);
}

const handleWindowResize = debounce(() => {
  enforceMobileMovesRule();
  afterLayoutChange();
}, 120);

window.addEventListener("resize", handleWindowResize);

window.addEventListener("orientationchange", () => {
  setTimeout(() => {
    enforceMobileMovesRule();
    afterLayoutChange();
  }, 200);
});

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
    if (raw === null) return null;
    return raw === "1";
  } catch (_) {
    return null;
  }
}

function enforceMobileMovesRule() {
  if (!$movesCard) return;

  const saved = getSavedMovesOpen();
  const isMobile = window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches;

  if (saved === null) {
    setMovesOpen(!isMobile, { persist: false });
    return;
  }

  setMovesOpen(saved, { persist: false });
}

function initMovesCollapse() {
  const $movesToggle = document.getElementById("movesToggle");
  if (!$movesCard || !$movesToggle) return;

  const toggle = () => {
    const nowOpen = !$movesCard.classList.contains("is-open");
    setMovesOpen(nowOpen, { persist: true });
  };

  $movesToggle.addEventListener("click", toggle);
  $movesToggle.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });

  enforceMobileMovesRule();
}

/* ============================================================================
   ===== THEME PANEL COLLAPSE STATE ==========================================
   ============================================================================ */

function setThemeOpen(isOpen) {
  if (!$themeCard) return;

  $themeCard.classList.toggle("is-open", isOpen);
  $themeCard.classList.toggle("is-collapsed", !isOpen);

  try {
    localStorage.setItem("chesslab_theme_open", isOpen ? "1" : "0");
  } catch (_) {}

  afterLayoutChange();
}

function initThemeCollapse() {
  if (!$themeCard || !$themeToggle) return;

  let isOpen = false;
  try {
    isOpen = localStorage.getItem("chesslab_theme_open") === "1";
  } catch (_) {}

  setThemeOpen(isOpen);

  $themeToggle.addEventListener("click", () => {
    const nowOpen = !$themeCard.classList.contains("is-open");
    setThemeOpen(nowOpen);
  });
}

/* ============================================================================
   ===== THEME EVENTS (color pickers) ========================================
   ============================================================================ */

function initThemeControls() {
  if (
    !$themeSqLight ||
    !$themeSqDark ||
    !$themeHlSelected ||
    !$themeHlLastFrom ||
    !$themeHlLastTo ||
    !$themeHlCheck
  ) {
    return;
  }

  const handlers = [
    $themeSqLight,
    $themeSqDark,
    $themeHlSelected,
    $themeHlLastFrom,
    $themeHlLastTo,
    $themeHlCheck,
  ];

  handlers.forEach(el => {
    el.addEventListener("input", () => applyAndSaveThemeFromInputs());
  });

  if ($themeReset) {
    $themeReset.addEventListener("click", () => resetThemeToDefaults());
  }
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
  return (
    window.matchMedia?.("(pointer: coarse)").matches ||
    "ontouchstart" in window ||
    (navigator.maxTouchPoints ?? 0) > 0
  );
}

/* ============================================================================
   ===== POST-GAME REVIEW MODE ================================================
   ============================================================================ */

function setReviewOpen(isOpen) {
  if (!$reviewCard) return;

  $reviewCard.style.display = isOpen ? "" : "none";
  $reviewCard.classList.toggle("is-open", isOpen);
  $reviewCard.classList.toggle("is-collapsed", !isOpen);
  afterLayoutChange();
}

function setReviewMode(on) {
  reviewMode = !!on;

  // Lock the board from interaction in review mode
  if (board) {
    board.draggable = !reviewMode && !$clickToMove?.checked;
    if (board.cfg) board.cfg.draggable = board.draggable;
  }

  // Disable gameplay buttons in review mode
  if ($undo) $undo.disabled = reviewMode;
  if ($newGame) $newGame.disabled = false; // allow new game anytime
  if ($elo) $elo.disabled = reviewMode;
  if ($playWhite) $playWhite.disabled = reviewMode;

  if ($clickToMove) $clickToMove.disabled = reviewMode;
  if ($showMoveSquares) $showMoveSquares.disabled = reviewMode;
  if ($showMoveDots) $showMoveDots.disabled = reviewMode;

  // Swap move list UI
  if ($moves) $moves.style.display = reviewMode ? "none" : "";
  if ($reviewMoves) $reviewMoves.style.display = reviewMode ? "" : "none";

  if (!reviewMode) {
    setReviewOpen(false);
    if ($reviewGame) $reviewGame.style.display = "none";
  }
}

function buildPlyListFromGame() {
  const tmp = new Chess();
  const plys = [];

  // ply 0 (start)
  plys.push({
    fen: tmp.fen(),
    san: "(start)",
    uci: "",
    turn: tmp.turn(),
    moveNumber: 0,
  });

  // Try verbose first, but fall back safely
  let hist;
  try {
    hist = game.history({ verbose: true });
  } catch (_) {
    hist = null;
  }

  // If verbose isn't supported (or returns strings), use SAN list
  const isVerboseObjects =
    Array.isArray(hist) && hist.length > 0 && typeof hist[0] === "object";

  if (!isVerboseObjects) {
    const sans = game.history(); // array of SAN strings
    for (let i = 0; i < sans.length; i++) {
      const san = sans[i];

      // sloppy:true helps SAN parsing across chess.js variants
      const mv = tmp.move(san, { sloppy: true }) || tmp.move(san);
      if (!mv) continue;

      const uci = `${mv.from}${mv.to}${mv.promotion || ""}`;
      plys.push({
        fen: tmp.fen(),
        san: mv.san || san,
        uci,
        turn: tmp.turn(),
        moveNumber: Math.floor(i / 2) + 1,
      });
    }

    return plys;
  }

  // Verbose objects path
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i];

    // m should be { from,to,san,promotion,... }
    const mv = tmp.move(m);
    if (!mv) continue;

    const uci = `${m.from}${m.to}${m.promotion || ""}`;
    plys.push({
      fen: tmp.fen(),
      san: m.san || mv.san,
      uci,
      turn: tmp.turn(),
      moveNumber: Math.floor(i / 2) + 1,
    });
  }

  return plys;
}

async function analyzeFenOnce(fen, opts = {}) {
  const { movetimeMs = 160, targetDepth = 10 } = opts;

  const candidates = await getEngineCandidates({
    movetimeMs,
    multiPV: 1,
    targetDepth,
    fenOverride: fen,
  });

  const best = candidates?.[0];
  if (!best) return { cp: 0, mate: null };

  return {
    cp: best.scoreCp ?? 0,
    mate: best.scoreMate ?? null,
  };
}

function fenTurn(fen) {
  // fen: ".... w ..."
  const parts = String(fen).split(" ");
  return parts[1] === "b" ? "b" : "w";
}

function toWhitePovCp(rawCp, rawMate, fen) {
  // If score is from side-to-move POV, flip when black to move.
  let cp = rawMate !== null ? Math.sign(rawMate) * 100000 : (rawCp ?? 0);
  const turn = fenTurn(fen);
  // side-to-move POV -> white POV:
  // if black to move, invert.
  if (turn === "b") cp = -cp;
  return cp;
}

function computeBlundersFromEvals(plys, evals) {
  // Simple swing-based blunders:
  // compare eval before move vs after move (white POV).
  // Mark big drops for the side who just moved.
  const out = [];
  const THRESH = 220; // cp swing threshold (tweak later)

  // evals[i] corresponds to plys[i]
  for (let i = 1; i < evals.length; i++) {
    const before = evals[i - 1]?.povCp ?? 0;
    const after = evals[i]?.povCp ?? 0;

    // Who played the move leading to position i?
    // Position i is AFTER move i (ply i), so mover is opposite of turn in plys[i]
    const mover = plys[i]?.turn === "w" ? "b" : "w";

    // From mover POV, a "drop" means it got worse for them.
    // If mover is White, worsening means white POV decreased.
    // If mover is Black, worsening means white POV increased.
    let drop;
    if (mover === "w") drop = before - after;
    else drop = after - before;

    if (drop >= THRESH) {
      const label =
        drop >= 600 ? "Blunder" : drop >= 350 ? "Mistake" : "Inaccuracy";
      out.push({ plyIndex: i, drop: Math.round(drop), label });
    }
  }

  return out.sort((a, b) => b.drop - a.drop);
}

// PASTE STARTS HERE
function plyToMoveLabel(plyIndex) {
  if (plyIndex === 0) return "Start position";
  const moveNo = Math.ceil(plyIndex / 2);
  const side = plyIndex % 2 === 1 ? "White" : "Black";
  return `Move ${moveNo} — ${side}`;
}

function formatEvalHuman(povCp, mate) {
  if (mate !== null && mate !== undefined) {
    if (mate === 0) return "Checkmate";
    return mate > 0
      ? `White mates in ${mate}`
      : `Black mates in ${Math.abs(mate)}`;
  }

  const pawns = (povCp ?? 0) / 100;
  const abs = Math.abs(pawns);
  const side = pawns > 0 ? "White" : pawns < 0 ? "Black" : "Even";

  if (abs < 0.3) return "Even";
  if (abs < 1.2) return `${side} slightly better (${abs.toFixed(1)})`;
  if (abs < 3.0) return `${side} better (${abs.toFixed(1)})`;
  if (abs < 6.0) return `${side} winning (${abs.toFixed(1)})`;
  return `${side} winning (9.9+)`;
}

function explainSanBasic(san) {
  if (!san || san === "(start)") return "";

  // Castling
  if (san === "O-O") return "Castles kingside";
  if (san === "O-O-O") return "Castles queenside";

  const pieceMap = {
    K: "King",
    Q: "Queen",
    R: "Rook",
    B: "Bishop",
    N: "Knight",
  };

  const check = san.includes("#")
    ? " (checkmate)"
    : san.includes("+")
      ? " (check)"
      : "";

  // Strip check symbols for parsing
  let s = san.replace(/[+#]/g, "");

  // Pawn move/capture
  if (!/^[KQRBN]/.test(s)) {
    if (s.includes("x")) {
      const toSq = s.split("x")[1];
      return `Pawn captures on ${toSq}${check}`;
    }
    // pawn push like e4
    if (/^[a-h][1-8]$/.test(s)) return `Pawn to ${s}${check}`;
    return `Pawn move ${san}${check}`;
  }

  // Piece move/capture
  const piece = pieceMap[s[0]] || "Piece";
  const isCapture = s.includes("x");
  const toSq = s.slice(-2);
  if (isCapture) return `${piece} captures on ${toSq}${check}`;
  return `${piece} to ${toSq}${check}`;
}

function drawEvalGraph(plys, evals, currentIndex) {
  if (!$evalGraph) return;
  const ctx = $evalGraph.getContext("2d");
  if (!ctx) return;

  const w = $evalGraph.width;
  const h = $evalGraph.height;

  ctx.clearRect(0, 0, w, h);

  // Frame
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  if (!evals || evals.length < 2) return;

  // Clamp evals for display (±800 cp), mate gets clamped
  const CLAMP = 800;

  const xs = i => (i / (evals.length - 1)) * (w - 10) + 5;
  const ys = cp => {
    const c = Math.max(-CLAMP, Math.min(CLAMP, cp));
    const t = (c + CLAMP) / (2 * CLAMP); // 0..1
    return (1 - t) * (h - 10) + 5;
  };

  // Zero line
  ctx.beginPath();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.moveTo(5, ys(0));
  ctx.lineTo(w - 5, ys(0));
  ctx.stroke();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 2;

  for (let i = 0; i < evals.length; i++) {
    const x = xs(i);
    const y = ys(evals[i].povCp);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Current marker
  const cx = xs(currentIndex);
  ctx.beginPath();
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1;
  ctx.moveTo(cx, 5);
  ctx.lineTo(cx, h - 5);
  ctx.stroke();
}

function renderCriticalList() {
  if (!$criticalList) return;
  $criticalList.innerHTML = "";

  const top = review.blunders.slice(0, 8);
  if (top.length === 0) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "No big blunders detected (nice).";
    $criticalList.appendChild(div);
    return;
  }

  for (const b of top) {
    const ply = review.plys[b.plyIndex];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = b.label === "Blunder" ? "blunder" : "";
    btn.textContent = `Move ${ply.moveNumber}${b.plyIndex % 2 === 1 ? " (White)" : " (Black)"}: ${ply.san}`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `${b.label} (−${b.drop}cp)`;
    btn.appendChild(tag);

    btn.addEventListener("click", () => gotoReviewPly(b.plyIndex));
    $criticalList.appendChild(btn);
  }
}

function buildBlunderIndexMap() {
  // plyIndex -> { drop, label }
  const map = new Map();
  for (const b of review.blunders || []) {
    map.set(b.plyIndex, b);
  }
  return map;
}

function renderReviewMovesList() {
  if (!$reviewMoves) return;
  $reviewMoves.innerHTML = "";

  const blMap = buildBlunderIndexMap();

  // We want to display by full moves (white+black), but clickable by ply.
  // review.plys[0] is start; ply 1 is white move 1, ply 2 black move 1, etc.
  const totalPlys = review.plys.length - 1;
  const totalMoves = Math.ceil(totalPlys / 2);

  for (let moveNo = 1; moveNo <= totalMoves; moveNo++) {
    const whitePly = moveNo * 2 - 1;
    const blackPly = moveNo * 2;

    const whiteSan = review.plys[whitePly]?.san ?? "";
    const blackSan = review.plys[blackPly]?.san ?? "";

    // Row for White move
    if (whitePly < review.plys.length) {
      const whiteTag = blMap.get(whitePly);
      const row = document.createElement("div");
      row.className = "review-move-row";
      row.dataset.ply = String(whitePly);

      const num = document.createElement("div");
      num.className = "review-move-num";
      num.textContent = `${moveNo}.`;

      const san = document.createElement("div");
      san.className = "review-move-san";
      san.textContent = whiteSan || "—";

      const tag = document.createElement("div");
      tag.className = "review-tag";
      if (whiteTag) {
        const cls =
          whiteTag.label === "Blunder"
            ? "blunder"
            : whiteTag.label === "Mistake"
              ? "mistake"
              : "inaccuracy";
        tag.classList.add(cls);
        tag.textContent =
          whiteTag.label === "Blunder"
            ? "?? Blunder"
            : whiteTag.label === "Mistake"
              ? "?! Mistake"
              : "!? Inaccuracy";
      } else {
        tag.textContent = "";
        tag.style.borderColor = "transparent";
      }

      row.appendChild(num);
      row.appendChild(san);
      row.appendChild(tag);

      row.addEventListener("click", () => gotoReviewPly(whitePly));
      $reviewMoves.appendChild(row);
    }

    // Row for Black move
    if (blackPly < review.plys.length) {
      const blackTag = blMap.get(blackPly);
      const row = document.createElement("div");
      row.className = "review-move-row";
      row.dataset.ply = String(blackPly);

      const num = document.createElement("div");
      num.className = "review-move-num";
      num.textContent = ""; // blank for black row

      const san = document.createElement("div");
      san.className = "review-move-san";
      san.textContent = blackSan || "—";

      const tag = document.createElement("div");
      tag.className = "review-tag";
      if (blackTag) {
        const cls =
          blackTag.label === "Blunder"
            ? "blunder"
            : blackTag.label === "Mistake"
              ? "mistake"
              : "inaccuracy";
        tag.classList.add(cls);
        tag.textContent =
          blackTag.label === "Blunder"
            ? "?? Blunder"
            : blackTag.label === "Mistake"
              ? "?! Mistake"
              : "!? Inaccuracy";
      } else {
        tag.textContent = "";
        tag.style.borderColor = "transparent";
      }

      row.appendChild(num);
      row.appendChild(san);
      row.appendChild(tag);

      row.addEventListener("click", () => gotoReviewPly(blackPly));
      $reviewMoves.appendChild(row);
    }
  }

  highlightCurrentReviewMoveRow();
}

function highlightCurrentReviewMoveRow() {
  if (!$reviewMoves) return;
  const rows = $reviewMoves.querySelectorAll(".review-move-row");
  rows.forEach(r => r.classList.remove("is-current"));

  const current = $reviewMoves.querySelector(
    `.review-move-row[data-ply="${review.currentPly}"]`,
  );
  if (current) current.classList.add("is-current");
}

function updateReviewStatusLine() {
  if (!$reviewStatus) return;

  const plyIndex = review.currentPly;
  const ply = review.plys[plyIndex];
  const ev = review.evals[plyIndex];

  const moveLabel = plyToMoveLabel(plyIndex);
  const san = plyIndex === 0 ? "" : (ply?.san ?? "");
  const explain = san ? explainSanBasic(san) : "";
  const moveText =
    plyIndex === 0
      ? "(start position)"
      : explain
        ? `${san} — ${explain}`
        : san || "—";

  let evalText = "—";
  if (ev) evalText = formatEvalHuman(ev.povCp ?? 0, ev.mate);

  $reviewStatus.textContent = `${moveLabel}: ${moveText} | Eval: ${evalText}`;
}

function gotoReviewPly(index) {
  index = Math.max(0, Math.min(review.plys.length - 1, index));
  review.currentPly = index;

  const fen = review.plys[index].fen;
  if (board) board.position(fen, true);

  clearHighlights();
  clearLastMoveHighlight();
  clearCheckHighlight();

  updateReviewStatusLine();
  drawEvalGraph(review.plys, review.evals, review.currentPly);
  highlightCurrentReviewMoveRow();
}

async function startPostGameReview() {
  if (review.running) return;
  if (!sf) return;

  review.running = true;
  setReviewMode(true);
  setReviewOpen(true);

  // Safety: if history is empty but PGN exists, rebuild game from PGN so review works
  if (game.history().length === 0) {
    const pgn = loadPgnFromStorage();
    if (pgn) {
      const rebuilt = new Chess();
      if (loadPgnIntoGame(rebuilt, pgn)) {
        game = rebuilt;
      }
    }
  }

  // Build ply list
  review.plys = buildPlyListFromGame();
  logDebug(`Review plys: ${review.plys.length}`);
  review.evals = new Array(review.plys.length).fill(null);
  review.blunders = [];
  review.currentPly = review.plys.length - 1;

  if ($reviewStatus) $reviewStatus.textContent = "Analyzing game…";
  if ($criticalList) $criticalList.innerHTML = "";
  drawEvalGraph(review.plys, [], 0);

  // Analyze each position (ply) quickly
  for (let i = 0; i < review.plys.length; i++) {
    // If user exits review while running
    if (!reviewMode) break;

    const fen = review.plys[i].fen;
    const r = await analyzeFenOnce(fen, { movetimeMs: 140, targetDepth: 10 });

    const povCp = toWhitePovCp(r.cp, r.mate, fen);

    review.evals[i] = {
      cp: r.cp,
      mate: r.mate,
      povCp: povCp,
    };

    // Live update graph every few points
    if (i % 4 === 0 || i === review.plys.length - 1) {
      drawEvalGraph(
        review.plys,
        review.evals.filter(Boolean),
        review.currentPly,
      );
    }
  }

  // Compute blunders once evals exist
  if (review.evals.every(Boolean)) {
    review.blunders = computeBlundersFromEvals(review.plys, review.evals);
  } else {
    // Partial run (user exited early) — compute with what we have
    const partialEvals = review.evals.map((e, idx) =>
      e ? e : { povCp: 0, mate: null, cp: 0 },
    );
    review.blunders = computeBlundersFromEvals(review.plys, partialEvals);
  }

  renderCriticalList();
  renderReviewMovesList();
  gotoReviewPly(review.currentPly);

  review.running = false;
}

function exitReview() {
  review.running = false;
  setReviewMode(false);

  // Return to the actual final game position
  if (board) board.position(game.fen(), true);
  updateStatus();
  renderMoveList();
  highlightCheck();
}

/* ============================================================================
   ===== MAIN INIT ============================================================
   ============================================================================ */

(function main() {
  const savedPgn = loadPgnFromStorage();
  const savedFen = loadFenFromStorage();

  // Prefer PGN (it contains move history)
  if (savedPgn && loadPgnIntoGame(game, savedPgn)) {
    initialPosition = game.fen();
  } else if (savedFen) {
    // Fallback: fen only (no history)
    try {
      game.load(savedFen);
      initialPosition = game.fen();
    } catch (_) {
      game = new Chess();
      initialPosition = "start";
      clearFenFromStorage();
      clearPgnFromStorage();
      saveFenToStorage();
      savePgnToStorage();
    }
  } else {
    initialPosition = "start";
  }

  const savedSettings = loadSettingsFromStorage();
  applySettings(savedSettings);

  setInputsToDefaults();

  const savedTheme = loadThemeFromStorage();
  if (savedTheme) {
    applyTheme(savedTheme);
  } else {
    applyTheme(getDefaultTheme());
  }

  initBoard();
  initBoardResizeObserver();
  initMovesCollapse();

  initThemeCollapse();
  initThemeControls();

  loadSavedElo();
  loadSavedBlunder();

  window.addEventListener("pageshow", () => {
    syncEloUI();
    syncBlunderUI();
  });

  initStockfish();

  setEngineThinking(false);

  updateStatus();
  renderMoveList();
  afterLayoutChange();

  saveFenToStorage();

  setTimeout(() => {
    if (analysisMode) {
      requestAnalysisNow();
    } else {
      maybeEnginePlays(); // will play only if it's engine's turn
    }
  }, 0);
})();
