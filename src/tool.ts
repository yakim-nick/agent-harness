/**
 * Tool definitions. A tool declares how risky it is and whether it may run in parallel
 * with others, so the harness (not the model) decides what needs approval and how calls
 * are scheduled. Inputs are validated with Zod before `run` ever sees them.
 */
import { z } from 'zod';
import type { Sandbox } from './sandbox.js';

/** `read` tools only look; `write` tools change the workspace and are harder to undo. */
export type Risk = 'read' | 'write';

export interface ToolContext {
  sandbox: Sandbox;
  signal: AbortSignal;
}

/** Thrown for failures the model can understand and react to (bad input, missing file...). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Thrown when the model's arguments do not match the tool's schema. */
export class ToolInputError extends ToolError {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments (object). */
  inputSchema: Record<string, unknown>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly risk: Risk;
  /** Read-only tools without shared state can run concurrently within one model turn. */
  readonly parallelSafe: boolean;
  readonly spec: ToolSpec;
  /** Validate `input` and run. Throws `ToolInputError` / `ToolError` with a model-readable message. */
  execute(input: unknown, ctx: ToolContext): Promise<string>;
}

export interface ToolDefinition<S extends z.ZodType> {
  name: string;
  description: string;
  risk: Risk;
  parallelSafe?: boolean;
  inputSchema: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string>;
}

export function defineTool<S extends z.ZodType>(definition: ToolDefinition<S>): Tool {
  // io: 'input' describes what the model SENDS, so fields with defaults are optional.
  const jsonSchema: Record<string, unknown> = {
    ...z.toJSONSchema(definition.inputSchema, { io: 'input' }),
  };
  delete jsonSchema['$schema']; // the API wants a plain object schema
  return {
    name: definition.name,
    description: definition.description,
    risk: definition.risk,
    // Only read tools may be parallel; a write tool is always serialised.
    parallelSafe: definition.risk === 'read' && (definition.parallelSafe ?? true),
    spec: {
      name: definition.name,
      description: definition.description,
      inputSchema: jsonSchema,
    },
    async execute(input, ctx) {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(input)'}: ${issue.message}`)
          .join('; ');
        throw new ToolInputError(`invalid arguments: ${issues}`);
      }
      return definition.run(parsed.data, ctx);
    },
  };
}
