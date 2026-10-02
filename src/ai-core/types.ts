import type { ZodType } from 'zod';

/** Minimální databázové rozhraní (PostgreSQL). Implementace: PGlite (dev/MVP) nebo pg Pool (produkce). */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type ActorType = 'ai' | 'human' | 'system' | 'public';
export interface Actor {
  type: ActorType;
  id: string;
  /** Povolené scopes nástrojů; '*' = vše (jen pro lidi/system). */
  scopes: string[];
}

export type Risk = 'read' | 'write' | 'sensitive';

/** Odkud informace pochází – vrací se s každým výsledkem a ukládá se do auditu. */
export interface Source {
  system: string;
  ref: string;
  retrieved_at: string;
  note?: string;
}

export interface PolicyReader {
  get<T = unknown>(key: string, fallback: T): Promise<T>;
}

export interface ToolContext {
  db: Db;
  actor: Actor;
  requestId: string;
  conversationId?: string;
  policy: PolicyReader;
  /** Doménové závislosti (e-mailový transport apod.). */
  deps: Record<string, any>;
  now: () => Date;
}

export type GuardDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; code: string; message: string }
  | { decision: 'approval'; category: string; summary: string; reason: string };

export interface ToolHandlerResult<O> {
  data: O;
  sources?: Source[];
  entity?: { type: string; id: string };
}

export interface ToolDefinition<I = any, O = any> {
  name: string;
  description: string;
  input: ZodType<I>;
  /** Scope, který musí aktér mít. */
  scope: string;
  risk: Risk;
  /** Deterministická pravidla (nikdy ne LLM). Běží po validaci a autorizaci. */
  guard?: (ctx: ToolContext, input: I) => Promise<GuardDecision>;
  handler: (ctx: ToolContext, input: I) => Promise<ToolHandlerResult<O>>;
}

export type ToolResult<O = any> =
  | { status: 'ok'; data: O; sources: Source[] }
  | { status: 'error'; error: { code: string; message: string; details?: unknown } }
  | { status: 'pending_approval'; approval_id: string; category: string; message: string };

/** Očekávaná doménová chyba (srozumitelná pro agenta i uživatele). */
export class DomainError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
