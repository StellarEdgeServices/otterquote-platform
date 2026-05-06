# D-211 Auth Doctor Extension

## Coverage Map

The React auth layer implements the following auth-doctor scenarios:

| Scenario | Coverage | Implementation |
|----------|----------|-----------------|
| **1. Unauthenticated → /login** | Full | `ProtectedRoute` redirects to /login if !user |
| **2. Authenticated + correct role → Allow** | Full | `ProtectedRoute` checks role, renders children if match |
| **3. Authenticated + wrong role → /home** | Full | `ProtectedRoute` redirects to / if role not in allowedRoles |
| **4. Session expiry** | Partial | Handled by Supabase JS SDK; middleware checks JWT exp for admin routes |
| **5. Admin gate (middleware)** | Full | Middleware reads sb_at cookie, decodes JWT, checks admin allowlist |
| **6. Contractor role resolution** | Full | auth-provider queries contractors table first, falls back to profiles, then allowlist |
| **7. Auth ready state** | Full | `useAuthReady()` returns true after INITIAL_SESSION fires |

## F-007 Pattern (INITIAL_SESSION + _initFired)

The auth provider implements React safety for Supabase JS v2:

```typescript
const _initFired = useRef(false);

supabase.auth.onAuthStateChange((event, session) => {
  if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && !_initFired.current) {
    _initFired.current = true;
    // Initialize page once
  }
});
```

**Why this pattern prevents race conditions:**
- Supabase JS v2 fires INITIAL_SESSION once during app boot to restore persisted session state
- Without the guard, DOMContentLoaded + getSession() races against onAuthStateChange, causing double-init
- The `_initFired` boolean ensures handlers run exactly once, even if events fire out of order
- React effect cleanup unsubscribes to prevent memory leaks

## Extending Auth-Doctor for React Pages

### 1. Add test page wrapper

Create a protected test page in `app/src/app/test-auth/page.tsx`:

```typescript
import { ProtectedRoute } from '@/components/protected-route';

export default function TestAuthPage() {
  return (
    <ProtectedRoute allowedRoles={['homeowner', 'contractor', 'admin']}>
      <div>Auth is working</div>
    </ProtectedRoute>
  );
}
```

### 2. Update auth-doctor Playwright spec

In auth-doctor scenarios, add a React-specific visit:

```typescript
// Before: HTML page testing
await page.goto('https://app.otterquote.com/dashboard.html');

// After/In addition: React page testing
await page.goto('https://app.otterquote.com/test-auth');
```

### 3. Assertions remain the same

The auth-doctor matrix checks:
- Status code 200 (page loaded)
- Redirect to /login (auth required)
- Redirect to / (wrong role)
- Admin bypass for /admin/* (middleware pass-through)

All apply to React routes exactly as they apply to HTML routes.

## Notes

- The auth layer does NOT create accounts — use Supabase auth UI for signup
- The admin allowlist is hardcoded; future D-numbers may move this to a `config` table
- Contractor ID resolution stores the `contractors.id` (not user_id) for later use in business logic
- Middleware only protects /admin/* by config.matcher — add other routes as needed
