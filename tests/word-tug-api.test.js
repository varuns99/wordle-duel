const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 4191;
const BASE = `http://127.0.0.1:${PORT}/api`;
const TUG_TEST_WORDS = ["knack", "snoop", "buggy", "vogue", "crane", "slate"];
const RACE_TEST_WORDS = ["crane", "slate", "vogue", "buggy", "knack", "snoop"];
const WORD_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "words.json"), "utf8"));

function testTugAnswer(roundNumber) {
  return TUG_TEST_WORDS[(Math.max(1, roundNumber) - 1) % TUG_TEST_WORDS.length];
}

function testRaceAnswer(roundNumber) {
  return RACE_TEST_WORDS[(Math.max(1, roundNumber) - 1) % RACE_TEST_WORDS.length];
}

function wrongGuesses(answer) {
  return WORD_DATA.answers.filter((word) => word !== answer).slice(0, 6);
}

function todayModeAnswer(mode, roundNumber = 1) {
  const words = WORD_DATA.answers;
  const start = Date.UTC(2026, 0, 1);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayNumber = Math.floor((today - start) / 86_400_000);
  const base = ((dayNumber % words.length) + words.length) % words.length;
  const offsets = { duel: 811, tug: 1627 };
  return words[(base + (offsets[mode] || 0) + Math.max(0, roundNumber - 1)) % words.length];
}

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "word-tug-test-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      TUG_COUNTDOWN_MS: "80",
      TUG_WORD_SEQUENCE: TUG_TEST_WORDS.join(","),
      RACE_WORD_SEQUENCE: RACE_TEST_WORDS.join(",")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return {
    child,
    dataDir,
    async ready() {
      for (let i = 0; i < 80; i += 1) {
        try {
          const response = await fetch(`${BASE}/leaderboard`);
          if (response.ok) return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      throw new Error(`Server did not start:\n${output}`);
    },
    stop() {
      child.kill("SIGTERM");
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

async function api(method, pathName, body) {
  const response = await fetch(`${BASE}${pathName}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  return { response, payload };
}

async function post(pathName, body) {
  return api("POST", pathName, body);
}

async function get(pathName) {
  return api("GET", pathName);
}

async function createReadyTugRoom() {
  const created = await post("/rooms", { name: "Alpha", mode: "tug" });
  assert.equal(created.response.status, 200);
  const code = created.payload.room.code;
  const alphaId = created.payload.room.playerId;

  const joined = await post("/rooms/join", { name: "Beta", code: code.toLowerCase() });
  assert.equal(joined.response.status, 200);
  const betaId = joined.payload.room.playerId;

  const third = await post("/rooms/join", { name: "Gamma", code });
  assert.equal(third.response.status, 409);
  assert.equal(third.payload.error, "Room is full");

  const beforeReady = await post(`/rooms/${code}/${alphaId}/guess`, {
    guess: testTugAnswer(1),
    roundNumber: 1
  });
  assert.equal(beforeReady.response.status, 409);
  assert.equal(beforeReady.payload.error, "Both players need to be ready.");

  await post(`/rooms/${code}/${alphaId}/ready`);
  const ready = await post(`/rooms/${code}/${betaId}/ready`);
  assert.equal(ready.response.status, 200);
  assert.ok(ready.payload.room.countdownEndsAt);

  const duringCountdown = await post(`/rooms/${code}/${alphaId}/guess`, {
    guess: testTugAnswer(1),
    roundNumber: 1
  });
  assert.equal(duringCountdown.response.status, 409);
  assert.equal(duringCountdown.payload.error, "Countdown in progress.");

  await new Promise((resolve) => setTimeout(resolve, 100));
  return { code, alphaId, betaId };
}

async function createReadyRaceRoom() {
  const created = await post("/rooms", { name: "Alpha", mode: "race" });
  assert.equal(created.response.status, 200);
  assert.equal(created.payload.room.mode, "race");
  assert.equal(created.payload.room.targetScore, 5);
  const code = created.payload.room.code;
  const alphaId = created.payload.room.playerId;

  const joined = await post("/rooms/join", { name: "Beta", code });
  assert.equal(joined.response.status, 200);
  const betaId = joined.payload.room.playerId;

  const beforeReady = await post(`/rooms/${code}/${alphaId}/guess`, {
    guess: testRaceAnswer(1),
    roundNumber: 1
  });
  assert.equal(beforeReady.response.status, 409);
  assert.equal(beforeReady.payload.error, "Both players need to be ready.");

  await post(`/rooms/${code}/${alphaId}/ready`);
  const ready = await post(`/rooms/${code}/${betaId}/ready`);
  assert.equal(ready.response.status, 200);
  assert.ok(ready.payload.room.countdownEndsAt);

  const duringCountdown = await post(`/rooms/${code}/${alphaId}/guess`, {
    guess: testRaceAnswer(1),
    roundNumber: 1
  });
  assert.equal(duringCountdown.response.status, 409);
  assert.equal(duringCountdown.payload.error, "Countdown in progress.");

  await new Promise((resolve) => setTimeout(resolve, 100));
  return { code, alphaId, betaId };
}

async function createDuelRoom() {
  const created = await post("/rooms", { name: "Sprint Alpha", mode: "duel" });
  assert.equal(created.response.status, 200);
  const code = created.payload.room.code;
  const alphaId = created.payload.room.playerId;

  const joined = await post("/rooms/join", { name: "Sprint Beta", code });
  assert.equal(joined.response.status, 200);
  const betaId = joined.payload.room.playerId;

  return { code, alphaId, betaId };
}

async function testSprintDuelReadyCountdown() {
  const { code, alphaId, betaId } = await createDuelRoom();
  const answer = todayModeAnswer("duel");

  const beforeReady = await post(`/rooms/${code}/${alphaId}/guess`, { guess: answer });
  assert.equal(beforeReady.response.status, 409);
  assert.equal(beforeReady.payload.error, "Both players need to be ready.");

  const alphaReady = await post(`/rooms/${code}/${alphaId}/ready`);
  assert.equal(alphaReady.response.status, 200);

  const oneReady = await post(`/rooms/${code}/${betaId}/guess`, { guess: answer });
  assert.equal(oneReady.response.status, 409);
  assert.equal(oneReady.payload.error, "Both players need to be ready.");

  const betaReady = await post(`/rooms/${code}/${betaId}/ready`);
  assert.equal(betaReady.response.status, 200);
  assert.ok(betaReady.payload.room.countdownEndsAt);

  const duringCountdown = await post(`/rooms/${code}/${alphaId}/guess`, { guess: answer });
  assert.equal(duringCountdown.response.status, 409);
  assert.equal(duringCountdown.payload.error, "Countdown in progress.");

  await new Promise((resolve) => setTimeout(resolve, 100));
  const active = await get(`/rooms/${code}/${alphaId}`);
  assert.equal(active.payload.room.roundActive, true);

  const solved = await post(`/rooms/${code}/${alphaId}/guess`, { guess: answer });
  assert.equal(solved.response.status, 200);
  assert.equal(solved.payload.won, true);
  assert.ok(solved.payload.startedAt <= Date.now());
}

async function testHappyPath() {
  const { code, alphaId, betaId } = await createReadyTugRoom();
  const active = await get(`/rooms/${code}/${alphaId}`);
  assert.equal(active.payload.room.roundActive, true);

  const round1 = await post(`/rooms/${code}/${alphaId}/guess`, {
    guess: testTugAnswer(1),
    roundNumber: 1
  });
  assert.equal(round1.response.status, 200);
  assert.equal(round1.payload.won, true);
  assert.equal(round1.payload.room.roundNumber, 2);
  assert.equal(round1.payload.room.you.progress.length, 0);
  assert.equal(round1.payload.room.scores[alphaId], 1);
  assert.equal(round1.payload.room.scores[betaId], -1);
  assert.equal(round1.payload.roundResult.word, testTugAnswer(1));

  const stale = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: testTugAnswer(1),
    roundNumber: 1
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.error, "That round already ended.");
  assert.equal(stale.payload.room.roundNumber, 2);
  assert.equal(stale.payload.room.you.progress.length, 0);

  const betaScores = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: testTugAnswer(2),
    roundNumber: 2
  });
  assert.equal(betaScores.response.status, 200);
  assert.equal(betaScores.payload.room.roundNumber, 3);
  assert.equal(betaScores.payload.room.scores[betaId], 0);
}

async function testRaceHappyPath() {
  const { code, alphaId, betaId } = await createReadyRaceRoom();
  const active = await get(`/rooms/${code}/${alphaId}`);
  assert.equal(active.payload.room.roundActive, true);

  const round1 = await post(`/rooms/${code}/${alphaId}/guess`, {
    guess: testRaceAnswer(1),
    roundNumber: 1
  });
  assert.equal(round1.response.status, 200);
  assert.equal(round1.payload.won, true);
  assert.equal(round1.payload.room.roundNumber, 2);
  assert.equal(round1.payload.room.scores[alphaId], 1);
  assert.equal(round1.payload.room.scores[betaId], 0);
  assert.equal(round1.payload.roundResult.word, testRaceAnswer(1));
  assert.equal(round1.payload.roundResult.reason, "solve");

  const stale = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: testRaceAnswer(1),
    roundNumber: 1
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.error, "That round already ended.");
  assert.equal(stale.payload.room.roundNumber, 2);

  const betaScores = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: testRaceAnswer(2),
    roundNumber: 2
  });
  assert.equal(betaScores.response.status, 200);
  assert.equal(betaScores.payload.room.roundNumber, 3);
  assert.equal(betaScores.payload.room.scores[alphaId], 1);
  assert.equal(betaScores.payload.room.scores[betaId], 1);
}

async function testRaceMissAwardsOpponent() {
  const { code, alphaId, betaId } = await createReadyRaceRoom();
  const answer = testRaceAnswer(1);
  const misses = wrongGuesses(answer);

  for (let index = 0; index < 6; index += 1) {
    const result = await post(`/rooms/${code}/${alphaId}/guess`, {
      guess: misses[index],
      roundNumber: 1
    });
    assert.equal(result.response.status, 200);
    if (index < 5) {
      assert.equal(result.payload.finished, false);
    } else {
      assert.equal(result.payload.finished, true);
      assert.equal(result.payload.roundResult.reason, "miss");
      assert.equal(result.payload.roundResult.winnerId, betaId);
      assert.equal(result.payload.room.scores[alphaId], 0);
      assert.equal(result.payload.room.scores[betaId], 1);
      assert.equal(result.payload.room.roundNumber, 2);
    }
  }
}

async function testRaceMatchWinner() {
  const { code, alphaId, betaId } = await createReadyRaceRoom();

  for (let round = 1; round <= 5; round += 1) {
    const result = await post(`/rooms/${code}/${alphaId}/guess`, {
      guess: testRaceAnswer(round),
      roundNumber: round
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.room.scores[alphaId], round);
    assert.equal(result.payload.room.scores[betaId], 0);
  }

  const finished = await get(`/rooms/${code}/${betaId}`);
  assert.equal(finished.payload.room.matchWinnerId, alphaId);
  assert.equal(finished.payload.room.roundNumber, 5);
  assert.equal(finished.payload.room.scores[alphaId], 5);

  const afterMatch = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: testRaceAnswer(5),
    roundNumber: 5
  });
  assert.equal(afterMatch.response.status, 409);
  assert.equal(afterMatch.payload.error, "Match is already finished");
}

async function testConcurrentStaleRoundGuard() {
  const { code, alphaId, betaId } = await createReadyTugRoom();
  const [alpha, beta] = await Promise.all([
    post(`/rooms/${code}/${alphaId}/guess`, {
      guess: testTugAnswer(1),
      roundNumber: 1
    }),
    post(`/rooms/${code}/${betaId}/guess`, {
      guess: testTugAnswer(1),
      roundNumber: 1
    })
  ]);

  const statuses = [alpha.response.status, beta.response.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  const alphaRoom = await get(`/rooms/${code}/${alphaId}`);
  const betaRoom = await get(`/rooms/${code}/${betaId}`);
  assert.equal(alphaRoom.payload.room.roundNumber, 2);
  assert.equal(betaRoom.payload.room.roundNumber, 2);
  assert.equal(alphaRoom.payload.room.you.progress.length, 0);
  assert.equal(betaRoom.payload.room.you.progress.length, 0);
  assert.equal(alphaRoom.payload.room.opponent.progress.length, 0);
  assert.equal(betaRoom.payload.room.opponent.progress.length, 0);
}

async function testLegacyClientWithoutRoundNumber() {
  const { code, alphaId, betaId } = await createReadyTugRoom();

  const alphaScores = await post(`/rooms/${code}/${alphaId}/guess`, {
    guess: testTugAnswer(1)
  });
  assert.equal(alphaScores.response.status, 200);
  assert.equal(alphaScores.payload.won, true);
  assert.equal(alphaScores.payload.room.roundNumber, 2);
  assert.equal(alphaScores.payload.roundResult.word, testTugAnswer(1));

  const staleOldAnswer = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: testTugAnswer(1)
  });
  assert.equal(staleOldAnswer.response.status, 409);
  assert.equal(staleOldAnswer.payload.error, "That round already ended.");
  assert.equal(staleOldAnswer.payload.room.roundNumber, 2);
  assert.equal(staleOldAnswer.payload.room.you.progress.length, 0);

  const betaScores = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: testTugAnswer(2)
  });
  assert.equal(betaScores.response.status, 200);
  assert.equal(betaScores.payload.won, true);
  assert.equal(betaScores.payload.room.roundNumber, 3);
  assert.equal(betaScores.payload.roundResult.word, testTugAnswer(2));
}

async function testLegacyConcurrentStaleRoundGuard() {
  const { code, alphaId, betaId } = await createReadyTugRoom();
  const [alpha, beta] = await Promise.all([
    post(`/rooms/${code}/${alphaId}/guess`, {
      guess: testTugAnswer(1)
    }),
    post(`/rooms/${code}/${betaId}/guess`, {
      guess: testTugAnswer(1)
    })
  ]);

  const statuses = [alpha.response.status, beta.response.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  const alphaRoom = await get(`/rooms/${code}/${alphaId}`);
  const betaRoom = await get(`/rooms/${code}/${betaId}`);
  assert.equal(alphaRoom.payload.room.roundNumber, 2);
  assert.equal(betaRoom.payload.room.roundNumber, 2);
  assert.equal(alphaRoom.payload.room.you.progress.length, 0);
  assert.equal(betaRoom.payload.room.you.progress.length, 0);
  assert.equal(alphaRoom.payload.room.opponent.progress.length, 0);
  assert.equal(betaRoom.payload.room.opponent.progress.length, 0);
}

async function testTugLeaderboardRecord() {
  const { code, alphaId } = await createReadyTugRoom();

  for (let round = 1; round <= 3; round += 1) {
    const result = await post(`/rooms/${code}/${alphaId}/guess`, {
      guess: testTugAnswer(round),
      roundNumber: round
    });
    assert.equal(result.response.status, 200);
  }

  const leaderboard = await get("/leaderboard");
  assert.equal(leaderboard.response.status, 200);
  const tugEntry = leaderboard.payload.entries.find((entry) => entry.gameId === `${code}:tug:${alphaId}`);
  assert.ok(tugEntry);
  assert.equal(tugEntry.mode, "tug");
  assert.equal(tugEntry.name, "Alpha");
  assert.equal(tugEntry.loserName, "Beta");
}

async function run() {
  const server = startServer();
  try {
    await server.ready();
    await testSprintDuelReadyCountdown();
    await testHappyPath();
    await testRaceHappyPath();
    await testRaceMissAwardsOpponent();
    await testRaceMatchWinner();
    await testConcurrentStaleRoundGuard();
    await testLegacyClientWithoutRoundNumber();
    await testLegacyConcurrentStaleRoundGuard();
    await testTugLeaderboardRecord();
    console.log("Room API tests passed");
  } finally {
    server.stop();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
