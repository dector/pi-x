import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, TruncationResult } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

const DEFAULT_WEB_TO_MD_MAX_BYTES = 12000;
const WEB_TO_MD_BASE_DIR = "/tmp/pi-http";

const HttpToolParams = Type.Object({
	url: Type.Optional(Type.String({ description: "Request URL (required unless curlArgs contains a URL)." })),
	method: Type.Optional(Type.String({ description: "HTTP method (GET, POST, PUT, PATCH, DELETE, ...)." })),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Headers object, e.g. { Authorization: 'Bearer ...' }.",
		}),
	),
	headerLines: Type.Optional(Type.Array(Type.String({ description: "Raw header lines, e.g. 'X-Trace-Id: 123'." }))),
	query: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Query string parameters appended to the URL.",
		}),
	),
	json: Type.Optional(Type.Any({ description: "JSON body (serialized with JSON.stringify)." })),
	form: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "application/x-www-form-urlencoded fields.",
		}),
	),
	body: Type.Optional(Type.String({ description: "Raw request body string." })),
	stdin: Type.Optional(Type.String({ description: "Body content provided as stdin-like input." })),
	followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects. Default: true." })),
	includeResponseHeaders: Type.Optional(Type.Boolean({ description: "Include response headers in output. Default: true." })),
	insecure: Type.Optional(Type.Boolean({ description: "curl-compatible flag. In fetch mode this is not supported." })),
	failOnHttpError: Type.Optional(Type.Boolean({ description: "If true, returns error result metadata for HTTP >= 400." })),
	timeoutSec: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
	outputFile: Type.Optional(Type.String({ description: "Write response body to file path (relative to cwd allowed)." })),
	curlArgs: Type.Optional(
		Type.Array(Type.String({
			description: "curl-compatible arguments. Parsed as a compatibility layer (subset of curl flags).",
		})),
	),
});

const HttpMarkdownToolParams = Type.Object({
	url: Type.Optional(Type.String({ description: "Request URL (required unless curlArgs contains a URL)." })),
	method: Type.Optional(Type.String({ description: "HTTP method (GET, POST, PUT, PATCH, DELETE, ...)." })),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Headers object, e.g. { Authorization: 'Bearer ...' }.",
		}),
	),
	headerLines: Type.Optional(Type.Array(Type.String({ description: "Raw header lines, e.g. 'X-Trace-Id: 123'." }))),
	query: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Query string parameters appended to the URL.",
		}),
	),
	json: Type.Optional(Type.Any({ description: "JSON body (serialized with JSON.stringify)." })),
	form: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "application/x-www-form-urlencoded fields.",
		}),
	),
	body: Type.Optional(Type.String({ description: "Raw request body string." })),
	stdin: Type.Optional(Type.String({ description: "Body content provided as stdin-like input." })),
	followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects. Default: true." })),
	includeResponseHeaders: Type.Optional(Type.Boolean({ description: "Include response headers in output. Default: true." })),
	insecure: Type.Optional(Type.Boolean({ description: "curl-compatible flag. In fetch mode this is not supported." })),
	failOnHttpError: Type.Optional(Type.Boolean({ description: "If true, returns error result metadata for HTTP >= 400." })),
	timeoutSec: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
	webToMdMaxBytes: Type.Optional(Type.Number({ description: `Max Markdown bytes to return inline. Default: ${DEFAULT_WEB_TO_MD_MAX_BYTES}.` })),
	curlArgs: Type.Optional(
		Type.Array(Type.String({
			description: "curl-compatible arguments. Parsed as a compatibility layer (subset of curl flags).",
		})),
	),
});

type HttpBaseParamsInput = {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	headerLines?: string[];
	query?: Record<string, string>;
	json?: unknown;
	form?: Record<string, string>;
	body?: string;
	stdin?: string;
	followRedirects?: boolean;
	includeResponseHeaders?: boolean;
	insecure?: boolean;
	failOnHttpError?: boolean;
	timeoutSec?: number;
	curlArgs?: string[];
};

type HttpToolParamsInput = HttpBaseParamsInput & {
	outputFile?: string;
};

type HttpMarkdownToolParamsInput = HttpBaseParamsInput & {
	webToMdMaxBytes?: number;
};

type NormalizedRequest = {
	mode: "structured" | "curl-compat";
	url: string;
	method: string;
	headers: Headers;
	body?: string;
	followRedirects: boolean;
	includeResponseHeaders: boolean;
	failOnHttpError: boolean;
	timeoutSec?: number;
	outputFile?: string;
	warnings: string[];
	rawArgs?: string[];
};

