import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
} from "@cap/web-domain";
import type { AssemblyAIEditResult } from "@/lib/edit-transcript";

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_MODEL = "nova-3";

export const DEEPGRAM_NO_SPOKEN_AUDIO_MESSAGE =
	"Deepgram transcription found no spoken audio";

type DeepgramWord = {
	word?: unknown;
	punctuated_word?: unknown;
	start?: unknown;
	end?: unknown;
	confidence?: unknown;
};

export type DeepgramListenResponse = {
	metadata?: { request_id?: unknown; duration?: unknown } | null;
	results?: {
		channels?: readonly {
			detected_language?: unknown;
			alternatives?: readonly { words?: readonly DeepgramWord[] | null }[];
		}[];
	} | null;
};

export type DeepgramTranscript = AssemblyAIEditResult & {
	audioDurationSeconds: number | null;
	requestId: string | null;
};

function finiteSeconds(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getDeepgramListenParams(language: AiGenerationLanguage) {
	const params = new URLSearchParams({
		model: DEEPGRAM_MODEL,
		smart_format: "true",
		punctuate: "true",
		filler_words: "true",
	});

	if (language === AI_GENERATION_LANGUAGE_AUTO) {
		params.set("detect_language", "true");
	} else {
		params.set("language", language);
	}

	return params;
}

export function deepgramToEditResult(
	response: DeepgramListenResponse,
): DeepgramTranscript {
	const channel = response.results?.channels?.[0];
	const words = (channel?.alternatives?.[0]?.words ?? []).flatMap((word) => {
		const text =
			typeof word.punctuated_word === "string"
				? word.punctuated_word
				: typeof word.word === "string"
					? word.word
					: null;
		const start = finiteSeconds(word.start);
		const end = finiteSeconds(word.end);
		if (!text || start === null || end === null) return [];

		return [
			{
				text,
				start: Math.round(start * 1000),
				end: Math.round(end * 1000),
				confidence: finiteSeconds(word.confidence),
			},
		];
	});

	return {
		words,
		language_code:
			typeof channel?.detected_language === "string"
				? channel.detected_language
				: undefined,
		speech_model_used: DEEPGRAM_MODEL,
		audioDurationSeconds: finiteSeconds(response.metadata?.duration),
		requestId:
			typeof response.metadata?.request_id === "string"
				? response.metadata.request_id
				: null,
	};
}

export async function transcribeWithDeepgram(
	audio: Buffer,
	language: AiGenerationLanguage,
	apiKey: string,
): Promise<DeepgramTranscript> {
	const response = await fetch(
		`${DEEPGRAM_LISTEN_URL}?${getDeepgramListenParams(language)}`,
		{
			method: "POST",
			headers: {
				Authorization: `Token ${apiKey}`,
				"Content-Type": "audio/mpeg",
			},
			body: new Uint8Array(audio),
		},
	);

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Deepgram transcription failed: ${response.status} ${response.statusText} ${detail.slice(0, 500)}`.trim(),
		);
	}

	const transcript = deepgramToEditResult(
		(await response.json()) as DeepgramListenResponse,
	);

	if (!transcript.words || transcript.words.length === 0) {
		throw new Error(
			`${DEEPGRAM_NO_SPOKEN_AUDIO_MESSAGE} (request=${transcript.requestId ?? "unknown"})`,
		);
	}

	return transcript;
}
