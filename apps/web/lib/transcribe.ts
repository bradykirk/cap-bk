import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import {
	organizations,
	s3Buckets,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { createClient } from "@deepgram/sdk";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { checkHasAudioTrack, extractAudioFromUrl } from "@/lib/audio-extract";
import { startAiGeneration } from "@/lib/generate-ai";
import {
	checkHasAudioTrackViaMediaServer,
	extractAudioViaMediaServer,
	isMediaServerConfigured,
} from "@/lib/media-client";
import { runPromise } from "@/lib/server";
import { type DeepgramResult, formatToWebVTT } from "@/lib/transcribe-utils";

const STALE_UPLOAD_MS = 30 * 60 * 1000;

type TranscribeResult = {
	success: boolean;
	message: string;
};

interface VideoData {
	video: typeof videos.$inferSelect;
	bucketId: S3Bucket.S3BucketId | null;
	transcriptionDisabled: boolean;
}

export async function transcribeVideo(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled = false,
	_isRetry = false,
): Promise<TranscribeResult> {
	if (!serverEnv().DEEPGRAM_API_KEY) {
		return {
			success: false,
			message: "Missing necessary environment variables",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({
			video: videos,
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video does not exist" };
	}

	const result = query[0];
	if (!result || !result.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (!video) {
		return { success: false, message: "Video information is missing" };
	}

	if (
		video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript
	) {
		console.log(
			`[transcribeVideo] Transcription disabled for video ${videoId}`,
		);
		try {
			await db()
				.update(videos)
				.set({ transcriptionStatus: "SKIPPED" })
				.where(eq(videos.id, videoId));
		} catch (err) {
			console.error(`[transcribeVideo] Failed to mark as skipped:`, err);
			return {
				success: false,
				message: "Transcription disabled, but failed to update status",
			};
		}
		return {
			success: true,
			message: "Transcription disabled for video — skipping transcription",
		};
	}

	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "PROCESSING" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO"
	) {
		return {
			success: true,
			message: "Transcription already completed or in progress",
		};
	}

	const upload = await db()
		.select({ phase: videoUploads.phase, updatedAt: videoUploads.updatedAt })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId))
		.limit(1);

	const uploadRow = upload[0];
	const uploadPhaseActive =
		uploadRow?.phase === "uploading" ||
		uploadRow?.phase === "processing" ||
		uploadRow?.phase === "generating_thumbnail";
	const uploadRecent =
		uploadRow?.updatedAt != null &&
		Date.now() - uploadRow.updatedAt.getTime() < STALE_UPLOAD_MS;

	if (uploadPhaseActive && uploadRecent) {
		return {
			success: true,
			message: "Video upload is still in progress",
		};
	}

	if (uploadPhaseActive && !uploadRecent) {
		console.warn(
			`[transcribeVideo] Ignoring stale ${uploadRow?.phase} upload row for ${videoId}`,
		);
	}

	console.log(`[transcribeVideo] Starting transcription for video ${videoId}`);

	Promise.resolve().then(() =>
		executeTranscriptionAsync(videoId, userId, aiGenerationEnabled).catch(
			(error) => {
				console.error(
					`[transcribeVideo] Async transcription failed for ${videoId}:`,
					error,
				);
			},
		),
	);

	return {
		success: true,
		message: "Transcription started",
	};
}

async function executeTranscriptionAsync(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled: boolean,
): Promise<void> {
	try {
		const videoData = await validateAndMarkProcessing(videoId);

		if (videoData.transcriptionDisabled) {
			await markSkipped(videoId);
			return;
		}

		const audioUrl = await extractAudio(videoId, userId, videoData.bucketId);

		if (!audioUrl) {
			await markNoAudio(videoId);
			return;
		}

		const transcription = await transcribeWithDeepgram(audioUrl);

		await saveTranscription(videoId, userId, videoData.bucketId, transcription);

		await cleanupTempAudio(videoId, userId, videoData.bucketId);

		if (aiGenerationEnabled) {
			await queueAiGeneration(videoId, userId);
		}

		console.log(
			`[transcribeVideo] Transcription completed successfully for ${videoId}`,
		);
	} catch (error) {
		console.error(
			`[transcribeVideo] Transcription failed for ${videoId}:`,
			error,
		);
		await db()
			.update(videos)
			.set({ transcriptionStatus: "ERROR" })
			.where(eq(videos.id, videoId));
	}
}

async function validateAndMarkProcessing(
	videoId: Video.VideoId,
): Promise<VideoData> {
	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		throw new Error("Video does not exist");
	}

	const result = query[0];
	if (!result?.video) {
		throw new Error("Video information is missing");
	}

	const transcriptionDisabled =
		result.video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript ??
		false;

	await db()
		.update(videos)
		.set({ transcriptionStatus: "PROCESSING" })
		.where(eq(videos.id, videoId));

	return {
		video: result.video,
		bucketId: (result.bucket?.id ?? null) as S3Bucket.S3BucketId | null,
		transcriptionDisabled,
	};
}

async function markSkipped(videoId: Video.VideoId): Promise<void> {
	await db()
		.update(videos)
		.set({ transcriptionStatus: "SKIPPED" })
		.where(eq(videos.id, videoId));
}

async function markNoAudio(videoId: Video.VideoId): Promise<void> {
	await db()
		.update(videos)
		.set({ transcriptionStatus: "NO_AUDIO" })
		.where(eq(videos.id, videoId));
}

async function extractAudio(
	videoId: Video.VideoId,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<string | null> {
	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId),
	).pipe(runPromise);

	const videoKey = `${userId}/${videoId}/result.mp4`;
	const videoUrl = await bucket.getSignedObjectUrl(videoKey).pipe(runPromise);

	const response = await fetch(videoUrl, {
		method: "GET",
		headers: { range: "bytes=0-0" },
	});
	if (!response.ok) {
		throw new Error("Video file not accessible");
	}

	const useMediaServer = isMediaServerConfigured();

	let hasAudio: boolean;
	let audioBuffer: Buffer;

	if (useMediaServer) {
		hasAudio = await checkHasAudioTrackViaMediaServer(videoUrl);
		if (!hasAudio) {
			return null;
		}

		audioBuffer = await extractAudioViaMediaServer(videoUrl);
	} else {
		hasAudio = await checkHasAudioTrack(videoUrl);
		if (!hasAudio) {
			return null;
		}

		const result = await extractAudioFromUrl(videoUrl);

		try {
			audioBuffer = await fs.readFile(result.filePath);
		} finally {
			await result.cleanup();
		}
	}

	const audioKey = `${userId}/${videoId}/audio-temp.mp3`;

	await bucket
		.putObject(audioKey, audioBuffer, {
			contentType: "audio/mpeg",
		})
		.pipe(runPromise);

	const audioSignedUrl = await bucket
		.getSignedObjectUrl(audioKey)
		.pipe(runPromise);

	return audioSignedUrl;
}

