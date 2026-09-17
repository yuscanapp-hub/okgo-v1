export interface WhatsAppProfile {
  name?: string;
}

export interface WhatsAppContact {
  profile?: WhatsAppProfile;
  wa_id?: string;
}

export interface WhatsAppTextMessage {
  body?: string;
}

export interface WhatsAppButtonReply {
  id: string;
  title: string;
}

export interface WhatsAppInteractiveReply {
  type: string;
  button_reply?: WhatsAppButtonReply;
  list_reply?: { id: string; title: string; description?: string };
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string; // 'text' | 'interactive' | 'location' | etc.
  text?: WhatsAppTextMessage;
  interactive?: WhatsAppInteractiveReply;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  [key: string]: unknown;
}

export interface WhatsAppMetadata {
  display_phone_number?: string;
  phone_number_id?: string;
}

export interface WhatsAppChangeValue {
  messaging_product?: string;
  metadata?: WhatsAppMetadata;
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  statuses?: unknown[];
  [key: string]: unknown;
}

export interface WhatsAppChange {
  value?: WhatsAppChangeValue;
  field?: string;
}

export interface WhatsAppEntry {
  id?: string;
  changes?: WhatsAppChange[];
}

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: WhatsAppEntry[];
  [key: string]: unknown;
}