interface HttpToolDetails {
	mode: "structured" | "curl-compat";
	method: string;
	url: string;
	statusCode?: number;
	statusText?: string;
	contentType?: string;
	redirected: boolean;
	followRedirects: boolean;
	timeoutSec?: number;
	outputFile?: string;
	warnings?: string[];
	failOnHttpError: boolean;
	httpError: boolean;
	commandLike?: string;
	curlArgs?: string[];
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

interface HttpMarkdownToolDetails extends HttpToolDetails {
	webToMdInline?: boolean;
	webToMdMaxBytes: number;
	webToMdOutputBytes?: number;
	webToMdFilePath?: string;
}

function shellQuote(arg: string): string {
	if (/^[A-Za-z0-9_./:=+\-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}

function applyQuery(url: string, query?: Record<string, string>): string {
	if (!query || Object.keys(query).length === 0) return url;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}
	for (const [key, value] of Object.entries(query)) parsed.searchParams.append(key, value);
	return parsed.toString();
}

function parseHeaderLine(line: string): { key: string; value: string } {
	const idx = line.indexOf(":");
	if (idx <= 0) throw new Error(`Invalid header line: ${line}`);
	const key = line.slice(0, idx).trim();
	const value = line.slice(idx + 1).trim();
	if (!key) throw new Error(`Invalid header line (empty header name): ${line}`);
	return { key, value };
}

function buildHeaders(objectHeaders?: Record<string, string>, headerLines?: string[]): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(objectHeaders ?? {})) headers.set(key, value);
	for (const line of headerLines ?? []) {
		if (!line.trim()) continue;
		const parsed = parseHeaderLine(line);
		headers.append(parsed.key, parsed.value);
	}
	return headers;
}

function normalizeWebToMdMaxBytes(value?: number): number {
	if (value === undefined) return DEFAULT_WEB_TO_MD_MAX_BYTES;
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("'webToMdMaxBytes' must be a finite number greater than 0.");
	}
	return Math.floor(value);
}

function shortenForDisplay(value: string, max = 80): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function extractUrlFromCurlArgs(curlArgs?: string[]): string | undefined {
	if (!curlArgs || curlArgs.length === 0) return undefined;

	for (let i = 0; i < curlArgs.length; i += 1) {
		const token = curlArgs[i] ?? "";
		if (token === "--url") {
			return curlArgs[i + 1];
		}
		if (!token.startsWith("-")) {
			return token;
		}
	}

	return undefined;
}

function buildCallSummary(input: HttpBaseParamsInput): string {
	const method = (input.method?.trim() || "GET").toUpperCase();
	const url = input.url?.trim() || extractUrlFromCurlArgs(input.curlArgs);
	if (!url) return method;
	return `${method} ${shortenForDisplay(url)}`;
}

function buildStructuredRequest(
	input: HttpBaseParamsInput & { outputFile?: string },
	cwd: string,
	options: { allowOutputFile: boolean },
): NormalizedRequest {
	if (!input.url || !input.url.trim()) {
		throw new Error("'url' is required in structured mode.");
	}

	const hasJson = input.json !== undefined;
	const hasForm = input.form !== undefined;
	const hasBody = typeof input.body === "string";
	const hasStdin = typeof input.stdin === "string";
	const bodyModes = [hasJson, hasForm, hasBody, hasStdin].filter(Boolean).length;
	if (bodyModes > 1) {
		throw new Error("Use only one of json, form, body, or stdin.");
	}

	const headers = buildHeaders(input.headers, input.headerLines);
	let body: string | undefined;

	if (hasJson) {
		body = JSON.stringify(input.json);
		if (!headers.has("content-type")) headers.set("content-type", "application/json");
	} else if (hasForm) {
		body = new URLSearchParams(input.form ?? {}).toString();
		if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
	} else if (hasBody) {
		body = input.body;
	} else if (hasStdin) {
		body = input.stdin;
	}

	const method = (input.method?.trim() || (body ? "POST" : "GET")).toUpperCase();
	const url = applyQuery(input.url, input.query);
	const outputFile = input.outputFile ? resolve(cwd, input.outputFile) : undefined;

	if (outputFile && !options.allowOutputFile) {
		throw new Error("'outputFile' is not supported by this tool.");
	}

	return {
		mode: "structured",
		url,
		method,
		headers,
		body,
		followRedirects: input.followRedirects ?? true,
		includeResponseHeaders: input.includeResponseHeaders ?? true,
		failOnHttpError: input.failOnHttpError ?? false,
		timeoutSec: input.timeoutSec,
		outputFile,
		warnings: input.insecure ? ["'insecure' is ignored in fetch mode."] : [],
	};
}

function readOptionValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
	if (index + 1 >= args.length) throw new Error(`Missing value for ${option}`);
	return { value: args[index + 1] ?? "", nextIndex: index + 1 };
}

function parseCurlCompat(
	input: HttpBaseParamsInput & { outputFile?: string },
	cwd: string,
	options: { allowOutputFile: boolean },
): NormalizedRequest {
	const args = [...(input.curlArgs ?? [])];
	if (args.length === 0) throw new Error("curlArgs is empty.");

	let url = input.url;
	let method = input.method?.toUpperCase();
	let body: string | undefined = input.stdin;
	let followRedirects = input.followRedirects ?? false;
	let includeResponseHeaders = input.includeResponseHeaders ?? false;
	let failOnHttpError = input.failOnHttpError ?? false;
	let timeoutSec = input.timeoutSec;
	let outputFile = input.outputFile ? resolve(cwd, input.outputFile) : undefined;

	const headerLines = [...(input.headerLines ?? [])];
	const warnings: string[] = [];

	for (let i = 0; i < args.length; i += 1) {
		const token = args[i] ?? "";

		if (!token.startsWith("-")) {
			if (!url) {
				url = token;
				continue;
			}
			throw new Error(`Multiple URLs are not supported in curl compatibility mode: '${token}'`);
		}

		if (token === "-X" || token === "--request") {
			const next = readOptionValue(args, i, token);
			method = next.value.toUpperCase();
			i = next.nextIndex;
			continue;
		}
		if (token.startsWith("-X") && token.length > 2) {
			method = token.slice(2).toUpperCase();
			continue;
		}
		if (token === "-H" || token === "--header") {
			const next = readOptionValue(args, i, token);
			headerLines.push(next.value);
			i = next.nextIndex;
			continue;
		}
		if (token === "-d" || token === "--data" || token === "--data-raw" || token === "--data-binary") {
			const next = readOptionValue(args, i, token);
			if (next.value === "@-") {
				body = input.stdin ?? "";
			} else {
				body = next.value;
			}
			i = next.nextIndex;
			if (!method) method = "POST";
			continue;
		}
		if (token === "-L" || token === "--location") {
			followRedirects = true;
			continue;
		}
		if (token === "-i" || token === "--include") {
			includeResponseHeaders = true;
			continue;
		}
		if (token === "--fail" || token === "--fail-with-body") {
			failOnHttpError = true;
			continue;
		}
		if (token === "-k" || token === "--insecure") {
			warnings.push("'--insecure' is ignored in fetch mode.");
			continue;
		}
		if (token === "-m" || token === "--max-time") {
			const next = readOptionValue(args, i, token);
			const parsed = Number.parseFloat(next.value);
			if (Number.isFinite(parsed) && parsed > 0) timeoutSec = parsed;
			i = next.nextIndex;
			continue;
		}
		if (token.startsWith("--max-time=")) {
			const parsed = Number.parseFloat(token.slice("--max-time=".length));
			if (Number.isFinite(parsed) && parsed > 0) timeoutSec = parsed;
			continue;
		}
		if (token === "-o" || token === "--output") {
			const next = readOptionValue(args, i, token);
			outputFile = resolve(cwd, next.value);
			i = next.nextIndex;
			continue;
		}
		if (token === "--url") {
			const next = readOptionValue(args, i, token);
			url = next.value;
			i = next.nextIndex;
			continue;
		}
		if (token === "-u" || token === "--user") {
			const next = readOptionValue(args, i, token);
			const encoded = Buffer.from(next.value, "utf8").toString("base64");
			headerLines.push(`Authorization: Basic ${encoded}`);
			i = next.nextIndex;
			continue;
		}
		if (token === "--compressed") {
			warnings.push("'--compressed' is unnecessary in fetch mode and has no effect.");
			continue;
		}
		if (token === "--no-progress-meter" || token === "-s" || token === "-S" || token === "-sS") {
			continue;
		}

		throw new Error(`Unsupported curl option in compatibility mode: ${token}`);
	}

	if (!url || !url.trim()) throw new Error("No URL provided in curlArgs mode.");
	const headers = buildHeaders(input.headers, headerLines);

	if (outputFile && !options.allowOutputFile) {
		throw new Error("'--output/-o' is not supported by this tool.");
	}

	return {
		mode: "curl-compat",
		url,
		method: (method || (body ? "POST" : "GET")).toUpperCase(),
		headers,
		body,
		followRedirects,
		includeResponseHeaders,
		failOnHttpError,
		timeoutSec,
		outputFile,
		warnings,
		rawArgs: args,
	};
}

