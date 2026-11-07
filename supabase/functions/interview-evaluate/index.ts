import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  EVAL_VERSION,
  MAX_EVALUATION_SCORES,
  aggregateOverallScore,
  buildEvaluationPrompt,
  codingCompetencyFromSessionRow,
  competenciesForTemplate,
  formatTranscript,
  mergeCodingCompetency,
  parseEvaluationPayload,
  planEvaluation,
  resolvePracticeTips,
  requestEvaluationReply,
  type SessionCodingRow,
  type TranscriptTurn,
} from '../_shared/interview-evaluate-policy.ts';
import { normalizeSessionId } from '../_shared/interview-turn-policy.ts';

/**
 * interview-evaluate
 *
 * Secrets are the same INT-005 function secrets. The browser never receives them.
 * OPENAI_API_KEY, INTERVIEW_AI_MODEL, optional INTERVIEW_AI_PROVIDER,
 * INTERVIEW_AI_TIMEOUT_MS, INTERVIEW_AI_MAX_RETRIES, INTERVIEW_AI_RETRY_BASE_MS.
 *
 * The service role is used only after the caller is authenticated, has
 * interview.access, and owns the session. It claims the evaluation, reads the
 * template rubric, and writes scores. A provider failure leaves the interview
 * completed and marks evaluation_status failed so a later retry can claim it.
 * overall_score is computed in apply_interview_evaluation from stored competency
 * scores. Any score in the request body is ignored.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;
const APPROVED_MODEL = 'gpt-6-luna';

const CLIENT_MESSAGE: Record<string, string> = {
  INTERVIEW_AI_TIMEOUT: 'Evaluation is taking too long. Your interview is saved. You can try again.',
  INTERVIEW_AI_UNAVAILABLE: 'Evaluation is temporarily unavailable. Your interview is saved.',
  INTERVIEW_AI_RATE_LIMIT: 'High demand right now. Your interview is saved. Please try again shortly.',
  AI_NOT_CONFIGURED: 'Evaluation is not configured yet. Your interview is saved.',
  INVALID_EVALUATION: 'The evaluation could not be read. Your interview is saved. You can try again.',
  NOT_SAVED: 'The evaluation could not be saved. Your interview is saved. You can try again.',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST to evaluate an interview.');

  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;
    const { userClient, userId } = auth;

    const body = await readBody(req);
    if (!body.ok) return body.response;
    const sessionId = normalizeSessionId(body.value['sessionId']);
    if (!sessionId) return fail(400, 'INVALID_INPUT', 'A valid interview session is required.');

    const allowed = await userClient.rpc('has_permission', { perm: 'interview.access' });
    if (allowed.error) return fail(500, 'PERMISSION_CHECK_FAILED', 'Could not verify interview access.');
    if (allowed.data !== true) return fail(403, 'FORBIDDEN', 'You do not have access to interviews.');

    const sessionResult = await userClient
      .from('interview_sessions')
      .select('id, user_id, status, template_id, evaluation_status, eval_version, evaluation_claimed_at, overall_score, evaluation_summary, evaluation_strengths, evaluation_improvements, evaluation_tips, evaluated_at')
      .eq('id', sessionId)
      .maybeSingle();
    if (sessionResult.error) return fail(500, 'SESSION_LOAD_FAILED', 'Could not open this interview.', sessionId);
    const session = asSession(sessionResult.data);
    if (!session || session.userId !== userId) {
      return fail(404, 'NOT_FOUND', 'This interview session could not be opened.');
    }

    const history = await loadTurns(userClient, session.id);
    if (!history.ok) return history.response;
    const transcript = formatTranscript(history.turns);
    if (session.evaluationStatus !== 'completed' && !transcript.ok) {
      if (transcript.reason === 'empty_transcript') {
        return fail(422, 'EMPTY_TRANSCRIPT', 'This interview has no conversation to evaluate.', sessionId);
      }
      if (transcript.reason === 'transcript_too_large') {
        return fail(422, 'TRANSCRIPT_TOO_LARGE', 'This interview is too long to evaluate in one pass.', sessionId);
      }
      return fail(422, 'INCOMPLETE_TRANSCRIPT', 'This interview needs both questions and answers before it can be evaluated.', sessionId);
    }
    const plan = planEvaluation({
      sessionStatus: session.status,
      evaluationStatus: session.evaluationStatus,
      storedVersion: session.evalVersion,
      requestedVersion: EVAL_VERSION,
      claimedAtMs: session.claimedAtMs,
      nowMs: Date.now(),
      userTurns: transcript.ok ? transcript.userTurns : 1,
      assistantTurns: transcript.ok ? transcript.assistantTurns : 1,
      transcriptChars: transcript.ok ? transcript.text.length : 0,
    });

    if (plan.action === 'not_completed') {
      return fail(409, 'SESSION_NOT_COMPLETED', 'Finish the interview before requesting evaluation.', sessionId);
    }
    if (plan.action === 'empty_transcript') {
      return fail(422, 'EMPTY_TRANSCRIPT', 'This interview has no conversation to evaluate.', sessionId);
    }
    if (plan.action === 'incomplete_transcript') {
      return fail(422, 'INCOMPLETE_TRANSCRIPT', 'This interview needs both questions and answers before it can be evaluated.', sessionId);
    }
    if (plan.action === 'transcript_too_large') {
      return fail(422, 'TRANSCRIPT_TOO_LARGE', 'This interview is too long to evaluate in one pass.', sessionId);
    }
    if (plan.action === 'return_existing' || plan.action === 'preserve_history') {
      const stored = await loadStored(userClient, session);
      if (!stored) return fail(500, 'NOT_SAVED', 'The saved evaluation could not be read.', sessionId);
      return json(stored);
    }
    if (plan.action === 'in_progress') {
      return fail(409, 'EVALUATION_IN_PROGRESS', 'Evaluation is still running.', sessionId);
    }
    if (!transcript.ok) {
      return fail(422, 'INCOMPLETE_TRANSCRIPT', 'This interview needs both questions and answers before it can be evaluated.', sessionId);
    }

    const writer = serviceDb();
    if (!writer) return fail(500, 'NOT_SAVED', CLIENT_MESSAGE['NOT_SAVED'], sessionId);
    const claim = await claimEvaluation(writer, session.id);
    if (!claim.ok) return fail(500, 'NOT_SAVED', CLIENT_MESSAGE['NOT_SAVED'], sessionId);
    if (claim.outcome === 'already_completed' || claim.outcome === 'version_preserved') {
      const stored = await loadStored(userClient, session);
      if (!stored) return fail(500, 'NOT_SAVED', 'The saved evaluation could not be read.', sessionId);
      return json(stored);
    }
    if (claim.outcome === 'in_progress' || claim.outcome === 'stale_claim') {
      return fail(409, 'EVALUATION_IN_PROGRESS', 'Evaluation is still running.', sessionId);
    }
    if (claim.outcome === 'not_completed') {
      return fail(409, 'SESSION_NOT_COMPLETED', 'Finish the interview before requesting evaluation.', sessionId);
    }
    if (claim.outcome !== 'claimed' || !claim.claimedAt) {
      return fail(404, 'NOT_FOUND', 'This interview session could not be opened.');
    }

    const template = await readTemplate(writer, session.templateId);
    if (!template) {
      await markFailed(writer, session.id, claim.claimedAt);
      return fail(500, 'NOT_SAVED', CLIENT_MESSAGE['NOT_SAVED'], sessionId);
    }

    const competencies = competenciesForTemplate(template.kind, template.rubric);
    const prompt = buildEvaluationPrompt({
      kind: template.kind,
      title: template.title,
      durationMinutes: template.durationMinutes,
      competencies,
      context: template.context,
      transcript: transcript.text,
    });
    const aiConfig = readAiConfig();
    if (!aiConfig.ok) {
      await markFailed(writer, session.id, claim.claimedAt);
      console.error(JSON.stringify({ source: 'interview-evaluate', code: 'AI_NOT_CONFIGURED', missing: aiConfig.missing }));
      return fail(503, 'AI_NOT_CONFIGURED', CLIENT_MESSAGE['AI_NOT_CONFIGURED'], sessionId);
    }

    const reply = await requestEvaluationReply({
      model: aiConfig.model,
      apiKey: aiConfig.apiKey,
      system: prompt.system,
      user: prompt.user,
      timeoutMs: aiConfig.timeoutMs,
      maxRetries: aiConfig.maxRetries,
      retryBaseMs: aiConfig.retryBaseMs,
    });
    if (!reply.ok) {
      await markFailed(writer, session.id, claim.claimedAt);
      return fail(reply.httpStatus, reply.code, CLIENT_MESSAGE[reply.code] ?? CLIENT_MESSAGE['INTERVIEW_AI_UNAVAILABLE'], sessionId);
    }

    const parsed = parseEvaluationPayload(reply.text, competencies);
    if (!parsed.ok) {
      await markFailed(writer, session.id, claim.claimedAt);
      console.error(JSON.stringify({ source: 'interview-evaluate', code: 'INVALID_EVALUATION', reason: parsed.reason, sessionId }));
      return fail(502, 'INVALID_EVALUATION', CLIENT_MESSAGE['INVALID_EVALUATION'], sessionId);
    }

    // INT-013: fold persisted public-test coding into interview_scores (not an AI guess).
    const codingRow = await loadSessionCoding(writer, session.id);
    const mergedCompetencies = mergeCodingCompetency(
      parsed.evaluation.competencies,
      codingCompetencyFromSessionRow(codingRow)
    );
    if (mergedCompetencies.length > MAX_EVALUATION_SCORES) {
      await markFailed(writer, session.id, claim.claimedAt);
      console.error(JSON.stringify({
        source: 'interview-evaluate',
        code: 'TOO_MANY_COMPETENCIES',
        count: mergedCompetencies.length,
        max: MAX_EVALUATION_SCORES,
        sessionId,
      }));
      return fail(
        502,
        'INVALID_EVALUATION',
        'The evaluation could not be saved because too many competency scores were produced. Your interview is saved. You can try again.',
        sessionId
      );
    }

    const tips = resolvePracticeTips({
      rawTips: parsed.evaluation.modelTips,
      competencies: mergedCompetencies,
      strengths: parsed.evaluation.strengths,
      improvements: parsed.evaluation.improvements,
    });
    if (tips.length < 3 || tips.length > 5) {
      await markFailed(writer, session.id, claim.claimedAt);
      return fail(502, 'INVALID_EVALUATION', CLIENT_MESSAGE['INVALID_EVALUATION'], sessionId);
    }

    const saved = await applyEvaluation(writer, {
      sessionId: session.id,
      claimedAt: claim.claimedAt,
      summary: parsed.evaluation.summary,
      strengths: parsed.evaluation.strengths,
      improvements: parsed.evaluation.improvements,
      tips,
      scores: mergedCompetencies.map((item) => ({
        competency: item.competency,
        score: item.score,
        rationale: item.feedback,
        evidence: item.evidence,
      })),
    });
    if (!saved.ok) {
      if (saved.code === 'EVALUATION_IN_PROGRESS') {
        return fail(saved.status, saved.code, 'Evaluation is still running.', sessionId);
      }
      await markFailed(writer, session.id, claim.claimedAt);
      return fail(saved.status, saved.code, CLIENT_MESSAGE[saved.code] ?? CLIENT_MESSAGE['NOT_SAVED'], sessionId);
    }
    return json(saved.body);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    console.error(JSON.stringify({ source: 'interview-evaluate', code: 'UNHANDLED', name }));
    return fail(500, 'NOT_SAVED', CLIENT_MESSAGE['NOT_SAVED']);
  }
});

function readAiConfig():
  | { ok: true; model: string; apiKey: string; timeoutMs: number; maxRetries: number; retryBaseMs: number }
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

async function loadTurns(
  userClient: SupabaseClient,
  sessionId: string
): Promise<{ ok: true; turns: TranscriptTurn[] } | { ok: false; response: Response }> {
  const { data, error } = await userClient
    .from('interview_turns')
    .select('role, content, seq, created_at')
    .eq('session_id', sessionId)
    .order('seq', { ascending: true });
  if (error) return { ok: false, response: fail(500, 'TRANSCRIPT_LOAD_FAILED', 'Could not read this interview.', sessionId) };
  const turns: TranscriptTurn[] = [];
  for (const item of data ?? []) {
    const turn = asTurn(item);
    if (turn) turns.push(turn);
  }
  turns.sort((left, right) => left.seq - right.seq);
  return { ok: true, turns };
}

/** Optional INT-013 coding attempt for this session. Missing row means coding was not run. */
async function loadSessionCoding(
  writer: SupabaseClient,
  sessionId: string
): Promise<SessionCodingRow | null> {
  const { data, error } = await writer
    .from('interview_session_coding')
    .select('language, code, passed_count, total_count, all_passed, results_json')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({
      source: 'interview-evaluate',
      code: 'CODING_LOAD_FAILED',
      dbCode: error.code ?? null,
      sessionId,
    }));
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  return {
    language: typeof row['language'] === 'string' ? row['language'] : null,
    code: typeof row['code'] === 'string' ? row['code'] : null,
    passed_count: typeof row['passed_count'] === 'number' ? row['passed_count'] : null,
    total_count: typeof row['total_count'] === 'number' ? row['total_count'] : null,
    all_passed: typeof row['all_passed'] === 'boolean' ? row['all_passed'] : null,
    results_json: row['results_json'],
  };
}

