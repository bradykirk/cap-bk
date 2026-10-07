import { serverEnv } from "@cap/env";

export type TranscriptionProvider = "assemblyai" | "deepgram";

export function getTranscriptionProvider(): TranscriptionProvider | null {
	const env = serverEnv();
	if (env.ASSEMBLY_API_KEY) return "assemblyai";
	if (env.DEEPGRAM_API_KEY) return "deepgram";
	return null;
}

export function isTranscriptionConfigured() {
	return getTranscriptionProvider() !== null;
}
