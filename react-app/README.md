# OtterQuote App — D-211 React Parallel Track

This is the Next.js 15 + React 19 application for OtterQuote, scaffolded as part of the D-211 migration initiative. The static marketing site remains at `otterquote.com`; this React app will serve the authenticated application surfaces at `app.otterquote.com`.

## What's Inside

- **Next.js 15** with React 19 and TypeScript
- **Tailwind CSS** configured to inherit CSS variables from the static site
- **App Router** (Next.js 13+ app directory structure)
- **Supabase** integration ready (env vars provided)
- **Google Analytics 4** configured (property: G-JNQ6XR3LX2)
- **Netlify** configuration for deployment

## Local Development

1. Install dependencies:
   ```bash
   cd react-app
   npm install
   ```

2. Set up environment variables:
   ```bash
   cp .env.local.example .env.local
   # Edit .env.local with your Supabase keys and other secrets
   ```

3. Run the development server:
   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) to see the app.

4. Build for production:
   ```bash
   npm run build
   npm start
   ```

## Project Structure

```
react-app/
├── app/                   # App Router pages and layouts
│   ├── layout.tsx         # Root layout
│   ├── page.tsx           # Home page (Phase 0 placeholder)
│   └── globals.css        # Global styles + CSS variables
├── public/                # Static assets
├── styles/                # Additional style modules (if needed)
├── tailwind.config.ts     # Tailwind + static site CSS variable mappings
├── next.config.js         # Next.js configuration
├── tsconfig.json          # TypeScript configuration
├── netlify.toml           # Netlify build and deploy settings
├── postcss.config.js      # PostCSS configuration for Tailwind
├── .eslintrc.json         # ESLint configuration
└── .env.local.example     # Environment variable template
```

## CSS Variables

Tailwind is configured to extend colors and spacing with CSS variables inherited from the static site's design system:

- **Colors**: `--navy`, `--navy-2`, `--navy-3`, `--amber`, `--slate`, `--gray`, `--white`, `--teal`, `--green`
- **Spacing**: `--sp-1` through `--sp-24` (following the static site's spacing scale)
- **Radius**: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-full`

These are defined in `app/globals.css` and can be used with Tailwind utilities like `bg-navy`, `text-slate`, `rounded-radius-lg`, etc.

## Environment Variables

Required environment variables (copy from `.env.local.example`):

- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anonymous key (safe for browser)
- `NEXT_PUBLIC_GA4_ID` — Google Analytics 4 property ID

## Manual Deployment Steps

**This is Phase 0 of D-211.** Before you can deploy this app to production, Dustin must:

### 1. Create Netlify Site

1. Log in to [Netlify](https://app.netlify.com)
2. Click **New site** → **Import an existing project**
3. Select GitHub repo: `StellarEdgeServices/otterquote-platform`
4. Configure the build:
   - **Base directory**: `react-app`
   - **Build command**: `npm run build`
   - **Publish directory**: `react-app/.next`
5. Install the Netlify Next.js plugin:
   - Search for and add `@netlify/plugin-nextjs`
6. Set environment variables in Netlify:
   - `NEXT_PUBLIC_SUPABASE_URL=https://yeszghaspzwwstvsrioa.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY=<get from Supabase dashboard>`
   - `NEXT_PUBLIC_GA4_ID=G-JNQ6XR3LX2`
7. Deploy from the `feature/d211-react-scaffold` branch first (for staging verification)
8. Once verified on staging, create a Netlify alias or second site for production if needed

### 2. Configure Cloudflare DNS

Once the Netlify site is live, add CNAME records in Cloudflare:

- **Staging**: `app-staging.otterquote.com` → Netlify staging site URL
- **Production** (after verification): `app.otterquote.com` → Netlify production site URL

See the Netlify site settings → **Domain management** for the exact CNAME targets.

## What's Next (Phase 1+)

- Auth integration via Supabase (F-007 pattern with `onAuthStateChange`)
- Dashboard and authenticated pages
- API routes for backend integration
- Comprehensive testing suite
- Performance monitoring and error tracking

## Related Documentation

- **D-211**: React parallel-track migration overview
- **D-212**: App service architecture (app.otterquote.com)
- **F-007**: Auth pattern — `onAuthStateChange` + `INITIAL_SESSION` guard
- **CLAUDE.md**: Codebase rules and edit constraints for the static site

## Questions?

See the main OtterQuote repository README or contact the development team.

---

**Scaffold Status**: Phase 0 — Static structure complete, placeholder UI in place. Ready for Netlify site creation and DNS configuration.
