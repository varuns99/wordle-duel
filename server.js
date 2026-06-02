const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const WORDS_FILE = path.join(PUBLIC_DIR, "words.json");

const rooms = new Map();
const wordData = JSON.parse(fs.readFileSync(WORDS_FILE, "utf8"));
const words = wordData.answers;
const validGuesses = new Set(wordData.validGuesses || wordData.answers);
const dailyChallengeOverrides = {
  "2026-05-31": 420,
  "2026-06-01": 137,
  "2026-06-02": 921,
  "2026-06-03": 2048
};

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEADERBOARD_FILE)) {
    fs.writeFileSync(LEADERBOARD_FILE, "[]\n");
  }
}

function readLeaderboard() {
  ensureData();
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeLeaderboard(entries) {
  ensureData();
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(entries.slice(-1000), null, 2));
}

function calculatePoints(attempts, elapsedMs) {
  const safeAttempts = Math.min(6, Math.max(1, Number(attempts) || 6));
  const safeElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  const seconds = safeElapsedMs / 1000;
  return Math.max(0, Math.round(10000 - safeAttempts * 1000 - seconds * 10));
}

function normalizeScore(input) {
  const attempts = Math.min(6, Math.max(1, Number(input.attempts || 0)));
  const elapsedMs = Math.max(0, Number(input.elapsedMs || 0));
  return {
    id: input.id || randomUUID(),
    gameId: input.gameId || null,
    name: String(input.name || "Player").slice(0, 24),
    mode: input.mode === "duel" || input.mode === "Duel" ? "Duel" : "Solo",
    attempts,
    elapsedMs,
    points: calculatePoints(attempts, elapsedMs),
    solvedAt: input.solvedAt || new Date().toISOString()
  };
}

