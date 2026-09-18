import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { extractOrderFromMessage } from '@/lib/groq';
import { sendInteractiveButtons, sendTextMessage } from '@/lib/whatsapp';
import { WhatsAppWebhookPayload } from '@/types/whatsapp';

/**
 * Formats a raw phone number / WhatsApp ID into a clean digit string suitable for Meta Cloud API.
 * Prefixes Tunisia country code '216' if given an 8-digit local number (e.g. '26342535' -> '21626342535').
 */
function formatWhatsAppId(rawPhone: string | null | undefined): string | null {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 8) {
    return `216${digits}`;
  }
  return digits.length >= 8 ? digits : null;
}

/**
 * Validates Meta X-Hub-Signature-256 header using WHATSAPP_APP_SECRET.
 */
function verifyMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  // Fail closed if WHATSAPP_APP_SECRET is not set in environment
  if (!appSecret) {
    console.error('[Security Error] WHATSAPP_APP_SECRET missing from environment. Rejecting request (fail closed).');
    return false;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    console.error('[Security Error] Missing or malformed X-Hub-Signature-256 header');
    return false;
  }

  const signatureHex = signatureHeader.slice(7);
  const expectedHmac = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  try {
    const signatureBuffer = Buffer.from(signatureHex, 'hex');
    const expectedBuffer = Buffer.from(expectedHmac, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (err) {
    console.error('[Security Exception] HMAC signature comparison failed:', err);
    return false;
  }
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
  const hasSigHeader = Boolean(request.headers.get('x-hub-signature-256'));
  console.log(`[Webhook Hit] Received at ${new Date().toISOString()}, signature header present: ${hasSigHeader}`);

  let rawBodyText = '';

  try {
    rawBodyText = await request.text();
  } catch (err) {
    console.error('[Webhook Read Error] Failed to read raw body text:', err);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // ITEM 4: Webhook Signature Verification
  const signatureHeader = request.headers.get('x-hub-signature-256');
  if (!verifyMetaSignature(rawBodyText, signatureHeader)) {
    console.error('[Webhook Security] Unauthorized request rejected with HTTP 401.');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    const body: WhatsAppWebhookPayload = JSON.parse(rawBodyText);
    console.log('[WhatsApp Webhook POST] Received payload:', JSON.stringify(body, null, 2));

    if (body?.object === 'whatsapp_business_account' && Array.isArray(body?.entry)) {
      for (const entry of body.entry) {
        for (const change of entry?.changes || []) {
          const value = change?.value;
          const messages = value?.messages;

          if (Array.isArray(messages) && messages.length > 0) {
            for (const message of messages) {
              const messageId = message?.id || null;
              const rawSenderId = message?.from || value?.contacts?.[0]?.wa_id || null;
              if (!rawSenderId) continue;

              const senderWaId = formatWhatsAppId(rawSenderId);
              if (!senderWaId) continue;

              // ITEM 5: Deduplication via message.id
              if (messageId) {
                const { data: existingEvent } = await supabase
                  .from('webhook_events')
                  .select('id')
                  .eq('message_id', messageId)
                  .limit(1)
                  .maybeSingle();

                if (existingEvent) {
                  console.log(`[Deduplication] Message ${messageId} already processed. Skipping duplicate execution.`);
                  continue;
                }
              }

              let messageBody: string | null = null;
              if (message?.type === 'text' && message?.text?.body) {
                messageBody = message.text.body;
              } else if (message?.type) {
                messageBody = `[${message.type}]`;
              }

              // Save to webhook_events with message_id for deduplication
              try {
                await supabase.from('webhook_events').insert({
                  sender_wa_id: senderWaId,
                  message_id: messageId,
                  message_body: messageBody,
                  raw_payload: body,
                });
              } catch (dbError) {
                console.error('[Supabase webhook_events Exception]:', dbError);
              }

              // ═════════════════════════════════════════════════════════════════════
              // GAP 1: RECOVERY ROUTING FOR SELLER IN 'AWAITING_BUYER_PHONE'
              // ═════════════════════════════════════════════════════════════════════
              const { data: awaitingPhoneOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('seller_wa_id', senderWaId)
                .eq('status', 'AWAITING_BUYER_PHONE')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              if (awaitingPhoneOrder && message?.type === 'text' && messageBody) {
                console.log(`[Awaiting Phone Recovery] Seller ${senderWaId} replied with text: "${messageBody}"`);

                const extractedResult = await extractOrderFromMessage(messageBody);
                const possiblePhone = extractedResult.data.buyer_phone || messageBody;
                const validatedBuyerPhone = formatWhatsAppId(possiblePhone);

                if (validatedBuyerPhone) {
                  // Update order to PENDING_CONFIRMATION
                  const { error: recoveryErr } = await supabase
                    .from('orders')
                    .update({
                      buyer_wa_id: validatedBuyerPhone,
                      buyer_phone: validatedBuyerPhone,
                      status: 'PENDING_CONFIRMATION',
                      updated_at: new Date().toISOString(),
                    })
                    .eq('id', awaitingPhoneOrder.id);

                  if (recoveryErr) {
                    console.error('[Awaiting Phone Recovery Update Error]:', recoveryErr);
                  } else {
                    console.log(`[Awaiting Phone Recovery Success] Order ${awaitingPhoneOrder.id} updated with buyer phone ${validatedBuyerPhone}`);

                    // Send confirmation message to BUYER
                    const productDisplay = awaitingPhoneOrder.product || 'N/A';
                    const priceDisplay = awaitingPhoneOrder.price || 'N/A';

                    if (awaitingPhoneOrder.risk_tier === 'LOW') {
                      const buttonText = `✅ Order Received!\n\n📦 Product: ${productDisplay}\n💰 Price: ${priceDisplay}\n📍 Address: ${awaitingPhoneOrder.address || 'Pending'}\n\nPlease confirm your order details below:`;
                      await sendInteractiveButtons(validatedBuyerPhone, buttonText, [
                        { id: `CONFIRM_${awaitingPhoneOrder.id}`, title: '✅ Confirm Order' },
                        { id: `OPTIONS_${awaitingPhoneOrder.id}`, title: '⚙️ Order Options' },
                      ]);
                    } else {
                      await sendTextMessage(
                        validatedBuyerPhone,
                        '📍 To complete your order confirmation, please share your WhatsApp Location Pin or reply with your full delivery address (City & Street).'
                      );
                    }

                    // Send receipt to SELLER
                    await sendTextMessage(
                      senderWaId,
                      `✅ Buyer phone number updated to ${validatedBuyerPhone}. Confirmation message sent to buyer!`
                    );
                    continue; // Handled recovery!
                  }
                } else {
                  await sendTextMessage(
                    senderWaId,
                    '⚠️ That phone number appears invalid. Please reply with a valid buyer phone number (e.g. 8 digits like 26342535).'
                  );
                  continue;
                }
              }

              // ═════════════════════════════════════════════════════════════════════
              // GAP 3: ROUTING CHECK INCLUDING 'NEEDS_SELLER_REVIEW'
              // ═════════════════════════════════════════════════════════════════════
              const { data: activeBuyerOrder } = await supabase
                .from('orders')
                .select('*')
                .eq('buyer_wa_id', senderWaId)
                .in('status', ['PENDING_CONFIRMATION', 'CONFIRMED', 'NEEDS_SELLER_REVIEW'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              // ═════════════════════════════════════════════════════════════════════
              // PATH 1: SENDER IS A BUYER RESPONDING TO AN EXISTING ORDER
              // ═════════════════════════════════════════════════════════════════════
              if (activeBuyerOrder) {
                console.log(`[Buyer Handler] Processing message from Buyer ${senderWaId} for Order ${activeBuyerOrder.id} (Status: ${activeBuyerOrder.status})`);

                // BUYER SUBMITS GPS LOCATION PIN
                if (message?.type === 'location' && message?.location) {
                  const { latitude, longitude } = message.location;
                  const mapsUrl = `https://maps.google.com/?q=${latitude},${longitude}`;

                  await supabase
                    .from('orders')
                    .update({
                      address: mapsUrl,
                      address_is_complete: true,
                      risk_tier: 'LOW',
                      updated_at: new Date().toISOString(),
                    })
                    .eq('id', activeBuyerOrder.id);

                  const buttonText = `📍 Location received!\n\n📦 Product: ${activeBuyerOrder.product}\n💰 Price: ${activeBuyerOrder.price}\n📍 Address: ${mapsUrl}\n\nPlease confirm your order below:`;
                  await sendInteractiveButtons(senderWaId, buttonText, [
                    { id: `CONFIRM_${activeBuyerOrder.id}`, title: '✅ Confirm Order' },
                    { id: `OPTIONS_${activeBuyerOrder.id}`, title: '⚙️ Order Options' },
                  ]);
                }

                // BUYER SUBMITS TEXT MESSAGE
                else if (message?.type === 'text' && messageBody) {
                  const extractionResult = await extractOrderFromMessage(messageBody);
                  const extracted = extractionResult.data;

                  // Check if message parses as a complete/valid address
                  if (extracted.address_is_complete && extracted.address) {
                    await supabase
                      .from('orders')
                      .update({
                        address: extracted.address,
                        address_is_complete: true,
                        risk_tier: 'LOW',
                        updated_at: new Date().toISOString(),
                      })
                      .eq('id', activeBuyerOrder.id);

                    const addrButtonText = `📍 Address updated!\n\n📦 Product: ${activeBuyerOrder.product}\n💰 Price: ${activeBuyerOrder.price}\n📍 Address: ${extracted.address}\n\nPlease confirm your order below:`;
                    await sendInteractiveButtons(senderWaId, addrButtonText, [
                      { id: `CONFIRM_${activeBuyerOrder.id}`, title: '✅ Confirm Order' },
                      { id: `OPTIONS_${activeBuyerOrder.id}`, title: '⚙️ Order Options' },
                    ]);
                  } else {
                    // GAP 3 & ITEM 3: BUYER FREE-TEXT (e.g. "change color to blue")
                    // Forward text directly to Seller (seller_wa_id) without modifying address
                    const sellerPhone = formatWhatsAppId(activeBuyerOrder.seller_wa_id);
                    const orderShortId = String(activeBuyerOrder.id).slice(0, 8);

                    if (sellerPhone) {
                      await sendTextMessage(
                        sellerPhone,
                        `⚠️ Buyer message needs your attention for Order #${orderShortId}:\n"${messageBody}"`
                      );
                    }

                    await sendTextMessage(
                      senderWaId,
                      '📝 Thank you! We have forwarded your message to the seller.'
                    );
                  }
                }

                // BUYER CLICKS INTERACTIVE BUTTONS
                else if (message?.type === 'interactive') {
                  const buttonId = message.interactive?.button_reply?.id || '';
                  if (!buttonId) continue;

                  const targetOrderId = activeBuyerOrder.id;

                  if (buttonId.startsWith('CONFIRM_')) {
                    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
                    await supabase
                      .from('orders')
                      .update({
                        status: 'CONFIRMED',
                        confirmed_at: new Date().toISOString(),
                        confirmation_window_expires_at: expiresAt,
                        updated_at: new Date().toISOString(),
                      })
                      .eq('id', targetOrderId);

                    await sendInteractiveButtons(senderWaId, '✅ Order Confirmed! You have a 12-hour window to edit your order or update delivery details.', [
                      { id: `OPTIONS_${targetOrderId}`, title: '⚙️ Order Options' },
                    ]);

                    const sellerPhone = formatWhatsAppId(activeBuyerOrder.seller_wa_id);
                    if (sellerPhone) {
                      const orderShortId = String(targetOrderId).slice(0, 8);
                      await sendTextMessage(sellerPhone, `✅ Buyer confirmed Order #${orderShortId}.`);
                    }
                  } else if (buttonId.startsWith('CANCEL_')) {
                    await supabase
                      .from('orders')
                      .update({
                        status: 'CANCELLED_PRE_DISPATCH',
                        cancelled_at: new Date().toISOString(),
                        cancellation_reason: 'BUYER_CANCELLED_VIA_WHATSAPP',
                        updated_at: new Date().toISOString(),
                      })
                      .eq('id', targetOrderId);

                    await sendTextMessage(senderWaId, '❌ Your order has been cancelled. Thank you for letting us know!');

                    const sellerPhone = formatWhatsAppId(activeBuyerOrder.seller_wa_id);
                    if (sellerPhone) {
                      const orderShortId = String(targetOrderId).slice(0, 8);
                      await sendTextMessage(sellerPhone, `❌ Order #${orderShortId} was CANCELLED by the buyer.`);
                    }
                  } else if (buttonId.startsWith('OPTIONS_')) {
                    await sendInteractiveButtons(senderWaId, '⚙️ Order Management Options:\nSelect an option below to manage your order:', [
                      { id: `EDIT_SIZE_${targetOrderId}`, title: '✏️ Change Size' },
                      { id: `RESCHEDULE_${targetOrderId}`, title: '📅 Delay Delivery' },
                      { id: `CANCEL_${targetOrderId}`, title: '❌ Cancel Order' },
                    ]);
                  } else if (buttonId.startsWith('EDIT_SIZE_') || buttonId.startsWith('RESCHEDULE_')) {
                    await supabase
                      .from('orders')
                      .update({
                        status: 'NEEDS_SELLER_REVIEW',
                        updated_at: new Date().toISOString(),
                      })
                      .eq('id', targetOrderId);

                    await sendTextMessage(senderWaId, '📝 Request received! We have notified the seller to check inventory/details with you.');

                    const sellerPhone = formatWhatsAppId(activeBuyerOrder.seller_wa_id);
                    if (sellerPhone) {
                      const orderShortId = String(targetOrderId).slice(0, 8);
                      await sendTextMessage(sellerPhone, `⚠️ Buyer requested an order update on Order #${orderShortId}. Please contact the buyer.`);
                    }
                  }
                }
              }

              // ═════════════════════════════════════════════════════════════════════
              // PATH 2: SENDER IS NOT A BUYER -> EVALUATE AS SELLER ORDER SUBMISSION
              // ═════════════════════════════════════════════════════════════════════
              else if (message?.type === 'text' && messageBody) {
                const extractionResult = await extractOrderFromMessage(messageBody);
                const extracted = extractionResult.data;

                const hasProduct = extracted.product && extracted.product !== 'N/A';
                const hasPrice = extracted.price && extracted.price !== 'N/A';
                const isNewOrderIntent = hasProduct || hasPrice;

                if (isNewOrderIntent) {
                  const sellerWaId = senderWaId;
                  const formattedBuyerPhone = extracted.buyer_phone ? formatWhatsAppId(extracted.buyer_phone) : null;

                  if (!formattedBuyerPhone) {
                    // ITEM 1: MISSING / INVALID BUYER PHONE -> Hold order in AWAITING_BUYER_PHONE
                    const orderToInsert = {
                      seller_wa_id: sellerWaId,
                      buyer_wa_id: null,
                      buyer_name: extracted.buyer_name || 'Unknown',
                      buyer_phone: extracted.buyer_phone || null,
                      address: extracted.address || 'Pending',
                      product: extracted.product || 'N/A',
                      price: extracted.price || 'N/A',
                      status: 'AWAITING_BUYER_PHONE',
                      extracted_data: extracted,
                      address_is_complete: Boolean(extracted.address_is_complete),
                      risk_tier: extracted.risk_tier || 'MEDIUM',
                      updated_at: new Date().toISOString(),
                    };

                    await supabase.from('orders').insert(orderToInsert);

                    await sendTextMessage(
                      sellerWaId,
                      `⚠️ Order received for "${extracted.product || 'Product'}", but the buyer's phone number was missing or invalid.\n\nPlease reply with the buyer's phone number to send confirmation.`
                    );
                  } else {
                    // GAP 2 & ITEM 6: SELLER ORDER SUPERSEDENCE (FAIL-SAFE ATOMIC SEQUENCE)
                    // Check if an existing pending order exists for this same buyer & seller
                    const { data: existingPending } = await supabase
                      .from('orders')
                      .select('id')
                      .eq('seller_wa_id', sellerWaId)
                      .eq('buyer_wa_id', formattedBuyerPhone)
                      .eq('status', 'PENDING_CONFIRMATION')
                      .order('created_at', { ascending: false })
                      .limit(1)
                      .maybeSingle();

                    // STEP 1: CREATE FRESH ORDER FIRST (Ensures old order is never cancelled if new insert fails)
                    const orderToInsert = {
                      seller_wa_id: sellerWaId,
                      buyer_wa_id: formattedBuyerPhone,
                      buyer_name: extracted.buyer_name || 'Unknown',
                      buyer_phone: formattedBuyerPhone,
                      address: extracted.address || 'Pending',
                      product: extracted.product || 'N/A',
                      price: extracted.price || 'N/A',
                      status: 'PENDING_CONFIRMATION',
                      extracted_data: extracted,
                      address_is_complete: Boolean(extracted.address_is_complete),
                      risk_tier: extracted.risk_tier || 'LOW',
                      updated_at: new Date().toISOString(),
                    };

                    const { data: insertedOrder, error: insertErr } = await supabase
                      .from('orders')
                      .insert(orderToInsert)
                      .select();

                    if (insertErr) {
                      console.error('[Supabase Order Insert Error]:', insertErr);
                      await sendTextMessage(sellerWaId, '⚠️ Error saving new order. Your existing pending order remains active.');
                      continue;
                    }

                    // STEP 2: ONLY AFTER INSERT SUCCEEDS, MARK OLD ORDER AS SUPERSEDED
                    if (existingPending) {
                      console.log(`[Seller Supersedence] Successfully created new order ${insertedOrder?.[0]?.id}. Superseding old order ${existingPending.id}`);
                      const { error: supersedErr } = await supabase
                        .from('orders')
                        .update({
                          status: 'CANCELLED_PRE_DISPATCH',
                          cancelled_at: new Date().toISOString(),
                          cancellation_reason: 'SUPERSEDED_BY_NEW_ORDER',
                          updated_at: new Date().toISOString(),
                        })
                        .eq('id', existingPending.id);

                      if (supersedErr) {
                        console.error('[Seller Supersedence Update Error]:', supersedErr);
                      }
                    }

                    const newOrderId = insertedOrder?.[0]?.id || `temp_${Date.now()}`;

                    // Send confirmation message to BUYER (formattedBuyerPhone)
                    if (extracted.risk_tier === 'LOW') {
                      const buttonText = `✅ Order Received!\n\n📦 Product: ${extracted.product || 'N/A'}\n💰 Price: ${extracted.price || 'N/A'}\n📍 Address: ${extracted.address || 'Pending'}\n\nPlease confirm your order details below:`;
                      await sendInteractiveButtons(formattedBuyerPhone, buttonText, [
                        { id: `CONFIRM_${newOrderId}`, title: '✅ Confirm Order' },
                        { id: `OPTIONS_${newOrderId}`, title: '⚙️ Order Options' },
                      ]);
                    } else {
                      await sendTextMessage(
                        formattedBuyerPhone,
                        '📍 To complete your order confirmation, please share your WhatsApp Location Pin or reply with your full delivery address (City & Street).'
                      );
                    }

                    // Notify SELLER (sellerWaId) that confirmation was dispatched to buyer
                    await sendTextMessage(
                      sellerWaId,
                      `📦 Order created for ${extracted.buyer_name || 'Buyer'} (${formattedBuyerPhone}). Confirmation message sent to buyer!`
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('[WhatsApp Webhook POST Exception]:', error);
  }

  return NextResponse.json({ status: 'ok' }, { status: 200 });
}

