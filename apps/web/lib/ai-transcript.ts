export interface VttSegment {
	start: number;
	text: string;
}

export interface Chapter {
	title: string;
	start: number;
}

const MIN_CHAPTER_GAP_SECONDS = 30;

export function parseVttWithTimestamps(vttContent: string): VttSegment[] {
	const lines = vttContent.split("\n");
	const segments: VttSegment[] = [];
	let currentStart = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.includes("-->")) {
			const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
			if (timeMatch) {
				currentStart =
					parseInt(timeMatch[1] ?? "0", 10) * 3600 +
					parseInt(timeMatch[2] ?? "0", 10) * 60 +
					parseInt(timeMatch[3] ?? "0", 10);
			}
		} else if (line && line !== "WEBVTT" && !/^\d+$/.test(line)) {
			segments.push({ start: currentStart, text: line });
		}
	}

	return segments;
}

export function formatTimestampLabel(seconds: number): string {
	const safe =
		Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const minutes = Math.floor(safe / 60);
	const remainder = safe % 60;
	return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function formatTranscriptWithTimestamps(segments: VttSegment[]): string {
	return segments
		.map(
			(segment) => `[${formatTimestampLabel(segment.start)}] ${segment.text}`,
		)
		.join("\n");
}

function parseStartSeconds(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
	}
	if (typeof value !== "string") return null;

	const trimmed = value.trim();
	if (trimmed === "") return null;

	if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.floor(Number(trimmed));

	const parts = trimmed.split(":");
	if (parts.length < 2 || parts.length > 3) return null;

	let total = 0;
	for (const part of parts) {
		if (!/^\d+(\.\d+)?$/.test(part)) return null;
		total = total * 60 + Number(part);
	}
	return Math.floor(total);
}

export function sanitizeChapters(
	chapters: unknown,
	maxTimeSeconds: number | null | undefined,
): Chapter[] {
	if (!Array.isArray(chapters)) return [];

	const limit =
		typeof maxTimeSeconds === "number" &&
		Number.isFinite(maxTimeSeconds) &&
		maxTimeSeconds > 0
			? maxTimeSeconds
			: null;

	const valid: Chapter[] = [];
	for (const entry of chapters) {
		if (!entry || typeof entry !== "object") continue;

		const { title, start } = entry as { title?: unknown; start?: unknown };
		if (typeof title !== "string" || title.trim() === "") continue;

		const startSeconds = parseStartSeconds(start);
		if (startSeconds === null) continue;
		if (limit !== null && startSeconds > limit) continue;

		valid.push({ title: title.trim(), start: startSeconds });
	}

	valid.sort((a, b) => a.start - b.start);

	const deduped: Chapter[] = [];
	for (const chapter of valid) {
		const previous = deduped[deduped.length - 1];
		if (
			!previous ||
			chapter.start - previous.start >= MIN_CHAPTER_GAP_SECONDS
		) {
			deduped.push(chapter);
		}
	}

	return deduped;
}
