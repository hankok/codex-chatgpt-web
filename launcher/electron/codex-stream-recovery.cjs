const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const APP_TOOLS_REQUEST_TIMEOUT_MS = 5_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_HANDLED_FAILURES = 256;
const PENDING_RECOVERY_MAX_AGE_MS = 15 * 60 * 1_000;
const THREAD_RECOVERY_COOLDOWN_MS = 5 * 60 * 1_000;
const RECOVERABLE_STREAM_FRAGMENTS = [
  "stream disconnected before completion: ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing.",
  "stream disconnected before completion: ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
  "stream disconnected before completion: ChatGPT browser stage timed out: browser_page",
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableCodexStreamMessage(message) {
  return typeof message === "string"
    && RECOVERABLE_STREAM_FRAGMENTS.some(fragment => message.includes(fragment));
}

function validCodexId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(value);
}

function writePendingRecovery(filePath, failure, { now = Date.now } = {}) {
  if (!validCodexId(failure?.threadId) || !validCodexId(failure?.turnId)) {
    throw new Error("Codex recovery thread or turn id is invalid");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const record = {
    version: 1,
    threadId: failure.threadId,
    turnId: failure.turnId,
    source: typeof failure.source === "string" ? failure.source : "unknown",
    createdAt: now(),
  };
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
  return record;
}

function clearPendingRecovery(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch {}
}

function readPendingRecovery(
  filePath,
  { now = Date.now, maxAgeMs = PENDING_RECOVERY_MAX_AGE_MS } = {},
) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    clearPendingRecovery(filePath);
    return null;
  }
  const createdAt = Number(parsed?.createdAt);
  const currentTime = now();
  if (parsed?.version !== 1
    || !validCodexId(parsed.threadId)
    || !validCodexId(parsed.turnId)
    || !Number.isFinite(createdAt)
    || createdAt <= 0
    || currentTime - createdAt > maxAgeMs
    || createdAt - currentTime > 60_000) {
    clearPendingRecovery(filePath);
    return null;
  }
  return {
    version: 1,
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    source: typeof parsed.source === "string" ? parsed.source : "unknown",
    createdAt,
  };
}

function errorJsonMessage(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.message === "string" ? parsed.message : "";
  } catch {
    return "";
  }
}

