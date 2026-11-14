/** Type declarations for search.js (plain-JS client library). */

export interface SearchDocInput {
  tasks?: Array<Record<string, unknown>>;
  entries?: Array<Record<string, unknown>>;
  comments?: Array<Record<string, unknown>>;
}

export interface SearchHit {
  kind: string;
  id: string;
  taskId: string | null;
  title: string;
  text: string;
  score: number;
  snippet: string;
}

export declare class ClientSearchIndex {
  constructor(options?: {
    decrypt?: (enc: string) => Promise<string | null>;
  });
  rebuild(input?: SearchDocInput): Promise<number>;
  search(query: string, limit?: number): SearchHit[];
}

export declare function tokenize(text: unknown): string[];
export declare function scoreText(
  text: string | null | undefined,
  terms: string[],
): number;
