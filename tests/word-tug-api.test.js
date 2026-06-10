const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 4191;
const BASE = `http://127.0.0.1:${PORT}/api`;

function todayTugAnswer(roundNumber) {
  const words = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "words.json"), "utf8")).answers;
  const start = Date.UTC(2026, 0, 1);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayNumber = Math.floor((today - start) / 86_400_000);
  const base = ((dayNumber % words.length) + words.length) % words.length;
  return words[(base + 1627 + Math.max(0, roundNumber - 1)) % words.length];
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
      TUG_COUNTDOWN_MS: "20"
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
    guess: todayTugAnswer(1),
    roundNumber: 1
  });
  assert.equal(beforeReady.response.status, 409);
  assert.equal(beforeReady.payload.error, "Both players need to be ready.");

  await post(`/rooms/${code}/${alphaId}/ready`);
  const ready = await post(`/rooms/${code}/${betaId}/ready`);
  assert.equal(ready.response.status, 200);
  assert.ok(ready.payload.room.countdownEndsAt);

  const duringCountdown = await post(`/rooms/${code}/${alphaId}/guess`, {
    guess: todayTugAnswer(1),
    roundNumber: 1
  });
  assert.equal(duringCountdown.response.status, 409);
  assert.equal(duringCountdown.payload.error, "Countdown in progress.");

  await new Promise((resolve) => setTimeout(resolve, 35));
  return { code, alphaId, betaId };
}

async function testHappyPath() {
  const { code, alphaId, betaId } = await createReadyTugRoom();
  const active = await get(`/rooms/${code}/${alphaId}`);
  assert.equal(active.payload.room.roundActive, true);

  const round1 = await post(`/rooms/${code}/${alphaId}/guess`, {
    guess: todayTugAnswer(1),
    roundNumber: 1
  });
  assert.equal(round1.response.status, 200);
  assert.equal(round1.payload.won, true);
  assert.equal(round1.payload.room.roundNumber, 2);
  assert.equal(round1.payload.room.you.progress.length, 0);
  assert.equal(round1.payload.room.scores[alphaId], 1);
  assert.equal(round1.payload.room.scores[betaId], -1);
  assert.equal(round1.payload.roundResult.word, todayTugAnswer(1));

  const stale = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: todayTugAnswer(1),
    roundNumber: 1
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.error, "That round already ended.");
  assert.equal(stale.payload.room.roundNumber, 2);
  assert.equal(stale.payload.room.you.progress.length, 0);

  const betaScores = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: todayTugAnswer(2),
    roundNumber: 2
  });
  assert.equal(betaScores.response.status, 200);
  assert.equal(betaScores.payload.room.roundNumber, 3);
  assert.equal(betaScores.payload.room.scores[betaId], 0);
}

async function testConcurrentStaleRoundGuard() {
  const { code, alphaId, betaId } = await createReadyTugRoom();
  const [alpha, beta] = await Promise.all([
    post(`/rooms/${code}/${alphaId}/guess`, {
      guess: todayTugAnswer(1),
      roundNumber: 1
    }),
    post(`/rooms/${code}/${betaId}/guess`, {
      guess: todayTugAnswer(1),
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
    guess: todayTugAnswer(1)
  });
  assert.equal(alphaScores.response.status, 200);
  assert.equal(alphaScores.payload.won, true);
  assert.equal(alphaScores.payload.room.roundNumber, 2);
  assert.equal(alphaScores.payload.roundResult.word, todayTugAnswer(1));

  const staleOldAnswer = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: todayTugAnswer(1)
  });
  assert.equal(staleOldAnswer.response.status, 409);
  assert.equal(staleOldAnswer.payload.error, "That round already ended.");
  assert.equal(staleOldAnswer.payload.room.roundNumber, 2);
  assert.equal(staleOldAnswer.payload.room.you.progress.length, 0);

  const betaScores = await post(`/rooms/${code}/${betaId}/guess`, {
    guess: todayTugAnswer(2)
  });
  assert.equal(betaScores.response.status, 200);
  assert.equal(betaScores.payload.won, true);
  assert.equal(betaScores.payload.room.roundNumber, 3);
  assert.equal(betaScores.payload.roundResult.word, todayTugAnswer(2));
}

async function testLegacyConcurrentStaleRoundGuard() {
  const { code, alphaId, betaId } = await createReadyTugRoom();
  const [alpha, beta] = await Promise.all([
    post(`/rooms/${code}/${alphaId}/guess`, {
      guess: todayTugAnswer(1)
    }),
    post(`/rooms/${code}/${betaId}/guess`, {
      guess: todayTugAnswer(1)
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

async function run() {
  const server = startServer();
  try {
    await server.ready();
    await testHappyPath();
    await testConcurrentStaleRoundGuard();
    await testLegacyClientWithoutRoundNumber();
    await testLegacyConcurrentStaleRoundGuard();
    console.log("Word Tug API tests passed");
  } finally {
    server.stop();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
