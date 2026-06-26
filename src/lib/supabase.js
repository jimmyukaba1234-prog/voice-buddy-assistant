import { createClient } from "@supabase/supabase-js";

const viteEnv = import.meta.env || {};
const supabaseUrl = viteEnv.VITE_SUPABASE_URL;
const supabaseAnonKey = viteEnv.VITE_SUPABASE_ANON_KEY;
const supabaseUrlValid = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(
  supabaseUrl || ""
);
const supabaseAnonKeyValid = Boolean(
  supabaseAnonKey &&
    !/^https?:\/\//i.test(supabaseAnonKey) &&
    (supabaseAnonKey.startsWith("sb_publishable_") ||
      supabaseAnonKey.split(".").length === 3)
);
const supabaseClientUrl =
  viteEnv.DEV && typeof window !== "undefined"
    ? `${window.location.origin}/supabase`
    : supabaseUrl;

export const supabaseConfigured = Boolean(
  supabaseUrlValid && supabaseAnonKeyValid
);

export const supabase = supabaseConfigured
  ? createClient(supabaseClientUrl, supabaseAnonKey)
  : null;
