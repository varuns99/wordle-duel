const WORDS = {
  answers: [],
  validGuesses: new Set()
};

const state = {
  answer: "",
  mode: "solo",
  backendAvailable: false,
  room: null,
  row: 0,
  col: 0,
  guesses: Array.from({ length: 6 }, () => Array(5).fill("")),
  progress: [],
  keyRanks: {},
  startTime: 0,
  elapsedMs: 0,
  timerId: null,
  timerStarted: false,
  pollId: null,
  countdownId: null,
  countdownEndsAt: null,
  tugRoundActive: false,
  finished: false,
  animateRow: null,
  roomRoundNumber: 1,
  lastSeenRoundResult: null,
  leaderboardEntries: [],
  activeLeaderboardMode: "daily",
  lastResultText: ""
};

const rank = { absent: 1, present: 2, correct: 3 };
const $ = (id) => document.getElementById(id);
const WORD_LIST_URL = document.body.dataset.wordListUrl || "words.json";
const API_BASE = document.body.dataset.apiBase || "api";
const SERVICE_WORKER_URL = document.body.dataset.serviceWorkerUrl || "sw.js";
const DAILY_CHALLENGE_OVERRIDES = {
  "2026-05-31": 420,
  "2026-06-01": 137,
  "2026-06-02": 921,
  "2026-06-03": 2048
};
const THEME_STORAGE_KEY = "wordleDuelTheme";
const PLAYER_NAME_STORAGE_KEY = "wordleDuelPlayerName";
const LOCAL_SCORE_STORAGE_KEY = "wordleDuelScores";
const SCORE_TIP_STORAGE_KEY = "wordleSprintScoreTipSeen";

function apiUrl(path) {
  return `${API_BASE}/${path}`;
}

function applyTheme(theme) {
  const isLight = theme === "light";
  document.body.classList.toggle("light-theme", isLight);
  $("themeToggle")?.setAttribute("aria-pressed", String(isLight));
  if ($("themeLabel")) $("themeLabel").textContent = isLight ? "Light" : "Dark";
}

function animateThemeChange(nextTheme) {
  const wave = $("themeWave");
  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!wave || prefersReducedMotion) {
    applyTheme(nextTheme);
    return;
  }

  wave.className = `theme-wave wave-${nextTheme}`;
  requestAnimationFrame(() => {
    wave.classList.add("wave-active");
  });
  setTimeout(() => applyTheme(nextTheme), 260);
  setTimeout(() => {
    wave.className = "theme-wave hidden";
  }, 820);
}

function initTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const preferredTheme = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(savedTheme || preferredTheme);
  $("themeToggle")?.addEventListener("click", () => {
    const nextTheme = document.body.classList.contains("light-theme") ? "dark" : "light";
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    animateThemeChange(nextTheme);
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(SERVICE_WORKER_URL).catch(() => {
      // Install support is a progressive enhancement; gameplay should continue.
    });
  });
}

function initScoreTip() {
  const hidden = localStorage.getItem(SCORE_TIP_STORAGE_KEY) === "true";
  $("scoreTip").classList.toggle("hidden", hidden);
  $("dismissScoreTipBtn").addEventListener("click", () => {
    localStorage.setItem(SCORE_TIP_STORAGE_KEY, "true");
    $("scoreTip").classList.add("hidden");
  });
}

function showView(id) {
  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("view-active", view.id === id);
  }
}

function playerName() {
  return $("playerName").value.trim() || "Player";
}

function showMenuStep(stepId) {
  for (const id of ["nameGate", "mainMenuStep", "duelMenuStep"]) {
    $(id).classList.toggle("hidden", id !== stepId);
  }
  if (stepId !== "duelMenuStep") {
    $("roomJoinField").classList.add("hidden");
    $("submitJoinRoomBtn").classList.add("hidden");
  }
}

function enterMainMenu(name) {
  $("playerName").value = String(name || "Player").slice(0, 24);
  localStorage.setItem(PLAYER_NAME_STORAGE_KEY, playerName());
  showMenuStep("mainMenuStep");
  $("menuStatus").textContent = WORDS.answers.length
    ? `${WORDS.answers.length.toLocaleString()} answer words loaded.`
    : "";
}

function skipName() {
  enterMainMenu("Player");
}

function continueWithName() {
  const name = $("playerName").value.trim();
  if (!name) {
    $("menuStatus").textContent = "Enter a name or skip.";
    $("playerName").focus();
    return;
  }
  enterMainMenu(name);
}

function showDuelMenu() {
  showMenuStep("duelMenuStep");
  $("menuStatus").textContent = state.backendAvailable
    ? "Create a room or join with a code."
    : "Two-player rooms need the Node backend or another realtime host.";
}