function aggregateLeaderboard(entries) {
  const players = new Map();
  for (const entry of entries.map(normalizeScore)) {
    const key = entry.name.trim().toLowerCase() || "player";
    const current = players.get(key) || {
      name: entry.name,
      games: 0,
      totalPoints: 0,
      bestPoints: 0,
      bestAttempts: 6,
      bestElapsedMs: Number.POSITIVE_INFINITY,
      lastSolvedAt: entry.solvedAt
    };
    current.games += 1;
    current.totalPoints += entry.points;
    current.bestPoints = Math.max(current.bestPoints, entry.points);
    if (entry.points > current.bestPoints) current.bestPoints = entry.points;
    if (
      entry.attempts < current.bestAttempts ||
      (entry.attempts === current.bestAttempts && entry.elapsedMs < current.bestElapsedMs)
    ) {
      current.bestAttempts = entry.attempts;
      current.bestElapsedMs = entry.elapsedMs;
    }
    if (new Date(entry.solvedAt) > new Date(current.lastSolvedAt)) {
      current.name = entry.name;
      current.lastSolvedAt = entry.solvedAt;
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

function recordLeaderboardScore(score) {
  const entries = readLeaderboard().map(normalizeScore);
  const normalized = normalizeScore(score);
  if (normalized.gameId && entries.some((entry) => entry.gameId === normalized.gameId)) {
    return { entries, players: aggregateLeaderboard(entries), saved: false };
  }
  entries.push(normalized);
  entries.sort((a, b) => new Date(a.solvedAt) - new Date(b.solvedAt));
  writeLeaderboard(entries);
  return { entries, players: aggregateLeaderboard(entries), saved: true };
}

function dailyChallengeKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function dailyAnswer(date = new Date()) {
  const override = dailyChallengeOverrides[dailyChallengeKey(date)];
  if (Number.isInteger(override)) {
    return words[override % words.length];
  }
  const start = Date.UTC(2026, 0, 1);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const dayNumber = Math.floor((today - start) / 86_400_000);
  const index = ((dayNumber % words.length) + words.length) % words.length;
  return words[index];
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function roomSnapshot(room, playerId) {
  const you = room.players[playerId];
  const opponentId = Object.keys(room.players).find((id) => id !== playerId);
  const opponent = opponentId ? room.players[opponentId] : null;

  return {
    code: room.code,
    wordLength: room.answer.length,
    playerId,
    startedAt: you.startedAt,
    playerCount: Object.keys(room.players).length,
    you,
    opponent: opponent
      ? {
          name: opponent.name,
          progress: opponent.progress,
          attempts: opponent.progress.length,
          solvedAt: opponent.solvedAt,
          elapsedMs: opponent.elapsedMs
        }
      : null
  };
}

function createPlayer(name) {
  return {
    name: String(name || "Player").slice(0, 24),
    startedAt: Date.now(),
    progress: [],
    solvedAt: null,
    elapsedMs: null
  };
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

function sendStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const safePath = path.normalize(requestPath).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, "");
  const candidates = [
    path.join(__dirname, safePath),
    path.join(PUBLIC_DIR, safePath),
    safePath.startsWith("public/") ? path.join(__dirname, safePath) : null
  ].filter(Boolean);
  const filePath = candidates.find((candidate) => {
    const insideApp = candidate.startsWith(__dirname);
    return insideApp && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  });

  if (!filePath) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json"
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/leaderboard") {
      const entries = readLeaderboard().map(normalizeScore);
      json(res, 200, { entries, players: aggregateLeaderboard(entries) });
      return;
    }

    if (req.method === "POST" && req.url === "/api/leaderboard") {
      const body = await readBody(req);
      const result = recordLeaderboardScore({
        name: body.name,
        mode: body.mode,
        attempts: body.attempts,
        elapsedMs: body.elapsedMs
      });
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/rooms") {
      const body = await readBody(req);
      const code = randomUUID().slice(0, 6).toUpperCase();
      const playerId = randomUUID();
      const answer = dailyAnswer();
      const room = {
        code,
        answer,
        challengeKey: dailyChallengeKey(),
        startedAt: Date.now(),
        players: {
          [playerId]: createPlayer(body.name)
        }
      };
      rooms.set(code, room);
      json(res, 200, { room: roomSnapshot(room, playerId) });
      return;
    }

    if (req.method === "POST" && req.url === "/api/rooms/join") {
      const body = await readBody(req);
      const code = String(body.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        json(res, 404, { error: "Room not found" });
        return;
      }
      if (Object.keys(room.players).length >= 2) {
        json(res, 409, { error: "Room is full" });
        return;
      }
      const playerId = randomUUID();
      room.players[playerId] = createPlayer(body.name);
      json(res, 200, { room: roomSnapshot(room, playerId) });
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/rooms/")) {
      const [, , , code, playerId] = req.url.split("/");
      const room = rooms.get(String(code || "").toUpperCase());
      if (!room || !room.players[playerId]) {
        json(res, 404, { error: "Room not found" });
        return;
      }
      json(res, 200, { room: roomSnapshot(room, playerId) });
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/api/rooms/")) {
      const [, , , code, playerId, action] = req.url.split("/");
      const room = rooms.get(String(code || "").toUpperCase());
      if (!room || !room.players[playerId]) {
        json(res, 404, { error: "Room not found" });
        return;
      }
      const body = await readBody(req);
      const player = room.players[playerId];

      if (action === "guess") {
        if (player.solvedAt || player.progress.length >= 6) {
          json(res, 409, { error: "Game is already finished" });
          return;
        }
        const guess = String(body.guess || "").toLowerCase();
        if (!validGuesses.has(guess)) {
          json(res, 400, { error: "Not in this word list" });
          return;
        }
        const result = scoreGuess(guess, room.answer);
        player.progress.push(result);
        const won = guess === room.answer;
        const finished = won || player.progress.length >= 6;
        if (won && !player.solvedAt) {
          player.solvedAt = Date.now();
          player.elapsedMs = player.solvedAt - player.startedAt;
          player.scoreRecorded = true;
          recordLeaderboardScore({
            gameId: `${room.code}:${playerId}`,
            name: player.name,
            mode: "duel",
            attempts: player.progress.length,
            elapsedMs: player.elapsedMs,
            solvedAt: new Date(player.solvedAt).toISOString()
          });
        }
        json(res, 200, {
          result,
          won,
          finished,
          attempts: player.progress.length,
          elapsedMs: player.elapsedMs,
          answer: finished ? room.answer : null,
          room: roomSnapshot(room, playerId)
        });
        return;
      }

      json(res, 404, { error: "Unknown room action" });
      return;
    }

    json(res, 404, { error: "Unknown endpoint" });
  } catch (error) {
    json(res, 400, { error: "Bad request" });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  sendStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`Wordle duel running at http://${displayHost}:${PORT}`);
});
