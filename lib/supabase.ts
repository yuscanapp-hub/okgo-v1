import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabaseInstance: SupabaseClient | null = null;

function formatMaskedKey(key: string): string {
  if (!key) return 'EMPTY';
  if (key.length <= 10) return `${key.slice(0, 2)}...${key.slice(-2)} (len: ${key.length})`;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseInstance) {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || 'LOCAL_DEVELOPMENT';

    console.log('[Supabase Runtime Diagnostic]', {
      deploymentCommitSha: commitSha,
      supabaseUrlExists: Boolean(supabaseUrl),
      supabaseUrl: supabaseUrl || 'NOT_SET',
      serviceRoleKeyExists: Boolean(supabaseServiceRoleKey),
      serviceRoleKeyLength: supabaseServiceRoleKey.length,
      serviceRoleKeyMasked: formatMaskedKey(supabaseServiceRoleKey),
    });

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      console.warn('[Supabase Initialization Warning] Missing env vars:', {
        hasSupabaseUrl: Boolean(supabaseUrl),
        hasServiceRoleKey: Boolean(supabaseServiceRoleKey),
      });
    }

    supabaseInstance = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return supabaseInstance;
}

export const supabase = {
  from: (table: string) => getSupabaseClient().from(table),
};
