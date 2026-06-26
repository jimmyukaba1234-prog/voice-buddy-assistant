import { supabase } from "./supabase.js";

function toChatMessage(message) {
  return {
    id: message.id,
    role: message.role,
    text: message.content,
    createdAt: message.created_at,
  };
}

export function generateConversationTitle(prompt) {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  const words = normalized.split(" ").filter(Boolean).slice(0, 8);
  const title = words.join(" ");

  if (!title) {
    return "New conversation";
  }

  return title.length > 60 ? `${title.slice(0, 57).trim()}...` : title;
}

export async function loadMostRecentConversation(userId) {
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id,user_id,title,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (conversationError) {
    throw conversationError;
  }

  if (!conversation) {
    return { conversation: null, messages: [] };
  }

  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select("id,conversation_id,user_id,role,content,created_at")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true });

  if (messagesError) {
    throw messagesError;
  }

  return {
    conversation,
    messages: (messages || []).map(toChatMessage),
  };
}

export async function createConversation(userId, title = "New conversation") {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, title })
    .select("id,user_id,title,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function saveMessage(userId, conversationId, role, content) {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      role,
      content,
    })
    .select("id,conversation_id,user_id,role,content,created_at")
    .single();

  if (error) {
    throw error;
  }

  return toChatMessage(data);
}

export async function updateConversation(conversationId, updates) {
  const { data, error } = await supabase
    .from("conversations")
    .update(updates)
    .eq("id", conversationId)
    .select("id,user_id,title,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  return data;
}
