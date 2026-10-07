import { describe, expect, it } from "vitest";
import { sanitizeChapters } from "@/lib/ai-transcript";

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

	it("sorts chapters and keeps owner edits that sit close together", () => {
		expect(
			sanitizeChapters(
				[
					{ title: "Third", start: 200 },
					{ title: "First", start: 0 },
					{ title: "Close edit", start: 10.5 },
					{ title: "Second", start: 100 },
				],
				600,
			),
		).toEqual([
			{ title: "First", start: 0 },
			{ title: "Close edit", start: 10.5 },
			{ title: "Second", start: 100 },
			{ title: "Third", start: 200 },
		]);
	});

	it("drops chapters that repeat an earlier start time", () => {
		expect(
			sanitizeChapters(
				[
					{ title: "Intro", start: 0 },
					{ title: "Duplicate", start: 0 },
					{ title: "Body", start: 60 },
				],
				600,
			),
		).toEqual([
			{ title: "Intro", start: 0 },
			{ title: "Body", start: 60 },
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