async function ensurePandocInstalled(): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn("pandoc", ["--version"], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("http.md requires pandoc, but 'pandoc' was not found in PATH."));
				return;
			}
			reject(new Error(`Failed to run pandoc preflight check: ${err.message}`));
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			const snippet = stderr.trim().slice(0, 300);
			reject(new Error(`pandoc preflight check failed with exit code ${code}.${snippet ? ` stderr: ${snippet}` : ""}`));
		});
	});
}

async function convertHtmlToMarkdown(html: string): Promise<string> {
	return await new Promise<string>((resolvePromise, reject) => {
		const child = spawn("pandoc", ["-f", "html", "-t", "gfm"], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => {
			reject(new Error(`Failed to run pandoc conversion: ${err.message}`));
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolvePromise(stdout);
				return;
			}
			const snippet = stderr.trim().slice(0, 500);
			reject(new Error(`pandoc conversion failed with exit code ${code}.${snippet ? ` stderr: ${snippet}` : ""}`));
		});

		child.stdin.write(html, "utf8", (error) => {
			if (error) reject(new Error(`Failed to write HTML to pandoc stdin: ${error.message}`));
			child.stdin.end();
		});
	});
}

async function spillMarkdownToFile(markdown: string): Promise<{ filePath: string; bytes: number }> {
	await mkdir(WEB_TO_MD_BASE_DIR, { recursive: true });
	const dir = await mkdtemp(join(WEB_TO_MD_BASE_DIR, "web-to-md-"));
	const filePath = join(dir, "result.md");
	await writeFile(filePath, markdown, "utf8");
	return { filePath, bytes: Buffer.byteLength(markdown, "utf8") };
}

async function truncateWithSpill(content: string): Promise<{ text: string; truncation?: TruncationResult; fullOutputPath?: string }> {
	const truncation = truncateHead(content, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});

	if (!truncation.truncated) return { text: truncation.content };

	const tempDir = await mkdtemp(join(tmpdir(), "pi-http-"));
	const fullOutputPath = join(tempDir, "output.txt");
	await writeFile(fullOutputPath, content, "utf8");

	let text = truncation.content;
	text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	text += ` Full output saved to: ${fullOutputPath}]`;

	return { text, truncation, fullOutputPath };
}

function buildCommandLike(request: NormalizedRequest): string {
	const args: string[] = ["curl"];
	args.push("-X", request.method);
	request.headers.forEach((value, key) => args.push("-H", `${key}: ${value}`));
	if (request.body !== undefined) args.push("--data-raw", request.body);
	if (request.followRedirects) args.push("-L");
	if (request.includeResponseHeaders) args.push("-i");
	if (request.failOnHttpError) args.push("--fail-with-body");
	if (request.timeoutSec && request.timeoutSec > 0) args.push("--max-time", String(request.timeoutSec));
	if (request.outputFile) args.push("-o", request.outputFile);
	args.push(request.url);
	return args.map(shellQuote).join(" ");
}

function formatFetchError(error: unknown, request: NormalizedRequest, timedOut: boolean): string {
	if (timedOut) {
		return `fetch timed out after ${request.timeoutSec}s while requesting ${request.url}`;
	}

	if (error instanceof Error && error.name === "AbortError") {
		return `fetch aborted while requesting ${request.url}`;
	}

	if (!(error instanceof Error)) {
		return `fetch failed for ${request.url}: ${String(error)}`;
	}

	const details: string[] = [];
	const cause = (error as Error & { cause?: unknown }).cause;
	if (cause && typeof cause === "object") {
		const maybeCause = cause as {
			code?: unknown;
			errno?: unknown;
			syscall?: unknown;
			hostname?: unknown;
			host?: unknown;
			port?: unknown;
			message?: unknown;
		};
		if (typeof maybeCause.code === "string") details.push(`code=${maybeCause.code}`);
		if (typeof maybeCause.errno === "string" || typeof maybeCause.errno === "number") details.push(`errno=${String(maybeCause.errno)}`);
		if (typeof maybeCause.syscall === "string") details.push(`syscall=${maybeCause.syscall}`);
		if (typeof maybeCause.hostname === "string") details.push(`hostname=${maybeCause.hostname}`);
		if (typeof maybeCause.host === "string") details.push(`host=${maybeCause.host}`);
		if (typeof maybeCause.port === "number" || typeof maybeCause.port === "string") details.push(`port=${String(maybeCause.port)}`);
		if (typeof maybeCause.message === "string" && maybeCause.message.trim()) {
			details.push(`cause=${maybeCause.message.trim()}`);
		}
	}

	const base = `fetch failed for ${request.url}: ${error.message}`;
	return details.length > 0 ? `${base} (${details.join(", ")})` : base;
}