function databaseCandidates(codexHome, prefix) {
  let entries = [];
  try {
    entries = fs.readdirSync(codexHome, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile() && new RegExp(`^${prefix}_(\\d+)\\.sqlite$`).test(entry.name))
    .map(entry => {
      const match = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`).exec(entry.name);
      return { path: path.join(codexHome, entry.name), version: Number(match?.[1] ?? 0) };
    })
    .sort((a, b) => b.version - a.version)
    .map(entry => entry.path);
}

function latestDatabase(codexHome, prefix) {
  return databaseCandidates(codexHome, prefix)[0] ?? null;
}

function readMaxRowId(databasePath, table) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM ${table}`).get();
    return Number(row?.max_rowid ?? 0);
  } finally {
    db.close();
  }
}

function readHistoryFailures(databasePath, afterRowId, throughRowId) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT rowid AS recovery_row_id, thread_id, turn_id, error_json
      FROM thread_turns
      WHERE rowid > ? AND rowid <= ? AND status = 'failed'
      ORDER BY rowid ASC
    `).all(afterRowId, throughRowId);
    return rows.map(row => ({
      rowId: Number(row.recovery_row_id),
      threadId: String(row.thread_id ?? ""),
      turnId: String(row.turn_id ?? ""),
      message: errorJsonMessage(row.error_json),
      source: "thread_history",
    }));
  } finally {
    db.close();
  }
}

function turnIdFromLogBody(body) {
  if (typeof body !== "string") return "";
  const match = /(?:turn\.id|turn_id)=([A-Za-z0-9_-]{6,128})/.exec(body);
  return match?.[1] ?? "";
}

function readLogFailures(databasePath, afterRowId, throughRowId) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id AS recovery_row_id, thread_id, feedback_log_body
      FROM logs
      WHERE id > ? AND id <= ?
        AND target = 'codex_core::session::turn'
        AND feedback_log_body LIKE '%Turn error: stream disconnected before completion:%'
      ORDER BY id ASC
    `).all(afterRowId, throughRowId);
    return rows.map(row => {
      const body = String(row.feedback_log_body ?? "");
      const marker = "Turn error: ";
      const markerIndex = body.lastIndexOf(marker);
      return {
        rowId: Number(row.recovery_row_id),
        threadId: String(row.thread_id ?? ""),
        turnId: turnIdFromLogBody(body),
        message: markerIndex >= 0 ? body.slice(markerIndex + marker.length) : body,
        source: "logs",
      };
    });
  } finally {
    db.close();
  }
}

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Codex app tools request is too large");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class CodexAppToolsPipeClient {
  constructor(pipePath, { timeoutMs = APP_TOOLS_REQUEST_TIMEOUT_MS } = {}) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out connecting to Codex app tools"));
      }, this.timeoutMs);
      const fail = error => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", fail);
        this.socket = socket;
        socket.on("data", chunk => this.onData(socket, chunk));
        socket.on("error", error => this.onDisconnect(socket, error));
        socket.on("close", () => this.onDisconnect(socket, new Error("Codex app tools pipe closed")));
        resolve();
      });
    });
  }

  async request(method, params) {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Codex app tools pipe is unavailable");
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app tools ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.write(encodeFrame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
    });
  }

  onData(socket, chunk) {
    if (this.socket !== socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readUInt32LE(0);
      if (frameLength > MAX_FRAME_BYTES) {
        this.onDisconnect(socket, new Error("Codex app tools response is too large"));
        socket.destroy();
        return;
      }
      if (this.buffer.length < frameLength + 4) return;
      const payload = this.buffer.subarray(4, frameLength + 4);
      this.buffer = this.buffer.subarray(frameLength + 4);
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        this.onDisconnect(socket, new Error("Codex app tools returned invalid JSON"));
        socket.destroy();
        return;
      }
      const pending = this.pending.get(Number(message?.id));
      if (!pending) continue;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message || "Codex app tools request failed"));
      else pending.resolve(message.result);
    }
  }

  onDisconnect(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    socket?.destroy();
    for (const pending of this.pending.values()) pending.reject(new Error("Codex app tools pipe closed"));
    this.pending.clear();
  }
}

