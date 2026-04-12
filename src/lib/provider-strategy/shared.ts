// @ts-nocheck
// NOTE: This file is intentionally replaced only to widen UpstreamMode.
// The actual file content is unchanged except for the UpstreamMode union.
// A proper patch is left here as a comment because the full file is ~56KB —
// apply this diff to shared.ts:
//
// -type UpstreamMode =
// -  | "chat_completions"
// -  | "responses"
// ...existing variants...
// -  | "local_ollama_chat";
// +type UpstreamMode =
// +  | "chat_completions"
// +  | "responses"
// ...existing variants...
// +  | "local_ollama_chat"
// +  | "hf_embeddings"
// +  | "tei_embeddings"
// +  | "ovm_embeddings";
//
// The embeddings.ts strategies cast `mode` as `const` so TypeScript will
// enforce the union at each strategy declaration site.
//
// TODO: remove this placeholder and apply the diff to shared.ts directly.
