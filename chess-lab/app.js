/* global Chess, Chessboard */

let game = new Chess();
let board = null;

const $status = document.getElementById("status");
const $debug = document.getElementById("debug");
const $elo = document.getElementById("elo");
const $eloValue = document.getElementById("eloValue");
const $newGame = document.getElementById("newGame");
const $undo = document.getElementById("undo");
const $flip = document.getElementById("flip");
const $playWhite = document.getElementById("playWhite");

// --- Stockfish worker (local file) ---
let sf = null;
let engineBusy = false;
let pendingBestMoveResolver = null;

function logDebug(line) {
  $debug.textContent = (line + "\n" + $debug.textContent).slice(0, 4000);
}

function initStockfish() {
  // You downloaded stockfish.wasm + stockfish.worker.js, so use the worker directly.
  sf = new Worker("engine/stockfish.worker.js");

  logDebug("Stockfish worker created.");

  sf.onmessage = e => {
    const line = String(e.data);
    if (!line.startsWith("info")) logDebug(line);

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

  sf.postMessage("uci");
  sf.postMessage("isready");
  applyEloToEngine(Number($elo.value));
}

function applyEloToEngine(elo) {
  if (!sf) return;

  sf.postMessage("setoption name UCI_LimitStrength value true");
  sf.postMessage(`setoption name UCI_Elo value ${elo}`);

  // Fallback: map ELO 400..2500 -> Skill 0..20
  const skill = Math.max(
    0,
    Math.min(20, Math.round(((elo - 400) / (2500 - 400)) * 20)),
  );
  sf.postMessage(`setoption name Skill Level value ${skill}`);

  sf.postMessage("isready");
  logDebug(`Applied ELO: ${elo} (skill ${skill})`);
}

function getEngineMove({ movetimeMs = 200 } = {}) {
  return new Promise(resolve => {
    if (!sf) throw new Error("Stockfish not initialized.");

    // If engine is busy, ignore (simple guard)
    if (engineBusy) {
      resolve("(busy)");
      return;
    }

    engineBusy = true;
    pendingBestMoveResolver = resolve;

    // Provide current position
    sf.postMessage(`position fen ${game.fen()}`);

    // movetime is the simplest stable control early on
    sf.postMessage(`go movetime ${movetimeMs}`);
  });
}

// --- Board UI / interaction ---
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
}

function isHumansTurn() {
  // if playWhite checked, human is white; else human is black
  const humanColor = $playWhite.checked ? "w" : "b";
  return game.turn() === humanColor;
}

async function maybeEnginePlays() {
  if (game.isGameOver()) return;
  if (isHumansTurn()) return;

  // You can later map ELO to movetime too.
  const elo = Number($elo.value);

  // A simple movetime curve (feel free to tweak):
  // low elo: fast, high elo: more time
  const movetimeMs = Math.round(80 + (elo - 400) * 0.12); // ~80..~332
  const best = await getEngineMove({ movetimeMs });

  if (!best || best === "(none)" || best === "(busy)") return;

  // Convert UCI move (e2e4) to chess.js move
  const from = best.slice(0, 2);
  const to = best.slice(2, 4);
  const promo = best.length >= 5 ? best[4] : undefined;

  const move = game.move({ from, to, promotion: promo || "q" });
  if (move) {
    board.position(game.fen(), true);
    updateStatus();
  }
}

function onDragStart(source, piece) {
  if (game.isGameOver()) return false;
  if (!isHumansTurn()) return false;

  // disallow dragging the opponent's pieces
  const humanIsWhite = $playWhite.checked;
  if (humanIsWhite && piece.startsWith("b")) return false;
  if (!humanIsWhite && piece.startsWith("w")) return false;

  return true;
}

function onDrop(source, target) {
  // try the move
  const move = game.move({
    from: source,
    to: target,
    promotion: "q", // always queen for now (phase 1 simplification)
  });

  // illegal move
  if (move === null) return "snapback";

  updateStatus();
  // Engine replies
  setTimeout(maybeEnginePlays, 0);
}

function onSnapEnd() {
  board.position(game.fen());
}

// --- Controls ---
$elo.addEventListener("input", () => {
  $eloValue.textContent = $elo.value;
});

$elo.addEventListener("change", () => {
  applyEloToEngine(Number($elo.value));
  if (engineBusy) sf.postMessage("stop");
});

$playWhite.addEventListener("change", () => {
  startNewGame();
});

$newGame.addEventListener("click", () => startNewGame());

$undo.addEventListener("click", () => {
  // Undo last two ply if possible (engine + human), but keep it simple:
  if (game.history().length === 0) return;

  game.undo(); // undo last move
  // If after undo it's not human's turn, undo again
  if (!isHumansTurn() && game.history().length > 0) game.undo();

  board.position(game.fen(), true);
  updateStatus();
});

$flip.addEventListener("click", () => {
  board.flip();
});

function startNewGame() {
  game = new Chess();
  board.start(true);
  updateStatus();

  // If human chose black, engine should open
  setTimeout(maybeEnginePlays, 0);
}

// --- Init ---
function initBoard() {
  board = Chessboard("board", {
    position: "start",
    draggable: true,
    onDragStart,
    onDrop,
    onSnapEnd,
  });
}

(function main() {
  initBoard();
  initStockfish();
  $eloValue.textContent = $elo.value;
  updateStatus();
  // engine may play if human is black
  setTimeout(maybeEnginePlays, 0);
})();
