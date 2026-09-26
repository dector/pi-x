import { describe, expect, test } from "bun:test";
import { deepseekImageTokens, findImagePaths, parseImageDimensions } from "./image-tokens.ts";

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const u16be = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u24le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const bytes = (...parts: Array<number[] | number>): Uint8Array => Uint8Array.from(parts.flat());

const PNG_100x50 = bytes(
	[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	u32be(13),
	ascii("IHDR"),
	u32be(100),
	u32be(50),
	[8, 6, 0, 0, 0],
);

const GIF_100x50 = bytes(ascii("GIF89a"), u16le(100), u16le(50));

const JPEG_100x50 = bytes(
	[0xff, 0xd8],
	[0xff, 0xe0],
	u16be(16),
	new Array(14).fill(0),
	[0xff, 0xc0],
	u16be(17),
	[0x08],
	u16be(50),
	u16be(100),
	[0x03],
);

const WEBP_VP8X_100x50 = bytes(
	ascii("RIFF"),
	u32le(30),
	ascii("WEBP"),
	ascii("VP8X"),
	u32le(10),
	[0, 0, 0, 0],
	u24le(99),
	u24le(49),
);

const WEBP_VP8L_100x50 = bytes(
	ascii("RIFF"),
	u32le(25),
	ascii("WEBP"),
	ascii("VP8L"),
	u32le(5),
	[0x2f],
	u32le((49 << 14) | 99),
);

const WEBP_VP8_100x50 = bytes(
	ascii("RIFF"),
	u32le(30),
	ascii("WEBP"),
	ascii("VP8 "),
	u32le(10),
	[0, 0, 0],
	[0x9d, 0x01, 0x2a],
	u16le(100),
	u16le(50),
);

describe("parseImageDimensions", () => {
	test("reads PNG, GIF, JPEG, and all three WebP layouts", () => {
		expect(parseImageDimensions(PNG_100x50)).toEqual({ width: 100, height: 50 });
		expect(parseImageDimensions(GIF_100x50)).toEqual({ width: 100, height: 50 });
		expect(parseImageDimensions(JPEG_100x50)).toEqual({ width: 100, height: 50 });
		expect(parseImageDimensions(WEBP_VP8X_100x50)).toEqual({ width: 100, height: 50 });
		expect(parseImageDimensions(WEBP_VP8L_100x50)).toEqual({ width: 100, height: 50 });
		expect(parseImageDimensions(WEBP_VP8_100x50)).toEqual({ width: 100, height: 50 });
	});

	test("returns undefined for unknown or truncated input", () => {
		expect(parseImageDimensions(new Uint8Array(0))).toBeUndefined();
		expect(parseImageDimensions(bytes(ascii("not an image")))).toBeUndefined();
		expect(parseImageDimensions(PNG_100x50.subarray(0, 12))).toBeUndefined();
	});
});

describe("findImagePaths", () => {
	test("extracts bare and @-prefixed paths and dedupes", () => {
		expect(findImagePaths("look at /tmp/a.png and @/tmp/b.jpg and /tmp/a.png")).toEqual([
			"/tmp/a.png",
			"/tmp/b.jpg",
		]);
	});

	test("handles quoted paths with spaces and strips trailing punctuation", () => {
		expect(findImagePaths('"/tmp/my pic.webp"')).toEqual(["/tmp/my pic.webp"]);
		expect(findImagePaths("(see /tmp/d.png).")).toEqual(["/tmp/d.png"]);
	});

	test("ignores non-images and remote URLs", () => {
		expect(findImagePaths("notes.txt and https://x.com/a.png")).toEqual([]);
	});
});

describe("deepseekImageTokens", () => {
	test("caps large images at the same value regardless of size", () => {
		expect(deepseekImageTokens(2000, 2000)).toBe(994);
		expect(deepseekImageTokens(5000, 5000)).toBe(994);
		expect(deepseekImageTokens(8192, 8192)).toBe(994);
	});

	test("upscales small images to the same floor", () => {
		expect(deepseekImageTokens(1, 1)).toBe(184);
		expect(deepseekImageTokens(100, 100)).toBe(184);
		expect(deepseekImageTokens(384, 384)).toBe(184);
	});

	test("scales with aspect ratio and area", () => {
		expect(deepseekImageTokens(1920, 1080)).toBe(968);
		expect(deepseekImageTokens(800, 800)).toBe(422);
		expect(deepseekImageTokens(1000, 500)).toBe(302);
		expect(deepseekImageTokens(500, 1000)).toBe(314);
	});

	test("returns 0 for invalid dimensions", () => {
		expect(deepseekImageTokens(0, 100)).toBe(0);
		expect(deepseekImageTokens(-5, 100)).toBe(0);
		expect(deepseekImageTokens(Number.NaN, 100)).toBe(0);
	});
});
