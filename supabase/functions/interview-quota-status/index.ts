
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  interviewQuotaStatusRpcErrorMessage,
  interviewRpcHttpStatus,
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
      global: {
        headers: { Authorization: authHeader },
      },
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
      console.error('Interview permission check failed.');
      return json({ error: 'Could not verify interview access.' }, 500);
    }

    if (hasPermission !== true) {
      return json({ error: 'Interview access denied.' }, 403);
    }

    const { data, error } = await userClient.rpc(
      'get_interview_quota_status',
    );

    if (error) {
      const status = interviewRpcHttpStatus(error);
      console.error('Interview quota status lookup failed:', error.message, error.code);
      return json(
        { error: interviewQuotaStatusRpcErrorMessage(error, status) },
        status,
      );
    }

    return json((data ?? {}) as Record<string, unknown>);
  } catch (err) {
    console.error('Interview quota status failed:', err);
    return json({ error: 'Unexpected server error' }, 500);
  }
});

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
