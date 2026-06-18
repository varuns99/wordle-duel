const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomInt, randomUUID } = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const WORDS_FILE = path.join(PUBLIC_DIR, "words.json");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const LEADERBOARD_TABLE = "leaderboard_scores";

const rooms = new Map();
let supabaseClientPromise = null;
const wordData = JSON.parse(fs.readFileSync(WORDS_FILE, "utf8"));
const words = wordData.answers;
const validGuesses = new Set(wordData.validGuesses || wordData.answers);
const tugWordSequence = String(process.env.TUG_WORD_SEQUENCE || "")
  .split(",")
  .map((word) => word.trim().toLowerCase())
  .filter((word) => words.includes(word));
const raceWordSequence = String(process.env.RACE_WORD_SEQUENCE || "")
  .split(",")
  .map((word) => word.trim().toLowerCase())
  .filter((word) => words.includes(word));
const dailyChallengeOverrides = {
  "2026-05-31": 420,
  "2026-06-01": 137,
  "2026-06-02": 921,
  "2026-06-03": 2048
};
const TUG_TARGET_SCORE = 3;
const RACE_TARGET_SCORE = 5;
const TUG_COUNTDOWN_MS = Math.max(0, Number(process.env.TUG_COUNTDOWN_MS) || 5000);

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

function useSupabaseLeaderboard() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function getSupabaseClient() {
  if (!useSupabaseLeaderboard()) return null;
  if (!supabaseClientPromise) {
    supabaseClientPromise = import("@supabase/supabase-js").then(({ createClient }) => createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    ));
  }
  return supabaseClientPromise;
}

function calculatePoints(attempts, elapsedMs) {
  const safeAttempts = Math.min(6, Math.max(1, Number(attempts) || 6));
  const safeElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  const seconds = safeElapsedMs / 1000;
  return Math.max(0, Math.round(10000 - safeAttempts * 1000 - seconds * 10));
}

function normalizeScore(input, preservePoints = false) {
  const attempts = Math.min(6, Math.max(1, Number(input.attempts || 0)));
  const elapsedMs = Math.max(0, Number(input.elapsedMs || 0));
  const inputMode = String(input.mode || "").toLowerCase();
  const mode = inputMode === "duel" || inputMode === "tug" || inputMode === "race" ? inputMode : "daily";
  const explicitPoints = Number(input.points);
  return {
    id: input.id || randomUUID(),
    gameId: input.gameId || null,
    challengeKey: input.challengeKey || null,
    name: String(input.name || "Player").slice(0, 24),
    loserName: input.loserName ? String(input.loserName).slice(0, 24) : null,
    mode,
    attempts,
    elapsedMs,
    points: preservePoints && Number.isFinite(explicitPoints)
      ? Math.max(0, Math.round(explicitPoints))
      : calculatePoints(attempts, elapsedMs),
    solvedAt: input.solvedAt || new Date().toISOString()
  };
}

function scoreToRow(score) {
  return {
    id: score.id,
    game_id: score.gameId,
    challenge_key: score.challengeKey,
    name: score.name,
    loser_name: score.loserName,
    mode: score.mode,
    attempts: score.attempts,
    elapsed_ms: score.elapsedMs,
    points: score.points,
    solved_at: score.solvedAt
  };
}

