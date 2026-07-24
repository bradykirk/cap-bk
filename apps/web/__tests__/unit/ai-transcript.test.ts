import { describe, expect, it } from "vitest";
import {
	formatTranscriptWithTimestamps,
	parseVttWithTimestamps,
	sanitizeChapters,
} from "@/lib/ai-transcript";

const SAMPLE_VTT = `WEBVTT

1
00:00:00.080 --> 00:00:04.320
Welcome everyone to the dealer update call.

2
00:01:12.000 --> 00:01:18.500
Next up is how you update your store information.

3
00:03:31.250 --> 00:03:39.000
Thanks for listening, send us your feedback.
`;

describe("parseVttWithTimestamps", () => {
	it("keeps the cue start time with each caption line", () => {
		expect(parseVttWithTimestamps(SAMPLE_VTT)).toEqual([
			{ start: 0, text: "Welcome everyone to the dealer update call." },
			{
				start: 72,
				text: "Next up is how you update your store information.",
			},
			{ start: 211, text: "Thanks for listening, send us your feedback." },
		]);
	});

	it("returns nothing for an empty transcript", () => {
		expect(parseVttWithTimestamps("WEBVTT\n\n")).toEqual([]);
	});
});

describe("formatTranscriptWithTimestamps", () => {
	it("prefixes every line with its timestamp so the model can cite it", () => {
		const segments = parseVttWithTimestamps(SAMPLE_VTT);

		expect(formatTranscriptWithTimestamps(segments)).toBe(
			[
				"[00:00] Welcome everyone to the dealer update call.",
				"[01:12] Next up is how you update your store information.",
				"[03:31] Thanks for listening, send us your feedback.",
			].join("\n"),
		);
	});

	it("formats past an hour without wrapping", () => {
		expect(
			formatTranscriptWithTimestamps([{ start: 3725, text: "later" }]),
		).toBe("[62:05] later");
	});
});

describe("sanitizeChapters", () => {
	it("drops chapters that start after the video ends", () => {
		const chapters = [
			{ title: "Introduction and Community Importance", start: 0 },
			{ title: "Updating Store Information", start: 100 },
			{ title: "Communication Strategy", start: 180 },
			{ title: "Custom Channels for Dealer Support", start: 300 },
			{ title: "Manufacturer Partnerships", start: 420 },
			{ title: "Feedback Mechanism and Future Outlook", start: 520 },
		];

		expect(sanitizeChapters(chapters, 230)).toEqual([
			{ title: "Introduction and Community Importance", start: 0 },
			{ title: "Updating Store Information", start: 100 },
			{ title: "Communication Strategy", start: 180 },
		]);
	});

	it("keeps a chapter landing exactly on the final timestamp", () => {
		expect(sanitizeChapters([{ title: "Wrap up", start: 230 }], 230)).toEqual([
			{ title: "Wrap up", start: 230 },
		]);
	});

	it("sorts and drops chapters closer than 30 seconds apart", () => {
		expect(
			sanitizeChapters(
				[
					{ title: "Third", start: 200 },
					{ title: "First", start: 0 },
					{ title: "Near duplicate", start: 10 },
					{ title: "Second", start: 100 },
				],
				600,
			),
		).toEqual([
			{ title: "First", start: 0 },
			{ title: "Second", start: 100 },
			{ title: "Third", start: 200 },
		]);
	});

	it("parses timestamp strings the model returns instead of numbers", () => {
		expect(
			sanitizeChapters(
				[
					{ title: "Intro", start: "00:00" },
					{ title: "Middle", start: "01:40" },
					{ title: "Late", start: "1:02:05" },
				],
				600,
			),
		).toEqual([
			{ title: "Intro", start: 0 },
			{ title: "Middle", start: 100 },
		]);
	});

	it("discards malformed entries", () => {
		expect(
			sanitizeChapters(
				[
					null,
					"nonsense",
					{ title: "No start" },
					{ title: "Negative", start: -5 },
					{ title: "", start: 10 },
					{ title: "Not a number", start: "soon" },
					{ title: "Valid", start: 20 },
				],
				600,
			),
		).toEqual([{ title: "Valid", start: 20 }]);
	});

	it("skips the range filter when the duration is unknown", () => {
		expect(sanitizeChapters([{ title: "Intro", start: 500 }], null)).toEqual([
			{ title: "Intro", start: 500 },
		]);
	});

	it("returns an empty list for non-array input", () => {
		expect(sanitizeChapters(undefined, 230)).toEqual([]);
	});
});
