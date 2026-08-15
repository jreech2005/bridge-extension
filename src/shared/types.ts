export type Platform = 'claude' | 'chatgpt';

export interface PageState {
  platform: Platform;
  conversationId: string | null;
  conversationTitle: string | null;
  project: string | null;
  url: string;
}

export interface Turn {
  platform: Platform;
  conversationId: string;
  conversationTitle: string | null;
  project: string | null;
  turnIndex: number;
  userText: string;
  assistantText: string;
  url: string;
  capturedAt: number;
}

export interface Chunk {
  id: string;
  conversationId: string;
  turnIndex: number;
  chunkIndex: number;
  userText: string;
  assistantText: string;
  combinedText: string;
  tokenCount: number;
  vector: Float32Array | null;
  capturedAt: number;
}

export interface Conversation {
  id: string;
  platform: Platform;
  platformConversationId: string;
  project: string | null;
  title: string | null;
  url: string;
  capturedAt: number;
  lastUpdatedAt: number;
}

export interface ClaudeProject {
  id: string;
  name: string;
  url: string;
}

export type TriggerSource =
  | { type: 'platform'; platform: string }
  | { type: 'project'; project: string };

export interface TriggerMatch {
  source: TriggerSource;
  matchedText: string;
}

export interface SearchResult {
  chunk: Chunk;
  conversation: Conversation;
  score: number;
}
