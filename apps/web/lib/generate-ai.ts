import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import {
	type Chapter,
	formatTimestampLabel,
	formatTranscriptWithTimestamps,
	parseVttWithTimestamps,
	sanitizeChapters,
	type VttSegment,
} from "@/lib/ai-transcript";
import { GROQ_MODEL, getGroqClient } from "@/lib/groq-client";
import { runPromise } from "@/lib/server";

type GenerateAiResult = {
	success: boolean;
	message: string;
};

interface VideoData {
	video: typeof videos.$inferSelect;
	bucketId: S3Bucket.S3BucketId | null;
	metadata: VideoMetadata;
}

interface TranscriptData {
	segments: VttSegment[];
}

interface TranscriptChunk {
	segments: VttSegment[];
	startTime: number;
	endTime: number;
}

interface AiResult {
	title?: string;
	summary?: string;
	chapters?: Chapter[];
}

const MAX_CHARS_PER_CHUNK = 24000;

export async function startAiGeneration(
	videoId: Video.VideoId,
	userId: string,
	options: { force?: boolean } = {},
): Promise<GenerateAiResult> {
	const force = options.force === true;

	if (!serverEnv().GROQ_API_KEY && !serverEnv().OPENAI_API_KEY) {
		return {
			success: false,
			message: "Missing AI API keys (Groq or OpenAI)",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video does not exist" };
	}

	const { video } = query[0];

	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			success: false,
			message: "Transcription not complete",
		};
	}

	const metadata = (video.metadata as VideoMetadata) || {};

	if (
		metadata.aiGenerationStatus === "PROCESSING" ||
		metadata.aiGenerationStatus === "QUEUED"
	) {
		return {
			success: true,
			message: "AI generation already in progress",
		};
	}

	if (
		!force &&
		metadata.aiGenerationStatus === "COMPLETE" &&
		metadata.summary &&
		metadata.chapters
	) {
		return {
			success: true,
			message: "AI metadata already generated",
		};
	}

	console.log(
		`[startAiGeneration] Starting AI generation for video ${videoId}`,
	);

	await db()
		.update(videos)
		.set({
			metadata: {
				...metadata,
				aiGenerationStatus: "QUEUED",
			},
		})
		.where(eq(videos.id, videoId));

	Promise.resolve().then(() =>
		executeAiGenerationAsync(videoId, userId, force).catch((error) => {
			console.error(
				`[startAiGeneration] Async AI generation failed for ${videoId}:`,
				error,
			);
		}),
	);

	return {
		success: true,
		message: "AI generation started",
	};
}

async function executeAiGenerationAsync(
	videoId: Video.VideoId,
	userId: string,
	force: boolean,
): Promise<void> {
	try {
		const videoData = await validateAndSetProcessing(videoId, force);

		const transcript = await fetchTranscript(
			videoId,
			userId,
			videoData.bucketId,
		);

		if (!transcript) {
			await markSkipped(videoId, videoData.metadata);
			console.log(
				`[startAiGeneration] Transcript empty or too short for ${videoId}, skipped`,
			);
			return;
		}

		const result = await generateWithAi(transcript, videoData.video.duration);

		await saveResults(videoId, videoData, result);

		console.log(
			`[startAiGeneration] AI generation completed successfully for ${videoId}`,
		);
	} catch (error) {
		console.error(
			`[startAiGeneration] AI generation failed for ${videoId}:`,
			error,
		);

		const query = await db()
			.select({ video: videos })
			.from(videos)
			.where(eq(videos.id, videoId));

		const metadata = (query[0]?.video?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId));
	}
}

async function validateAndSetProcessing(
	videoId: Video.VideoId,
	force: boolean,
): Promise<VideoData> {
	const groqClient = getGroqClient();
	if (!groqClient && !serverEnv().OPENAI_API_KEY) {
		throw new Error("Missing Groq or OpenAI API key");
	}

	const query = await db()
		.select({ video: videos, bucket: s3Buckets })
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new Error("Video does not exist");
	}

	const { video, bucket } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};

	if (video.transcriptionStatus !== "COMPLETE") {
		throw new Error("Transcription not complete");
	}

	if (!force && metadata.summary && metadata.chapters) {
		throw new Error("AI metadata already generated");
	}

	await db()
		.update(videos)
		.set({
			metadata: {
				...metadata,
				aiGenerationStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId));

	return {
		video,
		bucketId: (bucket?.id ?? null) as S3Bucket.S3BucketId | null,
		metadata,
	};
}

