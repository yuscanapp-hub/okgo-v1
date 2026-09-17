export interface WhatsAppButton {
  id: string;
  title: string;
}

export interface WhatsAppSendResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Sends a plain text message via Meta WhatsApp Cloud API.
 */
export async function sendTextMessage(to: string, text: string): Promise<WhatsAppSendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.warn('[WhatsApp API Warning] Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID in env.');
    return { success: false, error: 'WhatsApp credentials missing' };
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'text',
    text: { body: text },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error(`[WhatsApp API Error] HTTP ${response.status}:`, responseData);
      return { success: false, data: responseData, error: `HTTP ${response.status}` };
    }

    console.log('[WhatsApp API Success] Message sent:', responseData);
    return { success: true, data: responseData };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[WhatsApp API Exception]:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Sends interactive reply buttons via Meta WhatsApp Cloud API.
 * Maximum 3 buttons per interactive button message (Meta Cloud API limit).
 */
export async function sendInteractiveButtons(
  to: string,
  bodyText: string,
  buttons: WhatsAppButton[]
): Promise<WhatsAppSendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.warn('[WhatsApp API Warning] Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID in env.');
    return { success: false, error: 'WhatsApp credentials missing' };
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  // Meta allows up to 3 buttons per interactive button message
  const formattedButtons = buttons.slice(0, 3).map((button) => ({
    type: 'reply',
    reply: {
      id: button.id,
      title: button.title.slice(0, 20), // Meta title limit is 20 chars
    },
  }));

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: formattedButtons,
      },
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error(`[WhatsApp API Error] HTTP ${response.status}:`, responseData);
      return { success: false, data: responseData, error: `HTTP ${response.status}` };
    }

    console.log('[WhatsApp API Success] Interactive buttons sent:', responseData);
    return { success: true, data: responseData };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[WhatsApp API Exception]:', errorMessage);
    return { success: false, error: errorMessage };
  }
}
