# Supabase Edge Function Secrets Setup

These secrets must be configured in the Supabase Dashboard for the Edge Functions to work.

**Go to:** Supabase Dashboard → Project Settings → Edge Functions → Secrets

Add each of the following key-value pairs:

## Mailgun (send-adjuster-email function)
| Secret Name | Value |
|---|---|
| MAILGUN_API_KEY | *(from .env file)* |
| MAILGUN_DOMAIN | sandboxd2b099fad357409b845e5f4c5e8bd74e.mailgun.org |

## Stripe (create-payment-intent function)
| Secret Name | Value |
|---|---|
| STRIPE_SECRET_KEY | *(from .env file — the sk_test_ key)* |

## Twilio (send-sms function)
| Secret Name | Value |
|---|---|
| TWILIO_ACCOUNT_SID | *(from .env file)* |
| TWILIO_AUTH_TOKEN | *(from .env file)* |
| TWILIO_PHONE_NUMBER | 18448753412 |

## DocuSign (create-docusign-envelope function)
| Secret Name | Value |
|---|---|
| DOCUSIGN_INTEGRATION_KEY | 43f4a7d5-f1bf-45ec-8a97-264e3d473e42 |
| DOCUSIGN_API_ACCOUNT_ID | 0b57b777-5c6e-4650-80d3-14152257ca82 |
| DOCUSIGN_USER_ID | *(from .env file)* |
| DOCUSIGN_BASE_URI | https://na3.docusign.net |

## Total: 10 secrets to add