async function loadStored(
  userClient: SupabaseClient,
  session: SessionRow,
  reload = true
): Promise<Record<string, unknown> | null> {
  const version = session.evalVersion;
  if (session.evaluationStatus !== 'completed' || !version || session.overallScore === null || !session.summary) {
    if (!reload) return null;
    const again = await userClient
      .from('interview_sessions')
      .select('evaluation_status, eval_version, overall_score, evaluation_summary, evaluation_strengths, evaluation_improvements, evaluation_tips, evaluated_at')
      .eq('id', session.id)
      .maybeSingle();
    if (again.error || !again.data) return null;
    const refreshed = asSession({ ...sessionSource(session), ...again.data });
    if (!refreshed) return null;
    return loadStored(userClient, refreshed, false);
  }

  const { data, error } = await userClient
    .from('interview_scores')
    .select('competency, score, rationale, evidence, eval_version, created_at')
    .eq('session_id', session.id)
    .eq('eval_version', version)
    .order('created_at', { ascending: true });
  if (error || !data) return null;
  return bodyFromParts({
    evalVersion: version,
    overallScore: session.overallScore,
    summary: session.summary,
    strengths: session.strengths,
    improvements: session.improvements,
    tips: session.tips,
    evaluatedAt: session.evaluatedAt,
    scores: data,
  });
}