function formatTime(ms) {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function calculatePoints(attempts, elapsedMs) {
  const safeAttempts = Math.min(6, Math.max(1, Number(attempts) || 6));
  const safeElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  const seconds = safeElapsedMs / 1000;
  return Math.max(0, Math.round(10000 - safeAttempts * 1000 - seconds * 10));
}

function modeLabel(mode) {
  if (mode === "tug") return "duel";
  return mode === "duel" ? "duel" : "daily";
}

function dailyGameId() {
  return `daily:${dailyChallengeKey()}:${playerName().trim().toLowerCase() || "player"}`;
}

function aggregateLeaderboard(entries) {
  const players = new Map();
  for (const entry of entries) {
    const attempts = Math.min(6, Math.max(1, Number(entry.attempts) || 6));
    const elapsedMs = Math.max(0, Number(entry.elapsedMs) || 0);
    const points = Number(entry.points) || calculatePoints(attempts, elapsedMs);
    const name = String(entry.name || "Player").slice(0, 24);
    const key = name.trim().toLowerCase() || "player";
    const current = players.get(key) || {
      name,
      games: 0,
      totalPoints: 0,
      bestPoints: 0,
      bestAttempts: 6,
      bestElapsedMs: Number.POSITIVE_INFINITY,
      lastSolvedAt: entry.solvedAt || ""
    };
    current.games += 1;
    current.totalPoints += points;
    current.bestPoints = Math.max(current.bestPoints, points);
    if (attempts < current.bestAttempts || (attempts === current.bestAttempts && elapsedMs < current.bestElapsedMs)) {
      current.bestAttempts = attempts;
      current.bestElapsedMs = elapsedMs;
    }
    if ((entry.solvedAt || "") > current.lastSolvedAt) {
      current.name = name;
      current.lastSolvedAt = entry.solvedAt || "";
    }
    players.set(key, current);
  }
  return [...players.values()]
    .map((player) => ({
      ...player,
      averagePoints: Math.round(player.totalPoints / Math.max(1, player.games)),
      bestElapsedMs: Number.isFinite(player.bestElapsedMs) ? player.bestElapsedMs : 0
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints || b.bestPoints - a.bestPoints || a.bestElapsedMs - b.bestElapsedMs);
}

function setMessage(text) {
  $("message").textContent = text;
}

function setDuelStatus(room) {
  if ((state.mode !== "duel" && state.mode !== "tug") || !room) return;
  if (state.mode === "tug") {
    renderTugMeter(room);
    return;
  }
  const opponent = room.opponent;
  if (!opponent) {
    setMessage("Waiting for opponent. Share the room code.");
    return;
  }
  if (state.finished && opponent.finishedAt) {
    if (state.progress.length < opponent.attempts) {
      setMessage("You won the sprint.");
    } else if (state.progress.length > opponent.attempts) {
      setMessage("Opponent won the sprint.");
    } else if (state.elapsedMs && opponent.elapsedMs) {
      setMessage(state.elapsedMs <= opponent.elapsedMs ? "You won the sprint." : "Opponent won the sprint.");
    } else {
      setMessage("Sprint finished.");
    }
    return;
  }
  if (opponent.finishedAt) {
    setMessage(opponent.won ? "Opponent solved it. Keep sprinting." : "Opponent finished their attempts.");
    return;
  }
  if (opponent.attempts > 0) {
    setMessage(`Opponent is solving: ${opponent.attempts}/6 attempts used.`);
    return;
  }
  setMessage("Opponent joined. First valid guess starts your timer.");
}

function tugEmoji(score, opponentScore, winner, target = 3) {
  if (winner) return "🏆";
  if (opponentScore >= target - 1 && opponentScore > score) return "😰";
  if (score <= -(target - 1)) return "😬";
  if (score < 0) return "😟";
  return ["😐", "🙂", "😏", "🔥", "😈", "🏆"][Math.min(5, Math.max(0, score))];
}

function renderTugMeter(room) {
  if (state.mode !== "tug" || !room) return;
  const scores = room.scores || {};
  const youScore = scores[room.playerId] || 0;
  const opponentId = Object.keys(scores).find((id) => id !== room.playerId);
  const opponentScore = opponentId ? scores[opponentId] || 0 : 0;
  const opponentName = room.opponent?.name || "Opponent";
  const target = room.targetScore || 3;
  const scoreDelta = youScore - opponentScore;
  const markerPercent = 50 - (scoreDelta / (target * 2)) * 90;
  const clampedPercent = Math.max(5, Math.min(95, markerPercent));
  const youWon = room.matchWinnerId === room.playerId;
  const opponentWon = room.matchWinnerId && room.matchWinnerId !== room.playerId;
  const ready = room.ready || {};
  const youReady = Boolean(ready[room.playerId]);
  const opponentReady = Boolean(room.opponent && opponentId && ready[opponentId]);
  const countdownRemaining = room.countdownEndsAt ? room.countdownEndsAt - Date.now() : 0;
  const countdownActive = countdownRemaining > 0;
  const firstRound = room.roundNumber === 1;
  state.tugRoundActive = Boolean(room.roundActive || (!firstRound && room.roundStartAt && room.opponent && !room.matchWinnerId));

  $("youTugScore").textContent = youScore;
  $("opponentTugScore").textContent = opponentScore;
  $("tugOpponentName").textContent = opponentName;
  $("youMood").textContent = tugEmoji(youScore, opponentScore, youWon, target);
  $("opponentMood").textContent = tugEmoji(opponentScore, youScore, opponentWon, target);
  $("tugMarker").style.left = `${clampedPercent}%`;
  $("tugPanel").classList.toggle("match-point", Math.max(youScore, opponentScore) >= target - 1);
  $("tugReadyBtn").classList.toggle("hidden", Boolean(room.matchWinnerId || !room.opponent || !firstRound || state.tugRoundActive || countdownActive));
  $("tugReadyBtn").disabled = youReady;
  $("tugReadyBtn").textContent = youReady ? "Ready" : "Ready";
  renderTugCountdown(firstRound ? room.countdownEndsAt : null);
  if (!firstRound && room.roundStartAt && !state.timerStarted && !state.finished && !room.matchWinnerId) {
    startTimer(room.roundStartAt);
  }

  if (room.matchWinnerId) {
    $("tugRoundStatus").textContent = youWon ? "You won Word Tug." : `${opponentName} won Word Tug.`;
  } else if (room.lastRound && state.lastSeenRoundResult !== `${room.lastRound.roundNumber}:${room.lastRound.winnerId}:${room.lastRound.points}`) {
    state.lastSeenRoundResult = `${room.lastRound.roundNumber}:${room.lastRound.winnerId}:${room.lastRound.points}`;
    const winnerName = room.lastRound.winnerId === room.playerId ? "You" : room.lastRound.winnerId ? opponentName : "No one";
    $("tugRoundStatus").textContent = room.lastRound.winnerId
      ? `${winnerName} pulled the meter. Round ${room.roundNumber} begins.`
      : `No pull. Round ${room.roundNumber} begins.`;
    $("tugPanel").classList.add("pulse");
    setTimeout(() => $("tugPanel").classList.remove("pulse"), 520);
  } else if (!room.opponent) {
    $("tugRoundStatus").textContent = `Waiting for opponent. Pull to +${target} to win.`;
  } else if (firstRound && countdownActive) {
    $("tugRoundStatus").textContent = `Starting in ${Math.ceil(countdownRemaining / 1000)}.`;
  } else if (firstRound && !youReady) {
    $("tugRoundStatus").textContent = opponentReady ? "Opponent is ready. Tap Ready." : "Tap Ready when you are set.";
  } else if (firstRound && !opponentReady) {
    $("tugRoundStatus").textContent = "Ready. Waiting for opponent.";
  } else if (state.finished) {
    $("tugRoundStatus").textContent = "Round locked. Waiting for opponent.";
  } else {
    $("tugRoundStatus").textContent = `Round ${room.roundNumber}. Fastest solve pulls.`;
  }
}

function renderTugCountdown(countdownEndsAt) {
  clearInterval(state.countdownId);
  state.countdownId = null;
  state.countdownEndsAt = countdownEndsAt || null;
  const countdown = $("tugCountdown");
  if (!countdownEndsAt || countdownEndsAt <= Date.now()) {
    countdown.classList.add("hidden");
    if (countdownEndsAt && state.mode === "tug" && !state.timerStarted && !state.finished) startTimer(countdownEndsAt);
    return;
  }

  const updateCountdown = () => {
    const remaining = countdownEndsAt - Date.now();
    if (remaining <= 0) {
      countdown.classList.add("hidden");
      clearInterval(state.countdownId);
      state.countdownId = null;
      state.tugRoundActive = true;
      if (!state.timerStarted && !state.finished) startTimer(countdownEndsAt);
      $("tugRoundStatus").textContent = `Round ${state.roomRoundNumber}. Fastest solve pulls.`;
      return;
    }
    countdown.textContent = Math.ceil(remaining / 1000);
    countdown.classList.remove("hidden");
  };

  updateCountdown();
  state.countdownId = setInterval(updateCountdown, 120);
}

function hideResultCard() {
  $("resultCard").classList.add("hidden");
  $("resultStats").innerHTML = "";
  $("resultNote").textContent = "";
  $("shareResultBtn").textContent = "Share";
  state.lastResultText = "";
}

function showResultCard({ won, answer, saved = true }) {
  const attempts = state.progress.length;
  const points = won ? calculatePoints(attempts, state.elapsedMs) : 0;
  const title = won ? "Solved" : "Sprint over";
  const mode = modeLabel(state.mode);
  $("resultKicker").textContent = state.mode === "tug" ? "Word Tug" : mode === "duel" ? "Sprint Duel" : `Daily Sprint ${dailyChallengeKey()}`;
  $("resultTitle").textContent = title;
  $("resultStats").innerHTML = `
    <span><strong>${attempts}/6</strong> attempts</span>
    <span><strong>${formatTime(state.elapsedMs)}</strong> time</span>
    <span><strong>${points.toLocaleString()}</strong> points</span>
  `;
  $("resultNote").textContent = won
    ? saved
      ? "Score saved to the leaderboard."
      : "Score already counted for this daily challenge."
    : `The word was ${answer.toUpperCase()}.`;
  state.lastResultText = [
    "Word Sprint",
    `${state.mode === "tug" ? "Word Tug" : mode === "duel" ? "Sprint Duel" : "Daily Sprint"} ${won ? "solved" : "finished"}`,
    `${attempts}/6 attempts`,
    `${formatTime(state.elapsedMs)}`,
    `${points.toLocaleString()} points`
  ].join("\n");
  $("resultCard").classList.remove("hidden");
}

function showTugMatchResult(room) {
  if (state.mode !== "tug" || !room.matchWinnerId) return;
  const youWon = room.matchWinnerId === room.playerId;
  const scores = room.scores || {};
  const youScore = scores[room.playerId] || 0;
  const opponentId = Object.keys(scores).find((id) => id !== room.playerId);
  const opponentScore = opponentId ? scores[opponentId] || 0 : 0;
  const opponentName = room.opponent?.name || "Opponent";
  const history = room.history || [];
  const youWords = history
    .filter((round) => round.winnerId === room.playerId)
    .map((round) => round.word.toUpperCase());
  const opponentWords = history
    .filter((round) => round.winnerId && round.winnerId !== room.playerId)
    .map((round) => round.word.toUpperCase());
  const summary = [
    `You: ${youWords.length ? youWords.join(", ") : "-"}`,
    `${opponentName}: ${opponentWords.length ? opponentWords.join(", ") : "-"}`
  ].join(" | ");
  $("resultKicker").textContent = "Word Tug - Time Challenge";
  $("resultTitle").textContent = youWon ? "You won the tug" : `${opponentName} won the tug`;
  $("resultStats").innerHTML = `
    <span><strong>${youScore}</strong> You</span>
    <span><strong>${history.length}</strong> pulls</span>
    <span><strong>${opponentScore}</strong> ${escapeHtml(opponentName)}</span>
  `;
  $("resultNote").textContent = summary;
  state.lastResultText = [
    "Word Sprint",
    `Word Tug ${youWon ? "win" : "loss"}`,
    `You ${youScore} - ${opponentScore} ${opponentName}`,
    summary
  ].join("\n");
  $("resultCard").classList.remove("hidden");
}

function openHelp() {
  $("helpModal").classList.remove("hidden");
  $("closeHelpBtn").focus();
}

function closeHelp() {
  $("helpModal").classList.add("hidden");
  $("helpBtn").focus();
}

function dailyChallengeKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function dailyAnswer(date = new Date()) {
  const override = DAILY_CHALLENGE_OVERRIDES[dailyChallengeKey(date)];
  if (Number.isInteger(override)) {
    return WORDS.answers[override % WORDS.answers.length];
  }
  const start = Date.UTC(2026, 0, 1);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const dayNumber = Math.floor((today - start) / 86_400_000);
  const index = ((dayNumber % WORDS.answers.length) + WORDS.answers.length) % WORDS.answers.length;
  return WORDS.answers[index];
}

function resetGame({ mode, answer, room }) {
  clearInterval(state.timerId);
  clearInterval(state.pollId);
  clearInterval(state.countdownId);
  Object.assign(state, {
    answer,
    mode,
    room: room || null,
    row: 0,
    col: 0,
    guesses: Array.from({ length: 6 }, () => Array(5).fill("")),
    progress: [],
    keyRanks: {},
    startTime: 0,
    elapsedMs: 0,
    timerId: null,
    timerStarted: false,
    pollId: null,
    countdownId: null,
    countdownEndsAt: null,
    tugRoundActive: mode !== "tug",
    finished: false,
    animateRow: null,
    roomRoundNumber: room?.roundNumber || 1,
    lastSeenRoundResult: null
  });

  const isRoom = mode === "duel" || mode === "tug";
  $("modeLabel").textContent = isRoom ? "Room" : "Daily";
  $("gameTitle").textContent = mode === "tug" ? "Word Tug" : mode === "duel" ? "Sprint Duel" : "Daily Sprint";
  $("roomBadge").classList.toggle("hidden", !isRoom);
  $("helpBtn").classList.toggle("hidden", isRoom);
  $("roomCodeDisplay").textContent = isRoom ? room.code : "";
  $("copyRoomBtn").textContent = "Copy";
  $("opponentPanel").classList.toggle("hidden", !isRoom);
  $("tugPanel").classList.toggle("hidden", mode !== "tug");
  $("opponentName").textContent = "Waiting...";
  hideResultCard();
  renderBoard();
  renderKeyboard();
  renderOpponent(null);
  if (mode === "tug") renderTugMeter(room);
  setMessage(mode === "tug"
    ? "Share the room code. Tap Ready when both players join."
    : isRoom
      ? "Share the room code. First valid guess starts your timer."
      : `Daily Sprint ${dailyChallengeKey()}.`);
  $("timer").textContent = formatTime(0);
  showView("gameView");

  if (isRoom) {
    state.pollId = setInterval(pollRoom, 1000);
    pollRoom();
  }
}

function startTimer(startedAt = Date.now()) {
  if (state.timerStarted) return;
  state.timerStarted = true;
  state.startTime = startedAt;
  state.elapsedMs = Math.max(0, Date.now() - state.startTime);
  updateTimer();
  state.timerId = setInterval(updateTimer, 100);
}

function updateTimer() {
  if (state.timerStarted && !state.finished) {
    state.elapsedMs = Date.now() - state.startTime;
  }
  $("timer").textContent = formatTime(state.elapsedMs);
}

function renderBoard() {
  $("board").innerHTML = "";
  const animateRow = state.animateRow;
  for (let r = 0; r < 6; r += 1) {
    const row = document.createElement("div");
    row.className = "row";
    for (let c = 0; c < 5; c += 1) {
      const tile = document.createElement("div");
      tile.className = "tile";
      const letter = state.guesses[r][c];
      tile.textContent = letter;
      if (letter) tile.classList.add("filled");
      if (state.progress[r]) tile.classList.add(state.progress[r][c]);
      row.append(tile);
    }
    if (state.progress[r]) row.classList.add("evaluated");
    if (r === animateRow) row.classList.add("recent");
    $("board").append(row);
  }
  state.animateRow = null;
}

function renderKeyboard() {
  const rows = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
  $("keyboard").innerHTML = "";
  for (const letters of rows) {
    const row = document.createElement("div");
    row.className = "key-row";
    if (letters === "ZXCVBNM") row.append(keyButton("ENTER", "wide"));
    for (const letter of letters) row.append(keyButton(letter));
    if (letters === "ZXCVBNM") row.append(keyButton("⌫", "wide"));
    $("keyboard").append(row);
  }
}

function resetRoundFromRoom(room) {
  if (state.mode !== "tug" || room.roundNumber === state.roomRoundNumber) return;
  clearInterval(state.timerId);
  clearInterval(state.countdownId);
  Object.assign(state, {
    row: 0,
    col: 0,
    guesses: Array.from({ length: 6 }, () => Array(5).fill("")),
    progress: [],
    keyRanks: {},
    startTime: 0,
    elapsedMs: 0,
    timerId: null,
    timerStarted: false,
    countdownId: null,
    countdownEndsAt: null,
    tugRoundActive: false,
    finished: false,
    animateRow: null,
    roomRoundNumber: room.roundNumber
  });
  hideResultCard();
  renderBoard();
  renderKeyboard();
  $("timer").textContent = formatTime(0);
  $("tugCountdown").classList.add("hidden");
}

function keyButton(label, extra = "") {
  const button = document.createElement("button");
  button.className = `key ${extra}`;
  button.textContent = label;
  button.addEventListener("click", () => handleKey(label));
  const className = state.keyRanks[label.toLowerCase()];
  if (className) button.classList.add(className);
  return button;
}

function scoreGuess(guess, answer) {
  const result = Array(5).fill("absent");
  const remaining = answer.split("");
  for (let i = 0; i < 5; i += 1) {
    if (guess[i] === answer[i]) {
      result[i] = "correct";
      remaining[i] = null;
    }
  }
  for (let i = 0; i < 5; i += 1) {
    if (result[i] === "correct") continue;
    const index = remaining.indexOf(guess[i]);
    if (index !== -1) {
      result[i] = "present";
      remaining[index] = null;
    }
  }
  return result;
}

function handleKey(key) {
  if (state.finished) return;
  if (state.mode === "tug" && !state.tugRoundActive) {
    setMessage("Word Tug starts after both players are ready.");
    return;
  }
  if (key === "⌫" || key === "Backspace") {
    if (state.col > 0) {
      state.col -= 1;
      state.guesses[state.row][state.col] = "";
      renderBoard();
    }
    return;
  }
  if (key === "ENTER" || key === "Enter") {
    submitGuess();
    return;
  }
  if (/^[a-z]$/i.test(key) && state.col < 5) {
    state.guesses[state.row][state.col] = key.toUpperCase();
    state.col += 1;
    renderBoard();
  }
}

async function submitGuess() {
  if (state.mode === "tug" && !state.tugRoundActive) {
    setMessage("Wait for the countdown.");
    return;
  }
  if (state.col < 5) {
    setMessage("Five letters first.");
    shakeBoard();
    return;
  }
  const guess = state.guesses[state.row].join("").toLowerCase();
  if (!WORDS.validGuesses.has(guess)) {
    setMessage("Not in this word list.");
    shakeBoard();
    return;
  }
  if (state.mode === "duel" || state.mode === "tug") {
    await submitDuelGuess(guess);
    return;
  }

  startTimer();
  const scored = scoreGuess(guess, state.answer);
  await applyGuessResult({ guess, scored, won: guess === state.answer, answer: state.answer });
}

async function submitDuelGuess(guess) {
  if (!state.room) return;
  try {
    const response = await fetch(apiUrl(`rooms/${state.room.code}/${state.room.playerId}/guess`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guess })
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Could not submit that guess.");
      return;
    }
    state.room = data.room;
    if (data.startedAt) startTimer(data.startedAt);
    if (data.elapsedMs) state.elapsedMs = data.elapsedMs;
    await applyGuessResult({
      guess,
      scored: data.result,
      won: data.won,
      answer: data.answer,
      suppressResult: state.mode === "tug"
    });
    renderOpponent(data.room.opponent);
    resetRoundFromRoom(data.room);
    renderTugMeter(data.room);
    showTugMatchResult(data.room);
    setDuelStatus(data.room);
  } catch {
    setMessage("Could not reach the room server.");
  }
}

function shakeBoard() {
  $("board").classList.remove("shake");
  requestAnimationFrame(() => {
    $("board").classList.add("shake");
  });
  setTimeout(() => $("board").classList.remove("shake"), 360);
}

async function applyGuessResult({ guess, scored, won, answer, suppressResult = false }) {
  state.animateRow = state.row;
  state.progress.push(scored);
  for (let i = 0; i < 5; i += 1) {
    const letter = guess[i];
    const current = state.keyRanks[letter];
    if (!current || rank[scored[i]] > rank[current]) {
      state.keyRanks[letter] = scored[i];
    }
  }

  renderBoard();
  renderKeyboard();

  if (won || state.row === 5) {
    state.finished = true;
    if (state.timerStarted && !state.elapsedMs) {
      state.elapsedMs = Date.now() - state.startTime;
    }
    clearInterval(state.timerId);
    updateTimer();
    setMessage(won ? `Solved in ${state.row + 1} guesses.` : `The word was ${answer.toUpperCase()}.`);
    const saved = won && state.mode !== "duel" && state.mode !== "tug" ? await saveLeaderboard() : true;
    if (!suppressResult) showResultCard({ won, answer, saved });
    return;
  }

  state.row += 1;
  state.col = 0;
  setMessage("Good. Keep going.");
}

async function saveLeaderboard() {
  const entry = {
    name: playerName(),
    mode: modeLabel(state.mode),
    attempts: state.progress.length,
    elapsedMs: state.elapsedMs,
    points: calculatePoints(state.progress.length, state.elapsedMs),
    gameId: state.mode === "duel" ? null : dailyGameId(),
    challengeKey: state.mode === "duel" ? null : dailyChallengeKey()
  };
  try {
    const response = await fetch(apiUrl("leaderboard"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry)
    });
    if (!response.ok) throw new Error("Leaderboard API unavailable");
    const data = await response.json();
    return data.saved !== false;
  } catch {
    const localEntries = JSON.parse(localStorage.getItem(LOCAL_SCORE_STORAGE_KEY) || "[]");
    const alreadySaved = localEntries.some((score) => (
      normalizeMode(score.mode) === "daily" &&
      score.challengeKey === entry.challengeKey &&
      String(score.name || "").trim().toLowerCase() === entry.name.trim().toLowerCase()
    ));
    if (alreadySaved) return false;
    localEntries.push({ ...entry, solvedAt: new Date().toISOString() });
    localEntries.forEach((score) => {
      score.points = calculatePoints(score.attempts, score.elapsedMs);
    });
    localEntries.sort((a, b) => b.points - a.points || a.attempts - b.attempts || a.elapsedMs - b.elapsedMs);
    localStorage.setItem(LOCAL_SCORE_STORAGE_KEY, JSON.stringify(localEntries.slice(0, 50)));
    return true;
  }
}

async function pollRoom() {
  if (!state.room) return;
  try {
    const response = await fetch(apiUrl(`rooms/${state.room.code}/${state.room.playerId}`));
    if (!response.ok) return;
    const data = await response.json();
    state.room = data.room;
    renderOpponent(data.room.opponent);
    resetRoundFromRoom(data.room);
    renderTugMeter(data.room);
    showTugMatchResult(data.room);
    setDuelStatus(data.room);
  } catch {
    clearInterval(state.pollId);
  }
}

async function readyForTugRound() {
  if (state.mode !== "tug" || !state.room) return;
  try {
    const response = await fetch(apiUrl(`rooms/${state.room.code}/${state.room.playerId}/ready`), {
      method: "POST"
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Could not ready up.");
      return;
    }
    state.room = data.room;
    renderTugMeter(data.room);
    setDuelStatus(data.room);
  } catch {
    setMessage("Could not reach the room server.");
  }
}

function renderOpponent(opponent) {
  const grid = $("opponentGrid");
  grid.innerHTML = "";
  if (!opponent) {
    $("opponentName").textContent = "Waiting...";
  } else {
    $("opponentName").textContent = opponent.solvedAt
      ? `${opponent.name} · ${formatTime(opponent.elapsedMs)}`
      : opponent.name;
  }
  const progress = opponent?.progress || [];
  for (let r = 0; r < 6; r += 1) {
    const row = document.createElement("div");
    row.className = "mini-row";
    for (let c = 0; c < 5; c += 1) {
      const cell = document.createElement("div");
      cell.className = "mini-cell";
      if (progress[r]) cell.classList.add(progress[r][c]);
      row.append(cell);
    }
    grid.append(row);
  }
}

async function createRoom(mode = "duel") {
  $("menuStatus").textContent = "";
  if (!state.backendAvailable) {
    $("menuStatus").textContent = "Two-player rooms need the Node backend or another realtime host.";
    return;
  }
  try {
    const response = await fetch(apiUrl("rooms"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: playerName(), mode })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create room");
    resetGame({ mode: data.room.mode === "tug" ? "tug" : "duel", answer: "", room: data.room });
  } catch {
    $("menuStatus").textContent = "Could not create a room. The backend is unavailable.";
  }
}

function showJoinRoomForm() {
  if (!state.backendAvailable) {
    $("menuStatus").textContent = "Two-player rooms need the Node backend or another realtime host.";
    return;
  }
  $("roomJoinField").classList.remove("hidden");
  $("submitJoinRoomBtn").classList.remove("hidden");
  $("menuStatus").textContent = "Enter a room code, then press Join.";
  $("roomCodeInput").focus();
}

async function submitJoinRoom() {
  if (!state.backendAvailable) {
    $("menuStatus").textContent = "Two-player rooms need the Node backend or another realtime host.";
    return;
  }
  $("menuStatus").textContent = "";
  const code = $("roomCodeInput").value.trim().toUpperCase();
  if (!code) {
    $("menuStatus").textContent = "Enter a room code first.";
    $("roomCodeInput").focus();
    return;
  }
  try {
    const response = await fetch(apiUrl("rooms/join"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: playerName(), code })
    });
    const data = await response.json();
    if (!response.ok) {
      $("menuStatus").textContent = data.error || "Could not join that room.";
      $("roomCodeInput").select();
      return;
    }
    resetGame({ mode: data.room.mode === "tug" ? "tug" : "duel", answer: "", room: data.room });
  } catch {
    $("menuStatus").textContent = "Could not join. The backend is unavailable.";
    $("roomCodeInput").select();
  }
}

