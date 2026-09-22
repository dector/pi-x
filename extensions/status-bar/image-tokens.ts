// Image token estimation for the status-bar's unsent-message size label.
//
// DeepSeek publishes the exact resize + token algorithm behind its image token
// calculator. We port it here (model `v41`: patch 14, downsample 3, 1024-token
// cap, 544x544 upscale floor) so a pasted image contributes a realistic number
// instead of only the few tokens of its file-path text.
//
// It is a first estimate for every model: other providers use different image
// tokenizers, and DeepSeek itself calls the result approximate. The parser reads
// only file headers, so it stays synchronous and cheap enough to run on render.

export interface ImageDimensions {
	width: number;
	height: number;
}

// DeepSeek v41 calculator constants (see `deepseekImageTokens`).
const PATCH_SIZE = 14;
const DOWNSAMPLE_RATIO = 3;
const MAX_TOKENS = 1024;
const MIN_PIXELS = 544 * 544; // 295936

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;
// Quoted paths first (drag-and-drop may quote paths with spaces), then bare
// whitespace-delimited tokens.
const IMAGE_PATH_TOKEN = /"([^"]+)"|'([^']+)'|(\S+)/g;

/**
 * Collect image file paths mentioned in editor text. A pasted image is inserted
 * as its file path, so this is how images show up before the message is sent.
 * URLs are ignored (they are not local files and cannot be measured here).
 */
export function findImagePaths(text: string): string[] {
	const paths = new Set<string>();
	for (const match of text.matchAll(IMAGE_PATH_TOKEN)) {
		let token = match[1] ?? match[2] ?? match[3] ?? "";
		token = token.replace(/[),.;:!?]+$/, "");
		if (token.startsWith("@")) token = token.slice(1);
		if (!IMAGE_EXTENSION.test(token)) continue;
		if (token.includes("://")) continue;
		paths.add(token);
	}
	return [...paths];
}

function u16be(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset]! << 8) | bytes[offset + 1]!) >>> 0;
}

function u32be(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
	);
}

function u16le(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8)) >>> 0;
}

function u24le(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) >>> 0;
}

function positive(width: number, height: number): ImageDimensions | undefined {
	return width > 0 && height > 0 ? { width, height } : undefined;
}

function parsePng(bytes: Uint8Array): ImageDimensions | undefined {
	if (bytes.length < 24) return undefined;
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (!signature.every((byte, index) => bytes[index] === byte)) return undefined;
	return positive(u32be(bytes, 16), u32be(bytes, 20));
}

function parseGif(bytes: Uint8Array): ImageDimensions | undefined {
	if (bytes.length < 10) return undefined;
	const signature = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
	if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
	return positive(u16le(bytes, 6), u16le(bytes, 8));
}

function parseJpeg(bytes: Uint8Array): ImageDimensions | undefined {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		let marker = bytes[offset + 1]!;
		while (marker === 0xff && offset + 2 < bytes.length) {
			offset += 1;
			marker = bytes[offset + 1]!;
		}
		// Standalone markers carry no length payload.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		// Start of scan (or end of image) before any frame header: give up.
		if (marker === 0xda || marker === 0xd9) return undefined;
		const length = u16be(bytes, offset + 2);
		if (length < 2) return undefined;
		const isFrameHeader =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isFrameHeader) {
			if (offset + 9 >= bytes.length) return undefined;
			return positive(u16be(bytes, offset + 7), u16be(bytes, offset + 5));
		}
		offset += 2 + length;
	}
	return undefined;
}

