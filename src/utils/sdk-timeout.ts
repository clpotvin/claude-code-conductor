import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Options passed to the Agent SDK `query()` call.
 */
export interface QueryOptions {
  allowedTools: string[];
  cwd: string;
  maxTurns: number;
}

/**
 * Wraps the Agent SDK `query()` call with a wall-clock timeout.
 *
 * Uses `Promise.race()` against a `setTimeout`. On timeout, stops consuming
 * the async iterable and returns whatever partial result was captured.
 * If no partial result exists, returns an empty string (callers handle empty).
 *
 * @param prompt     The prompt to send to the SDK
 * @param options    SDK query options (allowedTools, cwd, maxTurns)
 * @param timeoutMs  Maximum wall-clock time in milliseconds
 * @param label      Human-readable label for logging on timeout
 * @returns          The result text from the SDK query, or partial/empty on timeout
 */
export async function queryWithTimeout(
  prompt: string,
  options: QueryOptions,
  timeoutMs: number,
  label: string,
): Promise<string> {
  let resultText = "";
  let timedOut = false;

  const queryPromise = (async () => {
    const asyncIterable = query({
      prompt,
      options: {
        allowedTools: options.allowedTools,
        cwd: options.cwd,
        maxTurns: options.maxTurns,
      },
    });

    for await (const event of asyncIterable) {
      if (timedOut) break;
      if (event.type === "result" && "result" in event) {
        resultText =
          typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result);
      }
    }

    return resultText;
  })();

  const timeoutPromise = new Promise<string>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      console.warn(
        `[sdk-timeout] ${label} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
        `Partial result: ${resultText.length} chars.`,
      );
      resolve(resultText);
    }, timeoutMs);
  });

  return Promise.race([queryPromise, timeoutPromise]);
}