async function executeRequest(request: NormalizedRequest, signal?: AbortSignal): Promise<{
	statusCode: number;
	statusText: string;
	contentType?: string;
	redirected: boolean;
	responseHeadersText: string;
	responseBuffer: Buffer;
}> {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	let timedOut = false;
	if (request.timeoutSec && request.timeoutSec > 0) {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, Math.ceil(request.timeoutSec * 1000));
	}

	try {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			redirect: request.followRedirects ? "follow" : "manual",
			signal: controller.signal,
		});

		const responseBuffer = Buffer.from(await response.arrayBuffer());
		if (request.outputFile) {
			await writeFile(request.outputFile, responseBuffer);
		}

		const headersText = [...response.headers.entries()]
			.map(([k, v]) => `${k}: ${v}`)
			.join("\n");

		return {
			statusCode: response.status,
			statusText: response.statusText,
			contentType: response.headers.get("content-type") ?? undefined,
			redirected: response.redirected,
			responseHeadersText: headersText,
			responseBuffer,
		};
	} catch (error) {
		throw new Error(formatFetchError(error, request, timedOut));
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (timeout) clearTimeout(timeout);
	}
}

function normalizeRequest(
	input: HttpBaseParamsInput & { outputFile?: string },
	cwd: string,
	options: { allowOutputFile: boolean },
): NormalizedRequest {
	return Array.isArray(input.curlArgs) && input.curlArgs.length > 0
		? parseCurlCompat(input, cwd, options)
		: buildStructuredRequest(input, cwd, options);
}

async function executeHttpTool(input: HttpToolParamsInput, cwd: string, signal?: AbortSignal) {
	const request = normalizeRequest(input, cwd, { allowOutputFile: true });
	const result = await executeRequest(request, signal);
	const httpError = result.statusCode >= 400;

	let output = `HTTP ${result.statusCode}${result.statusText ? ` ${result.statusText}` : ""}`;
	if (result.contentType) output += ` | ${result.contentType}`;
	if (result.redirected) output += " | redirected";
	output += "\n";

	if (request.includeResponseHeaders && result.responseHeadersText) {
		output += `\n${result.responseHeadersText}\n`;
	}

	const bodyText = request.outputFile
		? `(response body written to ${request.outputFile})`
		: result.responseBuffer.toString("utf8");
	output += `\n${bodyText}`;

	if (request.warnings.length > 0) {
		output += `\n\n[warnings]\n${request.warnings.map((w) => `- ${w}`).join("\n")}`;
	}

	if (request.failOnHttpError && httpError) {
		output += "\n\n[failOnHttpError enabled: request returned HTTP error status]";
	}

	const truncated = await truncateWithSpill(output);
	const details: HttpToolDetails = {
		mode: request.mode,
		method: request.method,
		url: request.url,
		statusCode: result.statusCode,
		statusText: result.statusText,
		contentType: result.contentType,
		redirected: result.redirected,
		followRedirects: request.followRedirects,
		timeoutSec: request.timeoutSec,
		outputFile: request.outputFile,
		warnings: request.warnings.length > 0 ? request.warnings : undefined,
		failOnHttpError: request.failOnHttpError,
		httpError,
		commandLike: buildCommandLike(request),
		curlArgs: request.rawArgs,
		truncation: truncated.truncation,
		fullOutputPath: truncated.fullOutputPath,
	};

	return {
		content: [{ type: "text" as const, text: truncated.text }],
		details,
	};
}

