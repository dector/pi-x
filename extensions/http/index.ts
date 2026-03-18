import { mkdtemp, writeFile } from "node:fs/promises";
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

type HttpToolParamsInput = {
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
	outputFile?: string;
	curlArgs?: string[];
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

function buildStructuredRequest(input: HttpToolParamsInput, cwd: string): NormalizedRequest {
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
		outputFile: input.outputFile ? resolve(cwd, input.outputFile) : undefined,
		warnings: input.insecure ? ["'insecure' is ignored in fetch mode."] : [],
	};
}

function readOptionValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
	if (index + 1 >= args.length) throw new Error(`Missing value for ${option}`);
	return { value: args[index + 1] ?? "", nextIndex: index + 1 };
}

function parseCurlCompat(input: HttpToolParamsInput, cwd: string): NormalizedRequest {
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

async function executeRequest(request: NormalizedRequest, signal?: AbortSignal): Promise<{
	statusCode: number;
	statusText: string;
	contentType?: string;
	redirected: boolean;
	responseHeadersText: string;
	bodyText: string;
}> {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	if (request.timeoutSec && request.timeoutSec > 0) {
		timeout = setTimeout(() => controller.abort(), Math.ceil(request.timeoutSec * 1000));
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
		const bodyText = request.outputFile
			? `(response body written to ${request.outputFile})`
			: responseBuffer.toString("utf8");

		return {
			statusCode: response.status,
			statusText: response.statusText,
			contentType: response.headers.get("content-type") ?? undefined,
			redirected: response.redirected,
			responseHeadersText: headersText,
			bodyText,
		};
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (timeout) clearTimeout(timeout);
	}
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as HttpToolParamsInput;
			const request = Array.isArray(input.curlArgs) && input.curlArgs.length > 0
				? parseCurlCompat(input, ctx.cwd)
				: buildStructuredRequest(input, ctx.cwd);

			const result = await executeRequest(request, signal);
			const httpError = result.statusCode >= 400;

			let output = `HTTP ${result.statusCode}${result.statusText ? ` ${result.statusText}` : ""}`;
			if (result.contentType) output += ` | ${result.contentType}`;
			if (result.redirected) output += " | redirected";
			output += "\n";

			if (request.includeResponseHeaders && result.responseHeadersText) {
				output += `\n${result.responseHeadersText}\n`;
			}

			output += `\n${result.bodyText}`;

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
				content: [{ type: "text", text: truncated.text }],
				details,
			};
		},
	});
}