async function claimEvaluation(
  writer: SupabaseClient,
  sessionId: string
): Promise<{ ok: true; outcome: string; claimedAt: string | null } | { ok: false }> {
  const { data, error } = await writer.rpc('claim_interview_evaluation', {
    p_session_id: sessionId,
    p_eval_version: EVAL_VERSION,
  });
  if (error) {
    console.error(JSON.stringify({ source: 'interview-evaluate', code: 'CLAIM_FAILED', dbCode: error.code ?? null, sessionId }));
    return { ok: false };
  }
  const row = firstRow(data);
  const outcome = typeof row?.['outcome'] === 'string' ? row['outcome'] : '';
  const claimedAt = typeof row?.['claimed_at'] === 'string' ? row['claimed_at'] : null;
  if (!outcome) return { ok: false };
  return { ok: true, outcome, claimedAt };
}

async function markFailed(writer: SupabaseClient, sessionId: string, claimedAt: string): Promise<void> {
  const { error } = await writer.rpc('fail_interview_evaluation', {
    p_session_id: sessionId,
    p_eval_version: EVAL_VERSION,
    p_claimed_at: claimedAt,
  });
  if (error) {
    console.error(JSON.stringify({ source: 'interview-evaluate', code: 'FAIL_MARK_FAILED', dbCode: error.code ?? null, sessionId }));
  }
}