async function showLeaderboard() {
  showView("leaderboardView");
  const list = $("leaderboardList");
  list.textContent = "Loading...";
  let data;
  try {
    const response = await fetch(apiUrl("leaderboard"));
    if (!response.ok) throw new Error("Leaderboard API unavailable");
    data = await response.json();
  } catch {
    const localEntries = JSON.parse(localStorage.getItem(LOCAL_SCORE_STORAGE_KEY) || "[]");
    data = { entries: localEntries, players: aggregateLeaderboard(localEntries) };
  }
  state.leaderboardEntries = data.entries || [];
  renderLeaderboard();
}

function normalizeMode(mode) {
  const value = String(mode || "").toLowerCase();
  return value === "duel" ? "duel" : "daily";
}

function renderLeaderboardSection(list, title, players) {
  const section = document.createElement("section");
  section.className = "leader-section";
  const titleEl = document.createElement("h3");
  titleEl.textContent = title;
  section.append(titleEl);
  if (!players.length) {
    const empty = document.createElement("p");
    empty.className = "leader-empty";
    empty.textContent = "No scores yet.";
    section.append(empty);
    list.append(section);
    return;
  }
  const header = document.createElement("div");
  header.className = "leader-row leader-header";
  header.innerHTML = `
    <span>Rank</span>
    <span>Name</span>
    <span>Total</span>
    <span>Games</span>
    <span>Avg</span>
    <span>Best</span>
    <span class="mode-cell">Last</span>
  `;
  section.append(header);
  players.slice(0, 20).forEach((player, index) => {
    const row = document.createElement("div");
    row.className = "leader-row";
    row.innerHTML = `
      <span>#${index + 1}</span>
      <strong>${escapeHtml(player.name)}</strong>
      <span>${player.totalPoints.toLocaleString()}</span>
      <span>${player.games}</span>
      <span>${player.averagePoints.toLocaleString()}</span>
      <span>${player.bestAttempts}/6 · ${formatTime(player.bestElapsedMs)}</span>
      <span class="mode-cell">${formatDate(player.lastSolvedAt)}</span>
    `;
    section.append(row);
  });
  list.append(section);
}

