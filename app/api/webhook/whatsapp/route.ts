import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { extractOrderFromMessage } from '@/lib/groq';
import { sendInteractiveButtons, sendTextMessage } from '@/lib/whatsapp';
import { WhatsAppWebhookPayload } from '@/types/whatsapp';

/**
 * Formats a raw phone number / WhatsApp ID into a clean digit string suitable for Meta Cloud API.
 * Prefixes Tunisia country code '216' if given an 8-digit local number (e.g. '26342535' -> '21626342535').
 */
function formatWhatsAppId(rawPhone: string): string {
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length === 8) {
    return `216${digits}`;
  }
  return digits;
}

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
              const rawSenderId = message?.from || value?.contacts?.[0]?.wa_id || null;
              if (!rawSenderId) continue;

              // Format sender WhatsApp ID cleanly as digits with country code (e.g. 21626342535)
              const recipientPhone = formatWhatsAppId(rawSenderId);

              let messageBody: string | null = null;
              if (message?.type === 'text' && message?.text?.body) {
                messageBody = message.text.body;
              } else if (message?.type) {
                messageBody = `[${message.type}]`;
              }

              const recordToInsert = {
                sender_wa_id: recipientPhone,
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
              if (message?.type === 'text' && messageBody) {
                try {
                  console.log(`[Order Extraction] Processing message for sender ${recipientPhone}...`);
                  const extractionResult = await extractOrderFromMessage(messageBody);
                  const extracted = extractionResult.data;

                  console.log('[Order Extraction Result]:', {
                    success: extractionResult.success,
                    extractedData: extracted,
                    error: extractionResult.error || null,
                  });

                  // Prepare order payload matching ground-truth Supabase orders schema
                  const orderToInsert = {
                    seller_wa_id: recipientPhone,
                    buyer_wa_id: recipientPhone,
                    buyer_name: extracted.buyer_name || 'Unknown',
                    buyer_phone: extracted.buyer_phone ? formatWhatsAppId(extracted.buyer_phone) : recipientPhone,
                    address: extracted.address || 'Pending',
                    product: extracted.product || 'N/A',
                    price: extracted.price || 'N/A',
                    status: 'PENDING_CONFIRMATION',
                    extracted_data: extracted,
                    address_is_complete: Boolean(extracted.address_is_complete),
                    risk_tier: extracted.risk_tier || 'LOW',
                    updated_at: new Date().toISOString(),
                  };

                  let insertedOrderId = `temp_${Date.now()}`;
                  console.log(`[Supabase Insert Attempt] Target Table: 'orders'`);

                  try {
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
                      if (orderData?.[0]?.id) {
                        insertedOrderId = String(orderData[0].id);
                      }
                    }
                  } catch (ordersDbErr) {
                    console.error('[Supabase orders Insert Exception]:', ordersDbErr);
                  }

                  // ALWAYS route outbound WhatsApp Cloud API messages to recipientPhone (sender's WA ID)
                  if (extracted.risk_tier === 'LOW') {
                    console.log(`[Risk Routing] LOW Risk order. Sending interactive confirmation buttons to ${recipientPhone}...`);
                    const productDisplay = extracted.product || 'N/A';
                    const priceDisplay = extracted.price || 'N/A';
                    const addressDisplay = extracted.address || 'Pending';

                    const buttonText = `✅ Order Received!\n\n📦 Product: ${productDisplay}\n💰 Price: ${priceDisplay}\n📍 Address: ${addressDisplay}\n\nPlease confirm your order details below:`;

                    await sendInteractiveButtons(recipientPhone, buttonText, [
                      { id: `CONFIRM_${insertedOrderId}`, title: '✅ Confirm Order' },
                      { id: `OPTIONS_${insertedOrderId}`, title: '⚙️ Order Options' },
                    ]);
                  } else {
                    console.log(`[Risk Routing] ${extracted.risk_tier} Risk order. Requesting location pin / full address from ${recipientPhone}...`);
                    const requestText = `📍 To complete your order confirmation, please share your current WhatsApp Location Pin or reply with your full delivery address (City & Street).`;

                    await sendTextMessage(recipientPhone, requestText);
                  }
                } catch (orderProcessErr) {
                  console.error('[Order Processing Exception]:', orderProcessErr);
                }
              }

              // 3. Handle Interactive Button Payloads with Strict Protocol Guardrails & State Locking
              if (message?.type === 'interactive') {
                try {
                  const buttonReply = message.interactive?.button_reply;
                  const buttonId = buttonReply?.id || '';
                  console.log(`[Interactive Button Response] ID: '${buttonId}', Title: '${buttonReply?.title}' from ${recipientPhone}`);

                  if (buttonId) {
                    let action = '';
                    let targetOrderId = '';

                    if (buttonId.startsWith('CONFIRM_')) {
                      action = 'CONFIRM';
                      targetOrderId = buttonId.replace('CONFIRM_', '');
                    } else if (buttonId.startsWith('OPTIONS_')) {
                      action = 'OPTIONS';
                      targetOrderId = buttonId.replace('OPTIONS_', '');
                    } else if (buttonId.startsWith('CANCEL_')) {
                      action = 'CANCEL';
                      targetOrderId = buttonId.replace('CANCEL_', '');
                    } else if (buttonId.startsWith('EDIT_SIZE_')) {
                      action = 'EDIT_SIZE';
                      targetOrderId = buttonId.replace('EDIT_SIZE_', '');
                    } else if (buttonId.startsWith('RESCHEDULE_')) {
                      action = 'RESCHEDULE';
                      targetOrderId = buttonId.replace('RESCHEDULE_', '');
                    }

                    if (!targetOrderId) continue;

                    // GUARDRAIL STEP 1: Fetch Order First
                    let order: any = null;
                    if (!targetOrderId.startsWith('temp_')) {
                      try {
                        const { data: fetchedOrder, error: fetchErr } = await supabase
                          .from('orders')
                          .select('*')
                          .eq('id', targetOrderId)
                          .single();

                        if (fetchErr || !fetchedOrder) {
                          console.warn('[Guardrail Warning] Order record not found for ID:', targetOrderId, fetchErr);
                          await sendTextMessage(recipientPhone, '⚠️ Order record not found.');
                          continue;
                        }
                        order = fetchedOrder;
                      } catch (fetchException) {
                        console.error('[Guardrail Exception] Error fetching order:', fetchException);
                        await sendTextMessage(recipientPhone, '⚠️ Order record not found.');
                        continue;
                      }
                    }

                    // Extract current status & expiration from database row
                    const currentStatus = order?.status || 'PENDING_CONFIRMATION';
                    const expiresAtTimestamp = order?.confirmation_window_expires_at ? new Date(order.confirmation_window_expires_at) : null;
                    const isWindowExpired = expiresAtTimestamp ? new Date() > expiresAtTimestamp : false;

                    // GUARDRAIL STEP 2: Execute State Machine Guardrail Rules
                    if (action === 'CONFIRM') {
                      console.log('[Guardrail Action: CONFIRM] Checking status for order ID:', targetOrderId, 'Current Status:', currentStatus);

                      if (currentStatus === 'CONFIRMED') {
                        console.log('[Guardrail] Order already confirmed:', targetOrderId);
                        await sendInteractiveButtons(
                          recipientPhone,
                          'ℹ️ This order is already confirmed! You can manage your options below:',
                          [{ id: `OPTIONS_${targetOrderId}`, title: '⚙️ Order Options' }]
                        );
                      } else if (currentStatus === 'CANCELLED_PRE_DISPATCH' || currentStatus === 'CANCELLED') {
                        console.log('[Guardrail] Order is cancelled:', targetOrderId);
                        await sendTextMessage(recipientPhone, '⚠️ This order was cancelled and cannot be confirmed.');
                      } else {
                        // Valid transition: PENDING_CONFIRMATION -> CONFIRMED
                        const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

                        try {
                          const { data: updateData, error: updateErr } = await supabase
                            .from('orders')
                            .update({
                              status: 'CONFIRMED',
                              confirmed_at: new Date().toISOString(),
                              confirmation_window_expires_at: expiresAt,
                              updated_at: new Date().toISOString(),
                            })
                            .eq('id', targetOrderId)
                            .select();

                          if (updateErr) {
                            console.error('[Button DB Update Error]', updateErr);
                          } else {
                            console.log('[Button DB Update Success] Order updated to CONFIRMED:', updateData);
                          }
                        } catch (dbUpdateErr) {
                          console.error('[Button DB Update Exception - CONFIRM]:', dbUpdateErr);
                        }

                        const confirmText = `✅ Order Confirmed! You have a 12-hour window to edit your order or update delivery details.`;
                        await sendInteractiveButtons(recipientPhone, confirmText, [
                          { id: `OPTIONS_${targetOrderId}`, title: '⚙️ Order Options' },
                        ]);
                      }
                    } else if (action === 'OPTIONS') {
                      console.log('[Guardrail Action: OPTIONS] Displaying management menu for order ID:', targetOrderId);

                      if (currentStatus === 'CANCELLED_PRE_DISPATCH' || currentStatus === 'CANCELLED') {
                        await sendTextMessage(recipientPhone, '❌ This order has been cancelled.');
                      } else if (isWindowExpired) {
                        await sendTextMessage(
                          recipientPhone,
                          '⚠️ Your 12-hour edit window has expired. Your order is currently being prepared for dispatch!'
                        );
                      } else {
                        const optionsText = `⚙️ Order Management Options:\nSelect an option below to manage your order:`;
                        await sendInteractiveButtons(recipientPhone, optionsText, [
                          { id: `EDIT_SIZE_${targetOrderId}`, title: '✏️ Change Size' },
                          { id: `RESCHEDULE_${targetOrderId}`, title: '📅 Delay Delivery' },
                          { id: `CANCEL_${targetOrderId}`, title: '❌ Cancel Order' },
                        ]);
                      }
                    } else if (action === 'CANCEL') {
                      console.log('[Guardrail Action: CANCEL] Attempting cancellation for order ID:', targetOrderId);

                      if (currentStatus === 'CANCELLED_PRE_DISPATCH' || currentStatus === 'CANCELLED') {
                        await sendTextMessage(recipientPhone, 'ℹ️ Order is already cancelled.');
                      } else if (isWindowExpired) {
                        await sendTextMessage(
                          recipientPhone,
                          '⚠️ Cancellation window has expired. Your order is currently in dispatch!'
                        );
                      } else {
                        try {
                          const { data: cancelData, error: cancelErr } = await supabase
                            .from('orders')
                            .update({
                              status: 'CANCELLED_PRE_DISPATCH',
                              cancelled_at: new Date().toISOString(),
                              cancellation_reason: 'Buyer cancelled via WhatsApp interactive button',
                              updated_at: new Date().toISOString(),
                            })
                            .eq('id', targetOrderId)
                            .select();

                          if (cancelErr) {
                            console.error('[Button DB Update Error - CANCEL]', cancelErr);
                          } else {
                            console.log('[Button DB Update Success] Order updated to CANCELLED_PRE_DISPATCH:', cancelData);
                          }
                        } catch (dbCancelErr) {
                          console.error('[Button DB Update Exception - CANCEL]:', dbCancelErr);
                        }

                        await sendTextMessage(
                          recipientPhone,
                          '❌ Your order has been cancelled. Thank you for letting us know!'
                        );
                      }
                    } else if (action === 'EDIT_SIZE' || action === 'RESCHEDULE') {
                      console.log(`[Guardrail Action: ${action}] Processing change request for order ID:`, targetOrderId);

                      if (isWindowExpired) {
                        await sendTextMessage(
                          recipientPhone,
                          '⚠️ Your 12-hour edit window has expired. Your order is currently being prepared for dispatch!'
                        );
                      } else {
                        await sendTextMessage(
                          recipientPhone,
                          '📝 Request received! Our support team will contact you shortly to update your order details.'
                        );
                      }
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
