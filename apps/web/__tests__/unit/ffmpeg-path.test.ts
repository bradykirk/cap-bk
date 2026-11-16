import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STATIC_PATH = "/app/node_modules/ffmpeg-static/ffmpeg";
const SYSTEM_PATH = "/usr/bin/ffmpeg";

vi.mock("ffmpeg-static", () => ({
	default: STATIC_PATH,
}));

let existingPaths = new Set<string>();

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: string) => existingPaths.has(path),
	};
});

describe("getFfmpegPath", () => {
	const originalFfmpegPath = process.env.FFMPEG_PATH;

	beforeEach(() => {
		vi.resetModules();
		existingPaths = new Set([STATIC_PATH, SYSTEM_PATH]);
		delete process.env.FFMPEG_PATH;
	});

	afterEach(() => {
		if (originalFfmpegPath === undefined) {
			delete process.env.FFMPEG_PATH;
		} else {
			process.env.FFMPEG_PATH = originalFfmpegPath;
		}
	});

	it("prefers FFMPEG_PATH over the ffmpeg-static binary", async () => {
		process.env.FFMPEG_PATH = SYSTEM_PATH;
		const { getFfmpegPath } = await import("@/lib/audio-extract");

		expect(getFfmpegPath()).toBe(SYSTEM_PATH);
	});

	it("uses the ffmpeg-static binary when FFMPEG_PATH is not set", async () => {
		const { getFfmpegPath } = await import("@/lib/audio-extract");

		expect(getFfmpegPath()).toBe(STATIC_PATH);
	});

	it("skips FFMPEG_PATH when that file does not exist", async () => {
		process.env.FFMPEG_PATH = "/missing/ffmpeg";
		const { getFfmpegPath } = await import("@/lib/audio-extract");

		expect(getFfmpegPath()).toBe(STATIC_PATH);
	});
});
