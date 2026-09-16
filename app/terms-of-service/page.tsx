import React from 'react';

export const metadata = {
  title: 'Terms of Service - OKGO',
  description: 'OKGO Order Confirmation Service Terms of Service',
};

export default function TermsOfServicePage() {
  return (
    <main style={{ maxWidth: '800px', margin: '0 auto', padding: '2rem 1rem', fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', lineHeight: '1.6', color: '#1a1a1a' }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem', fontWeight: '700' }}>OKGO Terms of Service</h1>
      <p style={{ color: '#666', marginBottom: '2rem', fontSize: '0.9rem' }}>Last updated: September 2026</p>

      <section style={{ marginBottom: '1.5rem' }}>
        <p>
          By using OKGO, sellers and buyers agree to the following terms.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Service Description</h2>
        <p>
          OKGO provides a WhatsApp-based order confirmation tool for online sellers. Sellers submit order details to OKGO, which contacts the buyer to confirm the order before shipment and sends delivery reminders.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Seller Responsibilities</h2>
        <p>
          Sellers are responsible for the accuracy of order information submitted to OKGO, including buyer contact details and product/price information.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>No Guarantee of Delivery</h2>
        <p>
          OKGO facilitates order confirmation only. We do not guarantee delivery, product quality, or buyer payment, and are not a party to the underlying sale between seller and buyer.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Acceptable Use</h2>
        <p>
          Users may not use OKGO to send spam, harassing messages, or unrelated marketing content to buyers.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Changes to Service</h2>
        <p>
          OKGO may modify or discontinue features at any time as the product evolves.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Contact</h2>
        <p>
          Questions about these terms can be sent to [your contact email].
        </p>
      </section>
    </main>
  );
}