async function transcribeWithDeepgram(audioUrl: string): Promise<string> {
	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

	const deepgram = createClient(serverEnv().DEEPGRAM_API_KEY as string);

	const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
		audioBuffer,
		{
			model: "nova-3",
			smart_format: true,
			detect_language: true,
			utterances: true,
			mime_type: "audio/mpeg",
		},
	);

	if (error) {
		throw new Error(`Deepgram transcription failed: ${error.message}`);
	}

	return formatToWebVTT(result as unknown as DeepgramResult);
}

async function saveTranscription(
	videoId: Video.VideoId,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
	transcription: string,
): Promise<void> {
	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId),
	).pipe(runPromise);

	await bucket
		.putObject(`${userId}/${videoId}/transcription.vtt`, transcription, {
			contentType: "text/vtt",
		})
		.pipe(runPromise);

	await db()
		.update(videos)
		.set({ transcriptionStatus: "COMPLETE" })
		.where(eq(videos.id, videoId));
}

async function cleanupTempAudio(
	videoId: Video.VideoId,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<void> {
	const audioKey = `${userId}/${videoId}/audio-temp.mp3`;

	try {
		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		).pipe(runPromise);

		await bucket.deleteObject(audioKey).pipe(runPromise);
	} catch (error) {
		console.error(
			`[transcribe] Failed to cleanup temp audio file: ${audioKey}`,
			error,
		);
	}
}

async function queueAiGeneration(
	videoId: Video.VideoId,
	userId: string,
): Promise<void> {
	await startAiGeneration(videoId, userId);
}
