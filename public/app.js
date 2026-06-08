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
  finished: false
};

const rank = { absent: 1, present: 2, correct: 3 };
const $ = (id) => document.getElementById(id);
const WORD_LIST_URL = document.body.dataset.wordListUrl || "words.json";
const API_BASE = document.body.dataset.apiBase || "api";
const DAILY_CHALLENGE_OVERRIDES = {
  "2026-05-31": 420,
  "2026-06-01": 137,
  "2026-06-02": 921,
  "2026-06-03": 2048
};
const THEME_STORAGE_KEY = "wordleDuelTheme";
const PLAYER_NAME_STORAGE_KEY = "wordleDuelPlayerName";

function apiUrl(path) {
  return `${API_BASE}/${path}`;
}

function applyTheme(theme) {
  const isLight = theme === "light";
  document.body.classList.toggle("light-theme", isLight);
  $("themeToggle")?.setAttribute("aria-pressed", String(isLight));
  if ($("themeLabel")) $("themeLabel").textContent = isLight ? "Light" : "Dark";
}

function initTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const preferredTheme = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(savedTheme || preferredTheme);
  $("themeToggle")?.addEventListener("click", () => {
    const nextTheme = document.body.classList.contains("light-theme") ? "dark" : "light";
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    applyTheme(nextTheme);
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
      bestElapsedMs: Number.isFinite(player.bestElapsedMs) ? player.bestElapsedMs : 0
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints || b.bestPoints - a.bestPoints || a.bestElapsedMs - b.bestElapsedMs);
}

function setMessage(text) {
  $("message").textContent = text;
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
    finished: false
  });

  $("modeLabel").textContent = mode === "duel" ? "Room" : "Solo";
  $("gameTitle").textContent = mode === "duel" ? "Wordle Duel" : "Solo Wordle";
  $("roomBadge").classList.toggle("hidden", mode !== "duel");
  $("helpBtn").classList.toggle("hidden", mode === "duel");
  $("roomCodeDisplay").textContent = mode === "duel" ? room.code : "";
  $("copyRoomBtn").textContent = "Copy";
  $("opponentPanel").classList.toggle("hidden", mode !== "duel");
  $("opponentName").textContent = "Waiting...";
  renderBoard();
  renderKeyboard();
  renderOpponent(null);
  setMessage(mode === "duel" ? "Share the room code. Your word starts now." : `Daily challenge ${dailyChallengeKey()}.`);
  $("timer").textContent = formatTime(0);
  showView("gameView");

  if (mode === "duel") {
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
    $("board").append(row);
  }
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
  if (state.col < 5) {
    setMessage("Five letters first.");
    return;
  }
  const guess = state.guesses[state.row].join("").toLowerCase();
  if (!WORDS.validGuesses.has(guess)) {
    setMessage("Not in this word list.");
    return;
  }
  if (state.mode === "duel") {
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
    if (data.startedAt) startTimer(data.startedAt);
    if (data.elapsedMs) state.elapsedMs = data.elapsedMs;
    await applyGuessResult({
      guess,
      scored: data.result,
      won: data.won,
      answer: data.answer
    });
    renderOpponent(data.room.opponent);
  } catch {
    setMessage("Could not reach the room server.");
  }
}

async function applyGuessResult({ guess, scored, won, answer }) {
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
    if (won && state.mode !== "duel") saveLeaderboard();
    return;
  }

  state.row += 1;
  state.col = 0;
  setMessage("Good. Keep going.");
}

async function saveLeaderboard() {
  const entry = {
    name: playerName(),
    mode: state.mode,
    attempts: state.progress.length,
    elapsedMs: state.elapsedMs,
    points: calculatePoints(state.progress.length, state.elapsedMs)
  };
  try {
    const response = await fetch(apiUrl("leaderboard"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry)
    });
    if (!response.ok) throw new Error("Leaderboard API unavailable");
  } catch {
    const localEntries = JSON.parse(localStorage.getItem("wordleDuelScores") || "[]");
    localEntries.push({ ...entry, solvedAt: new Date().toISOString() });
    localEntries.forEach((score) => {
      score.points = calculatePoints(score.attempts, score.elapsedMs);
    });
    localEntries.sort((a, b) => b.points - a.points || a.attempts - b.attempts || a.elapsedMs - b.elapsedMs);
    localStorage.setItem("wordleDuelScores", JSON.stringify(localEntries.slice(0, 50)));
  }
}

async function pollRoom() {
  if (!state.room) return;
  try {
    const response = await fetch(apiUrl(`rooms/${state.room.code}/${state.room.playerId}`));
    if (!response.ok) return;
    const data = await response.json();
    renderOpponent(data.room.opponent);
  } catch {
    clearInterval(state.pollId);
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

async function createRoom() {
  $("menuStatus").textContent = "";
  if (!state.backendAvailable) {
    $("menuStatus").textContent = "Two-player rooms need the Node backend or another realtime host.";
    return;
  }
  try {
    const response = await fetch(apiUrl("rooms"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: playerName() })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create room");
    resetGame({ mode: "duel", answer: "", room: data.room });
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
    resetGame({ mode: "duel", answer: "", room: data.room });
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
    const localEntries = JSON.parse(localStorage.getItem("wordleDuelScores") || "[]");
    data = { entries: localEntries, players: aggregateLeaderboard(localEntries) };
  }
  const entries = data.entries || [];
  const dailyPlayers = aggregateLeaderboard(entries.filter((entry) => normalizeMode(entry.mode) === "daily"));
  const duelPlayers = aggregateLeaderboard(entries.filter((entry) => normalizeMode(entry.mode) === "duel"));
  if (!dailyPlayers.length && !duelPlayers.length) {
    list.textContent = "No solved games yet.";
    return;
  }
  list.innerHTML = "";
  renderLeaderboardSection(list, "Daily Challenge", dailyPlayers);
  renderLeaderboardSection(list, "Duel", duelPlayers);
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
    <span>Best Time</span>
    <span class="mode-cell">Best Tries</span>
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
      <span>${formatTime(player.bestElapsedMs)}</span>
      <span class="mode-cell">${player.bestAttempts}/6</span>
    `;
    section.append(row);
  });
  list.append(section);
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
$("createRoomBtn").addEventListener("click", createRoom);
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
  $("joinRoomBtn").disabled = !state.backendAvailable;
  $("submitJoinRoomBtn").disabled = !state.backendAvailable;
  $("createRoomBtn").title = state.backendAvailable ? "" : "Requires the Node backend or a realtime hosting service.";
  $("joinRoomBtn").title = state.backendAvailable ? "" : "Requires the Node backend or a realtime hosting service.";
  if (!state.backendAvailable && WORDS.answers.length) {
    $("menuStatus").textContent = `${WORDS.answers.length.toLocaleString()} answer words loaded. Solo mode is ready.`;
  }
}

$("soloBtn").disabled = true;
$("createRoomBtn").disabled = true;
$("joinRoomBtn").disabled = true;
$("submitJoinRoomBtn").disabled = true;
initTheme();
$("playerName").value = localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || "";
loadWords();
