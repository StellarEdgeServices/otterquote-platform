'use client';

import * as Sentry from "@sentry/nextjs";
import { useEffect } from 'react';

export default function TestError() {
  useEffect(() => {
    // Send a test message to Sentry
    Sentry.captureMessage("D-211 Sentry test message", "info");
  }, []);

  const handleThrowError = () => {
    throw new Error("D-211 Sentry test error - thrown from test error page");
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '800px' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 'bold', marginBottom: '1rem' }}>
        Sentry Integration Test
      </h1>
      <p style={{ marginBottom: '1rem', color: '#666' }}>
        This page tests Sentry error capture for the D-211 React app.
      </p>
      <button
        onClick={handleThrowError}
        style={{
          padding: '0.75rem 1.5rem',
          backgroundColor: '#ef4444',
          color: 'white',
          border: 'none',
          borderRadius: '0.375rem',
          cursor: 'pointer',
          fontSize: '1rem',
          fontWeight: '500',
        }}
      >
        Throw Test Error
      </button>
      <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#666' }}>
        A test message has been sent to Sentry. Click the button above to send a test error.
      </p>
    </div>
  );
}