function rowToScore(row) {
  return normalizeScore({
    id: row.id,
    gameId: row.game_id,
    challengeKey: row.challenge_key,
    name: row.name,
    loserName: row.loser_name,
    mode: row.mode,
    attempts: row.attempts,
    elapsedMs: row.elapsed_ms,
    points: row.points,
    solvedAt: row.solved_at
  }, true);
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

async function readLeaderboardEntries() {
  if (!useSupabaseLeaderboard()) {
    return readLeaderboard().map((entry) => normalizeScore(entry, true));
  }
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from(LEADERBOARD_TABLE)
    .select("*")
    .order("solved_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return (data || []).map(rowToScore).sort((a, b) => new Date(a.solvedAt) - new Date(b.solvedAt));
}

async function recordLeaderboardScore(score, preservePoints = false) {
  if (useSupabaseLeaderboard()) {
    return recordSupabaseLeaderboardScore(score, preservePoints);
  }
  const entries = readLeaderboard().map((entry) => normalizeScore(entry, true));
  const normalized = normalizeScore(score, preservePoints);
  if (normalized.gameId && entries.some((entry) => entry.gameId === normalized.gameId)) {
    return { entries, players: aggregateLeaderboard(entries), saved: false };
  }
  if (
    normalized.mode === "daily" &&
    normalized.challengeKey &&
    entries.some((entry) => (
      entry.mode === "daily" &&
      entry.challengeKey === normalized.challengeKey &&
      entry.name.trim().toLowerCase() === normalized.name.trim().toLowerCase()
    ))
  ) {
    return { entries, players: aggregateLeaderboard(entries), saved: false };
  }
  entries.push(normalized);
  entries.sort((a, b) => new Date(a.solvedAt) - new Date(b.solvedAt));
  writeLeaderboard(entries);
  return { entries, players: aggregateLeaderboard(entries), saved: true };
}

async function recordSupabaseLeaderboardScore(score, preservePoints = false) {
  const supabase = await getSupabaseClient();
  const normalized = normalizeScore(score, preservePoints);

  if (normalized.gameId) {
    const { data, error } = await supabase
      .from(LEADERBOARD_TABLE)
      .select("id")
      .eq("game_id", normalized.gameId)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      const entries = await readLeaderboardEntries();
      return { entries, players: aggregateLeaderboard(entries), saved: false };
    }
  }

  if (normalized.mode === "daily" && normalized.challengeKey) {
    const normalizedName = normalized.name.trim().toLowerCase();
    const { data, error } = await supabase
      .from(LEADERBOARD_TABLE)
      .select("name")
      .eq("mode", "daily")
      .eq("challenge_key", normalized.challengeKey);
    if (error) throw error;
    if ((data || []).some((entry) => String(entry.name || "").trim().toLowerCase() === normalizedName)) {
      const entries = await readLeaderboardEntries();
      return { entries, players: aggregateLeaderboard(entries), saved: false };
    }
  }

  const { error } = await supabase
    .from(LEADERBOARD_TABLE)
    .insert(scoreToRow(normalized));
  if (error) {
    if (normalized.gameId && error.code === "23505") {
      const entries = await readLeaderboardEntries();
      return { entries, players: aggregateLeaderboard(entries), saved: false };
    }
    throw error;
  }

  const entries = await readLeaderboardEntries();
  return { entries, players: aggregateLeaderboard(entries), saved: true };
}

function dailyChallengeKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function dailyIndex(date = new Date()) {
  const override = dailyChallengeOverrides[dailyChallengeKey(date)];
  if (Number.isInteger(override)) {
    return override % words.length;
  }
  const start = Date.UTC(2026, 0, 1);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const dayNumber = Math.floor((today - start) / 86_400_000);
  return ((dayNumber % words.length) + words.length) % words.length;
}

function dailyAnswer(date = new Date()) {
  return words[dailyIndex(date)];
}

function modeAnswerIndex(mode, roundNumber = 1, date = new Date()) {
  const base = dailyIndex(date);
  const offsets = {
    daily: 0,
    duel: 811,
    tug: 1627
  };
  const offset = offsets[mode] || 0;
  return (base + offset + Math.max(0, roundNumber - 1)) % words.length;
}

function modeAnswer(mode, roundNumber = 1, date = new Date()) {
  return words[modeAnswerIndex(mode, roundNumber, date)];
}

function randomAnswer(excluded = []) {
  if (excluded.length >= words.length) return words[randomInt(words.length)];
  const used = new Set(excluded);
  let answer = words[randomInt(words.length)];
  while (used.has(answer)) {
    answer = words[randomInt(words.length)];
  }
  return answer;
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
  const ready = room.ready || {};
  const playerIds = Object.keys(room.players);
  const needsReady = room.mode === "duel" || room.mode === "tug" || room.mode === "race";
  const roomRoundActive = !needsReady || (
    playerIds.length === 2 &&
    (
      ((room.roundNumber || 1) === 1 && playerIds.every((id) => ready[id]) && room.countdownEndsAt && Date.now() >= room.countdownEndsAt) ||
      ((room.mode === "tug" || room.mode === "race") && (room.roundNumber || 1) > 1 && room.roundStartAt && Date.now() >= room.roundStartAt)
    )
  );

  return {
    code: room.code,
    mode: room.mode || "duel",
    wordLength: room.answer.length,
    playerId,
    startedAt: you.startedAt,
    serverNow: Date.now(),
    ready,
    countdownEndsAt: room.countdownEndsAt || null,
    roundStartAt: room.roundStartAt || null,
    roundActive: roomRoundActive,
    playerCount: Object.keys(room.players).length,
    roundNumber: room.roundNumber || 1,
    targetScore: room.targetScore || (room.mode === "race" ? RACE_TARGET_SCORE : TUG_TARGET_SCORE),
    scores: room.scores || null,
    matchWinnerId: room.matchWinnerId || null,
    lastRound: room.lastRound || null,
    history: room.history || [],
    you,
    opponent: opponent
      ? {
          name: opponent.name,
          progress: opponent.progress,
          attempts: opponent.progress.length,
          solvedAt: opponent.solvedAt,
          elapsedMs: opponent.elapsedMs,
          finishedAt: opponent.finishedAt,
          won: opponent.won
        }
      : null
  };
}

function createPlayer(name) {
  return {
    name: String(name || "Player").slice(0, 24),
    startedAt: null,
    progress: [],
    solvedAt: null,
    finishedAt: null,
    elapsedMs: null,
    won: false
  };
}

function nextRoomAnswer(room) {
  if (!room || (room.mode !== "tug" && room.mode !== "race")) return modeAnswer("duel");
  const roundIndex = Math.max(0, (room.roundNumber || 1) - 1);
  const sequence = room.mode === "race" ? raceWordSequence : tugWordSequence;
  const key = room.mode === "race" ? "raceWords" : "tugWords";
  if (sequence.length) return sequence[roundIndex % sequence.length];
  room[key] = room[key] || [];
  while (room[key].length <= roundIndex) {
    room[key].push(randomAnswer(room[key]));
  }
  return room[key][roundIndex];
}

function resetPlayerRound(player) {
  player.startedAt = null;
  player.progress = [];
  player.solvedAt = null;
  player.finishedAt = null;
  player.elapsedMs = null;
  player.won = false;
}

function advanceTugRound(room, summary) {
  if (summary) {
    room.previousRound = {
      roundNumber: summary.roundNumber,
      answer: summary.word
    };
  }
  room.roundNumber += 1;
  room.answer = nextRoomAnswer(room);
  room.roundStartAt = Date.now();
  room.countdownEndsAt = null;
  for (const player of Object.values(room.players)) resetPlayerRound(player);
}

function advanceRaceRound(room, summary) {
  if (summary) {
    room.previousRound = {
      roundNumber: summary.roundNumber,
      answer: summary.word
    };
  }
  room.roundNumber += 1;
  room.answer = nextRoomAnswer(room);
  room.roundStartAt = Date.now();
  room.countdownEndsAt = null;
  for (const player of Object.values(room.players)) resetPlayerRound(player);
}

function isStaleTugGuess(room, body, guess) {
  const submittedRoundNumber = Number(body.roundNumber);
  if (Number.isInteger(submittedRoundNumber)) {
    return submittedRoundNumber !== (room.roundNumber || 1);
  }
  return Boolean(
    room.previousRound &&
    room.previousRound.roundNumber !== (room.roundNumber || 1) &&
    guess === room.previousRound.answer
  );
}

function isStaleRaceGuess(room, body) {
  const submittedRoundNumber = Number(body.roundNumber);
  return Number.isInteger(submittedRoundNumber) && submittedRoundNumber !== (room.roundNumber || 1);
}

async function maybeResolveTugRound(room) {
  if (room.mode !== "tug" || room.matchWinnerId) return null;
  const playerIds = Object.keys(room.players);
  if (playerIds.length < 2) return null;
  const [firstId, secondId] = playerIds;
  const first = room.players[firstId];
  const second = room.players[secondId];
  if (!first.finishedAt && !second.finishedAt) return null;

  let winnerId = null;
  let points = 1;
  if (first.finishedAt && !second.finishedAt) {
    winnerId = first.won ? firstId : secondId;
  } else if (!first.finishedAt && second.finishedAt) {
    winnerId = second.won ? secondId : firstId;
  } else if (first.won && second.won) {
    winnerId = first.elapsedMs <= second.elapsedMs ? firstId : secondId;
  } else if (first.won && !second.won) {
    winnerId = firstId;
  } else if (!first.won && second.won) {
    winnerId = secondId;
  } else {
    points = 0;
  }

  const summary = {
    roundNumber: room.roundNumber,
    word: room.answer,
    winnerId,
    points,
    players: Object.fromEntries(playerIds.map((id) => [id, {
      name: room.players[id].name,
      won: room.players[id].won,
      elapsedMs: room.players[id].elapsedMs,
      attempts: room.players[id].progress.length
    }]))
  };

  if (winnerId) {
    const loserId = playerIds.find((id) => id !== winnerId);
    room.scores[winnerId] = Math.min(room.targetScore, (room.scores[winnerId] || 0) + points);
    if (loserId) {
      room.scores[loserId] = Math.max(-room.targetScore, (room.scores[loserId] || 0) - points);
    }
    room.history.push({
      roundNumber: summary.roundNumber,
      word: summary.word,
      winnerId,
      winnerName: room.players[winnerId].name,
      loserId,
      points,
      scores: { ...room.scores }
    });
    if (room.scores[winnerId] >= room.targetScore) {
      room.matchWinnerId = winnerId;
      await recordLeaderboardScore({
        gameId: `${room.code}:tug:${winnerId}`,
        name: room.players[winnerId].name,
        loserName: loserId ? room.players[loserId].name : null,
        mode: "tug",
        attempts: room.history.length,
        elapsedMs: Date.now() - room.startedAt,
        solvedAt: new Date().toISOString()
      });
    }
  }

  summary.scores = { ...room.scores };
  summary.matchWinnerId = room.matchWinnerId || null;
  room.lastRound = summary;
  if (!room.matchWinnerId) advanceTugRound(room, summary);
  return summary;
}

async function maybeResolveRaceRound(room) {
  if (room.mode !== "race" || room.matchWinnerId) return null;
  const playerIds = Object.keys(room.players);
  if (playerIds.length < 2) return null;
  const finishedId = playerIds.find((id) => room.players[id].finishedAt);
  if (!finishedId) return null;

  const finishedPlayer = room.players[finishedId];
  const opponentId = playerIds.find((id) => id !== finishedId);
  const winnerId = finishedPlayer.won ? finishedId : opponentId;
  const reason = finishedPlayer.won ? "solve" : "miss";
  const points = winnerId ? 1 : 0;
  const summary = {
    roundNumber: room.roundNumber,
    word: room.answer,
    winnerId,
    points,
    reason,
    players: Object.fromEntries(playerIds.map((id) => [id, {
      name: room.players[id].name,
      won: room.players[id].won,
      elapsedMs: room.players[id].elapsedMs,
      attempts: room.players[id].progress.length
    }]))
  };

  if (winnerId) {
    room.scores[winnerId] = Math.min(room.targetScore, (room.scores[winnerId] || 0) + points);
    room.history.push({
      roundNumber: summary.roundNumber,
      word: summary.word,
      winnerId,
      winnerName: room.players[winnerId].name,
      loserId: playerIds.find((id) => id !== winnerId),
      points,
      reason,
      scores: { ...room.scores }
    });
    if (room.scores[winnerId] >= room.targetScore) {
      room.matchWinnerId = winnerId;
      const loserId = playerIds.find((id) => id !== winnerId);
      const loserName = loserId ? room.players[loserId].name : null;
      const elapsedMs = Date.now() - room.startedAt;
      await recordLeaderboardScore({
        gameId: `${room.code}:race:${winnerId}:win`,
        name: room.players[winnerId].name,
        loserName,
        mode: "race",
        attempts: room.history.length,
        elapsedMs,
        points: room.scores[winnerId] || 0,
        solvedAt: new Date().toISOString()
      }, true);
      if (loserId) {
        await recordLeaderboardScore({
          gameId: `${room.code}:race:${loserId}:points`,
          name: room.players[loserId].name,
          mode: "race",
          attempts: room.history.length,
          elapsedMs,
          points: room.scores[loserId] || 0,
          solvedAt: new Date().toISOString()
        }, true);
      }
    }
  }

  summary.scores = { ...room.scores };
  summary.matchWinnerId = room.matchWinnerId || null;
  room.lastRound = summary;
  if (!room.matchWinnerId) advanceRaceRound(room, summary);
  return summary;
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
  const pathname = decodeURIComponent(req.url.split("?")[0]);
  const requestPath = pathname === "/" ? "/index.html" : pathname;
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
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
      ".svg": "image/svg+xml",
      ".png": "image/png"
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      json(res, 200, {
        ok: true,
        rooms: true,
        serverNow: Date.now()
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/leaderboard") {
      const entries = await readLeaderboardEntries();
      json(res, 200, { entries, players: aggregateLeaderboard(entries) });
      return;
    }

    if (req.method === "POST" && req.url === "/api/leaderboard") {
      const body = await readBody(req);
      const result = await recordLeaderboardScore({
        name: body.name,
        loserName: body.loserName,
        mode: body.mode,
        attempts: body.attempts,
        elapsedMs: body.elapsedMs,
        gameId: body.gameId,
        challengeKey: body.challengeKey
      });
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && req.url === "/api/rooms") {
      const body = await readBody(req);
      const code = randomUUID().slice(0, 6).toUpperCase();
      const playerId = randomUUID();
      const mode = body.mode === "tug" || body.mode === "race" ? body.mode : "duel";
      const room = {
        code,
        mode,
        answer: modeAnswer("duel"),
        challengeKey: dailyChallengeKey(),
        startedAt: Date.now(),
        roundNumber: 1,
        targetScore: mode === "race" ? RACE_TARGET_SCORE : TUG_TARGET_SCORE,
        scores: {
          [playerId]: 0
        },
        tugWords: [],
        raceWords: [],
        history: [],
        lastRound: null,
        previousRound: null,
        matchWinnerId: null,
        ready: {},
        countdownEndsAt: null,
        roundStartAt: null,
        players: {
          [playerId]: createPlayer(body.name)
        }
      };
      if (mode === "tug" || mode === "race") room.answer = nextRoomAnswer(room);
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
      if (room.mode === "tug" || room.mode === "race") room.scores[playerId] = 0;
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

      if (action === "ready") {
        if (room.mode !== "duel" && room.mode !== "tug" && room.mode !== "race") {
          json(res, 400, { error: "Ready is only available for room games" });
          return;
        }
        if (room.matchWinnerId) {
          json(res, 409, { error: "Match is already finished" });
          return;
        }
        if ((room.roundNumber || 1) !== 1) {
          json(res, 409, { error: "Ready is only needed before the first round" });
          return;
        }
        if (room.mode === "duel" && Object.values(room.players).some((participant) => participant.progress.length > 0 || participant.finishedAt)) {
          json(res, 409, { error: "Daily Word - Duel already started" });
          return;
        }
        room.ready = room.ready || {};
        room.ready[playerId] = true;
        const playerIds = Object.keys(room.players);
        const allReady = playerIds.length === 2 && playerIds.every((id) => room.ready[id]);
        if (allReady && !room.countdownEndsAt) {
          room.countdownEndsAt = Date.now() + TUG_COUNTDOWN_MS;
          room.roundStartAt = room.countdownEndsAt;
        }
        json(res, 200, { room: roomSnapshot(room, playerId) });
        return;
      }

      if (action === "guess") {
        if (room.matchWinnerId) {
          json(res, 409, { error: "Match is already finished" });
          return;
        }
        if (room.mode === "duel" || room.mode === "tug" || room.mode === "race") {
          const playerIds = Object.keys(room.players);
          if (playerIds.length < 2) {
            json(res, 409, { error: "Waiting for opponent." });
            return;
          }
          if (room.mode === "duel" || (room.roundNumber || 1) === 1) {
            const allReady = playerIds.every((id) => room.ready?.[id]);
            if (!allReady) {
              json(res, 409, { error: "Both players need to be ready." });
              return;
            }
            if (!room.countdownEndsAt || Date.now() < room.countdownEndsAt) {
              json(res, 409, { error: "Countdown in progress." });
              return;
            }
          }
        }
        if (player.finishedAt || player.progress.length >= 6) {
          json(res, 409, { error: "Game is already finished" });
          return;
        }
        const guess = String(body.guess || "").toLowerCase();
        if (!validGuesses.has(guess)) {
          json(res, 400, { error: "Not in this word list" });
          return;
        }
        if (room.mode === "tug" && isStaleTugGuess(room, body, guess)) {
          json(res, 409, {
            error: "That round already ended.",
            room: roomSnapshot(room, playerId)
          });
          return;
        }
        if (room.mode === "race" && isStaleRaceGuess(room, body)) {
          json(res, 409, {
            error: "That round already ended.",
            room: roomSnapshot(room, playerId)
          });
          return;
        }
        if (!player.startedAt) {
          player.startedAt = room.mode === "tug" || room.mode === "race" || room.mode === "duel" ? room.roundStartAt : Date.now();
        }
        const submittedAnswer = room.answer;
        const result = scoreGuess(guess, room.answer);
        player.progress.push(result);
        const won = guess === room.answer;
        const finished = won || player.progress.length >= 6;
        if (finished && !player.finishedAt) {
          player.finishedAt = Date.now();
          player.elapsedMs = player.finishedAt - player.startedAt;
          player.won = won;
        }
        if (won && !player.solvedAt) {
          player.solvedAt = player.finishedAt;
          player.scoreRecorded = true;
          if (room.mode !== "tug" && room.mode !== "race") {
            await recordLeaderboardScore({
              gameId: `${room.code}:${playerId}`,
              name: player.name,
              mode: "duel",
              attempts: player.progress.length,
              elapsedMs: player.elapsedMs,
              solvedAt: new Date(player.solvedAt).toISOString()
            });
          }
        }
        const startedAt = player.startedAt;
        const attempts = player.progress.length;
        const elapsedMs = player.elapsedMs;
        const roundResult = room.mode === "tug" ? await maybeResolveTugRound(room) : room.mode === "race" ? await maybeResolveRaceRound(room) : null;
        json(res, 200, {
          result,
          won,
          finished,
          roundResult,
          startedAt,
          attempts,
          elapsedMs,
          answer: finished ? submittedAnswer : null,
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
  console.log(`Word Sprint running at http://${displayHost}:${PORT}`);
});
