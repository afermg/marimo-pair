import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DISCOVER_SCRIPT = resolve(__dirname, "../skills/marimo-pair/scripts/discover-servers.sh");
const EXECUTE_SCRIPT = resolve(__dirname, "../skills/marimo-pair/scripts/execute-code.sh");

const EXECUTE_PARAMS = Type.Object({
  code: Type.Optional(
    Type.String({
      description:
        "Python code to execute in marimo's scratchpad. Prefer this for short or multiline snippets.",
    }),
  ),
  filePath: Type.Optional(
    Type.String({
      description:
        "Path to a file containing Python code to execute. Use instead of code for large snippets.",
    }),
  ),
  url: Type.Optional(
    Type.String({
      description:
        "Full marimo server URL, such as http://localhost:2718. Use when the target server is already known.",
    }),
  ),
  port: Type.Optional(
    Type.Integer({
      description:
        "Marimo server port to target during local auto-discovery, such as 2718.",
    }),
  ),
  session: Type.Optional(
    Type.String({
      description:
        "Specific marimo session ID to target when a server hosts multiple sessions.",
    }),
  ),
});

function normalizePathArgument(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function renderSessionSummary(sessions: unknown): string {
  if (!Array.isArray(sessions)) {
    return "Unable to parse marimo server discovery output.";
  }

  if (sessions.length === 0) {
    return "No running marimo servers found.";
  }

  const lines = sessions.map((session, index) => {
    const item = typeof session === "object" && session !== null ? (session as Record<string, unknown>) : {};
    const host = typeof item.host === "string" ? item.host : "localhost";
    const port = item.port ?? "?";
    const baseUrl = typeof item.base_url === "string" ? item.base_url : "";
    const serverId = typeof item.server_id === "string" ? item.server_id : `server-${index + 1}`;
    const pid = item.pid ?? "?";
    return `- ${serverId}: http://${host}:${port}${baseUrl} (pid ${pid})`;
  });

  return [`Found ${sessions.length} running marimo server(s):`, ...lines].join("\n");
}

function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];

  if (stdout.trim()) {
    parts.push(`stdout:\n${stdout.trimEnd()}`);
  }

  if (stderr.trim()) {
    parts.push(`stderr:\n${stderr.trimEnd()}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : "No output.";
}

export default function marimoPairPiExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "marimo_discover_sessions",
    label: "Discover Marimo Sessions",
    description: "List locally running marimo servers from marimo's server registry.",
    promptSnippet: "Discover running local marimo servers before connecting to a live notebook.",
    promptGuidelines: [
      "Use marimo_discover_sessions when the user wants to pair with a live marimo notebook and has not provided a server URL.",
      "For notebook-safe editing workflows and marimo._code_mode guidance, load /skill:marimo-pair before making durable notebook changes.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: "Discovering running marimo servers..." }],
      });

      const result = await pi.exec("bash", [DISCOVER_SCRIPT], { signal, timeout: 30_000 });
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";

      if (result.code !== 0) {
        return {
          content: [{ type: "text", text: combineOutput(stdout, stderr) }],
          details: { stdout, stderr, exitCode: result.code },
          isError: true,
        };
      }

      let parsed: unknown = [];
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : [];
      } catch {
        parsed = stdout;
      }

      const summary = renderSessionSummary(parsed);
      const raw = typeof parsed === "string" ? parsed.trim() : JSON.stringify(parsed, null, 2);
      const text = raw ? `${summary}\n\nRaw JSON:\n${raw}` : summary;

      return {
        content: [{ type: "text", text }],
        details: {
          sessions: Array.isArray(parsed) ? parsed : null,
          rawOutput: stdout,
          stderr,
          exitCode: result.code,
        },
      };
    },
  });

  pi.registerTool({
    name: "marimo_execute_code",
    label: "Execute Marimo Code",
    description:
      "Execute Python code in the scratchpad of a running marimo notebook session via the bundled execute-code.sh helper.",
    promptSnippet:
      "Run Python in a live marimo notebook session without editing notebook files directly.",
    promptGuidelines: [
      "Use marimo_execute_code to inspect notebook state, run Python, or drive marimo._code_mode against a live session.",
      "Prefer this tool over editing a marimo notebook .py file directly while the notebook is open.",
      "If the task involves durable notebook edits, load /skill:marimo-pair and follow its safety rules about marimo._code_mode.",
    ],
    parameters: EXECUTE_PARAMS,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const hasCode = typeof params.code === "string" && params.code.length > 0;
      const hasFilePath = typeof params.filePath === "string" && params.filePath.length > 0;

      if (hasCode === hasFilePath) {
        return {
          content: [{
            type: "text",
            text: "Provide exactly one of `code` or `filePath`."
          }],
          details: { params },
          isError: true,
        };
      }

      const args = [EXECUTE_SCRIPT];
      if (params.url) {
        args.push("--url", params.url);
      }
      if (typeof params.port === "number") {
        args.push("--port", String(params.port));
      }
      if (params.session) {
        args.push("--session", params.session);
      }

      if (hasCode) {
        args.push("-c", params.code!);
      } else {
        args.push(resolve(ctx.cwd, normalizePathArgument(params.filePath!)));
      }

      onUpdate?.({
        content: [{ type: "text", text: "Executing code in marimo..." }],
      });

      const result = await pi.exec("bash", args, { signal, timeout: 600_000 });
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const output = combineOutput(stdout, stderr);

      return {
        content: [{ type: "text", text: output }],
        details: {
          stdout,
          stderr,
          exitCode: result.code,
          killed: result.killed ?? false,
          invocation: {
            url: params.url ?? null,
            port: params.port ?? null,
            session: params.session ?? null,
            usedFilePath: hasFilePath ? resolve(ctx.cwd, normalizePathArgument(params.filePath!)) : null,
            usedInlineCode: hasCode,
          },
        },
        isError: result.code !== 0,
      };
    },
  });
}
