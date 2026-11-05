
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  interviewRpcHttpStatus,
  interviewStartRpcErrorMessage,
} from '../_shared/interview-rpc-errors.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const authHeader = req.headers.get('Authorization');

    if (!authHeader) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

    if (!supabaseUrl || !anonKey) {
      console.error('Missing Supabase environment configuration.');
      return json({ error: 'Server configuration error' }, 500);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: authData, error: authError } =
      await userClient.auth.getUser();

    if (authError || !authData.user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const { data: hasPermission, error: permissionError } =
      await userClient.rpc('has_permission', {
        perm: 'interview.access',
      });

    if (permissionError) {
      console.error('Interview permission check failed:', permissionError.message);
      return json({ error: 'Could not verify interview access.' }, 500);
    }

    if (hasPermission !== true) {
      return json({ error: 'Interview access denied.' }, 403);
    }

    let resumeSessionId: string | null = null;
    try {
      const body = await req.json();
      if (
        body &&
        typeof body === 'object' &&
        typeof body.session_id === 'string' &&
        body.session_id.length > 0
      ) {
        resumeSessionId = body.session_id;
      }
    } catch {
      /* empty body is valid for a new session */
    }

    const { data, error } = await userClient.rpc('start_interview_with_quota', {
      p_resume_session_id: resumeSessionId,
    });

    if (error) {
      const status = interviewRpcHttpStatus(error);
      console.error('Interview quota RPC failed:', error.message, error.code);
      return json(
        { error: interviewStartRpcErrorMessage(error, status) },
        status,
      );
    }

    if (
      data &&
      typeof data === 'object' &&
      'code' in data &&
      data.code === 'WEEKLY_QUOTA_EXCEEDED'
    ) {
      return json(normalizeQuotaPayload(data as Record<string, unknown>), 429);
    }

    return json(normalizeQuotaPayload(data as Record<string, unknown>));
  } catch (err) {
    console.error('Interview start failed:', err);
    return json({ error: 'Unexpected server error' }, 500);
  }
});

/** Ensure weekly_limit is present alongside legacy `limit`. */
function normalizeQuotaPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const limit =
    typeof payload['weekly_limit'] === 'number'
      ? payload['weekly_limit']
      : typeof payload['limit'] === 'number'
        ? payload['limit']
        : undefined;
  if (limit !== undefined && payload['weekly_limit'] === undefined) {
    return { ...payload, weekly_limit: limit };
  }
  if (limit !== undefined && payload['limit'] === undefined) {
    return { ...payload, limit };
  }
  return payload;
}

function json(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}
