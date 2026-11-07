import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  conversationForModel,
  classifyUniqueViolation,
  planAnswerAfterClose,
  decideClaim,
  findSavedAnswer,
  nextSequence,
  normalizeAnswer,
  normalizeClientTurnId,
  normalizeSessionId,
  parseStoredTurnList,
  positiveDurationMinutes,
  requestInterviewReply,
  rowsForSuccessfulReply,
  type AnswerPlan,
  type StoredTurn,
} from '../_shared/interview-turn-policy.ts';
import {
  parseTemplateVersionNumber,
  pickTemplateFacts,
} from '../_shared/interview-template-version.ts';

/**
 * interview-turn
 *
 * Secrets (Edge Function secrets only, never in Angular):
 * OPENAI_API_KEY, INTERVIEW_AI_MODEL,
 * optional INTERVIEW_AI_PROVIDER (must be openai when set),
 * INTERVIEW_AI_TIMEOUT_MS, INTERVIEW_AI_MAX_RETRIES, INTERVIEW_AI_RETRY_BASE_MS.
 *
 * v1 calls OpenAI gpt-6-luna. INTERVIEW_AI_MODEL overrides that id.
 * The service role is used only after the caller is authenticated,
 * has interview.access, and owns the session: to read a hidden template prompt,
 * and to insert the user and assistant turns together.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;
const APPROVED_MODEL = 'gpt-6-luna';

const CLIENT_MESSAGE: Record<string, string> = {
  INTERVIEW_AI_TIMEOUT: 'The interviewer is taking too long. Please try again.',
  INTERVIEW_AI_UNAVAILABLE: 'Interview AI is temporarily unavailable. Your answer was not saved.',
  INTERVIEW_AI_RATE_LIMIT: 'High demand right now. Please wait a moment and retry.',
  AI_NOT_CONFIGURED: 'Interview AI is not configured yet. Please try again later.',
  TURN_IN_PROGRESS: 'That answer is still being saved. Please send it again in a moment.',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST to send an answer.');

  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;
    const { userClient, userId } = auth;

    const body = await readBody(req);
    if (!body.ok) return body.response;
    const record = body.value;

    const sessionId = normalizeSessionId(record['sessionId']);
    const answerResult = normalizeAnswer(record['answer']);
    const clientTurn = normalizeClientTurnId(record['clientTurnId']);
    if (!sessionId || !clientTurn.ok) {
      return fail(400, 'INVALID_INPUT', 'A valid interview session and answer are required.');
    }
    if (!answerResult.ok) return fail(400, 'INVALID_INPUT', answerResult.message);
    const clientTurnId = clientTurn.clientTurnId;

    const allowed = await userClient.rpc('has_permission', { perm: 'interview.access' });
    if (allowed.error) return fail(500, 'PERMISSION_CHECK_FAILED', 'Could not verify interview access.');
    if (allowed.data !== true) return fail(403, 'FORBIDDEN', 'You do not have access to interviews.');

    const sessionResult = await userClient
      .from('interview_sessions')
      .select('id, user_id, status, template_id, prompt_version, template_version_id, started_at')
      .eq('id', sessionId)
      .maybeSingle();
    if (sessionResult.error) return fail(500, 'SESSION_LOAD_FAILED', 'Could not open this interview.', sessionId);
    const session = asSession(sessionResult.data);
    if (!session || session.userId !== userId) {
      return fail(404, 'NOT_FOUND', 'This interview session could not be opened.');
    }
    const history = await loadTurns(userClient, session.id);
    if (!history.ok) return history.response;
    const already = findSavedAnswer(history.turns, clientTurnId);
    const closure = await finishIfExpired(userClient, session.id);
    if (!closure.ok) {
      return fail(500, 'EXPIRE_UPDATE_FAILED', 'This interview could not be ended. Please try again.', sessionId);
    }
    const action = planAnswerAfterClose({
      saved: already.type,
      timeUp: closure.timeUp,
      status: closure.status,
    });
    if (action === 'replay' && already.type === 'replay') return replayResponse(already);
    if (action === 'expired') {
      return fail(409, 'SESSION_EXPIRED', 'This interview has ended because the time is up.', sessionId);
    }
    if (action === 'closed') {
      return fail(409, 'SESSION_CLOSED', 'This interview is already finished.', sessionId);
    }

    const template = await readSessionTemplate(userClient, session);
    if (!template) return fail(409, 'SESSION_CLOSED', 'This interview cannot continue.', sessionId);
    if (already.type === 'blocked') {
      return fail(409, 'TURN_CONFLICT', 'That answer conflicted with another submission. Refresh the conversation and try again.', sessionId);
    }

    const writer = serviceDb();
    if (!writer) return fail(500, 'NOT_SAVED', 'Your answer was not saved. Please try again.', sessionId);
    const reserved = await reserveClaim(writer, {
      sessionId: session.id,
      userId,
      clientTurnId,
      answer: answerResult.answer,
    });
    if (reserved.kind === 'error') return fail(500, 'NOT_SAVED', 'Your answer was not saved. Please try again.', sessionId);
    if (reserved.kind === 'wait') {
      return fail(409, 'TURN_IN_PROGRESS', CLIENT_MESSAGE['TURN_IN_PROGRESS'], sessionId);
    }
    if (reserved.kind === 'replay') return replayResponse(reserved.plan);

    let assistantText = reserved.assistantText;
    let mode = already.type;
    if (!assistantText) {
      const aiConfig = readAiConfig();
      if (!aiConfig.ok) {
        await markClaimFailed(writer, session.id, clientTurnId, reserved.claimedAt);
        await markSessionFailed(writer, session.id);
        console.error(JSON.stringify({
          source: 'interview-turn',
          code: 'AI_NOT_CONFIGURED',
          missing: aiConfig.missing,
        }));
        return fail(503, 'AI_NOT_CONFIGURED', CLIENT_MESSAGE['AI_NOT_CONFIGURED'], sessionId);
      }
      const conversation = conversationForModel(
        history.turns.map((turn) => ({ role: turn.role, content: turn.content })),
        reserved.answer,
        mode === 'repair' ? 'repair' : 'append'
      );
      const reply = await requestInterviewReply({
        model: aiConfig.model,
        apiKey: aiConfig.apiKey,
        systemPrompt: template.systemPrompt,
        conversation,
        timeoutMs: aiConfig.timeoutMs,
        maxRetries: aiConfig.maxRetries,
        retryBaseMs: aiConfig.retryBaseMs,
      });
      if (!reply.ok) {
        await markClaimFailed(writer, session.id, clientTurnId, reserved.claimedAt);
        await markSessionFailed(writer, session.id);
        return fail(
          reply.httpStatus,
          reply.code,
          CLIENT_MESSAGE[reply.code] ?? CLIENT_MESSAGE['INTERVIEW_AI_UNAVAILABLE'],
          sessionId
        );
      }
      const noted = await noteAssistantText(writer, session.id, clientTurnId, reserved.claimedAt, reply.text);
      if (!noted) return fail(409, 'TURN_IN_PROGRESS', CLIENT_MESSAGE['TURN_IN_PROGRESS'], sessionId);
      assistantText = reply.text;
    }

    let turns = history.turns;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const again = await loadTurns(userClient, session.id);
        if (!again.ok) return again.response;
        turns = again.turns;
      }
      const plan = findSavedAnswer(turns, clientTurnId);
      if (plan.type === 'replay') {
        await markClaimCompleted(writer, session.id, clientTurnId, plan.assistant.content);
        return replayResponse(plan);
      }
      if (plan.type === 'blocked') break;
      mode = plan.type;
      const saved = await insertTurns(
        writer,
        rowsForSuccessfulReply({
          sessionId: session.id,
          answer: reserved.answer,
          assistant: assistantText,
          mode,
          nextSeq: nextSequence(turns),
          clientTurnId,
        })
      );
      if (saved.ok) {
        const assistant = saved.turns.find((turn) => turn.role === 'assistant');
        if (!assistant) return fail(500, 'NOT_SAVED', 'Your answer was not saved. Please try again.', sessionId);
        await markClaimCompleted(writer, session.id, clientTurnId, assistant.content);
        return json({ assistantMessage: assistant.content, replayed: false, turns: saved.turns });
      }
      if (saved.conflict === 'client_turn' || saved.conflict === 'seq') continue;
      return fail(500, 'NOT_SAVED', 'Your answer was not saved. Please try again.', sessionId);
    }
    return fail(
      409,
      'TURN_CONFLICT',
      'That answer conflicted with another submission. Refresh the conversation and try again.',
      sessionId
    );
  } catch {
    return fail(500, 'UNEXPECTED', 'Could not send your answer. Please try again.');
  }
});

function replayResponse(plan: Extract<AnswerPlan, { type: 'replay' }>): Response {
  return json({
    assistantMessage: plan.assistant.content,
    replayed: true,
    turns: [publicTurn(plan.user), publicTurn(plan.assistant)],
  });
}

async function insertTurns(
  userClient: SupabaseClient,
  rows: { session_id: string; role: 'user' | 'assistant'; content: string; seq: number; client_turn_id: string | null }[]
): Promise<{ ok: true; turns: StoredTurn[] } | { ok: false; conflict: 'client_turn' | 'seq' | null }> {
  const { data, error } = await userClient
    .from('interview_turns')
    .insert(rows)
    .select('id, role, content, seq, created_at, client_turn_id');
  if (error) {
    if (error.code !== '23505') return { ok: false, conflict: null };
    const kind = classifyUniqueViolation(`${error.message ?? ''} ${error.details ?? ''}`);
    return { ok: false, conflict: kind ?? 'seq' };
  }
  const turns = parseStoredTurnList(data ?? []);
  if (!turns || !savedRowsMatch(rows, turns)) return { ok: false, conflict: null };
  return { ok: true, turns: turns.sort((left, right) => left.seq - right.seq) };
}

function savedRowsMatch(
  expected: { role: 'user' | 'assistant'; content: string; seq: number; client_turn_id: string | null }[],
  saved: StoredTurn[]
): boolean {
  if (saved.length !== expected.length) return false;
  const bySeq = new Map(saved.map((turn) => [turn.seq, turn]));
  return expected.every((row) => {
    const turn = bySeq.get(row.seq);
    return turn?.role === row.role && turn.content === row.content && turn.clientTurnId === row.client_turn_id;
  });
}

async function loadTurns(
  userClient: SupabaseClient,
  sessionId: string
): Promise<{ ok: true; turns: StoredTurn[] } | { ok: false; response: Response }> {
  const { data, error } = await userClient
    .from('interview_turns')
    .select('id, role, content, seq, created_at, client_turn_id')
    .eq('session_id', sessionId)
    .order('seq', { ascending: true });
  if (error) {
    return { ok: false, response: fail(500, 'TURN_LOAD_FAILED', 'Could not load this interview.', sessionId) };
  }
  const turns = parseStoredTurnList(data ?? []);
  if (!turns) {
    return { ok: false, response: fail(500, 'TURN_LOAD_FAILED', 'Could not load this interview.', sessionId) };
  }
  return { ok: true, turns };
}

async function readSessionTemplate(
  userClient: SupabaseClient,
  session: {
    templateId: string;
    promptVersion: string;
    templateVersionId: string | null;
  }
): Promise<{ systemPrompt: string; durationMinutes: number } | null> {
  const fromSnapshot = await versionFacts(userClient, session);
  if (fromSnapshot) return fromSnapshot;

  const privileged = serviceDb();
  if (privileged) {
    const privilegedSnapshot = await versionFacts(privileged, session);
    if (privilegedSnapshot) return privilegedSnapshot;
  }

  // Legacy sessions (slug:createdAt prompt_version, no template_version_id).
  const visible = await liveTemplateFacts(userClient, session.templateId);
  if (visible) return visible;
  if (!privileged) return null;
  return liveTemplateFacts(privileged, session.templateId);
}

async function versionFacts(
  client: SupabaseClient,
  session: {
    templateId: string;
    promptVersion: string;
    templateVersionId: string | null;
  }
): Promise<{ systemPrompt: string; durationMinutes: number } | null> {
  if (session.templateVersionId) {
    const { data, error } = await client
      .from('interview_template_versions')
      .select('system_prompt, duration_minutes')
      .eq('id', session.templateVersionId)
      .maybeSingle();
    if (!error) {
      const facts = pickTemplateFacts(data, positiveDurationMinutes);
      if (facts) return facts;
    }
  }

  const version = parseTemplateVersionNumber(session.promptVersion);
  if (version === null) return null;

  const { data, error } = await client
    .from('interview_template_versions')
    .select('system_prompt, duration_minutes')
    .eq('template_id', session.templateId)
    .eq('version', version)
    .maybeSingle();
  if (error) return null;
  return pickTemplateFacts(data, positiveDurationMinutes);
}

async function liveTemplateFacts(
  client: SupabaseClient,
  templateId: string
): Promise<{ systemPrompt: string; durationMinutes: number } | null> {
  const { data, error } = await client
    .from('interview_templates')
    .select('system_prompt, duration_minutes')
    .eq('id', templateId)
    .maybeSingle();
  if (error) return null;
  return pickTemplateFacts(data, positiveDurationMinutes);
}

function serviceDb(): SupabaseClient | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type ReservedClaim =
  | { kind: 'error' }
  | { kind: 'wait' }
  | { kind: 'replay'; plan: Extract<AnswerPlan, { type: 'replay' }> }
  | { kind: 'owned'; answer: string; assistantText: string | null; claimedAt: string };

async function reserveClaim(
  writer: SupabaseClient,
  input: { sessionId: string; userId: string; clientTurnId: string; answer: string }
): Promise<ReservedClaim> {
  const claimedAt = new Date().toISOString();
  const inserted = await writer.from('interview_turn_claims').insert({
    session_id: input.sessionId,
    client_turn_id: input.clientTurnId,
    user_id: input.userId,
    answer: input.answer,
    status: 'processing',
    claimed_at: claimedAt,
  }).select('answer, status, assistant_text, claimed_at').maybeSingle();

  if (!inserted.error && inserted.data) {
    return { kind: 'owned', answer: input.answer, assistantText: null, claimedAt };
  }
  if (inserted.error?.code !== '23505') return { kind: 'error' };

  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readClaim(writer, input.sessionId, input.clientTurnId);
    if (!current) return { kind: 'error' };
    const decision = decideClaim(current.state, Date.now());
    if (decision === 'wait') return { kind: 'wait' };
    const taken = await writer
      .from('interview_turn_claims')
      .update({ status: 'processing', claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('session_id', input.sessionId)
      .eq('client_turn_id', input.clientTurnId)
      .eq('claimed_at', current.claimedAt)
      .select('answer, status, assistant_text, claimed_at')
      .maybeSingle();
    if (taken.error || !taken.data) continue;
    const row = asClaim(taken.data);
    if (!row) return { kind: 'error' };
    if (decision === 'resume' && row.state.assistantText) {
      return {
        kind: 'owned',
        answer: row.state.answer,
        assistantText: row.state.assistantText,
        claimedAt: row.claimedAt,
      };
    }
    return { kind: 'owned', answer: row.state.answer, assistantText: null, claimedAt: row.claimedAt };
  }
  return { kind: 'wait' };
}

async function readClaim(
  writer: SupabaseClient,
  sessionId: string,
  clientTurnId: string
): Promise<{ state: { answer: string; status: 'processing' | 'completed' | 'failed'; assistantText: string | null; claimedAtMs: number }; claimedAt: string } | null> {
  const { data, error } = await writer
    .from('interview_turn_claims')
    .select('answer, status, assistant_text, claimed_at')
    .eq('session_id', sessionId)
    .eq('client_turn_id', clientTurnId)
    .maybeSingle();
  if (error || !data) return null;
  return asClaim(data);
}

function asClaim(value: unknown): {
  state: { answer: string; status: 'processing' | 'completed' | 'failed'; assistantText: string | null; claimedAtMs: number };
  claimedAt: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const status = row['status'];
  const claimedAt = row['claimed_at'];
  if (
    typeof row['answer'] !== 'string' ||
    (status !== 'processing' && status !== 'completed' && status !== 'failed') ||
    typeof claimedAt !== 'string' ||
    !Number.isFinite(Date.parse(claimedAt))
  ) {
    return null;
  }
  const assistant = row['assistant_text'];
  return {
    claimedAt,
    state: {
      answer: row['answer'],
      status,
      assistantText: typeof assistant === 'string' && assistant.trim() ? assistant : null,
      claimedAtMs: Date.parse(claimedAt),
    },
  };
}

async function noteAssistantText(
  writer: SupabaseClient,
  sessionId: string,
  clientTurnId: string,
  claimedAt: string,
  assistantText: string
): Promise<boolean> {
  const { data, error } = await writer
    .from('interview_turn_claims')
    .update({ assistant_text: assistantText, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('client_turn_id', clientTurnId)
    .eq('claimed_at', claimedAt)
    .select('client_turn_id')
    .maybeSingle();
  return !error && !!data;
}

/** Ends an in-progress session after the AI cannot reply. Saved turns are left in place. */
async function markSessionFailed(writer: SupabaseClient, sessionId: string): Promise<void> {
  const { error } = await writer
    .from('interview_sessions')
    .update({ status: 'failed', ended_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('status', 'in_progress');
  if (error) {
    console.error(JSON.stringify({
      source: 'interview-turn',
      code: 'FAIL_SESSION_UPDATE_FAILED',
      dbCode: error.code ?? null,
      sessionId,
    }));
  }
}

async function markClaimFailed(
  writer: SupabaseClient,
  sessionId: string,
  clientTurnId: string,
  claimedAt: string
): Promise<void> {
  await writer
    .from('interview_turn_claims')
    .update({ status: 'failed', assistant_text: null, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('client_turn_id', clientTurnId)
    .eq('claimed_at', claimedAt);
}

async function markClaimCompleted(
  writer: SupabaseClient,
  sessionId: string,
  clientTurnId: string,
  assistantText: string
): Promise<void> {
  await writer
    .from('interview_turn_claims')
    .update({ status: 'completed', assistant_text: assistantText, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('client_turn_id', clientTurnId);
}

async function finishIfExpired(
  userClient: SupabaseClient,
  sessionId: string
): Promise<{ ok: true; status: 'in_progress' | 'completed' | 'failed'; timeUp: boolean } | { ok: false }> {
  const { data, error } = await userClient.rpc('finish_own_interview_session', {
    p_session_id: sessionId,
    p_mode: 'expired',
  });
  if (error) {
    console.error(JSON.stringify({
      source: 'interview-turn',
      code: 'EXPIRE_UPDATE_FAILED',
      dbCode: error.code ?? null,
      sessionId,
    }));
    return { ok: false };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return { ok: false };
  const status = row.status;
  const timeUp = row.time_up;
  if ((status !== 'in_progress' && status !== 'completed' && status !== 'failed') || typeof timeUp !== 'boolean') {
    return { ok: false };
  }
  if (timeUp && status === 'in_progress') return { ok: false };
  return { ok: true, status, timeUp };
}

function readAiConfig():
  | {
      ok: true;
      model: string;
      apiKey: string;
      timeoutMs: number;
      maxRetries: number;
      retryBaseMs: number;
    }
  | { ok: false; missing: string[] } {
  const providerRaw = (Deno.env.get('INTERVIEW_AI_PROVIDER') ?? '').trim().toLowerCase();
  const configuredModel = (Deno.env.get('INTERVIEW_AI_MODEL') ?? '').trim();
  const model = configuredModel || APPROVED_MODEL;
  const missing: string[] = [];
  if (providerRaw !== '' && providerRaw !== 'openai') missing.push('INTERVIEW_AI_PROVIDER');
  if (!MODEL_PATTERN.test(model)) missing.push('INTERVIEW_AI_MODEL');
  const apiKey = (Deno.env.get('OPENAI_API_KEY') ?? '').trim();
  if (!apiKey) missing.push('OPENAI_API_KEY');
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    model,
    apiKey,
    timeoutMs: boundedInt(Deno.env.get('INTERVIEW_AI_TIMEOUT_MS'), 45_000, 1_000, 45_000),
    maxRetries: boundedInt(Deno.env.get('INTERVIEW_AI_MAX_RETRIES'), 2, 0, 2),
    retryBaseMs: boundedInt(Deno.env.get('INTERVIEW_AI_RETRY_BASE_MS'), 1_000, 100, 10_000),
  };
}

function asSession(value: unknown): {
  id: string;
  userId: string;
  status: string;
  templateId: string;
  promptVersion: string;
  templateVersionId: string | null;
  startedAt: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row['id'] !== 'string' ||
    typeof row['user_id'] !== 'string' ||
    typeof row['status'] !== 'string' ||
    typeof row['template_id'] !== 'string' ||
    typeof row['prompt_version'] !== 'string' ||
    typeof row['started_at'] !== 'string'
  ) {
    return null;
  }
  const versionId = row['template_version_id'];
  return {
    id: row['id'],
    userId: row['user_id'],
    status: row['status'],
    templateId: row['template_id'],
    promptVersion: row['prompt_version'],
    templateVersionId: typeof versionId === 'string' ? versionId : null,
    startedAt: row['started_at'],
  };
}

function publicTurn(turn: StoredTurn): {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  seq: number;
  createdAt: string;
} {
  return {
    id: turn.id,
    role: turn.role,
    content: turn.content,
    seq: turn.seq,
    createdAt: turn.createdAt,
  };
}

async function readBody(req: Request): Promise<
  { ok: true; value: Record<string, unknown> } | { ok: false; response: Response }
> {
  try {
    const value: unknown = await req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, response: fail(400, 'INVALID_INPUT', 'A valid interview session and answer are required.') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: fail(400, 'INVALID_INPUT', 'The request could not be read.') };
  }
}

async function requireUser(req: Request): Promise<
  { ok: true; userClient: SupabaseClient; userId: string } | { ok: false; response: Response }
> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return { ok: false, response: fail(401, 'UNAUTHORIZED', 'Sign in to continue.') };

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !anonKey) return { ok: false, response: fail(500, 'AUTH_UNAVAILABLE', 'Could not verify the signed-in student.') };

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return { ok: false, response: fail(401, 'UNAUTHORIZED', 'Sign in to continue.') };
  return { ok: true, userClient, userId: data.user.id };
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function fail(status: number, code: string, error: string, sessionId?: string): Response {
  if (code !== 'INVALID_INPUT' && code !== 'UNAUTHORIZED') {
    console.error(JSON.stringify({ source: 'interview-turn', code, status, sessionId: sessionId ?? null }));
  }
  return json({ error, code }, status);
}