function parseWebp(bytes: Uint8Array): ImageDimensions | undefined {
	if (bytes.length < 25) return undefined;
	if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== "RIFF") return undefined;
	if (String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) !== "WEBP") return undefined;
	const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
	if (chunk === "VP8X") {
		if (bytes.length < 30) return undefined;
		return positive(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
	}
	if (chunk === "VP8L") {
		if (bytes[20] !== 0x2f) return undefined;
		const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
		return positive((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
	}
	if (chunk === "VP8 ") {
		if (bytes.length < 30) return undefined;
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
		return positive(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
	}
	return undefined;
}

/**
 * Read PNG/JPEG/GIF/WebP dimensions from the leading bytes of a file. Returns
 * undefined for unsupported, truncated, or malformed input.
 */
export function parseImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
	return parsePng(bytes) ?? parseGif(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes);
}

const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

// Ported from DeepSeek's image token calculator. `nLlmH`/`nLlmW` are the tiled
// grid dimensions after the model's internal downsample.
function calcNumTokens(nLlmH: number, nLlmW: number): number {
	return nLlmH * (nLlmW + 1) + 2;
}

function solveResizeRatio(
	originalHeight: number,
	originalWidth: number,
	limit: number,
): { nLlmH: number; nLlmW: number; bestHeight: number; bestWidth: number; numTokens: number } {
	const ratio = originalHeight / originalWidth;
	const first = Math.sqrt((limit - 2) / ratio + 0.25) - 0.5;
	const second = first * ratio;
	let bestHeight: number;
	let bestWidth: number;
	if (first < 1) {
		const t = floorDiv(limit - 2, 2);
		bestWidth = PATCH_SIZE * DOWNSAMPLE_RATIO;
		bestHeight = t * PATCH_SIZE * DOWNSAMPLE_RATIO;
	} else if (second < 1) {
		const t = floorDiv(limit - 2, 1) - 1;
		if (!(t > 1)) throw new Error("deepseek image calculator: max_w > 1 assertion failed");
		bestWidth = t * PATCH_SIZE * DOWNSAMPLE_RATIO;
		bestHeight = PATCH_SIZE * DOWNSAMPLE_RATIO;
	} else {
		const scaleH = (Math.trunc(first) * PATCH_SIZE * DOWNSAMPLE_RATIO) / originalWidth;
		const scaleW = (Math.trunc(second) * PATCH_SIZE * DOWNSAMPLE_RATIO) / originalHeight;
		const scale = Math.min(scaleH, scaleW);
		bestWidth = Math.trunc((originalWidth * scale) / PATCH_SIZE) * PATCH_SIZE;
		bestHeight = Math.trunc((originalHeight * scale) / PATCH_SIZE) * PATCH_SIZE;
	}
	const nLlmH = ceilDiv(floorDiv(bestHeight, PATCH_SIZE), DOWNSAMPLE_RATIO);
	const nLlmW = ceilDiv(floorDiv(bestWidth, PATCH_SIZE), DOWNSAMPLE_RATIO);
	return { nLlmH, nLlmW, bestHeight, bestWidth, numTokens: calcNumTokens(nLlmH, nLlmW) };
}

interface ResizeResult {
	nLlmH: number;
	nLlmW: number;
	bestHeight: number;
	bestWidth: number;
	numTokens: number;
}

function safeResize(
	originalHeight: number,
	originalWidth: number,
	bestHeight: number,
	bestWidth: number,
): ResizeResult {
	const nLlmH = ceilDiv(floorDiv(bestHeight, PATCH_SIZE), DOWNSAMPLE_RATIO);
	const nLlmW = ceilDiv(floorDiv(bestWidth, PATCH_SIZE), DOWNSAMPLE_RATIO);
	const result: ResizeResult = { nLlmH, nLlmW, bestHeight, bestWidth, numTokens: calcNumTokens(nLlmH, nLlmW) };
	if (result.numTokens <= MAX_TOKENS) return result;
	const resized = solveResizeRatio(originalHeight, originalWidth, MAX_TOKENS);
	if (resized.numTokens > MAX_TOKENS) throw new Error("deepseek image calculator: token cap exceeded");
	return resized;
}

function calcResizeInner(width: number, height: number): ResizeResult {
	let scaledWidth = width;
	let scaledHeight = height;
	const pixels = scaledWidth * scaledHeight;
	if (pixels > 0 && pixels < MIN_PIXELS) {
		const scale = Math.sqrt(MIN_PIXELS / pixels);
		scaledWidth = Math.trunc(scaledWidth * scale);
		scaledHeight = Math.trunc(scaledHeight * scale);
	}
	const bestWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE;
	const bestHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE;
	return safeResize(scaledHeight, scaledWidth, bestHeight, bestWidth);
}

function sameResize(a: ResizeResult, b: ResizeResult): boolean {
	return (
		a.nLlmH === b.nLlmH &&
		a.nLlmW === b.nLlmW &&
		a.bestHeight === b.bestHeight &&
		a.bestWidth === b.bestWidth &&
		a.numTokens === b.numTokens
	);
}

/**
 * Estimate DeepSeek vision tokens for an image of the given pixel dimensions.
 * Matches DeepSeek's published resize rules (upscale below ~544x544, downscale
 * to ~1300x1300, 1024-token cap). Returns 0 for invalid dimensions.
 */
export function deepseekImageTokens(width: number, height: number): number {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
	let result = calcResizeInner(width, height);
	for (let i = 1; i < 10; i++) {
		const next = calcResizeInner(result.bestWidth, result.bestHeight);
		if (sameResize(next, result)) return result.numTokens;
		result = next;
	}
	return result.numTokens;
}