async function executeHttpMarkdownTool(input: HttpMarkdownToolParamsInput, cwd: string, signal?: AbortSignal) {
	const request = normalizeRequest(input, cwd, { allowOutputFile: false });
	const webToMdMaxBytes = normalizeWebToMdMaxBytes(input.webToMdMaxBytes);
	await ensurePandocInstalled();

	const result = await executeRequest(request, signal);
	const httpError = result.statusCode >= 400;

	let output = `HTTP ${result.statusCode}${result.statusText ? ` ${result.statusText}` : ""}`;
	if (result.contentType) output += ` | ${result.contentType}`;
	if (result.redirected) output += " | redirected";
	output += "\n";

	if (request.includeResponseHeaders && result.responseHeadersText) {
		output += `\n${result.responseHeadersText}\n`;
	}

	const html = result.responseBuffer.toString("utf8");
	const markdown = await convertHtmlToMarkdown(html);
	const webToMdOutputBytes = Buffer.byteLength(markdown, "utf8");

	let webToMdInline: boolean;
	let webToMdFilePath: string | undefined;
	if (webToMdOutputBytes <= webToMdMaxBytes) {
		webToMdInline = true;
		output += `\n${markdown}`;
	} else {
		webToMdInline = false;
		const spilled = await spillMarkdownToFile(markdown);
		webToMdFilePath = spilled.filePath;
		output += `\n[webToMd output saved to ${spilled.filePath} (${spilled.bytes} bytes)]`;
	}

	if (request.warnings.length > 0) {
		output += `\n\n[warnings]\n${request.warnings.map((w) => `- ${w}`).join("\n")}`;
	}

	if (request.failOnHttpError && httpError) {
		output += "\n\n[failOnHttpError enabled: request returned HTTP error status]";
	}

	const truncated = await truncateWithSpill(output);
	const details: HttpMarkdownToolDetails = {
		mode: request.mode,
		method: request.method,
		url: request.url,
		statusCode: result.statusCode,
		statusText: result.statusText,
		contentType: result.contentType,
		redirected: result.redirected,
		followRedirects: request.followRedirects,
		timeoutSec: request.timeoutSec,
		warnings: request.warnings.length > 0 ? request.warnings : undefined,
		failOnHttpError: request.failOnHttpError,
		httpError,
		commandLike: buildCommandLike(request),
		curlArgs: request.rawArgs,
		truncation: truncated.truncation,
		fullOutputPath: truncated.fullOutputPath,
		webToMdInline,
		webToMdMaxBytes,
		webToMdOutputBytes,
		webToMdFilePath,
	};

	return {
		content: [{ type: "text" as const, text: truncated.text }],
		details,
	};
}

export default function httpExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "http",
		label: "HTTP",
		description:
			"HTTP client using Node's native fetch API. Supports HTTPie-like structured fields and a curl-compat argument mode (subset).",
		promptSnippet: "Make HTTP requests using structured fields or curl-compatible args.",
		promptGuidelines: [
			"Use this tool for HTTP requests instead of spawning shell curl commands.",
			"Use headers/headerLines to pass arbitrary custom headers.",
			"Use curlArgs for curl-style requests (unsupported curl flags will return an explicit error).",
		],
		parameters: HttpToolParams,
		renderCall(args, theme) {
			const input = args as HttpToolParamsInput;
			const summary = buildCallSummary(input);
			let text = theme.fg("toolTitle", `${theme.bold("http")} `);
			text += theme.fg("muted", summary);
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await executeHttpTool(params as HttpToolParamsInput, ctx.cwd, signal);
		},
	});

	pi.registerTool({
		name: "http.md",
		label: "HTTP Markdown",
		description:
			"Fetch a web page and convert HTML to Markdown using pandoc. Supports structured request fields and curl-compatible args.",
		promptSnippet: "Fetch webpage content and convert it to Markdown.",
		promptGuidelines: [
			"Use this tool when webpage-to-Markdown output is needed.",
			"Use headers/headerLines to pass arbitrary custom headers.",
			"Use curlArgs for curl-style requests (unsupported curl flags will return an explicit error).",
		],
		parameters: HttpMarkdownToolParams,
		renderCall(args, theme) {
			const input = args as HttpMarkdownToolParamsInput;
			const summary = buildCallSummary(input);
			let text = theme.fg("toolTitle", `${theme.bold("http.md")} `);
			text += theme.fg("muted", summary);
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await executeHttpMarkdownTool(params as HttpMarkdownToolParamsInput, ctx.cwd, signal);
		},
	});
}