async function applyEvaluation(
  writer: SupabaseClient,
  input: {
    sessionId: string;
    claimedAt: string;
    summary: string;
    strengths: string[];
    improvements: string[];
    tips: string[];
    scores: { competency: string; score: number; rationale: string; evidence: string }[];
  }
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; code: string }> {
  const expected = aggregateOverallScore(input.scores.map((score) => score.score));
  if (expected === null || input.tips.length < 3 || input.tips.length > 5) {
    return { ok: false, status: 502, code: 'INVALID_EVALUATION' };
  }
  const { data, error } = await writer.rpc('apply_interview_evaluation', {
    p_session_id: input.sessionId,
    p_eval_version: EVAL_VERSION,
    p_summary: input.summary,
    p_strengths: input.strengths,
    p_improvements: input.improvements,
    p_scores: input.scores,
    p_claimed_at: input.claimedAt,
    p_tips: input.tips,
  });
  if (error) {
    console.error(JSON.stringify({
      source: 'interview-evaluate',
      code: 'APPLY_FAILED',
      dbCode: error.code ?? null,
      sessionId: input.sessionId,
    }));
    return { ok: false, status: 500, code: 'NOT_SAVED' };
  }
  const row = firstRow(data);
  const outcome = typeof row?.['outcome'] === 'string' ? row['outcome'] : '';
  if (outcome === 'stale_claim' || outcome === 'in_progress') {
    return { ok: false, status: 409, code: 'EVALUATION_IN_PROGRESS' };
  }
  if (outcome !== 'completed' && outcome !== 'already_completed' && outcome !== 'version_preserved') {
    return { ok: false, status: 500, code: 'NOT_SAVED' };
  }
  const body = bodyFromParts({
    evalVersion: typeof row?.['eval_version'] === 'string' ? row['eval_version'] : '',
    overallScore: numeric(row?.['overall_score']),
    summary: typeof row?.['evaluation_summary'] === 'string' ? row['evaluation_summary'] : '',
    strengths: row?.['evaluation_strengths'],
    improvements: row?.['evaluation_improvements'],
    tips: row?.['evaluation_tips'],
    evaluatedAt: typeof row?.['evaluated_at'] === 'string' ? row['evaluated_at'] : null,
    requireTips: outcome === 'completed',
    scores: row?.['scores'],
  });
  if (!body) return { ok: false, status: 500, code: 'NOT_SAVED' };
  const persisted = body['overallScore'];
  if (outcome === 'completed' && persisted !== expected) {
    console.error(JSON.stringify({
      source: 'interview-evaluate',
      code: 'SCORE_MISMATCH',
      sessionId: input.sessionId,
    }));
  }
  return { ok: true, body };
}