function renderLeaderboard() {
  const list = $("leaderboardList");
  $("dailyTabBtn").classList.toggle("active", state.activeLeaderboardMode === "daily");
  $("duelTabBtn").classList.toggle("active", state.activeLeaderboardMode === "duel");
  $("dailyTabBtn").setAttribute("aria-selected", String(state.activeLeaderboardMode === "daily"));
  $("duelTabBtn").setAttribute("aria-selected", String(state.activeLeaderboardMode === "duel"));
  const title = state.activeLeaderboardMode === "duel" ? "Sprint Duel" : "Daily Sprint";
  const players = aggregateLeaderboard(
    state.leaderboardEntries.filter((entry) => normalizeMode(entry.mode) === state.activeLeaderboardMode)
  );
  list.innerHTML = "";
  renderLeaderboardSection(list, title, players);
}

function setLeaderboardMode(mode) {
  state.activeLeaderboardMode = mode;
  renderLeaderboard();
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function backToMenu() {
  clearInterval(state.timerId);
  clearInterval(state.pollId);
  hideResultCard();
  showView("menuView");
  showMenuStep("mainMenuStep");
}

async function copyRoomCode() {
  if (!state.room?.code) return;
  try {
    await navigator.clipboard.writeText(state.room.code);
    $("copyRoomBtn").textContent = "Copied";
  } catch {
    $("copyRoomBtn").textContent = state.room.code;
  }
  setTimeout(() => {
    if (state.room?.code) $("copyRoomBtn").textContent = "Copy";
  }, 1400);
}

async function shareResult() {
  if (!state.lastResultText) return;
  try {
    if (navigator.share) {
      await navigator.share({ text: state.lastResultText });
      return;
    }
    await navigator.clipboard.writeText(state.lastResultText);
    $("shareResultBtn").textContent = "Copied";
  } catch {
    $("shareResultBtn").textContent = "Copy failed";
  }
  setTimeout(() => {
    $("shareResultBtn").textContent = "Share";
  }, 1400);
}

$("soloBtn").addEventListener("click", () => resetGame({ mode: "solo", answer: dailyAnswer() }));
$("nameContinueBtn").addEventListener("click", continueWithName);
$("skipNameBtn").addEventListener("click", skipName);
$("playerName").addEventListener("keydown", (event) => {
  if (event.key === "Enter") continueWithName();
});
$("duelMenuBtn").addEventListener("click", showDuelMenu);
$("duelBackBtn").addEventListener("click", () => {
  showMenuStep("mainMenuStep");
  $("menuStatus").textContent = WORDS.answers.length
    ? `${WORDS.answers.length.toLocaleString()} answer words loaded.`
    : "";
});
$("createRoomBtn").addEventListener("click", () => createRoom("duel"));
$("createTugRoomBtn").addEventListener("click", () => createRoom("tug"));
$("joinRoomBtn").addEventListener("click", showJoinRoomForm);
$("submitJoinRoomBtn").addEventListener("click", submitJoinRoom);
$("roomCodeInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitJoinRoom();
});
$("leaderboardBtn").addEventListener("click", showLeaderboard);
$("backBtn").addEventListener("click", backToMenu);
$("leaderBackBtn").addEventListener("click", () => {
  showView("menuView");
  showMenuStep("mainMenuStep");
});
$("copyRoomBtn").addEventListener("click", copyRoomCode);
$("tugReadyBtn").addEventListener("click", readyForTugRound);
$("shareResultBtn").addEventListener("click", shareResult);
$("resultLeaderboardBtn").addEventListener("click", () => {
  state.activeLeaderboardMode = modeLabel(state.mode);
  showLeaderboard();
});
$("dailyTabBtn").addEventListener("click", () => setLeaderboardMode("daily"));
$("duelTabBtn").addEventListener("click", () => setLeaderboardMode("duel"));
$("helpBtn").addEventListener("click", openHelp);
$("closeHelpBtn").addEventListener("click", closeHelp);
$("helpModal").addEventListener("click", (event) => {
  if (event.target === $("helpModal")) closeHelp();
});
document.addEventListener("keydown", (event) => {
  if (!$("helpModal").classList.contains("hidden")) {
    if (event.key === "Escape") closeHelp();
    return;
  }
  if ($("gameView").classList.contains("view-active")) handleKey(event.key);
});

