import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { workerCancellation } from "./cancellation.mjs";
export function workerEnvironment(source) {
    const env = {
        ...source
    };
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    delete env.MAX_THINKING_TOKENS;
    delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    for (const key of Object.keys(env)){
        if (key === "CLAUDECODE" || /^CLAUDE_(?:CODE_)?(?:SESSION|PARENT|AGENT|TEAM|REMOTE|SSE|PLUGIN)/.test(key)) delete env[key];
    }
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    return env;
}
export function workerArguments(request) {
    return [
        "--safe-mode",
        "--print",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--model",
        request.model,
        "--effort",
        request.effort,
        "--system-prompt",
        request.system
    ];
}
export async function runClaudeWorker(request, parentSignal) {
    const started = performance.now();
    const cancellation = workerCancellation(request.deadlineMs, request.cancelPath, parentSignal);
    try {
        await cancellation.check();
        cancellation.signal.throwIfAborted();
        const exited = await new Promise((resolve, reject)=>{
            const child = spawn(request.claudePath, workerArguments(request), {
                cwd: dirname(request.outputPath),
                env: {
                    ...workerEnvironment(process.env),
                    CLAUDE_CODE_MAX_RETRIES: "0"
                },
                detached: process.platform !== "win32",
                stdio: [
                    "pipe",
                    "pipe",
                    "pipe"
                ]
            });
            let output = "";
            let failure;
            let escalation;
            const kill = (signal)=>{
                try {
                    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
                    else child.kill(signal);
                } catch  {}
            };
            const stop = ()=>{
                failure ??= new Error(cancellation.signal.reason?.name === "TimeoutError" ? "role_deadline_exceeded" : "preparation_cancelled");
                kill("SIGTERM");
                escalation ??= setTimeout(()=>kill("SIGKILL"), 500);
            };
            cancellation.signal.addEventListener("abort", stop, {
                once: true
            });
            if (cancellation.signal.aborted) stop();
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk)=>{
                output += chunk;
            });
            child.stderr.resume();
            child.stdin.on("error", ()=>undefined);
            child.once("error", (error)=>{
                failure = error;
            });
            child.once("close", (code)=>{
                cancellation.signal.removeEventListener("abort", stop);
                if (escalation) clearTimeout(escalation);
                if (failure) {
                    kill("SIGKILL");
                    reject(failure);
                } else resolve({
                    output,
                    exitCode: code
                });
            });
            child.stdin.end(request.prompt);
        });
        let reply;
        try {
            reply = JSON.parse(exited.output);
        } catch  {}
        const durationMs = Math.round(performance.now() - started);
        if (!reply || typeof reply !== "object") return {
            nonce: request.nonce,
            ok: false,
            error: `Claude CLI exited ${exited.exitCode} without a valid JSON result`,
            code: "worker_result_invalid",
            retryable: false,
            durationMs
        };
        if (exited.exitCode !== 0 || reply.is_error) {
            const code = typeof reply.api_error === "string" && /^[a-z_]+$/.test(reply.api_error) ? reply.api_error : "claude_request_failed";
            const status = typeof reply.api_error_status === "number" && Number.isInteger(reply.api_error_status) && reply.api_error_status >= 400 && reply.api_error_status <= 599 ? reply.api_error_status : undefined;
            return {
                nonce: request.nonce,
                ok: false,
                code,
                durationMs,
                error: `Claude CLI exited ${exited.exitCode}: ${code}${status ? ` (HTTP ${status})` : ""}`,
                retryable: status === 408 || status === 409 || status === 429 || status !== undefined && status >= 500
            };
        }
        if (typeof reply.result !== "string" || !reply.result.trim()) throw new Error("Claude CLI returned no successful result");
        return {
            nonce: request.nonce,
            ok: true,
            answer: reply.result,
            durationMs: Math.round(performance.now() - started)
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /role_deadline_exceeded|TimeoutError/.test(message) ? "role_deadline_exceeded" : /preparation_cancelled|abort/i.test(message) ? "preparation_cancelled" : /ENOENT/.test(message) ? "claude_unavailable" : "worker_failed";
        return {
            nonce: request.nonce,
            ok: false,
            error: message,
            code,
            retryable: false,
            durationMs: Math.round(performance.now() - started)
        };
    } finally{
        cancellation.close();
    }
}
export async function main() {
    const chunks = [];
    for await (const chunk of process.stdin)chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const stopping = new AbortController();
    const stop = ()=>stopping.abort(new Error("preparation_cancelled"));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
        const result = await runClaudeWorker(request, stopping.signal);
        const temporary = `${request.outputPath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(result), {
            mode: 0o600
        });
        await rename(temporary, request.outputPath);
        process.stdout.write(`${JSON.stringify({
            ok: result.ok,
            role: request.role,
            durationMs: result.durationMs
        })}\n`);
    } finally{
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
    }
}