async function readTemplate(
  writer: SupabaseClient,
  templateId: string
): Promise<{ title: string; kind: string; durationMinutes: number; rubric: unknown; context: string } | null> {
  const { data, error } = await writer
    .from('interview_templates')
    .select('title, kind, duration_minutes, rubric_json, system_prompt')
    .eq('id', templateId)
    .maybeSingle();
  if (error || !data) return null;
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const kind = typeof data.kind === 'string' ? data.kind : '';
  const duration = typeof data.duration_minutes === 'number' ? data.duration_minutes : Number(data.duration_minutes);
  const context = typeof data.system_prompt === 'string' ? data.system_prompt.trim() : '';
  if (!title || !kind || !Number.isInteger(duration) || duration <= 0 || !context) return null;
  return { title, kind, durationMinutes: duration, rubric: data.rubric_json, context };
}

function bodyFromParts(input: {
  evalVersion: string;
  overallScore: number | null;
  summary: string;
  strengths: unknown;
  improvements: unknown;
  tips?: unknown;
  evaluatedAt: string | null;
  scores: unknown;
  requireTips?: boolean;
}): Record<string, unknown> | null {
  const strengths = textList(input.strengths);
  const improvements = textList(input.improvements);
  const competencies = scoreList(input.scores);
  const tips = practiceTips(input.tips);
  if (!input.evalVersion || input.overallScore === null || !input.summary.trim() || !strengths || !improvements || !competencies) {
    return null;
  }
  if (input.requireTips && tips.length < 3) return null;
  const mean = aggregateOverallScore(competencies.map((item) => item['score'] as number));
  if (mean === null || Math.abs(mean - input.overallScore) > 0.011) return null;
  return {
    status: 'completed',
    preserved: input.evalVersion !== EVAL_VERSION,
    evalVersion: input.evalVersion,
    overallScore: input.overallScore,
    summary: input.summary.trim(),
    strengths,
    improvements,
    tips,
    evaluatedAt: input.evaluatedAt,
    competencies,
  };
}

