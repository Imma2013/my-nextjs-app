import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type ChatSession = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id?: string;
  session_id?: string;
  user_id?: string;
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
};

export type Optimization = {
  id?: string;
  user_id?: string;
  resume_id?: string;
  job_description: string;
  score?: number;
  strengths?: string[];
  gaps?: string[];
  suggestions?: string[];
  optimized_summary?: string;
  created_at?: string;
};
