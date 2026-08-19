export function modelEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		object: "model",
		owned_by: "actualyze",
		context_window: 200_000,
		max_output_tokens: 64_000,
		capabilities: { vision: true, tool_use: true, thinking: true, thinking_adaptive: false },
		modalities: { input: ["text", "image", "pdf"], output: ["text"] },
		...overrides,
	};
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json", ...init.headers },
		...init,
	});
}