async function loadWords() {
  try {
    const data = await fetchWordList();
    WORDS.answers = data.answers;
    WORDS.validGuesses = new Set(data.validGuesses);
    $("soloBtn").disabled = false;
    if (!$("nameGate").classList.contains("hidden")) {
      $("menuStatus").textContent = `${WORDS.answers.length.toLocaleString()} answer words loaded.`;
    }
    checkBackend();
  } catch {
    $("menuStatus").textContent = "Could not load the word list.";
  }
}

async function fetchWordList() {
  const candidates = [...new Set([WORD_LIST_URL, "public/words.json", "words.json"])];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Try the next known hosting layout.
    }
  }
  throw new Error("Word list unavailable");
}

async function checkBackend() {
  try {
    const response = await fetch(apiUrl("leaderboard"));
    state.backendAvailable = response.ok;
  } catch {
    state.backendAvailable = false;
  }
  $("createRoomBtn").disabled = !state.backendAvailable;
  $("createTugRoomBtn").disabled = !state.backendAvailable;
  $("joinRoomBtn").disabled = !state.backendAvailable;
  $("submitJoinRoomBtn").disabled = !state.backendAvailable;
  $("createRoomBtn").title = state.backendAvailable ? "" : "Requires the Node backend or a realtime hosting service.";
  $("createTugRoomBtn").title = state.backendAvailable ? "" : "Requires the Node backend or a realtime hosting service.";
  $("joinRoomBtn").title = state.backendAvailable ? "" : "Requires the Node backend or a realtime hosting service.";
  if (!state.backendAvailable && WORDS.answers.length) {
    $("menuStatus").textContent = `${WORDS.answers.length.toLocaleString()} answer words loaded. Daily Sprint is ready.`;
  }
}

$("soloBtn").disabled = true;
$("createRoomBtn").disabled = true;
$("createTugRoomBtn").disabled = true;
$("joinRoomBtn").disabled = true;
$("submitJoinRoomBtn").disabled = true;
initTheme();
initScoreTip();
registerServiceWorker();
$("playerName").value = localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || "";
loadWords();
