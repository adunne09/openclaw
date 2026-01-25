import { AGENT_LANE_NESTED } from "../agents/lanes.js";
import { buildAgentToAgentMessageContext } from "../agents/tools/sessions-send-helpers.js";
import {
  extractAssistantText,
  resolveMainSessionAlias,
  resolveSessionReference,
  stripToolMessages,
} from "../agents/tools/sessions-helpers.js";
import { loadConfig } from "../config/config.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

type SessionsSendResult = {
  runId: string;
  status: "accepted" | "ok" | "timeout" | "error";
  sessionKey: string;
  reply?: string;
  error?: string;
};

const DEFAULT_TIMEOUT_SECONDS = 30;

function parseTimeoutSeconds(raw: unknown, runtime: RuntimeEnv): number | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TIMEOUT_SECONDS;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    runtime.error("--timeout must be a non-negative integer (seconds)");
    runtime.exit(1);
    return null;
  }
  return parsed;
}

function renderSessionsSendResult(
  result: SessionsSendResult,
  opts: { json?: boolean },
  runtime: RuntimeEnv,
) {
  const ok = result.status === "ok" || result.status === "accepted";
  if (opts.json) {
    runtime.log(JSON.stringify(result, null, 2));
    if (!ok) runtime.exit(1);
    return;
  }
  if (!ok) {
    runtime.error(result.error ?? "Session send failed");
    runtime.exit(1);
    return;
  }
  if (result.reply) {
    runtime.log(result.reply);
    return;
  }
  if (result.status === "accepted") {
    runtime.log(`Queued message for session ${result.sessionKey}.`);
    return;
  }
  runtime.log(`Message sent to session ${result.sessionKey}.`);
}

export async function sessionsSendCommand(
  opts: {
    session?: string;
    message?: string;
    timeout?: string | number;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const sessionInput = typeof opts.session === "string" ? opts.session.trim() : "";
  if (!sessionInput) {
    runtime.error("--session <sessionKey> is required");
    runtime.exit(1);
    return;
  }
  const message = typeof opts.message === "string" ? opts.message.trim() : "";
  if (!message) {
    runtime.error("--message <text> is required");
    runtime.exit(1);
    return;
  }

  const timeoutSeconds = parseTimeoutSeconds(opts.timeout, runtime);
  if (timeoutSeconds === null) return;

  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const resolvedSession = await resolveSessionReference({
    sessionKey: sessionInput,
    alias,
    mainKey,
    restrictToSpawned: false,
  });

  if (!resolvedSession.ok) {
    runtime.error(resolvedSession.error);
    runtime.exit(1);
    return;
  }

  const resolvedKey = resolvedSession.key;
  const displayKey = resolvedSession.displayKey;
  const idempotencyKey = randomIdempotencyKey();
  let runId: string = idempotencyKey;

  const sendParams = {
    message,
    sessionKey: resolvedKey,
    idempotencyKey,
    deliver: false,
    channel: INTERNAL_MESSAGE_CHANNEL,
    lane: AGENT_LANE_NESTED,
    extraSystemPrompt: buildAgentToAgentMessageContext({ targetSessionKey: displayKey }),
  };

  if (timeoutSeconds === 0) {
    try {
      const response = (await callGateway({
        method: "agent",
        params: sendParams,
        timeoutMs: 10_000,
      })) as { runId?: string };
      if (typeof response?.runId === "string" && response.runId) {
        runId = response.runId;
      }
      renderSessionsSendResult(
        { runId, status: "accepted", sessionKey: displayKey },
        opts,
        runtime,
      );
      return;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      renderSessionsSendResult(
        { runId, status: "error", error, sessionKey: displayKey },
        opts,
        runtime,
      );
      return;
    }
  }

  try {
    const response = (await callGateway({
      method: "agent",
      params: sendParams,
      timeoutMs: 10_000,
    })) as { runId?: string };
    if (typeof response?.runId === "string" && response.runId) {
      runId = response.runId;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    renderSessionsSendResult(
      { runId, status: "error", error, sessionKey: displayKey },
      opts,
      runtime,
    );
    return;
  }

  let waitStatus: string | undefined;
  let waitError: string | undefined;
  const timeoutMs = timeoutSeconds * 1000;
  try {
    const wait = (await callGateway({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 2000,
    })) as { status?: string; error?: string };
    waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
    waitError = typeof wait?.error === "string" ? wait.error : undefined;
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    const status = messageText.includes("gateway timeout") ? "timeout" : "error";
    renderSessionsSendResult(
      { runId, status, error: messageText, sessionKey: displayKey },
      opts,
      runtime,
    );
    return;
  }

  if (waitStatus === "timeout") {
    renderSessionsSendResult(
      { runId, status: "timeout", error: waitError, sessionKey: displayKey },
      opts,
      runtime,
    );
    return;
  }
  if (waitStatus === "error") {
    renderSessionsSendResult(
      { runId, status: "error", error: waitError ?? "agent error", sessionKey: displayKey },
      opts,
      runtime,
    );
    return;
  }

  const history = (await callGateway({
    method: "chat.history",
    params: { sessionKey: resolvedKey, limit: 50 },
  })) as { messages?: unknown[] };
  const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
  const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
  const reply = last ? extractAssistantText(last) : undefined;
  renderSessionsSendResult({ runId, status: "ok", reply, sessionKey: displayKey }, opts, runtime);
}