async function fetchTranscript(
	videoId: Video.VideoId,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<TranscriptData | null> {
	const vtt = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		);
		return yield* bucket.getObject(`${userId}/${videoId}/transcription.vtt`);
	}).pipe(runPromise);

	if (Option.isNone(vtt)) {
		return null;
	}

	const segments = parseVttWithTimestamps(vtt.value);
	const text = segments
		.map((s) => s.text)
		.join(" ")
		.trim();

	if (text.length < 10) {
		return null;
	}

	return { segments };
}

async function markSkipped(
	videoId: Video.VideoId,
	metadata: VideoMetadata,
): Promise<void> {
	await db()
		.update(videos)
		.set({
			metadata: {
				...metadata,
				aiGenerationStatus: "SKIPPED",
			},
		})
		.where(eq(videos.id, videoId));
}

async function generateWithAi(
	transcript: TranscriptData,
	durationSeconds: number | null,
): Promise<AiResult> {
	const groqClient = getGroqClient();
	const maxTime = resolveMaxTime(transcript.segments, durationSeconds);
	const chunks = chunkTranscriptWithTimestamps(transcript.segments);

	if (chunks.length <= 1) {
		return generateSingleChunk(transcript.segments, groqClient, maxTime);
	}

	return generateMultipleChunks(chunks, groqClient, maxTime);
}

function resolveMaxTime(
	segments: VttSegment[],
	durationSeconds: number | null,
): number | null {
	if (
		typeof durationSeconds === "number" &&
		Number.isFinite(durationSeconds) &&
		durationSeconds > 0
	) {
		return Math.ceil(durationSeconds);
	}

	const lastSegmentStart = segments[segments.length - 1]?.start ?? 0;
	return lastSegmentStart > 0 ? lastSegmentStart : null;
}

async function saveResults(
	videoId: Video.VideoId,
	videoData: VideoData,
	result: AiResult,
): Promise<void> {
	const { video, metadata } = videoData;

	const updatedMetadata: VideoMetadata = {
		...metadata,
		aiTitle: result.title || metadata.aiTitle,
		summary: result.summary || metadata.summary,
		chapters: result.chapters || metadata.chapters,
		aiGenerationStatus: "COMPLETE",
	};

	await db()
		.update(videos)
		.set({ metadata: updatedMetadata })
		.where(eq(videos.id, videoId));

	const hasDatePattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(
		video.name || "",
	);

	if (
		(video.name?.startsWith("Cap Recording -") || hasDatePattern) &&
		result.title
	) {
		await db()
			.update(videos)
			.set({ name: result.title })
			.where(eq(videos.id, videoId));
	}
}

function chunkTranscriptWithTimestamps(
	segments: VttSegment[],
): TranscriptChunk[] {
	const chunks: TranscriptChunk[] = [];
	let currentChunk: VttSegment[] = [];
	let currentLength = 0;

	const pushChunk = () => {
		chunks.push({
			segments: currentChunk,
			startTime: currentChunk[0]?.start ?? 0,
			endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
		});
	};

	for (const segment of segments) {
		if (
			currentLength + segment.text.length > MAX_CHARS_PER_CHUNK &&
			currentChunk.length > 0
		) {
			pushChunk();
			currentChunk = [];
			currentLength = 0;
		}
		currentChunk.push(segment);
		currentLength += segment.text.length + 1;
	}

	if (currentChunk.length > 0) {
		pushChunk();
	}

	return chunks;
}

