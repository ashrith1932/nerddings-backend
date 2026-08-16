import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

const supabase = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

export function storageConfigured() {
  return Boolean(supabase);
}

export async function createUploadUrl(userId: string, fileName: string, contentType: string) {
  if (!supabase) throw new Error("Supabase Storage is not configured");
  const safeName = fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const path = `${userId}/${Date.now()}-${safeName}`;
  const { data, error } = await supabase.storage.from(env.STORAGE_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error ?? new Error("Unable to create upload URL");
  return { path, token: data.token, signedUrl: data.signedUrl, contentType, publicUrl: `${env.SUPABASE_URL}/storage/v1/object/public/${env.STORAGE_BUCKET}/${path}` };
}

export async function removeObject(path: string) {
  if (!supabase) return;
  await supabase.storage.from(env.STORAGE_BUCKET).remove([path]);
}
