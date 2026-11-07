/**
 * INT-013: Run public tests for an in-progress interview coding step.
 * Authz: signed-in student must own the session. Separate from the exam run-code path.
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const JUDGE0_URL = Deno.env.get('JUDGE0_CE_URL')?.trim() ?? 'https://ce.judge0.com';

const LANGUAGE_IDS: Record<string, number> = {
  c: 50,
  cpp: 54,
  'c++': 54,
  java: 62,
  javascript: 63,
  js: 63,
  python: 71,
  py: 71,
};

interface Judge0RunResult {
  passed: boolean;
  actualOutput: string;
  stderr?: string;
  compileOutput?: string;
}

interface CodingProblem {
  enabled?: boolean;
  title?: string;
  prompt?: string;
  description?: string;
  starter_code?: string;
  starterCode?: string;
  language?: string;
  public_test_cases?: Array<{ input?: string; expectedOutput?: string; expected_output?: string }>;
  publicTestCases?: Array<{ input?: string; expectedOutput?: string; expected_output?: string }>;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const sessionId = String(body?.sessionId ?? '').trim();
    const code = String(body?.code ?? '');
    const languageRaw = String(body?.language ?? '').trim().toLowerCase();
    const persist = body?.persist !== false;

    if (!sessionId || !code.trim()) {
      return json({ error: 'sessionId and code are required' }, 400);
    }

    const adminClient = createAdminClient();

    const { data: session, error: sessionError } = await adminClient
      .from('interview_sessions')
      .select('id, user_id, status, template_id, template_version_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (sessionError) {
      console.error('interview-run-code session load failed', sessionError.message);
      return json({ error: 'Could not open this interview.' }, 500);
    }
    if (!session || session.user_id !== auth.userId) {
      return json({ error: 'Interview session not found.' }, 404);
    }
    if (session.status !== 'in_progress') {
      return json({ error: 'This interview is already finished.' }, 409);
    }

    const problem = await loadCodingProblem(adminClient, session);
    if (!problem || problem.enabled !== true) {
      return json({ error: 'This interview has no coding step.' }, 409);
    }

    const langKey = languageRaw || String(problem.language ?? 'javascript').toLowerCase();
    const languageId = LANGUAGE_IDS[langKey] ?? LANGUAGE_IDS.javascript;
    const testCases = problem.public_test_cases ?? problem.publicTestCases ?? [];

    const results = [];
    for (const tc of testCases) {
      const expected = String(tc.expectedOutput ?? tc.expected_output ?? '');
      const input = String(tc.input ?? '');
      const run = await judge0Run(code, languageId, input, expected);
      results.push({
        input,
        expectedOutput: expected,
        actualOutput: run.actualOutput,
        passed: run.passed,
        stderr: run.stderr,
        compileOutput: run.compileOutput,
      });
    }

    const passedCount = results.filter((r) => r.passed).length;
    const total = results.length;
    const allPassed = total > 0 && passedCount === total;

    if (persist) {
      const snapshot = {
        enabled: true,
        title: problem.title ?? 'Coding challenge',
        prompt: problem.prompt ?? problem.description ?? '',
        starter_code: problem.starter_code ?? problem.starterCode ?? '',
        language: langKey,
        public_test_cases: testCases.map((tc) => ({
          input: String(tc.input ?? ''),
          expectedOutput: String(tc.expectedOutput ?? tc.expected_output ?? ''),
        })),
      };

      const { error: upsertError } = await adminClient.from('interview_session_coding').upsert(
        {
          session_id: sessionId,
          language: langKey,
          code,
          passed_count: passedCount,
          total_count: total,
          all_passed: allPassed,
          results_json: results,
          problem_snapshot: snapshot,
          submitted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'session_id' }
      );

      if (upsertError) {
        console.error('interview-run-code persist failed', upsertError.message);
        return json({ error: 'Tests ran, but results could not be saved.' }, 500);
      }
    }

    return json({ results, passedCount, total, allPassed });
  } catch (err) {
    console.error('interview-run-code failed', err);
    return json({ error: err instanceof Error ? err.message : 'Unexpected error' }, 500);
  }
});

async function loadCodingProblem(
  client: SupabaseClient,
  session: { template_id: string; template_version_id: string | null }
): Promise<CodingProblem | null> {
  if (session.template_version_id) {
    const { data } = await client
      .from('interview_template_versions')
      .select('coding_json')
      .eq('id', session.template_version_id)
      .maybeSingle();
    if (data?.coding_json && typeof data.coding_json === 'object') {
      return data.coding_json as CodingProblem;
    }
  }

  const { data: live } = await client
    .from('interview_templates')
    .select('coding_json')
    .eq('id', session.template_id)
    .maybeSingle();
  if (live?.coding_json && typeof live.coding_json === 'object') {
    return live.coding_json as CodingProblem;
  }
  return null;
}

async function judge0Run(
  sourceCode: string,
  languageId: number,
  stdin: string,
  expectedOutput: string
): Promise<Judge0RunResult> {
  const res = await fetch(`${JUDGE0_URL}/submissions?base64_encoded=false&wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_code: sourceCode,
      language_id: languageId,
      stdin,
      expected_output: expectedOutput,
    }),
  });

  if (!res.ok) {
    return { passed: false, actualOutput: '', stderr: await res.text() };
  }

  const data = await res.json();
  const actualOutput = String(data?.stdout ?? '').trimEnd();
  const stderr = String(data?.stderr ?? '').trim() || undefined;
  const compileOutput = String(data?.compile_output ?? '').trim() || undefined;
  const passed = data?.status?.id === 3;

  return { passed, actualOutput, stderr, compileOutput };
}

async function requireUser(
  req: Request
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return { ok: false, response: json({ error: 'Unauthorized' }, 401) };

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !authData.user) {
    return { ok: false, response: json({ error: 'Unauthorized' }, 401) };
  }
  return { ok: true, userId: authData.user.id };
}

function createAdminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
