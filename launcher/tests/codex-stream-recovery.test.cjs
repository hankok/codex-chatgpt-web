const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  CodexStreamRecoveryMonitor,
  clearPendingRecovery,
  isRecoverableCodexStreamMessage,
  readPendingRecovery,
  sendRetryToCodexThread,
  writePendingRecovery,
} = require("../electron/codex-stream-recovery.cjs");

const AMBIGUOUS = "stream disconnected before completion: ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing.";

function createHistoryDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error_json TEXT
    )
  `);
  return db;
}

function createLogsDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY,
      thread_id TEXT,
      target TEXT NOT NULL,
      feedback_log_body TEXT
    )
  `);
  return db;
}

test("recoverable Codex stream detection is narrow", () => {
  assert.equal(isRecoverableCodexStreamMessage(AMBIGUOUS), true);
  assert.equal(
    isRecoverableCodexStreamMessage("stream disconnected before completion: ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing."),
    true,
  );
  assert.equal(
    isRecoverableCodexStreamMessage("stream disconnected before completion: ChatGPT browser stage timed out: browser_page"),
    true,
  );
  assert.equal(
    isRecoverableCodexStreamMessage("Error running remote compact task: stream disconnected before completion: ChatGPT did not complete the context handoff. Retry the task."),
    false,
  );
});

test("pending recovery survives a launcher relaunch but stale recovery is discarded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stream-recovery-pending-"));
  const recoveryPath = path.join(root, "pending.json");
  try {
    const created = writePendingRecovery(recoveryPath, {
      threadId: "thread_target",
      turnId: "turn_failed",
      source: "thread_history",
    }, { now: () => 10_000 });
    assert.deepEqual(readPendingRecovery(recoveryPath, { now: () => 11_000 }), created);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(recoveryPath).mode & 0o777, 0o600);
    }
    assert.equal(readPendingRecovery(recoveryPath, {
      now: () => 10_000 + (16 * 60 * 1_000),
    }), null);
    assert.equal(fs.existsSync(recoveryPath), false);
  } finally {
    clearPendingRecovery(recoveryPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("monitor ignores historical failures and recovers one new terminal failure from chat history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stream-recovery-history-"));
  const history = createHistoryDatabase(path.join(root, "thread_history_1.sqlite"));
  const logs = createLogsDatabase(path.join(root, "logs_2.sqlite"));
  const insert = history.prepare("INSERT INTO thread_turns(thread_id, turn_id, status, error_json) VALUES (?, ?, ?, ?)");
  insert.run("thread_old", "turn_old", "failed", JSON.stringify({ message: AMBIGUOUS }));
  const recovered = [];
  const monitor = new CodexStreamRecoveryMonitor({
    codexHome: root,
    logger: { warn() {}, error() {} },
    recover: async failure => recovered.push(failure),
  });
  try {
    await monitor.poll();
    assert.equal(recovered.length, 0);

    insert.run("thread_new", "turn_new", "failed", JSON.stringify({ message: AMBIGUOUS }));
    await monitor.poll();
    assert.equal(recovered.length, 1);
    assert.deepEqual(
      { threadId: recovered[0].threadId, turnId: recovered[0].turnId, source: recovered[0].source },
      { threadId: "thread_new", turnId: "turn_new", source: "thread_history" },
    );
  } finally {
    history.close();
    logs.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("monitor can detect the same terminal error from Codex logs without reacting to retry warnings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stream-recovery-logs-"));
  const history = createHistoryDatabase(path.join(root, "thread_history_1.sqlite"));
  const logs = createLogsDatabase(path.join(root, "logs_2.sqlite"));
  const recovered = [];
  const monitor = new CodexStreamRecoveryMonitor({
    codexHome: root,
    logger: { warn() {}, error() {} },
    recover: async failure => recovered.push(failure),
  });
  try {
    await monitor.poll();
    logs.prepare("INSERT INTO logs(thread_id, target, feedback_log_body) VALUES (?, ?, ?)").run(
      "thread_log",
      "codex_core::responses_retry",
      `turn{turn.id=turn_retry}: stream disconnected - retrying sampling request (1/5) sampling_error=${AMBIGUOUS}`,
    );
    logs.prepare("INSERT INTO logs(thread_id, target, feedback_log_body) VALUES (?, ?, ?)").run(
      "thread_log",
      "codex_core::session::turn",
      `turn{turn.id=turn_terminal}: Turn error: ${AMBIGUOUS}`,
    );
    await monitor.poll();
    assert.equal(recovered.length, 1);
    assert.deepEqual(
      { threadId: recovered[0].threadId, turnId: recovered[0].turnId, source: recovered[0].source },
      { threadId: "thread_log", turnId: "turn_terminal", source: "logs" },
    );
  } finally {
    history.close();
    logs.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retry sender uses the Codex desktop app-tools pipe and exact failed thread", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stream-recovery-pipe-"));
  const pipeDir = path.join(root, "codex-browser-use");
  fs.mkdirSync(pipeDir);
  const socketPath = path.join(pipeDir, "desktop.sock");
  const calls = [];
  const server = net.createServer(socket => {
    let buffered = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < length + 4) return;
        const request = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
        buffered = buffered.subarray(length + 4);
        calls.push(request);
        const result = request.method === "tools/list"
          ? { tools: [{ name: "send_message_to_thread", namespace: "codex_app" }] }
          : { success: true, contentItems: [{ type: "inputText", text: "sent" }] };
        const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        const frame = Buffer.alloc(4 + payload.length);
        frame.writeUInt32LE(payload.length, 0);
        payload.copy(frame, 4);
        socket.write(frame);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const result = await sendRetryToCodexThread("thread_target", "turn_failed", {
      env: {},
      tmpDir: root,
      timeoutMs: 1_000,
    });
    assert.deepEqual(result, { status: "sent" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "tools/list");
    assert.equal(calls[1].method, "tools/call");
    assert.equal(calls[1].params.tool, "send_message_to_thread");
    assert.equal(calls[1].params.threadId, "thread_target");
    assert.equal(calls[1].params.turnId, "turn_failed");
    assert.deepEqual(calls[1].params.arguments, { threadId: "thread_target", prompt: "retry" });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher recovery performs a full Electron relaunch before retrying the persisted Codex thread", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const writePending = main.indexOf("writePendingRecovery(CODEX_STREAM_RECOVERY_PATH, failure)");
  const destroyBrowser = main.indexOf("browserHost?.destroy()", writePending);
  const relaunch = main.indexOf("app.relaunch()", destroyBrowser);
  const quit = main.indexOf("app.quit()", relaunch);
  const finishPending = main.indexOf("finishPendingCodexStreamRecovery(pendingStreamRecovery", quit);
  assert.ok(writePending >= 0);
  assert.ok(destroyBrowser > writePending);
  assert.ok(relaunch > destroyBrowser);
  assert.ok(quit > relaunch);
  assert.ok(finishPending > quit);
});
