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
                    } else if (buttonId.startsWith('EDIT_SIZE_') || buttonId.startsWith('CHANGE_SIZE_')) {
                      action = 'CHANGE_SIZE';
                      targetOrderId = buttonId.replace(/^(EDIT_SIZE_|CHANGE_SIZE_)/, '');
                    } else if (buttonId.startsWith('RESCHEDULE_') || buttonId.startsWith('DELAY_')) {
                      action = 'DELAY';
                      targetOrderId = buttonId.replace(/^(RESCHEDULE_|DELAY_)/, '');
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

                    // GUARDRAIL STEP 2: Terminal State Lockdown (CANCELLED_PRE_DISPATCH, CANCELLED, EXPIRED, DISPATCHED)
                    const TERMINAL_STATES = ['CANCELLED_PRE_DISPATCH', 'CANCELLED', 'EXPIRED', 'DISPATCHED'];
                    if (order && TERMINAL_STATES.includes(order.status)) {
                      console.log('[Guardrail Lockdown] Order is in terminal state:', order.status, 'ID:', targetOrderId);
                      await sendTextMessage(
                        recipientPhone,
                        '⚠️ This order has already been cancelled or finalized. Please contact the seller if you need to place a new order.'
                      );
                      continue;
                    }

                    // GUARDRAIL STEP 3: Execute Action Guardrails
                    if (action === 'CONFIRM') {
                      console.log('[Guardrail Action: CONFIRM] Checking status for order ID:', targetOrderId, 'Current Status:', order?.status);

                      if (order?.status === 'CONFIRMED') {
                        console.log('[Guardrail] Order already confirmed:', targetOrderId);
                        await sendTextMessage(
                          recipientPhone,
                          '✅ This order is already confirmed! Your 12-hour modification window is active.'
                        );
                        continue;
                      }

                      // Non-terminal: Update status to 'CONFIRMED'
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
                          console.error('[Button DB Update Error - CONFIRM]', updateErr);
                        } else {
                          console.log('[Button DB Update Success] Order updated to CONFIRMED:', updateData);
                        }
                      } catch (dbUpdateErr) {
                        console.error('[Button DB Update Exception - CONFIRM]:', dbUpdateErr);
                      }

                      // Send buyer confirmation message
                      const confirmText = `✅ Order Confirmed! You have a 12-hour window to edit your order or update delivery details.`;
                      await sendInteractiveButtons(recipientPhone, confirmText, [
                        { id: `OPTIONS_${targetOrderId}`, title: '⚙️ Order Options' },
                      ]);

                      // Send notification to order.seller_wa_id
                      const sellerPhone = order?.seller_wa_id ? formatWhatsAppId(order.seller_wa_id) : null;
                      if (sellerPhone) {
                        const orderShortId = String(targetOrderId).slice(0, 8);
                        await sendTextMessage(sellerPhone, `✅ Buyer confirmed Order #${orderShortId}.`);
                      }
                    } else if (action === 'CANCEL') {
                      console.log('[Guardrail Action: CANCEL] Attempting cancellation for order ID:', targetOrderId);

                      try {
                        const { data: cancelData, error: cancelErr } = await supabase
                          .from('orders')
                          .update({
                            status: 'CANCELLED_PRE_DISPATCH',
                            cancelled_at: new Date().toISOString(),
                            cancellation_reason: 'BUYER_CANCELLED_VIA_WHATSAPP',
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

                      // Send buyer reply
                      await sendTextMessage(
                        recipientPhone,
                        '❌ Your order has been cancelled. Thank you for letting us know!'
                      );

                      // Send notification to order.seller_wa_id
                      const sellerPhone = order?.seller_wa_id ? formatWhatsAppId(order.seller_wa_id) : null;
                      if (sellerPhone) {
                        const orderShortId = String(targetOrderId).slice(0, 8);
                        await sendTextMessage(sellerPhone, `❌ Order #${orderShortId} was CANCELLED by the buyer.`);
                      }
                    } else if (action === 'CHANGE_SIZE' || action === 'DELAY' || action === 'OPTIONS') {
                      if (action === 'OPTIONS') {
                        const optionsText = `⚙️ Order Management Options:\nSelect an option below to manage your order:`;
                        await sendInteractiveButtons(recipientPhone, optionsText, [
                          { id: `EDIT_SIZE_${targetOrderId}`, title: '✏️ Change Size' },
                          { id: `RESCHEDULE_${targetOrderId}`, title: '📅 Delay Delivery' },
                          { id: `CANCEL_${targetOrderId}`, title: '❌ Cancel Order' },
                        ]);
                      } else {
                        if (order?.status === 'NEEDS_SELLER_REVIEW') {
                          await sendTextMessage(
                            recipientPhone,
                            'ℹ️ Your modification request is already being processed by the seller.'
                          );
                          continue;
                        }

                        try {
                          const { error: reviewErr } = await supabase
                            .from('orders')
                            .update({
                              status: 'NEEDS_SELLER_REVIEW',
                              updated_at: new Date().toISOString(),
                            })
                            .eq('id', targetOrderId);

                          if (reviewErr) {
                            console.error('[Button DB Update Error - NEEDS_SELLER_REVIEW]', reviewErr);
                          }
                        } catch (reviewDbErr) {
                          console.error('[Button DB Update Exception - NEEDS_SELLER_REVIEW]:', reviewDbErr);
                        }

                        // Send buyer reply
                        await sendTextMessage(
                          recipientPhone,
                          '📝 Request received! We have notified the seller to check inventory/details with you.'
                        );

                        // Send notification to order.seller_wa_id
                        const sellerPhone = order?.seller_wa_id ? formatWhatsAppId(order.seller_wa_id) : null;
                        if (sellerPhone) {
                          const orderShortId = String(targetOrderId).slice(0, 8);
                          await sendTextMessage(
                            sellerPhone,
                            `⚠️ Buyer requested an order update (Size/Delay) on Order #${orderShortId}. Please contact the buyer.`
                          );
                        }
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
