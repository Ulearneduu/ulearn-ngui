import type { InterviewTurn, InterviewTurnRole } from '../models';

const TURN_ROLES: readonly InterviewTurnRole[] = ['user', 'assistant'];

export class InterviewRequestError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'InterviewRequestError';
    this.code = code;
  }
}

export interface InterviewTurnResponse {
  assistantMessage: string;
  replayed: boolean;
  turns: InterviewTurn[];
}

export function sanitizeInterviewErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const message = value.trim();
  if (!message || message.length > 180 || /[\r\n]/.test(message)) return fallback;
  if (/bearer|api[_-]?key|service_role|sk-|AIza|eyJ/i.test(message)) return fallback;
  return message;
}

export function parseInterviewTurnResponse(value: unknown): InterviewTurnResponse | null {
  if (!isRecord(value) || typeof value['assistantMessage'] !== 'string') return null;
  const assistantMessage = value['assistantMessage'].trim();
  if (!assistantMessage) return null;
  if (!Array.isArray(value['turns'])) return null;

  const turns: InterviewTurn[] = [];
  for (const item of value['turns']) {
    const turn = asTurn(item);
    if (!turn) return null;
    turns.push(turn);
  }
  turns.sort((left, right) => left.seq - right.seq);
  if (!turns.some((turn) => turn.role === 'assistant' && turn.content.trim() === assistantMessage)) {
    return null;
  }
  return {
    assistantMessage,
    replayed: value['replayed'] === true,
    turns,
  };
}

export async function interviewFunctionError(
  error: unknown,
  fallback = 'Could not send your answer. Please try again.'
): Promise<InterviewRequestError> {
  const body = await readErrorBody(error);
  const code = body && typeof body['code'] === 'string' && body['code'] ? body['code'] : 'REQUEST_FAILED';
  const message = sanitizeInterviewErrorMessage(body?.['error'], fallback);
  return new InterviewRequestError(message, code);
}

function asTurn(value: unknown): InterviewTurn | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const role = value['role'];
  const content = value['content'];
  const seq = value['seq'];
  const createdAt = value['createdAt'];
  if (typeof id !== 'string' || typeof role !== 'string' || typeof content !== 'string') return null;
  if (typeof createdAt !== 'string' || !TURN_ROLES.includes(role as InterviewTurnRole)) return null;
  const seqNumber = typeof seq === 'number' ? seq : typeof seq === 'string' ? Number(seq) : NaN;
  if (!Number.isInteger(seqNumber) || seqNumber <= 0 || !content.trim()) return null;
  return { id, role: role as InterviewTurnRole, content, seq: seqNumber, createdAt };
}

async function readErrorBody(error: unknown): Promise<Record<string, unknown> | null> {
  if (!isRecord(error)) return null;
  const context = error['context'];
  if (typeof Response !== 'undefined' && context instanceof Response) {
    try {
      const body = await context.clone().json();
      return isRecord(body) ? body : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
