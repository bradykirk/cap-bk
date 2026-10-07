export interface Chapter {
	title: string;
	start: number;
}

function parseStartSeconds(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) && value >= 0 ? value : null;
	}
	if (typeof value !== "string") return null;

	const trimmed = value.trim();
	if (trimmed === "") return null;

	if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

	const parts = trimmed.split(":");
	if (parts.length < 2 || parts.length > 3) return null;

	let total = 0;
	for (const part of parts) {
		if (!/^\d+(\.\d+)?$/.test(part)) return null;
		total = total * 60 + Number(part);
	}
	return total;
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

	return valid.filter(
		(chapter, index) => index === 0 || chapter.start !== valid[index - 1]?.start,
	);
}