interface SessionRow {
  id: string;
  userId: string;
  status: string;
  templateId: string;
  evaluationStatus: string | null;
  evalVersion: string | null;
  claimedAtMs: number | null;
  overallScore: number | null;
  summary: string | null;
  strengths: unknown;
  improvements: unknown;
  tips: unknown;
  evaluatedAt: string | null;
}

function asSession(value: unknown): SessionRow | null {
  if (!isRecord(value)) return null;
  if (
    typeof value['id'] !== 'string' ||
    typeof value['user_id'] !== 'string' ||
    typeof value['status'] !== 'string' ||
    typeof value['template_id'] !== 'string'
  ) {
    return null;
  }
  const claimedAt = value['evaluation_claimed_at'];
  const claimedAtMs = typeof claimedAt === 'string' ? Date.parse(claimedAt) : null;
  return {
    id: value['id'],
    userId: value['user_id'],
    status: value['status'],
    templateId: value['template_id'],
    evaluationStatus: typeof value['evaluation_status'] === 'string' ? value['evaluation_status'] : null,
    evalVersion: typeof value['eval_version'] === 'string' ? value['eval_version'] : null,
    claimedAtMs: claimedAtMs !== null && Number.isFinite(claimedAtMs) ? claimedAtMs : null,
    overallScore: numeric(value['overall_score']),
    summary: typeof value['evaluation_summary'] === 'string' ? value['evaluation_summary'] : null,
    strengths: value['evaluation_strengths'],
    improvements: value['evaluation_improvements'],
    tips: value['evaluation_tips'],
    evaluatedAt: typeof value['evaluated_at'] === 'string' ? value['evaluated_at'] : null,
  };
}

function sessionSource(session: SessionRow): Record<string, unknown> {
  return {
    id: session.id,
    user_id: session.userId,
    status: session.status,
    template_id: session.templateId,
  };
}

function asTurn(value: unknown): TranscriptTurn | null {
  if (!isRecord(value)) return null;
  const role = value['role'];
  const content = value['content'];
  const seq = typeof value['seq'] === 'number' ? value['seq'] : Number(value['seq']);
  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null;
  if (!Number.isInteger(seq) || seq <= 0) return null;
  const createdAt = value['created_at'];
  return {
    role,
    content,
    seq,
    createdAt: typeof createdAt === 'string' ? createdAt : undefined,
  };
}

function scoreList(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const scores: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['competency'] !== 'string') return null;
    const score = numeric(item['score']);
    const feedback = typeof item['feedback'] === 'string' ? item['feedback'].trim() : typeof item['rationale'] === 'string' ? item['rationale'].trim() : '';
    const evidence = typeof item['evidence'] === 'string' ? item['evidence'].trim() : '';
    if (score === null || !feedback) return null;
    scores.push({ competency: item['competency'], score, feedback, evidence });
  }
  return scores;
}

function practiceTips(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return [];
    const text = item.trim().replace(/\s+/g, ' ');
    if (!text || text.length > 400) return [];
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
  if (items.length < 3 || items.length > 5) return [];
  return items;
}

function textList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return null;
    items.push(item.trim());
  }
  return items;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 100) / 100;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return isRecord(row) ? row : null;
}

function serviceDb(): SupabaseClient | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function readBody(req: Request): Promise<
  { ok: true; value: Record<string, unknown> } | { ok: false; response: Response }
> {
  try {
    const value: unknown = await req.json();
    if (!isRecord(value)) return { ok: false, response: fail(400, 'INVALID_INPUT', 'A valid interview session is required.') };
    return { ok: true, value };
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
    console.error(JSON.stringify({ source: 'interview-evaluate', code, status, sessionId: sessionId ?? null }));
  }
  return json({ error, code }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
