export interface ProjectRecord {
  id: string;
  name: string;
  workDir: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ProjectsResponse {
  projects: ProjectRecord[];
  active: string | null;
}

export interface VerifyResult {
  ok: boolean;
  absolutePath: string;
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  error: string | null;
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: string;
  bytes: number;
  firstUserMessage: string | null;
  turnCount: number;
}

export interface CostAggregate {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turns: number;
}

export interface CostSummary {
  today: CostAggregate;
  week: CostAggregate;
  lifetime: CostAggregate;
  daily: Array<{ day: string; costUsd: number; turns: number }>;
}
