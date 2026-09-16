import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { extractOrderFromMessage } from '@/lib/groq';
import { WhatsAppWebhookPayload } from '@/types/whatsapp';

/**
 * GET /api/webhook/whatsapp
 * Meta calls this to verify the webhook endpoint.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token && token === verifyToken) {
    return new NextResponse(challenge ?? '', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }

  return new NextResponse('Forbidden', { status: 403 });
}

/**
 * POST /api/webhook/whatsapp
 * Meta POSTs incoming WhatsApp events here as JSON.
 */
export async function POST(request: NextRequest) {
  try {
    const body: WhatsAppWebhookPayload = await request.json();
    console.log('[WhatsApp Webhook POST] Received payload:', JSON.stringify(body, null, 2));

    // Validate that payload object and entry array exist
    if (body?.object === 'whatsapp_business_account' && Array.isArray(body?.entry)) {
      for (const entry of body.entry) {
        for (const change of entry?.changes || []) {
          const value = change?.value;
          const messages = value?.messages;

          // Validate that messages array exists and is non-empty before processing
          if (Array.isArray(messages) && messages.length > 0) {
            for (const message of messages) {
              const senderWaId = message?.from || value?.contacts?.[0]?.wa_id || null;

              let messageBody: string | null = null;
              if (message?.type === 'text' && message?.text?.body) {
                messageBody = message.text.body;
              } else if (message?.type) {
                messageBody = `[${message.type}]`;
              }

              const recordToInsert = {
                sender_wa_id: senderWaId,
                message_body: messageBody,
                raw_payload: body,
              };

              const activeSupabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'NOT_SET';
              console.log(`[Supabase Insert Attempt] Target Table: 'webhook_events'`);
              console.log(`[Supabase Insert Attempt] Supabase URL: ${activeSupabaseUrl}`);
              console.log(`[Supabase Insert Attempt] Record to insert:`, JSON.stringify(recordToInsert, null, 2));

              // 1. Perform insert into webhook_events
              try {
                const { data, error } = await supabase
                  .from('webhook_events')
                  .insert(recordToInsert)
                  .select();

                if (error) {
                  console.error('[Supabase webhook_events Insert Error]:', {
                    message: error.message,
                    details: error.details,
                    hint: error.hint,
                    code: error.code,
                    fullError: error,
                  });
                } else {
                  console.log('[Supabase webhook_events Insert Success] Inserted row:', data);
                }
              } catch (dbError) {
                console.error('[Supabase webhook_events Unexpected Exception]:', dbError);
              }

              // 2. Perform Order Extraction via Groq API and insert into 'orders' table
              if (messageBody && message?.type === 'text') {
                try {
                  console.log(`[Order Extraction] Processing message for sender ${senderWaId}...`);
                  const extractionResult = await extractOrderFromMessage(messageBody);

                  console.log('[Order Extraction Result]:', {
                    success: extractionResult.success,
                    extractedData: extractionResult.data,
                    error: extractionResult.error || null,
                  });

                  // Prepare orders table row
                  const orderToInsert = {
                    seller_wa_id: senderWaId,
                    buyer_name: extractionResult.data.buyer_name,
                    buyer_phone: extractionResult.data.buyer_phone,
                    address: extractionResult.data.address,
                    product: extractionResult.data.product,
                    price: extractionResult.data.price,
                    status: 'pending_confirmation',
                  };

                  console.log(`[Supabase Insert Attempt] Target Table: 'orders'`);
                  console.log(`[Supabase Insert Attempt] Order Record to insert:`, JSON.stringify(orderToInsert, null, 2));

                  const { data: orderData, error: orderError } = await supabase
                    .from('orders')
                    .insert(orderToInsert)
                    .select();

                  if (orderError) {
                    console.error('[Supabase orders Insert Error]:', {
                      message: orderError.message,
                      details: orderError.details,
                      hint: orderError.hint,
                      code: orderError.code,
                      fullError: orderError,
                    });
                  } else {
                    console.log('[Supabase orders Insert Success] Inserted order row:', orderData);
                  }
                } catch (orderProcessErr) {
                  console.error('[Order Processing Exception]:', orderProcessErr);
                }
              }
            }
          } else {
            console.log('[WhatsApp Webhook POST] Event ignored: No messages array present (e.g. status/read receipt).');
          }
        }
      }
    } else {
      console.log('[WhatsApp Webhook POST] Payload ignored: Not a whatsapp_business_account event.');
    }
  } catch (error) {
    console.error('[WhatsApp Webhook POST Exception]:', error);
  }

  // Always respond with status 200 immediately to acknowledge receipt to Meta
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
