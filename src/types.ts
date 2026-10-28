import { z } from "zod";

export const MODES = ["baseline", "calibration"] as const;
export type Mode = (typeof MODES)[number];
export type RunStatus = "answered" | "abstained" | "failed";
export type Verification = "unverified" | "execution_only" | "verified" | "rejected";

/** Where a lesson applies. The server builds it; nothing in it comes from the request. */
export type Scope = {
  tenantId: string;
  databaseId: string; // stable logical database identity, shared by v1 and v2
  environmentId: string; // server-owned branch binding
  calibrationNamespace: string; // experiment arm or calibration cohort
  semanticVersion: string;
  schemaHash: string;
  schemaVersion: string;
};

export const AskInputSchema = z
  .object({
    environmentId: z.string().min(1).max(64),
    mode: z.enum(MODES),
    question: z.string().min(1).max(4000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
export type AskInput = z.infer<typeof AskInputSchema>;

/** The model's final message, parsed and validated before the run can finish. */
export const ModelAnswerSchema = z
  .object({
    status: z.enum(["answered", "abstained"]),
    text: z.string().min(1).max(4000),
    evidenceQueryIds: z.array(z.string()).max(12),
    resultQueryId: z.string().max(64),
    assumptions: z.array(z.string().max(500)).max(8),
    clarification: z.string().max(1000),
  })
  .strict();
export type ModelAnswer = z.infer<typeof ModelAnswerSchema>;

/** The same shape as a JSON schema, for providers that enforce a response format. No unions or nulls: some upstream
 * models refuse them, so "none" is an empty string. */
export const MODEL_ANSWER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "text", "evidenceQueryIds", "resultQueryId", "assumptions", "clarification"],
  properties: {
    status: { type: "string", enum: ["answered", "abstained"] },
    text: { type: "string", description: "The answer for a business reader, with the key numbers." },
    evidenceQueryIds: { type: "array", items: { type: "string" }, description: "Ids of successful queries that support the answer." },
    resultQueryId: { type: "string", description: "Id of the query whose rows are the answer's table, or an empty string." },
    assumptions: { type: "array", items: { type: "string" } },
    clarification: { type: "string", description: "A question for the user when the business meaning is missing, or an empty string." },
  },
} as const;

export type Answer = {
  status: RunStatus;
  text: string;
  evidenceQueryIds: string[];
  resultQueryId?: string;
  assumptions: string[];
  clarification?: string;
};

export type LessonKind = "semantic" | "schema" | "procedure";

export type Lesson = {
  id: string;
  kind: LessonKind;
  text: string;
  scope: Scope;
  evidenceIds: string[];
  verification: Verification;
  /** Relations and columns the lesson names, used to drop it when the schema no longer has them. */
  identifiers: string[];
  supersedesId?: string;
  /** Where it came from: Mubit's runtime calibration. */
  source: "mubit";
  /** The id Mubit gave the unit, when the lesson came back from Mubit. */
  remoteId?: string;
};

export type ColumnInfo = { name: string; dataTypeId: number; dataType?: string };

export type QueryResult = {
  queryId: string;
  columns: ColumnInfo[];
  rows: unknown[][];
  truncated: boolean;
  durationMs: number;
};

export type QueryFailure = {
  queryId: string;
  error: { code: string; sqlstate?: string; message: string };
};

export type Outcome = {
  runId: string;
  verification: Verification;
  source: "reference" | "reviewer" | "execution";
  evidenceIds: string[];
  reason?: string;
};

export type Usage = { inputTokens: number | null; outputTokens: number | null };

export const FeedbackSchema = z
  .object({ verdict: z.enum(["correct", "incorrect"]), reason: z.string().max(1000).optional() })
  .strict();
export type Feedback = z.infer<typeof FeedbackSchema>;