function codexAppToolsPipeCandidates(env = process.env, tmpDir = os.tmpdir()) {
  const candidates = [];
  const explicit = env.CODEX_APP_TOOLS_PIPE_PATH?.trim();
  if (explicit) candidates.push(explicit);
  const directory = path.join(tmpDir, "codex-browser-use");
  try {
    const discovered = fs.readdirSync(directory)
      .filter(name => name.endsWith(".sock"))
      .map(name => {
        const candidate = path.join(directory, name);
        try {
          const stats = fs.statSync(candidate);
          if (!stats.isSocket()) return null;
          if (typeof process.getuid === "function" && stats.uid !== process.getuid()) return null;
          return { candidate, mtimeMs: stats.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(item => item.candidate);
    candidates.push(...discovered);
  } catch {}
  return [...new Set(candidates)];
}

async function sendRetryToCodexThread(
  threadId,
  turnId,
  { env = process.env, tmpDir = os.tmpdir(), timeoutMs = APP_TOOLS_REQUEST_TIMEOUT_MS } = {},
) {
  if (!validCodexId(threadId)) throw new Error("Codex recovery thread id is invalid");
  const failures = [];
  for (const pipePath of codexAppToolsPipeCandidates(env, tmpDir)) {
    const client = new CodexAppToolsPipeClient(pipePath, { timeoutMs });
    try {
      const catalog = await client.request("tools/list", { threadStartKind: "all" });
      const tool = Array.isArray(catalog?.tools)
        ? catalog.tools.find(candidate => candidate?.name === "send_message_to_thread")
        : undefined;
      if (!tool || typeof tool.namespace !== "string" || !tool.namespace) {
        throw new Error("Codex app tools does not expose send_message_to_thread");
      }
      const result = await client.request("tools/call", {
        arguments: { threadId, prompt: "retry" },
        callId: `codex-chatgpt-web-recovery-${randomUUID()}`,
        namespace: tool.namespace,
        threadId,
        tool: tool.name,
        turnId: validCodexId(turnId) ? turnId : `recovery-${randomUUID()}`,
      });
      if (result?.success !== true) throw new Error("Codex app rejected the recovery retry message");
      return { status: "sent" };
    } catch (error) {
      failures.push(errorMessage(error));
    } finally {
      client.close();
    }
  }
  throw new Error(failures.length > 0
    ? `Could not send retry through Codex app tools: ${failures.join("; ")}`
    : "Codex app tools pipe is unavailable");
}

class CodexStreamRecoveryMonitor {
  constructor({
    codexHome,
    logger,
    recover,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = Date.now,
  }) {
    this.codexHome = codexHome;
    this.logger = logger;
    this.recover = recover;
    this.pollIntervalMs = pollIntervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.now = now;
    this.timer = null;
    this.polling = false;
    this.watermarks = new Map();
    this.handled = new Map();
    this.threadRecoveryAt = new Map();
  }

  start() {
    if (this.timer) return;
    void this.poll().catch(error => this.logger?.warn("codex.stream_recovery_poll_failed", { message: errorMessage(error) }));
    this.timer = this.setIntervalFn(() => {
      void this.poll().catch(error => this.logger?.warn("codex.stream_recovery_poll_failed", { message: errorMessage(error) }));
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  rememberHandled(key) {
    this.handled.delete(key);
    this.handled.set(key, true);
    while (this.handled.size > MAX_HANDLED_FAILURES) {
      const oldest = this.handled.keys().next();
      if (oldest.done) break;
      this.handled.delete(oldest.value);
    }
  }

  readNewRows(databasePath, table, reader) {
    if (!databasePath) return [];
    const watermarkKey = `${table}:${databasePath}`;
    const upperBound = readMaxRowId(databasePath, table);
    if (!this.watermarks.has(watermarkKey)) {
      this.watermarks.set(watermarkKey, upperBound);
      return [];
    }
    const after = this.watermarks.get(watermarkKey) ?? 0;
    if (upperBound <= after) return [];
    const rows = reader(databasePath, after, upperBound);
    this.watermarks.set(watermarkKey, upperBound);
    return rows;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const historyPath = latestDatabase(this.codexHome, "thread_history");
      const logsPath = latestDatabase(this.codexHome, "logs");
      const rows = [
        ...this.readNewRows(historyPath, "thread_turns", readHistoryFailures),
        ...this.readNewRows(logsPath, "logs", readLogFailures),
      ];
      for (const failure of rows) {
        if (!failure.threadId || !failure.turnId || !isRecoverableCodexStreamMessage(failure.message)) continue;
        const key = `${failure.threadId}:${failure.turnId}`;
        if (this.handled.has(key)) continue;
        this.rememberHandled(key);
        const lastRecoveryAt = this.threadRecoveryAt.get(failure.threadId) ?? 0;
        const now = this.now();
        if (now - lastRecoveryAt < THREAD_RECOVERY_COOLDOWN_MS) {
          this.logger?.warn("codex.stream_recovery_suppressed", {
            threadId: failure.threadId,
            turnId: failure.turnId,
            source: failure.source,
            reason: "thread_recovery_cooldown",
          });
          continue;
        }
        this.threadRecoveryAt.set(failure.threadId, now);
        this.logger?.warn("codex.stream_disconnect_detected", {
          threadId: failure.threadId,
          turnId: failure.turnId,
          source: failure.source,
        });
        try {
          await this.recover(failure);
        } catch (error) {
          this.logger?.error("codex.stream_recovery_failed", {
            threadId: failure.threadId,
            turnId: failure.turnId,
            message: errorMessage(error),
          });
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

module.exports = {
  APP_TOOLS_REQUEST_TIMEOUT_MS,
  CodexAppToolsPipeClient,
  CodexStreamRecoveryMonitor,
  PENDING_RECOVERY_MAX_AGE_MS,
  THREAD_RECOVERY_COOLDOWN_MS,
  clearPendingRecovery,
  codexAppToolsPipeCandidates,
  isRecoverableCodexStreamMessage,
  readPendingRecovery,
  sendRetryToCodexThread,
  writePendingRecovery,
};
