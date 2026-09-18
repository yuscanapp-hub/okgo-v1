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
 * Resolves the WhatsApp API bearer token from the environment.
 * Checks WHATSAPP_ACCESS_TOKEN first, then falls back to WHATSAPP_TOKEN.
 * Throws a hard error if neither is present so we never send "Bearer undefined".
 */
function resolveToken(): string {
  const token =
    process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;

  if (!token) {
    console.error(
      '[WhatsApp API Error] Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_TOKEN in environment'
    );
    throw new Error(
      'WhatsApp API token is not configured. Set WHATSAPP_ACCESS_TOKEN or WHATSAPP_TOKEN.'
    );
  }

  // Log a masked version so we can confirm which token instance is loaded in Vercel logs.
  const masked =
    token.length > 8
      ? `${token.slice(0, 4)}${'*'.repeat(token.length - 8)}${token.slice(-4)}`
      : '****';
  console.log(`[WhatsApp API] Resolved token: ${masked}`);

  return token;
}

/**
 * Sends a plain text message via Meta WhatsApp Cloud API.
 */
export async function sendTextMessage(
  to: string,
  text: string
): Promise<WhatsAppSendResult> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!phoneNumberId) {
    console.error(
      '[WhatsApp API Error] Missing WHATSAPP_PHONE_NUMBER_ID in environment'
    );
    return { success: false, error: 'WHATSAPP_PHONE_NUMBER_ID is not configured' };
  }

  let token: string;
  try {
    token = resolveToken();
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMessage };
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  };

  try {
    console.log(`[WhatsApp API] Sending text message to ${to}`);
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

    console.log('[WhatsApp API Success] Text message sent:', responseData);
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
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!phoneNumberId) {
    console.error(
      '[WhatsApp API Error] Missing WHATSAPP_PHONE_NUMBER_ID in environment'
    );
    return { success: false, error: 'WHATSAPP_PHONE_NUMBER_ID is not configured' };
  }

  let token: string;
  try {
    token = resolveToken();
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMessage };
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
    to,
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
    console.log(`[WhatsApp API] Sending interactive buttons to ${to}`);
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

/**
 * Sends a pre-approved Meta WhatsApp Message Template.
 * Used for business-initiated outreach to open or work outside the 24-hour customer window.
 */
export async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode: string = 'en_US',
  bodyParameters: string[] = []
): Promise<WhatsAppSendResult> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!phoneNumberId) {
    console.error(
      '[WhatsApp API Error] Missing WHATSAPP_PHONE_NUMBER_ID in environment'
    );
    return { success: false, error: 'WHATSAPP_PHONE_NUMBER_ID is not configured' };
  }

  let token: string;
  try {
    token = resolveToken();
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMessage };
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  const templatePayload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: languageCode,
      },
    },
  };

  if (bodyParameters.length > 0) {
    (templatePayload.template as Record<string, unknown>).components = [
      {
        type: 'body',
        parameters: bodyParameters.map((param) => ({
          type: 'text',
          text: param,
        })),
      },
    ];
  }

  try {
    console.log(`[WhatsApp API] Sending template message "${templateName}" (${languageCode}) to ${to}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(templatePayload),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error(`[WhatsApp API Error] HTTP ${response.status}:`, responseData);
      return { success: false, data: responseData, error: `HTTP ${response.status}` };
    }

    console.log('[WhatsApp API Success] Template message sent:', responseData);
    return { success: true, data: responseData };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[WhatsApp API Exception]:', errorMessage);
    return { success: false, error: errorMessage };
  }
}
