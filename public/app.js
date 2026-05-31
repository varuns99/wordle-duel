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

function apiUrl(path) {
  return `${API_BASE}/${path}`;
}

function showView(id) {
  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("view-active", view.id === id);
  }
}

function playerName() {
  return $("playerName").value.trim() || "Player";
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

function setMessage(text) {
  $("message").textContent = text;
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
    startTime: Date.now(),
    elapsedMs: 0,
    timerId: null,
    pollId: null,
    finished: false
  });

  $("modeLabel").textContent = mode === "duel" ? `Room ${room.code}` : "Solo";
  $("gameTitle").textContent = mode === "duel" ? "Two-Player Duel" : "Solo Wordle";
  $("opponentPanel").classList.toggle("hidden", mode !== "duel");
  $("opponentName").textContent = "Waiting...";
  renderBoard();
  renderKeyboard();
  renderOpponent(null);
  setMessage(mode === "duel" ? "Share the room code. Your word starts now." : `Daily challenge ${dailyChallengeKey()}.`);
  showView("gameView");

  state.timerId = setInterval(updateTimer, 100);
  if (mode === "duel") {
    state.pollId = setInterval(pollRoom, 1000);
    pollRoom();
  }
}

function updateTimer() {
  if (!state.finished) {
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
    state.elapsedMs = data.elapsedMs || state.elapsedMs;
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
    if (!state.elapsedMs) {
      state.elapsedMs = Date.now() - state.startTime;
    }
    clearInterval(state.timerId);
    updateTimer();
    setMessage(won ? `Solved in ${state.row + 1} guesses.` : `The word was ${answer.toUpperCase()}.`);
    if (won) saveLeaderboard();
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

async function joinRoom() {
  if (!state.backendAvailable) {
    $("menuStatus").textContent = "Two-player rooms need the Node backend or another realtime host.";
    return;
  }
  const field = $("roomJoinField");
  if (field.classList.contains("hidden")) {
    field.classList.remove("hidden");
    $("menuStatus").textContent = "Enter a room code, then press Join Room again.";
    $("roomCodeInput").focus();
    return;
  }
  $("menuStatus").textContent = "";
  try {
    const response = await fetch(apiUrl("rooms/join"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: playerName(), code: $("roomCodeInput").value })
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
    data = { entries: JSON.parse(localStorage.getItem("wordleDuelScores") || "[]") };
  }
  if (!data.entries.length) {
    list.textContent = "No solved games yet.";
    return;
  }
  list.innerHTML = "";
  const header = document.createElement("div");
  header.className = "leader-row leader-header";
  header.innerHTML = `
    <span>Rank</span>
    <span>Name</span>
    <span>Points</span>
    <span>Tries</span>
    <span>Time</span>
    <span class="mode-cell">Mode</span>
  `;
  list.append(header);
  const entries = data.entries.map((entry) => ({
    ...entry,
    points: calculatePoints(entry.attempts, entry.elapsedMs)
  })).sort((a, b) => b.points - a.points || a.attempts - b.attempts || a.elapsedMs - b.elapsedMs);
  entries.slice(0, 20).forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "leader-row";
    row.innerHTML = `
      <span>#${index + 1}</span>
      <strong>${escapeHtml(entry.name)}</strong>
      <span>${entry.points.toLocaleString()}</span>
      <span>${entry.attempts}/6</span>
      <span>${formatTime(entry.elapsedMs)}</span>
      <span class="mode-cell">${entry.mode}</span>
    `;
    list.append(row);
  });
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
}

$("soloBtn").addEventListener("click", () => resetGame({ mode: "solo", answer: dailyAnswer() }));
$("createRoomBtn").addEventListener("click", createRoom);
$("joinRoomBtn").addEventListener("click", joinRoom);
$("leaderboardBtn").addEventListener("click", showLeaderboard);
$("backBtn").addEventListener("click", backToMenu);
$("leaderBackBtn").addEventListener("click", () => showView("menuView"));
document.addEventListener("keydown", (event) => {
  if ($("gameView").classList.contains("view-active")) handleKey(event.key);
});

async function loadWords() {
  try {
    const data = await fetchWordList();
    WORDS.answers = data.answers;
    WORDS.validGuesses = new Set(data.validGuesses);
    $("soloBtn").disabled = false;
    $("menuStatus").textContent = `${WORDS.answers.length.toLocaleString()} answer words loaded.`;
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
  $("createRoomBtn").title = state.backendAvailable ? "" : "Requires the Node backend or a realtime hosting service.";
  $("joinRoomBtn").title = state.backendAvailable ? "" : "Requires the Node backend or a realtime hosting service.";
  if (!state.backendAvailable && WORDS.answers.length) {
    $("menuStatus").textContent = `${WORDS.answers.length.toLocaleString()} answer words loaded. Solo mode is ready.`;
  }
}

$("soloBtn").disabled = true;
$("createRoomBtn").disabled = true;
$("joinRoomBtn").disabled = true;
loadWords();
