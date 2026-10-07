import { describe, expect, it, vi } from "vitest";

const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => Record<string, string | undefined>>(() => ({})),
);

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
}));

const createOpenAIMock = vi.hoisted(() =>
	vi.fn((_options: { apiKey?: string; baseURL?: string }) => ({
		chat: (modelId: string) => ({ modelId }),
	})),
);

vi.mock("@ai-sdk/openai", () => ({
	createOpenAI: createOpenAIMock,
}));

import { getAiModel } from "@/lib/ai/provider";
import {
	getTranscriptionProvider,
	isTranscriptionConfigured,
} from "@/lib/transcription-provider";

describe("getTranscriptionProvider", () => {
	it("prefers AssemblyAI when both keys are set", () => {
		serverEnvMock.mockReturnValue({
			ASSEMBLY_API_KEY: "aai",
			DEEPGRAM_API_KEY: "dg",
		});
		expect(getTranscriptionProvider()).toBe("assemblyai");
	});

	it("uses Deepgram when only the Deepgram key is set", () => {
		serverEnvMock.mockReturnValue({ DEEPGRAM_API_KEY: "dg" });
		expect(getTranscriptionProvider()).toBe("deepgram");
		expect(isTranscriptionConfigured()).toBe(true);
	});

	it("reports no provider without keys", () => {
		serverEnvMock.mockReturnValue({});
		expect(getTranscriptionProvider()).toBeNull();
		expect(isTranscriptionConfigured()).toBe(false);
	});
});

describe("OpenAI base URL", () => {
	it("sends OpenAI requests to OPENAI_BASE_URL when it is set", () => {
		serverEnvMock.mockReturnValue({
			OPENAI_API_KEY: "sk",
			OPENAI_BASE_URL: "https://llm.example.com/v1",
		});
		getAiModel("generation")?.model();
		expect(createOpenAIMock).toHaveBeenLastCalledWith({
			apiKey: "sk",
			baseURL: "https://llm.example.com/v1",
		});
	});
});