async function callAiApi(
	prompt: string,
	groqClient: ReturnType<typeof getGroqClient>,
): Promise<string> {
	if (groqClient) {
		try {
			const completion = await groqClient.chat.completions.create({
				messages: [{ role: "user", content: prompt }],
				model: GROQ_MODEL,
			});
			return completion.choices?.[0]?.message?.content || "{}";
		} catch (groqError) {
			if (serverEnv().OPENAI_API_KEY) {
				return callOpenAi(prompt);
			}
			throw groqError;
		}
	} else if (serverEnv().OPENAI_API_KEY) {
		return callOpenAi(prompt);
	}
	return "{}";
}

async function callOpenAi(prompt: string): Promise<string> {
	const baseUrl = (
		serverEnv().OPENAI_BASE_URL || "https://api.openai.com/v1"
	).replace(/\/+$/, "");
	const aiRes = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${serverEnv().OPENAI_API_KEY}`,
		},
		body: JSON.stringify({
			model: "gpt-4o-mini",
			messages: [{ role: "user", content: prompt }],
		}),
	});
	if (!aiRes.ok) {
		const errorText = await aiRes.text();
		throw new Error(`OpenAI API error: ${aiRes.status} ${errorText}`);
	}
	const aiJson = await aiRes.json();
	return aiJson.choices?.[0]?.message?.content || "{}";
}

function cleanJsonResponse(content: string): string {
	if (content.includes("```json")) {
		return content.replace(/```json\s*/g, "").replace(/```\s*/g, "");
	}
	if (content.includes("```")) {
		return content.replace(/```\s*/g, "");
	}
	return content;
}

function chapterTimingRules(maxTime: number | null): string {
	const bound =
		maxTime === null
			? ""
			: `\n- The video is ${maxTime} seconds long (${formatTimestampLabel(maxTime)}). NEVER return a chapter with a start greater than ${maxTime}.`;

	return `- Every transcript line is prefixed with its real timestamp as [MM:SS]
- "start" MUST be the timestamp of the transcript line where that topic begins, converted to seconds (e.g. [01:40] becomes 100)
- Only use timestamps that actually appear in the transcript. Do NOT estimate, round, or evenly space them
- If you are unsure where a topic begins, omit the chapter rather than guessing${bound}`;
}

async function generateSingleChunk(
	segments: VttSegment[],
	groqClient: ReturnType<typeof getGroqClient>,
	maxTime: number | null,
): Promise<AiResult> {
	const prompt = `You are Cap AI, an expert at analyzing video content and creating comprehensive summaries.

Analyze this transcript thoroughly and provide a detailed JSON response:
{
  "title": "string (concise but descriptive title that captures the main topic)",
  "summary": "string (detailed summary that covers ALL key points discussed. For meetings: include decisions made, action items, and key discussion points. For tutorials: cover all steps and concepts explained. For presentations: summarize all main arguments and supporting points. Write from 1st person perspective if the speaker is teaching/presenting, e.g. 'In this video, I walk through...'. Make it comprehensive enough that someone could understand the full content without watching.)",
  "chapters": [{"title": "string (descriptive chapter title)", "start": number (seconds from start)}]
}

Guidelines:
- The summary should be detailed and comprehensive, not a brief overview
- Capture ALL important topics, not just the main theme
- For longer content, organize the summary by topic or chronologically
- Include specific details, names, numbers, and conclusions mentioned
- Chapters should mark distinct topic changes or sections

Chapter timing rules:
${chapterTimingRules(maxTime)}

Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript:
${formatTranscriptWithTimestamps(segments)}`;

	const content = await callAiApi(prompt, groqClient);
	return parseAiResponse(content, maxTime);
}

async function generateMultipleChunks(
	chunks: TranscriptChunk[],
	groqClient: ReturnType<typeof getGroqClient>,
	maxTime: number | null,
): Promise<AiResult> {
	const chunkSummaries: {
		summary: string;
		keyPoints: string[];
		chapters: Chapter[];
		startTime: number;
		endTime: number;
	}[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;

		const chunkPrompt = `You are Cap AI, an expert at analyzing video content. This is section ${i + 1} of ${chunks.length} from a longer video (timestamp ${formatTimestampLabel(chunk.startTime)} to ${formatTimestampLabel(chunk.endTime)}).

Analyze this section thoroughly and provide JSON:
{
  "summary": "string (detailed summary of this section - capture ALL key points, topics discussed, decisions made, or concepts explained. Include specific details like names, numbers, action items, and conclusions. This should be 3-6 sentences minimum.)",
  "keyPoints": ["string (specific key point or takeaway)", ...],
  "chapters": [{"title": "string (descriptive title for this topic/section)", "start": number (seconds from video start)}]
}

Chapter timing rules:
${chapterTimingRules(maxTime)}

Be thorough - this summary will be combined with other sections to create a comprehensive overview.
Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript section:
${formatTranscriptWithTimestamps(chunk.segments)}`;

		const chunkContent = await callAiApi(chunkPrompt, groqClient);
		try {
			const parsed = JSON.parse(cleanJsonResponse(chunkContent).trim());
			chunkSummaries.push({
				summary: parsed.summary || "",
				keyPoints: parsed.keyPoints || [],
				chapters: sanitizeChapters(parsed.chapters, maxTime),
				startTime: chunk.startTime,
				endTime: chunk.endTime,
			});
		} catch {}
	}

	const allChapters = sanitizeChapters(
		chunkSummaries.flatMap((c) => c.chapters),
		maxTime,
	);

	const allKeyPoints = chunkSummaries.flatMap((c) => c.keyPoints);

	const sectionDetails = chunkSummaries
		.map((c, i) => {
			const timeRange = `${formatTimestampLabel(c.startTime)} - ${formatTimestampLabel(c.endTime)}`;
			const keyPointsList =
				c.keyPoints.length > 0 ? `\nKey points: ${c.keyPoints.join("; ")}` : "";
			return `Section ${i + 1} (${timeRange}):\n${c.summary}${keyPointsList}`;
		})
		.join("\n\n");

	const finalPrompt = `You are Cap AI, an expert at synthesizing information into comprehensive, well-organized summaries.

Based on these detailed section analyses of a video, create a thorough final summary that captures EVERYTHING important.

Section analyses:
${sectionDetails}

${allKeyPoints.length > 0 ? `All key points identified:\n${allKeyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n` : ""}

Provide JSON in the following format:
{
  "title": "string (concise but descriptive title that captures the main topic/purpose)",
  "summary": "string (COMPREHENSIVE summary that covers the entire video thoroughly. This should be detailed enough that someone could understand all the important content without watching. Include: main topics covered, key decisions or conclusions, important details mentioned, action items if any. Organize it logically - for meetings use topics/agenda items, for tutorials use steps/concepts, for presentations use main arguments. Write from 1st person perspective if appropriate. This should be several paragraphs for longer content.)"
}

The summary must be detailed and comprehensive - not a brief overview. Capture all the important information from every section.
Return ONLY valid JSON without any markdown formatting or code blocks.`;

	const finalContent = await callAiApi(finalPrompt, groqClient);
	try {
		const parsed = JSON.parse(cleanJsonResponse(finalContent).trim());
		return {
			title: parsed.title,
			summary: parsed.summary,
			chapters: allChapters,
		};
	} catch {
		const fallbackSummary = chunkSummaries
			.map((c, i) => `**Part ${i + 1}:** ${c.summary}`)
			.join("\n\n");
		const keyPointsSummary =
			allKeyPoints.length > 0
				? `\n\n**Key Points:**\n${allKeyPoints.map((p) => `- ${p}`).join("\n")}`
				: "";
		return {
			title: "Video Summary",
			summary: fallbackSummary + keyPointsSummary,
			chapters: allChapters,
		};
	}
}

function parseAiResponse(content: string, maxTime: number | null): AiResult {
	try {
		const data = JSON.parse(cleanJsonResponse(content).trim());

		return {
			title: data.title,
			summary: data.summary,
			chapters: sanitizeChapters(data.chapters, maxTime),
		};
	} catch {
		return {
			title: "Generated Title",
			summary:
				"The AI was unable to generate a proper summary for this content.",
			chapters: [],
		};
	}
}
