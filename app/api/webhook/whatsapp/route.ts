import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { extractOrderFromMessage } from '@/lib/groq';
import { sendInteractiveButtons, sendTextMessage } from '@/lib/whatsapp';
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
                  });
                } else {
                  console.log('[Supabase webhook_events Insert Success] Inserted row:', data);
                }
              } catch (dbError) {
                console.error('[Supabase webhook_events Unexpected Exception]:', dbError);
              }

              // 2. Handle Text Messages: Order Extraction & Risk-Based Messaging
              if (message?.type === 'text' && messageBody && senderWaId) {
                try {
                  console.log(`[Order Extraction] Processing message for sender ${senderWaId}...`);
                  const extractionResult = await extractOrderFromMessage(messageBody);
                  const extracted = extractionResult.data;

                  console.log('[Order Extraction Result]:', {
                    success: extractionResult.success,
                    extractedData: extracted,
                    error: extractionResult.error || null,
                  });

                  // Prepare order payload matching Supabase orders schema
                  const orderToInsert = {
                    seller_wa_id: senderWaId,
                    buyer_name: extracted.buyer_name,
                    buyer_phone: extracted.buyer_phone,
                    address: extracted.address,
                    product: extracted.product,
                    price: extracted.price,
                    status: 'PENDING_CONFIRMATION',
                    extracted_data: {
                      address_is_complete: extracted.address_is_complete,
                      risk_tier: extracted.risk_tier,
                    },
                  };

                  console.log(`[Supabase Insert Attempt] Target Table: 'orders'`);
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
                    });
                  } else {
                    console.log('[Supabase orders Insert Success] Inserted order row:', orderData);
                  }

                  // Determine target phone number to send interactive confirmation
                  const targetPhone = extracted.buyer_phone || senderWaId;
                  const insertedOrderId = orderData?.[0]?.id || `temp_${Date.now()}`;

                  // Risk-based response routing
                  if (extracted.risk_tier === 'LOW') {
                    console.log(`[Risk Routing] LOW Risk order. Sending interactive confirmation buttons to ${targetPhone}...`);
                    const buttonText = `✅ Order Received!\n\n📦 Product: ${extracted.product || 'N/A'}\n💰 Price: ${extracted.price || 'N/A'}\n📍 Address: ${extracted.address || 'N/A'}\n\nPlease confirm your order details below:`;

                    await sendInteractiveButtons(targetPhone, buttonText, [
                      { id: `CONFIRM_${insertedOrderId}`, title: '✅ Confirm Order' },
                      { id: `OPTIONS_${insertedOrderId}`, title: '⚙️ Order Options' },
                    ]);
                  } else {
                    console.log(`[Risk Routing] ${extracted.risk_tier} Risk order. Requesting location pin / full address from ${targetPhone}...`);
                    const requestText = `📍 To complete your order confirmation, please share your current WhatsApp Location Pin or reply with your full delivery address (City & Street).`;

                    await sendTextMessage(targetPhone, requestText);
                  }
                } catch (orderProcessErr) {
                  console.error('[Order Processing Exception]:', orderProcessErr);
                }
              }

              // 3. Handle Interactive Button Payloads (Meta Interactive Button Responses)
              if (message?.type === 'interactive' && senderWaId) {
                try {
                  const buttonReply = message.interactive?.button_reply;
                  const buttonId = buttonReply?.id;
                  console.log(`[Interactive Button Response] ID: '${buttonId}', Title: '${buttonReply?.title}' from ${senderWaId}`);

                  if (buttonId) {
                    const firstUnderscore = buttonId.indexOf('_');
                    const action = firstUnderscore !== -1 ? buttonId.substring(0, firstUnderscore) : buttonId;
                    const orderId = firstUnderscore !== -1 ? buttonId.substring(firstUnderscore + 1) : '';

                    if (action === 'CONFIRM') {
                      console.log(`[Action: CONFIRM] Confirming order ${orderId}...`);
                      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

                      // Update order in Supabase
                      const { error: updateErr } = await supabase
                        .from('orders')
                        .update({
                          status: 'CONFIRMED',
                          confirmation_window_expires_at: expiresAt,
                          confirmed_at: new Date().toISOString(),
                        })
                        .eq('id', orderId);

                      if (updateErr) {
                        console.error('[Supabase Update Error - CONFIRM]:', updateErr);
                      }

                      // Send response with options button
                      const confirmText = `✅ Order Confirmed! You have a 12-hour window to edit your order or update delivery details.`;
                      await sendInteractiveButtons(senderWaId, confirmText, [
                        { id: `OPTIONS_${orderId}`, title: '⚙️ Order Options' },
                      ]);
                    } else if (action === 'OPTIONS') {
                      console.log(`[Action: OPTIONS] Displaying management menu for order ${orderId}...`);

                      // Check 12-hour remorse window expiration
                      let isExpired = false;
                      if (orderId && !orderId.startsWith('temp_')) {
                        const { data: orderRow } = await supabase
                          .from('orders')
                          .select('confirmation_window_expires_at')
                          .eq('id', orderId)
                          .single();

                        if (orderRow?.confirmation_window_expires_at) {
                          isExpired = new Date() > new Date(orderRow.confirmation_window_expires_at);
                        }
                      }

                      if (isExpired) {
                        await sendTextMessage(
                          senderWaId,
                          `⚠️ Your 12-hour edit window has expired. Your order is currently being prepared for dispatch!`
                        );
                      } else {
                        const optionsText = `⚙️ Order Management Options:\nSelect an option below to manage your order:`;
                        await sendInteractiveButtons(senderWaId, optionsText, [
                          { id: `EDIT_SIZE_${orderId}`, title: '✏️ Change Size' },
                          { id: `RESCHEDULE_${orderId}`, title: '📅 Delay Delivery' },
                          { id: `CANCEL_${orderId}`, title: '❌ Cancel Order' },
                        ]);
                      }
                    } else if (action === 'CANCEL') {
                      console.log(`[Action: CANCEL] Cancelling order ${orderId}...`);

                      const { error: cancelErr } = await supabase
                        .from('orders')
                        .update({
                          status: 'CANCELLED_PRE_DISPATCH',
                          cancelled_at: new Date().toISOString(),
                          cancellation_reason: 'Buyer cancelled via WhatsApp interactive button',
                        })
                        .eq('id', orderId);

                      if (cancelErr) {
                        console.error('[Supabase Update Error - CANCEL]:', cancelErr);
                      }

                      await sendTextMessage(
                        senderWaId,
                        `❌ Your order has been cancelled. Thank you for letting us know!`
                      );
                    } else if (action === 'EDIT' || action === 'RESCHEDULE' || buttonId.startsWith('EDIT_SIZE_')) {
                      console.log(`[Action: ${action}] Processing change request for order ${orderId}...`);

                      await sendTextMessage(
                        senderWaId,
                        `📝 Request received! Our support team will contact you shortly to update your order details.`
                      );
                    }
                  }
                } catch (interactiveErr) {
                  console.error('[Interactive Button Processing Exception]:', interactiveErr);
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
