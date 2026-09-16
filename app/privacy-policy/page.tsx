import React from 'react';

export const metadata = {
  title: 'Privacy Policy - OKGO',
  description: 'OKGO Order Confirmation Service Privacy Policy',
};

export default function PrivacyPolicyPage() {
  return (
    <main style={{ maxWidth: '800px', margin: '0 auto', padding: '2rem 1rem', fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', lineHeight: '1.6', color: '#1a1a1a' }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem', fontWeight: '700' }}>OKGO Privacy Policy</h1>
      <p style={{ color: '#666', marginBottom: '2rem', fontSize: '0.9rem' }}>Last updated: September 2026</p>

      <section style={{ marginBottom: '1.5rem' }}>
        <p>
          OKGO (&quot;we&quot;, &quot;us&quot;) provides an order confirmation service for sellers using WhatsApp to sell products directly to customers.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Information We Collect</h2>
        <p>
          When a seller submits an order through OKGO, we collect: the buyer&apos;s name, phone number, delivery address, and order details (product, price) as provided by the seller. We also collect WhatsApp message content sent to our system for the purpose of processing orders, and message delivery/read status.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>How We Use This Information</h2>
        <p>
          We use this information solely to: confirm orders with buyers via WhatsApp, send delivery reminders, and maintain a record of order outcomes (confirmed, cancelled, delivered) to help sellers reduce failed deliveries.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Data Sharing</h2>
        <p>
          We do not sell buyer or seller data to third parties. Order confirmation status may be visible in aggregate to other sellers using OKGO as part of our buyer trust network feature, but individual message content is never shared between sellers.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Data Storage</h2>
        <p>
          Data is stored securely using Supabase (PostgreSQL-based infrastructure) with access restricted to OKGO&apos;s systems.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Data Retention</h2>
        <p>
          We retain order and buyer confirmation history for as long as needed to operate the trust network feature described above.
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Your Rights</h2>
        <p>
          Buyers or sellers who wish to have their data deleted can contact us at [your contact email].
        </p>
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: '600' }}>Contact</h2>
        <p>
          For any privacy questions, contact us at [your contact email].
        </p>
      </section>
    </main>
  );
}
