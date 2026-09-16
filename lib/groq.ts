export interface ExtractedOrder {
  buyer_name: string | null;
  buyer_phone: string | null;
  address: string | null;
  product: string | null;
  price: string | null;
}

export interface ExtractedOrderResult {
  success: boolean;
  data: ExtractedOrder;
  rawResponse?: string;
  error?: string;
}

const DEFAULT_EXTRACTED_DATA: ExtractedOrder = {
  buyer_name: null,
  buyer_phone: null,
  address: null,
  product: null,
  price: null,
};

/**
 * Extracts structured order data from a seller's WhatsApp message using Groq API.
 * Supports Tunisian Arabic dialect, French, and Arabizi (Latin-script Arabic).
 */
export async function extractOrderFromMessage(messageText: string): Promise<ExtractedOrderResult> {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    console.warn('[Groq API Warning] GROQ_API_KEY is not defined in environment variables.');
    return {
      success: false,
      data: DEFAULT_EXTRACTED_DATA,
      error: 'GROQ_API_KEY missing',
    };
  }

  if (!messageText || typeof messageText !== 'string' || !messageText.trim()) {
    return {
      success: false,
      data: DEFAULT_EXTRACTED_DATA,
      error: 'Empty message text',
    };
  }

  const systemPrompt =
    'You are an order extraction assistant for a Tunisian e-commerce platform. Sellers send messages in a mix of Tunisian Arabic dialect, French, and Arabizi (Latin-script Arabic). Extract the following fields from the message and return ONLY valid JSON, no other text: buyer_name (string or null), buyer_phone (string or null), address (string or null), product (string or null), price (string or null). If a field isn\'t present in the message, use null.';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: messageText,
          },
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Groq API Error] HTTP ${response.status} (${response.statusText}):\nFull Response Body:\n${errorText}`);
      return {
        success: false,
        data: DEFAULT_EXTRACTED_DATA,
        error: `Groq API HTTP ${response.status}: ${errorText}`,
      };
    }

    const responseJson = await response.json();
    const content = responseJson?.choices?.[0]?.message?.content;

    if (!content) {
      console.error('[Groq API Error] Empty choices content in response:', JSON.stringify(responseJson, null, 2));
      return {
        success: false,
        data: DEFAULT_EXTRACTED_DATA,
        error: 'Empty completion content',
      };
    }

    // Try parsing the returned content as JSON
    try {
      const parsedData = JSON.parse(content);

      const extracted: ExtractedOrder = {
        buyer_name: typeof parsedData.buyer_name === 'string' ? parsedData.buyer_name : null,
        buyer_phone: typeof parsedData.buyer_phone === 'string' ? parsedData.buyer_phone : null,
        address: typeof parsedData.address === 'string' ? parsedData.address : null,
        product: typeof parsedData.product === 'string' ? parsedData.product : null,
        price: typeof parsedData.price === 'string' ? parsedData.price : null,
      };

      return {
        success: true,
        data: extracted,
        rawResponse: content,
      };
    } catch (jsonErr) {
      console.error('[Groq API Error] Failed to parse model output as JSON:', content);
      return {
        success: false,
        data: DEFAULT_EXTRACTED_DATA,
        rawResponse: content,
        error: 'Failed to parse output JSON',
      };
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[Groq API Exception]:', errorMessage);
    return {
      success: false,
      data: DEFAULT_EXTRACTED_DATA,
      error: errorMessage,
    };
  }
}
