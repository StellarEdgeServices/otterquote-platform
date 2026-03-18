# ClaimShield Platform

Private repository for the ClaimShield contractor bidding platform.

## Stack
- **Frontend:** Static HTML/CSS/JS (Phase 1), React planned for Phase 2
- - **Backend:** Supabase (PostgreSQL + Auth + Storage + Edge Functions)
  - - **Hosting:** Netlify
    - - **Domain:** stellaredgeservices.com
     
      - ## Getting Started
      - 1. Clone this repo
        2. 2. Copy `.env.example` to `.env` and fill in your keys
           3. 3. Run `supabase start` for local development
              4. 4. Deploy to Netlify via drag-and-drop or CLI
                
                 5. ## Security
                 6. - Never commit `.env` files
                    - - All API keys must stay server-side in Supabase Edge Functions
                      - - Frontend only uses publishable/anon keys
