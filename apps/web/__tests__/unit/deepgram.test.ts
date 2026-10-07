import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEEPGRAM_NO_SPOKEN_AUDIO_MESSAGE,
	deepgramToEditResult,
	getDeepgramListenParams,
	transcribeWithDeepgram,
} from "@/lib/deepgram";
import {
	createEditTranscript,
	editTranscriptWordsToCaptionVtt,
} from "@/lib/edit-transcript";

const RESPONSE = {
	metadata: { request_id: "req-1", duration: 4.2 },
	results: {
		channels: [
			{
				detected_language: "en",
				alternatives: [
					{
						words: [
							{
								word: "hello",
								punctuated_word: "Hello,",
								start: 0.08,
								end: 0.52,
								confidence: 0.98,
							},
							{ word: "world", start: 0.6, end: 1.1, confidence: 0.9 },
							{ word: "", start: 1.2, end: 1.3 },
							{ word: "broken", start: "x", end: 1.4 },
						],
					},
				],
			},
		],
	},
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("getDeepgramListenParams", () => {
	it("asks Deepgram to detect the language in auto mode", () => {
		const params = getDeepgramListenParams("auto");
		expect(params.get("model")).toBe("nova-3");
		expect(params.get("detect_language")).toBe("true");
		expect(params.get("filler_words")).toBe("true");
		expect(params.has("language")).toBe(false);
	});

	it("passes an explicit language code through", () => {
		const params = getDeepgramListenParams("es");
		expect(params.get("language")).toBe("es");
		expect(params.has("detect_language")).toBe(false);
	});
});

describe("deepgramToEditResult", () => {
	it("converts second timestamps to milliseconds and prefers punctuated words", () => {
		const result = deepgramToEditResult(RESPONSE);
		expect(result.words).toEqual([
			{ text: "Hello,", start: 80, end: 520, confidence: 0.98 },
			{ text: "world", start: 600, end: 1100, confidence: 0.9 },
		]);
		expect(result.language_code).toBe("en");
		expect(result.audioDurationSeconds).toBe(4.2);
		expect(result.requestId).toBe("req-1");
	});

	it("returns no words for an empty response", () => {
		expect(deepgramToEditResult({}).words).toEqual([]);
	});

	it("feeds the shared edit transcript and caption pipeline", () => {
		const editTranscript = createEditTranscript(
			deepgramToEditResult(RESPONSE),
			4200,
		);
		expect(editTranscript.words.map((word) => word.text)).toEqual([
			"Hello,",
			"world",
		]);
		const vtt = editTranscriptWordsToCaptionVtt(editTranscript.words);
		expect(vtt.startsWith("WEBVTT")).toBe(true);
		expect(vtt).toContain("00:00:00.080 -->");
		expect(vtt).toContain("world");
	});
});

describe("transcribeWithDeepgram", () => {
	it("posts the audio with the API key and returns the converted transcript", async () => {
		const fetchMock = vi.fn(async () => Response.json(RESPONSE));
		vi.stubGlobal("fetch", fetchMock);

		const result = await transcribeWithDeepgram(
			Buffer.from("audio"),
			"auto",
			"dg-key",
		);

		expect(result.words).toHaveLength(2);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toContain("https://api.deepgram.com/v1/listen?");
		expect(url).toContain("model=nova-3");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Token dg-key",
		);
	});

	it("reports no spoken audio when Deepgram returns no words", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ metadata: { request_id: "r" } })),
		);

		await expect(
			transcribeWithDeepgram(Buffer.from("audio"), "auto", "dg-key"),
		).rejects.toThrow(DEEPGRAM_NO_SPOKEN_AUDIO_MESSAGE);
	});

	it("includes the HTTP status when Deepgram rejects the request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("bad key", { status: 401, statusText: "Unauthorized" }),
			),
		);

		await expect(
			transcribeWithDeepgram(Buffer.from("audio"), "auto", "dg-key"),
		).rejects.toThrow("Deepgram transcription failed: 401 Unauthorized bad key");
	});
});
