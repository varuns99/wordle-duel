const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
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
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(entries.slice(0, 50), null, 2));
}

function calculatePoints(attempts, elapsedMs) {
  const safeAttempts = Math.min(6, Math.max(1, Number(attempts) || 6));
  const safeElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  const seconds = safeElapsedMs / 1000;
  return Math.max(0, Math.round(10000 - safeAttempts * 1000 - seconds * 10));
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
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
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
      json(res, 200, { entries: readLeaderboard() });
      return;
    }

    if (req.method === "POST" && req.url === "/api/leaderboard") {
      const body = await readBody(req);
      const entries = readLeaderboard();
      const attempts = Math.min(6, Math.max(1, Number(body.attempts || 0)));
      const elapsedMs = Math.max(0, Number(body.elapsedMs || 0));
      entries.push({
        id: randomUUID(),
        name: String(body.name || "Player").slice(0, 24),
        mode: body.mode === "duel" ? "Duel" : "Solo",
        attempts,
        elapsedMs,
        points: calculatePoints(attempts, elapsedMs),
        solvedAt: new Date().toISOString()
      });
      entries.forEach((entry) => {
        entry.points = calculatePoints(entry.attempts, entry.elapsedMs);
      });
      entries.sort((a, b) => b.points - a.points || a.attempts - b.attempts || a.elapsedMs - b.elapsedMs);
      writeLeaderboard(entries);
      json(res, 200, { entries: entries.slice(0, 50) });
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
